/* ============================================================================
   Le tirage « sans remise » : combien de parties avant qu'une question revienne.

   Des lecteurs signalaient que les questions tournaient trop vite. Le nombre de
   répétitions, lui, est arithmétique — 200 questions et 10 par partie, c'est
   20 parties, on n'y peut rien. Ce qui se corrige, c'est leur ESPACEMENT :
   l'ancienne version effaçait toute la mémoire dès qu'il restait moins de dix
   questions fraîches, puis repiochait dans le tas ENTIER. Une question vue la
   veille pouvait donc revenir le lendemain, et c'est ce qui donnait la
   sensation de tourner en rond.

   Le tirage tient désormais une FILE : les questions servies repartent en
   queue, et quand le vivier s'épuise on reprend par les plus anciennes. Le
   tour complet est donc garanti avant la moindre redite.

   On joue ici de vraies parties dans la page, sur le vrai tirage — pas une
   réécriture de l'algorithme dans le test, qui ne prouverait qu'elle-même.

     node api/tests/navigateur/tirage.mjs <base>
   ========================================================================== */
const BASE = process.argv[2] || 'http://127.0.0.1:8180';

let pass = 0, fail = 0;
const ok = m => { pass++; console.log(`   ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`   FAIL ${m}`); if (d) console.log('        ' + String(d).slice(0, 200)); };

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

const b = await chromium.launch();
const page = await (await b.newContext()).newPage();
const erreurs = [];
page.on('pageerror', e => erreurs.push(e.message));
await page.goto(BASE + '/defi/', { waitUntil: 'load' });
await page.waitForTimeout(900);

/* Joue `parties` tirages d'affilée sur un filtre donné, et rend pour chaque
   question l'écart le plus court entre deux apparitions. */
const jouer = (filtres, parties) => page.evaluate(([f, n]) => {
  store.vues = {};                       // on repart d'un appareil neuf
  const vuEn = {}, ecarts = [];
  let vivier = 0;
  for (let p = 1; p <= n; p++) {
    const pool = poolFiltre(f);
    vivier = pool.length;
    const tirees = tirageSansRemise(caseFiltres('essai', f), pool, 10,
      rngSeme('essai-' + p));
    for (const q of tirees) {
      if (vuEn[q.id]) ecarts.push(p - vuEn[q.id]);
      vuEn[q.id] = p;
    }
  }
  return { vivier, redites: ecarts.length, ecartMin: ecarts.length ? Math.min(...ecarts) : null };
}, [filtres, parties]);

console.log('\n-- Un niveau, toutes catégories : le tour complet doit précéder toute redite');
{
  const r = await jouer({ categorie: null, niveau: 3 }, 60);
  // On ne fige PAS la taille du vivier : elle a vocation à grandir, et un test
  // qui l'empêcherait travaillerait contre le produit. Ce qui doit tenir, c'est
  // l'invariant ci-dessous.
  r.vivier >= 200 ? ok(`le vivier compte ${r.vivier} questions`) : bad(`vivier de ${r.vivier}, attendu au moins 200`);
  const attendu = Math.floor(r.vivier / 10);
  r.ecartMin === null || r.ecartMin >= attendu
    ? ok(`aucune redite avant ${attendu} parties (écart le plus court : ${r.ecartMin})`)
    : bad(`une question est revenue après ${r.ecartMin} partie(s), attendu ${attendu} au minimum`);
}

console.log('\n-- Un niveau ET une catégorie : le vivier est petit, l\'écart doit rester maximal');
{
  const r = await jouer({ categorie: 'Personnages', niveau: 1 }, 40);
  r.vivier > 0 && r.vivier < 50 ? ok(`le vivier ne compte que ${r.vivier} questions`) : bad(`vivier inattendu : ${r.vivier}`);
  const attendu = Math.floor(r.vivier / 10);
  r.ecartMin === null || r.ecartMin >= attendu
    ? ok(`et l'écart le plus court vaut ${r.ecartMin} — le maximum possible ici`)
    : bad(`écart de ${r.ecartMin} partie(s), attendu ${attendu} au minimum`);
  r.redites > 0 ? ok(`${r.redites} redites en 40 parties : c'est arithmétique, pas un défaut`) : ok('aucune redite');
}

console.log('\n-- La mémoire ne garde jamais plus que le vivier');
{
  const taille = await page.evaluate(() => {
    const f = { categorie: 'Personnages', niveau: 1 };
    store.vues = {};
    for (let p = 1; p <= 30; p++) {
      tirageSansRemise(caseFiltres('essai', f), poolFiltre(f), 10, rngSeme('m' + p));
    }
    return { file: store.vues['essai|Personnages|1'].length, vivier: poolFiltre(f).length };
  });
  taille.file <= taille.vivier
    ? ok(`la file (${taille.file}) ne dépasse pas le vivier (${taille.vivier}) : rien ne s'accumule`)
    : bad(`la file enfle : ${taille.file} pour un vivier de ${taille.vivier}`);
}

erreurs.length === 0 ? ok('aucune exception JS') : bad('exceptions', erreurs.join(' | '));

await b.close();
console.log(`\n${pass} réussites, ${fail} échecs`);
process.exit(fail === 0 ? 0 : 1);
