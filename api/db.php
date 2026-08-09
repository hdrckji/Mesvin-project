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
    // Test rapide : si la dernière table existe déjà, tout est en place.
    try {
        $pdo->query('SELECT 1 FROM duels LIMIT 1');
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
        ];
    }

    foreach ($ddl as $sql) {
        $pdo->exec($sql);
    }
}
