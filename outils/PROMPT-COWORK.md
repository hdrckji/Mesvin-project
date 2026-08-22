# Prompt Cowork — programmation Instagram de la semaine

À coller tel quel dans Claude Cowork (sur la machine où Metricool est
connecté dans le navigateur). Réutilisable chaque semaine.

---

Tu travailles pour Bible Horizon (biblehorizon.fr). Le dépôt du projet est
https://github.com/hdrckji/mesvin-project — clone-le (ou mets-le à jour si
je l'ai déjà), puis lis `outils/README.md` : tout le kit de communication y
est expliqué.

Ta mission : faire la programmation Instagram de la semaine dans Metricool,
à ma place.

1. Ouvre metricool.com dans mon navigateur (je suis déjà connecté — si ce
   n'est pas le cas, demande-moi de me connecter et attends). Va dans le
   Planificateur et note ce qui est déjà programmé, posts et stories.

2. **Les posts-versets (3 par semaine).** Le lot 1 du kit (30 cartes) doit
   être programmé au rythme de 3 par semaine : mardi, jeudi et dimanche
   vers 19 h. Regarde jusqu'à quel numéro c'est fait, puis continue dans
   l'ordre, sans jamais reprogrammer un numéro déjà passé ou déjà planifié.
   Si les fichiers manquent sur la machine, regénère-les :
   `cd outils && npm install && node generer-kit.js` — visuels et légendes
   sortent dans `outils/kit-sortie/lot-1/`. Chaque publication = le visuel
   `post-NN.png` + la légende du même numéro dans `LEGENDES.md`, telle
   quelle. Quand le lot 1 est épuisé, génère le lot 2 (`--lot 2`).

3. **Les stories-questions (2 par jour).** Génère la prochaine semaine :
   `node outils/generer-stories.js --semaine N` — prends le premier N pas
   encore utilisé (vérifie dans le planificateur les stories déjà passées ;
   la semaine 1 couvre les stories 01 à 14, la semaine 2 les 15 à 28, etc.).
   Programme les 14 stories à raison de deux par jour, midi et 19 h, dans
   l'ordre des numéros, en **publication par notification** — jamais en
   auto-publication : je dois poser moi-même le sticker Quiz ou Sondage sur
   mon téléphone quand la notification arrive.

4. À la fin : montre-moi un récapitulatif clair (quoi, quel jour, quelle
   heure), et envoie-moi le `STORIES.md` de la semaine pour que je l'aie
   sous la main sur mon téléphone — c'est lui qui contient, pour chaque
   story, les 4 options du sticker, la bonne réponse et la référence.

Règles : tout est **programmé**, rien n'est publié immédiatement. Ne touche
qu'au compte Instagram de Bible Horizon, à rien d'autre dans Metricool. Au
moindre doute (compte, doublon, dates), demande-moi avant d'agir.
