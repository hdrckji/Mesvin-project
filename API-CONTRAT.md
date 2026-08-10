# Contrat d'API — Bible Horizon (comptes, duels & veillées en direct)

> Ce document est la **référence commune** entre le backend PHP (`api/`) et le
> frontend. Toute évolution passe par ici d'abord.

## Principes

- Base : `/api/…` — requêtes et réponses en **JSON** (`Content-Type: application/json`).
- Authentification : en-tête `Authorization: Bearer <token>` (token de session opaque).
- Erreurs : code HTTP approprié + corps `{ "error": "message lisible en français" }`.
- **Connexion sans mot de passe** : code à 6 chiffres envoyé par e-mail
  (plus fiable qu'un lien magique dans une PWA installée : on reste dans l'appli).
- Données personnelles : **e-mail + pseudo, rien d'autre**. Le vrai nom n'est
  jamais demandé. Suppression de compte = effacement total.
- Le local reste la base : l'appli fonctionne sans compte ; le serveur ne fait
  que synchroniser et relier.

## Authentification

### POST /api/auth/request-code
Corps : `{ "email": "..." }`
→ `{ "ok": true }` — envoie un code à 6 chiffres (validité 10 min, 5 essais max,
3 demandes/heure/e-mail). En mode dev (pas de SMTP configuré), la réponse
contient aussi `"devCode": "123456"` — JAMAIS en production.

### POST /api/auth/verify
Corps : `{ "email": "...", "code": "123456", "pseudo": "..." }` — `pseudo`
obligatoire seulement à la première connexion (création du compte) ; s'il est
requis et absent → 422 `{ "error": "...", "needPseudo": true }`.
→ `{ "token": "...", "user": { "pseudo": "...", "email": "...", "friendCode": "GRN-7F3K", "isAdmin": false } }`
(`isAdmin` : l'e-mail figure dans `ADMIN_EMAILS` — voir la section Administration ;
le client le range dans sa session locale, le serveur revérifie à chaque route)

### POST /api/auth/google
Connexion **en un geste** avec un compte Google — active seulement si la
variable `GOOGLE_CLIENT_ID` est configurée (sinon 501).
Corps : `{ "credential": "<jeton d'identité Google>", "pseudo": "..."? }`.
Le serveur vérifie le jeton auprès de Google (audience, émetteur, e-mail
confirmé) ; le compte est le même que par e-mail — **l'adresse fait foi**.
À la création, le pseudo est dérivé du prénom Google s'il n'est pas fourni ;
si rien ne convient → 422 `{ "needPseudo": true }` (renvoyer le même
`credential` avec un `pseudo`).
→ `{ "token": "...", "user": { … } }`

### GET /api/config
Configuration **publique** (aucune authentification) :
→ `{ "googleClientId": "…" | null }` — null = bouton Google masqué côté client.

### GET /api/me → `{ "user": { …, "isAdmin": true|false } }`
### POST /api/me/pseudo — corps `{ "pseudo": "..." }` → `{ "user": { … } }`
### POST /api/auth/logout → `{ "ok": true }` (invalide le token)
### DELETE /api/me → `{ "ok": true }` (supprime compte, synchro, amitiés, duels)

## Synchronisation

Blobs JSON par module, horodatés côté serveur. La **fusion intelligente** se
fait côté client (progression max, unions) ; le serveur stocke tel quel.

### GET /api/sync
→ `{ "memo": {...}|null, "lire": {...}|null, "defi": {...}|null, "updatedAt": "ISO" }`

### PUT /api/sync
Corps : `{ "memo": {...}?, "lire": {...}?, "defi": {...}? }` (clés facultatives)
→ `{ "ok": true, "updatedAt": "ISO" }` — taille max 512 Ko par module.

## Amis

Chaque utilisateur a un **code ami** court (ex. `GRN-7F3K`), affiché dans
l'écran Moi. Ajouter quelqu'un par son code crée l'amitié **immédiatement et
mutuellement** (le code ne circule qu'en privé : le partager vaut accord).

### GET /api/friends → `{ "friends": [ { "pseudo": "...", "friendCode": "...", "since": "ISO" } ] }`
### POST /api/friends/add — corps `{ "code": "GRN-XXXX" }` → `{ "ok": true, "friend": { … } }`
(404 si code inconnu, 409 si déjà amis, 400 si c'est son propre code)
### DELETE /api/friends/{code} → `{ "ok": true }`

## Duels (asynchrones)

Un duel = 10 questions tirées par le **serveur** dans `defi/data/questions.json`
(mêmes questions et même ordre pour les deux). Chacun joue quand il veut.
Le score est **recalculé côté serveur** à partir des réponses (le score envoyé
par le client n'est jamais cru).

### POST /api/duels
Corps : `{ "opponentCode": "GRN-XXXX" }` (doit être un ami)
→ `{ "duel": { "id": 12, "opponent": { "pseudo": "..." }, "questions": [ { "id": "...", "question": "...", "options": [ ... ] } ] } }`
(l'ordre des options est fixé par le serveur ; la bonne réponse n'est PAS envoyée)

### GET /api/duels
→ `{ "duels": [ { "id": 12, "opponent": { "pseudo": "..." }, "iChallenged": true,
  "myScore": 7|null, "theirScore": null|8, "status": "waiting_me"|"waiting_them"|"finished",
  "createdAt": "ISO" } ] }`

### GET /api/duels/{id}
→ duel détaillé ; inclut `questions` (sans bonnes réponses) si je n'ai pas
encore joué ; inclut `review` (mes réponses + bonnes réponses + références)
quand j'ai joué.

### POST /api/duels/{id}/result
Corps : `{ "answers": [0,2,1,…] }` (index de l'option choisie, -1 = sans réponse)
→ `{ "duel": { …, "myScore": 7, "review": [ { "id": "...", "mine": 2, "bonne": 1, "reference": "..." } ] } }`
(409 si déjà joué)

## Veillées en direct (mode groupe du Défi)

Un **animateur** (compte requis) crée une salle et projette un grand écran ;
les **participants** rejoignent avec un code court et leur prénom (**aucun
compte**) et répondent sur leur téléphone. Déroulé piloté par l'animateur :
`lobby → question → reveal → … → done`. Les clients suivent en interrogeant
`/state` toutes les ~2 s (polling). Comme pour les duels : questions tirées
par le serveur, bonne réponse jamais envoyée pendant la phase de réponse,
points calculés côté serveur (100 par bonne réponse + jusqu'à 50 de rapidité).
Les veillées sont balayées après 24 h.

### POST /api/veillees (authentifié — l'animateur)
Corps (tout facultatif) : `{ "nb": 5–20 (10), "seconds": 10–90 (25),
"categorie": "..."?, "niveau": 1–3? }`
→ 201 `{ "veillee": { "code": "K7PM", "statut": "lobby", "qTotal": 10, … } }`

### GET /api/veillees/{code}/state?player={playerKey}
Public, pollable. → `{ "veillee": { "code", "statut", "qIndex", "qTotal",
"seconds", "nPlayers", "players": [ { "prenom", "score", "rang" } ], … } }`
- en phase `question` : + `question` (SANS `bonne` ni `reference`),
  `remaining` (secondes restantes), `nAnswered` ;
- en phase `reveal`/`done` : + `question.bonne`, `question.reference`,
  `distribution` (nombre de réponses par option) ;
- avec `player` : + `me` (`answered`, puis `answer`, `correct`, `points`,
  `score`, `rang`) ;
- en phase `done` : + `bilan` (`reponses`, `bonnes` — le collectif d'abord).

### POST /api/veillees/{code}/join
Corps : `{ "prenom": "..." }` (2–20 caractères, unique dans la salle).
→ 201 `{ "playerKey": "<32 hex>", "prenom": "..." }`
(410 si la veillée est terminée, 409 si prénom pris ou salle pleine)

### POST /api/veillees/{code}/answer
Corps : `{ "playerKey": "...", "q": <qIndex>, "answer": <index option> }`
→ `{ "ok": true }` — refusé (409) si la question est fermée, le temps écoulé
(2 s de grâce réseau) ou la réponse déjà donnée. Le résultat personnel
n'est PAS renvoyé ici : il arrive avec l'état `reveal`.

### POST /api/veillees/{code}/advance (authentifié — l'animateur seul)
Corps : `{ "action": "start" | "reveal" | "next" | "end" }`
→ `{ "veillee": { … } }` — transitions strictes (409 sinon) ; `start` exige
au moins un participant ; `next` après la dernière question passe en `done`.

## Questions du Défi

La banque de base vit dans `defi/data/questions.json`, embarquée dans l'image
Docker ; le système de fichiers de Railway étant éphémère, les retouches
d'administration vivent en base (table `quiz_questions`). Tout le monde —
module Défi, duels, veillées — tire dans la banque **fusionnée** : les
questions du fichier, remplacées par leur surcharge active s'il y en a une,
retirées si la surcharge est inactive, plus les ajouts (id préfixés `adm-`).

### GET /api/questions
Public, sans authentification.
→ `{ "version": 2, "categories": [...], "questions": [banque fusionnée] }`
Le module Défi l'essaie d'abord et retombe sur son fichier local hors-ligne.

## Administration

Un utilisateur est **admin** si son e-mail figure dans la variable
d'environnement `ADMIN_EMAILS` (liste séparée par des virgules, insensible à
la casse) — aucune colonne en base. Le payload utilisateur (connexion et
`GET /api/me`) porte `"isAdmin": true|false`. Toutes les routes `/api/admin/*`
exigent une session valide **et** le rôle admin (403 sinon). L'écran vit à
l'adresse `/admin/` (en ligne seulement, jamais pré-caché).

### GET /api/admin/users
→ `{ "users": [ { "id": 3, "pseudo": "...", "email": "...", "friendCode": "GRN-XXXX",
  "createdAt": "ISO", "lastSeen": "ISO" } ] }`

### DELETE /api/admin/users/{id}
→ `{ "ok": true }` — suppression **totale** du compte, même effet que
`DELETE /api/me` (compte, synchro, amitiés, duels, sessions, codes).
400 si l'admin vise son propre compte (il passe par l'écran Moi),
404 si l'id n'existe pas.

### POST /api/admin/questions
Créer ou modifier une question. Corps :
`{ "id"?, "categorie", "niveau", "question", "options": [4], "bonne", "reference" }`
- sans `id` → **ajout**, id généré `adm-<6 hex>` ;
- `id` du fichier → **surcharge** (la version en base remplace celle du fichier) ;
- `id` en `adm-` → modification de l'ajout ; autre id → 404.
Validations : catégorie parmi celles du fichier, niveau 1–3, question non vide
≤ 300 caractères, exactement 4 options non vides ≤ 120 caractères, `bonne`
entre 0 et 3, référence non vide ≤ 60 caractères.
→ `{ "question": { … } }` (la question enregistrée)

### DELETE /api/admin/questions/{id}
- id du fichier : pose une surcharge `actif = 0` — la question est
  **désactivée** (elle reste dans le fichier ; réversible avec `/restore`) ;
- id `adm-` : l'ajout est **supprimé** pour de bon.
→ `{ "ok": true }` — 404 si l'id n'existe ni en base ni dans le fichier.

### POST /api/admin/questions/{id}/restore
Retire la surcharge : la version du fichier redevient active (annule une
édition ou une désactivation). → `{ "ok": true }` — 404 si pas de surcharge.

## Backend — notes d'implémentation

- PHP 8 + PDO. `MYSQL_URL` (Railway) ; **repli SQLite** (`api/data/dev.sqlite`)
  si absent → tests locaux possibles avec `php -S`.
- Migrations auto au premier appel (CREATE TABLE IF NOT EXISTS).
- Tables : `users`, `login_codes`, `sessions`, `sync_blobs`, `friendships`,
  `duels`, `veillees`, `veillee_players`, `veillee_answers`, `quiz_questions`.
- Rôle admin : `ADMIN_EMAILS` (adresses séparées par des virgules, casse
  ignorée) — pas de colonne en base, le rôle se retire en éditant la variable.
- E-mail : SMTP via env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `MAIL_FROM`) — sinon mode dev (`devCode` dans la réponse).
- Connexion Google : `GOOGLE_CLIENT_ID` (client OAuth « application Web » ;
  le domaine du site en origine JavaScript autorisée). Jamais de secret :
  seul le jeton d'identité est vérifié, via l'endpoint tokeninfo de Google.
- Tokens : 32 octets aléatoires hex. Codes : 6 chiffres, hachés en base.
