<?php
/* ============================================================================
   Connexion à la base + migrations automatiques.

   - Si la variable d'environnement MYSQL_URL existe (fournie par le plugin
     MySQL de Railway, format mysql://user:pass@host:port/base) → MySQL.
   - Sinon → repli SQLite dans api/data/dev.sqlite : permet de tester en local
     avec `php -S` et de démarrer sans base configurée.

   Les tables sont créées au premier appel (CREATE TABLE IF NOT EXISTS).
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

/** Crée les tables si elles n'existent pas encore. */
function db_migrate(PDO $pdo): void {
    // Test rapide : si la table la PLUS RÉCENTE existe déjà, tout est en place.
    // (sonder une table plus ancienne empêcherait les nouvelles d'être créées
    // sur une base déjà déployée — les CREATE IF NOT EXISTS sont idempotents)
    try {
        $pdo->query('SELECT 1 FROM push_abonnements LIMIT 1');
        return;
    } catch (PDOException $e) {
        // Tables absentes : on les crée ci-dessous.
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
        ];
    }

    foreach ($ddl as $sql) {
        $pdo->exec($sql);
    }
}
