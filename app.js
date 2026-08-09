/* ============================================================================
   Graine de Parole — mémorisation de versets par répétition espacée.
   Tout tourne côté navigateur : aucun compte, aucune donnée envoyée ailleurs.
   La progression est enregistrée sur l'appareil (localStorage) et fonctionne
   hors-ligne. Ton : sobre, encourageant, jamais culpabilisant.
   ========================================================================== */

'use strict';

const STORE_KEY = 'graine.v1';
const EASE_MIN = 1.3;
const EASE_DEFAULT = 2.5;

/* ---------- Petites aides ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const el = document.getElementById('app');

function todayNum() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return Math.round(d.getTime() / 86400000);
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------- Stockage ---------- */
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { cards: {}, streak: { count: 0, lastDay: null }, seenIntro: false };
}
function saveStore() { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
let store = loadStore();

/* ---------- Bibliothèque de versets (Segond 1910) ---------- */
let LIBRARY = [];
let LIB_VERSION = 'Segond 1910';

async function loadLibrary() {
  try {
    const res = await fetch('data/verses.json', { cache: 'no-cache' });
    const data = await res.json();
    LIBRARY = data.verses || [];
    LIB_VERSION = data.version || LIB_VERSION;
  } catch (e) {
    LIBRARY = [];
  }
}

/* Contexte factuel (neutre, non doctrinal) — de quel livre vient le verset. */
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
  'Matthieu ': ""
};
function bookOf(ref) {
  // « 1 Corinthiens 13.4 » -> « 1 Corinthiens »
  const m = ref.match(/^(\d?\s?[A-Za-zÀ-ÿ]+)/);
  return m ? m[1].trim() : ref;
}

/* ============================================================================
   Moteur de répétition espacée (inspiré de SM-2, simplifié et adouci).
   ========================================================================== */
function newCard(v) {
  return {
    id: v.id, ref: v.ref, text: v.text,
    ease: EASE_DEFAULT, interval: 0, reps: 0, lapses: 0,
    due: todayNum(), addedDay: todayNum()
  };
}
function grade(card, q) {
  const t = todayNum();
  if (q === 'again') {
    card.lapses++; card.reps = 0; card.interval = 1;
    card.ease = Math.max(EASE_MIN, card.ease - 0.2);
  } else if (q === 'hard') {
    card.reps++; card.ease = Math.max(EASE_MIN, card.ease - 0.15);
    card.interval = card.reps <= 1 ? 1 : Math.max(1, Math.round(card.interval * 1.2));
  } else if (q === 'good') {
    card.reps++;
    if (card.reps === 1) card.interval = 1;
    else if (card.reps === 2) card.interval = 4;
    else card.interval = Math.round(card.interval * card.ease);
  } else { // easy
    card.reps++; card.ease += 0.15;
    if (card.reps === 1) card.interval = 2;
    else if (card.reps === 2) card.interval = 6;
    else card.interval = Math.round(card.interval * card.ease * 1.3);
  }
  card.interval = Math.min(card.interval, 365);
  card.due = t + card.interval;
}
function stageOf(card) {
  if (card.reps === 0) return { icon: '🌰', label: 'À semer' };
  if (card.interval <= 3) return { icon: '🌱', label: 'Germe' };
  if (card.interval <= 13) return { icon: '🌿', label: 'Pousse' };
  if (card.interval <= 44) return { icon: '🪴', label: 'Plante' };
  if (card.interval <= 119) return { icon: '🌳', label: 'Arbre' };
  return { icon: '🌲', label: 'Enraciné' };
}
function dueCards() {
  const t = todayNum();
  return Object.values(store.cards).filter(c => c.due <= t);
}
function updateStreakOnActivity() {
  const t = todayNum();
  const s = store.streak;
  if (s.lastDay === t) return false;      // déjà compté aujourd'hui
  if (s.lastDay === t - 1) s.count++;     // jour consécutif
  else s.count = 1;                        // reprise (jamais de reproche)
  s.lastDay = t;
  saveStore();
  return true;
}

/* ============================================================================
   Exercices : premières lettres, mots à trous, mots mélangés, récitation.
   La difficulté s'adapte à la maturité du verset.
   ========================================================================== */
function firstLetters(text) {
  // Remplace chaque mot par sa première lettre + « . » ; garde la ponctuation,
  // sans doubler le point quand le mot était déjà suivi d'un point.
  return text.replace(/(\p{L})[\p{L}'’-]*/gu, (m, a) => a + '.').replace(/\.{2,}/g, '.');
}
function makeBlanks(text) {
  const words = text.split(/\s+/);
  const idx = words.map((w, i) => i).filter(i => words[i].replace(/[^\p{L}]/gu, '').length > 3);
  const hideCount = Math.max(1, Math.round(idx.length * 0.4));
  const hide = new Set(shuffle(idx).slice(0, hideCount));
  return words.map((w, i) => {
    if (!hide.has(i)) return esc(w);
    const letters = w.replace(/[^\p{L}]/gu, '');
    return `<span class="blank">${'&nbsp;'.repeat(Math.min(letters.length, 8))}</span>`;
  }).join(' ');
}
function pickExercise(card) {
  if (card.reps === 0) return 'letters';
  const words = card.text.split(/\s+/).length;
  if (card.interval >= 14) return 'recall';
  if (words <= 14 && Math.random() < 0.5) return 'scramble';
  return 'blanks';
}

/* ============================================================================
   État de navigation
   ========================================================================== */
let route = { name: 'home', param: null };
let session = null; // { queue: [cards], idx, revealed, kind }

function go(name, param) { route = { name, param: param || null }; render(); window.scrollTo(0, 0); }

/* ============================================================================
   Rendu des écrans
   ========================================================================== */
function render() {
  let html = '';
  if (route.name === 'home') html = viewHome();
  else if (route.name === 'session') html = viewSession();
  else if (route.name === 'library') html = viewLibrary();
  else if (route.name === 'verse') html = viewVerse(route.param);
  else if (route.name === 'about') html = viewAbout();
  el.innerHTML = html + tabbar();
  wire();
}

function topbar() {
  const s = store.streak.count;
  const flame = s > 0 ? `<span class="streak">🔥 ${s} jour${s > 1 ? 's' : ''}</span>` : '';
  return `<div class="topbar">
    <div class="brand">
      <img class="logo" src="icon.svg" alt="" />
      <span class="app-title"><span class="seed">Graine</span> de Parole</span>
    </div>${flame}
  </div>`;
}

function tabbar() {
  const tab = (name, ic, lbl) =>
    `<button data-tab="${name}" class="${route.name === name ? 'active' : ''}">
      <span class="ic">${ic}</span>${lbl}</button>`;
  // Pendant une session on masque la barre pour rester concentré.
  if (route.name === 'session') return '';
  return `<nav class="tabbar">
    ${tab('home', '🏠', 'Accueil')}
    ${tab('library', '📖', 'Versets')}
    ${tab('about', '☖', 'À propos')}
  </nav>`;
}

/* ----- Accueil ----- */
function viewHome() {
  const due = dueCards();
  const total = Object.keys(store.cards).length;

  if (total === 0) {
    return topbar() + `
      <div class="card hero center fade">
        <div class="verse">« Je serre ta parole dans mon cœur, afin de ne pas pécher contre toi. »</div>
        <div class="ref">Psaumes 119.11 <span class="version">· ${esc(LIB_VERSION)}</span></div>
      </div>
      <p class="muted center" style="margin:18px 6px">Choisis un premier verset à cacher dans ton cœur.
      Cinq minutes par jour suffisent pour le garder vivant.</p>
      <button class="btn btn-primary" data-tab="library">Choisir mon premier verset</button>`;
  }

  let body;
  if (due.length > 0) {
    body = `<div class="card hero fade">
      <div class="hello">Un moment avec la Parole ?</div>
      <div class="today-count"><span class="n">${due.length}</span> verset${due.length > 1 ? 's' : ''} à revoir</div>
      <p class="muted" style="margin:10px 0 18px">Quelques minutes, à ton rythme.</p>
      <button class="btn btn-primary" data-start="1">Commencer</button>
    </div>`;
  } else {
    body = `<div class="card hero fade">
      <div class="rest">
        <span class="big">🌱</span>
        <div class="verse small">Rien à revoir aujourd'hui.</div>
        <p class="muted" style="margin-top:8px">Ta mémoire travaille toute seule. Reviens demain — ou ajoute un nouveau verset.</p>
        <button class="btn btn-soft btn-block" data-tab="library" style="margin-top:10px">Ajouter un verset</button>
      </div>
    </div>`;
  }

  // Aperçu du jardin (les versets déjà semés)
  const cards = Object.values(store.cards).sort((a, b) => a.due - b.due);
  const list = cards.map(c => {
    const st = stageOf(c);
    const t = todayNum();
    const badge = c.due <= t ? '<span class="badge-due">à revoir</span>' : '';
    return `<button class="verse-item" data-verse="${esc(c.id)}">
      <span class="stage" title="${st.label}">${st.icon}</span>
      <span class="vi-main"><span class="vi-ref">${esc(c.ref)}</span><br>
        <span class="vi-text">${esc(c.text)}</span></span>
      ${badge}
    </button>`;
  }).join('');

  return topbar() + body +
    `<div class="section-title">Mon jardin · ${cards.length} verset${cards.length > 1 ? 's' : ''}</div>${list}`;
}

/* ----- Session de révision ----- */
function startSession() {
  const due = dueCards().sort((a, b) => a.due - b.due);
  if (due.length === 0) { go('home'); return; }
  session = { queue: due, idx: 0, revealed: false, kind: null, done: [] };
  session.kind = pickExercise(session.queue[0]);
  go('session');
}

function viewSession() {
  if (!session) { go('home'); return ''; }
  if (session.idx >= session.queue.length) return viewSessionDone();

  const card = session.queue[session.idx];
  const dots = session.queue.map((_, i) =>
    `<span class="${i < session.idx ? 'done' : i === session.idx ? 'current' : ''}"></span>`).join('');

  const labels = {
    letters: 'Premières lettres', blanks: 'Complète les mots',
    scramble: 'Remets dans l\'ordre', recall: 'Récite de mémoire'
  };

  let challenge = '';
  if (!session.revealed) {
    if (session.kind === 'letters') {
      challenge = `<div class="cloze hint">${esc(firstLetters(card.text))}</div>
        <p class="muted center" style="margin-top:16px">Récite dans ta tête, puis révèle.</p>
        <button class="btn btn-grow btn-block" data-reveal="1" style="margin-top:6px">Révéler</button>`;
    } else if (session.kind === 'blanks') {
      challenge = `<div class="cloze">${makeBlanks(card.text)}</div>
        <p class="muted center" style="margin-top:16px">Complète mentalement, puis révèle.</p>
        <button class="btn btn-grow btn-block" data-reveal="1" style="margin-top:6px">Révéler</button>`;
    } else if (session.kind === 'recall') {
      challenge = `<div class="card" style="background:var(--surface-2);text-align:center;padding:34px 18px">
          <div class="ref" style="margin:0">${esc(card.ref)}</div>
          <p class="muted" style="margin-top:12px">Récite le verset de mémoire, à voix haute ou dans ton cœur.</p>
        </div>
        <button class="btn btn-grow btn-block" data-reveal="1" style="margin-top:12px">Révéler</button>`;
    } else { // scramble
      const words = card.text.split(/\s+/);
      const pool = shuffle(words.map((w, i) => ({ w, i })));
      session.scramble = { words, placed: [] };
      challenge = `<div class="answer-line" id="answer"></div>
        <div class="pool" id="pool">${pool.map(o =>
          `<button class="chip" data-word="${o.i}">${esc(o.w)}</button>`).join('')}</div>
        <button class="btn btn-grow btn-block" data-reveal="1" style="margin-top:14px">Révéler la réponse</button>`;
    }
  } else {
    // Verset révélé + auto-évaluation
    challenge = `<div class="reveal-box fade">
        <div class="verse">« ${esc(card.text)} »</div>
        <div class="ref">${esc(card.ref)} <span class="version">· ${esc(LIB_VERSION)}</span></div>
      </div>
      <p class="muted center" style="margin:18px 0 6px">C'était comment ?</p>
      <div class="eval-grid">
        <button class="btn eval-again" data-eval="again">😖 Raté<span class="sub">à revoir demain</span></button>
        <button class="btn eval-hard" data-eval="hard">🤔 Difficile<span class="sub">bientôt</span></button>
        <button class="btn eval-good" data-eval="good">🙂 Correct<span class="sub">plus tard</span></button>
        <button class="btn eval-easy" data-eval="easy">😎 Facile<span class="sub">dans longtemps</span></button>
      </div>`;
  }

  return `<div class="fade">
    <button class="back-link" data-tab="home">✕ Quitter</button>
    <div class="progress-dots">${dots}</div>
    <div class="exercise-label">${labels[session.kind] || ''} · verset ${session.idx + 1} / ${session.queue.length}</div>
    <div class="card">${challenge}</div>
  </div>`;
}

function viewSessionDone() {
  const n = session ? session.done.length : 0;
  const changed = updateStreakOnActivity();
  const s = store.streak.count;
  const versets = shuffle([
    ['Ta parole est une lampe à mes pieds, et une lumière sur mon sentier.', 'Psaumes 119.105'],
    ['La semence, c\'est la parole de Dieu.', 'Luc 8.11'],
    ['L\'herbe sèche, la fleur tombe; mais la parole de notre Dieu subsiste éternellement.', 'Ésaïe 40.8']
  ])[0];
  session = null;
  return `<div class="done-screen fade">
    <div class="seal">🌱</div>
    <h2 style="font-family:var(--serif);margin:10px 0">C'est fait pour aujourd'hui</h2>
    <p class="muted">${n} verset${n > 1 ? 's' : ''} revu${n > 1 ? 's' : ''} · série de ${s} jour${s > 1 ? 's' : ''} 🔥</p>
    <div class="card" style="margin-top:22px">
      <div class="verse small">« ${esc(versets[0])} »</div>
      <div class="ref">${esc(versets[1])}</div>
    </div>
    <button class="btn btn-primary" data-tab="home" style="margin-top:20px">Revenir à l'accueil</button>
    <p class="muted" style="margin-top:14px">Repose-toi — trop réviser aujourd'hui n'aide pas. À demain 🙂</p>
  </div>`;
}

/* ----- Bibliothèque / ajout ----- */
let libFilter = { theme: null, q: '' };
function viewLibrary() {
  const owned = new Set(Object.keys(store.cards));
  const themes = [...new Set(LIBRARY.map(v => v.theme))].sort();
  let items = LIBRARY.filter(v => !owned.has(v.id));
  if (libFilter.theme) items = items.filter(v => v.theme === libFilter.theme);
  if (libFilter.q) {
    const q = libFilter.q.toLowerCase();
    items = items.filter(v => v.ref.toLowerCase().includes(q) || v.text.toLowerCase().includes(q));
  }

  const pills = themes.map(t =>
    `<button class="pill ${libFilter.theme === t ? 'on' : ''}" data-theme="${esc(t)}">${esc(t)}</button>`).join('');

  const list = items.map(v =>
    `<button class="verse-item" data-add="${esc(v.id)}">
      <span class="stage">＋</span>
      <span class="vi-main"><span class="vi-ref">${esc(v.ref)}</span><br>
        <span class="vi-text">${esc(v.text)}</span></span>
    </button>`).join('') || '<p class="muted center" style="padding:20px">Aucun verset ici. Essaie un autre thème, ou ajoute le tien ci-dessous.</p>';

  return topbar() + `
    <h2 style="font-family:var(--serif);margin-bottom:4px">Choisir un verset</h2>
    <p class="muted" style="margin:0 2px 14px">Ajoute-le à ton jardin pour commencer à le mémoriser.</p>
    <input class="field" id="libq" placeholder="Chercher (référence ou mot)…" value="${esc(libFilter.q)}" />
    <div class="pill-row" style="margin:12px 0 16px">
      <button class="pill ${!libFilter.theme ? 'on' : ''}" data-theme="">Tous</button>${pills}
    </div>
    ${list}
    <div class="section-title">Ajouter mon propre verset</div>
    <div class="card">
      <label class="lbl">Référence</label>
      <input class="field" id="mref" placeholder="ex. Romains 5.8" />
      <label class="lbl">Texte du verset</label>
      <textarea class="field" id="mtext" placeholder="Colle ou écris le verset ici…"></textarea>
      <button class="btn btn-grow btn-block" id="addManual" style="margin-top:14px">Ajouter ce verset</button>
    </div>`;
}

/* ----- Détail d'un verset (avec contexte) ----- */
function viewVerse(id) {
  const c = store.cards[id];
  if (!c) { go('home'); return ''; }
  const st = stageOf(c);
  const book = bookOf(c.ref);
  const ctx = BOOKS[book];
  const t = todayNum();
  const days = c.due - t;
  const when = c.reps === 0 ? 'Pas encore commencé'
    : days <= 0 ? 'À revoir aujourd\'hui'
    : days === 1 ? 'Prochaine révision : demain'
    : `Prochaine révision : dans ${days} jours`;

  return `<div class="fade">
    <button class="back-link" data-tab="home">‹ Retour</button>
    <div class="card hero">
      <div class="verse">« ${esc(c.text)} »</div>
      <div class="ref">${esc(c.ref)} <span class="version">· ${esc(LIB_VERSION)}</span></div>
    </div>
    <div class="card">
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:1.8rem">${st.icon}</span>
        <div><b>${st.label}</b><br><span class="muted" style="font-size:.9rem">${when}</span></div>
      </div>
      ${ctx ? `<div class="context-box"><b>Contexte — ${esc(book)}.</b> ${esc(ctx)}</div>` : ''}
    </div>
    <button class="btn btn-ghost btn-block" data-remove="${esc(id)}" style="color:var(--danger);border-color:var(--danger)">Retirer de mon jardin</button>
  </div>`;
}

/* ----- À propos ----- */
function viewAbout() {
  return topbar() + `
    <h2 style="font-family:var(--serif)">À propos de Graine de Parole</h2>
    <div class="card">
      <p><b>Graine de Parole</b> t'aide à cacher la Parole dans ton cœur, un peu chaque jour, et à ne pas l'oublier.</p>
      <p class="muted">Chaque verset revient au bon moment — juste avant que tu ne l'oublies. Plus tu le connais, plus l'intervalle s'allonge. Tu n'as rien à calculer : réponds honnêtement « c'était comment ? » et l'appli s'occupe du reste.</p>
    </div>
    <div class="section-title">Nos principes</div>
    <div class="card">
      <p>🕊️ <b>Gratuit, pour toujours.</b> Aucune fonction payante, aucune publicité.</p>
      <p>🔒 <b>Rien ne quitte ton appareil.</b> Ta progression reste chez toi, l'appli fonctionne hors-ligne.</p>
      <p>🌱 <b>Encourager, pas culpabiliser.</b> Pas de « retard », pas de reproche. Reviens quand tu veux.</p>
      <p>📖 <b>Respect du texte.</b> Versets ${esc(LIB_VERSION)} (domaine public).</p>
    </div>
    <p class="muted center" style="margin-top:20px">« La semence, c'est la parole de Dieu. » — Luc 8.11</p>
    <p class="muted center" style="font-size:.8rem;margin-top:10px">Version 0.1 · projet en construction</p>`;
}

/* ============================================================================
   Interactions (branchées après chaque rendu)
   ========================================================================== */
function wire() {
  // Onglets & liens de navigation
  el.querySelectorAll('[data-tab]').forEach(b =>
    b.addEventListener('click', () => go(b.dataset.tab)));
  document.querySelectorAll('.tabbar [data-tab]').forEach(b =>
    b.addEventListener('click', () => go(b.dataset.tab)));

  // Démarrer une session
  const start = el.querySelector('[data-start]');
  if (start) start.addEventListener('click', startSession);

  // Ouvrir un verset du jardin
  el.querySelectorAll('[data-verse]').forEach(b =>
    b.addEventListener('click', () => go('verse', b.dataset.verse)));

  // Session : révéler
  const rev = el.querySelector('[data-reveal]');
  if (rev) rev.addEventListener('click', () => { session.revealed = true; render(); });

  // Session : mots mélangés
  el.querySelectorAll('#pool .chip').forEach(chip =>
    chip.addEventListener('click', () => placeWord(chip)));
  el.querySelectorAll('#answer .chip').forEach(chip =>
    chip.addEventListener('click', () => unplaceWord(chip)));

  // Session : auto-évaluation
  el.querySelectorAll('[data-eval]').forEach(b =>
    b.addEventListener('click', () => evaluate(b.dataset.eval)));

  // Bibliothèque : thèmes / recherche / ajout
  el.querySelectorAll('[data-theme]').forEach(b =>
    b.addEventListener('click', () => { libFilter.theme = b.dataset.theme || null; render(); }));
  const q = el.querySelector('#libq');
  if (q) q.addEventListener('input', () => { libFilter.q = q.value; /* léger */ debouncedLib(); });
  el.querySelectorAll('[data-add]').forEach(b =>
    b.addEventListener('click', () => addVerse(b.dataset.add)));
  const man = el.querySelector('#addManual');
  if (man) man.addEventListener('click', addManual);

  // Détail : retirer
  const rm = el.querySelector('[data-remove]');
  if (rm) rm.addEventListener('click', () => removeVerse(rm.dataset.remove));
}

let libTimer = null;
function debouncedLib() {
  clearTimeout(libTimer);
  libTimer = setTimeout(() => {
    // Re-rendu ciblé de la liste sans perdre le focus du champ : simple re-render.
    const active = document.activeElement === el.querySelector('#libq');
    render();
    if (active) { const f = el.querySelector('#libq'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
  }, 180);
}

function placeWord(chip) {
  const answer = el.querySelector('#answer');
  const c = chip.cloneNode(true);
  c.classList.add('placed');
  c.addEventListener('click', () => unplaceWord(c));
  answer.appendChild(c);
  chip.remove();
}
function unplaceWord(chip) {
  const pool = el.querySelector('#pool');
  const c = chip.cloneNode(true);
  c.classList.remove('placed');
  c.addEventListener('click', () => placeWord(c));
  pool.appendChild(c);
  chip.remove();
}

function evaluate(q) {
  const card = session.queue[session.idx];
  grade(card, q);
  store.cards[card.id] = card;
  if (!session.done.includes(card.id)) session.done.push(card.id);
  saveStore();
  // Verset suivant
  session.idx++;
  session.revealed = false;
  session.scramble = null;
  if (session.idx < session.queue.length) session.kind = pickExercise(session.queue[session.idx]);
  render();
}

function addVerse(id) {
  const v = LIBRARY.find(x => x.id === id);
  if (!v || store.cards[id]) return;
  store.cards[id] = newCard(v);
  saveStore();
  go('home');
}
function addManual() {
  const ref = el.querySelector('#mref').value.trim();
  const text = el.querySelector('#mtext').value.trim();
  if (!ref || !text) { alert('Ajoute une référence et le texte du verset.'); return; }
  const id = 'perso-' + ref.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-') + '-' + Object.keys(store.cards).length;
  store.cards[id] = newCard({ id, ref, text });
  saveStore();
  go('home');
}
function removeVerse(id) {
  if (!confirm('Retirer ce verset de ton jardin ? Ta progression sur ce verset sera effacée.')) return;
  delete store.cards[id];
  saveStore();
  go('home');
}

/* ============================================================================
   Démarrage
   ========================================================================== */
(async function init() {
  el.innerHTML = '<p class="muted center" style="padding:40px">Chargement…</p>';
  await loadLibrary();
  render();
})();
