/* Fréquentation — le signal, et rien d'autre.

   Une ouverture de page = un POST /api/visite avec le nom de la page.
   AUCUN identifiant, aucun cookie, aucune donnée d'appareil : le serveur
   n'apprend que « une ouverture de plus sur cette page aujourd'hui ».

   sendBeacon quand il existe : il part même si l'on referme aussitôt, et
   n'attend rien en retour. Hors-ligne, le signal se perd — c'est voulu :
   le rattraper plus tard obligerait à garder un historique sur l'appareil.
   Chargé par chaque page de l'appli, APRÈS le reste (defer) : s'il échoue,
   rien d'autre n'en dépend. */
(function () {
  'use strict';
  var seg = location.pathname.split('/').filter(Boolean)[0] || 'accueil';
  if (seg === 'memoriser-versets') seg = 'memoriser';
  var corps = JSON.stringify({ page: seg });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/visite', new Blob([corps], { type: 'application/json' }));
    } else {
      fetch('/api/visite', { method: 'POST', body: corps, keepalive: true }).catch(function () {});
    }
  } catch (e) { /* jamais au détriment de la page */ }
})();
