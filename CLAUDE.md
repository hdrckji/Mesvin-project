# CLAUDE.md — mémoire du projet Bible Horizon

## Le projet en bref

**Bible Horizon** (biblehorizon.fr) : PWA francophone de mémorisation de la Bible
(Segond 1910), gratuite, sans pub. Trois modules : Mémoriser (racine), Lire (`lire/`),
Défis (`defi/`). Site statique + API (`api/`), servi par Caddy (voir `Caddyfile`,
`Dockerfile`). Auteur : Jimmy Hendrickx (hdrck.ji@gmail.com / contact@biblehorizon.fr).
Les commits s'écrivent en français, dans le style narratif de l'historique existant.

## Parcours Google Play — état au 26/08/2026

### Compte développeur
- Compte individuel Google Play créé le 21/08/2026 (frais 25 $ payés),
  **identité validée le 26/08/2026** (après un premier refus « justificatif trop
  ancien », résolu avec une attestation Alterna énergie du 25/08).
- Profil de paiement : 7765-8047-7550. Adresse : 5 rue Aimable Liénard, 59600 Vieux-Reng (FR).
- Contrainte compte récent : **test fermé de 12 testeurs actifs pendant 14 jours
  continus** obligatoire avant de demander l'accès production (usage réel vérifié).

### Appli Android (TWA)
- Projet TWA généré par Bubblewrap dans `twa/` — package **`fr.biblehorizon.app`**,
  v1.0.0 (versionCode 1). Voir `twa/README.md`.
- **Build** : le workflow `.github/workflows/build-twa.yml` (push sur la branche de
  travail touchant `twa/`, hors `twa/dist/`, ou déclenchement manuel) compile
  `bundleRelease` sur GitHub Actions et committe l'AAB **non signé** dans `twa/dist/`.
  Motif : le réseau des sessions Claude bloque `dl.google.com` (SDK Android) —
  ne pas tenter de builder localement, faire construire par la CI puis signer ici.
- **Signature** : clé d'upload `android.keystore` (alias `biblehorizon`,
  RSA 2048, validité 30 ans). Elle n'est **PAS dans le dépôt** (`.gitignore`) et la
  session étant éphémère, elle n'existe plus ici : **demander à Jimmy de joindre le
  fichier `android.keystore` + son mot de passe** (il les conserve, livrés le
  26/08/2026) pour signer un nouvel AAB (`jarsigner`, cf. `twa/README.md`).
- Empreinte SHA-256 de la clé d'upload :
  `6E:7F:AC:9C:BB:CF:6F:C7:C2:71:FB:62:6E:AA:D0:6B:C6:96:9E:86:19:AD:3D:A6:50:01:33:B0:A4:3A:D3:3B`
- AAB signé v1.0.0 : `twa/dist/bible-horizon-1.0.0.aab` (signé le 26/08/2026).

### assetlinks / prérequis console (état)
- `.well-known/assetlinks.json` : contient l'empreinte de la clé d'upload.
  **TODO après le premier import dans la Play Console** : ajouter l'empreinte de la
  clé de signature **Google Play** (Play Console → Intégrité de l'application →
  Signature des applications), sinon la TWA garde la barre d'adresse.
- Déjà en ligne côté site : politique de confidentialité (`/confidentialite`),
  suppression de compte (`/supprimer-mon-compte`), icône 512 (`icon-512.png`).

### Compte démo pour la revue Google (déclaration « Accès à l'appli »)
- `demo-play@biblehorizon.fr` + code fixe **316705** (la connexion de l'appli est
  sans mot de passe, par code e-mail — l'examinateur utilise ce code fixe).
- Implémenté dans `api/auth.php` (`demo_play_email()` / `demo_play_code()`),
  documenté dans API-CONTRAT.md, couvert par la suite de tests. Env :
  `DEMO_PLAY_CODE` remplace le code (6 chiffres) ou, définie à vide, coupe le
  compte ; `DEMO_PLAY_EMAIL` remplace l'adresse. Compte ordinaire sans
  privilège, recréé à chaque passage. **Actif en prod après merge + déploiement.**

### Étapes restantes (dans l'ordre)
1. Jimmy crée l'appli dans la Play Console et remplit les déclarations
   (il a un prompt Cowork dédié pour se faire guider écran par écran).
2. Import de `bible-horizon-1.0.0.aab` en piste **Test fermé** + liste d'e-mails
   des testeurs → récupérer le lien d'inscription.
3. Ajouter l'empreinte Google Play à `assetlinks.json` + **merger la branche de
   travail dans `main`** et déployer (le site doit servir le nouvel assetlinks).
4. 12+ testeurs actifs 14 jours → demander l'accès production.
5. Mises à jour futures : incrémenter `appVersionCode`/`appVersionName` dans
   `twa/twa-manifest.json` ET `twa/app/build.gradle`, push → CI → signer → importer.

### Suivi Gmail
Le connecteur Gmail de Jimmy est branché : il sert à vérifier les retours de Google
(payments-noreply@google.com, etc.). Une routine de surveillance a existé pour la
validation d'identité (supprimée le 26/08 une fois l'identité validée).
