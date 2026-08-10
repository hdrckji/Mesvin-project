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
require __DIR__ . '/veillees.php';
require __DIR__ . '/admin.php';

set_exception_handler(function (Throwable $e): void {
    error_log(sprintf('API : %s — %s:%d', $e->getMessage(), $e->getFile(), $e->getLine()));
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Erreur interne du serveur.'], JSON_UNESCAPED_UNICODE);
});

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = rtrim($path, '/');

/* ---- GET /api/health : état du service ---------------------------------------
   Public mais DISCRET : les anonymes ne voient que ok true/false ; le détail
   (pilote de base, mode e-mail, dernière erreur d'envoi…) est réservé aux
   admins — il renseignerait inutilement un curieux sur notre infrastructure.
   Le diagnostic complet des pannes reste dans les logs Railway. */
if ($path === '/api/health' && $method === 'GET') {
    try {
        $pdo = db();
        $pdo->query('SELECT 1');
    } catch (Throwable $e) {
        error_log('API health : base injoignable — ' . $e->getMessage());
        json_out(['ok' => false, 'error' => 'Base de données injoignable.'], 500);
    }
    $user = optional_user($pdo);
    if ($user === null || !is_admin($user)) {
        json_out(['ok' => true]);
    }
    json_out([
        'ok'   => true,
        'db'   => db_driver($pdo),
        'mail' => mail_mode(),
        // Adresse d'expédition effective : elle doit être un expéditeur
        // VALIDÉ chez Brevo (Senders & Domains), sinon les envois échouent.
        'mailFrom' => mail_from(),
        // Dernière erreur d'envoi (réponse du fournisseur), null si le
        // dernier envoi a réussi — évite d'aller fouiller les logs.
        'lastMailError' => mail_last_error(),
        // Diagnostic de déploiement : la page de démonstration de l'image de
        // base est-elle encore présente à la racine web ? (doit être false)
        'demo' => file_exists(dirname(__DIR__) . '/index.php'),
    ]);
}

/* ---- GET /api/config : configuration publique (sans base de données) -------- */
if ($path === '/api/config' && $method === 'GET') {
    json_out(['googleClientId' => google_client_id()]);
}

$pdo = db();

/* ---- Authentification & compte --------------------------------------------- */
if ($path === '/api/auth/request-code' && $method === 'POST') handle_auth_request_code($pdo);
if ($path === '/api/auth/verify'       && $method === 'POST') handle_auth_verify($pdo);
if ($path === '/api/auth/google'       && $method === 'POST') handle_auth_google($pdo);
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

/* ---- Questions du Défi (banque fusionnée, publique) ---------------------------- */
if ($path === '/api/questions' && $method === 'GET') handle_questions_get($pdo);

/* ---- Administration (ADMIN_EMAILS seulement) ----------------------------------- */
if ($path === '/api/admin/users' && $method === 'GET') handle_admin_users($pdo);
if ($path === '/api/admin/log'   && $method === 'GET') handle_admin_log_get($pdo);
if (preg_match('#^/api/admin/users/([0-9]+)$#', $path, $m) && $method === 'DELETE') {
    handle_admin_user_delete($pdo, (int) $m[1]);
}
if ($path === '/api/admin/questions' && $method === 'POST') handle_admin_question_save($pdo);
if (preg_match('#^/api/admin/questions/([A-Za-z0-9-]{1,40})$#', $path, $m) && $method === 'DELETE') {
    handle_admin_question_delete($pdo, $m[1]);
}
if (preg_match('#^/api/admin/questions/([A-Za-z0-9-]{1,40})/restore$#', $path, $m) && $method === 'POST') {
    handle_admin_question_restore($pdo, $m[1]);
}

/* ---- Veillées en direct -------------------------------------------------------- */
if ($path === '/api/veillees' && $method === 'POST') handle_veillees_create($pdo);
if (preg_match('#^/api/veillees/([A-Za-z0-9]{4})/(state|join|answer|advance)$#', $path, $m)) {
    $code = strtoupper($m[1]);
    if ($m[2] === 'state'   && $method === 'GET')  handle_veillees_state($pdo, $code);
    if ($m[2] === 'join'    && $method === 'POST') handle_veillees_join($pdo, $code);
    if ($m[2] === 'answer'  && $method === 'POST') handle_veillees_answer($pdo, $code);
    if ($m[2] === 'advance' && $method === 'POST') handle_veillees_advance($pdo, $code);
}

json_error('Route inconnue.', 404);
