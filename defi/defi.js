/* ============================================================================
   Graine de Parole — module « Défi » : connaissance des récits bibliques.

   Principes :
   - Questions strictement factuelles (qui, quoi, où, quand) ; jamais
     d'interprétation. Après chaque réponse, la référence biblique s'affiche :
     le défi ramène toujours vers le texte.
   - « Défi du jour » : dix questions identiques pour tous pendant la journée
     (tirage déterministe à partir de la date), pour pouvoir en parler autour
     de soi. « Défi libre » : au choix, par catégorie et par niveau.
   - Tout est local (localStorage). Pas de classement : on s'encourage,
     on ne se compare pas.
   ========================================================================== */

'use strict';

const STORE_KEY = 'graine.defi.v1';
const NB_QUESTIONS = 10;

const NIVEAUX = { 1: 'Découverte', 2: 'Habitué', 3: 'Connaisseur' };

/* ---------- Aides ---------- */
const el = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function dateISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dateHumaine() {
  return new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

/* Générateur pseudo-aléatoire déterministe (graine dérivée de la date) :
   deux personnes qui relèvent le défi du jour reçoivent les mêmes questions. */
function graineDepuis(txt) {
  let h = 1779033703 ^ txt.length;
  for (let i = 0; i < txt.length; i++) {
    h = Math.imul(h ^ txt.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function rngSeme(seedTxt) {
  let a = graineDepuis(seedTxt)();
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function melange(arr, rnd) {
  const r = arr.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/* ---------- Stockage local ---------- */
function loadStore() {
  try { const r = localStorage.getItem(STORE_KEY); if (r) return JSON.parse(r); } catch (e) {}
  return {
    defis: 0,               // défis relevés (menés jusqu'au bout)
    serie: 0,               // bonnes réponses d'affilée (en cours)
    meilleureSerie: 0,      // record de bonnes réponses d'affilée
    cats: {},               // { catégorie: { ok, total } }
    jour: null              // { date, score, total } — dernier défi du jour relevé
  };
}
function saveStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {} }
let store = loadStore();

/* ---------- Banque de questions ---------- */
let BANQUE = [];      // toutes les questions
let CATEGORIES = [];  // ordre d'affichage des catégories

async function chargerBanque() {
  const d = await (await fetch('data/questions.json', { cache: 'no-cache' })).json();
  BANQUE = d.questions || [];
  CATEGORIES = d.categories || [...new Set(BANQUE.map(q => q.categorie))];
}

/* ---------- Sélection des questions ---------- */
function tirage(mode, filtres) {
  let pool = BANQUE;
  let rnd;
  if (mode === 'jour') {
    rnd = rngSeme('graine-defi-' + dateISO());
  } else {
    rnd = rngSeme('libre-' + Date.now() + '-' + Math.random());
    if (filtres.categorie) pool = pool.filter(q => q.categorie === filtres.categorie);
    if (filtres.niveau) pool = pool.filter(q => q.niveau === filtres.niveau);
  }
  const choisies = melange(pool, rnd).slice(0, NB_QUESTIONS);
  // L'ordre des 4 réponses est lui aussi mélangé (déterministe pour le défi du jour).
  return choisies.map(q => {
    const ordre = melange([0, 1, 2, 3], rnd);
    return { q, ordre, bonnePos: ordre.indexOf(q.bonne) };
  });
}

/* ---------- État de l'écran ---------- */
let vue = { ecran: 'accueil' };
let filtresLibre = { categorie: null, niveau: null };

function demarrer(mode) {
  const items = tirage(mode, filtresLibre);
  if (!items.length) return;
  vue = {
    ecran: 'question',
    mode,
    items,
    index: 0,
    score: 0,
    repondu: null,     // position choisie pour la question en cours (null = pas encore)
    ratees: []         // questions manquées, pour le récapitulatif
  };
  render();
}

function repondre(pos) {
  if (vue.repondu !== null) return;
  const item = vue.items[vue.index];
  const ok = pos === item.bonnePos;
  vue.repondu = pos;
  if (ok) {
    vue.score++;
    store.serie++;
    if (store.serie > store.meilleureSerie) store.meilleureSerie = store.serie;
  } else {
    store.serie = 0;
    vue.ratees.push(item.q);
  }
  const c = store.cats[item.q.categorie] || (store.cats[item.q.categorie] = { ok: 0, total: 0 });
  c.total++; if (ok) c.ok++;
  saveStore();
  render();
}

function suivante() {
  if (vue.index + 1 < vue.items.length) {
    vue.index++;
    vue.repondu = null;
    render();
  } else {
    terminer();
  }
}

function terminer() {
  store.defis++;
  if (vue.mode === 'jour') {
    store.jour = { date: dateISO(), score: vue.score, total: vue.items.length };
  }
  saveStore();
  vue.ecran = 'fin';
  render();
}

/* ---------- Phrases d'encouragement (sobres, jamais culpabilisantes) ---------- */
const MOTS_FIN = {
  parfait: [
    'Sans faute. La Parole habite en toi — continue de la sonder.',
    'Tout est juste. Que cette connaissance nourrisse aussi le cœur.'
  ],
  haut: [
    'Belle connaissance du texte. Les références ci-dessous complèteront le tableau.',
    'Tu connais bien les récits. Encore un pas, et tout y sera.'
  ],
  milieu: [
    'Un bon parcours. Chaque référence ci-dessous est une porte ouverte vers le texte.',
    'Tu avances. Relire les passages manqués, c’est déjà relever le prochain défi.'
  ],
  depart: [
    'Chaque question est une occasion d’ouvrir la Bible. Les références ci-dessous t’attendent.',
    'L’essentiel n’est pas le score : c’est le chemin vers le texte. Les passages ci-dessous sont un bon début.'
  ]
};
function motDeFin(score, total) {
  const r = score / total;
  const liste = r === 1 ? MOTS_FIN.parfait : r >= 0.7 ? MOTS_FIN.haut : r >= 0.4 ? MOTS_FIN.milieu : MOTS_FIN.depart;
  return liste[store.defis % liste.length];
}

/* ---------- Statistiques locales ---------- */
function categorieForte() {
  let meilleure = null;
  for (const [cat, c] of Object.entries(store.cats)) {
    if (c.total < 5) continue; // on attend un minimum de questions pour se prononcer
    const taux = c.ok / c.total;
    if (!meilleure || taux > meilleure.taux) meilleure = { cat, taux };
  }
  return meilleure;
}

/* ============================================================================
   Rendu
   ========================================================================== */
function render() {
  if (vue.ecran === 'question') return renderQuestion();
  if (vue.ecran === 'fin') return renderFin();
  renderAccueil();
}

function renderAccueil() {
  const jourFait = store.jour && store.jour.date === dateISO();
  const forte = categorieForte();

  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-retour-accueil">‹ Accueil</button>
    <div class="topbar">
      <div class="brand">
        <h1 class="app-title">Défi <span class="seed">•</span> <span class="muted">connaissance biblique</span></h1>
      </div>
    </div>

    <div class="card hero">
      <h2 style="font-family:var(--serif)">Défi du jour</h2>
      <p class="defi-lead">Dix questions, les mêmes pour tous aujourd'hui (${esc(dateHumaine())}). De quoi en parler autour de toi.</p>
      ${jourFait ? `<p class="defi-day-note">Déjà relevé aujourd'hui : ${store.jour.score}/${store.jour.total}. Tu peux le refaire, ou revenir demain.</p>` : ''}
      <div class="defi-actions">
        <button class="btn btn-primary" id="btn-jour">${jourFait ? 'Relever à nouveau' : 'Relever le défi du jour'}</button>
      </div>
    </div>

    <div class="card">
      <h2 style="font-family:var(--serif)">Défi libre</h2>
      <p class="defi-lead">Choisis une catégorie et un niveau, ou laisse tout ouvert.</p>
      <div class="defi-filters">
        <label class="lbl">Catégorie</label>
        <div class="pill-row" id="pills-cat">
          <button class="pill ${filtresLibre.categorie === null ? 'on' : ''}" data-cat="">Toutes</button>
          ${CATEGORIES.map(c => `<button class="pill ${filtresLibre.categorie === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
        <label class="lbl">Niveau</label>
        <div class="pill-row" id="pills-niv">
          <button class="pill ${filtresLibre.niveau === null ? 'on' : ''}" data-niv="">Tous</button>
          ${[1, 2, 3].map(n => `<button class="pill ${filtresLibre.niveau === n ? 'on' : ''}" data-niv="${n}">${NIVEAUX[n]}</button>`).join('')}
        </div>
      </div>
      <div class="defi-actions">
        <button class="btn btn-grow btn-block" id="btn-libre">Relever un défi libre</button>
      </div>
    </div>

    ${store.defis > 0 ? `
    <div class="section-title">Ton chemin</div>
    <div class="card">
      <div class="defi-stats">
        <div class="defi-stat"><div class="n">${store.defis}</div><div class="l">défi${store.defis > 1 ? 's' : ''} relevé${store.defis > 1 ? 's' : ''}</div></div>
        <div class="defi-stat"><div class="n">${store.meilleureSerie}</div><div class="l">meilleure série de bonnes réponses</div></div>
        ${forte ? `<div class="defi-stat wide"><div class="n">${esc(forte.cat)}</div><div class="l">ta catégorie la plus forte (${Math.round(forte.taux * 100)}% de bonnes réponses)</div></div>` : ''}
      </div>
    </div>` : ''}
  </div>`;

  document.getElementById('btn-retour-accueil').onclick = () => { location.href = '../index.html'; };
  document.getElementById('btn-jour').onclick = () => demarrer('jour');
  document.getElementById('btn-libre').onclick = () => demarrer('libre');
  document.querySelectorAll('#pills-cat .pill').forEach(b => {
    b.onclick = () => { filtresLibre.categorie = b.dataset.cat || null; renderAccueil(); };
  });
  document.querySelectorAll('#pills-niv .pill').forEach(b => {
    b.onclick = () => { filtresLibre.niveau = b.dataset.niv ? Number(b.dataset.niv) : null; renderAccueil(); };
  });
}

function renderQuestion() {
  const item = vue.items[vue.index];
  const q = item.q;
  const total = vue.items.length;
  const num = vue.index + 1;
  const repondu = vue.repondu !== null;
  const derniere = vue.index + 1 >= total;

  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-quitter">‹ Quitter le défi</button>
    <div class="defi-meta">
      <span>Question ${num}/${total}</span>
      <span>${esc(q.categorie)} · ${NIVEAUX[q.niveau] || ''}</span>
    </div>
    <div class="defi-progress"><i style="width:${Math.round(((num - (repondu ? 0 : 1)) / total) * 100)}%"></i></div>

    <div class="card">
      <p class="defi-question">${esc(q.question)}</p>
      <div id="options">
        ${item.ordre.map((idxOpt, pos) => {
          let cls = 'defi-option';
          if (repondu) {
            if (pos === item.bonnePos) cls += ' good';
            else if (pos === vue.repondu) cls += ' bad';
            else cls += ' dim';
          }
          return `<button class="${cls}" data-pos="${pos}" ${repondu ? 'disabled' : ''}>${esc(q.options[idxOpt])}</button>`;
        }).join('')}
      </div>
      ${repondu ? `
        <p class="defi-ref-line"><span class="arrow">→</span>${esc(q.reference)} <span class="muted">· à retrouver dans ta Bible</span></p>
        <button class="btn btn-primary" id="btn-suivante">${derniere ? 'Voir le résultat' : 'Question suivante'}</button>
      ` : ''}
    </div>
  </div>`;

  document.getElementById('btn-quitter').onclick = () => { vue = { ecran: 'accueil' }; render(); };
  if (!repondu) {
    document.querySelectorAll('#options .defi-option').forEach(b => {
      b.onclick = () => repondre(Number(b.dataset.pos));
    });
  } else {
    document.getElementById('btn-suivante').onclick = suivante;
  }
}

function renderFin() {
  const total = vue.items.length;
  el.innerHTML = `
  <div class="fade">
    <div class="card hero done-screen">
      <div class="seal">🌾</div>
      <div class="defi-score">${vue.score}<span class="of">/${total}</span></div>
      <p class="defi-word">${esc(motDeFin(vue.score, total))}</p>
    </div>

    ${vue.ratees.length ? `
    <div class="section-title">Pour retourner au texte</div>
    <div class="card">
      ${vue.ratees.map(q => `
        <div class="defi-missed">
          <div class="q">${esc(q.question)}</div>
          <div class="a">Réponse : ${esc(q.options[q.bonne])}</div>
          <div class="r">→ ${esc(q.reference)}</div>
        </div>`).join('')}
    </div>` : ''}

    <div class="defi-actions">
      <button class="btn btn-grow btn-block" id="btn-recommencer">Recommencer</button>
      <button class="btn btn-ghost btn-block" id="btn-retour">Retour</button>
    </div>
  </div>`;

  document.getElementById('btn-recommencer').onclick = () => demarrer(vue.mode);
  document.getElementById('btn-retour').onclick = () => { vue = { ecran: 'accueil' }; render(); };
}

/* ---------- Démarrage ---------- */
(async function init() {
  try {
    await chargerBanque();
    render();
  } catch (e) {
    el.innerHTML = `
    <div class="card">
      <p class="defi-lead">Les questions n'ont pas pu être chargées. Vérifie ta connexion, puis réessaie.</p>
      <div class="defi-actions"><button class="btn btn-ghost btn-block" onclick="location.reload()">Réessayer</button></div>
    </div>`;
  }
})();
