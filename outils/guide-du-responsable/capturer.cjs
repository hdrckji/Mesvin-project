const { createRequire } = require('module');
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const fs = require('fs');
const TA = fs.readFileSync('/tmp/ta.txt','utf8').trim(), TB = fs.readFileSync('/tmp/tb.txt','utf8').trim();
const B = process.env.GRAINE_URL || 'http://127.0.0.1:8123';
const D = __dirname + '/captures/';
async function cap(page, sels, nom, pad = 10) {
  const boxes = [];
  for (const s of [].concat(sels)) {
    const b = await (typeof s === 'string' ? page.locator(s).first() : s).boundingBox();
    if (b) boxes.push(b);
  }
  if (!boxes.length) { console.log('MANQUE', nom); return; }
  const x = Math.max(0, Math.min(...boxes.map(b => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map(b => b.y)) - pad);
  const x2 = Math.max(...boxes.map(b => b.x + b.width)) + pad;
  const y2 = Math.max(...boxes.map(b => b.y + b.height)) + pad;
  await page.screenshot({ path: D + nom + '.png', fullPage: true, clip: { x, y, width: x2 - x, height: y2 - y } });
  console.log('ok', nom, Math.round(x2 - x) + 'x' + Math.round(y2 - y));
}
const sect = (p, titre) => p.locator('.section-title', { hasText: titre }).first();
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(B + '/');
  await p.evaluate(t => localStorage.setItem('graine.session', JSON.stringify({ token: t, user: { pseudo: 'Alice' } })), TA);
  await p.reload(); await p.waitForTimeout(1500);
  await p.click('[data-tab="eglise"]'); await p.waitForTimeout(2200);

  await cap(p, '.egl-nom', 'r1-identite', 0);
  await cap(p, p.locator('.card').first(), 'r2-tete');
  await cap(p, ['.friend-code-row', '[data-inviter]'], 'r3-code');
  await cap(p, [sect(p, 'Annonces'), p.locator('.card').filter({ hasText: 'Baptêmes' }).first()], 'r4-annonces');
  await cap(p, [sect(p, "La semaine de l'assemblée"), p.locator('.card').filter({ hasText: 'Culte' }).first()], 'r5-rdv');
  await cap(p, [sect(p, 'Services'), p.locator('.card').filter({ hasText: 'Accueil du dimanche' }).first()], 'r6-services');
  await cap(p, [sect(p, 'Ensemble par cœur'), p.locator('.card').filter({ hasText: 'camp' }).first()], 'r7-packs');
  await cap(p, [sect(p, 'Ensemble dans la Parole'), p.locator('.card').filter({ hasText: 'Jean' }).first()], 'r8-lecture');
  await cap(p, [sect(p, 'Membres'), p.locator('.friends-card').first()], 'r9-membres');
  await cap(p, '[data-tab="banques"]', 'r10-series');
  await cap(p, '[data-egldelopen]', 'r11-supprimer', 14);
  await browser.close();
})();
