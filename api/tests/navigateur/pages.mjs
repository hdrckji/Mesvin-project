/* ============================================================================
   Chaque page du site, ouverte dans un vrai navigateur.

   Les six autres scénarios éprouvent des PARCOURS (une veillée, un duel, une
   connexion) et visitent donc surtout les écrans de l'appli. Restent les pages
   qu'aucun test ne touchait : /eglises/, /quiz-biblique/, /plan-lecture-bible/,
   /memoriser-versets/, /confidentialite/, /mentions-legales/… — le référencement
   et les pages légales, c'est-à-dire la vitrine publique. Une page cassée là ne
   gêne aucun utilisateur connecté : personne ne s'en aperçoit.

   La liste n'est pas écrite en dur : on découvre les pages sur le disque, pour
   qu'une page ajoutée demain soit couverte sans que personne y pense.

   Chaque page est ouverte dans un contexte NEUF — donc en première visite, sans
   rien en localStorage ni en cache : c'est la condition du nouveau venu, celle
   où les défauts d'initialisation se voient.

   Note sur les erreurs de console : elles sont RAPPORTÉES, jamais fatales. Un
   avertissement de navigateur ou une ressource tierce capricieuse rendrait le
   test rouge sans qu'aucun défaut existe, et un test qui crie pour rien finit
   par ne plus être lu du tout. Ce qui échoue ici, ce sont les faits durs : la
   page ne répond pas, ne se peint pas, lève une exception, ou réclame un
   fichier qui n'existe pas.

     node api/tests/navigateur/pages.mjs <base>
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:8180';
const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let pass = 0, fail = 0;
const ok = m => { pass++; console.log(`   ok   ${m}`); };
const bad = (m, d) => {
  fail++;
  console.log(`   FAIL ${m}`);
  if (d) String(d).split('\n').slice(0, 12).forEach(l => console.log('        ' + l));
};

/* Les pages : la racine, puis tout dossier de premier niveau portant un
   index.html. « outils/ » est l'atelier de communication, hors du site. */
const HORS_SITE = new Set(['outils', 'api', 'node_modules', '.git', '.well-known']);
const pages = ['/'];
for (const e of fs.readdirSync(RACINE, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!e.isDirectory() || HORS_SITE.has(e.name)) continue;
  if (fs.existsSync(path.join(RACINE, e.name, 'index.html'))) pages.push(`/${e.name}/`);
}

// Un 404 sur ces requêtes-là n'est pas un défaut : le navigateur les tente
// de lui-même, ou l'appli les essaie sciemment.
const TOLERE = [/favicon\.ico$/, /\/api\/push\/vapid/];

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
  console.log(`\n-- ${pages.length} pages découvertes sur le disque`);
  for (const chemin of pages) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();

    const exceptions = [], consoleKO = [], requetesKO = [];
    page.on('pageerror', e => exceptions.push(e.message));
    page.on('console', m => { if (m.type() === 'error') consoleKO.push(m.text()); });
    page.on('requestfailed', r => {
      if (!TOLERE.some(re => re.test(r.url()))) requetesKO.push(`${r.url()} — ${r.failure()?.errorText}`);
    });
    page.on('response', r => {
      if (r.status() >= 400 && !TOLERE.some(re => re.test(r.url()))) requetesKO.push(`${r.status()} ${r.url()}`);
    });

    try {
      const rep = await page.goto(BASE + chemin, { waitUntil: 'load', timeout: 30000 });
      const code = rep ? rep.status() : 0;
      // Les scripts « defer » doivent avoir tourné et l'écran être peint.
      await page.waitForTimeout(2500);
      const titre = (await page.title()).trim();
      const texte = (await page.evaluate(() => document.body.innerText || '')).trim();

      const griefs = [];
      if (code !== 200) griefs.push(`répond ${code || 'rien'}`);
      if (!titre) griefs.push('titre vide');
      if (texte.length <= 40) griefs.push(`page quasi vide (« ${texte.slice(0, 80)} »)`);
      if (exceptions.length) griefs.push(`exception JS : ${exceptions.join(' | ')}`);
      if (requetesKO.length) griefs.push(`requête en échec : ${requetesKO.join(' | ')}`);

      if (griefs.length === 0) {
        ok(`${chemin} — 200, « ${titre.slice(0, 46)} », ${texte.length} caractères peints`);
      } else {
        bad(`${chemin}`, griefs.join('\n'));
      }
      // Rapportées, jamais fatales : voir l'en-tête de ce fichier.
      if (consoleKO.length) console.log(`        (console : ${consoleKO.length} message(s) — ${consoleKO[0].slice(0, 90)})`);
    } catch (e) {
      bad(`${chemin} — la page n'a pas pu être ouverte`, e.message);
    }
    await ctx.close();
  }

  /* ---- Le manifeste et le service worker -------------------------------- */
  // Une erreur ici ne se voit sur aucun écran : c'est l'installation sur le
  // téléphone qui échoue, en silence.
  console.log('\n-- PWA : manifeste et service worker');
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'load' });

  const m = await page.evaluate(async () => {
    const l = document.querySelector('link[rel="manifest"]');
    if (!l) return { erreur: 'pas de <link rel="manifest">' };
    const r = await fetch(l.href);
    if (!r.ok) return { erreur: 'manifeste ' + r.status };
    try { return { json: await r.json() }; } catch (e) { return { erreur: 'manifeste illisible : ' + e.message }; }
  });
  if (m.erreur) {
    bad(m.erreur);
  } else {
    ok(`manifeste servi et analysable — « ${m.json.name || m.json.short_name} »`);
    // Une seule icône manquante et le navigateur refuse l'installation.
    const manquantes = await page.evaluate(async icons => {
      const out = [];
      for (const i of icons) { const r = await fetch(new URL(i.src, location.href)); if (!r.ok) out.push(`${i.src} → ${r.status}`); }
      return out;
    }, m.json.icons || []);
    manquantes.length
      ? bad('icône(s) du manifeste absente(s)', manquantes.join('\n'))
      : ok(`les ${(m.json.icons || []).length} icônes du manifeste répondent`);
  }

  const sw = await page.evaluate(() => new Promise(res => {
    if (!('serviceWorker' in navigator)) return res({ erreur: 'pas de serviceWorker' });
    navigator.serviceWorker.ready.then(reg => res({ scope: reg.scope })).catch(e => res({ erreur: e.message }));
    setTimeout(() => res({ erreur: 'délai dépassé (10 s)' }), 10000);
  }));
  sw.erreur ? bad('service worker : ' + sw.erreur) : ok(`service worker actif (scope ${sw.scope})`);
  await ctx.close();
} finally {
  await b.close();
}

console.log(`\n${pass} réussites, ${fail} échecs`);
process.exit(fail === 0 ? 0 : 1);
