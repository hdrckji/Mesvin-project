/* ============================================================================
   Bible Horizon — le moteur de recherche dans le texte biblique.

   TOUT SE PASSE SUR L'APPAREIL. Les 66 livres de la Segond 1910 sont déjà
   téléchargés et pré-cachés (voir sw.js) : chercher ne fait AUCUNE requête,
   ne parle à AUCUN serveur, et fonctionne donc hors ligne, dans le métro
   comme au camp. Ce que quelqu'un cherche dans sa Bible ne regarde personne
   — pas même nous.

   Ce fichier ne contient que des fonctions PURES : pas de DOM, pas de fetch,
   pas de localStorage. C'est délibéré — le rendu (et donc l'échappement)
   reste dans lire.js, et ce moteur se relit tout seul depuis Node
   (lire/tests/recherche-test.mjs).

   ---- Ce dont on se protège, et comment -------------------------------------
   1. INJECTION HTML : le moteur ne produit JAMAIS de balise. Il rend du
      TEXTE BRUT découpé (avant / trouvé / après) ; c'est la vue qui échappe
      chaque morceau avant d'entourer le milieu d'un <mark>. Impossible de
      faire passer du balisage par la requête.
   2. EXPRESSIONS RÉGULIÈRES : aucune regex n'est construite à partir de ce
      que tape l'utilisateur. Tout passe par indexOf. Un « (a+)+$ » collé
      dans le champ ne peut pas figer l'onglet (déni de service par
      catastrophic backtracking).
   3. GEL DE L'INTERFACE : la requête est bornée (REQUETE_MIN / REQUETE_MAX)
      et les résultats plafonnés (MAX_RESULTATS). Une recherche sur « e »
      s'arrête net au lieu de fabriquer 30 000 lignes.
   4. CHEMINS DE FICHIERS : le moteur ne charge rien. Les identifiants de
      livres viennent du catalogue de l'appelant et n'y sont jamais
      concaténés ici — pas de surface de traversée de chemin.
   ========================================================================== */

(function (racine) {
  'use strict';

  const REQUETE_MIN = 2;      // en dessous, tout matche : on ne cherche pas
  const REQUETE_MAX = 80;     // au delà, c'est une phrase entière — inutile
  const MAX_RESULTATS = 300;  // au delà, on le DIT plutôt que de figer l'écran
  const EXTRAIT_AVANT = 60;   // caractères de contexte autour du passage trouvé
  const EXTRAIT_APRES = 90;

  /**
   * « Plier » un texte pour la comparaison : minuscules, sans accents,
   * apostrophes uniformisées. « Éternel » et « eternel » se retrouvent,
   * « qu'il » et « qu’il » aussi.
   *
   * INVARIANT CRUCIAL : la chaîne rendue fait EXACTEMENT la même longueur que
   * l'originale, caractère pour caractère. C'est ce qui permet de chercher
   * dans la version pliée et de découper dans la version d'origine avec les
   * mêmes index — sans quoi les extraits seraient décalés.
   */
  function plier(texte) {
    const s = String(texte);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\u2019' || c === '\u02BC') { out += "'"; continue; }  // ’ et ʼ → '
      const f = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      // f peut valoir '' (un signe diacritique isolé) ou faire 2 caractères
      // (le i turc, par exemple) : on garde toujours UN caractère.
      out += f.length === 1 ? f : (f.length === 0 ? c : f[0]);
    }
    return out;
  }

  /** La requête est-elle cherchable ? Rend { ok } ou { ok:false, raison }. */
  function requeteValide(brute) {
    const q = String(brute == null ? '' : brute).trim();
    if (q.length === 0) return { ok: false, raison: 'vide' };
    if (q.length > REQUETE_MAX) return { ok: false, raison: 'trop-longue' };
    // On compte après pliage : « éé » fait bien deux caractères cherchables.
    if (plier(q).replace(/\s+/g, '').length < REQUETE_MIN) return { ok: false, raison: 'trop-courte' };
    return { ok: true, requete: q };
  }

  /**
   * Cherche dans les chapitres d'un livre déjà chargé.
   * `chapitres` : tableau de chapitres, chacun tableau de versets (texte).
   * `plies`     : le même tableau, déjà plié (mis en cache par l'appelant).
   * Rend un tableau de { ch, v, texte, debut, fin } — index dans le TEXTE
   * D'ORIGINE, jamais de HTML.
   */
  function chercherDansLivre(chapitres, plies, motifPlie, restant) {
    const trouves = [];
    if (!motifPlie || restant <= 0) return trouves;
    for (let ch = 0; ch < chapitres.length; ch++) {
      const versets = chapitres[ch] || [];
      const versetsPlies = plies[ch] || [];
      for (let v = 0; v < versets.length; v++) {
        const i = versetsPlies[v].indexOf(motifPlie);   // jamais de regex
        if (i === -1) continue;
        trouves.push({ ch, v, texte: versets[v], debut: i, fin: i + motifPlie.length });
        if (trouves.length >= restant) return trouves;  // plafond : on s'arrête net
      }
    }
    return trouves;
  }

  /** Plie tous les versets d'un livre — à garder en cache, c'est le coût. */
  function plierLivre(chapitres) {
    return (chapitres || []).map(ch => (ch || []).map(plier));
  }

  /**
   * Découpe un résultat en trois morceaux de TEXTE BRUT, avec un peu de
   * contexte autour : { avant, trouve, apres, coupeAvant, coupeApres }.
   * La vue échappe les trois et n'entoure que `trouve`.
   */
  function extrait(res) {
    const t = res.texte;
    const d0 = Math.max(0, res.debut - EXTRAIT_AVANT);
    const f0 = Math.min(t.length, res.fin + EXTRAIT_APRES);
    return {
      avant: t.slice(d0, res.debut),
      trouve: t.slice(res.debut, res.fin),
      apres: t.slice(res.fin, f0),
      coupeAvant: d0 > 0,
      coupeApres: f0 < t.length
    };
  }

  /**
   * « Jean 3.16 », « 1 jean 2 », « psaume 23 » → { livreId, ch, v } (index à
   * partir de 0), ou null. Le nom peut être abrégé tant qu'il ne désigne
   * qu'un seul livre : « jea » va à Jean, « je » est ambigu et ne donne rien.
   *
   * `livres` est le catalogue de l'appelant : { id: { nom, nb } }. Le
   * résultat ne peut donc contenir qu'un identifiant DÉJÀ CONNU — c'est ce
   * qui garantit qu'aucune requête ne se transforme en chemin de fichier.
   */
  function analyserReference(brute, livres) {
    const q = String(brute == null ? '' : brute).trim();
    // nom, puis chapitre, puis éventuellement . ou : et le verset
    const m = q.match(/^(.+?)\s*(\d{1,3})(?:\s*[.:,]\s*(\d{1,3}))?$/);
    if (!m) return null;
    const nomPlie = plier(m[1]).replace(/[\s.]+/g, '');
    if (nomPlie.length < 2) return null;

    let choisi = null, exact = false;
    for (const id of Object.keys(livres)) {
      const b = livres[id];
      const candidats = [plier(b.nom).replace(/[\s.]+/g, ''), plier(id)];
      if (candidats.some(c => c === nomPlie)) { choisi = id; exact = true; break; }
      if (candidats.some(c => c.indexOf(nomPlie) === 0)) {
        if (choisi && choisi !== id) return null;    // abréviation ambiguë : on renonce
        choisi = id;
      }
    }
    if (!choisi) return null;
    if (!exact && nomPlie.length < 3) return null;   // « je » ne suffit pas

    const ch = parseInt(m[2], 10);
    if (!(ch >= 1 && ch <= livres[choisi].nb)) return null;
    const v = m[3] === undefined ? null : parseInt(m[3], 10);
    if (v !== null && !(v >= 1 && v <= 200)) return null;
    return { livreId: choisi, ch: ch - 1, v: v === null ? null : v - 1 };
  }

  const api = {
    REQUETE_MIN, REQUETE_MAX, MAX_RESULTATS,
    plier, requeteValide, plierLivre, chercherDansLivre, extrait, analyserReference
  };

  // Navigateur : un global, comme icons.js et pierres.js. Node : un export,
  // pour que le test relise exactement le même code que l'application.
  racine.GraineRecherche = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
