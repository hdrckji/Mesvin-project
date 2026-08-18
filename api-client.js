/* ============================================================================
   Bible Horizon — client API partagé (comptes, synchro, amis, duels).
   Suit strictement API-CONTRAT.md. Chargé par l'appli principale et par le
   module Défi via <script src=".../api-client.js"> AVANT leur propre script.

   Expose un objet global `GraineAPI`. Le token de session vit dans
   localStorage sous « graine.session » : { token, user }.
   Hors-ligne ou sans compte : les appels échouent proprement avec
   ApiError.offline=true — l'appli locale continue de fonctionner.
   ========================================================================== */

'use strict';

(function () {
  const SESSION_KEY = 'graine.session';
  // L'API vit à la racine du site, même quand la page est dans /defi/ ou /lire/.
  const BASE = new URL('.', document.currentScript ? document.currentScript.src : location.href).href.replace(/\/$/, '');

  class ApiError extends Error {
    constructor(message, { status = 0, offline = false, data = null } = {}) {
      super(message);
      this.status = status;
      this.offline = offline;
      this.data = data;
    }
  }

  function getSession() {
    try { const r = localStorage.getItem(SESSION_KEY); if (r) return JSON.parse(r); } catch (e) {}
    return null;
  }
  function setSession(s) {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  }

  async function call(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const s = getSession();
    if (s && s.token) headers['Authorization'] = 'Bearer ' + s.token;
    let res;
    try {
      res = await fetch(BASE + path, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new ApiError('Pas de connexion — tes données restent sur cet appareil.', { offline: true });
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* réponse vide ou non-JSON */ }
    if (!res.ok) {
      // Session expirée : on nettoie pour que l'UI repasse en « non connecté ».
      if (res.status === 401 && s) setSession(null);
      throw new ApiError((data && data.error) || 'Une erreur est survenue.', { status: res.status, data });
    }
    return data;
  }

  const GraineAPI = {
    ApiError,
    /* ---- session ---- */
    session: getSession,
    user() { const s = getSession(); return s ? s.user : null; },
    isLoggedIn() { return !!getSession(); },

    /* ---- configuration publique (ex. client ID Google) ---- */
    async config() { return call('GET', '/api/config'); },

    /* ---- état du serveur (détaillé si la session est admin) ---- */
    async health() { return call('GET', '/api/health'); },

    /* ---- authentification ---- */
    async requestCode(email) { return call('POST', '/api/auth/request-code', { email }); },
    async googleSignIn(credential, pseudo) {
      const r = await call('POST', '/api/auth/google', pseudo ? { credential, pseudo } : { credential });
      setSession({ token: r.token, user: r.user });
      return r.user;
    },
    async verify(email, code, pseudo) {
      const r = await call('POST', '/api/auth/verify', pseudo ? { email, code, pseudo } : { email, code });
      setSession({ token: r.token, user: r.user });
      return r.user;
    },
    async me() {
      const r = await call('GET', '/api/me');
      const s = getSession(); if (s) { s.user = r.user; setSession(s); }
      return r.user;
    },
    async setPseudo(pseudo) {
      const r = await call('POST', '/api/me/pseudo', { pseudo });
      const s = getSession(); if (s) { s.user = r.user; setSession(s); }
      return r.user;
    },
    async logout() {
      try { await call('POST', '/api/auth/logout'); } catch (e) { /* même hors-ligne on se déconnecte localement */ }
      setSession(null);
    },
    async deleteAccount() { await call('DELETE', '/api/me'); setSession(null); },

    /* ---- synchronisation ---- */
    async syncGet() { return call('GET', '/api/sync'); },
    async syncPut(blobs) { return call('PUT', '/api/sync', blobs); },

    /* ---- amis ---- */
    async friends() { return (await call('GET', '/api/friends')).friends; },
    async addFriend(code) { return call('POST', '/api/friends/add', { code }); },
    async removeFriend(code) { return call('DELETE', '/api/friends/' + encodeURIComponent(code)); },

    /* ---- duels ---- */
    async createDuel(opponentCode) { return (await call('POST', '/api/duels', { opponentCode })).duel; },
    async duels() { return (await call('GET', '/api/duels')).duels; },
    async duel(id) { return (await call('GET', '/api/duels/' + id)).duel; },
    async duelResult(id, answers) { return (await call('POST', '/api/duels/' + id + '/result', { answers })).duel; },

    /* ---- groupes d'église (voir api/groupes.php et la section Groupes du contrat) ---- */
    async mesGroupes() { return (await call('GET', '/api/groupes')).groupes; },
    async groupeRejoindre(code) { return (await call('POST', '/api/groupes/rejoindre', { code })).groupe; },
    async groupeDetail(code) { return (await call('GET', '/api/groupes/' + encodeURIComponent(code))).groupe; },
    async groupeVerset(code, reference, texte) {
      return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/verset', { reference, texte })).groupe;
    },
    async groupeQuitter(code) { return call('DELETE', '/api/groupes/' + encodeURIComponent(code) + '/membres/moi'); },
    // Effacer le groupe et tout ce qui y pend — le responsable seul, sans retour.
    async groupeSupprimer(code) { return call('DELETE', '/api/groupes/' + encodeURIComponent(code)); },
    // Confier la responsabilité à un membre, désigné par son pseudo (la seule
    // identité que le groupe expose). L'appelant devient simple membre.
    async groupePassation(code, pseudo) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/passation', { pseudo })).groupe; },
    // Le nom de l'église, mis en forme — des MOTS-CLÉS d'une liste blanche
    // (style : classique|moderne|solennelle ; taille : discrete|posee|majestueuse).
    async groupeIdentite(code, style, taille) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/identite', { style, taille })).groupe; },
    // L'équipe qui nourrit avec le responsable — nommée et retirée par LUI seul.
    async groupeCorespAjouter(code, pseudo) { return call('POST', '/api/groupes/' + encodeURIComponent(code) + '/coresponsables', { pseudo }); },
    async groupeCorespRetirer(code, pseudo) { return call('DELETE', '/api/groupes/' + encodeURIComponent(code) + '/coresponsables/' + encodeURIComponent(pseudo)); },
    // La création d'un groupe passe par une DEMANDE validée par l'administrateur —
    // jamais de création directe depuis l'appli. L'adresse de l'église est
    // obligatoire ; l'e-mail de contact est facultatif (omis si vide).
    async groupeDemandeEnvoyer(nom, adresse, email) {
      const corps = { nom, adresse };
      if (email) corps.email = email;
      return (await call('POST', '/api/groupes/demande', corps)).demande;
    },
    async groupeDemande() { return (await call('GET', '/api/groupes/demande')).demande; },
    async groupeDemandeAnnuler() { return call('DELETE', '/api/groupes/demande'); },
    // La banque de quiz PAR GROUPE (api/groupes-quiz.php) : réglages lisibles
    // par les membres, écriture réservée au responsable (403 sinon).
    async groupeQuiz(code) { return (await call('GET', '/api/groupes/' + encodeURIComponent(code) + '/quiz')).quiz; },
    async groupeQuizMode(code, mode) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/quiz/mode', { mode })).quiz; },
    // REMPLACE la sélection entière d'ids de la banque commune.
    async groupeQuizSelection(code, ids) { return (await call('PUT', '/api/groupes/' + encodeURIComponent(code) + '/quiz/selection', { ids })).quiz; },
    // Les questions PROPRES du groupe (elles portent la bonne réponse) — responsable seul.
    async groupeQuizQuestions(code) { return (await call('GET', '/api/groupes/' + encodeURIComponent(code) + '/quiz/questions')).questions; },
    // Sans id = création (id egl- rendu), avec id = modification.
    async groupeQuizQuestionSave(code, q) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/quiz/questions', q)).question; },
    async groupeQuizQuestionDelete(code, id) { return call('DELETE', '/api/groupes/' + encodeURIComponent(code) + '/quiz/questions/' + encodeURIComponent(id)); },

    /* ---- ce que l'église propose (api/groupes-propositions.php) : packs de
       versets et chemins de lecture. Tout membre lit ; l'équipe écrit.
       ADOPTER est local : rien ne remonte jamais au serveur. */
    async groupePropositions(code) { return (await call('GET', '/api/groupes/' + encodeURIComponent(code) + '/propositions')).propositions; },
    async groupePropositionSave(code, corps) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/propositions', corps)).proposition; },
    async groupePropositionDelete(code, id) { return call('DELETE', '/api/groupes/' + encodeURIComponent(code) + '/propositions/' + encodeURIComponent(id)); },

    /* ---- la page de l'église (api/groupes-page.php) : annonces, rendez-vous,
       services. Lecture pour tout membre ; écriture réservée au responsable
       (403 sinon) — sauf lever/retirer la main, ouvert à tout membre. */
    async groupePage(code) { return call('GET', '/api/groupes/' + encodeURIComponent(code) + '/page'); },
    // Sans id = création, avec id = modification (même règle que les questions).
    async groupeAnnonceSave(code, corps) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/annonces', corps)).annonce; },
    async groupeAnnonceDelete(code, id) { return call('DELETE', '/api/groupes/' + encodeURIComponent(code) + '/annonces/' + encodeURIComponent(id)); },
    async groupeRdvSave(code, corps) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/rdv', corps)).rdv; },
    async groupeRdvDelete(code, id) { return call('DELETE', '/api/groupes/' + encodeURIComponent(code) + '/rdv/' + encodeURIComponent(id)); },
    async groupeServiceSave(code, corps) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/services', corps)).service; },
    async groupeServiceDelete(code, id) { return call('DELETE', '/api/groupes/' + encodeURIComponent(code) + '/services/' + encodeURIComponent(id)); },
    async groupeServiceLeverLaMain(code, id) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/services/' + encodeURIComponent(id) + '/inscription')).service; },
    async groupeServiceRetirer(code, id) { return (await call('DELETE', '/api/groupes/' + encodeURIComponent(code) + '/services/' + encodeURIComponent(id) + '/inscription')).service; },

    /* ---- banques d'église par épreuve (api/groupes-banques.php) ----
       quiadit | ecritoupas | portrait. TOUT est réservé au responsable,
       lecture comprise : les items portent la bonne réponse. */
    // La banque FUSIONNÉE de l'église — même format que /api/banque/{module} :
    // c'est elle que les pages d'épreuves chargent pour animer « dans mon église ».

    /* ---- séries de questions d'une église (épreuves) ----
       Lecture des séries publiées : tout membre. Écriture et brouillons :
       responsable et co-responsables (le serveur revérifie). */
    async groupeSeries(code, module) { return call('GET', '/api/groupes/' + encodeURIComponent(code) + '/series/' + encodeURIComponent(module)); },
    async groupeSerieCreer(code, module, nom) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/series/' + encodeURIComponent(module), { nom })).serie; },
    async groupeSerieMaj(code, module, id, corps) { return (await call('POST', '/api/groupes/' + encodeURIComponent(code) + '/series/' + encodeURIComponent(module) + '/' + encodeURIComponent(id), corps)).serie; },
    async groupeSerieSupprimer(code, module, id) { return call('DELETE', '/api/groupes/' + encodeURIComponent(code) + '/series/' + encodeURIComponent(module) + '/' + encodeURIComponent(id)); },
    // Renvoie { item, avertissement } : l'avertissement est informatif, l'item est enregistré.
    async groupeSerieItemSave(code, module, id, corps) { return call('POST', '/api/groupes/' + encodeURIComponent(code) + '/series/' + encodeURIComponent(module) + '/' + encodeURIComponent(id) + '/items', corps); },
    async groupeSerieItemDelete(code, module, id, itemId) { return call('DELETE', '/api/groupes/' + encodeURIComponent(code) + '/series/' + encodeURIComponent(module) + '/' + encodeURIComponent(id) + '/items/' + encodeURIComponent(itemId)); },
    // Les items d'une série — ce que chargent les pages d'épreuve pour jouer.
    async groupeSerieItems(code, module, id) { return call('GET', '/api/groupes/' + encodeURIComponent(code) + '/series/' + encodeURIComponent(module) + '/' + encodeURIComponent(id) + '/items'); },

    /* ---- questions du Défi (banque fusionnée, publique) ---- */
    async questions() { return call('GET', '/api/questions'); },

    /* ---- banques des épreuves (fusionnées, publiques) ----
       module ∈ 'quiadit' | 'ecritoupas' | 'portrait'. */
    async banque(module) { return call('GET', '/api/banque/' + encodeURIComponent(module)); },

    /* ---- notifications « le verset offert » (compte facultatif) ---- */
    // La clé publique VAPID, générée par le serveur au premier appel.
    async pushKey() { return call('GET', '/api/push/cle'); },
    // subscription : le PushSubscription.toJSON() du navigateur ;
    // heure : 0-23 ; tz : new Date().getTimezoneOffset() (minutes).
    async pushSubscribe(subscription, heure, tz) { return call('POST', '/api/push/subscribe', { subscription, heure, tz }); },
    async pushUnsubscribe(endpoint) { return call('POST', '/api/push/unsubscribe', { endpoint }); },

    /* ---- administration (adresses listées dans ADMIN_EMAILS) ---- */
    async adminUsers() { return (await call('GET', '/api/admin/users')).users; },
    async adminDeleteUser(id) { return call('DELETE', '/api/admin/users/' + id); },
    async adminSaveQuestion(q) { return (await call('POST', '/api/admin/questions', q)).question; },
    async adminDeleteQuestion(id) { return call('DELETE', '/api/admin/questions/' + encodeURIComponent(id)); },
    async adminRestoreQuestion(id) { return call('POST', '/api/admin/questions/' + encodeURIComponent(id) + '/restore'); },
    // Banques des épreuves : sans id = ajout (id adm- rendu), avec id = surcharge ;
    // « supprimer » une question du fichier la désactive seulement (réversible).
    async adminBanqueSave(module, item) { return call('POST', '/api/admin/banque/' + encodeURIComponent(module), item); },
    async adminBanqueDelete(module, id) { return call('DELETE', '/api/admin/banque/' + encodeURIComponent(module) + '/' + encodeURIComponent(id)); },
    async adminBanqueRestore(module, id) { return call('POST', '/api/admin/banque/' + encodeURIComponent(module) + '/' + encodeURIComponent(id) + '/restore'); },
    // Onglet « Activité » : le journal serveur, et les événements vus par Brevo.
    async adminJournal() { return call('GET', '/api/admin/journal'); },
    async adminBrevo() { return call('GET', '/api/admin/brevo'); },
    async adminVisites() { return call('GET', '/api/admin/visites'); },
    // Onglet « Églises » : les demandes de groupe en attente et les groupes
    // existants ; accepter fait naître le groupe (le demandeur devient
    // responsable), refuser laisse le porteur redemander plus tard.
    async adminEglises() { return call('GET', '/api/admin/eglises'); },
    // Voir et retirer ce qu'une église a publié — sur signalement, jamais a priori.
    async adminGroupes() { return (await call('GET', '/api/admin/groupes')).groupes; },
    async adminGroupeContenu(code) { return call('GET', '/api/admin/groupes/' + encodeURIComponent(code)); },
    async adminGroupeRetirer(code, type, id) { return call('DELETE', '/api/admin/groupes/' + encodeURIComponent(code) + '/contenu/' + encodeURIComponent(type) + '/' + encodeURIComponent(id)); },
    async adminEgliseAccepter(id) { return call('POST', '/api/admin/eglises/demandes/' + id + '/accepter'); },
    async adminEgliseRefuser(id) { return call('POST', '/api/admin/eglises/demandes/' + id + '/refuser'); },

    /* ---- veillées en direct ---- */
    async createVeillee(opts) { return (await call('POST', '/api/veillees', opts || {})).veillee; },
    async veilleeState(code, playerKey) {
      const qs = playerKey ? '?player=' + encodeURIComponent(playerKey) : '';
      return (await call('GET', '/api/veillees/' + encodeURIComponent(code) + '/state' + qs)).veillee;
    },
    async joinVeillee(code, prenom) { return call('POST', '/api/veillees/' + encodeURIComponent(code) + '/join', { prenom }); },
    async veilleeAnswer(code, playerKey, q, answer) {
      return call('POST', '/api/veillees/' + encodeURIComponent(code) + '/answer', { playerKey, q, answer });
    },
    async veilleeAdvance(code, action) { return (await call('POST', '/api/veillees/' + encodeURIComponent(code) + '/advance', { action })).veillee; }
  };

  window.GraineAPI = GraineAPI;
})();
