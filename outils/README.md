# Outils de communication (hors application)

Ce dossier ne fait PAS partie du site : rien ici n'est servi en production
(le Dockerfile copie les fichiers explicitement). Ce sont les outils de
communication du projet, versionnés pour être utilisables depuis n'importe
quelle session Claude — y compris Cowork sur votre machine.

## Le kit Instagram (`generer-kit.js`)

Génère un lot de 30 cartes de versets (1080×1080, Segond 1910, palette de la
marque) et leurs légendes prêtes à programmer dans Metricool.

### Première fois
```
cd outils
npm install
```
Il faut aussi un Chrome ou Chromium sur la machine (le script trouve tout
seul celui de l'environnement Claude, le Chrome installé, ou le chemin donné
dans la variable CHROME_PATH).

### Générer
```
node generer-kit.js            # lot 1 : versets 1 à 30
node generer-kit.js --lot 2    # lot 2 : la suite, sans redite
```
Sortie dans `outils/kit-sortie/lot-N/` : `visuels/post-NN.png` + `LEGENDES.md`
(non versionnés — c'est de la production, pas du code).

### Ensuite, dans Metricool (Instagram)
1. Le lien **biblehorizon.fr** doit être dans la **bio** du compte (les
   légendes n'ont pas d'URL : elle n'est pas cliquable sur Instagram).
2. Planificateur → nouvelle publication → glisser le visuel, coller la
   légende du même numéro, choisir la date.
3. Rythme conseillé : **3 par semaine** (mardi, jeudi, dimanche vers 19 h),
   puis se fier aux meilleures heures que Metricool apprendra.

### L'esprit — le même que l'appli
On **offre** un verset, on ne réclame rien : pas de « installe vite », pas
d'urgence. Une publication sur cinq mentionne l'appli, les autres donnent.
Et on répond aux commentaires en personne — c'est la seule croissance qui
compte pour ce projet.

## Le mode d'emploi des banques de questions (`guide-banque-questions/`)

Le PDF que les responsables téléchargent depuis l'écran des séries. Il est
versionné là où il est SERVI — `guide/mode-emploi-banque-de-questions.pdf` —
et sa source vit ici : `guide.html`, ses captures, et de quoi tout refaire.

Toutes les captures sont prises dans l'application réelle, cadrées sur les
éléments du DOM (jamais découpées au pixel) : quand un écran change, on
regénère plutôt que de retoucher une image.

### Refaire les captures
```
# 1. le serveur de test, base neuve
rm -f api/data/dev.sqlite
env -u MYSQL_URL -u BREVO_API_KEY -u SMTP_HOST \
    ADMIN_EMAILS=alice@example.org GRAINE_DEV=1 \
    php -S 127.0.0.1:8123 api/tests/router.php &

# 2. le décor : Alice responsable, Bob membre, une église
bash outils/guide-banque-questions/preparer.sh

# 3. les captures (Chromium + Playwright)
node outils/guide-banque-questions/capturer.cjs
```

### Refaire le PDF
```
node outils/guide-banque-questions/imprimer.cjs
```
Neuf pages A4. Si une section déborde, elle se coupe en deux : mesurer la
hauteur de chaque `.page` en média `print` sur 178 mm de large (la limite
utile est 264 mm) et resserrer une image via ses classes `hNN`.
