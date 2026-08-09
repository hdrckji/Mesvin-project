<?php
/* ============================================================================
   Bible Horizon — point d'entrée UNIQUE de l'API.

   Le Caddyfile réécrit /api/* vers ce fichier ; les autres fichiers .php ne
   sont jamais exécutés directement (ils vérifient la constante GRAINE_API).
   Le routage se fait sur le chemin d'origine (REQUEST_URI), conformément
   au contrat décrit dans API-CONTRAT.md.
   ========================================================================== */

declare(strict_types=1);

define('GRAINE_API', true);

// Jamais de détail technique ni de trace en sortie : tout part dans les logs.
ini_set('display_errors', '0');
ini_set('log_errors', '1');

require __DIR__ . '/helpers.php';
require __DIR__ . '/db.php';
require __DIR__ . '/mail.php';
require __DIR__ . '/auth.php';
require __DIR__ . '/sync.php';
require __DIR__ . '/friends.php';
require __DIR__ . '/duels.php';

set_exception_handler(function (Throwable $e): void {
    error_log(sprintf('API : %s — %s:%d', $e->getMessage(), $e->getFile(), $e->getLine()));
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Erreur interne du serveur.'], JSON_UNESCAPED_UNICODE);
});

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = rtrim($path, '/');

/* ---- GET /api/health : état de la base et du courrier ---------------------- */
if ($path === '/api/health' && $method === 'GET') {
    $mysqlUrl = getenv('MYSQL_URL');
    $attempted = ($mysqlUrl !== false && $mysqlUrl !== '') ? 'mysql' : 'sqlite';
    try {
        $pdo = db();
        $pdo->query('SELECT 1');
    } catch (Throwable $e) {
        error_log('API health : base injoignable — ' . $e->getMessage());
        // Diagnostic sans secret : pilote tenté + nature de l'erreur (les
        // messages PDO ne contiennent pas le mot de passe ; coupé à 160
        // caractères par prudence). Réservé à cette route de contrôle.
        json_out([
            'ok'    => false,
            'error' => 'Base de données injoignable.',
            'db'    => $attempted,
            'hint'  => mb_substr($e->getMessage(), 0, 160),
        ], 500);
    }
    json_out([
        'ok'   => true,
        'db'   => db_driver($pdo),
        'mail' => mail_mode(),
        // Diagnostic de déploiement : la page de démonstration de l'image de
        // base est-elle encore présente à la racine web ? (doit être false)
        'demo' => file_exists(dirname(__DIR__) . '/index.php'),
    ]);
}

$pdo = db();

/* ---- Authentification & compte --------------------------------------------- */
if ($path === '/api/auth/request-code' && $method === 'POST') handle_auth_request_code($pdo);
if ($path === '/api/auth/verify'       && $method === 'POST') handle_auth_verify($pdo);
if ($path === '/api/auth/logout'       && $method === 'POST') handle_auth_logout($pdo);
if ($path === '/api/me'                && $method === 'GET')  handle_me_get($pdo);
if ($path === '/api/me/pseudo'         && $method === 'POST') handle_me_pseudo($pdo);
if ($path === '/api/me'                && $method === 'DELETE') handle_me_delete($pdo);

/* ---- Synchronisation -------------------------------------------------------- */
if ($path === '/api/sync' && $method === 'GET') handle_sync_get($pdo);
if ($path === '/api/sync' && $method === 'PUT') handle_sync_put($pdo);

/* ---- Amis -------------------------------------------------------------------- */
if ($path === '/api/friends'     && $method === 'GET')  handle_friends_list($pdo);
if ($path === '/api/friends/add' && $method === 'POST') handle_friends_add($pdo);
if (preg_match('#^/api/friends/([^/]+)$#', $path, $m) && $method === 'DELETE') {
    handle_friends_remove($pdo, $m[1]);
}

/* ---- Duels -------------------------------------------------------------------- */
if ($path === '/api/duels' && $method === 'POST') handle_duels_create($pdo);
if ($path === '/api/duels' && $method === 'GET')  handle_duels_list($pdo);
if (preg_match('#^/api/duels/([0-9]+)$#', $path, $m) && $method === 'GET') {
    handle_duels_detail($pdo, (int) $m[1]);
}
if (preg_match('#^/api/duels/([0-9]+)/result$#', $path, $m) && $method === 'POST') {
    handle_duels_result($pdo, (int) $m[1]);
}

json_error('Route inconnue.', 404);
