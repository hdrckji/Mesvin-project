/* ============================================================================
   La CONNEXION GOOGLE de l'appli du Play Store, dans un VRAI navigateur.

   Pourquoi ce fichier existe : dans l'appli installée, la page de Google
   s'ouvre dans Chrome. Selon le téléphone, la suite (/#google=…) atterrit
   dans Chrome plutôt que dans l'appli, ou l'appli revient au premier plan
   sans rien recevoir — et l'utilisateur reste « pas connecté », sans un mot.
   Le serveur garde donc le jeton sous l'empreinte du nonce (relais), et
   l'appli vient le chercher en revenant à l'écran. On rejoue ici chaque
   chemin, avec un faux Google (tokeninfo local) et un faux script GSI :

   - le pire cas : Google termine dans un « Chrome » au stockage SÉPARÉ,
     l'appli revient sans rien recevoir → elle se connecte par le relais,
     et la session survit au rechargement ;
   - l'appli revient AVANT que le serveur ait reçu le jeton → les essais
     rapprochés finissent par le trouver ;
   - le retour par l'ancre dans l'appli déjà ouverte (hashchange), relais
     en concurrence → connectée, sans message d'erreur ;
   - contre-épreuve : un jeton portant le nonce d'un AUTRE appareil ne
     connecte personne.

   Le test se sert tout seul (copie du site, son `php -S`, SQLite frais).

   Lancement :  node api/tests/navigateur/connexion-google.mjs [racine] [port]
   Prérequis : Playwright (ou BH_PLAYWRIGHT) et `php` sur le PATH.
   ========================================================================== */

import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = resolve(process.argv[2] || join(ICI, '..', '..', '..'));
const PORT = Number(process.argv[3] || 8191);
const PORT_GOOGLE = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

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

/* ---- La copie du site et un faux Google ------------------------------------- */
const COPIE = mkdtempSync(join(tmpdir(), 'bh-google-'));
cpSync(RACINE, COPIE, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(RACINE.length).replace(/\\/g, '/');
    return !(rel.startsWith('/.git') || rel.startsWith('/api/data')
      || rel.startsWith('/lire/data') || rel.startsWith('/api/tests/navigateur'));
  },
});
mkdirSync(join(COPIE, 'api', 'data'), { recursive: true });
// Faux tokeninfo : rend le contenu du jeton (non signé), comme Google le
// rendrait d'un vrai jeton dont il a vérifié la signature.
const GOOGLE = mkdtempSync(join(tmpdir(), 'bh-fauxgoogle-'));
writeFileSync(join(GOOGLE, 'index.php'), `<?php
$p = explode('.', (string) ($_GET['id_token'] ?? ''));
$pl = json_decode((string) base64_decode(strtr($p[1] ?? '', '-_', '+/')), true);
header('Content-Type: application/json');
if (!is_array($pl)) { http_response_code(400); echo '{}'; exit; }
echo json_encode($pl);
`);

const env = { ...process.env, PROXY_HOPS: '0', GOOGLE_CLIENT_ID: 'client-test',
  GOOGLE_TOKENINFO_URL: `http://127.0.0.1:${PORT_GOOGLE}/` };
delete env.MYSQL_URL; delete env.BH_TEST_MYSQL_URL;
delete env.BREVO_API_KEY; delete env.SMTP_HOST;
const serveur = spawn('php', ['-S', `127.0.0.1:${PORT}`, 'api/tests/router.php'], { cwd: COPIE, env, stdio: 'ignore' });
const google = spawn('php', ['-S', `127.0.0.1:${PORT_GOOGLE}`, 'index.php'], { cwd: GOOGLE, stdio: 'ignore' });

let debout = false;
for (let i = 0; i < 50 && !debout; i++) {
  try { const r = await fetch(BASE + '/api/config'); debout = r.ok; } catch (e) { await pause(200); }
}
if (!debout) { console.log('FAIL le serveur de la copie ne répond pas'); serveur.kill(); google.kill(); process.exit(1); }

const playwright = await chargerPlaywright();
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
const nav = await chromium.launch();

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jeton = (nonce, email) => b64({ alg: 'none' }) + '.' + b64({ nonce, email, aud: 'client-test',
  iss: 'https://accounts.google.com', email_verified: 'true', given_name: 'Jim' }) + '.sig';
// Visibilité simulée : le geste réel de l'appli qui passe derrière Chrome, puis revient.
const visibilite = (p, etat) => p.evaluate(e => {
  Object.defineProperty(document, 'visibilityState', { value: e, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, etat);
const etat = p => p.evaluate(() => ({ connecte: GraineAPI.isLoggedIn(), etape: auth && auth.step, erreur: auth && auth.error }));

/** L'appli sur l'écran Compte, bouton Google monté (faux GSI : pas de réseau). */
async function appli() {
  const ctx = await nav.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true });
  await ctx.route('https://accounts.google.com/**', r => r.fulfill({ contentType: 'text/javascript',
    body: 'window.google={accounts:{id:{initialize(){},renderButton(el){el.appendChild(document.createElement("div"))}}}};' }));
  const p = await ctx.newPage();
  p.on('pageerror', e => raté('erreur JS : ' + e.message));
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.evaluate(() => startAccountFlow());
  let nonce = null;
  for (let i = 0; i < 40 && !nonce; i++) { await pause(150); nonce = await p.evaluate(() => localStorage.getItem('graine.googleNonce')); }
  return { ctx, p, nonce };
}
/** « Chrome » : un AUTRE contexte (stockage séparé) poste le formulaire comme Google. */
async function googlePoste(cred) {
  const ctx = await nav.newContext({ userAgent: UA });
  const p = await ctx.newPage();
  let location = '';
  p.on('response', r => { if (r.url().includes('/api/auth/google/redirect')) location = r.headers()['location'] || ''; });
  await p.setContent(`<form method="post" action="${BASE}/api/auth/google/redirect"><input name="credential" value="${cred}"></form>`);
  await Promise.all([p.waitForNavigation(), p.evaluate(() => document.forms[0].submit())]);
  await ctx.close();
  return location;
}

try {
  /* ---- Le pire cas : le retour se perd dans Chrome ------------------------- */
  {
    const { ctx, p, nonce } = await appli();
    attendu(/^[a-f0-9]{32}$/.test(nonce || ''), 'mobile : le bouton Google pose un nonce (mode redirection)');
    await visibilite(p, 'hidden');
    const location = await googlePoste(jeton(nonce, 'un@exemple.org'));
    attendu(location.startsWith('/#google='), 'serveur : le retour de Google repart vers /#google=…');
    await visibilite(p, 'visible');
    await pause(2500);
    const e = await etat(p);
    attendu(e.connecte && e.etape === 'welcome' && !e.erreur,
      'retour perdu dans Chrome : l\'appli se connecte par le relais, écran Bienvenue');
    await p.reload({ waitUntil: 'load' });
    attendu((await etat(p)).connecte, '… et la session survit à la relance');
    await ctx.close();
  }

  /* ---- L'appli revient avant que le serveur ait le jeton -------------------- */
  {
    const { ctx, p, nonce } = await appli();
    await visibilite(p, 'hidden');
    await visibilite(p, 'visible');
    await pause(800);
    await googlePoste(jeton(nonce, 'deux@exemple.org'));
    await pause(6000);
    attendu((await etat(p)).connecte, 'appli revenue trop tôt : les essais rapprochés trouvent le jeton');
    await ctx.close();
  }

  /* ---- Le retour par l'ancre, relais en concurrence ------------------------- */
  {
    const { ctx, p, nonce } = await appli();
    await visibilite(p, 'hidden');
    const cred = jeton(nonce, 'trois@exemple.org');
    await googlePoste(cred);
    await p.evaluate(c => { location.hash = '#google=' + c; }, cred);
    await visibilite(p, 'visible');
    await pause(2500);
    const e = await etat(p);
    attendu(e.connecte && !e.erreur, 'retour par l\'ancre dans l\'appli ouverte : connectée, sans message d\'erreur');
    await ctx.close();
  }

  /* ---- Contre-épreuve : le nonce d'un autre appareil ne connecte personne --- */
  {
    const { ctx, p } = await appli();
    await visibilite(p, 'hidden');
    await googlePoste(jeton('f'.repeat(32), 'autre@exemple.org'));
    await visibilite(p, 'visible');
    await pause(2000);
    attendu(!(await etat(p)).connecte, 'contre-épreuve : le jeton d\'un autre appareil ne connecte pas');
    await ctx.close();
  }
} finally {
  await nav.close().catch(() => {});
  serveur.kill(); google.kill();
  rmSync(COPIE, { recursive: true, force: true });
  rmSync(GOOGLE, { recursive: true, force: true });
}

console.log(`${REUSSITES} réussites, ${ECHECS} échecs`);
process.exit(ECHECS ? 1 : 0);
