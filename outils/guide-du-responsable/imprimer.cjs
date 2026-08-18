const { createRequire } = require('module');
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await browser.newPage();
  await p.goto('file://' + __dirname + '/guide-responsable.html', { waitUntil: 'networkidle' });
  await p.pdf({ path: __dirname + '/../../guide/guide-du-responsable.pdf', format: 'A4', printBackground: true,
                margin: { top: '17mm', bottom: '16mm', left: '16mm', right: '16mm' } });
  await browser.close();
  console.log('pdf ok');
})();
