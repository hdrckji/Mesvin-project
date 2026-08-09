<?php
/* ============================================================================
   Duels asynchrones entre amis.

   - Le SERVEUR tire 10 questions dans defi/data/questions.json (catégories
     et niveaux variés), mélange l'ordre des options et STOCKE le tout dans
     duels.questions_json : les deux joueurs voient exactement le même duel.
   - La bonne réponse n'est JAMAIS envoyée au client tant qu'il n'a pas joué.
   - Le score est recalculé côté serveur à partir des réponses stockées :
     le score envoyé par le client n'est jamais cru.
   - Statuts (du point de vue du joueur qui regarde) :
     waiting_me (je n'ai pas joué) / waiting_them (j'ai joué, pas l'autre)
     / finished (les deux ont joué).
   ========================================================================== */

defined('GRAINE_API') || exit;

const DUEL_QUESTION_COUNT   = 10;
const DUEL_MAX_PER_CATEGORY = 2;
const DUEL_MAX_PER_LEVEL    = 4;

/* ---- Tirage des questions -------------------------------------------------- */

/**
 * Tire 10 questions variées de la banque et fixe l'ordre des options.
 * Chaque entrée stockée : { id, question, options[4], bonne, reference }
 * (bonne = index de la bonne réponse APRÈS mélange des options).
 */
function duel_pick_questions(): array {
    $file = __DIR__ . '/../defi/data/questions.json';
    $bank = json_decode((string) file_get_contents($file), true);
    $all = $bank['questions'] ?? null;
    if (!is_array($all) || count($all) < DUEL_QUESTION_COUNT) {
        throw new RuntimeException('Banque de questions introuvable ou incomplète : ' . $file);
    }

    // Variété : on mélange toute la banque, puis on prend au plus
    // 2 questions par catégorie et 4 par niveau, jusqu'à en avoir 10.
    shuffle($all);
    $picked = [];
    $perCategory = [];
    $perLevel = [];
    foreach ($all as $q) {
        $cat = (string) ($q['categorie'] ?? '');
        $lvl = (int) ($q['niveau'] ?? 0);
        if (($perCategory[$cat] ?? 0) >= DUEL_MAX_PER_CATEGORY) continue;
        if (($perLevel[$lvl] ?? 0) >= DUEL_MAX_PER_LEVEL) continue;
        $picked[] = $q;
        $perCategory[$cat] = ($perCategory[$cat] ?? 0) + 1;
        $perLevel[$lvl] = ($perLevel[$lvl] ?? 0) + 1;
        if (count($picked) === DUEL_QUESTION_COUNT) break;
    }
    // Complément de sécurité si les quotas ont trop filtré.
    foreach ($all as $q) {
        if (count($picked) === DUEL_QUESTION_COUNT) break;
        if (!in_array($q, $picked, true)) $picked[] = $q;
    }
    shuffle($picked);

    // Mélange de l'ordre des options, stocké une fois pour toutes.
    $stored = [];
    foreach ($picked as $q) {
        $order = range(0, count($q['options']) - 1);
        shuffle($order);
        $options = [];
        $bonne = 0;
        foreach ($order as $newIndex => $oldIndex) {
            $options[] = $q['options'][$oldIndex];
            if ($oldIndex === (int) $q['bonne']) {
                $bonne = $newIndex;
            }
        }
        $stored[] = [
            'id'        => $q['id'],
            'question'  => $q['question'],
            'options'   => $options,
            'bonne'     => $bonne,
            'reference' => $q['reference'],
        ];
    }
    return $stored;
}

/* ---- Représentation d'un duel pour un joueur ------------------------------- */

/** Charge un duel (avec les pseudos des deux joueurs) ou null. */
function duel_load(PDO $pdo, int $id): ?array {
    $st = $pdo->prepare(
        'SELECT d.*, uc.pseudo AS challenger_pseudo, uo.pseudo AS opponent_pseudo
         FROM duels d
         JOIN users uc ON uc.id = d.challenger_id
         JOIN users uo ON uo.id = d.opponent_id
         WHERE d.id = ?'
    );
    $st->execute([$id]);
    $duel = $st->fetch();
    return $duel === false ? null : $duel;
}

/**
 * Vue « résumé » d'un duel, du point de vue de $user :
 * id, opponent, iChallenged, myScore, theirScore, status, createdAt.
 */
function duel_payload(array $duel, array $user): array {
    $iChallenged = ((int) $duel['challenger_id'] === (int) $user['id']);
    $myAnswers    = $iChallenged ? $duel['challenger_answers'] : $duel['opponent_answers'];
    $theirAnswers = $iChallenged ? $duel['opponent_answers']   : $duel['challenger_answers'];
    $myScore      = $iChallenged ? $duel['challenger_score']   : $duel['opponent_score'];
    $theirScore   = $iChallenged ? $duel['opponent_score']     : $duel['challenger_score'];

    if ($myAnswers === null) {
        $status = 'waiting_me';
    } elseif ($theirAnswers === null) {
        $status = 'waiting_them';
    } else {
        $status = 'finished';
    }

    return [
        'id'          => (int) $duel['id'],
        'opponent'    => ['pseudo' => $iChallenged ? $duel['opponent_pseudo'] : $duel['challenger_pseudo']],
        'iChallenged' => $iChallenged,
        'myScore'     => $myScore === null ? null : (int) $myScore,
        'theirScore'  => $theirScore === null ? null : (int) $theirScore,
        'status'      => $status,
        'createdAt'   => sql_to_iso($duel['created_at']),
    ];
}

/**
 * Vue « détail » : ajoute soit les questions SANS bonnes réponses (si le
 * joueur n'a pas encore joué), soit la revue complète (s'il a joué).
 */
function duel_payload_detail(array $duel, array $user): array {
    $out = duel_payload($duel, $user);
    $questions = json_decode($duel['questions_json'], true);
    $iChallenged = $out['iChallenged'];
    $myAnswersJson = $iChallenged ? $duel['challenger_answers'] : $duel['opponent_answers'];

    if ($myAnswersJson === null) {
        // Pas encore joué : questions et options, mais ni bonne ni référence.
        $out['questions'] = array_map(
            fn (array $q): array => ['id' => $q['id'], 'question' => $q['question'], 'options' => $q['options']],
            $questions
        );
    } else {
        // Déjà joué : revue avec mes réponses, les bonnes réponses, les références.
        $mine = json_decode($myAnswersJson, true);
        $review = [];
        foreach ($questions as $i => $q) {
            $review[] = [
                'id'        => $q['id'],
                'question'  => $q['question'],
                'options'   => $q['options'],
                'mine'      => (int) ($mine[$i] ?? -1),
                'bonne'     => (int) $q['bonne'],
                'reference' => $q['reference'],
            ];
        }
        $out['review'] = $review;
    }
    return $out;
}

/* ---- POST /api/duels — créer un duel --------------------------------------- */

function handle_duels_create(PDO $pdo): never {
    $user = require_user($pdo);
    $code = normalize_friend_code(read_json_body()['opponentCode'] ?? null);
    if ($code === null) {
        json_error('Code ami invalide (format attendu : GRN-XXXX).', 400);
    }
    if ($code === $user['friend_code']) {
        json_error('Impossible de se défier soi-même !', 400);
    }

    $st = $pdo->prepare('SELECT * FROM users WHERE friend_code = ?');
    $st->execute([$code]);
    $opponent = $st->fetch();
    if ($opponent === false) {
        json_error('Code ami inconnu.', 404);
    }
    if (!are_friends($pdo, (int) $user['id'], (int) $opponent['id'])) {
        json_error('Vous devez d\'abord être amis pour vous défier.', 403);
    }

    $questions = duel_pick_questions();
    $st = $pdo->prepare(
        'INSERT INTO duels (challenger_id, opponent_id, questions_json, created_at)
         VALUES (?, ?, ?, ?)'
    );
    $st->execute([
        $user['id'],
        $opponent['id'],
        json_encode($questions, JSON_UNESCAPED_UNICODE),
        now_sql(),
    ]);

    $duel = duel_load($pdo, (int) $pdo->lastInsertId());
    json_out(['duel' => duel_payload_detail($duel, $user)], 201);
}

/* ---- GET /api/duels — mes duels -------------------------------------------- */

function handle_duels_list(PDO $pdo): never {
    $user = require_user($pdo);
    $st = $pdo->prepare(
        'SELECT d.*, uc.pseudo AS challenger_pseudo, uo.pseudo AS opponent_pseudo
         FROM duels d
         JOIN users uc ON uc.id = d.challenger_id
         JOIN users uo ON uo.id = d.opponent_id
         WHERE d.challenger_id = ? OR d.opponent_id = ?
         ORDER BY d.id DESC'
    );
    $st->execute([$user['id'], $user['id']]);

    $duels = [];
    foreach ($st->fetchAll() as $duel) {
        $duels[] = duel_payload($duel, $user);
    }
    json_out(['duels' => $duels]);
}

/* ---- GET /api/duels/{id} — détail ------------------------------------------ */

function handle_duels_detail(PDO $pdo, int $id): never {
    $user = require_user($pdo);
    $duel = duel_load($pdo, $id);
    if ($duel === null
        || ((int) $duel['challenger_id'] !== (int) $user['id']
            && (int) $duel['opponent_id'] !== (int) $user['id'])) {
        json_error('Duel introuvable.', 404);
    }
    json_out(['duel' => duel_payload_detail($duel, $user)]);
}

/* ---- POST /api/duels/{id}/result — jouer ----------------------------------- */

function handle_duels_result(PDO $pdo, int $id): never {
    $user = require_user($pdo);
    $duel = duel_load($pdo, $id);
    if ($duel === null
        || ((int) $duel['challenger_id'] !== (int) $user['id']
            && (int) $duel['opponent_id'] !== (int) $user['id'])) {
        json_error('Duel introuvable.', 404);
    }

    $iChallenged = ((int) $duel['challenger_id'] === (int) $user['id']);
    if (($iChallenged ? $duel['challenger_answers'] : $duel['opponent_answers']) !== null) {
        json_error('Tu as déjà joué ce duel.', 409);
    }

    $questions = json_decode($duel['questions_json'], true);
    $answers = read_json_body()['answers'] ?? null;
    if (!is_array($answers) || count($answers) !== count($questions)) {
        json_error('Il faut une réponse (ou -1) pour chacune des ' . count($questions) . ' questions.', 400);
    }
    $clean = [];
    foreach (array_values($answers) as $a) {
        if (!is_int($a) || $a < -1 || $a > 3) {
            json_error('Réponses invalides : indices entiers entre -1 et 3 attendus.', 400);
        }
        $clean[] = $a;
    }

    // Score recalculé côté serveur, à partir des questions stockées.
    $score = 0;
    foreach ($questions as $i => $q) {
        if ($clean[$i] === (int) $q['bonne']) {
            $score++;
        }
    }

    $column = $iChallenged ? 'challenger' : 'opponent';
    $st = $pdo->prepare(
        "UPDATE duels SET {$column}_answers = ?, {$column}_score = ? WHERE id = ?"
    );
    $st->execute([json_encode($clean), $score, $id]);

    $duel = duel_load($pdo, $id);
    json_out(['duel' => duel_payload_detail($duel, $user)]);
}
