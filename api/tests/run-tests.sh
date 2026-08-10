#!/usr/bin/env bash
# ============================================================================
# Tests d'intégration de l'API Graine de Parole (SQLite + mode dev).
#
#   bash api/tests/run-tests.sh
#
# Lance `php -S` sur le port 8180 avec le routeur qui simule la réécriture
# Caddy (/api/* → api/index.php), puis déroule le parcours complet du contrat :
# santé → connexion → synchro → amis → duels → déconnexion → suppression.
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
for f in "$ROOT"/api/*.php "$ROOT"/api/tests/router.php; do
  if ! php -l "$f" > /dev/null 2>&1; then LINT_OK=non; php -l "$f"; fi
done
check "php -l sans erreur" oui "$LINT_OK"

# ---------------------------------------------------------------------------
say "Démarrage du serveur de test (php -S, SQLite, mode dev)"
rm -f "$ROOT"/api/data/dev.sqlite "$ROOT"/api/data/dev.sqlite-*
cd "$ROOT"
env -u MYSQL_URL -u BREVO_API_KEY -u SMTP_HOST \
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
say "Santé"
check "GET /api/health → 200"           200     "$(api GET /api/health)"
check "health : ok"                     true    "$(jval .ok)"
check "health : base sqlite (repli)"    sqlite  "$(jval .db)"
check "health : mail en mode dev"       dev     "$(jval .mail)"

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
say "Divers"
check "route inconnue → 404"            404 "$(api GET /api/nimporte-quoi)"
check "GET /api/db.php → réécrit, 404"  404 "$(api GET /api/db.php)"

# ---------------------------------------------------------------------------
kill "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
printf '\n============================================\n'
printf 'Résultat : %d réussites, %d échecs\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
