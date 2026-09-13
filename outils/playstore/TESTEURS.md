# Trouver les 12 testeurs du test fermé

Google exige, pour un compte développeur individuel récent, **12 testeurs
inscrits au test fermé, en continu pendant 14 jours**, avant d'autoriser la
publication publique. La règle est plus douce qu'elle n'en a l'air : les
testeurs n'ont **rien à évaluer ni à commenter** — il leur suffit de
s'inscrire, d'installer l'application, et de **ne pas la désinstaller**
pendant deux semaines.

## Les deux liens à partager

- **S'inscrire au test** : https://play.google.com/apps/testing/fr.biblehorizon.app
- **Installer ensuite** (le lien Play Store classique) :
  https://play.google.com/store/apps/details?id=fr.biblehorizon.app

L'inscription doit se faire avec le compte Google du téléphone, **avant**
l'installation — sinon le Play Store dit « article introuvable ».

⚠️ À vérifier une fois dans la Play Console (Tests → Test fermé → Testeurs) :
si le test est configuré par **liste d'adresses e-mail**, chaque testeur doit
y figurer avant de s'inscrire. Le plus simple est de basculer sur une
**Google Groupe** ouverte : les gens la rejoignent seuls, plus rien à gérer.

## Les trois canaux (dans l'ordre)

1. **Les utilisateurs du site** — `testeurs.js` affiche depuis la racine du
   site une petite carte « deviens testeur », sur Android uniquement,
   refermable, jamais dans l'appli Play elle-même. À retirer (une balise
   dans `index.html`) quand l'appli sera publique.
2. **WhatsApp / e-mail** — le message ci-dessous, à adresser à l'église, la
   famille, les amis. Même sans utiliser l'appli, installer et laisser
   installé 14 jours est un service que chacun peut rendre.
3. **Instagram** — la story « recherche testeurs » (générée par
   `outils/generer-story-testeurs.js`), avec un sticker **Lien** vers
   l'inscription.

## Le message WhatsApp (à copier tel quel)

> Salut ! 🌅 Petite demande de service : mon appli **Bible Horizon**
> (mémorisation de versets, lecture de la Bible, défis bibliques — gratuite
> et sans pub) arrive sur le Play Store. Avant de l'ouvrir à tous, Google
> me demande d'avoir 12 testeurs pendant 14 jours.
>
> Concrètement, ça prend 2 minutes et il n'y a rien d'autre à faire :
> 1. Ouvre ce lien et accepte l'invitation :
>    https://play.google.com/apps/testing/fr.biblehorizon.app
> 2. Installe l'appli depuis le Play Store :
>    https://play.google.com/store/apps/details?id=fr.biblehorizon.app
> 3. Garde-la installée 2 semaines (pas besoin de l'utiliser).
>
> C'est tout — et si en plus elle te sert, c'est encore mieux 🙂 Merci !

## La version e-mail (un peu plus posée)

> Objet : Un service de 2 minutes pour Bible Horizon
>
> Bonjour,
>
> Bible Horizon — l'application gratuite de mémorisation de versets, de
> lecture de la Bible et de défis bibliques — s'apprête à sortir sur le
> Play Store. Dernière étape imposée par Google : réunir 12 testeurs qui
> gardent l'application installée pendant 14 jours.
>
> Si vous avez un téléphone Android, vous pouvez rendre ce service en deux
> minutes : (1) accepter l'invitation via
> https://play.google.com/apps/testing/fr.biblehorizon.app puis
> (2) installer l'application depuis
> https://play.google.com/store/apps/details?id=fr.biblehorizon.app et
> simplement la garder installée. Rien d'autre n'est attendu.
>
> Merci de tout cœur pour ce coup de main.
> Jimmy — biblehorizon.fr

## Tenir le compte

La Play Console (Tests → Test fermé) affiche le nombre de testeurs et le
compte à rebours des 14 jours. Deux points de vigilance :
- le compteur repart si quelqu'un désinstalle : viser **15-16 inscrits**
  plutôt que 12 pile, pour absorber les défections ;
- une fois les 14 jours atteints, la Play Console ouvre le formulaire de
  **demande d'accès à la production** (questions sur le test) — la remplir
  honnêtement : testeurs de la communauté de l'appli, retours par WhatsApp.

En appoint si les 12 ne sont pas atteints : les communautés d'entraide entre
développeurs (r/AndroidClosedTesting sur Reddit, groupes Telegram « closed
testing ») fonctionnent sur la réciprocité — on teste leurs applis, ils
testent la nôtre.
