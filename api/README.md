# API Bible Horizon — installation & exploitation (Railway)

Backend PHP classique (pas de framework, pas de Composer) qui ajoute à la PWA :
comptes par code e-mail **ou compte Google**, synchronisation, amis par code,
duels asynchrones et **veillées en direct** (grand écran + téléphones).
Les fondations serveur des **groupes d'église** (code `GRP-XXXXX`, verset de
la semaine poussé par le responsable) sont posées — encore aucune interface.
La **page de l'église** aussi (`groupes-page.php`) : annonces épinglables,
rendez-vous réguliers et services volontaires où chaque membre lève la main.
Le contrat complet des routes est dans [`../API-CONTRAT.md`](../API-CONTRAT.md).

## Comment c'est construit

- **FrankenPHP** (`dunglas/frankenphp`) : c'est Caddy avec PHP intégré — le
  site statique est servi exactement comme avant, et le `Caddyfile` réécrit
  toutes les requêtes `/api/*` vers l'unique point d'entrée `api/index.php`.
  Aucun autre fichier `.php` n'est jamais exécuté directement.
- **Base de données** : MySQL si la variable `MYSQL_URL` existe, sinon repli
  automatique sur SQLite (`api/data/dev.sqlite`) pour les tests locaux.
  Les tables sont créées automatiquement au premier appel.
- **Fichiers** : `index.php` (routage) → `auth.php`, `sync.php`, `friends.php`,
  `groupes.php`, `groupes-quiz.php` (la banque de questions par église),
  `groupes-page.php` (la page de l'église : annonces, rendez-vous, services),
  `duels.php`, `veillees.php`, `admin.php`, `push.php` (les routes),
  avec `db.php` (connexion + migrations), `mail.php` (envoi des codes),
  `helpers.php` (fonctions partagées). `push.php` embarque la crypto Web Push
  complète (RFC 8291 + VAPID RFC 8292) en PHP pur — validée à l'octet près
  contre l'annexe A du RFC 8291 par `tests/push-crypto-test.php`.

## Installation sur Railway

### 1. La base MySQL

1. Dans le projet Railway : **+ New → Database → MySQL**.
2. Dans le service de l'application : **Variables → New Variable**, ajouter
   une *référence* nommée `MYSQL_URL` pointant vers la variable `MYSQL_URL`
   du service MySQL (syntaxe Railway : `${{MySQL.MYSQL_URL}}`).

C'est tout : au premier appel de l'API, les tables sont créées toutes seules.

### 2. L'envoi des codes par e-mail

Deux options — **l'une OU l'autre**, au choix :

**Option A — Brevo (recommandée, la plus simple).**
Créer un compte sur [brevo.com](https://www.brevo.com) (300 e-mails/jour
gratuits), générer une clé API (SMTP & API → API Keys), puis définir :

| Variable | Exemple | Rôle |
|---|---|---|
| `BREVO_API_KEY` | `xkeysib-…` | clé API Brevo |
| `MAIL_FROM` | `no-reply@mondomaine.fr` | adresse d'expéditeur (validée chez Brevo) |

**Option B — SMTP classique** (n'importe quel fournisseur : Brevo SMTP, OVH…) :

| Variable | Exemple | Rôle |
|---|---|---|
| `SMTP_HOST` | `smtp-relay.brevo.com` | serveur SMTP |
| `SMTP_PORT` | `587` (STARTTLS, défaut) ou `465` (TLS) | port |
| `SMTP_USER` | `…` | identifiant |
| `SMTP_PASS` | `…` | mot de passe |
| `MAIL_FROM` | `no-reply@mondomaine.fr` | adresse d'expéditeur |

Si `BREVO_API_KEY` est définie, elle a la priorité sur SMTP.

> **Important — mode dev :** si NI `BREVO_API_KEY` NI `SMTP_HOST` ne sont
> définies, l'API passe en mode développement : le code de connexion est
> renvoyé directement dans la réponse HTTP (`devCode`). Pratique en local,
> **à ne jamais laisser en production** — vérifier avec `/api/health` que
> `"mail"` ne vaut pas `"dev"`.

### 3. La connexion Google (facultative)

Sans elle, tout marche déjà par code e-mail. Pour proposer en plus le bouton
« Continuer avec Google » :

1. [console.cloud.google.com](https://console.cloud.google.com) → créer un
   projet (ou en réutiliser un) → **APIs & Services → Credentials →
   Create credentials → OAuth client ID** → type **Web application**.
2. Dans **Authorized JavaScript origins**, ajouter l'adresse du site
   (ex. `https://mon-domaine.up.railway.app`) — et `http://localhost:8080`
   pour tester en local. Pas de redirect URI à déclarer.
3. Copier le **Client ID** (se termine par `.apps.googleusercontent.com`)
   dans une variable Railway :

| Variable | Exemple | Rôle |
|---|---|---|
| `GOOGLE_CLIENT_ID` | `1234…abc.apps.googleusercontent.com` | active le bouton Google |

Aucun secret à stocker : le site ne reçoit qu'un **jeton d'identité**, que le
serveur revérifie auprès de Google. Le bouton apparaît tout seul dès que la
variable est définie (`GET /api/config` permet de vérifier). Un compte Google
et un compte e-mail avec la **même adresse** sont **le même compte**.

### 4. Les administrateurs (facultatif)

| Variable | Exemple | Rôle |
|---|---|---|
| `ADMIN_EMAILS` | `moi@mondomaine.fr, elle@mondomaine.fr` | adresses admin, séparées par des virgules (casse ignorée) |

Les comptes dont l'e-mail figure dans la liste voient une carte
« Administration » dans l'écran Moi et accèdent à l'adresse **`/admin/`** :
liste et suppression des comptes, et gestion de la banque de questions du
Défi. Le fichier `defi/data/questions.json` est embarqué dans l'image et le
système de fichiers de Railway est éphémère : les retouches (éditions,
désactivations, ajouts) vivent donc en base, dans la table `quiz_questions`,
et tout le monde (Défi, duels, veillées) tire dans la banque fusionnée servie
par `GET /api/questions`. Pas de colonne en base : retirer une adresse de la
variable retire le rôle.

### 5. Le cron des notifications (« le verset offert »)

Les notifications push quotidiennes n'exigent **aucune variable** : les clés
VAPID et la clé secrète du cron sont générées automatiquement au premier
besoin et rangées en base (table `vapid`). Il ne reste qu'à faire appeler
cette URL **une fois par heure** (c'est elle qui repère, à chaque passage,
les abonnés dont c'est l'heure locale) :

```
https://<mon-domaine>/api/cron/notify?key=<CRON_KEY>
```

**Où trouver la clé ?** Se connecter dans l'appli avec un compte admin, puis
ouvrir `https://<mon-domaine>/api/health` : le bloc `push` contient
`cronKey` et surtout `cronUrl`, l'URL complète prête à copier.

**Comment l'appeler toutes les heures ?** Deux options :

- **Service cron dans Railway** : dans le projet, **+ New → Empty Service**,
  y définir un *Cron Schedule* `0 * * * *` (Settings → Cron Schedule) et une
  image minimale qui lance :
  `curl -fsS "https://<mon-domaine>/api/cron/notify?key=<CRON_KEY>"`
  (par exemple l'image `curlimages/curl` avec cette commande en Start Command).
- **Pinger externe** (le plus simple) : un compte gratuit chez
  [cron-job.org](https://cron-job.org) (ou UptimeRobot et semblables), une
  tâche « toutes les heures » sur l'URL ci-dessus. Rien à déployer.

La route est **idempotente** (chaque abonné reçoit au plus un verset par jour,
dans son fuseau — le jour est marqué avant l'envoi) : un appel en double ou
un cron trop zélé ne spamme personne. Clé fausse → 403. La réponse
`{ "ok": true, "envoyes": n, "supprimes": m }` compte les versets offerts et
les abonnements morts retirés (404/410 du service push, ou 5 échecs de suite).

### 6. Vérifier que tout marche

Ouvrir `https://<mon-domaine>/api/health` :

```json
{ "ok": true }  // le détail (db, mail…) s'affiche si on est connecté en admin
```

- `db` : `"mysql"` en production (`"sqlite"` = `MYSQL_URL` absente) ;
- `mail` : `"brevo"` ou `"smtp"` en production (`"dev"` = aucun envoi configuré) ;
- `reseau` : le diagnostic du relais — voir juste en dessous ;
- une erreur 500 « Base de données injoignable » = revoir la variable `MYSQL_URL`.

#### Le nombre de relais (`PROXY_HOPS`)

Les plafonds anti-abus (30 demandes de code par heure et par adresse, entre
autres) comptent **par adresse IP** : encore faut-il retenir la bonne.
`X-Forwarded-For` s'écrit « client, relais1, relais2 » — chaque relais ajoute
**à droite** l'adresse dont il a reçu la connexion. Le début de la chaîne vient
donc du visiteur et se forge en une ligne de commande ; seules les dernières
valeurs, écrites par nos relais, sont dignes de foi. L'API lit la
`PROXY_HOPS`-ième **en partant de la droite**.

| Variable | Exemple | Rôle |
|---|---|---|
| `PROXY_HOPS` | `1` (défaut, cas de Railway) | nombre de relais de confiance devant l'application ; `0` = aucun relais, `X-Forwarded-For` alors totalement ignoré |

Un garde-fou complète le réglage : si la valeur ainsi désignée est une adresse
**privée, réservée ou en `100.64.0.0/10`** (l'espace partagé des répartiteurs
d'hébergeurs), c'est un relais interne de plus que prévu — l'API poursuit alors
vers la gauche jusqu'à la première adresse **publique**. Un `PROXY_HOPS` trop
**petit** se rattrape ainsi de lui-même, tant que le relais le plus extérieur
inscrit bien l'adresse publique du visiteur. Une entrée illisible (`unknown`,
en-tête tronqué) arrête net la lecture et l'adresse retombe sur `REMOTE_ADDR` :
on ne devine jamais.

Le contrôle se fait dans l'**administration → Système → Réseau** : `/api/health`
n'est lisible qu'avec un jeton, l'ouvrir dans la barre d'adresse ne donne que
`{"ok":true}`.

L'écran **Système → Réseau** de l'administration montre l'en-tête reçu,
l'adresse de la connexion, le `PROXY_HOPS` en vigueur et l'**adresse retenue** —
celle qui sert de compteur. On l'ouvre depuis deux réseaux différents (le wifi,
puis le téléphone en 4G) : l'adresse retenue doit **changer**, et valoir
l'adresse publique de la connexion. Si elle ne change pas, `PROXY_HOPS` est
**trop grand** : tout le monde partage alors un seul compteur et de vraies
personnes se retrouvent bloquées. Si aucun en-tête n'est reçu alors que
`PROXY_HOPS` vaut 1 ou plus, c'est qu'aucun relais ne se signale : mettre la
variable à **0**. L'écran signale ces deux cas de lui-même. Corriger la
variable suffit — aucun redéploiement du code.

Puis, dans l'appli : écran Moi → entrer son e-mail → recevoir le code →
se connecter, et vérifier que le code ami (GRN-XXXX) s'affiche.

## Tests en local (sans Docker, sans MySQL)

```bash
# Depuis la racine du projet — SQLite + mode dev automatiquement :
php -S 127.0.0.1:8180 api/tests/router.php
# puis ouvrir http://127.0.0.1:8180 (le devCode s'affiche dans la réponse
# de /api/auth/request-code, onglet Réseau du navigateur)

# Ou dérouler tout le parcours automatiquement (php, curl et jq requis) :
bash api/tests/run-tests.sh
```

La base locale (`api/data/dev.sqlite`) peut être supprimée à tout moment :
elle sera recréée vide au prochain appel.

## Sécurité — ce qui est en place

- Codes de connexion à 6 chiffres **hachés** en base (`password_hash`),
  validité 10 min, 5 essais max, 3 demandes/heure/e-mail.
- Tokens de session : 32 octets aléatoires (64 hex), validité ~90 jours.
- Requêtes SQL **préparées partout** ; entrées validées strictement ;
  erreurs en français sans jamais exposer de trace technique.
- La bonne réponse d'un duel n'est jamais envoyée avant d'avoir joué,
  et le score est toujours recalculé côté serveur.
- Suppression de compte = effacement total (profil, synchro, amitiés,
  duels, sessions, codes).

## Lancer les tests

```bash
# SQLite seul — rapide, rien à installer
bash api/tests/run-tests.sh

# Les DEUX dialectes : SQLite puis MySQL (celui de la production)
BH_TEST_MYSQL_URL='mysql://user:pass@127.0.0.1:3306/bh_test' \
  bash api/tests/run-tests-dialectes.sh
```

`db_migrate()` porte **deux blocs DDL distincts** qui divergent réellement
(ENUM contre CHECK, sémantique de `rowCount()`, types de dates). Ne jouer que
SQLite revient à déployer le bloc MySQL sans l'avoir jamais exécuté — alors
que la production tourne sur MySQL. **Avant tout déploiement qui touche à la
base, jouer les deux.**

La base MySQL indiquée est **vidée à chaque passe** : ne jamais y pointer une
base contenant quoi que ce soit d'utile. Une seconde base suffixée `_mig` (ici
`bh_test_mig`) sert au contrôle de migration et doit être accessible au même
compte.

### Les veillées dans un vrai navigateur

Une veillée se joue sur **trois écrans à la fois** : le téléphone de
l'animateur, le vidéoprojecteur, les téléphones des participants. L'API ne peut
rien dire de ce que voit la salle — et c'est là que les défauts font mal. Un
scénario Playwright (`api/tests/navigateur/veillees.mjs`) ouvre donc Chromium et
joue une veillée pour chaque module : le Défi dans ses **deux configurations
d'écran** (dont la révélation pendant que l'animateur a l'écran **verrouillé**),
puis les quatre épreuves avec leur projection — en vérifiant au passage
qu'aucune commande d'animateur n'apparaît sur l'écran projeté.

Playwright n'est **pas** une dépendance du dépôt : l'appli n'en a aucune, et un
scénario de test ne va pas lui en imposer une. La suite le cherche à côté, puis
à l'endroit que désigne `BH_PLAYWRIGHT` (un import ESM ne suit pas `NODE_PATH`).
S'il est absent, la suite **le dit** et passe outre.

```bash
BH_PLAYWRIGHT=/chemin/vers/node_modules bash api/tests/run-tests.sh
```

Le scénario ouvre sa propre session d'animateur (mode dev) et donne à chaque
participant son propre contexte de navigateur — c'est-à-dire son téléphone.
