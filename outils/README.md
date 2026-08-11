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
