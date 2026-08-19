/* ============================================================================
   Les veillées, dans un VRAI navigateur.

   La suite de api/tests/run-tests.sh éprouve l'API ; elle ne peut rien dire de
   ce que voit la salle. Or une veillée se joue sur trois écrans à la fois — le
   téléphone de l'animateur, le vidéoprojecteur, les téléphones des
   participants — et c'est précisément là que les défauts font mal : un grand
   écran figé devant vingt personnes, une projection qui porterait les
   commandes de l'animateur, une réponse qui n'arrive nulle part.

   Ce fichier ouvre donc Chromium et joue une veillée pour chaque module :
   - le Défi, dans SES DEUX configurations d'écran (un seul écran, deux écrans)
     — dont la révélation pendant que l'animateur a l'écran VERROUILLÉ ;
   - les quatre épreuves, avec leur projection.

   Lancement :  node api/tests/navigateur/veillees.mjs [adresse]
   Prérequis : Playwright (NODE_PATH peut pointer ailleurs) et un serveur de
   test déjà debout. Sans Playwright, run-tests.sh le DIT et passe outre — le
   reste de la suite n'en dépend pas.
   ========================================================================== */

const BASE = process.argv[2] || 'http://127.0.0.1:8700';

/* L'animateur ouvre SA session, ici et maintenant. Recevoir un jeton du
   dehors paraissait plus simple — mais un jeton fabriqué au début d'une suite
   de plusieurs centaines de vérifications peut très bien ne plus valoir rien
   quand ce scénario démarre. Une adresse qui n'appartient qu'à lui évite au
   passage de manger le plafond de demandes de code d'un autre. */
const EMAIL_ANIMATEUR = process.env.BH_EMAIL_ANIMATEUR || 'animateur-navigateur@example.org';

async function ouvrirSession() {
  const demande = await fetch(BASE + '/api/auth/request-code', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL_ANIMATEUR }),
  }).then(r => r.json());
  if (!demande.devCode) {
    throw new Error("Pas de code de connexion : le serveur n'est pas en mode dev (" + JSON.stringify(demande).slice(0, 120) + ')');
  }
  const session = await fetch(BASE + '/api/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL_ANIMATEUR, code: demande.devCode, pseudo: 'Animateur' }),
  }).then(r => r.json());
  if (!session.token) { throw new Error('Connexion impossible : ' + JSON.stringify(session).slice(0, 120)); }
  return session.token;
}

const JETON = await ouvrirSession();

let echecs = 0, reussites = 0;
const attendre = ms => new Promise(r => setTimeout(r, ms));
const dire = (bon, quoi, detail) => {
  if (bon) { reussites++; console.log('   ok   ' + quoi); }
  else { echecs++; console.log('   FAIL ' + quoi + (detail ? '\n        ' + String(detail).replace(/\s+/g, ' ').trim().slice(0, 220) : '')); }
};
const texte = p => p.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').trim());

/* Attendre QUE QUELQUE CHOSE ARRIVE plutôt qu'attendre un délai : les écrans se
   remplissent au rythme du sondage (~2 s), et un délai fixe finit toujours par
   tomber trop tôt sur une machine chargée — l'écran affiche encore « Un
   instant… » et le test accuse l'appli d'un défaut qui n'est pas le sien. */
async function attendreTexte(page, motif, msMax = 12000) {
  const jusqua = Date.now() + msMax;
  for (;;) {
    const vu = await texte(page);
    if (motif.test(vu)) return vu;
    if (Date.now() > jusqua) return vu;
    // Une seconde, pas moins : lire innerText force un recalcul de mise en
    // page, et le faire trop souvent dispute le fil d'exécution au sondage de
    // l'appli — on finit par mesurer sa propre impatience.
    await attendre(1000);
  }
}

/* Un bouton se reconnaît à son intitulé NETTOYÉ : « ‹ Quitter » commence par un
   chevron, et une comparaison naïve le confondrait avec une proposition. */
const nettoyer = s => (s || '').replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/^[A-D]\s+/, '');
const COMMANDES = /^(quitter|fermer|copier|retour|partager|clore|lancer|un seul|deux écrans|révéler|question suivante)/i;

async function cliquer(page, ...mots) {
  for (const b of await page.$$('button, a.btn')) {
    const l = nettoyer(await b.innerText());
    if (!mots.some(m => l.toLowerCase().includes(m.toLowerCase()))) continue;
    if (!(await b.isEnabled())) continue;            // un bouton grisé n'est pas un clic
    await b.click({ timeout: 5000 }).catch(() => {});
    return true;
  }
  return false;
}

/* Clique une PROPOSITION : tout bouton qui n'est pas une commande. */
async function repondre(page) {
  for (const b of await page.$$('button')) {
    const l = nettoyer(await b.innerText());
    if (l.length > 1 && !COMMANDES.test(l) && (await b.isEnabled())) {
      await b.click({ timeout: 5000 }).catch(() => {});
      return l;
    }
  }
  return null;
}

/* Les commandes de l'animateur ne doivent JAMAIS apparaître sur la projection :
   la salle regarde, elle ne pilote pas. */
const commandesVisibles = page => page.evaluate(() =>
  [...document.querySelectorAll('button, a.btn')]
    .map(e => e.innerText.trim().toLowerCase())
    .filter(l => /révéler|lancer|question suivante|clôturer|clore/.test(l)));

/* ---- Le Défi : ses deux configurations d'écran ----------------------------- */

async function ouvrirAnimateur(ctx, ecrans) {
  const p = await ctx.newPage();
  p.on('pageerror', e => dire(false, 'exception JavaScript (animateur)', e.message));
  await p.goto(BASE + '/index.html');
  await p.evaluate(t => localStorage.setItem('graine.session',
    JSON.stringify({ token: t, user: { email: 'animateur@example.org', pseudo: 'Animateur' } })), JETON);
  await p.goto(BASE + '/defi/'); await attendre(900);
  await p.getByText('Qui, où, quand ?').click(); await attendre(900);
  await p.getByText('En direct, dans ton église').click(); await attendre(900);
  await p.getByText('Animer', { exact: true }).first().click(); await attendre(1500);
  await cliquer(p, '5');
  await cliquer(p, 'Vif · 15 s');
  await cliquer(p, ecrans);
  await cliquer(p, 'Créer le quiz'); await attendre(3000);
  // Le code se lit dans la sauvegarde de l'animateur : le chercher dans le
  // texte de la page ramasserait le numéro de port de l'adresse affichée.
  const code = await p.evaluate(() => (JSON.parse(localStorage.getItem('graine.defi.veillee.v1') || '{}')).code);
  return [p, code];
}

/* Chaque participant reçoit SON contexte — c'est-à-dire son appareil. Deux
   onglets d'un même navigateur partagent la sauvegarde du participant (une
   seule clé pour l'origine) et, surtout, celui du fond voit ses minuteries
   bridées par Chromium : il reste alors au salon pendant que l'autre joue.
   En salle, chacun a son téléphone ; le scénario doit dire la même chose. */
/* Le service worker est BLOQUÉ dans ces contextes. Ce n'est pas lui qu'on
   éprouve ici, et il coûte cher : à chaque nouvel appareil simulé, il
   pré-cache la coquille ET les 4,4 Mo de la Bible. Cinq appareils dans une
   veillée, et le navigateur passe son temps à télécharger — les sondages des
   participants font la queue derrière, un écran reste au salon, et le
   scénario accuse l'appli d'un défaut qui n'est que le sien. (Le service
   worker a sa propre preuve, ailleurs : cf. le commit qui sépare le cache de
   la Bible de celui de la coquille.) */
const OPTIONS_APPAREIL = { viewport: { width: 430, height: 900 }, serviceWorkers: 'block' };
const OPTIONS_ECRAN = { viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' };

const appareils = [];   // les contextes ouverts, à refermer en fin de scénario
async function fermerAppareils() {
  while (appareils.length) { await appareils.pop().close().catch(() => {}); }
}

async function rejoindreDefi(navigateur, code, prenom) {
  const ctx = await navigateur.newContext(OPTIONS_APPAREIL);
  appareils.push(ctx);
  const q = await ctx.newPage();
  q.on('pageerror', e => dire(false, 'exception JavaScript (' + prenom + ')', e.message));
  await q.goto(BASE + '/defi/'); await attendre(700);
  await q.getByText('Qui, où, quand ?').click(); await attendre(700);
  await q.getByText('En direct, dans ton église').click(); await attendre(700);
  await q.getByText('Rejoindre', { exact: true }).first().click(); await attendre(900);
  const champs = await q.$$('input');
  if (champs[0]) await champs[0].fill(code);
  if (champs[1]) await champs[1].fill(prenom);
  await cliquer(q, 'rejoindre', 'entrer', 'valider'); await attendre(2200);
  return q;
}

/* Une veillée d'épreuve : même principe, un appareil par participant. */
async function rejoindreEpreuve(navigateur, module, code, prenom) {
  const ctx = await navigateur.newContext(OPTIONS_APPAREIL);
  appareils.push(ctx);
  const q = await ctx.newPage();
  q.on('pageerror', e => dire(false, 'exception JavaScript (' + prenom + ')', e.message));
  await q.goto(BASE + '/' + module + '/'); await attendre(600);
  await q.getByText('En direct, dans ton église').click(); await attendre(600);
  await q.getByText('Rejoindre', { exact: true }).first().click(); await attendre(800);
  const champs = await q.$$('input');
  if (champs[0]) await champs[0].fill(code);
  if (champs[1]) await champs[1].fill(prenom);
  await cliquer(q, 'rejoindre', 'entrer', 'valider'); await attendre(2200);
  return q;
}

async function defiUnSeulEcran(b) {
  console.log('\n-- Défi · un seul écran (l\'animateur projette son propre appareil)');
  const ctx = await b.newContext(OPTIONS_APPAREIL);
  const [anim, code] = await ouvrirAnimateur(ctx, 'Un seul écran');
  dire(!!code && code.length === 4, 'le quiz est créé, code de 4 caractères', code);
  if (!code) { await ctx.close(); return; }
  await rejoindreDefi(b, code, 'Marie'); await attendre(1200);
  dire(/1/.test(await texte(anim)), 'l\'animateur voit la participante arriver');
  dire(await cliquer(anim, 'lancer'), 'le lancement est possible');
  await attendre(3000);
  dire(/QUESTION/i.test(await texte(anim)), 'la question s\'affiche SUR L\'ÉCRAN DE L\'ANIMATEUR', await texte(anim));
  await fermerAppareils();
  await ctx.close();
}

async function defiDeuxEcrans(b) {
  console.log('\n-- Défi · deux écrans (télécommande + projection), animateur écran VERROUILLÉ');
  const ctx = await b.newContext(OPTIONS_APPAREIL);
  const [anim, code] = await ouvrirAnimateur(ctx, 'Deux écrans');
  dire(!!code, 'le quiz est créé', code);
  if (!code) { await ctx.close(); return; }

  const proj = await ctx.newPage();
  proj.on('pageerror', e => dire(false, 'exception JavaScript (projection)', e.message));
  await proj.goto(BASE + '/defi/'); await attendre(800);
  await proj.getByText('Qui, où, quand ?').click(); await attendre(800);
  await proj.getByText('En direct, dans ton église').click(); await attendre(800);
  // « Grand écran » EXACTEMENT : la carte « Rejoindre » cite les mêmes mots.
  await proj.getByText('Grand écran', { exact: true }).first().click(); await attendre(1200);
  const champs = await proj.$$('input');
  if (champs[0]) await champs[0].fill(code);
  await cliquer(proj, 'afficher', 'grand écran', 'valider', 'ouvrir', 'projeter', 'continuer');
  const projPrete = await attendreTexte(proj, new RegExp(code));
  dire(projPrete.includes(code), 'la projection affiche le code de la salle', projPrete);
  dire((await commandesVisibles(proj)).length === 0, 'aucune commande d\'animateur sur la projection');

  // Les deux téléphones entrent EN PARALLÈLE, comme deux personnes qui sortent
  // leur téléphone en même temps quand le code s'affiche sur le mur.
  const [marie, paul] = await Promise.all([
    rejoindreDefi(b, code, 'Marie'),
    rejoindreDefi(b, code, 'Paul'),
  ]);
  const projDeux = await attendreTexte(proj, /2\s*participant/i);
  dire(/2/.test(projDeux), 'la projection compte les deux participants', projDeux);
  dire(await cliquer(anim, 'lancer'), 'la télécommande peut lancer');
  const projQuestion = await attendreTexte(proj, /QUESTION/i);
  dire(/QUESTION/i.test(projQuestion), 'la question est projetée', projQuestion);

  // Le téléphone de l'animateur se verrouille : plus une seule minuterie, plus
  // un seul sondage de sa part. C'est LE cas qui figeait le grand écran.
  await anim.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    let n = setTimeout(() => {}, 0); while (n--) { clearTimeout(n); clearInterval(n); }
  });
  const telecommandeAvant = await texte(anim);

  for (const [nom, page] of [['Marie', marie], ['Paul', paul]]) {
    // Un onglet d'arrière-plan voit ses minuteries bridées par le navigateur —
    // exactement comme le téléphone qu'on a rangé dans sa poche. On le remet
    // donc au premier plan, ce que fait le participant qui reprend son
    // téléphone en main ; l'appli se rattrape au retour de visibilité.
    await page.bringToFront();
    // Chaque téléphone reçoit la question à SON rythme (sondage ~2 s). Répondre
    // avant qu'elle soit affichée cliquerait dans le salon d'attente. Et si
    // elle tarde vraiment, on RECHARGE : c'est le geste du participant devant
    // un écran qui n'avance pas, et l'appli sait reprendre la partie depuis sa
    // sauvegarde. Un scénario qui ne fait pas ce geste accuse l'appli à tort.
    let vue = await attendreTexte(page, /QUESTION/i, 10000);
    if (!/QUESTION/i.test(vue)) {
      // Un écran qui n'avance pas : le participant recharge, et l'appli
      // reprend la partie depuis sa sauvegarde. C'est un vrai geste, pas un
      // contournement — mais il ne doit jamais être NÉCESSAIRE.
      await page.reload();
      vue = await attendreTexte(page, /QUESTION/i, 10000);
      dire(/QUESTION/i.test(vue), nom + ' n\'a pas eu besoin de recharger', 'il a fallu recharger sa page');
    }
    const choisi = await repondre(page);
    dire(!!choisi, nom + ' a pu répondre', choisi ? '' : await texte(page));
    await attendre(600);
  }
  const projApres = await attendreTexte(proj, /→/, 25000);
  // La révélation se reconnaît à ce que la question n'a pas : la RÉFÉRENCE
  // (précédée d'une flèche) et la répartition des votes.
  dire(/→/.test(projApres) && projApres !== projQuestion,
    'ANIMATEUR VERROUILLÉ : la projection révèle quand même', projApres);
  const chezMarie = await attendreTexte(marie, /bonne réponse|bravo|pas cette fois/i, 12000);
  dire(/bonne réponse|bravo|pas cette fois/i.test(chezMarie),
    'le participant reçoit le verdict et la référence', chezMarie);
  dire((await texte(anim)) === telecommandeAvant, 'la télécommande, elle, n\'a rien envoyé');
  await fermerAppareils();
  await ctx.close();
}

/* ---- Les quatre épreuves : la projection suit toute seule ------------------- */

async function epreuve(b, module, prefixe, titre) {
  console.log('\n-- ' + titre + ' · en direct dans l\'église, avec la projection');
  const ctx = await b.newContext(OPTIONS_ECRAN);
  const anim = await ctx.newPage();
  anim.on('pageerror', e => dire(false, 'exception JavaScript (animateur ' + module + ')', e.message));
  await anim.goto(BASE + '/' + module + '/'); await attendre(800);
  await anim.getByText('En direct, dans ton église').click(); await attendre(800);
  await anim.getByText('Animer', { exact: true }).first().click(); await attendre(1000);
  await cliquer(anim, 'ouvrir la veillée'); await attendre(2800);
  const code = ((await texte(anim)).match(new RegExp(prefixe + '-[A-Z2-9]{5}')) || [])[0];
  dire(!!code, 'salle ouverte (' + prefixe + '-)', code || await texte(anim));
  if (!code) { await ctx.close(); return; }

  // La projection s'ouvre à l'adresse que l'animateur affiche lui-même.
  const ecran = await ctx.newPage();
  ecran.on('pageerror', e => dire(false, 'exception JavaScript (projection ' + module + ')', e.message));
  await ecran.goto(BASE + '/' + module + '/?direct=' + code);
  const avant = await attendreTexte(ecran, new RegExp(code));
  dire(avant.includes(code), 'la projection affiche le code', avant);
  dire((await commandesVisibles(ecran)).length === 0, 'aucune commande d\'animateur sur la projection');

  await rejoindreEpreuve(b, module, code, 'Marie');
  const ecranUn = await attendreTexte(ecran, /1\s*(déjà|participant)/i);
  dire(/1/.test(ecranUn), 'la projection voit arriver la participante', ecranUn);

  dire(await cliquer(anim, 'lancer'), 'l\'animateur lance');
  const apres = await attendreTexte(ecran, /QUESTION|PORTRAIT|CARTE/i);
  dire(apres !== avant && apres.length > 80, 'la question s\'affiche sur la projection', apres);
  await fermerAppareils();
  await ctx.close();
}

/* ---- Déroulé ---------------------------------------------------------------- */

/* Playwright n'est pas une dépendance de ce dépôt — l'appli n'a AUCUNE
   dépendance, et ce n'est pas un scénario de test qui va lui en imposer une.
   On le prend là où il se trouve : d'abord à côté (node_modules du dépôt), et
   sinon à l'endroit désigné par BH_PLAYWRIGHT. Un import ESM ne suit pas
   NODE_PATH, d'où ce chemin explicite. */
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

// Playwright est un module CommonJS : importé depuis un fichier ESM, ses
// exports arrivent tantôt à plat, tantôt sous « default ». On prend les deux.
const playwright = await chargerPlaywright();
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
if (!chromium) { throw new Error('Playwright chargé mais sans « chromium ».'); }
const b = await chromium.launch();
try {
  await defiUnSeulEcran(b);
  await defiDeuxEcrans(b);
  await epreuve(b, 'quiadit', 'EV', 'Qui a dit ça ?');
  await epreuve(b, 'ecritoupas', 'EV', 'Écrit… ou pas ?');
  await epreuve(b, 'portrait', 'PV', 'De qui parle-t-on ?');
  await epreuve(b, 'frise', 'FV', 'Avant ou après ?');
} finally {
  await b.close();
}
console.log('\n' + reussites + ' réussites, ' + echecs + ' échecs (navigateur)');
process.exit(echecs === 0 ? 0 : 1);
