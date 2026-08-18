#!/usr/bin/env bash
# ============================================================================
# Tests d'intégration de l'API Graine de Parole (SQLite + mode dev).
#
#   bash api/tests/run-tests.sh
#
# Lance `php -S` sur le port 8180 avec le routeur qui simule la réécriture
# Caddy (/api/* → api/index.php), puis déroule le parcours complet du contrat :
# santé → connexion → synchro → amis → duels → veillées → groupes d'église
# → administration → déconnexion → suppression.
# Nécessite : php (>= 8.1), curl, jq.
# ============================================================================

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=8180
BASE="http://127.0.0.1:$PORT"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

say()  { printf '\n== %s\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf '   ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '   FAIL %s\n' "$1"; sed 's/^/        /' "$TMP/body.json" 2>/dev/null; }

# check "description" attendu obtenu
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (attendu: $2, obtenu: $3)"; fi; }

# api METHODE CHEMIN TOKEN CORPS → code HTTP sur stdout, corps dans $TMP/body.json
api() {
  local method=$1 path=$2 token=${3:-} body=${4:-}
  local args=(-s -o "$TMP/body.json" -w '%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data "$body")
  curl "${args[@]}"
}
jval() { jq -r "$1" "$TMP/body.json"; }

# ---------------------------------------------------------------------------
say "Analyse syntaxique (php -l) de chaque fichier PHP"
LINT_OK=oui
for f in "$ROOT"/api/*.php "$ROOT"/api/tests/router.php "$ROOT"/api/tests/push-crypto-test.php; do
  if ! php -l "$f" > /dev/null 2>&1; then LINT_OK=non; php -l "$f"; fi
done
check "php -l sans erreur" oui "$LINT_OK"

# ---------------------------------------------------------------------------
say "Crypto Web Push : vecteur RFC 8291 (annexe A) et JWT VAPID"
if php "$ROOT/api/tests/push-crypto-test.php" > "$TMP/crypto.log" 2>&1; then
  ok "vecteur RFC 8291 reproduit à l'octet près + VAPID vérifié (openssl_verify)"
else
  FAIL=$((FAIL + 1)); printf '   FAIL crypto Web Push\n'; sed 's/^/        /' "$TMP/crypto.log"
fi

# ---------------------------------------------------------------------------
# db_migrate() applique des étapes versionnées tamponnées dans
# schema_migrations. Trois invariants : une base neuve reçoit tout et le
# journal s'arrête à DB_MIGRATION_DERNIERE ; une base déployée d'AVANT le
# journal (schéma présent, pas de tampons) rattrape les étapes récentes sans
# rien casser ; re-migrer une base à jour ne fait rien.
say "Migrations versionnées (journal schema_migrations)"
MIG="$(php -r '
define("GRAINE_API", 1);
require $argv[1] . "/api/db.php";
$pdo = new PDO("sqlite:" . $argv[2]);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
db_migrate($pdo);
$v = (int) $pdo->query("SELECT MAX(version) FROM schema_migrations")->fetchColumn();
if ($v !== DB_MIGRATION_DERNIERE) { echo "journal-incomplet"; exit; }
// Base déployée d avant le journal : schéma là, aucun tampon, étapes 2 et 3
// absentes (les ALTER de l étape 3 ne sont PAS idempotents — c est le journal
// qui garantit leur exécution unique, la simulation doit donc les défaire).
$pdo->exec("DROP TABLE schema_migrations");
$pdo->exec("DROP TABLE groupe_banques");
$pdo->exec("DROP TABLE groupe_banque_items");
$pdo->exec("DROP TABLE groupe_series");
$pdo->exec("ALTER TABLE groupes DROP COLUMN nom_style");
$pdo->exec("ALTER TABLE groupes DROP COLUMN nom_taille");
$pdo->exec("ALTER TABLE groupe_service_inscriptions DROP COLUMN rappel_envoye");
db_migrate($pdo);
$tables = $pdo->query("SELECT name FROM sqlite_master WHERE type = \"table\"")->fetchAll(PDO::FETCH_COLUMN);
if (!in_array("groupe_banques", $tables) || !in_array("groupe_banque_items", $tables)) { echo "rattrapage-manque"; exit; }
$cols = $pdo->query("SELECT name FROM pragma_table_info(\"groupes\")")->fetchAll(PDO::FETCH_COLUMN);
if (!in_array("nom_style", $cols)) { echo "alter-manque"; exit; }
// Base à jour : re-migrer doit être un non-événement.
db_migrate($pdo);
$n = (int) $pdo->query("SELECT COUNT(*) FROM schema_migrations")->fetchColumn();
echo $n === DB_MIGRATION_DERNIERE ? "oui" : "tampons-en-double";
' "$ROOT" "$TMP/deja-deploye.sqlite" 2>>"$TMP/migration.log")"
check "neuve, rattrapage d'avant-journal, à jour : les trois chemins passent" oui "$MIG"

# ---------------------------------------------------------------------------
say "Démarrage du serveur de test (php -S, SQLite, mode dev)"
rm -f "$ROOT"/api/data/dev.sqlite "$ROOT"/api/data/dev.sqlite-*
cd "$ROOT"
env -u MYSQL_URL -u BREVO_API_KEY -u SMTP_HOST ADMIN_EMAILS=alice@example.org \
  php -S 127.0.0.1:$PORT api/tests/router.php > "$TMP/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

UP=non
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "$BASE/api/health"; then UP=oui; break; fi
  sleep 0.1
done
check "serveur de test démarré" oui "$UP"
[ "$UP" = oui ] || { echo "Journal du serveur :"; cat "$TMP/server.log"; exit 1; }

# ---------------------------------------------------------------------------
say "Santé (anonyme : réponse minimale, le détail est réservé aux admins)"
check "GET /api/health → 200"           200     "$(api GET /api/health)"
check "health : ok"                     true    "$(jval .ok)"
check "health anonyme : pas de détail"  null    "$(jval .db)"

say "Statique toujours servi à l'identique"
check "GET / → 200"                     200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
check "GET /defi/data/questions.json"   200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/defi/data/questions.json")"

# ---------------------------------------------------------------------------
say "Connexion — demande de code"
check "e-mail invalide → 400"           400 "$(api POST /api/auth/request-code '' '{"email":"pas-un-email"}')"
check "request-code u1 → 200"           200 "$(api POST /api/auth/request-code '' '{"email":"alice@example.org"}')"
CODE1="$(jval .devCode)"
check "devCode présent (mode dev)"      6   "${#CODE1}"

say "Connexion — vérification du code"
check "mauvais code → 401"              401 "$(api POST /api/auth/verify '' '{"email":"alice@example.org","code":"000000"}')"
[ "$CODE1" = "000000" ] && echo "        (collision improbable : relancer le test)"
check "bon code sans pseudo → 422"      422 "$(api POST /api/auth/verify '' "{\"email\":\"alice@example.org\",\"code\":\"$CODE1\"}")"
check "→ needPseudo: true"              true "$(jval .needPseudo)"
check "pseudo invalide (1 car.) → 422"  422 "$(api POST /api/auth/verify '' "{\"email\":\"alice@example.org\",\"code\":\"$CODE1\",\"pseudo\":\"A\"}")"
check "bon code + pseudo → 200"         200 "$(api POST /api/auth/verify '' "{\"email\":\"alice@example.org\",\"code\":\"$CODE1\",\"pseudo\":\"Aurélie 1\"}")"
TOKEN1="$(jval .token)"
FCODE1="$(jval .user.friendCode)"
check "token de 64 hex"                 64  "${#TOKEN1}"
check "code ami au format GRN-XXXX"     GRN "${FCODE1%-*}"
check "code consommé : rejouer → 400"   400 "$(api POST /api/auth/verify '' "{\"email\":\"alice@example.org\",\"code\":\"$CODE1\"}")"

say "Profil"
check "GET /api/me sans token → 401"    401 "$(api GET /api/me)"
check "GET /api/me → 200"               200 "$(api GET /api/me "$TOKEN1")"
check "→ pseudo"                        "Aurélie 1" "$(jval .user.pseudo)"
check "POST /api/me/pseudo → 200"       200 "$(api POST /api/me/pseudo "$TOKEN1" '{"pseudo":"Alice"}')"
check "→ pseudo mis à jour"             Alice "$(jval .user.pseudo)"

# ---------------------------------------------------------------------------
say "Synchronisation"
check "PUT sync {memo,defi} → 200"      200 "$(api PUT /api/sync "$TOKEN1" '{"memo":{"streak":3,"cartes":["jn-3-16"]},"defi":{"best":5}}')"
check "→ updatedAt ISO"                 Z   "$(jval .updatedAt | tail -c 2)"
check "GET sync → 200"                  200 "$(api GET /api/sync "$TOKEN1")"
check "→ memo.streak = 3"               3   "$(jval .memo.streak)"
check "→ lire = null"                   null "$(jval .lire)"
check "→ defi.best = 5"                 5   "$(jval .defi.best)"
check "PUT sync sans module → 400"      400 "$(api PUT /api/sync "$TOKEN1" '{}')"
python3 -c "print('{\"memo\":{\"x\":\"' + 'a' * 524288 + '\"}}')" > "$TMP/big.json"
check "PUT sync > 512 Ko → 413"         413 "$(api PUT /api/sync "$TOKEN1" "@$TMP/big.json")"
check "GET sync sans token → 401"       401 "$(api GET /api/sync)"

# ---------------------------------------------------------------------------
say "Deuxième et troisième utilisateurs"
api POST /api/auth/request-code '' '{"email":"benoit@example.org"}' > /dev/null
CODE2="$(jval .devCode)"
check "verify u2 → 200"                 200 "$(api POST /api/auth/verify '' "{\"email\":\"benoit@example.org\",\"code\":\"$CODE2\",\"pseudo\":\"Benoît\"}")"
TOKEN2="$(jval .token)"
FCODE2="$(jval .user.friendCode)"
api POST /api/auth/request-code '' '{"email":"chloe@example.org"}' > /dev/null
CODE3="$(jval .devCode)"
api POST /api/auth/verify '' "{\"email\":\"chloe@example.org\",\"code\":\"$CODE3\",\"pseudo\":\"Chloé\"}" > /dev/null
TOKEN3="$(jval .token)"

say "Amis"
check "duel sans amitié → 403"          403 "$(api POST /api/duels "$TOKEN1" "{\"opponentCode\":\"$FCODE2\"}")"
check "u2 ajoute u1 par code → 200"     200 "$(api POST /api/friends/add "$TOKEN2" "{\"code\":\"$FCODE1\"}")"
check "→ friend.pseudo = Alice"         Alice "$(jval .friend.pseudo)"
check "déjà amis → 409"                 409 "$(api POST /api/friends/add "$TOKEN2" "{\"code\":\"$FCODE1\"}")"
check "son propre code → 400"           400 "$(api POST /api/friends/add "$TOKEN2" "{\"code\":\"$FCODE2\"}")"
check "code inconnu → 404"              404 "$(api POST /api/friends/add "$TOKEN2" '{"code":"GRN-1111"}')"
check "code mal formé → 400"            400 "$(api POST /api/friends/add "$TOKEN2" '{"code":"bonjour"}')"
check "amitié mutuelle : u1 voit u2"    "$FCODE2" "$(api GET /api/friends "$TOKEN1" > /dev/null; jval '.friends[0].friendCode')"
check "u1 a exactement 1 ami"           1   "$(jval '.friends | length')"

# ---------------------------------------------------------------------------
say "Duels — création (par u1, contre u2)"
check "adversaire inconnu → 404"        404 "$(api POST /api/duels "$TOKEN1" '{"opponentCode":"GRN-1111"}')"
check "création → 201"                  201 "$(api POST /api/duels "$TOKEN1" "{\"opponentCode\":\"$FCODE2\"}")"
DUEL_ID="$(jval .duel.id)"
check "10 questions"                    10    "$(jval '.duel.questions | length')"
check "4 options par question"          true  "$(jval '[.duel.questions[] | (.options | length) == 4] | all')"
check "bonne réponse JAMAIS envoyée"    false "$(jval '[.duel.questions[] | has("bonne")] | any')"
check "référence pas envoyée non plus"  false "$(jval '[.duel.questions[] | has("reference")] | any')"
check "variété : >= 5 catégories"       true  "$(jval '[.duel.questions[].id | split("-")[0]] | unique | length >= 5')"
QIDS_U1="$(jval '[.duel.questions[].id] | join(",")')"
check "statut créateur : waiting_me"    waiting_me "$(jval .duel.status)"

say "Duels — listes des deux côtés (personne n'a joué)"
check "liste u1 → 200"                  200 "$(api GET /api/duels "$TOKEN1")"
check "u1 : iChallenged = true"         true       "$(jval '.duels[0].iChallenged')"
check "u1 : statut waiting_me"          waiting_me "$(jval '.duels[0].status')"
check "u1 : myScore null"               null       "$(jval '.duels[0].myScore')"
check "liste u2 → 200"                  200 "$(api GET /api/duels "$TOKEN2")"
check "u2 : iChallenged = false"        false      "$(jval '.duels[0].iChallenged')"
check "u2 : statut waiting_me"          waiting_me "$(jval '.duels[0].status')"
check "u2 : opponent = Alice"           Alice      "$(jval '.duels[0].opponent.pseudo')"

say "Duels — détail : mêmes questions, même ordre, pour les deux joueurs"
api GET "/api/duels/$DUEL_ID" "$TOKEN2" > /dev/null
QIDS_U2="$(jval '[.duel.questions[].id] | join(",")')"
check "questions identiques u1/u2"      "$QIDS_U1" "$QIDS_U2"
check "duel d'autrui (u3) → 404"        404 "$(api GET "/api/duels/$DUEL_ID" "$TOKEN3")"

say "Duels — u1 (challenger) joue"
check "réponses incomplètes → 400"      400 "$(api POST "/api/duels/$DUEL_ID/result" "$TOKEN1" '{"answers":[0,1]}')"
check "indice hors bornes → 400"        400 "$(api POST "/api/duels/$DUEL_ID/result" "$TOKEN1" '{"answers":[0,0,0,0,0,0,0,0,0,7]}')"
check "réponses (tout à 0) → 200"       200 "$(api POST "/api/duels/$DUEL_ID/result" "$TOKEN1" '{"answers":[0,0,0,0,0,0,0,0,0,0]}')"
SCORE1="$(jval .duel.myScore)"
EXPECTED1="$(jval '[.duel.review[] | select(.bonne == 0)] | length')"
check "score RECALCULÉ par le serveur"  "$EXPECTED1" "$SCORE1"
check "review : 10 entrées"             10   "$(jval '.duel.review | length')"
check "review : bonnes réponses là"     true "$(jval '[.duel.review[] | has("bonne") and has("reference") and has("mine")] | all')"
check "statut u1 : waiting_them"        waiting_them "$(jval .duel.status)"
check "rejouer → 409"                   409  "$(api POST "/api/duels/$DUEL_ID/result" "$TOKEN1" '{"answers":[0,0,0,0,0,0,0,0,0,0]}')"

say "Duels — côté u2 pendant ce temps"
api GET /api/duels "$TOKEN2" > /dev/null
check "u2 : toujours waiting_me"        waiting_me "$(jval '.duels[0].status')"
api GET "/api/duels/$DUEL_ID" "$TOKEN2" > /dev/null
check "u2 : questions toujours sans bonne" false "$(jval '[.duel.questions[] | has("bonne")] | any')"

say "Duels — u2 (adversaire) joue"
check "réponses (tout à 1) → 200"       200 "$(api POST "/api/duels/$DUEL_ID/result" "$TOKEN2" '{"answers":[1,1,1,1,1,1,1,1,1,1]}')"
SCORE2="$(jval .duel.myScore)"
EXPECTED2="$(jval '[.duel.review[] | select(.bonne == 1)] | length')"
check "score u2 recalculé serveur"      "$EXPECTED2" "$SCORE2"
check "statut u2 : finished"            finished "$(jval .duel.status)"
check "u2 voit le score de u1"          "$SCORE1" "$(jval .duel.theirScore)"

say "Duels — statuts et scores finaux cohérents des deux côtés"
api GET /api/duels "$TOKEN1" > /dev/null
check "u1 : finished"                   finished "$(jval '.duels[0].status')"
check "u1 : myScore = $SCORE1"          "$SCORE1" "$(jval '.duels[0].myScore')"
check "u1 : theirScore = $SCORE2"       "$SCORE2" "$(jval '.duels[0].theirScore')"
api GET /api/duels "$TOKEN2" > /dev/null
check "u2 : finished"                   finished "$(jval '.duels[0].status')"
check "u2 : myScore = $SCORE2"          "$SCORE2" "$(jval '.duels[0].myScore')"
check "u2 : theirScore = $SCORE1"       "$SCORE1" "$(jval '.duels[0].theirScore')"

# ---------------------------------------------------------------------------
say "Config publique & connexion Google (non configurée en test)"
check "GET /api/config → 200"           200  "$(api GET /api/config)"
check "→ googleClientId null"           null "$(jval .googleClientId)"
check "auth Google → 501 (pas de clé)"  501  "$(api POST /api/auth/google '' '{"credential":"x"}')"

# ---------------------------------------------------------------------------
say "Veillée en direct — création (u1 anime)"
check "créer sans compte → 401"         401 "$(api POST /api/veillees '' '{}')"
check "nb hors bornes → 400"            400 "$(api POST /api/veillees "$TOKEN1" '{"nb":3}')"
check "créer (5 questions) → 201"       201 "$(api POST /api/veillees "$TOKEN1" '{"nb":5,"seconds":30}')"
VCODE="$(jval .veillee.code)"
check "code de 4 caractères"            4     "${#VCODE}"
check "statut lobby"                    lobby "$(jval .veillee.statut)"
check "5 questions annoncées"           5     "$(jval .veillee.qTotal)"

say "Veillée — rejoindre (sans compte)"
check "état public → 200"               200 "$(api GET "/api/veillees/$VCODE/state")"
check "code inconnu → 404"              404 "$(api GET /api/veillees/ZZZZ/state)"
check "Marc rejoint → 201"              201 "$(api POST "/api/veillees/$VCODE/join" '' '{"prenom":"Marc"}')"
PKEY1="$(jval .playerKey)"
check "clé de participant (32 hex)"     32  "${#PKEY1}"
check "prénom en double → 409"          409 "$(api POST "/api/veillees/$VCODE/join" '' '{"prenom":"Marc"}')"
check "Léa rejoint → 201"               201 "$(api POST "/api/veillees/$VCODE/join" '' '{"prenom":"Léa"}')"
PKEY2="$(jval .playerKey)"
api GET "/api/veillees/$VCODE/state" > /dev/null
check "2 participants visibles"         2   "$(jval .veillee.nPlayers)"
# Présent DÈS L'ARRIVÉE : sans ça, quelqu'un qui vient de rejoindre mais n'a pas
# encore sondé compterait comme absent et la révélation partirait sans lui.
check "2 présents dès l'arrivée"        2   "$(jval .veillee.nPresent)"
# Compté sur un état ANONYME : ne peut passer que si `join` horodate lui-même.
check "présents sans avoir sondé"       2   "$(jval .veillee.nPresent)"
# Prénoms à apostrophe : sans eux, N'Golo ou M'Barka resteraient à la porte.
check "apostrophe droite → 201"         201 "$(api POST "/api/veillees/$VCODE/join" '' "{\"prenom\":\"N'Golo\"}")"
check "apostrophe typographique → 201"  201 "$(api POST "/api/veillees/$VCODE/join" '' "{\"prenom\":\"M’Barka\"}")"
check "apostrophe seule → 422"          422 "$(api POST "/api/veillees/$VCODE/join" '' "{\"prenom\":\"'\"}")"
check "prénom d'un caractère → 422"     422 "$(api POST "/api/veillees/$VCODE/join" '' '{"prenom":"A"}')"

# Le vrai souci d'une veillée à 17 : quelqu'un s'en va, « tous ont répondu » ne
# devient jamais vrai et l'animateur subit le décompte entier à chaque question.
# La présence se déduit du sondage de l'état (~2 s côté client).
say "Veillée — présence : on n'attend plus que ceux qui sont ENCORE là"
api GET "/api/veillees/$VCODE/state" > /dev/null
check "4 participants au total"         4 "$(jval .veillee.nPlayers)"
check "4 présents"                      4 "$(jval .veillee.nPresent)"
# Vieillir l'horodatage en base plutôt qu'attendre 30 s : la suite doit rester
# rapide. Les quatre lignes touchées prouvent au passage que veillee_presence
# est bien écrite, une par participant.
VIEILLIS="$(php -r '
$pdo = new PDO("sqlite:" . $argv[1]);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$st = $pdo->prepare(
  "UPDATE veillee_presence SET last_seen = ?
   WHERE veillee_id IN (SELECT id FROM veillees WHERE code = ?)"
);
$st->execute([gmdate("Y-m-d H:i:s", time() - 60), $argv[2]]);
echo $st->rowCount();
' "$ROOT/api/data/dev.sqlite" "$VCODE" 2>>"$TMP/presence.log")"
check "1 ligne de présence par participant" 4 "$VIEILLIS"
api GET "/api/veillees/$VCODE/state" > /dev/null
check "plus personne n'est compté présent" 0 "$(jval .veillee.nPresent)"
# Marc resonde : le sondage lui-même vaut signe de présence, et il se compte
# dans l'état qu'il reçoit (sinon la révélation partirait une question trop tôt).
api GET "/api/veillees/$VCODE/state?player=$PKEY1" > /dev/null
check "celui qui sonde redevient présent" 1    "$(jval .veillee.nPresent)"
# La présence n'est donnée qu'en total : /state est public, et dire QUI a
# fermé son téléphone exposerait chacun sans rien apporter à personne.
check "la présence n'est pas nominative"  false "$(jval '.veillee.players[0] | has("present")')"
# Un absent n'est pas un partant définitif : il garde sa place et peut revenir.
check "nPlayers garde son sens"           4    "$(jval .veillee.nPlayers)"
check "le classement garde les absents"   4    "$(jval '.veillee.players | length')"
check "un absent garde son rang"          true "$(jval '.veillee.players[] | select(.prenom == "Léa") | .rang >= 1')"

say "Veillée — pilotage (animateur seul)"
check "u3 pilote → 403"                 403 "$(api POST "/api/veillees/$VCODE/advance" "$TOKEN3" '{"action":"start"}')"
check "répondre avant le début → 409"   409 "$(api POST "/api/veillees/$VCODE/answer" '' "{\"playerKey\":\"$PKEY1\",\"q\":0,\"answer\":0}")"
check "u1 lance → 200"                  200 "$(api POST "/api/veillees/$VCODE/advance" "$TOKEN1" '{"action":"start"}')"
check "statut question"                 question "$(jval .veillee.statut)"
api GET "/api/veillees/$VCODE/state?player=$PKEY1" > /dev/null
check "question posée, 4 options"       4     "$(jval '.veillee.question.options | length')"
check "bonne réponse PAS envoyée"       false "$(jval '.veillee.question | has("bonne")')"
check "décompte en cours (> 0)"         true  "$(jval '.veillee.remaining > 0')"

say "Veillée — réponses"
check "réponse hors bornes → 400"       400 "$(api POST "/api/veillees/$VCODE/answer" '' "{\"playerKey\":\"$PKEY1\",\"q\":0,\"answer\":9}")"
check "Marc répond 0 → 200"             200 "$(api POST "/api/veillees/$VCODE/answer" '' "{\"playerKey\":\"$PKEY1\",\"q\":0,\"answer\":0}")"
check "Marc re-répond → 409"            409 "$(api POST "/api/veillees/$VCODE/answer" '' "{\"playerKey\":\"$PKEY1\",\"q\":0,\"answer\":1}")"
check "clé inconnue → 401"              401 "$(api POST "/api/veillees/$VCODE/answer" '' '{"playerKey":"00000000000000000000000000000000","q":0,"answer":0}')"
api GET "/api/veillees/$VCODE/state?player=$PKEY1" > /dev/null
check "1 réponse comptée"               1    "$(jval .veillee.nAnswered)"
check "me.answered = true"              true "$(jval .veillee.me.answered)"
check "Marc, présent, a répondu"        1    "$(jval .veillee.nPresentRepondu)"
# Marc a répondu PUIS rangé son téléphone. nAnswered le compte toujours,
# nPresentRepondu non — sans cette distinction, comparer nAnswered à nPresent
# franchirait le seuil et couperait la parole à ceux qui réfléchissent encore.
php -r '
$pdo = new PDO("sqlite:" . $argv[1]);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->prepare(
  "UPDATE veillee_presence SET last_seen = ?
   WHERE veillee_id IN (SELECT id FROM veillees WHERE code = ?)"
)->execute([gmdate("Y-m-d H:i:s", time() - 60), $argv[2]]);
' "$ROOT/api/data/dev.sqlite" "$VCODE" 2>>"$TMP/presence.log"
api GET "/api/veillees/$VCODE/state" > /dev/null
check "sa réponse reste dans nAnswered" 1    "$(jval .veillee.nAnswered)"
check "mais plus dans les présents"     0    "$(jval .veillee.nPresentRepondu)"

say "Veillée — révélation puis fin"
check "u1 révèle → 200"                 200 "$(api POST "/api/veillees/$VCODE/advance" "$TOKEN1" '{"action":"reveal"}')"
api GET "/api/veillees/$VCODE/state?player=$PKEY1" > /dev/null
check "bonne réponse visible"           true "$(jval '.veillee.question | has("bonne")')"
check "référence visible"               true "$(jval '.veillee.question | has("reference")')"
check "répartition sur 4 options"       4    "$(jval '.veillee.distribution | length')"
if [ "$(jval .veillee.question.bonne)" = "0" ]; then
  check "points de Marc (bonne, ≥ 100)" true "$(jval '.veillee.me.points >= 100')"
else
  check "points de Marc (raté) = 0"     0    "$(jval .veillee.me.points)"
fi
check "u1 clôt la veillée → 200"        200  "$(api POST "/api/veillees/$VCODE/advance" "$TOKEN1" '{"action":"end"}')"
check "statut done"                     done "$(jval .veillee.statut)"
api GET "/api/veillees/$VCODE/state?player=$PKEY2" > /dev/null
check "bilan collectif présent"         true "$(jval '.veillee | has("bilan")')"
check "Léa a un rang"                   true "$(jval '.veillee.me.rang >= 1')"
check "rejoindre une veillée close → 410" 410 "$(api POST "/api/veillees/$VCODE/join" '' '{"prenom":"Paul"}')"

# ---------------------------------------------------------------------------
# « De qui parle-t-on ? » — veillée PV- : la correspondance des réponses
# tolère UNE faute de frappe (Levenshtein ≤ 1) sur une cible d'au moins
# 5 caractères, jamais une confusion : cible courte (Saül) en exacte
# seulement, et saisie ambiguë entre deux portraits du paquet refusée.
# Jubal et Tubal (Genèse 4) se ressemblent à une lettre près : parfaits
# pour prouver qu'on ne devine jamais.
say "Portrait — veillée PV- : une faute tolérée, jamais une confusion"
IND5='["Indice un","Indice deux","Indice trois","Indice quatre","Indice cinq"]'
PDECK="[{\"reponse\":\"Moïse\",\"accepte\":[],\"indices\":$IND5},
        {\"reponse\":\"Saül\",\"accepte\":[],\"indices\":$IND5},
        {\"reponse\":\"Jubal\",\"accepte\":[],\"indices\":$IND5},
        {\"reponse\":\"Tubal\",\"accepte\":[],\"indices\":$IND5}]"
check "ouvrir la veillée → 200"         200 "$(api POST /api/portrait/veillee '' "{\"deck\":$PDECK}")"
PCODE="$(jval .code)"
PCLE="$(jval .cle)"
check "code au format PV-XXXXX"         PV  "${PCODE%-*}"
api POST "/api/portrait/veillee/$PCODE/rejoindre" '' '{"prenom":"Marc"}' > /dev/null
PJ1="$(jval .jeton)"
api POST "/api/portrait/veillee/$PCODE/rejoindre" '' '{"prenom":"Léa"}' > /dev/null
PJ2="$(jval .jeton)"
check "lancer le premier portrait → 200" 200 "$(api POST "/api/portrait/veillee/$PCODE/avancer" '' "{\"cle\":\"$PCLE\",\"action\":\"indice\"}")"

say "Portrait — faute tolérée sur nom long (Moïse), deux fautes refusées"
check "« Moisse » (1 faute) → 200"      200  "$(api POST "/api/portrait/veillee/$PCODE/reponse" '' "{\"jeton\":\"$PJ1\",\"carte\":1,\"texte\":\"Moisse\"}")"
check "→ accepté (bon = true)"          true "$(jval .moi.bon)"
check "→ 5 points au premier indice"    5    "$(jval .moi.points)"
check "« Msoe » (2 fautes) → 200"       200  "$(api POST "/api/portrait/veillee/$PCODE/reponse" '' "{\"jeton\":\"$PJ2\",\"carte\":1,\"texte\":\"Msoe\"}")"
check "→ refusé (bon = false)"          false "$(jval .moi.bon)"
api POST "/api/portrait/veillee/$PCODE/avancer" '' "{\"cle\":\"$PCLE\",\"action\":\"reveler\"}" > /dev/null
api POST "/api/portrait/veillee/$PCODE/avancer" '' "{\"cle\":\"$PCLE\",\"action\":\"suivant\"}" > /dev/null

say "Portrait — nom court (Saül) : correspondance exacte seulement"
check "« Paul » pour Saül → 200"        200   "$(api POST "/api/portrait/veillee/$PCODE/reponse" '' "{\"jeton\":\"$PJ1\",\"carte\":2,\"texte\":\"Paul\"}")"
check "→ refusé (jamais de confusion)"  false "$(jval .moi.bon)"
check "« Saül » exact → 200"            200   "$(api POST "/api/portrait/veillee/$PCODE/reponse" '' "{\"jeton\":\"$PJ2\",\"carte\":2,\"texte\":\"Saül\"}")"
check "→ accepté"                       true  "$(jval .moi.bon)"
api POST "/api/portrait/veillee/$PCODE/avancer" '' "{\"cle\":\"$PCLE\",\"action\":\"reveler\"}" > /dev/null
api POST "/api/portrait/veillee/$PCODE/avancer" '' "{\"cle\":\"$PCLE\",\"action\":\"suivant\"}" > /dev/null

say "Portrait — ambigu entre deux portraits du paquet : on refuse, on ne devine pas"
check "« Zubal » (proche de Jubal ET Tubal) → 200" 200 "$(api POST "/api/portrait/veillee/$PCODE/reponse" '' "{\"jeton\":\"$PJ1\",\"carte\":3,\"texte\":\"Zubal\"}")"
check "→ refusé (ambigu)"               false "$(jval .moi.bon)"
check "« Jubal » exact malgré le voisin Tubal → 200" 200 "$(api POST "/api/portrait/veillee/$PCODE/reponse" '' "{\"jeton\":\"$PJ2\",\"carte\":3,\"texte\":\"Jubal\"}")"
check "→ accepté (l'exactitude prime)"  true  "$(jval .moi.bon)"
api GET "/api/portrait/veillee/$PCODE/etat" > /dev/null
check "classement : Léa devant (10 pts)" "Léa 10" "$(jval '"\(.participants[0].prenom) \(.participants[0].score)"')"
check "Marc garde ses 5 points"          5 "$(jval '.participants[] | select(.prenom == "Marc") | .score')"

# ---------------------------------------------------------------------------
# Groupes d'église : la création directe est FERMÉE — un groupe naît d'une
# DEMANDE (groupes-demandes.php) que seule l'administration (TOKEN1 = alice)
# accepte ou refuse. Aucun appel request-code ici : on réutilise TOKEN1/
# TOKEN2/TOKEN3 pour ne pas entamer les plafonds testés plus loin.

# Crée un groupe par le flux complet — demande du porteur, acceptation admin —
# et écrit le code GRP- du groupe sur stdout (le corps de la dernière réponse
# est celui de l'acceptation : {code, nom}).
groupe_via_demande() {
  api POST /api/groupes/demande "$1" "{\"nom\":\"$2\",\"adresse\":\"12 rue des Oliviers, Mons\"}" > /dev/null
  api GET /api/admin/eglises "$TOKEN1" > /dev/null
  local id
  id="$(jq -r --arg nom "$2" '[.demandes[] | select(.nom == $nom)] | last | .id' "$TMP/body.json")"
  api POST "/api/admin/eglises/demandes/$id/accepter" "$TOKEN1" > /dev/null
  jval .code
}

say "Groupes d'église — la création directe est fermée (le message oriente)"
check "POST /api/groupes sans compte → 401" 401 "$(api POST /api/groupes '' '{"nom":"Béthel"}')"
check "création directe connectée → 403" 403 "$(api POST /api/groupes "$TOKEN1" '{"nom":"Béthel"}')"
check "→ le message oriente vers la demande" true "$(jval '.error | contains("demande")')"

say "Groupes — déposer sa demande (u1) : nom, adresse obligatoire, e-mail facultatif"
check "demande sans compte → 401"       401 "$(api POST /api/groupes/demande '' '{"nom":"Béthel"}')"
check "nom trop court → 400"            400 "$(api POST /api/groupes/demande "$TOKEN1" '{"nom":"B"}')"
check "nom avec caractère interdit → 400" 400 "$(api POST /api/groupes/demande "$TOKEN1" '{"nom":"Béthel <7>"}')"
check "adresse manquante → 400"         400 "$(api POST /api/groupes/demande "$TOKEN1" '{"nom":"Béthel"}')"
check "adresse trop courte → 400"       400 "$(api POST /api/groupes/demande "$TOKEN1" '{"nom":"Béthel","adresse":"Rue"}')"
check "e-mail de contact invalide → 400" 400 "$(api POST /api/groupes/demande "$TOKEN1" '{"nom":"Béthel","adresse":"12 rue des Oliviers, Mons","email":"pas-un-email"}')"
check "GET : aucune demande au départ"  null "$(api GET /api/groupes/demande "$TOKEN1" > /dev/null; jval .demande)"
check "annuler sans demande → 404"      404 "$(api DELETE /api/groupes/demande "$TOKEN1")"
check "demande valide, sans e-mail (facultatif) → 201" 201 "$(api POST /api/groupes/demande "$TOKEN1" '{"nom":"L’Église d’Éphèse","adresse":"7 place de la Grâce, Éphèse"}')"
check "→ statut attente"                attente "$(jval .demande.statut)"
check "→ createdAt en ISO"              Z "$(jval .demande.createdAt | tail -c 2)"
check "→ l'adresse est portée"          "7 place de la Grâce, Éphèse" "$(jval .demande.adresse)"
check "→ email null (absent)"           null "$(jval .demande.email)"
check "seconde demande → 409 (une seule à la fois)" 409 "$(api POST /api/groupes/demande "$TOKEN1" '{"nom":"Une autre","adresse":"12 rue des Oliviers, Mons"}')"
api GET /api/groupes/demande "$TOKEN1" > /dev/null
check "GET : la demande est là"         "L’Église d’Éphèse" "$(jval .demande.nom)"
check "GET : avec son adresse"          "7 place de la Grâce, Éphèse" "$(jval .demande.adresse)"
check "GET : email null"                null "$(jval .demande.email)"
check "aucun groupe n'existe encore"    0 "$(api GET /api/groupes "$TOKEN1" > /dev/null; jval '.groupes | length')"

say "Groupes — annuler sa demande, puis redéposer"
check "annuler → ok true"               true "$(api DELETE /api/groupes/demande "$TOKEN1" > /dev/null; jval .ok)"
check "GET : plus de demande"           null "$(api GET /api/groupes/demande "$TOKEN1" > /dev/null; jval .demande)"
check "re-annuler → 404"                404 "$(api DELETE /api/groupes/demande "$TOKEN1")"
check "redéposer → 201"                 201 "$(api POST /api/groupes/demande "$TOKEN1" '{"nom":"L’Église d’Éphèse","adresse":"7 place de la Grâce, Éphèse"}')"

say "Groupes — le refus par l'administration, la demande REMPLACÉE"
check "admin/eglises sans token → 401"  401 "$(api GET /api/admin/eglises)"
check "admin/eglises non-admin → 403"   403 "$(api GET /api/admin/eglises "$TOKEN3")"
check "admin/eglises alice → 200"       200 "$(api GET /api/admin/eglises "$TOKEN1")"
check "1 demande en attente listée"     1 "$(jval '.demandes | length')"
check "→ avec pseudo et e-mail"         "Alice alice@example.org" "$(jval '"\(.demandes[0].pseudo) \(.demandes[0].email)"')"
check "→ avec l'adresse de l'église"    "7 place de la Grâce, Éphèse" "$(jval '.demandes[0].adresse')"
check "→ emailContact null (absent)"    null "$(jval '.demandes[0].emailContact')"
check "→ aucun groupe pour l'instant"   0 "$(jval '.groupes | length')"
DEM_ID="$(jval '.demandes[0].id')"
check "refuser par non-admin → 403"     403 "$(api POST "/api/admin/eglises/demandes/$DEM_ID/refuser" "$TOKEN3")"
check "refuser → ok true"               true "$(api POST "/api/admin/eglises/demandes/$DEM_ID/refuser" "$TOKEN1" > /dev/null; jval .ok)"
check "re-refuser (déjà tranchée) → 404" 404 "$(api POST "/api/admin/eglises/demandes/$DEM_ID/refuser" "$TOKEN1")"
check "accepter une refusée → 404"      404 "$(api POST "/api/admin/eglises/demandes/$DEM_ID/accepter" "$TOKEN1")"
check "le porteur voit le refus"        refusee "$(api GET /api/groupes/demande "$TOKEN1" > /dev/null; jval .demande.statut)"
check "la refusée ne bloque plus l'admin" 0 "$(api GET /api/admin/eglises "$TOKEN1" > /dev/null; jval '.demandes | length')"
check "le refus CONSERVE les détails"   "7 place de la Grâce, Éphèse" "$(api GET /api/groupes/demande "$TOKEN1" > /dev/null; jval .demande.adresse)"
check "la refusée est REMPLACÉE → 201"  201 "$(api POST /api/groupes/demande "$TOKEN1" '{"nom":"L’Église d’Éphèse","adresse":"1 chemin du Figuier, Smyrne","email":"Contact@Ephese.example.org"}')"
api GET /api/groupes/demande "$TOKEN1" > /dev/null
check "→ de nouveau en attente"         attente "$(jval .demande.statut)"
check "→ les détails aussi sont remplacés" "1 chemin du Figuier, Smyrne" "$(jval .demande.adresse)"
check "→ e-mail de contact en minuscules" "contact@ephese.example.org" "$(jval .demande.email)"
check "l'admin voit l'e-mail de contact" "contact@ephese.example.org" "$(api GET /api/admin/eglises "$TOKEN1" > /dev/null; jval '.demandes[0].emailContact')"

say "Groupes — l'acceptation fait naître le groupe (u1 responsable)"
api GET /api/admin/eglises "$TOKEN1" > /dev/null
DEM_ID="$(jval '.demandes[0].id')"
check "accepter une demande inconnue → 404" 404 "$(api POST /api/admin/eglises/demandes/999999/accepter "$TOKEN1")"
check "accepter par non-admin → 403"    403 "$(api POST "/api/admin/eglises/demandes/$DEM_ID/accepter" "$TOKEN3")"
check "accepter → 200"                  200 "$(api POST "/api/admin/eglises/demandes/$DEM_ID/accepter" "$TOKEN1")"
GCODE="$(jval .code)"
check "→ le nom demandé"                "L’Église d’Éphèse" "$(jval .nom)"
check "code au format GRP-XXXXX (préfixe)"  GRP "${GCODE%-*}"
check "code au format GRP-XXXXX (longueur)" 9   "${#GCODE}"
check "la demande a disparu"            null "$(api GET /api/groupes/demande "$TOKEN1" > /dev/null; jval .demande)"
check "re-accepter → 404"               404 "$(api POST "/api/admin/eglises/demandes/$DEM_ID/accepter" "$TOKEN1")"
api GET /api/groupes "$TOKEN1" > /dev/null
check "u1 a maintenant 1 groupe"        1 "$(jval '.groupes | length')"
check "le demandeur est responsable"    responsable "$(jval '.groupes[0].role')"
check "1 membre au départ"              1    "$(jval '.groupes[0].nbMembres')"
check "pas encore de verset"            null "$(jval '.groupes[0].verset')"
api GET /api/admin/eglises "$TOKEN1" > /dev/null
check "admin/eglises : plus de demande" 0 "$(jval '.demandes | length')"
check "le groupe figure dans la liste"  "L’Église d’Éphèse" "$(jval ".groupes[] | select(.code == \"$GCODE\") | .nom")"
check "→ responsable et nbMembres"      "Alice 1" "$(jval ".groupes[] | select(.code == \"$GCODE\") | \"\(.responsable) \(.nbMembres)\"")"

say "Groupes — e-mail de contact identique à celui du compte : masqué pour l'admin"
check "u2 dépose avec son propre e-mail → 201" 201 "$(api POST /api/groupes/demande "$TOKEN2" '{"nom":"Antioche","adresse":"3 rue du Levant, Antioche","email":"BENOIT@example.org"}')"
check "l'admin voit emailContact null (identique)" null "$(api GET /api/admin/eglises "$TOKEN1" > /dev/null; jval '.demandes[0].emailContact')"
check "u2 annule → ok true"             true "$(api DELETE /api/groupes/demande "$TOKEN2" > /dev/null; jval .ok)"

say "Groupes — u3 rejoint par code"
check "code mal formé → 400"            400 "$(api POST /api/groupes/rejoindre "$TOKEN3" '{"code":"BETHEL7"}')"
check "code inconnu → 404"              404 "$(api POST /api/groupes/rejoindre "$TOKEN3" '{"code":"GRP-00000"}')"
GCODE_MIN="$(printf '%s' "$GCODE" | tr '[:upper:]' '[:lower:]')"
check "u3 rejoint (code en minuscules) → 200" 200 "$(api POST /api/groupes/rejoindre "$TOKEN3" "{\"code\":\"$GCODE_MIN\"}")"
check "→ role membre"                   membre "$(jval .groupe.role)"
check "→ 2 membres"                     2      "$(jval .groupe.nbMembres)"
check "re-rejoindre → 409"              409 "$(api POST /api/groupes/rejoindre "$TOKEN3" "{\"code\":\"$GCODE\"}")"

say "Groupes — liste et détail (membres seulement, jamais les e-mails)"
check "liste u1 → 200"                  200 "$(api GET /api/groupes "$TOKEN1")"
check "u1 a 1 groupe"                   1   "$(jval '.groupes | length')"
check "u1 : role responsable"           responsable "$(jval '.groupes[0].role')"
check "liste u2 : aucun groupe"         0   "$(api GET /api/groupes "$TOKEN2" > /dev/null; jval '.groupes | length')"
check "détail u2 (non-membre) → 403"    403 "$(api GET "/api/groupes/$GCODE" "$TOKEN2")"
check "détail u1 (membre) → 200"        200 "$(api GET "/api/groupes/$GCODE" "$TOKEN1")"
check "2 membres listés"                2   "$(jval '.groupe.membres | length')"
check "membres : pseudo et role seulement" "pseudo,role" "$(jval '.groupe.membres | map(keys) | flatten | unique | sort | join(",")')"
check "JAMAIS d'e-mail dans le détail"  false "$(jval 'tostring | contains("@")')"

say "Groupes — verset de la semaine (responsable seul)"
check "u3 (membre) pose le verset → 403" 403 "$(api POST "/api/groupes/$GCODE/verset" "$TOKEN3" '{"reference":"Jean 3.16","texte":"Car Dieu a tant aimé le monde…"}')"
check "texte vide → 400"                400 "$(api POST "/api/groupes/$GCODE/verset" "$TOKEN1" '{"reference":"Jean 3.16","texte":"  "}')"
check "u1 (responsable) → 200"          200 "$(api POST "/api/groupes/$GCODE/verset" "$TOKEN1" '{"reference":"Jean 3.16","texte":"Car Dieu a tant aimé le monde…"}')"
check "→ verset.reference"              "Jean 3.16" "$(jval .groupe.verset.reference)"
check "→ verset.depuis en ISO"          Z   "$(jval .groupe.verset.depuis | tail -c 2)"
api GET "/api/groupes/$GCODE" "$TOKEN3" > /dev/null
check "le verset est visible des membres" "Car Dieu a tant aimé le monde…" "$(jval .groupe.verset.texte)"

say "Groupes — passation de responsabilité (par pseudo, responsable seul)"
check "u3 (membre) tente → 403"         403 "$(api POST "/api/groupes/$GCODE/passation" "$TOKEN3" '{"pseudo":"Alice"}')"
check "pseudo vide → 400"               400 "$(api POST "/api/groupes/$GCODE/passation" "$TOKEN1" '{"pseudo":"  "}')"
check "pseudo inconnu du groupe → 404"  404 "$(api POST "/api/groupes/$GCODE/passation" "$TOKEN1" '{"pseudo":"Personne"}')"
check "son propre pseudo → 404"         404 "$(api POST "/api/groupes/$GCODE/passation" "$TOKEN1" '{"pseudo":"Alice"}')"
check "u1 confie à Chloé → 200"         200 "$(api POST "/api/groupes/$GCODE/passation" "$TOKEN1" '{"pseudo":"Chloé"}')"
check "→ u1 est désormais membre"       membre "$(jval .groupe.role)"
check "→ toujours 2 membres"            2   "$(jval .groupe.nbMembres)"
api GET "/api/groupes/$GCODE" "$TOKEN3" > /dev/null
check "u3 se voit responsable"          responsable "$(jval .groupe.role)"
check "les rôles listés ont suivi"      "membre,responsable" "$(jval '.groupe.membres | map(.role) | sort | join(",")')"
check "u1 (membre) pose le verset → 403" 403 "$(api POST "/api/groupes/$GCODE/verset" "$TOKEN1" '{"reference":"Jean 1.1","texte":"Au commencement était la Parole."}')"
check "u3 (responsable) le pose → 200"  200 "$(api POST "/api/groupes/$GCODE/verset" "$TOKEN3" '{"reference":"Jean 1.1","texte":"Au commencement était la Parole."}')"
check "Chloé rend le groupe à Alice → 200" 200 "$(api POST "/api/groupes/$GCODE/passation" "$TOKEN3" '{"pseudo":"Alice"}')"
api GET "/api/groupes/$GCODE" "$TOKEN1" > /dev/null
check "u1 est de nouveau responsable"   responsable "$(jval .groupe.role)"

say "Groupes — co-responsables : nommés par le responsable, ils NOURRISSENT"
check "u3 (membre) ne pose pas le verset → 403" 403 "$(api POST "/api/groupes/$GCODE/verset" "$TOKEN3" '{"reference":"Jean 1.1","texte":"Au commencement était la Parole."}')"
check "u3 ne se nomme pas lui-même → 403" 403 "$(api POST "/api/groupes/$GCODE/coresponsables" "$TOKEN3" '{"pseudo":"Chloé"}')"
check "pseudo inconnu → 404"            404 "$(api POST "/api/groupes/$GCODE/coresponsables" "$TOKEN1" '{"pseudo":"Personne"}')"
check "u1 nomme Chloé → 200"            200 "$(api POST "/api/groupes/$GCODE/coresponsables" "$TOKEN1" '{"pseudo":"Chloé"}')"
check "re-nommer → 409"                 409 "$(api POST "/api/groupes/$GCODE/coresponsables" "$TOKEN1" '{"pseudo":"Chloé"}')"
api GET "/api/groupes/$GCODE" "$TOKEN3" > /dev/null
check "u3 se voit co-responsable"       coresponsable "$(jval .groupe.role)"
check "les rôles listés ont suivi"      "coresponsable,responsable" "$(jval '.groupe.membres | map(.role) | sort | join(",")')"
# Ce qu'un co-responsable peut désormais faire : nourrir.
check "il pose le verset → 200"         200 "$(api POST "/api/groupes/$GCODE/verset" "$TOKEN3" '{"reference":"Jean 1.1","texte":"Au commencement était la Parole."}')"
check "→ son rôle reste co-responsable" coresponsable "$(jval .groupe.role)"
check "il crée une annonce → 201"       201 "$(api POST "/api/groupes/$GCODE/annonces" "$TOKEN3" '{"titre":"Un mot de l équipe","texte":"Bonjour à tous."}')"
check "il règle la banque de quiz → 200" 200 "$(api POST "/api/groupes/$GCODE/quiz/mode" "$TOKEN3" '{"mode":"toutes"}')"
check "il tient les séries d une épreuve → 200" 200 "$(api GET "/api/groupes/$GCODE/series/quiadit" "$TOKEN3")"
# Ce qu'il ne peut PAS : porter le groupe.
check "il ne nomme pas un co-responsable → 403" 403 "$(api POST "/api/groupes/$GCODE/coresponsables" "$TOKEN3" '{"pseudo":"Alice"}')"
check "il ne transmet pas le groupe → 403" 403 "$(api POST "/api/groupes/$GCODE/passation" "$TOKEN3" '{"pseudo":"Alice"}')"
check "il ne met pas en forme le nom → 403" 403 "$(api POST "/api/groupes/$GCODE/identite" "$TOKEN3" '{"style":"moderne","taille":"posee"}')"
check "il ne supprime pas le groupe → 403" 403 "$(api DELETE "/api/groupes/$GCODE" "$TOKEN3")"
check "u2 (non-membre) reste dehors → 403" 403 "$(api GET "/api/groupes/$GCODE/series/quiadit" "$TOKEN2")"
# Retrait : il redevient membre, sans quitter le groupe.
check "retrait d'un non-co-responsable → 404" 404 "$(api DELETE "/api/groupes/$GCODE/coresponsables/Alice" "$TOKEN1")"
check "u1 retire Chloé → 200"           200 "$(api DELETE "/api/groupes/$GCODE/coresponsables/Chlo%C3%A9" "$TOKEN1")"
api GET "/api/groupes/$GCODE" "$TOKEN3" > /dev/null
check "→ elle redevient membre"         membre "$(jval .groupe.role)"
check "→ toujours dans le groupe"       2   "$(jval .groupe.nbMembres)"
check "et ne pose plus le verset → 403" 403 "$(api POST "/api/groupes/$GCODE/verset" "$TOKEN3" '{"reference":"Jean 1.1","texte":"Au commencement était la Parole."}')"

say "Groupes — l'identité du nom (mots-clés à liste blanche, responsable seul)"
check "par défaut : classique / posee"  "classique,posee" "$(api GET "/api/groupes/$GCODE" "$TOKEN1" > /dev/null; jval '.groupe.nomStyle + "," + .groupe.nomTaille')"
check "posée par u3 (membre) → 403"     403 "$(api POST "/api/groupes/$GCODE/identite" "$TOKEN3" '{"style":"moderne","taille":"posee"}')"
check "style hors liste → 400"          400 "$(api POST "/api/groupes/$GCODE/identite" "$TOKEN1" '{"style":"comic-sans","taille":"posee"}')"
check "taille hors liste → 400"         400 "$(api POST "/api/groupes/$GCODE/identite" "$TOKEN1" '{"style":"moderne","taille":"96px"}')"
check "u1 pose solennelle / majestueuse → 200" 200 "$(api POST "/api/groupes/$GCODE/identite" "$TOKEN1" '{"style":"solennelle","taille":"majestueuse"}')"
check "→ nomStyle suit"                 solennelle "$(jval .groupe.nomStyle)"
check "les membres la voient aussi"     "solennelle,majestueuse" "$(api GET "/api/groupes/$GCODE" "$TOKEN3" > /dev/null; jval '.groupe.nomStyle + "," + .groupe.nomTaille')"

say "Groupes — quitter"
check "u1 responsable ne peut pas quitter (u3 est là) → 400" 400 "$(api DELETE "/api/groupes/$GCODE/membres/moi" "$TOKEN1")"
check "u3 quitte → 200"                 200 "$(api DELETE "/api/groupes/$GCODE/membres/moi" "$TOKEN3")"
check "u3 re-quitte → 404"              404 "$(api DELETE "/api/groupes/$GCODE/membres/moi" "$TOKEN3")"
check "u3 : liste vide"                 0   "$(api GET /api/groupes "$TOKEN3" > /dev/null; jval '.groupes | length')"
check "u1, resté seul, quitte → 200"    200 "$(api DELETE "/api/groupes/$GCODE/membres/moi" "$TOKEN1")"
check "le groupe a disparu avec lui → 404" 404 "$(api POST /api/groupes/rejoindre "$TOKEN3" "{\"code\":\"$GCODE\"}")"

say "Groupes — plafond de 5 groupes par responsable, puis suppression"
GCODES=""
for i in 1 2 3 4 5; do
  GCODES="$GCODES $(groupe_via_demande "$TOKEN1" "Groupe numéro $i")"
done
check "u1 responsable de 5 groupes"     5   "$(api GET /api/groupes "$TOKEN1" > /dev/null; jval '.groupes | length')"
check "6e demande → 409 (plafond)"      409 "$(api POST /api/groupes/demande "$TOKEN1" '{"nom":"Groupe de trop","adresse":"12 rue des Oliviers, Mons"}')"
# Le plafond se REVÉRIFIE à l'acceptation : une demande déposée avant le 5e
# groupe peut être tranchée après lui. Insertion directe en base pour simuler
# ce décalage (le dépôt normal refuse déjà à 5), demande CONSERVÉE au 409.
php -r '
$pdo = new PDO("sqlite:" . $argv[1]);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec("INSERT INTO groupe_demandes (user_id, nom, statut, created_at)
  SELECT id, \"Demande en décalage\", \"attente\", \"2000-01-01 00:00:00\"
  FROM users WHERE email = \"alice@example.org\"");
' "$ROOT/api/data/dev.sqlite"
api GET /api/admin/eglises "$TOKEN1" > /dev/null
DEC_ID="$(jval '.demandes[0].id')"
check "accepter au plafond → 409"       409 "$(api POST "/api/admin/eglises/demandes/$DEC_ID/accepter" "$TOKEN1")"
check "la demande est conservée"        1   "$(api GET /api/admin/eglises "$TOKEN1" > /dev/null; jval '.demandes | length')"
php -r '
$pdo = new PDO("sqlite:" . $argv[1]);
$pdo->exec("DELETE FROM groupe_demandes WHERE nom = \"Demande en décalage\"");
' "$ROOT/api/data/dev.sqlite"
set -- $GCODES
check "suppression par u3 (non-responsable) → 403" 403 "$(api DELETE "/api/groupes/$1" "$TOKEN3")"
SUPPRIMES=0
for c in $GCODES; do
  [ "$(api DELETE "/api/groupes/$c" "$TOKEN1")" = 200 ] && SUPPRIMES=$((SUPPRIMES + 1))
done
check "u1 supprime ses 5 groupes"       5   "$SUPPRIMES"
check "u1 : liste vide"                 0   "$(api GET /api/groupes "$TOKEN1" > /dev/null; jval '.groupes | length')"

say "Groupes — deuxième groupe : u2 responsable, u3 membre (passation testée après la suppression de u2)"
G2CODE="$(groupe_via_demande "$TOKEN2" "Groupe de Benoît")"
check "u2 obtient son groupe (via demande)" GRP "${G2CODE%-*}"
check "u3 rejoint → 200"                200 "$(api POST /api/groupes/rejoindre "$TOKEN3" "{\"code\":\"$G2CODE\"}")"
check "→ 2 membres"                     2   "$(jval .groupe.nbMembres)"

# ---------------------------------------------------------------------------
# Quiz d'église — la banque de questions par groupe (groupes-quiz.php).
# Toujours aucun appel request-code ici. u1 (responsable) et u3 (membre)
# portent les tests ; u2, encore vivant à ce stade, sert de non-membre.
# À ce point de la suite, quiz_questions est vide : la banque commune
# fusionnée est exactement le fichier — les 5 premières questions du fichier
# servent de sélection déterministe pour le test du tirage.
say "Quiz d'église — réglages par défaut (u1 crée, u3 rejoint)"
QGCODE="$(groupe_via_demande "$TOKEN1" "Église du Quiz")"
check "u1 obtient le groupe du quiz (via demande)" GRP "${QGCODE%-*}"
api POST /api/groupes/rejoindre "$TOKEN3" "{\"code\":\"$QGCODE\"}" > /dev/null
NBQF="$(api GET /api/questions > /dev/null; jval '.questions | length')"
check "GET quiz par u3 (membre) → 200"  200 "$(api GET "/api/groupes/$QGCODE/quiz" "$TOKEN3")"
check "mode par défaut : toutes"        toutes "$(jval .quiz.mode)"
check "nbSelection 0"                   0   "$(jval .quiz.nbSelection)"
check "nbPropres 0"                     0   "$(jval .quiz.nbPropres)"
check "nbTotal = banque commune entière" "$NBQF" "$(jval .quiz.nbTotal)"

say "Quiz d'église — lecture aux membres, écriture au responsable seul"
check "GET quiz non-membre (u2) → 403"  403 "$(api GET "/api/groupes/$QGCODE/quiz" "$TOKEN2")"
check "mode posé par u3 (membre) → 403" 403 "$(api POST "/api/groupes/$QGCODE/quiz/mode" "$TOKEN3" '{"mode":"selection"}')"
check "sélection posée par u3 → 403"    403 "$(api PUT "/api/groupes/$QGCODE/quiz/selection" "$TOKEN3" '{"ids":[]}')"
check "questions propres lues par u3 → 403" 403 "$(api GET "/api/groupes/$QGCODE/quiz/questions" "$TOKEN3")"
check "question propre créée par u3 → 403" 403 "$(api POST "/api/groupes/$QGCODE/quiz/questions" "$TOKEN3" '{"categorie":"Personnages","niveau":1,"question":"Q ?","options":["A","B","C","D"],"bonne":0,"reference":"R"}')"
check "mode inconnu → 400"              400 "$(api POST "/api/groupes/$QGCODE/quiz/mode" "$TOKEN1" '{"mode":"aucune"}')"

say "Quiz d'église — sélection dans la banque commune (REMPLACE, ids vérifiés)"
SELIDS="$(jq -c '[.questions[0:5][].id]' "$ROOT/defi/data/questions.json")"
jq -r '.questions[0:5][].question' "$ROOT/defi/data/questions.json" > "$TMP/selection.txt"
check "id inconnu → 400"                400 "$(api PUT "/api/groupes/$QGCODE/quiz/selection" "$TOKEN1" '{"ids":["xyz-inexistant"]}')"
check "→ l'id fautif est nommé"         true "$(jval '.error | contains("xyz-inexistant")')"
check "5 ids valides → 200"             200 "$(api PUT "/api/groupes/$QGCODE/quiz/selection" "$TOKEN1" "{\"ids\":$SELIDS}")"
check "nbSelection 5"                   5   "$(jval .quiz.nbSelection)"
check "mode encore toutes : nbTotal inchangé" "$NBQF" "$(jval .quiz.nbTotal)"

say "Quiz d'église — questions propres (validations identiques à l'admin)"
check "catégorie inconnue → 400"        400 "$(api POST "/api/groupes/$QGCODE/quiz/questions" "$TOKEN1" '{"categorie":"Cuisine","niveau":1,"question":"Q ?","options":["A","B","C","D"],"bonne":0,"reference":"R"}')"
check "3 options seulement → 400"       400 "$(api POST "/api/groupes/$QGCODE/quiz/questions" "$TOKEN1" '{"categorie":"Personnages","niveau":1,"question":"Q ?","options":["A","B","C"],"bonne":0,"reference":"R"}')"
check "bonne hors bornes → 400"         400 "$(api POST "/api/groupes/$QGCODE/quiz/questions" "$TOKEN1" '{"categorie":"Personnages","niveau":1,"question":"Q ?","options":["A","B","C","D"],"bonne":4,"reference":"R"}')"
check "création → 200"                  200 "$(api POST "/api/groupes/$QGCODE/quiz/questions" "$TOKEN1" '{"categorie":"Personnages","niveau":2,"question":"Qui a fondé notre assemblée ?","options":["Pierre","Paul","Jacques","Jean"],"bonne":1,"reference":"Actes 1.1"}')"
EGLID="$(jval .question.id)"
check "id généré préfixé egl-"          egl- "$(printf '%s' "$EGLID" | cut -c1-4)"
check "id généré : egl- + 6 hex"        10  "${#EGLID}"
check "id egl- inconnu → 404"           404 "$(api POST "/api/groupes/$QGCODE/quiz/questions" "$TOKEN1" '{"id":"egl-000000","categorie":"Personnages","niveau":1,"question":"Q ?","options":["A","B","C","D"],"bonne":0,"reference":"R"}')"
check "modification → 200"              200 "$(api POST "/api/groupes/$QGCODE/quiz/questions" "$TOKEN1" "{\"id\":\"$EGLID\",\"categorie\":\"Personnages\",\"niveau\":2,\"question\":\"Qui a fondé notre assemblée ? (v2)\",\"options\":[\"Pierre\",\"Paul\",\"Jacques\",\"Jean\"],\"bonne\":1,\"reference\":\"Actes 1.1\"}")"
api GET "/api/groupes/$QGCODE/quiz/questions" "$TOKEN1" > /dev/null
check "1 question propre listée"        1   "$(jval '.questions | length')"
check "version modifiée servie"         "Qui a fondé notre assemblée ? (v2)" "$(jval '.questions[0].question')"
check "la bonne réponse est là (responsable seul)" 1 "$(jval '.questions[0].bonne')"
api GET "/api/groupes/$QGCODE/quiz" "$TOKEN1" > /dev/null
check "nbPropres 1"                     1   "$(jval .quiz.nbPropres)"
check "nbTotal (toutes) = commune + 1"  "$(( NBQF + 1 ))" "$(jval .quiz.nbTotal)"

say "Quiz d'église — mode selection : la banque rétrécit"
check "mode selection → 200"            200 "$(api POST "/api/groupes/$QGCODE/quiz/mode" "$TOKEN1" '{"mode":"selection"}')"
check "nbTotal = 5 retenues + 1 propre" 6   "$(jval .quiz.nbTotal)"
check "suppression de la question propre → 200" 200 "$(api DELETE "/api/groupes/$QGCODE/quiz/questions/$EGLID" "$TOKEN1")"
check "re-suppression → 404"            404 "$(api DELETE "/api/groupes/$QGCODE/quiz/questions/$EGLID" "$TOKEN1")"
api GET "/api/groupes/$QGCODE/quiz" "$TOKEN1" > /dev/null
check "nbPropres 0, nbTotal 5"          "0 5" "$(jval '"\(.quiz.nbPropres) \(.quiz.nbTotal)"')"

say "Veillée liée à l'église — responsable seul, tirage dans la banque du groupe"
check "u3 (membre simple) lie une veillée → 403" 403 "$(api POST /api/veillees "$TOKEN3" "{\"nb\":5,\"groupe\":\"$QGCODE\"}")"
check "6 questions pour 5 en banque → 400" 400 "$(api POST /api/veillees "$TOKEN1" "{\"nb\":6,\"groupe\":\"$QGCODE\"}")"
check "→ « Pas assez de questions… »"   true "$(jval '.error | startswith("Pas assez de questions")')"
check "u1 (responsable) crée la veillée liée → 201" 201 "$(api POST /api/veillees "$TOKEN1" "{\"nb\":5,\"seconds\":30,\"groupe\":\"$QGCODE\"}")"
VQCODE="$(jval .veillee.code)"
check "state : eglise = nom du groupe"  "Église du Quiz" "$(jval .veillee.eglise)"
# LE TEST CLEF : 5 ids retenus, 0 propre → le tirage de 5 parmi 5 est
# déterministe en CONTENU ; chaque intitulé reçu doit venir de la sélection.
api POST "/api/veillees/$VQCODE/join" '' '{"prenom":"Timothée"}' > /dev/null
api POST "/api/veillees/$VQCODE/advance" "$TOKEN1" '{"action":"start"}' > /dev/null
DANS_SELECTION=0
for _ in 1 2 3 4 5; do
  api GET "/api/veillees/$VQCODE/state" > /dev/null
  grep -qxF "$(jval .veillee.question.question)" "$TMP/selection.txt" && DANS_SELECTION=$((DANS_SELECTION + 1))
  api POST "/api/veillees/$VQCODE/advance" "$TOKEN1" '{"action":"reveal"}' > /dev/null
  api POST "/api/veillees/$VQCODE/advance" "$TOKEN1" '{"action":"next"}' > /dev/null
done
check "les 5 questions viennent TOUTES de la sélection" 5 "$DANS_SELECTION"
check "une veillée ordinaire n'a pas d'église" false "$(api GET "/api/veillees/$VCODE/state" > /dev/null; jval '.veillee | has("eglise")')"

# ---------------------------------------------------------------------------
# Séries de questions d'une église (groupes-banques.php) : quiadit,
# ecritoupas, portrait. L'écriture et les brouillons sont réservés au
# responsable ; un MEMBRE lit les séries publiées, sans quoi il ne pourrait
# pas y jouer. Réutilise le groupe du quiz : u1 responsable, u3 membre, u2 dehors.
say "Séries d'église — qui voit quoi"
check "module inconnu → 404"            404 "$(api GET "/api/groupes/$QGCODE/series/inconnu" "$TOKEN1")"
check "u2 (non-membre) → 403"           403 "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN2")"
check "u3 (membre) → 200"               200 "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN3")"
check "le membre n'anime pas"           false "$(jval .anime)"
check "aucune série au départ"          0   "$(jval '.series | length')"
check "responsable → 200"               200 "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN1")"
check "le responsable anime"            true "$(jval .anime)"
check "le plafond est annoncé"          8   "$(jval .maxPubliees)"

say "Séries d'église — création"
check "u3 (membre) ne crée pas → 403"   403 "$(api POST "/api/groupes/$QGCODE/series/quiadit" "$TOKEN3" '{"nom":"Interdite"}')"
check "nom vide → 400"                  400 "$(api POST "/api/groupes/$QGCODE/series/quiadit" "$TOKEN1" '{"nom":"   "}')"
NOMLONG="$(printf 'x%.0s' $(seq 1 81))"
check "nom de 81 caractères → 400"      400 "$(api POST "/api/groupes/$QGCODE/series/quiadit" "$TOKEN1" "{\"nom\":\"$NOMLONG\"}")"
check "création → 201"                  201 "$(api POST "/api/groupes/$QGCODE/series/quiadit" "$TOKEN1" '{"nom":"Prédication du 10 août — Jonas"}')"
SID="$(jval .serie.id)"
check "elle naît en brouillon"          brouillon "$(jval .serie.etat)"
check "et vide"                         0   "$(jval .serie.nbItems)"
check "le membre ne voit pas le brouillon" 0 "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN3" > /dev/null; jval '.series | length')"
check "le responsable, si"              1   "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN1" > /dev/null; jval '.series | length')"

say "Séries d'église — les items gardent les validations de l'admin"
IT="/api/groupes/$QGCODE/series/quiadit/$SID/items"
check "u3 (membre) n'écrit pas → 403"   403 "$(api POST "$IT" "$TOKEN3" '{"parole":"P","options":["A","B","C","D"],"bonne":0,"reference":"Actes 20.35"}')"
check "parole manquante → 400"          400 "$(api POST "$IT" "$TOKEN1" '{"options":["A","B","C","D"],"bonne":0,"reference":"R"}')"
check "3 options au lieu de 4 → 400"    400 "$(api POST "$IT" "$TOKEN1" '{"parole":"P","options":["A","B","C"],"bonne":0,"reference":"R"}')"
check "série inconnue → 404"            404 "$(api POST "/api/groupes/$QGCODE/series/quiadit/999999/items" "$TOKEN1" '{"parole":"P","options":["A","B","C","D"],"bonne":0,"reference":"Actes 20.35"}')"

say "Séries d'église — l'avertissement de conformité, qui ne bloque jamais"
check "parole absente du verset → 201 quand même" 201 \
  "$(api POST "$IT" "$TOKEN1" '{"parole":"Une parole de notre assemblée","options":["Moïse","David","Paul","Pierre"],"bonne":2,"reference":"Actes 20.35"}')"
IID1="$(jval .item.id)"
check "→ id de la famille egl-"         egl "${IID1%-*}"
check "et un avertissement est rendu"   true "$(jval '.avertissement != null')"
check "l'avertissement nomme la référence" true "$(jval '.avertissement | test("Actes 20.35")')"
check "parole exacte → aucun avertissement" true \
  "$(api POST "$IT" "$TOKEN1" '{"parole":"Il y a plus de bonheur à donner qu à recevoir","options":["Jésus","Paul","Pierre","Jean"],"bonne":1,"reference":"Actes 20.35"}' > /dev/null; jval '.avertissement == null')"
IID2="$(jval .item.id)"
check "référence illisible → on se tait" true \
  "$(api POST "$IT" "$TOKEN1" '{"parole":"Question propre à notre organisation","options":["A","B","C","D"],"bonne":0,"reference":"Notre règlement 3"}' > /dev/null; jval '.avertissement == null')"
IID3="$(jval .item.id)"
check "3 items dans la série"           3 "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN1" > /dev/null; jval '.series[0].nbItems')"

say "Séries d'église — publier, et le plancher de 3 questions"
check "état inconnu → 400"              400 "$(api POST "/api/groupes/$QGCODE/series/quiadit/$SID" "$TOKEN1" '{"etat":"visible"}')"
check "u3 ne publie pas → 403"          403 "$(api POST "/api/groupes/$QGCODE/series/quiadit/$SID" "$TOKEN3" '{"etat":"publiee"}')"
check "publication → 200"               200 "$(api POST "/api/groupes/$QGCODE/series/quiadit/$SID" "$TOKEN1" '{"etat":"publiee"}')"
check "état publiee"                    publiee "$(jval .serie.etat)"
check "renommer → 200"                  200 "$(api POST "/api/groupes/$QGCODE/series/quiadit/$SID" "$TOKEN1" '{"nom":"Série sur Jonas"}')"
check "le nom a changé"                 "Série sur Jonas" "$(jval .serie.nom)"
check "le membre la voit enfin"         1   "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN3" > /dev/null; jval '.series | length')"

say "Séries d'église — jouer une série"
JOUE="/api/groupes/$QGCODE/series/quiadit/$SID/items"
check "u2 (non-membre) → 403"           403 "$(api GET "$JOUE" "$TOKEN2")"
check "u3 (membre) → 200"               200 "$(api GET "$JOUE" "$TOKEN3")"
check "format : version + items"        true "$(jval 'has("version") and has("items")')"
check "3 items servis"                  3   "$(jval '.items | length')"
check "la série est nommée"             "Série sur Jonas" "$(jval .serie.nom)"
check "l'item de l'église est bien là"  "Une parole de notre assemblée" \
  "$(jval ".items[] | select(.id == \"$IID1\") | .parole")"

say "Séries d'église — retomber sous le plancher dépublie"
check "suppression d'un item → 200"     200 "$(api DELETE "/api/groupes/$QGCODE/series/quiadit/$SID/items/$IID3" "$TOKEN1")"
check "il en reste 2"                   2   "$(jval .nbItems)"
check "la série est repassée en brouillon" true "$(jval .depubliee)"
check "le membre ne la voit plus"       0   "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN3" > /dev/null; jval '.series | length')"
check "et ne peut plus y jouer → 403"   403 "$(api GET "$JOUE" "$TOKEN3")"
check "republier à 2 questions → 400"   400 "$(api POST "/api/groupes/$QGCODE/series/quiadit/$SID" "$TOKEN1" '{"etat":"publiee"}')"
check "item inconnu supprimé → 404"     404 "$(api DELETE "/api/groupes/$QGCODE/series/quiadit/$SID/items/egl-000000" "$TOKEN1")"

say "Séries d'église — le plafond de séries publiées, et l'archivage qui libère"
# On remonte la série d'origine à 3 items, puis on en publie 7 autres : 8 au total.
api POST "$IT" "$TOKEN1" '{"parole":"Troisième parole","options":["A","B","C","D"],"bonne":0,"reference":"Actes 20.35"}' > /dev/null
api POST "/api/groupes/$QGCODE/series/quiadit/$SID" "$TOKEN1" '{"etat":"publiee"}' > /dev/null
for n in 2 3 4 5 6 7 8; do
  api POST "/api/groupes/$QGCODE/series/quiadit" "$TOKEN1" "{\"nom\":\"Série $n\"}" > /dev/null
  SN="$(jval .serie.id)"
  for q in 1 2 3; do
    api POST "/api/groupes/$QGCODE/series/quiadit/$SN/items" "$TOKEN1" \
      "{\"parole\":\"Parole $n-$q\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"bonne\":0,\"reference\":\"Actes 20.35\"}" > /dev/null
  done
  api POST "/api/groupes/$QGCODE/series/quiadit/$SN" "$TOKEN1" '{"etat":"publiee"}' > /dev/null
  [ "$n" = "8" ] && SDERN="$SN"
done
check "8 séries publiées"               8 "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN3" > /dev/null; jval '.series | length')"
api POST "/api/groupes/$QGCODE/series/quiadit" "$TOKEN1" '{"nom":"La neuvième"}' > /dev/null
SNEUF="$(jval .serie.id)"
for q in 1 2 3; do
  api POST "/api/groupes/$QGCODE/series/quiadit/$SNEUF/items" "$TOKEN1" \
    "{\"parole\":\"Parole 9-$q\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"bonne\":0,\"reference\":\"Actes 20.35\"}" > /dev/null
done
check "publier la 9e → 409"             409 "$(api POST "/api/groupes/$QGCODE/series/quiadit/$SNEUF" "$TOKEN1" '{"etat":"publiee"}')"
check "le refus dit d'archiver"         true "$(jval '.error | test("archive")')"
check "archiver la 8e → 200"            200 "$(api POST "/api/groupes/$QGCODE/series/quiadit/$SDERN" "$TOKEN1" '{"etat":"archivee"}')"
check "la 9e passe alors → 200"         200 "$(api POST "/api/groupes/$QGCODE/series/quiadit/$SNEUF" "$TOKEN1" '{"etat":"publiee"}')"
check "toujours 8 visibles pour le membre" 8 "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN3" > /dev/null; jval '.series | length')"
check "l'archivée n'est pas perdue"     archivee \
  "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN1" > /dev/null; jval ".series[] | select(.id == $SDERN) | .etat")"

# Le rôle est ATTACHÉ À UNE ÉGLISE, jamais à la personne. Quelqu'un qui
# porte une assemblée et fréquente la voisine ne doit rien pouvoir y faire de
# plus qu'un membre — et ne doit pas voir ses brouillons.
say "Séries d'église — responsable ailleurs ne donne aucun droit ici"
AUTRE="$(groupe_via_demande "$TOKEN3" "Assemblée de u3")"
check "u3 est responsable chez lui → 201" 201 "$(api POST "/api/groupes/$AUTRE/series/quiadit" "$TOKEN3" '{"nom":"Chez u3"}')"
check "…et toujours refusé chez QGCODE → 403" 403 "$(api POST "/api/groupes/$QGCODE/series/quiadit" "$TOKEN3" '{"nom":"Intrusion"}')"
check "il n y anime pas"                  false "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN3" > /dev/null; jval .anime)"
check "il anime bien chez lui"            true  "$(api GET "/api/groupes/$AUTRE/series/quiadit" "$TOKEN3" > /dev/null; jval .anime)"
# Un brouillon de QGCODE reste invisible, et injouable même en devinant son id.
api POST "/api/groupes/$QGCODE/series/quiadit" "$TOKEN1" '{"nom":"Brouillon du responsable"}' > /dev/null
BROU="$(jval .serie.id)"
check "le brouillon n apparaît pas à u3"  0 \
  "$(api GET "/api/groupes/$QGCODE/series/quiadit" "$TOKEN3" > /dev/null; jval "[.series[] | select(.id == $BROU)] | length")"
check "et ne se joue pas → 403"           403 "$(api GET "/api/groupes/$QGCODE/series/quiadit/$BROU/items" "$TOKEN3")"
check "u3 ne le publie pas → 403"         403 "$(api POST "/api/groupes/$QGCODE/series/quiadit/$BROU" "$TOKEN3" '{"etat":"publiee"}')"
check "ni ne le supprime → 403"           403 "$(api DELETE "/api/groupes/$QGCODE/series/quiadit/$BROU" "$TOKEN3")"
# Viser une série d'une autre église avec SON code : introuvable, pas servie.
check "série d une autre église → 404"    404 "$(api GET "/api/groupes/$AUTRE/series/quiadit/$BROU/items" "$TOKEN3")"
check "u3 ne voit pas le contenu admin de QGCODE → 403" 403 "$(api GET "/api/admin/groupes/$QGCODE" "$TOKEN3")"
api DELETE "/api/groupes/$AUTRE" "$TOKEN3" > /dev/null
api DELETE "/api/groupes/$QGCODE/series/quiadit/$BROU" "$TOKEN1" > /dev/null

say "Séries d'église — suppression d'une série, items compris"
check "série inconnue → 404"            404 "$(api DELETE "/api/groupes/$QGCODE/series/quiadit/999999" "$TOKEN1")"
check "u3 ne supprime pas → 403"        403 "$(api DELETE "/api/groupes/$QGCODE/series/quiadit/$SNEUF" "$TOKEN3")"
check "suppression → 200"               200 "$(api DELETE "/api/groupes/$QGCODE/series/quiadit/$SNEUF" "$TOKEN1")"
check "ses items ne se jouent plus → 404" 404 "$(api GET "/api/groupes/$QGCODE/series/quiadit/$SNEUF/items" "$TOKEN1")"

say "Séries d'église — une épreuve n'empiète pas sur l'autre"
check "portrait : aucune série"         0 "$(api GET "/api/groupes/$QGCODE/series/portrait" "$TOKEN1" > /dev/null; jval '.series | length')"
check "portrait sans ses 5 indices → 400" 400 \
  "$(api POST "/api/groupes/$QGCODE/series/portrait" "$TOKEN1" '{"nom":"Portraits de Jonas"}' > /dev/null; SP="$(jval .serie.id)"; api POST "/api/groupes/$QGCODE/series/portrait/$SP/items" "$TOKEN1" '{"reponse":"Moïse","accepte":["Moïse"],"genre":"personnage","indices":["Un seul indice"],"reference":"Exode 2"}')"
check "la série de quiadit est introuvable côté portrait → 404" 404 \
  "$(api GET "/api/groupes/$QGCODE/series/portrait/$SID/items" "$TOKEN1")"

# Ce que l'administration peut voir et retirer d'une église. Ce n'est pas de
# la modération a priori — personne ne relit avant publication — mais le
# minimum pour agir sur signalement, comme les mentions légales l'annoncent.
say "Administration — voir et retirer le contenu d'une église"
check "liste des églises sans token → 401" 401 "$(api GET /api/admin/groupes)"
check "liste par u3 (non-admin) → 403"     403 "$(api GET /api/admin/groupes "$TOKEN3")"
check "liste par l admin → 200"            200 "$(api GET /api/admin/groupes "$TOKEN1")"
check "l église du quiz y figure"          true "$(jval "[.groupes[] | select(.code == \"$QGCODE\")] | length > 0")"
check "contenu par u3 → 403"               403 "$(api GET "/api/admin/groupes/$QGCODE" "$TOKEN3")"
check "contenu par l admin → 200"          200 "$(api GET "/api/admin/groupes/$QGCODE" "$TOKEN1")"
check "les séries sont listées"            true "$(jval '(.series | length) > 0')"
check "les items portent leur texte"       true "$(jval '(.items | length) > 0 and ((.items[0].texte | length) > 0)')"
ADMIID="$(jval '.items[0].id')"
check "type de contenu inconnu → 404"      404 "$(api DELETE "/api/admin/groupes/$QGCODE/contenu/chanson/$ADMIID" "$TOKEN1")"
check "item inconnu → 404"                 404 "$(api DELETE "/api/admin/groupes/$QGCODE/contenu/item/egl-000000" "$TOKEN1")"
check "retrait par u3 → 403"               403 "$(api DELETE "/api/admin/groupes/$QGCODE/contenu/item/$ADMIID" "$TOKEN3")"
check "retrait par l admin → 200"          200 "$(api DELETE "/api/admin/groupes/$QGCODE/contenu/item/$ADMIID" "$TOKEN1")"
check "le retrait est tracé au journal"    true \
  "$(api GET /api/admin/log "$TOKEN1" > /dev/null; jval '[.log[] | select(.action == "retrait-item")] | length > 0')"
# Retirer une série emporte ses questions : rien ne reste orphelin en base.
api GET "/api/admin/groupes/$QGCODE" "$TOKEN1" > /dev/null
ADMSID="$(jval '.series[0].id')"
ADMAVANT="$(jval '.items | length')"
check "retrait d une série → 200"          200 "$(api DELETE "/api/admin/groupes/$QGCODE/contenu/serie/$ADMSID" "$TOKEN1")"
check "ses questions sont parties avec"    true \
  "$(api GET "/api/admin/groupes/$QGCODE" "$TOKEN1" > /dev/null; jval "(.items | length) < $ADMAVANT")"
check "église inconnue → 404"              404 "$(api GET "/api/admin/groupes/GRP-ZZZZZ" "$TOKEN1")"

say "Quiz d'église — suppression du groupe : tout est purgé"
QSQL() { php -r '$p = new PDO("sqlite:" . $argv[1]); echo $p->query($argv[2])->fetchColumn();' "$ROOT/api/data/dev.sqlite" "$1"; }
check "u1 supprime le groupe → 200"     200 "$(api DELETE "/api/groupes/$QGCODE" "$TOKEN1")"
check "GET quiz sur le groupe disparu → 404" 404 "$(api GET "/api/groupes/$QGCODE/quiz" "$TOKEN1")"
check "réglages + sélection + propres + liens : 0 ligne" 0 \
  "$(QSQL 'SELECT (SELECT COUNT(*) FROM groupe_quiz_reglages) + (SELECT COUNT(*) FROM groupe_quiz_selection) + (SELECT COUNT(*) FROM groupe_questions) + (SELECT COUNT(*) FROM veillee_groupes)')"
check "séries et items d'épreuves : 0 ligne aussi" 0 \
  "$(QSQL 'SELECT (SELECT COUNT(*) FROM groupe_banques) + (SELECT COUNT(*) FROM groupe_banque_items) + (SELECT COUNT(*) FROM groupe_series)')"
check "la veillée liée survit, sans église" false "$(api GET "/api/veillees/$VQCODE/state" > /dev/null; jval '.veillee | has("eglise")')"

# ---------------------------------------------------------------------------
# La page de l'église (fondations serveur — aucune interface encore).
# Toujours aucun appel request-code : TOKEN1/TOKEN2/TOKEN3 suffisent.
# Regards directs dans la base SQLite (aussi utilisés plus bas, Notifications).
sqlval()  { php -r '$p = new PDO("sqlite:" . $argv[1]); echo $p->query($argv[2])->fetchColumn();' "$ROOT/api/data/dev.sqlite" "$1"; }
sqlexec() { php -r '$p = new PDO("sqlite:" . $argv[1]); $p->exec($argv[2]);' "$ROOT/api/data/dev.sqlite" "$1"; }

say "La page de l'église — vide au départ, réservée aux membres"
PGCODE="$(groupe_via_demande "$TOKEN1" "Assemblée du Chemin")"
api POST /api/groupes/rejoindre "$TOKEN3" "{\"code\":\"$PGCODE\"}" > /dev/null
check "GET page sans token → 401"       401 "$(api GET "/api/groupes/$PGCODE/page")"
check "GET page non-membre (u2) → 403"  403 "$(api GET "/api/groupes/$PGCODE/page" "$TOKEN2")"
check "GET page groupe inconnu → 404"   404 "$(api GET /api/groupes/GRP-00000/page "$TOKEN1")"
check "GET page membre (u3) → 200"      200 "$(api GET "/api/groupes/$PGCODE/page" "$TOKEN3")"
check "aucune annonce"                  0   "$(jval '.annonces | length')"
check "aucun rendez-vous"               0   "$(jval '.rdv | length')"
check "aucun service"                   0   "$(jval '.services | length')"

say "Page — annonces : le responsable nourrit"
check "u3 (membre) publie → 403"        403 "$(api POST "/api/groupes/$PGCODE/annonces" "$TOKEN3" '{"titre":"Essai","texte":"Coucou"}')"
check "titre vide → 400"                400 "$(api POST "/api/groupes/$PGCODE/annonces" "$TOKEN1" '{"titre":"  ","texte":"Bonjour"}')"
check "titre de 81 caractères → 400"    400 "$(api POST "/api/groupes/$PGCODE/annonces" "$TOKEN1" "{\"titre\":\"$(php -r 'echo str_repeat("a", 81);')\",\"texte\":\"Bonjour\"}")"
check "texte de 2001 caractères → 400"  400 "$(api POST "/api/groupes/$PGCODE/annonces" "$TOKEN1" "{\"titre\":\"Titre\",\"texte\":\"$(php -r 'echo str_repeat("a", 2001);')\"}")"
check "création → 201"                  201 "$(api POST "/api/groupes/$PGCODE/annonces" "$TOKEN1" '{"titre":"Bienvenue","texte":"Soyez les bienvenus dans notre assemblée."}')"
AN1="$(jval .annonce.id)"
check "→ epingle false par défaut"      false "$(jval .annonce.epingle)"
check "→ date en ISO"                   Z   "$(jval .annonce.date | tail -c 2)"
check "création épinglée → 201"         201 "$(api POST "/api/groupes/$PGCODE/annonces" "$TOKEN1" '{"titre":"Semaine de prière","texte":"Du lundi au vendredi à 6 h.","epingle":true}')"
AN2="$(jval .annonce.id)"
api GET "/api/groupes/$PGCODE/page" "$TOKEN3" > /dev/null
check "2 annonces sur la page"          2   "$(jval '.annonces | length')"
check "l'épinglée passe en tête"        "$AN2" "$(jval '.annonces[0].id')"
check "modification → 200"              200 "$(api POST "/api/groupes/$PGCODE/annonces" "$TOKEN1" "{\"id\":$AN1,\"titre\":\"Bienvenue à tous\",\"texte\":\"Texte mis à jour.\"}")"
check "→ titre mis à jour"              "Bienvenue à tous" "$(jval .annonce.titre)"
check "modification d'un id inconnu → 404" 404 "$(api POST "/api/groupes/$PGCODE/annonces" "$TOKEN1" '{"id":999999,"titre":"X","texte":"Y"}')"
check "suppression par u3 → 403"        403 "$(api DELETE "/api/groupes/$PGCODE/annonces/$AN2" "$TOKEN3")"
check "suppression → 200"               200 "$(api DELETE "/api/groupes/$PGCODE/annonces/$AN2" "$TOKEN1")"
check "suppression rejouée → 404"       404 "$(api DELETE "/api/groupes/$PGCODE/annonces/$AN2" "$TOKEN1")"

say "Page — les rendez-vous réguliers de l'assemblée"
check "u3 (membre) ajoute → 403"        403 "$(api POST "/api/groupes/$PGCODE/rdv" "$TOKEN3" '{"libelle":"Culte","jour":0,"heure":"10:30"}')"
check "jour 7 → 400"                    400 "$(api POST "/api/groupes/$PGCODE/rdv" "$TOKEN1" '{"libelle":"Culte","jour":7,"heure":"10:30"}')"
check "jour absent → 400"               400 "$(api POST "/api/groupes/$PGCODE/rdv" "$TOKEN1" '{"libelle":"Culte","heure":"10:30"}')"
check "heure 25:00 → 400"               400 "$(api POST "/api/groupes/$PGCODE/rdv" "$TOKEN1" '{"libelle":"Culte","jour":0,"heure":"25:00"}')"
check "heure 9h30 → 400"                400 "$(api POST "/api/groupes/$PGCODE/rdv" "$TOKEN1" '{"libelle":"Culte","jour":0,"heure":"9h30"}')"
check "création Culte (dim. 10:30) → 201" 201 "$(api POST "/api/groupes/$PGCODE/rdv" "$TOKEN1" '{"libelle":"Culte","jour":0,"heure":"10:30"}')"
RDV1="$(jval .rdv.id)"
check "→ lieu null si non fourni"       null "$(jval .rdv.lieu)"
check "création Prière (mer. 19:00) → 201" 201 "$(api POST "/api/groupes/$PGCODE/rdv" "$TOKEN1" '{"libelle":"Prière","jour":3,"heure":"19:00","lieu":"Salle du haut"}')"
check "création Accueil (dim. 09:45) → 201" 201 "$(api POST "/api/groupes/$PGCODE/rdv" "$TOKEN1" '{"libelle":"Accueil","jour":0,"heure":"09:45"}')"
api GET "/api/groupes/$PGCODE/page" "$TOKEN3" > /dev/null
check "3 rendez-vous sur la page"       3   "$(jval '.rdv | length')"
check "tri par jour puis heure"         "0 09:45,0 10:30,3 19:00" "$(jval '[.rdv[] | "\(.jour) \(.heure)"] | join(",")')"
check "modification (le culte passe à 10:00) → 200" 200 "$(api POST "/api/groupes/$PGCODE/rdv" "$TOKEN1" "{\"id\":$RDV1,\"libelle\":\"Culte\",\"jour\":0,\"heure\":\"10:00\"}")"
check "suppression par u3 → 403"        403 "$(api DELETE "/api/groupes/$PGCODE/rdv/$RDV1" "$TOKEN3")"
check "suppression → 200"               200 "$(api DELETE "/api/groupes/$PGCODE/rdv/$RDV1" "$TOKEN1")"
api GET "/api/groupes/$PGCODE/page" "$TOKEN1" > /dev/null
check "2 rendez-vous restants"          2   "$(jval '.rdv | length')"

say "Page — services : on lève la main, on n'est pas réquisitionné"
DEMAIN="$(php -r 'echo gmdate("Y-m-d", time() + 86400);')"
check "u3 (membre) crée → 403"          403 "$(api POST "/api/groupes/$PGCODE/services" "$TOKEN3" "{\"titre\":\"Essai\",\"date\":\"$DEMAIN\",\"places\":2}")"
check "date passée → 400"               400 "$(api POST "/api/groupes/$PGCODE/services" "$TOKEN1" '{"titre":"Nettoyage","date":"2020-01-01","places":2}')"
check "date impossible (30 février) → 400" 400 "$(api POST "/api/groupes/$PGCODE/services" "$TOKEN1" '{"titre":"Nettoyage","date":"2026-02-30","places":2}')"
check "date mal formée → 400"           400 "$(api POST "/api/groupes/$PGCODE/services" "$TOKEN1" '{"titre":"Nettoyage","date":"demain","places":2}')"
check "places 0 → 400"                  400 "$(api POST "/api/groupes/$PGCODE/services" "$TOKEN1" "{\"titre\":\"Nettoyage\",\"date\":\"$DEMAIN\",\"places\":0}")"
check "places 51 → 400"                 400 "$(api POST "/api/groupes/$PGCODE/services" "$TOKEN1" "{\"titre\":\"Nettoyage\",\"date\":\"$DEMAIN\",\"places\":51}")"
check "création (1 place) → 201"        201 "$(api POST "/api/groupes/$PGCODE/services" "$TOKEN1" "{\"titre\":\"Nettoyage de la salle\",\"date\":\"$DEMAIN\",\"places\":1,\"details\":\"Après le culte\"}")"
SRV1="$(jval .service.id)"
check "→ personne d'inscrit au départ"  0   "$(jval '.service.inscrits | length')"
api GET "/api/groupes/$PGCODE/page" "$TOKEN3" > /dev/null
check "u3 voit le service, pas inscrit" false "$(jval '.services[0].jeSuisInscrit')"
check "u3 lève la main → 200"           200 "$(api POST "/api/groupes/$PGCODE/services/$SRV1/inscription" "$TOKEN3")"
check "u2 (non-membre) s'inscrit → 403" 403 "$(api POST "/api/groupes/$PGCODE/services/$SRV1/inscription" "$TOKEN2")"
check "u3 se réinscrit → 409"           409 "$(api POST "/api/groupes/$PGCODE/services/$SRV1/inscription" "$TOKEN3")"
check "u1 : service complet → 409"      409 "$(api POST "/api/groupes/$PGCODE/services/$SRV1/inscription" "$TOKEN1")"
check "service inconnu → 404"           404 "$(api POST "/api/groupes/$PGCODE/services/999999/inscription" "$TOKEN1")"
api GET "/api/groupes/$PGCODE/page" "$TOKEN3" > /dev/null
check "Chloé visible dans les inscrits" "Chloé" "$(jval '.services[0].inscrits[0]')"
check "jeSuisInscrit pour u3"           true "$(jval '.services[0].jeSuisInscrit')"
check "jamais d'e-mail sur la page"     false "$(jval 'tostring | contains("@")')"
check "u3 se retire → 200"              200 "$(api DELETE "/api/groupes/$PGCODE/services/$SRV1/inscription" "$TOKEN3")"
check "u3 se retire à nouveau → 404"    404 "$(api DELETE "/api/groupes/$PGCODE/services/$SRV1/inscription" "$TOKEN3")"
check "place libérée : u1 s'inscrit → 200" 200 "$(api POST "/api/groupes/$PGCODE/services/$SRV1/inscription" "$TOKEN1")"

say "Page — retoucher puis supprimer un service (les inscriptions partent avec)"
APRES="$(php -r 'echo gmdate("Y-m-d", time() + 3 * 86400);')"
check "modification (repoussé, 2 places) → 200" 200 "$(api POST "/api/groupes/$PGCODE/services" "$TOKEN1" "{\"id\":$SRV1,\"titre\":\"Nettoyage de la salle\",\"date\":\"$APRES\",\"places\":2}")"
check "→ u1 toujours inscrit"           true "$(jval .service.jeSuisInscrit)"
check "u3 prend la 2e place → 200"      200 "$(api POST "/api/groupes/$PGCODE/services/$SRV1/inscription" "$TOKEN3")"
check "réduire à 1 place sous les 2 mains levées → 400" 400 "$(api POST "/api/groupes/$PGCODE/services" "$TOKEN1" "{\"id\":$SRV1,\"titre\":\"Nettoyage de la salle\",\"date\":\"$APRES\",\"places\":1}")"
check "suppression par u3 → 403"        403 "$(api DELETE "/api/groupes/$PGCODE/services/$SRV1" "$TOKEN3")"
check "suppression → 200"               200 "$(api DELETE "/api/groupes/$PGCODE/services/$SRV1" "$TOKEN1")"
check "ses inscriptions sont parties"   0   "$(sqlval "SELECT COUNT(*) FROM groupe_service_inscriptions WHERE service_id = $SRV1")"
api GET "/api/groupes/$PGCODE/page" "$TOKEN1" > /dev/null
check "plus aucun service sur la page"  0   "$(jval '.services | length')"

say "Page — ménage : les services passés depuis plus de 90 jours sont balayés"
PGID="$(sqlval "SELECT id FROM groupes WHERE code = '$PGCODE'")"
HIER="$(php -r 'echo gmdate("Y-m-d", time() - 86400);')"
JADIS="$(php -r 'echo gmdate("Y-m-d", time() - 100 * 86400);')"
sqlexec "INSERT INTO groupe_services (groupe_id, titre, date_service, details, places, created_at) VALUES ($PGID, 'Hier', '$HIER', NULL, 2, '2000-01-01 00:00:00'), ($PGID, 'Jadis', '$JADIS', NULL, 2, '2000-01-01 00:00:00')"
JADIS_ID="$(sqlval "SELECT id FROM groupe_services WHERE titre = 'Jadis'")"
sqlexec "INSERT INTO groupe_service_inscriptions (service_id, user_id, created_at) VALUES ($JADIS_ID, 1, '2000-01-01 00:00:00')"
api GET "/api/groupes/$PGCODE/page" "$TOKEN1" > /dev/null
check "les services passés ne s'affichent pas" 0 "$(jval '.services | length')"
check "plus de 90 jours : balayé"       0   "$(sqlval "SELECT COUNT(*) FROM groupe_services WHERE id = $JADIS_ID")"
check "… et ses inscriptions avec lui"  0   "$(sqlval "SELECT COUNT(*) FROM groupe_service_inscriptions WHERE service_id = $JADIS_ID")"
check "moins de 90 jours : conservé"    1   "$(sqlval "SELECT COUNT(*) FROM groupe_services WHERE date_service = '$HIER'")"

say "Page — plafonds par groupe (remplissage direct en base pour rester sobre)"
VALS=""
for i in $(seq 1 99); do VALS="$VALS,($PGID,'Remplissage $i','texte',0,'2000-01-01 00:00:00','2000-01-01 00:00:00')"; done
sqlexec "INSERT INTO groupe_annonces (groupe_id, titre, texte, epingle, created_at, updated_at) VALUES ${VALS#,}"
check "la 101e annonce → 400"           400 "$(api POST "/api/groupes/$PGCODE/annonces" "$TOKEN1" '{"titre":"De trop","texte":"Une de trop."}')"
api GET "/api/groupes/$PGCODE/page" "$TOKEN1" > /dev/null
check "la page s'arrête à 50 annonces"  50  "$(jval '.annonces | length')"
sqlexec "DELETE FROM groupe_annonces WHERE titre LIKE 'Remplissage %'"
VALS=""
for i in $(seq 1 28); do VALS="$VALS,($PGID,'Remplissage $i',1,'12:00',NULL,0)"; done
sqlexec "INSERT INTO groupe_rdv (groupe_id, libelle, jour, heure, lieu, ordre) VALUES ${VALS#,}"
check "le 31e rendez-vous → 400"        400 "$(api POST "/api/groupes/$PGCODE/rdv" "$TOKEN1" '{"libelle":"De trop","jour":1,"heure":"12:00"}')"
sqlexec "DELETE FROM groupe_rdv WHERE libelle LIKE 'Remplissage %'"
VALS=""
for i in $(seq 1 100); do VALS="$VALS,($PGID,'Remplissage $i','$DEMAIN',NULL,2,'2000-01-01 00:00:00')"; done
sqlexec "INSERT INTO groupe_services (groupe_id, titre, date_service, details, places, created_at) VALUES ${VALS#,}"
check "le 101e service à venir → 400"   400 "$(api POST "/api/groupes/$PGCODE/services" "$TOKEN1" "{\"titre\":\"De trop\",\"date\":\"$DEMAIN\",\"places\":2}")"
sqlexec "DELETE FROM groupe_services WHERE titre LIKE 'Remplissage %'"

say "Propositions — packs de versets et chemins de lecture (l'équipe propose, tous lisent)"
check "liste par u3 (membre) → 200"     200 "$(api GET "/api/groupes/$PGCODE/propositions" "$TOKEN3")"
check "vide au départ"                  0   "$(jval '.propositions | length')"
check "liste par u2 (non-membre) → 403" 403 "$(api GET "/api/groupes/$PGCODE/propositions" "$TOKEN2")"
check "création par u3 (membre) → 403"  403 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN3" '{"genre":"pack","titre":"X","versets":[{"reference":"R","texte":"T"}]}')"
check "genre inconnu → 400"             400 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN1" '{"genre":"chanson","titre":"X"}')"
check "titre vide → 400"                400 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN1" '{"genre":"pack","titre":"  ","versets":[{"reference":"R","texte":"T"}]}')"
check "pack sans verset → 400"          400 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN1" '{"genre":"pack","titre":"Vide","versets":[]}')"
check "verset sans texte → 400"         400 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN1" '{"genre":"pack","titre":"X","versets":[{"reference":"Matthieu 5.3","texte":"  "}]}')"
check "pack créé → 201"                 201 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN1" '{"genre":"pack","titre":"Les Béatitudes","description":"Six semaines ensemble.","versets":[{"reference":"Matthieu 5.3","texte":"Heureux les pauvres en esprit…"},{"reference":"Matthieu 5.4","texte":"Heureux les affligés…"}]}')"
PACKID="$(jval .proposition.id)"
check "→ 2 versets rangés"              2   "$(jval '.proposition.contenu.versets | length')"
check "→ la description suit"           "Six semaines ensemble." "$(jval .proposition.description)"
check "livre inconnu → 400"             400 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN1" '{"genre":"lecture","titre":"X","livres":["evangile-secret"]}')"
check "tentative de chemin de fichier → 400" 400 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN1" '{"genre":"lecture","titre":"X","livres":["../../api/db"]}')"
check "chemin de lecture créé → 201"    201 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN1" '{"genre":"lecture","titre":"Luc avant Pâques","livres":["luc","actes","luc"]}')"
LECID="$(jval .proposition.id)"
check "→ le doublon est fondu"          2   "$(jval '.proposition.contenu.livres | length')"
check "modification du pack → 200"      200 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN1" "{\"id\":$PACKID,\"genre\":\"pack\",\"titre\":\"Les Béatitudes (revu)\",\"versets\":[{\"reference\":\"Matthieu 5.3\",\"texte\":\"Heureux les pauvres en esprit…\"}]}")"
check "→ le titre a suivi"              "Les Béatitudes (revu)" "$(jval .proposition.titre)"
check "modifier en changeant de genre → 404" 404 "$(api POST "/api/groupes/$PGCODE/propositions" "$TOKEN1" "{\"id\":$PACKID,\"genre\":\"lecture\",\"titre\":\"Détournement\",\"livres\":[\"luc\"]}")"
check "les membres voient les deux"     2   "$(api GET "/api/groupes/$PGCODE/propositions" "$TOKEN3" > /dev/null; jval '.propositions | length')"
check "suppression par u3 → 403"        403 "$(api DELETE "/api/groupes/$PGCODE/propositions/$LECID" "$TOKEN3")"
check "suppression par u1 → 200"        200 "$(api DELETE "/api/groupes/$PGCODE/propositions/$LECID" "$TOKEN1")"
check "supprimée deux fois → 404"       404 "$(api DELETE "/api/groupes/$PGCODE/propositions/$LECID" "$TOKEN1")"

say "Page — la suppression du groupe emporte toute la page"
api POST "/api/groupes/$PGCODE/services" "$TOKEN1" "{\"titre\":\"Dernier service\",\"date\":\"$DEMAIN\",\"places\":2}" > /dev/null
SRV2="$(jval .service.id)"
api POST "/api/groupes/$PGCODE/services/$SRV2/inscription" "$TOKEN3" > /dev/null
check "suppression du groupe → 200"     200 "$(api DELETE "/api/groupes/$PGCODE" "$TOKEN1")"
check "la page a disparu → 404"         404 "$(api GET "/api/groupes/$PGCODE/page" "$TOKEN1")"
check "annonces purgées"                0   "$(sqlval "SELECT COUNT(*) FROM groupe_annonces WHERE groupe_id = $PGID")"
check "rendez-vous purgés"              0   "$(sqlval "SELECT COUNT(*) FROM groupe_rdv WHERE groupe_id = $PGID")"
check "services purgés"                 0   "$(sqlval "SELECT COUNT(*) FROM groupe_services WHERE groupe_id = $PGID")"
check "inscriptions purgées"            0   "$(sqlval "SELECT COUNT(*) FROM groupe_service_inscriptions WHERE service_id = $SRV2")"
check "propositions purgées"            0   "$(sqlval "SELECT COUNT(*) FROM groupe_propositions WHERE groupe_id = $PGID")"

say "Page — un service chez Benoît (pour la suppression de son compte, plus bas)"
DANS5J="$(php -r 'echo gmdate("Y-m-d", time() + 5 * 86400);')"
check "u2 crée un service → 201"        201 "$(api POST "/api/groupes/$G2CODE/services" "$TOKEN2" "{\"titre\":\"Sonorisation\",\"date\":\"$DANS5J\",\"places\":3}")"
G2SRV="$(jval .service.id)"
check "u2 lève la main → 200"           200 "$(api POST "/api/groupes/$G2CODE/services/$G2SRV/inscription" "$TOKEN2")"
check "u3 lève la main → 200"           200 "$(api POST "/api/groupes/$G2CODE/services/$G2SRV/inscription" "$TOKEN3")"
check "2 mains levées"                  2   "$(sqlval "SELECT COUNT(*) FROM groupe_service_inscriptions WHERE service_id = $G2SRV")"

# ---------------------------------------------------------------------------
say "Administration — rôle admin (ADMIN_EMAILS=alice@example.org)"
api GET /api/me "$TOKEN1" > /dev/null
check "me alice : isAdmin true"         true  "$(jval .user.isAdmin)"
api GET /api/me "$TOKEN3" > /dev/null
check "me chloé : isAdmin false"        false "$(jval .user.isAdmin)"
check "admin/users sans token → 401"    401 "$(api GET /api/admin/users)"
check "admin/users non-admin → 403"     403 "$(api GET /api/admin/users "$TOKEN3")"
check "admin/users alice → 200"         200 "$(api GET /api/admin/users "$TOKEN1")"
check "3 comptes listés"                3   "$(jval '.users | length')"
check "champs id/pseudo/email/code/dates" true \
  "$(jval '[.users[] | has("id") and has("pseudo") and has("email") and has("friendCode") and has("createdAt") and has("lastSeen")] | all')"
ALICE_ID="$(jval '.users[] | select(.email == "alice@example.org") | .id')"
check "alice se supprime elle-même → 400" 400 "$(api DELETE "/api/admin/users/$ALICE_ID" "$TOKEN1")"
check "id inexistant → 404"             404 "$(api DELETE /api/admin/users/999999 "$TOKEN1")"
check "suppression par non-admin → 403" 403 "$(api DELETE "/api/admin/users/$ALICE_ID" "$TOKEN3")"

say "Fréquentation — compteurs anonymes"
check "signal accepté → 200"            200 "$(api POST /api/visite '' '{"page":"lire"}')"
check "second signal → 200"             200 "$(api POST /api/visite '' '{"page":"lire"}')"
check "page hors liste : avalée → 200"  200 "$(api POST /api/visite '' '{"page":"nimporte"}')"
check "rapport sans compte → 401"       401 "$(api GET /api/admin/visites)"
check "rapport non-admin → 403"         403 "$(api GET /api/admin/visites "$TOKEN3")"
check "rapport admin → 200"             200 "$(api GET /api/admin/visites "$TOKEN1")"
check "2 ouvertures comptées sur lire"  2   "$(jval '.parPage[] | select(.page == "lire") | .n')"
check "la page hors liste n'existe pas" ""  "$(jval '.parPage[] | select(.page == "nimporte") | .n')"
check "le jour du signal est là"        true "$(jval '.parJour | length >= 1')"

say "Administration — suppression totale d'un compte (u4 jetable)"
api POST /api/auth/request-code '' '{"email":"david@example.org"}' > /dev/null
CODE4="$(jval .devCode)"
api POST /api/auth/verify '' "{\"email\":\"david@example.org\",\"code\":\"$CODE4\",\"pseudo\":\"David\"}" > /dev/null
TOKEN4="$(jval .token)"
check "u4 dépose une demande de groupe → 201" 201 "$(api POST /api/groupes/demande "$TOKEN4" '{"nom":"Groupe de David","adresse":"9 rue du Puits, Bethléem","email":"secretariat@bethleem.example.org"}')"
api GET /api/admin/users "$TOKEN1" > /dev/null
check "4 comptes après l'arrivée de u4" 4   "$(jval '.users | length')"
DAVID_ID="$(jval '.users[] | select(.email == "david@example.org") | .id')"
check "admin supprime u4 → 200"         200 "$(api DELETE "/api/admin/users/$DAVID_ID" "$TOKEN1")"
check "la session de u4 est close"      401 "$(api GET /api/me "$TOKEN4")"
check "sa demande de groupe est purgée avec le compte" 0 \
  "$(sqlval "SELECT COUNT(*) FROM groupe_demandes WHERE nom = 'Groupe de David'")"
check "… et ses détails avec elle (aucun orphelin)" 0 \
  "$(sqlval "SELECT COUNT(*) FROM groupe_demande_details WHERE demande_id NOT IN (SELECT id FROM groupe_demandes)")"
api GET /api/admin/users "$TOKEN1" > /dev/null
check "3 comptes restants"              3   "$(jval '.users | length')"

# ---------------------------------------------------------------------------
say "Questions — banque publique fusionnée"
check "GET /api/questions → 200"        200 "$(api GET /api/questions)"
check "version 2"                       2   "$(jval .version)"
check "6 catégories"                    6   "$(jval '.categories | length')"
NBQ="$(jval '.questions | length')"
check "banque du fichier non vide (≥ 300)" 300 "$(( NBQ >= 300 ? 300 : NBQ ))"

say "Questions — écriture réservée à l'admin"
QOK='{"categorie":"Personnages","niveau":1,"question":"Question de test ?","options":["A","B","C","D"],"bonne":2,"reference":"Test 1.1"}'
check "POST sans token → 401"           401 "$(api POST /api/admin/questions '' "$QOK")"
check "POST non-admin → 403"            403 "$(api POST /api/admin/questions "$TOKEN3" "$QOK")"
check "DELETE non-admin → 403"          403 "$(api DELETE /api/admin/questions/per-01 "$TOKEN3")"
check "restore non-admin → 403"         403 "$(api POST /api/admin/questions/per-01/restore "$TOKEN3")"

say "Questions — validations"
check "catégorie inconnue → 400"        400 "$(api POST /api/admin/questions "$TOKEN1" '{"categorie":"Cuisine","niveau":1,"question":"Q ?","options":["A","B","C","D"],"bonne":0,"reference":"R"}')"
check "niveau hors bornes → 400"        400 "$(api POST /api/admin/questions "$TOKEN1" '{"categorie":"Personnages","niveau":4,"question":"Q ?","options":["A","B","C","D"],"bonne":0,"reference":"R"}')"
check "question vide → 400"             400 "$(api POST /api/admin/questions "$TOKEN1" '{"categorie":"Personnages","niveau":1,"question":"  ","options":["A","B","C","D"],"bonne":0,"reference":"R"}')"
check "3 options seulement → 400"       400 "$(api POST /api/admin/questions "$TOKEN1" '{"categorie":"Personnages","niveau":1,"question":"Q ?","options":["A","B","C"],"bonne":0,"reference":"R"}')"
check "option vide → 400"               400 "$(api POST /api/admin/questions "$TOKEN1" '{"categorie":"Personnages","niveau":1,"question":"Q ?","options":["A","","C","D"],"bonne":0,"reference":"R"}')"
check "bonne hors bornes → 400"         400 "$(api POST /api/admin/questions "$TOKEN1" '{"categorie":"Personnages","niveau":1,"question":"Q ?","options":["A","B","C","D"],"bonne":4,"reference":"R"}')"
check "référence vide → 400"            400 "$(api POST /api/admin/questions "$TOKEN1" '{"categorie":"Personnages","niveau":1,"question":"Q ?","options":["A","B","C","D"],"bonne":0,"reference":""}')"
check "id ni fichier ni adm- → 404"     404 "$(api POST /api/admin/questions "$TOKEN1" '{"id":"xyz-99","categorie":"Personnages","niveau":1,"question":"Q ?","options":["A","B","C","D"],"bonne":0,"reference":"R"}')"

say "Questions — ajout avec id (adm-test-1)"
check "ajout adm-test-1 → 200"          200 "$(api POST /api/admin/questions "$TOKEN1" '{"id":"adm-test-1","categorie":"Personnages","niveau":1,"question":"Question de test ?","options":["A","B","C","D"],"bonne":2,"reference":"Test 1.1"}')"
check "→ id conservé"                   adm-test-1 "$(jval .question.id)"
api GET /api/questions > /dev/null
check "banque à N+1 (ajout)"            "$(( NBQ + 1 ))" "$(jval '.questions | length')"
check "adm-test-1 servie"               "Question de test ?" "$(jval '.questions[] | select(.id == "adm-test-1") | .question')"

say "Questions — ajout sans id (généré), puis suppression"
check "ajout sans id → 200"             200 "$(api POST /api/admin/questions "$TOKEN1" "$QOK")"
GEN_ID="$(jval .question.id)"
check "id généré préfixé adm-"          adm- "$(printf '%s' "$GEN_ID" | cut -c1-4)"
check "id généré : adm- + 6 hex"        10  "${#GEN_ID}"
api GET /api/questions > /dev/null
check "banque à N+2 (2e ajout)"         "$(( NBQ + 2 ))" "$(jval '.questions | length')"
check "suppression de l'ajout → 200"    200 "$(api DELETE "/api/admin/questions/$GEN_ID" "$TOKEN1")"
api GET /api/questions > /dev/null
check "banque revenue à N+1"            "$(( NBQ + 1 ))" "$(jval '.questions | length')"

say "Questions — surcharge d'une question du fichier (per-01)"
P01_FICHIER="$(jq -r '.questions[] | select(.id == "per-01") | .question' "$ROOT/defi/data/questions.json")"
check "modification per-01 → 200"       200 "$(api POST /api/admin/questions "$TOKEN1" '{"id":"per-01","categorie":"Personnages","niveau":2,"question":"Qui construisit une arche ? (version admin)","options":["Abraham","Noé","Moïse","Élie"],"bonne":1,"reference":"Genèse 6.14"}')"
api GET /api/questions > /dev/null
check "la banque reste à N+1"           "$(( NBQ + 1 ))" "$(jval '.questions | length')"
check "per-01 : version modifiée servie" "Qui construisit une arche ? (version admin)" \
  "$(jval '.questions[] | select(.id == "per-01") | .question')"
check "per-01 : une seule occurrence"   1   "$(jval '[.questions[] | select(.id == "per-01")] | length')"

say "Questions — désactivation puis restauration (per-01)"
check "DELETE per-01 (désactive) → 200" 200 "$(api DELETE /api/admin/questions/per-01 "$TOKEN1")"
api GET /api/questions > /dev/null
check "banque à N (per-01 retirée, adm-test-1 encore là)" "$NBQ" "$(jval '.questions | length')"
check "per-01 absente de la banque"     0   "$(jval '[.questions[] | select(.id == "per-01")] | length')"
check "restore sans surcharge (per-02) → 404" 404 "$(api POST /api/admin/questions/per-02/restore "$TOKEN1")"
check "restore per-01 → 200"            200 "$(api POST /api/admin/questions/per-01/restore "$TOKEN1")"
api GET /api/questions > /dev/null
check "banque repasse à N+1 (adm-test-1 existe encore)" "$(( NBQ + 1 ))" "$(jval '.questions | length')"
check "per-01 : version du fichier de retour" "$P01_FICHIER" \
  "$(jval '.questions[] | select(.id == "per-01") | .question')"

say "Questions — suppression d'un ajout (adm-test-1)"
check "DELETE d'un id inconnu → 404"    404 "$(api DELETE /api/admin/questions/adm-inconnu "$TOKEN1")"
check "DELETE adm-test-1 → 200"         200 "$(api DELETE /api/admin/questions/adm-test-1 "$TOKEN1")"
api GET /api/questions > /dev/null
check "banque revenue à N"              "$NBQ" "$(jval '.questions | length')"
check "per-01 toujours version fichier" "$P01_FICHIER" \
  "$(jval '.questions[] | select(.id == "per-01") | .question')"

# ---------------------------------------------------------------------------
# Banques des épreuves à fichier (quiadit, ecritoupas, portrait) : même
# système que les questions du Défi — fichier + surcharges en base, banque
# fusionnée servie par GET /api/banque/{module} (voir api/banques.php).

say "Banques d'épreuves — route publique fusionnée"
check "module inconnu → 404"            404 "$(api GET /api/banque/inconnu)"
check "GET /api/banque/quiadit → 200"   200 "$(api GET /api/banque/quiadit)"
NBQD="$(jval '.items | length')"
check "quiadit : items du fichier présents" "$(jq '.items | length' "$ROOT/quiadit/data/banque.json")" "$NBQD"
check "quiadit : qd-001 servie"         "Jean 14.6" "$(jval '.items[] | select(.id == "qd-001") | .reference')"
check "GET /api/banque/ecritoupas → 200" 200 "$(api GET /api/banque/ecritoupas)"
NBEO="$(jval '.items | length')"
check "ecritoupas : eo-001 servie"      false "$(jval '.items[] | select(.id == "eo-001") | .ecrit')"
check "GET /api/banque/portrait → 200"  200 "$(api GET /api/banque/portrait)"
NBPO="$(jval '.items | length')"
check "portrait : po-001 avec 5 indices" 5 "$(jval '.items[] | select(.id == "po-001") | .indices | length')"

say "Banques — écriture réservée à l'admin"
BQD_OK='{"parole":"Parole de test ?","options":["Un","Deux","Trois","Quatre"],"bonne":1,"reference":"Test 1.1","contexte":"Contexte de test."}'
check "POST sans token → 401"           401 "$(api POST /api/admin/banque/quiadit '' "$BQD_OK")"
check "POST non-admin → 403"            403 "$(api POST /api/admin/banque/quiadit "$TOKEN3" "$BQD_OK")"
check "POST module inconnu → 404"       404 "$(api POST /api/admin/banque/inconnu "$TOKEN1" "$BQD_OK")"
check "DELETE non-admin → 403"          403 "$(api DELETE /api/admin/banque/quiadit/qd-001 "$TOKEN3")"
check "restore non-admin → 403"         403 "$(api POST /api/admin/banque/quiadit/qd-001/restore "$TOKEN3")"

say "Banques — validations (quiadit)"
check "parole vide → 400"               400 "$(api POST /api/admin/banque/quiadit "$TOKEN1" '{"parole":"  ","options":["A","B","C","D"],"bonne":0,"reference":"R"}')"
check "3 options seulement → 400"       400 "$(api POST /api/admin/banque/quiadit "$TOKEN1" '{"parole":"P ?","options":["A","B","C"],"bonne":0,"reference":"R"}')"
check "option vide → 400"               400 "$(api POST /api/admin/banque/quiadit "$TOKEN1" '{"parole":"P ?","options":["A","","C","D"],"bonne":0,"reference":"R"}')"
check "bonne hors bornes → 400"         400 "$(api POST /api/admin/banque/quiadit "$TOKEN1" '{"parole":"P ?","options":["A","B","C","D"],"bonne":4,"reference":"R"}')"
check "référence vide → 400"            400 "$(api POST /api/admin/banque/quiadit "$TOKEN1" '{"parole":"P ?","options":["A","B","C","D"],"bonne":0,"reference":""}')"
check "id ni fichier ni adm- → 404"     404 "$(api POST /api/admin/banque/quiadit "$TOKEN1" '{"id":"xyz-99","parole":"P ?","options":["A","B","C","D"],"bonne":0,"reference":"R"}')"

say "Banques — validations (ecritoupas)"
check "ecrit non booléen → 400"         400 "$(api POST /api/admin/banque/ecritoupas "$TOKEN1" '{"phrase":"Phrase.","ecrit":"oui","reference":"R"}')"
check "phrase vide → 400"               400 "$(api POST /api/admin/banque/ecritoupas "$TOKEN1" '{"phrase":"","ecrit":true,"reference":"R"}')"
check "écrit sans référence → 400"      400 "$(api POST /api/admin/banque/ecritoupas "$TOKEN1" '{"phrase":"Phrase.","ecrit":true,"reference":null}')"

say "Banques — validations (portrait)"
check "4 indices seulement → 400"       400 "$(api POST /api/admin/banque/portrait "$TOKEN1" '{"reponse":"Testeur","accepte":["testeur"],"genre":"personnage","indices":["a","b","c","d"],"reference":"R"}')"
check "indice vide → 400"               400 "$(api POST /api/admin/banque/portrait "$TOKEN1" '{"reponse":"Testeur","accepte":["testeur"],"genre":"personnage","indices":["a","b","c","d",""],"reference":"R"}')"
check "accepte vide → 400"              400 "$(api POST /api/admin/banque/portrait "$TOKEN1" '{"reponse":"Testeur","accepte":[],"genre":"personnage","indices":["a","b","c","d","e"],"reference":"R"}')"
check "genre hors liste → 400"          400 "$(api POST /api/admin/banque/portrait "$TOKEN1" '{"reponse":"Testeur","accepte":["testeur"],"genre":"animal","indices":["a","b","c","d","e"],"reference":"R"}')"
check "réponse trop longue → 400"       400 "$(api POST /api/admin/banque/portrait "$TOKEN1" "{\"reponse\":\"$(printf 'x%.0s' $(seq 1 61))\",\"accepte\":[\"testeur\"],\"genre\":\"personnage\",\"indices\":[\"a\",\"b\",\"c\",\"d\",\"e\"],\"reference\":\"R\"}")"

say "Banques — ajout admin (quiadit), visible dans la banque publique"
check "ajout sans id → 200"             200 "$(api POST /api/admin/banque/quiadit "$TOKEN1" "$BQD_OK")"
BQD_ID="$(jval .item.id)"
check "id généré préfixé adm-"          adm- "$(printf '%s' "$BQD_ID" | cut -c1-4)"
api GET /api/banque/quiadit > /dev/null
check "banque à N+1 (ajout)"            "$(( NBQD + 1 ))" "$(jval '.items | length')"
check "l'ajout est servi"               "Parole de test ?" "$(jval ".items[] | select(.id == \"$BQD_ID\") | .parole")"

say "Banques — ajouts admin (ecritoupas, portrait)"
check "ajout ecritoupas → 200"          200 "$(api POST /api/admin/banque/ecritoupas "$TOKEN1" '{"id":"adm-eo-test","phrase":"Phrase de test.","ecrit":false,"reference":null,"precision":"Précision de test."}')"
api GET /api/banque/ecritoupas > /dev/null
check "ecritoupas à N+1"                "$(( NBEO + 1 ))" "$(jval '.items | length')"
check "ajout portrait → 200"            200 "$(api POST /api/admin/banque/portrait "$TOKEN1" '{"id":"adm-po-test","reponse":"Testeur","accepte":["testeur"],"genre":"personnage","indices":["Indice 1","Indice 2","Indice 3","Indice 4","Indice 5"],"reference":"Test 1.1"}')"
api GET /api/banque/portrait > /dev/null
check "portrait à N+1"                  "$(( NBPO + 1 ))" "$(jval '.items | length')"
check "les modules restent étanches (quiadit toujours à N+1)" "$(( NBQD + 1 ))" "$(api GET /api/banque/quiadit > /dev/null; jval '.items | length')"

say "Banques — surcharge d'un item du fichier (qd-001)"
QD01_FICHIER="$(jq -r '.items[] | select(.id == "qd-001") | .parole' "$ROOT/quiadit/data/banque.json")"
check "modification qd-001 → 200"       200 "$(api POST /api/admin/banque/quiadit "$TOKEN1" '{"id":"qd-001","parole":"Parole retouchée (version admin).","options":["Jésus","Pierre","Paul","Jean"],"bonne":0,"reference":"Jean 14.6","contexte":"Contexte retouché."}')"
api GET /api/banque/quiadit > /dev/null
check "la banque reste à N+1"           "$(( NBQD + 1 ))" "$(jval '.items | length')"
check "qd-001 : version modifiée servie" "Parole retouchée (version admin)." "$(jval '.items[] | select(.id == "qd-001") | .parole')"
check "qd-001 : une seule occurrence"   1   "$(jval '[.items[] | select(.id == "qd-001")] | length')"

say "Banques — désactivation puis restauration (qd-001)"
check "DELETE qd-001 (désactive) → 200" 200 "$(api DELETE /api/admin/banque/quiadit/qd-001 "$TOKEN1")"
api GET /api/banque/quiadit > /dev/null
check "banque à N (qd-001 retirée, l'ajout encore là)" "$NBQD" "$(jval '.items | length')"
check "qd-001 absente de la banque"     0   "$(jval '[.items[] | select(.id == "qd-001")] | length')"
check "restore sans surcharge (qd-002) → 404" 404 "$(api POST /api/admin/banque/quiadit/qd-002/restore "$TOKEN1")"
check "restore qd-001 → 200"            200 "$(api POST /api/admin/banque/quiadit/qd-001/restore "$TOKEN1")"
api GET /api/banque/quiadit > /dev/null
check "banque repasse à N+1"            "$(( NBQD + 1 ))" "$(jval '.items | length')"
check "qd-001 : version du fichier de retour" "$QD01_FICHIER" "$(jval '.items[] | select(.id == "qd-001") | .parole')"

say "Banques — désactivation d'un item jamais surchargé (eo-001), puis retour"
check "DELETE eo-001 → 200"             200 "$(api DELETE /api/admin/banque/ecritoupas/eo-001 "$TOKEN1")"
api GET /api/banque/ecritoupas > /dev/null
check "eo-001 absente"                  0   "$(jval '[.items[] | select(.id == "eo-001")] | length')"
check "restore eo-001 → 200"            200 "$(api POST /api/admin/banque/ecritoupas/eo-001/restore "$TOKEN1")"
api GET /api/banque/ecritoupas > /dev/null
check "eo-001 de retour"                1   "$(jval '[.items[] | select(.id == "eo-001")] | length')"

say "Banques — suppression des ajouts (réelle pour les adm-)"
check "DELETE d'un id inconnu → 404"    404 "$(api DELETE /api/admin/banque/quiadit/adm-inconnu "$TOKEN1")"
check "DELETE de l'ajout quiadit → 200" 200 "$(api DELETE "/api/admin/banque/quiadit/$BQD_ID" "$TOKEN1")"
check "DELETE adm-eo-test → 200"        200 "$(api DELETE /api/admin/banque/ecritoupas/adm-eo-test "$TOKEN1")"
check "DELETE adm-po-test → 200"        200 "$(api DELETE /api/admin/banque/portrait/adm-po-test "$TOKEN1")"
api GET /api/banque/quiadit > /dev/null
check "quiadit revenue à N"             "$NBQD" "$(jval '.items | length')"
api GET /api/banque/ecritoupas > /dev/null
check "ecritoupas revenue à N"          "$NBEO" "$(jval '.items | length')"
api GET /api/banque/portrait > /dev/null
check "portrait revenue à N"            "$NBPO" "$(jval '.items | length')"

# ---------------------------------------------------------------------------
# Notifications — « le verset offert ». Les clés du vecteur RFC 8291 servent
# d'abonnement plausible ; l'endpoint https://exemple.invalide est injoignable
# (aucun envoi réel ici) : c'est la gestion d'échec qui est testée.
# (sqlval/sqlexec sont définies plus haut, section « La page de l'église »)

say "Notifications — clé VAPID auto-générée"
check "config : vapidPublicKey null avant toute activation" null "$(api GET /api/config > /dev/null; jval .vapidPublicKey)"
check "GET /api/push/cle → 200"          200 "$(api GET /api/push/cle)"
VKEY="$(jval .vapidPublicKey)"
check "clé publique P-256 brute (87 caractères base64url)" 87 "${#VKEY}"
check "la clé est STABLE au 2e appel"    "$VKEY" "$(api GET /api/push/cle > /dev/null; jval .vapidPublicKey)"
check "config : vapidPublicKey désormais exposée" "$VKEY" "$(api GET /api/config > /dev/null; jval .vapidPublicKey)"

say "Notifications — abonnement (validations puis REPLACE par endpoint)"
P256DH="BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
AUTHK="BTBZMqHH6r4Tts7J_aSIgg"
GOODSUB="{\"endpoint\":\"https://exemple.invalide/push/abo-1\",\"keys\":{\"p256dh\":\"$P256DH\",\"auth\":\"$AUTHK\"}}"
check "subscription absente → 400"       400 "$(api POST /api/push/subscribe '' '{"heure":8}')"
check "endpoint http (pas https) → 400"  400 "$(api POST /api/push/subscribe '' "{\"subscription\":{\"endpoint\":\"http://exemple.invalide/x\",\"keys\":{\"p256dh\":\"$P256DH\",\"auth\":\"$AUTHK\"}},\"heure\":8,\"tz\":0}")"
check "p256dh invalide → 400"            400 "$(api POST /api/push/subscribe '' "{\"subscription\":{\"endpoint\":\"https://exemple.invalide/x\",\"keys\":{\"p256dh\":\"pas-une-cle\",\"auth\":\"$AUTHK\"}},\"heure\":8,\"tz\":0}")"
check "auth invalide → 400"              400 "$(api POST /api/push/subscribe '' "{\"subscription\":{\"endpoint\":\"https://exemple.invalide/x\",\"keys\":{\"p256dh\":\"$P256DH\",\"auth\":\"trop-court\"}},\"heure\":8,\"tz\":0}")"
check "heure hors bornes → 400"          400 "$(api POST /api/push/subscribe '' "{\"subscription\":$GOODSUB,\"heure\":24,\"tz\":0}")"
check "fuseau hors bornes → 400"         400 "$(api POST /api/push/subscribe '' "{\"subscription\":$GOODSUB,\"heure\":8,\"tz\":5000}")"
HEURE_NOW="$(date -u +%-H)"   # l'heure UTC courante (tz 0) : le cron déclenchera
check "abonnement anonyme valide → 200"  200 "$(api POST /api/push/subscribe '' "{\"subscription\":$GOODSUB,\"heure\":$HEURE_NOW,\"tz\":0}")"
check "re-subscribe même endpoint (connecté) → 200" 200 "$(api POST /api/push/subscribe "$TOKEN1" "{\"subscription\":$GOODSUB,\"heure\":$HEURE_NOW,\"tz\":0}")"
check "un SEUL abonnement (REPLACE par endpoint)" 1 "$(sqlval 'SELECT COUNT(*) FROM push_abonnements')"
check "l'abonnement est maintenant relié au compte" 1 "$(sqlval 'SELECT COUNT(*) FROM push_abonnements WHERE user_id IS NOT NULL')"

say "Notifications — cron : clé exigée, idempotence, gestion d'échec"
check "cron sans clé → 403"              403 "$(api GET /api/cron/notify)"
check "cron mauvaise clé → 403"          403 "$(api GET '/api/cron/notify?key=mauvaise-cle')"
api GET /api/health "$TOKEN1" > /dev/null
CRONKEY="$(jval .push.cronKey)"
check "health admin : cronKey (64 hex)"  64 "${#CRONKEY}"
check "health admin : cronUrl porte la clé" 1 "$(jval .push.cronUrl | grep -c "$CRONKEY")"
check "health admin : 1 abonnement compté" 1 "$(jval .push.abonnements)"
check "cron bonne clé → 200"             200 "$(api GET "/api/cron/notify?key=$CRONKEY")"
check "→ ok true"                        true "$(jval .ok)"
check "→ envoyes 0 (endpoint injoignable)" 0 "$(jval .envoyes)"
check "→ supprimes 0 (premier échec)"    0 "$(jval .supprimes)"
check "l'échec est compté (echecs = 1)"  1 "$(sqlval 'SELECT echecs FROM push_abonnements')"
check "last_sent_day posé AVANT l'envoi (idempotence)" 1 "$(sqlval 'SELECT COUNT(*) FROM push_abonnements WHERE last_sent_day IS NOT NULL')"
api GET "/api/cron/notify?key=$CRONKEY" > /dev/null
check "2e cron du même jour : rien ne repart (echecs reste 1)" 1 "$(sqlval 'SELECT echecs FROM push_abonnements')"

# L'annonce d'une nouvelle série. Groupée : un responsable qui publie trois
# séries d'affilée ne réveille son assemblée qu'une fois. Le drapeau est posé
# AVANT l'envoi — rater une annonce vaut mieux que la répéter.
say "Notifications — les séries publiées s'annoncent une fois, groupées"
# Le groupe qui portait des séries a été supprimé plus haut : on en pose deux
# à la main sur une église encore vivante, pour éprouver le groupement.
sqlexec "INSERT INTO groupe_series (groupe_id, module, nom, etat, created_at, updated_at, notif_envoyee)
         SELECT id, 'quiadit', 'Série d essai A', 'publiee', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 0 FROM groupes LIMIT 1"
sqlexec "INSERT INTO groupe_series (groupe_id, module, nom, etat, created_at, updated_at, notif_envoyee)
         SELECT id, 'quiadit', 'Série d essai B', 'publiee', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 0 FROM groupes LIMIT 1"
check "deux séries attendent leur annonce" 2 \
  "$(sqlval "SELECT COUNT(*) FROM groupe_series WHERE etat = 'publiee' AND notif_envoyee = 0")"
api GET "/api/cron/notify?key=$CRONKEY" > /dev/null
check "le cron rend un compte de séries"  true "$(jval 'has("series")')"
check "les deux sont marquées d un coup"  0 \
  "$(sqlval "SELECT COUNT(*) FROM groupe_series WHERE etat = 'publiee' AND notif_envoyee = 0")"
api GET "/api/cron/notify?key=$CRONKEY" > /dev/null
check "2e passage : rien ne repart"       0 "$(jval .series)"

say "Notifications — l'abonnement mort est retiré au 5e échec"
sqlexec "UPDATE push_abonnements SET echecs = 4, last_sent_day = NULL"
api GET "/api/cron/notify?key=$CRONKEY" > /dev/null
check "cron : supprimes = 1"             1 "$(jval .supprimes)"
check "plus aucun abonnement en base"    0 "$(sqlval 'SELECT COUNT(*) FROM push_abonnements')"

say "Notifications — désabonnement (l'endpoint suffit) et détachement"
check "endpoint manquant → 400"          400 "$(api POST /api/push/unsubscribe '' '{}')"
api POST /api/push/subscribe '' "{\"subscription\":$GOODSUB,\"heure\":8,\"tz\":-120}" > /dev/null
check "unsubscribe → 200"                200 "$(api POST /api/push/unsubscribe '' '{"endpoint":"https://exemple.invalide/push/abo-1"}')"
check "la ligne a disparu"               0   "$(sqlval 'SELECT COUNT(*) FROM push_abonnements')"
check "unsubscribe rejoué (déjà parti) → 200" 200 "$(api POST /api/push/unsubscribe '' '{"endpoint":"https://exemple.invalide/push/abo-1"}')"
# u2 s'abonne avec son compte : à la suppression du compte (plus bas), cet
# abonnement doit être DÉTACHÉ (user_id NULL), pas supprimé.
check "abonnement de u2 (compte) → 200"  200 "$(api POST /api/push/subscribe "$TOKEN2" "{\"subscription\":{\"endpoint\":\"https://exemple.invalide/push/abo-u2\",\"keys\":{\"p256dh\":\"$P256DH\",\"auth\":\"$AUTHK\"}},\"heure\":20,\"tz\":-60}")"
check "relié au compte de u2"            1   "$(sqlval 'SELECT COUNT(*) FROM push_abonnements WHERE user_id IS NOT NULL')"

say "Notifications — le rappel de MON service, la veille au soir"
# u2 porte l'abonnement créé ci-dessus. Une église neuve, un service DEMAIN,
# u2 lève la main ; le « soir de la veille » se simule en réglant le fuseau
# de l'abonné pour que son heure locale vaille 18 h au moment du test.
RGCODE="$(groupe_via_demande "$TOKEN1" "Église du Rappel")"
api POST /api/groupes/rejoindre "$TOKEN2" "{\"code\":\"$RGCODE\"}" > /dev/null
DEMAIN="$(date -u -d '+1 day' +%F)"
api POST "/api/groupes/$RGCODE/services" "$TOKEN1" "{\"titre\":\"Accueil du dimanche\",\"date\":\"$DEMAIN\",\"places\":2}" > /dev/null
SVCID="$(jval .service.id)"
check "u2 lève la main → 200"           200 "$(api POST "/api/groupes/$RGCODE/services/$SVCID/inscription" "$TOKEN2")"
sqlexec "UPDATE push_abonnements SET tz_offset = $(( ( $(date -u +%-H) - 18 ) * 60 )) WHERE user_id IS NOT NULL"
api GET "/api/cron/notify?key=$CRONKEY" > /dev/null
check "le rappel est marqué (une seule chance, même si l'envoi rate)" 1 \
  "$(sqlval "SELECT rappel_envoye FROM groupe_service_inscriptions WHERE service_id = $SVCID")"
api GET "/api/cron/notify?key=$CRONKEY" > /dev/null
check "cron rejoué : aucun nouveau rappel (services = 0)" 0 "$(jval .services)"
# Hors de la fenêtre du soir (ici 3 h du matin locales) : rien ne part, rien
# n'est marqué — on repassera aux heures suivantes.
api DELETE "/api/groupes/$RGCODE/services/$SVCID/inscription" "$TOKEN2" > /dev/null
api POST "/api/groupes/$RGCODE/services/$SVCID/inscription" "$TOKEN2" > /dev/null
sqlexec "UPDATE push_abonnements SET tz_offset = $(( ( $(date -u +%-H) - 3 ) * 60 )) WHERE user_id IS NOT NULL"
api GET "/api/cron/notify?key=$CRONKEY" > /dev/null
check "à 3 h locales, pas de rappel (ni de marque)" 0 \
  "$(sqlval "SELECT rappel_envoye FROM groupe_service_inscriptions WHERE service_id = $SVCID")"
api DELETE "/api/groupes/$RGCODE" "$TOKEN1" > /dev/null # tout part avec le groupe

# ---------------------------------------------------------------------------
say "Limites : essais de code et demandes par heure (u3)"
api POST /api/auth/request-code '' '{"email":"chloe@example.org"}' > /dev/null
for _ in 1 2 3 4 5; do api POST /api/auth/verify '' '{"email":"chloe@example.org","code":"999999"}' > /dev/null; done
check "6e essai → 429"                  429 "$(api POST /api/auth/verify '' '{"email":"chloe@example.org","code":"999999"}')"
api POST /api/auth/request-code '' '{"email":"chloe@example.org"}' > /dev/null
check "3e demande dans l'heure → 200"   200 "$(api POST /api/auth/request-code '' '{"email":"chloe@example.org"}')"
check "4e demande dans l'heure → 429"   429 "$(api POST /api/auth/request-code '' '{"email":"chloe@example.org"}')"

# ---------------------------------------------------------------------------
say "Déconnexion et suppression de compte"
check "logout u1 → 200"                 200 "$(api POST /api/auth/logout "$TOKEN1")"
check "me après logout → 401"           401 "$(api GET /api/me "$TOKEN1")"
check "DELETE /api/me (u2) → 200"       200 "$(api DELETE /api/me "$TOKEN2")"
check "me après suppression → 401"      401 "$(api GET /api/me "$TOKEN2")"
check "l'abonnement push de u2 survit, DÉTACHÉ (user_id NULL)" 1 \
  "$(sqlval 'SELECT COUNT(*) FROM push_abonnements WHERE user_id IS NULL')"
check "aucun abonnement encore relié à u2" 0 "$(sqlval 'SELECT COUNT(*) FROM push_abonnements WHERE user_id IS NOT NULL')"

say "Groupes — le responsable supprimé : u3, plus ancien membre restant, est promu"
api GET /api/groupes "$TOKEN3" > /dev/null
check "u3 a toujours son groupe"        1 "$(jval '.groupes | length')"
check "u3 promu responsable"            responsable "$(jval ".groupes[] | select(.code == \"$G2CODE\") | .role")"
check "1 membre restant"                1 "$(jval ".groupes[] | select(.code == \"$G2CODE\") | .nbMembres")"
api GET "/api/groupes/$G2CODE" "$TOKEN3" > /dev/null
check "détail : Chloé responsable"      responsable "$(jval '.groupe.membres[] | select(.pseudo == "Chloé") | .role')"
check "u3 peut poser le verset → 200"   200 "$(api POST "/api/groupes/$G2CODE/verset" "$TOKEN3" '{"reference":"Psaume 23.1","texte":"L’Éternel est mon berger : je ne manquerai de rien."}')"

say "Page — la suppression du compte de u2 a retiré sa main levée, pas celle de Chloé"
api GET "/api/groupes/$G2CODE/page" "$TOKEN3" > /dev/null
check "le service de Benoît demeure"    1   "$(jval '.services | length')"
check "une seule main levée désormais"  1   "$(jval '.services[0].inscrits | length')"
check "Chloé reste inscrite"            "Chloé" "$(jval '.services[0].inscrits[0]')"
check "en base : la seule inscription est celle de Chloé" 1 "$(sqlval "SELECT COUNT(*) FROM groupe_service_inscriptions WHERE service_id = $G2SRV")"

say "u1 se reconnecte : l'ami supprimé et ses duels ont disparu"
api POST /api/auth/request-code '' '{"email":"alice@example.org"}' > /dev/null
CODE1B="$(jval .devCode)"
check "reconnexion sans pseudo → 200"   200 "$(api POST /api/auth/verify '' "{\"email\":\"alice@example.org\",\"code\":\"$CODE1B\"}")"
TOKEN1B="$(jval .token)"
check "pseudo conservé"                 Alice "$(api GET /api/me "$TOKEN1B" > /dev/null; jval .user.pseudo)"
check "plus d'amis"                     0 "$(api GET /api/friends "$TOKEN1B" > /dev/null; jval '.friends | length')"
check "plus de duels"                   0 "$(api GET /api/duels "$TOKEN1B" > /dev/null; jval '.duels | length')"
check "la synchro de u1 est intacte"    3 "$(api GET /api/sync "$TOKEN1B" > /dev/null; jval .memo.streak)"

# ---------------------------------------------------------------------------
say "Santé détaillée et journal (admin seulement)"
check "health admin : db sqlite"        sqlite "$(api GET /api/health "$TOKEN1B" > /dev/null; jval .db)"
check "health admin : mail dev"         dev    "$(jval .mail)"
check "journal sans token → 401"        401    "$(api GET /api/admin/log)"
check "journal admin → 200"             200    "$(api GET /api/admin/log "$TOKEN1B")"
check "au moins une action tracée"      true   "$(jval '.log | length > 0')"
check "les actions portent leur auteur" true   "$(jval '[.log[] | has("admin") and has("action") and has("cible")] | all')"

# ---------------------------------------------------------------------------
say "Plafond par IP sur les demandes de code (30/heure)"
LAST=000
for i in $(seq 1 40); do
  LAST="$(api POST /api/auth/request-code '' "{\"email\":\"spam$i@example.org\"}")"
  [ "$LAST" = 429 ] && break
done
check "la rafale finit par un 429"      429 "$LAST"
check "message doux sur le réseau"      "Trop de demandes depuis ce réseau — réessaie dans une heure." "$(jval .error)"

# ---------------------------------------------------------------------------
say "Divers"
check "route inconnue → 404"            404 "$(api GET /api/nimporte-quoi)"
check "GET /api/db.php → réécrit, 404"  404 "$(api GET /api/db.php)"

# ---------------------------------------------------------------------------
kill "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
printf '\n============================================\n'
printf 'Résultat : %d réussites, %d échecs\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
