/* ============================================================================
   Signaler ce qui cloche — dans un VRAI navigateur.

   L'API sait dire qu'une route accepte un signalement. Elle ne peut rien dire
   du geste lui-même, et c'est le geste qui décide de tout : un lien qu'on ne
   voit pas, un formulaire qui décourage, un envoi qui ne dit pas merci, et
   plus personne ne signale rien — on croit alors que les 600 questions sont
   parfaites parce que la boîte est vide.

   Ce scénario joue donc les deux bouts de la chaîne :
   - LE LECTEUR, sans compte (c'est le cas normal : personne n'ouvre une
     session pour dire qu'un verset ne colle pas) ;
   - L'ADMINISTRATION, qui doit retrouver la remarque, comprendre ce que le
     lecteur avait sous les yeux, et la classer.

   Lancement :  node api/tests/navigateur/signalement.mjs [adresse]
   BH_JETON_ADMIN doit porter un jeton de session admin.
   ========================================================================== */

const BASE = process.argv[2] || 'http://127.0.0.1:8180';
const JETON_ADMIN = process.env.BH_JETON_ADMIN || '';

let echecs = 0, reussites = 0;
const attendre = ms => new Promise(r => setTimeout(r, ms));
const dire = (bon, quoi, detail) => {
  if (bon) { reussites++; console.log('   ok   ' + quoi); }
  else { echecs++; console.log('   FAIL ' + quoi + (detail ? '\n        ' + String(detail).replace(/\s+/g, ' ').trim().slice(0, 260) : '')); }
};
const texte = p => p.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').trim());

async function attendreTexte(page, motif, msMax = 12000) {
  const jusqua = Date.now() + msMax;
  for (;;) {
    const vu = await texte(page);
    if (motif.test(vu)) return vu;
    if (Date.now() > jusqua) return vu;
    await attendre(1000);
  }
}

const nettoyer = s => (s || '').replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/^[A-D]\s+/, '');
const COMMANDES = /^(quitter|fermer|copier|retour|partager|clore|lancer|signaler|voir le|question suivante|relever)/i;

async function cliquer(page, ...mots) {
  for (const b of await page.$$('button, a.btn')) {
    const l = nettoyer(await b.innerText());
    if (!mots.some(m => l.toLowerCase().includes(m.toLowerCase()))) continue;
    if (!(await b.isEnabled())) continue;
    await b.click({ timeout: 5000 }).catch(() => {});
    return true;
  }
  return false;
}

/* Clique une PROPOSITION : tout bouton qui n'est pas une commande. */
async function repondre(page) {
  for (const b of await page.$$('.defi-opts button, .opts button, button')) {
    const l = nettoyer(await b.innerText());
    if (l.length > 1 && !COMMANDES.test(l) && (await b.isEnabled())) {
      await b.click({ timeout: 5000 }).catch(() => {});
      return l;
    }
  }
  return null;
}

const MOTIF = 'La réponse ne correspond pas à ce que je lis dans ma Bible.';

/* ---- Le lecteur, sans compte ---------------------------------------------- */

async function lecteurSignale(b) {
  console.log('\n-- Le lecteur : un défi solo, la révélation, le lien');
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  p.on('pageerror', e => dire(false, 'exception JavaScript (lecteur)', e.message));

  /* Le motif passe par window.prompt : sans ce gestionnaire, Playwright
     referme la boîte et le scénario n'éprouverait que le cas « Annuler ». */
  p.on('dialog', d => d.accept(MOTIF).catch(() => {}));

  await p.goto(BASE + '/defi/');
  await attendre(1200);

  /* AUCUNE session n'est posée : c'est tout l'enjeu. Si un jour signaler
     exigeait un compte, ce scénario tomberait ici même. */
  const sansSession = await p.evaluate(() => !localStorage.getItem('graine.session'));
  dire(sansSession, 'le lecteur n\'a pas de compte — et n\'en aura pas besoin');

  await p.getByText('Qui, où, quand ?').click();
  await attendre(900);
  // L'épreuve propose d'abord SA façon de se jouer : seul, à plusieurs ici,
  // à distance, ou en direct dans l'église. Le lecteur qui signale est celui
  // qui lit tout seul, sa Bible à côté.
  await p.getByText('Seul', { exact: false }).first().click();
  await attendre(900);
  await cliquer(p, 'Relever un défi libre', 'Relever le défi du jour');
  await attendre(1500);

  const enQuestion = await attendreTexte(p, /Question\s*1|\/\s*\d/i);
  dire(/\?|\./.test(enQuestion), 'une question est posée');

  /* Avant de répondre, RIEN à signaler — et un lien visible ici serait un
     indice de plus sur l'écran. */
  const avant = await p.$('[data-signaler]');
  dire(avant === null, 'aucun lien « Signaler » avant la réponse — rien à signaler encore');

  await repondre(p);
  await attendre(900);

  const lien = await p.$('[data-signaler]');
  dire(lien !== null, 'le lien « Signaler » apparaît avec la référence');
  if (!lien) { await ctx.close(); return null; }

  const cible = await lien.getAttribute('data-signaler');
  const contexte = await lien.getAttribute('data-contexte');
  dire(/^question:.+/.test(cible) && !/undefined/.test(cible),
    'il désigne la question par son identifiant (' + cible + ')');
  dire(!!contexte && contexte.length > 10 && !/undefined/.test(contexte),
    'il emporte ce que le lecteur a sous les yeux');

  await lien.click();
  const apres = await attendreTexte(p, /Signalé, merci/);
  dire(/Signalé, merci/.test(apres), 'un tap suffit, et le lecteur est remercié', apres.slice(-200));

  await p.screenshot({ path: (process.env.BH_CAPTURES || '/tmp') + '/sig-defi.png', fullPage: false })
    .catch(() => {});

  await ctx.close();
  return { cible, contexte };
}

/* ---- L'administration ------------------------------------------------------ */

async function adminTraite(b, attendu) {
  console.log('\n-- L\'administration : la remarque arrive, et se classe');
  if (!JETON_ADMIN) { dire(false, 'BH_JETON_ADMIN manquant'); return; }

  const ctx = await b.newContext();
  const p = await ctx.newPage();
  p.on('pageerror', e => dire(false, 'exception JavaScript (admin)', e.message));

  await p.goto(BASE + '/index.html');
  await p.evaluate(t => localStorage.setItem('graine.session',
    JSON.stringify({ token: t, user: { email: 'alice@example.org', pseudo: 'Alice', isAdmin: true } })), JETON_ADMIN);
  await p.goto(BASE + '/admin/');
  await attendre(1200);

  await cliquer(p, 'Activité');
  // La CSS met les intitulés de section en capitales, et innerText rend ce
  // qui s'affiche — pas ce qui est écrit dans le source.
  // Attendre le RÉSUMÉ, pas le titre : le titre s'affiche immédiatement, mais
  // il annonce « chargement… » tant que l'appel n'est pas revenu. Guetter le
  // titre seul, c'est mesurer la vitesse du rendu au lieu du contenu.
  const vu = await attendreTexte(p, /à regarder|rien à traiter/i);
  dire(/signalements/i.test(vu), 'la section « Signalements » est là');
  dire(/à regarder/i.test(vu), 'et elle annonce qu\'il y a quelque chose à regarder', vu.slice(0, 300));

  /* La section est repliée par défaut : c'est le résumé qui alerte. */
  await cliquer(p, 'Signalements');
  await p.evaluate(() => {
    const d = document.querySelector('details[data-cle="signalements"]');
    if (d) d.open = true;
  });
  await attendre(600);

  const pile = await texte(p);
  if (attendu) {
    dire(pile.includes(attendu.cible), 'le signalement porte la bonne cible (' + attendu.cible + ')');
    const debut = attendu.contexte.slice(0, 24);
    dire(pile.includes(debut), 'et le texte que le lecteur avait sous les yeux');
  }
  dire(pile.includes(MOTIF), 'le motif écrit par le lecteur est lisible tel quel');
  dire(/signalé sans compte/.test(pile), 'il est bien marqué « signalé sans compte »');
  dire(!/@/.test((pile.split(/signalements/i)[1] || '').split(/fr[ée]quentation/i)[0] || ''),
    'aucune adresse e-mail n\'apparaît');

  const bouton = await p.$('[data-sigclasser]');
  dire(bouton !== null, 'un bouton permet de le classer');
  if (bouton) {
    await bouton.click();
    const apres = await attendreTexte(p, /rien à traiter/);
    dire(/rien à traiter/.test(apres), 'un tap le classe, et la pile se vide', apres.slice(0, 300));
  }

  await ctx.close();
}

/* ---- Playwright ------------------------------------------------------------ */

async function chargerPlaywright() {
  try { return await import('playwright'); } catch (e) { /* ailleurs */ }
  const ailleurs = process.env.BH_PLAYWRIGHT;
  if (ailleurs) {
    const { pathToFileURL } = await import('node:url');
    const chemin = ailleurs.endsWith('.js') ? ailleurs : ailleurs.replace(/\/$/, '') + '/playwright/index.js';
    return await import(pathToFileURL(chemin).href);
  }
  throw new Error('Playwright introuvable : installe-le, ou pose BH_PLAYWRIGHT sur le dossier node_modules qui le contient.');
}

const playwright = await chargerPlaywright();
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
if (!chromium) { throw new Error('Playwright chargé mais sans « chromium ».'); }
const b = await chromium.launch();
try {
  const signale = await lecteurSignale(b);
  await adminTraite(b, signale);
} finally {
  await b.close();
}
console.log('\n' + reussites + ' réussites, ' + echecs + ' échecs (navigateur — signaler)');
process.exit(echecs === 0 ? 0 : 1);
