/* ============================================================================
   Bible Horizon — la story « recherche testeurs » (Instagram).

   Un visuel unique (1080×1920) pour la période du test fermé Play Store :
   il annonce l'arrivée sur Android et appelle les abonnés à devenir
   testeurs. L'espace vide du bas accueille le sticker LIEN d'Instagram,
   pointé vers https://play.google.com/apps/testing/fr.biblehorizon.app
   (voir outils/playstore/TESTEURS.md pour le reste de la campagne).

   Usage :  node outils/generer-story-testeurs.js
   Sortie : outils/kit-sortie/story-testeurs.png — non versionnée.
   Prérequis : les mêmes que generer-kit.js (npm install + Chrome/Chromium).
   ========================================================================== */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const SORTIE = path.join(__dirname, 'kit-sortie');
fs.mkdirSync(SORTIE, { recursive: true });

const soleil = (w, c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="90 100 332 190" width="${w}">
  <circle cx="256" cy="252" r="46" fill="${c}"/>
  <g stroke="${c}" stroke-width="13" stroke-linecap="round">
    <path d="M256 158v-30"/><path d="M180 192l-21-21"/><path d="M332 192l21-21"/>
    <path d="M162 252h-30"/><path d="M350 252h30"/>
  </g></svg>`;

const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0}
  .c{width:1080px;height:1920px;background:#1b2a4a;position:relative;overflow:hidden;
     font-family:'Liberation Serif','Times New Roman',Georgia,serif;display:flex;flex-direction:column;
     align-items:center;text-align:center;padding:300px 100px 280px;box-sizing:border-box;color:#f4efe4}
  .halo{position:absolute;top:-320px;left:50%;transform:translateX(-50%);width:1000px;height:1000px;
     border-radius:50%;background:radial-gradient(circle,rgba(217,180,95,.16) 0%,transparent 62%)}
  .sur{color:#d9b45f;font-size:30px;letter-spacing:.16em;text-transform:uppercase;
     font-family:'Liberation Sans',Arial,sans-serif;font-weight:bold;position:relative}
  .sun{margin:44px 0 56px;position:relative}
  .t{font-size:72px;line-height:1.3;position:relative;max-width:860px}
  .t em{font-style:normal;color:#d9b45f}
  .s{font-size:40px;line-height:1.5;margin-top:56px;opacity:.92;position:relative;max-width:820px}
  .pas{font-family:'Liberation Sans',Arial,sans-serif;font-size:30px;line-height:1.7;margin-top:64px;
     position:relative;opacity:.85}
  .zone{flex:1}
  .indice{opacity:.5;font-family:'Liberation Sans',Arial,sans-serif;font-size:28px;letter-spacing:.05em;position:relative}
  .pied{position:absolute;bottom:190px;left:0;right:0;opacity:.52;
     font-family:'Liberation Sans',Arial,sans-serif;font-size:26px;letter-spacing:.06em}
  </style><div class="c"><div class="halo"></div>
  <div class="sur">Bible Horizon arrive sur Android</div>
  <div class="sun">${soleil(180, '#d9b45f')}</div>
  <div class="t">On cherche <em>12 testeurs</em> pour ouvrir la porte du Play Store</div>
  <div class="s">Deux minutes, rien à évaluer : installer l'appli et la garder deux semaines.</div>
  <div class="pas">1. Touche le lien ci-dessous&nbsp;&nbsp;·&nbsp;&nbsp;2. Accepte l'invitation<br>3. Installe — c'est tout 🌅</div>
  <div class="zone"></div>
  <div class="indice">Le lien est juste ici ⌄</div>
  <div class="pied">biblehorizon.fr · gratuit, sans publicité</div></div>`;

async function lancerNavigateur() {
  if (process.env.CHROME_PATH) {
    return chromium.launch({ executablePath: process.env.CHROME_PATH });
  }
  const claude = '/opt/pw-browsers/chromium';
  if (fs.existsSync(claude)) {
    return chromium.launch({ executablePath: claude });
  }
  return chromium.launch({ channel: 'chrome' });
}

(async () => {
  const browser = await lancerNavigateur();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1080, height: 1920 });
  await page.setContent(html);
  await page.screenshot({ path: path.join(SORTIE, 'story-testeurs.png') });
  await browser.close();
  console.log('Story testeurs → ' + path.join(SORTIE, 'story-testeurs.png'));
})();
