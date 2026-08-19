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
    // Session glissante : chaque utilisation active repousse l'expiration de
    // SESSION_LIFETIME_SECONDS (voir auth.php) — un compte utilisé au moins
    // une fois par période ne se déconnecte donc jamais tout seul ; seule une
    // longue absence, ou une déconnexion explicite, met fin à la session.
    $ext = $pdo->prepare('UPDATE sessions SET expires_at = ? WHERE token = ?');
    $ext->execute([now_sql_plus(SESSION_LIFETIME_SECONDS), $token]);
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
 * La version EN LIGNE, en clair.
 *
 * Publier ne suffit pas : il faut que le déploiement aboutisse, et rien dans
 * l'appli ne le disait. On a passé une nuit à chercher dans l'écran
 * d'administration une section qui n'avait jamais quitté GitHub. Railway pose
 * RAILWAY_GIT_COMMIT_SHA dans l'environnement du conteneur : c'est la vérité
 * de ce qui tourne, à l'empreinte près. Absente (local, autre hébergeur), on
 * le dit plutôt que d'inventer.
 */
function version_en_ligne(): array {
    $sha = trim((string) getenv('RAILWAY_GIT_COMMIT_SHA'));
    $msg = trim((string) getenv('RAILWAY_GIT_COMMIT_MESSAGE'));
    return [
        'commit'  => $sha === '' ? null : substr($sha, 0, 7),
        'message' => $msg === '' ? null : mb_substr(preg_split('/\r?\n/', $msg)[0], 0, 120),
    ];
}

/**
 * Nombre de relais (proxies) de CONFIANCE placés devant l'application.
 * Réglable par la variable d'environnement PROXY_HOPS — corriger le nombre en
 * production ne demande donc aucun redéploiement du code. Défaut : 1 (Railway
 * place un relais devant le conteneur). 0 = aucun relais (auto-hébergement) :
 * X-Forwarded-For, entièrement fourni par le client, est alors IGNORÉ.
 * Toute valeur qui n'est pas un entier positif ou nul retombe sur 1.
 */
function proxy_hops(): int {
    $brut = trim((string) getenv('PROXY_HOPS'));
    return ctype_digit($brut) ? (int) $brut : 1;
}

/**
 * Ramène une adresse à sa forme canonique avant tout jugement.
 * `::ffff:1.2.3.4` désigne exactement 1.2.3.4 — c'est ce qu'écrit un écouteur
 * double-pile. PHP, lui, juge TOUT `::ffff:0:0/96` réservé, quelle que soit
 * l'IPv4 derrière : sans cette remise à plat, l'adresse d'un visiteur bien réel
 * passerait pour celle d'un relais interne.
 */
function ip_normaliser(string $ip): string {
    if (preg_match('/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i', $ip, $m)
        && filter_var($m[1], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
        return $m[1];
    }
    return $ip;
}

/**
 * Cette adresse est-elle celle d'un RELAIS plutôt que d'un visiteur ?
 * Privée (10/8, 172.16/12, 192.168/16, fd00::/7…), réservée (127/8, ::1,
 * fe80::/10…), ou dans l'espace partagé 100.64.0.0/10 — que PHP juge public
 * alors qu'il sert précisément aux répartiteurs de charge des hébergeurs et
 * aux opérateurs : personne n'y est joignable depuis l'extérieur.
 * $ip doit déjà être une adresse valide et normalisée.
 */
function ip_interne(string $ip): bool {
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
        return true;
    }
    $v4 = ip2long($ip);
    // 100.64.0.0/10 : masque /10 = 0xFFC00000.
    return $v4 !== false && ($v4 & 0xFFC00000) === (ip2long('100.64.0.0') & 0xFFC00000);
}

/**
 * Adresse IP du client. Derrière le proxy de Railway, REMOTE_ADDR est celle
 * du proxy : la véritable adresse se lit dans X-Forwarded-For.
 *
 * ATTENTION au sens de lecture. L'en-tête s'écrit « client, relais1, relais2 » :
 * chaque relais AJOUTE À DROITE l'adresse dont il a reçu la connexion. Le début
 * de la chaîne vient donc du client et se forge en une ligne de commande ; seules
 * les dernières valeurs, écrites par NOS relais, sont dignes de foi. On lit la
 * proxy_hops()-ième valeur EN PARTANT DE LA DROITE : celle qu'a inscrite le
 * relais le plus extérieur, c'est-à-dire l'adresse réelle du visiteur.
 *
 * Sert uniquement aux plafonds anti-abus — jamais à l'authentification.
 */
function client_ip(): string {
    $remote = substr((string) ($_SERVER['REMOTE_ADDR'] ?? 'inconnue'), 0, 45);

    // Aucun relais devant nous : l'en-tête n'est qu'une affirmation du client.
    $hops = proxy_hops();
    if ($hops < 1) {
        return $remote;
    }

    $xff = (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
    if (trim($xff) === '') {
        return $remote;
    }

    // RISQUE À CONNAÎTRE : si PROXY_HOPS est plus GRAND que le nombre réel de
    // relais, l'indice remonte dans la partie écrite par le client (au mieux un
    // repli, au pire une valeur forgée) ; s'il est plus grand encore, ou si le
    // client n'envoie rien, on retombe sur REMOTE_ADDR — l'adresse du relais,
    // la MÊME pour tout le monde : un seul compteur pour tous les visiteurs, et
    // de vraies personnes bloquées par le plafond d'autrui. Le bloc « reseau »
    // du GET /api/health admin montre l'en-tête reçu, REMOTE_ADDR, PROXY_HOPS
    // et l'IP retenue : c'est là qu'on vérifie le nombre, sans toucher au code.
    $chaine = array_map('trim', explode(',', $xff));
    $index = count($chaine) - $hops;
    if ($index < 0) {
        // Moins de valeurs que de relais annoncés : en-tête inexploitable.
        return $remote;
    }

    // Un relais de plus que prévu ? Les relais INTERNES (bordure Railway,
    // répartiteur, réseau Docker) portent des adresses privées ou réservées :
    // elles ne désignent personne, et retenir l'une d'elles ferait partager UN
    // SEUL compteur à tous les visiteurs — 10 épreuves créées par heure pour la
    // France entière, des veillées coupées. On continue donc vers la GAUCHE
    // tant qu'on tombe sur une adresse privée, et on ne s'arrête que sur une
    // adresse publique : la seule qui identifie vraiment un visiteur.
    // Cette marche ne rouvre pas la faille TANT QUE le relais le plus à
    // l'extérieur inscrit bien l'adresse PUBLIQUE du visiteur : on s'arrête sur
    // elle avant d'atteindre la partie forgeable, et la marche ne fait que
    // rattraper un PROXY_HOPS trop petit. Devant une installation où aucun de
    // nos relais n'écrirait d'adresse publique, la chaîne ne dit rien de fiable
    // et il faut alors régler PROXY_HOPS=0 : l'en-tête est ignoré, les plafonds
    // comptent sur REMOTE_ADDR. Le bloc « reseau » du health admin le montre.
    for (; $index >= 0; $index--) {
        $ip = ip_normaliser($chaine[$index]);
        // Une entrée qui n'est pas une IP (« unknown », en-tête tronqué,
        // obfuscation d'un relais…) ne doit JAMAIS servir de clé de plafond —
        // et on ne devine pas ce qu'il y a derrière : on s'arrête net.
        if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
            return $remote;
        }
        if (!ip_interne($ip)) {
            return substr($ip, 0, 45);
        }
    }
    // Que des adresses privées : personne d'identifiable dans cette chaîne.
    return $remote;
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

/**
 * Journal serveur (onglet « Activité » de l'administration) : trace un
 * événement du parcours de connexion — code_demande, code_envoye,
 * code_echec_envoi, code_verifie_ok, code_incorrect, compte_cree,
 * connexion_google, compte_supprime.
 *
 * L'e-mail est stocké EN CLAIR (l'admin voit déjà les adresses des comptes ;
 * c'est ce qui permet d'aider quelqu'un de bloqué), mais chaque écriture
 * purge les entrées de plus de 30 jours — le journal ne s'accumule jamais.
 *
 * Tout est enveloppé de try/catch : un journal qui tousse ne doit JAMAIS
 * casser le flux principal (connexion, envoi de code…).
 */
function journal_log(PDO $pdo, string $event, ?string $email = null, ?string $detail = null): void {
    try {
        $pdo->prepare('DELETE FROM journal WHERE ts < ?')->execute([now_sql_plus(-30 * 86400)]);
        $st = $pdo->prepare('INSERT INTO journal (ts, event, email, detail) VALUES (?, ?, ?, ?)');
        $st->execute([
            now_sql(),
            mb_substr($event, 0, 40),
            $email === null ? null : mb_substr($email, 0, 255),
            $detail === null ? null : mb_substr($detail, 0, 200),
        ]);
    } catch (Throwable $e) {
        error_log('Journal : écriture impossible — ' . $e->getMessage());
    }
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
 * espaces, tirets et apostrophes, avec au moins une lettre ou un chiffre.
 * Les apostrophes — droite et typographique, comme pour les noms de groupe —
 * sont admises : sans elles, N'Golo, M'Barka ou D'Amico ne pourraient pas
 * rejoindre une veillée.
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
    if (!preg_match("/^[\p{L}\p{N} '’\-]+\$/u", $pseudo) || !preg_match('/[\p{L}\p{N}]/u', $pseudo)) {
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

/**
 * Valide un nom de groupe : 2 à 40 caractères, mêmes règles qu'un pseudo
 * (lettres avec accents, chiffres, espaces, tirets) plus les apostrophes —
 * droite (') et typographique (’) — pour « L'Église d'Éphèse ».
 * Retourne le nom nettoyé, ou null s'il est invalide.
 */
function validate_group_name(mixed $nom): ?string {
    if (!is_string($nom)) {
        return null;
    }
    $nom = trim($nom);
    $length = mb_strlen($nom);
    if ($length < 2 || $length > 40) {
        return null;
    }
    if (!preg_match("/^[\p{L}\p{N} '’\-]+\$/u", $nom) || !preg_match('/[\p{L}\p{N}]/u', $nom)) {
        return null;
    }
    return $nom;
}

/** Valide un code de groupe "GRP-XXXXX" (normalisé en majuscules), ou null. */
function normalize_group_code(mixed $code): ?string {
    if (!is_string($code)) {
        return null;
    }
    $code = strtoupper(trim($code));
    if (!preg_match('/^GRP-[A-Z0-9]{5}$/', $code)) {
        return null;
    }
    return $code;
}

/**
 * Génère un code de groupe unique "GRP-XXXXX" (même alphabet sans ambiguïté
 * que les codes amis, mais 5 caractères : un code de groupe ouvre la porte à
 * toute une assemblée — l'espace élargi résiste mieux à l'énumération).
 */
function generate_group_code(PDO $pdo): string {
    $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    $max = strlen($alphabet) - 1;
    for ($try = 0; $try < 50; $try++) {
        $code = 'GRP-';
        for ($i = 0; $i < 5; $i++) {
            $code .= $alphabet[random_int(0, $max)];
        }
        $st = $pdo->prepare('SELECT 1 FROM groupes WHERE code = ?');
        $st->execute([$code]);
        if ($st->fetch() === false) {
            return $code;
        }
    }
    throw new RuntimeException('Impossible de générer un code de groupe unique.');
}

/**
 * État de la configuration : pour chaque variable d'environnement attendue,
 * dit UNIQUEMENT si elle est définie — jamais sa valeur. Affiché dans
 * l'onglet Système de l'administration, pour savoir d'un coup d'œil ce qui
 * est actif en production sans ouvrir le tableau de bord de l'hébergeur.
 */
function config_checklist(): array {
    $definie = fn (string $nom): bool => (string) getenv($nom) !== '';
    $lignes = [
        ['variable' => 'MYSQL_URL',        'libelle' => 'Base de données MySQL',    'definie' => $definie('MYSQL_URL')],
        ['variable' => 'BREVO_API_KEY',    'libelle' => "Envoi d'e-mails (Brevo)",  'definie' => $definie('BREVO_API_KEY')],
        ['variable' => 'MAIL_FROM',        'libelle' => "Adresse d'expédition",     'definie' => $definie('MAIL_FROM')],
        ['variable' => 'GOOGLE_CLIENT_ID', 'libelle' => 'Connexion Google',         'definie' => $definie('GOOGLE_CLIENT_ID')],
        ['variable' => 'ADMIN_EMAILS',     'libelle' => 'Administrateurs',          'definie' => $definie('ADMIN_EMAILS')],
        // Facultative : sans elle, client_ip() compte 1 relais devant l'appli,
        // ce qui est le cas de Railway. On l'affiche quand même pour qu'on
        // sache qu'elle existe et qu'on puisse la corriger sans lire le code.
        ['variable' => 'PROXY_HOPS',       'libelle' => 'Relais de confiance',      'definie' => $definie('PROXY_HOPS')],
    ];
    // La voie SMTP est une ALTERNATIVE à Brevo : on ne l'affiche que si elle
    // est entamée (SMTP_HOST posée), pour ne pas semer des « manquante ✗ »
    // alarmants sur une voie volontairement inutilisée.
    if ($definie('SMTP_HOST')) {
        $lignes[] = ['variable' => 'SMTP_HOST', 'libelle' => 'Serveur SMTP',          'definie' => true];
        $lignes[] = ['variable' => 'SMTP_USER', 'libelle' => 'Identifiant SMTP',      'definie' => $definie('SMTP_USER')];
        $lignes[] = ['variable' => 'SMTP_PASS', 'libelle' => 'Mot de passe SMTP',     'definie' => $definie('SMTP_PASS')];
    }
    return $lignes;
}
