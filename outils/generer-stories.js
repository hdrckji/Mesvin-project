/* ============================================================================
   Bible Horizon — générateur de stories-questions (Instagram).

   Produit une « semaine » de stories (1080×1920) à partir de la banque de
   questions du Défi (defi/data/questions.json) : le visuel pose la question,
   la personne qui publie ajoute par-dessus le sticker « Quiz » d'Instagram
   avec les 4 options — les abonnés répondent, Instagram révèle la bonne
   réponse. Un avant-goût du Défi de l'appli, directement dans les stories.

   Usage (depuis la racine du dépôt ou depuis outils/) :
     node outils/generer-stories.js              → semaine 1 (14 stories, 2/jour)
     node outils/generer-stories.js --semaine 2  → la suivante, sans redite
   Sortie : outils/kit-sortie/stories-semaine-N/ (visuels/ + STORIES.md) —
   non versionnée, comme les lots de posts.

   Prérequis : les mêmes que generer-kit.js (npm install dans outils/ +
   un Chrome/Chromium ; CHROME_PATH est honoré).
   ========================================================================== */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const PAR_SEMAINE = 14; // deux stories par jour
const OPTION_MAX = 24;  // le sticker Quiz d'Instagram coupe au-delà de ~26 caractères
const semArg = process.argv.indexOf('--semaine');
const SEMAINE = semArg === -1 ? 1 : Math.max(1, parseInt(process.argv[semArg + 1], 10) || 1);

const SORTIE = path.join(__dirname, 'kit-sortie', 'stories-semaine-' + SEMAINE);
fs.mkdirSync(path.join(SORTIE, 'visuels'), { recursive: true });

/* ---- Les questions de la semaine -------------------------------------------
   On ne prend que celles dont les 4 options tiennent dans le sticker, puis on
   les range niveau par niveau en alternant les catégories : chaque semaine
   mélange les six thèmes, et commence facile. L'ordre est déterministe :
   relancer le script redonne les mêmes semaines, sans redite entre elles. */
const banque = JSON.parse(fs.readFileSync(path.join(RACINE, 'defi/data/questions.json'), 'utf8'));
const jouables = banque.questions.filter(q => q.options.every(o => o.length <= OPTION_MAX));

const parCategorie = new Map();
for (const q of jouables) {
  if (!parCategorie.has(q.categorie)) parCategorie.set(q.categorie, []);
  parCategorie.get(q.categorie).push(q);
}
for (const liste of parCategorie.values()) liste.sort((a, b) => a.niveau - b.niveau || a.id.localeCompare(b.id));

const ordonnees = [];
const files = [...parCategorie.values()];
for (let i = 0; files.some(f => f.length); i++) {
  const file = files[i % files.length];
  if (file.length) ordonnees.push(file.shift());
}

const questions = ordonnees.slice((SEMAINE - 1) * PAR_SEMAINE, SEMAINE * PAR_SEMAINE);
if (questions.length === 0) {
  console.error(`Semaine ${SEMAINE} : plus de questions disponibles (${jouables.length} jouables en banque). ` +
    'Ajoute des questions à defi/data/questions.json, ou demande une semaine thématique sur mesure.');
  process.exit(1);
}

/* ---- La story : palette du site, format vertical ---------------------------
   Le tiers central reste VIDE : c'est là que la personne pose le sticker Quiz.
   Haut et bas gardent une marge de sécurité (~250 px) que l'interface
   d'Instagram recouvre. Alternance nuit / aube, comme le fil. */
const soleil = (w, c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="90 100 332 190" width="${w}">
  <circle cx="256" cy="252" r="46" fill="${c}"/>
  <g stroke="${c}" stroke-width="13" stroke-linecap="round">
    <path d="M256 158v-30"/><path d="M180 192l-21-21"/><path d="M332 192l21-21"/>
    <path d="M162 252h-30"/><path d="M350 252h30"/>
  </g></svg>`;

function tailleQuestion(t) {
  if (t.length <= 60) return 68;
  if (t.length <= 90) return 62;
  if (t.length <= 120) return 56;
  return 50;
}

const echap = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function carteStory(q, i) {
  const nuit = i % 2 === 0;
  const bg = nuit ? '#1b2a4a' : '#f7f3ea';
  const encre = nuit ? '#f4efe4' : '#233047';
  const accent = nuit ? '#d9b45f' : '#b98a2e';
  const halo = nuit ? 'rgba(217,180,95,.14)' : 'rgba(185,138,46,.12)';
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0}
  .c{width:1080px;height:1920px;background:${bg};position:relative;overflow:hidden;
     font-family:'Liberation Serif','Times New Roman',Georgia,serif;display:flex;flex-direction:column;
     align-items:center;text-align:center;padding:300px 100px 280px;box-sizing:border-box}
  .halo{position:absolute;top:-320px;left:50%;transform:translateX(-50%);width:1000px;height:1000px;
     border-radius:50%;background:radial-gradient(circle,${halo} 0%,transparent 62%)}
  .cat{color:${accent};font-size:30px;letter-spacing:.16em;text-transform:uppercase;
     font-family:'Liberation Sans',Arial,sans-serif;font-weight:bold;position:relative}
  .sun{margin:44px 0 56px;position:relative}
  .q{color:${encre};font-size:${tailleQuestion(q.question)}px;line-height:1.4;position:relative;max-width:860px}
  .trait{width:72px;height:3px;background:${accent};opacity:.55;margin:56px auto 0}
  .zone{flex:1}
  .indice{color:${encre};opacity:.45;font-family:'Liberation Sans',Arial,sans-serif;
     font-size:28px;letter-spacing:.05em;position:relative}
  .pied{position:absolute;bottom:190px;left:0;right:0;color:${encre};opacity:.52;
     font-family:'Liberation Sans',Arial,sans-serif;font-size:26px;letter-spacing:.06em}
  </style><div class="c"><div class="halo"></div>
  <div class="cat">Défi Bible Horizon · ${echap(q.categorie)}</div>
  <div class="sun">${soleil(180, accent)}</div>
  <div class="q">${echap(q.question)}</div>
  <div class="trait"></div>
  <div class="zone"></div>
  <div class="indice">Réponds au quiz ci-dessous ⌄</div>
  <div class="pied">biblehorizon.fr</div></div>`;
}

/* ---- Le mode d'emploi de la semaine ----------------------------------------
   Une story par visuel, deux par jour. Le sticker Quiz ne peut pas être
   programmé automatiquement (l'API d'Instagram ne le permet pas) : dans
   Metricool, on programme la story en « publication par notification », et au
   moment venu on pose le sticker avec les options ci-dessous. */
function modeEmploi() {
  let md = `# Stories-questions — semaine ${SEMAINE}\n\n`;
  md += 'Chaque story correspond au visuel du même numéro (visuels/story-NN.png).\n';
  md += 'Rythme conseillé : **deux par jour** (midi et 19 h), du lundi au dimanche.\n\n';
  md += '## Comment publier (Metricool + Instagram)\n\n';
  md += '1. Dans Metricool : Planificateur → story → glisser le visuel, choisir\n';
  md += '   la date, et régler la publication **par notification** (le sticker\n';
  md += '   Quiz ne peut pas être posé automatiquement : l\'API d\'Instagram ne\n';
  md += '   le permet à aucun outil).\n';
  md += '2. À la notification : ouvrir la story dans Instagram et poser un\n';
  md += '   sticker dans l\'espace vide sous la question — **Quiz** ou\n';
  md += '   **Sondage**, au choix. Comme la question est déjà sur le visuel,\n';
  md += '   écrire simplement « Ta réponse ? » dans le champ du sticker, puis\n';
  md += '   les 4 options du même numéro ci-dessous.\n';
  md += '3. La différence entre les deux : le **Quiz** (coche la bonne réponse\n';
  md += '   en le créant) la révèle à chaque personne qui vote — l\'esprit du\n';
  md += '   Défi de l\'appli. Le **Sondage** ne montre que les pourcentages :\n';
  md += '   si tu le préfères, donne la réponse dans la story suivante ou en\n';
  md += '   répondant aux votes (elle est ci-dessous, avec sa référence).\n';
  md += '4. Une fois par semaine (la story n° 7), ajouter aussi le sticker\n';
  md += '   **Lien** vers biblehorizon.fr : « Envie d\'autres questions ? » —\n';
  md += '   les autres stories donnent, sans rien réclamer.\n\n';
  md += 'La référence biblique est là pour toi (et pour répondre aux messages) ;\n';
  md += 'elle n\'apparaît pas sur le visuel pour ne pas souffler la réponse.\n\n';
  questions.forEach((q, i) => {
    const n = String((SEMAINE - 1) * PAR_SEMAINE + i + 1).padStart(2, '0');
    const jour = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'][Math.floor(i / 2) % 7];
    const heure = i % 2 === 0 ? 'midi' : '19 h';
    md += `## story-${n} — ${jour} ${heure} · ${q.categorie} (niveau ${q.niveau})\n\n`;
    md += `${q.question}\n\n`;
    q.options.forEach((o, j) => {
      md += `- ${j === q.bonne ? '✅' : '▫️'} ${o}\n`;
    });
    md += `\nRéférence : ${q.reference}\n\n`;
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
  await page.setViewportSize({ width: 1080, height: 1920 });
  for (let i = 0; i < questions.length; i++) {
    await page.setContent(carteStory(questions[i], i));
    const n = String((SEMAINE - 1) * PAR_SEMAINE + i + 1).padStart(2, '0');
    await page.screenshot({ path: path.join(SORTIE, 'visuels', 'story-' + n + '.png') });
  }
  await browser.close();
  fs.writeFileSync(path.join(SORTIE, 'STORIES.md'), modeEmploi());
  console.log(`Semaine ${SEMAINE} : ${questions.length} stories + mode d'emploi → ${SORTIE}`);
  if (questions.length < PAR_SEMAINE) {
    console.log(`(dernière semaine : il ne restait que ${questions.length} questions jouables en banque)`);
  }
})();
