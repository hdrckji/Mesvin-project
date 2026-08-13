<?php
/* ============================================================================
   Administration — réservée aux adresses listées dans ADMIN_EMAILS.

   - GET    /api/questions                    : banque du Défi FUSIONNÉE (publique).
   - GET    /api/admin/users                  : liste des comptes.
   - DELETE /api/admin/users/{id}             : suppression totale d'un compte.
   - POST   /api/admin/questions              : créer (id adm-…) ou modifier une question.
   - DELETE /api/admin/questions/{id}         : désactiver (id du fichier) ou supprimer (adm-).
   - POST   /api/admin/questions/{id}/restore : retirer la surcharge (version fichier).
   - GET    /api/admin/journal                : journal serveur (connexions, envois de codes).
   - GET    /api/admin/brevo                  : les derniers événements chez Brevo.

   La banque de base vit dans defi/data/questions.json, embarquée dans l'image
   Docker ; le système de fichiers de Railway étant éphémère, les retouches
   vivent dans la table quiz_questions : une ligne dont l'id existe dans le
   fichier SURCHARGE la question (édition, ou désactivation si actif = 0),
   une ligne à l'id nouveau (préfixe adm-) l'AJOUTE. La fonction quiz_bank()
   sert la banque fusionnée à tout le monde : Défi, duels et veillées.
   ========================================================================== */

defined('GRAINE_API') || exit;

/* ---- Rôle admin -------------------------------------------------------------- */

/** Exige un utilisateur connecté ET admin (403 sinon), et le retourne. */
function require_admin(PDO $pdo): array {
    $user = require_user($pdo);
    if (!is_admin($user)) {
        json_error("Réservé à l'administration.", 403);
    }
    return $user;
}

/* ---- Banque de questions ------------------------------------------------------ */

/** Lit le fichier de base defi/data/questions.json (catégories + questions). */
function quiz_file_bank(): array {
    $file = __DIR__ . '/../defi/data/questions.json';
    $bank = json_decode((string) file_get_contents($file), true);
    if (!is_array($bank) || !is_array($bank['questions'] ?? null)) {
        throw new RuntimeException('Banque de questions introuvable ou invalide : ' . $file);
    }
    return $bank;
}

/** Une ligne quiz_questions, remise dans la forme d'une question du fichier. */
function quiz_row_to_question(array $row): array {
    return [
        'id'        => (string) $row['id'],
        'categorie' => (string) $row['categorie'],
        'niveau'    => (int) $row['niveau'],
        'question'  => (string) $row['question'],
        'options'   => json_decode((string) $row['options_json'], true) ?: [],
        'bonne'     => (int) $row['bonne'],
        'reference' => (string) $row['reference'],
    ];
}

/**
 * La banque FUSIONNÉE, celle que tout le monde tire (Défi, duels, veillées) :
 * les questions du fichier — remplacées par leur surcharge active s'il y en a
 * une, retirées si la surcharge est inactive — plus les ajouts (adm-) actifs.
 */
function quiz_bank(PDO $pdo): array {
    $bank = quiz_file_bank();
    $overrides = [];
    foreach ($pdo->query('SELECT * FROM quiz_questions')->fetchAll() as $row) {
        $overrides[(string) $row['id']] = $row;
    }

    $merged = [];
    foreach ($bank['questions'] as $q) {
        $row = $overrides[(string) $q['id']] ?? null;
        if ($row === null) {
            $merged[] = $q;                              // version du fichier
        } elseif ((int) $row['actif'] === 1) {
            $merged[] = quiz_row_to_question($row);      // surcharge active
        }                                                // sinon : désactivée
        unset($overrides[(string) $q['id']]);
    }
    foreach ($overrides as $row) {                       // ajouts (id hors fichier)
        if ((int) $row['actif'] === 1) {
            $merged[] = quiz_row_to_question($row);
        }
    }
    return $merged;
}

/* ---- GET /api/questions — banque publique (sans authentification) ------------- */

function handle_questions_get(PDO $pdo): never {
    $bank = quiz_file_bank();
    json_out([
        'version'    => $bank['version'] ?? 2,
        'categories' => $bank['categories'] ?? [],
        'questions'  => quiz_bank($pdo),
    ]);
}

/* ---- GET /api/admin/users — liste des comptes --------------------------------- */

function handle_admin_users(PDO $pdo): never {
    require_admin($pdo);
    $users = [];
    foreach ($pdo->query('SELECT * FROM users ORDER BY id')->fetchAll() as $u) {
        $users[] = [
            'id'         => (int) $u['id'],
            'pseudo'     => $u['pseudo'],
            'email'      => $u['email'],
            'friendCode' => $u['friend_code'],
            'createdAt'  => sql_to_iso($u['created_at']),
            'lastSeen'   => sql_to_iso($u['last_seen']),
        ];
    }
    json_out(['users' => $users]);
}

/* ---- DELETE /api/admin/users/{id} — suppression totale d'un compte ------------ */

function handle_admin_user_delete(PDO $pdo, int $id): never {
    $admin = require_admin($pdo);
    if ($id === (int) $admin['id']) {
        json_error("Impossible de supprimer ton propre compte par cette route — passe par l'écran Moi.", 400);
    }
    $st = $pdo->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$id]);
    $user = $st->fetch();
    if ($user === false) {
        json_error('Compte introuvable.', 404);
    }
    delete_user_completely($pdo, $user);
    admin_log($pdo, $admin, 'compte.suppression', $user['email'] . ' (' . $user['pseudo'] . ')');
    json_out(['ok' => true]);
}

/* ---- POST /api/admin/questions — créer ou modifier une question --------------- */

function handle_admin_question_save(PDO $pdo): never {
    $admin = require_admin($pdo);
    $body = read_json_body();
    $bank = quiz_file_bank();

    $categories = array_values(array_filter($bank['categories'] ?? [], 'is_string'));
    $categorie = $body['categorie'] ?? null;
    if (!is_string($categorie) || !in_array($categorie, $categories, true)) {
        json_error('Catégorie inconnue — choisis parmi celles du Défi.', 400);
    }
    $niveau = $body['niveau'] ?? null;
    if (!is_int($niveau) || $niveau < 1 || $niveau > 3) {
        json_error('Niveau invalide (1 à 3).', 400);
    }
    $question = trim((string) ($body['question'] ?? ''));
    if ($question === '' || mb_strlen($question) > 300) {
        json_error('La question doit faire entre 1 et 300 caractères.', 400);
    }
    $options = $body['options'] ?? null;
    if (!is_array($options) || count($options) !== 4) {
        json_error('Il faut exactement 4 options.', 400);
    }
    $clean = [];
    foreach (array_values($options) as $o) {
        $o = is_string($o) ? trim($o) : '';
        if ($o === '' || mb_strlen($o) > 120) {
            json_error('Chaque option doit faire entre 1 et 120 caractères.', 400);
        }
        $clean[] = $o;
    }
    $bonne = $body['bonne'] ?? null;
    if (!is_int($bonne) || $bonne < 0 || $bonne > 3) {
        json_error("L'index de la bonne réponse va de 0 à 3.", 400);
    }
    $reference = trim((string) ($body['reference'] ?? ''));
    if ($reference === '' || mb_strlen($reference) > 60) {
        json_error('La référence doit faire entre 1 et 60 caractères.', 400);
    }

    // Sans id : un AJOUT, identifié par un id neuf préfixé adm-.
    // Avec id : une question du fichier (surcharge) ou un ajout existant.
    $id = $body['id'] ?? null;
    if ($id === null || $id === '') {
        $id = 'adm-' . bin2hex(random_bytes(3));
    } elseif (!is_string($id) || !preg_match('/^[A-Za-z0-9-]{1,40}$/', $id)) {
        json_error('Identifiant de question invalide.', 400);
    } elseif (!str_starts_with($id, 'adm-')
        && !in_array($id, array_column($bank['questions'], 'id'), true)) {
        json_error('Question introuvable : ' . $id, 404);
    }

    $st = $pdo->prepare('SELECT 1 FROM quiz_questions WHERE id = ?');
    $st->execute([$id]);
    if ($st->fetch() !== false) {
        $st = $pdo->prepare(
            'UPDATE quiz_questions
             SET categorie = ?, niveau = ?, question = ?, options_json = ?,
                 bonne = ?, reference = ?, actif = 1, updated_at = ?
             WHERE id = ?'
        );
        $st->execute([$categorie, $niveau, $question,
            json_encode($clean, JSON_UNESCAPED_UNICODE), $bonne, $reference, now_sql(), $id]);
    } else {
        $st = $pdo->prepare(
            'INSERT INTO quiz_questions
             (id, categorie, niveau, question, options_json, bonne, reference, actif, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
        );
        $st->execute([$id, $categorie, $niveau, $question,
            json_encode($clean, JSON_UNESCAPED_UNICODE), $bonne, $reference, now_sql()]);
    }

    admin_log($pdo, $admin, 'question.enregistrement', $id . ' — ' . $question);
    json_out(['question' => [
        'id'        => $id,
        'categorie' => $categorie,
        'niveau'    => $niveau,
        'question'  => $question,
        'options'   => $clean,
        'bonne'     => $bonne,
        'reference' => $reference,
    ]]);
}

/* ---- DELETE /api/admin/questions/{id} — désactiver ou supprimer --------------- */

function handle_admin_question_delete(PDO $pdo, string $id): never {
    $admin = require_admin($pdo);
    $st = $pdo->prepare('SELECT * FROM quiz_questions WHERE id = ?');
    $st->execute([$id]);
    $row = $st->fetch();

    $fileQ = null;
    foreach (quiz_file_bank()['questions'] as $q) {
        if ((string) $q['id'] === $id) {
            $fileQ = $q;
            break;
        }
    }
    if ($row === false && $fileQ === null) {
        json_error('Question introuvable : ' . $id, 404);
    }

    if ($fileQ !== null) {
        // Question du fichier : impossible de l'en retirer — on pose (ou on
        // garde) une surcharge inactive. Réversible avec /restore.
        if ($row !== false) {
            $pdo->prepare('UPDATE quiz_questions SET actif = 0, updated_at = ? WHERE id = ?')
                ->execute([now_sql(), $id]);
        } else {
            $st = $pdo->prepare(
                'INSERT INTO quiz_questions
                 (id, categorie, niveau, question, options_json, bonne, reference, actif, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
            );
            $st->execute([$id, $fileQ['categorie'], (int) $fileQ['niveau'], $fileQ['question'],
                json_encode($fileQ['options'], JSON_UNESCAPED_UNICODE),
                (int) $fileQ['bonne'], $fileQ['reference'], now_sql()]);
        }
    } else {
        // Ajout (adm-…) : la ligne disparaît pour de bon.
        $pdo->prepare('DELETE FROM quiz_questions WHERE id = ?')->execute([$id]);
    }
    admin_log($pdo, $admin, $fileQ !== null ? 'question.desactivation' : 'question.suppression', $id);
    json_out(['ok' => true]);
}

/* ---- POST /api/admin/questions/{id}/restore — retirer la surcharge ------------ */

function handle_admin_question_restore(PDO $pdo, string $id): never {
    $admin = require_admin($pdo);
    $st = $pdo->prepare('SELECT 1 FROM quiz_questions WHERE id = ?');
    $st->execute([$id]);
    if ($st->fetch() === false
        || !in_array($id, array_column(quiz_file_bank()['questions'], 'id'), true)) {
        json_error('Aucune surcharge à retirer pour cette question.', 404);
    }
    $pdo->prepare('DELETE FROM quiz_questions WHERE id = ?')->execute([$id]);
    admin_log($pdo, $admin, 'question.retablissement', $id);
    json_out(['ok' => true]);
}

/* ---- GET /api/admin/log — journal des actions d'administration ----------------- */

function handle_admin_log_get(PDO $pdo): never {
    require_admin($pdo);
    $st = $pdo->query('SELECT * FROM admin_log ORDER BY id DESC LIMIT 100');
    $entries = [];
    foreach ($st->fetchAll() as $row) {
        $entries[] = [
            'admin'     => $row['admin_email'],
            'action'    => $row['action'],
            'cible'     => $row['cible'],
            'createdAt' => sql_to_iso($row['created_at']),
        ];
    }
    json_out(['log' => $entries]);
}

/* ---- GET /api/admin/journal — journal serveur (onglet « Activité ») ------------- */

/**
 * Les 100 derniers événements du journal serveur (voir journal_log dans
 * helpers.php), les plus récents d'abord : demandes et envois de codes,
 * connexions, créations et suppressions de comptes.
 */
function handle_admin_journal(PDO $pdo): never {
    require_admin($pdo);
    $st = $pdo->query('SELECT * FROM journal ORDER BY id DESC LIMIT 100');
    $events = [];
    foreach ($st->fetchAll() as $row) {
        $events[] = [
            'ts'     => sql_to_iso($row['ts']),
            'event'  => (string) $row['event'],
            'email'  => $row['email'] !== null ? (string) $row['email'] : null,
            'detail' => $row['detail'] !== null ? (string) $row['detail'] : null,
        ];
    }
    json_out(['events' => $events]);
}

/* ---- GET /api/admin/brevo — les derniers événements chez Brevo ------------------ */

/**
 * Remonte les derniers événements e-mail vus par Brevo (délivré, ouvert,
 * rejeté…), pour croiser avec le journal serveur sans quitter l'écran.
 *
 * Appelle GET https://api.brevo.com/v3/smtp/statistics/events?limit=100&sort=desc
 * (documentée sur https://developers.brevo.com — getEmailEventReport). La
 * réponse attendue est { "events": [ { "date": "ISO 8601", "email": "…",
 * "subject": "…", "event": "requests|delivered|opened|clicks|softBounces|
 * hardBounces|blocked|spam|invalid|deferred|unsubscribed|error|…",
 * "messageId": "…", "from": "…" } ] } — le parsing reste DÉFENSIF (chaque
 * champ avec repli) : les docs n'étant pas toujours joignables depuis ici,
 * un champ absent ou renommé ne casse rien.
 *
 * Robustesse : clé absente ou Brevo injoignable → 200 avec events vide et
 * une note lisible — l'admin voit l'état, rien ne casse. La clé API ne sort
 * JAMAIS de la réponse.
 */
function handle_admin_brevo(PDO $pdo): never {
    require_admin($pdo);

    $apiKey = (string) getenv('BREVO_API_KEY');
    if ($apiKey === '') {
        json_out(['events' => [], 'note' => 'Brevo non configuré']);
    }

    $ch = curl_init('https://api.brevo.com/v3/smtp/statistics/events?limit=100&sort=desc');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_HTTPHEADER     => [
            'api-key: ' . $apiKey,
            'Accept: application/json',
        ],
    ]);
    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false || $status >= 300) {
        // Détail complet dans les logs (sans la clé) ; à l'écran, une note douce.
        error_log("Brevo : événements injoignables — HTTP $status $curlError "
            . substr((string) $response, 0, 300));
        json_out(['events' => [], 'note' => 'Brevo injoignable pour le moment']);
    }

    $data = json_decode((string) $response, true);
    $events = [];
    foreach (is_array($data['events'] ?? null) ? $data['events'] : [] as $e) {
        if (!is_array($e)) {
            continue;
        }
        $events[] = [
            'ts'      => is_string($e['date'] ?? null) ? $e['date'] : null,
            'email'   => is_string($e['email'] ?? null) ? $e['email'] : null,
            'event'   => is_string($e['event'] ?? null) ? $e['event'] : 'inconnu',
            'subject' => is_string($e['subject'] ?? null) ? $e['subject'] : null,
        ];
    }
    json_out(['events' => $events]);
}
