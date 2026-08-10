/* ============================================================================
   Bible Horizon — mémorisation de versets, VÉRIFIÉE PAR L'APPLI.

   Principe (important) :
   - La vérification se fait SUR L'APPLI, pas dans la tête de l'utilisateur.
     Il remet les mots dans l'ordre, ou complète les mots manquants, en touchant
     l'écran ; l'appli juge si c'est correct.
   - Un verset n'entre au JARDIN qu'après avoir été RÉUSSI OBJECTIVEMENT
     3 fois, sur plusieurs retours espacés (répétition espacée). Un échec ne
     punit pas : il fait juste reculer d'un cran et revenir plus tôt.
   - Une aide (« revoir le verset ») reste possible, mais un essai aidé ne
     compte pas comme une validation : la maîtrise se gagne sans aide.

   Tout est côté navigateur : aucun compte, hors-ligne, rien ne quitte l'appareil.
   ========================================================================== */

'use strict';

const STORE_KEY = 'graine.v3';
const EASE_MIN = 1.3, EASE_DEFAULT = 2.5;
const MASTERY = 3;            // nombre de réussites objectives pour « mémorisé »
const SCRAMBLE_MAX = 12;      // au-delà, on passe aux mots à trous

/* ---------- Aides ---------- */
const el = document.getElementById('app');
const todayNum = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.round(d.getTime() / 86400000); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }

/* ---------- Stockage ---------- */
function loadStore() {
  let s = null;
  try { const r = localStorage.getItem(STORE_KEY); if (r) s = JSON.parse(r); } catch (e) {}
  return normalizeStore(s);
}
// Remet les champs par défaut sur un store quelconque (chargé OU issu d'une
// fusion avec le serveur) — champs additifs uniquement, jamais destructif.
function normalizeStore(s) {
  if (!s || typeof s !== 'object') s = {};
  // Champs additifs uniquement : un store v3 existant reste valide tel quel.
  if (!s.cards) s.cards = {};
  if (!s.streak) s.streak = { count: 0, lastDay: null };
  if (!('activeCollection' in s)) s.activeCollection = null;           // objectif choisi (id de collection) ou null = parcours général
  if (!Array.isArray(s.completedCollections)) s.completedCollections = []; // collections déjà célébrées
  // Espace « Moi » — champs additifs (un store existant reste valide) :
  // plus longue série (initialisée à la série en cours, sans inventer de passé)
  if (typeof s.bestStreak !== 'number') s.bestStreak = typeof s.streak.count === 'number' ? s.streak.count : 0;
  // jours d'activité : compteur démarré à la première ouverture (aucun historique inventé)
  if (typeof s.activeDays !== 'number') s.activeDays = 0;
  if (!('activeDayLast' in s)) s.activeDayLast = null; // dernier jour compté
  if (!s.streak || typeof s.streak !== 'object') s.streak = { count: 0, lastDay: null };
  return s;
}
function saveStore() { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
let store = loadStore();

/* ---------- Thème (Moi → Apparence) ----------
   'auto' (défaut) : aucun attribut data-theme, les media queries décident.
   'clair' | 'sombre' | 'sepia' : posé sur <html>, gagne sur le système.
   Le mini-script inline de chaque index.html fait la même chose au chargement
   (anti-flash) ; ici on gère le choix et son application immédiate. */
const THEME_KEY = 'graine.theme';
const THEME_CHOICES = ['auto', 'clair', 'sombre', 'sepia'];
const THEME_FONDS = { clair: '#f7f3ea', sombre: '#141b28', sepia: '#f2e6cf' }; // = --bg de chaque palette
function themeChoice() {
  try { const t = localStorage.getItem(THEME_KEY); return THEME_CHOICES.includes(t) ? t : 'auto'; }
  catch (e) { return 'auto'; }
}
function applyTheme(choix) {
  if (!THEME_CHOICES.includes(choix)) choix = 'auto';
  try { localStorage.setItem(THEME_KEY, choix); } catch (e) {}
  if (choix === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choix);
  // La barre du navigateur (theme-color) suit le thème effectif.
  const sombreSysteme = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  const effectif = choix === 'auto' ? (sombreSysteme ? 'sombre' : 'clair') : choix;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_FONDS[effectif] || THEME_FONDS.clair);
}

/* ---------- Bibliothèque (parcours) ---------- */
let LIBRARY = [], LIB_VERSION = 'Segond 1910';
async function loadLibrary() {
  try { const d = await (await fetch('data/verses.json', { cache: 'no-cache' })).json(); LIBRARY = d.verses || []; LIB_VERSION = d.version || LIB_VERSION; }
  catch (e) { LIBRARY = []; }
}

/* ---------- Collections (objectifs facultatifs) ---------- */
let THEME_COLLECTIONS = [];
const BOOK_COLLECTION_MIN = 3; // un livre devient une collection à partir de 3 versets
async function loadCollections() {
  try { const d = await (await fetch('data/collections.json', { cache: 'no-cache' })).json(); THEME_COLLECTIONS = d.collections || []; }
  catch (e) { THEME_COLLECTIONS = []; }
}
// Les collections « par livre » se déduisent du champ ref, dans l'ordre du parcours.
function bookCollections() {
  const byBook = new Map();
  for (const v of LIBRARY) {
    const b = bookOf(v.ref);
    if (!byBook.has(b)) byBook.set(b, []);
    byBook.get(b).push(v.id);
  }
  const out = [];
  for (const [book, ids] of byBook) {
    if (ids.length >= BOOK_COLLECTION_MIN) out.push({ id: 'livre:' + book, name: book, emoji: '📖', desc: '', verses: ids });
  }
  return out;
}
const allCollections = () => THEME_COLLECTIONS.concat(bookCollections());
const collectionById = id => (id ? allCollections().find(c => c.id === id) || null : null);
const activeColl = () => collectionById(store.activeCollection);
function collProgress(c) {
  const m = c.verses.filter(id => store.cards[id] && isMastered(store.cards[id])).length;
  return { m, total: c.verses.length };
}
const isCollComplete = c => { const p = collProgress(c); return p.total > 0 && p.m >= p.total; };
// Marque comme « complètes » (sans célébration) les collections déjà achevées
// au chargement — la célébration est réservée au moment où l'on complète.
function syncCompletedCollections() {
  let changed = false;
  for (const c of allCollections()) {
    if (isCollComplete(c) && !store.completedCollections.includes(c.id)) { store.completedCollections.push(c.id); changed = true; }
  }
  if (changed) saveStore();
}
// Après une mémorisation : quelles collections viennent d'être complétées ?
function checkCollectionCompletions() {
  const newly = [];
  for (const c of allCollections()) {
    if (isCollComplete(c) && !store.completedCollections.includes(c.id)) {
      store.completedCollections.push(c.id);
      newly.push(c);
      if (store.activeCollection === c.id) store.activeCollection = null; // retour au parcours général
    }
  }
  if (newly.length) saveStore();
  return newly;
}

// Prochain verset à apprendre : celui de l'objectif actif s'il y en a un,
// sinon le parcours général (ordre du tableau verses.json), comme avant.
function nextToLearn() {
  const c = activeColl();
  if (c) {
    const vid = c.verses.find(id => !store.cards[id]);
    return vid ? LIBRARY.find(v => v.id === vid) || null : null;
  }
  return LIBRARY.find(v => !store.cards[v.id]) || null;
}

/* ---------- Contexte factuel du livre ---------- */
const BOOKS = {
  'Jean': "Évangile écrit par Jean, l'un des douze apôtres. Il met en avant l'identité de Jésus, Fils de Dieu.",
  'Psaumes': "Recueil de 150 prières et chants d'Israël (David et d'autres). Louange, détresse, confiance.",
  'Philippiens': "Lettre de Paul, écrite depuis la prison, à l'église de Philippes. Un ton de joie et de reconnaissance.",
  'Proverbes': "Recueil de sentences de sagesse, en grande partie attribuées à Salomon.",
  'Romains': "Lettre de l'apôtre Paul à l'église de Rome, exposé de fond sur le salut par la foi.",
  'Ésaïe': "Livre du prophète Ésaïe, annonçant le jugement puis la consolation et l'espérance.",
  'Matthieu': "Évangile écrit par Matthieu, qui présente Jésus comme le Messie promis.",
  'Josué': "Récit de l'entrée du peuple d'Israël dans le pays promis, sous la conduite de Josué.",
  'Éphésiens': "Lettre de Paul à l'église d'Éphèse, sur la grâce et la vie nouvelle en Christ.",
  'Jérémie': "Livre du prophète Jérémie, écrit dans une période d'épreuve et d'exil.",
  '1 Corinthiens': "Première lettre de Paul à l'église de Corinthe, réponses à des questions de la vie d'église.",
  '1 Jean': "Lettre de l'apôtre Jean sur l'amour, la lumière et l'assurance du salut.",
  'Apocalypse': "Dernier livre de la Bible, une révélation donnée à Jean, pleine d'espérance.",
  '2 Timothée': "Dernière lettre de Paul, à son disciple Timothée, comme un testament d'encouragement.",
  'Galates': "Lettre de Paul aux églises de Galatie sur la liberté et la vie par l'Esprit.",
  'Michée': "Livre du prophète Michée, appel à la justice et à l'humilité devant Dieu.",
  'Hébreux': "Lettre exhortant à persévérer dans la foi en Christ, supérieur à tout.",
  'Lamentations': "Poèmes de deuil sur Jérusalem, où perce malgré tout la fidélité de Dieu.",
  'Colossiens': "Lettre de Paul à l'église de Colosses, sur la primauté de Christ et la vie nouvelle.",
  '1 Thessaloniciens': "Première lettre de Paul à l'église de Thessalonique, encouragements et espérance du retour de Christ.",
  'Jacques': "Lettre de Jacques, très concrète : une foi qui se voit dans les actes de chaque jour."
};
const bookOf = ref => { const m = ref.match(/^(\d?\s?[A-Za-zÀ-ÿ]+)/); return m ? m[1].trim() : ref; };

/* ============================================================================
   Cartes & répétition espacée
   ========================================================================== */
function introduce(v) {
  store.cards[v.id] = {
    id: v.id, ref: v.ref, text: v.text,
    ease: EASE_DEFAULT, interval: 0, due: todayNum(),
    validations: 0, attempts: 0, addedDay: todayNum()
  };
  saveStore();
  return store.cards[v.id];
}
const isMastered = c => c.validations >= MASTERY;
function schedule(card, quality) {
  // quality: 'fail' | 'ok' | 'clean'
  const t = todayNum();
  if (quality === 'fail') { card.ease = Math.max(EASE_MIN, card.ease - 0.2); card.interval = 1; }
  else {
    const step = card.validations; // déjà incrémenté avant l'appel
    if (step <= 1) card.interval = 1;
    else if (step === 2) card.interval = 3;
    else card.interval = Math.round((card.interval || 4) * card.ease);
    if (quality === 'clean') card.ease += 0.05;
  }
  // Pendant l'apprentissage, on garde des retours rapprochés (≤ 3 jours).
  if (!isMastered(card)) card.interval = Math.min(card.interval, 3);
  card.interval = Math.min(card.interval, 365);
  card.due = t + card.interval;
}
function stageOf(card) {
  if (card.interval <= 3) return { icon: '🌱', label: 'Germe' };
  if (card.interval <= 13) return { icon: '🌿', label: 'Pousse' };
  if (card.interval <= 44) return { icon: '🪴', label: 'Plante' };
  if (card.interval <= 119) return { icon: '🌳', label: 'Arbre' };
  return { icon: '🌲', label: 'Enraciné' };
}
const masteredCards = () => Object.values(store.cards).filter(isMastered);
const learningCards = () => Object.values(store.cards).filter(c => !isMastered(c));
const dueCards = () => { const t = todayNum(); return Object.values(store.cards).filter(c => c.due <= t); };
function updateStreak() {
  const t = todayNum(), s = store.streak;
  if (s.lastDay === t) return; if (s.lastDay === t - 1) s.count++; else s.count = 1;
  s.lastDay = t;
  if (s.count > (store.bestStreak || 0)) store.bestStreak = s.count; // record de série
  saveStore();
}
// Un jour est « actif » dès qu'on ouvre l'appli — compté une seule fois par jour.
function markActiveDay() {
  const t = todayNum();
  if (store.activeDayLast === t) return;
  store.activeDayLast = t;
  store.activeDays = (store.activeDays || 0) + 1;
  saveStore();
}

/* ---------- Lecture DÉFENSIVE des stores des autres modules ----------
   Les modules Lire et Défi possèdent leurs propres clés localStorage et leur
   forme peut évoluer : on lit sans jamais casser (try/catch + valeurs sûres). */
function lireStats() {
  const out = { chapters: 0, books: 0 };
  try {
    const raw = localStorage.getItem('graine.lire.v1');
    if (!raw) return out;
    const s = JSON.parse(raw);
    const plans = s && typeof s === 'object' && s.plans && typeof s.plans === 'object' ? s.plans : {};
    for (const p of Object.values(plans)) {
      if (!p || !Array.isArray(p.read)) continue;
      const n = p.read.filter(Boolean).length;
      out.chapters += n;
      if (p.read.length > 0 && n === p.read.length) out.books++;
    }
  } catch (e) {}
  return out;
}
function defiStats() {
  const out = { defis: 0, bestSerie: 0, bestScore: null, bestScoreLabel: 'Meilleur score' };
  try {
    const raw = localStorage.getItem('graine.defi.v1');
    if (!raw) return out;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return out;
    if (typeof s.defis === 'number') out.defis = s.defis;
    if (typeof s.meilleureSerie === 'number') out.bestSerie = s.meilleureSerie;
    if (typeof s.meilleurScore === 'number') out.bestScore = String(s.meilleurScore);
    else if (s.jour && typeof s.jour.score === 'number' && typeof s.jour.total === 'number') {
      out.bestScore = s.jour.score + '/' + s.jour.total; // à défaut de record : dernier défi du jour
      out.bestScoreLabel = 'Dernier défi du jour';
    }
  } catch (e) {}
  return out;
}

/* ============================================================================
   Construction des exercices interactifs
   ========================================================================== */
function buildExercise(card) {
  const words = card.text.split(/\s+/);
  if (words.length <= SCRAMBLE_MAX) {
    return { type: 'scramble', words, shuffled: shuffle(words.map((_, i) => i)), answer: [], errors: 0, hinted: false, showHint: false, wrong: false };
  }
  // Mots à trous : on masque une part croissante des mots « pleins ».
  const content = words.map((w, i) => i).filter(i => words[i].replace(/[^\p{L}]/gu, '').length > 3);
  const ratio = Math.min(0.75, 0.45 + 0.15 * card.validations);
  const blanks = shuffle(content).slice(0, Math.max(2, Math.round(content.length * ratio))).sort((a, b) => a - b);
  const pool = shuffle(blanks.map((i, k) => ({ id: k, w: words[i] })));
  return { type: 'fill', words, blanks, pool, filled: blanks.map(() => null), errors: 0, hinted: false, showHint: false, wrong: false };
}
function exComplete(ex) {
  return ex.type === 'scramble' ? ex.answer.length === ex.words.length : ex.filled.every(x => x !== null);
}
function exCorrect(ex) {
  if (ex.type === 'scramble') return norm(ex.answer.map(i => ex.words[i]).join(' ')) === norm(ex.words.join(' '));
  return ex.blanks.every((wi, k) => {
    const item = ex.pool.find(p => p.id === ex.filled[k]);
    return item && norm(item.w) === norm(ex.words[wi]);
  });
}

/* ============================================================================
   Navigation & session
   ========================================================================== */
let route = { name: 'home', param: null };
let session = null; // { queue, idx, intro?, phase:'exercise'|'result', ex, result, done:[], mastered:[] }
let studyList = []; // versets présentés sur la page d'étude en cours (avant le quiz d'introduction)
const go = (name, param) => { route = { name, param: param || null }; render(); window.scrollTo(0, 0); };

function render() {
  const v = { home: viewHome, memo: viewMemo, study: viewStudy, session: viewSession, moi: viewMoi, garden: viewGarden, verse: () => viewVerse(route.param), about: viewAbout, collections: viewCollections, account: viewAccount }[route.name] || viewHome;
  el.innerHTML = v() + tabbar();
  wire();
}
function topbar(withAccount) {
  const s = store.streak.count;
  const flame = s > 0 ? `<span class="streak">🔥 ${s} jour${s > 1 ? 's' : ''}</span>` : '';
  // Sur l'accueil : l'entrée compte est visible d'emblée, en haut à droite.
  let account = '';
  if (withAccount) {
    const u = window.GraineAPI ? GraineAPI.user() : null;
    account = u
      ? `<button class="acc-chip" data-accchip="1" title="Mon compte">☁️ ${esc(u.pseudo)}</button>`
      : `<button class="acc-chip connect" data-accchip="1">Se connecter</button>`;
  }
  return `<div class="topbar"><div class="brand"><img class="logo" src="icon.svg" alt="" />
    <span class="app-title">Bible <span class="seed">Horizon</span></span></div>
    <span class="top-right">${flame}${account}</span></div>`;
}
function tabbar() {
  if (route.name === 'session') return '';
  // L'écran « Mémoriser » (et ses sous-écrans) reste rattaché à l'onglet Accueil ;
  // le jardin et ses versets restent rattachés à l'onglet Moi.
  const cur = ['memo', 'study', 'collections'].includes(route.name) ? 'home'
    : ['garden', 'verse', 'account'].includes(route.name) ? 'moi' : route.name;
  const tab = (n, ic, l) => `<button data-tab="${n}" class="${cur === n ? 'active' : ''}"><span class="ic">${ic}</span>${l}</button>`;
  return `<nav class="tabbar">${tab('home', '🏠', 'Accueil')}${tab('moi', '👤', 'Moi')}${tab('about', '☖', 'À propos')}</nav>`;
}

/* ---------- Accueil : hub des trois modules ---------- */
function viewHome() {
  const due = dueCards();

  const hero = `<div class="card hero compact fade"><div class="hero-emblem"><img src="icon.svg" alt="" /></div>
    <h1 class="hero-name">Bible <span class="seed">Horizon</span></h1>
    <p class="hero-tag">Fais grandir la Parole dans ton cœur, un peu chaque jour.</p></div>`;

  // Sous-titre dynamique du module Semer : la métaphore du jardin, explicite.
  let memoSub;
  if (due.length > 0) memoSub = `${due.length} verset${due.length > 1 ? 's' : ''} à arroser aujourd'hui`;
  else if (nextToLearn()) memoSub = `Apprends un verset par cœur, il grandira dans ton jardin`;
  else memoSub = `Ton jardin se repose — reviens demain`;

  const hub = `
    <button class="card hub-card fade" data-tab="memo">
      <span class="hub-ic">🌱</span>
      <span class="hub-txt"><span class="hub-title">Semer</span>
        <span class="hub-sub">${memoSub}</span></span>
      <span class="chev">›</span></button>
    <a class="card hub-card fade" href="lire/">
      <span class="hub-ic">📖</span>
      <span class="hub-txt"><span class="hub-title">Marcher</span>
        <span class="hub-sub">Suis ton plan de lecture de la Bible, à ton rythme</span></span>
      <span class="chev">›</span></a>
    <a class="card hub-card fade" href="defi/">
      <span class="hub-ic">🕯️</span>
      <span class="hub-txt"><span class="hub-title">Sonder</span>
        <span class="hub-sub">Des questions pour tester ta connaissance de la Bible, seul ou entre amis</span></span>
      <span class="chev">›</span></a>`;

  return topbar(true) + hero + hub;
}

/* ---------- Mémoriser : session du jour, apprendre, objectif, jardin ---------- */
function viewMemo() {
  const due = dueCards(), gardenN = masteredCards().length, learnN = learningCards().length, total = Object.keys(store.cards).length;
  const obj = activeColl();

  const head = `<button class="back-link" data-tab="home">‹ Accueil</button>
    <h2 style="font-family:var(--serif);margin-bottom:2px">🌱 Semer</h2>
    <p class="muted" style="margin:0 2px 16px">Sème un verset dans ton cœur, arrose-le en le révisant — quand tu le sais par cœur, il s'enracine dans ton jardin.</p>`;

  // Carte « objectif » (ou invitation discrète), construite ici pour servir
  // aussi bien l'écran vierge que l'écran normal.
  let objectiveCard = '';
  if (obj) {
    const { m, total: ct } = collProgress(obj);
    const pct = ct ? Math.round(m / ct * 100) : 0;
    objectiveCard = `<div class="card objective fade"><div class="obj-head">
        <b>🎯 Objectif : ${esc(obj.name)}</b>
        <button class="linkbtn" data-collections="1">Changer</button></div>
      <div class="coll-meter"><span class="gauge"><i style="width:${pct}%"></i></span>
        <span class="coll-count">${m}/${ct} mémorisé${m > 1 ? 's' : ''}</span></div></div>`;
  }

  if (total === 0) {
    return topbar() + head + `
      <div class="steps fade">
        <div class="step"><span class="si">📖</span><div><b>L'appli te propose quelques versets à étudier.</b><br><span class="muted">Tu n'as pas à choisir.</span></div></div>
        <div class="step"><span class="si">✍️</span><div><b>Tu les reconstitues sur l'écran, de mémoire</b> — l'appli vérifie que c'est juste.</div></div>
        <div class="step"><span class="si">🌱</span><div><b>Réussi plusieurs fois</b>, chaque verset rejoint ton jardin — et revient avant que tu l'oublies.</div></div>
      </div>
      ${objectiveCard}
      <button class="btn btn-primary" data-learn="1">Semer mes premiers versets</button>
      ${obj ? '' : `<button class="linkbtn center" data-collections="1" style="display:block;margin:12px auto 0">🎯 Choisir un objectif (facultatif)</button>`}`;
  }
  let actions = '';
  if (due.length > 0) {
    actions += `<div class="card action fade"><div class="action-txt"><b>Arroser mes versets</b>
      <span class="muted">${due.length} verset${due.length > 1 ? 's' : ''} à revoir pour bien ${due.length > 1 ? 'les' : 'l\''} enraciner.</span></div>
      <button class="btn btn-primary" data-review="1">Commencer</button></div>`;
  }
  if (nextToLearn()) {
    actions += `<div class="card action fade"><div class="action-txt"><b>Semer de nouveaux versets</b>
      <span class="muted">${obj ? `Les versets de « ${esc(obj.name)} » qui restent à découvrir.` : `L'appli t'en propose quelques-uns.`}</span></div>
      <button class="btn btn-grow" data-learn="1">Semer</button></div>`;
  } else if (obj) {
    actions += `<p class="muted center fade" style="margin:6px 4px 10px">Tous les versets de « ${esc(obj.name)} » sont en route — continue tes sessions 🌱</p>`;
  } else if (due.length === 0) {
    actions += `<div class="card fade"><p class="center" style="margin:0">🎉 Tu as mémorisé tous les versets proposés !</p></div>`;
  }
  if (due.length === 0) actions += `<p class="muted center" style="margin:6px 4px 0">Rien à arroser aujourd'hui — ton jardin pousse tout seul 🌱</p>`;

  // Objectif (collection choisie) — ou invitation discrète à en choisir un.
  const objective = objectiveCard || `<button class="verse-item objective-link fade" data-collections="1">
      <span class="stage">🎯</span><span class="vi-main"><span class="vi-ref">Choisir un objectif</span><br>
      <span class="vi-text">Facultatif — une collection de versets par thème ou par livre.</span></span><span class="chev">›</span></button>`;

  let progress = '';
  if (learnN > 0) progress += `<button class="verse-item fade" data-review="1">
      <span class="stage">🌱</span><span class="vi-main"><span class="vi-ref">En apprentissage</span><br>
      <span class="vi-text">${learnN} verset${learnN > 1 ? 's' : ''} en cours de mémorisation</span></span><span class="chev">›</span></button>`;
  progress += `<button class="verse-item gardenlink fade" data-tab="garden">
      <span class="stage">🌳</span><span class="vi-main"><span class="vi-ref">Mon jardin</span><br>
      <span class="vi-text">${gardenN} verset${gardenN > 1 ? 's' : ''} mémorisé${gardenN > 1 ? 's' : ''}</span></span><span class="chev">›</span></button>`;

  return topbar() + head + actions + objective + progress;
}

/* ---------- Collections : choisir un objectif ---------- */
function viewCollections() {
  const renderItem = c => {
    const { m, total } = collProgress(c);
    const complete = total > 0 && m >= total;
    const active = store.activeCollection === c.id;
    const pct = total ? Math.round(m / total * 100) : 0;
    return `<button class="verse-item coll-item${complete ? ' complete' : ''}" data-selectcoll="${esc(c.id)}">
      <span class="stage">${complete ? '🏅' : c.emoji || '📖'}</span>
      <span class="vi-main">
        <span class="vi-ref">${esc(c.name)}</span>
        ${active ? '<span class="mini-badge">objectif actif</span>' : ''}
        ${complete ? '<span class="mini-badge gold">complète ✨</span>' : ''}<br>
        ${c.desc ? `<span class="vi-text">${esc(c.desc)}</span>` : ''}
        <span class="coll-meter"><span class="gauge"><i style="width:${pct}%"></i></span>
          <span class="coll-count">${m}/${total} mémorisé${m > 1 ? 's' : ''}</span></span>
      </span></button>`;
  };
  const themes = THEME_COLLECTIONS.map(renderItem).join('');
  const books = bookCollections().map(renderItem).join('');
  const clear = store.activeCollection
    ? `<button class="btn btn-ghost btn-block" data-clearcoll="1" style="margin-top:18px">Revenir au parcours général</button>`
    : '';
  return `<div class="fade"><button class="back-link" data-tab="memo">‹ Semer</button>
    <h2 style="font-family:var(--serif);margin-bottom:2px">Collections</h2>
    <p class="muted" style="margin:0 2px 16px">Choisis un objectif : le bouton « Apprendre » te servira alors les versets de cette collection. C'est facultatif — sans objectif, le parcours général continue.</p>
    <div class="section-title">Par thème</div>${themes || '<p class="muted">Aucune collection disponible.</p>'}
    <div class="section-title">Par livre</div>${books}
    ${clear}</div>`;
}
function selectCollection(id) {
  const c = collectionById(id);
  if (!c || isCollComplete(c)) return; // une collection complète ne redevient pas un objectif
  store.activeCollection = store.activeCollection === id ? null : id; // re-toucher = désélectionner
  saveStore();
  go('memo');
}

/* ---------- Apprentissage par série : page d'étude puis quiz d'introduction ---------- */
// Versets à introduire : ceux de la collection active pas encore travaillés
// (tous — une collection se découvre d'un bloc), sinon les 3 prochains du
// parcours général.
function versesToIntroduce() {
  const c = activeColl();
  if (c) return c.verses.filter(id => !store.cards[id]).map(id => LIBRARY.find(v => v.id === id)).filter(Boolean);
  return LIBRARY.filter(v => !store.cards[v.id]).slice(0, 3);
}
function startLearnNew() {
  studyList = versesToIntroduce();
  if (!studyList.length) { go('memo'); return; }
  go('study');
}
// « Je suis prêt » : le quiz porte sur les versets de la page d'étude, dans un
// ordre mélangé (différent de l'ordre de présentation). IMPORTANT : les cards
// ne sont PAS créées ici — un verset n'entre dans la répétition espacée qu'au
// moment de son premier exercice effectivement tenté (voir liveCard).
function startIntroQuiz() {
  if (!studyList.length) { go('memo'); return; }
  session = { intro: true, queue: shuffle(studyList), idx: 0, done: [], mastered: [], celebrated: [] };
  enterCard(); go('session');
}

/* ---------- Page d'étude ---------- */
function viewStudy() {
  if (!studyList.length) { go('memo'); return ''; }
  const obj = activeColl();
  const n = studyList.length;
  const items = studyList.map(v => `<div class="card study-verse fade">
      <div class="verse">« ${esc(v.text)} »</div>
      <div class="ref">${esc(v.ref)} <span class="version">· ${esc(LIB_VERSION)}</span></div>
      ${v.contexte ? `<div class="context-box">${esc(v.contexte)}</div>` : ''}
    </div>`).join('');
  return `<div class="fade"><button class="back-link" data-tab="memo">‹ Semer</button>
    <h2 style="font-family:var(--serif);margin-bottom:2px">Page d'étude</h2>
    <p class="muted" style="margin:0 2px 14px">${obj ? `Les versets de « ${esc(obj.name)} » — ${n} verset${n > 1 ? 's' : ''}.` : `Tes ${n} prochains versets du parcours.`}</p>
    <div class="study-note fade">Prends le temps de lire et de t'imprégner de ces versets. Quand tu te sens prêt, l'épreuve commence.</div>
    ${items}
    <button class="btn btn-primary" data-ready="1" style="margin-top:6px">Je suis prêt</button></div>`;
}

/* ---------- Session (introduction + entretien, tout vérifié par l'appli) ---------- */
function enterCard() {
  // Plus d'étape de lecture : l'introduction passe par la page d'étude, les
  // révisions se font de mémoire — l'exercice commence directement.
  const item = session.queue[session.idx];
  const known = store.cards[item.id];
  session.phase = 'exercise';
  session.ex = buildExercise({ text: item.text, validations: known ? known.validations : 0 });
  session.result = null;
}
// La card sur laquelle on enregistre le résultat. En quiz d'introduction, elle
// n'est créée qu'ici, au premier essai réel — quitter avant ne laisse rien.
function liveCard() {
  const item = session.queue[session.idx];
  if (session.intro) return store.cards[item.id] || introduce(item);
  return item;
}
function startReview() {
  const due = dueCards().sort((a, b) => a.due - b.due);
  if (!due.length) { go('memo'); return; }
  session = { queue: due, idx: 0, done: [], mastered: [], celebrated: [] };
  enterCard(); go('session');
}

function viewSession() {
  if (!session) { go('home'); return ''; }
  if (session.idx >= session.queue.length) return viewSessionDone();
  // En quiz d'introduction, la card peut ne pas exister encore (aucun essai) :
  // on affiche alors le verset de la bibliothèque avec une progression à 0.
  const item = session.queue[session.idx];
  const card = (session.intro ? store.cards[item.id] : item) || item;
  const validations = card.validations || 0;
  const ex = session.ex;
  const dots = session.queue.map((_, i) => `<span class="${i < session.idx ? 'done' : i === session.idx ? 'current' : ''}"></span>`).join('');
  const badge = validations >= MASTERY ? 'Entretien' : `Apprentissage · ${validations}/${MASTERY}`;

  let body = '';
  if (session.phase === 'result') {
    const ok = session.result === 'success';
    body = `<div class="exresult ${ok ? 'ok' : 'ko'} fade">
        <div class="exres-icon">${ok ? '✅' : '💐'}</div>
        <div class="exres-title">${ok ? (ex.hinted ? 'Juste ! (avec un coup d\'œil)' : 'Juste, de mémoire !') : 'Pas grave — on le reverra'}</div>
      </div>
      <div class="verse small" style="margin-top:8px">« ${esc(card.text)} »</div>
      <div class="ref">${esc(card.ref)}</div>
      ${ok && isMastered(card) && session.mastered.includes(card.id) ? '<p class="center" style="color:var(--grow);font-weight:650;margin-top:12px">🌱 Planté dans ton jardin !</p>' : ''}
      <button class="btn btn-grow btn-block" data-snext="1" style="margin-top:16px">Continuer</button>`;
  } else { // exercise
    const label = ex.type === 'scramble' ? 'Remets les mots dans l\'ordre' : 'Complète les mots manquants';
    body = `<div class="ex-instr">${label}</div>` +
      (ex.showHint ? `<div class="hint-reveal fade">« ${esc(card.text)} »</div>` : '') +
      (ex.type === 'scramble' ? renderScramble(ex) : renderFill(ex)) +
      (ex.wrong ? `<p class="ex-wrong fade">Pas tout à fait — corrige les mots en rouge, puis revérifie.</p>` : '') +
      `<button class="btn btn-primary" data-check="1" ${exComplete(ex) ? '' : 'disabled'} style="margin-top:14px">Vérifier</button>
       <div class="ex-tools">
         <button class="linkbtn" data-hint="1">👁 Revoir le verset</button>
         <button class="linkbtn" data-giveup="1">Voir la réponse</button>
       </div>`;
  }

  return `<div class="fade">
    <button class="back-link" data-tab="memo">✕ Quitter</button>
    <div class="progress-dots">${dots}</div>
    <div class="exercise-label">${badge} · verset ${session.idx + 1} / ${session.queue.length}</div>
    <div class="card">${body}</div>
  </div>`;
}

function renderScramble(ex) {
  const used = new Set(ex.answer);
  const answer = ex.answer.map((wi, pos) => {
    // Après une vérification ratée, on marque en rouge les mots mal placés.
    const wrongClass = ex.wrong && norm(ex.words[wi]) !== norm(ex.words[pos]) ? ' wrong' : '';
    return `<button class="chip placed${wrongClass}" data-unpick="${pos}">${esc(ex.words[wi])}</button>`;
  }).join('');
  const pool = ex.shuffled.filter(i => !used.has(i)).map(i => `<button class="chip" data-pick="${i}">${esc(ex.words[i])}</button>`).join('');
  return `<div class="answer-line" id="answer">${answer || '<span class="ph">Touche les mots ci-dessous…</span>'}</div>
    <div class="pool" id="pool">${pool}</div>`;
}
function renderFill(ex) {
  const placed = new Set(ex.filled.filter(x => x !== null));
  let k = -1;
  const verse = ex.words.map((w, i) => {
    if (!ex.blanks.includes(i)) return esc(w);
    k++; const kk = k;
    const pid = ex.filled[kk];
    if (pid === null) return `<span class="slot empty">____</span>`;
    const item = ex.pool.find(p => p.id === pid);
    const wrongClass = ex.wrong && norm(item.w) !== norm(w) ? ' wrong' : '';
    return `<button class="slot filled${wrongClass}" data-clear="${kk}">${esc(item.w)}</button>`;
  }).join(' ');
  const pool = ex.pool.filter(p => !placed.has(p.id)).map(p => `<button class="chip" data-fillword="${p.id}">${esc(p.w)}</button>`).join('');
  return `<div class="cloze fillverse">${verse}</div><div class="pool" id="pool" style="margin-top:16px">${pool}</div>`;
}

function viewSessionDone() {
  updateStreak();
  scheduleSync(); // la progression du jour part vers le serveur (débouncé, silencieux)
  const s = store.streak.count;
  const done = session ? session.done.length : 0;
  const mastered = session ? session.mastered.length : 0;
  const celebrated = session ? session.celebrated : [];
  session = null;

  // Célébration sobre : une collection vient d'être complétée.
  if (celebrated.length > 0) {
    const c = celebrated[0];
    const n = c.verses.length;
    const others = celebrated.slice(1).map(x => `« ${esc(x.name)} »`).join(' et ');
    return `<div class="done-screen fade">
      <div class="seal">✨</div>
      <h2 style="font-family:var(--serif);margin:10px 0">Collection ${esc(c.name)} complète ✨</h2>
      <p class="muted">${n} verset${n > 1 ? 's' : ''} caché${n > 1 ? 's' : ''} dans ton cœur.</p>
      ${others ? `<p class="muted">Et par la même occasion : ${others} 🏅</p>` : ''}
      <p class="muted" style="margin-top:14px">Si tu le souhaites, tu peux choisir une autre collection — ou simplement continuer le parcours général.</p>
      <button class="btn btn-primary" data-collections="1" style="margin-top:16px">Choisir une autre collection</button>
      <button class="btn btn-ghost btn-block" data-tab="home" style="margin-top:10px">Revenir à l'accueil</button>
    </div>`;
  }

  return `<div class="done-screen fade">
    <div class="seal">${mastered > 0 ? '🌱' : '🌿'}</div>
    <h2 style="font-family:var(--serif);margin:10px 0">C'est fait pour aujourd'hui</h2>
    <p class="muted">${done} verset${done > 1 ? 's' : ''} travaillé${done > 1 ? 's' : ''}${mastered > 0 ? ` · ${mastered} planté${mastered > 1 ? 's' : ''} 🌱` : ''} · série de ${s} jour${s > 1 ? 's' : ''} 🔥</p>
    <button class="btn btn-primary" data-tab="home" style="margin-top:20px">Revenir à l'accueil</button>
    <p class="muted" style="margin-top:14px">Repose-toi — trop en faire aujourd'hui n'aide pas. À demain 🙂</p>
  </div>`;
}

/* ---------- Moi : espace personnel (stats locales, jardin, compte & amis) ---------- */
function viewMoi() {
  const user = window.GraineAPI ? GraineAPI.user() : null;
  const gardenN = masteredCards().length, learnN = learningCards().length;
  const completedN = store.completedCollections.length;
  const streakN = store.streak.count || 0, bestN = store.bestStreak || 0, daysN = store.activeDays || 0;
  const lire = lireStats(), defi = defiStats();
  const tile = (n, l) => `<div class="stat-tile"><div class="st-n">${n}</div><div class="st-l">${l}</div></div>`;

  const head = `<div class="card me-head fade"><div class="me-emoji">🌱</div>
    <h2>Bienvenue chez toi</h2>
    <p class="muted">${user
      ? `Ton chemin avec la Parole, en un coup d'œil — sauvegardé sur ton compte.`
      : `Ton chemin avec la Parole, en un coup d'œil. Tout reste sur ton appareil.`}</p></div>`;

  const account = user ? moiAccountCard(user) : moiInviteCard();

  // Apparence : quatre pastilles, le choix s'applique immédiatement.
  const theme = themeChoice();
  const tpill = (v, l) => `<button class="pill ${theme === v ? 'on' : ''}" data-theme-pick="${v}">${l}</button>`;
  const apparence = `<div class="section-title">🎨 Apparence</div>
    <div class="card fade">
      <div class="pill-row">${tpill('auto', 'Auto')}${tpill('clair', '☀️ Clair')}${tpill('sombre', '🌙 Sombre')}${tpill('sepia', '📜 Sépia')}</div>
      <p class="muted" style="font-size:.85rem;margin:12px 2px 0">« Auto » suit le réglage clair/sombre de ton appareil. Ton choix vaut pour toute l'appli.</p>
    </div>`;

  const memo = `<div class="section-title">🧠 Mémorisation</div>
    <div class="stat-grid fade">
      ${tile(gardenN, `verset${gardenN > 1 ? 's' : ''} mémorisé${gardenN > 1 ? 's' : ''}`)}
      ${tile(learnN, 'en apprentissage')}
      ${tile(streakN + ' 🔥', 'série actuelle (jours)')}
      ${tile(bestN, 'plus longue série')}
      <div class="stat-tile wide"><div class="st-n">${completedN}</div>
        <div class="st-l">collection${completedN > 1 ? 's' : ''} complétée${completedN > 1 ? 's' : ''}</div></div>
    </div>`;

  const assiduite = `<div class="section-title">📆 Assiduité</div>
    <div class="stat-grid fade">
      <div class="stat-tile wide"><div class="st-n">${daysN}</div>
        <div class="st-l">jour${daysN > 1 ? 's' : ''} d'activité en tout</div></div>
    </div>`;

  const lireSec = `<div class="section-title">📖 Lecture</div>
    <div class="stat-grid fade">
      ${tile(lire.chapters, `chapitre${lire.chapters > 1 ? 's' : ''} lu${lire.chapters > 1 ? 's' : ''}`)}
      ${tile(lire.books, `livre${lire.books > 1 ? 's' : ''} terminé${lire.books > 1 ? 's' : ''}`)}
    </div>
    ${lire.chapters === 0 ? `<p class="muted me-note">Pas encore commencé — le module Lire t'attend, à ton rythme.</p>` : ''}`;

  const defiSec = `<div class="section-title">🕯️ Défi</div>
    <div class="stat-grid fade">
      ${tile(defi.defis, `défi${defi.defis > 1 ? 's' : ''} relevé${defi.defis > 1 ? 's' : ''}`)}
      ${tile(defi.bestScore === null ? '—' : defi.bestScore, defi.bestScoreLabel.toLowerCase())}
      ${tile(defi.bestSerie, 'meilleure série de bonnes réponses')}
    </div>
    ${defi.defis === 0 ? `<p class="muted me-note">Pas encore commencé — relève ton premier défi quand tu veux.</p>` : ''}`;

  const friends = user ? moiFriendsSection(user) : '';

  // Petite carte discrète vers l'espace d'administration — seulement pour
  // les comptes dont l'e-mail figure dans ADMIN_EMAILS (champ isAdmin du
  // payload utilisateur ; le serveur revérifie de toute façon à chaque route).
  const admin = user && user.isAdmin ? `<a class="card hub-card fade" href="admin/" style="margin-top:14px">
      <span class="hub-ic">🔧</span>
      <span class="hub-txt"><span class="hub-title">Administration</span>
        <span class="hub-sub">Comptes et banque de questions du Défi</span></span>
      <span class="chev">›</span></a>` : '';

  return topbar() + head + account + apparence + memo + assiduite + lireSec + defiSec + friends + admin;
}

/* ---------- Jardin (versets mémorisés) ---------- */
let gardenView = 'list'; // 'list' | 'coll' — préférence d'affichage, non persistée
function gardenItem(c) {
  const st = stageOf(c), badge = c.due <= todayNum() ? '<span class="badge-due">à revoir</span>' : '';
  return `<button class="verse-item" data-verse="${esc(c.id)}"><span class="stage" title="${st.label}">${st.icon}</span>
    <span class="vi-main"><span class="vi-ref">${esc(c.ref)}</span><br><span class="vi-text">${esc(c.text)}</span></span>${badge}</button>`;
}
function viewGarden() {
  const cards = masteredCards().sort((a, b) => a.due - b.due);
  const completed = allCollections().filter(isCollComplete);

  let toggle = '';
  if (cards.length > 0 && completed.length > 0) {
    toggle = `<div class="pill-row" style="margin-bottom:12px">
      <button class="pill ${gardenView === 'list' ? 'on' : ''}" data-gview="list">Liste</button>
      <button class="pill ${gardenView === 'coll' ? 'on' : ''}" data-gview="coll">Par collection</button></div>`;
  }

  let list;
  if (!cards.length) {
    list = `<div class="card center"><p style="margin:0">Ton jardin est encore vide 🌱<br>
      <span class="muted">Mémorise un verset et il apparaîtra ici.</span></p>
      <button class="btn btn-grow btn-block" data-learn="1" style="margin-top:14px">Apprendre un verset</button></div>`;
  } else if (gardenView === 'coll' && completed.length > 0) {
    // Groupé par collection complétée ; chaque verset n'apparaît qu'une fois.
    const seen = new Set();
    list = completed.map(col => {
      const own = cards.filter(c => col.verses.includes(c.id) && !seen.has(c.id));
      own.forEach(c => seen.add(c.id));
      if (!own.length) return '';
      return `<div class="section-title">🏅 ${esc(col.name)}</div>` + own.map(gardenItem).join('');
    }).join('');
    const rest = cards.filter(c => !seen.has(c.id));
    if (rest.length) list += `<div class="section-title">Autres versets</div>` + rest.map(gardenItem).join('');
  } else {
    list = cards.map(gardenItem).join('');
  }
  const learn = learningCards();
  const learnList = learn.length ? `<div class="section-title">En apprentissage</div>` + learn.map(c =>
    `<div class="verse-item"><span class="stage">🌰</span><span class="vi-main"><span class="vi-ref">${esc(c.ref)}</span><br>
      <span class="vi-text">${c.validations}/${MASTERY} réussites · ${esc(c.text)}</span></span></div>`).join('') : '';

  return topbar() + `<button class="back-link" data-tab="moi">‹ Moi</button>
    <h2 style="font-family:var(--serif);margin-bottom:2px">Mon jardin</h2>
    <p class="muted" style="margin:0 2px 16px">Les versets que tu as mémorisés. Chacun grandit à mesure qu'il s'enracine.</p>
    ${toggle}${list}${learnList}`;
}
function viewVerse(id) {
  const c = store.cards[id]; if (!c) { go('garden'); return ''; }
  const st = stageOf(c), book = bookOf(c.ref), ctx = BOOKS[book], days = c.due - todayNum();
  // Contexte propre au verset (champ "contexte" de verses.json, s'il existe).
  const lib = LIBRARY.find(v => v.id === id);
  const vctx = lib && lib.contexte ? `<div class="context-box">${esc(lib.contexte)}</div>` : '';
  const when = days <= 0 ? 'À revoir aujourd\'hui' : days === 1 ? 'Prochaine révision : demain' : `Prochaine révision : dans ${days} jours`;
  return `<div class="fade"><button class="back-link" data-tab="garden">‹ Mon jardin</button>
    <div class="card hero"><div class="verse">« ${esc(c.text)} »</div>
      <div class="ref">${esc(c.ref)} <span class="version">· ${esc(LIB_VERSION)}</span></div></div>
    <div class="card"><div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:1.8rem">${st.icon}</span>
        <div><b>${st.label}</b><br><span class="muted" style="font-size:.9rem">${when}</span></div></div>
      ${vctx}
      ${ctx ? `<div class="context-box"><b>Contexte — ${esc(book)}.</b> ${esc(ctx)}</div>` : ''}</div>
    <button class="btn btn-ghost btn-block" data-remove="${esc(id)}" style="color:var(--danger);border-color:var(--danger)">Retirer de mon jardin</button></div>`;
}
function viewAbout() {
  return topbar() + `<h2 style="font-family:var(--serif)">À propos</h2>
    <div class="card"><p><b>Bible Horizon</b> t'aide à faire grandir la Parole dans ton cœur, un peu chaque jour.</p>
      <p class="muted">Tu reconstitues chaque verset sur l'écran ; l'appli vérifie. Réussi plusieurs fois sur plusieurs jours, il rejoint ton jardin, puis revient juste avant que tu l'oublies.</p></div>
    <div class="section-title">Nos principes</div>
    <div class="card">
      <p>🕊️ <b>Gratuit, pour toujours.</b> Aucune fonction payante, aucune publicité.</p>
      <p>🔒 <b>Vie privée d'abord.</b> Tout fonctionne hors-ligne, sans compte. Le compte est facultatif (e-mail + pseudo, rien d'autre) et se supprime en un geste.</p>
      <p>🌱 <b>Encourager, pas culpabiliser.</b> Pas de « retard », pas de reproche.</p>
      <p>📖 <b>Respect du texte.</b> Versets ${esc(LIB_VERSION)} (domaine public).</p></div>
    <p class="muted center" style="margin-top:20px">« La semence, c'est la parole de Dieu. » — Luc 8.11</p>
    <p class="muted center" style="font-size:.8rem;margin-top:10px">Version 0.3 · projet en construction</p>`;
}

/* ============================================================================
   Compte, synchronisation & amis — serveur FACULTATIF (voir API-CONTRAT.md).
   Le local reste la base : sans compte ou hors-ligne, rien ne change.
   ========================================================================== */
const LIRE_KEY = 'graine.lire.v1', DEFI_KEY = 'graine.defi.v1';
const SYNC_META_KEY = 'graine.sync.meta';

/* ---------- Fusion PURE des stores (testable : window.GraineSync) ----------
   Règle d'or : ne JAMAIS perdre de progression. En cas de doute, on garde le
   meilleur des deux côtés (max) et la révision la plus proche (min due). */
const deepCopy = o => (o === null || o === undefined) ? null : JSON.parse(JSON.stringify(o));
const isNum = v => typeof v === 'number' && isFinite(v);
function maxN(a, b) { if (!isNum(a)) return isNum(b) ? b : undefined; if (!isNum(b)) return a; return Math.max(a, b); }
function minN(a, b) { if (!isNum(a)) return isNum(b) ? b : undefined; if (!isNum(b)) return a; return Math.min(a, b); }
const setIf = (obj, key, v) => { if (v !== undefined) obj[key] = v; };

// memo (graine.v3) — union des cards ; par card commune : max(validations),
// max(attempts), min(due) (le plus prudent : elle revient plus tôt),
// max(lapses/ease/interval) ; streak/bestStreak/activeDays = max ;
// union des collections complétées ; objectif local prioritaire.
function mergeMemo(local, server) {
  if (!server || typeof server !== 'object') return deepCopy(local);
  if (!local || typeof local !== 'object') return deepCopy(server);
  const out = deepCopy(local), srv = deepCopy(server);
  out.cards = out.cards && typeof out.cards === 'object' ? out.cards : {};
  const sCards = srv.cards && typeof srv.cards === 'object' ? srv.cards : {};
  for (const id of Object.keys(sCards)) {
    const sc = sCards[id], lc = out.cards[id];
    if (!lc || typeof lc !== 'object') { out.cards[id] = sc; continue; }
    lc.validations = maxN(lc.validations, sc.validations) || 0;
    lc.attempts = maxN(lc.attempts, sc.attempts) || 0;
    setIf(lc, 'due', minN(lc.due, sc.due));
    setIf(lc, 'lapses', maxN(lc.lapses, sc.lapses));
    setIf(lc, 'ease', maxN(lc.ease, sc.ease));
    setIf(lc, 'interval', maxN(lc.interval, sc.interval));
    setIf(lc, 'addedDay', minN(lc.addedDay, sc.addedDay));
  }
  const ls = out.streak && typeof out.streak === 'object' ? out.streak : {};
  const ss = srv.streak && typeof srv.streak === 'object' ? srv.streak : {};
  out.streak = { count: maxN(ls.count, ss.count) || 0 };
  const lastDay = maxN(ls.lastDay, ss.lastDay);
  out.streak.lastDay = lastDay === undefined ? null : lastDay;
  out.bestStreak = maxN(out.bestStreak, srv.bestStreak) || 0;
  out.activeDays = maxN(out.activeDays, srv.activeDays) || 0;
  const adl = maxN(out.activeDayLast, srv.activeDayLast);
  if (adl !== undefined) out.activeDayLast = adl;
  const lcc = Array.isArray(out.completedCollections) ? out.completedCollections : [];
  const scc = Array.isArray(srv.completedCollections) ? srv.completedCollections : [];
  out.completedCollections = Array.from(new Set(lcc.concat(scc)));
  out.activeCollection = out.activeCollection || srv.activeCollection || null;
  return out;
}

// lire (graine.lire.v1) — le module écrit un format v2 (voir lire/lire.js) :
// { v:2, active:<planId>|null, books:{ <livre>:{ read:[bool…] } },
//   plans:[ { id, nom, objectif, seq:[livre…], minutes } ] }.
// Fusion : chaque côté passe d'abord par la même migration douce que lire.js
// (un blob resté à l'ancien format ne corrompt rien), puis OR case par case
// des tableaux `read` de chaque livre, union des chemins par IDENTITÉ
// (objectif + séquence de livres — les ids sont propres à chaque appareil),
// max 3 chemins avec priorité aux locaux, chemin actif local prioritaire.
const LIRE_MAX_PLANS = 3;
// L'ancien module ne proposait que Marc et Jean : de quoi nommer un chemin
// migré depuis un blob v1 (lire.js, lui, a le catalogue complet).
const LIRE_NOMS_V1 = { marc: "L'Évangile de Marc", jean: "L'Évangile de Jean" };
const lireNormMinutes = m => (m === 10 ? 15 : m); // ancien rythme « 10 min » → 15

// Migration douce, PURE (copie) : v1 → v2, v2 → hygiène minimale (même esprit
// que migrate() de lire/lire.js). Renvoie null si le blob est inexploitable.
function lireMigrate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const b = deepCopy(raw);
  if (b.v === 2) {
    if (!b.books || typeof b.books !== 'object' || Array.isArray(b.books)) b.books = {};
    b.plans = Array.isArray(b.plans) ? b.plans.filter(p => p && typeof p === 'object') : [];
    b.plans.forEach(p => { p.minutes = lireNormMinutes(p.minutes); });
    if (typeof b.active !== 'string') b.active = null;
    return b;
  }
  // ---- ancien format : { active, minutes, plans: { <livre>: { read } } } ----
  const s = { v: 2, active: null, books: {}, plans: [] };
  const old = (b.plans && typeof b.plans === 'object' && !Array.isArray(b.plans)) ? b.plans : {};
  for (const id of Object.keys(old)) {
    if (old[id] && Array.isArray(old[id].read)) s.books[id] = { read: old[id].read.map(Boolean) };
  }
  if (typeof b.active === 'string' && b.active) {
    const plan = {
      id: 'pv1-' + b.active,
      nom: LIRE_NOMS_V1[b.active] || (b.active.charAt(0).toUpperCase() + b.active.slice(1)),
      objectif: null, seq: [b.active],
      minutes: isNum(b.minutes) ? lireNormMinutes(b.minutes) : null
    };
    s.plans.push(plan);
    s.active = plan.id;
  }
  return s;
}

function mergeLire(local, server) {
  const loc = lireMigrate(local), srv = lireMigrate(server); // déjà des copies
  if (!srv) return loc;
  if (!loc) return srv;
  const out = { v: 2, active: null, books: {}, plans: [] };
  // 1) Livres : OR case par case — un chapitre lu quelque part reste lu.
  for (const id of new Set(Object.keys(loc.books).concat(Object.keys(srv.books)))) {
    const lb = loc.books[id], sb = srv.books[id];
    const lr = (lb && Array.isArray(lb.read)) ? lb.read : [];
    const sr = (sb && Array.isArray(sb.read)) ? sb.read : [];
    const m = Object.assign({}, sb, lb); // champs éventuels : priorité locale
    m.read = Array.from({ length: Math.max(lr.length, sr.length) }, (_, i) => !!(lr[i] || sr[i]));
    out.books[id] = m;
  }
  // 2) Chemins : identité = objectif + séquence (les ids diffèrent par appareil).
  const sig = p => (p.objectif || '') + '|' + (Array.isArray(p.seq) ? p.seq.join(',') : '');
  const plans = loc.plans.map(p => Object.assign({}, p));
  for (const sp of srv.plans) {
    const twin = plans.find(p => sig(p) === sig(sp));
    if (twin) { // même chemin des deux côtés : on comble les trous locaux
      for (const k of Object.keys(sp)) if (twin[k] === undefined || twin[k] === null) twin[k] = sp[k];
    } else if (plans.length < LIRE_MAX_PLANS) {
      plans.push(Object.assign({}, sp));
    }
  }
  out.plans = plans;
  // 3) Chemin actif : le choix local d'abord ; sinon celui du serveur,
  //    retrouvé par identité (son id peut différer d'un appareil à l'autre).
  const srvActive = srv.plans.find(p => p.id === srv.active);
  if (loc.active && plans.some(p => p.id === loc.active)) out.active = loc.active;
  else if (srvActive) {
    const twin = plans.find(p => sig(p) === sig(srvActive));
    out.active = twin ? twin.id : null;
  }
  // 4) Autres champs éventuels : priorité locale, rien n'est perdu.
  for (const k of Object.keys(loc)) if (!(k in out)) out[k] = loc[k];
  for (const k of Object.keys(srv)) if (!(k in out)) out[k] = srv[k];
  return out;
}

// defi (graine.defi.v1) — max des compteurs (défis, séries, records) ;
// objets (cats, jour…) : max par clé numérique, sinon priorité locale.
function mergeDefi(local, server) {
  if (!server || typeof server !== 'object') return deepCopy(local);
  if (!local || typeof local !== 'object') return deepCopy(server);
  const out = deepCopy(local), srv = deepCopy(server);
  for (const k of Object.keys(srv)) {
    const sv = srv[k], lv = out[k];
    if (isNum(sv) && isNum(lv)) out[k] = Math.max(lv, sv);
    else if (sv && lv && typeof sv === 'object' && typeof lv === 'object' && !Array.isArray(sv) && !Array.isArray(lv)) {
      for (const kk of Object.keys(sv)) {
        if (isNum(sv[kk]) && isNum(lv[kk])) lv[kk] = Math.max(lv[kk], sv[kk]);
        else if (!(kk in lv)) lv[kk] = sv[kk];
      }
    } else if (lv === undefined) out[k] = sv;
    // sinon : priorité locale
  }
  return out;
}

/* ---------- Orchestration de la synchro (silencieuse, non bloquante) ---------- */
let syncUi = { status: 'idle', lastAt: null }; // idle|syncing|ok|offline|error
try { const r = localStorage.getItem(SYNC_META_KEY); if (r) syncUi.lastAt = JSON.parse(r).lastAt || null; } catch (e) {}
function saveSyncMeta() { try { localStorage.setItem(SYNC_META_KEY, JSON.stringify({ lastAt: syncUi.lastAt })); } catch (e) {} }
function readLocalBlob(key) { try { const r = localStorage.getItem(key); if (r) return JSON.parse(r); } catch (e) {} return null; }

let syncTimer = null, syncRunning = false;
// « planifier une synchro dans 3 s » — débouncé, appelé aux moments de
// progression majeure (fin de session, célébration). Sans compte : no-op.
function scheduleSync(delay) {
  if (!window.GraineAPI || !GraineAPI.isLoggedIn()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncNow(); }, delay || 3000);
}

async function syncNow() {
  if (!window.GraineAPI || !GraineAPI.isLoggedIn() || syncRunning) return;
  syncRunning = true;
  syncUi.status = 'syncing';
  renderIfIdle();
  try {
    // 1) pull : l'état du serveur…
    const remote = await GraineAPI.syncGet();
    // 2) …fusionné dans le local, sans jamais perdre de progression…
    const mergedMemo = mergeMemo(store, remote.memo);
    if (mergedMemo && !session) { store = normalizeStore(mergedMemo); saveStore(); }
    const mergedLire = mergeLire(readLocalBlob(LIRE_KEY), remote.lire);
    if (mergedLire) localStorage.setItem(LIRE_KEY, JSON.stringify(mergedLire));
    const mergedDefi = mergeDefi(readLocalBlob(DEFI_KEY), remote.defi);
    if (mergedDefi) localStorage.setItem(DEFI_KEY, JSON.stringify(mergedDefi));
    // 3) puis push du résultat fusionné.
    const blobs = {};
    if (!session) blobs.memo = store;
    if (mergedLire) blobs.lire = mergedLire;
    if (mergedDefi) blobs.defi = mergedDefi;
    if (Object.keys(blobs).length) await GraineAPI.syncPut(blobs);
    syncCompletedCollections(); // la fusion peut révéler des collections complètes
    syncUi.status = 'ok';
    syncUi.lastAt = new Date().toISOString();
    saveSyncMeta();
    if (friendsCache === 'error') friendsCache = null; // on est en ligne : on retentera la liste d'amis
  } catch (e) {
    // Hors-ligne ou erreur : AUCUN message intrusif — on réessaiera.
    syncUi.status = (e && e.offline) ? 'offline' : 'error';
  }
  syncRunning = false;
  renderIfIdle();
}
function syncStatusText() {
  if (syncUi.status === 'syncing') return 'Synchronisation…';
  if (syncUi.status === 'offline') return 'Hors-ligne — tes données restent ici, on réessaiera.';
  if (syncUi.status === 'error') return 'Synchro impossible pour l\'instant — on réessaiera.';
  if (syncUi.lastAt) {
    const mins = Math.round((Date.now() - new Date(syncUi.lastAt).getTime()) / 60000);
    if (mins < 1) return 'Synchronisé à l\'instant ✓';
    if (mins < 60) return `Synchronisé il y a ${mins} min ✓`;
    const h = Math.round(mins / 60);
    if (h < 24) return `Synchronisé il y a ${h} h ✓`;
    return 'Synchronisé le ' + new Date(syncUi.lastAt).toLocaleDateString('fr-FR') + ' ✓';
  }
  return 'Pas encore synchronisé.';
}
// Re-rendre sans gêner : seulement sur Moi / le parcours compte, et jamais
// pendant que l'utilisateur écrit dans un champ.
function renderIfIdle() {
  if (route.name !== 'moi' && route.name !== 'account') return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
  render();
}
// Fonctions de fusion exposées, pures et testables.
window.GraineSync = { mergeMemo, mergeLire, mergeDefi, syncNow, scheduleSync, status: () => Object.assign({}, syncUi) };

/* ---------- Parcours compte (écrans successifs, style de l'appli) ---------- */
let auth = null; // { step:'email'|'code'|'pseudo'|'welcome', email, code, pseudo, devCode, error, notice, busy }
let pseudoEdit = null;      // { value, error, busy } — édition du pseudo dans Moi
let accountNotice = null, accountError = null; // messages doux de la carte compte
let friendsCache = null;    // null = pas chargé | 'error' | [ { pseudo, friendCode, since } ]
let friendsLoading = false;
let friendField = '', friendError = null, friendNotice = null;

function friendlyError(e) {
  if (e && e.offline) return 'Pas de connexion — réessaie quand tu seras en ligne.';
  return (e && e.message) || 'Une erreur est survenue — réessaie.';
}

/* ---------- Connexion Google (facultative, si le serveur est configuré) ----- */
let publicConfig = null;        // { googleClientId } une fois chargée
let publicConfigAsked = false;
let gsiLoading = null;          // promesse de chargement du script Google

function loadPublicConfig() {
  if (publicConfigAsked || !window.GraineAPI) return;
  publicConfigAsked = true;
  GraineAPI.config().then(c => { publicConfig = c || null; renderIfIdle(); })
    .catch(() => { publicConfig = null; });
}
function ensureGsi() {
  if (window.google && window.google.accounts) return Promise.resolve();
  if (!gsiLoading) {
    gsiLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true;
      s.onload = resolve;
      s.onerror = () => { gsiLoading = null; reject(new Error('gsi')); };
      document.head.appendChild(s);
    });
  }
  return gsiLoading;
}
function mountGoogleButton() {
  if (!publicConfig || !publicConfig.googleClientId) return;
  ensureGsi().then(() => {
    const slot = document.getElementById('google-btn'); // re-vérifié après l'attente
    if (!slot || slot.childElementCount) return;
    google.accounts.id.initialize({
      client_id: publicConfig.googleClientId,
      callback: resp => onGoogleCredential(resp && resp.credential),
      ux_mode: 'popup'
    });
    google.accounts.id.renderButton(slot, {
      type: 'standard', theme: 'outline', size: 'large', shape: 'pill',
      text: 'continue_with', locale: 'fr', width: 280
    });
  }).catch(() => { /* hors-ligne : pas de bouton, le parcours e-mail reste là */ });
}
async function onGoogleCredential(credential) {
  if (!auth || auth.busy || !credential) return;
  auth.error = null; auth.busy = true; render();
  try { await GraineAPI.googleSignIn(credential); authSuccess(); }
  catch (e) {
    // Pseudo indérivable depuis le profil Google : on le demande, puis on
    // renvoie le MÊME jeton accompagné du pseudo choisi.
    if (e && e.data && e.data.needPseudo) { auth.step = 'pseudo'; auth.google = credential; }
    else auth.error = friendlyError(e);
  }
  auth.busy = false; render();
}

function startAccountFlow() {
  accountNotice = accountError = null;
  auth = { step: 'email', email: '', code: '', pseudo: '', devCode: null, google: null, error: null, notice: null, busy: false };
  loadPublicConfig();
  go('account');
}
function viewAccount() {
  if (!auth || !window.GraineAPI) { go('moi'); return ''; }
  const err = auth.error ? `<p class="field-error">${esc(auth.error)}</p>` : '';
  const busy = auth.busy ? 'disabled' : '';
  const back = `<button class="back-link" data-tab="moi">‹ Moi</button>`;
  if (auth.step === 'email') {
    return `<div class="fade">${back}
      <h2 style="font-family:var(--serif);margin-bottom:2px">☁️ Ton compte</h2>
      <p class="muted" style="margin:0 2px 14px">Gratuit et facultatif : sauvegarde ta progression, retrouve-la partout, défie tes amis. On te demande un e-mail et un pseudo — rien d'autre, jamais ton vrai nom.</p>
      <div class="card">
        <form data-authstep="email" novalidate>
          <label class="lbl" for="auth-email">Ton adresse e-mail</label>
          <input class="field" type="email" id="auth-email" inputmode="email" autocomplete="email" placeholder="toi@exemple.fr" value="${esc(auth.email)}">
          ${err}
          <button class="btn btn-primary" type="submit" ${busy} style="margin-top:14px">${auth.busy ? 'Envoi…' : 'Recevoir mon code'}</button>
        </form>
        <p class="muted" style="font-size:.85rem;margin:12px 2px 0">Pas de mot de passe : on t'envoie un code à 6 chiffres par e-mail, valable 10 minutes.</p>
      </div>
      ${publicConfig && publicConfig.googleClientId ? `
      <div class="or-sep"><span>ou</span></div>
      <div class="card" style="text-align:center">
        <div id="google-btn" style="display:flex;justify-content:center"></div>
        <p class="muted" style="font-size:.85rem;margin:10px 2px 0">En un geste avec ton compte Google — on ne reçoit que ton e-mail et ton prénom, rien d'autre.</p>
      </div>` : ''}</div>`;
  }
  if (auth.step === 'code') {
    return `<div class="fade">${back}
      <h2 style="font-family:var(--serif);margin-bottom:2px">📬 Ton code</h2>
      <p class="muted" style="margin:0 2px 14px">Un code à 6 chiffres a été envoyé à <b>${esc(auth.email)}</b>.</p>
      <div class="card">
        <form data-authstep="code">
          <label class="lbl" for="auth-code">Code reçu par e-mail</label>
          <input class="field code-field" type="text" id="auth-code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="••••••" value="${esc(auth.code)}">
          ${err}${auth.notice ? `<p class="field-ok">${esc(auth.notice)}</p>` : ''}
          <button class="btn btn-primary" type="submit" ${busy} style="margin-top:14px">${auth.busy ? 'Vérification…' : 'Valider'}</button>
        </form>
        ${auth.devCode ? `<p class="dev-code">mode test : code ${esc(auth.devCode)}</p>` : ''}
        <div class="ex-tools">
          <button class="linkbtn" data-authback="1">‹ Changer d'e-mail</button>
          <button class="linkbtn" data-authresend="1">Renvoyer un code</button>
        </div>
      </div></div>`;
  }
  if (auth.step === 'pseudo') {
    return `<div class="fade">${back}
      <h2 style="font-family:var(--serif);margin-bottom:2px">🌱 Ton pseudo</h2>
      <p class="muted" style="margin:0 2px 14px">Première connexion : choisis le nom que tes amis verront.</p>
      <div class="card">
        <form data-authstep="pseudo">
          <label class="lbl" for="auth-pseudo">Ton pseudo</label>
          <input class="field" type="text" id="auth-pseudo" maxlength="20" autocomplete="nickname" placeholder="ex. Semeur" value="${esc(auth.pseudo)}">
          <p class="muted" style="font-size:.85rem;margin:8px 2px 0">2 à 20 caractères. Un surnom suffit — jamais ton vrai nom si tu ne veux pas.</p>
          ${err}
          <button class="btn btn-primary" type="submit" ${busy} style="margin-top:14px">${auth.busy ? 'Création…' : 'C\'est mon pseudo'}</button>
        </form>
      </div></div>`;
  }
  // welcome — compte prêt, première synchro déjà lancée en arrière-plan.
  const u = GraineAPI.user() || {};
  return `<div class="done-screen fade">
    <div class="seal">🎉</div>
    <h2 style="font-family:var(--serif);margin:10px 0">Bienvenue, ${esc(u.pseudo || '')} !</h2>
    <p class="muted">Ton compte est prêt — ta progression se synchronise en arrière-plan.</p>
    <div class="friend-code-row" style="max-width:300px;margin:18px auto 0;text-align:left">
      <div><div class="fc-label">Ton code ami</div><div class="friend-code">${esc(u.friendCode || '')}</div></div>
      <button class="btn btn-soft" data-copycode="1">Copier</button></div>
    <p class="muted" style="font-size:.9rem;margin-top:12px">Partage-le en privé : c'est lui qui relie tes amis à toi.</p>
    <button class="btn btn-primary" data-authdone="1" style="margin-top:18px">C'est parti</button>
  </div>`;
}
async function authSubmit(step) {
  if (!auth || auth.busy) return;
  auth.notice = null;
  if (step === 'email') {
    const email = (auth.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { auth.error = 'Entre une adresse e-mail valide.'; render(); return; }
    auth.email = email; auth.error = null; auth.busy = true; render();
    try {
      const r = await GraineAPI.requestCode(email);
      auth.devCode = r && r.devCode ? String(r.devCode) : null;
      auth.step = 'code'; auth.code = '';
    } catch (e) { auth.error = friendlyError(e); }
    auth.busy = false; render();
  } else if (step === 'code') {
    const code = (auth.code || '').replace(/\D/g, '');
    if (code.length !== 6) { auth.error = 'Le code contient 6 chiffres.'; render(); return; }
    auth.code = code; auth.error = null; auth.busy = true; render();
    try { await GraineAPI.verify(auth.email, code); authSuccess(); }
    catch (e) {
      if (e && e.data && e.data.needPseudo) { auth.step = 'pseudo'; auth.error = null; }
      else auth.error = friendlyError(e);
    }
    auth.busy = false; render();
  } else if (step === 'pseudo') {
    const pseudo = (auth.pseudo || '').trim();
    if (pseudo.length < 2 || pseudo.length > 20) { auth.error = 'Ton pseudo doit faire entre 2 et 20 caractères.'; render(); return; }
    auth.pseudo = pseudo; auth.error = null; auth.busy = true; render();
    // Selon le chemin d'entrée : compte Google (jeton gardé) ou code e-mail.
    try {
      if (auth.google) await GraineAPI.googleSignIn(auth.google, pseudo);
      else await GraineAPI.verify(auth.email, auth.code, pseudo);
      authSuccess();
    }
    catch (e) { auth.error = friendlyError(e); }
    auth.busy = false; render();
  }
}
function authSuccess() {
  auth.step = 'welcome';
  friendsCache = null;
  syncNow(); // PREMIÈRE SYNCHRO — silencieuse, non bloquante
}
async function authResend() {
  if (!auth || auth.busy) return;
  auth.busy = true; auth.error = null; auth.notice = null; render();
  try {
    const r = await GraineAPI.requestCode(auth.email);
    auth.devCode = r && r.devCode ? String(r.devCode) : auth.devCode;
    auth.notice = 'Nouveau code envoyé.';
  } catch (e) { auth.error = friendlyError(e); }
  auth.busy = false; render();
}

/* ---------- Carte compte dans Moi ---------- */
function moiInviteCard() {
  return `<div class="card account-card fade">
    ${accountNotice ? `<p class="field-ok" style="margin:0 0 10px">${esc(accountNotice)}</p>` : ''}
    <div class="acc-head"><span class="acc-ic">☁️</span><b>Synchronise et retrouve tes amis</b></div>
    <p class="muted">Sauvegarde ta progression, retrouve-la sur tous tes appareils, défie tes amis.</p>
    <p class="muted acc-privacy">🔒 Facultatif et gratuit. E-mail + pseudo, rien d'autre — jamais ton vrai nom.</p>
    <button class="btn btn-primary" data-account="1" style="margin-top:12px">Créer mon compte / Me connecter</button>
  </div>`;
}
function moiAccountCard(u) {
  let actions;
  if (pseudoEdit) {
    actions = `<form data-pseudoform="1" class="add-friend-row" style="margin-top:12px">
        <input class="field" type="text" id="pseudoInput" maxlength="20" autocomplete="nickname" value="${esc(pseudoEdit.value)}">
        <button class="btn btn-grow" type="submit" ${pseudoEdit.busy ? 'disabled' : ''}>OK</button>
      </form>
      ${pseudoEdit.error ? `<p class="field-error">${esc(pseudoEdit.error)}</p>` : ''}
      <button class="linkbtn" data-cancelpseudo="1">Annuler</button>`;
  } else {
    actions = `<button class="btn btn-soft btn-block" data-syncnow="1" ${syncUi.status === 'syncing' ? 'disabled' : ''} style="margin-top:12px">Synchroniser maintenant</button>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn btn-ghost" data-editpseudo="1">Changer de pseudo</button>
        <button class="btn btn-ghost" data-logout="1">Se déconnecter</button>
      </div>`;
  }
  return `<div class="card account-card fade">
    <div class="acc-user"><span class="acc-ic">☁️</span>
      <div class="acc-id"><b>${esc(u.pseudo)}</b><br><span class="muted acc-mail">${esc(u.email)}</span></div></div>
    <div class="friend-code-row">
      <div><div class="fc-label">Code ami</div><div class="friend-code" id="friendCode">${esc(u.friendCode)}</div></div>
      <button class="btn btn-soft" data-copycode="1">Copier</button></div>
    <p class="sync-status muted">${esc(syncStatusText())}</p>
    ${actions}
    ${accountError ? `<p class="field-error">${esc(accountError)}</p>` : ''}
    <details class="danger-zone"><summary>Supprimer mon compte…</summary>
      <p class="muted" style="margin:8px 2px">Cela efface <b>tout sur le serveur</b> : compte, sauvegarde, amis, duels. Tes données locales, elles, restent sur cet appareil.</p>
      <button class="btn btn-ghost btn-block btn-danger" data-delaccount="1">Oui, supprimer mon compte du serveur</button>
    </details>
  </div>`;
}
async function doLogout() {
  await GraineAPI.logout(); // même hors-ligne, la session locale est effacée
  pseudoEdit = null; friendsCache = null; friendField = ''; friendError = friendNotice = null;
  syncUi = { status: 'idle', lastAt: null };
  try { localStorage.removeItem(SYNC_META_KEY); } catch (e) {}
  accountNotice = 'Tu es déconnecté. Tes données locales sont intactes.';
  render();
}
async function doDeleteAccount() {
  accountError = null;
  try {
    await GraineAPI.deleteAccount();
    pseudoEdit = null; friendsCache = null; friendField = ''; friendError = friendNotice = null;
    syncUi = { status: 'idle', lastAt: null };
    try { localStorage.removeItem(SYNC_META_KEY); } catch (e) {}
    accountNotice = 'Ton compte a été supprimé du serveur. Tes données locales sont intactes.';
  } catch (e) { accountError = friendlyError(e); }
  render();
}
async function savePseudo() {
  if (!pseudoEdit || pseudoEdit.busy) return;
  const p = (pseudoEdit.value || '').trim();
  if (p.length < 2 || p.length > 20) { pseudoEdit.error = 'Entre 2 et 20 caractères.'; render(); return; }
  pseudoEdit.busy = true; pseudoEdit.error = null; render();
  try { await GraineAPI.setPseudo(p); pseudoEdit = null; }
  catch (e) { pseudoEdit.busy = false; pseudoEdit.error = friendlyError(e); }
  render();
}
function copyFriendCode() {
  const u = GraineAPI.user(); if (!u) return;
  const done = () => {
    const b = el.querySelector('[data-copycode]');
    if (b) { b.textContent = 'Copié ✓'; setTimeout(() => { const b2 = el.querySelector('[data-copycode]'); if (b2) b2.textContent = 'Copier'; }, 1600); }
  };
  const fallback = () => { // repli : sélection + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = u.friendCode; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { /* le code reste visible à recopier */ }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u.friendCode).then(done).catch(fallback);
  else fallback();
}

/* ---------- Amis ---------- */
function normalizeFriendCode(raw) {
  let c = String(raw || '').toUpperCase().replace(/[\s-]+/g, '');
  if (/^[A-Z0-9]{4}$/.test(c)) c = 'GRN' + c; // on tolère les 4 caractères seuls
  return /^GRN[A-Z0-9]{4}$/.test(c) ? 'GRN-' + c.slice(3) : null;
}
function sinceText(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'amis';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dd = new Date(d); dd.setHours(0, 0, 0, 0);
    if (dd.getTime() === today.getTime()) return 'amis depuis aujourd\'hui';
    return 'amis depuis le ' + d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (e) { return 'amis'; }
}
function ensureFriends() {
  if (!window.GraineAPI || !GraineAPI.isLoggedIn() || friendsCache !== null || friendsLoading) return;
  friendsLoading = true;
  GraineAPI.friends()
    .then(f => { friendsCache = Array.isArray(f) ? f : []; })
    .catch(() => { friendsCache = 'error'; })
    .then(() => { friendsLoading = false; renderIfIdle(); });
}
function moiFriendsSection(u) {
  let list;
  if (friendsCache === null) list = `<p class="muted fr-empty">Chargement de ta liste d'amis…</p>`;
  else if (friendsCache === 'error') list = `<p class="muted fr-empty">Ta liste d'amis apparaîtra dès que tu seras en ligne.</p>`;
  else if (!friendsCache.length) list = `<p class="muted fr-empty">Pas encore d'ami — échangez vos codes pour vous retrouver.</p>`;
  else list = friendsCache.map(f => `<div class="friend-row">
      <span class="fr-avatar">🌿</span>
      <span class="fr-main"><b>${esc(f.pseudo)}</b><br><span class="muted fr-since">${esc(sinceText(f.since))}</span></span>
      <button class="fr-x" data-unfriend="${esc(f.friendCode)}" data-pseudo="${esc(f.pseudo)}" title="Retirer cet ami" aria-label="Retirer ${esc(f.pseudo)}">✕</button>
    </div>`).join('');
  return `<div class="section-title">🤝 Amis</div>
    <div class="card friends-card fade">
      <p style="margin:0 0 10px">Ton code ami : <span class="friend-code inline">${esc(u.friendCode)}</span></p>
      <form data-addfriendform="1" class="add-friend-row">
        <input class="field" type="text" id="friendInput" placeholder="Code d'un ami (GRN-XXXX)" autocomplete="off" autocapitalize="characters" value="${esc(friendField)}">
        <button class="btn btn-grow" type="submit">Ajouter</button>
      </form>
      ${friendError ? `<p class="field-error">${esc(friendError)}</p>` : ''}
      ${friendNotice ? `<p class="field-ok">${esc(friendNotice)}</p>` : ''}
      ${list}
    </div>
    <p class="muted me-note">Pour vous défier, rendez-vous dans Défi → « Défier un ami ».</p>`;
}
async function doAddFriend() {
  friendNotice = null;
  const code = normalizeFriendCode(friendField);
  if (!code) { friendError = 'Un code ami ressemble à GRN-XXXX.'; render(); return; }
  const me = GraineAPI.user();
  if (me && code === me.friendCode) { friendError = 'C\'est ton propre code 🙂'; render(); return; }
  friendError = null;
  try {
    const r = await GraineAPI.addFriend(code);
    friendField = '';
    const pseudo = r && r.friend && r.friend.pseudo ? r.friend.pseudo : 'ton ami';
    friendNotice = `Vous voilà amis avec ${pseudo} 🌱`;
    if (Array.isArray(friendsCache) && r && r.friend) friendsCache.push(r.friend);
    else friendsCache = null; // on rechargera la liste
  } catch (e) {
    if (e && e.offline) friendError = 'Pas de connexion — réessaie quand tu seras en ligne.';
    else if (e && e.status === 404) friendError = 'Code inconnu — vérifie-le auprès de ton ami.';
    else if (e && e.status === 409) friendError = 'Vous êtes déjà amis 🙂';
    else friendError = friendlyError(e);
  }
  render();
}
async function doRemoveFriend(code, pseudo) {
  if (!confirm(`Retirer ${pseudo} de tes amis ?`)) return;
  try {
    await GraineAPI.removeFriend(code);
    if (Array.isArray(friendsCache)) friendsCache = friendsCache.filter(f => f.friendCode !== code);
  } catch (e) { friendError = friendlyError(e); }
  render();
}

/* ============================================================================
   Interactions
   ========================================================================== */
function wire() {
  const q = s => el.querySelector(s);
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
  el.querySelectorAll('[data-learn]').forEach(b => b.addEventListener('click', startLearnNew));
  el.querySelectorAll('[data-review]').forEach(b => b.addEventListener('click', startReview));

  if (q('[data-ready]')) q('[data-ready]').addEventListener('click', startIntroQuiz);
  if (q('[data-snext]')) q('[data-snext]').addEventListener('click', nextInSession);
  if (q('[data-check]')) q('[data-check]').addEventListener('click', checkExercise);
  if (q('[data-hint]')) q('[data-hint]').addEventListener('click', () => { session.ex.hinted = true; session.ex.showHint = true; render(); });
  if (q('[data-giveup]')) q('[data-giveup]').addEventListener('click', giveUp);
  el.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { session.ex.answer.push(+b.dataset.pick); session.ex.wrong = false; render(); }));
  el.querySelectorAll('[data-unpick]').forEach(b => b.addEventListener('click', () => { session.ex.answer.splice(+b.dataset.unpick, 1); session.ex.wrong = false; render(); }));
  el.querySelectorAll('[data-fillword]').forEach(b => b.addEventListener('click', () => fillNext(+b.dataset.fillword)));
  el.querySelectorAll('[data-clear]').forEach(b => b.addEventListener('click', () => { session.ex.filled[+b.dataset.clear] = null; session.ex.wrong = false; render(); }));

  el.querySelectorAll('[data-verse]').forEach(b => b.addEventListener('click', () => go('verse', b.dataset.verse)));
  if (q('[data-remove]')) q('[data-remove]').addEventListener('click', () => removeVerse(q('[data-remove]').dataset.remove));

  // Collections (objectifs)
  el.querySelectorAll('[data-collections]').forEach(b => b.addEventListener('click', () => go('collections')));
  el.querySelectorAll('[data-selectcoll]').forEach(b => b.addEventListener('click', () => selectCollection(b.dataset.selectcoll)));
  el.querySelectorAll('[data-clearcoll]').forEach(b => b.addEventListener('click', () => { store.activeCollection = null; saveStore(); go('memo'); }));
  el.querySelectorAll('[data-gview]').forEach(b => b.addEventListener('click', () => { gardenView = b.dataset.gview; render(); }));

  // Apparence : appliquer + sauvegarder + re-render, sans rechargement
  el.querySelectorAll('[data-theme-pick]').forEach(b => b.addEventListener('click', () => { applyTheme(b.dataset.themePick); render(); }));

  // Compte, synchro & amis
  if (route.name === 'moi') ensureFriends();
  if (q('[data-account]')) q('[data-account]').addEventListener('click', startAccountFlow);
  if (q('[data-accchip]')) q('[data-accchip]').addEventListener('click', () => {
    if (window.GraineAPI && GraineAPI.isLoggedIn()) go('moi');
    else startAccountFlow();
  });
  if (q('[data-syncnow]')) q('[data-syncnow]').addEventListener('click', () => { syncNow(); });
  if (q('[data-copycode]')) q('[data-copycode]').addEventListener('click', copyFriendCode);
  if (q('[data-editpseudo]')) q('[data-editpseudo]').addEventListener('click', () => {
    pseudoEdit = { value: (GraineAPI.user() || {}).pseudo || '', error: null, busy: false }; render();
  });
  if (q('[data-cancelpseudo]')) q('[data-cancelpseudo]').addEventListener('click', () => { pseudoEdit = null; render(); });
  if (q('[data-pseudoform]')) q('[data-pseudoform]').addEventListener('submit', e => { e.preventDefault(); savePseudo(); });
  if (q('[data-logout]')) q('[data-logout]').addEventListener('click', doLogout);
  if (q('[data-delaccount]')) q('[data-delaccount]').addEventListener('click', doDeleteAccount);
  if (q('[data-addfriendform]')) q('[data-addfriendform]').addEventListener('submit', e => { e.preventDefault(); doAddFriend(); });
  el.querySelectorAll('[data-unfriend]').forEach(b => b.addEventListener('click', () => doRemoveFriend(b.dataset.unfriend, b.dataset.pseudo)));
  // parcours compte (écrans successifs)
  el.querySelectorAll('form[data-authstep]').forEach(f => f.addEventListener('submit', e => { e.preventDefault(); authSubmit(f.dataset.authstep); }));
  if (q('#google-btn')) mountGoogleButton();
  if (q('[data-authback]')) q('[data-authback]').addEventListener('click', () => { if (auth) { auth.step = 'email'; auth.error = auth.notice = null; render(); } });
  if (q('[data-authresend]')) q('[data-authresend]').addEventListener('click', authResend);
  if (q('[data-authdone]')) q('[data-authdone]').addEventListener('click', () => { auth = null; go('moi'); });
  // les saisies survivent aux re-rendus (l'état est la source de vérité)
  const bindInput = (id, fn) => { const n = q('#' + id); if (n) n.addEventListener('input', () => fn(n.value)); };
  bindInput('auth-email', v => { if (auth) auth.email = v; });
  bindInput('auth-code', v => { if (auth) auth.code = v; });
  bindInput('auth-pseudo', v => { if (auth) auth.pseudo = v; });
  bindInput('pseudoInput', v => { if (pseudoEdit) pseudoEdit.value = v; });
  bindInput('friendInput', v => { friendField = v; });
}
function fillNext(pid) {
  const ex = session.ex; const k = ex.filled.findIndex(x => x === null);
  if (k >= 0) { ex.filled[k] = pid; ex.wrong = false; render(); }
}
function checkExercise() {
  const ex = session.ex;
  if (!exComplete(ex)) return;
  if (exCorrect(ex)) {
    const card = liveCard(); // en introduction, la card naît au premier résultat enregistré
    card.attempts++;
    const wasMastered = isMastered(card);
    // Un essai aidé (verset revu pendant l'exercice) ne compte pas comme validation.
    if (!ex.hinted) card.validations = Math.min(MASTERY, card.validations + 1);
    schedule(card, ex.hinted ? 'ok' : (ex.errors === 0 ? 'clean' : 'ok'));
    if (!wasMastered && isMastered(card)) {
      session.mastered.push(card.id); // vient d'être planté 🌱
      session.celebrated.push(...checkCollectionCompletions()); // une collection vient-elle d'être complétée ?
    }
    if (!session.done.includes(card.id)) session.done.push(card.id);
    saveStore();
    session.result = 'success'; session.phase = 'result'; render();
  } else {
    ex.errors++; ex.wrong = true; render();
  }
}
function giveUp() {
  const card = liveCard(); // en introduction, la card naît au premier résultat enregistré
  card.attempts++;
  card.validations = Math.max(0, card.validations - 1);
  schedule(card, 'fail');
  if (!session.done.includes(card.id)) session.done.push(card.id);
  saveStore();
  session.result = 'fail'; session.phase = 'result'; render();
}
function nextInSession() {
  session.idx++;
  if (session.idx < session.queue.length) enterCard();
  render();
}
function removeVerse(id) {
  if (!confirm('Retirer ce verset de ton jardin ? Ta progression sur ce verset sera effacée.')) return;
  delete store.cards[id]; saveStore(); go('garden');
}

/* ============================================================================
   Démarrage
   ========================================================================== */
(async function init() {
  el.innerHTML = '<p class="muted center" style="padding:40px">Chargement…</p>';
  markActiveDay(); // ouvrir l'appli compte comme un jour d'activité (une fois par jour)
  await Promise.all([loadLibrary(), loadCollections()]);
  syncCompletedCollections();
  render();
  // Synchronisation à l'ouverture si connecté — silencieuse, non bloquante :
  // hors-ligne, l'appli locale continue exactement comme avant.
  if (window.GraineAPI && GraineAPI.isLoggedIn()) syncNow();
  loadPublicConfig(); // sait déjà, à l'ouverture de « Moi », si Google est proposé
})();
