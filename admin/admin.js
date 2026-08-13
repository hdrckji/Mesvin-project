/* ============================================================================
   Bible Horizon — écran d'administration (adresses listées dans ADMIN_EMAILS).

   - « Questions » : la banque du Défi telle que servie par /api/questions,
     comparée au fichier defi/data/questions.json pour montrer l'état de
     chaque question : fichier (intacte) / modifiée (surcharge en base) /
     ajoutée (id adm-) / désactivée (surcharge inactive). Éditer une question
     du fichier crée une surcharge ; la « supprimer » la désactive seulement
     (réversible) ; seuls les ajouts se suppriment pour de bon.
   - « Utilisateurs » : la liste des comptes, avec suppression totale.

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
let onglet = 'questions';   // 'questions' | 'users' | 'activite' | 'systeme'
let sys = null, sysErreur = null; // onglet Système : état du serveur
let actJournal = null, actJournalErreur = null; // onglet Activité : journal serveur
let actBrevo = null, actBrevoErreur = null;     // onglet Activité : côté Brevo
let categories = [];        // catégories du fichier (ordre d'affichage, et du select)
let qListe = null;          // [{ q, etat }] — null tant que rien n'est chargé
let qRecherche = '';
let qCategorie = null;      // null = toutes
let qForm = null;           // formulaire ouvert : { neuf, id, categorie, niveau, question, options, bonne, reference, erreur }
let qErreur = null;
let qBusy = false;
let uListe = null;          // comptes — null pendant le chargement
let uErreur = null;

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

function qFiltrees() {
  return qListe.filter(i => {
    if (qCategorie && i.q.categorie !== qCategorie) return false;
    if (qRecherche) {
      const t = normalise(i.q.question + ' ' + i.q.reference + ' ' + i.q.id);
      if (!t.includes(normalise(qRecherche))) return false;
    }
    return true;
  });
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
  render();
  // Les deux sections en parallèle, chacune avec son propre filet : un souci
  // d'un côté (Brevo, par exemple) ne prive pas de l'autre.
  await Promise.all([
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

function htmlJournalServeur() {
  if (actJournalErreur) return `<div class="card"><p class="field-error" style="margin:0">${esc(actJournalErreur)}</p></div>`;
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
  if (actBrevoErreur) return `<div class="card"><p class="field-error" style="margin:0">${esc(actBrevoErreur)}</p></div>`;
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

function htmlActivite() {
  const enCours = actJournal === null && !actJournalErreur;
  return `
    <button class="btn btn-soft btn-block" id="btn-act-actualiser" style="margin-bottom:14px" ${enCours ? 'disabled' : ''}>Actualiser</button>
    <div class="section-title">Journal du serveur</div>
    ${htmlJournalServeur()}
    <div class="section-title" style="margin-top:18px">Chez Brevo</div>
    ${htmlChezBrevo()}`;
}

function brancherActivite() {
  const b = document.getElementById('btn-act-actualiser');
  if (b) b.onclick = chargerActivite;
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

function htmlSysteme() {
  if (sysErreur) return `<div class="card"><p class="field-error" style="margin:0">${esc(sysErreur)}</p></div>`;
  if (!sys) return `<div class="card center" style="padding:30px"><p class="muted" style="margin:0">Chargement…</p></div>`;
  const p = sys.push || {};
  return `
    <div class="section-title">État du serveur</div>
    <div class="card">
      ${ligneSys('Base de données', sys.db || '?')}
      ${ligneSys("Envoi d'e-mails", sys.mail === 'dev' ? 'non configuré (mode dev)' : sys.mail, sys.mail !== 'dev')}
      ${ligneSys("Adresse d'expédition", sys.mailFrom || '—')}
      ${ligneSys('Dernier envoi', sys.lastMailError ? sys.lastMailError : 'aucun échec récent', !sys.lastMailError)}
    </div>
    ${htmlConfiguration()}

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
      <button class="pill ${onglet === 'activite' ? 'on' : ''}" id="tab-activite">Activité</button>
      <button class="pill ${onglet === 'systeme' ? 'on' : ''}" id="tab-systeme">Système</button>
    </div>`;

  el.innerHTML = `<div class="fade">${entete}${
    onglet === 'users' ? htmlUsers()
    : onglet === 'activite' ? htmlActivite()
    : onglet === 'systeme' ? htmlSysteme()
    : htmlQuestions()}</div>`;

  document.getElementById('btn-retour').onclick = () => { location.href = '../index.html'; };
  document.getElementById('tab-questions').onclick = () => { onglet = 'questions'; qForm = null; render(); };
  document.getElementById('tab-users').onclick = ouvrirUsers;
  document.getElementById('tab-activite').onclick = ouvrirActivite;
  document.getElementById('tab-systeme').onclick = ouvrirSysteme;
  if (onglet === 'users') brancherUsers();
  else if (onglet === 'activite') brancherActivite();
  else if (onglet === 'systeme') brancherSysteme();
  else brancherQuestions();
}

/* ---------- Onglet Questions ---------- */

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

function htmlQuestions() {
  if (qForm) return htmlForm();
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
    <div class="section-title">Banque de questions</div>
    <p class="adm-count">${actives} question${actives > 1 ? 's' : ''} active${actives > 1 ? 's' : ''} · ${qListe.length} en tout</p>
    ${qErreur ? `<p class="field-error" style="margin:0 4px 10px">${esc(qErreur)}</p>` : ''}
    <button class="btn btn-grow btn-block" id="btn-nouvelle" style="margin-bottom:12px" ${qBusy ? 'disabled' : ''}>Nouvelle question</button>
    <input class="field" type="search" id="q-recherche" placeholder="Chercher une question, une référence…"
      autocomplete="off" value="${esc(qRecherche)}" style="margin-bottom:10px">
    <div class="pill-row" id="q-cats" style="margin-bottom:10px">${pills}</div>
    <p class="adm-count" id="q-compte">${filtrees.length} affichée${filtrees.length > 1 ? 's' : ''}</p>
    <div id="q-liste">${filtrees.map(ligneQuestion).join('') || `<p class="muted" style="margin:14px 4px">Aucune question ne correspond.</p>`}</div>`;
}

function brancherQuestions() {
  if (qForm) { brancherForm(); return; }
  const btnN = document.getElementById('btn-nouvelle');
  if (btnN) btnN.onclick = () => {
    qForm = { neuf: true, id: null, categorie: categories[0] || '', niveau: 1, question: '', options: ['', '', '', ''], bonne: 0, reference: '', erreur: null };
    render();
  };
  const rech = document.getElementById('q-recherche');
  if (rech) rech.oninput = () => { qRecherche = rech.value; majListe(); };
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
