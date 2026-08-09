<?php
/* ============================================================================
   Authentification sans mot de passe (code à 6 chiffres par e-mail) + compte.

   - POST /api/auth/request-code : envoie un code (3 demandes/heure/e-mail).
   - POST /api/auth/verify       : vérifie le code (10 min, 5 essais max),
                                   crée le compte au premier passage (pseudo
                                   obligatoire), ouvre une session ~90 jours.
   - GET  /api/me                : utilisateur connecté.
   - POST /api/me/pseudo         : changer de pseudo.
   - POST /api/auth/logout       : invalide le token.
   - DELETE /api/me              : efface TOUT (compte, synchro, amis, duels).
   ========================================================================== */

defined('GRAINE_API') || exit;

const CODE_VALIDITY_SECONDS   = 600;          // 10 minutes
const CODE_MAX_ATTEMPTS       = 5;
const CODE_MAX_PER_HOUR       = 3;
const SESSION_LIFETIME_SECONDS = 90 * 86400;  // ~90 jours

/** Valide et normalise l'e-mail du corps de requête, ou répond 400. */
function auth_read_email(array $body): string {
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    if ($email === '' || strlen($email) > 255 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        json_error('Adresse e-mail invalide.', 400);
    }
    return $email;
}

/* ---- POST /api/auth/request-code ---------------------------------------- */

function handle_auth_request_code(PDO $pdo): never {
    $email = auth_read_email(read_json_body());

    // Ménage : les codes de plus de 2 h ne servent plus à rien
    // (ni à se connecter, ni à compter dans la limite horaire).
    $st = $pdo->prepare('DELETE FROM login_codes WHERE created_at < ?');
    $st->execute([now_sql_plus(-7200)]);

    // Limite : 3 demandes par heure et par e-mail.
    $st = $pdo->prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?');
    $st->execute([$email, now_sql_plus(-3600)]);
    if ((int) $st->fetch()['n'] >= CODE_MAX_PER_HOUR) {
        json_error('Trop de demandes de code — réessaie dans une heure.', 429);
    }

    $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    $st = $pdo->prepare(
        'INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at)
         VALUES (?, ?, ?, 0, ?)'
    );
    $st->execute([$email, password_hash($code, PASSWORD_DEFAULT), now_sql_plus(CODE_VALIDITY_SECONDS), now_sql()]);

    if (mail_mode() === 'dev') {
        // Aucun envoi d'e-mail configuré : mode développement uniquement.
        json_out(['ok' => true, 'devCode' => $code]);
    }
    if (!mail_send_code($email, $code)) {
        json_error("L'envoi de l'e-mail a échoué — réessaie dans un instant.", 502);
    }
    json_out(['ok' => true]);
}

/* ---- POST /api/auth/verify ----------------------------------------------- */

function handle_auth_verify(PDO $pdo): never {
    $body = read_json_body();
    $email = auth_read_email($body);
    $code = trim((string) ($body['code'] ?? ''));
    if (!preg_match('/^[0-9]{6}$/', $code)) {
        json_error('Le code doit comporter 6 chiffres.', 400);
    }

    // Dernier code encore valable pour cet e-mail.
    $st = $pdo->prepare(
        'SELECT * FROM login_codes WHERE email = ? AND expires_at > ? ORDER BY id DESC LIMIT 1'
    );
    $st->execute([$email, now_sql()]);
    $row = $st->fetch();
    if ($row === false) {
        json_error('Code expiré ou jamais demandé — demande un nouveau code.', 400);
    }
    if ((int) $row['attempts'] >= CODE_MAX_ATTEMPTS) {
        json_error("Trop d'essais — demande un nouveau code.", 429);
    }

    // On compte l'essai AVANT de vérifier, pour que la limite tienne toujours.
    $st = $pdo->prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?');
    $st->execute([$row['id']]);

    if (!password_verify($code, $row['code_hash'])) {
        json_error('Code incorrect.', 401);
    }

    // Code bon. L'utilisateur existe-t-il déjà ?
    $st = $pdo->prepare('SELECT * FROM users WHERE email = ?');
    $st->execute([$email]);
    $user = $st->fetch();

    if ($user === false) {
        // Première connexion : le pseudo est obligatoire pour créer le compte.
        // Important : le code n'est PAS consommé ici, pour que le client
        // puisse renvoyer le même code accompagné du pseudo.
        $pseudo = validate_pseudo($body['pseudo'] ?? null);
        if ($pseudo === null) {
            json_error(
                'Choisis un pseudo : 2 à 20 caractères (lettres, chiffres, espaces ou tirets).',
                422,
                ['needPseudo' => true]
            );
        }
        $st = $pdo->prepare(
            'INSERT INTO users (email, pseudo, friend_code, created_at, last_seen)
             VALUES (?, ?, ?, ?, ?)'
        );
        $st->execute([$email, $pseudo, generate_friend_code($pdo), now_sql(), now_sql()]);
        $st = $pdo->prepare('SELECT * FROM users WHERE email = ?');
        $st->execute([$email]);
        $user = $st->fetch();
    }

    // Connexion réussie : on consomme tous les codes de cet e-mail.
    $st = $pdo->prepare('DELETE FROM login_codes WHERE email = ?');
    $st->execute([$email]);

    $token = bin2hex(random_bytes(32));
    $st = $pdo->prepare(
        'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    );
    $st->execute([$token, $user['id'], now_sql(), now_sql_plus(SESSION_LIFETIME_SECONDS)]);

    json_out(['token' => $token, 'user' => user_payload($user)]);
}

/* ---- GET /api/me ---------------------------------------------------------- */

function handle_me_get(PDO $pdo): never {
    $user = require_user($pdo);
    json_out(['user' => user_payload($user)]);
}

/* ---- POST /api/me/pseudo -------------------------------------------------- */

function handle_me_pseudo(PDO $pdo): never {
    $user = require_user($pdo);
    $pseudo = validate_pseudo(read_json_body()['pseudo'] ?? null);
    if ($pseudo === null) {
        json_error('Pseudo invalide : 2 à 20 caractères (lettres, chiffres, espaces ou tirets).', 422);
    }
    $st = $pdo->prepare('UPDATE users SET pseudo = ? WHERE id = ?');
    $st->execute([$pseudo, $user['id']]);
    $user['pseudo'] = $pseudo;
    json_out(['user' => user_payload($user)]);
}

/* ---- POST /api/auth/logout ------------------------------------------------ */

function handle_auth_logout(PDO $pdo): never {
    require_user($pdo); // 401 si le token n'est pas (ou plus) valable
    $st = $pdo->prepare('DELETE FROM sessions WHERE token = ?');
    $st->execute([bearer_token()]);
    json_out(['ok' => true]);
}

/* ---- DELETE /api/me — suppression totale du compte ------------------------ */

function handle_me_delete(PDO $pdo): never {
    $user = require_user($pdo);
    $id = $user['id'];

    $pdo->beginTransaction();
    try {
        $st = $pdo->prepare('DELETE FROM sync_blobs WHERE user_id = ?');
        $st->execute([$id]);
        $st = $pdo->prepare('DELETE FROM friendships WHERE user_a = ? OR user_b = ?');
        $st->execute([$id, $id]);
        $st = $pdo->prepare('DELETE FROM duels WHERE challenger_id = ? OR opponent_id = ?');
        $st->execute([$id, $id]);
        $st = $pdo->prepare('DELETE FROM sessions WHERE user_id = ?');
        $st->execute([$id]);
        $st = $pdo->prepare('DELETE FROM login_codes WHERE email = ?');
        $st->execute([$user['email']]);
        $st = $pdo->prepare('DELETE FROM users WHERE id = ?');
        $st->execute([$id]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    json_out(['ok' => true]);
}
