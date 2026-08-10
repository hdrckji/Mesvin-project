/* ============================================================================
   Bible Horizon — « Les pierres du chemin » : badges-souvenirs partagés.

   « Que signifient ces pierres ? » — Josué 4.21. Comme Israël au bord du
   Jourdain, on pose une pierre pour se souvenir du chemin parcouru. Chaque
   pierre marque un pas réel (premier verset planté, premier chapitre lu…),
   se célèbre sobrement une seule fois, et ne se retire JAMAIS.

   Chargé par les trois pages (accueil, Lire, Défi) AVANT leur propre script.
   Expose window.GrainePierres = { verifier, lues, definitions, drapeau } :
   - verifier()  : lit défensivement les stores des modules, pose les pierres
                   nouvellement méritées et affiche leur célébration.
   - lues()      : les pierres posées, avec leur date, pour l'écran Moi.
   - drapeau(n)  : pose un drapeau d'événement ('ami', 'quizAnime') que les
                   compteurs seuls ne savent pas dire.

   Stockage :
   - 'graine.pierres.v1'   : { pierreId: dayNumber } — même convention de jour
                             que todayNum() d'app.js (minuit local / 86400000).
   - 'graine.pierres.flags': { ami: true, quizAnime: true } — drapeaux posés
                             par app.js (premier ami) et defi.js (quiz animé).
   Les pierres voyagent aussi dans la synchronisation (blob memo, champ
   `pierres`) : voir mergeMemo() dans app.js — union, date la plus ancienne.
   ========================================================================== */

'use strict';

(function () {
  const PIERRES_KEY = 'graine.pierres.v1';
  const FLAGS_KEY = 'graine.pierres.flags';

  /* Même convention que todayNum() d'app.js : numéro du jour courant. */
  function jourNum() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return Math.round(d.getTime() / 86400000);
  }
  /* Date lisible d'un numéro de jour (midi UTC : stable quel que soit le fuseau). */
  function dateDe(jour) {
    try {
      return new Date(jour * 86400000 + 43200000)
        .toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) { return ''; }
  }

  function lireJSON(key) {
    try {
      const r = localStorage.getItem(key);
      if (r) { const v = JSON.parse(r); if (v && typeof v === 'object' && !Array.isArray(v)) return v; }
    } catch (e) {}
    return {};
  }
  function ecrireJSON(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {} }

  /* ---------- Les 17 pierres (liste validée — ne pas retoucher à la légère).
     Chaque phrase-souvenir est au passé : elle répond à « que signifie
     cette pierre ? » quand on la retrouve plus tard dans l'écran Moi. ------ */
  const DEFINITIONS = [
    /* ---- Semer ---- */
    { id: 'premiere-graine', emoji: '🌰', nom: 'Première graine',
      phrase: 'Ton premier verset a pris racine dans ton cœur.' },
    { id: 'petit-verger', emoji: '🌳', nom: 'Petit verger',
      phrase: 'Dix versets plantés : ton jardin est devenu un petit verger.' },
    { id: 'racines-profondes', emoji: '🌲', nom: 'Racines profondes',
      phrase: 'Un verset s’est enraciné en toi, pour de bon.' },
    { id: 'gerbe-liee', emoji: '🌾', nom: 'Gerbe liée',
      phrase: 'Tu as achevé ta première collection — les épis, liés en une gerbe.' },
    /* ---- Marcher ---- */
    { id: 'premier-pas', emoji: '👣', nom: 'Le premier pas',
      phrase: 'Tu as lu ton premier chapitre : le chemin s’est ouvert.' },
    { id: 'livre-au-bout', emoji: '📕', nom: 'Un livre au bout',
      phrase: 'Tu as marché dans un livre entier, du premier au dernier chapitre.' },
    { id: 'cent-bornes', emoji: '🛤️', nom: 'Cent bornes',
      phrase: 'Cent chapitres lus, un pas après l’autre.' },
    { id: 'grand-voyage', emoji: '🗺️', nom: 'Le grand voyage',
      phrase: 'Les 66 livres, de la Genèse à l’Apocalypse : tu as traversé toute la Bible.' },
    /* ---- Sonder ---- */
    { id: 'premier-feu', emoji: '🕯️', nom: 'Premier feu',
      phrase: 'Tu as relevé ton premier défi — une première flamme s’est allumée.' },
    { id: 'sans-faute', emoji: '✨', nom: 'Sans faute',
      phrase: 'Un défi du jour relevé sans une seule erreur.' },
    { id: 'tu-sondes', emoji: '🔍', nom: 'Tu sondes les Écritures',
      phrase: 'Trente défis relevés. « Vous sondez les Écritures. » — Jean 5.39' },
    { id: 'assemblee-reunie', emoji: '⛪', nom: 'Assemblée réunie',
      phrase: 'Tu as animé un quiz pour ton église, du début jusqu’au bout.' },
    { id: 'compagnon-armes', emoji: '⚔️', nom: 'Compagnon d’armes',
      phrase: 'Ton premier duel s’est joué — deux amis penchés sur une même Parole.' },
    /* ---- Ensemble & durée ---- */
    { id: 'deux-valent-mieux', emoji: '🤝', nom: 'Deux valent mieux qu’un',
      phrase: 'Ton premier ami t’a rejoint sur le chemin. « Deux valent mieux qu’un. » — Ecclésiaste 4.9' },
    { id: 'semaine-de-manne', emoji: '🍞', nom: 'Semaine de manne',
      phrase: 'Sept jours d’affilée, tu as recueilli ta part — comme la manne, chaque matin. (Exode 16)' },
    { id: 'fidele-en-peu', emoji: '🕊️', nom: 'Fidèle en peu de chose',
      phrase: 'Trente jours de présence, semés au fil du temps. « Tu as été fidèle en peu de chose. » — Matthieu 25.21' },
    { id: 'cent-matins', emoji: '🌄', nom: 'Cent matins',
      phrase: 'Cent jours passés avec la Parole — et l’horizon s’ouvre encore.' }
  ];

  /* ---------- Lecture DÉFENSIVE des stores des modules ----------
     Leur forme peut évoluer : try/catch partout, valeurs sûres par défaut —
     au pire une pierre attend le prochain passage, rien ne casse jamais. */

  /* graine.v3 (Semer) : versets plantés, enracinement, collections, série, jours. */
  function statsMemo() {
    const out = { plantes: 0, enracine: false, collections: 0, bestStreak: 0, activeDays: 0 };
    try {
      const raw = localStorage.getItem('graine.v3');
      if (!raw) return out;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return out;
      const cards = s.cards && typeof s.cards === 'object' ? s.cards : {};
      for (const c of Object.values(cards)) {
        if (!c || typeof c !== 'object') continue;
        if (typeof c.validations === 'number' && c.validations >= 3) out.plantes++; // MASTERY d'app.js
        if (typeof c.interval === 'number' && c.interval > 119) out.enracine = true; // stade « Enraciné »
      }
      if (Array.isArray(s.completedCollections)) out.collections = s.completedCollections.length;
      if (typeof s.bestStreak === 'number') out.bestStreak = s.bestStreak;
      if (typeof s.activeDays === 'number') out.activeDays = s.activeDays; // jours CUMULÉS, pas consécutifs
    } catch (e) {}
    return out;
  }

  /* graine.lire.v1 (Marcher) : même comptage que lireStats() d'app.js —
     chapitres = cases `read` cochées, livre terminé = tableau entièrement lu.
     On lit les deux formats : v2 (s.books, ce que lire.js écrit aujourd'hui)
     et l'ancien v1 (s.plans objet), pour ne perdre aucun souvenir. */
  function statsLire() {
    const out = { chapitres: 0, livres: 0 };
    try {
      const raw = localStorage.getItem('graine.lire.v1');
      if (!raw) return out;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return out;
      let parLivre = null;
      if (s.books && typeof s.books === 'object' && !Array.isArray(s.books)) parLivre = s.books;
      else if (s.plans && typeof s.plans === 'object' && !Array.isArray(s.plans)) parLivre = s.plans;
      if (!parLivre) return out;
      for (const b of Object.values(parLivre)) {
        if (!b || !Array.isArray(b.read)) continue;
        const n = b.read.filter(Boolean).length;
        out.chapitres += n;
        if (b.read.length > 0 && n === b.read.length) out.livres++;
      }
    } catch (e) {}
    return out;
  }

  /* graine.defi.v1 (Sonder) : défis solo, défi du jour parfait, duels relevés. */
  function statsDefi() {
    const out = { defis: 0, sansFaute: false, duels: 0 };
    try {
      const raw = localStorage.getItem('graine.defi.v1');
      if (!raw) return out;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return out;
      if (typeof s.defis === 'number') out.defis = s.defis;
      // Évalué au moment où c'est vrai (le dernier défi du jour) — pas rétroactif, c'est accepté.
      if (s.jour && typeof s.jour === 'object' && s.jour.score === 10 && s.jour.total === 10) out.sansFaute = true;
      if (s.duelsAmis && typeof s.duelsAmis === 'object' && typeof s.duelsAmis.relevees === 'number') out.duels = s.duelsAmis.relevees;
    } catch (e) {}
    return out;
  }

  /* Les 17 conditions, évaluées d'un coup. */
  function etatConditions() {
    const memo = statsMemo(), lire = statsLire(), defi = statsDefi(), f = lireJSON(FLAGS_KEY);
    return {
      'premiere-graine': memo.plantes >= 1,
      'petit-verger': memo.plantes >= 10,
      'racines-profondes': memo.enracine,
      'gerbe-liee': memo.collections >= 1,
      'premier-pas': lire.chapitres >= 1,
      'livre-au-bout': lire.livres >= 1,
      'cent-bornes': lire.chapitres >= 100,
      'grand-voyage': lire.livres >= 66,
      'premier-feu': defi.defis >= 1,
      'sans-faute': defi.sansFaute,
      'tu-sondes': defi.defis >= 30,
      'assemblee-reunie': f.quizAnime === true,
      'compagnon-armes': defi.duels >= 1,
      'deux-valent-mieux': f.ami === true,
      'semaine-de-manne': memo.bestStreak >= 7,
      'fidele-en-peu': memo.activeDays >= 30,
      'cent-matins': memo.activeDays >= 100
    };
  }

  /* ---------- Célébration : bannière sobre, une seule à la fois ---------- */
  let file = [];            // pierres en attente de célébration
  let toastEnCours = false; // une bannière est affichée

  function celebrer(def) { file.push(def); prochaine(); }
  function prochaine() {
    if (toastEnCours || !file.length || !document.body) return;
    toastEnCours = true;
    const def = file.shift();

    const toast = document.createElement('div');
    toast.className = 'pierre-toast';
    toast.setAttribute('role', 'status');
    const kicker = document.createElement('div');
    kicker.className = 'pt-kicker';
    kicker.textContent = '🪨 Une pierre se pose sur ton chemin';
    const body = document.createElement('div');
    body.className = 'pt-body';
    const emoji = document.createElement('span');
    emoji.className = 'pt-emoji';
    emoji.textContent = def.emoji;
    const txt = document.createElement('div');
    txt.className = 'pt-txt';
    const nom = document.createElement('div');
    nom.className = 'pt-nom';
    nom.textContent = def.nom;
    const phrase = document.createElement('div');
    phrase.className = 'pt-phrase';
    phrase.textContent = def.phrase;
    txt.appendChild(nom); txt.appendChild(phrase);
    body.appendChild(emoji); body.appendChild(txt);
    toast.appendChild(kicker); toast.appendChild(body);
    document.body.appendChild(toast);

    // Disparition douce après ~6 s, ou au toucher — puis la suivante, s'il y en a.
    let fermee = false;
    const fermer = () => {
      if (fermee) return;
      fermee = true;
      toast.classList.add('hide');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        toastEnCours = false;
        prochaine();
      }, 450);
    };
    toast.addEventListener('click', fermer);
    setTimeout(fermer, 6000);
  }

  /* ---------- API ---------- */

  /* Évalue tout, pose les pierres nouvellement méritées (avec leur jour),
     célèbre chacune. Une pierre déjà posée ne bouge jamais. */
  function verifier() {
    const posees = lireJSON(PIERRES_KEY);
    const ok = etatConditions();
    const nouvelles = [];
    for (const def of DEFINITIONS) {
      if (ok[def.id] && typeof posees[def.id] !== 'number') {
        posees[def.id] = jourNum();
        nouvelles.push(def);
      }
    }
    if (nouvelles.length) {
      ecrireJSON(PIERRES_KEY, posees);
      nouvelles.forEach(celebrer);
    }
    return nouvelles.map(d => d.id);
  }

  /* Les pierres posées, prêtes à afficher (ordre : la plus ancienne d'abord). */
  function lues() {
    const posees = lireJSON(PIERRES_KEY);
    const out = [];
    for (const def of DEFINITIONS) {
      const jour = posees[def.id];
      if (typeof jour !== 'number') continue;
      out.push({ id: def.id, emoji: def.emoji, nom: def.nom, phrase: def.phrase, jour, date: dateDe(jour) });
    }
    out.sort((a, b) => a.jour - b.jour);
    return out;
  }

  /* Pose un drapeau d'événement ('ami', 'quizAnime') — sans re-vérifier :
     l'appelant enchaîne avec verifier() quand il est prêt. */
  function drapeau(nomDrapeau) {
    const f = lireJSON(FLAGS_KEY);
    if (f[nomDrapeau] === true) return;
    f[nomDrapeau] = true;
    ecrireJSON(FLAGS_KEY, f);
  }

  window.GrainePierres = { verifier, lues, definitions: DEFINITIONS, drapeau };
})();
