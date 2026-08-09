# Vision & architecture — Graine de Parole

> Un **compagnon de la Parole** pour la communauté chrétienne francophone :
> plusieurs modules qui partagent **un même socle**, un même ton (sobre,
> encourageant, factuel — jamais doctrinal), et un même contenu (la Bible)
> qui circule de l'un à l'autre.

Ce document décrit **où l'on va**, même si tout n'est pas construit tout de
suite. Il sert à ce que chaque brique nouvelle **se greffe** proprement sur
l'existant.

---

## 1. Les modules

| Module | Ce que c'est | État |
|---|---|---|
| **Mémoriser** | Mémoriser des versets par répétition espacée. L'appli propose le verset, accompagne l'apprentissage, valide **objectivement** la mémorisation, puis entretient. | ✅ v0.3 |
| **Collections** | Regrouper les versets par **thème** (pardon, amour, confiance…) ou par livre. Objectif facultatif : on choisit une collection, on la complète. | ✅ |
| **Lire** | Plan de lecture **« chemin, pas calendrier »** : on avance à son rythme, jamais de « retard », jamais de culpabilité. Marc et Jean intégrés. | ✅ v1 |
| **Défi / Veillée** | Connaissance biblique (ex-« Ichthus »), **factuelle** (qui/quoi/où). Défi du jour + défi libre en **solo** ✅ ; mode **veillée** en groupe à venir. | ✅ v1 (solo) |

*(« Jouer » est volontairement évité : on dit **Défi** en solo, **Veillée** en groupe — respect du texte.)*

---

## 2. Le socle commun (ce que tous les modules partagent)

- **La Bible intégrée** — texte **Louis Segond 1910** (domaine public) comme
  source unique : la mémorisation y puise ses versets, la lecture son texte,
  le défi ses questions, la mémorisation son contexte de passage. *Une seule
  source, réutilisée partout.*
- **Moteur de répétition espacée** — réutilisable (versets aujourd'hui,
  potentiellement questions du défi demain).
- **Progression de l'utilisateur** — **locale d'abord** (rien ne quitte
  l'appareil), **compte optionnel plus tard** pour synchroniser et rejoindre
  un groupe.
- **Système de design** — sobre, chaleureux, clair/sombre, mobile d'abord.
- **Gamification douce & transversale** — séries (streak), jardin qui grandit,
  collections à compléter, objectifs **collectifs** plutôt que compétitifs.

---

## 3. La dimension communautaire (plus tard, mais prévue)

- **Comptes optionnels** : lien magique par e-mail (principal) + Google
  (option). Aucun compte pour les enfants.
- **Groupes d'église par code** : on rejoint « BETHEL7 » en un code.
- **Espace responsable** : verset/collection de la semaine poussé au groupe,
  packs, suivi **bienveillant** (au niveau du groupe, jamais un classement
  individuel public).
- **Bascule serveur** : ces fonctions demandent un backend + base de données
  → hébergement Railway (le statique actuel bascule alors sans réécriture).

---

## 4. Modèle de données (esquisse, pour que tout compose)

```
Verset      { id, ref, livre, texte, thèmes[] }          // source commune
Collection  { id, nom, thème, versets[] }                 // module Collections
CarteMémo   { versetId, ease, interval, due, validations, statut }  // module Mémoriser
PlanLecture { id, nom, séquence[], position }             // module Lire (chemin)
Question    { id, catégorie, énoncé, réponse, réfBiblique }// module Défi
Progrès     { local | compte, streak, … }                 // transversal
Groupe      { code, membres[], responsable, poussées[] }  // communautaire
```

Point clé : **le Verset est au centre**. Un même verset peut être mémorisé,
lu dans son passage, rangé dans des collections, et servir de question de
défi (« complète le verset », « d'où vient-il ? »).

---

## 5. Principes directeurs (non négociables)

1. **Gratuit, pour toujours.** On ne monnaie jamais l'accès à la Parole.
2. **Hors-ligne d'abord**, vie privée d'abord (collecter le strict minimum).
3. **Encourager, jamais culpabiliser.**
4. **Factuel, pas doctrinal** : le contexte et les questions restent neutres ;
   l'interprétation, si elle existe un jour, sera laissée à chaque église.
5. **Respect du texte** et sobriété du ton.

---

## 6. Feuille de route (ordre indicatif)

1. ✅ Mémorisation (v0.3)
2. ✅ Validation **objective** de la mémorisation (tests auto-corrigés, plusieurs retours)
3. ✅ **Collections** thématiques (option, amenée en douceur)
4. Rappel quotidien (notification PWA)
5. ✅ **Plan de lecture** « chemin » (Marc, Jean)
6. ✅ **Défi** (connaissance biblique, solo) — la **Veillée** en groupe reste à venir
7. Comptes optionnels + **groupes d'église** (bascule serveur)

---

## 7. Ce qu'on ne fait PAS maintenant (assumé)

- Pas de backend ni de comptes tant que le local suffit.
- Pas de versions sous droits (on reste en Segond 1910).
- On construit **une brique à la fois, bien faite**, pas trois demi-outils.
