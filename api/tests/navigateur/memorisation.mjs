/* ============================================================================
   La planification de la mémorisation, éprouvée dans un vrai navigateur.

   Pourquoi ici et pas dans la suite d'endpoints : Mémoriser est le module
   RACINE de l'appli, et sa planification ne parle à AUCUNE route. Elle vit
   entièrement dans app.js, côté navigateur. La suite d'intégration pouvait
   donc rester verte de bout en bout pendant que la répétition espacée —
   c'est-à-dire le cœur du produit — dérivait sans que rien ne le dise. Une
   dérive de la courbe ne se voit pas : les versets reviennent au mauvais
   moment pendant des mois avant que quiconque le formule.

   app.js est chargé en script classique : ses déclarations de fonction
   atterrissent sur l'objet global, et ses `const` de haut niveau vivent dans
   la portée lexicale globale. On appelle donc le VRAI code — celui qui sera
   servi en production — par identifiants nus. Pas une copie recollée dans le
   test, qui ne prouverait que sa propre cohérence.

     node api/tests/navigateur/memorisation.mjs <base>
   ========================================================================== */
const BASE = process.argv[2] || 'http://127.0.0.1:8180';

let pass = 0, fail = 0;
const ok = m => { pass++; console.log(`   ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`   FAIL ${m}`); if (d) console.log('        ' + d); };
const egal = (m, attendu, obtenu) =>
  String(attendu) === String(obtenu) ? ok(m) : bad(m, `attendu : ${attendu}, obtenu : ${obtenu}`);

/* Playwright n'est pas une dépendance de ce dépôt — l'appli n'en a aucune.
   On le prend là où il se trouve : à côté, sinon là où pointe BH_PLAYWRIGHT
   (un import ESM ne suit pas NODE_PATH, d'où le chemin explicite). */
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
if (!chromium) { throw new Error('Playwright chargé mais sans « chromium ».'); }

const b = await chromium.launch();
try {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const erreursJs = [];
  page.on('pageerror', e => erreursJs.push(e.message));

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  /* ---- Le vrai code est-il joignable ? ----------------------------------- */
  const absentes = await page.evaluate(() => Object.entries({
    schedule: typeof schedule, stageOf: typeof stageOf, isMastered: typeof isMastered,
    introduce: typeof introduce, todayNum: typeof todayNum,
  }).filter(([, t]) => t !== 'function').map(([n]) => n));
  absentes.length === 0
    ? ok('schedule, stageOf, isMastered, introduce, todayNum joignables depuis la page')
    : bad('fonctions introuvables dans la portée globale', absentes.join(', '));

  const consts = await page.evaluate(() => ({ MASTERY, EASE_MIN }));
  egal('MASTERY vaut 3', 3, consts.MASTERY);
  egal('EASE_MIN vaut 1.3', 1.3, consts.EASE_MIN);

  /* Joue le vrai schedule() sur une carte forgée et rend son état d'après.
     Les `validations` sont celles d'APRÈS le décrément de giveUp() : c'est
     l'état exact dans lequel schedule() reçoit une carte ratée. */
  const planifie = (carte, quality) => page.evaluate(
    ([c, q]) => { const k = Object.assign({}, c); schedule(k, q); return k; },
    [carte, quality]);

  /* ---- Un verset raté redescend d'un cran, il ne repart pas de zéro ------ */
  console.log('\n-- Un oubli ne remet plus le verset à plat');
  {
    const mur = await planifie({ ease: 2.5, interval: 60, validations: 2, due: 0 }, 'fail');
    egal('verset planté (60 j) raté → revient dans 3 j, plus le lendemain', 3, mur.interval);

    const enracine = await planifie({ ease: 2.5, interval: 120, validations: 2, due: 0 }, 'fail');
    egal('verset enraciné (120 j) raté → 3 j', 3, enracine.interval);

    // En apprentissage, le plafond de 3 jours borne déjà tout : la nuance est
    // faible, et c'est voulu — un verset mal su a besoin de contacts serrés.
    const jeune = await planifie({ ease: 2.5, interval: 3, validations: 1, due: 0 }, 'fail');
    egal('verset en apprentissage (3 j) raté → 2 j', 2, jeune.interval);

    // Le cas limite qui pourrait produire un intervalle NUL : round(0 / 2) = 0.
    const neuf = await planifie({ ease: 2.5, interval: 0, validations: 0, due: 0 }, 'fail');
    egal('verset neuf (0 j) raté → 1 j, jamais 0', 1, neuf.interval);

    // Une carte sans intervalle (donnée héritée d'une vieille synchro) ne doit
    // pas produire NaN : ce serait une échéance invalide, donc un verset perdu.
    const sansInterval = await planifie({ ease: 2.5, validations: 0, due: 0 }, 'fail');
    Number.isFinite(sansInterval.interval) && Number.isFinite(sansInterval.due)
      ? ok('carte sans interval : ni NaN sur l\'intervalle, ni sur l\'échéance')
      : bad('NaN produit', `interval=${sansInterval.interval} due=${sansInterval.due}`);
  }

  /* ---- Ce que l'adoucissement ne devait PAS emporter --------------------- */
  console.log('\n-- La courbe, par ailleurs, est intacte');
  {
    const r = await planifie({ ease: 2.5, interval: 60, validations: 2, due: 0 }, 'fail');
    egal('un échec fait toujours baisser la facilité de 0,2', 2.3, r.ease);

    const plancher = await planifie({ ease: 1.3, interval: 60, validations: 2, due: 0 }, 'fail');
    egal('la facilité ne descend jamais sous EASE_MIN', 1.3, plancher.ease);

    egal('1re validation → 1 j', 1,
      (await planifie({ ease: 2.5, interval: 0, validations: 1, due: 0 }, 'ok')).interval);
    egal('2e validation → 3 j', 3,
      (await planifie({ ease: 2.5, interval: 1, validations: 2, due: 0 }, 'ok')).interval);

    const mur = await planifie({ ease: 2.5, interval: 10, validations: 4, due: 0 }, 'ok');
    egal('verset planté : l\'intervalle croît (10 × 2,5)', 25, mur.interval);

    const propre = await planifie({ ease: 2.5, interval: 10, validations: 4, due: 0 }, 'clean');
    egal('une reprise sans faute augmente la facilité', 2.55, propre.ease);

    egal('l\'intervalle reste plafonné à 365 j', 365,
      (await planifie({ ease: 2.5, interval: 300, validations: 9, due: 0 }, 'ok')).interval);

    egal('tant que le verset n\'est pas planté, retour sous 3 j', 3,
      (await planifie({ ease: 2.5, interval: 50, validations: 2, due: 0 }, 'ok')).interval);
  }

  /* ---- L'échéance suit l'intervalle, et le jardin suit l'échéance -------- */
  console.log('\n-- De l\'intervalle à l\'échéance, et de l\'échéance au jardin');
  {
    const t = await page.evaluate(() => todayNum());
    const r = await planifie({ ease: 2.5, interval: 60, validations: 2, due: 0 }, 'fail');
    egal('due = aujourd\'hui + intervalle', t + 3, r.due);
    r.revisedAt === t
      ? ok('la date de révision est posée (c\'est elle qui départage la synchro)')
      : bad('revisedAt absent');

    const stades = await page.evaluate(() => [0, 3, 13, 44, 119, 200]
      .map(i => stageOf({ interval: i, validations: 3 }).label));
    egal('les cinq stades du jardin se suivent',
      'Germe,Germe,Pousse,Plante,Arbre,Enraciné', stades.join(','));
  }

  /* ---- L'écran, tel qu'il s'affiche -------------------------------------- */
  console.log('\n-- L\'écran de mémorisation à l\'ouverture');
  {
    const texte = (await page.evaluate(() => document.body.innerText || '')).trim();
    texte.length > 40 ? ok(`l'accueil est peint (${texte.length} caractères)`) : bad('accueil vide');
    const nav = await page.evaluate(() => document.querySelectorAll('[data-tab]').length);
    nav > 0 ? ok(`la barre de navigation est injectée (${nav} entrées)`) : bad('pas de navigation');
    erreursJs.length === 0
      ? ok('aucune exception JS pendant tout le parcours')
      : bad('exceptions JS', erreursJs.join(' | '));
  }
  await ctx.close();
} finally {
  await b.close();
}

console.log(`\n${pass} réussites, ${fail} échecs`);
process.exit(fail === 0 ? 0 : 1);
