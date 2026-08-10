# API Bible Horizon — installation & exploitation (Railway)

Backend PHP classique (pas de framework, pas de Composer) qui ajoute à la PWA :
comptes par code e-mail **ou compte Google**, synchronisation, amis par code,
duels asynchrones et **veillées en direct** (grand écran + téléphones).
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
  `duels.php`, `veillees.php` (les routes), avec `db.php` (connexion +
  migrations), `mail.php` (envoi des codes), `helpers.php` (fonctions
  partagées).

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

### 4. Vérifier que tout marche

Ouvrir `https://<mon-domaine>/api/health` :

```json
{ "ok": true, "db": "mysql", "mail": "brevo" }
```

- `db` : `"mysql"` en production (`"sqlite"` = `MYSQL_URL` absente) ;
- `mail` : `"brevo"` ou `"smtp"` en production (`"dev"` = aucun envoi configuré) ;
- une erreur 500 « Base de données injoignable » = revoir la variable `MYSQL_URL`.

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
