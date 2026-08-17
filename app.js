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

/* Filet : si icons.js manque (déploiement incomplet), l'appli s'affiche sans
   icônes plutôt que de planter sur « icon is not defined ». */
if (!window.icon) window.icon = function () { return ''; };


const STORE_KEY = 'graine.v3';
const EASE_MIN = 1.3, EASE_DEFAULT = 2.5;
const MASTERY = 3;            // nombre de réussites objectives pour « mémorisé »
const SEMER_MAX = 3;          // versets introduits par fournée (objectif compris)
const REVISER_MAX = 10;       // versets par session de révision — au-delà, les
                              // plus anciens passent d'abord, le reste patiente
                              // (un retour de vacances doit rester une joie)
const SCRAMBLE_MAX = 12;      // au-delà, on passe aux mots à trous

/* ---------- Aides ---------- */
const el = document.getElementById('app');
const todayNum = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.round(d.getTime() / 86400000); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }

/* Le jeu d'icônes en traits (fonction icon(nom, taille)) vient d'icons.js,
   chargé avant ce script — partagé avec les modules Lire, Défi et Admin. */

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
  // Situer le verset, mode expert : après le livre, chapitre et numéro aussi.
  if (typeof s.situerExpert !== 'boolean') s.situerExpert = false;
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

/* ---------- Notifications « Le verset offert » (Moi) ----------
   Chaque jour, à l'heure choisie, une notification OFFRE un verset — elle ne
   réclame jamais rien (pas de « viens faire », pas de « tu as manqué »).
   L'état affiché vient d'une préférence locale (graine.push) : pas besoin
   d'interroger le serveur pour dessiner la carte. L'abonnement lui-même vit
   chez le navigateur (pushManager) et sur le serveur (POST subscribe). */
const PUSH_KEY = 'graine.push';         // { endpoint, heure } quand c'est actif
const PUSH_HEURES = [7, 8, 12, 20];     // pastilles d'heure proposées (défaut 8 h)
let pushBusy = false, pushError = null, pushNotice = null;

function pushPref() {
  try { const r = localStorage.getItem(PUSH_KEY); if (r) return JSON.parse(r); } catch (e) {}
  return null;
}
function savePushPref(p) {
  try { if (p) localStorage.setItem(PUSH_KEY, JSON.stringify(p)); else localStorage.removeItem(PUSH_KEY); } catch (e) {}
}
// 'oui' : tout est là ; 'ios' : iPhone/iPad pas encore installé sur l'écran
// d'accueil (Safari n'expose l'API push qu'aux PWA installées) ; 'non' : pas
// de prise en charge du tout.
function pushSupport() {
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'oui';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad récent
  const installe = (window.matchMedia && matchMedia('(display-mode: standalone)').matches)
    || navigator.standalone === true;
  return ios && !installe ? 'ios' : 'non';
}
// Clé publique VAPID : base64url → Uint8Array pour pushManager.subscribe.
function pushB64uToU8(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function pushFriendlyError(e) {
  if (e && e.offline) return 'Pas de connexion — réessaie quand tu seras en ligne.';
  if (e && e.status) return e.message || 'Le serveur n\'a pas pu enregistrer l\'abonnement — réessaie plus tard.';
  return 'Impossible d\'activer les notifications pour l\'instant — réessaie plus tard.';
}
async function pushActivate(heure) {
  if (pushBusy || !window.GraineAPI) return;
  pushBusy = true; pushError = pushNotice = null; render();
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      // Refus ou fermeture de la demande : on n'insiste pas, jamais.
      pushError = perm === 'denied'
        ? 'Ton navigateur bloque les notifications pour ce site — tu peux le changer dans ses réglages.'
        : 'Pas de souci — tu pourras activer quand tu veux.';
    } else {
      const reg = await navigator.serviceWorker.ready;
      const { vapidPublicKey } = await GraineAPI.pushKey();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: pushB64uToU8(vapidPublicKey)
        });
      }
      await GraineAPI.pushSubscribe(sub.toJSON(), heure, new Date().getTimezoneOffset());
      savePushPref({ endpoint: sub.endpoint, heure });
      pushNotice = 'C\'est prêt : chaque jour vers ' + heure + ' h, un verset t\'attendra 🌱';
    }
  } catch (e) { pushError = pushFriendlyError(e); }
  pushBusy = false; render();
}
async function pushSetHour(heure) {
  const pref = pushPref();
  if (!pref || pushBusy || !window.GraineAPI) return;
  if (pref.heure === heure) return;
  pushBusy = true; pushError = pushNotice = null; render();
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) { // l'abonnement navigateur a disparu : on refait le chemin complet
      savePushPref(null); pushBusy = false;
      return pushActivate(heure);
    }
    await GraineAPI.pushSubscribe(sub.toJSON(), heure, new Date().getTimezoneOffset());
    savePushPref({ endpoint: sub.endpoint, heure });
  } catch (e) { pushError = pushFriendlyError(e); }
  pushBusy = false; render();
}
async function pushDeactivate() {
  if (pushBusy) return;
  pushBusy = true; pushError = pushNotice = null; render();
  const pref = pushPref();
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const endpoint = sub ? sub.endpoint : (pref && pref.endpoint);
    if (sub) await sub.unsubscribe();
    if (endpoint && window.GraineAPI) {
      // Hors-ligne, tant pis : le serveur retirera de lui-même l'abonnement
      // mort après quelques échecs d'envoi.
      try { await GraineAPI.pushUnsubscribe(endpoint); } catch (e) {}
    }
  } catch (e) { /* même en cas de pépin, le choix de l'utilisateur est respecté */ }
  savePushPref(null);
  pushNotice = 'Notifications désactivées. Tu peux les retrouver ici quand tu veux.';
  pushBusy = false; render();
}
// La section « Le verset offert » de l'écran Moi — repliée, même modèle
// que Apparence ; son résumé dit l'essentiel sans ouvrir.
function moiPushCard() {
  const support = pushSupport();
  const pref = pushPref();
  let resume;
  if (support === 'ios') resume = 'après installation';
  else if (support === 'non') resume = 'indisponible ici';
  else if (Notification.permission === 'denied') resume = 'bloquées par le navigateur';
  else if (pref) resume = `chaque jour vers ${pref.heure} h`;
  else resume = 'désactivé';
  const desc = `<p class="muted" style="margin:0">Chaque jour, un verset t'est offert en notification. Rien à faire, rien à rattraper — juste recevoir.</p>`;
  let corps;
  if (support === 'ios') {
    // iOS Safari : l'API push n'existe qu'une fois la PWA installée.
    corps = desc + `<p class="muted" style="font-size:.85rem;margin:12px 2px 0">📲 Sur iPhone ou iPad, ajoute d'abord Bible Horizon à ton écran d'accueil (bouton Partager → « Sur l'écran d'accueil ») pour recevoir des notifications.</p>`;
  } else if (support === 'non') {
    corps = desc + `<p class="muted" style="font-size:.85rem;margin:12px 2px 0">Ce navigateur ne prend pas en charge les notifications — tout le reste de l'appli fonctionne normalement.</p>`;
  } else if (Notification.permission === 'denied') {
    corps = desc + `<p class="muted" style="font-size:.85rem;margin:12px 2px 0">Ton navigateur bloque les notifications pour ce site — tu peux le changer dans ses réglages, puis revenir ici.</p>`;
  } else if (pref) {
    const hpill = h => `<button class="pill ${pref.heure === h ? 'on' : ''}" data-push-heure="${h}" ${pushBusy ? 'disabled' : ''}>${h} h</button>`;
    corps = `<p class="muted" style="margin:0">Chaque jour vers <b>${pref.heure} h</b>, un verset t'est offert. Change l'heure librement — ou arrête, sans question.</p>
      <div class="pill-row" style="margin-top:12px">${PUSH_HEURES.map(hpill).join('')}</div>
      <button class="btn btn-ghost btn-block" data-push-off="1" ${pushBusy ? 'disabled' : ''} style="margin-top:12px">Désactiver</button>`;
  } else {
    corps = desc + `<button class="btn btn-primary" data-push-on="1" ${pushBusy ? 'disabled' : ''} style="margin-top:12px">${pushBusy ? 'Activation…' : 'Activer'}</button>`;
  }
  // Erreur et confirmation HORS du repli : visibles même section fermée.
  const alerte = (pushError ? `<p class="field-error mr-alerte">${esc(pushError)}</p>` : '')
    + (pushNotice ? `<p class="field-ok mr-alerte">${esc(pushNotice)}</p>` : '');
  return moiRepli('offert', `${icon('cloche')} Le verset offert`, resume,
    `<div class="card fade">${corps}</div>`, alerte);
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
    if (ids.length >= BOOK_COLLECTION_MIN) out.push({ id: 'livre:' + book, name: book, emoji: '', desc: '', verses: ids });
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

/* ---------- Contexte factuel du livre ----------
   Règle : ces résumés doivent rester STRICTEMENT bibliques — uniquement ce
   que le livre affirme de lui-même (ex. Romains 1.1 « Paul, apôtre ») ou ce
   qu'un autre passage biblique dit de lui, jamais une tradition d'Église,
   une hypothèse d'érudition ou un repère historique externe au texte, même
   largement admis. En cas de doute sur une attribution, l'omettre. */
const BOOKS = {
  'Jean': "Évangile selon Jean, centré sur l'identité de Jésus, Fils de Dieu.",
  'Psaumes': "Recueil de 150 prières et chants d'Israël (David et d'autres). Louange, détresse, confiance.",
  'Philippiens': "Lettre de Paul, écrite depuis la prison, à l'église de Philippes. Un ton de joie et de reconnaissance.",
  'Proverbes': "Recueil de sentences de sagesse, en grande partie attribuées à Salomon.",
  'Romains': "Lettre de l'apôtre Paul à l'église de Rome, exposé de fond sur le salut par la foi.",
  'Ésaïe': "Livre du prophète Ésaïe, annonçant le jugement puis la consolation et l'espérance.",
  'Matthieu': "Évangile selon Matthieu, qui présente Jésus comme le Messie promis.",
  'Josué': "Récit de l'entrée du peuple d'Israël dans le pays promis, sous la conduite de Josué.",
  'Éphésiens': "Lettre de Paul à l'église d'Éphèse, sur la grâce et la vie nouvelle en Christ.",
  'Jérémie': "Livre du prophète Jérémie, écrit dans une période d'épreuve et d'exil.",
  '1 Corinthiens': "Première lettre de Paul à l'église de Corinthe, réponses à des questions de la vie d'église.",
  '1 Jean': "Lettre de Jean sur l'amour, la lumière et l'assurance du salut.",
  'Apocalypse': "Dernier livre de la Bible, une révélation donnée à Jean, pleine d'espérance.",
  '2 Timothée': "Lettre de Paul à son disciple Timothée, écrite alors qu'il sent sa fin proche, comme un testament d'encouragement.",
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
  if (card.interval <= 3) return { iconName: 'germe', label: 'Germe' };
  if (card.interval <= 13) return { iconName: 'pousse', label: 'Pousse' };
  if (card.interval <= 44) return { iconName: 'plante', label: 'Plante' };
  if (card.interval <= 119) return { iconName: 'arbre', label: 'Arbre' };
  return { iconName: 'enracine', label: 'Enraciné' };
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
    if (!s || typeof s !== 'object') return out;
    // Deux formats : v2 (s.books — ce que lire.js écrit aujourd'hui) et
    // l'ancien v1 (s.plans objet par livre). Sans le v2, les compteurs
    // « Lecture » de Moi restaient à zéro pour les stores récents.
    let parLivre = null;
    if (s.books && typeof s.books === 'object' && !Array.isArray(s.books)) parLivre = s.books;
    else if (s.plans && typeof s.plans === 'object' && !Array.isArray(s.plans)) parLivre = s.plans;
    if (!parLivre) return out;
    for (const p of Object.values(parLivre)) {
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
   Situer le verset — après chaque exercice réussi (introduction comme
   révision), retrouver le LIVRE du verset (et, en mode expert, le chapitre et
   le numéro). Connaître un verset, c'est aussi savoir où le retrouver dans sa
   Bible. Se tromper ici ne compte JAMAIS dans la répétition espacée : la
   référence est un plus, pas une barrière.
   ========================================================================== */
// Les 66 livres, groupés par section : deux des trois leurres viennent de la
// même section que le bon livre — situer un verset apprend au passage la
// structure de la Bible (une épître se confond avec une épître, pas avec un
// prophète).
const BIBLE_SECTIONS = [
  ['Genèse', 'Exode', 'Lévitique', 'Nombres', 'Deutéronome'],
  ['Josué', 'Juges', 'Ruth', '1 Samuel', '2 Samuel', '1 Rois', '2 Rois',
   '1 Chroniques', '2 Chroniques', 'Esdras', 'Néhémie', 'Esther'],
  ['Job', 'Psaumes', 'Proverbes', 'Ecclésiaste', 'Cantique des cantiques'],
  ['Ésaïe', 'Jérémie', 'Lamentations', 'Ézéchiel', 'Daniel', 'Osée', 'Joël',
   'Amos', 'Abdias', 'Jonas', 'Michée', 'Nahum', 'Habacuc', 'Sophonie',
   'Aggée', 'Zacharie', 'Malachie'],
  ['Matthieu', 'Marc', 'Luc', 'Jean', 'Actes'],
  ['Romains', '1 Corinthiens', '2 Corinthiens', 'Galates', 'Éphésiens',
   'Philippiens', 'Colossiens', '1 Thessaloniciens', '2 Thessaloniciens',
   '1 Timothée', '2 Timothée', 'Tite', 'Philémon'],
  ['Hébreux', 'Jacques', '1 Pierre', '2 Pierre', '1 Jean', '2 Jean', '3 Jean',
   'Jude', 'Apocalypse'],
];

// « Philippiens 4.13 » → { livre, chapitre, versets } — versets reste une
// chaîne pour respecter les plages (« Romains 8.38-39 »). Null si la
// référence a une forme inattendue : l'étape est alors simplement sautée.
function parseRef(ref) {
  const m = /^(.+?)\s+(\d+)\.(\d+(?:-\d+)?)$/.exec(String(ref || ''));
  return m ? { livre: m[1], chapitre: +m[2], versets: m[3] } : null;
}

// Quatre livres proposés : le bon, deux voisins de section, un d'ailleurs.
function situerOptionsLivres(livre) {
  const section = BIBLE_SECTIONS.find(s => s.includes(livre)) || [];
  const proches = shuffle(section.filter(l => l !== livre)).slice(0, 2);
  const autres = shuffle(BIBLE_SECTIONS.flat().filter(l => l !== livre && !proches.includes(l)));
  return shuffle([livre, ...proches, ...autres.slice(0, 3 - proches.length)]);
}

// Mode expert : quatre « chapitre.verset » plausibles autour du bon — assez
// proches pour demander une vraie mémoire, assez distincts pour rester francs.
function situerOptionsRef(chapitre, versets) {
  const v = parseInt(versets, 10);
  const bonne = chapitre + '.' + versets;
  const leurres = [];
  [[chapitre, v + 2], [chapitre, Math.max(1, v - 3)], [chapitre + 1, v],
   [Math.max(1, chapitre - 1), v + 1], [chapitre + 2, Math.max(1, v - 1)]]
    .forEach(([c, n]) => {
      const s = c + '.' + n;
      if (s !== bonne && !leurres.includes(s)) leurres.push(s);
    });
  return shuffle([bonne, ...shuffle(leurres).slice(0, 3)]);
}

/* ============================================================================
   Navigation & session
   ========================================================================== */
let route = { name: 'home', param: null };
let session = null; // { queue, idx, intro?, phase:'exercise'|'situer'|'result', ex, result, situer, done:[], mastered:[] }
let studyList = []; // versets présentés sur la page d'étude en cours (avant le quiz d'introduction)
const go = (name, param) => {
  // Chaque entrée dans l'onglet Mon église rouvre droit à UNE tentative
  // réseau : un chargement raté (hors-ligne) se retente à la visite suivante.
  if (name === 'eglise') pageTentee = {};
  route = { name, param: param || null }; render(); window.scrollTo(0, 0);
};

function render() {
  const v = { home: viewHome, memo: viewMemo, study: viewStudy, session: viewSession, moi: viewMoi, garden: viewGarden, verse: () => viewVerse(route.param), about: viewAbout, collections: viewCollections, account: viewAccount, eglise: viewEglise, banques: viewEgliseBanques }[route.name] || viewHome;
  el.innerHTML = v() + tabbar();
  wire();
}
function topbar(withAccount) {
  const s = store.streak.count;
  const flame = s > 0 ? `<span class="streak">${icon('defi', 14)} ${s} jour${s > 1 ? 's' : ''}</span>` : '';
  // Sur l'accueil : l'entrée compte est visible d'emblée, en haut à droite.
  let account = '';
  if (withAccount) {
    const u = window.GraineAPI ? GraineAPI.user() : null;
    account = u
      ? `<button class="acc-chip" data-accchip="1" title="Mon compte">${icon('nuage', 14)} ${esc(u.pseudo)}</button>`
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
    : ['garden', 'verse', 'account'].includes(route.name) ? 'moi'
    : route.name === 'banques' ? 'eglise' : route.name;
  const tab = (n, ic, l) => `<button data-tab="${n}" class="${cur === n ? 'active' : ''}"><span class="ic">${ic}</span>${l}</button>`;
  // L'onglet « Mon église » n'existe que pour qui est dans un groupe : la
  // barre reste à trois onglets pour tous les autres, et l'onglet APPARAÎT
  // au moment où l'on rejoint son assemblée.
  const eglise = Array.isArray(groupesCache) && groupesCache.length
    ? tab('eglise', icon('eglise', 21), 'Mon église') : '';
  return `<nav class="tabbar">${tab('home', icon('accueil', 21), 'Accueil')}${tab('moi', icon('moi', 21), 'Moi')}${eglise}${tab('about', icon('apropos', 21), 'À propos')}</nav>`;
}

/* Le défi du jour vit dans le module Sonder (localStorage 'graine.defi.v1').
   On le lit ici seulement pour l'afficher sur l'accueil — on n'y touche pas. */
function defiDuJourFait() {
  try {
    const d = JSON.parse(localStorage.getItem('graine.defi.v1'));
    const t = new Date(), p = n => String(n).padStart(2, '0');
    const auj = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
    return !!(d && d.jour && d.jour.date === auj);
  } catch (e) { return false; }
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
      <span class="hub-ic">${icon('memorisation', 26)}</span>
      <span class="hub-txt"><span class="hub-title">Semer</span>
        <span class="hub-sub">${memoSub}</span></span>
      <span class="chev">›</span></button>
    <a class="card hub-card fade" href="lire/">
      <span class="hub-ic">${icon('lecture', 26)}</span>
      <span class="hub-txt"><span class="hub-title">Marcher</span>
        <span class="hub-sub">Suis ton plan de lecture de la Bible, à ton rythme</span></span>
      <span class="chev">›</span></a>
    <a class="card hub-card fade" href="defi/">
      <span class="hub-ic">${icon('defi', 26)}</span>
      <span class="hub-txt"><span class="hub-title">Sonder</span>
        <span class="hub-sub">Des questions pour tester ta connaissance de la Bible, seul ou entre amis</span></span>
      <span class="chev">›</span></a>
    <a class="card hub-card fade home-daily" href="defi/#jour">
      <span class="hub-ic">${icon('soleil', 26)}</span>
      <span class="hub-txt"><span class="hub-title">Défi du jour</span>
        <span class="hub-sub">${defiDuJourFait() ? 'Relevé aujourd\'hui ✓ — reviens demain' : 'Ton rendez-vous quotidien, le même pour tous'}</span></span>
      <span class="chev">›</span></a>`;

  return topbar(true) + hero + hub;
}

/* ---------- Mémoriser : session du jour, apprendre, objectif, jardin ---------- */
function viewMemo() {
  const due = dueCards(), gardenN = masteredCards().length, learnN = learningCards().length, total = Object.keys(store.cards).length;
  const obj = activeColl();

  const head = `<button class="back-link" data-tab="home">‹ Accueil</button>
    <h2 style="font-family:var(--serif);margin-bottom:2px">${icon('memorisation', 19)} Semer</h2>
    <p class="muted" style="margin:0 2px 16px">Sème un verset dans ton cœur, arrose-le en le révisant — quand tu le sais par cœur, il s'enracine dans ton jardin.</p>`;

  // Carte « objectif » (ou invitation discrète), construite ici pour servir
  // aussi bien l'écran vierge que l'écran normal.
  let objectiveCard = '';
  if (obj) {
    const { m, total: ct } = collProgress(obj);
    const pct = ct ? Math.round(m / ct * 100) : 0;
    objectiveCard = `<div class="card objective fade"><div class="obj-head">
        <b>${icon('cible', 15)} Objectif : ${esc(obj.name)}</b>
        <button class="linkbtn" data-collections="1">Changer</button></div>
      <div class="coll-meter"><span class="gauge"><i style="width:${pct}%"></i></span>
        <span class="coll-count">${m}/${ct} mémorisé${m > 1 ? 's' : ''}</span></div></div>`;
  }

  if (total === 0) {
    return topbar() + head + `
      <div class="steps fade">
        <div class="step"><span class="si">${icon('lecture', 22)}</span><div><b>L'appli te propose quelques versets à étudier.</b><br><span class="muted">Tu n'as pas à choisir.</span></div></div>
        <div class="step"><span class="si">${icon('stylo', 22)}</span><div><b>Tu les reconstitues sur l'écran, de mémoire</b> — l'appli vérifie que c'est juste.</div></div>
        <div class="step"><span class="si">${icon('memorisation', 22)}</span><div><b>Réussi plusieurs fois</b>, chaque verset rejoint ton jardin — et revient avant que tu l'oublies.</div></div>
      </div>
      ${objectiveCard}
      <button class="btn btn-primary" data-learn="1">Semer mes premiers versets</button>
      ${obj ? '' : `<button class="linkbtn center" data-collections="1" style="display:block;margin:12px auto 0">${icon('cible', 14)} Choisir un objectif (facultatif)</button>`}`;
  }
  let actions = '';
  if (due.length > 0) {
    // Au-delà du plafond de session : on le dit avec douceur — les versets en
    // attente ne s'abîment pas, et personne ne doit rentrer de vacances
    // devant une montagne.
    const texte = due.length > REVISER_MAX
      ? `${due.length} versets t'attendent — on commence par les ${REVISER_MAX} plus anciens, les autres patienteront sans s'abîmer.`
      : `${due.length} verset${due.length > 1 ? 's' : ''} à revoir pour bien ${due.length > 1 ? 'les' : 'l\''} enraciner.`;
    actions += `<div class="card action fade"><div class="action-txt"><b>Arroser mes versets</b>
      <span class="muted">${texte}</span></div>
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
      <span class="stage">${icon('cible', 20)}</span><span class="vi-main"><span class="vi-ref">Choisir un objectif</span><br>
      <span class="vi-text">Facultatif — une collection de versets par thème ou par livre.</span></span><span class="chev">›</span></button>`;

  let progress = '';
  if (learnN > 0 && due.length > 0) {
    progress += `<button class="verse-item fade" data-review="1">
      <span class="stage">${icon('germe', 20)}</span><span class="vi-main"><span class="vi-ref">En apprentissage</span><br>
      <span class="vi-text">${learnN} verset${learnN > 1 ? 's' : ''} en cours de mémorisation</span></span><span class="chev">›</span></button>`;
  } else if (learnN > 0) {
    // Rien à revoir aujourd'hui : la ligne informe au lieu d'un tap muet
    // qui re-rendait le même écran sans aucun retour.
    const dans = Math.min.apply(null, learningCards().map(c => c.due)) - todayNum();
    const quand = dans <= 1 ? 'demain' : `dans ${dans} jours`;
    progress += `<div class="verse-item fade" style="cursor:default">
      <span class="stage">${icon('germe', 20)}</span><span class="vi-main"><span class="vi-ref">En apprentissage</span><br>
      <span class="vi-text">${learnN} verset${learnN > 1 ? 's' : ''} en route — à revoir ${quand}</span></span></div>`;
  }
  progress += `<button class="verse-item gardenlink fade" data-tab="garden">
      <span class="stage">${icon('arbre', 20)}</span><span class="vi-main"><span class="vi-ref">Mon jardin</span><br>
      <span class="vi-text">${gardenN} verset${gardenN > 1 ? 's' : ''} mémorisé${gardenN > 1 ? 's' : ''}</span></span><span class="chev">›</span></button>`;
  // Situer le verset, mode expert : après chaque exercice réussi, l'appli
  // demande déjà le livre ; en expert, elle demande aussi chapitre et numéro.
  progress += `<button class="verse-item fade" data-situer-expert="1">
      <span class="stage">${icon('cible', 20)}</span><span class="vi-main"><span class="vi-ref">Mode expert ${store.situerExpert ? '<span class="mini-badge">activé</span>' : ''}</span><br>
      <span class="vi-text vi-text-long">${store.situerExpert
        ? 'Situer chaque verset : le livre, puis le chapitre et le numéro. Touche pour revenir au mode simple.'
        : 'Tu situes déjà le livre de chaque verset réussi. En expert : le chapitre et le numéro aussi.'}</span></span>
      <span class="chev">${store.situerExpert ? '✓' : '›'}</span></button>`;

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
      <span class="stage">${complete ? icon('medaille', 20) : c.emoji || icon('lecture', 20)}</span>
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
  // Par fournées de SEMER_MAX, objectif choisi ou non : une collection entière
  // d'un coup ferait déferler autant de révisions dès le lendemain — le reste
  // attend sagement les prochaines fournées.
  const c = activeColl();
  if (c) {
    return c.verses.filter(id => !store.cards[id])
      .map(id => LIBRARY.find(v => v.id === id)).filter(Boolean).slice(0, SEMER_MAX);
  }
  return LIBRARY.filter(v => !store.cards[v.id]).slice(0, SEMER_MAX);
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
  session.situer = null;
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
  // Session plafonnée : les plus anciens d'abord, le reste patiente sans
  // s'abîmer (et rien n'empêche d'enchaîner une seconde session si on veut).
  session = { queue: due.slice(0, REVISER_MAX), idx: 0, done: [], mastered: [], celebrated: [] };
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
  if (session.phase === 'situer') {
    // Étape bonus après un exercice réussi : situer le verset. La référence
    // n'apparaît nulle part sur cet écran — c'est justement la question.
    // Au toucher d'une réponse, on RESTE sur cet écran le temps d'un vrai
    // retour : le bon choix passe en vert, le mauvais en rouge — aucune
    // ambiguïté possible — puis on avance tout seul (voir situerPickLivre).
    const st = session.situer;
    const opt = (attr, valeur, texte, bonne) => {
      let cls = '';
      if (st.revele && valeur === bonne) cls = ' bon';
      else if (st.revele && valeur === (attr === 'livre' ? st.choixLivre : st.choixRef)) cls = ' faux';
      return `<button class="chip situer-opt${cls}" data-situer-${attr}="${esc(valeur)}" ${st.revele ? 'disabled' : ''}>${esc(texte)}</button>`;
    };
    if (!st.refOptions) {
      const fb = !st.revele
        ? `<p class="muted center" style="font-size:.85rem;margin:14px 0 0">Se tromper ici ne compte pas — la référence, c'est le petit plus.</p>`
        : st.choixLivre === st.livre
          ? `<p class="situer-fb ok">${icon('coche', 14)} Exact !</p>`
          : `<p class="situer-fb faux">Pas celui-là — c'était ${esc(st.livre)}.</p>`;
      body = `<div class="ex-instr">C'est juste ! Une dernière chose…</div>
        <p class="situer-q">Dans quel <b>livre</b> se trouve ce verset ?</p>
        <div class="verse small">« ${esc(card.text)} »</div>
        <div class="situer-grid${st.revele ? ' revele' : ''}">${st.options.map(l => opt('livre', l, l, st.livre)).join('')}</div>
        ${fb}`;
    } else {
      const bonne = st.chapitre + '.' + st.versets;
      const fb = !st.revele ? ''
        : st.choixRef === bonne
          ? `<p class="situer-fb ok">${icon('coche', 14)} Au verset près !</p>`
          : `<p class="situer-fb faux">Pas tout à fait — c'était ${esc(st.livre)} ${esc(bonne)}.</p>`;
      body = `<div class="ex-instr">${esc(st.livre)}, exact !</div>
        <p class="situer-q">Et plus précisément — <b>chapitre et verset</b> ?</p>
        <div class="verse small">« ${esc(card.text)} »</div>
        <div class="situer-grid${st.revele ? ' revele' : ''}">${st.refOptions.map(r => opt('ref', r, st.livre + ' ' + r, bonne)).join('')}</div>
        ${fb}`;
    }
  } else if (session.phase === 'result') {
    const ok = session.result === 'success';
    // Retour de l'étape « situer » (si elle a eu lieu) : bienveillant dans
    // tous les cas — la bonne référence s'affiche juste en dessous, on la
    // relit et on avance.
    const st = session.situer;
    let situerFb = '';
    if (st && st.choixLivre !== null) {
      const okLivre = st.choixLivre === st.livre;
      const okRef = st.choixRef === null || st.choixRef === st.chapitre + '.' + st.versets;
      situerFb = okLivre && okRef
        ? `<p class="situer-fb ok">${icon('cible', 14)} Et bien situé${st.choixRef !== null ? ', au verset près' : ''} !</p>`
        : okLivre
          ? `<p class="situer-fb">${icon('cible', 14)} Bon livre — le chapitre viendra avec le temps 🙂</p>`
          : `<p class="situer-fb">${icon('cible', 14)} Il se trouve dans ${esc(st.livre)} — tu le retiendras 🙂</p>`;
    }
    body = `<div class="exresult ${ok ? 'ok' : 'ko'} fade">
        <div class="exres-icon">${icon(ok ? 'coche' : 'fleur', 34)}</div>
        <div class="exres-title">${ok ? (ex.hinted ? 'Juste ! (avec un coup d\'œil)' : 'Juste, de mémoire !') : 'Pas grave — on le reverra'}</div>
      </div>
      <div class="verse small" style="margin-top:8px">« ${esc(card.text)} »</div>
      <div class="ref">${esc(card.ref)}</div>
      ${situerFb}
      ${ok && isMastered(card) && session.mastered.includes(card.id) ? `<p class="center" style="color:var(--grow);font-weight:650;margin-top:12px">${icon('germe', 15)} Planté dans ton jardin !</p>` : ''}
      <button class="btn btn-grow btn-block" data-snext="1" style="margin-top:16px">Continuer</button>`;
  } else { // exercise
    const label = ex.type === 'scramble' ? 'Remets les mots dans l\'ordre' : 'Complète les mots manquants';
    body = `<div class="ex-instr">${label}</div>` +
      (ex.showHint ? `<div class="hint-reveal fade">« ${esc(card.text)} »</div>` : '') +
      (ex.type === 'scramble' ? renderScramble(ex) : renderFill(ex)) +
      (ex.wrong ? `<p class="ex-wrong fade">Pas tout à fait — corrige les mots en rouge, puis revérifie.</p>` : '') +
      `<button class="btn btn-primary" data-check="1" ${exComplete(ex) ? '' : 'disabled'} style="margin-top:14px">Vérifier</button>
       <div class="ex-tools">
         <button class="linkbtn" data-hint="1">${icon('oeil', 14)} Revoir le verset</button>
         <button class="linkbtn" data-giveup="1">Voir la réponse</button>
       </div>`;
  }

  return `<div class="fade">
    <button class="back-link" data-tab="memo">${icon('croix', 13)} Quitter</button>
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
  if (window.GrainePierres) GrainePierres.verifier(); // série, jours… une pierre peut se poser
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
    <div class="seal">${icon(mastered > 0 ? 'germe' : 'pousse', 42)}</div>
    <h2 style="font-family:var(--serif);margin:10px 0">C'est fait pour aujourd'hui</h2>
    <p class="muted">${done} verset${done > 1 ? 's' : ''} travaillé${done > 1 ? 's' : ''}${mastered > 0 ? ` · ${mastered} planté${mastered > 1 ? 's' : ''} 🌱` : ''} · série de ${s} jour${s > 1 ? 's' : ''} 🔥</p>
    <button class="btn btn-primary" data-tab="home" style="margin-top:20px">Revenir à l'accueil</button>
    <p class="muted" style="margin-top:14px">Repose-toi — trop en faire aujourd'hui n'aide pas. À demain 🙂</p>
  </div>`;
}

/* ---------- Moi : sections repliables ----------
   L'écran Moi est long : chaque bloc secondaire se replie, fermé par défaut,
   et les rangées vivent ensemble dans UNE carte-liste (.moi-liste) — même
   langage que la carte de compte au-dessus. L'intitulé à gauche, le résumé
   en colonne à droite, le chevron contre le bord (voir app.css).
   `moiOuverts` mémorise l'état déplié : une action re-rend tout l'écran, et
   une section ouverte doit le rester (cf. l'onglet Activité de l'admin).
   Les messages d'une section (erreur, confirmation) passent par `alerte` :
   rendus HORS du <details>, ils restent visibles sans avoir à ouvrir. */
let moiOuverts = {};
function moiRepli(cle, titre, resume, corps, alerte) {
  return `<details class="moi-repli" data-cle="${cle}" ${moiOuverts[cle] ? 'open' : ''}>
      <summary><span class="mr-titre">${titre}</span><span class="mr-resume">${esc(resume)}</span></summary>
      <div class="mr-corps">${corps}</div>
    </details>
    ${alerte || ''}`;
}

/* ---------- Moi : espace personnel (stats locales, jardin, compte & amis) ---------- */
function viewMoi() {
  const user = window.GraineAPI ? GraineAPI.user() : null;
  const gardenN = masteredCards().length, learnN = learningCards().length;
  const completedN = store.completedCollections.length;
  const streakN = store.streak.count || 0, bestN = store.bestStreak || 0, daysN = store.activeDays || 0;
  const lire = lireStats(), defi = defiStats();
  const tile = (n, l) => `<div class="stat-tile"><div class="st-n">${n}</div><div class="st-l">${l}</div></div>`;

  const head = `<div class="card me-head fade"><div class="me-emoji">${icon('memorisation', 30)}</div>
    <h2>Bienvenue chez toi</h2>
    <p class="muted">${user
      ? `Ton chemin avec la Parole, en un coup d'œil — sauvegardé sur ton compte.`
      : `Ton chemin avec la Parole, en un coup d'œil. Tout reste sur ton appareil.`}</p></div>`;

  const account = user ? moiAccountCard(user) : moiInviteCard();

  // Apparence : quatre pastilles, le choix s'applique immédiatement.
  const theme = themeChoice();
  const tpill = (v, l) => `<button class="pill ${theme === v ? 'on' : ''}" data-theme-pick="${v}">${l}</button>`;
  const themeNoms = { auto: 'auto', clair: 'clair', sombre: 'sombre', sepia: 'sépia' };
  const apparence = moiRepli('apparence', `${icon('apparence')} Apparence`, themeNoms[theme] || 'auto',
    `<div class="card fade">
      <div class="pill-row">${tpill('auto', 'Auto')}${tpill('clair', icon('soleil', 14) + ' Clair')}${tpill('sombre', icon('lune', 14) + ' Sombre')}${tpill('sepia', icon('parchemin', 14) + ' Sépia')}</div>
      <p class="muted" style="font-size:.85rem;margin:12px 2px 0">« Auto » suit le réglage clair/sombre de ton appareil. Ton choix vaut pour toute l'appli.</p>
    </div>`);

  // « Le verset offert » — notifications quotidiennes, sur le même modèle.
  const pousse = moiPushCard();

  const memo = moiRepli('memo', `${icon('memorisation')} Mémorisation`,
    `${gardenN} verset${gardenN > 1 ? 's' : ''} mémorisé${gardenN > 1 ? 's' : ''}`,
    `<div class="stat-grid fade">
      ${tile(gardenN, `verset${gardenN > 1 ? 's' : ''} mémorisé${gardenN > 1 ? 's' : ''}`)}
      ${tile(learnN, 'en apprentissage')}
      ${tile(streakN + ' 🔥', 'série actuelle (jours)')}
      ${tile(bestN, 'plus longue série')}
      <div class="stat-tile wide"><div class="st-n">${completedN}</div>
        <div class="st-l">collection${completedN > 1 ? 's' : ''} complétée${completedN > 1 ? 's' : ''}</div></div>
    </div>`);

  const assiduite = moiRepli('assiduite', `${icon('assiduite')} Assiduité`,
    `${daysN} jour${daysN > 1 ? 's' : ''} d'activité`,
    `<div class="stat-grid fade">
      <div class="stat-tile wide"><div class="st-n">${daysN}</div>
        <div class="st-l">jour${daysN > 1 ? 's' : ''} d'activité en tout</div></div>
    </div>`);

  // Pierres du chemin (badges-souvenirs, voir pierres.js) : SEULEMENT les
  // pierres reçues — jamais de grille grisée de ce qui manquerait.
  const pierresList = window.GrainePierres ? GrainePierres.lues() : [];
  const pierresTiles = pierresList.map(p => `<div class="pierre-tile fade">
      <span class="pi-emoji">${p.emoji}</span>
      <span class="pi-main"><span class="pi-nom">${esc(p.nom)}</span>
        <span class="pi-phrase">${esc(p.phrase)}</span>
        <span class="pi-date">posée le ${esc(p.date)}</span></span>
    </div>`).join('');
  const pierresSec = moiRepli('pierres', `${icon('pierres')} Pierres du chemin`,
    pierresList.length ? `${pierresList.length} posée${pierresList.length > 1 ? 's' : ''}` : 'aucune pour l\'instant',
    `<p class="muted me-note fade" style="margin-top:0">Des badges-souvenirs qui marquent un pas réel du chemin — premier
      verset planté, premier chapitre lu, premier défi relevé… Une pierre se pose une seule fois,
      et ne se retire jamais.</p>
    <p class="pierres-quote fade">« Que signifient ces pierres ? » — Josué 4.21</p>
    ${pierresList.length
      ? pierresTiles + `<p class="muted me-note center">D'autres pierres se poseront au fil du chemin.</p>`
      : `<p class="muted me-note center fade">Tes pierres se poseront ici, une à une, au fil du chemin.</p>`}`);

  const lireSec = moiRepli('lecture', `${icon('lecture')} Lecture`,
    `${lire.chapters} chapitre${lire.chapters > 1 ? 's' : ''} lu${lire.chapters > 1 ? 's' : ''}`,
    `<div class="stat-grid fade">
      ${tile(lire.chapters, `chapitre${lire.chapters > 1 ? 's' : ''} lu${lire.chapters > 1 ? 's' : ''}`)}
      ${tile(lire.books, `livre${lire.books > 1 ? 's' : ''} terminé${lire.books > 1 ? 's' : ''}`)}
    </div>
    ${lire.chapters === 0 ? `<p class="muted me-note">Pas encore commencé — le module Lire t'attend, à ton rythme.</p>` : ''}`);

  const defiSec = moiRepli('defi', `${icon('defi')} Défi`,
    `${defi.defis} défi${defi.defis > 1 ? 's' : ''} relevé${defi.defis > 1 ? 's' : ''}`,
    `<div class="stat-grid fade">
      ${tile(defi.defis, `défi${defi.defis > 1 ? 's' : ''} relevé${defi.defis > 1 ? 's' : ''}`)}
      ${tile(defi.bestScore === null ? '—' : defi.bestScore, defi.bestScoreLabel.toLowerCase())}
      ${tile(defi.bestSerie, 'meilleure série de bonnes réponses')}
    </div>
    ${defi.defis === 0 ? `<p class="muted me-note">Pas encore commencé — relève ton premier défi quand tu veux.</p>` : ''}`);

  const friends = user ? moiFriendsSection(user) : '';

  // Mon église — connecté seulement (l'invitation à se connecter est déjà là).
  const eglise = user ? moiEgliseSection() : '';

  // Faire découvrir l'appli — visible pour tous, connecté ou non.
  const invite = moiPartageCard();

  // Petite carte discrète vers l'espace d'administration — seulement pour
  // les comptes dont l'e-mail figure dans ADMIN_EMAILS (champ isAdmin du
  // payload utilisateur ; le serveur revérifie de toute façon à chaque route).
  const admin = user && user.isAdmin ? `<a class="card hub-card fade" href="admin/" style="margin-top:14px">
      <span class="hub-ic">${icon('outil', 26)}</span>
      <span class="hub-txt"><span class="hub-title">Administration</span>
        <span class="hub-sub">Comptes et banque de questions du Défi</span></span>
      <span class="chev">›</span></a>` : '';

  const sections = `<div class="card moi-liste fade">${apparence}${pousse}${memo}${assiduite}${pierresSec}${lireSec}${defiSec}${friends}${eglise}${invite}</div>`;
  return topbar() + head + account + sections + admin;
}

/* ---------- Jardin (versets mémorisés) ---------- */
let gardenView = 'list'; // 'list' | 'coll' — préférence d'affichage, non persistée
function gardenItem(c) {
  const st = stageOf(c), badge = c.due <= todayNum() ? '<span class="badge-due">à revoir</span>' : '';
  return `<button class="verse-item" data-verse="${esc(c.id)}"><span class="stage" title="${st.label}">${icon(st.iconName, 20)}</span>
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
      return `<div class="section-title">${icon('medaille')} ${esc(col.name)}</div>` + own.map(gardenItem).join('');
    }).join('');
    const rest = cards.filter(c => !seen.has(c.id));
    if (rest.length) list += `<div class="section-title">Autres versets</div>` + rest.map(gardenItem).join('');
  } else {
    list = cards.map(gardenItem).join('');
  }
  const learn = learningCards();
  const learnList = learn.length ? `<div class="section-title">En apprentissage</div>` + learn.map(c =>
    `<div class="verse-item"><span class="stage">${icon('grainePosee', 20)}</span><span class="vi-main"><span class="vi-ref">${esc(c.ref)}</span><br>
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
        <span>${icon(st.iconName, 28)}</span>
        <div><b>${st.label}</b><br><span class="muted" style="font-size:.9rem">${when}</span></div></div>
      ${vctx}
      ${ctx ? `<div class="context-box"><b>Contexte — ${esc(book)}.</b> ${esc(ctx)}</div>` : ''}</div>
    <button class="btn btn-ghost btn-block" data-remove="${esc(id)}" style="color:var(--danger);border-color:var(--danger)">Retirer de mon jardin</button></div>`;
}
function viewAbout() {
  return topbar() + `<h2 style="font-family:var(--serif)">À propos</h2>
    <div class="card"><p><b>Bible Horizon</b> t'aide à faire grandir la Parole dans ton cœur, un peu chaque jour — trois chemins qui se complètent :</p>
      <p>${icon('memorisation', 16)} <b>Semer.</b> Mémorise des versets pas à pas ; l'appli vérifie, puis les fait revenir juste avant que tu ne les oublies. Ton jardin garde la trace de chaque verset planté.</p>
      <p>${icon('lecture', 16)} <b>Marcher.</b> Un plan de lecture « chemin, pas calendrier » : un évangile, un testament ou toute la Bible — à ton rythme, jamais de retard, jamais de culpabilité.</p>
      <p>${icon('defi', 16)} <b>Sonder.</b> Des questions sur les récits bibliques : seul, à plusieurs sur un appareil, en duel avec un ami, ou en direct dans ton église, sur grand écran. Chaque réponse ramène vers le texte.</p></div>
    <div class="section-title">Nos principes</div>
    <div class="card">
      <p>${icon('colombe', 16)} <b>Gratuit, pour toujours.</b> Aucune fonction payante, aucune publicité.</p>
      <p>${icon('cadenas', 16)} <b>Vie privée d'abord.</b> Tout fonctionne hors-ligne, sans compte. Le compte est facultatif (e-mail + pseudo, rien d'autre) et se supprime en un geste.</p>
      <p>${icon('memorisation', 16)} <b>Encourager, pas culpabiliser.</b> Pas de « retard », pas de reproche.</p>
      <p>${icon('lecture', 16)} <b>Respect du texte.</b> Versets ${esc(LIB_VERSION)} (domaine public).</p></div>
    <div class="section-title">Soutenir Bible Horizon</div>
    <div class="card">
      <p>L'appli est gratuite, sans publicité, sans compte obligatoire — et elle le restera. Ce n'est pas un modèle économique, c'est une conviction : <b>la Parole ne se vend pas</b>.</p>
      <p>Alors si Bible Horizon te fait du bien et que tu veux donner quelque chose en retour, voici la plus belle rémunération que tu puisses nous offrir : <b>fais-la découvrir</b>. Un message à un ami, un mot dans ton groupe de jeunes, une annonce dans ton église — chaque personne qui s'ancre dans la Parole grâce à toi vaut plus que n'importe quel prix d'achat.</p>
      <p>Et si tu veux aller plus loin : <a href="mailto:contact@biblehorizon.fr?subject=Mon%20retour%20sur%20Bible%20Horizon" style="color:var(--accent-ink)">raconte-nous</a> ce que l'appli change pour toi, et ce qui lui manque. Vos retours la font grandir — celle que tu utilises aujourd'hui est déjà pleine des idées de ses premiers utilisateurs.</p>
      <button class="btn btn-primary btn-block" data-invite="1" style="margin-top:6px">Faire découvrir Bible Horizon</button>
    </div>
    <div class="section-title">Pour les églises</div>
    <div class="card">
      <p>${icon('eglise', 16)} <b>Pasteur, responsable d'église ou de jeunesse ?</b> Tu aimerais utiliser Bible Horizon avec ton assemblée — quiz sur grand écran, groupes, suivi ? Écris-nous : on regardera ensemble comment l'adapter au mieux à tes besoins.</p>
      <p class="center" style="margin-top:12px"><a class="btn btn-soft" href="mailto:contact@biblehorizon.fr?subject=Bible%20Horizon%20pour%20mon%20%C3%A9glise">contact@biblehorizon.fr</a></p>
      <p class="muted center" style="font-size:.85rem;margin-top:10px"><a href="eglises/" style="color:var(--accent-ink)">Tout savoir sur le quiz dans ton église →</a></p>
    </div>
    <p class="muted center" style="margin-top:20px">« La semence, c'est la parole de Dieu. » — Luc 8.11</p>
    <p class="muted center" style="font-size:.8rem;margin-top:10px">Version 0.3 · projet en construction</p>`;
}

/* ============================================================================
   Compte, synchronisation & amis — serveur FACULTATIF (voir API-CONTRAT.md).
   Le local reste la base : sans compte ou hors-ligne, rien ne change.
   ========================================================================== */
const LIRE_KEY = 'graine.lire.v1', DEFI_KEY = 'graine.defi.v1';
const PIERRES_KEY = 'graine.pierres.v1'; // pierres du chemin (voir pierres.js) — voyagent dans le blob memo
const SYNC_META_KEY = 'graine.sync.meta';
const EXPIRED_KEY = 'graine.session.expiree'; // « ta session a expiré » à montrer sur Moi

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
  // Pierres du chemin (badges-souvenirs, champ `pierres` du blob memo) :
  // UNION des deux côtés — une pierre posée ne se retire jamais — et pour
  // chacune le dayNumber MINIMUM (on garde la date la plus ancienne).
  const lp = out.pierres && typeof out.pierres === 'object' && !Array.isArray(out.pierres) ? out.pierres : {};
  const sp = srv.pierres && typeof srv.pierres === 'object' && !Array.isArray(srv.pierres) ? srv.pierres : {};
  const pierres = {};
  for (const id of new Set(Object.keys(lp).concat(Object.keys(sp)))) {
    const j = minN(lp[id], sp[id]);
    if (j !== undefined) pierres[id] = j;
  }
  out.pierres = pierres;
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
    // Un chemin sans séquence exploitable est écarté : lire.js filtrera en
    // plus les ids de livres inconnus (le catalogue vit là-bas).
    b.plans = Array.isArray(b.plans)
      ? b.plans.filter(p => p && typeof p === 'object' && Array.isArray(p.seq)
          && p.seq.length > 0 && p.seq.every(id => typeof id === 'string'))
      : [];
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
    // Les pierres du chemin voyagent dans le blob memo (champ `pierres`) mais
    // vivent localement dans leur propre clé : on les greffe sur une COPIE du
    // store avant la fusion, puis on les range à part — graine.v3 n'en garde rien.
    const memoLocal = Object.assign({}, store, { pierres: readLocalBlob(PIERRES_KEY) || {} });
    const mergedMemo = mergeMemo(memoLocal, remote.memo);
    if (mergedMemo) {
      try { localStorage.setItem(PIERRES_KEY, JSON.stringify(mergedMemo.pierres || {})); } catch (e) {}
      delete mergedMemo.pierres;
      if (!session) { store = normalizeStore(mergedMemo); saveStore(); }
    }
    const mergedLire = mergeLire(readLocalBlob(LIRE_KEY), remote.lire);
    if (mergedLire) localStorage.setItem(LIRE_KEY, JSON.stringify(mergedLire));
    const mergedDefi = mergeDefi(readLocalBlob(DEFI_KEY), remote.defi);
    if (mergedDefi) localStorage.setItem(DEFI_KEY, JSON.stringify(mergedDefi));
    // 3) puis push du résultat fusionné (le memo emporte les pierres avec lui).
    const blobs = {};
    if (!session) blobs.memo = Object.assign({}, store, { pierres: readLocalBlob(PIERRES_KEY) || {} });
    if (mergedLire) blobs.lire = mergedLire;
    if (mergedDefi) blobs.defi = mergedDefi;
    if (Object.keys(blobs).length) await GraineAPI.syncPut(blobs);
    syncCompletedCollections(); // la fusion peut révéler des collections complètes
    if (window.GrainePierres) GrainePierres.verifier(); // la progression fusionnée peut mériter une pierre
    syncUi.status = 'ok';
    syncUi.lastAt = new Date().toISOString();
    saveSyncMeta();
    try { localStorage.removeItem(EXPIRED_KEY); } catch (err) {} // la session marche : plus rien à signaler
    if (friendsCache === 'error') friendsCache = null; // on est en ligne : on retentera la liste d'amis
    if (groupesCache === 'error') groupesCache = null; // idem pour la section église
  } catch (e) {
    if (e && e.status === 401) {
      // Session expirée : api-client a déjà effacé la session locale. Sans
      // trace, l'utilisateur croirait sa progression encore sauvegardée —
      // on pose un petit mot doux, affiché sur l'écran Moi.
      try { localStorage.setItem(EXPIRED_KEY, '1'); } catch (err) {}
      syncUi.status = 'idle';
    } else {
      // Hors-ligne ou erreur : AUCUN message intrusif — on réessaiera.
      syncUi.status = (e && e.offline) ? 'offline' : 'error';
    }
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
// Re-rendre sans gêner : seulement sur Moi, le parcours compte et l'onglet
// Mon église, et jamais pendant que l'utilisateur écrit dans un champ.
function renderIfIdle() {
  if (!['moi', 'account', 'eglise', 'banques'].includes(route.name)) return;
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
      <h2 style="font-family:var(--serif);margin-bottom:2px">${icon('nuage', 19)} Ton compte</h2>
      <p class="muted" style="margin:0 2px 14px">Gratuit et facultatif : sauvegarde ta progression, retrouve-la partout, défie tes amis. On te demande un e-mail et un pseudo — rien d'autre, jamais ton vrai nom.</p>
      <div class="card">
        <form data-authstep="email" novalidate>
          <label class="lbl" for="auth-email">Ton adresse e-mail</label>
          <input class="field" type="email" id="auth-email" inputmode="email" autocomplete="email" placeholder="toi@exemple.fr" value="${esc(auth.email)}">
          ${err}
          <button class="btn btn-primary" type="submit" ${busy} style="margin-top:14px">${auth.busy ? 'Envoi…' : 'Recevoir mon code'}</button>
        </form>
        <p class="muted" style="font-size:.85rem;margin:12px 2px 0">Pas de mot de passe : on t'envoie un code à 6 chiffres par e-mail, valable 45 minutes. Il peut mettre quelques minutes à arriver — pense à vérifier tes courriers indésirables.</p>
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
      <h2 style="font-family:var(--serif);margin-bottom:2px">${icon('enveloppe', 19)} Ton code</h2>
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
      <h2 style="font-family:var(--serif);margin-bottom:2px">${icon('moi', 19)} Ton pseudo</h2>
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
  let expiree = false;
  try { expiree = localStorage.getItem(EXPIRED_KEY) === '1'; } catch (e) {}
  return `<div class="card account-card fade">
    ${expiree ? `<p class="field-ok" style="margin:0 0 10px">Ta session a expiré — reconnecte-toi pour reprendre la sauvegarde. Tes données restent sur cet appareil.</p>` : ''}
    ${accountNotice ? `<p class="field-ok" style="margin:0 0 10px">${esc(accountNotice)}</p>` : ''}
    <div class="acc-head"><span class="acc-ic">${icon('nuage', 22)}</span><b>Synchronise et retrouve tes amis</b></div>
    <p class="muted">Sauvegarde ta progression, retrouve-la sur tous tes appareils, défie tes amis.</p>
    <p class="muted acc-privacy">${icon('cadenas', 13)} Facultatif et gratuit. E-mail + pseudo, rien d'autre — jamais ton vrai nom.</p>
    <button class="btn btn-primary" data-account="1" style="margin-top:12px">Créer mon compte / Me connecter</button>
  </div>`;
}
// La ligne de synchro suit le motif du code ami : l'état à gauche, l'action
// discrète à droite. Pas de gros bouton — tout se synchronise déjà tout seul.
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
    actions = `<div class="btn-row" style="margin-top:12px">
        <button class="btn btn-ghost" data-editpseudo="1">Changer de pseudo</button>
        <button class="btn btn-ghost" data-logout="1">Se déconnecter</button>
      </div>`;
  }
  return `<div class="card account-card fade">
    <div class="acc-user"><span class="acc-ic">${icon('nuage', 22)}</span>
      <div class="acc-id"><b>${esc(u.pseudo)}</b><br><span class="muted acc-mail">${esc(u.email)}</span></div></div>
    <div class="friend-code-row">
      <div><div class="fc-label">Code ami</div><div class="friend-code" id="friendCode">${esc(u.friendCode)}</div></div>
      <button class="btn btn-soft" data-copycode="1">Copier</button></div>
    <div class="sync-line"><span class="sync-status muted">${esc(syncStatusText())}</span>
      <button class="linkbtn" data-syncnow="1" ${syncUi.status === 'syncing' ? 'disabled' : ''}>Synchroniser</button></div>
    ${actions}
    ${accountError ? `<p class="field-error">${esc(accountError)}</p>` : ''}
    <details class="danger-zone"><summary>Supprimer mon compte…</summary>
      <p class="muted" style="margin:8px 2px">Cela efface <b>tout sur le serveur</b> : compte, sauvegarde, amis, duels. Tes données locales, elles, restent sur cet appareil.</p>
      <button class="btn btn-ghost btn-block btn-danger" data-delaccount="1">Oui, supprimer mon compte du serveur</button>
    </details>
  </div>`;
}
function egliseOublier() { // à la déconnexion / suppression : plus rien d'église à montrer
  groupesCache = null; groupeDetails = {}; demandeCache = undefined; versetEdit = null;
  grpCodeField = grpNomField = grpAdrField = grpMailField = ''; grpError = grpNotice = null;
  // L'onglet et sa page partent avec le compte — copies hors-ligne comprises :
  // sur un appareil partagé, la page de l'assemblée ne survit pas à la session.
  egliseSel = null; pageCache = {}; pageMeta = {}; pageTentee = {}; pageEdit = null; pageNotice = pageError = null;
  bqCache = {}; bqTentee = {}; bqSel = null; bqEdit = null; bqNotice = bqError = null;
  if (route.name === 'banques') route = { name: 'moi', param: null };
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith(PAGE_CACHE_PREFIX))
      .forEach(k => localStorage.removeItem(k));
  } catch (e) { /* stockage inaccessible : rien à effacer */ }
  if (route.name === 'eglise') route = { name: 'moi', param: null };
}
async function doLogout() {
  await GraineAPI.logout(); // même hors-ligne, la session locale est effacée
  pseudoEdit = null; friendsCache = null; friendField = ''; friendError = friendNotice = null;
  egliseOublier();
  syncUi = { status: 'idle', lastAt: null };
  try { localStorage.removeItem(SYNC_META_KEY); localStorage.removeItem(EXPIRED_KEY); } catch (e) {}
  accountNotice = 'Tu es déconnecté. Tes données locales sont intactes.';
  render();
}
async function doDeleteAccount() {
  accountError = null;
  try {
    await GraineAPI.deleteAccount();
    pseudoEdit = null; friendsCache = null; friendField = ''; friendError = friendNotice = null;
    egliseOublier();
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

/* ---------- Invitation & partage (bouche-à-oreille, sobre) ----------
   Un seul chemin : navigator.share quand il existe (mobile — WhatsApp & co),
   sinon copie dans le presse-papiers avec une petite confirmation.
   L'URL partagée est location.origin : elle suivra le domaine du site. */
function toastCopie(message) {
  const old = document.querySelector('.toast-copie');
  if (old) old.remove();
  const t = document.createElement('div');
  t.className = 'toast-copie';
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 2200);
}
function partager(texte) {
  if (navigator.share) { navigator.share({ text: texte }).catch(() => { /* partage annulé : rien à faire */ }); return; }
  const done = () => toastCopie('Copié — colle-le où tu veux 🙂');
  const fallback = () => { // repli : sélection + execCommand (vieux navigateurs)
    try {
      const ta = document.createElement('textarea');
      ta.value = texte; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { /* tant pis : rien d'intrusif */ }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texte).then(done).catch(fallback);
  else fallback();
}
// Texte d'invitation : le même pour tous ; connecté, le code ami s'y glisse
// (lu au moment du clic — jamais figé dans le HTML).
function texteInvitation() {
  const u = window.GraineAPI ? GraineAPI.user() : null;
  let t = 'Découvre Bible Horizon : mémorise des versets, lis la Bible à ton rythme, relève des défis bibliques. Gratuit et sans pub.';
  if (u && u.friendCode) t += ` Rejoins-moi : mon code ami est ${u.friendCode}.`;
  return t + '\n' + location.origin;
}
// La section « Fais découvrir » de l'écran Moi — pour tous, connecté ou non.
function moiPartageCard() {
  return moiRepli('partage', `${icon('partage')} Fais découvrir`, 'invite un proche',
    `<div class="card account-card fade">
      <p class="muted" style="margin:0">Quelqu'un autour de toi aimerait peut-être, lui aussi, avancer dans la Parole — un simple message suffit.</p>
      <button class="btn btn-soft btn-block" data-invite="1" style="margin-top:10px">Inviter un proche</button>
    </div>`);
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
    .then(f => {
      friendsCache = Array.isArray(f) ? f : [];
      // Au moins un ami relié (peut-être depuis un autre appareil) : la pierre
      // « Deux valent mieux qu'un » peut se poser.
      if (friendsCache.length > 0 && window.GrainePierres) { GrainePierres.drapeau('ami'); GrainePierres.verifier(); }
    })
    .catch(() => { friendsCache = 'error'; })
    .then(() => { friendsLoading = false; renderIfIdle(); });
}
function moiFriendsSection(u) {
  let list;
  if (friendsCache === null) list = `<p class="muted fr-empty">Chargement de ta liste d'amis…</p>`;
  else if (friendsCache === 'error') list = `<p class="muted fr-empty">Ta liste d'amis apparaîtra dès que tu seras en ligne.</p>`;
  else if (!friendsCache.length) list = `<p class="muted fr-empty">Pas encore d'ami — échangez vos codes pour vous retrouver.</p>`;
  else list = friendsCache.map(f => `<div class="friend-row">
      <span class="fr-avatar">${icon('moi', 18)}</span>
      <span class="fr-main"><b>${esc(f.pseudo)}</b><br><span class="muted fr-since">${esc(sinceText(f.since))}</span></span>
      <button class="fr-x" data-unfriend="${esc(f.friendCode)}" data-pseudo="${esc(f.pseudo)}" title="Retirer cet ami" aria-label="Retirer ${esc(f.pseudo)}">${icon('croix', 13)}</button>
    </div>`).join('');
  let resume;
  if (friendsCache === null) resume = '…';
  else if (friendsCache === 'error') resume = 'hors-ligne';
  else resume = friendsCache.length ? String(friendsCache.length) : 'aucun pour l\'instant';
  // Erreur et confirmation HORS du repli : visibles même section fermée.
  const alerte = (friendError ? `<p class="field-error mr-alerte">${esc(friendError)}</p>` : '')
    + (friendNotice ? `<p class="field-ok mr-alerte">${esc(friendNotice)}</p>` : '');
  return moiRepli('amis', `${icon('amis')} Mes amis`, resume,
    `<div class="card friends-card fade">
      <p style="margin:0 0 10px">Ton code ami : <span class="friend-code inline">${esc(u.friendCode)}</span></p>
      <form data-addfriendform="1" class="add-friend-row">
        <input class="field" type="text" id="friendInput" placeholder="Code d'un ami (GRN-XXXX)" autocomplete="off" autocapitalize="characters" value="${esc(friendField)}">
        <button class="btn btn-grow" type="submit">Ajouter</button>
      </form>
      ${list}
    </div>
    <p class="muted me-note">Pour vous défier, rendez-vous dans Défi → « Défier un ami ».</p>`, alerte);
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
    // Premier ami relié : la pierre « Deux valent mieux qu'un » se pose.
    if (window.GrainePierres) { GrainePierres.drapeau('ami'); GrainePierres.verifier(); }
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

/* ---------- Mon église (groupes — voir api/groupes.php) ----------
   On rejoint le groupe de son église par code (GRP-XXXXX) ; la CRÉATION passe
   par une demande validée par l'administrateur. Le cœur de la section : le
   verset de la semaine, offert au groupe par le responsable. */
let groupesCache = null;    // null = pas chargé | 'error' | [ { code, nom, role, nbMembres, verset } ]
let groupesLoading = false;
let groupeDetails = {};     // détail par code (liste des membres — pseudo + rôle, jamais d'e-mail)
let demandeCache;           // undefined = pas chargée | null | { nom, statut: 'attente'|'refusee', createdAt }
let grpCodeField = '', grpNomField = '', grpAdrField = '', grpMailField = '';
let grpError = null, grpNotice = null;
let versetEdit = null;      // { code, reference, texte, error, busy } — formulaire du responsable

function normalizeGroupCode(raw) {
  let c = String(raw || '').toUpperCase().replace(/[\s-]+/g, '');
  if (/^[A-Z0-9]{5}$/.test(c)) c = 'GRP' + c; // on tolère les 5 caractères seuls
  return /^GRP[A-Z0-9]{5}$/.test(c) ? 'GRP-' + c.slice(3) : null;
}
function ensureGroupes() {
  if (!window.GraineAPI || !GraineAPI.isLoggedIn() || groupesCache !== null || groupesLoading) return;
  groupesLoading = true;
  GraineAPI.mesGroupes()
    .then(async gs => {
      groupesCache = Array.isArray(gs) ? gs : [];
      if (groupesCache.length) {
        // Le détail apporte la liste des membres ; s'il manque (réseau), la
        // carte s'affiche quand même — sans la liste, jamais d'erreur brute.
        await Promise.all(groupesCache.map(g => GraineAPI.groupeDetail(g.code)
          .then(d => { if (d) groupeDetails[g.code] = d; })
          .catch(() => { /* la carte vivra sans sa liste */ })));
      } else {
        // Sans groupe : où en est la demande d'ouverture ? Si la route n'est
        // pas joignable, on propose simplement les deux chemins.
        await GraineAPI.groupeDemande()
          .then(d => { demandeCache = d || null; })
          .catch(() => { demandeCache = null; });
      }
    })
    .catch(() => { groupesCache = 'error'; })
    .then(() => { groupesLoading = false; renderIfIdle(); });
}
// Après un changement d'adhésion (rejoindre, quitter, demande acceptée…),
// tout se recharge depuis le serveur — la source de vérité.
function egliseRecharger() {
  groupesCache = null; groupeDetails = {}; demandeCache = undefined; versetEdit = null;
  ensureGroupes();
}

function moiEgliseSection() {
  // Dans un groupe : la vie d'église a son onglet dans la barre — cette
  // section de Moi ne sert plus que l'ENTRÉE (rejoindre, demander).
  if (Array.isArray(groupesCache) && groupesCache.length) return '';
  let corps;
  if (groupesCache === null) corps = `<div class="card fade"><p class="muted fr-empty" style="margin:0">Chargement…</p></div>`;
  else if (groupesCache === 'error') corps = `<div class="card fade"><p class="muted fr-empty" style="margin:0">Ta section église apparaîtra dès que tu seras en ligne.</p></div>`;
  else corps = moiSansGroupeCard();
  // Le résumé dit l'essentiel sans ouvrir.
  let resume;
  if (groupesCache === null) resume = '…';
  else if (groupesCache === 'error') resume = 'hors-ligne';
  else if (demandeCache === undefined) resume = '…';
  else if (demandeCache && demandeCache.statut === 'attente') resume = 'demande en attente';
  else resume = 'rejoindre ou demander';
  // Erreur et confirmation HORS du repli : visibles même section fermée.
  const alerte = (grpNotice ? `<p class="field-ok mr-alerte">${esc(grpNotice)}</p>` : '')
    + (grpError ? `<p class="field-error mr-alerte">${esc(grpError)}</p>` : '');
  return moiRepli('eglise', `${icon('eglise')} Mon église`, resume, corps, alerte);
}

// Sans groupe : deux chemins (rejoindre par code, demander l'ouverture) —
// ou l'état de la demande déjà posée, si elle existe.
function moiSansGroupeCard() {
  if (demandeCache === undefined) {
    return `<div class="card fade"><p class="muted fr-empty" style="margin:0">Chargement…</p></div>`;
  }
  if (demandeCache && demandeCache.statut === 'attente') {
    return `<div class="card friends-card fade">
      <p style="margin:0 0 4px">Ta demande pour « <b>${esc(demandeCache.nom)}</b> » attend une réponse.</p>
      ${demandeCache.adresse ? `<p class="muted" style="margin:0 0 4px">${esc(demandeCache.adresse)}</p>` : ''}
      <p class="muted">L'administrateur la regarde bientôt — le groupe apparaîtra ici dès qu'il sera ouvert.</p>
      <button class="linkbtn" data-grpdemcancel="1">Annuler ma demande</button>
    </div>`;
  }
  // Refusée : un mot doux, et les deux chemins restent grands ouverts.
  const refus = demandeCache && demandeCache.statut === 'refusee'
    ? `<p class="muted" style="margin:0 0 12px">Ta demande pour « ${esc(demandeCache.nom)} » n'a pas abouti cette fois — rien de grave.
        Tu peux en poser une nouvelle quand tu veux, ou rejoindre un groupe existant avec un code.</p>`
    : `<p class="muted" style="margin:0 0 12px">Retrouve ton assemblée ici : le verset de la semaine et les membres du groupe.</p>`;
  return `<div class="card friends-card fade">
    ${refus}
    <label class="lbl" for="grpCodeInput" style="margin-top:0">J'ai un code</label>
    <form data-grpjoinform="1" class="add-friend-row">
      <input class="field" type="text" id="grpCodeInput" placeholder="GRP-XXXXX" autocomplete="off" autocapitalize="characters" value="${esc(grpCodeField)}">
      <button class="btn btn-grow" type="submit">Rejoindre</button>
    </form>
    <p class="muted" style="font-size:.85rem;margin:8px 2px 0">Le responsable de ton groupe te le donne.</p>
    <label class="lbl" for="grpNomInput">Demander l'ouverture d'un groupe</label>
    <form data-grpdemform="1">
      <input class="field" type="text" id="grpNomInput" placeholder="Nom de ton église" maxlength="40" autocomplete="off" value="${esc(grpNomField)}">
      <label class="lbl" for="grpAdrInput">Adresse de l'église</label>
      <input class="field" type="text" id="grpAdrInput" placeholder="Rue et numéro, ville" maxlength="120" autocomplete="off" value="${esc(grpAdrField)}">
      <label class="lbl" for="grpMailInput">E-mail de contact (si différent du tien)</label>
      <input class="field" type="email" id="grpMailInput" placeholder="Facultatif" maxlength="255" autocomplete="off" value="${esc(grpMailField)}">
      <button class="btn btn-soft btn-block" type="submit" style="margin-top:12px">Envoyer la demande</button>
    </form>
    <p class="muted" style="font-size:.85rem;margin:8px 2px 0">L'administrateur regarde chaque demande ; tu deviendras responsable du groupe.</p>
  </div>`;
}

/* ============================================================================
   L'onglet « Mon église » — la page de l'assemblée.

   Tout membre y lit ce que le responsable a posé : le verset de la semaine,
   les annonces (épinglées en tête), les rendez-vous réguliers et les services
   où chacun LÈVE LA MAIN (jamais réquisitionné). Le responsable édite EN
   PLACE, sur la même page que ses membres — il voit toujours exactement ce
   qu'ils voient. Le serveur re-vérifie chaque écriture (403 sinon) : ici on
   ne fait que montrer ou cacher des boutons.

   Hors-ligne : la dernière page vue est gardée en localStorage et servie avec
   sa date — le service worker ne cache jamais /api/ (données privées).
   ========================================================================== */
const PAGE_CACHE_PREFIX = 'graine.eglpage.'; // + code du groupe
const JOURS_SEMAINE = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

let egliseSel = null;      // code du groupe affiché (utile à partir de 2 groupes)
let pageCache = {};        // code → { annonces, rdv, services }
let pageMeta = {};         // code → { quand: ISO, horsLigne: bool }
let pageLoading = {};
let pageTentee = {};       // une tentative réseau par visite de l'onglet — wire()
                           // repasse à chaque rendu, il ne doit pas re-fetcher
let pageEdit = null;       // formulaire ouvert : { type, code, id, …champs, busy, error }
let pageNotice = null, pageError = null;

function egliseCourante() {
  const gs = Array.isArray(groupesCache) ? groupesCache : [];
  return gs.find(x => x.code === egliseSel) || gs[0] || null;
}

/* Texte multi-lignes saisi par le responsable : échappé PUIS aéré — jamais
   l'inverse, c'est l'échappement qui protège la page. */
function multiligne(t) { return esc(t).replace(/\n/g, '<br>'); }

function dateAnnonceFr(iso) {
  try { return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }); }
  catch (e) { return ''; }
}
function dateServiceFr(ymd) {
  // Midi pile : à minuit, un fuseau à l'ouest ferait glisser au jour d'avant.
  try {
    const s = new Date(ymd + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch (e) { return esc(ymd); } // le repli s'insère dans du HTML : échappé aussi
}

function ensurePage(code) {
  if (!code || pageLoading[code] || pageTentee[code]) return;
  pageTentee[code] = true;
  const dejaLa = !!pageCache[code];
  // La dernière copie vue s'affiche tout de suite, marquée de sa date —
  // le réseau la remplacera s'il répond.
  if (!dejaLa) {
    try {
      const raw = localStorage.getItem(PAGE_CACHE_PREFIX + code);
      if (raw) {
        const c = JSON.parse(raw);
        // La copie ne se sert que si sa forme est saine : trois tableaux —
        // une copie abîmée ne doit jamais faire tomber l'écran.
        if (c && c.data && [c.data.annonces, c.data.rdv, c.data.services].every(Array.isArray)) {
          pageCache[code] = c.data;
          pageMeta[code] = { quand: c.quand, horsLigne: true };
        }
      }
    } catch (e) { /* copie illisible : on vivra sans */ }
  }
  pageLoading[code] = true;
  GraineAPI.groupePage(code)
    .then(d => {
      pageCache[code] = { annonces: d.annonces || [], rdv: d.rdv || [], services: d.services || [] };
      pageMeta[code] = { quand: new Date().toISOString(), horsLigne: false };
      try {
        localStorage.setItem(PAGE_CACHE_PREFIX + code,
          JSON.stringify({ data: pageCache[code], quand: pageMeta[code].quand }));
      } catch (e) { /* stockage plein : la page vit en mémoire */ }
    })
    .catch(() => { if (!pageCache[code]) pageMeta[code] = { quand: null, horsLigne: true }; })
    .then(() => { pageLoading[code] = false; renderIfIdle(); });
}
function pageRafraichir(code) { delete pageCache[code]; delete pageTentee[code]; ensurePage(code); }

function viewEglise() {
  const user = window.GraineAPI ? GraineAPI.user() : null;
  const gs = Array.isArray(groupesCache) ? groupesCache : [];
  if (!user || !gs.length) {
    // On n'arrive normalement pas ici (l'onglet n'existe qu'en groupe) —
    // mais un groupe quitté ou une déconnexion ne doit rien casser.
    return topbar() + `<div class="card fade" style="margin-top:14px">
      <p style="margin:0 0 8px"><b>Ton église t'attend ici.</b></p>
      <p class="muted" style="margin:0 0 12px">Rejoins un groupe avec le code de ton responsable, ou demande l'ouverture d'un groupe pour ton assemblée — tout se passe dans l'écran Moi.</p>
      <button class="btn btn-soft btn-block" data-tab="moi">Ouvrir l'écran Moi</button>
    </div>`;
  }
  const g = egliseCourante();
  const resp = g.role === 'responsable';
  const d = groupeDetails[g.code];
  const p = pageCache[g.code];
  const meta = pageMeta[g.code];

  // Plusieurs assemblées : une pastille par groupe, comme la banque du Défi.
  const choix = gs.length > 1 ? `<div class="pill-row" style="margin:0 0 14px">
      ${gs.map(x => `<button class="pill ${x.code === g.code ? 'on' : ''}" data-eglsel="${esc(x.code)}">${esc(x.nom)}</button>`).join('')}
    </div>` : '';

  const tete = `<div class="card fade">
    <p style="margin:0"><b>${esc(g.nom)}</b><br>
      <span class="muted" style="font-size:.85rem">${resp ? 'Tu es responsable' : 'Tu es membre'} · ${g.nbMembres} membre${g.nbMembres > 1 ? 's' : ''}</span></p>
    ${g.verset
      ? `<div class="grp-verset"><div class="gv-label">Verset de la semaine</div>
          <p class="gv-texte">« ${esc(g.verset.texte)} »</p>
          <p class="gv-ref">${esc(g.verset.reference)}</p></div>`
      : `<p class="muted" style="margin:10px 2px 0">Pas encore de verset de la semaine${resp ? ' — à toi de l\'offrir au groupe.' : '.'}</p>`}
    ${resp ? egliseVersetForm(g) : ''}
  </div>`;

  const alerte = (pageNotice ? `<p class="field-ok" style="margin:8px 2px">${esc(pageNotice)}</p>` : '')
    + (pageError ? `<p class="field-error" style="margin:8px 2px">${esc(pageError)}</p>` : '');

  // La page (annonces, rendez-vous, services) — ou son état de chargement.
  let corpsPage;
  if (!p) {
    corpsPage = meta && meta.horsLigne
      ? `<div class="card fade"><p class="muted fr-empty" style="margin:0">La page de ton église apparaîtra dès que tu seras en ligne.</p></div>`
      : `<div class="card fade"><p class="muted fr-empty" style="margin:0">Chargement…</p></div>`;
  } else {
    const vieux = meta && meta.horsLigne && meta.quand
      ? `<p class="muted" style="font-size:.85rem;margin:6px 2px 0">Hors-ligne — page du ${dateAnnonceFr(meta.quand)}.</p>` : '';
    corpsPage = vieux + egliseAnnonces(g, p, resp) + egliseRdv(g, p, resp) + egliseServices(g, p, resp);
  }

  // Le coin du responsable : le code qui ouvre la porte, et la porte de la
  // banque de questions (l'écran lui-même vit dans le module Défi).
  const coinResp = resp ? `
    <div class="section-title">${icon('outil')} Coin du responsable</div>
    <div class="card fade">
      <div class="friend-code-row">
        <div><div class="fc-label">Code du groupe</div><div class="friend-code">${esc(g.code)}</div></div>
        <button class="btn btn-soft" data-copygrp="${esc(g.code)}">Copier</button></div>
      <p class="muted" style="font-size:.85rem;margin:8px 2px 0">Partage-le aux membres de ton église : c'est lui qui ouvre la porte du groupe.</p>
    </div>
    <button class="card hub-card fade" data-tab="banques">
      <span class="hub-ic">${icon('defi', 26)}</span>
      <span class="hub-txt"><span class="hub-title">Banques de questions de mon église</span>
        <span class="hub-sub">Ce que tes parties d'église utilisent, épreuve par épreuve : la banque commune, ta sélection, tes propres questions.</span></span>
      <span class="chev">›</span></button>
    <div class="card fade">
      <div class="fc-label" style="margin-bottom:4px">Animer dans mon église</div>
      <p class="muted" style="margin:0 0 10px;font-size:.88rem">Chaque partie lancée d'ici tire dans la banque de ton église.</p>
      <div class="egl-animer">
        <a class="btn btn-soft" href="defi/">Qui, où, quand ?</a>
        <a class="btn btn-soft" href="quiadit/?eglise=${esc(g.code)}">Qui a dit ?</a>
        <a class="btn btn-soft" href="ecritoupas/?eglise=${esc(g.code)}">Écrit… ou pas ?</a>
        <a class="btn btn-soft" href="portrait/?eglise=${esc(g.code)}">De qui parle-t-on ?</a>
      </div>
    </div>` : '';

  const membres = `<div class="section-title">${icon('amis')} Membres</div>
    <div class="card friends-card fade">
      ${d && Array.isArray(d.membres)
        ? d.membres.map(m => `<div class="friend-row">
            <span class="fr-avatar">${icon('moi', 18)}</span>
            <span class="fr-main"><b>${esc(m.pseudo)}</b><br><span class="muted fr-since">${m.role === 'responsable' ? 'responsable' : 'membre'}</span></span>
            ${resp && m.role !== 'responsable'
              ? `<button class="linkbtn fr-passation" data-passation="${esc(m.pseudo)}">Confier la responsabilité</button>` : ''}
          </div>`).join('')
        : `<p class="muted fr-empty">La liste des membres apparaîtra dès que tu seras en ligne.</p>`}
      <button class="linkbtn" data-grpleave="${esc(g.code)}" data-nom="${esc(g.nom)}">Quitter ce groupe</button>
    </div>`;

  return topbar() + choix + tete + alerte + corpsPage + coinResp + membres;
}

/* Le formulaire du verset (responsable) — même état versetEdit que partout. */
function egliseVersetForm(g) {
  if (versetEdit && versetEdit.code === g.code) {
    return `<form data-grpversetform="1" style="margin-top:12px">
      <label class="lbl" for="versetRefInput" style="margin-top:0">Référence</label>
      <input class="field" type="text" id="versetRefInput" maxlength="60" placeholder="Jean 3.16" autocomplete="off" value="${esc(versetEdit.reference)}">
      <label class="lbl" for="versetTexteInput">Texte du verset</label>
      <textarea class="field" id="versetTexteInput" maxlength="500" placeholder="Recopie le verset ici…">${esc(versetEdit.texte)}</textarea>
      ${versetEdit.error ? `<p class="field-error">${esc(versetEdit.error)}</p>` : ''}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-grow" type="submit" ${versetEdit.busy ? 'disabled' : ''}>Offrir au groupe</button>
        <button class="btn btn-ghost" type="button" data-versetcancel="1">Annuler</button>
      </div>
    </form>`;
  }
  return `<button class="btn btn-soft btn-block" data-versetedit="${esc(g.code)}" style="margin-top:12px">${g.verset ? 'Changer le verset de la semaine' : 'Définir le verset de la semaine'}</button>`;
}

function egliseAnnonces(g, p, resp) {
  const forme = pageEdit && pageEdit.type === 'annonce' ? egliseFormAnnonce() : '';
  const liste = p.annonces.length
    ? p.annonces.map(a => `<div class="egl-annonce fade ${a.epingle ? 'epingle' : ''}">
        <div class="ea-titre">${a.epingle ? '<span class="ea-pin" title="Épinglée">📌</span> ' : ''}<b>${esc(a.titre)}</b></div>
        <p class="ea-texte">${multiligne(a.texte)}</p>
        <div class="ea-meta muted">${dateAnnonceFr(a.date)}${resp ? ` ·
          <button class="linkbtn" data-pageedit="annonce" data-id="${a.id}">Modifier</button>
          <button class="linkbtn" data-pagepin="${a.id}">${a.epingle ? 'Désépingler' : 'Épingler'}</button>
          <button class="linkbtn danger" data-pagedel="annonce" data-id="${a.id}" data-nom="${esc(a.titre)}">Supprimer</button>` : ''}</div>
      </div>`).join('')
    : `<p class="muted fr-empty">${resp ? 'Aucune annonce — la première nouvelle de l\'assemblée se pose ici.' : 'Pas d\'annonce pour l\'instant.'}</p>`;
  return `<div class="section-title">${icon('cloche')} Annonces</div>
    ${forme || `<div class="card fade">${liste}
      ${resp && !pageEdit ? `<button class="btn btn-soft btn-block" data-pageedit="annonce" style="margin-top:10px">Nouvelle annonce</button>` : ''}</div>`}`;
}

function egliseRdv(g, p, resp) {
  const forme = pageEdit && pageEdit.type === 'rdv' ? egliseFormRdv() : '';
  const liste = p.rdv.length
    ? p.rdv.map(r => `<div class="egl-rdv">
        <span class="er-quand"><b>${JOURS_SEMAINE[r.jour] || '?'}</b> ${esc(r.heure)}</span>
        <span class="er-quoi">${esc(r.libelle)}${r.lieu ? `<br><span class="muted">${esc(r.lieu)}</span>` : ''}</span>
        ${resp ? `<span class="er-actions">
          <button class="linkbtn" data-pageedit="rdv" data-id="${r.id}">Modifier</button>
          <button class="linkbtn danger" data-pagedel="rdv" data-id="${r.id}" data-nom="${esc(r.libelle)}">Supprimer</button></span>` : ''}
      </div>`).join('')
    : `<p class="muted fr-empty">${resp ? 'Aucun rendez-vous — pose le culte, la prière, l\'étude…' : 'Pas encore de rendez-vous réguliers.'}</p>`;
  return `<div class="section-title">${icon('assiduite')} La semaine de l'assemblée</div>
    ${forme || `<div class="card fade">${liste}
      ${resp && !pageEdit ? `<button class="btn btn-soft btn-block" data-pageedit="rdv" style="margin-top:10px">Ajouter un rendez-vous</button>` : ''}</div>`}`;
}

function egliseServices(g, p, resp) {
  const forme = pageEdit && pageEdit.type === 'service' ? egliseFormService() : '';
  const liste = p.services.length
    ? p.services.map(s => {
      const plein = s.inscrits.length >= s.places;
      // Le geste du membre : lever la main, ou la retirer — jamais réquisitionné.
      const main = s.jeSuisInscrit
        ? `<button class="btn btn-ghost" data-svcmain="${s.id}" data-inscrit="1">Je me retire</button>`
        : plein
          ? `<span class="muted" style="font-size:.88rem">Complet — merci à ceux qui ont levé la main !</span>`
          : `<button class="btn btn-grow" data-svcmain="${s.id}" data-inscrit="0">Je lève la main</button>`;
      return `<div class="egl-service fade">
        <div class="es-tete"><b>${esc(s.titre)}</b><span class="es-places">${s.inscrits.length}/${s.places}</span></div>
        <div class="muted" style="font-size:.88rem">${dateServiceFr(s.date)}</div>
        ${s.details ? `<p class="es-details">${multiligne(s.details)}</p>` : ''}
        ${s.inscrits.length ? `<p class="muted es-inscrits">${s.inscrits.map(esc).join(' · ')}</p>` : ''}
        <div class="es-actions">${main}${resp ? `
          <button class="linkbtn" data-pageedit="service" data-id="${s.id}">Modifier</button>
          <button class="linkbtn danger" data-pagedel="service" data-id="${s.id}" data-nom="${esc(s.titre)}">Supprimer</button>` : ''}</div>
      </div>`;
    }).join('')
    : `<p class="muted fr-empty">${resp ? 'Aucun service à venir — propose un coup de main, chacun lèvera la main s\'il le veut.' : 'Pas de service proposé pour l\'instant.'}</p>`;
  return `<div class="section-title">${icon('partage')} Services — je lève la main</div>
    ${forme || `<div class="card fade">${liste}
      ${resp && !pageEdit ? `<button class="btn btn-soft btn-block" data-pageedit="service" style="margin-top:10px">Proposer un service</button>` : ''}</div>`}`;
}

/* ---- Les trois formulaires du responsable (création et modification) ---- */

function egliseFormBoutons() {
  return `${pageEdit.error ? `<p class="field-error">${esc(pageEdit.error)}</p>` : ''}
    <div class="btn-row" style="margin-top:10px">
      <button class="btn btn-grow" type="submit" ${pageEdit.busy ? 'disabled' : ''}>${pageEdit.id ? 'Enregistrer' : 'Publier'}</button>
      <button class="btn btn-ghost" type="button" data-pagecancel="1">Annuler</button>
    </div>`;
}
function egliseFormAnnonce() {
  return `<form class="card fade" data-pageform="1">
    <label class="lbl" for="pageTitre" style="margin-top:0">${pageEdit.id ? 'Modifier l\'annonce' : 'Nouvelle annonce'}</label>
    <input class="field" type="text" id="pageTitre" maxlength="80" placeholder="Titre" autocomplete="off" value="${esc(pageEdit.titre)}">
    <textarea class="field" id="pageTexte" maxlength="2000" placeholder="La nouvelle à partager…">${esc(pageEdit.texte)}</textarea>
    <button class="pill ${pageEdit.epingle ? 'on' : ''}" type="button" data-pagepinform="1" style="margin-top:8px">📌 Épinglée en tête de page</button>
    ${egliseFormBoutons()}
  </form>`;
}
function egliseFormRdv() {
  return `<form class="card fade" data-pageform="1">
    <label class="lbl" for="pageLibelle" style="margin-top:0">${pageEdit.id ? 'Modifier le rendez-vous' : 'Nouveau rendez-vous régulier'}</label>
    <input class="field" type="text" id="pageLibelle" maxlength="80" placeholder="Culte, prière, étude…" autocomplete="off" value="${esc(pageEdit.libelle)}">
    <label class="lbl" for="pageJour">Jour</label>
    <select class="field" id="pageJour">${JOURS_SEMAINE.map((j, i) =>
      `<option value="${i}" ${String(i) === String(pageEdit.jour) ? 'selected' : ''}>${j.charAt(0).toUpperCase() + j.slice(1)}</option>`).join('')}</select>
    <label class="lbl" for="pageHeure">Heure</label>
    <input class="field" type="time" id="pageHeure" value="${esc(pageEdit.heure)}">
    <label class="lbl" for="pageLieu">Lieu (facultatif)</label>
    <input class="field" type="text" id="pageLieu" maxlength="80" placeholder="Salle, adresse…" autocomplete="off" value="${esc(pageEdit.lieu)}">
    ${egliseFormBoutons()}
  </form>`;
}
function egliseFormService() {
  return `<form class="card fade" data-pageform="1">
    <label class="lbl" for="pageTitre" style="margin-top:0">${pageEdit.id ? 'Modifier le service' : 'Proposer un service'}</label>
    <input class="field" type="text" id="pageTitre" maxlength="80" placeholder="Nettoyage de la salle, accueil…" autocomplete="off" value="${esc(pageEdit.titre)}">
    <label class="lbl" for="pageDate">Date</label>
    <input class="field" type="date" id="pageDate" value="${esc(pageEdit.date)}">
    <label class="lbl" for="pageDetails">Détails (facultatif)</label>
    <textarea class="field" id="pageDetails" maxlength="500" placeholder="Ce qu'il faut savoir…">${esc(pageEdit.details)}</textarea>
    <label class="lbl" for="pagePlaces">Places</label>
    <input class="field" type="number" id="pagePlaces" min="1" max="500" value="${esc(pageEdit.places)}">
    <p class="muted" style="font-size:.85rem;margin:8px 2px 0">Chacun lève la main s'il le veut, dans la limite des places.</p>
    ${egliseFormBoutons()}
  </form>`;
}

/* ---- Les actions de la page ---- */

function pageOuvrirForm(type, id) {
  const g = egliseCourante(); if (!g) return;
  const p = pageCache[g.code] || { annonces: [], rdv: [], services: [] };
  pageNotice = pageError = null;
  if (type === 'annonce') {
    const a = id ? p.annonces.find(x => x.id === id) : null;
    pageEdit = { type, code: g.code, id: a ? a.id : null, titre: a ? a.titre : '', texte: a ? a.texte : '', epingle: a ? a.epingle : false, busy: false, error: null };
  } else if (type === 'rdv') {
    const r = id ? p.rdv.find(x => x.id === id) : null;
    pageEdit = { type, code: g.code, id: r ? r.id : null, libelle: r ? r.libelle : '', jour: r ? r.jour : 0, heure: r ? r.heure : '10:30', lieu: r && r.lieu ? r.lieu : '', busy: false, error: null };
  } else {
    const s = id ? p.services.find(x => x.id === id) : null;
    pageEdit = { type, code: g.code, id: s ? s.id : null, titre: s ? s.titre : '', date: s ? s.date : '', details: s && s.details ? s.details : '', places: s ? s.places : 4, busy: false, error: null };
  }
  render();
}

async function doPageSave() {
  const pe = pageEdit; if (!pe || pe.busy) return;
  pe.busy = true; pe.error = null; render();
  try {
    const corps = { id: pe.id || undefined };
    if (pe.type === 'annonce') {
      Object.assign(corps, { titre: pe.titre, texte: pe.texte, epingle: !!pe.epingle });
      await GraineAPI.groupeAnnonceSave(pe.code, corps);
    } else if (pe.type === 'rdv') {
      Object.assign(corps, { libelle: pe.libelle, jour: Number(pe.jour), heure: pe.heure, lieu: pe.lieu });
      await GraineAPI.groupeRdvSave(pe.code, corps);
    } else {
      Object.assign(corps, { titre: pe.titre, date: pe.date, details: pe.details, places: Number(pe.places) });
      await GraineAPI.groupeServiceSave(pe.code, corps);
    }
    pageNotice = pe.id ? 'C\'est enregistré.' : 'C\'est publié pour ton assemblée 🙂';
    pageEdit = null;
    pageRafraichir(pe.code);
  } catch (e) {
    pe.busy = false;
    pe.error = (e && e.offline) ? 'Pas de connexion — réessaie quand tu seras en ligne.' : friendlyError(e);
  }
  render();
}

async function doPageDelete(type, id, nom) {
  const g = egliseCourante(); if (!g) return;
  const quoi = type === 'annonce' ? 'cette annonce' : type === 'rdv' ? 'ce rendez-vous' : 'ce service (les mains levées partent avec)';
  if (!confirm(`Supprimer ${quoi} — « ${nom} » ?`)) return;
  pageNotice = pageError = null;
  try {
    if (type === 'annonce') await GraineAPI.groupeAnnonceDelete(g.code, id);
    else if (type === 'rdv') await GraineAPI.groupeRdvDelete(g.code, id);
    else await GraineAPI.groupeServiceDelete(g.code, id);
    pageRafraichir(g.code);
  } catch (e) {
    pageError = (e && e.offline) ? 'Pas de connexion — réessaie quand tu seras en ligne.' : friendlyError(e);
  }
  render();
}

/* Épingler/désépingler en un geste : une modification d'annonce comme une autre. */
async function doPagePin(id) {
  const g = egliseCourante(); if (!g) return;
  const a = (pageCache[g.code] || { annonces: [] }).annonces.find(x => x.id === id);
  if (!a) return;
  pageNotice = pageError = null;
  try {
    await GraineAPI.groupeAnnonceSave(g.code, { id: a.id, titre: a.titre, texte: a.texte, epingle: !a.epingle });
    pageRafraichir(g.code);
  } catch (e) {
    pageError = (e && e.offline) ? 'Pas de connexion — réessaie quand tu seras en ligne.' : friendlyError(e);
  }
  render();
}

/* La passation : le groupe change de mains — geste rare et lourd de sens,
   donc confirmé en toutes lettres. Le serveur revérifie que l'appelant est
   bien le responsable, et refuse les pseudos ambigus (homonymes). */
async function doGroupePassation(pseudo) {
  const g = egliseCourante(); if (!g) return;
  if (!confirm(`Confier la responsabilité de « ${g.nom} » à ${pseudo} ? Tu resteras membre du groupe, mais ${pseudo} en deviendra le responsable.`)) return;
  pageNotice = pageError = null;
  try {
    await GraineAPI.groupePassation(g.code, pseudo);
    pageNotice = `« ${g.nom} » est maintenant entre les mains de ${pseudo} 🙂`;
    egliseRecharger();
  } catch (e) {
    pageError = (e && e.offline) ? 'Pas de connexion — réessaie quand tu seras en ligne.' : friendlyError(e);
  }
  render();
}

/* ============================================================================
   Les banques de mon église — l'éditeur multi-épreuves (responsable seul).

   Une pastille par épreuve « à fichier » (Qui a dit ?, Écrit… ou pas ?,
   De qui parle-t-on ?) : le mode toutes/sélection, la sélection dans la
   banque commune, et les items PROPRES de l'église — mêmes règles de
   validation que l'administration, revérifiées par le serveur (403 pour
   quiconque n'est pas responsable, lecture comprise : les items portent la
   bonne réponse). « Qui, où, quand ? » garde son écran dans le module Défi
   (autre moteur, même esprit) — une carte y mène.
   ========================================================================== */
const BQ_MODULES = [
  { id: 'quiadit', nom: 'Qui a dit ?' },
  { id: 'ecritoupas', nom: 'Écrit… ou pas ?' },
  { id: 'portrait', nom: 'De qui parle-t-on ?' },
];
let bqModule = 'quiadit';
let bqCache = {};          // `${code}|${module}` → réglages + items du serveur
let bqLoading = {}, bqTentee = {};
let bqCommune = {};        // module → items de la banque commune (écran de sélection)
let bqSel = null;          // écran de sélection ouvert : { ids: {}, filtre: '' }
let bqEdit = null;         // formulaire d'item ouvert : { id|null, champs…, busy, error }
let bqBusy = false;        // changement de mode en vol
let bqNotice = null, bqError = null;

function bqCle() { const g = egliseCourante(); return g ? g.code + '|' + bqModule : null; }

function ensureBanqueEglise() {
  const g = egliseCourante(); if (!g) return;
  const cle = bqCle();
  if (bqLoading[cle] || bqTentee[cle]) return;
  bqTentee[cle] = true;
  bqLoading[cle] = true;
  GraineAPI.groupeBanque(g.code, bqModule)
    .then(b => { bqCache[cle] = b; })
    .catch(e => { bqError = (e && e.offline) ? 'Pas de connexion — la banque apparaîtra en ligne.' : friendlyError(e); })
    .then(() => { bqLoading[cle] = false; renderIfIdle(); });
}
function bqRafraichir() { const cle = bqCle(); delete bqCache[cle]; delete bqTentee[cle]; ensureBanqueEglise(); }

/* L'étiquette d'un item selon sa forme — pour les listes (sélection, propres). */
function bqItemLibelle(module, it) {
  if (module === 'quiadit') return it.parole || '';
  if (module === 'ecritoupas') return it.phrase || '';
  return it.reponse || '';
}
function bqItemMeta(module, it) {
  if (module === 'quiadit') return `${esc((it.options || [])[it.bonne] || '')} · ${esc(it.reference || '')}`;
  if (module === 'ecritoupas') return `${it.ecrit ? 'écrit' : 'pas écrit'}${it.reference ? ' · ' + esc(it.reference) : ''}`;
  return `${esc(it.genre || '')} · ${esc(it.reference || '')}`;
}

function viewEgliseBanques() {
  const user = window.GraineAPI ? GraineAPI.user() : null;
  const g = egliseCourante();
  if (!user || !g || g.role !== 'responsable') {
    return topbar() + `<div class="card fade" style="margin-top:14px">
      <p style="margin:0 0 12px"><b>Les banques de questions</b> se règlent par le responsable d'une église.</p>
      <button class="btn btn-soft btn-block" data-tab="eglise">Revenir à Mon église</button>
    </div>`;
  }
  const b = bqCache[bqCle()];

  const tete = `<button class="back-link" data-tab="eglise">‹ Mon église</button>
    <div class="section-title" style="margin-top:6px">${icon('eglise')} Banques de ${esc(g.nom)}</div>
    <p class="muted" style="margin:0 4px 12px;font-size:.9rem">Ce que les parties lancées « dans mon église » utilisent — les pages publiques restent mondiales.</p>
    <div class="pill-row" style="margin:0 0 14px">
      ${BQ_MODULES.map(m => `<button class="pill ${m.id === bqModule ? 'on' : ''}" data-bqmodule="${m.id}">${m.nom}</button>`).join('')}
    </div>`;

  const alerte = (bqNotice ? `<p class="field-ok" style="margin:0 4px 10px">${esc(bqNotice)}</p>` : '')
    + (bqError ? `<p class="field-error" style="margin:0 4px 10px">${esc(bqError)}</p>` : '');

  let corps;
  if (bqEdit) corps = bqFormHTML();
  else if (bqSel) corps = bqSelectionHTML();
  else if (!b) corps = `<div class="card fade"><p class="muted fr-empty" style="margin:0">Chargement…</p></div>`;
  else {
    const selection = b.mode === 'selection';
    const reglages = `<div class="card fade">
      <label class="lbl" style="margin-top:0">La banque commune</label>
      <div class="pill-row">
        <button class="pill ${selection ? '' : 'on'}" data-bqmode="toutes" ${bqBusy ? 'disabled' : ''}>Toute la banque commune</button>
        <button class="pill ${selection ? 'on' : ''}" data-bqmode="selection" ${bqBusy ? 'disabled' : ''}>Ma sélection</button>
      </div>
      ${selection ? `
      <p class="prepa-note">${b.nbSelection
        ? `${b.nbSelection} item${b.nbSelection > 1 ? 's' : ''} de la banque commune retenu${b.nbSelection > 1 ? 's' : ''}.`
        : `Rien de retenu pour l'instant — choisis, sinon tes parties d'église n'auront que les items propres.`}</p>
      <button class="btn btn-soft btn-block" data-bqselouvrir="1" style="margin-top:10px">Choisir les items retenus</button>` : `
      <p class="prepa-note">Tes parties d'église tirent dans toute la banque commune${b.nbSelection ? ` — ta sélection (${b.nbSelection}) est gardée en attendant` : ''}.</p>`}
      <p class="prepa-note">En tout : <b>${b.nbTotal}</b> item${b.nbTotal > 1 ? 's' : ''} (banque commune ${selection ? 'retenue' : 'entière'} + items de ton église).</p>
    </div>`;

    const propres = `<div class="section-title">Les items de ton église${b.nbPropres ? ` (${b.nbPropres})` : ''}</div>
      <div class="card fade">
        ${b.items.length ? b.items.map(it => `<div class="egl-annonce">
            <div class="ea-titre"><b>${esc(bqItemLibelle(bqModule, it))}</b></div>
            <div class="ea-meta muted">${bqItemMeta(bqModule, it)} ·
              <button class="linkbtn" data-bqedit="${esc(it.id)}">Modifier</button>
              <button class="linkbtn danger" data-bqdel="${esc(it.id)}">Supprimer</button></div>
          </div>`).join('')
          : `<p class="muted fr-empty" style="margin-top:0">Ton église peut écrire ses propres items — ils s'ajoutent à la banque commune dans ses parties.</p>`}
        <button class="btn btn-grow btn-block" data-bqedit="" style="margin-top:10px">Nouvel item</button>
      </div>`;

    corps = reglages + propres;
  }

  // « Qui, où, quand ? » : sa banque d'église vit dans le module Défi.
  const defiCard = (bqEdit || bqSel) ? '' : `<a class="card hub-card fade" href="defi/#banque">
    <span class="hub-ic">${icon('defi', 26)}</span>
    <span class="hub-txt"><span class="hub-title">Qui, où, quand ?</span>
      <span class="hub-sub">La banque du grand quiz se règle dans le module Défi — même esprit, autre moteur.</span></span>
    <span class="chev">›</span></a>`;

  return topbar() + tete + alerte + corps + defiCard;
}

/* ---- L'écran de sélection dans la banque commune ---- */

function bqSelectionHTML() {
  const commune = bqCommune[bqModule];
  if (!commune) return `<div class="card fade"><p class="muted fr-empty" style="margin:0">Chargement de la banque commune…</p></div>`;
  const filtre = (bqSel.filtre || '').toLowerCase();
  const visibles = filtre
    ? commune.filter(it => (bqItemLibelle(bqModule, it) + ' ' + (it.reference || '')).toLowerCase().includes(filtre))
    : commune;
  const nb = Object.keys(bqSel.ids).length;
  return `<div class="card fade">
    <label class="lbl" for="bqFiltre" style="margin-top:0">Choisir les items retenus (${nb})</label>
    <input class="field" type="search" id="bqFiltre" placeholder="Filtrer…" value="${esc(bqSel.filtre)}">
    <div class="bq-liste">
      ${visibles.map(it => `<label class="bq-choix">
        <input type="checkbox" data-bqcoche="${esc(String(it.id))}" ${bqSel.ids[it.id] ? 'checked' : ''}>
        <span class="bq-choix-txt">${esc(bqItemLibelle(bqModule, it))}<br><span class="muted">${bqItemMeta(bqModule, it)}</span></span>
      </label>`).join('') || `<p class="muted fr-empty">Rien ne correspond au filtre.</p>`}
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-grow" data-bqselsave="1" ${bqBusy ? 'disabled' : ''}>Retenir (${nb})</button>
      <button class="btn btn-ghost" data-bqselannuler="1">Annuler</button>
    </div>
  </div>`;
}

/* ---- Le formulaire d'un item, selon la forme de l'épreuve ---- */

function bqFormHTML() {
  const e = bqEdit;
  const boutons = `${e.error ? `<p class="field-error">${esc(e.error)}</p>` : ''}
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-grow" type="submit" ${e.busy ? 'disabled' : ''}>${e.id ? 'Enregistrer' : 'Ajouter'}</button>
      <button class="btn btn-ghost" type="button" data-bqannuler="1">Annuler</button>
    </div>`;
  if (bqModule === 'quiadit') {
    return `<form class="card fade" data-bqform="1">
      <label class="lbl" for="bqParole" style="margin-top:0">${e.id ? 'Modifier la parole' : 'Nouvelle parole'}</label>
      <textarea class="field" id="bqParole" maxlength="300" placeholder="« La parole à attribuer… »">${esc(e.parole)}</textarea>
      ${[0, 1, 2, 3].map(i => `<label class="lbl" for="bqOpt${i}">Voix ${i + 1}${i === Number(e.bonne) ? ' — la bonne' : ''}</label>
        <input class="field" type="text" id="bqOpt${i}" maxlength="90" autocomplete="off" value="${esc(e.options[i] || '')}">`).join('')}
      <label class="lbl">La bonne voix</label>
      <div class="pill-row">${[0, 1, 2, 3].map(i =>
        `<button class="pill ${Number(e.bonne) === i ? 'on' : ''}" type="button" data-bqbonne="${i}">Voix ${i + 1}</button>`).join('')}</div>
      <label class="lbl" for="bqRef">Référence</label>
      <input class="field" type="text" id="bqRef" maxlength="60" placeholder="Jean 14.6" autocomplete="off" value="${esc(e.reference)}">
      <label class="lbl" for="bqContexte">Contexte révélé (facultatif)</label>
      <textarea class="field" id="bqContexte" maxlength="300" placeholder="Une précision montrée après la réponse…">${esc(e.contexte)}</textarea>
      ${boutons}
    </form>`;
  }
  if (bqModule === 'ecritoupas') {
    return `<form class="card fade" data-bqform="1">
      <label class="lbl" for="bqPhrase" style="margin-top:0">${e.id ? 'Modifier la phrase' : 'Nouvelle phrase'}</label>
      <textarea class="field" id="bqPhrase" maxlength="300" placeholder="La phrase — écrite dans la Bible, ou pas ?">${esc(e.phrase)}</textarea>
      <label class="lbl">Verdict</label>
      <div class="pill-row">
        <button class="pill ${e.ecrit ? 'on' : ''}" type="button" data-bqecrit="1">C'est écrit</button>
        <button class="pill ${e.ecrit ? '' : 'on'}" type="button" data-bqecrit="0">Ce n'est pas écrit</button>
      </div>
      <label class="lbl" for="bqRef">Référence${e.ecrit ? ' (une phrase écrite se prouve)' : ' (facultative)'}</label>
      <input class="field" type="text" id="bqRef" maxlength="60" placeholder="Proverbes 3.5" autocomplete="off" value="${esc(e.reference)}">
      <label class="lbl" for="bqPrecision">Précision révélée (facultatif)</label>
      <textarea class="field" id="bqPrecision" maxlength="300" placeholder="D'où vient la confusion, ce que dit vraiment le texte…">${esc(e.precision)}</textarea>
      ${boutons}
    </form>`;
  }
  return `<form class="card fade" data-bqform="1">
    <label class="lbl" for="bqReponse" style="margin-top:0">${e.id ? 'Modifier le portrait' : 'Nouveau portrait'}</label>
    <input class="field" type="text" id="bqReponse" maxlength="60" placeholder="Qui est-ce ? (la réponse)" autocomplete="off" value="${esc(e.reponse)}">
    <label class="lbl" for="bqAccepte">Orthographes acceptées (séparées par des virgules)</label>
    <input class="field" type="text" id="bqAccepte" placeholder="Moïse, Moise" autocomplete="off" value="${esc(e.accepte)}">
    <label class="lbl">Genre</label>
    <div class="pill-row">${['personnage', 'lieu', 'chose'].map(gr =>
      `<button class="pill ${e.genre === gr ? 'on' : ''}" type="button" data-bqgenre="${gr}">${gr}</button>`).join('')}</div>
    ${[0, 1, 2, 3, 4].map(i => `<label class="lbl" for="bqInd${i}">Indice ${i + 1}${i === 0 ? ' (le plus difficile)' : i === 4 ? ' (le plus facile)' : ''}</label>
      <input class="field" type="text" id="bqInd${i}" maxlength="240" autocomplete="off" value="${esc(e.indices[i] || '')}">`).join('')}
    <label class="lbl" for="bqRef">Référence</label>
    <input class="field" type="text" id="bqRef" maxlength="60" placeholder="Exode 2" autocomplete="off" value="${esc(e.reference)}">
    ${boutons}
  </form>`;
}

/* ---- Les actions de l'éditeur ---- */

function bqOuvrirForm(id) {
  const b = bqCache[bqCle()]; if (!b) return;
  const it = id ? b.items.find(x => x.id === id) : null;
  bqNotice = bqError = null;
  if (bqModule === 'quiadit') {
    bqEdit = { id: it ? it.id : null, parole: it ? it.parole : '', options: it ? it.options.slice() : ['', '', '', ''],
      bonne: it ? it.bonne : 0, reference: it ? it.reference : '', contexte: it && it.contexte ? it.contexte : '', busy: false, error: null };
  } else if (bqModule === 'ecritoupas') {
    bqEdit = { id: it ? it.id : null, phrase: it ? it.phrase : '', ecrit: it ? !!it.ecrit : true,
      reference: it && it.reference ? it.reference : '', precision: it && it.precision ? it.precision : '', busy: false, error: null };
  } else {
    bqEdit = { id: it ? it.id : null, reponse: it ? it.reponse : '', accepte: it ? (it.accepte || []).join(', ') : '',
      genre: it ? it.genre : 'personnage', indices: it ? it.indices.slice() : ['', '', '', '', ''],
      reference: it ? it.reference : '', busy: false, error: null };
  }
  render();
}

async function doBqMode(mode) {
  const g = egliseCourante(); if (!g || bqBusy) return;
  bqBusy = true; bqNotice = bqError = null; render();
  try {
    bqCache[bqCle()] = await GraineAPI.groupeBanqueMode(g.code, bqModule, mode);
  } catch (e) {
    bqError = (e && e.offline) ? 'Pas de connexion — réessaie quand tu seras en ligne.' : friendlyError(e);
  }
  bqBusy = false;
  render();
}

async function doBqSelOuvrir() {
  const b = bqCache[bqCle()]; if (!b) return;
  const ids = {};
  b.selection.forEach(id => { ids[id] = true; });
  bqSel = { ids, filtre: '' };
  bqNotice = bqError = null;
  render();
  if (!bqCommune[bqModule]) {
    try {
      const d = await GraineAPI.banque(bqModule);
      bqCommune[bqModule] = (d && d.items) || [];
    } catch (e) {
      bqSel = null;
      bqError = (e && e.offline) ? 'Pas de connexion — la banque commune est introuvable.' : friendlyError(e);
    }
    render();
  }
}

async function doBqSelSave() {
  const g = egliseCourante(); if (!g || !bqSel || bqBusy) return;
  bqBusy = true; render();
  try {
    bqCache[bqCle()] = await GraineAPI.groupeBanqueSelection(g.code, bqModule, Object.keys(bqSel.ids));
    bqSel = null;
    bqNotice = 'Sélection retenue pour tes parties d\'église.';
  } catch (e) {
    bqError = (e && e.offline) ? 'Pas de connexion — réessaie quand tu seras en ligne.' : friendlyError(e);
  }
  bqBusy = false;
  render();
}

async function doBqItemSave() {
  const g = egliseCourante(); const e = bqEdit;
  if (!g || !e || e.busy) return;
  e.busy = true; e.error = null; render();
  let corps;
  if (bqModule === 'quiadit') {
    corps = { parole: e.parole, options: e.options.map(o => o || ''), bonne: Number(e.bonne),
      reference: e.reference, contexte: e.contexte.trim() === '' ? null : e.contexte };
  } else if (bqModule === 'ecritoupas') {
    corps = { phrase: e.phrase, ecrit: !!e.ecrit,
      reference: e.reference.trim() === '' ? null : e.reference,
      precision: e.precision.trim() === '' ? null : e.precision };
  } else {
    corps = { reponse: e.reponse, accepte: e.accepte.split(',').map(a => a.trim()).filter(Boolean),
      genre: e.genre, indices: e.indices.map(i => i || ''), reference: e.reference };
  }
  if (e.id) corps.id = e.id;
  try {
    await GraineAPI.groupeBanqueItemSave(g.code, bqModule, corps);
    bqEdit = null;
    bqNotice = e.id ? 'C\'est enregistré.' : 'L\'item rejoint la banque de ton église 🙂';
    bqRafraichir();
  } catch (err) {
    e.busy = false;
    e.error = (err && err.offline) ? 'Pas de connexion — réessaie quand tu seras en ligne.' : friendlyError(err);
  }
  render();
}

async function doBqItemDelete(id) {
  const g = egliseCourante(); if (!g) return;
  const b = bqCache[bqCle()];
  const it = b && b.items.find(x => x.id === id);
  if (!confirm(`Supprimer « ${it ? bqItemLibelle(bqModule, it) : id} » de la banque de ton église ?`)) return;
  bqNotice = bqError = null;
  try {
    await GraineAPI.groupeBanqueItemDelete(g.code, bqModule, id);
    bqRafraichir();
  } catch (e) {
    bqError = (e && e.offline) ? 'Pas de connexion — réessaie quand tu seras en ligne.' : friendlyError(e);
  }
  render();
}

async function doServiceMain(id, deja) {
  const g = egliseCourante(); if (!g) return;
  pageNotice = pageError = null;
  try {
    const s = deja
      ? await GraineAPI.groupeServiceRetirer(g.code, id)
      : await GraineAPI.groupeServiceLeverLaMain(g.code, id);
    // Le serveur renvoie le service à jour : on le replace sans tout recharger.
    const p = pageCache[g.code];
    if (p && s) { const k = p.services.findIndex(x => x.id === id); if (k >= 0) p.services[k] = s; }
  } catch (e) {
    if (e && e.status === 409) pageRafraichir(g.code); // complet, ou déjà inscrit : la page dit vrai
    pageError = (e && e.offline) ? 'Pas de connexion — réessaie quand tu seras en ligne.' : friendlyError(e);
  }
  render();
}

async function doGroupeRejoindre() {
  grpNotice = null;
  const code = normalizeGroupCode(grpCodeField);
  if (!code) { grpError = 'Un code de groupe ressemble à GRP-XXXXX.'; render(); return; }
  grpError = null;
  try {
    const g = await GraineAPI.groupeRejoindre(code);
    grpCodeField = '';
    grpNotice = `Te voilà membre de « ${g && g.nom ? g.nom : 'ton groupe'} » 🙂`;
    egliseRecharger();
  } catch (e) {
    if (e && e.offline) grpError = 'Pas de connexion — réessaie quand tu seras en ligne.';
    else if (e && e.status === 404) grpError = 'Groupe introuvable — vérifie le code avec ton responsable.';
    else grpError = friendlyError(e);
  }
  render();
}
async function doDemandeEnvoyer() {
  grpNotice = null;
  const nom = (grpNomField || '').trim();
  const adresse = (grpAdrField || '').trim();
  const email = (grpMailField || '').trim();
  if (nom.length < 2 || nom.length > 40) { grpError = 'Le nom de ton église : entre 2 et 40 caractères.'; render(); return; }
  // Vérifications locales douces — le serveur revérifie de toute façon.
  if (adresse.length < 5 || adresse.length > 120) { grpError = 'L\'adresse de ton église : entre 5 et 120 caractères.'; render(); return; }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) { grpError = 'Cet e-mail de contact semble incomplet — vérifie-le, ou laisse le champ vide.'; render(); return; }
  grpError = null;
  try {
    // Une demande refusée encore affichée s'efface avant d'en poser une nouvelle.
    if (demandeCache && demandeCache.statut === 'refusee') {
      try { await GraineAPI.groupeDemandeAnnuler(); } catch (e) { /* on tente l'envoi quand même */ }
    }
    const d = await GraineAPI.groupeDemandeEnvoyer(nom, adresse, email);
    grpNomField = grpAdrField = grpMailField = '';
    demandeCache = d || { nom, adresse, email: email || null, statut: 'attente', createdAt: new Date().toISOString() };
    grpNotice = 'Ta demande est envoyée — on te répond bientôt.';
  } catch (e) {
    if (e && e.offline) grpError = 'Pas de connexion — réessaie quand tu seras en ligne.';
    else if (e && e.status === 409) { egliseRecharger(); } // une demande attend déjà : on la raffiche
    else grpError = friendlyError(e);
  }
  render();
}
async function doDemandeAnnuler() {
  if (demandeCache && !confirm(`Annuler ta demande pour « ${demandeCache.nom} » ?`)) return;
  grpNotice = null;
  try { await GraineAPI.groupeDemandeAnnuler(); demandeCache = null; grpError = null; }
  catch (e) { grpError = friendlyError(e); }
  render();
}
async function doGroupeQuitter(code, nom) {
  if (!confirm(`Quitter le groupe « ${nom} » ?`)) return;
  grpNotice = null;
  try {
    await GraineAPI.groupeQuitter(code);
    grpError = null;
    grpNotice = `Tu as quitté « ${nom} ».`;
    egliseRecharger();
    // Depuis l'onglet Mon église : il peut disparaître avec le groupe quitté —
    // on ramène vers Moi, où vit le message d'au revoir.
    if (route.name === 'eglise') { egliseSel = null; go('moi'); return; }
  } catch (e) {
    // Le responsable qui n'est pas seul reçoit ici le message du serveur
    // (transmettre d'abord la responsabilité) — on l'affiche tel quel.
    grpError = friendlyError(e);
  }
  render();
}
async function doGroupeVerset() {
  if (!versetEdit || versetEdit.busy) return;
  const reference = (versetEdit.reference || '').trim();
  const texte = (versetEdit.texte || '').trim();
  if (!reference) { versetEdit.error = 'Indique la référence (par exemple Jean 3.16).'; render(); return; }
  if (!texte) { versetEdit.error = 'Recopie le texte du verset.'; render(); return; }
  versetEdit.busy = true; versetEdit.error = null; render();
  try {
    const g = await GraineAPI.groupeVerset(versetEdit.code, reference, texte);
    if (Array.isArray(groupesCache) && g) {
      const i = groupesCache.findIndex(x => x.code === versetEdit.code);
      if (i >= 0) groupesCache[i] = Object.assign({}, groupesCache[i], { verset: g.verset });
    }
    if (groupeDetails[versetEdit.code] && g) groupeDetails[versetEdit.code].verset = g.verset;
    versetEdit = null;
    grpNotice = 'Le verset de la semaine est offert au groupe 🙂';
  } catch (e) { versetEdit.busy = false; versetEdit.error = friendlyError(e); }
  render();
}
// Copier le code du groupe — même geste que le code ami (bouton « Copié ✓ »).
function copyGroupCode(code) {
  const sel = `[data-copygrp="${code}"]`;
  const done = () => {
    const b = el.querySelector(sel);
    if (b) { b.textContent = 'Copié ✓'; setTimeout(() => { const b2 = el.querySelector(sel); if (b2) b2.textContent = 'Copier'; }, 1600); }
  };
  const fallback = () => { // repli : sélection + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { /* le code reste visible à recopier */ }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done).catch(fallback);
  else fallback();
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
  el.querySelectorAll('[data-situer-livre]').forEach(b => b.addEventListener('click', () => situerPickLivre(b.dataset.situerLivre)));
  el.querySelectorAll('[data-situer-ref]').forEach(b => b.addEventListener('click', () => situerPickRef(b.dataset.situerRef)));
  if (q('[data-situer-expert]')) q('[data-situer-expert]').addEventListener('click', () => { store.situerExpert = !store.situerExpert; saveStore(); render(); });

  el.querySelectorAll('[data-verse]').forEach(b => b.addEventListener('click', () => go('verse', b.dataset.verse)));
  if (q('[data-remove]')) q('[data-remove]').addEventListener('click', () => removeVerse(q('[data-remove]').dataset.remove));

  // Collections (objectifs)
  el.querySelectorAll('[data-collections]').forEach(b => b.addEventListener('click', () => go('collections')));
  el.querySelectorAll('[data-selectcoll]').forEach(b => b.addEventListener('click', () => selectCollection(b.dataset.selectcoll)));
  el.querySelectorAll('[data-clearcoll]').forEach(b => b.addEventListener('click', () => { store.activeCollection = null; saveStore(); go('memo'); }));
  el.querySelectorAll('[data-gview]').forEach(b => b.addEventListener('click', () => { gardenView = b.dataset.gview; render(); }));

  // Apparence : appliquer + sauvegarder + re-render, sans rechargement
  el.querySelectorAll('[data-theme-pick]').forEach(b => b.addEventListener('click', () => { applyTheme(b.dataset.themePick); render(); }));

  // « Le verset offert » : activer (défaut 8 h), changer d'heure, désactiver
  if (q('[data-push-on]')) q('[data-push-on]').addEventListener('click', () => pushActivate(8));
  if (q('[data-push-off]')) q('[data-push-off]').addEventListener('click', pushDeactivate);
  el.querySelectorAll('[data-push-heure]').forEach(b => b.addEventListener('click', () => pushSetHour(+b.dataset.pushHeure)));

  // Écran Moi : mémorise l'état déplié/replié de chaque section — une action
  // re-rend tout l'écran, et une section ouverte doit le rester (même
  // mécanique que l'onglet Activité de l'admin).
  el.querySelectorAll('details.moi-repli').forEach(d => {
    d.addEventListener('toggle', () => { moiOuverts[d.dataset.cle] = d.open; });
  });

  // Compte, synchro, amis & église
  if (route.name === 'moi') { ensureFriends(); ensureGroupes(); }
  if (q('[data-account]')) q('[data-account]').addEventListener('click', startAccountFlow);
  if (q('[data-accchip]')) q('[data-accchip]').addEventListener('click', () => {
    if (window.GraineAPI && GraineAPI.isLoggedIn()) go('moi');
    else startAccountFlow();
  });
  if (q('[data-syncnow]')) q('[data-syncnow]').addEventListener('click', () => { syncNow(); });
  if (q('[data-copycode]')) q('[data-copycode]').addEventListener('click', copyFriendCode);
  if (q('[data-invite]')) q('[data-invite]').addEventListener('click', () => partager(texteInvitation()));
  if (q('[data-editpseudo]')) q('[data-editpseudo]').addEventListener('click', () => {
    pseudoEdit = { value: (GraineAPI.user() || {}).pseudo || '', error: null, busy: false }; render();
  });
  if (q('[data-cancelpseudo]')) q('[data-cancelpseudo]').addEventListener('click', () => { pseudoEdit = null; render(); });
  if (q('[data-pseudoform]')) q('[data-pseudoform]').addEventListener('submit', e => { e.preventDefault(); savePseudo(); });
  if (q('[data-logout]')) q('[data-logout]').addEventListener('click', doLogout);
  if (q('[data-delaccount]')) q('[data-delaccount]').addEventListener('click', doDeleteAccount);
  if (q('[data-addfriendform]')) q('[data-addfriendform]').addEventListener('submit', e => { e.preventDefault(); doAddFriend(); });
  el.querySelectorAll('[data-unfriend]').forEach(b => b.addEventListener('click', () => doRemoveFriend(b.dataset.unfriend, b.dataset.pseudo)));
  // Mon église
  if (q('[data-grpjoinform]')) q('[data-grpjoinform]').addEventListener('submit', e => { e.preventDefault(); doGroupeRejoindre(); });
  if (q('[data-grpdemform]')) q('[data-grpdemform]').addEventListener('submit', e => { e.preventDefault(); doDemandeEnvoyer(); });
  if (q('[data-grpdemcancel]')) q('[data-grpdemcancel]').addEventListener('click', doDemandeAnnuler);
  el.querySelectorAll('[data-copygrp]').forEach(b => b.addEventListener('click', () => copyGroupCode(b.dataset.copygrp)));
  el.querySelectorAll('[data-grpleave]').forEach(b => b.addEventListener('click', () => doGroupeQuitter(b.dataset.grpleave, b.dataset.nom)));
  el.querySelectorAll('[data-versetedit]').forEach(b => b.addEventListener('click', () => {
    const g = Array.isArray(groupesCache) ? groupesCache.find(x => x.code === b.dataset.versetedit) : null;
    versetEdit = { code: b.dataset.versetedit,
      reference: g && g.verset ? g.verset.reference : '',
      texte: g && g.verset ? g.verset.texte : '', error: null, busy: false };
    render();
  }));
  if (q('[data-versetcancel]')) q('[data-versetcancel]').addEventListener('click', () => { versetEdit = null; render(); });
  if (q('[data-grpversetform]')) q('[data-grpversetform]').addEventListener('submit', e => { e.preventDefault(); doGroupeVerset(); });
  // L'onglet Mon église : la page se charge à l'arrivée, le reste est du geste.
  if (route.name === 'eglise') { ensureGroupes(); const gEgl = egliseCourante(); if (gEgl) ensurePage(gEgl.code); }
  if (route.name === 'banques') { ensureGroupes(); ensureBanqueEglise(); }
  // L'éditeur des banques d'église
  el.querySelectorAll('[data-bqmodule]').forEach(b => b.addEventListener('click', () => {
    bqModule = b.dataset.bqmodule; bqSel = null; bqEdit = null; bqNotice = bqError = null;
    render(); ensureBanqueEglise();
  }));
  el.querySelectorAll('[data-bqmode]').forEach(b => b.addEventListener('click', () => doBqMode(b.dataset.bqmode)));
  if (q('[data-bqselouvrir]')) q('[data-bqselouvrir]').addEventListener('click', doBqSelOuvrir);
  if (q('[data-bqselsave]')) q('[data-bqselsave]').addEventListener('click', doBqSelSave);
  if (q('[data-bqselannuler]')) q('[data-bqselannuler]').addEventListener('click', () => { bqSel = null; render(); });
  el.querySelectorAll('[data-bqcoche]').forEach(c => c.addEventListener('change', () => {
    if (!bqSel) return;
    if (c.checked) bqSel.ids[c.dataset.bqcoche] = true; else delete bqSel.ids[c.dataset.bqcoche];
    // Les compteurs se retouchent en place : re-rendre ferait perdre le fil
    // (défilement, focus) au milieu d'une longue liste.
    const nb = Object.keys(bqSel.ids).length;
    const btn = q('[data-bqselsave]'); if (btn) btn.textContent = `Retenir (${nb})`;
    const lbl = q('label[for="bqFiltre"]'); if (lbl) lbl.textContent = `Choisir les items retenus (${nb})`;
  }));
  el.querySelectorAll('[data-bqedit]').forEach(b => b.addEventListener('click', () => bqOuvrirForm(b.dataset.bqedit || null)));
  el.querySelectorAll('[data-bqdel]').forEach(b => b.addEventListener('click', () => doBqItemDelete(b.dataset.bqdel)));
  if (q('[data-bqform]')) q('[data-bqform]').addEventListener('submit', e => { e.preventDefault(); doBqItemSave(); });
  if (q('[data-bqannuler]')) q('[data-bqannuler]').addEventListener('click', () => { bqEdit = null; render(); });
  el.querySelectorAll('[data-bqbonne]').forEach(b => b.addEventListener('click', () => { if (bqEdit) { bqEdit.bonne = +b.dataset.bqbonne; render(); } }));
  el.querySelectorAll('[data-bqecrit]').forEach(b => b.addEventListener('click', () => { if (bqEdit) { bqEdit.ecrit = b.dataset.bqecrit === '1'; render(); } }));
  el.querySelectorAll('[data-bqgenre]').forEach(b => b.addEventListener('click', () => { if (bqEdit) { bqEdit.genre = b.dataset.bqgenre; render(); } }));
  el.querySelectorAll('[data-eglsel]').forEach(b => b.addEventListener('click', () => {
    egliseSel = b.dataset.eglsel; pageEdit = null; pageNotice = pageError = null; render();
    const gEgl = egliseCourante(); if (gEgl) ensurePage(gEgl.code);
  }));
  el.querySelectorAll('[data-pageedit]').forEach(b => b.addEventListener('click', () => pageOuvrirForm(b.dataset.pageedit, b.dataset.id ? +b.dataset.id : null)));
  el.querySelectorAll('[data-pagedel]').forEach(b => b.addEventListener('click', () => doPageDelete(b.dataset.pagedel, +b.dataset.id, b.dataset.nom)));
  el.querySelectorAll('[data-pagepin]').forEach(b => b.addEventListener('click', () => doPagePin(+b.dataset.pagepin)));
  el.querySelectorAll('[data-svcmain]').forEach(b => b.addEventListener('click', () => doServiceMain(+b.dataset.svcmain, b.dataset.inscrit === '1')));
  el.querySelectorAll('[data-passation]').forEach(b => b.addEventListener('click', () => doGroupePassation(b.dataset.passation)));
  if (q('[data-pageform]')) q('[data-pageform]').addEventListener('submit', e => { e.preventDefault(); doPageSave(); });
  if (q('[data-pagecancel]')) q('[data-pagecancel]').addEventListener('click', () => { pageEdit = null; render(); });
  if (q('[data-pagepinform]')) q('[data-pagepinform]').addEventListener('click', () => { if (pageEdit) { pageEdit.epingle = !pageEdit.epingle; render(); } });
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
  bindInput('grpCodeInput', v => { grpCodeField = v; });
  bindInput('grpNomInput', v => { grpNomField = v; });
  bindInput('grpAdrInput', v => { grpAdrField = v; });
  bindInput('grpMailInput', v => { grpMailField = v; });
  bindInput('versetRefInput', v => { if (versetEdit) versetEdit.reference = v; });
  bindInput('versetTexteInput', v => { if (versetEdit) versetEdit.texte = v; });
  // Formulaires de la page d'église (un seul ouvert à la fois).
  bindInput('pageTitre', v => { if (pageEdit) pageEdit.titre = v; });
  bindInput('pageTexte', v => { if (pageEdit) pageEdit.texte = v; });
  bindInput('pageLibelle', v => { if (pageEdit) pageEdit.libelle = v; });
  bindInput('pageJour', v => { if (pageEdit) pageEdit.jour = v; });
  bindInput('pageHeure', v => { if (pageEdit) pageEdit.heure = v; });
  bindInput('pageLieu', v => { if (pageEdit) pageEdit.lieu = v; });
  bindInput('pageDate', v => { if (pageEdit) pageEdit.date = v; });
  bindInput('pageDetails', v => { if (pageEdit) pageEdit.details = v; });
  bindInput('pagePlaces', v => { if (pageEdit) pageEdit.places = v; });
  // Formulaires des banques d'église (un seul ouvert à la fois, forme par épreuve).
  bindInput('bqFiltre', v => {
    if (!bqSel) return;
    // Filtrer re-rend la liste ; le champ retrouve son focus et son curseur.
    bqSel.filtre = v; render();
    const f = q('#bqFiltre'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  });
  bindInput('bqParole', v => { if (bqEdit) bqEdit.parole = v; });
  bindInput('bqOpt0', v => { if (bqEdit) bqEdit.options[0] = v; });
  bindInput('bqOpt1', v => { if (bqEdit) bqEdit.options[1] = v; });
  bindInput('bqOpt2', v => { if (bqEdit) bqEdit.options[2] = v; });
  bindInput('bqOpt3', v => { if (bqEdit) bqEdit.options[3] = v; });
  bindInput('bqRef', v => { if (bqEdit) bqEdit.reference = v; });
  bindInput('bqContexte', v => { if (bqEdit) bqEdit.contexte = v; });
  bindInput('bqPhrase', v => { if (bqEdit) bqEdit.phrase = v; });
  bindInput('bqPrecision', v => { if (bqEdit) bqEdit.precision = v; });
  bindInput('bqReponse', v => { if (bqEdit) bqEdit.reponse = v; });
  bindInput('bqAccepte', v => { if (bqEdit) bqEdit.accepte = v; });
  bindInput('bqInd0', v => { if (bqEdit) bqEdit.indices[0] = v; });
  bindInput('bqInd1', v => { if (bqEdit) bqEdit.indices[1] = v; });
  bindInput('bqInd2', v => { if (bqEdit) bqEdit.indices[2] = v; });
  bindInput('bqInd3', v => { if (bqEdit) bqEdit.indices[3] = v; });
  bindInput('bqInd4', v => { if (bqEdit) bqEdit.indices[4] = v; });
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
    // Une pierre du chemin vient-elle de se poser ? (verset planté, collection
    // complétée, verset enraciné…) — léger : simple lecture des stores.
    if (window.GrainePierres) GrainePierres.verifier();
    session.result = 'success';
    // Situer le verset : après chaque exercice réussi — en introduction, la
    // page d'étude vient de montrer la référence, la redemander tout de suite
    // est justement un premier ancrage.
    const p = parseRef(card.ref);
    if (p) {
      session.situer = { livre: p.livre, chapitre: p.chapitre, versets: p.versets,
        options: situerOptionsLivres(p.livre), refOptions: null,
        choixLivre: null, choixRef: null, revele: false };
      session.phase = 'situer';
    } else {
      session.phase = 'result';
    }
    render();
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
// Situer : au toucher, on révèle d'abord (vert/rouge, boutons figés), puis on
// avance tout seul — vite si c'était bon, plus posément s'il faut lire la
// correction. Le garde-fou vérifie qu'on est toujours sur le même écran
// (l'utilisateur a pu quitter la session pendant la pause).
function situerAvance(st, delai, suite) {
  setTimeout(() => {
    if (!session || session.phase !== 'situer' || session.situer !== st) return;
    suite();
    render();
  }, delai);
}
function situerPickLivre(livre) {
  const st = session.situer;
  if (st.revele) return;
  st.choixLivre = livre;
  st.revele = true;
  render();
  const ok = livre === st.livre;
  situerAvance(st, ok ? 900 : 2100, () => {
    if (ok && store.situerExpert) {
      st.refOptions = situerOptionsRef(st.chapitre, st.versets);
      st.revele = false;
    } else {
      session.phase = 'result';
    }
  });
}
function situerPickRef(ref) {
  const st = session.situer;
  if (st.revele) return;
  st.choixRef = ref;
  st.revele = true;
  render();
  situerAvance(st, ref === st.chapitre + '.' + st.versets ? 900 : 2100, () => {
    session.phase = 'result';
  });
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
  // Un démarrage qui échoue ne doit JAMAIS laisser « Chargement… » figé :
  // l'écran dit ce qui s'est passé et propose de réessayer.
  try {
    markActiveDay(); // ouvrir l'appli compte comme un jour d'activité (une fois par jour)
    // Les pierres déjà méritées (y compris par les modules Lire et Défi) se
    // posent dès l'ouverture — jamais deux fois, la clé garde la mémoire.
    if (window.GrainePierres) GrainePierres.verifier();
    await Promise.all([loadLibrary(), loadCollections()]);
    syncCompletedCollections();
    render();
  } catch (e) {
    el.innerHTML = `<div class="card center" style="margin-top:40px;padding:30px 18px">
      <p style="margin:0 0 6px"><b>L'appli n'a pas pu démarrer.</b></p>
      <p class="muted" style="margin:0">${esc((e && e.message) || 'Erreur inconnue')}</p>
      <button class="btn btn-primary" style="margin-top:16px" onclick="location.reload()">Réessayer</button>
    </div>`;
    return;
  }
  // Synchronisation à l'ouverture si connecté — silencieuse, non bloquante :
  // hors-ligne, l'appli locale continue exactement comme avant.
  if (window.GraineAPI && GraineAPI.isLoggedIn()) syncNow();
  // Les groupes se chargent dès l'ouverture : c'est eux qui font apparaître
  // l'onglet « Mon église » dans la barre, sans attendre un passage par Moi.
  ensureGroupes();
  loadPublicConfig(); // sait déjà, à l'ouverture de « Moi », si Google est proposé
})();
