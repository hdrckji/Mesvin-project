set -e
B="${GRAINE_URL:-http://127.0.0.1:8123}"
TA=$(cat /tmp/ta.txt); TB=$(cat /tmp/tb.txt); GC=$(cat /tmp/gc.txt)
post() { curl -s -X POST "$B$1" -H "Authorization: Bearer $2" -H 'Content-Type: application/json' -d "$3" -o /tmp/out.json -w '%{http_code} '; echo "$1"; }

post "/api/groupes/$GC/verset" "$TA" '{"reference":"Psaume 119.105","texte":"Ta parole est une lampe à mes pieds, et une lumière sur mon sentier."}'
post "/api/groupes/$GC/annonces" "$TA" '{"titre":"Baptêmes le 7 septembre","texte":"Cinq frères et sœurs témoigneront de leur foi au lac. Rendez-vous à 14h, prévoyez de quoi pique-niquer.","epingle":true}'
post "/api/groupes/$GC/annonces" "$TA" '{"titre":"Reprise de l étude du mercredi","texte":"On repart dans l épître aux Romains, dès le 3 septembre."}'
post "/api/groupes/$GC/rdv" "$TA" '{"libelle":"Culte","jour":0,"heure":"10:00","lieu":"12 rue des Oliviers"}'
post "/api/groupes/$GC/rdv" "$TA" '{"libelle":"Prière","jour":2,"heure":"19:30","lieu":"Salle du bas"}'
post "/api/groupes/$GC/rdv" "$TA" '{"libelle":"Étude biblique","jour":3,"heure":"20:00"}'
D1=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=6)).isoformat())")
D2=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=13)).isoformat())")
post "/api/groupes/$GC/services" "$TA" "{\"titre\":\"Accueil du dimanche\",\"date\":\"$D1\",\"details\":\"Ouvrir la salle à 9h15, accueillir et orienter.\",\"places\":3}"
post "/api/groupes/$GC/services" "$TA" "{\"titre\":\"Garderie des petits\",\"date\":\"$D2\",\"details\":\"Pendant la prédication, avec Marthe.\",\"places\":2}"
post "/api/groupes/$GC/propositions" "$TA" '{"genre":"pack","titre":"Les versets du camp d été","description":"Les cinq versets travaillés ensemble au camp — à garder pour l année.","versets":[{"reference":"Josué 1.9","texte":"Ne t effraie point et ne t épouvante point, car l Éternel, ton Dieu, est avec toi dans tout ce que tu entreprendras."},{"reference":"Philippiens 4.13","texte":"Je puis tout par celui qui me fortifie."},{"reference":"Ésaïe 41.10","texte":"Ne crains rien, car je suis avec toi ; ne promène pas des regards inquiets, car je suis ton Dieu."}]}'
post "/api/groupes/$GC/propositions" "$TA" '{"genre":"lecture","titre":"Traverser Jean avant Noël","description":"Un chapitre par jour, ensemble, du 1er octobre à Noël.","livres":["jean"]}'
# un membre lève la main sur le premier service
SID=$(curl -s "$B/api/groupes/$GC/page" -H "Authorization: Bearer $TA" | python3 -c "import sys,json;print(json.load(sys.stdin)['services'][0]['id'])")
post "/api/groupes/$GC/services/$SID/inscription" "$TB" '{}'
echo "meublée : $GC"
