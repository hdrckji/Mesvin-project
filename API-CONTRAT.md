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

## Santé & anti-abus

- `GET /api/health` : `{ "ok": true }` pour tout le monde ; le **détail**
  (pilote de base, mode e-mail, dernière erreur d'envoi, drapeau demo) n'est
  renvoyé qu'aux **admins** authentifiés. En panne de base : `{ "ok": false }`.
  Le détail admin contient aussi `config` : la liste des variables
  d'environnement attendues, chacune sous la forme
  `{ "variable", "libelle", "definie": true|false }` — **jamais les valeurs**
  (fonction `config_checklist()` dans `api/helpers.php`).
- `POST /api/auth/request-code` est plafonné **par e-mail** (3/heure) ET
  **par adresse IP** (30/heure, table `throttle`) → 429 au-delà.
- Chaque action d'administration est tracée (table `admin_log`) et
  consultable via `GET /api/admin/log` (admins, 100 dernières entrées).
- Les en-têtes de sécurité (CSP, nosniff, frame-ancestors, HSTS…) sont posés
  par le Caddyfile sur toutes les réponses.

## « Avant ou après ? » — l'épreuve de la frise (/frise/, reliée à Sonder)

Endpoints **sans compte** (l'épreuve se partage par codes, y compris avec
des personnes sans compte) : le paquet de cartes
`[{ "t": titre, "r": référence|null, "o": rang }]` est fourni par le client à
la création (la 1re carte amorce la frise) ; le serveur arbitre les positions
par les rangs `o` et ne révèle jamais les cartes à venir d'une veillée.
Codes `FD-XXXXX` (défis, balayés à 7 jours) et `FV-XXXXX` (veillées, 24 h).
Plafond 10 créations/heure/IP (fichier `api/frise.php`).

- `POST /api/frise/duel` `{pseudo, mode, deck}` → `{code, cle}` — la clé
  authentifie le créateur (case p1).
- `GET /api/frise/duel/{code}` → `{mode, deck, total, p1, p2}`.
- `POST /api/frise/duel/{code}/score` `{score, cle}` (créateur) ou
  `{score, pseudo}` (case p2, premier arrivé) → l'état du duel ; chaque case
  ne s'écrit qu'une fois (409 sinon).
- `POST /api/frise/veillee` `{mode, deck}` → `{code, cle}` (clé = animateur).
- `POST /api/frise/veillee/{code}/rejoindre` `{prenom}` → `{jeton}` (40 max).
- `POST /api/frise/veillee/{code}/avancer` `{cle}` — attente → placement
  (carte 1) → revele → placement (suivante, réponses remises à zéro) → … → fin.
- `POST /api/frise/veillee/{code}/reponse` `{jeton, carte, position}` — en
  phase placement uniquement, une seule réponse par carte ; le serveur pose
  le verdict et le point.
- `GET /api/frise/veillee/{code}/etat?jeton=…|cle=…` → `{phase, carte, total,
  participants, moi, frise, enCours, positionJuste, animateur}` — les verdicts
  des autres n'apparaissent qu'en phase `revele`.

## Épreuves à choix (« Qui a dit ça ? » /quiadit/, « Écrit… ou pas ? » /ecritoupas/)

Mêmes principes que la Frise, pour des paquets de QUESTIONS À CHOIX
`{q, options[2..4], bonne, ref|null, rev|null}` (fichier `api/epreuve.php`).
Codes `ED-XXXXX` (défis, 7 j) et `EV-XXXXX` (veillées, 24 h). En veillée,
l'état ne transmet JAMAIS `bonne`/`ref`/`rev` pendant la phase `question` —
seulement à la révélation. Routes : `POST /api/epreuve/duel`,
`GET/POST /api/epreuve/duel/{code}[/score]`, `POST /api/epreuve/veillee`,
`POST …/{code}/rejoindre|avancer|reponse` (`{jeton, carte, choix}`),
`GET …/{code}/etat`. Les banques vivent côté client
(`quiadit/data/banque.json`, `ecritoupas/data/banque.json`).

## « De qui parle-t-on ? » (/portrait/) — le portrait à indices

Défis `PD-XXXXX` (table epreuve_duels, score max = 5 points × portraits) et
veillées `PV-XXXXX` (fichier `api/portrait.php`) : l'animateur révèle les
indices UN À UN (`avancer` avec `action: 'indice'|'reveler'|'suivant'`),
chacun répond en TEXTE LIBRE une seule fois par portrait
(`reponse {jeton, carte, texte}` — correspondance tolérante, points
dégressifs 5→1 selon l'indice courant). L'état n'expose que les indices déjà
révélés ; la réponse et la référence n'arrivent qu'à la révélation.
Banque : `portrait/data/banque.json`.

## Authentification

### POST /api/auth/request-code
Corps : `{ "email": "..." }`
→ `{ "ok": true }` — envoie un code à 6 chiffres (validité 45 min, 5 essais max,
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
→ `{ "googleClientId": "…" | null, "vapidPublicKey": "…" | null }`
— `googleClientId` null = bouton Google masqué côté client ; `vapidPublicKey`
null = personne n'a encore activé les notifications (la clé naît au premier
`GET /api/push/cle`).

### GET /api/me → `{ "user": { …, "isAdmin": true|false } }`
### POST /api/me/pseudo — corps `{ "pseudo": "..." }` → `{ "user": { … } }`
### POST /api/auth/logout → `{ "ok": true }` (invalide le token)
### DELETE /api/me → `{ "ok": true }` (supprime compte, synchro, amitiés, duels,
adhésions aux groupes — voir la section Groupes pour la passation)

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
"categorie": "..."?, "niveau": 1–3?, "groupe": "GRP-XXXXX"? }`
→ 201 `{ "veillee": { "code": "K7PM", "statut": "lobby", "qTotal": 10, … } }`
`groupe` lie le quiz à une église : l'appelant doit en être **responsable**
(403 sinon) et le tirage se fait dans la **banque du groupe** — voir la
section « Quiz d'église » (400 « Pas assez de questions… » si elle est plus
petite que `nb`).

### GET /api/veillees/{code}/state?player={playerKey}
Public, pollable. → `{ "veillee": { "code", "statut", "qIndex", "qTotal",
"seconds", "nPlayers", "nPresent", "players": [ { "prenom", "score", "rang" } ],
… } }`
- `nPlayers` = tous ceux qui ont rejoint ; `nPresent` = ceux vus il y a moins
  de 30 s (sonder `/state` vaut signe de présence, et rejoindre marque déjà
  présent). Un participant parti garde son score et son rang au classement —
  il n'est simplement plus attendu pour révéler la réponse. La présence n'est
  donnée qu'en total : dire publiquement QUI a fermé son téléphone
  exposerait chacun sans rien apporter ;
- veillée liée à une église : + `"eglise": "<nom du groupe>"` (pour le
  grand écran) — rien d'autre du groupe ne transparaît ;
- en phase `question` : + `question` (SANS `bonne` ni `reference`),
  `remaining` (secondes restantes), `nAnswered`, `nPresentRepondu` ;
- `nAnswered` compte TOUTES les réponses, `nPresentRepondu` seulement celles
  des présents. C'est ce dernier qu'il faut comparer à `nPresent` : mêler les
  deux populations couperait la parole à quelqu'un qui réfléchit encore ;
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

## Groupes d'église (fondations — encore aucune interface)

Le serveur est prêt, l'écran viendra ensuite : **rien n'est visible dans
l'appli pour l'instant**. L'esprit (VISION.md) : on rejoint le groupe de son
église avec un **code court** (`GRP-XXXXX`, 5 caractères dans l'alphabet sans
ambiguïté des codes amis — l'espace élargi résiste à l'énumération) ; le
**responsable** pousse le verset de la semaine au groupe ; le suivi reste
bienveillant — jamais de classement individuel public, et les e-mails des
membres ne sont **jamais** exposés.

Toutes les routes exigent une session (`Authorization: Bearer …`). Le payload
`groupe` commun : `{ "code", "nom", "role" ("responsable" | "membre" — celui
du demandeur), "nbMembres", "verset": { "reference", "texte", "depuis": "ISO" } | null }`.

### POST /api/groupes
FERMÉE : la création directe répond désormais **403** — l'ouverture d'un
groupe passe par une demande validée par l'administration (ci-dessous).

### POST /api/groupes/demande
Compte requis. Corps : `{ "nom": "...", "adresse": "...", "email"?: "..." }`.
`nom` : mêmes règles qu'un nom de groupe (2 à 40 caractères : lettres,
chiffres, espaces, tirets, apostrophes). `adresse` (**obligatoire**) :
l'adresse de l'église, texte libre de 5 à 120 caractères (400 sinon).
`email` (**facultatif**) : un e-mail de contact si différent de celui du
compte — mêmes règles de validité qu'à la connexion (400 si invalide),
absent ou vide → `null`. Une seule demande **en attente** à la fois par
compte (409 sinon) ; une demande **refusée** est remplacée par la suivante
(détails compris) ; 409 si le demandeur est déjà responsable de 5 groupes ;
plafond horaire par IP (429).
→ 201 `{ "demande": { "nom", "adresse", "email", "statut": "attente",
"createdAt" } }`

### GET /api/groupes/demande
→ `{ "demande": null | { "nom", "adresse", "email",
"statut": "attente"|"refusee", "createdAt" } }` — `adresse`/`email` peuvent
être `null` sur une demande d'avant leur introduction.

### DELETE /api/groupes/demande
Annule sa demande (efface aussi une refusée, détails compris).
→ `{ "ok": true }` — 404 si rien.

### GET /api/admin/eglises
Admin seul. → `{ "demandes": [ { "id", "nom", "adresse", "emailContact",
"pseudo", "email", "createdAt" } ] (en attente, ordre d'arrivée),
"groupes": [ { "code", "nom", "nbMembres", "responsable", "createdAt" } ] }`.
`emailContact` : l'e-mail de contact fourni au dépôt, `null` s'il est absent
ou identique à celui du compte ; `adresse` : `null` seulement sur une
demande d'avant son introduction.

### POST /api/admin/eglises/demandes/{id}/accepter
Le groupe naît (code GRP- unique, demandeur **responsable**), la demande
disparaît — revendiquée atomiquement : deux acceptations simultanées ne
créent qu'un groupe, la seconde reçoit 404. Le plafond de 5 est revérifié
(409, demande conservée). Tracé dans admin_log. → `{ "code", "nom" }`

### POST /api/admin/eglises/demandes/{id}/refuser
Statut `refusee` (détails conservés) — le demandeur le voit avec douceur et
peut redéposer.
Tracé dans admin_log. → `{ "ok": true }` — 404 si déjà tranchée.

### POST /api/groupes/rejoindre
Corps : `{ "code": "GRP-XXXXX" }` — on rejoint en **membre**.
→ `{ "groupe": { … } }` — 400 code mal formé, 404 code inconnu,
409 déjà membre ou groupe complet (500 membres au maximum).

### GET /api/groupes
→ `{ "groupes": [ { code, nom, role, nbMembres, verset|null } ] }` — mes groupes.

### GET /api/groupes/{code}
**Membres seulement** (403 sinon).
→ `{ "groupe": { code, nom, role, nbMembres,
  "membres": [ { "pseudo", "role" } ], verset|null } }`
(les membres n'exposent que pseudo et rôle — **jamais les e-mails**)

### POST /api/groupes/{code}/verset
**Responsable seulement** (403 sinon). Corps : `{ "reference": "…" (1–60),
"texte": "…" (1–500) }` — pose le verset de la semaine (remplace le précédent,
`depuis` est horodaté par le serveur). → `{ "groupe": { … } }`

### POST /api/groupes/{code}/identite
**Responsable seulement** (403 sinon). Corps : `{ "style": "classique" |
"moderne" | "solennelle", "taille": "discrete" | "posee" | "majestueuse" }` —
la mise en forme du nom sur la page Mon église. Des **mots-clés à liste
blanche**, rendus par des classes CSS : jamais une police ni une taille
libres (400 hors liste). Le payload d'un groupe porte `nomStyle` et
`nomTaille` (défauts : classique / posee). → `{ "groupe": { … } }`

### POST /api/groupes/{code}/passation
**Responsable seulement** (403 sinon). Corps : `{ "pseudo": "…" }` — confie
la responsabilité au membre portant ce pseudo (la seule identité que le
groupe expose). L'appelant devient simple membre. 404 si aucun **autre**
membre ne porte ce pseudo ; 409 si deux le portent (homonymes : l'un doit
d'abord changer de pseudo). Les deux écritures du rôle passent par
l'entonnoir unique `groupe_set_responsable` — le même que l'héritage à la
suppression d'un compte. → `{ "groupe": { …, "role": "membre" } }`

### DELETE /api/groupes/{code}/membres/moi
Quitter le groupe. → `{ "ok": true }` — un responsable ne peut pas quitter
tant qu'il reste d'autres membres (400 : il transmet d'abord la
responsabilité, voir la passation ci-dessus) ; s'il est le dernier, le
groupe est supprimé avec lui. 404 si l'on n'est pas membre.

### DELETE /api/groupes/{code}
**Responsable seulement** (403 sinon) : supprime le groupe et toutes ses
adhésions. → `{ "ok": true }`

À la suppression d'un compte (`DELETE /api/me` ou administration) : ses
adhésions sont retirées ; pour chaque groupe dont il était responsable, le
groupe est supprimé s'il y était seul, sinon le **membre restant le plus
ancien** est promu responsable — l'assemblée ne reste jamais sans berger.

## Quiz d'église : la banque par groupe (fondations — aucune interface)

Chaque église (groupe) choisit ce que **ses** quiz utilisent : toute la banque
commune (mode `toutes`, défaut), une **sélection** de celle-ci (mode
`selection`), et/ou ses **propres questions** (id `egl-…`, écrites par le
responsable). Règle absolue : cela ne touche **que** les quiz lancés dans
l'église (`POST /api/veillees` avec `groupe`) — le Défi du jour et le solo
des membres restent **mondiaux**.

Lecture aux **membres** du groupe, écriture au **responsable** seul
(403 sinon). Le payload `quiz` commun : `{ "mode": "toutes" | "selection",
"nbSelection", "nbPropres", "nbTotal" }` — `nbTotal` est la taille de la
banque **résultante** (commune retenue + questions propres actives), celle où
tirera un quiz d'église.

### GET /api/groupes/{code}/quiz
**Membres seulement.** → `{ "quiz": { … } }`

### POST /api/groupes/{code}/quiz/mode
Corps : `{ "mode": "toutes" | "selection" }` → `{ "quiz": { … } }`

### PUT /api/groupes/{code}/quiz/selection
Corps : `{ "ids": [ "gen-01", … ] }` — **remplace** la sélection entière
(2000 ids au maximum, doublons fondus). Chaque id doit exister dans la banque
commune fusionnée — 400 sinon, l'id fautif est nommé dans l'erreur.
→ `{ "quiz": { … } }` — la sélection se pose même en mode `toutes` (elle ne
compte dans `nbTotal` qu'en mode `selection`).

### GET /api/groupes/{code}/quiz/questions
Les questions **propres** du groupe — **responsable seul** (elles portent la
bonne réponse). → `{ "questions": [ { "id", "categorie", "niveau",
"question", "options", "bonne", "reference" } ] }`

### POST /api/groupes/{code}/quiz/questions
Créer (sans `id` → généré `egl-<6 hex>`) ou modifier (`id` en `egl-` du
groupe — 404 s'il n'y est pas) une question propre. Validations
**strictement identiques** à `POST /api/admin/questions` (catégorie du
fichier, niveau 1–3, longueurs, 4 options, `bonne` 0–3). Plafond : 300
questions propres par groupe. → `{ "question": { … } }`

### DELETE /api/groupes/{code}/quiz/questions/{id}
Supprime la question propre **pour de bon** (pas de désactivation ici).
→ `{ "ok": true }` — 404 si l'id n'est pas une question du groupe.

### Le quiz dans l'église
`POST /api/veillees` avec `{ "groupe": "GRP-XXXXX" }` (voir la section
Veillées) : réservé au **responsable** du groupe (403 sinon), tirage dans la
banque du groupe, et l'état de la veillée porte `"eglise": "<nom du groupe>"`
pour le grand écran. Le lien vit dans la table `veillee_groupes` — la table
`veillees` n'est pas modifiée.

À la suppression du groupe (route DELETE, dernier membre qui part,
suppression de compte) : réglages, sélection, questions propres et liens
veillée ↔ groupe sont **purgés** ; une veillée liée survit, simplement sans
`eglise`. À la **passation** (volontaire ou par héritage), les réglages du
groupe sont conservés.

## Banques d'église par épreuve (quiadit, ecritoupas, portrait)

Le pendant du quiz d'église pour les trois épreuves « à fichier »
(banques.php) : par couple (groupe, module), un mode `toutes`/`selection`,
une sélection d'ids de la banque commune, et des items **propres** (id
`egl-<6 hex>`), validés par les **mêmes règles** que ceux de
l'administration (`banque_item_propre`). Tables `groupe_banques` et
`groupe_banque_items` (étape 2 des migrations, `schema_migrations`).

**TOUT est réservé au responsable, lecture comprise** (403 sinon — les items
portent la bonne réponse, un membre pourrait tricher avant la veillée).
Module inconnu → 404. Plafonds : 2000 ids de sélection, 300 items propres
par (groupe, module).

### GET /api/groupes/{code}/banques/{module}
→ `{ "banque": { "module", "mode", "selection": [ids], "nbSelection",
"nbCommune", "nbPropres", "nbTotal", "items": [ { "id", …champs du
module } ] } }` — la sélection est recoupée avec la banque commune du
moment (un item retiré par l'administration en disparaît sans bruit).

### POST /api/groupes/{code}/banques/{module}/mode
Corps : `{ "mode": "toutes" | "selection" }` — la sélection est **gardée**
en changeant de mode. → `{ "banque": { … } }`

### PUT /api/groupes/{code}/banques/{module}/selection
Corps : `{ "ids": [ … ] }` — **remplace** la sélection (doublons fondus) ;
les ids absents de la banque commune sont **écartés sans erreur**.
→ `{ "banque": { … } }`

### POST /api/groupes/{code}/banques/{module}/items
Créer (sans `id`) ou modifier (`id` en `egl-` du groupe — 404 sinon) un
item propre, au format du module (quiadit : parole/options[4]/bonne/
reference/contexte ; ecritoupas : phrase/ecrit/reference/precision ;
portrait : reponse/accepte[]/genre/indices[5]/reference).
→ `{ "item": { "id", … } }` (201 à la création)

### DELETE /api/groupes/{code}/banques/{module}/items/{id}
→ `{ "ok": true }` — 404 si l'item n'est pas de ce groupe.

### GET /api/groupes/{code}/banque/{module}
La banque **fusionnée** de l'église, au **même format** que la banque
publique `/api/banque/{module}` : `{ "version", "items": [ … ] }` —
banque commune (entière ou sélection, selon le mode) + items propres.
C'est elle que chargent les pages d'épreuves pour animer « dans mon
église » (`?eglise=GRP-XXXXX`) — seul le fetch change, les moteurs de
défis et veillées sont inchangés. À la suppression du groupe, tout est
purgé (`groupe_banques_purge`).

## Ce que l'église propose : packs de versets et chemins de lecture

Table `groupe_propositions` (étape 5). Deux genres, une seule forme :
- `pack` — `contenu: { versets: [ { reference, texte } ] }` (1 à 50). Les
  versets vivent DANS la proposition : ils ne viennent pas forcément de
  `data/verses.json`, l'équipe écrit ce qu'elle veut offrir.
- `lecture` — `contenu: { livres: [ id… ] }` (1 à 66, doublons fondus,
  ordre conservé). Chaque id doit exister dans `lire/data/{id}.json` —
  liste blanche déduite des fichiers, 400 sinon.

Le pacte : l'équipe (responsable + co-responsables) **propose**, tout membre
**lit**, et **adopter est strictement LOCAL** — rien ne remonte jamais, aucune
route ne dit qui a adopté quoi ni où il en est. Un pack adopté devient une
collection du parcours (ses versets sont rangés sur l'appareil et fondus dans
la bibliothèque) ; un chemin adopté devient un plan du module Marcher. Le
genre ne change jamais après création (404). Plafond : 20 par groupe et par
genre. À la suppression du groupe, tout est purgé — mais ce qu'un membre a
adopté lui reste : c'est son parcours.

### GET /api/groupes/{code}/propositions
**Membres seulement.** → `{ "propositions": [ { "id", "genre", "titre",
"description", "contenu", "date" } ] }`

### POST /api/groupes/{code}/propositions
**Équipe seulement** (403 sinon). Sans `id` → création (201), avec `id` →
modification du même genre (404 sinon). → `{ "proposition": { … } }`

### DELETE /api/groupes/{code}/propositions/{id}
**Équipe seulement.** → `{ "ok": true }` — 404 hors du groupe.

## La page de l'église : annonces, rendez-vous, services (l'onglet « Mon église » les affiche)

Chaque groupe-église a sa « page », trois blocs : les **annonces** du
responsable (épinglables en tête), les **rendez-vous réguliers** de
l'assemblée (« Culte, dimanche 10:30 ») et les **services** ponctuels
(« Nettoyage de la salle, samedi »). L'esprit maison : le responsable
**nourrit**, il ne surveille pas ; le service est **volontaire** — on lève
la main, on n'est pas réquisitionné.

**Lecture** pour tout **membre** du groupe, **écriture** pour le
**responsable** seul — sauf l'inscription aux services, ouverte à tout
membre. 403 sinon, 404 groupe inconnu. Les pseudos des inscrits sont
visibles des membres — **jamais les e-mails**.

### GET /api/groupes/{code}/page
Tout d'un coup (membres seulement) :
→ `{ "annonces": [ { "id", "titre", "texte", "epingle", "date": "ISO" } ],
"rdv": [ { "id", "libelle", "jour": 0–6 (0 = dimanche), "heure": "HH:MM", "lieu"|null } ],
"services": [ { "id", "titre", "date": "AAAA-MM-JJ", "details"|null, "places",
"inscrits": [pseudos], "jeSuisInscrit": true|false } ] }`
- annonces : les épinglées d'abord, puis les plus récentes — 50 au plus ;
- rdv : triés par jour puis heure (puis `ordre`, champ d'affichage facultatif) ;
- services : **à venir seulement** (aujourd'hui compris), triés par date ;
  `inscrits` dans l'ordre des mains levées ;
- ménage opportuniste à chaque lecture : les services passés depuis plus de
  **90 jours** sont supprimés, inscriptions comprises.

### POST /api/groupes/{code}/annonces
**Responsable seulement.** Corps : `{ "id"?, "titre" (1–80), "texte" (1–2000),
"epingle"? (défaut false) }` — sans `id` → création (201 ; plafond **100**
annonces par groupe → 400), avec `id` → modification (200 ; 404 si l'annonce
n'est pas de ce groupe). → `{ "annonce": { … } }`

### DELETE /api/groupes/{code}/annonces/{id}
**Responsable seulement.** → `{ "ok": true }` — 404 si inconnue dans ce groupe.

### POST /api/groupes/{code}/rdv
**Responsable seulement.** Corps : `{ "id"?, "libelle" (1–80), "jour" (0–6,
0 = dimanche), "heure" ("HH:MM"), "lieu"? (0–80), "ordre"? (0–999, défaut 0) }`
— création (201 ; plafond **30** par groupe → 400) ou modification (200).
→ `{ "rdv": { … } }`

### DELETE /api/groupes/{code}/rdv/{id}
**Responsable seulement.** → `{ "ok": true }` — 404 si inconnu dans ce groupe.

### POST /api/groupes/{code}/services
**Responsable seulement.** Corps : `{ "id"?, "titre" (1–80), "date"
("AAAA-MM-JJ", jour valide et non passé), "details"? (0–500), "places" (1–50) }`
— création (201 ; plafond **100** services à venir par groupe → 400) ou
modification (200 ; on ne réduit jamais `places` sous le nombre de mains déjà
levées → 400). → `{ "service": { … } }`

### DELETE /api/groupes/{code}/services/{id}
**Responsable seulement** : supprime le service **avec ses inscriptions**.
→ `{ "ok": true }` — 404 si inconnu dans ce groupe.

### POST /api/groupes/{code}/services/{id}/inscription
**Tout membre** lève la main. → `{ "service": { … } }` — 409 si déjà inscrit
ou si le service est complet (`places` atteint), 400 si la date est passée.

### DELETE /api/groupes/{code}/services/{id}/inscription
**Tout membre** se retire librement. → `{ "service": { … } }` — 404 s'il
n'était pas inscrit.

À la **suppression du groupe** (route DELETE, responsable dernier membre qui
part, suppression de compte), toute la page part avec lui : annonces,
rendez-vous, services et inscriptions. À la **suppression d'un compte**, ses
inscriptions aux services sont retirées — une place se libère, simplement.

## Notifications — le verset offert

Chaque jour, à l'heure choisie, une notification push **offre** un verset
(titre + texte + référence). Philosophie non négociable : la notification
**donne, elle ne réclame jamais rien** — pas de « viens faire ta session »,
pas de « tu as manqué hier » ; l'utilisateur l'active et la désactive
librement, et son silence n'entraîne jamais de relance.

Le compte est **facultatif** : un abonnement anonyme reçoit la bibliothèque
(`data/verses.json`) en rotation déterministe par jour de l'année ; un
abonnement relié à un compte qui a un jardin synchronisé (blob `memo`) reçoit
**un verset de son jardin** — celui dont la révision (`due`) est la plus
proche : l'offrir, c'est déjà l'arroser.

La seule notification **d'église** (décision produit) : le **rappel de MON
service, la veille au soir** — « tu as levé la main pour demain ». Elle sert
le membre dans son propre engagement, jamais l'assemblée pour le faire
revenir. Une fois par inscription (`rappel_envoye` marqué **avant** l'envoi,
comme les défis : rater vaut mieux que harceler), entre 17 h et 22 h locales
la veille, et seulement si les notifications de l'appli sont déjà actives —
lever la main n'abonne personne. Écartés délibérément : rappels des
rendez-vous réguliers, « il reste des places », arrivée d'un membre, et tout
« tu n'es pas venu ».

Toute la pile est maison (RFC 8291 aes128gcm + RFC 8292 VAPID, en PHP pur,
validée à l'octet près contre l'annexe A du RFC 8291 — voir
`api/tests/push-crypto-test.php`). Les clés VAPID et la clé du cron sont
**auto-générées** au premier besoin et rangées en base (table `vapid`) :
aucune variable d'environnement à configurer.

### GET /api/push/cle
Génère les clés VAPID si besoin, puis :
→ `{ "vapidPublicKey": "<clé P-256 brute en base64url>" }` — à décoder en
`Uint8Array` pour `pushManager.subscribe({ applicationServerKey })`.

### POST /api/push/subscribe
Connecté **ou anonyme** (le token, s'il est présent, relie l'abonnement au
compte). Plafond : 30/heure/IP (scope `push`). Corps :
`{ "subscription": { "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" } },
"heure": 0–23 (8), "tz": <getTimezoneOffset(), minutes> }`
→ `{ "ok": true }` — un abonnement par endpoint (REPLACE : re-poster change
l'heure ou rattache le compte). 400 si l'endpoint n'est pas en https ou si
les clés ne se décodent pas (p256dh : 65 octets, auth : 16 octets).

### POST /api/push/unsubscribe
Corps : `{ "endpoint": "https://…" }` → `{ "ok": true }` — **sans
authentification** : connaître l'endpoint suffit, il est secret par nature
(seuls le navigateur abonné et notre base le connaissent). Idempotent.

### GET /api/cron/notify?key=CRON_KEY
Appelé **toutes les heures** par un cron externe (voir `api/README.md`).
La clé s'affiche dans `GET /api/health` (admins), avec l'URL prête à copier.
Pour chaque abonnement dont l'heure **locale** courante (via `tz_offset`)
vaut `heure` et qui n'a rien reçu aujourd'hui (dans **son** fuseau) : verset
choisi puis envoyé. `last_sent_day` est posé **avant** l'envoi (idempotent :
relancer dans l'heure ne renvoie rien). 404/410 du service push → abonnement
supprimé ; autre échec → `echecs + 1` (supprimé au 5e).
→ `{ "ok": true, "envoyes": n, "supprimes": m }` — clé fausse ou absente → 403.

À la suppression d'un compte, ses abonnements sont **détachés** (`user_id`
→ NULL), pas supprimés : l'appareil a activé les notifications
indépendamment du compte et continue de recevoir la rotation générique ;
la désactivation reste possible à tout moment dans l'écran Moi.

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

### GET /api/banque/{module}
Public, sans authentification. `module` ∈ `quiadit` | `ecritoupas` |
`portrait` (liste blanche — tout autre → 404).
→ `{ "version", "items": [banque fusionnée] }` — les items gardent la
structure du fichier du module ({module}/data/banque.json) : ceux du fichier
d'abord (remplacés par leur surcharge active, retirés si surcharge inactive),
puis les ajouts `adm-` actifs. Les pages d'épreuve l'essaient d'abord
(copie locale en localStorage, rafraîchie en arrière-plan) et retombent sur
leur fichier statique hors-ligne.

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

### POST /api/admin/banque/{module}
Créer ou modifier un item de la banque du module (mêmes règles d'id que le
quiz : sans `id` → ajout `adm-<6 hex>` ; `id` du fichier → surcharge ;
`id` en `adm-` → modification ; autre → 404). Corps = l'item du module,
validé strictement selon sa structure — bornes alignées sur les moteurs
d'épreuve pour qu'un item ajouté ne puisse jamais casser une partie :
- `quiadit` : `parole` ≤ 300, `options` exactement 4 (≤ 90 chacune),
  `bonne` 0–3, `reference` requise ≤ 60, `contexte` optionnel ≤ 300 ;
- `ecritoupas` : `phrase` ≤ 300, `ecrit` booléen strict, `reference`
  requise (≤ 60) si `ecrit` est vrai, `precision` optionnelle ≤ 300 ;
- `portrait` : `reponse` ≤ 60, `accepte` non vide (entrées ≤ 60),
  `genre` ∈ personnage|lieu|chose, `indices` exactement 5 (≤ 240 chacun),
  `reference` requise ≤ 60.
Les champs hors structure sont rejetés à la reconstruction (rien d'étranger
n'entre en base ni ne ressort). Tracé dans admin_log.
→ `{ "item": { … } }` (l'item enregistré, id inclus)

### DELETE /api/admin/banque/{module}/{id}
Comme le quiz : id du fichier → surcharge `actif = 0` (désactivé,
réversible) ; id `adm-` → suppression réelle. → `{ "ok": true }` — 404 sinon.

### POST /api/admin/banque/{module}/{id}/restore
Retire la surcharge : la version du fichier redevient active.
→ `{ "ok": true }` — 404 s'il n'y a rien à retirer.

### GET /api/admin/journal
Le **journal serveur** (onglet « Activité ») : les 100 derniers événements du
parcours de connexion, les plus récents d'abord.
→ `{ "events": [ { "ts": "ISO", "event": "…", "email": "…"|null, "detail": "…"|null } ] }`
Événements tracés (table `journal`, helper `journal_log` — qui ne casse
JAMAIS le flux principal) :
- `code_demande` : demande de code acceptée (quotas passés), **avant** l'envoi ;
- `code_envoye` : l'e-mail est réellement parti (Brevo/SMTP). En **mode dev**
  (aucun envoi configuré, `devCode` dans la réponse), seul `code_demande` est
  enregistré : `code_envoye` ne trace que de **vrais** envois ;
- `code_echec_envoi` : échec d'envoi (detail = raison courte, statut HTTP +
  début de la réponse du fournisseur — jamais la clé API) ;
- `code_verifie_ok` : connexion réussie ; `code_incorrect` : mauvais code ;
- `compte_cree` (detail = pseudo), `connexion_google`, `compte_supprime`.
L'e-mail est stocké **en clair** (l'admin voit déjà les adresses des comptes ;
c'est ce qui permet d'aider quelqu'un de bloqué) mais chaque écriture **purge
les entrées de plus de 30 jours** — le journal ne s'accumule jamais.

### GET /api/admin/brevo
La **remontée Brevo** (onglet « Activité ») : le serveur appelle
`GET https://api.brevo.com/v3/smtp/statistics/events?limit=100&sort=desc`
(clé `BREVO_API_KEY`, timeout 15 s) et renvoie une liste simplifiée :
→ `{ "events": [ { "ts": "…", "email": "…", "event":
"requests|delivered|opened|clicks|softBounces|hardBounces|blocked|spam|…",
"subject": "…" } ] }`
Robustesse : `BREVO_API_KEY` absente → `{ "events": [], "note": "Brevo non
configuré" }` ; erreur réseau ou HTTP → `{ "events": [], "note": "Brevo
injoignable pour le moment" }` — **toujours en 200** (l'admin voit la note,
rien ne casse) ; le parsing de la réponse Brevo est défensif (champs
date/email/event/subject avec repli). La clé API ne sort **jamais**.

## Backend — notes d'implémentation

- PHP 8 + PDO. `MYSQL_URL` (Railway) ; **repli SQLite** (`api/data/dev.sqlite`)
  si absent → tests locaux possibles avec `php -S`.
- Migrations auto au premier appel (CREATE TABLE IF NOT EXISTS).
- Tables : `users`, `login_codes`, `sessions`, `sync_blobs`, `friendships`, `throttle`, `admin_log`,
  `duels`, `veillees`, `veillee_players`, `veillee_answers`, `quiz_questions`,
  `groupes`, `groupe_membres`, `groupe_annonces`, `groupe_rdv`,
  `groupe_services`, `groupe_service_inscriptions`, `vapid`, `push_abonnements`,
  `groupe_quiz_reglages`, `groupe_quiz_selection`, `groupe_questions`,
  `veillee_groupes`, `journal`.
- Rôle admin : `ADMIN_EMAILS` (adresses séparées par des virgules, casse
  ignorée) — pas de colonne en base, le rôle se retire en éditant la variable.
- E-mail : SMTP via env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `MAIL_FROM`) — sinon mode dev (`devCode` dans la réponse).
- Connexion Google : `GOOGLE_CLIENT_ID` (client OAuth « application Web » ;
  le domaine du site en origine JavaScript autorisée). Jamais de secret :
  seul le jeton d'identité est vérifié, via l'endpoint tokeninfo de Google.
- Tokens : 32 octets aléatoires hex. Codes : 6 chiffres, hachés en base.
