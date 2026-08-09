/* ============================================================================
   Graine de Parole — mémorisation de versets par répétition espacée.

   Modèle :
   - L'appli PROPOSE le verset suivant d'un parcours (l'utilisateur ne choisit pas).
   - Un apprentissage GUIDÉ (découvre → initiales → mots à trous → par cœur)
     se termine par une récitation de mémoire. Confirmée « par cœur », le verset
     est PLANTÉ DANS LE JARDIN.
   - Le JARDIN ne contient donc que les versets réellement mémorisés ; la
     répétition espacée les fait revenir juste avant l'oubli pour les entretenir.

   Tout tourne côté navigateur : aucun compte, hors-ligne, rien ne quitte l'appareil.
   Ton : sobre, encourageant, jamais culpabilisant.
   ========================================================================== */

'use strict';

const STORE_KEY = 'graine.v2';
const EASE_MIN = 1.3;
const EASE_DEFAULT = 2.5;

/* ---------- Aides ---------- */
const el = document.getElementById('app');
function todayNum() { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.round(d.getTime() / 86400000); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }

/* ---------- Stockage ---------- */
function loadStore() {
  try { const raw = localStorage.getItem(STORE_KEY); if (raw) return JSON.parse(raw); } catch (e) {}
  return { cards: {}, learning: null, streak: { count: 0, lastDay: null }, seenWelcome: false };
}
function saveStore() { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
let store = loadStore();

/* ---------- Bibliothèque (parcours) ---------- */
let LIBRARY = [];
let LIB_VERSION = 'Segond 1910';
async function loadLibrary() {
  try {
    const res = await fetch('data/verses.json', { cache: 'no-cache' });
    const data = await res.json();
    LIBRARY = data.verses || []; LIB_VERSION = data.version || LIB_VERSION;
  } catch (e) { LIBRARY = []; }
}
function nextToLearn() {
  // Premier verset du parcours qui n'est ni dans le jardin, ni en cours d'apprentissage.
  return LIBRARY.find(v => !store.cards[v.id] && (!store.learning || store.learning.id !== v.id)) || null;
}

/* ---------- Contexte factuel du livre (neutre, non doctrinal) ---------- */
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
  'Lamentations': "Poèmes de deuil sur Jérusalem, où perce malgré tout la fidélité de Dieu."
};
function bookOf(ref) { const m = ref.match(/^(\d?\s?[A-Za-zÀ-ÿ]+)/); return m ? m[1].trim() : ref; }

/* ============================================================================
   Répétition espacée (inspirée de SM-2, adoucie)
   ========================================================================== */
function grade(card, q) {
  const t = todayNum();
  if (q === 'again') { card.lapses++; card.reps = 0; card.interval = 1; card.ease = Math.max(EASE_MIN, card.ease - 0.2); }
  else if (q === 'hard') { card.reps++; card.ease = Math.max(EASE_MIN, card.ease - 0.15); card.interval = card.reps <= 1 ? 1 : Math.max(1, Math.round(card.interval * 1.2)); }
  else if (q === 'good') { card.reps++; if (card.reps === 1) card.interval = 1; else if (card.reps === 2) card.interval = 4; else card.interval = Math.round(card.interval * card.ease); }
  else { card.reps++; card.ease += 0.15; if (card.reps === 1) card.interval = 2; else if (card.reps === 2) card.interval = 6; else card.interval = Math.round(card.interval * card.ease * 1.3); }
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
function dueCards() { const t = todayNum(); return Object.values(store.cards).filter(c => c.due <= t); }
function updateStreakOnActivity() {
  const t = todayNum(), s = store.streak;
  if (s.lastDay === t) return false;
  if (s.lastDay === t - 1) s.count++; else s.count = 1;
  s.lastDay = t; saveStore(); return true;
}

/* ============================================================================
   Exercices
   ========================================================================== */
function firstLetters(text) {
  return text.replace(/(\p{L})[\p{L}'’-]*/gu, (m, a) => a + '.').replace(/\.{2,}/g, '.');
}
function makeBlanks(text) {
  const words = text.split(/\s+/);
  const idx = words.map((w, i) => i).filter(i => words[i].replace(/[^\p{L}]/gu, '').length > 3);
  const hide = new Set(shuffle(idx).slice(0, Math.max(1, Math.round(idx.length * 0.4))));
  return words.map((w, i) => hide.has(i)
    ? `<span class="blank">${'&nbsp;'.repeat(Math.min(w.replace(/[^\p{L}]/gu, '').length, 8))}</span>`
    : esc(w)).join(' ');
}
function pickExercise(card) {
  const words = card.text.split(/\s+/).length;
  if (card.interval >= 14) return 'recall';
  if (words <= 14 && Math.random() < 0.5) return 'scramble';
  return 'blanks';
}

/* ============================================================================
   Navigation
   ========================================================================== */
let route = { name: 'home', param: null };
let session = null;   // révision du jardin
let learnRevealed = false;

function go(name, param) { route = { name, param: param || null }; render(); window.scrollTo(0, 0); }

function render() {
  const v = {
    home: viewHome, learn: viewLearn, review: viewReview,
    garden: viewGarden, verse: () => viewVerse(route.param), about: viewAbout
  }[route.name] || viewHome;
  el.innerHTML = v() + tabbar();
  wire();
}

/* ---------- Éléments communs ---------- */
function topbar() {
  const s = store.streak.count;
  const flame = s > 0 ? `<span class="streak">🔥 ${s} jour${s > 1 ? 's' : ''}</span>` : '';
  return `<div class="topbar">
    <div class="brand"><img class="logo" src="icon.svg" alt="" />
      <span class="app-title"><span class="seed">Graine</span> de Parole</span></div>${flame}
  </div>`;
}
function tabbar() {
  if (route.name === 'learn' || route.name === 'review') return '';
  const tab = (n, ic, l) => `<button data-tab="${n}" class="${route.name === n ? 'active' : ''}"><span class="ic">${ic}</span>${l}</button>`;
  return `<nav class="tabbar">
    ${tab('home', '🏠', 'Accueil')}${tab('garden', '🌳', 'Mon jardin')}${tab('about', '☖', 'À propos')}
  </nav>`;
}

/* ============================================================================
   Écran d'accueil (page d'accueil claire)
   ========================================================================== */
function viewHome() {
  const due = dueCards();
  const gardenN = Object.keys(store.cards).length;
  const L = store.learning;

  const hero = `<div class="card hero fade">
    <div class="hero-emblem"><img src="icon.svg" alt="" /></div>
    <h1 class="hero-name"><span class="seed">Graine</span> de Parole</h1>
    <p class="hero-tag">Cache la Parole dans ton cœur, un peu chaque jour.</p>
  </div>`;

  // Première visite : on explique, puis un seul bouton.
  if (gardenN === 0 && !L) {
    return topbar() + hero + `
      <div class="steps fade">
        <div class="step"><span class="si">📖</span><div><b>L'appli te propose un verset.</b><br><span class="muted">Tu n'as pas à choisir.</span></div></div>
        <div class="step"><span class="si">🧠</span><div><b>Elle t'aide à le mémoriser</b>, pas à pas, en quelques minutes.</div></div>
        <div class="step"><span class="si">🌱</span><div><b>Une fois su par cœur</b>, il rejoint ton jardin — et revient juste avant que tu l'oublies.</div></div>
      </div>
      <button class="btn btn-primary" data-learn="1">Apprendre mon premier verset</button>
      <p class="muted center" style="margin-top:14px;font-size:.85rem">Gratuit · rien ne quitte ton téléphone</p>`;
  }

  // Retour : actions claires.
  let actions = '';
  if (due.length > 0) {
    actions += `<div class="card action fade">
      <div class="action-txt"><b>${due.length} verset${due.length > 1 ? 's' : ''} à revoir</b>
        <span class="muted">Quelques minutes pour les garder vivants.</span></div>
      <button class="btn btn-primary" data-review="1">Réviser</button>
    </div>`;
  }
  if (L) {
    actions += `<div class="card action fade">
      <div class="action-txt"><b>Tu apprends un verset</b>
        <span class="muted">${esc(L.ref)} — reprends où tu t'es arrêté.</span></div>
      <button class="btn btn-grow" data-learn="1">Continuer</button>
    </div>`;
  } else if (nextToLearn()) {
    actions += `<div class="card action fade">
      <div class="action-txt"><b>Apprendre un nouveau verset</b>
        <span class="muted">L'appli t'en propose un.</span></div>
      <button class="btn btn-grow" data-learn="1">Apprendre</button>
    </div>`;
  } else {
    actions += `<div class="card fade"><p class="center" style="margin:0">🎉 Tu as mémorisé tous les versets proposés !<br>
      <span class="muted">Tu peux ajouter les tiens depuis ton jardin.</span></p></div>`;
  }
  if (due.length === 0) {
    actions += `<p class="muted center" style="margin:6px 4px 0">Rien d'urgent à revoir aujourd'hui 🌱</p>`;
  }

  return topbar() + hero + actions +
    `<button class="verse-item gardenlink fade" data-tab="garden">
       <span class="stage">🌳</span>
       <span class="vi-main"><span class="vi-ref">Mon jardin</span><br>
         <span class="vi-text">${gardenN} verset${gardenN > 1 ? 's' : ''} mémorisé${gardenN > 1 ? 's' : ''}</span></span>
       <span class="chev">›</span>
     </button>`;
}

/* ============================================================================
   Apprentissage guidé d'un nouveau verset
   ========================================================================== */
const LEARN_STEPS = ['read', 'letters', 'blanks', 'recall'];
const LEARN_LABELS = { read: 'Découvre le verset', letters: 'Devine avec les initiales', blanks: 'Complète les mots', recall: 'Récite de mémoire' };

function startLearning() {
  if (!store.learning) {
    const v = nextToLearn();
    if (!v) { go('home'); return; }
    store.learning = { id: v.id, ref: v.ref, text: v.text, step: 0 };
    saveStore();
  }
  learnRevealed = false;
  go('learn');
}
function learnAdvance() { store.learning.step++; learnRevealed = false; saveStore(); render(); }
function graduate(quality) {
  const L = store.learning;
  const card = { id: L.id, ref: L.ref, text: L.text, ease: EASE_DEFAULT, reps: quality === 'byheart' ? 2 : 1, lapses: 0 };
  card.interval = quality === 'byheart' ? 2 : 1;
  card.due = todayNum() + card.interval;
  card.addedDay = todayNum();
  store.cards[L.id] = card;
  store.learning = null;
  saveStore();
  route = { name: 'learn', param: 'done' }; // écran de célébration
  learnRevealed = false;
  render(); window.scrollTo(0, 0);
}

function viewLearn() {
  if (route.param === 'done') return viewLearnDone();
  const L = store.learning;
  if (!L) { startLearning(); return ''; }
  const step = LEARN_STEPS[L.step];
  const dots = LEARN_STEPS.map((_, i) => `<span class="${i < L.step ? 'done' : i === L.step ? 'current' : ''}"></span>`).join('');

  let body = '';
  if (step === 'read') {
    body = `<div class="verse">« ${esc(L.text)} »</div>
      <div class="ref">${esc(L.ref)} <span class="version">· ${esc(LIB_VERSION)}</span></div>
      <p class="muted center" style="margin:18px 0 6px">Lis-le calmement, à voix haute si tu peux.</p>
      <button class="btn btn-grow btn-block" data-ladv="1">Continuer</button>`;
  } else if (step === 'letters') {
    body = !learnRevealed
      ? `<div class="cloze hint">${esc(firstLetters(L.text))}</div>
         <p class="muted center" style="margin-top:16px">Récite dans ta tête, puis révèle.</p>
         <button class="btn btn-grow btn-block" data-lreveal="1">Révéler</button>`
      : `<div class="verse fade">« ${esc(L.text)} »</div><div class="ref">${esc(L.ref)}</div>
         <button class="btn btn-grow btn-block" data-ladv="1" style="margin-top:16px">Continuer</button>`;
  } else if (step === 'blanks') {
    body = !learnRevealed
      ? `<div class="cloze">${makeBlanks(L.text)}</div>
         <p class="muted center" style="margin-top:16px">Complète mentalement, puis révèle.</p>
         <button class="btn btn-grow btn-block" data-lreveal="1">Révéler</button>`
      : `<div class="verse fade">« ${esc(L.text)} »</div><div class="ref">${esc(L.ref)}</div>
         <button class="btn btn-grow btn-block" data-ladv="1" style="margin-top:16px">Continuer</button>`;
  } else { // recall
    body = !learnRevealed
      ? `<div class="card" style="background:var(--surface-2);text-align:center;padding:30px 18px">
           <div class="ref" style="margin:0">${esc(L.ref)}</div>
           <p class="muted" style="margin-top:12px">Récite le verset entier de mémoire, à voix haute ou dans ton cœur.</p>
         </div>
         <button class="btn btn-grow btn-block" data-lreveal="1" style="margin-top:12px">Révéler</button>`
      : `<div class="verse fade">« ${esc(L.text)} »</div><div class="ref">${esc(L.ref)}</div>
         <p class="muted center" style="margin:18px 0 8px">As-tu réussi à le réciter ?</p>
         <div class="eval-grid">
           <button class="btn eval-easy" data-grad="byheart">😎 Oui, par cœur<span class="sub">planté dans le jardin</span></button>
           <button class="btn eval-good" data-grad="almost">🙂 Presque<span class="sub">on le revoit demain</span></button>
         </div>
         <button class="btn btn-ghost btn-block" data-grad="again" style="margin-top:10px">↩︎ Pas encore — réessayer</button>`;
  }

  return `<div class="fade">
    <button class="back-link" data-tab="home">✕ Quitter</button>
    <div class="progress-dots">${dots}</div>
    <div class="exercise-label">Apprentissage · ${LEARN_LABELS[step]}</div>
    <div class="card">${body}</div>
    <p class="muted center" style="margin-top:14px;font-size:.85rem">Ce verset entrera dans ton jardin quand tu le sauras par cœur.</p>
  </div>`;
}

function viewLearnDone() {
  const changed = updateStreakOnActivity();
  const s = store.streak.count;
  const more = nextToLearn();
  return `<div class="done-screen fade">
    <div class="seal">🌱</div>
    <h2 style="font-family:var(--serif);margin:10px 0">Planté dans ton jardin !</h2>
    <p class="muted">Un verset de plus caché dans ton cœur · série de ${s} jour${s > 1 ? 's' : ''} 🔥</p>
    <div class="card" style="margin-top:18px">
      <div class="verse small">« Je serre ta parole dans mon cœur, afin de ne pas pécher contre toi. »</div>
      <div class="ref">Psaumes 119.11</div>
    </div>
    ${more ? `<button class="btn btn-primary" data-learn="1" style="margin-top:20px">Apprendre un autre verset</button>` : ''}
    <button class="btn btn-soft btn-block" data-tab="garden" style="margin-top:10px">Voir mon jardin</button>
    <button class="btn btn-ghost btn-block" data-tab="home" style="margin-top:10px">Retour à l'accueil</button>
  </div>`;
}

/* ============================================================================
   Révision du jardin (entretien par répétition espacée)
   ========================================================================== */
function startReview() {
  const due = dueCards().sort((a, b) => a.due - b.due);
  if (!due.length) { go('home'); return; }
  session = { queue: due, idx: 0, revealed: false, kind: pickExercise(due[0]), done: [] };
  go('review');
}
function viewReview() {
  if (!session) { go('home'); return ''; }
  if (session.idx >= session.queue.length) return viewReviewDone();
  const card = session.queue[session.idx];
  const dots = session.queue.map((_, i) => `<span class="${i < session.idx ? 'done' : i === session.idx ? 'current' : ''}"></span>`).join('');
  const labels = { blanks: 'Complète les mots', scramble: 'Remets dans l\'ordre', recall: 'Récite de mémoire' };

  let challenge = '';
  if (!session.revealed) {
    if (session.kind === 'blanks') {
      challenge = `<div class="cloze">${makeBlanks(card.text)}</div>
        <p class="muted center" style="margin-top:16px">Complète mentalement, puis révèle.</p>
        <button class="btn btn-grow btn-block" data-reveal="1">Révéler</button>`;
    } else if (session.kind === 'recall') {
      challenge = `<div class="card" style="background:var(--surface-2);text-align:center;padding:34px 18px">
          <div class="ref" style="margin:0">${esc(card.ref)}</div>
          <p class="muted" style="margin-top:12px">Récite le verset de mémoire.</p></div>
        <button class="btn btn-grow btn-block" data-reveal="1" style="margin-top:12px">Révéler</button>`;
    } else {
      const words = shuffle(card.text.split(/\s+/).map((w, i) => ({ w, i })));
      challenge = `<div class="answer-line" id="answer"></div>
        <div class="pool" id="pool">${words.map(o => `<button class="chip" data-word="${o.i}">${esc(o.w)}</button>`).join('')}</div>
        <button class="btn btn-grow btn-block" data-reveal="1" style="margin-top:14px">Révéler la réponse</button>`;
    }
  } else {
    challenge = `<div class="reveal-box fade">
        <div class="verse">« ${esc(card.text)} »</div>
        <div class="ref">${esc(card.ref)} <span class="version">· ${esc(LIB_VERSION)}</span></div></div>
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
function viewReviewDone() {
  const n = session ? session.done.length : 0;
  updateStreakOnActivity();
  const s = store.streak.count;
  session = null;
  return `<div class="done-screen fade">
    <div class="seal">🌿</div>
    <h2 style="font-family:var(--serif);margin:10px 0">C'est fait pour aujourd'hui</h2>
    <p class="muted">${n} verset${n > 1 ? 's' : ''} revu${n > 1 ? 's' : ''} · série de ${s} jour${s > 1 ? 's' : ''} 🔥</p>
    <button class="btn btn-primary" data-tab="home" style="margin-top:20px">Revenir à l'accueil</button>
    <p class="muted" style="margin-top:14px">Repose-toi — trop réviser aujourd'hui n'aide pas. À demain 🙂</p>
  </div>`;
}

/* ============================================================================
   Le jardin (versets mémorisés) + ajout d'un verset personnel
   ========================================================================== */
function viewGarden() {
  const cards = Object.values(store.cards).sort((a, b) => a.due - b.due);
  const list = cards.length ? cards.map(c => {
    const st = stageOf(c), t = todayNum();
    const badge = c.due <= t ? '<span class="badge-due">à revoir</span>' : '';
    return `<button class="verse-item" data-verse="${esc(c.id)}">
      <span class="stage" title="${st.label}">${st.icon}</span>
      <span class="vi-main"><span class="vi-ref">${esc(c.ref)}</span><br>
        <span class="vi-text">${esc(c.text)}</span></span>${badge}</button>`;
  }).join('') : `<div class="card center"><p style="margin:0">Ton jardin est encore vide 🌱<br>
      <span class="muted">Apprends un verset et il apparaîtra ici.</span></p>
      <button class="btn btn-grow btn-block" data-learn="1" style="margin-top:14px">Apprendre un verset</button></div>`;

  return topbar() + `
    <h2 style="font-family:var(--serif);margin-bottom:2px">Mon jardin</h2>
    <p class="muted" style="margin:0 2px 16px">Les versets que tu as mémorisés. Chacun grandit à mesure qu'il s'enracine.</p>
    ${list}
    <details class="addbox" style="margin-top:22px">
      <summary>➕ Ajouter un verset de mon choix</summary>
      <div class="card" style="margin-top:10px">
        <p class="muted" style="margin-top:0;font-size:.9rem">Tu apprendras ce verset comme les autres, puis il rejoindra ton jardin.</p>
        <label class="lbl">Référence</label>
        <input class="field" id="mref" placeholder="ex. Romains 5.8" />
        <label class="lbl">Texte du verset</label>
        <textarea class="field" id="mtext" placeholder="Colle ou écris le verset ici…"></textarea>
        <button class="btn btn-grow btn-block" id="addManual" style="margin-top:14px">Commencer à l'apprendre</button>
      </div>
    </details>`;
}

function viewVerse(id) {
  const c = store.cards[id];
  if (!c) { go('garden'); return ''; }
  const st = stageOf(c), book = bookOf(c.ref), ctx = BOOKS[book];
  const days = c.due - todayNum();
  const when = days <= 0 ? 'À revoir aujourd\'hui' : days === 1 ? 'Prochaine révision : demain' : `Prochaine révision : dans ${days} jours`;
  return `<div class="fade">
    <button class="back-link" data-tab="garden">‹ Mon jardin</button>
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

function viewAbout() {
  return topbar() + `
    <h2 style="font-family:var(--serif)">À propos</h2>
    <div class="card">
      <p><b>Graine de Parole</b> t'aide à cacher la Parole dans ton cœur, un peu chaque jour, et à ne pas l'oublier.</p>
      <p class="muted">L'appli te propose un verset, t'accompagne pour le mémoriser, puis veille à ce qu'il te revienne juste avant que tu l'oublies. Tu n'as rien à calculer.</p>
    </div>
    <div class="section-title">Nos principes</div>
    <div class="card">
      <p>🕊️ <b>Gratuit, pour toujours.</b> Aucune fonction payante, aucune publicité.</p>
      <p>🔒 <b>Rien ne quitte ton appareil.</b> Ta progression reste chez toi ; l'appli fonctionne hors-ligne.</p>
      <p>🌱 <b>Encourager, pas culpabiliser.</b> Pas de « retard », pas de reproche.</p>
      <p>📖 <b>Respect du texte.</b> Versets ${esc(LIB_VERSION)} (domaine public).</p>
    </div>
    <p class="muted center" style="margin-top:20px">« La semence, c'est la parole de Dieu. » — Luc 8.11</p>
    <p class="muted center" style="font-size:.8rem;margin-top:10px">Version 0.2 · projet en construction</p>`;
}

/* ============================================================================
   Interactions
   ========================================================================== */
function wire() {
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
  const q = (s) => el.querySelector(s);

  if (q('[data-learn]')) el.querySelectorAll('[data-learn]').forEach(b => b.addEventListener('click', startLearning));
  if (q('[data-review]')) q('[data-review]').addEventListener('click', startReview);

  // Apprentissage
  if (q('[data-ladv]')) q('[data-ladv]').addEventListener('click', learnAdvance);
  if (q('[data-lreveal]')) q('[data-lreveal]').addEventListener('click', () => { learnRevealed = true; render(); });
  el.querySelectorAll('[data-grad]').forEach(b => b.addEventListener('click', () => graduate(b.dataset.grad)));

  // Révision
  if (q('[data-reveal]')) q('[data-reveal]').addEventListener('click', () => { session.revealed = true; render(); });
  el.querySelectorAll('#pool .chip').forEach(c => c.addEventListener('click', () => placeWord(c)));
  el.querySelectorAll('#answer .chip').forEach(c => c.addEventListener('click', () => unplaceWord(c)));
  el.querySelectorAll('[data-eval]').forEach(b => b.addEventListener('click', () => evaluate(b.dataset.eval)));

  // Jardin
  el.querySelectorAll('[data-verse]').forEach(b => b.addEventListener('click', () => go('verse', b.dataset.verse)));
  if (q('#addManual')) q('#addManual').addEventListener('click', addManual);
  if (q('[data-remove]')) q('[data-remove]').addEventListener('click', () => removeVerse(q('[data-remove]').dataset.remove));
}

function placeWord(chip) {
  const a = el.querySelector('#answer'); const c = chip.cloneNode(true);
  c.classList.add('placed'); c.addEventListener('click', () => unplaceWord(c)); a.appendChild(c); chip.remove();
}
function unplaceWord(chip) {
  const p = el.querySelector('#pool'); const c = chip.cloneNode(true);
  c.classList.remove('placed'); c.addEventListener('click', () => placeWord(c)); p.appendChild(c); chip.remove();
}
function evaluate(qy) {
  const card = session.queue[session.idx];
  grade(card, qy); store.cards[card.id] = card;
  if (!session.done.includes(card.id)) session.done.push(card.id);
  saveStore();
  session.idx++; session.revealed = false;
  if (session.idx < session.queue.length) session.kind = pickExercise(session.queue[session.idx]);
  render();
}
function addManual() {
  if (store.learning) { alert('Tu apprends déjà un verset. Termine-le d\'abord 🙂'); return; }
  const ref = el.querySelector('#mref').value.trim();
  const text = el.querySelector('#mtext').value.trim();
  if (!ref || !text) { alert('Ajoute une référence et le texte du verset.'); return; }
  const id = 'perso-' + ref.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-') + '-' + Object.keys(store.cards).length;
  store.learning = { id, ref, text, step: 0 };
  saveStore(); startLearning();
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
  await loadLibrary();
  render();
})();
