/* ============================================================================
   Graine de Parole — module « Lire »
   Un plan de lecture qui est un CHEMIN, PAS UN CALENDRIER.

   Principe (non négociable) :
   - Aucune date, aucun « retard » possible. Le plan est un chemin d'une
     certaine longueur ; on avance quand on lit, on ne recule jamais quand
     on ne lit pas.
   - On montre ce qui est FAIT (« Tu as déjà lu 5 chapitres 🌱 »),
     jamais ce qui manquerait.
   - Fin d'un livre = célébration sobre. Fin d'un objectif aussi.

   v2 : le chemin se CONFIGURE (où marcher ? combien de temps ? quel
   objectif ?), on peut garder plusieurs chemins (3 max), et la progression
   par livre est PARTAGÉE entre eux : un chapitre lu compte partout.

   Tout est côté navigateur : localStorage uniquement, rien ne quitte
   l'appareil. Texte : Louis Segond 1910 (domaine public).
   ========================================================================== */

'use strict';

const STORE_KEY = 'graine.lire.v1';
const WORDS_PER_MIN = 170; // rythme de lecture posé, pour l'estimation douce
const MAX_PLANS = 3;

/* ============================================================================
   Catalogue des livres disponibles (fichiers chargés à la demande).
   `mots` = nombre total de mots (précalculé) pour l'estimation douce
   avant même que le texte soit téléchargé.
   ========================================================================== */
const BOOKS = {
  /* ---- Ancien Testament ---- */
  genese: { id: 'genese', testament: 'AT', nom: 'Genèse', nb: 50, mots: 34612,
    contexte: "Premier livre de la Bible : la création, les débuts de l'humanité, puis l'histoire d'Abraham, d'Isaac, de Jacob et de Joseph." },
  exode: { id: 'exode', testament: 'AT', nom: 'Exode', nb: 40, mots: 28494,
    contexte: "La sortie d'Égypte : Moïse, la traversée de la mer, le don de la loi au Sinaï et la marche au désert." },
  psaumes: { id: 'psaumes', testament: 'AT', nom: 'Psaumes', nb: 150, mots: 40168, chapLabel: 'Psaume',
    contexte: "Un recueil de 150 prières et chants — louange, confiance, détresse, reconnaissance — attribués en grande partie à David." },
  proverbes: { id: 'proverbes', testament: 'AT', nom: 'Proverbes', nb: 31, mots: 14792,
    contexte: "Des paroles de sagesse pour la vie de tous les jours, rassemblées autour de Salomon." },
  /* ---- Nouveau Testament ---- */
  matthieu: { id: 'matthieu', testament: 'NT', nom: 'Matthieu', nb: 28, mots: 22151, evangile: true,
    contexte: "Évangile attribué à Matthieu, le collecteur d'impôts devenu apôtre. Il présente Jésus comme le Messie annoncé par les Écritures." },
  marc: { id: 'marc', testament: 'NT', nom: 'Marc', nb: 16, mots: 13874, evangile: true,
    contexte: "Évangile généralement attribué à Jean-Marc, compagnon de Pierre et de Paul. C'est le plus court des quatre Évangiles : un récit direct de la vie, de la mort et de la résurrection de Jésus." },
  luc: { id: 'luc', testament: 'NT', nom: 'Luc', nb: 24, mots: 23937, evangile: true,
    contexte: "Évangile écrit par Luc, médecin et compagnon de Paul. Un récit soigné et ordonné, attentif aux personnes que l'on oublie." },
  jean: { id: 'jean', testament: 'NT', nom: 'Jean', nb: 21, mots: 18293, evangile: true,
    contexte: "Évangile écrit par Jean, l'un des douze apôtres. Il met en avant l'identité de Jésus, Fils de Dieu, à travers sept « signes » et de longs entretiens." },
  actes: { id: 'actes', testament: 'NT', nom: 'Actes', nb: 28, mots: 22607,
    contexte: "La suite de l'Évangile de Luc : la Pentecôte, les premières communautés, et l'Évangile qui se répand de Jérusalem jusqu'à Rome." },
  romains: { id: 'romains', testament: 'NT', nom: 'Romains', nb: 16, mots: 9581,
    contexte: "Lettre de Paul aux chrétiens de Rome — son exposé le plus complet : tous ont besoin de grâce, et la foi en Jésus-Christ la reçoit." },
  '1corinthiens': { id: '1corinthiens', testament: 'NT', nom: '1 Corinthiens', nb: 16, mots: 9436,
    contexte: "Lettre de Paul à l'église de Corinthe : l'unité, l'amour (le chapitre 13), les dons spirituels et la résurrection." },
  '2corinthiens': { id: '2corinthiens', testament: 'NT', nom: '2 Corinthiens', nb: 13, mots: 6333,
    contexte: "Paul se confie : ses épreuves, son ministère, et la force de Dieu qui s'accomplit dans la faiblesse." },
  galates: { id: 'galates', testament: 'NT', nom: 'Galates', nb: 6, mots: 3157,
    contexte: "Une lettre vive : le salut vient de la foi en Christ, non des œuvres de la loi. La liberté chrétienne." },
  ephesiens: { id: 'ephesiens', testament: 'NT', nom: 'Éphésiens', nb: 6, mots: 3065,
    contexte: "Le dessein de Dieu en Christ, l'Église comme un seul corps, et la vie nouvelle qui en découle." },
  philippiens: { id: 'philippiens', testament: 'NT', nom: 'Philippiens', nb: 4, mots: 2242,
    contexte: "Écrite depuis une prison, c'est pourtant la lettre de la joie : « Réjouissez-vous toujours dans le Seigneur. »" },
  colossiens: { id: 'colossiens', testament: 'NT', nom: 'Colossiens', nb: 4, mots: 2078,
    contexte: "Le Christ au-dessus de tout : en lui habite toute la plénitude. Une vie enracinée en lui." },
  '1thessaloniciens': { id: '1thessaloniciens', testament: 'NT', nom: '1 Thessaloniciens', nb: 5, mots: 1947,
    contexte: "Une des premières lettres de Paul : des encouragements à une jeune église, et l'espérance du retour du Seigneur." },
  '2thessaloniciens': { id: '2thessaloniciens', testament: 'NT', nom: '2 Thessaloniciens', nb: 3, mots: 1067,
    contexte: "La suite de la première lettre : tenir ferme et continuer à vivre fidèlement, dans l'attente." },
  '1timothee': { id: '1timothee', testament: 'NT', nom: '1 Timothée', nb: 6, mots: 2368,
    contexte: "Conseils de Paul à Timothée, jeune responsable d'église : la fidélité à l'enseignement et la conduite de la communauté." },
  '2timothee': { id: '2timothee', testament: 'NT', nom: '2 Timothée', nb: 4, mots: 1652,
    contexte: "La dernière lettre de Paul, comme un passage de témoin : « J'ai combattu le bon combat, j'ai achevé la course. »" },
  tite: { id: 'tite', testament: 'NT', nom: 'Tite', nb: 3, mots: 952,
    contexte: "Paul écrit à Tite, resté en Crète, pour organiser les églises et encourager une vie qui honore l'Évangile." },
  philemon: { id: 'philemon', testament: 'NT', nom: 'Philémon', nb: 1, mots: 446,
    contexte: "Un mot personnel de Paul : il plaide pour Onésime, esclave en fuite devenu frère dans la foi." }
};

const LETTRES_PAUL = ['romains', '1corinthiens', '2corinthiens', 'galates',
  'ephesiens', 'philippiens', 'colossiens', '1thessaloniciens', '2thessaloniciens',
  '1timothee', '2timothee', 'tite', 'philemon'];

/* Nom « long » d'un livre, pour nommer un chemin d'un seul livre. */
function titreLivre(id) {
  const b = BOOKS[id];
  if (b.evangile) return "L'Évangile de " + b.nom;
  if (id === 'actes') return 'Les Actes des apôtres';
  if (id === 'psaumes') return 'Les Psaumes';
  if (id === 'proverbes') return 'Les Proverbes';
  return b.nom;
}

/* ============================================================================
   Les objectifs proposés par le configurateur.
   Chaque objectif = une séquence ordonnée de livres. Le choix « où marcher ? »
   (zone AT / NT) filtre la liste.
   ========================================================================== */
const OBJECTIFS = [
  /* ---- Nouveau Testament ---- */
  { id: 'vie-jesus', zone: 'NT', nom: 'Découvrir la vie de Jésus', seq: ['marc'],
    pourquoi: "L'Évangile le plus court et le plus vif — <b>idéal pour commencer</b>." },
  { id: 'quatre-evangiles', zone: 'NT', nom: 'Les quatre Évangiles', seq: ['matthieu', 'marc', 'luc', 'jean'],
    pourquoi: "Quatre regards sur la même vie : Matthieu, Marc, Luc et Jean." },
  { id: 'naissance-eglise', zone: 'NT', nom: "La naissance de l'Église", seq: ['actes'],
    pourquoi: "La Pentecôte et les premiers pas de l'Évangile, de Jérusalem à Rome." },
  { id: 'jesus-puis-eglise', zone: 'NT', nom: "De Jésus à l'Église", seq: ['luc', 'actes'],
    pourquoi: "Le récit de Luc en deux tomes : la vie de Jésus, puis les débuts de l'Église." },
  { id: 'lettre-joie', zone: 'NT', nom: 'Une lettre de Paul : la joie', seq: ['philippiens'],
    pourquoi: "Quatre chapitres écrits en prison, et pourtant remplis de joie." },
  { id: 'foi-expliquee', zone: 'NT', nom: 'La foi expliquée', seq: ['romains'],
    pourquoi: "La lettre aux Romains, où Paul déploie l'Évangile pas à pas." },
  { id: 'lettres-paul', zone: 'NT', nom: 'Toutes les lettres de Paul', seq: LETTRES_PAUL,
    pourquoi: "Les treize lettres, de Romains à Philémon, dans l'ordre." },
  /* ---- Ancien Testament ---- */
  { id: 'origines', zone: 'AT', nom: 'Les origines', seq: ['genese'],
    pourquoi: "La Genèse : la création, Abraham, Jacob, Joseph — là où tout commence." },
  { id: 'liberation', zone: 'AT', nom: 'La grande libération', seq: ['exode'],
    pourquoi: "L'Exode : la sortie d'Égypte, la mer ouverte, la loi donnée au Sinaï." },
  { id: 'origines-liberte', zone: 'AT', nom: 'Des origines à la liberté', seq: ['genese', 'exode'],
    pourquoi: "Genèse puis Exode, d'une seule marche : de la création au Sinaï." },
  { id: 'psaume-par-jour', zone: 'AT', nom: 'Un psaume par jour', seq: ['psaumes'],
    pourquoi: "150 prières à recevoir une par une, à ton rythme — un psaume à la fois." },
  { id: 'sagesse', zone: 'AT', nom: 'La sagesse au quotidien', seq: ['proverbes'],
    pourquoi: "Les Proverbes : des paroles courtes et concrètes pour la vie de tous les jours." }
];

/* ---------- Aides ---------- */
const el = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ============================================================================
   Stockage local (v2) + migration silencieuse depuis l'ancien format.

   v2 : {
     v: 2,
     active: <planId> | null,
     books: { <livreId>: { read: [bool, …] } },   // progression PAR LIVRE,
                                                   // partagée entre les chemins
     plans: [ { id, nom, objectif, seq: [livreId…], minutes } ]
   }
   `minutes` : 5/10/15, ou 0 = « avancer sans estimation », par chemin.

   Ancien format (v1) : { active: 'marc'|'jean'|null, minutes, plans: { marc:
   { read: [...] }, jean: { read: [...] } } } → les tableaux `read` deviennent
   `books`, et le plan actif devient un chemin d'un livre. Rien n'est perdu.
   ========================================================================== */
function freshStore() { return { v: 2, active: null, books: {}, plans: [] }; }
const genId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function migrate(raw) {
  if (!raw || typeof raw !== 'object') return freshStore();
  if (raw.v === 2) {
    // hygiène minimale
    if (!raw.books || typeof raw.books !== 'object') raw.books = {};
    if (!Array.isArray(raw.plans)) raw.plans = [];
    return raw;
  }
  // ---- ancien format ----
  const s = freshStore();
  const old = (raw.plans && typeof raw.plans === 'object') ? raw.plans : {};
  Object.keys(old).forEach(id => {
    if (BOOKS[id] && old[id] && Array.isArray(old[id].read)) {
      s.books[id] = { read: old[id].read.map(Boolean) };
    }
  });
  if (raw.active && BOOKS[raw.active]) {
    const plan = {
      id: genId(), nom: titreLivre(raw.active), objectif: null,
      seq: [raw.active],
      minutes: (typeof raw.minutes === 'number') ? raw.minutes : null
    };
    s.plans.push(plan);
    s.active = plan.id;
  }
  return s;
}

function loadStore() {
  let raw = null;
  try { const r = localStorage.getItem(STORE_KEY); if (r) raw = JSON.parse(r); } catch (e) {}
  const s = migrate(raw);
  return s;
}
function saveStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {} }
let store = loadStore();
saveStore(); // persiste tout de suite une éventuelle migration

/* ---------- Progression par livre (partagée entre les chemins) ---------- */
function bookState(id) {
  if (!store.books[id]) store.books[id] = { read: new Array(BOOKS[id].nb).fill(false) };
  const st = store.books[id];
  if (!Array.isArray(st.read) || st.read.length !== BOOKS[id].nb) {
    const fixed = new Array(BOOKS[id].nb).fill(false);
    (Array.isArray(st.read) ? st.read : []).forEach((v, i) => { if (i < fixed.length) fixed[i] = !!v; });
    st.read = fixed;
  }
  return st;
}
const readCount = id => bookState(id).read.filter(Boolean).length;
const nextChapter = id => bookState(id).read.indexOf(false); // -1 = livre terminé

/* ---------- Le chemin actif ---------- */
const activePlan = () => store.plans.find(p => p.id === store.active) || null;
function planTotals(plan) {
  let nb = 0, lu = 0;
  plan.seq.forEach(id => { nb += BOOKS[id].nb; lu += readCount(id); });
  return { nb, lu };
}
/* Première étape non lue du chemin : { livre, ch } ou null si tout est lu. */
function planNext(plan) {
  for (const id of plan.seq) {
    const c = nextChapter(id);
    if (c !== -1) return { livre: id, ch: c };
  }
  return null;
}

/* ---------- Texte biblique (chargé à la demande, gardé en mémoire) ---------- */
const bookCache = {};
async function loadBook(id) {
  if (bookCache[id]) return bookCache[id];
  const r = await fetch('data/' + id + '.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('fetch ' + r.status);
  const d = await r.json();
  d.mots = d.chapitres.map(ch => ch.join(' ').split(/\s+/).length); // mots par chapitre
  bookCache[id] = d;
  return d;
}

/* ---------- Estimation douce (jamais contraignante, jamais de reproche) ----
   Toujours calculée VERS L'AVANT, à partir d'aujourd'hui et de ce qui reste :
   elle se recale d'elle-même, quoi qu'il se soit passé avant.
   Pour les livres pas encore téléchargés, on estime au prorata des chapitres
   restants (le total de mots par livre est connu d'avance). */
function restantMots(plan) {
  let mots = 0;
  plan.seq.forEach(id => {
    const st = bookState(id), b = BOOKS[id], cached = bookCache[id];
    if (cached) {
      cached.chapitres.forEach((ch, i) => { if (!st.read[i]) mots += cached.mots[i]; });
    } else {
      const restants = st.read.filter(r => !r).length;
      mots += Math.round(b.mots * restants / b.nb);
    }
  });
  return mots;
}
function estimation(plan) {
  if (!plan.minutes) return '';
  const mots = restantMots(plan);
  if (mots === 0) return '';
  const jours = Math.max(1, Math.ceil(mots / WORDS_PER_MIN / plan.minutes));
  const d = new Date(); d.setDate(d.getDate() + jours);
  const quand = jours <= 1 ? "dès aujourd'hui"
    : 'vers le ' + d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  return `À raison de ${plan.minutes} min par jour, tu peux arriver au bout ${quand}. Et si la vie en décide autrement, le chemin t'attend — simplement.`;
}

/* ============================================================================
   Navigation
   ========================================================================== */
let route = { name: 'home', param: null };
let readingLivre = null;   // livre ouvert en lecture
let currentBook = null;    // ses données une fois chargées
let loadError = false;
let expandedLivre = null;  // livre dont on montre le chemin de jalons
let draft = null;          // réponses du configurateur en cours

function go(name, param) { route = { name, param: param === undefined ? null : param }; render(); window.scrollTo(0, 0); }

function render() {
  const views = {
    cfgWhere: viewCfgWhere, cfgBook: viewCfgBook, cfgTime: viewCfgTime,
    cfgGoal: viewCfgGoal, home: viewHome,
    read: () => viewRead(route.param), chapterDone: () => viewChapterDone(route.param),
    bookDone: () => viewBookDone(route.param), planDone: viewPlanDone
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
   Le configurateur — trois questions, une par écran, sans pression.
   ========================================================================== */
function startConfig() {
  if (store.plans.length >= MAX_PLANS) { go('home'); return; }
  draft = { zone: null, livre: null, minutes: null };
  go('cfgWhere');
}

/* ---------- 1. Où veux-tu marcher ? ---------- */
function viewCfgWhere() {
  const first = store.plans.length === 0;
  const intro = first
    ? `<div class="card hero fade">
        <h1 class="hero-name">Un chemin, <span class="seed">pas un calendrier</span></h1>
        <p class="hero-tag">Ici, pas de dates : tu avances quand tu lis, à ton rythme. Aucun retard n'existe — le chemin t'attend, simplement.</p>
      </div>`
    : '';
  const opt = (zone, titre, sous) => `<button class="card plan-card fade" data-zone="${zone}">
      <div class="plan-name">${titre}</div>
      <div class="plan-why">${sous}</div>
    </button>`;
  return header() + intro + `
    <div class="cfg-step fade"><span class="cfg-dot on"></span><span class="cfg-dot"></span><span class="cfg-dot"></span></div>
    <h2 class="cfg-q fade">Où veux-tu marcher ?</h2>
    ${opt('NT', '✝️ Le Nouveau Testament', "La vie de Jésus, la naissance de l'Église, les lettres de Paul.")}
    ${opt('AT', "📜 L'Ancien Testament", 'Les origines, la grande libération, les psaumes, la sagesse.')}
    ${opt('LIVRE', '📖 Un livre précis', 'Tu sais déjà lequel — choisis-le dans la liste.')}
    ${first
      ? `<p class="muted center" style="font-size:.85rem;margin-top:10px">Texte : Louis Segond 1910 · rien ne quitte ton téléphone</p>`
      : `<button class="linklike" data-back-home="1">‹ Revenir à mon chemin</button>`}`;
}

/* ---------- 1 bis. Quel livre ? (si « un livre précis ») ---------- */
function viewCfgBook() {
  const group = (t, label) => {
    const rows = Object.values(BOOKS).filter(b => b.testament === t).map(b => {
      const n = readCount(b.id);
      const prog = n > 0 ? ` <span style="color:var(--grow)">· ${n} lu${n > 1 ? 's' : ''} 🌱</span>` : '';
      return `<button class="book-pick fade" data-book="${b.id}">
          <span class="book-pick-name">${esc(b.nom)}</span>
          <span class="book-pick-meta">${b.nb} ch.${prog}</span>
        </button>`;
    }).join('');
    return `<div class="card fade"><div class="book-group-label">${label}</div><div class="book-list">${rows}</div></div>`;
  };
  return header() + `
    <div class="cfg-step fade"><span class="cfg-dot on"></span><span class="cfg-dot"></span><span class="cfg-dot"></span></div>
    <h2 class="cfg-q fade">Quel livre veux-tu ouvrir ?</h2>
    ${group('AT', 'Ancien Testament')}
    ${group('NT', 'Nouveau Testament')}
    <button class="linklike" data-cfg-back="cfgWhere">‹ Revenir en arrière</button>`;
}

/* ---------- 2. Combien de temps par jour ? ---------- */
function viewCfgTime() {
  const pill = m => `<button class="pill${draft.minutes === m ? ' on' : ''}" data-min="${m}">${m} min</button>`;
  return header() + `
    <div class="cfg-step fade"><span class="cfg-dot done"></span><span class="cfg-dot on"></span><span class="cfg-dot"></span></div>
    <h2 class="cfg-q fade">Combien de temps peux-tu donner par jour ?</h2>
    <div class="card fade">
      <p class="muted" style="margin:0 0 14px">Cela sert seulement à te donner une idée de l'horizon — <b>jamais</b> à te mettre en retard. Rien ne t'y oblige.</p>
      <div class="pill-row" style="justify-content:center">${pill(5)}${pill(10)}${pill(15)}</div>
      <button class="btn btn-ghost btn-block" data-min="0" style="margin-top:14px">Je préfère avancer sans estimation</button>
    </div>
    <button class="linklike" data-cfg-back="${draft.zone === 'LIVRE' ? 'cfgBook' : 'cfgWhere'}">‹ Revenir en arrière</button>`;
}

/* ---------- 3. Quel est ton objectif ? ---------- */
function goalsFor(draft) {
  if (draft.zone === 'LIVRE') {
    const b = BOOKS[draft.livre];
    return [{
      id: 'livre:' + b.id, zone: draft.zone, nom: 'Lire ' + titreLivre(b.id), seq: [b.id],
      pourquoi: esc(b.contexte)
    }];
  }
  return OBJECTIFS.filter(o => o.zone === draft.zone);
}
function viewCfgGoal() {
  const goals = goalsFor(draft);
  const cards = goals.map(o => {
    const nbCh = o.seq.reduce((s, id) => s + BOOKS[id].nb, 0);
    const livres = o.seq.length === 1 ? titreLivre(o.seq[0])
      : o.seq.map(id => BOOKS[id].nom).join(' · ');
    return `<button class="card plan-card fade" data-goal="${o.id}">
        <div class="plan-name">${esc(o.nom)}</div>
        <div class="plan-meta">${esc(livres)} — ${nbCh} chapitre${nbCh > 1 ? 's' : ''}</div>
        <div class="plan-why">${o.pourquoi}</div>
      </button>`;
  }).join('');
  return header() + `
    <div class="cfg-step fade"><span class="cfg-dot done"></span><span class="cfg-dot done"></span><span class="cfg-dot on"></span></div>
    <h2 class="cfg-q fade">Quel est ton objectif ?</h2>
    ${cards}
    <button class="linklike" data-cfg-back="cfgTime">‹ Revenir en arrière</button>`;
}

function createPlan(goalId) {
  const o = goalsFor(draft).find(g => g.id === goalId);
  if (!o) return;
  const plan = { id: genId(), nom: o.nom, objectif: o.id, seq: o.seq.slice(), minutes: draft.minutes };
  store.plans.push(plan);
  store.active = plan.id;
  saveStore();
  draft = null;
  expandedLivre = null;
  go('home');
}

/* ============================================================================
   Écran principal : le chemin actif
   ========================================================================== */
function viewHome() {
  const plan = activePlan();
  if (!plan) {
    // aucun chemin : on ouvre le configurateur (sans re-rendu imbriqué)
    if (!draft) draft = { zone: null, livre: null, minutes: null };
    route = { name: 'cfgWhere', param: null };
    return viewCfgWhere();
  }

  const { nb, lu } = planTotals(plan);
  const next = planNext(plan);
  const multi = plan.seq.length > 1;

  /* ---- carte principale ---- */
  let main;
  if (!next) {
    main = `<div class="card hero fade">
      <div class="hero-emblem"><img src="../icon.svg" alt="" style="width:52px;height:52px"></div>
      <h1 class="hero-name" style="font-size:1.4rem">« ${esc(plan.nom)} », c'est accompli ✨</h1>
      <p class="hero-tag">Les ${nb} chapitres, du premier au dernier, à ton rythme. Tu peux relire quand tu veux, ou ouvrir un autre chemin.</p>
      ${store.plans.length < MAX_PLANS ? `<button class="btn btn-primary" data-new-plan="1" style="margin-top:18px">Ouvrir un nouveau chemin</button>` : ''}
    </div>`;
  } else {
    const B = BOOKS[next.livre];
    const label = (B.chapLabel || B.nom) + ' ' + (next.ch + 1);
    const sub = lu === 0
      ? `Le chemin commence ici — premier pas : ${esc(label)}.`
      : `Reprends là où tu t'es arrêté : ${esc(label)}.`;
    main = `<div class="card hero fade">
      <p class="hello">${esc(plan.nom)}</p>
      <h1 style="font-family:var(--serif);font-size:1.5rem;margin:6px 0 8px">${lu === 0 ? 'Bienvenue sur le chemin' : 'Reprends là où tu t’es arrêté'}</h1>
      <p class="muted" style="margin:0 0 18px">${sub}</p>
      <button class="btn btn-primary" data-read="${next.livre}:${next.ch}" style="font-size:1.15rem;padding:16px 20px">📖 Lire ${esc(label)}</button>
    </div>`;
  }

  /* ---- jauge globale + livres du chemin ---- */
  const est = estimation(plan);
  const open = expandedLivre && plan.seq.includes(expandedLivre) ? expandedLivre
    : (next ? next.livre : plan.seq[plan.seq.length - 1]);

  const bookRows = plan.seq.map(id => {
    const B = BOOKS[id], n = readCount(id), fini = n === B.nb;
    const isOpen = id === open;
    const path = isOpen ? `<div class="path">` + bookState(id).read.map((r, i) => {
      const isNext = next && next.livre === id && next.ch === i;
      const cls = r ? 'read' : (isNext ? 'next' : '');
      return `<button class="mile ${cls}" data-read="${id}:${i}" title="${esc((B.chapLabel || B.nom) + ' ' + (i + 1))}">${r ? '✓' : i + 1}</button>`;
    }).join('') + `</div>` : '';
    return `<div class="book-row${isOpen ? ' open' : ''}">
      <button class="book-head" data-expand="${id}">
        <span class="book-head-name">${fini ? '✓ ' : ''}${esc(B.nom)}</span>
        <span class="book-head-count${n > 0 ? ' grow' : ''}">${n} / ${B.nb}</span>
      </button>
      <div class="gauge mini"><i style="width:${Math.round(n / B.nb * 100)}%"></i></div>
      ${path}
    </div>`;
  }).join('');

  const gauge = `<div class="card fade">
    <div class="gauge-label"><span><b>${lu}</b> / ${nb} chapitres lus</span>
      ${lu > 0 ? `<span style="color:var(--grow);font-weight:650">🌱</span>` : ''}</div>
    <div class="gauge"><i style="width:${Math.round(lu / nb * 100)}%"></i></div>
    ${multi ? `<div class="book-rows">${bookRows}</div>`
            : `<div class="book-rows single">${bookRows}</div>`}
    ${est ? `<div class="soft-note">${est}</div>` : ''}
  </div>`;

  /* ---- contexte du livre en cours ---- */
  const ctxB = BOOKS[open];
  const ctx = `<div class="card fade"><div class="context-box" style="margin-top:0">
      <b>Contexte — ${esc(ctxB.nom)}.</b> ${esc(ctxB.contexte)}</div></div>`;

  /* ---- mes chemins (bascule + nouveau) ---- */
  const others = store.plans.filter(p => p.id !== plan.id);
  const switcher = `<div class="card fade">
    <div class="book-group-label">Mes chemins</div>
    <div class="plan-switch">
      ${store.plans.map(p => `<button class="pill${p.id === plan.id ? ' on' : ''}" data-switch="${p.id}">${esc(p.nom)}</button>`).join('')}
      ${store.plans.length < MAX_PLANS ? `<button class="pill add" data-new-plan="1">+ Nouveau chemin</button>` : ''}
    </div>
    ${others.length || store.plans.length < MAX_PLANS ? '' : ''}
    <button class="linklike" data-remove="${plan.id}" style="margin-top:8px">Ranger ce chemin (ta progression reste gardée)</button>
  </div>`;

  return header() + main + gauge + ctx + switcher;
}

/* ============================================================================
   Lecture d'un chapitre — param = { livre, ch }
   ========================================================================== */
function viewRead(p) {
  const B = BOOKS[p.livre], st = bookState(p.livre), ci = p.ch;
  const nomCh = (B.chapLabel || B.nom) + ' ' + (ci + 1);
  if (loadError) {
    return header() + `<div class="card center fade"><p>Le texte n'a pas pu être chargé pour l'instant.</p>
      <p class="muted">Vérifie ta connexion, puis réessaie — ta progression, elle, est bien gardée.</p>
      <button class="btn btn-soft btn-block" data-read="${p.livre}:${ci}">Réessayer</button></div>`;
  }
  if (!currentBook || readingLivre !== p.livre) return header() + `<p class="muted center" style="padding:40px">Chargement du texte…</p>`;

  const verses = currentBook.chapitres[ci];
  const body = verses.map((v, i) => `<span class="vnum">${i + 1}</span>${esc(v)}`).join(' ');
  const isRead = st.read[ci];

  const finish = isRead
    ? `<p class="already-read">Chapitre déjà lu 🌱</p>` +
      (ci + 1 < B.nb ? `<button class="btn btn-soft btn-block" data-read="${p.livre}:${ci + 1}">Chapitre suivant ›</button>` : '')
    : `<button class="btn btn-primary" data-finish="${p.livre}:${ci}">J'ai terminé ce chapitre</button>`;

  return `<div class="fade">
    <button class="back-link" data-back-home="1">‹ Mon chemin</button>
    <div class="chapter-head">
      <button class="chapter-nav" data-read="${p.livre}:${ci - 1}" ${ci === 0 ? 'disabled' : ''} aria-label="Chapitre précédent">‹</button>
      <h2>${esc(nomCh)}</h2>
      <button class="chapter-nav" data-read="${p.livre}:${ci + 1}" ${ci + 1 >= B.nb ? 'disabled' : ''} aria-label="Chapitre suivant">›</button>
    </div>
    <div class="card"><div class="scripture">${body}</div>
      <div class="ref" style="margin-top:18px">${esc(B.nom)} ${ci + 1} <span class="version">· Louis Segond 1910</span></div></div>
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
function viewChapterDone(p) {
  const B = BOOKS[p.livre], plan = activePlan();
  const nomCh = (B.chapLabel || B.nom) + ' ' + (p.ch + 1);
  const mot = BRAVOS[p.ch % BRAVOS.length];
  const n = readCount(p.livre);
  const tot = plan ? planTotals(plan) : null;
  const next = plan ? planNext(plan) : null;
  const nextLabel = next ? (BOOKS[next.livre].chapLabel || BOOKS[next.livre].nom) + ' ' + (next.ch + 1) : '';
  const planLine = plan && plan.seq.length > 1
    ? `<p style="font-weight:650;color:var(--grow);margin:14px 0 0">Sur ce chemin : ${tot.lu} chapitre${tot.lu > 1 ? 's' : ''} sur ${tot.nb} 🌱</p>
       <div class="gauge" style="margin-top:14px"><i style="width:${Math.round(tot.lu / tot.nb * 100)}%"></i></div>`
    : `<p style="font-weight:650;color:var(--grow);margin:14px 0 0">Tu as déjà lu ${n} chapitre${n > 1 ? 's' : ''} sur ${B.nb} 🌱</p>
       <div class="gauge" style="margin-top:14px"><i style="width:${Math.round(n / B.nb * 100)}%"></i></div>`;
  return header() + `<div class="celebrate card fade">
      <div class="seal">🌱</div>
      <h2>${esc(nomCh)}, c'est lu</h2>
      <p class="muted">${mot}</p>
      ${planLine}
    </div>
    ${next ? `<button class="btn btn-grow btn-block" data-read="${next.livre}:${next.ch}">Continuer avec ${esc(nextLabel)}</button>` : ''}
    <button class="btn btn-ghost btn-block" data-back-home="1" style="margin-top:10px">Ça suffit pour aujourd'hui</button>
    <p class="muted center" style="font-size:.88rem;margin-top:14px">Reviens quand tu veux — le chemin t'attendra, sans compter les jours.</p>`;
}

/* ---------- Fin d'un livre : célébration sobre ---------- */
function viewBookDone(livre) {
  const B = BOOKS[livre], plan = activePlan();
  const next = plan ? planNext(plan) : null;
  const sparks = [10, 30, 50, 70, 90].map((x, i) =>
    `<span style="left:${x}%;animation-delay:${i * 0.18}s">✨</span>`).join('');
  const suite = next
    ? `<button class="btn btn-grow btn-block" data-read="${next.livre}:${next.ch}" style="margin-top:6px">Continuer : ${esc(titreLivre(next.livre))}</button>`
    : '';
  return header() + `<div class="celebrate card fade">
      <div class="sparks">${sparks}</div>
      <div class="seal">✨</div>
      <h2>Tu viens de terminer ${esc(titreLivre(livre))}</h2>
      <p class="muted">${B.nb} chapitre${B.nb > 1 ? 's' : ''}, lu${B.nb > 1 ? 's' : ''} du premier au dernier, à ton rythme. C'est un beau chemin parcouru.</p>
      <div class="verse small">« La semence, c'est la parole de Dieu. »</div>
      <div class="ref">Luc 8.11</div>
    </div>
    ${suite}
    <button class="btn btn-ghost btn-block" data-back-home="1" style="margin-top:10px">Revenir à mon chemin</button>`;
}

/* ---------- Fin de l'OBJECTIF : la grande célébration sobre ---------- */
function viewPlanDone() {
  const plan = activePlan();
  const { nb } = planTotals(plan);
  const livres = plan.seq.map(id => BOOKS[id].nom).join(', ');
  const sparks = [6, 22, 38, 54, 70, 86].map((x, i) =>
    `<span style="left:${x}%;animation-delay:${i * 0.15}s">✨</span>`).join('');
  return header() + `<div class="celebrate card fade">
      <div class="sparks">${sparks}</div>
      <div class="seal">🌾</div>
      <h2>Objectif accompli : ${esc(plan.nom)}</h2>
      <p class="muted">${plan.seq.length > 1 ? `${plan.seq.length} livres (${esc(livres)}), soit ` : ''}${nb} chapitre${nb > 1 ? 's' : ''}, du premier au dernier, à ton rythme. La graine a poussé.</p>
      <div class="verse small">« La semence, c'est la parole de Dieu. »</div>
      <div class="ref">Luc 8.11</div>
    </div>
    ${store.plans.length < MAX_PLANS ? `<button class="btn btn-grow btn-block" data-new-plan="1" style="margin-top:6px">Ouvrir un nouveau chemin</button>` : ''}
    <button class="btn btn-ghost btn-block" data-back-home="1" style="margin-top:10px">Revenir à mon chemin</button>`;
}

/* ============================================================================
   Actions
   ========================================================================== */
function ensureBook(livre) {
  if (currentBook && readingLivre === livre && bookCache[livre]) return;
  loadBook(livre)
    .then(b => {
      currentBook = b; loadError = false;
      render();
    })
    .catch(() => { loadError = true; render(); });
}
function openChapter(livre, ci) {
  const B = BOOKS[livre];
  if (!B || ci < 0 || ci >= B.nb) return;
  loadError = false;
  readingLivre = livre;
  currentBook = bookCache[livre] || null;
  go('read', { livre, ch: ci });
  ensureBook(livre);
}
function finishChapter(livre, ci) {
  const st = bookState(livre);
  if (!st.read[ci]) { st.read[ci] = true; saveStore(); }
  const plan = activePlan();
  const livreFini = nextChapter(livre) === -1;
  if (plan && !planNext(plan)) go('planDone');
  else if (livreFini) go('bookDone', livre);
  else go('chapterDone', { livre, ch: ci });
}
function switchPlan(id) {
  if (!store.plans.some(p => p.id === id)) return;
  store.active = id; saveStore();
  expandedLivre = null;
  go('home');
}
function removePlan(id) {
  const p = store.plans.find(x => x.id === id);
  if (!p) return;
  const ok = window.confirm(`Ranger le chemin « ${p.nom} » ? Ta progression de lecture reste gardée, livre par livre.`);
  if (!ok) return;
  store.plans = store.plans.filter(x => x.id !== id);
  if (store.active === id) store.active = store.plans.length ? store.plans[0].id : null;
  saveStore();
  go('home');
}

/* ============================================================================
   Interactions
   ========================================================================== */
function wire() {
  const on = (sel, fn) => el.querySelectorAll(sel).forEach(b => b.addEventListener('click', fn));
  /* configurateur */
  on('[data-zone]', e => {
    draft = draft || { zone: null, livre: null, minutes: null };
    draft.zone = e.currentTarget.dataset.zone;
    go(draft.zone === 'LIVRE' ? 'cfgBook' : 'cfgTime');
  });
  on('[data-book]', e => { draft.livre = e.currentTarget.dataset.book; go('cfgTime'); });
  on('[data-min]', e => { draft.minutes = +e.currentTarget.dataset.min; go('cfgGoal'); });
  on('[data-goal]', e => createPlan(e.currentTarget.dataset.goal));
  on('[data-cfg-back]', e => go(e.currentTarget.dataset.cfgBack));
  on('[data-new-plan]', startConfig);
  /* chemin */
  on('[data-read]', e => {
    const [livre, ci] = e.currentTarget.dataset.read.split(':');
    openChapter(livre, +ci);
  });
  on('[data-finish]', e => {
    const [livre, ci] = e.currentTarget.dataset.finish.split(':');
    finishChapter(livre, +ci);
  });
  on('[data-expand]', e => { expandedLivre = e.currentTarget.dataset.expand; render(); });
  on('[data-switch]', e => switchPlan(e.currentTarget.dataset.switch));
  on('[data-remove]', e => removePlan(e.currentTarget.dataset.remove));
  on('[data-back-home]', () => go('home'));
}

/* ============================================================================
   Démarrage
   ========================================================================== */
(function init() {
  if (!activePlan()) {
    if (store.plans.length) { store.active = store.plans[0].id; saveStore(); go('home'); }
    else startConfig();
  } else {
    go('home');
  }
})();
