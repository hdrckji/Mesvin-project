# 🌱 Graine de Parole

> « La semence, c'est la parole de Dieu. » — Luc 8.11

Application web (PWA) — un **compagnon de la Parole** pour la communauté chrétienne
(protestante / évangélique) francophone : sobre, respectueuse du texte, **gratuite**,
et **encourageante plutôt que culpabilisante**.

Trois modules, un même socle (design, hors-ligne, rien ne quitte l'appareil) :

## Les modules

### 📖 Mémoriser (racine de l'appli)

- **Répétition espacée** : chaque verset revient *juste avant* que tu ne l'oublies.
- **Validation objective** : tu reconstitues le verset sur l'écran (mots mélangés,
  mots à trous) et **l'appli vérifie**. 3 réussites espacées = verset « planté ».
- **Un jardin** : chaque verset mémorisé grandit (🌱 → 🌿 → 🪴 → 🌳 → 🌲).
- **Collections** : objectifs facultatifs par **thème** ou par **livre** —
  on choisit une collection, le bouton « Apprendre » sert ses versets, et on la complète.
- Contexte factuel (non doctrinal) du livre de chaque verset. Série (streak) quotidienne.

### 📖 Lire (`lire/`)

Plan de lecture **« chemin, pas calendrier »** : aucune date, aucun « retard » possible.
On avance quand on lit ; le chemin attend, simplement. Deux chemins pour commencer :
l'Évangile de **Marc** (16 ch.) et l'Évangile de **Jean** (21 ch.), texte Segond 1910 intégré.
Estimation douce et facultative de l'horizon (« à raison de 10 min par jour… »),
célébration sobre en fin de livre.

### 🕯️ Défi (`defi/`)

Connaissance des récits bibliques : questions strictement **factuelles** (qui, quoi, où),
jamais d'interprétation. **Défi du jour** (10 questions, les mêmes pour tous, tirage
déterministe par date) et **défi libre** (par catégorie et niveau). Après chaque réponse,
la **référence biblique** ramène vers le texte. Pas de classement — on s'encourage,
on ne se compare pas.

## Pile technique

100 % côté client : **HTML + CSS + JavaScript**, sans dépendance ni étape de build.

```
index.html, app.js, app.css      # module Mémoriser (+ socle de design partagé)
data/verses.json                 # versets (Segond 1910, domaine public)
data/collections.json            # collections thématiques
lire/index.html, lire.js, lire.css
lire/data/marc.json, jean.json   # texte biblique des chemins de lecture
defi/index.html, defi.js, defi.css
defi/data/questions.json         # 120 questions factuelles
manifest.webmanifest, sw.js      # installation PWA & hors-ligne complet
icon.svg
```

Stockage local (`localStorage`) : `graine.v3` (mémorisation), `graine.lire.v1` (lecture),
`graine.defi.v1` (défi). Rien ne quitte l'appareil.

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

## Feuille de route

- [x] Mémorisation par répétition espacée, **vérifiée par l'appli**
- [x] **Collections** : objectifs par thème ou par livre
- [x] **Plan de lecture** « chemin, pas calendrier » (Marc, Jean)
- [x] **Défi** : questions de connaissance biblique (défi du jour + défi libre)
- [x] Navigation unifiée entre les modules + hors-ligne complet
- [ ] Rappel quotidien (notification) pour ancrer l'habitude
- [ ] **Veillée** : le défi en groupe (écran projeté + téléphones)
- [ ] Bible complète intégrée (lecture dans le contexte du passage)
- [ ] Comptes optionnels (lien magique e-mail + Google) pour synchro et groupes d'église
- [ ] Espace responsable : verset de la semaine, packs, suivi bienveillant du groupe

## Principes

1. **Gratuit, pour toujours.** Pas de publicité, pas de fonction payante. On ne monnaie jamais l'accès à la Parole.
2. **Respect du texte** et **sobriété** du ton.
3. **Encourager, jamais culpabiliser.**
4. **Vie privée d'abord** : collecter le strict minimum ; tout fonctionne hors-ligne.
