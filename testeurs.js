/* ============================================================================
   Bible Horizon — l'appel aux testeurs Android.

   Google exige 12 testeurs inscrits pendant 14 jours avant d'ouvrir le
   Play Store à tous. Les mieux placés pour rendre ce service sont ceux qui
   utilisent déjà biblehorizon.fr : ce fichier leur montre, sur Android
   seulement, une petite carte « deviens testeur » avec le lien d'inscription.

   Trois partis pris, dans l'esprit de l'appli :
   - ON PROPOSE, ON NE HARCÈLE PAS. La carte apparaît après quelques secondes,
     se ferme d'une croix, et ne revient jamais une fois fermée ou suivie.
   - INVISIBLE HORS SUJET. Rien sur iPhone ni sur ordinateur ; rien non plus
     dans l'application du Play Store elle-même (référent android-app://),
     où la mission est déjà accomplie.
   - AUTONOME. Aucun autre fichier à toucher : styles injectés ici, une seule
     clé de stockage. Le jour où le Play Store est ouvert à tous, on retire
     la balise <script> et tout disparaît.

   La période de test terminée, LIEN_OPTIN peut pointer vers la fiche
   publique du Play Store — ou le script être simplement retiré.
   ========================================================================== */
'use strict';

(function () {
  /* Le lien d'inscription au test fermé — l'URL standard découle du nom de
     paquet. Vider la constante suspend la carte sans retirer le script. */
  const LIEN_OPTIN = 'https://play.google.com/apps/testing/fr.biblehorizon.app';
  const CLE = 'graine.testeurs'; // 'non' = fermé, 'oui' = a cliqué, 'twa' = déjà sur Play

  if (!LIEN_OPTIN) return;
  if (!/Android/i.test(navigator.userAgent)) return;

  // Ouvert depuis l'application du Play Store : mission accomplie, silence.
  // La coquille WebView se signale dans l'agent utilisateur ; l'ancienne
  // coquille TWA, par son référent android-app://.
  if (/BibleHorizonApp/.test(navigator.userAgent)) return;
  try {
    if (document.referrer.indexOf('android-app://') === 0) {
      localStorage.setItem(CLE, 'twa');
    }
    if (localStorage.getItem(CLE)) return;
  } catch (e) { return; /* stockage indisponible : on ne saura pas se taire, donc on se tait */ }

  function montrer() {
    const style = document.createElement('style');
    style.textContent =
      '.bh-testeurs{position:fixed;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));' +
      'z-index:60;background:var(--surface,#fffdf8);color:var(--ink,#233047);border:1px solid var(--line,#e2d9c6);' +
      'border-radius:var(--radius,14px);box-shadow:var(--shadow,0 10px 30px rgba(27,42,74,.18));' +
      'padding:14px 40px 14px 16px;font-family:var(--sans,system-ui,sans-serif);font-size:.92rem;line-height:1.45;' +
      'animation:bh-testeurs-entre .35s ease}' +
      '@keyframes bh-testeurs-entre{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}' +
      '.bh-testeurs strong{display:block;margin-bottom:2px}' +
      '.bh-testeurs a{display:inline-block;margin-top:8px;padding:8px 14px;border-radius:999px;' +
      'background:var(--accent,#b98a2e);color:var(--on-accent,#fff);text-decoration:none;font-weight:600}' +
      '.bh-testeurs button{position:absolute;top:6px;right:6px;width:30px;height:30px;border:0;background:none;' +
      'color:inherit;opacity:.55;font-size:18px;line-height:1;cursor:pointer;padding:0}';
    document.head.appendChild(style);

    const carte = document.createElement('div');
    carte.className = 'bh-testeurs';
    carte.setAttribute('role', 'complementary');
    carte.innerHTML =
      '<strong>Bible Horizon arrive sur le Play Store 🌅</strong>' +
      'Aide-nous à ouvrir la porte : deviens l’un de nos premiers testeurs Android — ' +
      'deux minutes, et il suffit de garder l’appli installée.' +
      '<br><a href="' + LIEN_OPTIN + '" target="_blank" rel="noopener">Devenir testeur</a>' +
      '<button type="button" aria-label="Fermer">×</button>';

    carte.querySelector('button').addEventListener('click', function () {
      try { localStorage.setItem(CLE, 'non'); } catch (e) { /* tant pis, à la prochaine visite */ }
      carte.remove();
    });
    carte.querySelector('a').addEventListener('click', function () {
      try { localStorage.setItem(CLE, 'oui'); } catch (e) { /* idem */ }
      carte.remove();
    });

    document.body.appendChild(carte);
  }

  // Après quelques secondes : le temps d'arriver pour ce qu'on venait faire.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(montrer, 4000); });
  } else {
    setTimeout(montrer, 4000);
  }
})();
