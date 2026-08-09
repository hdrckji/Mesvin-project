# Contrat d'API — Bible Horizon (phase 1 : comptes + duels)

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
→ `{ "token": "...", "user": { "pseudo": "...", "email": "...", "friendCode": "GRN-7F3K" } }`

### GET /api/me → `{ "user": { … } }`
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

## Backend — notes d'implémentation

- PHP 8 + PDO. `MYSQL_URL` (Railway) ; **repli SQLite** (`api/data/dev.sqlite`)
  si absent → tests locaux possibles avec `php -S`.
- Migrations auto au premier appel (CREATE TABLE IF NOT EXISTS).
- Tables : `users`, `login_codes`, `sessions`, `sync_blobs`, `friendships`, `duels`.
- E-mail : SMTP via env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `MAIL_FROM`) — sinon mode dev (`devCode` dans la réponse).
- Tokens : 32 octets aléatoires hex. Codes : 6 chiffres, hachés en base.
