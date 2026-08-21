/* ============================================================================
   Bible Horizon — écran d'administration (adresses listées dans ADMIN_EMAILS).

   - « Questions » : les questions de chaque épreuve, épreuve par épreuve.
     Le quiz du Défi vient de /api/questions comparé à defi/data/questions.json ;
     les trois autres banques (« Qui a dit ça ? », « Écrit… ou pas ? »,
     « De qui parle-t-on ? ») de /api/banque/{module} comparé à leur
     {module}/data/banque.json. La comparaison donne l'état de chaque
     question : fichier (intacte) / modifiée (surcharge en base) /
     ajoutée (id adm-) / désactivée (surcharge inactive). Éditer une question
     du fichier crée une surcharge ; la « supprimer » la désactive seulement
     (réversible) ; seuls les ajouts se suppriment pour de bon.
   - « Utilisateurs » : la liste des comptes, avec suppression totale.
   - « Églises » : les demandes de groupe en attente (accepter fait naître le
     groupe, refuser laisse le porteur redemander) et les groupes existants.

   En ligne seulement : rien ici n'est pré-caché, et le serveur revérifie le
   rôle admin à chaque route — cette page ne fait que refléter son verdict.
   ========================================================================== */

'use strict';

/* Filet : si icons.js manque (déploiement incomplet), l'appli s'affiche sans
   icônes plutôt que de planter sur « icon is not defined ». */
if (!window.icon) window.icon = function () { return ''; };


const el = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const NIVEAUX = { 1: 'Découverte', 2: 'Habitué', 3: 'Connaisseur' };
const ETATS = { fichier: 'fichier', modifiee: 'modifiée', ajoutee: 'ajoutée', desactivee: 'désactivée' };

/* Les trois banques d'épreuve gérées ici (le quiz du Défi a son propre circuit).
   `champ` : le texte principal d'une question (affichage, recherche, tri A → Z) ;
   `nom`/`fem` : le mot juste pour compteurs, boutons et confirmations. */
const EPREUVES = {
  quiadit: {
    titre: 'Qui a dit ça ?', champ: 'parole', fichier: '../quiadit/data/banque.json',
    nom: 'parole', fem: true, placeholder: 'Chercher une parole, une référence…'
  },
  ecritoupas: {
    titre: 'Écrit… ou pas ?', champ: 'phrase', fichier: '../ecritoupas/data/banque.json',
    nom: 'phrase', fem: true, placeholder: 'Chercher une phrase, une référence…'
  },
  portrait: {
    titre: 'De qui parle-t-on ?', champ: 'reponse', fichier: '../portrait/data/banque.json',
    nom: 'portrait', fem: false, placeholder: 'Chercher un personnage, un indice, une référence…'
  }
};

/* Message doux quand le serveur est injoignable — jamais d'erreur brute. */
function messageDoux(e) {
  if (e && e.offline) return 'Pas de connexion — l’administration ne fonctionne qu’en ligne.';
  return (e && e.message) || 'Un petit souci est survenu. Réessaie dans un instant.';
}

function dateCourte(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* Comparaison sans accents ni casse, pour la recherche. */
const normalise = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/* ---------- État ---------- */
let onglet = 'questions';   // 'questions' | 'users' | 'eglises' | 'activite' | 'systeme'
let sys = null, sysErreur = null; // onglet Système : état du serveur
let actJournal = null, actJournalErreur = null; // onglet Activité : journal serveur
let actBrevo = null, actBrevoErreur = null;     // onglet Activité : côté Brevo
let actVisites = null, actVisitesErreur = null; // onglet Activité : fréquentation
let actSignal = null, actSignalErreur = null; // onglet Activité : ce que les lecteurs signalent
let actOuverts = { signalements: false, visites: false, journal: false, brevo: false }; // sections dépliées (survit au re-rendu)
let epreuve = 'quiz';       // sous-onglet de « Questions » : 'quiz' | 'quiadit' | 'ecritoupas' | 'portrait'
let categories = [];        // catégories du fichier (ordre d'affichage, et du select)
let qListe = null;          // [{ q, etat }] — null tant que rien n'est chargé
let qRecherche = '';
let qCategorie = null;      // null = toutes
let qTri = 'fichier';       // 'fichier' | 'texte' | 'reference'
let qForm = null;           // formulaire ouvert : { neuf, id, categorie, niveau, question, options, bonne, reference, erreur }
let qErreur = null;
let qBusy = false;
/* Les trois banques d'épreuve, chacune son coin d'état (clé = module). */
let bListes = { quiadit: null, ecritoupas: null, portrait: null }; // [{ q, etat }]
let bErreurs = { quiadit: null, ecritoupas: null, portrait: null };
let bRecherches = { quiadit: '', ecritoupas: '', portrait: '' };
let bFiltres = { ecritoupas: null, portrait: null }; // ecritoupas : true/false (le champ ecrit) ; portrait : un genre — null = toutes
let bTris = { quiadit: 'fichier', ecritoupas: 'fichier', portrait: 'fichier' };
let bGenres = [];           // genres réellement présents dans la banque portrait
let bForm = null;           // formulaire d'épreuve ouvert : { module, neuf, id, …champs, erreur }
let uListe = null;          // comptes — null pendant le chargement
let uErreur = null;
let egData = null;          // onglet Églises : { demandes, groupes } — null pendant le chargement
let egContenuCode = null;   // église dont on inspecte le contenu publié
let egContenu = null;       // son contenu, ou null pendant le chargement
let egRetraitErreur = null; // l'échec d'un retrait, gardé sous les yeux
const ETATS_SERIE = { brouillon: 'brouillon', publiee: 'publiée', archivee: 'archivée' };
let egErreur = null;
let egBusy = false;         // une décision (accepter/refuser) à la fois

/* ---------- Questions : chargement et fusion des états ---------- */

function memeQuestion(a, b) {
  return a.categorie === b.categorie && a.niveau === b.niveau && a.question === b.question
    && a.bonne === b.bonne && a.reference === b.reference
    && JSON.stringify(a.options) === JSON.stringify(b.options);
}

async function chargerQuestions() {
  qErreur = null;
  try {
    // La banque fusionnée du serveur, et le fichier de base pour comparer.
    const [serveur, fichier] = await Promise.all([
      GraineAPI.questions(),
      fetch('../defi/data/questions.json', { cache: 'no-cache' }).then(r => r.json())
    ]);
    categories = fichier.categories || serveur.categories || [];
    const parId = new Map((serveur.questions || []).map(q => [q.id, q]));
    const liste = [];
    (fichier.questions || []).forEach(f => {
      const m = parId.get(f.id);
      if (!m) liste.push({ q: f, etat: 'desactivee' });
      else liste.push({ q: m, etat: memeQuestion(f, m) ? 'fichier' : 'modifiee' });
      parId.delete(f.id);
    });
    parId.forEach(q => liste.push({ q, etat: 'ajoutee' })); // les ajouts (adm-…)
    qListe = liste;
  } catch (e) {
    qListe = null;
    qErreur = messageDoux(e);
  }
  render();
}

/* Tri d'une liste [{ q, etat }] : ordre du fichier (tel quel), ou A → Z sur le
   texte principal (`champ`) ou la référence — sans accents, à la française. */
function triListe(liste, tri, champ) {
  if (tri === 'fichier') return liste;
  const cle = tri === 'reference' ? 'reference' : champ;
  return liste.slice().sort((a, b) =>
    normalise(a.q[cle] || '').localeCompare(normalise(b.q[cle] || ''), 'fr'));
}

function qFiltrees() {
  const res = qListe.filter(i => {
    if (qCategorie && i.q.categorie !== qCategorie) return false;
    if (qRecherche) {
      const t = normalise(i.q.question + ' ' + i.q.reference + ' ' + i.q.id);
      if (!t.includes(normalise(qRecherche))) return false;
    }
    return true;
  });
  return triListe(res, qTri, 'question');
}

/* ---------- Questions : actions ---------- */

async function actionQuestion(act, id) {
  if (qBusy) return;
  if (act === 'supprimer' && !confirm('Supprimer définitivement cette question ajoutée ?')) return;
  qBusy = true; qErreur = null; render();
  try {
    if (act === 'desactiver' || act === 'supprimer') await GraineAPI.adminDeleteQuestion(id);
    else await GraineAPI.adminRestoreQuestion(id); // réactiver / rétablir
  } catch (e) {
    qErreur = messageDoux(e);
  }
  qBusy = false;
  await chargerQuestions();
}

/* Relit les champs du formulaire (pour ne rien perdre à un re-rendu). */
function lireForm() {
  const f = qForm;
  const g = id => document.getElementById(id);
  if (!f || !g('f-question')) return;
  f.question = g('f-question').value;
  f.categorie = g('f-categorie').value;
  f.reference = g('f-reference').value;
  f.options = [0, 1, 2, 3].map(i => g('f-opt-' + i).value);
  const r = document.querySelector('input[name="f-bonne"]:checked');
  f.bonne = r ? Number(r.value) : 0;
}

async function enregistrerForm() {
  if (qBusy) return;
  lireForm();
  const f = qForm;
  const corps = {
    categorie: f.categorie,
    niveau: f.niveau,
    question: f.question.trim(),
    options: f.options.map(o => o.trim()),
    bonne: f.bonne,
    reference: f.reference.trim()
  };
  if (!f.neuf) corps.id = f.id;
  // Petites vérifications locales — le serveur revalide tout de toute façon.
  if (!corps.question) { f.erreur = 'La question ne peut pas être vide.'; render(); return; }
  if (corps.options.some(o => !o)) { f.erreur = 'Les 4 réponses doivent être remplies.'; render(); return; }
  if (!corps.reference) { f.erreur = 'La référence biblique ne peut pas être vide.'; render(); return; }
  qBusy = true; f.erreur = null; render();
  try {
    await GraineAPI.adminSaveQuestion(corps);
    qForm = null; qBusy = false;
    await chargerQuestions();
  } catch (e) {
    qBusy = false; f.erreur = messageDoux(e); render();
  }
}

/* ---------- Banques d'épreuve : chargement et fusion des états ----------
   Même mécanique que le quiz : la banque fusionnée du serveur d'un côté, le
   fichier statique de l'autre, et la comparaison donne l'état de chaque
   question — fichier / modifiée / ajoutée (adm-) / désactivée. */

function memeItemBanque(module, a, b) {
  const t = v => (v == null ? '' : String(v)); // null et absent valent « vide »
  if (module === 'quiadit') {
    return t(a.parole) === t(b.parole) && a.bonne === b.bonne
      && t(a.reference) === t(b.reference) && t(a.contexte) === t(b.contexte)
      && JSON.stringify(a.options) === JSON.stringify(b.options);
  }
  if (module === 'ecritoupas') {
    return t(a.phrase) === t(b.phrase) && !!a.ecrit === !!b.ecrit
      && t(a.reference) === t(b.reference) && t(a.precision) === t(b.precision);
  }
  return t(a.reponse) === t(b.reponse) && t(a.genre) === t(b.genre)
    && t(a.reference) === t(b.reference)
    && JSON.stringify(a.accepte || []) === JSON.stringify(b.accepte || [])
    && JSON.stringify(a.indices || []) === JSON.stringify(b.indices || []);
}

async function chargerBanque(module) {
  bErreurs[module] = null;
  try {
    const [serveur, fichier] = await Promise.all([
      GraineAPI.banque(module),
      fetch(EPREUVES[module].fichier, { cache: 'no-cache' }).then(r => r.json())
    ]);
    if (module === 'portrait') {
      // Les genres réellement présents dans le fichier, dans son ordre.
      bGenres = [];
      (fichier.items || []).forEach(it => { if (it.genre && !bGenres.includes(it.genre)) bGenres.push(it.genre); });
    }
    const parId = new Map((serveur.items || []).map(q => [q.id, q]));
    const liste = [];
    (fichier.items || []).forEach(f => {
      const s = parId.get(f.id);
      if (!s) liste.push({ q: f, etat: 'desactivee' });
      else liste.push({ q: s, etat: memeItemBanque(module, f, s) ? 'fichier' : 'modifiee' });
      parId.delete(f.id);
    });
    parId.forEach(q => liste.push({ q, etat: 'ajoutee' })); // les ajouts (adm-…)
    bListes[module] = liste;
  } catch (e) {
    bListes[module] = null;
    bErreurs[module] = messageDoux(e);
  }
  render();
}

/* Tous les champs textuels d'une question, pour la recherche (id compris). */
function texteBanque(module, q) {
  if (module === 'quiadit') return [q.parole].concat(q.options || [], [q.reference, q.contexte, q.id]);
  if (module === 'ecritoupas') return [q.phrase, q.reference, q.precision, q.id];
  return [q.reponse].concat(q.accepte || [], q.indices || [], [q.genre, q.reference, q.id]);
}

function bFiltrees(module) {
  const res = bListes[module].filter(i => {
    const q = i.q;
    if (module === 'ecritoupas' && bFiltres.ecritoupas !== null && !!q.ecrit !== bFiltres.ecritoupas) return false;
    if (module === 'portrait' && bFiltres.portrait && q.genre !== bFiltres.portrait) return false;
    if (bRecherches[module]) {
      const t = normalise(texteBanque(module, q).filter(Boolean).join(' '));
      if (!t.includes(normalise(bRecherches[module]))) return false;
    }
    return true;
  });
  return triListe(res, bTris[module], EPREUVES[module].champ);
}

/* ---------- Banques d'épreuve : actions ---------- */

async function actionBanque(module, act, id) {
  if (qBusy) return;
  const c = EPREUVES[module];
  if (act === 'supprimer' && !confirm(`Supprimer définitivement ${c.fem ? 'cette' : 'ce'} ${c.nom} ajouté${c.fem ? 'e' : ''} ?`)) return;
  qBusy = true; bErreurs[module] = null; render();
  try {
    if (act === 'desactiver' || act === 'supprimer') await GraineAPI.adminBanqueDelete(module, id);
    else await GraineAPI.adminBanqueRestore(module, id); // réactiver / rétablir
  } catch (e) {
    bErreurs[module] = messageDoux(e);
  }
  qBusy = false;
  await chargerBanque(module);
}

/* Un formulaire vierge pour l'épreuve donnée. */
function formBanqueVide(module) {
  if (module === 'quiadit') return { module, neuf: true, id: null, parole: '', options: ['', '', '', ''], bonne: 0, reference: '', contexte: '', erreur: null };
  if (module === 'ecritoupas') return { module, neuf: true, id: null, phrase: '', ecrit: true, reference: '', precision: '', erreur: null };
  return { module, neuf: true, id: null, reponse: '', accepte: '', genre: bGenres[0] || 'personnage', indices: ['', '', '', '', ''], reference: '', erreur: null };
}

/* Relit les champs du formulaire d'épreuve (pour ne rien perdre à un re-rendu). */
function lireFormBanque() {
  const f = bForm;
  const g = id => document.getElementById(id);
  if (!f || !g('b-f-reference')) return;
  f.reference = g('b-f-reference').value;
  if (f.module === 'quiadit') {
    f.parole = g('b-f-parole').value;
    f.contexte = g('b-f-contexte').value;
    f.options = [0, 1, 2, 3].map(i => g('b-f-opt-' + i).value);
    const r = document.querySelector('input[name="b-f-bonne"]:checked');
    f.bonne = r ? Number(r.value) : 0;
  } else if (f.module === 'ecritoupas') {
    f.phrase = g('b-f-phrase').value;
    f.precision = g('b-f-precision').value;
  } else {
    f.reponse = g('b-f-reponse').value;
    f.accepte = g('b-f-accepte').value;
    f.indices = [0, 1, 2, 3, 4].map(i => g('b-f-ind-' + i).value);
  }
}

async function enregistrerFormBanque() {
  if (qBusy) return;
  lireFormBanque();
  const f = bForm;
  let corps;
  // Petites vérifications locales — le serveur revalide tout de toute façon.
  if (f.module === 'quiadit') {
    corps = {
      parole: f.parole.trim(), options: f.options.map(o => o.trim()), bonne: f.bonne,
      reference: f.reference.trim(), contexte: f.contexte.trim()
    };
    if (!corps.parole) { f.erreur = 'La parole ne peut pas être vide.'; render(); return; }
    if (corps.options.some(o => !o)) { f.erreur = 'Les 4 réponses doivent être remplies.'; render(); return; }
    if (!corps.reference) { f.erreur = 'La référence biblique ne peut pas être vide.'; render(); return; }
  } else if (f.module === 'ecritoupas') {
    corps = {
      phrase: f.phrase.trim(), ecrit: f.ecrit,
      reference: f.reference.trim() || null, precision: f.precision.trim()
    };
    if (!corps.phrase) { f.erreur = 'La phrase ne peut pas être vide.'; render(); return; }
    if (f.ecrit && !corps.reference) { f.erreur = 'Une phrase écrite doit citer sa référence biblique.'; render(); return; }
  } else {
    corps = {
      reponse: f.reponse.trim(),
      accepte: f.accepte.split(',').map(v => v.trim()).filter(Boolean),
      genre: f.genre, indices: f.indices.map(i => i.trim()), reference: f.reference.trim()
    };
    if (!corps.reponse) { f.erreur = 'La réponse ne peut pas être vide.'; render(); return; }
    if (corps.indices.some(i => !i)) { f.erreur = 'Les 5 indices doivent être remplis.'; render(); return; }
    if (!corps.reference) { f.erreur = 'La référence biblique ne peut pas être vide.'; render(); return; }
  }
  if (!f.neuf) corps.id = f.id;
  qBusy = true; f.erreur = null; render();
  try {
    await GraineAPI.adminBanqueSave(f.module, corps);
    const module = f.module;
    bForm = null; qBusy = false;
    await chargerBanque(module);
  } catch (e) {
    qBusy = false; f.erreur = messageDoux(e); render();
  }
}

/* ---------- Utilisateurs ---------- */

async function ouvrirUsers() {
  onglet = 'users';
  uListe = null; uErreur = null;
  render();
  try { uListe = await GraineAPI.adminUsers(); }
  catch (e) { uErreur = messageDoux(e); }
  render();
}

async function supprimerCompte(id, pseudo, email) {
  if (!confirm(`Supprimer le compte de « ${pseudo} » (${email}) ?\n\nCela supprime TOUT : compte, sauvegarde, amis, duels. C'est définitif.`)) return;
  uErreur = null;
  try { await GraineAPI.adminDeleteUser(id); }
  catch (e) { uErreur = messageDoux(e); }
  await ouvrirUsers();
}

/* ---------- Églises : demandes de groupe et groupes existants ---------- */

async function ouvrirEglises() {
  onglet = 'eglises';
  egData = null; egErreur = null;
  render();
  await chargerEglises();
}

/* Recharge la liste sans effacer une erreur déjà affichée (celle d'une
   décision qui vient d'échouer doit rester visible après le re-rendu). */
async function chargerEglises() {
  try { egData = await GraineAPI.adminEglises(); }
  catch (e) { egData = null; egErreur = messageDoux(e); }
  render();
}

async function trancherDemande(action, id, nom, pseudo) {
  if (egBusy) return;
  if (action === 'accepter'
    && !confirm(`Accepter la demande « ${nom} » de ${pseudo} ?\n\nLe groupe sera créé, et ${pseudo} en deviendra le responsable.`)) return;
  egBusy = true; egErreur = null; render();
  try {
    if (action === 'accepter') await GraineAPI.adminEgliseAccepter(id);
    else await GraineAPI.adminEgliseRefuser(id);
  } catch (e) {
    egErreur = messageDoux(e);
  }
  egBusy = false;
  await chargerEglises();
}

/* ---------- Activité : journal serveur + remontée Brevo ---------- */

/* Les événements du journal serveur, traduits en français lisible.
   ok: true = bonne nouvelle (vert), false = alerte (rouge). */
const ACT_EVENEMENTS = {
  code_demande:     { label: 'Code demandé' },
  code_envoye:      { label: 'Code envoyé ✓', ok: true },
  code_echec_envoi: { label: "Échec d'envoi", ok: false },
  code_verifie_ok:  { label: 'Connexion réussie', ok: true },
  code_incorrect:   { label: 'Code incorrect', ok: false },
  compte_cree:      { label: 'Compte créé', ok: true },
  connexion_google: { label: 'Connexion Google', ok: true },
  compte_supprime:  { label: 'Compte supprimé' }
};

/* Les événements vus par Brevo, en français lisible. */
const ACT_BREVO = {
  requests:     { label: 'Envoi demandé' },
  delivered:    { label: 'Délivré', ok: true },
  opened:       { label: 'Ouvert', ok: true },
  uniqueOpened: { label: 'Ouvert', ok: true },
  proxy_open:   { label: 'Ouvert (proxy)' },
  loadedByProxy:{ label: 'Ouvert (proxy)' },
  clicks:       { label: 'Cliqué', ok: true },
  softBounces:  { label: 'Rejet temporaire', ok: false },
  hardBounces:  { label: 'Rejet définitif', ok: false },
  blocked:      { label: 'Bloqué', ok: false },
  spam:         { label: 'Signalé spam', ok: false },
  invalid:      { label: 'Adresse invalide', ok: false },
  deferred:     { label: 'Différé', ok: false },
  unsubscribed: { label: 'Désinscrit' },
  error:        { label: 'Erreur', ok: false }
};

function heureLocale(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—'
    : d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function chargerActivite() {
  actJournal = null; actJournalErreur = null;
  actBrevo = null; actBrevoErreur = null;
  actVisites = null; actVisitesErreur = null;
  actSignal = null; actSignalErreur = null;
  render();
  // Les sections en parallèle, chacune avec son propre filet : un souci
  // d'un côté (Brevo, par exemple) ne prive pas des autres.
  await Promise.all([
    GraineAPI.adminSignalements()
      .then(r => { actSignal = r; })
      .catch(e => { actSignalErreur = messageDoux(e); }),
    GraineAPI.adminVisites()
      .then(r => { actVisites = r; })
      .catch(e => { actVisitesErreur = messageDoux(e); }),
    GraineAPI.adminJournal()
      .then(r => { actJournal = r; })
      .catch(e => { actJournalErreur = messageDoux(e); }),
    GraineAPI.adminBrevo()
      .then(r => { actBrevo = r; })
      .catch(e => { actBrevoErreur = messageDoux(e); })
  ]);
  render();
}

function ouvrirActivite() {
  onglet = 'activite';
  chargerActivite();
}

function actBadge(table, evt) {
  const info = table[evt] || { label: evt };
  const classe = info.ok === true ? 'ok' : info.ok === false ? 'err' : '';
  return `<span class="act-evt ${classe}">${esc(info.label)}</span>`;
}

/* Résumé d'un journal pour l'intitulé de sa section repliée : nombre
   d'événements et heure du plus récent — l'essentiel sans avoir à ouvrir. */
function actResume(donnees, erreur) {
  if (erreur) return 'chargement impossible';
  if (!donnees) return 'chargement…';
  const evts = donnees.events || [];
  if (!evts.length) return "rien pour l'instant";
  const dernier = evts.reduce((max, e) => (e.ts && (!max || e.ts > max) ? e.ts : max), null);
  return `${evts.length} événement${evts.length > 1 ? 's' : ''} · dernier : ${heureLocale(dernier)}`;
}

/* Une section repliable de l'onglet Activité. L'erreur éventuelle reste HORS
   du <details> : elle doit se voir sans avoir à ouvrir la section.
   `resume` remplace le résumé standard quand les données ne sont pas un
   journal d'événements (la fréquentation, par exemple). */
function htmlSectionActivite(cle, titre, donnees, erreur, corps, resume) {
  return `
    <details class="act-repli" data-cle="${cle}" ${actOuverts[cle] ? 'open' : ''}>
      <summary>${esc(titre)} <span class="act-resume">— ${esc(resume ?? actResume(donnees, erreur))}</span></summary>
      ${corps}
    </details>
    ${erreur ? `<div class="card"><p class="field-error" style="margin:0">${esc(erreur)}</p></div>` : ''}`;
}

/* ---------- Fréquentation : les compteurs anonymes (api/visites.php) ---------- */

/* Les noms montrés à l'administrateur — la liste blanche VISITE_PAGES, côté humain. */
const VISITE_LIBELLES = {
  accueil: 'Accueil', lire: 'Lire', defi: 'Sonder (défi)', frise: 'Avant ou après ?',
  quiadit: 'Qui a dit ça ?', ecritoupas: 'Écrit… ou pas ?',
  portrait: 'De qui parle-t-on ?', memoriser: 'Mémoriser des versets',
};

function visitesResume() {
  if (actVisitesErreur) return 'chargement impossible';
  if (!actVisites) return 'chargement…';
  const total = (actVisites.parJour || []).reduce((s, j) => s + j.n, 0);
  if (!total) return "rien pour l'instant";
  return `${total} ouverture${total > 1 ? 's' : ''} sur 30 jours · ${actVisites.aujourdhui} aujourd'hui`;
}

function htmlVisites() {
  if (actVisitesErreur) return ''; // l'erreur est affichée hors du repli
  if (!actVisites) return `<div class="card center" style="padding:22px"><p class="muted" style="margin:0">Chargement…</p></div>`;
  const jours = actVisites.parJour || [];
  const pages = actVisites.parPage || [];
  const maxJour = Math.max(1, ...jours.map(j => j.n));
  const lignesPages = pages.map(p => `
    <tr>
      <td>${esc(VISITE_LIBELLES[p.page] || p.page)}</td>
      <td class="act-heure" style="text-align:right">${p.n}</td>
    </tr>`).join('');
  const barresJours = jours.map(j => `
    <div class="vis-jour">
      <span class="vis-date">${esc(j.jour.slice(5))}</span>
      <span class="vis-barre"><i style="width:${Math.round(100 * j.n / maxJour)}%"></i></span>
      <span class="vis-n">${j.n}</span>
    </div>`).join('');
  return `
    <div class="card" style="padding:12px 14px">
      <p class="muted" style="margin:0 0 10px">Des compteurs anonymes : aucune adresse, aucun identifiant, aucun
        cookie. L'appli vivant hors-ligne, une ouverture sans réseau n'envoie rien — ces chiffres
        sous-estiment, et donnent un ordre de grandeur plus qu'une mesure.</p>
      ${jours.length ? `<div class="vis-jours">${barresJours}</div>` : `<p class="muted" style="margin:0">Aucune ouverture comptée pour l'instant.</p>`}
      ${pages.length ? `
      <div class="adm-table-wrap" style="margin-top:12px">
        <table class="adm-table">
          <thead><tr><th>Page</th><th style="text-align:right">Ouvertures (30 j)</th></tr></thead>
          <tbody>${lignesPages}</tbody>
        </table>
      </div>` : ''}
    </div>`;
}

function htmlJournalServeur() {
  if (actJournalErreur) return ''; // l'erreur est affichée hors du repli
  if (!actJournal) return `<div class="card center" style="padding:22px"><p class="muted" style="margin:0">Chargement…</p></div>`;
  const lignes = (actJournal.events || []).map(e => `
    <tr>
      <td class="act-heure">${esc(heureLocale(e.ts))}</td>
      <td>${actBadge(ACT_EVENEMENTS, e.event)}</td>
      <td>${esc(e.email || '—')}</td>
      <td class="act-detail">${esc(e.detail || '')}</td>
    </tr>`).join('');
  return `
    <div class="card" style="padding:8px 10px">
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr><th>Quand</th><th>Événement</th><th>E-mail</th><th>Détail</th></tr></thead>
          <tbody>${lignes || `<tr><td colspan="4" class="muted">Rien au journal pour l'instant.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}

function htmlChezBrevo() {
  if (actBrevoErreur) return ''; // l'erreur est affichée hors du repli
  if (!actBrevo) return `<div class="card center" style="padding:22px"><p class="muted" style="margin:0">Chargement…</p></div>`;
  const note = actBrevo.note ? `<p class="muted" style="margin:2px 2px 10px">${esc(actBrevo.note)}</p>` : '';
  const lignes = (actBrevo.events || []).map(e => {
    const sujet = e.subject ? (e.subject.length > 42 ? e.subject.slice(0, 41) + '…' : e.subject) : '—';
    return `
    <tr>
      <td class="act-heure">${esc(heureLocale(e.ts))}</td>
      <td>${actBadge(ACT_BREVO, e.event)}</td>
      <td>${esc(e.email || '—')}</td>
      <td class="act-detail">${esc(sujet)}</td>
    </tr>`;
  }).join('');
  return `
    <div class="card" style="padding:8px 10px">
      ${note}
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr><th>Quand</th><th>Événement</th><th>E-mail</th><th>Sujet</th></tr></thead>
          <tbody>${lignes || (actBrevo.note ? '' : `<tr><td colspan="4" class="muted">Aucun événement récent chez Brevo.</td></tr>`)}</tbody>
        </table>
      </div>
    </div>`;
}

/* ---------- Ce que les lecteurs signalent (api/signalements.php) ----------

   Cette section passe DEVANT les autres dans l'onglet, et c'est voulu : la
   fréquentation se regarde quand on a le temps, un signalement attend une
   réponse. Un lecteur a pris la peine de dire « ça ne colle pas avec ma
   Bible » — le pire serait qu'il ne se passe rien. */

const SIGNAL_GENRES = {
  question: 'Question', annonce: 'Annonce', serie: 'Série', rdv: 'Rendez-vous',
};

function signalResume() {
  if (actSignalErreur) return 'chargement impossible';
  if (!actSignal) return 'chargement…';
  const n = actSignal.nouveaux || 0;
  if (!n) return 'rien à traiter';
  return n === 1 ? '1 à regarder' : n + ' à regarder';
}

function htmlSignalements() {
  if (!actSignal) return '';
  const liste = (actSignal.signalements || []);
  if (!liste.length) {
    return `<div class="card"><p class="muted" style="margin:0">Rien n'a été signalé.
      C'est bon signe — et le lien reste à portée du lecteur en cas de besoin.</p></div>`;
  }
  const lignes = liste.map(s => `
    <div class="sig-ligne ${s.statut === 'nouveau' ? 'sig-neuf' : 'sig-classe'}">
      <div class="sig-tete">
        <b>${esc(SIGNAL_GENRES[s.genre] || s.genre)}</b>
        <code class="sys-var">${esc(s.cible)}</code>
        <span class="muted">${esc(heureLocale(s.created_at))}</span>
        <span class="muted">· ${s.auteur ? esc(s.auteur) : 'signalé sans compte'}</span>
      </div>
      ${s.contexte ? `<p class="sig-contexte">${esc(s.contexte)}</p>` : ''}
      ${s.motif ? `<p class="sig-motif">« ${esc(s.motif)} »</p>` : `<p class="muted sig-motif">Aucun motif précisé.</p>`}
      <button class="btn btn-soft" data-sigclasser="${s.id}" data-statut="${s.statut === 'nouveau' ? 'traite' : 'nouveau'}">
        ${s.statut === 'nouveau' ? 'Classer' : 'Rouvrir'}
      </button>
    </div>`).join('');
  return `<div class="card" style="padding:8px 10px">${lignes}</div>`;
}

/* Classer ne supprime rien : la trace demeure, et se rouvre si la correction
   s'avère fausse. */
async function doSignalClasser(id, statut) {
  try {
    await GraineAPI.adminSignalementClasser(id, statut);
    actSignal = await GraineAPI.adminSignalements();
  } catch (e) {
    actSignalErreur = messageDoux(e);
  }
  render();
}

function htmlActivite() {
  const enCours = actJournal === null && !actJournalErreur;
  return `
    <button class="btn btn-soft btn-block" id="btn-act-actualiser" style="margin-bottom:14px" ${enCours ? 'disabled' : ''}>Actualiser</button>
    ${htmlSectionActivite('signalements', 'Signalements', actSignal, actSignalErreur, htmlSignalements(), signalResume())}
    ${htmlSectionActivite('visites', 'Fréquentation', actVisites, actVisitesErreur, htmlVisites(), visitesResume())}
    ${htmlSectionActivite('journal', 'Journal du serveur', actJournal, actJournalErreur, htmlJournalServeur())}
    ${htmlSectionActivite('brevo', 'Chez Brevo', actBrevo, actBrevoErreur, htmlChezBrevo())}`;
}

function brancherActivite() {
  const b = document.getElementById('btn-act-actualiser');
  if (b) b.onclick = chargerActivite;
  document.querySelectorAll('[data-sigclasser]').forEach(b => {
    b.addEventListener('click', () => doSignalClasser(+b.dataset.sigclasser, b.dataset.statut));
  });
  // Mémorise l'état déplié/replié : « Actualiser » re-rend tout l'écran, et
  // une section ouverte doit le rester après le re-rendu.
  document.querySelectorAll('details.act-repli').forEach(d => {
    d.addEventListener('toggle', () => { actOuverts[d.dataset.cle] = d.open; });
  });
}

/* ---------- Système : état du serveur et adresse du cron ---------- */

/* L'état du serveur, même si api-client.js est encore une vieille version en
   cache (mise à jour en cours de déploiement) : repli sur un appel direct. */
async function chargerSante() {
  if (GraineAPI.health) return GraineAPI.health();
  let session = null;
  try { session = JSON.parse(localStorage.getItem('graine.session') || 'null'); } catch (e) {}
  const r = await fetch('../api/health', {
    headers: session && session.token ? { Authorization: 'Bearer ' + session.token } : {}
  });
  if (!r.ok) throw new Error('Le serveur a répondu ' + r.status + '.');
  return r.json();
}

async function ouvrirSysteme() {
  onglet = 'systeme';
  sys = null; sysErreur = null;
  render();
  try { sys = await chargerSante(); }
  catch (e) { sysErreur = messageDoux(e); }
  render();
}

function ligneSys(label, valeur, ok) {
  return `<div class="sys-ligne"><span class="muted">${label}</span><b class="${ok === false ? 'sys-alerte' : ''}">${esc(String(valeur))}</b></div>`;
}

/* Une ligne de la liste « Configuration » : la variable est-elle définie sur
   le serveur ? Uniquement configurée/manquante — jamais les valeurs. */
function ligneConfig(c) {
  const ok = !!c.definie;
  return `<div class="sys-ligne">
    <span class="muted">${esc(c.libelle || c.variable)} <code class="sys-var">${esc(c.variable)}</code></span>
    <b class="${ok ? 'sys-bon' : 'sys-alerte'}">${ok ? 'configurée ✓' : 'manquante ✗'}</b>
  </div>`;
}

function htmlConfiguration() {
  // Absente d'une réponse encore en cache (ancienne version de l'API en cours
  // de déploiement) : la section s'efface d'elle-même plutôt que d'alarmer.
  if (!Array.isArray(sys.config) || sys.config.length === 0) return '';
  return `
    <div class="section-title">Configuration</div>
    <div class="card">
      ${sys.config.map(ligneConfig).join('')}
      <p class="muted" style="font-size:.85rem;margin:10px 2px 0">Seule la présence de chaque variable est vérifiée — les valeurs ne sont jamais affichées ni transmises.</p>
    </div>`;
}

/* La section « Réseau » : ce que le relais nous envoie VRAIMENT, et l'adresse
   que les plafonds anti-abus retiennent. Sans elle, PROXY_HOPS se règle à
   l'aveugle — /api/health n'est lisible qu'avec un jeton, donc jamais depuis
   la barre d'adresse du navigateur. La marche à suivre est écrite en toutes
   lettres : ouvrir cet écran en wifi, puis en 4G ; l'adresse retenue doit
   changer, et valoir l'adresse publique de la connexion. */
function htmlReseau() {
  // Absente d'une réponse encore en cache (ancienne version de l'API en cours
  // de déploiement) : la section s'efface plutôt que d'alarmer.
  const r = sys.reseau;
  if (!r) return '';
  const recu = r.xForwardedFor ? r.xForwardedFor : 'aucun en-tête reçu';
  // Deux réglages visiblement faux, et un seul geste pour chacun.
  let avis = '';
  if (!r.xForwardedFor && r.proxyHops > 0) {
    avis = `Aucun relais ne se signale alors que <code class="sys-var">PROXY_HOPS</code> vaut ${r.proxyHops} :
      l'en-tête, entièrement fourni par le visiteur, ne devrait pas être cru. Mettre la variable à <b>0</b>.`;
  } else if (r.xForwardedFor && r.ipRetenue === r.remoteAddr) {
    avis = `L'adresse retenue est celle de la connexion, pas celle du visiteur :
      <code class="sys-var">PROXY_HOPS</code> est trop grand. Le baisser d'un cran.`;
  }
  return `
    <div class="section-title">Réseau</div>
    <div class="card">
      ${ligneSys('Adresse retenue pour toi', r.ipRetenue || '?')}
      ${ligneSys('Reçu du relais', recu)}
      ${ligneSys('Adresse de la connexion', r.remoteAddr || '?')}
      ${ligneSys('Relais de confiance (PROXY_HOPS)', r.proxyHops)}
      ${avis ? `<p class="muted sys-alerte" style="font-size:.85rem;margin:10px 2px 0">${avis}</p>` : ''}
      <p class="muted" style="font-size:.85rem;margin:10px 2px 0">Les plafonds anti-abus comptent par adresse :
        c'est « adresse retenue » qui sert de compteur. Pour la vérifier, ouvre cet écran en wifi, puis
        avec le téléphone en 4G — elle doit <b>changer</b> et valoir l'adresse publique de la connexion.
        Si elle ne change pas, tout le monde partage un seul compteur et de vraies personnes seront bloquées :
        c'est <code class="sys-var">PROXY_HOPS</code> qu'il faut corriger, sans redéployer.</p>
    </div>`;
}

/* La version en ligne, tout en haut de l'état du serveur. Publier n'est pas
   déployer : un déploiement peut échouer sans que rien ne le dise, et l'on
   cherche alors dans l'appli une nouveauté qui n'a jamais quitté le dépôt.
   L'empreinte du commit tranche en une seconde. */
function htmlVersion() {
  const v = sys.version;
  if (!v || !v.commit) return '';
  const quoi = v.message ? v.commit + ' · ' + v.message : v.commit;
  return ligneSys('Version en ligne', quoi);
}

function htmlSysteme() {
  if (sysErreur) return `<div class="card"><p class="field-error" style="margin:0">${esc(sysErreur)}</p></div>`;
  if (!sys) return `<div class="card center" style="padding:30px"><p class="muted" style="margin:0">Chargement…</p></div>`;
  const p = sys.push || {};
  return `
    <div class="section-title">État du serveur</div>
    <div class="card">
      ${htmlVersion()}
      ${ligneSys('Base de données', sys.db || '?')}
      ${ligneSys("Envoi d'e-mails", sys.mail === 'dev' ? 'non configuré (mode dev)' : sys.mail, sys.mail !== 'dev')}
      ${ligneSys("Adresse d'expédition", sys.mailFrom || '—')}
      ${ligneSys('Dernier envoi', sys.lastMailError ? sys.lastMailError : 'aucun échec récent', !sys.lastMailError)}
    </div>
    ${htmlConfiguration()}
    ${htmlReseau()}

    <div class="section-title">Le verset offert (notifications)</div>
    <div class="card">
      ${ligneSys('Abonnements', p.abonnements ?? 0)}
      <p class="muted" style="margin:12px 2px 8px">Pour que les versets partent chaque jour, un service doit appeler cette
        adresse <b>toutes les heures</b>. Sur Railway : nouveau service vide, Cron Schedule <code>0 * * * *</code>,
        commande <code>curl -fsS "&lt;l'adresse ci-dessous&gt;"</code>. (Ou un pinger gratuit type cron-job.org.)</p>
      <div class="sys-cron"><code>${esc(p.cronUrl || '— (indisponible)')}</code></div>
      <button class="btn btn-soft btn-block" id="btn-copie-cron" style="margin-top:10px" ${p.cronUrl ? '' : 'disabled'}>Copier l'adresse du cron</button>
      <p class="muted" style="font-size:.85rem;margin:10px 2px 0">Cette adresse contient une clé secrète : ne la partage jamais publiquement.</p>
    </div>`;
}

function brancherSysteme() {
  const b = document.getElementById('btn-copie-cron');
  if (b) b.onclick = async () => {
    const url = (sys && sys.push && sys.push.cronUrl) || '';
    if (!url) return;
    try { await navigator.clipboard.writeText(url); b.textContent = 'Adresse copiée ✓'; }
    catch (e) { b.textContent = 'Copie impossible — sélectionne le texte à la main'; }
    setTimeout(() => { b.textContent = "Copier l'adresse du cron"; }, 2600);
  };
}

/* ============================================================================
   Rendu
   ========================================================================== */

function renderRefus() {
  el.innerHTML = `
  <div class="fade">
    <div class="card center" style="padding:34px 20px">
      <div>${icon('cadenas', 30)}</div>
      <h2 style="font-family:var(--serif);margin:10px 0 6px">Réservé à l'administration</h2>
      <p class="muted" style="margin:0">Cette page est réservée à l'équipe qui prend soin de l'appli.</p>
      <a class="btn btn-ghost" href="../" style="margin-top:18px;text-decoration:none">Revenir à l'accueil</a>
    </div>
  </div>`;
}

function renderChargement() {
  el.innerHTML = `<div class="card center" style="padding:40px"><p class="muted" style="margin:0">Un instant…</p></div>`;
}

function render() {
  const entete = `
    <button class="back-link" id="btn-retour">‹ Accueil</button>
    <div class="topbar">
      <div class="brand">
        <h1 class="app-title">${icon('outil', 17)} Administration <span class="seed">•</span> <span class="muted">Bible Horizon</span></h1>
      </div>
    </div>
    <div class="pill-row" style="margin-bottom:16px">
      <button class="pill ${onglet === 'questions' ? 'on' : ''}" id="tab-questions">Questions</button>
      <button class="pill ${onglet === 'users' ? 'on' : ''}" id="tab-users">Utilisateurs</button>
      <button class="pill ${onglet === 'eglises' ? 'on' : ''}" id="tab-eglises">Églises</button>
      <button class="pill ${onglet === 'activite' ? 'on' : ''}" id="tab-activite">Activité</button>
      <button class="pill ${onglet === 'systeme' ? 'on' : ''}" id="tab-systeme">Système</button>
    </div>`;

  el.innerHTML = `<div class="fade">${entete}${
    onglet === 'users' ? htmlUsers()
    : onglet === 'eglises' ? htmlEglises()
    : onglet === 'activite' ? htmlActivite()
    : onglet === 'systeme' ? htmlSysteme()
    : htmlQuestions()}</div>`;

  document.getElementById('btn-retour').onclick = () => { location.href = '../index.html'; };
  document.getElementById('tab-questions').onclick = () => { onglet = 'questions'; qForm = null; bForm = null; render(); };
  document.getElementById('tab-users').onclick = ouvrirUsers;
  document.getElementById('tab-eglises').onclick = ouvrirEglises;
  document.getElementById('tab-activite').onclick = ouvrirActivite;
  document.getElementById('tab-systeme').onclick = ouvrirSysteme;
  if (onglet === 'users') brancherUsers();
  else if (onglet === 'eglises') brancherEglises();
  else if (onglet === 'activite') brancherActivite();
  else if (onglet === 'systeme') brancherSysteme();
  else brancherQuestions();
}

/* ---------- Onglet Questions ---------- */

/* Le petit select de tri, commun au quiz et aux banques d'épreuve. */
function htmlTri(id, valeur) {
  const opts = [['fichier', 'Ordre du fichier'], ['texte', 'A → Z (texte)'], ['reference', 'A → Z (référence)']];
  return `<label class="adm-tri">Trier
    <select id="${id}">${opts.map(([v, l]) =>
      `<option value="${v}" ${valeur === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
  </label>`;
}

/* Le sélecteur d'épreuve en tête de l'onglet. */
/* Le choix de l'ÉPREUVE — un composant à part, qui ne doit surtout pas
   ressembler aux pastilles de filtre en dessous : le quiz a une catégorie
   « Qui a dit ? » quasi homonyme de l'épreuve « Qui a dit ça ? », et deux
   rangées de pastilles identiques rendaient les deux niveaux indiscernables.
   Mêmes icônes que le hub de l'appli, pour parler la même langue. */
const EPREUVE_ICONES = { quiz: 'defi', quiadit: 'parchemin', ecritoupas: 'lecture', portrait: 'moi' };
function htmlSelecteurEpreuve() {
  const entrees = [['quiz', 'Qui, où, quand ?']].concat(Object.keys(EPREUVES).map(m => [m, EPREUVES[m].titre]));
  return `
    <div class="section-title">Épreuve</div>
    <div class="adm-epreuves" id="q-epreuves">${entrees.map(([m, t]) =>
      `<button class="adm-epreuve ${epreuve === m ? 'on' : ''}" data-epreuve="${m}">${icon(EPREUVE_ICONES[m], 18)}<span>${esc(t)}</span></button>`).join('')}
    </div>
    <p class="muted adm-epreuve-note">« Avant ou après ? » (la frise) n'est pas encore modifiable ici — sa chronologie arrive dans une prochaine étape.</p>`;
}

function htmlQuestions() {
  if (epreuve === 'quiz') {
    if (qForm) return htmlForm();
    return htmlSelecteurEpreuve() + htmlQuiz();
  }
  if (bForm) return htmlFormBanque();
  return htmlSelecteurEpreuve() + htmlBanque(epreuve);
}

function brancherQuestions() {
  if (epreuve === 'quiz' && qForm) { brancherForm(); return; }
  if (epreuve !== 'quiz' && bForm) { brancherFormBanque(); return; }
  document.querySelectorAll('#q-epreuves [data-epreuve]').forEach(p => {
    p.onclick = () => {
      epreuve = p.dataset.epreuve;
      qForm = null; bForm = null;
      render();
      // Première visite d'une banque : on la charge (le quiz l'est au démarrage).
      if (epreuve !== 'quiz' && bListes[epreuve] === null && !bErreurs[epreuve]) chargerBanque(epreuve);
    };
  });
  if (epreuve === 'quiz') brancherQuiz();
  else brancherBanque(epreuve);
}

/* ---------- Le quiz du Défi (liste historique, intacte) ---------- */

function ligneQuestion(item) {
  const q = item.q;
  return `
  <div class="adm-q ${item.etat === 'desactivee' ? 'off' : ''}">
    <div class="adm-q-top">
      <span class="adm-q-txt">${esc(q.question)}</span>
      <span class="adm-badge ${item.etat}">${ETATS[item.etat]}</span>
    </div>
    <div class="adm-q-meta">${esc(q.categorie)} · niveau ${q.niveau} (${esc(NIVEAUX[q.niveau] || '?')}) · ${esc(q.reference)}</div>
    <div class="adm-q-actions">
      ${item.etat !== 'desactivee' ? `<button class="linkbtn" data-act="editer" data-id="${esc(q.id)}">Modifier</button>` : ''}
      ${item.etat === 'fichier' || item.etat === 'modifiee' ? `<button class="linkbtn" data-act="desactiver" data-id="${esc(q.id)}">Désactiver</button>` : ''}
      ${item.etat === 'modifiee' ? `<button class="linkbtn" data-act="retablir" data-id="${esc(q.id)}">Rétablir la version du fichier</button>` : ''}
      ${item.etat === 'desactivee' ? `<button class="linkbtn" data-act="reactiver" data-id="${esc(q.id)}">Réactiver</button>` : ''}
      ${item.etat === 'ajoutee' ? `<button class="linkbtn danger" data-act="supprimer" data-id="${esc(q.id)}">Supprimer</button>` : ''}
    </div>
  </div>`;
}

function htmlQuiz() {
  if (qListe === null && !qErreur) {
    return `<div class="card center" style="padding:30px"><p class="muted" style="margin:0">Chargement de la banque…</p></div>`;
  }
  if (qListe === null) {
    return `<div class="card"><p class="field-error" style="margin:0">${esc(qErreur)}</p></div>`;
  }

  const actives = qListe.filter(i => i.etat !== 'desactivee').length;
  const filtrees = qFiltrees();
  const pills = [`<button class="pill ${qCategorie === null ? 'on' : ''}" data-cat="">Toutes</button>`]
    .concat(categories.map(c => `<button class="pill ${qCategorie === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`))
    .join('');

  return `
    <div class="section-title">Qui, où, quand ? — les questions du quiz</div>
    <p class="adm-count">${actives} question${actives > 1 ? 's' : ''} active${actives > 1 ? 's' : ''} · ${qListe.length} en tout</p>
    ${qErreur ? `<p class="field-error" style="margin:0 4px 10px">${esc(qErreur)}</p>` : ''}
    <button class="btn btn-grow btn-block" id="btn-nouvelle" style="margin-bottom:12px" ${qBusy ? 'disabled' : ''}>Nouvelle question</button>
    <input class="field" type="search" id="q-recherche" placeholder="Chercher une question, une référence…"
      autocomplete="off" value="${esc(qRecherche)}" style="margin-bottom:10px">
    <label class="lbl" style="margin-top:2px">Catégorie <span class="muted" style="font-weight:500">(un thème du quiz — pas une épreuve)</span></label>
    <div class="pill-row" id="q-cats" style="margin-bottom:10px">${pills}</div>
    <div class="adm-outils">
      <p class="adm-count" id="q-compte">${filtrees.length} affichée${filtrees.length > 1 ? 's' : ''}</p>
      ${htmlTri('q-tri', qTri)}
    </div>
    <div id="q-liste">${filtrees.map(ligneQuestion).join('') || `<p class="muted" style="margin:14px 4px">Aucune question ne correspond.</p>`}</div>`;
}

function brancherQuiz() {
  const btnN = document.getElementById('btn-nouvelle');
  if (btnN) btnN.onclick = () => {
    qForm = { neuf: true, id: null, categorie: categories[0] || '', niveau: 1, question: '', options: ['', '', '', ''], bonne: 0, reference: '', erreur: null };
    render();
  };
  const rech = document.getElementById('q-recherche');
  if (rech) rech.oninput = () => { qRecherche = rech.value; majListe(); };
  const tri = document.getElementById('q-tri');
  if (tri) tri.onchange = () => { qTri = tri.value; majListe(); };
  document.querySelectorAll('#q-cats .pill').forEach(p => {
    p.onclick = () => { qCategorie = p.dataset.cat || null; render(); };
  });
  brancherListe();
}

/* Re-rendu de la liste seule, pour que le champ de recherche garde le focus. */
function majListe() {
  const zone = document.getElementById('q-liste');
  if (!zone) return;
  const filtrees = qFiltrees();
  const compte = document.getElementById('q-compte');
  if (compte) compte.textContent = `${filtrees.length} affichée${filtrees.length > 1 ? 's' : ''}`;
  zone.innerHTML = filtrees.map(ligneQuestion).join('') || `<p class="muted" style="margin:14px 4px">Aucune question ne correspond.</p>`;
  brancherListe();
}

function brancherListe() {
  document.querySelectorAll('#q-liste [data-act]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.id;
      if (b.dataset.act === 'editer') {
        const item = qListe.find(i => i.q.id === id);
        if (!item) return;
        qForm = {
          neuf: false, id, categorie: item.q.categorie, niveau: item.q.niveau,
          question: item.q.question, options: item.q.options.slice(),
          bonne: item.q.bonne, reference: item.q.reference, erreur: null
        };
        render();
      } else {
        actionQuestion(b.dataset.act, id);
      }
    };
  });
}

/* ---------- Formulaire (nouvelle question / modification) ---------- */

function htmlForm() {
  const f = qForm;
  return `
    <div class="card">
      <h2 style="font-family:var(--serif);font-size:1.15rem;margin-bottom:4px">${f.neuf ? 'Nouvelle question' : 'Modifier la question'}</h2>
      ${f.neuf ? '' : `<p class="adm-count" style="margin:0">${esc(f.id)}</p>`}
      <label class="lbl" for="f-question">Question</label>
      <textarea class="field" id="f-question" maxlength="300">${esc(f.question)}</textarea>
      <label class="lbl" for="f-categorie">Catégorie</label>
      <select class="field" id="f-categorie">
        ${categories.map(c => `<option value="${esc(c)}" ${c === f.categorie ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <label class="lbl">Niveau</label>
      <div class="pill-row" id="f-niveaux">
        ${[1, 2, 3].map(n => `<button type="button" class="pill ${f.niveau === n ? 'on' : ''}" data-niveau="${n}">${n} · ${NIVEAUX[n]}</button>`).join('')}
      </div>
      <label class="lbl">Les 4 réponses <span class="muted" style="font-weight:500">(coche la bonne)</span></label>
      ${[0, 1, 2, 3].map(i => `
      <div class="adm-opt-row">
        <input type="radio" name="f-bonne" value="${i}" id="f-bonne-${i}" ${f.bonne === i ? 'checked' : ''} aria-label="Bonne réponse : option ${i + 1}">
        <input class="field" type="text" id="f-opt-${i}" maxlength="120" placeholder="Réponse ${i + 1}" value="${esc(f.options[i])}">
      </div>`).join('')}
      <label class="lbl" for="f-reference">Référence biblique</label>
      <input class="field" type="text" id="f-reference" maxlength="60" placeholder="Genèse 6.14" value="${esc(f.reference)}">
      ${f.erreur ? `<p class="field-error">${esc(f.erreur)}</p>` : ''}
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-ghost" id="f-annuler" ${qBusy ? 'disabled' : ''}>Annuler</button>
        <button class="btn btn-grow" id="f-enregistrer" ${qBusy ? 'disabled' : ''}>Enregistrer</button>
      </div>
    </div>`;
}

function brancherForm() {
  document.getElementById('f-annuler').onclick = () => { qForm = null; render(); };
  document.getElementById('f-enregistrer').onclick = enregistrerForm;
  document.querySelectorAll('#f-niveaux .pill').forEach(p => {
    p.onclick = () => { lireForm(); qForm.niveau = Number(p.dataset.niveau); render(); };
  });
}

/* ---------- Les banques d'épreuve : listes ---------- */

/* Le mot juste, accordé : « 3 paroles actives », « 1 portrait actif »… */
function accordBanque(module, n, actif) {
  const c = EPREUVES[module];
  const s = n > 1 ? 's' : '';
  return `${n} ${c.nom}${s}` + (actif ? ` acti${c.fem ? 've' : 'f'}${s}` : '');
}

function ligneBanque(module, item) {
  const q = item.q;
  let txt, meta;
  if (module === 'quiadit') {
    txt = q.parole;
    meta = `${esc((q.options || [])[q.bonne] || '?')} · ${esc(q.reference)}`;
  } else if (module === 'ecritoupas') {
    txt = q.phrase;
    meta = `${q.ecrit ? 'écrite · ' + esc(q.reference || '?') : 'inventée'}`;
  } else {
    txt = q.reponse;
    meta = `${esc(q.genre)} · ${esc(q.reference)}`;
  }
  return `
  <div class="adm-q ${item.etat === 'desactivee' ? 'off' : ''}">
    <div class="adm-q-top">
      <span class="adm-q-txt">${esc(txt)}</span>
      <span class="adm-badge ${item.etat}">${ETATS[item.etat]}</span>
    </div>
    <div class="adm-q-meta">${meta}</div>
    <div class="adm-q-actions">
      ${item.etat !== 'desactivee' ? `<button class="linkbtn" data-act="editer" data-id="${esc(q.id)}">Modifier</button>` : ''}
      ${item.etat === 'fichier' || item.etat === 'modifiee' ? `<button class="linkbtn" data-act="desactiver" data-id="${esc(q.id)}">Désactiver</button>` : ''}
      ${item.etat === 'modifiee' ? `<button class="linkbtn" data-act="retablir" data-id="${esc(q.id)}">Rétablir la version du fichier</button>` : ''}
      ${item.etat === 'desactivee' ? `<button class="linkbtn" data-act="reactiver" data-id="${esc(q.id)}">Réactiver</button>` : ''}
      ${item.etat === 'ajoutee' ? `<button class="linkbtn danger" data-act="supprimer" data-id="${esc(q.id)}">Supprimer</button>` : ''}
    </div>
  </div>`;
}

/* Les pills de filtre du module — rien pour « Qui a dit ça ? » (pas de
   catégorie dans ses données), écrite/inventée pour « Écrit… ou pas ? »,
   le genre pour « De qui parle-t-on ? ». */
function htmlFiltresBanque(module) {
  let pills = '';
  if (module === 'ecritoupas') {
    const v = bFiltres.ecritoupas;
    pills = `
      <button class="pill ${v === null ? 'on' : ''}" data-filtre="">Toutes</button>
      <button class="pill ${v === true ? 'on' : ''}" data-filtre="1">Écrites</button>
      <button class="pill ${v === false ? 'on' : ''}" data-filtre="0">Inventées</button>`;
  } else if (module === 'portrait' && bGenres.length) {
    pills = [`<button class="pill ${bFiltres.portrait === null ? 'on' : ''}" data-filtre="">Tous</button>`]
      .concat(bGenres.map(g => `<button class="pill ${bFiltres.portrait === g ? 'on' : ''}" data-filtre="${esc(g)}">${esc(g.charAt(0).toUpperCase() + g.slice(1))}</button>`))
      .join('');
  }
  return pills ? `<div class="pill-row" id="b-filtres" style="margin-bottom:10px">${pills}</div>` : '';
}

function htmlBanque(module) {
  const c = EPREUVES[module];
  if (bListes[module] === null && !bErreurs[module]) {
    return `<div class="card center" style="padding:30px"><p class="muted" style="margin:0">Chargement de la banque…</p></div>`;
  }
  if (bListes[module] === null) {
    return `<div class="card"><p class="field-error" style="margin:0">${esc(bErreurs[module])}</p></div>`;
  }
  const liste = bListes[module];
  const actives = liste.filter(i => i.etat !== 'desactivee').length;
  const filtrees = bFiltrees(module);
  return `
    <div class="section-title">${esc(c.titre)}</div>
    <p class="adm-count">${accordBanque(module, actives, true)} · ${liste.length} en tout</p>
    ${bErreurs[module] ? `<p class="field-error" style="margin:0 4px 10px">${esc(bErreurs[module])}</p>` : ''}
    <button class="btn btn-grow btn-block" id="b-nouvelle" style="margin-bottom:12px" ${qBusy ? 'disabled' : ''}>${c.fem ? 'Nouvelle' : 'Nouveau'} ${esc(c.nom)}</button>
    <input class="field" type="search" id="b-recherche" placeholder="${esc(c.placeholder)}"
      autocomplete="off" value="${esc(bRecherches[module])}" style="margin-bottom:10px">
    ${htmlFiltresBanque(module)}
    <div class="adm-outils">
      <p class="adm-count" id="b-compte">${filtrees.length} affichée${filtrees.length > 1 ? 's' : ''}</p>
      ${htmlTri('b-tri', bTris[module])}
    </div>
    <div id="b-liste">${filtrees.map(i => ligneBanque(module, i)).join('') || `<p class="muted" style="margin:14px 4px">Aucune question ne correspond.</p>`}</div>`;
}

function brancherBanque(module) {
  const btnN = document.getElementById('b-nouvelle');
  if (btnN) btnN.onclick = () => { bForm = formBanqueVide(module); render(); };
  const rech = document.getElementById('b-recherche');
  if (rech) rech.oninput = () => { bRecherches[module] = rech.value; majListeBanque(module); };
  const tri = document.getElementById('b-tri');
  if (tri) tri.onchange = () => { bTris[module] = tri.value; majListeBanque(module); };
  document.querySelectorAll('#b-filtres .pill').forEach(p => {
    p.onclick = () => {
      const v = p.dataset.filtre;
      if (module === 'ecritoupas') bFiltres.ecritoupas = v === '' ? null : v === '1';
      else bFiltres.portrait = v || null;
      render();
    };
  });
  brancherListeBanque(module);
}

/* Re-rendu de la liste seule, pour que le champ de recherche garde le focus. */
function majListeBanque(module) {
  const zone = document.getElementById('b-liste');
  if (!zone) return;
  const filtrees = bFiltrees(module);
  const compte = document.getElementById('b-compte');
  if (compte) compte.textContent = `${filtrees.length} affichée${filtrees.length > 1 ? 's' : ''}`;
  zone.innerHTML = filtrees.map(i => ligneBanque(module, i)).join('') || `<p class="muted" style="margin:14px 4px">Aucune question ne correspond.</p>`;
  brancherListeBanque(module);
}

function brancherListeBanque(module) {
  document.querySelectorAll('#b-liste [data-act]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.id;
      if (b.dataset.act === 'editer') {
        const item = bListes[module].find(i => i.q.id === id);
        if (!item) return;
        const q = item.q;
        if (module === 'quiadit') {
          bForm = {
            module, neuf: false, id, parole: q.parole, options: q.options.slice(),
            bonne: q.bonne, reference: q.reference, contexte: q.contexte || '', erreur: null
          };
        } else if (module === 'ecritoupas') {
          bForm = {
            module, neuf: false, id, phrase: q.phrase, ecrit: !!q.ecrit,
            reference: q.reference || '', precision: q.precision || '', erreur: null
          };
        } else {
          bForm = {
            module, neuf: false, id, reponse: q.reponse, accepte: (q.accepte || []).join(', '),
            genre: q.genre || 'personnage', indices: (q.indices || []).slice(),
            reference: q.reference, erreur: null
          };
        }
        render();
      } else {
        actionBanque(module, b.dataset.act, id);
      }
    };
  });
}

/* ---------- Les banques d'épreuve : formulaires ---------- */

function htmlFormBanque() {
  const f = bForm;
  const c = EPREUVES[f.module];
  const titre = f.neuf ? `${c.fem ? 'Nouvelle' : 'Nouveau'} ${c.nom}` : `Modifier ${c.fem ? 'la' : 'le'} ${c.nom}`;
  let champs;
  if (f.module === 'quiadit') {
    champs = `
      <label class="lbl" for="b-f-parole">La parole</label>
      <textarea class="field" id="b-f-parole" maxlength="300">${esc(f.parole)}</textarea>
      <label class="lbl">Les 4 réponses <span class="muted" style="font-weight:500">(coche la bonne)</span></label>
      ${[0, 1, 2, 3].map(i => `
      <div class="adm-opt-row">
        <input type="radio" name="b-f-bonne" value="${i}" id="b-f-bonne-${i}" ${f.bonne === i ? 'checked' : ''} aria-label="Bonne réponse : option ${i + 1}">
        <input class="field" type="text" id="b-f-opt-${i}" maxlength="120" placeholder="Réponse ${i + 1}" value="${esc(f.options[i])}">
      </div>`).join('')}
      <label class="lbl" for="b-f-reference">Référence biblique</label>
      <input class="field" type="text" id="b-f-reference" maxlength="60" placeholder="Jean 14.6" value="${esc(f.reference)}">
      <label class="lbl" for="b-f-contexte">Contexte <span class="muted" style="font-weight:500">(facultatif — montré avec la réponse)</span></label>
      <input class="field" type="text" id="b-f-contexte" maxlength="200" placeholder="Réponse à Thomas, lors du dernier entretien…" value="${esc(f.contexte)}">`;
  } else if (f.module === 'ecritoupas') {
    champs = `
      <label class="lbl" for="b-f-phrase">La phrase</label>
      <textarea class="field" id="b-f-phrase" maxlength="300">${esc(f.phrase)}</textarea>
      <label class="lbl">Cette phrase est-elle dans la Bible ?</label>
      <div class="pill-row" id="b-f-ecrit">
        <button type="button" class="pill ${f.ecrit ? 'on' : ''}" data-ecrit="1">Oui, écrite</button>
        <button type="button" class="pill ${!f.ecrit ? 'on' : ''}" data-ecrit="0">Non, inventée</button>
      </div>
      <label class="lbl" for="b-f-reference">Référence biblique <span class="muted" style="font-weight:500">(si elle est écrite)</span></label>
      <input class="field" type="text" id="b-f-reference" maxlength="60" placeholder="Matthieu 6.34" value="${esc(f.reference)}">
      <label class="lbl" for="b-f-precision">Précision <span class="muted" style="font-weight:500">(facultatif — montrée avec la réponse)</span></label>
      <input class="field" type="text" id="b-f-precision" maxlength="300" placeholder="D'où vient la phrase, ce qui surprend…" value="${esc(f.precision)}">`;
  } else {
    champs = `
      <label class="lbl" for="b-f-reponse">La réponse</label>
      <input class="field" type="text" id="b-f-reponse" maxlength="60" placeholder="Moïse" value="${esc(f.reponse)}">
      <label class="lbl" for="b-f-accepte">Variantes acceptées <span class="muted" style="font-weight:500">(séparées par des virgules)</span></label>
      <input class="field" type="text" id="b-f-accepte" maxlength="200" placeholder="moise, moïse" value="${esc(f.accepte)}">
      <label class="lbl">Genre</label>
      <div class="pill-row" id="b-f-genres">
        ${(bGenres.length ? bGenres : ['personnage', 'lieu', 'chose']).map(g =>
          `<button type="button" class="pill ${f.genre === g ? 'on' : ''}" data-genre="${esc(g)}">${esc(g.charAt(0).toUpperCase() + g.slice(1))}</button>`).join('')}
      </div>
      <label class="lbl">Les 5 indices <span class="muted" style="font-weight:500">(révélés dans cet ordre : du plus difficile au plus facile)</span></label>
      ${[0, 1, 2, 3, 4].map(i => `
      <input class="field" type="text" id="b-f-ind-${i}" maxlength="300" style="margin-bottom:8px"
        placeholder="Indice ${i + 1}${i === 0 ? ' — le plus difficile' : i === 4 ? ' — le plus facile' : ''}" value="${esc(f.indices[i])}">`).join('')}
      <label class="lbl" for="b-f-reference">Référence biblique</label>
      <input class="field" type="text" id="b-f-reference" maxlength="60" placeholder="Exode 2–14" value="${esc(f.reference)}">`;
  }
  return `
    <div class="card">
      <h2 style="font-family:var(--serif);font-size:1.15rem;margin-bottom:4px">${esc(titre)} <span class="muted" style="font-weight:500">· ${esc(c.titre)}</span></h2>
      ${f.neuf ? '' : `<p class="adm-count" style="margin:0">${esc(f.id)}</p>`}
      ${champs}
      ${f.erreur ? `<p class="field-error">${esc(f.erreur)}</p>` : ''}
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-ghost" id="b-f-annuler" ${qBusy ? 'disabled' : ''}>Annuler</button>
        <button class="btn btn-grow" id="b-f-enregistrer" ${qBusy ? 'disabled' : ''}>Enregistrer</button>
      </div>
    </div>`;
}

function brancherFormBanque() {
  document.getElementById('b-f-annuler').onclick = () => { bForm = null; render(); };
  document.getElementById('b-f-enregistrer').onclick = enregistrerFormBanque;
  document.querySelectorAll('#b-f-ecrit .pill').forEach(p => {
    p.onclick = () => { lireFormBanque(); bForm.ecrit = p.dataset.ecrit === '1'; render(); };
  });
  document.querySelectorAll('#b-f-genres .pill').forEach(p => {
    p.onclick = () => { lireFormBanque(); bForm.genre = p.dataset.genre; render(); };
  });
}

/* ---------- Onglet Utilisateurs ---------- */

function htmlUsers() {
  if (uListe === null && !uErreur) {
    return `<div class="card center" style="padding:30px"><p class="muted" style="margin:0">Chargement des comptes…</p></div>`;
  }
  if (uListe === null) {
    return `<div class="card"><p class="field-error" style="margin:0">${esc(uErreur)}</p></div>`;
  }
  const lignes = uListe.map(u => `
    <tr>
      <td class="pseudo">${esc(u.pseudo)}</td>
      <td>${esc(u.email)}</td>
      <td><span class="friend-code inline">${esc(u.friendCode)}</span></td>
      <td>${esc(dateCourte(u.createdAt))}</td>
      <td>${esc(dateCourte(u.lastSeen))}</td>
      <td><button class="fr-x" data-suppr="${u.id}" data-pseudo="${esc(u.pseudo)}" data-email="${esc(u.email)}"
        title="Supprimer ce compte" aria-label="Supprimer le compte de ${esc(u.pseudo)}">${icon('croix', 13)}</button></td>
    </tr>`).join('');
  return `
    <div class="section-title">Comptes (${uListe.length})</div>
    ${uErreur ? `<p class="field-error" style="margin:0 4px 10px">${esc(uErreur)}</p>` : ''}
    <div class="card" style="padding:8px 10px">
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr><th>Pseudo</th><th>E-mail</th><th>Code ami</th><th>Inscrit le</th><th>Vu le</th><th></th></tr></thead>
          <tbody>${lignes || `<tr><td colspan="6" class="muted">Aucun compte pour l'instant.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}

function brancherUsers() {
  document.querySelectorAll('[data-suppr]').forEach(b => {
    b.onclick = () => supprimerCompte(Number(b.dataset.suppr), b.dataset.pseudo, b.dataset.email);
  });
}

/* ---------- Onglet Églises ---------- */

/* Une demande en attente : le nom voulu, qui la porte, depuis quand — et la
   décision. L'e-mail s'affiche (l'admin voit déjà les comptes) : c'est lui
   qui permet d'écrire au porteur si un doute demande d'être levé. L'adresse
   de l'église et l'éventuel e-mail de contact (si différent de celui du
   compte) aident à juger sur pièces. */
function carteDemande(d) {
  return `
  <div class="adm-q">
    <div class="adm-q-top">
      <span class="adm-q-txt">${esc(d.nom)}</span>
      <span class="adm-badge">en attente</span>
    </div>
    <div class="adm-q-meta">${esc(d.pseudo)} · ${esc(d.email)} · demandé le ${esc(dateCourte(d.createdAt))}</div>
    ${d.adresse ? `<div class="adm-q-meta">Adresse : ${esc(d.adresse)}</div>` : ''}
    ${d.emailContact ? `<div class="adm-q-meta">Contact : ${esc(d.emailContact)}</div>` : ''}
    <div class="eg-actions">
      <button class="btn btn-grow" data-eg="accepter" data-id="${d.id}" data-nom="${esc(d.nom)}"
        data-pseudo="${esc(d.pseudo)}" ${egBusy ? 'disabled' : ''}>Accepter</button>
      <button class="btn btn-ghost" data-eg="refuser" data-id="${d.id}" data-nom="${esc(d.nom)}"
        data-pseudo="${esc(d.pseudo)}" ${egBusy ? 'disabled' : ''}>Refuser</button>
    </div>
  </div>`;
}

function htmlEglises() {
  if (egData === null && !egErreur) {
    return `<div class="card center" style="padding:30px"><p class="muted" style="margin:0">Chargement des demandes…</p></div>`;
  }
  if (egData === null) {
    return `<div class="card"><p class="field-error" style="margin:0">${esc(egErreur)}</p></div>`;
  }
  const demandes = egData.demandes || [];
  const groupes = egData.groupes || [];
  const lignes = groupes.map(g => `
    <tr>
      <td><span class="friend-code inline">${esc(g.code)}</span></td>
      <td class="pseudo">${esc(g.nom)}</td>
      <td>${esc(g.responsable)}</td>
      <td style="text-align:right">${g.nbMembres}</td>
      <td>${esc(dateCourte(g.createdAt))}</td>
      <td><button class="linkbtn" data-egcontenu="${esc(g.code)}">Contenu</button></td>
    </tr>`).join('');
  return `
    <div class="section-title">Demandes en attente${demandes.length ? ` (${demandes.length})` : ''}</div>
    ${egErreur ? `<p class="field-error" style="margin:0 4px 10px">${esc(egErreur)}</p>` : ''}
    ${demandes.map(carteDemande).join('')
      || `<div class="card"><p class="muted" style="margin:0">Aucune demande en attente — quand quelqu'un demandera l'ouverture d'un groupe pour son église, elle apparaîtra ici.</p></div>`}
    <div class="section-title" style="margin-top:22px">Groupes existants (${groupes.length})</div>
    <div class="card" style="padding:8px 10px">
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr><th>Code</th><th>Nom</th><th>Responsable</th><th style="text-align:right">Membres</th><th>Créé le</th><th></th></tr></thead>
          <tbody>${lignes || `<tr><td colspan="6" class="muted">Aucun groupe pour l'instant.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    ${vueEgliseContenu()}`;
}

/* Ce qu'une église a publié — pour agir sur signalement, jamais pour relire
   avant publication. Chaque retrait est définitif et journalisé côté serveur. */
function vueEgliseContenu() {
  if (!egContenuCode) return '';
  if (egContenu === null) {
    return `<div class="card" style="margin-top:18px"><p class="muted" style="margin:0">Chargement du contenu…</p></div>`;
  }
  const bloc = (titre, type, liste, libelle, meta) => `
    <div class="section-title" style="margin-top:16px">${titre} (${liste.length})</div>
    <div class="card" style="padding:8px 10px">
      ${liste.length ? liste.map(x => `<div class="egl-annonce">
          <div class="ea-titre"><b>${esc(libelle(x))}</b></div>
          <div class="ea-meta muted">${esc(meta(x))} ·
            <button class="linkbtn danger" data-egretirer="${type}|${esc(String(x.id))}">Retirer</button></div>
        </div>`).join('') : `<p class="muted" style="margin:6px 2px">Rien.</p>`}
    </div>`;
  return `
    <div class="section-title" style="margin-top:24px">Contenu de ${esc(egContenu.groupe.nom)}
      <button class="linkbtn" data-egfermer="1" style="margin-left:8px">Fermer</button></div>
    ${egRetraitErreur ? `<p class="field-error" style="margin:0 4px 10px">${esc(egRetraitErreur)}</p>` : ''}
    ${bloc('Annonces', 'annonce', egContenu.annonces, x => x.titre, x => x.texte.slice(0, 90))}
    ${bloc('Séries', 'serie', egContenu.series, x => x.nom, x => x.module + ' · ' + ETATS_SERIE[x.etat] + ' — retirer emporte ses questions')}
    ${bloc('Questions de séries', 'item', egContenu.items, x => x.texte || '(sans texte)', x => x.module + ' · ' + (x.reference || 'sans référence'))}
    ${bloc('Questions du Défi', 'question', egContenu.questions, x => x.question, x => x.categorie + ' · ' + x.reference)}
    ${bloc('Propositions', 'proposition', egContenu.propositions, x => x.titre, x => x.genre)}`;
}

function brancherEglises() {
  document.querySelectorAll('[data-egcontenu]').forEach(b => {
    b.onclick = () => ouvrirContenuEglise(b.dataset.egcontenu);
  });
  const fermer = document.querySelector('[data-egfermer]');
  if (fermer) fermer.onclick = () => { egContenuCode = null; egContenu = null; egRetraitErreur = null; render(); };
  document.querySelectorAll('[data-egretirer]').forEach(b => {
    b.onclick = () => { const [t, id] = b.dataset.egretirer.split('|'); retirerContenu(t, id); };
  });
  document.querySelectorAll('[data-eg]').forEach(b => {
    b.onclick = () => trancherDemande(b.dataset.eg, Number(b.dataset.id), b.dataset.nom, b.dataset.pseudo);
  });
}

async function ouvrirContenuEglise(code) {
  egContenuCode = code; egContenu = null; egRetraitErreur = null;
  render();
  try { egContenu = await GraineAPI.adminGroupeContenu(code); }
  catch (e) { egContenu = null; egContenuCode = null; egErreur = messageDoux(e); }
  render();
}

async function retirerContenu(type, id) {
  if (!egContenuCode) return;
  if (!confirm('Retirer définitivement ce contenu ? Le geste est journalisé.')) return;
  egRetraitErreur = null;
  try {
    await GraineAPI.adminGroupeRetirer(egContenuCode, type, id);
    egContenu = await GraineAPI.adminGroupeContenu(egContenuCode);
  } catch (e) { egRetraitErreur = messageDoux(e); }
  render();
}

/* ---------- Démarrage ---------- */
(async function init() {
  renderChargement();
  // Vérification en direct auprès du serveur (la session locale peut mentir) ;
  // non connecté, non admin ou hors-ligne → même message sobre.
  let moi = null;
  if (window.GraineAPI && GraineAPI.isLoggedIn()) {
    try { moi = await GraineAPI.me(); } catch (e) { moi = null; }
  }
  if (!moi || !moi.isAdmin) { renderRefus(); return; }
  render();
  chargerQuestions();
})();
