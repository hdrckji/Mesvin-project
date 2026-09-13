/* ============================================================================
   La CONNEXION par le vrai écran, dans un VRAI navigateur.

   Partout ailleurs, les tests navigateur posent une session toute faite dans
   localStorage — c'est le bon outil pour tester les duels, pas la connexion.
   Or la connexion est LA porte : si elle coince, plus rien n'existe derrière.
   Ici, on la passe comme un joueur : au doigt, écran par écran.

   Épreuves :
   - sans compte, l'accueil propose « Se connecter » ; on tape son e-mail,
     l'écran du code s'affiche (en mode test, le code s'y montre) ;
   - premier compte : le code juste mène au choix du pseudo, puis à l'écran
     de bienvenue avec le code ami ; l'accueil porte alors le pseudo ;
   - la session SURVIT au rechargement — c'est elle que tous les habitués
     retrouvent chaque matin ;
   - deuxième venue (autre navigateur, même adresse) : le code suffit, pas
     de pseudo redemandé, on retombe sur SON compte.

   Contre-épreuve :
   - un code faux est refusé, l'erreur se DIT à l'écran, et on reste
     déconnecté.

   Lancement :  node api/tests/navigateur/connexion.mjs [adresse]
   Prérequis : Playwright (ou BH_PLAYWRIGHT) et le serveur de test debout,
   en mode dev (le code de connexion doit s'afficher à l'écran).
   ========================================================================== */

const BASE = process.argv[2] || 'http://127.0.0.1:8180';

let REUSSITES = 0;
let ECHECS = 0;
function ok(m) { REUSSITES++; console.log('   ok   ' + m); }
function raté(m) { ECHECS++; console.log('   FAIL ' + m); }
function attendu(cond, m) { if (cond) ok(m); else raté(m); }

/* ---- Playwright, pris là où il se trouve (même règle que veillees.mjs) ------ */
async function chargerPlaywright() {
  try { return await import('playwright'); } catch (e) { /* pas à côté */ }
  const ailleurs = (process.env.BH_PLAYWRIGHT || '').trim();
  if (ailleurs !== '') {
    const { pathToFileURL } = await import('node:url');
    const chemin = ailleurs.endsWith('.js') ? ailleurs : ailleurs.replace(/\/$/, '') + '/playwright/index.js';
    return await import(pathToFileURL(chemin).href);
  }
  throw new Error('Playwright introuvable : installe-le, ou pose BH_PLAYWRIGHT sur le dossier node_modules qui le contient.');
}

const playwright = await chargerPlaywright();
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
if (!chromium) throw new Error('Playwright chargé mais sans « chromium ».');

const nav = await chromium.launch();
async function pageNeuve() {
  const ctx = await nav.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  return { ctx, page };
}

// Jusqu'à l'écran du code : le geste commun aux deux visites.
async function jusquAuCode(page, email) {
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.click('.acc-chip.connect');
  await page.waitForSelector('#auth-email', { timeout: 8000 });
  await page.fill('#auth-email', email);
  await page.click('form[data-authstep="email"] button[type="submit"]');
  await page.waitForSelector('#auth-code', { timeout: 8000 });
  const dev = await page.locator('.dev-code').textContent().catch(() => '');
  const code = (dev.match(/(\d{6})/) || [])[1] || '';
  return code;
}

const EMAIL = `connexion.reelle.${Math.floor(Math.random() * 1e9)}@example.org`;

try {
  /* ---- Première venue : e-mail → code → pseudo → bienvenue ----------------- */
  const { ctx, page } = await pageNeuve();
  attendu(true, 'décor : un navigateur neuf, aucun compte');

  const code = await jusquAuCode(page, EMAIL);
  attendu(/^\d{6}$/.test(code), `l'écran du code s'affiche, le code de test s'y montre (${code || 'absent'})`);

  // Contre-épreuve d'abord : un code faux est refusé, et ça se DIT.
  const faux = code === '000000' ? '000001' : '000000';
  await page.fill('#auth-code', faux);
  await page.click('form[data-authstep="code"] button[type="submit"]');
  await page.waitForSelector('.field-error', { timeout: 8000 });
  attendu(await page.locator('#auth-code').count() === 1,
    'contre-épreuve : code faux → l\'erreur s\'affiche, on reste sur l\'écran du code');
  attendu(await page.evaluate(() => !localStorage.getItem('graine.session')),
    'contre-épreuve : code faux → toujours déconnecté');

  // Le bon code : première connexion, l'appli demande un pseudo.
  await page.fill('#auth-code', code);
  await page.click('form[data-authstep="code"] button[type="submit"]');
  await page.waitForSelector('#auth-pseudo', { timeout: 8000 });
  ok('bon code, premier compte : l\'appli demande le pseudo');
  await page.fill('#auth-pseudo', 'Testeuse');
  await page.click('form[data-authstep="pseudo"] button[type="submit"]');
  await page.waitForSelector('.done-screen', { timeout: 8000 });
  const bienvenue = await page.locator('.done-screen h2').textContent().catch(() => '');
  attendu(/Bienvenue, Testeuse/.test(bienvenue || ''), 'l\'écran de bienvenue salue par le pseudo');
  const codeAmi = await page.locator('.friend-code').textContent().catch(() => '');
  attendu((codeAmi || '').trim().length >= 4, `le code ami est montré (${(codeAmi || '').trim()})`);

  await page.click('[data-authdone]'); // « C'est parti » mène à l'écran Moi
  await page.waitForSelector('[data-tab="home"]', { timeout: 8000 });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('.acc-chip', { timeout: 8000 });
  attendu(/Testeuse/.test(await page.locator('.acc-chip').textContent() || ''),
    'de retour à l\'accueil : la pastille du compte porte le pseudo');

  // La session survit au rechargement — le quotidien de tous les habitués.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.acc-chip', { timeout: 8000 });
  attendu(/Testeuse/.test(await page.locator('.acc-chip').textContent() || ''),
    'après rechargement : toujours connectée, sans rien ressaisir');
  await ctx.close();

  /* ---- Deuxième venue : autre navigateur, même adresse --------------------- */
  const retour = await pageNeuve();
  const code2 = await jusquAuCode(retour.page, EMAIL);
  attendu(/^\d{6}$/.test(code2), 'deuxième venue : un nouveau code s\'affiche');
  await retour.page.fill('#auth-code', code2);
  await retour.page.click('form[data-authstep="code"] button[type="submit"]');
  await retour.page.waitForSelector('.done-screen', { timeout: 8000 });
  const re = await retour.page.locator('.done-screen h2').textContent().catch(() => '');
  attendu(/Bienvenue, Testeuse/.test(re || ''),
    'le code suffit : pas de pseudo redemandé, on retombe sur SON compte');
  await retour.ctx.close();
} finally {
  await nav.close().catch(() => {});
}

console.log(`${REUSSITES} réussites, ${ECHECS} échecs`);
process.exit(ECHECS === 0 ? 0 : 1);
