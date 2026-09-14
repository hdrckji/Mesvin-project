# La coquille WebView (remplace la TWA)

La TWA affichait le site dans Chrome : l'activité des testeurs était
attribuée à Chrome, invisible pour Google, et l'accès production des TWA est
régulièrement refusé pour « testeurs pas engagés » (et les services de
testeurs comme testerscommunity refusent les TWA pour cette raison). Cette
coquille WebView affiche le même site **dans l'application** : l'activité
compte, et le casse-tête assetlinks/barre d'adresse disparaît entièrement.

Rien ne change pour le site : biblehorizon.fr reste accessible dans tout
navigateur, la PWA reste installable, les déploiements Railway restent
instantanés. Même nom de paquet (`fr.biblehorizon.app`), même clé
d'importation, même fiche Play — c'est une simple mise à jour
(versionCode 2, versionName 1.1.0).

## Construire l'AAB

Prérequis : JDK 17 et le SDK Android (Android Studio les installe tous
les deux). Puis, depuis ce dossier :

```bash
# Le wrapper n'est pas versionné : le générer une fois.
gradle wrapper --gradle-version 8.7

# Sans signature (vérifier que tout compile) :
./gradlew bundleRelease

# Signé, prêt pour la Play Console — le keystore est celui créé avec
# bubblewrap en août (alias « biblehorizon », mot de passe dans le
# gestionnaire de mots de passe) :
BH_KEYSTORE=/chemin/vers/android.keystore \
BH_KEYSTORE_MDP='...' BH_CLE_MDP='...' \
./gradlew bundleRelease
```

L'AAB sort dans `app/build/outputs/bundle/release/app-release.aab`.
Ouvrir le dossier dans Android Studio et lancer *Build > Generate Signed
App Bundle* fonctionne tout aussi bien.

## Téléverser

Play Console → Tests → Test fermé → **Créer une release** → glisser
l'AAB → déployer. Le test et son compteur de testeurs continuent : une
nouvelle release ne remet pas les 14 jours à zéro.

## Ce que la coquille fait

- Le domaine (biblehorizon.fr et sous-domaines) reste dans l'appli ;
  tout autre lien s'ouvre dans le navigateur.
- Le bouton retour remonte l'historique du site avant de quitter.
- Sans réseau au lancement : page d'attente locale avec « Réessayer »
  (`assets/hors-ligne.html`).
- Raccourcis « Lire » et « Défi », liens profonds biblehorizon.fr.
- L'agent utilisateur contient `BibleHorizonApp/2` : `testeurs.js` (et tout
  script du site qui veut savoir où il tourne) s'en sert.

## Limite connue

La WebView ne porte pas le Web Push : les notifications du matin (« verset
du jour ») ne fonctionnent pas dans l'appli tant qu'un pont natif (FCM)
n'est pas construit. Le site les propose toujours dans Chrome. À traiter
après la mise en production ; d'ici là le site détecte l'absence de
PushManager et n'affiche simplement pas l'option.
