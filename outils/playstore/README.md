# Publier Bible Horizon sur Google Play

L'application du Play Store n'est qu'une **coquille Android autour de
`biblehorizon.fr`** (un *TWA* : Trusted Web Activity). Les déploiements Railway
continuent d'arriver instantanément chez les utilisateurs, sans passer par
Google. Seule la coquille demande une mise à jour, environ une fois par an,
quand Google relève le niveau d'API ciblé. **Rien n'est figé par la publication.**

---

## Le piège qui fait perdre des heures

L'empreinte à coller dans `/.well-known/assetlinks.json` **n'est pas celle de
votre clé locale**. En laissant Play signer l'application — le défaut, et le bon
choix, car Google garde la clé et une clé perdue est fatale — c'est **Google qui
resigne**. L'empreinte à utiliser est donc :

> Play Console → **Configuration** → **Intégrité de l'application** →
> **Certificat de la clé de signature de l'application** → `SHA-256`

et **surtout pas** celle du *certificat de la clé d'importation*.

Avec la mauvaise, tout se construit, tout s'installe — et l'application s'ouvre
avec **une barre d'adresse en haut**, sans que rien n'explique pourquoi.

Une fois l'empreinte en main, elle se colle dans le tableau vide :

```json
"sha256_cert_fingerprints": ["AB:CD:EF:01:…:99"]
```

puis on déploie. La suite de tests signale tant que ce tableau est vide.

---

## Construire la coquille

À faire **sur votre machine** (la clé ne doit pas voyager). Node 18+ et un JDK
suffisent ; Bubblewrap télécharge le reste.

```bash
npm install -g @bubblewrap/cli
mkdir bible-horizon-android && cd bible-horizon-android
cp <ce dossier>/twa-manifest.json .
bubblewrap init --manifest ./twa-manifest.json
bubblewrap build
```

`twa-manifest.json` est déjà réglé : identifiant `fr.biblehorizon.app` (celui
que déclare `assetlinks.json` — les deux doivent coïncider), couleurs de
l'application en clair et en sombre, icône adaptative, et deux raccourcis
(Lire, Défi) sur l'icône.

`enableNotifications` est à **true** : sans lui, « Le verset offert » ne
demanderait jamais la permission Android et les notifications resteraient
muettes.

La sortie est `app-release-bundle.aab`, à envoyer dans Play Console.

---

## Le formulaire « Sécurité des données »

À remplir exactement — une déclaration approximative se paie cher plus tard.
Voici ce que l'application collecte **vraiment**, lu dans le schéma.

| Donnée | Où | Obligatoire ? | Finalité |
|---|---|---|---|
| Adresse e-mail | `users`, `login_codes` | non — l'appli marche sans compte | gestion du compte |
| Pseudo | `users` | non | fonctionnalité (classements, défis entre amis) |
| Prénom | `*_participants` | non | fonctionnalité (affichage pendant une veillée) |
| Jeton de session | `sessions` | — | gestion du compte |
| Abonnement aux notifications | `push_abonnements` | non | fonctionnalité (le verset quotidien) |
| Nom, adresse et contact d'une église | `groupe_demandes` | non | fonctionnalité (compte responsable) |
| Contenu publié par une église | `groupe_annonces`, `groupe_series` | non | fonctionnalité |
| Adresse IP | `throttle`, **2 heures au plus** | — | **prévention de la fraude et sécurité** |

- **Chiffrement en transit : oui** (HTTPS partout, HSTS).
- **Suppression possible : oui** — dans l'application (Moi → Mon compte) et par
  l'adresse web `https://biblehorizon.fr/supprimer-mon-compte/`, à indiquer dans
  le champ prévu.
- **Aucune donnée n'est partagée avec un tiers.** Aucune publicité, aucun
  traceur, aucune analyse tierce.
- Les **compteurs de fréquentation** (`visites`) ne portent aucun identifiant,
  aucune adresse, aucun cookie : ils ne sont rattachables à personne, et ne
  relèvent donc pas d'une collecte au sens du formulaire.

---

## Contenu généré par les utilisateurs — À TRAITER AVANT DE PUBLIER

Les églises publient des **annonces**, des **rendez-vous** et des **séries de
questions**, visibles par leurs membres. Google considère cela comme du contenu
généré par les utilisateurs, et exige alors **deux choses** :

1. un moyen de **signaler** un contenu **depuis l'application** ;
2. une **modération**.

La modération existe (retrait sur signalement, jamais a priori). **Le bouton de
signalement, lui, n'existe pas encore** : un membre doit écrire à l'adresse de
contact. Il faut l'ajouter avant de soumettre — répondre « oui, il y a du
contenu d'utilisateurs » sans mécanisme de signalement expose à un refus.

---

## Le reste de la fiche

- **Classification du contenu** : questionnaire à remplir ; application
  d'étude biblique, sans violence ni contenu sensible. Déclarer l'existence
  d'un contenu d'utilisateurs (voir ci-dessus).
- **Politique de confidentialité** : `https://biblehorizon.fr/confidentialite/`
- **Catégorie** : Enseignement, ou Style de vie.
- **Gratuit**, sans achat intégré, sans publicité.

### Description courte (80 caractères au plus)

```
Lis la Bible, mémorise des versets et anime des veillées dans ton église.
```

### Description longue

```
Bible Horizon accompagne la lecture de la Bible, seul ou à plusieurs.

LIRE
La Bible entière (Segond 1910) sur votre appareil, lisible même sans réseau.
Recherche dans le texte, passages gardés, chemin de lecture à votre rythme.

MÉMORISER
Une bibliothèque de versets, à apprendre un peu chaque jour. Un verset peut
vous être offert chaque matin, à l'heure que vous choisissez.

CHERCHER ENSEMBLE
Cinq épreuves autour du texte : questions sur les récits, paroles à
attribuer, phrases à reconnaître, portraits à deviner, événements à replacer
dans l'ordre. Seul, à deux, ou à distance avec un ami.

EN ÉGLISE
Une veillée se mène à plusieurs : un grand écran pour toute la salle, chacun
répond sur son téléphone, l'animateur donne le rythme. Une église peut
proposer ses propres questions à ses membres.

Bible Horizon est gratuit, sans publicité, et le restera. Aucune donnée n'est
revendue ni partagée. L'application fonctionne entièrement sans compte : dans
ce cas, rien ne quitte votre appareil.

Le texte biblique est la Bible Louis Segond 1910, dans le domaine public.
```
