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
require __DIR__ . '/groupes.php';
require __DIR__ . '/groupes-demandes.php';
require __DIR__ . '/groupes-quiz.php';
require __DIR__ . '/segond.php';
require __DIR__ . '/groupes-banques.php';
require __DIR__ . '/groupes-propositions.php';
require __DIR__ . '/groupes-page.php';
require __DIR__ . '/duels.php';
require __DIR__ . '/veillees.php';
require __DIR__ . '/frise.php';
require __DIR__ . '/epreuve.php';
require __DIR__ . '/portrait.php';
require __DIR__ . '/admin.php';
require __DIR__ . '/banques.php';
require __DIR__ . '/visites.php';
require __DIR__ . '/push.php';

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
    // Notifications push : la clé du cron est générée ici au premier regard
    // d'un admin (avec les clés VAPID), et l'URL à copier dans le service de
    // cron est servie toute prête — voir api/README.md, section cron.
    $pushCfg = push_config($pdo, true);
    $host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
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
        // Configuration : chaque variable attendue, définie ou non — la
        // valeur elle-même ne quitte JAMAIS le serveur.
        'config' => config_checklist(),
        'push' => [
            'abonnements' => (int) $pdo->query('SELECT COUNT(*) FROM push_abonnements')->fetchColumn(),
            'cronKey'     => $pushCfg === null ? null : $pushCfg['cron_key'],
            'cronUrl'     => $pushCfg === null ? null
                : 'https://' . $host . '/api/cron/notify?key=' . $pushCfg['cron_key'],
        ],
    ]);
}

/* ---- GET /api/config : configuration publique -------------------------------- */
if ($path === '/api/config' && $method === 'GET') {
    // vapidPublicKey : null tant que personne n'a activé les notifications
    // (la clé naît à la première activation, via GET /api/push/cle). La config
    // reste utile même en panne de base : la clé retombe alors sur null.
    $vapidPublicKey = null;
    try {
        $vapidPublicKey = push_public_key(db());
    } catch (Throwable $e) {
        // Base indisponible : le reste de la configuration se sert quand même.
    }
    json_out(['googleClientId' => google_client_id(), 'vapidPublicKey' => $vapidPublicKey]);
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

/* ---- Groupes d'église ------------------------------------------------------------
   La création directe est fermée (403) : elle passe par une demande, que seule
   l'administration accepte ou refuse (groupes-demandes.php). AVANT le motif
   /api/groupes/{code} : « demande » n'est pas un code de groupe. */
if ($path === '/api/groupes' && $method === 'POST') handle_groupes_create($pdo);
if ($path === '/api/groupes' && $method === 'GET')  handle_groupes_list($pdo);
if ($path === '/api/groupes/demande') {
    if ($method === 'POST')   handle_groupe_demande_create($pdo);
    if ($method === 'GET')    handle_groupe_demande_get($pdo);
    if ($method === 'DELETE') handle_groupe_demande_delete($pdo);
}
if ($path === '/api/groupes/rejoindre' && $method === 'POST') handle_groupes_join($pdo);
if (preg_match('#^/api/groupes/([^/]+)/verset$#', $path, $m) && $method === 'POST') {
    handle_groupes_verset($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/membres/moi$#', $path, $m) && $method === 'DELETE') {
    handle_groupes_leave($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/passation$#', $path, $m) && $method === 'POST') {
    handle_groupes_passation($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/identite$#', $path, $m) && $method === 'POST') {
    handle_groupes_identite($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/coresponsables$#', $path, $m) && $method === 'POST') {
    handle_groupes_coresp_add($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/coresponsables/(.+)$#', $path, $m) && $method === 'DELETE') {
    handle_groupes_coresp_remove($pdo, $m[1], urldecode($m[2]));
}

/* ---- Ce que l'église propose : packs de versets, chemins de lecture ------------- */
if (preg_match('#^/api/groupes/([^/]+)/propositions$#', $path, $m)) {
    if ($method === 'GET')  handle_groupe_propositions_get($pdo, $m[1]);
    if ($method === 'POST') handle_groupe_proposition_save($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/propositions/([0-9]+)$#', $path, $m) && $method === 'DELETE') {
    handle_groupe_proposition_delete($pdo, $m[1], (int) $m[2]);
}

/* ---- La page de l'église : annonces, rendez-vous, services (groupes-page.php) --- */
if (preg_match('#^/api/groupes/([^/]+)/page$#', $path, $m) && $method === 'GET') {
    handle_groupe_page($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/annonces$#', $path, $m) && $method === 'POST') {
    handle_groupe_annonce_save($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/annonces/([0-9]+)$#', $path, $m) && $method === 'DELETE') {
    handle_groupe_annonce_delete($pdo, $m[1], (int) $m[2]);
}
if (preg_match('#^/api/groupes/([^/]+)/rdv$#', $path, $m) && $method === 'POST') {
    handle_groupe_rdv_save($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/rdv/([0-9]+)$#', $path, $m) && $method === 'DELETE') {
    handle_groupe_rdv_delete($pdo, $m[1], (int) $m[2]);
}
if (preg_match('#^/api/groupes/([^/]+)/services$#', $path, $m) && $method === 'POST') {
    handle_groupe_service_save($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/services/([0-9]+)$#', $path, $m) && $method === 'DELETE') {
    handle_groupe_service_delete($pdo, $m[1], (int) $m[2]);
}
if (preg_match('#^/api/groupes/([^/]+)/services/([0-9]+)/inscription$#', $path, $m)) {
    if ($method === 'POST')   handle_groupe_service_inscription($pdo, $m[1], (int) $m[2]);
    if ($method === 'DELETE') handle_groupe_service_desinscription($pdo, $m[1], (int) $m[2]);
}

if (preg_match('#^/api/groupes/([^/]+)$#', $path, $m)) {
    if ($method === 'GET')    handle_groupes_detail($pdo, $m[1]);
    if ($method === 'DELETE') handle_groupes_delete($pdo, $m[1]);
}

/* ---- Quiz d'église : la banque par groupe (voir groupes-quiz.php) --------------- */
if (preg_match('#^/api/groupes/([^/]+)/quiz$#', $path, $m) && $method === 'GET') {
    handle_groupe_quiz_get($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/quiz/mode$#', $path, $m) && $method === 'POST') {
    handle_groupe_quiz_mode($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/quiz/selection$#', $path, $m) && $method === 'PUT') {
    handle_groupe_quiz_selection($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/quiz/questions$#', $path, $m)) {
    if ($method === 'GET')  handle_groupe_quiz_questions_list($pdo, $m[1]);
    if ($method === 'POST') handle_groupe_quiz_question_save($pdo, $m[1]);
}
if (preg_match('#^/api/groupes/([^/]+)/quiz/questions/([A-Za-z0-9-]{1,60})$#', $path, $m) && $method === 'DELETE') {
    handle_groupe_quiz_question_delete($pdo, $m[1], $m[2]);
}

/* ---- Séries de questions d'une église : quiadit, ecritoupas, portrait
       (voir groupes-banques.php). Écriture et brouillons : responsable et
       co-responsables. Lecture des séries PUBLIÉES : tout membre — sans quoi
       il ne pourrait pas y jouer. --------------------------------------------- */
if (preg_match('#^/api/groupes/([^/]+)/series/([a-z]{1,20})$#', $path, $m) && $method === 'GET') {
    handle_groupe_series_list($pdo, $m[1], $m[2]);
}
if (preg_match('#^/api/groupes/([^/]+)/series/([a-z]{1,20})$#', $path, $m) && $method === 'POST') {
    handle_groupe_serie_creer($pdo, $m[1], $m[2]);
}
if (preg_match('#^/api/groupes/([^/]+)/series/([a-z]{1,20})/([0-9]{1,10})$#', $path, $m) && $method === 'POST') {
    handle_groupe_serie_maj($pdo, $m[1], $m[2], (int) $m[3]);
}
if (preg_match('#^/api/groupes/([^/]+)/series/([a-z]{1,20})/([0-9]{1,10})$#', $path, $m) && $method === 'DELETE') {
    handle_groupe_serie_supprimer($pdo, $m[1], $m[2], (int) $m[3]);
}
if (preg_match('#^/api/groupes/([^/]+)/series/([a-z]{1,20})/([0-9]{1,10})/items$#', $path, $m) && $method === 'POST') {
    handle_groupe_serie_item_save($pdo, $m[1], $m[2], (int) $m[3]);
}
if (preg_match('#^/api/groupes/([^/]+)/series/([a-z]{1,20})/([0-9]{1,10})/items/([A-Za-z0-9-]{1,60})$#', $path, $m) && $method === 'DELETE') {
    handle_groupe_serie_item_delete($pdo, $m[1], $m[2], (int) $m[3], $m[4]);
}
// Les items d'une série — c'est ce que chargent les pages d'épreuve pour jouer.
if (preg_match('#^/api/groupes/([^/]+)/series/([a-z]{1,20})/([0-9]{1,10})/items$#', $path, $m) && $method === 'GET') {
    handle_groupe_serie_jouer($pdo, $m[1], $m[2], (int) $m[3]);
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

/* ---- Banques des épreuves à fichier (fusionnées, publiques — banques.php) ------- */
if (preg_match('#^/api/banque/([a-z]{1,20})$#', $path, $m) && $method === 'GET') {
    handle_banque_get($pdo, $m[1]);
}

/* ---- Notifications — « le verset offert » (voir push.php) ----------------------- */
if ($path === '/api/push/cle'         && $method === 'GET')  handle_push_key($pdo);
if ($path === '/api/push/subscribe'   && $method === 'POST') handle_push_subscribe($pdo);
if ($path === '/api/push/unsubscribe' && $method === 'POST') handle_push_unsubscribe($pdo);
if ($path === '/api/cron/notify'      && $method === 'GET')  handle_cron_notify($pdo);

/* ---- Administration (ADMIN_EMAILS seulement) ----------------------------------- */
if ($path === '/api/admin/users'   && $method === 'GET') handle_admin_users($pdo);
if ($path === '/api/admin/log'     && $method === 'GET') handle_admin_log_get($pdo);
if ($path === '/api/admin/journal' && $method === 'GET') handle_admin_journal($pdo);
if ($path === '/api/admin/visites' && $method === 'GET') handle_admin_visites($pdo);
if ($path === '/api/admin/brevo'   && $method === 'GET') handle_admin_brevo($pdo);
if ($path === '/api/admin/eglises' && $method === 'GET') handle_admin_eglises($pdo);
if (preg_match('#^/api/admin/eglises/demandes/([0-9]+)/(accepter|refuser)$#', $path, $m) && $method === 'POST') {
    if ($m[2] === 'accepter') handle_admin_eglise_accepter($pdo, (int) $m[1]);
    handle_admin_eglise_refuser($pdo, (int) $m[1]);
}
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
if (preg_match('#^/api/admin/banque/([a-z]{1,20})$#', $path, $m) && $method === 'POST') {
    handle_admin_banque_save($pdo, $m[1]);
}
if (preg_match('#^/api/admin/banque/([a-z]{1,20})/([A-Za-z0-9-]{1,40})$#', $path, $m) && $method === 'DELETE') {
    handle_admin_banque_delete($pdo, $m[1], $m[2]);
}
if (preg_match('#^/api/admin/banque/([a-z]{1,20})/([A-Za-z0-9-]{1,40})/restore$#', $path, $m) && $method === 'POST') {
    handle_admin_banque_restore($pdo, $m[1], $m[2]);
}

/* ---- Veillées en direct -------------------------------------------------------- */
/* ---- Fréquentation : le signal anonyme (visites.php) ---- */
if ($path === '/api/visite' && $method === 'POST') handle_visite_post($pdo);

if ($path === '/api/veillees' && $method === 'POST') handle_veillees_create($pdo);
if (preg_match('#^/api/veillees/([A-Za-z0-9]{4})/(state|join|answer|advance)$#', $path, $m)) {
    $code = strtoupper($m[1]);
    if ($m[2] === 'state'   && $method === 'GET')  handle_veillees_state($pdo, $code);
    if ($m[2] === 'join'    && $method === 'POST') handle_veillees_join($pdo, $code);
    if ($m[2] === 'answer'  && $method === 'POST') handle_veillees_answer($pdo, $code);
    if ($m[2] === 'advance' && $method === 'POST') handle_veillees_advance($pdo, $code);
}

/* ---- La Frise (atelier d'essai) : défis et veillées par code, sans compte ---- */
if ($path === '/api/frise/duel' && $method === 'POST') frise_duel_create($pdo);
if (preg_match('#^/api/frise/duel/(FD-[A-Z2-9]{5})$#', $path, $m)) {
    if ($method === 'GET') frise_duel_get($pdo, $m[1]);
}
if (preg_match('#^/api/frise/duel/(FD-[A-Z2-9]{5})/score$#', $path, $m)) {
    if ($method === 'POST') frise_duel_score($pdo, $m[1]);
}
if ($path === '/api/frise/veillee' && $method === 'POST') frise_veillee_create($pdo);
if (preg_match('#^/api/frise/veillee/(FV-[A-Z2-9]{5})/rejoindre$#', $path, $m)) {
    if ($method === 'POST') frise_veillee_rejoindre($pdo, $m[1]);
}
if (preg_match('#^/api/frise/veillee/(FV-[A-Z2-9]{5})/avancer$#', $path, $m)) {
    if ($method === 'POST') frise_veillee_avancer($pdo, $m[1]);
}
if (preg_match('#^/api/frise/veillee/(FV-[A-Z2-9]{5})/reponse$#', $path, $m)) {
    if ($method === 'POST') frise_veillee_reponse($pdo, $m[1]);
}
if (preg_match('#^/api/frise/veillee/(FV-[A-Z2-9]{5})/etat$#', $path, $m)) {
    if ($method === 'GET') {
        frise_veillee_etat($pdo, $m[1],
            is_string($_GET['jeton'] ?? null) ? $_GET['jeton'] : null,
            is_string($_GET['cle'] ?? null) ? $_GET['cle'] : null);
    }
}

/* ---- Épreuves à choix : défis et veillées par code, sans compte ---- */
if ($path === '/api/epreuve/duel' && $method === 'POST') epreuve_duel_create($pdo);
if (preg_match('#^/api/epreuve/duel/(ED-[A-Z2-9]{5})$#', $path, $m)) {
    if ($method === 'GET') epreuve_duel_get($pdo, $m[1]);
}
if (preg_match('#^/api/epreuve/duel/(ED-[A-Z2-9]{5})/score$#', $path, $m)) {
    if ($method === 'POST') epreuve_duel_score($pdo, $m[1]);
}
if ($path === '/api/epreuve/veillee' && $method === 'POST') epreuve_veillee_create($pdo);
if (preg_match('#^/api/epreuve/veillee/(EV-[A-Z2-9]{5})/rejoindre$#', $path, $m)) {
    if ($method === 'POST') epreuve_veillee_rejoindre($pdo, $m[1]);
}
if (preg_match('#^/api/epreuve/veillee/(EV-[A-Z2-9]{5})/avancer$#', $path, $m)) {
    if ($method === 'POST') epreuve_veillee_avancer($pdo, $m[1]);
}
if (preg_match('#^/api/epreuve/veillee/(EV-[A-Z2-9]{5})/reponse$#', $path, $m)) {
    if ($method === 'POST') epreuve_veillee_reponse($pdo, $m[1]);
}
if (preg_match('#^/api/epreuve/veillee/(EV-[A-Z2-9]{5})/etat$#', $path, $m)) {
    if ($method === 'GET') {
        epreuve_veillee_etat($pdo, $m[1],
            is_string($_GET['jeton'] ?? null) ? $_GET['jeton'] : null,
            is_string($_GET['cle'] ?? null) ? $_GET['cle'] : null);
    }
}

/* ---- « De qui parle-t-on ? » : défis (PD-, table epreuve_duels) et veillées à indices ---- */
if ($path === '/api/portrait/duel' && $method === 'POST') portrait_duel_create($pdo);
if (preg_match('#^/api/portrait/duel/(PD-[A-Z2-9]{5})$#', $path, $m)) {
    if ($method === 'GET') epreuve_duel_get($pdo, $m[1]);
}
if (preg_match('#^/api/portrait/duel/(PD-[A-Z2-9]{5})/score$#', $path, $m)) {
    if ($method === 'POST') epreuve_duel_score($pdo, $m[1]);
}
if ($path === '/api/portrait/veillee' && $method === 'POST') portrait_veillee_create($pdo);
if (preg_match('#^/api/portrait/veillee/(PV-[A-Z2-9]{5})/rejoindre$#', $path, $m)) {
    if ($method === 'POST') portrait_veillee_rejoindre($pdo, $m[1]);
}
if (preg_match('#^/api/portrait/veillee/(PV-[A-Z2-9]{5})/avancer$#', $path, $m)) {
    if ($method === 'POST') portrait_veillee_avancer($pdo, $m[1]);
}
if (preg_match('#^/api/portrait/veillee/(PV-[A-Z2-9]{5})/reponse$#', $path, $m)) {
    if ($method === 'POST') portrait_veillee_reponse($pdo, $m[1]);
}
if (preg_match('#^/api/portrait/veillee/(PV-[A-Z2-9]{5})/etat$#', $path, $m)) {
    if ($method === 'GET') {
        portrait_veillee_etat($pdo, $m[1],
            is_string($_GET['jeton'] ?? null) ? $_GET['jeton'] : null,
            is_string($_GET['cle'] ?? null) ? $_GET['cle'] : null);
    }
}

json_error('Route inconnue.', 404);
