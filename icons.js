/* ============================================================================
   Bible Horizon — jeu d'icônes en traits, partagé entre les 4 modules.

   Remplace l'emoji quand il sert de REPÈRE STRUCTUREL (titre de section,
   bouton, badge de statut, stade de progression) : traits fins cohérents
   (viewBox 20x20, stroke-width 1.5, currentColor), rendu identique sur tout
   appareil contrairement aux emoji qui varient selon l'OS.

   Laissé en emoji nativement, volontairement :
   - les 17 pierres du chemin (pierres.js) — leur variété colorée est le point ;
   - les emoji de collections (data/collections.json) — même raison ;
   - l'emoji décoratif dans une phrase (célébrations, ton du texte).

   Chargé par les quatre pages AVANT leur propre script. Expose une seule
   fonction globale : icon(nom, taille?) → balise <svg> (taille par défaut 15). */
'use strict';

(function () {
  const PATHS = {
    // ---- déjà en place (écran Moi, hub, barre d'onglets) ----
    apparence: '<circle cx="10" cy="10" r="7.25"/><path d="M10 2.75a7.25 7.25 0 0 1 0 14.5Z" fill="currentColor" stroke="none"/>',
    memorisation: '<path d="M10 17V10"/><path d="M10 10C10 6.5 7 5 4 5c0 3.5 2.5 6 6 5Z"/><path d="M10 10c0-4 3-5.5 6-5.5 0 3.5-2.5 6-6 5.5Z"/>',
    assiduite: '<rect x="3" y="4.5" width="14" height="12.5" rx="2.2"/><path d="M3 8.5h14"/><path d="M6.5 2.5v3M13.5 2.5v3"/><path d="M7 12.2l1.8 1.8L13 10.2"/>',
    pierres: '<ellipse cx="10" cy="15.3" rx="6.5" ry="2"/><ellipse cx="10" cy="10.7" rx="4.6" ry="1.7"/><ellipse cx="10" cy="6.8" rx="2.8" ry="1.4"/>',
    lecture: '<path d="M10 5.2C8.3 3.9 6 3.4 3.2 3.8v11.2c2.8-.4 5.1.1 6.8 1.4 1.7-1.3 4-1.8 6.8-1.4V3.8c-2.8-.4-5.1.1-6.8 1.4Z"/><path d="M10 5.2v11.2"/>',
    defi: '<path d="M10 17c-3 0-5-2-5-4.6 0-2 1.2-3 1.9-4.6.4 1 1.1 1.6 1.7 1.6-.3-2.6.6-4.7 2.6-6.4-.4 2 .1 3.4 1.5 4.6 1.5 1.3 2.3 2.8 2.3 4.8 0 2.6-2 4.6-5 4.6Z"/>',
    accueil: '<path d="M3.2 9.5 10 4l6.8 5.5"/><path d="M5 8.5V16h10V8.5"/><path d="M8.3 16v-4h3.4v4"/>',
    moi: '<circle cx="10" cy="6.7" r="3"/><path d="M3.8 16.5c.7-3.6 3.4-5.5 6.2-5.5s5.5 1.9 6.2 5.5"/>',
    apropos: '<circle cx="10" cy="10" r="7.25"/><line x1="10" y1="9.2" x2="10" y2="14"/><circle cx="10" cy="6.1" r="1" fill="currentColor" stroke="none"/>',

    // ---- stades de progression d'un verset (stageOf(), voir app.js) ----
    // Une même famille de traits, de la graine posée à l'enracinement.
    grainePosee: '<ellipse cx="10" cy="12.5" rx="2.6" ry="3.4" transform="rotate(-18 10 12.5)"/><path d="M4 16h12"/>',
    germe: '<path d="M4 16h12"/><path d="M10 16v-3.2"/><path d="M10 12.8c0-2.1-1.7-3.1-3.4-2.9.1 1.8 1.4 3.1 3.4 2.9Z"/>',
    pousse: '<path d="M4 16h12"/><path d="M10 16V9.5"/><path d="M10 11.5c0-2.3-1.9-3.4-3.8-3.1.1 2 1.6 3.4 3.8 3.1Z"/><path d="M10 10.2c0-2.3 1.9-3.4 3.8-3.1-.1 2-1.6 3.4-3.8 3.1Z"/>',
    plante: '<path d="M6.3 12.2h7.4l-1 4.8H7.3z"/><path d="M10 12.2V6.5"/><path d="M10 8.3c0-2-1.6-3-3.3-2.8.1 1.9 1.4 3 3.3 2.8Z"/><path d="M10 7.1c0-2 1.6-3 3.3-2.8-.1 1.9-1.4 3-3.3 2.8Z"/>',
    arbre: '<path d="M10 17v-5.2"/><path d="M10 12.6c-3.3 0-5.8-2.4-5.8-5.7C6.6 7.5 8.3 9 10 9c-.7-1.6-.5-4 1-5.6 2.6 1.4 3.6 4 2.8 6.4 1.4-.4 2.3-1 3-1.9.3 3.6-2.9 6.7-6.8 6.7Z"/>',
    enracine: '<path d="M10 17v-4.4"/><path d="M10 12.6c-3.6 0-6.3-2.6-6.3-6.1 1 .8 2.6 1.3 3.9 1.1-.6-1.8-.2-4.3 1.5-6 2.7 1.6 3.7 4.3 2.8 6.8 1.5-.3 2.6-1 3.4-2 .5 3.9-2.7 6.2-5.3 6.2Z"/><path d="M8 17l-2-2.6M12 17l2-2.6"/>',

    // ---- écran Moi / socle : notifications, comptes, actions ----
    cloche: '<path d="M5.6 14.8c.3-1 .6-1.7.6-4.5 0-2.7 1.5-4.4 3.8-4.4s3.8 1.7 3.8 4.4c0 2.8.3 3.5.6 4.5H5.6Z"/><path d="M8.6 17c.3.6.8 1 1.4 1s1.1-.4 1.4-1"/>',
    cible: '<circle cx="10" cy="10" r="7.25"/><circle cx="10" cy="10" r="4.1"/><circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/>',
    oeil: '<path d="M2.5 10S5.5 4.7 10 4.7 17.5 10 17.5 10 14.5 15.3 10 15.3 2.5 10 2.5 10Z"/><circle cx="10" cy="10" r="2.3"/>',
    croix: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
    cadenas: '<rect x="4.5" y="9" width="11" height="7.5" rx="2"/><path d="M6.8 9V6.9a3.2 3.2 0 0 1 6.4 0V9"/>',
    nuage: '<path d="M6.4 15c-2.1 0-3.7-1.6-3.7-3.6 0-1.9 1.4-3.4 3.2-3.6a4.4 4.4 0 0 1 8.5-1.4 3.3 3.3 0 0 1-.4 8.6z"/>',
    medaille: '<path d="M7.3 10 4.8 3.8M12.7 10 15.2 3.8"/><circle cx="10" cy="13.2" r="4.2"/><path d="M10 11.1l.7 1.4 1.5.2-1.1 1.1.3 1.5-1.4-.7-1.4.7.3-1.5-1.1-1.1 1.5-.2z" fill="currentColor" stroke="none"/>',
    stylo: '<path d="M12.6 4.3 15.7 7.4 6.9 16.2 3.4 16.7l.5-3.5z"/><path d="M11 5.9 14.1 9"/>',
    enveloppe: '<rect x="3" y="5" width="14" height="10.2" rx="1.8"/><path d="M3.5 6.1 10 11.5l6.5-5.4"/>',
    amis: '<circle cx="6.6" cy="7.6" r="2.3"/><circle cx="13.6" cy="8.5" r="1.9"/><path d="M2.8 16c.4-2.9 2.1-4.4 3.9-4.4s3.4 1.3 3.9 3.7"/><path d="M11.2 12.2c1.5.2 2.6 1.4 3 3.2"/>',
    fleur: '<circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none"/><ellipse cx="10" cy="5.6" rx="1.8" ry="2.6"/><ellipse cx="10" cy="14.4" rx="1.8" ry="2.6"/><ellipse cx="5.6" cy="10" rx="2.6" ry="1.8"/><ellipse cx="14.4" cy="10" rx="2.6" ry="1.8"/>',

    // ---- module Défi ----
    seul: '<circle cx="10" cy="7" r="3.1"/><path d="M4 16.5c.7-3.9 3-5.9 6-5.9s5.3 2 6 5.9"/>',
    groupe: '<circle cx="6.8" cy="7.4" r="2.4"/><circle cx="13.8" cy="8.3" r="2"/><path d="M2.6 16c.5-3 2.2-4.6 4.3-4.6s3.7 1.4 4.2 3.8"/><path d="M11.4 12.1c1.6.2 2.8 1.5 3.2 3.4"/>',
    epees: '<path d="M4.5 4.5 15.5 15.5"/><path d="M15.5 4.5 4.5 15.5"/><path d="M6 6 4.3 4.3M14 6l1.7-1.7M6 14l-1.7 1.7M14 14l1.7 1.7"/>',
    ecranDirect: '<rect x="3" y="4.5" width="14" height="9.6" rx="1.6"/><path d="M7.4 17.2h5.2M10 14.1v3.1"/><circle cx="10" cy="9.3" r="1.5" fill="currentColor" stroke="none"/>',
    sablier: '<path d="M6 3.5h8M6 16.5h8"/><path d="M6.6 3.5c0 3.1 1.4 4.6 3.4 5.8-2 1.2-3.4 2.7-3.4 5.7M13.4 3.5c0 3.1-1.4 4.6-3.4 5.8 2 1.2 3.4 2.7 3.4 5.7"/>',
    coche: '<path d="M4.5 10.4 8 13.9l7.5-8"/>',
    reprendre: '<path d="M4.5 10h11"/><path d="M8.3 6.2 4.5 10l3.8 3.8"/>',
    rejoindre: '<path d="M4 4.5v11h4.5"/><path d="M8.5 10h7.5"/><path d="M13 6.5 16.5 10 13 13.5"/>',
    microphone: '<rect x="8" y="3" width="4" height="8.5" rx="2"/><path d="M5.3 9.5a4.7 4.7 0 0 0 9.4 0"/><path d="M10 14.2v2.8"/><path d="M7.5 17h5"/>',
    epi: '<path d="M10 17V6"/><path d="M10 6.3 7.6 4.3M10 6.3l2.4-2"/><path d="M10 9.3 7.6 7.5M10 9.3l2.4-1.8"/><path d="M10 12.3 7.6 10.5M10 12.3l2.4-1.8"/>',

    // ---- module Lire ----
    croixNt: '<path d="M10 3.5v13M6.2 8h7.6"/>',
    parchemin: '<rect x="5.5" y="5" width="9" height="10" rx="1"/><circle cx="5.5" cy="5" r="1.5"/><circle cx="14.5" cy="15" r="1.5"/>',
    bibliotheque: '<rect x="3.3" y="6" width="4.3" height="10" rx=".8"/><rect x="8.5" y="4.4" width="4.3" height="11.6" rx=".8"/><rect x="13.7" y="7" width="3.1" height="9" rx=".8"/>',

    // ---- espace admin ----
    outil: '<path d="M12.3 4.4a3.3 3.3 0 0 1 4.3 4.3l-6.9 6.9-4.7 1.2 1.2-4.7z"/><path d="M11 6.9l2.1 2.1"/>',

    // ---- thème, à propos ----
    soleil: '<circle cx="10" cy="10" r="3.4"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.3 5.3l1.4 1.4M13.3 13.3l1.4 1.4M5.3 14.7l1.4-1.4M13.3 6.7l1.4-1.4"/>',
    lune: '<path d="M15.8 12.9A6.6 6.6 0 1 1 7.1 4.2a5.3 5.3 0 0 0 8.7 8.7Z"/>',
    colombe: '<path d="M3 8.2c2.1 2.3 4.9 2.3 7 0 2.1 2.3 4.9 2.3 7 0"/><path d="M3 12.8c2.1 2.3 4.9 2.3 7 0 2.1 2.3 4.9 2.3 7 0"/>',
    eglise: '<path d="M10 3v3M8.5 4.5h3"/><path d="M4 17V9.5L10 5l6 4.5V17"/><path d="M8 17v-4h4v4"/>',
  };

  function icon(name, size) {
    const p = PATHS[name];
    if (!p) return '';
    size = size || 15;
    return `<svg class="ic-svg" viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }

  window.icon = icon;
})();
