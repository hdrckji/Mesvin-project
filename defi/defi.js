/* ============================================================================
   Graine de Parole — module « Défi » : connaissance des récits bibliques.

   Principes :
   - Questions strictement factuelles (qui, quoi, où, quand) ; jamais
     d'interprétation. Après chaque réponse, la référence biblique s'affiche :
     le défi ramène toujours vers le texte.
   - « Défi du jour » : dix questions identiques pour tous pendant la journée
     (tirage déterministe à partir de la date), pour pouvoir en parler autour
     de soi. « Défi libre » : au choix, par catégorie et par niveau.
   - « À plusieurs » : sur un même appareil, en famille ou en groupe.
     Compétitif (chacun son tour, tirage équitable, classement bienveillant)
     ou coopératif (une réponse commune, un objectif d'équipe — esprit veillée).
   - Tout est local (localStorage). Les statistiques personnelles ne comptent
     que le solo ; les épreuves à plusieurs ont leur propre petit compteur.
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
  let s = null;
  try { const r = localStorage.getItem(STORE_KEY); if (r) s = JSON.parse(r); } catch (e) {}
  if (!s) s = {
    defis: 0,               // défis solo relevés (menés jusqu'au bout)
    serie: 0,               // bonnes réponses d'affilée (en cours, solo)
    meilleureSerie: 0,      // record de bonnes réponses d'affilée (solo)
    cats: {},               // { catégorie: { ok, total } } — solo uniquement
    jour: null              // { date, score, total } — dernier défi du jour relevé
  };
  // Épreuves à plusieurs : prénoms retenus + petit compteur (séparé des stats solo).
  if (!s.groupe) s.groupe = { prenoms: [], relevees: 0 };
  return s;
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
function poolFiltre(filtres) {
  let pool = BANQUE;
  if (filtres.categorie) pool = pool.filter(q => q.categorie === filtres.categorie);
  if (filtres.niveau) pool = pool.filter(q => q.niveau === filtres.niveau);
  return pool;
}
/* Une question « habillée » : ordre des 4 options mélangé. */
function habille(q, rnd) {
  const ordre = melange([0, 1, 2, 3], rnd);
  return { q, ordre, bonnePos: ordre.indexOf(q.bonne) };
}

function tirage(mode, filtres) {
  let pool = BANQUE;
  let rnd;
  if (mode === 'jour') {
    rnd = rngSeme('graine-defi-' + dateISO());
  } else {
    rnd = rngSeme('libre-' + Date.now() + '-' + Math.random());
    pool = poolFiltre(filtres);
  }
  // L'ordre des 4 réponses est lui aussi mélangé (déterministe pour le défi du jour).
  return melange(pool, rnd).slice(0, NB_QUESTIONS).map(q => habille(q, rnd));
}

/* Tirage équitable pour le compétitif : les manches sont construites niveau
   par niveau — à chaque manche, chaque participant reçoit une question du
   MÊME niveau (des questions différentes, mais une difficulté identique).
   La difficulté monte doucement au fil des manches. */
function manchesDisponibles(filtres, nb) {
  const parNiveau = {};
  poolFiltre(filtres).forEach(q => { (parNiveau[q.niveau] = parNiveau[q.niveau] || []).push(q); });
  let total = 0;
  for (const n of Object.keys(parNiveau)) total += Math.floor(parNiveau[n].length / nb);
  return total;
}
function tirageCompet(filtres, nb, parTete) {
  const rnd = rngSeme('plusieurs-' + Date.now() + '-' + Math.random());
  const parNiveau = {};
  melange(poolFiltre(filtres), rnd).forEach(q => { (parNiveau[q.niveau] = parNiveau[q.niveau] || []).push(q); });
  const niveaux = Object.keys(parNiveau).map(Number).sort((a, b) => a - b);
  // Chaque niveau apporte autant de manches complètes qu'il peut en fournir.
  const dispo = [];
  for (const n of niveaux) {
    for (let i = 0; i < Math.floor(parNiveau[n].length / nb); i++) dispo.push(n);
  }
  const manches = Math.min(parTete, dispo.length);
  const tours = [];
  for (let i = 0; i < manches; i++) {
    // Échantillonnage régulier dans la liste triée : mélange de niveaux
    // proportionné à la banque, du plus simple au plus exigeant.
    const niveau = dispo[Math.floor((i + 0.5) * dispo.length / manches)];
    for (let p = 0; p < nb; p++) tours.push({ p, manche: i + 1, ...habille(parNiveau[niveau].pop(), rnd) });
  }
  return { tours, manches };
}
function tirageCoop(filtres, n) {
  const rnd = rngSeme('coop-' + Date.now() + '-' + Math.random());
  return melange(poolFiltre(filtres), rnd).slice(0, n).map(q => habille(q, rnd));
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

/* ---------- Statistiques locales (solo uniquement) ---------- */
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
   À plusieurs — préparation et déroulement (sur un même appareil)
   ========================================================================== */

/* Préparation : choix retenus le temps de la visite (prénoms : localStorage). */
let prepa = {
  mode: 'compet',           // 'compet' | 'coop'
  nb: Math.min(Math.max(store.groupe.prenoms.length, 2), 6),
  noms: store.groupe.prenoms.slice(),
  categorie: null,
  niveau: null,
  longueur: null            // null = valeur conseillée selon le mode et le nombre
};
let m = null; // épreuve à plusieurs en cours

function longueurConseillee() {
  if (prepa.mode === 'coop') return NB_QUESTIONS;
  return prepa.nb <= 3 ? NB_QUESTIONS : 5; // à 4-6, cinq questions chacun suffisent (≤ ~15 min)
}
function longueurEffective() {
  const filtres = { categorie: prepa.categorie, niveau: prepa.niveau };
  const voulu = prepa.longueur || longueurConseillee();
  const maxi = prepa.mode === 'compet'
    ? manchesDisponibles(filtres, prepa.nb)
    : poolFiltre(filtres).length;
  return { voulu, possible: Math.min(voulu, maxi), maxi };
}
function nomsPropres() {
  const noms = [];
  for (let i = 0; i < prepa.nb; i++) {
    const n = (prepa.noms[i] || '').trim();
    noms.push(n || `Participant ${i + 1}`);
  }
  return noms;
}

function demarrerMulti() {
  const filtres = { categorie: prepa.categorie, niveau: prepa.niveau };
  const L = longueurEffective();
  if (!L.possible) return;
  const noms = nomsPropres();
  // On retient les prénoms pour la prochaine fois.
  store.groupe.prenoms = noms.slice();
  saveStore();

  if (prepa.mode === 'compet') {
    const { tours, manches } = tirageCompet(filtres, prepa.nb, L.possible);
    m = {
      mode: 'compet', noms, nb: prepa.nb, manches, tours, t: 0, repondu: null,
      scores: noms.map(() => 0),
      ratees: noms.map(() => [])
    };
    vue = { ecran: 'relais' };
  } else {
    const items = tirageCoop(filtres, L.possible);
    m = {
      mode: 'coop', noms, items, index: 0, repondu: null,
      score: 0, ratees: [],
      objectif: Math.ceil(items.length * 0.75) // « Ensemble, atteignez 8/10 »
    };
    vue = { ecran: 'objectif' };
  }
  render();
}

function repondreMulti(pos) {
  if (m.repondu !== null) return;
  m.repondu = pos;
  if (m.mode === 'compet') {
    const tour = m.tours[m.t];
    if (pos === tour.bonnePos) m.scores[tour.p]++;
    else m.ratees[tour.p].push(tour.q);
  } else {
    const item = m.items[m.index];
    if (pos === item.bonnePos) m.score++;
    else m.ratees.push(item.q);
  }
  render(); // rien n'est écrit dans les stats solo
}

function suivanteMulti() {
  m.repondu = null;
  if (m.mode === 'compet') {
    m.t++;
    if (m.t < m.tours.length) { vue.ecran = 'relais'; }
    else { terminerMulti(); return; }
  } else {
    m.index++;
    if (m.index >= m.items.length) { terminerMulti(); return; }
  }
  render();
}

function terminerMulti() {
  store.groupe.relevees++;
  saveStore();
  vue = { ecran: 'mfin' };
  render();
}

function quitterMulti() {
  m = null;
  vue = { ecran: 'prepa' };
  render();
}

/* Classement bienveillant : égalités partagées (ex aequo), pas de « perdant ». */
function classement() {
  const rows = m.noms.map((nom, i) => ({ nom, i, score: m.scores[i] }))
    .sort((a, b) => b.score - a.score);
  let prev = null, rang = 0;
  rows.forEach((r, idx) => {
    if (r.score !== prev) { rang = idx + 1; prev = r.score; }
    r.rang = rang;
  });
  rows.forEach(r => { r.exaequo = rows.filter(o => o.rang === r.rang).length > 1; });
  return rows;
}
function rangLabel(r) { return r === 1 ? '1ᵉʳ' : `${r}ᵉ`; }

/* ============================================================================
   Rendu
   ========================================================================== */
function render() {
  if (vue.ecran === 'solo') return renderSolo();
  if (vue.ecran === 'question') return renderQuestion();
  if (vue.ecran === 'fin') return renderFin();
  if (vue.ecran === 'prepa') return renderPrepa();
  if (vue.ecran === 'relais') return renderRelais();
  if (vue.ecran === 'objectif') return renderObjectif();
  if (vue.ecran === 'mquestion') return renderQuestionMulti();
  if (vue.ecran === 'mfin') return m.mode === 'compet' ? renderFinCompet() : renderFinCoop();
  renderAccueil();
}

/* ---------- Accueil du module : seul ou à plusieurs ---------- */
function renderAccueil() {
  const g = store.groupe;
  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-retour-accueil">‹ Accueil</button>
    <div class="topbar">
      <div class="brand">
        <h1 class="app-title">Défi <span class="seed">•</span> <span class="muted">seul ou à plusieurs</span></h1>
      </div>
    </div>

    <p class="defi-lead" style="margin:0 4px 16px">Des questions sur les récits de la Bible, et pour chacune la référence pour retourner au texte.</p>

    <button class="card hub-card" id="btn-seul">
      <span class="hub-ic">🌱</span>
      <span class="hub-txt">
        <span class="hub-title">Seul</span>
        <span class="hub-sub">Défi du jour, défi libre, et ton chemin personnel.</span>
      </span>
      <span class="chev">›</span>
    </button>

    <button class="card hub-card" id="btn-plusieurs">
      <span class="hub-ic">🕯️</span>
      <span class="hub-txt">
        <span class="hub-title">À plusieurs</span>
        <span class="hub-sub">Sur un même appareil, en famille ou en groupe : compétitif ou coopératif.${g.relevees > 0 ? ` <b class="grp-count">${g.relevees} épreuve${g.relevees > 1 ? 's' : ''} relevée${g.relevees > 1 ? 's' : ''} ensemble</b>` : ''}</span>
      </span>
      <span class="chev">›</span>
    </button>
  </div>`;

  document.getElementById('btn-retour-accueil').onclick = () => { location.href = '../index.html'; };
  document.getElementById('btn-seul').onclick = () => { vue = { ecran: 'solo' }; render(); };
  document.getElementById('btn-plusieurs').onclick = () => { vue = { ecran: 'prepa' }; render(); };
}

/* ---------- Seul : défi du jour, défi libre, chemin ---------- */
function renderSolo() {
  const jourFait = store.jour && store.jour.date === dateISO();
  const forte = categorieForte();

  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-retour-defi">‹ Défi</button>
    <div class="topbar">
      <div class="brand">
        <h1 class="app-title">Seul <span class="seed">•</span> <span class="muted">connaissance biblique</span></h1>
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

  document.getElementById('btn-retour-defi').onclick = () => { vue = { ecran: 'accueil' }; render(); };
  document.getElementById('btn-jour').onclick = () => demarrer('jour');
  document.getElementById('btn-libre').onclick = () => demarrer('libre');
  document.querySelectorAll('#pills-cat .pill').forEach(b => {
    b.onclick = () => { filtresLibre.categorie = b.dataset.cat || null; renderSolo(); };
  });
  document.querySelectorAll('#pills-niv .pill').forEach(b => {
    b.onclick = () => { filtresLibre.niveau = b.dataset.niv ? Number(b.dataset.niv) : null; renderSolo(); };
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

  document.getElementById('btn-quitter').onclick = () => { vue = { ecran: 'solo' }; render(); };
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
  document.getElementById('btn-retour').onclick = () => { vue = { ecran: 'solo' }; render(); };
}

/* ---------- À plusieurs : préparation ---------- */
function renderPrepa() {
  const L = longueurEffective();
  const conseil = longueurConseillee();
  const totalQuestions = prepa.mode === 'compet' ? L.possible * prepa.nb : L.possible;
  const minutes = Math.max(2, Math.round(totalQuestions * 25 / 60)); // ~25 s par question, échanges compris

  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-retour-defi">‹ Défi</button>
    <div class="topbar">
      <div class="brand">
        <h1 class="app-title">À plusieurs <span class="seed">•</span> <span class="muted">sur un même appareil</span></h1>
      </div>
    </div>

    <div class="card">
      <div class="mode-choice">
        <button class="mode-card ${prepa.mode === 'compet' ? 'on' : ''}" id="mode-compet">
          <b>Compétitif</b>
          <span class="d">Chacun répond à son tour ; on se passe l'appareil, classement bienveillant à la fin.</span>
        </button>
        <button class="mode-card ${prepa.mode === 'coop' ? 'on' : ''}" id="mode-coop">
          <b>Coopératif</b>
          <span class="d">On discute et on donne une seule réponse commune ; un objectif d'équipe à atteindre ensemble.</span>
        </button>
      </div>

      <label class="lbl">Participants</label>
      <div class="pill-row" id="pills-nb">
        ${[2, 3, 4, 5, 6].map(n => `<button class="pill ${prepa.nb === n ? 'on' : ''}" data-nb="${n}">${n}</button>`).join('')}
      </div>
      <div class="noms-grid" id="noms">
        ${Array.from({ length: prepa.nb }, (_, i) => `
          <input class="field" type="text" maxlength="20" autocomplete="off"
                 placeholder="Prénom ${i + 1}" data-i="${i}" value="${esc(prepa.noms[i] || '')}" />`).join('')}
      </div>

      <label class="lbl">Catégorie</label>
      <div class="pill-row" id="pills-mcat">
        <button class="pill ${prepa.categorie === null ? 'on' : ''}" data-cat="">Toutes</button>
        ${CATEGORIES.map(c => `<button class="pill ${prepa.categorie === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      <label class="lbl">Niveau</label>
      <div class="pill-row" id="pills-mniv">
        <button class="pill ${prepa.niveau === null ? 'on' : ''}" data-niv="">Tous</button>
        ${[1, 2, 3].map(n => `<button class="pill ${prepa.niveau === n ? 'on' : ''}" data-niv="${n}">${NIVEAUX[n]}</button>`).join('')}
      </div>

      <label class="lbl">Longueur</label>
      <div class="pill-row" id="pills-long">
        ${[5, 10].map(n => `<button class="pill ${(prepa.longueur || conseil) === n ? 'on' : ''}" data-long="${n}">${n} question${n > 1 ? 's' : ''}${prepa.mode === 'compet' ? ' chacun' : ''}</button>`).join('')}
      </div>

      <p class="prepa-note">
        ${L.possible
          ? `${prepa.mode === 'compet'
              ? `${L.possible} question${L.possible > 1 ? 's' : ''} par participant, même difficulté pour tous`
              : `${L.possible} question${L.possible > 1 ? 's' : ''} à décider ensemble`} · ≈ ${minutes} min.`
          : `Pas assez de questions avec ces choix — élargis la catégorie ou le niveau.`}
        ${L.possible && L.possible < L.voulu ? ` (La banque limite à ${L.maxi} avec ces choix.)` : ''}
      </p>

      <div class="defi-actions">
        <button class="btn btn-primary" id="btn-demarrer" ${L.possible ? '' : 'disabled'}>Relever l'épreuve</button>
      </div>
    </div>
  </div>`;

  document.getElementById('btn-retour-defi').onclick = () => { vue = { ecran: 'accueil' }; render(); };
  document.getElementById('mode-compet').onclick = () => { prepa.mode = 'compet'; renderPrepa(); };
  document.getElementById('mode-coop').onclick = () => { prepa.mode = 'coop'; renderPrepa(); };
  document.querySelectorAll('#pills-nb .pill').forEach(b => {
    b.onclick = () => { prepa.nb = Number(b.dataset.nb); renderPrepa(); };
  });
  document.querySelectorAll('#noms .field').forEach(inp => {
    inp.oninput = () => { prepa.noms[Number(inp.dataset.i)] = inp.value; };
  });
  document.querySelectorAll('#pills-mcat .pill').forEach(b => {
    b.onclick = () => { prepa.categorie = b.dataset.cat || null; renderPrepa(); };
  });
  document.querySelectorAll('#pills-mniv .pill').forEach(b => {
    b.onclick = () => { prepa.niveau = b.dataset.niv ? Number(b.dataset.niv) : null; renderPrepa(); };
  });
  document.querySelectorAll('#pills-long .pill').forEach(b => {
    b.onclick = () => { prepa.longueur = Number(b.dataset.long); renderPrepa(); };
  });
  document.getElementById('btn-demarrer').onclick = demarrerMulti;
}

/* ---------- Compétitif : écran relais (on se passe l'appareil) ---------- */
function renderRelais() {
  const tour = m.tours[m.t];
  const nom = m.noms[tour.p];
  const premiere = m.t === 0;

  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-quitter">‹ Quitter l'épreuve</button>
    <div class="defi-meta">
      <span>Manche ${tour.manche}/${m.manches}</span>
      <span>Question ${m.t + 1}/${m.tours.length}</span>
    </div>
    <div class="defi-progress"><i style="width:${Math.round((m.t / m.tours.length) * 100)}%"></i></div>

    <div class="card hero relais-screen">
      <div class="relais-kicker">${premiere ? 'L’épreuve commence' : 'Passe l’appareil à'}</div>
      <div class="relais-nom">${esc(nom)}</div>
      <p class="defi-lead">${premiere ? `${esc(nom)}, à toi la première question.` : 'Les autres, on ne souffle pas la réponse !'}</p>
      <div class="defi-actions">
        <button class="btn btn-primary" id="btn-voir">C'est moi, ${esc(nom)} — voir la question</button>
      </div>
    </div>
  </div>`;

  document.getElementById('btn-quitter').onclick = quitterMulti;
  document.getElementById('btn-voir').onclick = () => { vue.ecran = 'mquestion'; render(); };
}

/* ---------- Coopératif : l'objectif d'équipe, affiché dès le départ ---------- */
function renderObjectif() {
  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-quitter">‹ Quitter l'épreuve</button>
    <div class="card hero relais-screen">
      <div class="relais-kicker">Objectif d'équipe</div>
      <div class="relais-nom">Ensemble, atteignez ${m.objectif}/${m.items.length}</div>
      <p class="defi-lead">${m.noms.map(esc).join(', ')} : discutez chaque question, puis donnez une seule réponse commune. L'appareil peut rester au milieu de la table.</p>
      <div class="defi-actions">
        <button class="btn btn-primary" id="btn-voir">Commencer</button>
      </div>
    </div>
  </div>`;

  document.getElementById('btn-quitter').onclick = quitterMulti;
  document.getElementById('btn-voir').onclick = () => { vue.ecran = 'mquestion'; render(); };
}

/* ---------- À plusieurs : écran question (bandeau de tour ou d'équipe) ---------- */
function renderQuestionMulti() {
  const compet = m.mode === 'compet';
  const item = compet ? m.tours[m.t] : m.items[m.index];
  const q = item.q;
  const total = compet ? m.tours.length : m.items.length;
  const num = (compet ? m.t : m.index) + 1;
  const repondu = m.repondu !== null;
  const derniere = num >= total;

  const bandeau = compet
    ? `<div class="tour-banner"><span class="who">Au tour de ${esc(m.noms[item.p])}</span><span class="side">Manche ${item.manche}/${m.manches}</span></div>`
    : `<div class="tour-banner coop"><span class="who">Ensemble · objectif ${m.objectif}/${total}</span><span class="side">${m.score} bonne${m.score > 1 ? 's' : ''} réponse${m.score > 1 ? 's' : ''}</span></div>`;

  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-quitter">‹ Quitter l'épreuve</button>
    ${bandeau}
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
            else if (pos === m.repondu) cls += ' bad';
            else cls += ' dim';
          }
          return `<button class="${cls}" data-pos="${pos}" ${repondu ? 'disabled' : ''}>${esc(q.options[idxOpt])}</button>`;
        }).join('')}
      </div>
      ${repondu ? `
        <p class="defi-ref-line"><span class="arrow">→</span>${esc(q.reference)} <span class="muted">· à retrouver dans ta Bible</span></p>
        <button class="btn btn-primary" id="btn-suivante">${derniere
          ? (compet ? 'Voir le classement' : 'Voir le résultat')
          : (compet ? 'Passer l’appareil' : 'Question suivante')}</button>
      ` : ''}
    </div>
  </div>`;

  document.getElementById('btn-quitter').onclick = quitterMulti;
  if (!repondu) {
    document.querySelectorAll('#options .defi-option').forEach(b => {
      b.onclick = () => repondreMulti(Number(b.dataset.pos));
    });
  } else {
    document.getElementById('btn-suivante').onclick = suivanteMulti;
  }
}

/* ---------- Compétitif : classement sobre et bienveillant ---------- */
function renderFinCompet() {
  const rows = classement();
  const tousExAequo = rows.every(r => r.rang === 1);

  el.innerHTML = `
  <div class="fade">
    <div class="card hero done-screen">
      <div class="seal">🌾</div>
      <h2 style="font-family:var(--serif)">${tousExAequo ? 'Tous ex aequo !' : 'Épreuve relevée !'}</h2>
      <p class="defi-word">Bien relevé, tous ensemble. Chaque référence ci-dessous est une porte ouverte vers le texte.</p>
    </div>

    <div class="section-title">Classement</div>
    <div class="card">
      ${rows.map(r => `
        <div class="rang-row ${r.rang === 1 ? 'top' : ''}">
          <span class="rang">${rangLabel(r.rang)}${r.exaequo ? ' <i>ex aequo</i>' : ''}</span>
          <span class="rnom">${esc(r.nom)}</span>
          <span class="rscore">${r.score}/${m.manches}</span>
        </div>`).join('')}
    </div>

    ${rows.some(r => m.ratees[r.i].length) ? `
    <div class="section-title">Pour retourner au texte</div>
    ${rows.filter(r => m.ratees[r.i].length).map(r => `
    <div class="card">
      <details class="revoir">
        <summary>Références à revoir — ${esc(r.nom)} (${m.ratees[r.i].length})</summary>
        ${m.ratees[r.i].map(q => `
          <div class="defi-missed">
            <div class="q">${esc(q.question)}</div>
            <div class="a">Réponse : ${esc(q.options[q.bonne])}</div>
            <div class="r">→ ${esc(q.reference)}</div>
          </div>`).join('')}
      </details>
    </div>`).join('')}` : ''}

    <div class="defi-actions">
      <button class="btn btn-grow btn-block" id="btn-encore">Nouvelle épreuve</button>
      <button class="btn btn-ghost btn-block" id="btn-retour">Retour</button>
    </div>
  </div>`;

  document.getElementById('btn-encore').onclick = () => { m = null; vue = { ecran: 'prepa' }; render(); };
  document.getElementById('btn-retour').onclick = () => { m = null; vue = { ecran: 'accueil' }; render(); };
}

/* ---------- Coopératif : réussite ou pas, toujours encourageant ---------- */
function renderFinCoop() {
  const total = m.items.length;
  const reussi = m.score >= m.objectif;

  el.innerHTML = `
  <div class="fade">
    <div class="card hero done-screen">
      <div class="seal">${reussi ? '🌾' : '🌱'}</div>
      <div class="defi-score">${m.score}<span class="of">/${total}</span></div>
      <p class="defi-word">${reussi
        ? `Objectif atteint, ensemble ! Il fallait ${m.objectif}/${total} — vous avez fait mieux que le relever.`
        : `L'objectif était ${m.objectif}/${total} — pas atteint cette fois, mais chaque passage relu ensemble compte plus qu'un score. À bientôt pour le prochain !`}</p>
    </div>

    ${m.ratees.length ? `
    <div class="section-title">À relire ensemble</div>
    <div class="card">
      ${m.ratees.map(q => `
        <div class="defi-missed">
          <div class="q">${esc(q.question)}</div>
          <div class="a">Réponse : ${esc(q.options[q.bonne])}</div>
          <div class="r">→ ${esc(q.reference)}</div>
        </div>`).join('')}
    </div>` : `
    <div class="card"><p class="defi-lead">Rien à relire : tout était juste. Ouvrez la Bible pour le plaisir, alors.</p></div>`}

    <div class="defi-actions">
      <button class="btn btn-grow btn-block" id="btn-encore">Nouvelle épreuve</button>
      <button class="btn btn-ghost btn-block" id="btn-retour">Retour</button>
    </div>
  </div>`;

  document.getElementById('btn-encore').onclick = () => { m = null; vue = { ecran: 'prepa' }; render(); };
  document.getElementById('btn-retour').onclick = () => { m = null; vue = { ecran: 'accueil' }; render(); };
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
