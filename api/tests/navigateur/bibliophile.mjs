/* ===========================================================================
   Bibliophile : le niveau 3 joué SANS les propositions.

   Ce qu'on éprouve ici n'est pas l'affichage mais la RÈGLE : une faute de
   frappe est pardonnée, jamais une confusion. C'est la même règle que
   portrait_correspond() côté serveur, et se tromper dessus dans un sens
   (trop sévère) découragerait, dans l'autre (trop laxiste) validerait une
   réponse fausse.

     node api/tests/navigateur/bibliophile.mjs <base>
   ========================================================================= */
const BASE = process.argv[2] || 'http://127.0.0.1:8180';

/* Playwright n'est pas une dépendance de ce dépôt : on le prend à côté, ou là
   où pointe BH_PLAYWRIGHT (un import ESM ne suit pas NODE_PATH). */
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
const pw = await chargerPlaywright();
const chromium = pw.chromium || (pw.default && pw.default.chromium);
if (!chromium) { throw new Error('Playwright chargé mais sans « chromium ».'); }

let pass = 0, fail = 0;
const ok = m => { pass++; console.log(`   ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`   FAIL ${m}`); if (d) console.log('        ' + String(d).slice(0, 200)); };

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const erreurs = [];
page.on('pageerror', e => erreurs.push(e.message));

const txt = () => page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());

await page.goto(BASE + '/defi/', { waitUntil: 'load' });
await page.waitForTimeout(800);

console.log('\n-- On arrive jusqu\'à la pastille');
await page.getByText('Qui, où, quand ?').click(); await page.waitForTimeout(500);
await page.getByText('Seul', { exact: true }).click(); await page.waitForTimeout(500);

const avant = await txt();
/Bibliophile/.test(avant) ? ok('la pastille « Bibliophile » est proposée') : bad('pastille absente', avant);

await page.locator('[data-niv="bibliophile"]').click(); await page.waitForTimeout(400);
const apres = await txt();
/sans les propositions/i.test(apres)
  ? ok('l\'écran explique ce qui change')
  : bad('pas d\'explication', apres);

/* La règle se joue sur le vrai code de la page : on interroge directement
   saisieCorrespond(), plutôt que de taper dix réponses à l'aveugle. */
console.log('\n-- La règle : une faute pardonnée, jamais une confusion');
const cas = [
  ['Belschatsar',  'Belschatsar', ['Nebucadnetsar', 'Darius', 'Cyrus'], true,  'la réponse exacte'],
  ['belschatsar',  'Belschatsar', ['Nebucadnetsar', 'Darius', 'Cyrus'], true,  'sans les majuscules'],
  ['Belschatsr',   'Belschatsar', ['Nebucadnetsar', 'Darius', 'Cyrus'], true,  'une lettre oubliée : pardonnée'],
  ['Belchatsar',   'Belschatsar', ['Nebucadnetsar', 'Darius', 'Cyrus'], true,  'une autre faute de frappe'],
  ['Darius',       'Belschatsar', ['Nebucadnetsar', 'Darius', 'Cyrus'], false, 'une AUTRE option : refusée'],
  ['Nebucadnetsar','Belschatsar', ['Nebucadnetsar', 'Darius', 'Cyrus'], false, 'une autre option encore'],
  ['',             'Belschatsar', ['Nebucadnetsar', 'Darius', 'Cyrus'], false, 'le vide ne vaut rien'],
  ['Chypre',       'Chypre',      ['La Crète', 'Malte', 'Patmos'],      true,  'accents et casse mis à part'],
  ['chypre.',      'Chypre',      ['La Crète', 'Malte', 'Patmos'],      true,  'la ponctuation est ignorée'],
  ['Malte',        'Chypre',      ['La Crète', 'Malte', 'Patmos'],      false, 'une île voisine : refusée'],
  // Cibles courtes : à quatre lettres, une faute change le mot au lieu de
  // l'abîmer — on exige donc l'exactitude.
  ['Paul',         'Paul',        ['Pierre', 'Jean', 'Jacques'],        true,  'cible courte, exacte'],
  ['Paol',         'Paul',        ['Pierre', 'Jean', 'Jacques'],        false, 'cible courte, faute : refusée'],
  // Le cœur de la règle : deux réponses proches l'une de l'autre.
  ['Jean',         'Jean',        ['Jeanne', 'Pierre', 'Luc'],          true,  'exacte malgré une voisine proche'],
  ['Sual',         'Saül',        ['Samuel', 'David', 'Jonathan'],      false, 'cible courte accentuée : exactitude'],
];
for (const [saisie, bonne, autres, attendu, quoi] of cas) {
  const r = await page.evaluate(([s, b, a]) => saisieCorrespond(s, b, a), [saisie, bonne, autres]);
  r === attendu
    ? ok(`« ${saisie || '(vide)' } » → ${r ? 'acceptée' : 'refusée'} — ${quoi}`)
    : bad(`« ${saisie || '(vide)'} » → ${r ? 'acceptée' : 'refusée'}, attendu ${attendu ? 'acceptée' : 'refusée'} — ${quoi}`);
}

console.log('\n-- Une partie jouée pour de vrai');
await page.getByText('Relever un défi libre').click(); await page.waitForTimeout(900);

const q1 = await txt();
const champ = await page.$('#saisie');
champ ? ok('le champ de saisie remplace les propositions') : bad('pas de champ', q1);
const options = await page.$$('#options .defi-option');
options.length === 0 ? ok('aucune proposition n\'est affichée') : bad(`${options.length} propositions encore visibles`);
// L'écran met le libellé en capitales (CSS) : on compare sans la casse.
/Bibliophile/i.test(q1) ? ok('l\'en-tête annonce Bibliophile') : bad('en-tête inattendu', q1);
const niv = await page.evaluate(() => vue.items.every(i => i.q.niveau === 3));
niv ? ok('les questions servies sont toutes de niveau 3') : bad('des questions d\'un autre niveau se sont glissées');

// La bonne réponse est dans la page : on la lit pour jouer un coup juste.
const bonne = await page.evaluate(() => {
  const it = vue.items[vue.index];
  return it.q.options[it.q.bonne];
});
await page.fill('#saisie', bonne);
await page.click('#btn-valider'); await page.waitForTimeout(600);
const apresJuste = await txt();
/Tu avais écrit/.test(apresJuste) ? ok('la réponse écrite est rappelée à l\'écran') : bad('pas de rappel', apresJuste);
const score = await page.evaluate(() => vue.score);
score === 1 ? ok('une bonne réponse écrite compte un point') : bad(`score = ${score}, attendu 1`);
/→/.test(apresJuste) ? ok('la référence biblique s\'affiche comme d\'habitude') : bad('pas de référence', apresJuste);

// Question suivante : on renonce.
await page.click('#btn-suivante'); await page.waitForTimeout(600);
await page.click('#btn-langue'); await page.waitForTimeout(600);
const apresRenonce = await txt();
/Tu as passé la question/.test(apresRenonce) ? ok('« Je ne trouve pas » est accueilli sans reproche') : bad('renoncement mal rendu', apresRenonce);
const score2 = await page.evaluate(() => vue.score);
score2 === 1 ? ok('et ne rapporte aucun point') : bad(`score = ${score2}, attendu 1`);

console.log('\n-- « Voir les propositions — ½ point » : l\'indice au prix annoncé');
// Question 3 : le prix est écrit SUR le bouton, avant tout engagement.
await page.click('#btn-suivante'); await page.waitForTimeout(600);
const avantIndice = await txt();
/Voir les propositions — ½ point/.test(avantIndice)
  ? ok('le bouton annonce son prix avant le tap')
  : bad('le prix n\'est pas annoncé sur le bouton', avantIndice);
await page.click('#btn-indice'); await page.waitForTimeout(600);
(await page.$('#saisie')) === null
  ? ok('propositions révélées : le champ de saisie disparaît — porte à sens unique')
  : bad('le champ de saisie survit à la révélation');
const revele = await page.$$('#options .defi-option');
revele.length === 4 ? ok('les 4 propositions apparaissent') : bad(`${revele.length} propositions`);
/cette question vaut ½ point/.test(await txt())
  ? ok('et l\'écran redit le prix pendant qu\'on choisit')
  : bad('le prix n\'est pas rappelé à l\'écran');
// On touche la BONNE : ½ point, la série continue.
const serieAvant = await page.evaluate(() => store.serie);
await page.evaluate(() => {
  const it = vue.items[vue.index];
  document.querySelector(`#options .defi-option[data-pos="${it.bonnePos}"]`).click();
});
await page.waitForTimeout(600);
const s3 = await page.evaluate(() => ({ score: vue.score, serie: store.serie, ratees: vue.ratees.length }));
s3.score === 1.5 ? ok('la bonne réponse touchée vaut ½ point (score 1,5)') : bad(`score = ${s3.score}, attendu 1.5`);
s3.serie === serieAvant + 1 ? ok('la série continue : trouver reste trouver') : bad(`série ${s3.serie}, attendu ${serieAvant + 1}`);
s3.ratees === 1 ? ok('et la question ne part pas dans les ratées') : bad(`${s3.ratees} ratées, attendu 1`);
/Trouvée avec les propositions : ½ point/.test(await txt())
  ? ok('le rappel dit comment elle a été trouvée')
  : bad('rappel absent ou muet sur l\'indice');

// Question 4 : indice puis MAUVAISE option — zéro, comme un tap raté en Connaisseur.
await page.click('#btn-suivante'); await page.waitForTimeout(600);
await page.click('#btn-indice'); await page.waitForTimeout(600);
await page.evaluate(() => {
  const it = vue.items[vue.index];
  const faux = [0, 1, 2, 3].find(p => p !== it.bonnePos);
  document.querySelector(`#options .defi-option[data-pos="${faux}"]`).click();
});
await page.waitForTimeout(600);
const s4 = await page.evaluate(() => ({ score: vue.score, ratees: vue.ratees.length }));
s4.score === 1.5 ? ok('se tromper après l\'indice ne rapporte rien') : bad(`score = ${s4.score}, attendu 1.5`);
s4.ratees === 2 ? ok('et la question rejoint les ratées') : bad(`${s4.ratees} ratées, attendu 2`);

// Question 5 : l'indice ne colle pas d'une question à l'autre.
await page.click('#btn-suivante'); await page.waitForTimeout(600);
(await page.$('#saisie')) ? ok('la question suivante repart en saisie libre, à 1 point')
                          : bad('l\'indice a débordé sur la question suivante');

// La fin de partie écrit les demi-points à la française. On renonce jusqu'au bout.
for (let i = 4; i < 10; i++) {
  await page.click('#btn-langue'); await page.waitForTimeout(350);
  await page.click('#btn-suivante'); await page.waitForTimeout(350);
}
const fin = await txt();
/1,5\s*\/\s*10/.test(fin) ? ok('l\'écran de fin affiche « 1,5/10 » — virgule française')
                          : bad('le demi-point ne s\'écrit pas 1,5', fin.slice(0, 200));

console.log('\n-- Le reste de l\'appli n\'a pas bougé');
await page.goto(BASE + '/defi/', { waitUntil: 'load' }); await page.waitForTimeout(700);
await page.getByText('Qui, où, quand ?').click(); await page.waitForTimeout(400);
await page.getByText('Seul', { exact: true }).click(); await page.waitForTimeout(400);
await page.locator('[data-niv="3"]').click(); await page.waitForTimeout(300);
await page.getByText('Relever un défi libre').click(); await page.waitForTimeout(900);
const normal = await page.$$('#options .defi-option');
normal.length === 4 ? ok('un défi Connaisseur ordinaire garde ses 4 propositions') : bad(`${normal.length} propositions`);
(await page.$('#saisie')) ? bad('un champ de saisie traîne là où il ne devrait pas') : ok('et aucun champ de saisie');
(await page.$('#btn-indice')) ? bad('le bouton d\'indice n\'a rien à faire en Connaisseur') : ok('ni bouton d\'indice — les propositions y sont déjà gratuites');

erreurs.length === 0 ? ok('aucune exception JS de bout en bout') : bad('exceptions', erreurs.join(' | '));

await b.close();
console.log(`\n${pass} réussites, ${fail} échecs`);
process.exit(fail === 0 ? 0 : 1);
