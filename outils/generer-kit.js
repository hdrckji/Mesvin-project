/* ============================================================================
   Bible Horizon — générateur du kit Instagram.

   Produit un « lot » de cartes de versets (1080×1080) et leurs légendes,
   prêts à programmer dans Metricool. Les versets viennent de la banque de
   l'appli (data/verses.json, Segond 1910) : mêmes textes, même sérieux.

   Usage (depuis la racine du dépôt ou depuis outils/) :
     node outils/generer-kit.js            → lot 1 (les 30 premiers)
     node outils/generer-kit.js --lot 2    → lot suivant, sans redite
   Sortie : outils/kit-sortie/lot-N/  (visuels/ + LEGENDES.md) — non versionnée.

   Prérequis : Node + `npm install` dans outils/ (playwright-core), et un
   Chrome/Chromium. Le script cherche dans l'ordre : la variable CHROME_PATH,
   le Chromium de l'environnement Claude (/opt/pw-browsers/chromium), puis le
   Chrome installé sur la machine (canal « chrome » — cas Cowork).
   ========================================================================== */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const PAR_LOT = 30;
const lotArg = process.argv.indexOf('--lot');
const LOT = lotArg === -1 ? 1 : Math.max(1, parseInt(process.argv[lotArg + 1], 10) || 1);

const SORTIE = path.join(__dirname, 'kit-sortie', 'lot-' + LOT);
fs.mkdirSync(path.join(SORTIE, 'visuels'), { recursive: true });

/* ---- Les versets du lot : courts, dans l'ordre du parcours de l'appli ---- */
const donnees = JSON.parse(fs.readFileSync(path.join(RACINE, 'data/verses.json'), 'utf8'));
const courts = (donnees.verses || []).filter(v => v.text && v.text.length <= 190);
const versets = courts.slice((LOT - 1) * PAR_LOT, LOT * PAR_LOT);
if (versets.length === 0) {
  console.error(`Lot ${LOT} : plus de versets disponibles (${courts.length} courts en banque). ` +
    'Ajoute des versets à data/verses.json, ou demande un lot thématique sur mesure.');
  process.exit(1);
}

/* ---- La carte : palette du site (nuit #1b2a4a, or #d9b45f, crème #f7f3ea) ---- */
const soleil = (w, c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="90 100 332 190" width="${w}">
  <circle cx="256" cy="252" r="46" fill="${c}"/>
  <g stroke="${c}" stroke-width="13" stroke-linecap="round">
    <path d="M256 158v-30"/><path d="M180 192l-21-21"/><path d="M332 192l21-21"/>
    <path d="M162 252h-30"/><path d="M350 252h30"/>
  </g></svg>`;

function tailleTexte(t) {
  if (t.length <= 60) return 66;
  if (t.length <= 100) return 58;
  if (t.length <= 140) return 50;
  return 44;
}

// Alternance nuit / aube pour le rythme du fil.
function carteVerset(v, i) {
  const nuit = i % 2 === 0;
  const bg = nuit ? '#1b2a4a' : '#f7f3ea';
  const encre = nuit ? '#f4efe4' : '#233047';
  const accent = nuit ? '#d9b45f' : '#b98a2e';
  const halo = nuit ? 'rgba(217,180,95,.14)' : 'rgba(185,138,46,.12)';
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0}
  .c{width:1080px;height:1080px;background:${bg};position:relative;overflow:hidden;
     font-family:'Liberation Serif','Times New Roman',Georgia,serif;display:flex;flex-direction:column;
     align-items:center;justify-content:center;text-align:center;padding:0 110px;box-sizing:border-box}
  .halo{position:absolute;top:-260px;left:50%;transform:translateX(-50%);width:900px;height:900px;
     border-radius:50%;background:radial-gradient(circle,${halo} 0%,transparent 62%)}
  .sun{margin-bottom:38px}
  .t{color:${encre};font-size:${tailleTexte(v.text)}px;line-height:1.42;font-style:italic;position:relative}
  .r{color:${accent};font-size:34px;letter-spacing:.14em;text-transform:uppercase;
     font-family:'Liberation Sans',Arial,sans-serif;font-weight:bold;margin-top:46px;position:relative}
  .trait{width:72px;height:3px;background:${accent};opacity:.55;margin:34px auto 0}
  .pied{position:absolute;bottom:54px;left:0;right:0;color:${encre};opacity:.52;
     font-family:'Liberation Sans',Arial,sans-serif;font-size:26px;letter-spacing:.06em}
  </style><div class="c"><div class="halo"></div>
  <div class="sun">${soleil(210, accent)}</div>
  <div class="t">« ${v.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')} »</div>
  <div class="r">${v.ref}</div><div class="trait"></div>
  <div class="pied">biblehorizon.fr · Segond 1910</div></div>`;
}

/* ---- Les légendes Instagram : on offre, on ne réclame pas -------------------
   Pas d'URL dans la légende (non cliquable sur Instagram) : le lien vit dans
   la bio, et une publication sur cinq y renvoie en douceur. */
const douceurs = [
  'À garder près de soi aujourd’hui.',
  'Quelques mots à laisser descendre dans le cœur.',
  'Bonne journée, sous ce soleil-là.',
  'À relire ce soir, sans se presser.',
  'Un verset qui tient dans une poche — et dans un cœur.',
  'Paix sur ta journée.',
];
const TAGS = '#Bible #Verset #VersetDuJour #ParoleDeDieu #Foi #Espérance #Encouragement';

function legendes() {
  let md = `# Légendes — lot ${LOT} (Instagram)\n\n`;
  md += 'Chaque légende correspond au visuel du même numéro (visuels/post-NN.png).\n';
  md += 'Le lien biblehorizon.fr vit dans la BIO du compte — pense à l\'y mettre.\n\n';
  versets.forEach((v, i) => {
    const n = String((LOT - 1) * PAR_LOT + i + 1).padStart(2, '0');
    md += `## post-${n} — ${v.ref}\n\n`;
    md += `« ${v.text} »\n${v.ref} (Segond 1910)\n\n`;
    md += douceurs[i % douceurs.length] + '\n\n';
    if ((i + 1) % 5 === 0) {
      md += 'Bible Horizon — une appli gratuite et sans pub pour garder la Parole près de toi. Le lien est dans la bio 🌅\n\n';
    }
    md += TAGS + '\n';
    md += '\n';
  });
  return md;
}

/* ---- Trouver un navigateur, où qu'on soit ---------------------------------- */
async function lancerNavigateur() {
  if (process.env.CHROME_PATH) {
    return chromium.launch({ executablePath: process.env.CHROME_PATH });
  }
  const claude = '/opt/pw-browsers/chromium';
  if (fs.existsSync(claude)) {
    return chromium.launch({ executablePath: claude });
  }
  // Cowork / machine personnelle : le Chrome installé.
  return chromium.launch({ channel: 'chrome' });
}

(async () => {
  const browser = await lancerNavigateur();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1080, height: 1080 });
  for (let i = 0; i < versets.length; i++) {
    await page.setContent(carteVerset(versets[i], i));
    const n = String((LOT - 1) * PAR_LOT + i + 1).padStart(2, '0');
    await page.screenshot({ path: path.join(SORTIE, 'visuels', 'post-' + n + '.png') });
  }
  await browser.close();
  fs.writeFileSync(path.join(SORTIE, 'LEGENDES.md'), legendes());
  console.log(`Lot ${LOT} : ${versets.length} visuels + légendes → ${SORTIE}`);
  if (versets.length < PAR_LOT) {
    console.log(`(dernier lot : il ne restait que ${versets.length} versets courts en banque)`);
  }
})();
