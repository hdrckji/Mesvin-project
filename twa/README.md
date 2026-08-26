# Bible Horizon — appli Android (TWA)

Ce dossier contient le projet Android qui emballe le site **biblehorizon.fr** en
application Android de type **TWA** (Trusted Web Activity), destinée au Play Store.

- Package : `fr.biblehorizon.app` — versionCode `1`, versionName `1.0.0`
- Généré par [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) à partir de
  `twa-manifest.json` (les URL `localhost` qu'il contient viennent d'un environnement
  de build sans accès réseau au site : pour régénérer le projet, remplacez-les par
  `https://biblehorizon.fr/...` ou servez le dépôt sur `localhost:8765`).

## Build

Le workflow GitHub Actions **Build TWA AAB** (déclenchement manuel) compile
`bundleRelease` et dépose l'AAB **non signé** dans `twa/dist/`.

La **signature** se fait hors CI avec la clé d'upload (`android.keystore`, alias
`biblehorizon`) qui n'est **jamais committée** (voir `.gitignore`) :

```bash
jarsigner -keystore android.keystore -signedjar app-release.aab \
  dist/app-release-unsigned.aab biblehorizon
```

## Lien site ↔ appli (assetlinks)

`/.well-known/assetlinks.json` (à la racine du site) doit contenir les empreintes
SHA-256 **des deux clés** pour que l'appli s'ouvre sans barre d'adresse :

1. la clé d'upload (déjà en place) ;
2. la clé de signature **Google Play** — à récupérer après le premier envoi de
   l'AAB, dans Play Console → Configuration → Intégrité de l'application →
   Signature des applications, puis à ajouter au tableau
   `sha256_cert_fingerprints` et à déployer sur le site.
