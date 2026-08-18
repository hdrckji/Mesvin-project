/* ============================================================================
   Test CLI du moteur de recherche biblique (lire/recherche.js) — lancé par
   api/tests/run-tests.sh :

       node lire/tests/recherche-test.mjs

   Il relit LE MÊME fichier que l'application (aucune copie), et cherche dans
   LE VRAI texte (lire/data/*.json) : si un verset cité ici ne se trouve plus
   à sa place, le test tombe.

   L'essentiel de ce qui est vérifié tient en une phrase : une requête est du
   texte d'un inconnu, et ce texte ne doit jamais pouvoir devenir du balisage,
   une expression régulière, un chemin de fichier, ni un écran figé.

   Code de sortie : 0 si tout passe, 1 sinon.
   ========================================================================== */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = join(ICI, '..', '..');
const R = createRequire(import.meta.url)(join(RACINE, 'lire', 'recherche.js'));

let pass = 0, fail = 0;
const verif = (nom, vrai) => {
  if (vrai) { pass++; console.log('   ok   ' + nom); }
  else { fail++; console.log('   FAIL ' + nom); }
};
const egal = (nom, attendu, obtenu) => {
  const ok = JSON.stringify(attendu) === JSON.stringify(obtenu);
  verif(nom + (ok ? '' : ` (attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)})`), ok);
};

const livre = id => JSON.parse(readFileSync(join(RACINE, 'lire', 'data', id + '.json'), 'utf8'));
const chercher = (id, requete) => {
  const d = livre(id);
  return R.chercherDansLivre(d.chapitres, R.plierLivre(d.chapitres), R.plier(requete), R.MAX_RESULTATS);
};

/* ---- 1. Le pliage : accents, casse, apostrophes ------------------------------ */

egal('« Éternel » se plie en « eternel »', 'eternel', R.plier('Éternel'));
egal("l'apostrophe typographique devient droite", "qu'il", R.plier('qu’il'));
verif('le pliage garde la longueur, caractère pour caractère',
  ['Éternel', 'PRIÈRE', 'Œuvre', 'çà et là', 'Ægypte'].every(s => R.plier(s).length === s.length));

/* ---- 2. Chercher pour de vrai, dans le vrai texte ---------------------------- */

const jean = chercher('jean', 'tant aimé le monde');
verif('« tant aimé le monde » se trouve dans Jean', jean.length >= 1);
egal('… et c\'est bien Jean 3.16', { ch: 2, v: 15 }, jean[0] ? { ch: jean[0].ch, v: jean[0].v } : null);

verif('sans accents, on trouve quand même (« eternel » → Psaumes)',
  chercher('psaumes', 'eternel est mon berger').length >= 1);
verif('la casse est indifférente',
  chercher('psaumes', 'ETERNEL EST MON BERGER').length >= 1);
verif('une apostrophe droite trouve le texte',
  chercher('jean', "qu'il a donné son Fils").length >= 1);

const introuvable = chercher('jonas', 'zzzzz cette phrase n existe pas');
egal('ce qui n\'existe pas ne se trouve pas', 0, introuvable.length);

/* ---- 3. Les index rendus découpent le VRAI texte, sans décalage -------------- */

const p23 = chercher('psaumes', 'mon berger')[0];
verif('les index tombent juste, même après des lettres accentuées',
  p23 && p23.texte.slice(p23.debut, p23.fin).toLowerCase() === 'mon berger');
const ex = R.extrait(p23);
verif("l'extrait recolle exactement au passage trouvé", ex.trouve.toLowerCase() === 'mon berger');
verif("l'extrait rend du texte brut, jamais de balise",
  !/[<>]/.test(ex.avant + ex.trouve + ex.apres));

/* ---- 4. SÉCURITÉ — une requête hostile reste du texte ------------------------ */

// a) Injection HTML : le moteur ne fabrique aucune balise, donc rien à injecter.
const script = '<img src=x onerror=alert(1)>';
egal('une balise cherchée ne trouve rien dans le texte biblique', 0, chercher('jonas', script).length);
verif('… et le moteur ne rend aucun HTML de lui-même',
  typeof R.plier(script) === 'string' && !('innerHTML' in R));

// b) ReDoS : ces motifs figeraient un moteur qui construirait une regex.
const bombes = ['(a+)+$', '(x+x+)+y', '[', '\\', '(((((((((((a)))))))))))*', '.*.*.*.*.*.*b'];
const debut = Date.now();
bombes.forEach(b => { chercher('jonas', b); });
const duree = Date.now() - debut;
verif(`six motifs « bombes à regex » traités comme du texte (${duree} ms)`, duree < 3000);
egal('« (a+)+$ » est cherché littéralement, et ne se trouve pas', 0, chercher('jonas', '(a+)+$').length);

// c) Bornes : ni requête vide, ni requête d'un seul caractère, ni pavé.
egal('une requête vide est refusée', 'vide', R.requeteValide('   ').raison);
egal('un seul caractère est refusé', 'trop-courte', R.requeteValide('a').raison);
egal('un espace ne compte pas pour un caractère', 'trop-courte', R.requeteValide('a ').raison);
egal('au delà de 80 caractères, refus', 'trop-longue', R.requeteValide('x'.repeat(81)).raison);
verif('deux caractères suffisent', R.requeteValide('foi').ok === true);

// d) Plafond de résultats : une requête très large ne peut pas figer l'écran.
const larges = chercher('psaumes', 'de');
verif(`« de » dans les Psaumes s'arrête au plafond (${larges.length} ≤ ${R.MAX_RESULTATS})`,
  larges.length <= R.MAX_RESULTATS);

/* ---- 5. Les références : « Jean 3.16 » mène au bon endroit ------------------- */

const CAT = {
  jean: { nom: 'Jean', nb: 21 }, '1jean': { nom: '1 Jean', nb: 5 },
  psaumes: { nom: 'Psaumes', nb: 150 }, jeremie: { nom: 'Jérémie', nb: 52 },
  job: { nom: 'Job', nb: 42 }, genese: { nom: 'Genèse', nb: 50 }
};
egal('« Jean 3.16 »', { livreId: 'jean', ch: 2, v: 15 }, R.analyserReference('Jean 3.16', CAT));
egal('« jean 3:16 » (deux-points)', { livreId: 'jean', ch: 2, v: 15 }, R.analyserReference('jean 3:16', CAT));
egal('« 1 Jean 2 » ne se confond pas avec Jean', { livreId: '1jean', ch: 1, v: null }, R.analyserReference('1 Jean 2', CAT));
egal('« genese 1 » sans accent', { livreId: 'genese', ch: 0, v: null }, R.analyserReference('genese 1', CAT));
egal('« jea 3 » : une abréviation qui ne désigne qu\'un livre', { livreId: 'jean', ch: 2, v: null }, R.analyserReference('jea 3', CAT));
egal('« je 3 » est ambigu : on renonce', null, R.analyserReference('je 3', CAT));
egal('un chapitre hors du livre est refusé', null, R.analyserReference('Jean 99', CAT));
egal('un livre inconnu est refusé', null, R.analyserReference('Hobbit 3', CAT));
egal('du texte seul n\'est pas une référence', null, R.analyserReference('tant aimé le monde', CAT));

// SÉCURITÉ : une référence ne peut rendre qu'un identifiant DU CATALOGUE —
// c'est ce qui empêche une requête de devenir un chemin de fichier.
['../../etc/passwd 1', '..%2f..%2fapi%2fdb.php 1', 'jean/../../secret 3', 'http://ailleurs.tld/x 1']
  .forEach(mauvais => egal(`« ${mauvais} » ne donne aucun livre`, null, R.analyserReference(mauvais, CAT)));
const ref = R.analyserReference('Jean 3', CAT);
verif("l'identifiant rendu appartient toujours au catalogue",
  ref !== null && Object.prototype.hasOwnProperty.call(CAT, ref.livreId));

console.log(`\n${pass} réussites, ${fail} échecs`);
process.exit(fail === 0 ? 0 : 1);
