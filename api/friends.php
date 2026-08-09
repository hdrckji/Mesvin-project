<?php
/* ============================================================================
   Amis : ajout par code ami (GRN-XXXX) = amitié mutuelle immédiate.

   La table friendships stocke chaque paire une seule fois, avec la
   convention user_a < user_b (garantie d'unicité par la clé primaire).
   ========================================================================== */

defined('GRAINE_API') || exit;

/** Retourne [a, b] triés pour respecter la convention user_a < user_b. */
function friendship_pair(int $id1, int $id2): array {
    return $id1 < $id2 ? [$id1, $id2] : [$id2, $id1];
}

/** Est-ce que ces deux utilisateurs sont amis ? */
function are_friends(PDO $pdo, int $id1, int $id2): bool {
    [$a, $b] = friendship_pair($id1, $id2);
    $st = $pdo->prepare('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?');
    $st->execute([$a, $b]);
    return $st->fetch() !== false;
}

/* ---- GET /api/friends ------------------------------------------------------ */

function handle_friends_list(PDO $pdo): never {
    $user = require_user($pdo);
    $st = $pdo->prepare(
        'SELECT u.pseudo, u.friend_code, f.created_at
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
         WHERE f.user_a = ? OR f.user_b = ?
         ORDER BY f.created_at DESC, u.pseudo ASC'
    );
    $st->execute([$user['id'], $user['id'], $user['id']]);

    $friends = [];
    foreach ($st->fetchAll() as $row) {
        $friends[] = [
            'pseudo'     => $row['pseudo'],
            'friendCode' => $row['friend_code'],
            'since'      => sql_to_iso($row['created_at']),
        ];
    }
    json_out(['friends' => $friends]);
}

/* ---- POST /api/friends/add ------------------------------------------------- */

function handle_friends_add(PDO $pdo): never {
    $user = require_user($pdo);
    $code = normalize_friend_code(read_json_body()['code'] ?? null);
    if ($code === null) {
        json_error('Code ami invalide (format attendu : GRN-XXXX).', 400);
    }
    if ($code === $user['friend_code']) {
        json_error('C\'est ton propre code ami !', 400);
    }

    $st = $pdo->prepare('SELECT * FROM users WHERE friend_code = ?');
    $st->execute([$code]);
    $friend = $st->fetch();
    if ($friend === false) {
        json_error('Code ami inconnu — vérifie-le avec ton ami.', 404);
    }
    if (are_friends($pdo, (int) $user['id'], (int) $friend['id'])) {
        json_error('Vous êtes déjà amis.', 409);
    }

    [$a, $b] = friendship_pair((int) $user['id'], (int) $friend['id']);
    $st = $pdo->prepare('INSERT INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)');
    $st->execute([$a, $b, now_sql()]);

    json_out([
        'ok' => true,
        'friend' => [
            'pseudo'     => $friend['pseudo'],
            'friendCode' => $friend['friend_code'],
            'since'      => sql_to_iso(now_sql()),
        ],
    ]);
}

/* ---- DELETE /api/friends/{code} -------------------------------------------- */

function handle_friends_remove(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $code = normalize_friend_code(rawurldecode($rawCode));
    if ($code === null) {
        json_error('Code ami invalide (format attendu : GRN-XXXX).', 400);
    }

    $st = $pdo->prepare('SELECT id FROM users WHERE friend_code = ?');
    $st->execute([$code]);
    $friend = $st->fetch();
    if ($friend === false) {
        json_error('Code ami inconnu.', 404);
    }

    [$a, $b] = friendship_pair((int) $user['id'], (int) $friend['id']);
    $st = $pdo->prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?');
    $st->execute([$a, $b]);
    if ($st->rowCount() === 0) {
        json_error('Vous n\'êtes pas amis.', 404);
    }
    json_out(['ok' => true]);
}
