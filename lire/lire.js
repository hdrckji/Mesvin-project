/* ============================================================================
   Graine de Parole — module « Lire »
   Un plan de lecture qui est un CHEMIN, PAS UN CALENDRIER.

   Principe (non négociable) :
   - Aucune date, aucun « retard » possible. Le plan est un chemin d'une
     certaine longueur ; on avance quand on lit, on ne recule jamais quand
     on ne lit pas.
   - On montre ce qui est FAIT (« Tu as déjà lu 5 chapitres 🌱 »),
     jamais ce qui manquerait.
   - Fin d'un livre = célébration sobre.

   Tout est côté navigateur : localStorage uniquement, rien ne quitte
   l'appareil. Texte : Louis Segond 1910 (domaine public).
   ========================================================================== */

'use strict';

const STORE_KEY = 'graine.lire.v1';
const WORDS_PER_MIN = 170; // rythme de lecture posé, pour l'estimation douce

/* ---------- Les chemins proposés ---------- */
const PLANS = {
  marc: {
    id: 'marc', fichier: 'data/marc.json',
    titre: "L'Évangile de Marc", livre: 'Marc', nb: 16,
    pourquoi: "Le plus court des quatre Évangiles — <b>idéal pour commencer</b>. Un récit vif, qui va droit à l'essentiel.",
    contexte: "Évangile généralement attribué à Jean-Marc, compagnon de Pierre et de Paul. C'est le plus court des quatre Évangiles : un récit direct de la vie, de la mort et de la résurrection de Jésus."
  },
  jean: {
    id: 'jean', fichier: 'data/jean.json',
    titre: "L'Évangile de Jean", livre: 'Jean', nb: 21,
    pourquoi: "Un Évangile profond et contemplatif, qui met en avant l'identité de Jésus, Fils de Dieu.",
    contexte: "Évangile écrit par Jean, l'un des douze apôtres. Il met en avant l'identité de Jésus, Fils de Dieu, à travers sept « signes » et de longs entretiens."
  }
};

/* ---------- Aides ---------- */
const el = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Stockage local ---------- */
function loadStore() {
  try { const r = localStorage.getItem(STORE_KEY); if (r) return JSON.parse(r); } catch (e) {}
  return { active: null, minutes: null, plans: {} };
}
function saveStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {} }
let store = loadStore();

function planState(id) {
  if (!store.plans[id]) store.plans[id] = { read: new Array(PLANS[id].nb).fill(false) };
  const st = store.plans[id];
  if (!Array.isArray(st.read) || st.read.length !== PLANS[id].nb) {
    const fixed = new Array(PLANS[id].nb).fill(false);
    (Array.isArray(st.read) ? st.read : []).forEach((v, i) => { if (i < fixed.length) fixed[i] = !!v; });
    st.read = fixed;
  }
  return st;
}
const readCount = id => planState(id).read.filter(Boolean).length;
const nextChapter = id => planState(id).read.indexOf(false); // -1 = livre terminé

/* ---------- Texte biblique (chargé à la demande, gardé en mémoire) ---------- */
const bookCache = {};
async function loadBook(id) {
  if (bookCache[id]) return bookCache[id];
  const r = await fetch(PLANS[id].fichier, { cache: 'no-cache' });
  if (!r.ok) throw new Error('fetch ' + r.status);
  const d = await r.json();
  d.mots = d.chapitres.map(ch => ch.join(' ').split(/\s+/).length); // mots par chapitre
  bookCache[id] = d;
  return d;
}

/* ---------- Estimation douce (jamais contraignante, jamais de reproche) ----
   Toujours calculée VERS L'AVANT, à partir d'aujourd'hui et de ce qui reste :
   elle se recale d'elle-même, quoi qu'il se soit passé avant. */
function estimation(id, book) {
  if (!store.minutes || !book) return '';
  const st = planState(id);
  const motsRestants = book.chapitres.reduce((s, ch, i) => st.read[i] ? s : s + book.mots[i], 0);
  if (motsRestants === 0) return '';
  const jours = Math.max(1, Math.ceil(motsRestants / WORDS_PER_MIN / store.minutes));
  const d = new Date(); d.setDate(d.getDate() + jours);
  const quand = jours <= 1 ? "dès aujourd'hui"
    : 'vers le ' + d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  return `À raison de ${store.minutes} min par jour, tu peux arriver au bout ${quand}. Et si la vie en décide autrement, le chemin t'attend — simplement.`;
}

/* ============================================================================
   Navigation
   ========================================================================== */
let route = { name: 'home', param: null };
let currentBook = null;   // données du livre actif (une fois chargées)
let loadError = false;

function go(name, param) { route = { name, param: param === undefined ? null : param }; render(); window.scrollTo(0, 0); }

function render() {
  const views = {
    choose: viewChoose, rhythm: viewRhythm, home: viewHome,
    read: () => viewRead(route.param), chapterDone: () => viewChapterDone(route.param),
    bookDone: viewBookDone
  };
  el.innerHTML = (views[route.name] || viewHome)();
  wire();
}

function header() {
  return `<div class="topbar">
    <a class="back-link" href="../index.html" style="margin:0;text-decoration:none">‹ Accueil</a>
    <div class="brand"><span class="app-title"><span class="seed">Graine</span> de Parole · Lire</span></div>
  </div>`;
}

/* ============================================================================
   Écrans
   ========================================================================== */

/* ---------- Choix du chemin ---------- */
function viewChoose() {
  const first = !store.active;
  const intro = first
    ? `<div class="card hero fade">
        <h1 class="hero-name">Un chemin, <span class="seed">pas un calendrier</span></h1>
        <p class="hero-tag">Ici, pas de dates : tu avances quand tu lis, à ton rythme. Aucun retard n'existe — le chemin t'attend, simplement.</p>
      </div>`
    : `<h2 style="font-family:var(--serif);margin:6px 2px 14px">Choisir un chemin</h2>`;

  const cards = Object.values(PLANS).map(p => {
    const n = readCount(p.id);
    const progress = n > 0
      ? `<div class="plan-meta" style="color:var(--grow);font-weight:650">Tu as déjà lu ${n} chapitre${n > 1 ? 's' : ''} 🌱</div>` : '';
    return `<button class="card plan-card fade" data-plan="${p.id}">
      <div class="plan-name">📖 ${esc(p.titre)}</div>
      <div class="plan-meta">${p.nb} chapitres</div>
      ${progress}
      <div class="plan-why">${p.pourquoi}</div>
    </button>`;
  }).join('');

  return header() + intro + cards +
    (first ? `<p class="muted center" style="font-size:.85rem;margin-top:10px">Texte : Louis Segond 1910 · rien ne quitte ton téléphone</p>`
           : `<button class="linklike" data-back-home="1">‹ Revenir à mon chemin</button>`);
}

/* ---------- Rythme (optionnel, pour une estimation douce) ---------- */
function viewRhythm() {
  const p = PLANS[route.param];
  const pill = m => `<button class="pill${store.minutes === m ? ' on' : ''}" data-min="${m}">${m} min</button>`;
  return header() + `<div class="card hero fade">
      <h2 style="font-family:var(--serif)">Une dernière chose — si tu veux</h2>
      <p class="muted" style="margin:10px 0 0">Combien de temps peux-tu donner par jour, en général ? Cela sert seulement à te donner une idée de l'horizon. <b>Rien ne t'y oblige, jamais.</b></p>
    </div>
    <div class="card fade">
      <div class="pill-row" style="justify-content:center">${pill(5)}${pill(10)}${pill(15)}</div>
      <button class="btn btn-ghost btn-block" data-skip-min="1" style="margin-top:14px">Je préfère avancer sans estimation</button>
    </div>
    <p class="muted center" style="font-size:.85rem">Tu commences : ${esc(p.titre)}</p>`;
}

/* ---------- Écran principal : le chemin ---------- */
function viewHome() {
  if (!store.active) return viewChoose();
  const id = store.active, p = PLANS[id], st = planState(id);
  const n = readCount(id), next = nextChapter(id);
  const done = next === -1;

  const path = st.read.map((r, i) => {
    const cls = r ? 'read' : (i === next ? 'next' : '');
    return `<button class="mile ${cls}" data-open="${i}" title="Chapitre ${i + 1}">${r ? '✓' : i + 1}</button>`;
  }).join('');

  let main;
  if (done) {
    main = `<div class="card hero fade">
      <div class="hero-emblem"><img src="../icon.svg" alt="" style="width:52px;height:52px"></div>
      <h1 class="hero-name" style="font-size:1.4rem">Tu as lu ${esc(p.titre)} en entier ✨</h1>
      <p class="hero-tag">Les ${p.nb} chapitres, du premier au dernier. Tu peux le relire quand tu veux, ou ouvrir un autre chemin.</p>
      <button class="btn btn-primary" data-change="1" style="margin-top:18px">Choisir un autre chemin</button>
    </div>`;
  } else {
    const sub = n === 0
      ? `Le chemin commence ici — premier pas : ${esc(p.livre)} 1.`
      : `Reprends là où tu t'es arrêté : ${esc(p.livre)} ${next + 1}.`;
    main = `<div class="card hero fade">
      <p class="hello">${esc(p.titre)}</p>
      <h1 style="font-family:var(--serif);font-size:1.5rem;margin:6px 0 8px">${n === 0 ? 'Bienvenue sur le chemin' : 'Reprends là où tu t’es arrêté'}</h1>
      <p class="muted" style="margin:0 0 18px">${sub}</p>
      <button class="btn btn-primary" data-read-next="1" style="font-size:1.15rem;padding:16px 20px">📖 Lire ${esc(p.livre)} ${next + 1}</button>
    </div>`;
  }

  const est = estimation(id, currentBook);
  const gauge = `<div class="card fade">
    <div class="gauge-label"><span><b>${n}</b> / ${p.nb} chapitres lus</span>
      ${n > 0 ? `<span style="color:var(--grow);font-weight:650">🌱</span>` : ''}</div>
    <div class="gauge"><i style="width:${Math.round(n / p.nb * 100)}%"></i></div>
    <div class="path">${path}</div>
    ${est ? `<div class="soft-note">${est}</div>` : ''}
  </div>`;

  const ctx = `<div class="card fade"><div class="context-box" style="margin-top:0">
      <b>Contexte — ${esc(p.livre)}.</b> ${esc(p.contexte)}</div></div>`;

  return header() + main + gauge + ctx +
    `<button class="linklike" data-change="1">Changer de chemin</button>`;
}

/* ---------- Lecture d'un chapitre ---------- */
function viewRead(ci) {
  const id = store.active, p = PLANS[id], st = planState(id);
  if (loadError) {
    return header() + `<div class="card center fade"><p>Le texte n'a pas pu être chargé pour l'instant.</p>
      <p class="muted">Vérifie ta connexion, puis réessaie — ta progression, elle, est bien gardée.</p>
      <button class="btn btn-soft btn-block" data-retry="${ci}">Réessayer</button></div>`;
  }
  if (!currentBook) return header() + `<p class="muted center" style="padding:40px">Chargement du texte…</p>`;

  const verses = currentBook.chapitres[ci];
  const body = verses.map((v, i) => `<span class="vnum">${i + 1}</span>${esc(v)}`).join(' ');
  const isRead = st.read[ci];

  const finish = isRead
    ? `<p class="already-read">Chapitre déjà lu 🌱</p>` +
      (ci + 1 < p.nb ? `<button class="btn btn-soft btn-block" data-goto="${ci + 1}">Chapitre suivant ›</button>` : '')
    : `<button class="btn btn-primary" data-finish="${ci}">J'ai terminé ce chapitre</button>`;

  return `<div class="fade">
    <button class="back-link" data-back-home="1">‹ Mon chemin</button>
    <div class="chapter-head">
      <button class="chapter-nav" data-goto="${ci - 1}" ${ci === 0 ? 'disabled' : ''} aria-label="Chapitre précédent">‹</button>
      <h2>${esc(p.livre)} ${ci + 1}</h2>
      <button class="chapter-nav" data-goto="${ci + 1}" ${ci + 1 >= p.nb ? 'disabled' : ''} aria-label="Chapitre suivant">›</button>
    </div>
    <div class="card"><div class="scripture">${body}</div>
      <div class="ref" style="margin-top:18px">${esc(p.livre)} ${ci + 1} <span class="version">· Louis Segond 1910</span></div></div>
    <div class="finish-zone">${finish}</div>
  </div>`;
}

/* ---------- Petite confirmation après un chapitre ---------- */
const BRAVOS = [
  'Un pas de plus sur le chemin.',
  'La Parole fait son œuvre, un chapitre à la fois.',
  'Bien. Tranquillement, sûrement.',
  'Chaque page lue est une graine semée.'
];
function viewChapterDone(ci) {
  const id = store.active, p = PLANS[id];
  const n = readCount(id), next = nextChapter(id);
  const mot = BRAVOS[ci % BRAVOS.length];
  return header() + `<div class="celebrate card fade">
      <div class="seal">🌱</div>
      <h2>${esc(p.livre)} ${ci + 1}, c'est lu</h2>
      <p class="muted">${mot}</p>
      <p style="font-weight:650;color:var(--grow);margin:14px 0 0">Tu as déjà lu ${n} chapitre${n > 1 ? 's' : ''} sur ${p.nb} 🌱</p>
      <div class="gauge" style="margin-top:14px"><i style="width:${Math.round(n / p.nb * 100)}%"></i></div>
    </div>
    ${next !== -1 ? `<button class="btn btn-grow btn-block" data-goto="${next}">Continuer avec ${esc(p.livre)} ${next + 1}</button>` : ''}
    <button class="btn btn-ghost btn-block" data-back-home="1" style="margin-top:10px">Ça suffit pour aujourd'hui</button>
    <p class="muted center" style="font-size:.88rem;margin-top:14px">Reviens quand tu veux — le chemin t'attendra, sans compter les jours.</p>`;
}

/* ---------- Fin du livre : célébration sobre ---------- */
function viewBookDone() {
  const id = store.active, p = PLANS[id];
  const autres = Object.values(PLANS).filter(x => x.id !== id && nextChapter(x.id) !== -1);
  const sparks = [10, 30, 50, 70, 90].map((x, i) =>
    `<span style="left:${x}%;animation-delay:${i * 0.18}s">✨</span>`).join('');
  return header() + `<div class="celebrate card fade">
      <div class="sparks">${sparks}</div>
      <div class="seal">✨</div>
      <h2>Tu viens de terminer ${esc(p.titre)}</h2>
      <p class="muted">${p.nb} chapitres, lus du premier au dernier, à ton rythme. C'est un beau chemin parcouru.</p>
      <div class="verse small">« La semence, c'est la parole de Dieu. »</div>
      <div class="ref">Luc 8.11</div>
    </div>
    ${autres.map(a => `<button class="btn btn-grow btn-block" data-start="${a.id}" style="margin-top:6px">Ouvrir ${esc(a.titre)}</button>`).join('')}
    <button class="btn btn-ghost btn-block" data-back-home="1" style="margin-top:10px">Revenir à mon chemin</button>`;
}

/* ============================================================================
   Actions
   ========================================================================== */
async function activatePlan(id, askRhythm) {
  store.active = id;
  planState(id);
  saveStore();
  currentBook = null; loadError = false;
  if (askRhythm && store.minutes === null) { go('rhythm', id); }
  else { go('home'); }
  ensureBook();
}
function ensureBook() {
  const id = store.active;
  if (!id || (currentBook && currentBook.livre === PLANS[id].livre)) return;
  loadBook(id)
    .then(b => { currentBook = b; loadError = false; render(); })
    .catch(() => { loadError = true; render(); });
}
function openChapter(ci) {
  const p = PLANS[store.active];
  if (ci < 0 || ci >= p.nb) return;
  loadError = false;
  go('read', ci);
  ensureBook();
}
function finishChapter(ci) {
  const id = store.active, st = planState(id);
  if (!st.read[ci]) { st.read[ci] = true; saveStore(); }
  if (nextChapter(id) === -1) go('bookDone');
  else go('chapterDone', ci);
}

/* ============================================================================
   Interactions
   ========================================================================== */
function wire() {
  const on = (sel, fn) => el.querySelectorAll(sel).forEach(b => b.addEventListener('click', fn));
  on('[data-plan]', e => activatePlan(e.currentTarget.dataset.plan, true));
  on('[data-start]', e => activatePlan(e.currentTarget.dataset.start, false));
  on('[data-min]', e => { store.minutes = +e.currentTarget.dataset.min; saveStore(); go('home'); ensureBook(); });
  on('[data-skip-min]', () => { store.minutes = 0; saveStore(); go('home'); ensureBook(); });
  on('[data-read-next]', () => openChapter(nextChapter(store.active)));
  on('[data-open]', e => openChapter(+e.currentTarget.dataset.open));
  on('[data-goto]', e => openChapter(+e.currentTarget.dataset.goto));
  on('[data-retry]', e => openChapter(+e.currentTarget.dataset.retry));
  on('[data-finish]', e => finishChapter(+e.currentTarget.dataset.finish));
  on('[data-back-home]', () => go('home'));
  on('[data-change]', () => go('choose'));
}

/* ============================================================================
   Démarrage
   ========================================================================== */
(function init() {
  if (!store.active) go('choose');
  else { go('home'); ensureBook(); }
})();
