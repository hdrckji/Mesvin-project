<?php
/* ============================================================================
   Petites fonctions partagées : réponses JSON, lecture du corps de requête,
   dates, authentification par token, validations.
   ========================================================================== */

defined('GRAINE_API') || exit;

/** Envoie une réponse JSON et termine la requête. */
function json_out(array $data, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** Envoie une erreur JSON `{ "error": "…" }` et termine la requête. */
function json_error(string $message, int $status, array $extra = []): never {
    json_out(array_merge(['error' => $message], $extra), $status);
}

/** Lit et décode le corps JSON de la requête (objet attendu). */
function read_json_body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        json_error('Corps de requête JSON invalide.', 400);
    }
    return $data;
}

/** Date-heure courante en UTC, au format SQL ("YYYY-MM-DD HH:MM:SS"). */
function now_sql(): string {
    return gmdate('Y-m-d H:i:s');
}

/** Date-heure UTC décalée de $seconds secondes, au format SQL. */
function now_sql_plus(int $seconds): string {
    return gmdate('Y-m-d H:i:s', time() + $seconds);
}

/** Convertit une date SQL (UTC) en ISO 8601 ("YYYY-MM-DDTHH:MM:SSZ"). */
function sql_to_iso(?string $sqlDate): ?string {
    if ($sqlDate === null || $sqlDate === '') {
        return null;
    }
    return str_replace(' ', 'T', $sqlDate) . 'Z';
}

/** Extrait le token de l'en-tête "Authorization: Bearer …" (ou null). */
function bearer_token(): ?string {
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if ($header === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp($name, 'Authorization') === 0) {
                $header = $value;
                break;
            }
        }
    }
    if (preg_match('/^Bearer\s+([a-f0-9]{64})$/i', trim($header), $m)) {
        return strtolower($m[1]);
    }
    return null;
}

/**
 * Exige une session valide et retourne l'utilisateur connecté (ligne `users`).
 * Répond 401 si le token est absent, inconnu ou expiré.
 */
function require_user(PDO $pdo): array {
    $token = bearer_token();
    if ($token === null) {
        json_error('Connexion requise.', 401);
    }
    $st = $pdo->prepare(
        'SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?'
    );
    $st->execute([$token, now_sql()]);
    $user = $st->fetch();
    if ($user === false) {
        json_error('Session expirée — reconnecte-toi.', 401);
    }
    $up = $pdo->prepare('UPDATE users SET last_seen = ? WHERE id = ?');
    $up->execute([now_sql(), $user['id']]);
    return $user;
}

/**
 * Vrai si l'e-mail de l'utilisateur figure dans la variable d'environnement
 * ADMIN_EMAILS (liste séparée par des virgules, insensible à la casse).
 * Aucune colonne en base : le rôle se donne et se retire en changeant la
 * variable, sans migration ni redéploiement de données.
 */
function is_admin(array $user): bool {
    $env = getenv('ADMIN_EMAILS');
    if ($env === false || trim($env) === '') {
        return false;
    }
    $admins = array_filter(array_map(
        fn (string $e): string => strtolower(trim($e)),
        explode(',', $env)
    ));
    return in_array(strtolower((string) ($user['email'] ?? '')), $admins, true);
}

/**
 * L'utilisateur connecté si un token valable est présent, sinon null —
 * contrairement à require_user, ne répond jamais 401 (routes publiques qui
 * en disent simplement plus aux personnes identifiées, ex. /api/health).
 */
function optional_user(PDO $pdo): ?array {
    $token = bearer_token();
    if ($token === null) {
        return null;
    }
    $st = $pdo->prepare(
        'SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?'
    );
    $st->execute([$token, now_sql()]);
    $user = $st->fetch();
    return $user === false ? null : $user;
}

/**
 * Adresse IP du client. Derrière le proxy de Railway, REMOTE_ADDR est celle
 * du proxy : on lit d'abord X-Forwarded-For (première adresse de la chaîne).
 * Sert uniquement aux plafonds anti-abus — jamais à l'authentification.
 */
function client_ip(): string {
    $xff = (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
    if ($xff !== '') {
        $first = trim(explode(',', $xff)[0]);
        if ($first !== '') {
            return substr($first, 0, 45);
        }
    }
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? 'inconnue'), 0, 45);
}

/**
 * Plafond horaire par IP : au-delà de $maxPerHour appels pour ce $scope
 * dans l'heure en cours → 429. Compteurs en base (table throttle), balayés
 * au passage quand ils ont plus de deux heures.
 */
function throttle_or_429(PDO $pdo, string $scope, int $maxPerHour): void {
    $pdo->prepare('DELETE FROM throttle WHERE created_at < ?')->execute([now_sql_plus(-7200)]);

    $bucket = $scope . '|' . client_ip() . '|' . gmdate('YmdH');
    $st = $pdo->prepare('SELECT n FROM throttle WHERE bucket = ?');
    $st->execute([$bucket]);
    $row = $st->fetch();
    if ($row === false) {
        $pdo->prepare('INSERT INTO throttle (bucket, n, created_at) VALUES (?, 1, ?)')
            ->execute([$bucket, now_sql()]);
        return;
    }
    if ((int) $row['n'] >= $maxPerHour) {
        json_error('Trop de demandes depuis ce réseau — réessaie dans une heure.', 429);
    }
    $pdo->prepare('UPDATE throttle SET n = n + 1 WHERE bucket = ?')->execute([$bucket]);
}

/** Trace une action d'administration (journal consultable via /api/admin/log). */
function admin_log(PDO $pdo, array $admin, string $action, string $cible): void {
    $st = $pdo->prepare(
        'INSERT INTO admin_log (admin_id, admin_email, action, cible, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    $st->execute([(int) $admin['id'], $admin['email'], $action, mb_substr($cible, 0, 190), now_sql()]);
}

/** Représentation publique d'un utilisateur (jamais l'id interne). */
function user_payload(array $user): array {
    return [
        'pseudo'     => $user['pseudo'],
        'email'      => $user['email'],
        'friendCode' => $user['friend_code'],
        // Le client le range dans sa session locale pour afficher (ou non)
        // l'entrée « Administration » — le serveur revérifie à chaque route.
        'isAdmin'    => is_admin($user),
    ];
}

/**
 * Valide un pseudo : 2 à 20 caractères, lettres (accents inclus), chiffres,
 * espaces et tirets, avec au moins une lettre ou un chiffre.
 * Retourne le pseudo nettoyé, ou null s'il est invalide.
 */
function validate_pseudo(mixed $pseudo): ?string {
    if (!is_string($pseudo)) {
        return null;
    }
    $pseudo = trim($pseudo);
    $length = mb_strlen($pseudo);
    if ($length < 2 || $length > 20) {
        return null;
    }
    if (!preg_match('/^[\p{L}\p{N} \-]+$/u', $pseudo) || !preg_match('/[\p{L}\p{N}]/u', $pseudo)) {
        return null;
    }
    return $pseudo;
}

/** Valide un code ami "GRN-XXXX" (normalisé en majuscules), ou null. */
function normalize_friend_code(mixed $code): ?string {
    if (!is_string($code)) {
        return null;
    }
    $code = strtoupper(trim($code));
    if (!preg_match('/^GRN-[A-Z0-9]{4}$/', $code)) {
        return null;
    }
    return $code;
}

/** Génère un code ami unique "GRN-XXXX" (sans caractères ambigus I/L/O/0/1). */
function generate_friend_code(PDO $pdo): string {
    $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    $max = strlen($alphabet) - 1;
    for ($try = 0; $try < 50; $try++) {
        $code = 'GRN-';
        for ($i = 0; $i < 4; $i++) {
            $code .= $alphabet[random_int(0, $max)];
        }
        $st = $pdo->prepare('SELECT 1 FROM users WHERE friend_code = ?');
        $st->execute([$code]);
        if ($st->fetch() === false) {
            return $code;
        }
    }
    throw new RuntimeException('Impossible de générer un code ami unique.');
}
