<?php
/* ============================================================================
   Connexion à la base + migrations automatiques.

   - Si la variable d'environnement MYSQL_URL existe (fournie par le plugin
     MySQL de Railway, format mysql://user:pass@host:port/base) → MySQL.
   - Sinon → repli SQLite dans api/data/dev.sqlite : permet de tester en local
     avec `php -S` et de démarrer sans base configurée.

   Le schéma évolue par MIGRATIONS versionnées : la table schema_migrations
   tamponne chaque étape appliquée. L'étape 1 est le schéma historique
   (CREATE TABLE IF NOT EXISTS, idempotent) ; les suivantes peuvent tout
   faire, ALTER TABLE compris. Règle d'or : on ne retouche JAMAIS une étape
   passée — on en ajoute une nouvelle, et on incrémente DB_MIGRATION_DERNIERE.
   ========================================================================== */

defined('GRAINE_API') || exit;

/** Retourne la connexion PDO (créée une seule fois par requête). */
function db(): PDO {
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $mysqlUrl = getenv('MYSQL_URL');
    if ($mysqlUrl !== false && $mysqlUrl !== '') {
        $parts = parse_url($mysqlUrl);
        if ($parts === false || !isset($parts['host'])) {
            throw new RuntimeException('MYSQL_URL est mal formée (attendu : mysql://user:pass@host:port/base).');
        }
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            $parts['host'],
            $parts['port'] ?? 3306,
            ltrim($parts['path'] ?? '', '/')
        );
        $pdo = new PDO($dsn, urldecode($parts['user'] ?? ''), urldecode($parts['pass'] ?? ''));
    } else {
        $dir = __DIR__ . '/data';
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        $pdo = new PDO('sqlite:' . $dir . '/dev.sqlite');
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = 5000');
    }

    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

    db_migrate($pdo);
    return $pdo;
}

/** Nom du pilote utilisé : "mysql" ou "sqlite". */
function db_driver(PDO $pdo): string {
    return $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
}

/** Dernière étape de migration connue — à incrémenter avec chaque nouvelle étape. */
const DB_MIGRATION_DERNIERE = 3;

/** Applique les étapes de migration manquantes (journal : schema_migrations). */
function db_migrate(PDO $pdo): void {
    // Le journal remplace l'ancienne « sonde » sur la table la plus récente :
    // chaque étape s'applique une seule fois puis se tamponne — c'est ce qui
    // rend les ALTER TABLE possibles sur les bases déjà déployées.
    $pdo->exec(db_driver($pdo) === 'mysql'
        ? 'CREATE TABLE IF NOT EXISTS schema_migrations (
              version INT UNSIGNED NOT NULL PRIMARY KEY,
              applied_at DATETIME NOT NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
        : 'CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER NOT NULL PRIMARY KEY,
              applied_at TEXT NOT NULL
          )');
    $fait = (int) $pdo->query('SELECT COALESCE(MAX(version), 0) FROM schema_migrations')->fetchColumn();
    if ($fait >= DB_MIGRATION_DERNIERE) {
        return; // tout est en place — le chemin de toutes les requêtes sauf la première
    }

    if (db_driver($pdo) === 'mysql') {
        $ddl = [
            'CREATE TABLE IF NOT EXISTS users (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                pseudo VARCHAR(40) NOT NULL,
                friend_code VARCHAR(10) NOT NULL UNIQUE,
                created_at DATETIME NOT NULL,
                last_seen DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            'CREATE TABLE IF NOT EXISTS login_codes (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                code_hash VARCHAR(255) NOT NULL,
                expires_at DATETIME NOT NULL,
                attempts INT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                INDEX idx_login_codes_email (email)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            'CREATE TABLE IF NOT EXISTS sessions (
                token CHAR(64) NOT NULL PRIMARY KEY,
                user_id INT UNSIGNED NOT NULL,
                created_at DATETIME NOT NULL,
                expires_at DATETIME NOT NULL,
                INDEX idx_sessions_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            "CREATE TABLE IF NOT EXISTS sync_blobs (
                user_id INT UNSIGNED NOT NULL,
                module ENUM('memo','lire','defi') NOT NULL,
                payload MEDIUMTEXT NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (user_id, module)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            'CREATE TABLE IF NOT EXISTS friendships (
                user_a INT UNSIGNED NOT NULL,
                user_b INT UNSIGNED NOT NULL,
                created_at DATETIME NOT NULL,
                PRIMARY KEY (user_a, user_b)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            'CREATE TABLE IF NOT EXISTS duels (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                challenger_id INT UNSIGNED NOT NULL,
                opponent_id INT UNSIGNED NOT NULL,
                questions_json MEDIUMTEXT NOT NULL,
                challenger_answers TEXT NULL,
                opponent_answers TEXT NULL,
                challenger_score INT NULL,
                opponent_score INT NULL,
                created_at DATETIME NOT NULL,
                INDEX idx_duels_challenger (challenger_id),
                INDEX idx_duels_opponent (opponent_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            'CREATE TABLE IF NOT EXISTS veillees (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(8) NOT NULL,
                host_user_id INT UNSIGNED NOT NULL,
                statut VARCHAR(10) NOT NULL,
                questions_json MEDIUMTEXT NOT NULL,
                current_q INT NOT NULL DEFAULT -1,
                seconds INT NOT NULL,
                question_started_at DATETIME NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                INDEX idx_veillees_code (code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            'CREATE TABLE IF NOT EXISTS veillee_players (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                veillee_id INT UNSIGNED NOT NULL,
                player_key CHAR(32) NOT NULL,
                prenom VARCHAR(40) NOT NULL,
                score INT NOT NULL DEFAULT 0,
                joined_at DATETIME NOT NULL,
                INDEX idx_vplayers_veillee (veillee_id),
                INDEX idx_vplayers_key (player_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            'CREATE TABLE IF NOT EXISTS veillee_answers (
                veillee_id INT UNSIGNED NOT NULL,
                q_index INT NOT NULL,
                player_id INT UNSIGNED NOT NULL,
                answer INT NOT NULL,
                correct TINYINT NOT NULL,
                points INT NOT NULL,
                answered_at DATETIME NOT NULL,
                PRIMARY KEY (veillee_id, q_index, player_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Retouches de la banque de questions du Défi (administration).
            // Le fichier defi/data/questions.json est embarqué dans l'image et
            // Railway a un système de fichiers éphémère : les modifications
            // vivent donc ici. Un id présent dans le fichier = SURCHARGE
            // (édition, ou désactivation si actif = 0) ; un id nouveau
            // (préfixe adm-) = AJOUT.
            'CREATE TABLE IF NOT EXISTS quiz_questions (
                id VARCHAR(40) NOT NULL PRIMARY KEY,
                categorie VARCHAR(60) NOT NULL,
                niveau TINYINT NOT NULL,
                question VARCHAR(300) NOT NULL,
                options_json TEXT NOT NULL,
                bonne TINYINT NOT NULL,
                reference VARCHAR(60) NOT NULL,
                actif TINYINT NOT NULL DEFAULT 1,
                updated_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Compteurs anti-abus par IP (ex. demandes de code de connexion).
            'CREATE TABLE IF NOT EXISTS throttle (
                bucket VARCHAR(120) NOT NULL PRIMARY KEY,
                n INT NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Journal des actions d'administration (qui / quoi / quand).
            'CREATE TABLE IF NOT EXISTS admin_log (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                admin_id INT UNSIGNED NOT NULL,
                admin_email VARCHAR(255) NOT NULL,
                action VARCHAR(40) NOT NULL,
                cible VARCHAR(190) NOT NULL,
                created_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Groupes d'église (fondations serveur — voir groupes.php).
            // On rejoint par code court (GRP-XXXXX) ; le responsable pousse
            // le verset de la semaine (verset_*), NULL tant que rien n'est posé.
            'CREATE TABLE IF NOT EXISTS groupes (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(10) NOT NULL UNIQUE,
                nom VARCHAR(40) NOT NULL,
                responsable_id INT UNSIGNED NOT NULL,
                verset_ref VARCHAR(60) NULL,
                verset_texte VARCHAR(500) NULL,
                verset_updated_at DATETIME NULL,
                created_at DATETIME NOT NULL,
                INDEX idx_groupes_responsable (responsable_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Adhésions aux groupes : une ligne par membre, y compris le
            // responsable (role « responsable » ou « membre »).
            'CREATE TABLE IF NOT EXISTS groupe_membres (
                groupe_id INT UNSIGNED NOT NULL,
                user_id INT UNSIGNED NOT NULL,
                role VARCHAR(12) NOT NULL,
                joined_at DATETIME NOT NULL,
                PRIMARY KEY (groupe_id, user_id),
                INDEX idx_gmembres_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // La page de l'église (voir groupes-page.php) : les annonces du
            // responsable, épinglables pour rester en tête de page.
            'CREATE TABLE IF NOT EXISTS groupe_annonces (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                groupe_id INT UNSIGNED NOT NULL,
                titre VARCHAR(80) NOT NULL,
                texte VARCHAR(2000) NOT NULL,
                epingle TINYINT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                INDEX idx_gannonces_groupe (groupe_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Les rendez-vous réguliers de l'assemblée (« Culte », « Prière »…) :
            // jour 0 = dimanche … 6 = samedi, heure « HH:MM », ordre d'affichage.
            'CREATE TABLE IF NOT EXISTS groupe_rdv (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                groupe_id INT UNSIGNED NOT NULL,
                libelle VARCHAR(80) NOT NULL,
                jour TINYINT NOT NULL,
                heure CHAR(5) NOT NULL,
                lieu VARCHAR(80) NULL,
                ordre INT NOT NULL DEFAULT 0,
                INDEX idx_grdv_groupe (groupe_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Les services ponctuels (« Nettoyage de la salle ») — VOLONTAIRES :
            // on lève la main (table suivante), on n'est pas réquisitionné.
            // date_service « YYYY-MM-DD » ; balayés 90 jours après la date.
            'CREATE TABLE IF NOT EXISTS groupe_services (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                groupe_id INT UNSIGNED NOT NULL,
                titre VARCHAR(80) NOT NULL,
                date_service CHAR(10) NOT NULL,
                details VARCHAR(500) NULL,
                places TINYINT NOT NULL,
                created_at DATETIME NOT NULL,
                INDEX idx_gservices_groupe (groupe_id),
                INDEX idx_gservices_date (date_service)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Les mains levées : une ligne par membre inscrit à un service.
            'CREATE TABLE IF NOT EXISTS groupe_service_inscriptions (
                service_id INT UNSIGNED NOT NULL,
                user_id INT UNSIGNED NOT NULL,
                created_at DATETIME NOT NULL,
                PRIMARY KEY (service_id, user_id),
                INDEX idx_gsinscriptions_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Configuration des notifications push (« le verset offert ») :
            // UNE rangée (id = 1), auto-générée au premier besoin — clés VAPID
            // (privée PEM + publique brute base64url), sujet de contact et clé
            // secrète du cron. Aucune variable d'environnement à configurer.
            'CREATE TABLE IF NOT EXISTS vapid (
                id TINYINT NOT NULL PRIMARY KEY,
                private_pem TEXT NOT NULL,
                public_b64u VARCHAR(90) NOT NULL,
                subject VARCHAR(120) NOT NULL,
                cron_key CHAR(64) NOT NULL,
                created_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Abonnements push : un par navigateur (endpoint). Les endpoints
            // dépassent souvent 255 caractères → TEXT, avec un haché SHA-256
            // (endpoint_hash) pour porter la contrainte UNIQUE, MySQL
            // ne sachant pas indexer un TEXT entier. user_id NULL = abonnement
            // anonyme (rotation générique). tz_offset : minutes, même signe
            // que getTimezoneOffset() côté JS (UTC+2 → -120). last_sent_day :
            // dernier jour servi, dans le fuseau de chaque abonné (posé AVANT
            // chaque envoi : idempotence du cron).
            'CREATE TABLE IF NOT EXISTS push_abonnements (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                endpoint TEXT NOT NULL,
                endpoint_hash CHAR(64) NOT NULL UNIQUE,
                p256dh VARCHAR(100) NOT NULL,
                auth VARCHAR(30) NOT NULL,
                user_id INT UNSIGNED NULL,
                heure TINYINT NOT NULL DEFAULT 8,
                tz_offset SMALLINT NOT NULL DEFAULT 0,
                last_sent_day VARCHAR(10) NULL,
                echecs TINYINT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                INDEX idx_push_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Quiz d'église — la banque de questions PAR GROUPE (voir
            // groupes-quiz.php). Réglages : mode 'toutes' (banque commune
            // entière) ou 'selection' (seuls les ids retenus ci-dessous).
            // Ne touche QUE les quiz lancés dans l'église : le Défi du jour
            // et le solo des membres restent mondiaux.
            "CREATE TABLE IF NOT EXISTS groupe_quiz_reglages (
                groupe_id INT UNSIGNED NOT NULL PRIMARY KEY,
                mode VARCHAR(10) NOT NULL DEFAULT 'toutes',
                updated_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            // Sélection du groupe : les ids de la banque commune retenus
            // (utilisée seulement en mode 'selection').
            'CREATE TABLE IF NOT EXISTS groupe_quiz_selection (
                groupe_id INT UNSIGNED NOT NULL,
                question_id VARCHAR(40) NOT NULL,
                PRIMARY KEY (groupe_id, question_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Questions propres au groupe (id « egl-<6 hex> », écrites par le
            // responsable) — mêmes contraintes de colonnes que quiz_questions.
            'CREATE TABLE IF NOT EXISTS groupe_questions (
                id VARCHAR(60) NOT NULL PRIMARY KEY,
                groupe_id INT UNSIGNED NOT NULL,
                categorie VARCHAR(60) NOT NULL,
                niveau TINYINT NOT NULL,
                question VARCHAR(300) NOT NULL,
                options_json TEXT NOT NULL,
                bonne TINYINT NOT NULL,
                reference VARCHAR(60) NOT NULL,
                actif TINYINT NOT NULL DEFAULT 1,
                updated_at DATETIME NOT NULL,
                INDEX idx_gquestions_groupe (groupe_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Lien quiz (veillée) ↔ église, SANS toucher à la table veillees
            // existante (pas de ALTER : les bases déjà déployées ne le
            // recevraient pas via CREATE IF NOT EXISTS).
            'CREATE TABLE IF NOT EXISTS veillee_groupes (
                veillee_id INT UNSIGNED NOT NULL PRIMARY KEY,
                groupe_id INT UNSIGNED NOT NULL,
                INDEX idx_vgroupes_groupe (groupe_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Journal serveur (onglet « Activité » de l'administration) :
            // les événements de connexion et d'envoi de codes, pour ne plus
            // fouiller les logs Railway. E-mail en clair (l'admin voit déjà
            // les adresses des comptes) mais purge automatique à 30 jours —
            // voir journal_log() dans helpers.php.
            'CREATE TABLE IF NOT EXISTS journal (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                ts DATETIME NOT NULL,
                event VARCHAR(40) NOT NULL,
                email VARCHAR(255) NULL,
                detail VARCHAR(200) NULL,
                INDEX idx_journal_ts (ts)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // La Frise (atelier d'essai, sans compte) — défis par code : le
            // paquet de cartes [{t,r,o}] est fourni par le client, la clé
            // authentifie le créateur (case p1). Balayage à 7 jours.
            'CREATE TABLE IF NOT EXISTS frise_duels (
                code VARCHAR(10) NOT NULL PRIMARY KEY,
                cle CHAR(32) NOT NULL,
                mode VARCHAR(40) NOT NULL,
                deck MEDIUMTEXT NOT NULL,
                total INT NOT NULL,
                p1_pseudo VARCHAR(20) NOT NULL,
                p1_score INT NULL,
                p2_pseudo VARCHAR(20) NULL,
                p2_score INT NULL,
                created_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // La Frise — veillées en direct : phase attente|placement|revele|
            // fin, carte = index de la carte en cours dans le paquet.
            // Balayage à 24 h. La clé authentifie l'animateur.
            'CREATE TABLE IF NOT EXISTS frise_veillees (
                code VARCHAR(10) NOT NULL PRIMARY KEY,
                cle CHAR(32) NOT NULL,
                mode VARCHAR(40) NOT NULL,
                deck MEDIUMTEXT NOT NULL,
                phase VARCHAR(12) NOT NULL,
                carte INT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // La Frise — participants d'une veillée : le jeton authentifie,
            // reponse/bon portent la carte EN COURS (remis à NULL à chaque
            // nouvelle carte), le score cumule.
            'CREATE TABLE IF NOT EXISTS frise_participants (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(10) NOT NULL,
                jeton CHAR(32) NOT NULL,
                prenom VARCHAR(20) NOT NULL,
                score INT NOT NULL DEFAULT 0,
                reponse INT NULL,
                bon TINYINT NULL,
                created_at DATETIME NOT NULL,
                INDEX idx_frisep_code (code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Épreuves à choix (« Qui a dit ça ? », « Écrit… ou pas ? »…) —
            // mêmes formes que les tables frise_*, mais le paquet porte des
            // questions à options et l'arbitrage compare des index de choix
            // (voir api/epreuve.php).
            'CREATE TABLE IF NOT EXISTS epreuve_duels (
                code VARCHAR(10) NOT NULL PRIMARY KEY,
                cle CHAR(32) NOT NULL,
                mode VARCHAR(40) NOT NULL,
                deck MEDIUMTEXT NOT NULL,
                total INT NOT NULL,
                p1_pseudo VARCHAR(20) NOT NULL,
                p1_score INT NULL,
                p2_pseudo VARCHAR(20) NULL,
                p2_score INT NULL,
                created_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            'CREATE TABLE IF NOT EXISTS epreuve_veillees (
                code VARCHAR(10) NOT NULL PRIMARY KEY,
                cle CHAR(32) NOT NULL,
                mode VARCHAR(40) NOT NULL,
                deck MEDIUMTEXT NOT NULL,
                phase VARCHAR(12) NOT NULL,
                carte INT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            'CREATE TABLE IF NOT EXISTS epreuve_participants (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(10) NOT NULL,
                jeton CHAR(32) NOT NULL,
                prenom VARCHAR(20) NOT NULL,
                score INT NOT NULL DEFAULT 0,
                reponse INT NULL,
                bon TINYINT NULL,
                created_at DATETIME NOT NULL,
                INDEX idx_epreuvep_code (code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // « De qui parle-t-on ? » — veillées à indices : indice = combien
            // sont révélés ; reponse des participants en TEXTE libre, points
            // dégressifs (voir api/portrait.php). Les défis PD- vivent dans
            // epreuve_duels.
            'CREATE TABLE IF NOT EXISTS portrait_veillees (
                code VARCHAR(10) NOT NULL PRIMARY KEY,
                cle CHAR(32) NOT NULL,
                mode VARCHAR(40) NOT NULL,
                deck MEDIUMTEXT NOT NULL,
                phase VARCHAR(12) NOT NULL,
                carte INT NOT NULL DEFAULT 0,
                indice INT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            'CREATE TABLE IF NOT EXISTS portrait_participants (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(10) NOT NULL,
                jeton CHAR(32) NOT NULL,
                prenom VARCHAR(20) NOT NULL,
                score INT NOT NULL DEFAULT 0,
                reponse VARCHAR(60) NULL,
                bon TINYINT NULL,
                points INT NULL,
                created_at DATETIME NOT NULL,
                INDEX idx_portraitp_code (code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Défis (duels entre amis) déjà signalés par notification : une
            // ligne = « on a prévenu l'adversaire, une fois, jamais plus » —
            // voir push_defis_en_attente() dans push.php.
            'CREATE TABLE IF NOT EXISTS push_defis (
                duel_id INT UNSIGNED NOT NULL PRIMARY KEY,
                notified_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Présence aux veillées : une ligne par participant, réécrite à
            // chaque sondage de l'état (~2 s). Elle dit qui est ENCORE là —
            // sans elle, quelqu'un parti en cours de veillée resterait attendu
            // et l'animateur subirait le décompte entier à chaque question.
            'CREATE TABLE IF NOT EXISTS veillee_presence (
                veillee_id INT UNSIGNED NOT NULL,
                player_id INT UNSIGNED NOT NULL,
                last_seen DATETIME NOT NULL,
                PRIMARY KEY (veillee_id, player_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Fréquentation : de simples compteurs par jour et par page —
            // AUCUN identifiant, aucune adresse, aucun cookie. On sait
            // « combien d'ouvertures », jamais qui. Voir api/visites.php.
            'CREATE TABLE IF NOT EXISTS visites (
                jour CHAR(10) NOT NULL,
                page VARCHAR(30) NOT NULL,
                n INT UNSIGNED NOT NULL DEFAULT 0,
                PRIMARY KEY (jour, page)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',

            // Retouches des banques d'épreuves à fichier JSON (« Qui a dit
            // ça ? », « Écrit… ou pas ? », « De qui parle-t-on ? ») — même
            // principe que quiz_questions : un id présent dans le fichier
            // = SURCHARGE (édition, ou désactivation si actif = 0), un id
            // nouveau (préfixe adm-) = AJOUT. corps porte l'item COMPLET en
            // JSON — chaque module garde sa propre forme, c'est voulu.
            // Voir api/banques.php.
            "CREATE TABLE IF NOT EXISTS banque_surcharges (
                module ENUM('quiadit','ecritoupas','portrait') NOT NULL,
                id VARCHAR(40) NOT NULL,
                corps MEDIUMTEXT NOT NULL,
                actif TINYINT NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL,
                PRIMARY KEY (module, id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            // Demandes de groupe d'église : la création n'est plus libre — on
            // dépose une demande (le nom souhaité), et seule l'administration
            // l'accepte (le groupe naît alors) ou la refuse (statut 'refusee',
            // remplaçable par une nouvelle demande). UNE demande par compte à
            // la fois — voir api/groupes-demandes.php.
            "CREATE TABLE IF NOT EXISTS groupe_demandes (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                user_id INT UNSIGNED NOT NULL,
                nom VARCHAR(40) NOT NULL,
                statut VARCHAR(10) NOT NULL DEFAULT 'attente',
                created_at DATETIME NOT NULL,
                INDEX idx_gdemandes_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            // Détails de la demande de groupe — table COMPAGNE de
            // groupe_demandes (pas d'ALTER : les bases déjà déployées ne le
            // recevraient pas via CREATE IF NOT EXISTS) : l'adresse de
            // l'église (obligatoire au dépôt) et un e-mail de contact si
            // différent de celui du compte (NULL sinon). La ligne suit la
            // demande dans tout son cycle — voir api/groupes-demandes.php.
            'CREATE TABLE IF NOT EXISTS groupe_demande_details (
                demande_id INT UNSIGNED NOT NULL PRIMARY KEY,
                adresse VARCHAR(120) NOT NULL,
                email VARCHAR(255) NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        ];
    } else {
        $ddl = [
            'CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                pseudo TEXT NOT NULL,
                friend_code TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                last_seen TEXT NOT NULL
            )',

            'CREATE TABLE IF NOT EXISTS login_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                code_hash TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes (email)',

            'CREATE TABLE IF NOT EXISTS sessions (
                token TEXT NOT NULL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)',

            "CREATE TABLE IF NOT EXISTS sync_blobs (
                user_id INTEGER NOT NULL,
                module TEXT NOT NULL CHECK (module IN ('memo','lire','defi')),
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, module)
            )",

            'CREATE TABLE IF NOT EXISTS friendships (
                user_a INTEGER NOT NULL,
                user_b INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (user_a, user_b)
            )',

            'CREATE TABLE IF NOT EXISTS duels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                challenger_id INTEGER NOT NULL,
                opponent_id INTEGER NOT NULL,
                questions_json TEXT NOT NULL,
                challenger_answers TEXT NULL,
                opponent_answers TEXT NULL,
                challenger_score INTEGER NULL,
                opponent_score INTEGER NULL,
                created_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_duels_challenger ON duels (challenger_id)',
            'CREATE INDEX IF NOT EXISTS idx_duels_opponent ON duels (opponent_id)',

            'CREATE TABLE IF NOT EXISTS veillees (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL,
                host_user_id INTEGER NOT NULL,
                statut TEXT NOT NULL,
                questions_json TEXT NOT NULL,
                current_q INTEGER NOT NULL DEFAULT -1,
                seconds INTEGER NOT NULL,
                question_started_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_veillees_code ON veillees (code)',

            'CREATE TABLE IF NOT EXISTS veillee_players (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                veillee_id INTEGER NOT NULL,
                player_key TEXT NOT NULL,
                prenom TEXT NOT NULL,
                score INTEGER NOT NULL DEFAULT 0,
                joined_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_vplayers_veillee ON veillee_players (veillee_id)',
            'CREATE INDEX IF NOT EXISTS idx_vplayers_key ON veillee_players (player_key)',

            'CREATE TABLE IF NOT EXISTS veillee_answers (
                veillee_id INTEGER NOT NULL,
                q_index INTEGER NOT NULL,
                player_id INTEGER NOT NULL,
                answer INTEGER NOT NULL,
                correct INTEGER NOT NULL,
                points INTEGER NOT NULL,
                answered_at TEXT NOT NULL,
                PRIMARY KEY (veillee_id, q_index, player_id)
            )',

            // Retouches de la banque de questions du Défi — voir le
            // commentaire du dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS quiz_questions (
                id TEXT NOT NULL PRIMARY KEY,
                categorie TEXT NOT NULL,
                niveau INTEGER NOT NULL,
                question TEXT NOT NULL,
                options_json TEXT NOT NULL,
                bonne INTEGER NOT NULL,
                reference TEXT NOT NULL,
                actif INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            )',

            // Compteurs anti-abus par IP (ex. demandes de code de connexion).
            'CREATE TABLE IF NOT EXISTS throttle (
                bucket TEXT NOT NULL PRIMARY KEY,
                n INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            )',

            // Journal des actions d'administration (qui / quoi / quand).
            'CREATE TABLE IF NOT EXISTS admin_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                admin_id INTEGER NOT NULL,
                admin_email TEXT NOT NULL,
                action TEXT NOT NULL,
                cible TEXT NOT NULL,
                created_at TEXT NOT NULL
            )',

            // Groupes d'église — voir le commentaire du dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS groupes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                nom TEXT NOT NULL,
                responsable_id INTEGER NOT NULL,
                verset_ref TEXT NULL,
                verset_texte TEXT NULL,
                verset_updated_at TEXT NULL,
                created_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_groupes_responsable ON groupes (responsable_id)',

            // Adhésions aux groupes : une ligne par membre, y compris le
            // responsable (role « responsable » ou « membre »).
            'CREATE TABLE IF NOT EXISTS groupe_membres (
                groupe_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                joined_at TEXT NOT NULL,
                PRIMARY KEY (groupe_id, user_id)
            )',
            'CREATE INDEX IF NOT EXISTS idx_gmembres_user ON groupe_membres (user_id)',

            // La page de l'église (annonces, rendez-vous, services et mains
            // levées) — voir les commentaires du dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS groupe_annonces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                groupe_id INTEGER NOT NULL,
                titre TEXT NOT NULL,
                texte TEXT NOT NULL,
                epingle INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_gannonces_groupe ON groupe_annonces (groupe_id)',

            'CREATE TABLE IF NOT EXISTS groupe_rdv (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                groupe_id INTEGER NOT NULL,
                libelle TEXT NOT NULL,
                jour INTEGER NOT NULL,
                heure TEXT NOT NULL,
                lieu TEXT NULL,
                ordre INTEGER NOT NULL DEFAULT 0
            )',
            'CREATE INDEX IF NOT EXISTS idx_grdv_groupe ON groupe_rdv (groupe_id)',

            'CREATE TABLE IF NOT EXISTS groupe_services (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                groupe_id INTEGER NOT NULL,
                titre TEXT NOT NULL,
                date_service TEXT NOT NULL,
                details TEXT NULL,
                places INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_gservices_groupe ON groupe_services (groupe_id)',
            'CREATE INDEX IF NOT EXISTS idx_gservices_date ON groupe_services (date_service)',

            'CREATE TABLE IF NOT EXISTS groupe_service_inscriptions (
                service_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (service_id, user_id)
            )',
            'CREATE INDEX IF NOT EXISTS idx_gsinscriptions_user ON groupe_service_inscriptions (user_id)',

            // Configuration des notifications push — voir le commentaire du
            // dialecte MySQL ci-dessus (une rangée, id = 1, auto-générée).
            'CREATE TABLE IF NOT EXISTS vapid (
                id INTEGER NOT NULL PRIMARY KEY,
                private_pem TEXT NOT NULL,
                public_b64u TEXT NOT NULL,
                subject TEXT NOT NULL,
                cron_key TEXT NOT NULL,
                created_at TEXT NOT NULL
            )',

            // Abonnements push — voir le commentaire du dialecte MySQL.
            'CREATE TABLE IF NOT EXISTS push_abonnements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                endpoint TEXT NOT NULL,
                endpoint_hash TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                user_id INTEGER NULL,
                heure INTEGER NOT NULL DEFAULT 8,
                tz_offset INTEGER NOT NULL DEFAULT 0,
                last_sent_day TEXT NULL,
                echecs INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_push_user ON push_abonnements (user_id)',

            // Quiz d'église — la banque de questions par groupe : voir le
            // commentaire du dialecte MySQL ci-dessus.
            "CREATE TABLE IF NOT EXISTS groupe_quiz_reglages (
                groupe_id INTEGER NOT NULL PRIMARY KEY,
                mode TEXT NOT NULL DEFAULT 'toutes',
                updated_at TEXT NOT NULL
            )",

            'CREATE TABLE IF NOT EXISTS groupe_quiz_selection (
                groupe_id INTEGER NOT NULL,
                question_id TEXT NOT NULL,
                PRIMARY KEY (groupe_id, question_id)
            )',

            'CREATE TABLE IF NOT EXISTS groupe_questions (
                id TEXT NOT NULL PRIMARY KEY,
                groupe_id INTEGER NOT NULL,
                categorie TEXT NOT NULL,
                niveau INTEGER NOT NULL,
                question TEXT NOT NULL,
                options_json TEXT NOT NULL,
                bonne INTEGER NOT NULL,
                reference TEXT NOT NULL,
                actif INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_gquestions_groupe ON groupe_questions (groupe_id)',

            // Lien quiz (veillée) ↔ église — voir le dialecte MySQL.
            'CREATE TABLE IF NOT EXISTS veillee_groupes (
                veillee_id INTEGER NOT NULL PRIMARY KEY,
                groupe_id INTEGER NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_vgroupes_groupe ON veillee_groupes (groupe_id)',

            // Journal serveur — voir le commentaire du dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS journal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                event TEXT NOT NULL,
                email TEXT NULL,
                detail TEXT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_journal_ts ON journal (ts)',

            // La Frise (atelier d'essai) — voir le dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS frise_duels (
                code TEXT NOT NULL PRIMARY KEY,
                cle TEXT NOT NULL,
                mode TEXT NOT NULL,
                deck TEXT NOT NULL,
                total INTEGER NOT NULL,
                p1_pseudo TEXT NOT NULL,
                p1_score INTEGER NULL,
                p2_pseudo TEXT NULL,
                p2_score INTEGER NULL,
                created_at TEXT NOT NULL
            )',
            'CREATE TABLE IF NOT EXISTS frise_veillees (
                code TEXT NOT NULL PRIMARY KEY,
                cle TEXT NOT NULL,
                mode TEXT NOT NULL,
                deck TEXT NOT NULL,
                phase TEXT NOT NULL,
                carte INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )',
            'CREATE TABLE IF NOT EXISTS frise_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL,
                jeton TEXT NOT NULL,
                prenom TEXT NOT NULL,
                score INTEGER NOT NULL DEFAULT 0,
                reponse INTEGER NULL,
                bon INTEGER NULL,
                created_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_frisep_code ON frise_participants (code)',

            // Épreuves à choix — voir le dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS epreuve_duels (
                code TEXT NOT NULL PRIMARY KEY,
                cle TEXT NOT NULL,
                mode TEXT NOT NULL,
                deck TEXT NOT NULL,
                total INTEGER NOT NULL,
                p1_pseudo TEXT NOT NULL,
                p1_score INTEGER NULL,
                p2_pseudo TEXT NULL,
                p2_score INTEGER NULL,
                created_at TEXT NOT NULL
            )',
            'CREATE TABLE IF NOT EXISTS epreuve_veillees (
                code TEXT NOT NULL PRIMARY KEY,
                cle TEXT NOT NULL,
                mode TEXT NOT NULL,
                deck TEXT NOT NULL,
                phase TEXT NOT NULL,
                carte INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )',
            'CREATE TABLE IF NOT EXISTS epreuve_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL,
                jeton TEXT NOT NULL,
                prenom TEXT NOT NULL,
                score INTEGER NOT NULL DEFAULT 0,
                reponse INTEGER NULL,
                bon INTEGER NULL,
                created_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_epreuvep_code ON epreuve_participants (code)',

            // « De qui parle-t-on ? » — voir le dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS portrait_veillees (
                code TEXT NOT NULL PRIMARY KEY,
                cle TEXT NOT NULL,
                mode TEXT NOT NULL,
                deck TEXT NOT NULL,
                phase TEXT NOT NULL,
                carte INTEGER NOT NULL DEFAULT 0,
                indice INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )',
            'CREATE TABLE IF NOT EXISTS portrait_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL,
                jeton TEXT NOT NULL,
                prenom TEXT NOT NULL,
                score INTEGER NOT NULL DEFAULT 0,
                reponse TEXT NULL,
                bon INTEGER NULL,
                points INTEGER NULL,
                created_at TEXT NOT NULL
            )',
            'CREATE INDEX IF NOT EXISTS idx_portraitp_code ON portrait_participants (code)',

            // Défis déjà signalés — voir le dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS push_defis (
                duel_id INTEGER NOT NULL PRIMARY KEY,
                notified_at TEXT NOT NULL
            )',

            // Présence aux veillées — voir le dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS veillee_presence (
                veillee_id INTEGER NOT NULL,
                player_id INTEGER NOT NULL,
                last_seen TEXT NOT NULL,
                PRIMARY KEY (veillee_id, player_id)
            )',

            // Fréquentation — voir le dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS visites (
                jour TEXT NOT NULL,
                page TEXT NOT NULL,
                n INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (jour, page)
            )',

            // Retouches des banques d'épreuves à fichier JSON — voir le
            // commentaire du dialecte MySQL ci-dessus.
            "CREATE TABLE IF NOT EXISTS banque_surcharges (
                module TEXT NOT NULL CHECK (module IN ('quiadit','ecritoupas','portrait')),
                id TEXT NOT NULL,
                corps TEXT NOT NULL,
                actif INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                PRIMARY KEY (module, id)
            )",

            // Demandes de groupe d'église — voir le dialecte MySQL ci-dessus.
            "CREATE TABLE IF NOT EXISTS groupe_demandes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                nom TEXT NOT NULL,
                statut TEXT NOT NULL DEFAULT 'attente',
                created_at TEXT NOT NULL
            )",
            'CREATE INDEX IF NOT EXISTS idx_gdemandes_user ON groupe_demandes (user_id)',

            // Détails de la demande de groupe (table compagne) — voir le
            // dialecte MySQL ci-dessus.
            'CREATE TABLE IF NOT EXISTS groupe_demande_details (
                demande_id INTEGER NOT NULL PRIMARY KEY,
                adresse TEXT NOT NULL,
                email TEXT NULL
            )',
        ];
    }

    /* ---- Étape 2 — la banque d'église par épreuve ------------------------------
       Réglages (mode toutes/sélection + sélection d'ids de la banque commune)
       et questions propres par couple (groupe, module), pour quiadit,
       ecritoupas et portrait — voir api/groupes-banques.php. */
    if (db_driver($pdo) === 'mysql') {
        $etape2 = [
            "CREATE TABLE IF NOT EXISTS groupe_banques (
                groupe_id INT UNSIGNED NOT NULL,
                module VARCHAR(20) NOT NULL,
                mode ENUM('toutes','selection') NOT NULL DEFAULT 'toutes',
                selection MEDIUMTEXT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (groupe_id, module)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            "CREATE TABLE IF NOT EXISTS groupe_banque_items (
                groupe_id INT UNSIGNED NOT NULL,
                module VARCHAR(20) NOT NULL,
                item_id VARCHAR(60) NOT NULL,
                item MEDIUMTEXT NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (groupe_id, module, item_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        ];
    } else {
        $etape2 = [
            "CREATE TABLE IF NOT EXISTS groupe_banques (
                groupe_id INTEGER NOT NULL,
                module TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'toutes',
                selection TEXT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (groupe_id, module)
            )",

            "CREATE TABLE IF NOT EXISTS groupe_banque_items (
                groupe_id INTEGER NOT NULL,
                module TEXT NOT NULL,
                item_id TEXT NOT NULL,
                item TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (groupe_id, module, item_id)
            )",
        ];
    }

    /* ---- Étape 3 — identité de l'église + rappel de service ---------------------
       Les premiers ALTER TABLE du projet (rendus possibles par le journal) :
       - groupes.nom_style / nom_taille : l'en-tête de la page Mon église,
         par MOTS-CLÉS à liste blanche (jamais une police ni une taille libres) ;
       - groupe_service_inscriptions.rappel_envoye : le rappel push de la
         veille ne part qu'une fois (marqué avant l'envoi, comme push_defis). */
    $etape3 = db_driver($pdo) === 'mysql'
        ? [
            "ALTER TABLE groupes ADD COLUMN nom_style VARCHAR(20) NULL",
            "ALTER TABLE groupes ADD COLUMN nom_taille VARCHAR(20) NULL",
            "ALTER TABLE groupe_service_inscriptions ADD COLUMN rappel_envoye TINYINT NOT NULL DEFAULT 0",
        ]
        : [
            "ALTER TABLE groupes ADD COLUMN nom_style TEXT NULL",
            "ALTER TABLE groupes ADD COLUMN nom_taille TEXT NULL",
            "ALTER TABLE groupe_service_inscriptions ADD COLUMN rappel_envoye INTEGER NOT NULL DEFAULT 0",
        ];

    /* Chaque étape s'applique dans l'ordre puis se tamponne. Sur une base
       déjà déployée d'avant le journal, l'étape 1 traverse sans effet (tout
       est en IF NOT EXISTS) et prend simplement son tampon. */
    foreach ([1 => $ddl, 2 => $etape2, 3 => $etape3] as $version => $liste) {
        if ($version <= $fait) {
            continue;
        }
        foreach ($liste as $sql) {
            $pdo->exec($sql);
        }
        try {
            $pdo->prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
                ->execute([$version, gmdate('Y-m-d H:i:s')]);
        } catch (PDOException $e) {
            // Base neuve, deux requêtes simultanées : l'autre a posé le
            // tampon — les étapes sont idempotentes, rien n'est perdu.
        }
    }
}
