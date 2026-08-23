/* ============================================================================
   Ce que la PRODUCTION servira vraiment — sans construire l'image.

   Le Dockerfile le dit lui-même : « la copie est EXPLICITE — tout nouveau
   fichier servi à la racine du site doit être ajouté ici, sinon il n'existe
   pas en production ». C'est un piège à retardement, et le pire genre : le
   serveur de test (`php -S`) sert TOUT le dépôt, donc la suite reste verte
   pendant que le fichier manque à l'arrivée. Le défaut n'apparaît qu'en ligne,
   chez le lecteur.

   Et il ne coûte pas un fichier, il coûte le hors-ligne entier : la coquille
   du service worker est posée par `addAll()`, qui est ATOMIQUE. Un seul 404 et
   l'installation échoue en bloc — plus aucun cache, sans le moindre message à
   l'écran.

   On reconstitue donc l'arborescence de /app/public à partir des seules
   directives COPY, puis on vérifie que tout ce que le code RÉCLAME s'y trouve :
   la coquille du service worker, les livres bibliques, les icônes du manifeste,
   et chaque ressource référencée par chaque page. Le filet inverse ferme la
   boucle : ce que les tests servent et que l'image n'a pas.

   Pas de navigateur, pas de serveur, aucune dépendance — quelques
   millisecondes de lecture de fichiers.

     node api/tests/parite-image.mjs
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(RACINE);

let pass = 0, fail = 0;
const ok = m => { pass++; console.log(`   ok   ${m}`); };
const bad = (m, d) => {
  fail++;
  console.log(`   FAIL ${m}`);
  if (d) String(d).split('\n').slice(0, 25).forEach(l => console.log('        ' + l));
};

/* ---- .dockerignore : ce qui n'entre jamais dans le contexte de build ------ */
const ignores = fs.existsSync('.dockerignore')
  ? fs.readFileSync('.dockerignore', 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  : [];
// Un motif .dockerignore peut porter des jokers n'importe où (« api/data/*.sqlite* ») :
// on le traduit en expression régulière plutôt que de ne traiter qu'un « * » final.
const enRegex = m => new RegExp('^' + m.split('*').map(p =>
  p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '(/.*)?$');
const ignore = rel => ignores.some(m => rel === m || enRegex(m).test(rel));

// L'historique Git et les node_modules ne sont jamais servis : les traverser
// ne coûterait que du temps.
const ELAGUE = new Set(['.git', 'node_modules']);
const fichiersDe = dir => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ELAGUE.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...fichiersDe(p));
    else out.push(p.split(path.sep).join('/'));
  }
  return out;
};

/* ---- Les directives COPY : « COPY <src...> <dest> » ----------------------- */
const public_ = new Set();
let copies = 0;
for (let ligne of fs.readFileSync('Dockerfile', 'utf8').split('\n')) {
  ligne = ligne.trim();
  if (!/^COPY\s/i.test(ligne)) continue;
  const parts = ligne.slice(5).split(/\s+/).filter(p => p && !p.startsWith('--'));
  if (parts.length < 2) continue;
  let dest = parts[parts.length - 1];
  if (dest.startsWith('/')) continue;              // le Caddyfile, hors du site
  if (dest.startsWith('./')) dest = dest.slice(2); // « ./frise/ » → « frise »
  dest = dest.replace(/\/$/, '');
  copies++;
  for (const brut of parts.slice(0, -1)) {
    const src = brut.replace(/\/$/, '');
    if (!fs.existsSync(src)) { bad(`COPY vise un chemin inexistant : ${brut}`); continue; }
    if (fs.statSync(src).isDirectory()) {
      // « COPY dossier/ ./dossier/ » copie le CONTENU, pas le dossier.
      for (const f of fichiersDe(src)) {
        if (ignore(f)) continue;
        const interne = path.relative(src, f).split(path.sep).join('/');
        public_.add(dest ? `${dest}/${interne}` : interne);
      }
    } else if (!ignore(src)) {
      public_.add(dest ? `${dest}/${path.basename(src)}` : path.basename(src));
    }
  }
}

console.log(`\n-- Arborescence de production reconstituée (${copies} directives COPY)`);
ok(`${public_.size} fichiers atterriraient dans /app/public`);
public_.has('index.html') ? ok('index.html est bien copié') : bad('index.html ABSENT de l\'image');

/** Le fichier serait-il servi ? Un chemin en « / » vaut son index.html. */
function sert(chemin) {
  let c = chemin.split('?')[0].split('#')[0];
  c = c.replace(/^\.?\//, '');
  if (c === '' || c === '.') c = 'index.html';
  if (c.endsWith('/')) c += 'index.html';
  return public_.has(c);
}

/* ---- 1. La coquille du service worker ------------------------------------ */
console.log('\n-- La coquille du service worker (addAll est atomique : un 404 et tout tombe)');
const sw = fs.readFileSync('sw.js', 'utf8');
const tableau = nom => {
  const m = sw.match(new RegExp('const\\s+' + nom + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
};
const shell = tableau('SHELL');
shell.length > 0 ? ok(`${shell.length} entrées déclarées dans SHELL`) : bad('SHELL introuvable dans sw.js');
const hs = shell.filter(u => !sert(u));
hs.length ? bad(`${hs.length} entrée(s) de la coquille absente(s) de l'image`, hs.join('\n'))
  : ok('chaque entrée de la coquille existe en production');

/* ---- 2. Les livres bibliques pré-cachés ---------------------------------- */
console.log('\n-- La Bible pré-cachée, livre par livre');
const bible = tableau('BIBLE');
bible.length > 0 ? ok(`${bible.length} livres déclarés`) : bad('BIBLE introuvable dans sw.js');
const hb = bible.filter(u => !sert(u));
hb.length ? bad(`${hb.length} livre(s) absent(s) de l'image`, hb.join('\n'))
  : ok(`les ${bible.length} livres sont copiés`);

/* ---- 3. Le manifeste et ses icônes --------------------------------------- */
// Une seule icône manquante et le navigateur refuse d'installer l'appli.
console.log('\n-- Le manifeste PWA et ses icônes');
const mani = JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8'));
const icones = (mani.icons || []).map(i => i.src);
ok(`${icones.length} icône(s) déclarée(s)`);
const hi = icones.filter(i => !sert(i));
hi.length ? bad('icône(s) du manifeste absente(s) de l\'image', hi.join('\n'))
  : ok('toutes les icônes sont copiées');
sert(mani.start_url || '/') ? ok(`start_url servi : ${mani.start_url}`)
  : bad(`start_url introuvable : ${mani.start_url}`);

/* ---- 4. Ce que chaque page réclame --------------------------------------- */
console.log('\n-- Les ressources référencées par chaque page');
const pages = [...public_].filter(p => p.endsWith('.html')).sort();
ok(`${pages.length} page(s) HTML dans l'image`);
let total = 0; const absents = [];
for (const p of pages) {
  if (!fs.existsSync(p)) continue;
  const h = fs.readFileSync(p, 'utf8');
  const base = path.dirname(p) === '.' ? '' : path.dirname(p);
  for (const m of h.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const r = m[1];
    if (/^(https?:|\/\/|#|mailto:|tel:|data:|javascript:)/.test(r)) continue;
    total++;
    const brut = r.startsWith('/') ? r.slice(1) : (base ? `${base}/${r}` : r);
    // normalize() garde le « / » final : on le retire d'abord, puis on le
    // remet si la référence d'origine désignait bien un dossier.
    let cible = path.normalize(brut).split(path.sep).join('/').replace(/\/+$/, '');
    if (r.endsWith('/')) cible += '/';
    if (!sert(cible)) absents.push(`${p} → ${r}`);
  }
}
ok(`${total} référence(s) locale(s) examinée(s)`);
absents.length ? bad(`${absents.length} référence(s) pointant dans le vide`, absents.join('\n'))
  : ok('aucune page ne référence un fichier absent de l\'image');

/* ---- 5. Le filet inverse -------------------------------------------------- */
// `php -S` sert tout le dépôt. Ce qu'il sert et que l'image n'a PAS est
// exactement la classe de défaut contre laquelle le Dockerfile met en garde.
console.log('\n-- Servi pendant les tests, mais absent de l\'image');
// Ce qui n'a rien à faire dans l'image parce que ce n'est pas le SITE :
// l'atelier de communication, le backend (servi par réécriture, pas en
// statique), les tests, et l'outillage de dépôt.
const HORS = ['outils/', 'api/', 'lire/tests/', '.github/'];
const horsimage = fichiersDe('.')
  .map(f => f.replace(/^\.\//, ''))
  // Les fichiers CACHÉS ne sont jamais servis (.dockerignore, .gitignore…) —
  // mais un DOSSIER caché, lui, peut l'être : .well-known/assetlinks.json est
  // ce qui prouve à Android que le domaine et l'appli du Play Store sont la
  // même main. Sans lui, l'appli s'ouvre avec une barre d'adresse. On filtre
  // donc sur le nom de fichier, pas sur le chemin.
  .filter(rel => !path.basename(rel).startsWith('.'))
  .filter(rel => !HORS.some(h => rel.startsWith(h)) && !rel.endsWith('.md') && !rel.endsWith('.php'))
  .filter(rel => !['Dockerfile', 'Caddyfile'].includes(rel))
  .filter(rel => !public_.has(rel));
horsimage.length
  ? bad(`${horsimage.length} fichier(s) du dépôt n'atterrissent pas dans l'image`, horsimage.sort().join('\n'))
  : ok('aucun fichier servable du dépôt n\'est oublié par le Dockerfile');

console.log(`\n${pass} réussites, ${fail} échecs`);
process.exit(fail === 0 ? 0 : 1);
