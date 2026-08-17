<?php
/* ============================================================================
   Authentification sans mot de passe (code à 6 chiffres par e-mail) + compte.

   - POST /api/auth/request-code : envoie un code (3 demandes/heure/e-mail).
   - POST /api/auth/verify       : vérifie le code (10 min, 5 essais max),
                                   crée le compte au premier passage (pseudo
                                   obligatoire), ouvre une session ~90 jours.
   - POST /api/auth/google       : connexion en un geste avec un compte Google
                                   (jeton d'identité vérifié côté serveur ;
                                   actif seulement si GOOGLE_CLIENT_ID est
                                   configurée). Même compte que par e-mail :
                                   c'est l'adresse qui fait foi.
   - GET  /api/config            : configuration publique (client ID Google).
   - GET  /api/me                : utilisateur connecté.
   - POST /api/me/pseudo         : changer de pseudo.
   - POST /api/auth/logout       : invalide le token.
   - DELETE /api/me              : efface TOUT (compte, synchro, amis, duels,
                                   adhésions aux groupes — avec passation).
   ========================================================================== */

defined('GRAINE_API') || exit;

const CODE_VALIDITY_SECONDS   = 2700;         // 45 minutes — les e-mails
// d'un domaine récent peuvent être différés (greylisting) : un code trop
// court expire avant d'arriver. 6 chiffres hachés + 5 essais + plafond IP
// suffisent à garder cette fenêtre sûre.
const CODE_MAX_ATTEMPTS       = 5;
const CODE_MAX_PER_HOUR       = 3;
const SESSION_LIFETIME_SECONDS = 90 * 86400;  // ~90 jours

/** Ouvre une session (~90 jours) pour cet utilisateur et retourne le token. */
function open_session(PDO $pdo, array $user): string {
    // Ménage opportuniste : les sessions expirées ne servent plus à rien.
    $pdo->prepare('DELETE FROM sessions WHERE expires_at < ?')->execute([now_sql()]);
    $token = bin2hex(random_bytes(32));
    $st = $pdo->prepare(
        'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    );
    $st->execute([$token, $user['id'], now_sql(), now_sql_plus(SESSION_LIFETIME_SECONDS)]);
    return $token;
}

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

    // Plafond PAR IP en plus de la limite par e-mail : sans lui, on pourrait
    // faire envoyer des codes à des centaines d'adresses différentes (spam
    // via notre expéditeur, réputation du domaine en jeu). 30/heure laisse
    // de la marge à un groupe entier derrière la même connexion.
    throttle_or_429($pdo, 'code', 30);

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
    $codeId = (int) $pdo->lastInsertId();

    // Journal : la demande est acceptée (quotas passés), AVANT l'envoi.
    journal_log($pdo, 'code_demande', $email);

    if (mail_mode() === 'dev') {
        // Aucun envoi d'e-mail configuré : mode développement uniquement.
        // Pas de « code_envoye » au journal : aucun e-mail n'est réellement
        // parti — l'événement ne trace que de vrais envois (Brevo/SMTP).
        json_out(['ok' => true, 'devCode' => $code]);
    }
    if (!mail_send_code($email, $code)) {
        // L'e-mail n'est pas parti : l'utilisateur n'a rien reçu, cette
        // tentative ne doit PAS consommer son quota horaire.
        $st = $pdo->prepare('DELETE FROM login_codes WHERE id = ?');
        $st->execute([$codeId]);
        // Raison courte : la trace mémorisée par mail.php (statut HTTP +
        // début de la réponse du fournisseur — jamais la clé API).
        journal_log($pdo, 'code_echec_envoi', $email,
            mail_last_error() ?? "l'e-mail n'est pas parti (voir les logs)");
        json_error("L'envoi de l'e-mail a échoué — réessaie dans un instant.", 502);
    }
    journal_log($pdo, 'code_envoye', $email);
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

    // TOUS les codes encore valables pour cet e-mail (du plus récent au plus
    // ancien). Pourquoi tous : quand l'e-mail tarde (greylisting), l'utilisateur
    // clique « Renvoyer un code » — si seul le dernier comptait, le code qui
    // finit par arriver serait refusé alors qu'il est parfaitement légitime.
    $st = $pdo->prepare(
        'SELECT * FROM login_codes WHERE email = ? AND expires_at > ? ORDER BY id DESC'
    );
    $st->execute([$email, now_sql()]);
    $rows = $st->fetchAll();
    if ($rows === []) {
        json_error('Code expiré ou jamais demandé — demande un nouveau code.', 400);
    }
    // La limite d'essais se compte sur le code le plus récent : un essai est
    // toujours enregistré AVANT la vérification, pour que la limite tienne.
    if ((int) $rows[0]['attempts'] >= CODE_MAX_ATTEMPTS) {
        json_error("Trop d'essais — demande un nouveau code.", 429);
    }
    $st = $pdo->prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?');
    $st->execute([$rows[0]['id']]);

    $bon = false;
    foreach ($rows as $row) {
        if (password_verify($code, $row['code_hash'])) { $bon = true; break; }
    }
    if (!$bon) {
        journal_log($pdo, 'code_incorrect', $email);
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
                'Choisis un pseudo : 2 à 20 caractères (lettres, chiffres, espaces, tirets ou apostrophes).',
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
        journal_log($pdo, 'compte_cree', $email, $pseudo);
    }

    // Connexion réussie : on consomme tous les codes de cet e-mail.
    $st = $pdo->prepare('DELETE FROM login_codes WHERE email = ?');
    $st->execute([$email]);

    journal_log($pdo, 'code_verifie_ok', $email);
    json_out(['token' => open_session($pdo, $user), 'user' => user_payload($user)]);
}

/* ---- Connexion Google ------------------------------------------------------ */

/** Client ID OAuth Google (variable d'environnement), ou null si absent. */
function google_client_id(): ?string {
    $id = getenv('GOOGLE_CLIENT_ID');
    if ($id === false) {
        return null;
    }
    $id = trim($id);
    return $id === '' ? null : $id;
}

/**
 * Vérifie un jeton d'identité Google auprès de Google (endpoint tokeninfo :
 * signature et expiration contrôlées par Google) puis revérifie ici
 * l'audience, l'émetteur et l'e-mail confirmé. Retourne le payload du jeton.
 */
function google_verify_credential(string $credential): array {
    $ch = curl_init('https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($credential));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
    ]);
    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    if ($response === false) {
        json_error('Google est injoignable pour le moment — réessaie dans un instant.', 502);
    }
    $info = json_decode((string) $response, true);
    if ($status !== 200 || !is_array($info)) {
        json_error('Connexion Google refusée — réessaie.', 401);
    }
    if (($info['aud'] ?? null) !== google_client_id()
        || !in_array((string) ($info['iss'] ?? ''), ['accounts.google.com', 'https://accounts.google.com'], true)
        || ($info['email_verified'] ?? '') !== 'true'
        || !filter_var((string) ($info['email'] ?? ''), FILTER_VALIDATE_EMAIL)) {
        json_error('Connexion Google refusée — réessaie.', 401);
    }
    return $info;
}

/**
 * Dérive un pseudo présentable depuis le profil Google (prénom, puis nom
 * complet), en le pliant aux règles de validate_pseudo. Null si rien ne passe.
 */
function google_derive_pseudo(array $info): ?string {
    foreach ([$info['given_name'] ?? null, $info['name'] ?? null] as $candidate) {
        if (!is_string($candidate)) {
            continue;
        }
        $clean = (string) preg_replace('/[^\p{L}\p{N} \-]+/u', ' ', $candidate);
        $clean = trim((string) preg_replace('/\s+/', ' ', $clean));
        $pseudo = validate_pseudo(mb_substr($clean, 0, 20));
        if ($pseudo !== null) {
            return $pseudo;
        }
    }
    return null;
}

/* ---- POST /api/auth/google ------------------------------------------------- */

function handle_auth_google(PDO $pdo): never {
    if (google_client_id() === null) {
        json_error("La connexion Google n'est pas configurée sur ce serveur.", 501);
    }
    $body = read_json_body();
    $credential = (string) ($body['credential'] ?? '');
    if ($credential === '' || strlen($credential) > 4096) {
        json_error('Jeton Google manquant ou invalide.', 400);
    }

    $info = google_verify_credential($credential);
    $email = strtolower((string) $info['email']);

    $st = $pdo->prepare('SELECT * FROM users WHERE email = ?');
    $st->execute([$email]);
    $user = $st->fetch();

    if ($user === false) {
        // Première connexion : pseudo fourni par le client s'il y en a un,
        // sinon dérivé du prénom Google — l'entrée reste « en un geste »
        // dans la plupart des cas, et le pseudo se change ensuite dans Moi.
        $pseudo = validate_pseudo($body['pseudo'] ?? null) ?? google_derive_pseudo($info);
        if ($pseudo === null) {
            json_error(
                'Choisis un pseudo : 2 à 20 caractères (lettres, chiffres, espaces, tirets ou apostrophes).',
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
        journal_log($pdo, 'compte_cree', $email, $pseudo);
    }

    journal_log($pdo, 'connexion_google', $email);
    json_out(['token' => open_session($pdo, $user), 'user' => user_payload($user)]);
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
        json_error('Pseudo invalide : 2 à 20 caractères (lettres, chiffres, espaces, tirets ou apostrophes).', 422);
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

/**
 * Efface COMPLÈTEMENT un compte : synchro, amitiés, duels, groupes, sessions,
 * codes de connexion, puis la ligne users elle-même. Partagée entre DELETE
 * /api/me (l'utilisateur lui-même) et DELETE /api/admin/users/{id}
 * (l'administration).
 *
 * Groupes d'église : ses adhésions et ses inscriptions aux services de la
 * page de l'église sont retirées ; pour chaque groupe dont il est
 * responsable, le groupe est supprimé s'il y était seul (page comprise),
 * sinon le membre restant le plus ancien est promu responsable
 * (groupes.responsable_id ET son role dans groupe_membres) — l'assemblée ne
 * reste jamais sans berger.
 *
 * Notifications push : les abonnements de l'appareil sont DÉTACHÉS du compte
 * (user_id → NULL), pas supprimés — l'utilisateur a activé « le verset
 * offert » sur son appareil indépendamment de son compte ; supprimer le
 * compte ne retire pas ce choix, l'appareil reçoit désormais la rotation
 * générique. Se désabonner reste possible à tout moment depuis l'écran Moi.
 */
function delete_user_completely(PDO $pdo, array $user): void {
    $id = $user['id'];

    $pdo->beginTransaction();
    try {
        $st = $pdo->prepare('DELETE FROM sync_blobs WHERE user_id = ?');
        $st->execute([$id]);
        $st = $pdo->prepare('UPDATE push_abonnements SET user_id = NULL WHERE user_id = ?');
        $st->execute([$id]);
        $st = $pdo->prepare('DELETE FROM friendships WHERE user_a = ? OR user_b = ?');
        $st->execute([$id, $id]);
        $st = $pdo->prepare('DELETE FROM duels WHERE challenger_id = ? OR opponent_id = ?');
        $st->execute([$id, $id]);

        // Page de l'église : ses mains levées sont retirées — les services
        // eux-mêmes restent, une place se libère simplement.
        $st = $pdo->prepare('DELETE FROM groupe_service_inscriptions WHERE user_id = ?');
        $st->execute([$id]);

        // Sa demande de groupe (en attente ou refusée) part avec le compte,
        // détails compris (adresse, e-mail de contact — table compagne).
        $st = $pdo->prepare(
            'DELETE FROM groupe_demande_details WHERE demande_id IN
             (SELECT id FROM groupe_demandes WHERE user_id = ?)'
        );
        $st->execute([$id]);
        $st = $pdo->prepare('DELETE FROM groupe_demandes WHERE user_id = ?');
        $st->execute([$id]);

        // Groupes dont il est responsable : suppression s'il y est seul
        // (avec toute la page — voir groupe_delete_completely), sinon
        // passation au membre restant le plus ancien.
        $st = $pdo->prepare('SELECT id FROM groupes WHERE responsable_id = ?');
        $st->execute([$id]);
        foreach (array_column($st->fetchAll(), 'id') as $groupeId) {
            $st = $pdo->prepare(
                'SELECT user_id FROM groupe_membres
                 WHERE groupe_id = ? AND user_id <> ?
                 ORDER BY joined_at ASC, user_id ASC LIMIT 1'
            );
            $st->execute([$groupeId, $id]);
            $heritier = $st->fetch();
            if ($heritier === false) {
                // Seul dans son groupe : le groupe disparaît avec lui, quiz
                // d'église et page compris (groupe_delete_completely).
                groupe_delete_completely($pdo, (int) $groupeId);
            } else {
                $pdo->prepare('UPDATE groupes SET responsable_id = ? WHERE id = ?')
                    ->execute([$heritier['user_id'], $groupeId]);
                $st = $pdo->prepare(
                    'UPDATE groupe_membres SET role = \'responsable\'
                     WHERE groupe_id = ? AND user_id = ?'
                );
                $st->execute([$groupeId, $heritier['user_id']]);
            }
        }
        // Puis toutes ses adhésions (simples membres comme responsable sortant).
        $st = $pdo->prepare('DELETE FROM groupe_membres WHERE user_id = ?');
        $st->execute([$id]);

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
    // APRÈS le commit : le journal ne participe pas à la transaction
    // (et ne pourrait de toute façon jamais la faire échouer).
    journal_log($pdo, 'compte_supprime', $user['email'], $user['pseudo']);
}

function handle_me_delete(PDO $pdo): never {
    $user = require_user($pdo);
    delete_user_completely($pdo, $user);
    json_out(['ok' => true]);
}
