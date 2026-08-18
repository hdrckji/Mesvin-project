const { createRequire } = require('module');
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const fs = require('fs');
const TA = fs.readFileSync('/tmp/ta.txt','utf8').trim(), TB = fs.readFileSync('/tmp/tb.txt','utf8').trim();
const GC = fs.readFileSync('/tmp/gc.txt','utf8').trim();
const B = process.env.GRAINE_URL || 'http://127.0.0.1:8123';
const D = __dirname + '/captures/';

/* capture d'un ou plusieurs éléments, avec une marge — le cadrage suit le DOM,
   jamais des pixels devinés. */
async function cap(page, sels, nom, pad = 10) {
  const boxes = [];
  for (const s of [].concat(sels)) {
    const b = await (typeof s === 'string' ? page.locator(s).first() : s).boundingBox();
    if (b) boxes.push(b);
  }
  if (!boxes.length) { console.log('MANQUE', nom); return; }
  const x = Math.min(...boxes.map(b => b.x)) - pad;
  const y = Math.min(...boxes.map(b => b.y)) - pad;
  const x2 = Math.max(...boxes.map(b => b.x + b.width)) + pad;
  const y2 = Math.max(...boxes.map(b => b.y + b.height)) + pad;
  await page.screenshot({ path: D + nom + '.png',
    clip: { x: Math.max(0, x), y: Math.max(0, y), width: x2 - Math.max(0, x), height: y2 - Math.max(0, y) } });
  console.log('ok', nom, Math.round(x2 - x) + 'x' + Math.round(y2 - y));
}
const PORTRAITS = [
  ['Jonas','Jonas, Yonas','personnage','Jonas 1–4',[
    "Dieu l'envoie vers une grande ville, et il part dans l'autre sens.",
    'Une tempête se lève ; les marins tirent au sort pour savoir qui est en cause.',
    "Il passe trois jours et trois nuits dans le ventre d'un grand poisson.",
    'Il prêche à Ninive, et toute la ville se repent.',
    'Il boude sous un ricin, fâché que Dieu ait pardonné.']],
  ['Ninive','Ninive','lieu','Jonas 3',[
    'Une grande ville : trois jours de marche pour la traverser.',
    "Sa méchanceté est montée jusqu'à Dieu.",
    'Ses habitants proclament un jeûne, du plus grand au plus petit.',
    "Même le roi descend de son trône et se couvre d'un sac.",
    "Dieu renonce au mal qu'il avait résolu de lui faire."]],
  ['le grand poisson','le grand poisson, un grand poisson, poisson','chose','Jonas 2',[
    "L'Éternel le fit venir.",
    'Il engloutit un homme sans le tuer.',
    "On y prie du sein du séjour des morts.",
    'Trois jours et trois nuits.',
    "Il le vomit sur la terre ferme."]],
];
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 2200 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(B + '/');
  await p.evaluate(t => localStorage.setItem('graine.session', JSON.stringify({ token: t, user: { pseudo: 'Alice' } })), TA);
  await p.reload(); await p.waitForTimeout(1500);

  await p.click('[data-tab="eglise"]'); await p.waitForTimeout(1600);
  await cap(p, '[data-tab="banques"]', 's1-porte');

  await p.click('[data-tab="banques"]'); await p.waitForTimeout(1700);
  await p.click('[data-bqmodule="portrait"]'); await p.waitForTimeout(1400);
  await cap(p, ['.pill-row', '.card'], 's2-epreuves');

  await p.fill('#bqSerieNom', 'Prédication du 10 août — Jonas'); await p.waitForTimeout(200);
  await cap(p, '#bqSerieNom', 's3-nommer', 26);
  await p.click('[data-bqseriecreer]'); await p.waitForTimeout(1700);
  await cap(p, ['.field-ok'], 's4-creee');
  await cap(p, '.card', 's5-brouillon');

  for (let k = 0; k < PORTRAITS.length; k++) {
    const [rep, acc, genre, ref, ind] = PORTRAITS[k];
    await p.click('[data-bqedit=""]'); await p.waitForTimeout(800);
    if (k === 0) await cap(p, 'form[data-bqform]', 's6-form-vide');
    await p.fill('#bqReponse', rep); await p.fill('#bqAccepte', acc);
    await p.click(`[data-bqgenre="${genre}"]`);
    for (let i = 0; i < 5; i++) await p.fill('#bqInd' + i, ind[i]);
    await p.fill('#bqRef', ref); await p.waitForTimeout(250);
    if (k === 0) await cap(p, 'form[data-bqform]', 's7-form-rempli');
    await p.click('form[data-bqform] button[type="submit"]'); await p.waitForTimeout(1600);
  }
  await cap(p, p.locator('.card').filter({ hasText: 'Nouvelle question' }).first(), 's8-questions');

  await p.click('[data-bqserieretour]'); await p.waitForTimeout(1600);
  await cap(p, p.locator('.egl-annonce').first(), 's9-avant-publication', 14);
  await p.locator('[data-bqserieetat]').first().click(); await p.waitForTimeout(1700);
  await cap(p, ['.field-ok'], 's10-publiee');
  await cap(p, p.locator('.egl-annonce').first(), 's11-apres-publication', 14);

  // ---- Qui a dit ? : formulaire + avertissement ----
  await p.click('[data-bqmodule="quiadit"]'); await p.waitForTimeout(1400);
  await p.fill('#bqSerieNom', 'Étude du mercredi — les paroles de Jésus');
  await p.click('[data-bqseriecreer]'); await p.waitForTimeout(1700);
  await p.click('[data-bqedit=""]'); await p.waitForTimeout(800);
  await p.fill('#bqParole', 'Je suis le chemin, la vérité, et la vie.');
  await p.fill('#bqOpt0', 'Jésus'); await p.fill('#bqOpt1', 'Pierre');
  await p.fill('#bqOpt2', 'Paul'); await p.fill('#bqOpt3', 'Jean-Baptiste');
  await p.fill('#bqRef', 'Jean 14.6'); await p.waitForTimeout(250);
  await cap(p, 'form[data-bqform]', 's12-quiadit-form');
  await p.fill('#bqRef', 'Jean 3.16');
  await p.click('form[data-bqform] button[type="submit"]'); await p.waitForTimeout(1800);
  await cap(p, ['.field-ok', '.soft-warn'], 's13-avertissement');

  // ---- Écrit… ou pas ? ----
  await p.click('[data-bqmodule="ecritoupas"]'); await p.waitForTimeout(1400);
  await p.fill('#bqSerieNom', 'Idées reçues — série de rentrée');
  await p.click('[data-bqseriecreer]'); await p.waitForTimeout(1700);
  await p.click('[data-bqedit=""]'); await p.waitForTimeout(800);
  await p.fill('#bqPhrase', "Aide-toi, le ciel t'aidera.");
  await p.click('[data-bqecrit="0"]'); await p.waitForTimeout(250);
  await p.fill('#bqPrecision', "Proverbe français, pas un verset — la Bible dit au contraire de s'appuyer sur l'Éternel plutôt que sur soi (Proverbes 3.5).");
  await p.waitForTimeout(250);
  await cap(p, 'form[data-bqform]', 's14-ecritoupas-form');

  // ---- Qui, où, quand ? : les réglages ----
  await p.click('[data-bqmodule="defi"]'); await p.waitForTimeout(1800);
  await cap(p, '.card', 's15-defi-reglages');

  // ---- côté membre ----
  const ctx2 = await browser.newContext({ viewport: { width: 420, height: 1400 }, deviceScaleFactor: 2 });
  const m = await ctx2.newPage();
  await m.goto(B + '/');
  await m.evaluate(t => localStorage.setItem('graine.session', JSON.stringify({ token: t, user: { pseudo: 'Bob' } })), TB);
  await m.goto(B + '/portrait/?eglise=' + GC); await m.waitForTimeout(2400);
  await cap(m, m.locator('div').filter({ hasText: /^Avec quelles questions/ }).last(), 's16-cote-membre', 12);
  await browser.close();
})();
