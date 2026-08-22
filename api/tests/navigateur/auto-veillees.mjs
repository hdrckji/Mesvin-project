/* ============================================================================
   Le mode « la veillée s'enchaîne toute seule », dans un VRAI navigateur —
   pour chacune des quatre pages d'épreuve (le module passé en argument).

   L'API prouve les bascules ; elle ne peut rien dire du GESTE : le réglage
   « Le rythme » à l'ouverture, le décompte annoncé sur tous les écrans, et
   l'animateur qui reprend la main sans refermer la salle. Le portrait a sa
   marche propre — le chrono fait tomber les indices, la réponse révèle.

   Lancement :  node auto-veillees.mjs <adresse> <page> <préfixe-code>
   ========================================================================== */
const BASE = process.argv[2] || 'http://127.0.0.1:8199';
const PAGE = process.argv[3] || 'quiadit';
const CODE_RE = process.argv[4] || 'EV';
/* Playwright se cherche à côté du dépôt, ou là où BH_PLAYWRIGHT le désigne —
   la même règle que veillees.mjs, pour les mêmes raisons. */
async function chargerPlaywright() {
  try { return await import('playwright'); } catch (e) { /* ailleurs */ }
  const ailleurs = process.env.BH_PLAYWRIGHT;
  if (ailleurs) {
    const { pathToFileURL } = await import('node:url');
    return await import(pathToFileURL(ailleurs.replace(/\/$/, '') + '/playwright/index.js').href);
  }
  throw new Error('Playwright introuvable : installe-le, ou pose BH_PLAYWRIGHT.');
}
const pw = await chargerPlaywright();
const chromium = pw.chromium || (pw.default && pw.default.chromium);

let ok = 0, ko = 0;
const dire = (b, quoi, det) => { if (b) { ok++; console.log('   ok   ' + quoi); } else { ko++; console.log('   FAIL ' + quoi + (det ? '\n        ' + String(det).slice(0, 200) : '')); } };
const attendre = ms => new Promise(r => setTimeout(r, ms));
const texte = p => p.evaluate(() => document.body.innerText);
async function attendreTexte(p, motif, msMax = 20000) {
  const fin = Date.now() + msMax;
  for (;;) { const t = await texte(p); if (motif.test(t)) return t; if (Date.now() > fin) return t; await attendre(1000); }
}

const b = await chromium.launch();
const ctx = await b.newContext();
const anim = await ctx.newPage();
anim.on('pageerror', e => dire(false, 'exception JS (animateur)', e.message));
await anim.goto(BASE + '/' + PAGE + '/'); await attendre(1000);
await anim.getByText('En direct, dans ton église').first().click(); await attendre(800);
await anim.getByText('Animer', { exact: true }).first().click(); await attendre(800);

dire(/Le rythme/.test(await texte(anim)), 'le réglage « Le rythme » est proposé');
await anim.getByText('Elle s\'enchaîne toute seule', { exact: true }).click(); await attendre(600);
const t1 = await texte(anim);
dire(/Vif · 15 s/.test(t1) && /Posé · 25 s/.test(t1), 'les cadences apparaissent');
await anim.getByText('Vif · 15 s').click(); await attendre(500);
await anim.getByText('Ouvrir la veillée').click();
const t2 = await attendreTexte(anim, /Le code de la salle/);
const code = (t2.match(new RegExp(CODE_RE + '-[A-Z2-9]{5}')) || [])[0];
dire(!!code, 'la salle est ouverte (' + code + ')');
dire(/Reprendre la main/.test(t2), 'l\'animateur voit qu\'elle s\'enchaîne (interrupteur présent)');

const part = await ctx.newPage();
part.on('pageerror', e => dire(false, 'exception JS (participante)', e.message));
await part.goto(BASE + '/' + PAGE + '/'); await attendre(800);
await part.getByText('En direct, dans ton église').first().click(); await attendre(600);
await part.getByText('Rejoindre', { exact: true }).first().click(); await attendre(600);
await part.fill('#in-code', code); await part.fill('#in-pseudo', 'Zoé');
await part.getByText('Rejoindre', { exact: true }).last().click();
await attendreTexte(part, /Te voilà dans la salle|dans la salle/i);

await anim.getByText(/Lancer l/i).click().catch(() => {});
const t3 = await attendreTexte(anim, /⏳ \d+ s/);
dire(/⏳ \d+ s/.test(t3), 'le décompte est annoncé chez l\'animateur', t3.slice(-150));
const t3p = await attendreTexte(part, /⏳ \d+ s/);
dire(/⏳ \d+ s/.test(t3p), 'et sur le téléphone de la participante');

if (PAGE === 'portrait') {
  // La singularité du portrait : le chrono ne révèle pas, il fait TOMBER LES
  // INDICES. On vérifie l'indice 2, puis la réponse de la seule présente
  // révèle (la réparation commune) — et on enchaîne.
  const ti = await attendreTexte(anim, /indice 2/i, 25000);
  dire(/indice 2/i.test(ti), 'le chrono fait tomber l\'indice suivant', ti.slice(-200));
  await part.fill('#in-texte', 'Anne');
  await part.getByText('Je verrouille ma réponse').click();
  const t4 = await attendreTexte(anim, /On enchaîne dans \d+ s/, 15000);
  dire(/On enchaîne dans \d+ s/.test(t4), 'tous ont répondu : révélé, et on annonce la suite', t4.slice(-200));
} else {
  // Personne ne répond : le chrono (15 s) doit révéler tout seul.
  const t4 = await attendreTexte(anim, /On enchaîne dans \d+ s|Réponse :/, 25000);
  dire(/On enchaîne dans \d+ s|Réponse :/.test(t4), 'le chrono révèle sans un geste', t4.slice(-200));
}

// Puis on enchaîne tout seul sur la question 2.
const API_BASE = BASE + '/api/' + (PAGE === 'frise' ? 'frise' : PAGE === 'portrait' ? 'portrait' : 'epreuve');
let carte2 = false;
for (let i = 0; i < 20 && !carte2; i++) {
  const et = await fetch(API_BASE + '/veillee/' + code + '/etat').then(r => r.json());
  carte2 = et.carte >= 2;
  if (!carte2) await attendre(1000);
}
dire(carte2, 'puis la veillée enchaîne toute seule');

// L'animateur reprend la main : le décompte doit disparaître.
await anim.getByText('Reprendre la main').click();
await attendreTexte(anim, /Laisser la veillée s'enchaîner/);
dire(/Laisser la veillée s'enchaîner/.test(await texte(anim)), 'il reprend la main — l\'interrupteur s\'inverse');
await attendre(2500);
const badge = await anim.evaluate(() => { const b = document.getElementById('decompte-veillee'); return b ? !b.hidden : false; });
dire(!badge, 'et le décompte s\'éteint');

await anim.screenshot({ path: (process.env.BH_CAPTURES || '/tmp') + '/auto-' + PAGE + '.png' }).catch(() => {});
await b.close();
console.log('\n' + ok + ' réussites, ' + ko + ' échecs (' + PAGE + ')');
process.exit(ko === 0 ? 0 : 1);
