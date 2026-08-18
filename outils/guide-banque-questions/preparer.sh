#!/usr/bin/env bash
# Monte le décor du mode d'emploi : deux comptes (Alice responsable, Bob
# membre) et une église de démonstration, sur le serveur de développement.
# Écrit les jetons dans /tmp/{ta,tb,gc}.txt, que capturer.cjs relit.
#
# Prérequis : le serveur de test tourne (voir le README de ce dossier).
set -e
B="${GRAINE_URL:-http://127.0.0.1:8123}"
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }

compte() {
  CODE=$(curl -s -X POST "$B/api/auth/request-code" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\"}" | j "['devCode']")   # GRAINE_DEV=1 renvoie le code en clair
  curl -s -X POST "$B/api/auth/verify" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"code\":\"$CODE\",\"pseudo\":\"$2\"}" | j "['token']"
}

TA=$(compte alice@example.org Alice)   # doit figurer dans ADMIN_EMAILS : c'est
TB=$(compte bob@example.org Bob)       # elle qui accepte sa propre demande

curl -s -X POST "$B/api/groupes/demande" -H "Authorization: Bearer $TA" \
  -H 'Content-Type: application/json' \
  -d '{"nom":"Église de la Colline","adresse":"12 rue des Oliviers, Mons"}' >/dev/null
ID=$(curl -s "$B/api/admin/eglises" -H "Authorization: Bearer $TA" | j "['demandes'][0]['id']")
GC=$(curl -s -X POST "$B/api/admin/eglises/demandes/$ID/accepter" -H "Authorization: Bearer $TA" | j "['code']")
curl -s -X POST "$B/api/groupes/rejoindre" -H "Authorization: Bearer $TB" \
  -H 'Content-Type: application/json' -d "{\"code\":\"$GC\"}" >/dev/null

echo "$TA" > /tmp/ta.txt; echo "$TB" > /tmp/tb.txt; echo "$GC" > /tmp/gc.txt
echo "église de démonstration : $GC"
