#!/usr/bin/env bash
# ============================================================================
# La production, telle qu'elle répond vraiment.
#
#   bash api/tests/sonde-production.sh [https://biblehorizon.fr]
#
# POURQUOI ce script existe, alors que la suite couvre déjà 1045 points :
# parce qu'elle ne peut pas couvrir le SERVEUR. Les tests passent par
# `php -S` et api/tests/router.php, qui ne simulent qu'une seule chose du
# Caddyfile : la réécriture /api/*. Tout le reste — en-têtes de sécurité,
# redirections 301, Cache-Control, et surtout le fait que les fichiers soient
# RÉELLEMENT dans l'image déployée — n'existe qu'en ligne.
#
# parite-image.mjs vérifie déjà que rien ne manque, mais à partir d'un MODÈLE
# du Dockerfile reconstitué par lecture des directives COPY. Ce script-ci
# interroge l'image telle qu'elle tourne. C'est la différence entre « d'après
# mes calculs, le fichier devrait y être » et « je viens de le demander, il y
# est ».
#
# STRICTEMENT EN LECTURE. Que des GET et des HEAD. Aucune écriture, aucune
# authentification, aucun compte créé, aucun e-mail déclenché. On peut le
# lancer sur la production en pleine journée sans rien déranger : c'est ce que
# fait n'importe quel visiteur.
#
# QUAND ELLE TOURNE. Le workflow .github/workflows/en-ligne.yml la lance tout
# seul après chaque fusion sur `main`, une fois la version du dépôt réellement
# servie par le domaine — c'est ce qui répond à « est-ce que c'est en ligne ? »
# sans que personne ait à scruter le tableau de bord Railway.
#
# Elle reste lançable à la main, et sur n'importe quelle adresse (premier
# argument), ce qui est utile pour éprouver un environnement de recette.
#
# Ce qu'elle ne fait PAS : tourner à chaque poussée. La CI n'a aucune raison
# d'aller taper le domaine quand on pousse sur une branche de travail.
#
# Nécessite : curl, jq.
# ============================================================================
set -u

BASE="${1:-https://biblehorizon.fr}"
BASE="${BASE%/}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

say() { printf '\n== %s\n' "$*"; }
ok()  { PASS=$((PASS + 1)); printf '   ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '   FAIL %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; return 0; }

# code CHEMIN — code HTTP d'un GET, sans suivre les redirections.
code() { curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$BASE$1"; }

# existe CHEMIN — 0 si la ressource répond 200. HEAD d'abord (on ne veut pas
# rapatrier 4 Mo de Bible pour savoir si elle est là) ; si le serveur répond
# autre chose, on RECONTRÔLE en GET avant d'accuser : certains serveurs
# traitent mal HEAD, et un faux négatif ferait perdre plus de temps que les
# quelques octets économisés.
existe() {
  local c
  c=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' --head "$BASE$1")
  [ "$c" = "200" ] && return 0
  c=$(code "$1")
  [ "$c" = "200" ]
}

# entete CHEMIN NOM — valeur d'un en-tête de réponse (vide si absent).
entete() {
  curl -sS --max-time 20 -o /dev/null -D "$TMP/h.txt" "$BASE$1" 2>/dev/null
  grep -i "^$2:" "$TMP/h.txt" | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'
}

# liste_js NOM — les chaînes d'un tableau de sw.js (SHELL, BIBLE).
liste_js() {
  awk -v nom="$1" '
    $0 ~ "const " nom " *= *\\[" { dans = 1 }
    dans { print }
    dans && /\]/ && !/\[/ { exit }
  ' "$ROOT/sw.js" | grep -oE "'[^']+'" | tr -d "'"
}

printf '\n============================================\n'
printf 'Sonde de production — %s\n' "$BASE"
printf '============================================\n'

# ---------------------------------------------------------------------------
say "Le site répond"
C=$(code /)
if [ "$C" = "200" ]; then ok "GET / → 200"; else
  bad "GET / → $C" "injoignable : le reste de la sonde n'aurait aucun sens"
  printf '\n%s réussites, %s échecs\n' "$PASS" "$FAIL"; exit 1
fi
TYPE=$(entete / content-type)
case "$TYPE" in
  text/html*) ok "la racine sert bien du HTML ($TYPE)" ;;
  *)          bad "content-type inattendu à la racine" "$TYPE" ;;
esac

# ---------------------------------------------------------------------------
# Ces en-têtes sont posés par le Caddyfile et par LUI SEUL : aucun test local
# ne peut les voir, puisque `php -S` n'en pose aucun.
say "En-têtes de sécurité (posés par le Caddyfile, invisibles en test local)"
verif_entete() { # verif_entete NOM ATTENDU_SOUS_CHAINE
  local v; v=$(entete / "$1")
  if [ -z "$v" ]; then bad "$1 absent"
  elif [ -n "${2:-}" ] && ! printf '%s' "$v" | grep -qi -- "$2"; then
    bad "$1 ne porte pas « $2 »" "$v"
  else ok "$1 : $(printf '%s' "$v" | cut -c1-58)"; fi
}
verif_entete "X-Content-Type-Options"   "nosniff"
verif_entete "X-Frame-Options"          "DENY"
verif_entete "Referrer-Policy"          "strict-origin"
verif_entete "Permissions-Policy"       "camera="
verif_entete "Strict-Transport-Security" "max-age="

CSP=$(entete / content-security-policy)
if [ -z "$CSP" ]; then bad "Content-Security-Policy absente"; else
  ok "Content-Security-Policy présente"
  # Les trois directives qui ferment vraiment la porte : le reste peut évoluer.
  for d in "default-src 'self'" "frame-ancestors 'none'" "object-src 'none'"; do
    if printf '%s' "$CSP" | grep -qF -- "$d"; then ok "CSP : $d"
    else bad "CSP : « $d » manquante" "$CSP"; fi
  done
fi

# ---------------------------------------------------------------------------
# Sans elles, une adresse partagée sans barre oblique finale casse les chemins
# relatifs de la page — et le lecteur tombe sur un écran nu.
say "Redirections permanentes (adresse sans barre oblique finale)"
REDIR_OK=0; REDIR_KO=""
for p in lire defi admin frise quiadit ecritoupas portrait \
         quiz-biblique plan-lecture-bible memoriser-versets eglises \
         confidentialite mentions-legales supprimer-mon-compte; do
  C=$(code "/$p")
  L=$(entete "/$p" location)
  if [ "$C" = "301" ] && { [ "$L" = "/$p/" ] || [ "$L" = "$BASE/$p/" ]; }; then
    REDIR_OK=$((REDIR_OK + 1))
  else
    REDIR_KO="$REDIR_KO
        /$p → $C ${L:+(Location: $L)}"
  fi
done
if [ -z "$REDIR_KO" ]; then ok "les 14 redirections 301 sont en place"
else bad "redirection(s) manquante(s) — $REDIR_OK/14 correctes" "$REDIR_KO"; fi

# ---------------------------------------------------------------------------
# LE point que parite-image.mjs ne peut que MODÉLISER. Ici on demande vraiment.
# addAll() étant atomique, une seule de ces entrées en 404 et l'installation du
# service worker échoue en bloc : plus aucun hors-ligne, sans un mot à l'écran.
say "La coquille du service worker, demandée fichier par fichier"
SHELL_KO=""; SHELL_N=0
while IFS= read -r u; do
  [ -z "$u" ] && continue
  SHELL_N=$((SHELL_N + 1))
  # La coquille pré-cache « . », c'est-à-dire la racine elle-même.
  [ "$u" = "." ] && u=""
  existe "/${u#./}" || SHELL_KO="$SHELL_KO
        ${u:-. (racine)}"
done <<< "$(liste_js SHELL)"
if [ "$SHELL_N" -eq 0 ]; then bad "aucune entrée SHELL lue dans sw.js" "extraction à revoir"
elif [ -z "$SHELL_KO" ]; then ok "les $SHELL_N entrées de la coquille répondent 200"
else bad "entrée(s) de la coquille absente(s) EN LIGNE" "$SHELL_KO"; fi

say "La Bible pré-cachée, livre par livre"
BIBLE_KO=""; BIBLE_N=0
while IFS= read -r u; do
  [ -z "$u" ] && continue
  BIBLE_N=$((BIBLE_N + 1))
  existe "/$u" || BIBLE_KO="$BIBLE_KO
        $u"
done <<< "$(liste_js BIBLE)"
if [ "$BIBLE_N" -eq 0 ]; then bad "aucune entrée BIBLE lue dans sw.js" "extraction à revoir"
elif [ -z "$BIBLE_KO" ]; then ok "les $BIBLE_N livres répondent 200"
else bad "livre(s) absent(s) EN LIGNE" "$BIBLE_KO"; fi

# ---------------------------------------------------------------------------
say "L'API"
C=$(code /api/health)
[ "$C" = "200" ] && ok "GET /api/health → 200 (anonyme, réponse minimale)" \
                 || bad "GET /api/health → $C"
CC=$(entete /api/health cache-control)
printf '%s' "$CC" | grep -qi 'no-store' \
  && ok "Cache-Control: no-store sur /api/* (une réponse d'API ne se cache pas)" \
  || bad "Cache-Control manquant ou incorrect sur /api/*" "${CC:-<absent>}"

# La réécriture doit envoyer TOUT /api/* vers index.php : aucun autre .php
# ne doit être joignable. Une régression ici exposerait db.php.
C=$(code /api/db.php)
[ "$C" = "404" ] && ok "GET /api/db.php → 404 (réécrit, jamais servi tel quel)" \
                 || bad "GET /api/db.php → $C" "ATTENTION : le fichier ne doit JAMAIS être servi"

# ---------------------------------------------------------------------------
say "PWA — manifeste, icônes, et le lien avec le Play Store"
if curl -sS --max-time 20 "$BASE/manifest.webmanifest" -o "$TMP/m.json" && jq -e . "$TMP/m.json" > /dev/null 2>&1; then
  ok "manifeste servi et analysable — « $(jq -r '.name // .short_name' "$TMP/m.json")»"
  IC_KO=""; IC_N=0
  while IFS= read -r i; do
    [ -z "$i" ] && continue
    IC_N=$((IC_N + 1))
    existe "/${i#./}" || IC_KO="$IC_KO
        $i"
  done <<< "$(jq -r '.icons[].src' "$TMP/m.json" 2>/dev/null)"
  [ -z "$IC_KO" ] && ok "les $IC_N icônes du manifeste répondent" \
                  || bad "icône(s) absente(s) — le navigateur refusera l'installation" "$IC_KO"
else
  bad "manifeste absent ou illisible"
fi

# Sans ce fichier, l'appli du Play Store s'ouvre avec une BARRE D'ADRESSE et
# ressemble à un navigateur déguisé.
if curl -sS --max-time 20 "$BASE/.well-known/assetlinks.json" -o "$TMP/a.json" \
   && jq -e 'type == "array"' "$TMP/a.json" > /dev/null 2>&1; then
  ok "Digital Asset Links servi et valide ($(jq 'length' "$TMP/a.json") entrée(s))"
  jq -e '.[0].target.sha256_cert_fingerprints | length > 0' "$TMP/a.json" > /dev/null 2>&1 \
    && ok "l'empreinte de signature y est" \
    || printf '   --   empreinte de signature encore vide (à coller depuis la Play Console)\n'
else
  bad "assetlinks.json absent ou invalide" "l'appli du Play Store s'ouvrira avec une barre d'adresse"
fi

# ---------------------------------------------------------------------------
# Le geste que Google Play exige : signaler un contenu depuis l'appli. On
# vérifie que la porte répond SANS rien déposer — un genre inconnu est refusé
# en 400 avant toute écriture — et que le plafond horaire est bien devant
# elle (une vraie rafale rendrait ce réseau muet une heure : on ne la joue
# pas ici ; run-tests.sh la joue en local).
say "Signalement — la porte répond, derrière son plafond"
SIG_CODE="$(curl -sS --max-time 20 -o "$TMP/sig.json" -w '%{http_code}' -X POST "$BASE/api/signalement" \
  -H 'Content-Type: application/json' -d '{"genre":"sonde","cible":"sonde"}')"
if [ "$SIG_CODE" = 400 ] && jq -e '.error' "$TMP/sig.json" > /dev/null 2>&1; then
  ok "POST /api/signalement répond (genre inconnu → 400, rien de déposé)"
elif [ "$SIG_CODE" = 429 ]; then
  ok "POST /api/signalement répond — plafond horaire atteint depuis ce réseau (429), la porte tient"
else
  bad "POST /api/signalement → $SIG_CODE" "attendu 400 (genre inconnu) : le bouton Signaler de l'appli ne mène nulle part"
fi

# ---------------------------------------------------------------------------
say "Référencement"
for f in robots.txt sitemap.xml og-image.png; do
  existe "/$f" && ok "$f répond" || bad "$f absent"
done

# ---------------------------------------------------------------------------
# Sans le cron horaire, AUCUNE notification ne part — verset du matin compris —
# et rien ne le disait : on s'en apercevait des jours plus tard, au doute
# (« je ne suis plus sûr d'en avoir reçu ces derniers jours »). L'appli expose
# désormais son battement de cœur ; ici on le prend. Trois heures = deux
# passages horaires manqués d'affilée : ce n'est plus un raté du pinger,
# c'est une panne.
say "Le cœur des notifications (le cron horaire)"
if curl -sS --max-time 20 "$BASE/api/health" -o "$TMP/h.json" \
   && jq -e '.ok == true' "$TMP/h.json" > /dev/null 2>&1; then
  DERNIER=$(jq -r '.cron.dernier // empty' "$TMP/h.json")
  DEPUIS=$(jq -r '.cron.enPlaceDepuis // empty' "$TMP/h.json")
  MAINT=$(date -u +%s)
  # âge ISO_8601 → minutes ; vide si la date ne se lit pas (date non-GNU).
  age_min() { local s; s=$(date -u -d "$1" +%s 2>/dev/null) || return 1; echo $(( (MAINT - s) / 60 )); }
  if [ -n "$DERNIER" ] && AGE=$(age_min "$DERNIER"); then
    if [ "$AGE" -le 180 ]; then
      ok "le cron est passé il y a $AGE min"
    else
      bad "le cron ne passe PLUS (dernier passage il y a $((AGE / 60)) h)" \
          "aucune notification ne part — vérifier le pinger (cron-job.org ou service cron Railway) et la clé : api/README.md, section 5"
    fi
  elif [ -n "$DEPUIS" ] && AGE=$(age_min "$DEPUIS"); then
    if [ "$AGE" -le 180 ]; then
      printf '   --   battement de cœur tout neuf (%s min) : premier passage attendu dans l'\''heure — repasser la sonde ensuite\n' "$AGE"
    else
      bad "le cron n'est JAMAIS passé depuis la pose du battement de cœur ($((AGE / 60)) h)" \
          "il n'est probablement pas branché du tout — api/README.md, section 5, dit comment"
    fi
  else
    printf '   --   la version en ligne ne connaît pas encore le battement de cœur (elle date d'\''avant — déployer, puis repasser)\n'
  fi
else
  bad "impossible de lire /api/health" "la santé ne répond pas : voir d'abord les sections précédentes"
fi

# ---------------------------------------------------------------------------
# La question qu'on se pose vraiment après un « git push » : est-ce que ma
# version est EN LIGNE ? Le numéro de cache du service worker la porte.
say "Le déploiement a-t-il atterri ?"
LOCALE=$(grep -oE "const CACHE *= *'[^']+'" "$ROOT/sw.js" | grep -oE "'[^']+'" | tr -d "'")
DISTANTE=$(curl -sS --max-time 20 "$BASE/sw.js" | grep -oE "const CACHE *= *'[^']+'" | grep -oE "'[^']+'" | tr -d "'")
if [ -z "$DISTANTE" ]; then
  bad "impossible de lire la version en ligne" "sw.js illisible ou absent"
elif [ "$LOCALE" = "$DISTANTE" ]; then
  ok "la version en ligne est celle du dépôt ($DISTANTE)"
else
  bad "la version en ligne DIFFÈRE du dépôt" "en ligne : $DISTANTE — dépôt : $LOCALE
        Soit le déploiement n'est pas passé, soit le dépôt est en avance."
fi

# ---------------------------------------------------------------------------
printf '\n============================================\n'
printf '%s réussites, %s échecs\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
