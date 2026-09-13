/* ============================================================================
   La MISE À JOUR de l'appli, dans un VRAI navigateur — le parcours complet
   d'un déploiement, épreuve et contre-épreuves.

   Pourquoi ce fichier existe : la classe de bugs qui a le plus mordu en
   production n'était pas dans un endpoint — c'était le service worker.
   Un numéro de cache oublié, et des téléphones servaient une vieille page
   avec un nouveau client d'API ; personne ne le voyait en développement,
   parce que personne n'y VIT une mise à jour. Ici, on en vit une :

   - version N : premier chargement, le service worker s'installe, la
     coquille entre au cache — et AUCUNE invitation ne s'affiche (au premier
     passage, il n'y a rien à mettre à jour) ;
   - on « déploie » la version N+1 dans une COPIE du site (numéro de cache
     bumpé + un fichier de la coquille modifié, comme un vrai déploiement) ;
   - retour au premier plan (visibilitychange, le geste réel de l'appli) :
     le bouton « Une mise à jour est prête » apparaît, on le touche, la
     nouvelle version prend l'écran ;
   - hors-ligne : la NOUVELLE coquille est servie depuis le cache — preuve
     que l'ancien cache est parti et que le nouveau est complet ;
   - contre-épreuve : re-vérifier sans nouveau déploiement n'affiche RIEN —
     pas de fausse joie.

   Le test se sert tout seul : il copie l'arbre du site dans un dossier
   temporaire (pour pouvoir y « déployer » sans toucher au vrai), lance son
   propre `php -S` dessus (SQLite frais, jamais la base des autres tests),
   et range tout en partant.

   Lancement :  node api/tests/navigateur/mise-a-jour.mjs [racine] [port]
   Prérequis : Playwright (ou BH_PLAYWRIGHT) et `php` sur le PATH.
   ========================================================================== */

import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = resolve(process.argv[2] || join(ICI, '..', '..', '..'));
const PORT = Number(process.argv[3] || 8189);
const BASE = `http://127.0.0.1:${PORT}`;

let REUSSITES = 0;
let ECHECS = 0;
function ok(m) { REUSSITES++; console.log('   ok   ' + m); }
function raté(m) { ECHECS++; console.log('   FAIL ' + m); }
function attendu(cond, m) { if (cond) ok(m); else raté(m); }
const pause = ms => new Promise(r => setTimeout(r, ms));

/* ---- Playwright, pris là où il se trouve (même règle que veillees.mjs) ------ */
async function chargerPlaywright() {
  try { return await import('playwright'); } catch (e) { /* pas à côté */ }
  const ailleurs = (process.env.BH_PLAYWRIGHT || '').trim();
  if (ailleurs !== '') {
    const chemin = ailleurs.endsWith('.js') ? ailleurs : ailleurs.replace(/\/$/, '') + '/playwright/index.js';
    return await import(pathToFileURL(chemin).href);
  }
  throw new Error('Playwright introuvable : installe-le, ou pose BH_PLAYWRIGHT sur le dossier node_modules qui le contient.');
}

/* ---- La copie du site : notre « production » à nous ------------------------- */
// On écarte ce qui n'entre pas dans la coquille : le dépôt git, les données
// locales, la Bible complète (pré-cachée en best-effort — son absence ne fait
// pas échouer l'installation, c'est même une propriété que le vrai sw.js
// garantit) et les tests eux-mêmes.
const COPIE = mkdtempSync(join(tmpdir(), 'bh-maj-'));
cpSync(RACINE, COPIE, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(RACINE.length).replace(/\\/g, '/');
    return !(rel.startsWith('/.git') || rel.startsWith('/api/data')
      || rel.startsWith('/lire/data') || rel.startsWith('/api/tests/navigateur'));
  },
});
mkdirSync(join(COPIE, 'api', 'data'), { recursive: true });

/* ---- Son serveur à elle : SQLite frais, jamais la base des autres passes ---- */
const env = { ...process.env, ADMIN_EMAILS: 'x@example.org', PROXY_HOPS: '0' };
delete env.MYSQL_URL; delete env.BH_TEST_MYSQL_URL;
delete env.BREVO_API_KEY; delete env.SMTP_HOST;
const serveur = spawn('php', ['-S', `127.0.0.1:${PORT}`, 'api/tests/router.php'],
  { cwd: COPIE, env, stdio: 'ignore' });

let debout = false;
for (let i = 0; i < 50 && !debout; i++) {
  try { const r = await fetch(BASE + '/index.html'); debout = r.ok; } catch (e) { await pause(200); }
}
if (!debout) { console.log('FAIL le serveur de la copie ne répond pas'); serveur.kill(); process.exit(1); }

const playwright = await chargerPlaywright();
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
const nav = await chromium.launch();

const versionDe = txt => (txt.match(/const CACHE = '([^']+)'/) || [])[1] || '';
const CHEMIN_SW = join(COPIE, 'sw.js');
const V1 = versionDe(readFileSync(CHEMIN_SW, 'utf8'));

try {
  const ctx = await nav.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  /* ---- Version N : première visite, le service worker s'installe ---------- */
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const caches1 = await page.evaluate(() => caches.keys());
  attendu(caches1.includes(V1), `première visite : la coquille ${V1} est au cache (${caches1.join(', ')})`);
  await pause(1200); // le temps que claim() passe — s'il devait afficher à tort, ce serait là
  attendu(await page.locator('#maj-prete').count() === 0,
    'première visite : aucune invitation à recharger (il n\'y a rien à mettre à jour)');

  // Deuxième visite ordinaire : la page est contrôlée dès le départ — c'est
  // dans cet état que vivent tous les habitués de l'appli.
  await page.reload({ waitUntil: 'load' });
  attendu(await page.evaluate(() => !!navigator.serviceWorker.controller),
    'visite suivante : la page est servie sous le contrôle du service worker');

  /* ---- On déploie la version N+1 dans la copie ----------------------------- */
  const V2 = V1 + '-test-maj';
  writeFileSync(CHEMIN_SW, readFileSync(CHEMIN_SW, 'utf8').replace(`const CACHE = '${V1}'`, `const CACHE = '${V2}'`));
  appendFileSync(join(COPIE, 'app.js'), '\nwindow.BH_TEST_VERSION = 2;\n');

  // Le geste réel : l'appli revient au premier plan, app.js demande lui-même
  // au service worker d'aller voir si une nouvelle version existe.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  try {
    await page.waitForSelector('#maj-prete', { timeout: 15000 });
    ok('retour au premier plan : « Une mise à jour est prête » s\'affiche');
  } catch (e) {
    raté('retour au premier plan : l\'invitation à recharger n\'est jamais apparue');
  }
  const texte = await page.locator('#maj-prete').textContent().catch(() => '');
  attendu(/mise à jour est prête/.test(texte || ''), 'le bouton dit bien ce qu\'il propose');

  /* ---- On touche le bouton : la nouvelle version prend l'écran ------------- */
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#maj-prete')]);
  attendu(await page.evaluate(() => window.BH_TEST_VERSION) === 2,
    'après le geste : la nouvelle coquille est à l\'écran');
  const caches2 = await page.evaluate(() => caches.keys());
  attendu(caches2.includes(V2) && !caches2.includes(V1),
    `l'ancien cache ${V1} est parti, le nouveau ${V2} l'a remplacé (${caches2.join(', ')})`);

  /* ---- Hors-ligne : la nouvelle coquille tient toute seule ----------------- */
  await page.evaluate(() => navigator.serviceWorker.ready); // la v2 a fini d'installer sa coquille
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  attendu(await page.evaluate(() => window.BH_TEST_VERSION) === 2,
    'hors-ligne : la NOUVELLE version est servie depuis le cache');
  await ctx.setOffline(false);

  /* ---- Contre-épreuve : pas de nouveau déploiement, pas de fausse joie ----- */
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await pause(2500);
  attendu(await page.locator('#maj-prete').count() === 0,
    'contre-épreuve : re-vérifier sans nouvelle version n\'invite PAS à recharger');

  await ctx.close();
} finally {
  await nav.close().catch(() => {});
  serveur.kill();
  rmSync(COPIE, { recursive: true, force: true });
}

console.log(`${REUSSITES} réussites, ${ECHECS} échecs`);
process.exit(ECHECS === 0 ? 0 : 1);
