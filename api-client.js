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

    /* ---- questions du Défi (banque fusionnée, publique) ---- */
    async questions() { return call('GET', '/api/questions'); },

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
    // Onglet « Activité » : le journal serveur, et les événements vus par Brevo.
    async adminJournal() { return call('GET', '/api/admin/journal'); },
    async adminBrevo() { return call('GET', '/api/admin/brevo'); },

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
