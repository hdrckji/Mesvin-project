# 🌱 Graine de Parole

> « La semence, c'est la parole de Dieu. » — Luc 8.11

Application web (PWA) pour **mémoriser des versets bibliques** et les garder vivants,
un peu chaque jour, grâce à la **répétition espacée**.

Pensée pour la communauté chrétienne (protestante / évangélique) francophone :
sobre, respectueuse du texte, **gratuite**, et **encourageante plutôt que culpabilisante**.

## Ce que ça fait (version 0.1)

- **Mémorisation par répétition espacée** — chaque verset revient *juste avant* que tu ne l'oublies. Plus tu le connais, plus l'intervalle s'allonge. Algorithme inspiré de SM-2, adouci.
- **Exercices variés adaptés à la maturité du verset** : premières lettres → mots à trous / mots mélangés → récitation de mémoire.
- **Auto-évaluation en un geste** (Raté / Difficile / Correct / Facile) qui pilote la planification, sans rien à calculer pour l'utilisateur.
- **Un « jardin »** : chaque verset grandit visuellement (🌰 → 🌱 → 🌿 → 🪴 → 🌳 → 🌲 enraciné).
- **Contexte factuel** du livre d'où vient le verset (neutre, non doctrinal).
- **Bibliothèque** d'une trentaine de versets classiques (Segond 1910) + ajout de ses propres versets.
- **PWA** : installable sur l'écran d'accueil, **fonctionne hors-ligne**, aucun compte requis.
- **Rien ne quitte l'appareil** : la progression est stockée en local (`localStorage`).

## Pile technique

100 % côté client : **HTML + CSS + JavaScript**, sans dépendance ni étape de build.
- `index.html` — coquille de l'appli
- `app.css` — design (clair/sombre automatique, mobile d'abord)
- `app.js` — moteur de répétition espacée, exercices, écrans
- `data/verses.json` — versets (Segond 1910, domaine public)
- `manifest.webmanifest` + `sw.js` — installation PWA & hors-ligne

## Lancer en local

Comme c'est statique, n'importe quel petit serveur suffit :

```bash
# depuis le dossier du projet
python3 -m http.server 8080
# puis ouvrir http://localhost:8080
```

(Il faut un serveur, pas un simple double-clic : le service worker et `fetch()` exigent `http://`.)

## Versets & droits

Les textes sont en **Louis Segond 1910** (domaine public). À **relire** avant une diffusion large.
Les versions plus récentes (Segond 21, Semeur…) sont sous droits et nécessiteraient une autorisation.

## Feuille de route (idées discutées)

- [ ] Rappel quotidien (notification) pour ancrer l'habitude
- [ ] Sens inverse : retrouver la **référence** à partir du texte
- [ ] **Plan de lecture** « chemin, pas calendrier » (sans retard ni culpabilité)
- [ ] **Défi / Veillée** : questions de connaissance biblique, solo ou en groupe
- [ ] Bible complète intégrée (lecture dans le contexte du passage)
- [ ] Comptes optionnels (lien magique e-mail + Google) pour synchro et groupes d'église
- [ ] Espace responsable : verset de la semaine, packs, suivi bienveillant du groupe

## Principes

1. **Gratuit, pour toujours.** Pas de publicité, pas de fonction payante. On ne monnaie jamais l'accès à la Parole.
2. **Respect du texte** et **sobriété** du ton.
3. **Encourager, jamais culpabiliser.**
4. **Vie privée d'abord** : collecter le strict minimum.
