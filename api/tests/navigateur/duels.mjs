/* ============================================================================
   Les duels entre amis, dans un VRAI navigateur — épreuves ET contre-épreuves.

   La suite d'API éprouve chaque endpoint ; ce fichier rejoue les PARCOURS,
   ceux qu'un joueur fait vraiment avec ses doigts — parce qu'un écran peut
   mentir alors que chaque endpoint dit vrai (la carte « 2 défis relevés »
   qui menait à un menu au lieu d'une feuille de score est passée par là).

   Épreuves (le chemin heureux, de bout en bout) :
   - la liste d'amis lance un duel d'un geste, l'invitée le reçoit, chacun
     joue, chacun a sa revue question par question ;
   - « Tes duels » raconte l'attente puis le score, sans ambiguïté ;
   - l'accueil de l'appli : une carte PAR défi relevé, scores dessus, un
     clic ouvre la feuille de score de CE duel et la marque comme vue.

   Contre-épreuves (ce qui doit rater, rate) :
   - un score annoncé ne vaut rien : le serveur rejoue les réponses ;
   - annuler sans la clé → 403 ; un duel relevé ne s'annule pas → 409 ;
   - défier un inconnu (pas ami) → 403 ;
   - sans compte : pas de liste d'amis, les grandes cartes « par code »
     restent l'entrée ; connecté : elles se replient en une ligne.

   Lancement :  node api/tests/navigateur/duels.mjs [adresse]
   Prérequis : Playwright (ou BH_PLAYWRIGHT) et un serveur de test debout,
   comme veillees.mjs. Sans Playwright, run-tests.sh le DIT et passe outre.
   ========================================================================== */

const BASE = process.argv[2] || 'http://127.0.0.1:8180';

let REUSSITES = 0;
let ECHECS = 0;
function ok(m) { REUSSITES++; console.log('   ok   ' + m); }
function raté(m) { ECHECS++; console.log('   FAIL ' + m); }
function attendu(cond, m) { if (cond) ok(m); else raté(m); }

/* ---- L'API, pour poser le décor (comptes, amitiés, duels) ------------------- */
async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
async function compte(email, pseudo) {
  const dem = await api('POST', '/api/auth/request-code', null, { email });
  if (!dem.data.devCode) throw new Error('serveur pas en mode dev : ' + JSON.stringify(dem.data).slice(0, 120));
  const v = await api('POST', '/api/auth/verify', null, { email, code: dem.data.devCode, pseudo });
  return v.data; // { token, user }
}

const ED = [
  { q: 'Première question ?', options: ['bonne', 'mauvaise'], bonne: 0 },
  { q: 'Deuxième question ?', options: ['mauvaise', 'bonne'], bonne: 1 },
  { q: 'Troisième question ?', options: ['bonne', 'mauvaise'], bonne: 0 },
];

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
async function pageDe(session) {
  const ctx = await nav.newContext({ viewport: { width: 390, height: 844 } });
  if (session) {
    await ctx.addInitScript(s => localStorage.setItem('graine.session', JSON.stringify(s)), session);
  }
  return ctx.newPage();
}
async function jouerChoix(p) {
  await p.waitForSelector('.opts .opt', { timeout: 8000 });
  for (let i = 0; i < 10; i++) { await p.click('.opts .opt:first-child'); await p.click('[data-suiv]'); }
  await p.waitForSelector('.card.fin', { timeout: 8000 });
}

try {
  /* ---- Le décor : Jim, deux amies, un tiers qui n'est pas ami --------------- */
  const jim = await compte('duels-jim@example.org', 'Jim');
  const cey = await compte('duels-cey@example.org', 'Ceylia');
  const mar = await compte('duels-mar@example.org', 'Marie');
  const zoe = await compte('duels-zoe@example.org', 'Zoé'); // pas amie de Jim
  await api('POST', '/api/friends/add', jim.token, { code: cey.user.friendCode });
  await api('POST', '/api/friends/add', jim.token, { code: mar.user.friendCode });

  /* ==== ÉPREUVE 1 — le duel entre amis, de la liste jusqu'aux deux revues ==== */
  const pj = await pageDe({ token: jim.token, user: jim.user });
  await pj.goto(BASE + '/quiadit/');
  await pj.click('[data-vers="dmenu"]');
  await pj.waitForSelector('.duel-row.ami', { timeout: 8000 });
  const menu = (await pj.textContent('.fade')).replace(/\s+/g, ' ');
  attendu(menu.includes('Par code, même sans compte') && !menu.includes('Créer un défi '),
    'connecté : le « par code » est replié en une ligne');
  await pj.click('.duel-row.ami');
  await jouerChoix(pj);
  let ecran = (await pj.textContent('.fade')).replace(/\s+/g, ' ');
  attendu(ecran.includes('La revue, question par question') && /✓|✗/.test(ecran),
    'le lanceur joue et reçoit sa revue, verdicts à l’appui');

  const pc = await pageDe({ token: cey.token, user: cey.user });
  await pc.goto(BASE + '/quiadit/');
  await pc.click('[data-vers="dmenu"]');
  await pc.waitForSelector('[data-defirecu]', { timeout: 8000 });
  const recu = (await pc.textContent('[data-defirecu]')).replace(/\s+/g, ' ');
  attendu(recu.includes('Jim') && recu.includes("À toi de relever l'épreuve"),
    'l’invitée trouve « Jim — À toi de relever l’épreuve »');
  await pc.click('[data-defirecu]');
  await jouerChoix(pc);
  ecran = (await pc.textContent('.fade')).replace(/\s+/g, ' ');
  attendu(ecran.includes('Ton duel avec Jim') && ecran.includes('La revue'),
    'l’invitée aussi : « Ton duel avec Jim » et sa propre revue');

  /* ==== ÉPREUVE 2 — « Tes duels » dit qui a quoi, et le fil de l'amitié ===== */
  await pj.click('[data-quit]');
  await pj.click('[data-vers="dmenu"]');
  await pj.waitForSelector('[data-fini]', { timeout: 8000 });
  const fini = (await pj.textContent('[data-fini]')).replace(/\s+/g, ' ');
  attendu(/Toi \d+ — Ceylia \d+/.test(fini), '« Duels terminés » : « Toi X — Ceylia Y », sans ambiguïté');
  const amiRow = (await pj.textContent('.duel-row.ami')).replace(/\s+/g, ' ');
  attendu(amiRow.includes('1 duel'), 'la ligne de l’amie porte le fil : « ' + amiRow.slice(0, 60) + ' »');
  await pj.click('[data-fini]');
  await pj.waitForFunction(() => document.body && document.body.textContent.includes('La revue'), null, { timeout: 8000 });
  ok('un clic sur la ligne finie rouvre le résultat, revue comprise');

  /* ==== ÉPREUVE 3 — l'accueil : une carte PAR résultat, un clic = la feuille = */
  const d2 = await api('POST', '/api/epreuve/duel', jim.token,
    { mode: 'Écrit… ou pas ?', deck: ED, opponentCode: mar.user.friendCode });
  await api('POST', '/api/epreuve/duel/' + d2.data.code + '/score', null, { cle: d2.data.cle, answers: [0, 1, 0] });
  await api('POST', '/api/epreuve/duel/' + d2.data.code + '/score', null, { pseudo: 'Marie', answers: [1, 1, 0] });
  const ph = await pageDe({ token: jim.token, user: jim.user });
  await ph.goto(BASE + '/');
  await ph.waitForSelector('.card.attente', { timeout: 8000 });
  const cartes = await ph.$$eval('.card.attente', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  attendu(cartes.length === 2 && cartes.every(c => /Toi \d+ — (Ceylia|Marie) \d+/.test(c)),
    'accueil : une carte par défi relevé, scores écrits dessus (' + cartes.length + ' cartes)');
  await ph.click('.card.attente .attente-corps');
  await ph.waitForURL(/duel=/, { timeout: 8000 });
  await ph.waitForFunction(() => document.body && document.body.textContent.includes('La revue'), null, { timeout: 8000 });
  ok('le clic ouvre la feuille de score de CE duel — pas un menu');
  await ph.goto(BASE + '/');
  await ph.waitForSelector('.card.attente', { timeout: 8000 });
  const restantes = await ph.$$eval('.card.attente', els => els.length);
  attendu(restantes === 1, 'le résultat consulté a quitté l’accueil, l’autre attend toujours');

  /* ==== CONTRE-ÉPREUVES — ce qui doit rater, rate =========================== */
  // Le score annoncé ne vaut rien : les réponses tranchent.
  const d3 = await api('POST', '/api/epreuve/duel', jim.token,
    { mode: 'Qui a dit ça ?', deck: ED, opponentCode: cey.user.friendCode });
  const triche = await api('POST', '/api/epreuve/duel/' + d3.data.code + '/score', null,
    { cle: d3.data.cle, score: 3, answers: [1, 0, 1] });   // tout faux, mais « 3 » annoncé
  attendu(triche.status === 200 && triche.data.p1.score === 0,
    'contre-épreuve : score annoncé 3, réponses toutes fausses → le serveur retient 0');
  // Annuler sans la clé, ou un duel déjà relevé.
  const sansCle = await api('POST', '/api/epreuve/duel/' + d3.data.code + '/annuler', null, { cle: 'forgée' });
  attendu(sansCle.status === 403, 'contre-épreuve : annuler sans la clé → 403');
  const releve = await api('POST', '/api/epreuve/duel/' + d2.data.code + '/annuler', null, { cle: d2.data.cle });
  attendu(releve.status === 409, 'contre-épreuve : annuler un duel relevé → 409, le résultat reste');
  // Défier quelqu'un qui n'est pas un ami.
  const inconnu = await api('POST', '/api/epreuve/duel', jim.token,
    { mode: 'Qui a dit ça ?', deck: ED, opponentCode: zoe.user.friendCode });
  attendu(inconnu.status === 403, 'contre-épreuve : défier un non-ami → 403');
  // Sans compte : pas d'amis, les grandes cartes par code restent l'entrée.
  const pa = await pageDe(null);
  await pa.goto(BASE + '/quiadit/');
  await pa.click('[data-vers="dmenu"]');
  await pa.waitForSelector('.hub-card[data-vers="dcfg"]', { timeout: 8000 });
  const anon = (await pa.textContent('.fade')).replace(/\s+/g, ' ');
  attendu(anon.includes('Créer un défi') && anon.includes("J'ai reçu un code") && !anon.includes('Défier un ami directement'),
    'contre-épreuve : sans compte, les grandes cartes par code — et aucune liste d’amis');
} finally {
  await nav.close();
}

console.log(`${REUSSITES} réussites, ${ECHECS} échecs (navigateur duels)`);
if (ECHECS > 0) process.exit(1);
