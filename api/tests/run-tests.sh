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
for f in "$ROOT"/api/*.php "$ROOT"/api/tests/router.php; do
  if ! php -l "$f" > /dev/null 2>&1; then LINT_OK=non; php -l "$f"; fi
done
check "php -l sans erreur" oui "$LINT_OK"

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
# Groupes d'église (fondations serveur — aucune interface encore).
# Aucun appel request-code ici : on réutilise TOKEN1/TOKEN2/TOKEN3 pour ne pas
# entamer les plafonds testés plus loin (par e-mail et par IP).
say "Groupes d'église — création (u1 responsable)"
check "créer sans compte → 401"         401 "$(api POST /api/groupes '' '{"nom":"Béthel"}')"
check "nom trop court → 400"            400 "$(api POST /api/groupes "$TOKEN1" '{"nom":"B"}')"
check "nom avec caractère interdit → 400" 400 "$(api POST /api/groupes "$TOKEN1" '{"nom":"Béthel <7>"}')"
check "création (apostrophes, accents) → 201" 201 "$(api POST /api/groupes "$TOKEN1" '{"nom":"L’Église d’Éphèse"}')"
GCODE="$(jval .groupe.code)"
check "code au format GRP-XXXXX (préfixe)"  GRP "${GCODE%-*}"
check "code au format GRP-XXXXX (longueur)" 9   "${#GCODE}"
check "le créateur est responsable"     responsable "$(jval .groupe.role)"
check "1 membre au départ"              1    "$(jval .groupe.nbMembres)"
check "pas encore de verset"            null "$(jval .groupe.verset)"

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
  api POST /api/groupes "$TOKEN1" "{\"nom\":\"Groupe numéro $i\"}" > /dev/null
  GCODES="$GCODES $(jval .groupe.code)"
done
check "u1 responsable de 5 groupes"     5   "$(api GET /api/groupes "$TOKEN1" > /dev/null; jval '.groupes | length')"
check "6e groupe → 400"                 400 "$(api POST /api/groupes "$TOKEN1" '{"nom":"Groupe de trop"}')"
set -- $GCODES
check "suppression par u3 (non-responsable) → 403" 403 "$(api DELETE "/api/groupes/$1" "$TOKEN3")"
SUPPRIMES=0
for c in $GCODES; do
  [ "$(api DELETE "/api/groupes/$c" "$TOKEN1")" = 200 ] && SUPPRIMES=$((SUPPRIMES + 1))
done
check "u1 supprime ses 5 groupes"       5   "$SUPPRIMES"
check "u1 : liste vide"                 0   "$(api GET /api/groupes "$TOKEN1" > /dev/null; jval '.groupes | length')"

say "Groupes — deuxième groupe : u2 responsable, u3 membre (passation testée après la suppression de u2)"
check "u2 crée son groupe → 201"        201 "$(api POST /api/groupes "$TOKEN2" '{"nom":"Groupe de Benoît"}')"
G2CODE="$(jval .groupe.code)"
check "u3 rejoint → 200"                200 "$(api POST /api/groupes/rejoindre "$TOKEN3" "{\"code\":\"$G2CODE\"}")"
check "→ 2 membres"                     2   "$(jval .groupe.nbMembres)"

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

say "Administration — suppression totale d'un compte (u4 jetable)"
api POST /api/auth/request-code '' '{"email":"david@example.org"}' > /dev/null
CODE4="$(jval .devCode)"
api POST /api/auth/verify '' "{\"email\":\"david@example.org\",\"code\":\"$CODE4\",\"pseudo\":\"David\"}" > /dev/null
TOKEN4="$(jval .token)"
api GET /api/admin/users "$TOKEN1" > /dev/null
check "4 comptes après l'arrivée de u4" 4   "$(jval '.users | length')"
DAVID_ID="$(jval '.users[] | select(.email == "david@example.org") | .id')"
check "admin supprime u4 → 200"         200 "$(api DELETE "/api/admin/users/$DAVID_ID" "$TOKEN1")"
check "la session de u4 est close"      401 "$(api GET /api/me "$TOKEN4")"
api GET /api/admin/users "$TOKEN1" > /dev/null
check "3 comptes restants"              3   "$(jval '.users | length')"

# ---------------------------------------------------------------------------
say "Questions — banque publique fusionnée"
check "GET /api/questions → 200"        200 "$(api GET /api/questions)"
check "version 2"                       2   "$(jval .version)"
check "6 catégories"                    6   "$(jval '.categories | length')"
check "300 questions (fichier seul)"    300 "$(jval '.questions | length')"

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
check "banque à 301"                    301 "$(jval '.questions | length')"
check "adm-test-1 servie"               "Question de test ?" "$(jval '.questions[] | select(.id == "adm-test-1") | .question')"

say "Questions — ajout sans id (généré), puis suppression"
check "ajout sans id → 200"             200 "$(api POST /api/admin/questions "$TOKEN1" "$QOK")"
GEN_ID="$(jval .question.id)"
check "id généré préfixé adm-"          adm- "$(printf '%s' "$GEN_ID" | cut -c1-4)"
check "id généré : adm- + 6 hex"        10  "${#GEN_ID}"
api GET /api/questions > /dev/null
check "banque à 302"                    302 "$(jval '.questions | length')"
check "suppression de l'ajout → 200"    200 "$(api DELETE "/api/admin/questions/$GEN_ID" "$TOKEN1")"
api GET /api/questions > /dev/null
check "banque revenue à 301"            301 "$(jval '.questions | length')"

say "Questions — surcharge d'une question du fichier (per-01)"
P01_FICHIER="$(jq -r '.questions[] | select(.id == "per-01") | .question' "$ROOT/defi/data/questions.json")"
check "modification per-01 → 200"       200 "$(api POST /api/admin/questions "$TOKEN1" '{"id":"per-01","categorie":"Personnages","niveau":2,"question":"Qui construisit une arche ? (version admin)","options":["Abraham","Noé","Moïse","Élie"],"bonne":1,"reference":"Genèse 6.14"}')"
api GET /api/questions > /dev/null
check "la banque reste à 301"           301 "$(jval '.questions | length')"
check "per-01 : version modifiée servie" "Qui construisit une arche ? (version admin)" \
  "$(jval '.questions[] | select(.id == "per-01") | .question')"
check "per-01 : une seule occurrence"   1   "$(jval '[.questions[] | select(.id == "per-01")] | length')"

say "Questions — désactivation puis restauration (per-01)"
check "DELETE per-01 (désactive) → 200" 200 "$(api DELETE /api/admin/questions/per-01 "$TOKEN1")"
api GET /api/questions > /dev/null
check "banque à 300 (per-01 retirée, adm-test-1 encore là)" 300 "$(jval '.questions | length')"
check "per-01 absente de la banque"     0   "$(jval '[.questions[] | select(.id == "per-01")] | length')"
check "restore sans surcharge (per-02) → 404" 404 "$(api POST /api/admin/questions/per-02/restore "$TOKEN1")"
check "restore per-01 → 200"            200 "$(api POST /api/admin/questions/per-01/restore "$TOKEN1")"
api GET /api/questions > /dev/null
check "banque repasse à 301 (adm-test-1 existe encore)" 301 "$(jval '.questions | length')"
check "per-01 : version du fichier de retour" "$P01_FICHIER" \
  "$(jval '.questions[] | select(.id == "per-01") | .question')"

say "Questions — suppression d'un ajout (adm-test-1)"
check "DELETE d'un id inconnu → 404"    404 "$(api DELETE /api/admin/questions/adm-inconnu "$TOKEN1")"
check "DELETE adm-test-1 → 200"         200 "$(api DELETE /api/admin/questions/adm-test-1 "$TOKEN1")"
api GET /api/questions > /dev/null
check "banque revenue à 300"            300 "$(jval '.questions | length')"
check "per-01 toujours version fichier" "$P01_FICHIER" \
  "$(jval '.questions[] | select(.id == "per-01") | .question')"

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

say "Groupes — le responsable supprimé : u3, plus ancien membre restant, est promu"
api GET /api/groupes "$TOKEN3" > /dev/null
check "u3 a toujours son groupe"        1 "$(jval '.groupes | length')"
check "u3 promu responsable"            responsable "$(jval ".groupes[] | select(.code == \"$G2CODE\") | .role")"
check "1 membre restant"                1 "$(jval ".groupes[] | select(.code == \"$G2CODE\") | .nbMembres")"
api GET "/api/groupes/$G2CODE" "$TOKEN3" > /dev/null
check "détail : Chloé responsable"      responsable "$(jval '.groupe.membres[] | select(.pseudo == "Chloé") | .role')"
check "u3 peut poser le verset → 200"   200 "$(api POST "/api/groupes/$G2CODE/verset" "$TOKEN3" '{"reference":"Psaume 23.1","texte":"L’Éternel est mon berger : je ne manquerai de rien."}')"

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
