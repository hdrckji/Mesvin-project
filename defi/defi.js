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
  // Duels à distance : compteur local distinct — ne touche jamais aux stats solo.
  if (!s.duelsAmis) s.duelsAmis = { relevees: 0 };
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
   Défier un ami — duels à distance, asynchrones (via le serveur).

   Principes :
   - Les questions viennent du serveur (mêmes questions pour les deux), SANS la
     bonne réponse : aucun verdict pendant l'épreuve — la review arrive du
     serveur après l'envoi, avec les références bibliques.
   - Les réponses en cours restent en brouillon local : on peut être interrompu
     et reprendre. Rien n'est envoyé avant la confirmation.
   - Hors-ligne ou sans compte : messages doux ; le reste du module fonctionne.
   ========================================================================== */

const DUEL_DRAFT_KEY = 'graine.defi.duel.brouillons.v1'; // { [id]: { answers, index, ts } }
const DUEL_Q_KEY = 'graine.defi.duel.questions.v1';      // { [id]: { questions, opponent } }

function lireJSON(key) {
  try { const r = localStorage.getItem(key); if (r) return JSON.parse(r); } catch (e) {}
  return {};
}
function ecrireJSON(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {} }

function brouillonDe(id) { return lireJSON(DUEL_DRAFT_KEY)[id] || null; }
function garderBrouillon(id, d) { const m2 = lireJSON(DUEL_DRAFT_KEY); m2[id] = { ...d, ts: Date.now() }; ecrireJSON(DUEL_DRAFT_KEY, m2); }
function effacerBrouillon(id) { const m2 = lireJSON(DUEL_DRAFT_KEY); delete m2[id]; ecrireJSON(DUEL_DRAFT_KEY, m2); }

/* Les questions servies par le serveur (texte + ordre des options) sont gardées
   localement pour pouvoir afficher la review plus tard — la review du serveur
   ne renvoie que les index. */
function questionsGardees(id) { return lireJSON(DUEL_Q_KEY)[id] || null; }
function garderQuestions(id, questions, opponent) {
  const m2 = lireJSON(DUEL_Q_KEY); m2[id] = { questions, opponent }; ecrireJSON(DUEL_Q_KEY, m2);
}
function purgerQuestions(idsVivants) {
  const m2 = lireJSON(DUEL_Q_KEY);
  let touche = false;
  for (const id of Object.keys(m2)) if (!idsVivants.has(String(id))) { delete m2[id]; touche = true; }
  if (touche) ecrireJSON(DUEL_Q_KEY, m2);
}

function apiPret() { return typeof window !== 'undefined' && !!window.GraineAPI; }
function connecte() { return apiPret() && GraineAPI.isLoggedIn(); }

let duelsConnus = null; // dernière liste reçue (pour le badge de l'accueil)

function statutDuel(d) {
  if (d.status === 'waiting_me') return { txt: 'À toi de relever l’épreuve', cls: 'moi' };
  if (d.status === 'waiting_them') return { txt: `En attente de ${d.opponent.pseudo}`, cls: 'eux' };
  return { txt: 'Terminé', cls: 'fini' };
}

/* Formulation bienveillante du résultat final, quelle que soit l'issue. */
function phraseDuelFinal(mien, leur, pseudo) {
  if (mien > leur) return `Toi ${mien} — ${pseudo} ${leur} · Bien relevé ! Et de quoi en reparler ensemble.`;
  if (mien === leur) return `Égalité ${mien} partout · Deux lecteurs d'une même Parole, fraternellement.`;
  return `${pseudo} ${leur} — Toi ${mien} · De belles découvertes à relire !`;
}

/* Message doux quand le serveur est injoignable — jamais d'erreur brute. */
function messageDoux(e) {
  if (e && e.offline) return 'Pas de connexion pour l’instant. Les duels t’attendront ici — le reste du module fonctionne sans réseau.';
  return (e && e.message) || 'Un petit souci est survenu. Réessaie dans un instant.';
}

/* ---------- Chargement de l'écran des duels ---------- */
async function ouvrirDuels() {
  if (!connecte()) { vue = { ecran: 'duelCompte' }; render(); return; }
  vue = { ecran: 'duels', chargement: true, amis: null, duels: null, erreur: null };
  render();
  await chargerDuels();
}

async function chargerDuels() {
  try {
    const [amis, duels] = await Promise.all([GraineAPI.friends(), GraineAPI.duels()]);
    duelsConnus = duels;
    purgerQuestions(new Set(duels.map(d => String(d.id))));
    if (vue.ecran !== 'duels') return;
    vue = { ecran: 'duels', chargement: false, amis, duels, erreur: null };
  } catch (e) {
    if (vue.ecran !== 'duels') return;
    vue = { ecran: 'duels', chargement: false, amis: null, duels: null, erreur: messageDoux(e) };
  }
  render();
}

/* ---------- Créer un duel puis relever sa part tout de suite ---------- */
async function nouveauDuel(code) {
  vue = { ecran: 'duels', chargement: true, amis: null, duels: null, erreur: null };
  render();
  try {
    const duel = await GraineAPI.createDuel(code);
    demarrerDuelDistant(duel, null);
  } catch (e) {
    vue = { ecran: 'duels', chargement: false, amis: null, duels: null, erreur: messageDoux(e) };
    render();
  }
}

/* ---------- Ouvrir un duel existant (relever ma part, ou voir le résultat) ---------- */
async function ouvrirDuel(d) {
  if (d.status === 'waiting_me') {
    // Brouillon local + questions gardées : reprise immédiate, même flux sinon.
    const brouillon = brouillonDe(d.id);
    const garde = questionsGardees(d.id);
    if (brouillon && garde) {
      demarrerDuelDistant({ id: d.id, opponent: garde.opponent || d.opponent, questions: garde.questions }, brouillon);
      return;
    }
    vue = { ecran: 'duels', chargement: true, amis: null, duels: null, erreur: null };
    render();
    try {
      const detail = await GraineAPI.duel(d.id);
      demarrerDuelDistant({ id: d.id, opponent: detail.opponent || d.opponent, questions: detail.questions }, brouillon);
    } catch (e) {
      vue = { ecran: 'duels', chargement: false, amis: null, duels: null, erreur: messageDoux(e) };
      render();
    }
    return;
  }
  // Déjà relevé : review (mémoire locale + serveur).
  vue = { ecran: 'duels', chargement: true, amis: null, duels: null, erreur: null };
  render();
  try {
    const detail = await GraineAPI.duel(d.id);
    vue = { ecran: 'duelReview', duel: { ...d, ...detail } };
  } catch (e) {
    vue = { ecran: 'duels', chargement: false, amis: null, duels: null, erreur: messageDoux(e) };
  }
  render();
}

function demarrerDuelDistant(duel, brouillon) {
  garderQuestions(duel.id, duel.questions, duel.opponent);
  const n = duel.questions.length;
  let answers = duel.questions.map(() => -1);
  let index = 0;
  if (brouillon && Array.isArray(brouillon.answers)) {
    answers = duel.questions.map((_, i) => (typeof brouillon.answers[i] === 'number' ? brouillon.answers[i] : -1));
    index = Math.min(Math.max(brouillon.index || 0, 0), n - 1);
  }
  vue = { ecran: 'duelQuestion', duel, index, answers, recap: false };
  render();
}

function repondreDuel(pos) {
  if (vue.avance) return; // évite un double appui pendant la courte transition
  vue.avance = true;
  vue.answers[vue.index] = pos;
  garderBrouillon(vue.duel.id, { answers: vue.answers, index: vue.index });
  // Enchaînement fluide : on marque le choix, puis on avance (pas de verdict —
  // la bonne réponse n'est pas connue ici, c'est voulu).
  const btn = el.querySelector(`#options .defi-option[data-pos="${pos}"]`);
  if (btn) btn.classList.add('pick');
  setTimeout(() => {
    if (vue.ecran !== 'duelQuestion') return;
    vue.avance = false;
    if (vue.index + 1 < vue.duel.questions.length) {
      vue.index++;
      garderBrouillon(vue.duel.id, { answers: vue.answers, index: vue.index });
    } else {
      vue.recap = true;
    }
    render();
  }, 180);
}

async function envoyerDuel() {
  const { duel, answers } = vue;
  const btn = document.getElementById('btn-envoyer');
  if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
  try {
    const resultat = await GraineAPI.duelResult(duel.id, answers);
    effacerBrouillon(duel.id);
    store.duelsAmis.relevees++;
    saveStore();
    vue = { ecran: 'duelReview', duel: { opponent: duel.opponent, ...resultat, id: duel.id } };
    render();
  } catch (e) {
    // Le brouillon reste : rien n'est perdu, on réessaiera.
    if (e && e.status === 409) {
      // Déjà relevé (autre appareil ?) : on va chercher le résultat.
      effacerBrouillon(duel.id);
      try {
        const detail = await GraineAPI.duel(duel.id);
        vue = { ecran: 'duelReview', duel: { opponent: duel.opponent, ...detail, id: duel.id } };
        render();
        return;
      } catch (e2) { /* on retombe sur le message doux */ }
    }
    vue.envoiErreur = 'Tes réponses sont gardées sur cet appareil. ' + messageDoux(e);
    render();
  }
}

async function revanche(opponent) {
  const b = document.getElementById('btn-revanche');
  if (b) { b.disabled = true; b.textContent = 'Un instant…'; }
  try {
    // Le contrat ne renvoie que le pseudo de l'adversaire : on retrouve son
    // code ami dans la liste d'amis.
    let code = opponent.friendCode;
    if (!code) {
      const amis = await GraineAPI.friends();
      const ami = amis.find(a => a.pseudo === opponent.pseudo);
      if (!ami) throw new Error(`${opponent.pseudo} n'est plus dans tes amis — retrouvez-vous dans l'écran Moi.`);
      code = ami.friendCode;
    }
    const duel = await GraineAPI.createDuel(code);
    demarrerDuelDistant(duel, null);
  } catch (e) {
    if (b) { b.disabled = false; b.textContent = 'Revanche'; }
    const note = document.getElementById('duel-note');
    if (note) note.textContent = messageDoux(e);
  }
}

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
  if (vue.ecran === 'duelCompte') return renderDuelCompte();
  if (vue.ecran === 'duels') return renderDuels();
  if (vue.ecran === 'duelQuestion') return vue.recap ? renderDuelEnvoi() : renderDuelQuestion();
  if (vue.ecran === 'duelReview') return renderDuelReview();
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
        <span class="hub-title">À plusieurs, ici</span>
        <span class="hub-sub">Sur un même appareil, en famille ou en groupe : compétitif ou coopératif.${g.relevees > 0 ? ` <b class="grp-count">${g.relevees} épreuve${g.relevees > 1 ? 's' : ''} relevée${g.relevees > 1 ? 's' : ''} ensemble</b>` : ''}</span>
      </span>
      <span class="chev">›</span>
    </button>

    <button class="card hub-card" id="btn-ami">
      <span class="hub-ic">⚔️</span>
      <span class="hub-txt">
        <span class="hub-title">Défier un ami</span>
        <span class="hub-sub">À distance : mêmes questions pour vous deux, chacun quand il veut.<span id="duel-attente"></span></span>
      </span>
      <span class="chev">›</span>
    </button>
  </div>`;

  document.getElementById('btn-retour-accueil').onclick = () => { location.href = '../index.html'; };
  document.getElementById('btn-seul').onclick = () => { vue = { ecran: 'solo' }; render(); };
  document.getElementById('btn-plusieurs').onclick = () => { vue = { ecran: 'prepa' }; render(); };
  document.getElementById('btn-ami').onclick = ouvrirDuels;

  // Badge discret si au moins un duel m'attend (silencieux hors-ligne).
  majBadgeDuels();
}

function majBadgeDuels() {
  const poser = (liste) => {
    const n = (liste || []).filter(d => d.status === 'waiting_me').length;
    const span = document.getElementById('duel-attente');
    if (span) span.innerHTML = n ? ` <b class="duel-badge">${n} duel${n > 1 ? 's' : ''} t'attend${n > 1 ? 'ent' : ''}</b>` : '';
  };
  if (duelsConnus) poser(duelsConnus);
  if (!connecte()) return;
  GraineAPI.duels().then(liste => {
    duelsConnus = liste;
    if (vue.ecran === 'accueil') poser(liste);
  }).catch(() => { /* hors-ligne : on n'affiche simplement rien */ });
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

/* ============================================================================
   Défier un ami — écrans
   ========================================================================== */

/* ---------- Sans compte : explication sobre ---------- */
function renderDuelCompte() {
  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-retour-defi">‹ Défi</button>
    <div class="topbar">
      <div class="brand">
        <h1 class="app-title">Défier un ami <span class="seed">•</span> <span class="muted">à distance</span></h1>
      </div>
    </div>

    <div class="card hero duel-compte">
      <div class="seal">⚔️</div>
      <h2 style="font-family:var(--serif)">Un duel, chacun chez soi</h2>
      <p class="defi-lead">Les mêmes dix questions pour vous deux, chacun les relève quand il veut, et on compare à la fin — références bibliques à l'appui.</p>
      <p class="defi-lead" style="margin-top:10px">Pour défier un ami, il faut un compte : crée-le dans l'écran <b>Moi</b> de l'accueil — gratuit, e-mail + pseudo seulement.</p>
      <div class="defi-actions">
        <a class="btn btn-primary" href="../index.html" style="display:block;text-align:center;text-decoration:none">Aller à l'accueil</a>
      </div>
    </div>
  </div>`;

  document.getElementById('btn-retour-defi').onclick = () => { vue = { ecran: 'accueil' }; render(); };
}

/* ---------- Écran des duels (connecté) ---------- */
function renderDuels() {
  const entete = `
    <button class="back-link" id="btn-retour-defi">‹ Défi</button>
    <div class="topbar">
      <div class="brand">
        <h1 class="app-title">Défier un ami <span class="seed">•</span> <span class="muted">à distance</span></h1>
      </div>
    </div>`;

  if (vue.chargement) {
    el.innerHTML = `<div class="fade">${entete}<div class="card"><p class="defi-lead duel-charge">Un instant…</p></div></div>`;
    document.getElementById('btn-retour-defi').onclick = () => { vue = { ecran: 'accueil' }; render(); };
    return;
  }

  if (vue.erreur) {
    el.innerHTML = `
    <div class="fade">${entete}
      <div class="card">
        <p class="defi-lead">${esc(vue.erreur)}</p>
        <div class="defi-actions">
          <button class="btn btn-grow btn-block" id="btn-reessayer">Réessayer</button>
          <button class="btn btn-ghost btn-block" id="btn-retour">Retour</button>
        </div>
      </div>
    </div>`;
    document.getElementById('btn-retour-defi').onclick = () => { vue = { ecran: 'accueil' }; render(); };
    document.getElementById('btn-reessayer').onclick = ouvrirDuels;
    document.getElementById('btn-retour').onclick = () => { vue = { ecran: 'accueil' }; render(); };
    return;
  }

  const amis = vue.amis || [];
  const duels = vue.duels || [];
  const enCours = duels.filter(d => d.status !== 'finished');
  const finis = duels.filter(d => d.status === 'finished');

  const ligneDuel = (d) => {
    const s = statutDuel(d);
    const brouillon = d.status === 'waiting_me' && brouillonDe(d.id);
    const scores = d.status === 'finished'
      ? `${d.myScore ?? '–'} / ${d.theirScore ?? '–'}`
      : (d.myScore != null ? `Toi : ${d.myScore}` : '');
    return `
      <button class="duel-row" data-id="${d.id}">
        <span class="duel-qui">${esc(d.opponent.pseudo)}</span>
        <span class="duel-etat ${s.cls}">${esc(brouillon ? 'Reprendre l’épreuve commencée' : s.txt)}</span>
        ${scores ? `<span class="duel-scores">${esc(String(scores))}</span>` : ''}
      </button>`;
  };

  el.innerHTML = `
  <div class="fade">${entete}

    <div class="section-title duel-titre-ligne">Nouveau duel
      <button class="duel-actualiser" id="btn-actualiser" title="Actualiser">↻ Actualiser</button>
    </div>
    <div class="card">
      ${amis.length ? `
        <p class="defi-lead" style="margin-bottom:6px">Choisis l'ami à défier — vous recevrez les mêmes dix questions.</p>
        ${amis.map(a => `
          <button class="duel-row ami" data-code="${esc(a.friendCode)}">
            <span class="duel-qui">${esc(a.pseudo)}</span>
            <span class="duel-etat moi">Défier</span>
          </button>`).join('')}
      ` : `
        <p class="defi-lead">Pas encore d'amis par ici. Ajoute-les dans l'écran <b>Moi</b> de l'accueil, avec leur code ami — et le premier duel peut commencer.</p>
        <div class="defi-actions">
          <a class="btn btn-ghost btn-block" href="../index.html" style="display:block;text-align:center;text-decoration:none">Aller à l'écran Moi</a>
        </div>
      `}
    </div>

    ${enCours.length ? `
    <div class="section-title">Duels en cours</div>
    <div class="card">${enCours.map(ligneDuel).join('')}</div>` : ''}

    ${finis.length ? `
    <div class="section-title">Duels terminés</div>
    <div class="card">${finis.map(ligneDuel).join('')}</div>` : ''}

    ${store.duelsAmis.relevees > 0 ? `<p class="duel-compteur">${store.duelsAmis.relevees} épreuve${store.duelsAmis.relevees > 1 ? 's' : ''} de duel relevée${store.duelsAmis.relevees > 1 ? 's' : ''} depuis cet appareil.</p>` : ''}
  </div>`;

  document.getElementById('btn-retour-defi').onclick = () => { vue = { ecran: 'accueil' }; render(); };
  document.getElementById('btn-actualiser').onclick = ouvrirDuels;
  document.querySelectorAll('.duel-row.ami').forEach(b => {
    b.onclick = () => nouveauDuel(b.dataset.code);
  });
  document.querySelectorAll('.duel-row[data-id]').forEach(b => {
    b.onclick = () => {
      const d = duels.find(x => String(x.id) === b.dataset.id);
      if (d) ouvrirDuel(d);
    };
  });
}

/* ---------- Relever ma part : question sans verdict (anti-triche) ---------- */
function renderDuelQuestion() {
  const { duel, index, answers } = vue;
  const q = duel.questions[index];
  const total = duel.questions.length;
  const num = index + 1;
  const repondues = answers.filter(a => a >= 0).length;
  // La catégorie (« Qui a dit ? », etc.) donne le contexte : le serveur ne
  // l'envoie pas, on la retrouve dans la banque locale par l'id.
  const info = BANQUE.find(x => x.id === q.id);

  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-quitter">‹ Mettre en pause</button>
    <div class="tour-banner"><span class="who">Duel avec ${esc(duel.opponent.pseudo)}</span><span class="side">${info ? esc(info.categorie) : 'réponses à la fin'}</span></div>
    <div class="defi-meta">
      <span>Question ${num}/${total}</span>
      <span>${repondues}/${total} répondue${repondues > 1 ? 's' : ''}</span>
    </div>
    <div class="defi-progress"><i style="width:${Math.round((repondues / total) * 100)}%"></i></div>

    <div class="card">
      <p class="defi-question">${esc(q.question)}</p>
      <div id="options">
        ${q.options.map((opt, pos) => `
          <button class="defi-option ${answers[index] === pos ? 'pick' : ''}" data-pos="${pos}">${esc(opt)}</button>`).join('')}
      </div>
      <div class="duel-nav">
        <button class="btn btn-ghost" id="btn-prec" ${index === 0 ? 'disabled' : ''}>‹ Précédente</button>
        ${answers[index] >= 0 ? `<button class="btn btn-ghost" id="btn-suiv">${num === total ? 'Vers l’envoi ›' : 'Suivante ›'}</button>` : ''}
      </div>
    </div>
    <p class="duel-note-basse">Le verdict et les références viendront après l'envoi — comme pour ${esc(duel.opponent.pseudo)}.</p>
  </div>`;

  document.getElementById('btn-quitter').onclick = () => {
    garderBrouillon(duel.id, { answers, index });
    ouvrirDuels();
  };
  document.querySelectorAll('#options .defi-option').forEach(b => {
    b.onclick = () => repondreDuel(Number(b.dataset.pos));
  });
  document.getElementById('btn-prec').onclick = () => {
    if (vue.index > 0) { vue.index--; garderBrouillon(duel.id, { answers, index: vue.index }); render(); }
  };
  const suiv = document.getElementById('btn-suiv');
  if (suiv) suiv.onclick = () => {
    if (vue.index + 1 < total) { vue.index++; garderBrouillon(duel.id, { answers, index: vue.index }); }
    else vue.recap = true;
    render();
  };
}

/* ---------- Avant l'envoi : relire, revenir, puis confirmer ---------- */
function renderDuelEnvoi() {
  const { duel, answers } = vue;
  const total = duel.questions.length;
  const sansReponse = answers.filter(a => a < 0).length;

  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-quitter">‹ Mettre en pause</button>
    <div class="tour-banner"><span class="who">Duel avec ${esc(duel.opponent.pseudo)}</span><span class="side">dernier regard</span></div>

    <div class="card">
      <h2 style="font-family:var(--serif)">Tes réponses sont prêtes</h2>
      <p class="defi-lead">Un dernier regard ? Touche une question pour y revenir. Rien n'est envoyé avant ta confirmation.</p>
      <div class="duel-recap">
        ${duel.questions.map((q, i) => `
          <button class="duel-recap-ligne" data-i="${i}">
            <span class="num">${i + 1}.</span>
            <span class="txt">${esc(q.question)}</span>
            <span class="rep ${answers[i] < 0 ? 'vide' : ''}">${answers[i] >= 0 ? esc(q.options[answers[i]]) : 'Sans réponse'}</span>
          </button>`).join('')}
      </div>
      ${sansReponse ? `<p class="duel-note-basse" style="margin:10px 2px 0">${sansReponse} question${sansReponse > 1 ? 's' : ''} sans réponse — elle${sansReponse > 1 ? 's' : ''} comptera${sansReponse > 1 ? 'ont' : ''} comme manquée${sansReponse > 1 ? 's' : ''}.</p>` : ''}
      ${vue.envoiErreur ? `<p class="duel-envoi-erreur">${esc(vue.envoiErreur)}</p>` : ''}
      <div class="defi-actions">
        <button class="btn btn-primary" id="btn-envoyer">Envoyer mes réponses</button>
      </div>
    </div>
  </div>`;

  document.getElementById('btn-quitter').onclick = () => {
    garderBrouillon(duel.id, { answers, index: total - 1 });
    ouvrirDuels();
  };
  document.querySelectorAll('.duel-recap-ligne').forEach(b => {
    b.onclick = () => { vue.recap = false; vue.index = Number(b.dataset.i); vue.envoiErreur = null; render(); };
  });
  document.getElementById('btn-envoyer').onclick = envoyerDuel;
}

/* ---------- Review du serveur : mon score, les références, le statut ---------- */
function renderDuelReview() {
  const d = vue.duel;
  const garde = questionsGardees(d.id) || {};
  const questions = garde.questions || null;
  const pseudo = (d.opponent && d.opponent.pseudo) || (garde.opponent && garde.opponent.pseudo) || 'ton ami';
  const review = d.review || [];
  const total = review.length || (questions ? questions.length : NB_QUESTIONS);
  const fini = d.status === 'finished' || (d.theirScore != null && d.myScore != null);

  // Retrouve le texte d'une question de la review : d'abord la version servie
  // par le serveur (gardée localement — bons index d'options), sinon la banque.
  const texteDe = (r, i) => {
    let q = questions && (questions[i] && questions[i].id === r.id ? questions[i] : questions.find(x => x.id === r.id));
    if (q) return { question: q.question, mienne: r.mine >= 0 ? q.options[r.mine] : null, bonne: q.options[r.bonne] };
    const b = BANQUE.find(x => x.id === r.id);
    return { question: b ? b.question : 'Question ' + (i + 1), mienne: null, bonne: b ? b.options[b.bonne] : null };
  };

  el.innerHTML = `
  <div class="fade">
    <button class="back-link" id="btn-retour-duels">‹ Mes duels</button>

    <div class="card hero done-screen">
      <div class="seal">${fini ? '🌾' : '⚔️'}</div>
      ${fini ? `
        <h2 style="font-family:var(--serif)">Duel terminé</h2>
        <div class="duel-vs"><span class="camp">Toi<br><b>${d.myScore}</b></span><span class="tiret">—</span><span class="camp">${esc(pseudo)}<br><b>${d.theirScore}</b></span></div>
        <p class="defi-word">${esc(phraseDuelFinal(d.myScore, d.theirScore, pseudo))}</p>
      ` : `
        <div class="defi-score">${d.myScore}<span class="of">/${total}</span></div>
        <p class="defi-word">Ta part est relevée. En attente de ${esc(pseudo)} — tu verras son score quand il aura relevé la sienne.</p>
      `}
      <p id="duel-note" class="duel-note-basse" style="margin-top:8px"></p>
    </div>

    ${review.length ? `
    <div class="section-title">Pour retourner au texte</div>
    <div class="card">
      ${review.map((r, i) => {
        const t = texteDe(r, i);
        const ok = r.mine === r.bonne;
        return `
        <div class="defi-missed ${ok ? 'ok' : ''}">
          <div class="q">${esc(t.question)}</div>
          ${ok
            ? `<div class="a">✓ Ta réponse : ${esc(t.bonne ?? '')}</div>`
            : `${t.mienne != null ? `<div class="m">Ta réponse : ${esc(t.mienne)}</div>` : (r.mine < 0 ? `<div class="m">Sans réponse</div>` : '')}
               <div class="a">Réponse : ${esc(t.bonne ?? '')}</div>`}
          <div class="r">→ ${esc(r.reference)}</div>
        </div>`;
      }).join('')}
    </div>` : ''}

    <div class="defi-actions">
      ${fini ? `<button class="btn btn-grow btn-block" id="btn-revanche">Revanche</button>` : `<button class="btn btn-grow btn-block" id="btn-actualiser">Actualiser</button>`}
      <button class="btn btn-ghost btn-block" id="btn-retour">Retour aux duels</button>
    </div>
  </div>`;

  document.getElementById('btn-retour-duels').onclick = ouvrirDuels;
  document.getElementById('btn-retour').onclick = ouvrirDuels;
  const ra = document.getElementById('btn-actualiser');
  if (ra) ra.onclick = async () => {
    ra.disabled = true; ra.textContent = 'Un instant…';
    try {
      const detail = await GraineAPI.duel(d.id);
      vue = { ecran: 'duelReview', duel: { ...d, ...detail } };
    } catch (e) {
      const note = document.getElementById('duel-note');
      if (note) note.textContent = messageDoux(e);
      ra.disabled = false; ra.textContent = 'Actualiser';
      return;
    }
    render();
  };
  const rv = document.getElementById('btn-revanche');
  if (rv) rv.onclick = () => revanche({ pseudo, friendCode: d.opponent && d.opponent.friendCode });
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
