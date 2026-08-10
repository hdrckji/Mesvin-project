<?php
/* ============================================================================
   Veillée en direct — le mode « en groupe » du module Défi.

   Un animateur (compte requis) crée une salle et la projette sur un grand
   écran ; chacun la rejoint avec un code court et son prénom (AUCUN compte
   pour les participants) et répond sur son propre téléphone, en direct.

   Déroulé : lobby → question → reveal → … → done, piloté par l'animateur.
   Les clients suivent en interrogeant /state toutes les ~2 s (polling —
   simple, robuste, largement suffisant pour un groupe d'église).

   Principes hérités des duels :
   - le SERVEUR tire les questions et fixe l'ordre des options ;
   - la bonne réponse n'est JAMAIS envoyée pendant la phase de réponse ;
   - points et scores sont calculés côté serveur, rien n'est cru du client.

   Points : 100 par bonne réponse + jusqu'à 50 de bonus de rapidité.
   Les veillées de plus de 24 h sont balayées à la création suivante.
   ========================================================================== */

defined('GRAINE_API') || exit;

const VEILLEE_MIN_QUESTIONS     = 5;
const VEILLEE_MAX_QUESTIONS     = 20;
const VEILLEE_DEFAULT_QUESTIONS = 10;
const VEILLEE_MIN_SECONDS       = 10;
const VEILLEE_MAX_SECONDS       = 90;
const VEILLEE_DEFAULT_SECONDS   = 25;
const VEILLEE_MAX_PLAYERS       = 100;
const VEILLEE_GRACE_SECONDS     = 2;   // tolérance réseau après le décompte
const VEILLEE_TTL_SECONDS       = 86400;
const VEILLEE_POINTS_BASE       = 100;
const VEILLEE_POINTS_SPEED      = 50;

/* ---- Aides ------------------------------------------------------------------ */

/** Balaye les veillées (et leurs joueurs/réponses) de plus de 24 h. */
function veillee_cleanup(PDO $pdo): void {
    $limit = now_sql_plus(-VEILLEE_TTL_SECONDS);
    $st = $pdo->prepare('SELECT id FROM veillees WHERE created_at < ?');
    $st->execute([$limit]);
    $ids = array_column($st->fetchAll(), 'id');
    foreach ($ids as $id) {
        $pdo->prepare('DELETE FROM veillee_answers WHERE veillee_id = ?')->execute([$id]);
        $pdo->prepare('DELETE FROM veillee_players WHERE veillee_id = ?')->execute([$id]);
        $pdo->prepare('DELETE FROM veillees WHERE id = ?')->execute([$id]);
    }
}

/** Code de salle court (4 caractères, sans I/L/O/0/1), unique parmi les actives. */
function veillee_generate_code(PDO $pdo): string {
    $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    $max = strlen($alphabet) - 1;
    for ($try = 0; $try < 50; $try++) {
        $code = '';
        for ($i = 0; $i < 4; $i++) {
            $code .= $alphabet[random_int(0, $max)];
        }
        $st = $pdo->prepare('SELECT 1 FROM veillees WHERE code = ?');
        $st->execute([$code]);
        if ($st->fetch() === false) {
            return $code;
        }
    }
    throw new RuntimeException('Impossible de générer un code de veillée unique.');
}

/** Charge la veillée la plus récente portant ce code, ou répond 404. */
function veillee_load(PDO $pdo, string $code): array {
    $st = $pdo->prepare('SELECT * FROM veillees WHERE code = ? ORDER BY id DESC LIMIT 1');
    $st->execute([$code]);
    $v = $st->fetch();
    if ($v === false) {
        json_error('Quiz introuvable — vérifie le code.', 404);
    }
    return $v;
}

/** Convertit une date SQL (UTC) en timestamp Unix. */
function veillee_ts(?string $sqlDate): ?int {
    if ($sqlDate === null || $sqlDate === '') {
        return null;
    }
    $ts = strtotime($sqlDate . ' UTC');
    return $ts === false ? null : $ts;
}

/** Secondes restantes pour la question en cours (0 si le temps est écoulé). */
function veillee_remaining(array $v): int {
    $started = veillee_ts($v['question_started_at']);
    if ($started === null) {
        return 0;
    }
    return max(0, (int) $v['seconds'] - (time() - $started));
}

/**
 * Tire $nb questions dans la banque fusionnée du Défi (quiz_bank : fichier +
 * retouches d'administration ; filtres facultatifs), mélange l'ordre des
 * options et fige le tout — même logique que les duels, avec la catégorie
 * et le niveau conservés pour l'affichage sur le grand écran.
 */
function veillee_pick_questions(PDO $pdo, int $nb, ?string $categorie, ?int $niveau): array {
    $all = quiz_bank($pdo);
    if ($categorie !== null) {
        $all = array_values(array_filter($all, fn (array $q): bool => ($q['categorie'] ?? '') === $categorie));
    }
    if ($niveau !== null) {
        $all = array_values(array_filter($all, fn (array $q): bool => (int) ($q['niveau'] ?? 0) === $niveau));
    }
    if (count($all) < $nb) {
        json_error('Pas assez de questions avec ces critères — élargis la catégorie ou le niveau.', 400);
    }
    shuffle($all);
    $picked = array_slice($all, 0, $nb);

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
            'categorie' => $q['categorie'] ?? '',
            'niveau'    => (int) ($q['niveau'] ?? 0),
        ];
    }
    return $stored;
}

/** Joueurs de la veillée, triés pour le classement (rangs ex aequo partagés). */
function veillee_players(PDO $pdo, int $veilleeId): array {
    $st = $pdo->prepare(
        'SELECT id, player_key, prenom, score FROM veillee_players
         WHERE veillee_id = ? ORDER BY score DESC, joined_at ASC, id ASC'
    );
    $st->execute([$veilleeId]);
    $rows = $st->fetchAll();
    $rang = 0;
    $prevScore = null;
    foreach ($rows as $i => &$r) {
        if ($prevScore === null || (int) $r['score'] < $prevScore) {
            $rang = $i + 1;
            $prevScore = (int) $r['score'];
        }
        $r['rang'] = $rang;
    }
    return $rows;
}

/**
 * L'état complet vu par un client (joueur, animateur ou grand écran).
 * La bonne réponse et la référence n'apparaissent qu'aux phases reveal/done.
 */
function veillee_state_payload(PDO $pdo, array $v, ?array $me): array {
    $questions = json_decode($v['questions_json'], true);
    $players = veillee_players($pdo, (int) $v['id']);
    $statut = (string) $v['statut'];
    $qIndex = (int) $v['current_q'];

    $out = [
        'code'     => $v['code'],
        'statut'   => $statut,
        'qIndex'   => $qIndex,
        'qTotal'   => count($questions),
        'seconds'  => (int) $v['seconds'],
        'nPlayers' => count($players),
        'players'  => array_map(
            fn (array $p): array => ['prenom' => $p['prenom'], 'score' => (int) $p['score'], 'rang' => $p['rang']],
            $players
        ),
    ];

    if ($qIndex >= 0 && $qIndex < count($questions) && $statut !== 'lobby') {
        $q = $questions[$qIndex];
        $out['question'] = [
            'question'  => $q['question'],
            'options'   => $q['options'],
            'categorie' => $q['categorie'],
            'niveau'    => $q['niveau'],
        ];
        $st = $pdo->prepare(
            'SELECT player_id, answer, correct, points FROM veillee_answers
             WHERE veillee_id = ? AND q_index = ?'
        );
        $st->execute([(int) $v['id'], $qIndex]);
        $answers = $st->fetchAll();
        $out['nAnswered'] = count($answers);

        if ($statut === 'question') {
            $out['remaining'] = veillee_remaining($v);
        } else { // reveal ou done : on peut tout montrer
            $out['question']['bonne'] = (int) $q['bonne'];
            $out['question']['reference'] = $q['reference'];
            $dist = array_fill(0, count($q['options']), 0);
            foreach ($answers as $a) {
                $i = (int) $a['answer'];
                if ($i >= 0 && $i < count($dist)) {
                    $dist[$i]++;
                }
            }
            $out['distribution'] = $dist;
        }

        if ($me !== null) {
            $mine = null;
            foreach ($answers as $a) {
                if ((int) $a['player_id'] === (int) $me['id']) {
                    $mine = $a;
                    break;
                }
            }
            $out['me'] = ['prenom' => $me['prenom'], 'answered' => $mine !== null];
            if ($mine !== null && $statut !== 'question') {
                $out['me']['answer'] = (int) $mine['answer'];
                $out['me']['correct'] = (bool) $mine['correct'];
                $out['me']['points'] = (int) $mine['points'];
            }
        }
    } elseif ($me !== null) {
        $out['me'] = ['prenom' => $me['prenom'], 'answered' => false];
    }

    if ($me !== null) {
        foreach ($players as $p) {
            if ((int) $p['id'] === (int) $me['id']) {
                $out['me']['score'] = (int) $p['score'];
                $out['me']['rang'] = $p['rang'];
            }
        }
    }

    if ($statut === 'done') {
        // Bilan collectif — l'esprit veillée : ce qu'on a trouvé ENSEMBLE.
        $st = $pdo->prepare(
            'SELECT COUNT(*) AS n, COALESCE(SUM(correct), 0) AS c
             FROM veillee_answers WHERE veillee_id = ?'
        );
        $st->execute([(int) $v['id']]);
        $bilan = $st->fetch();
        $out['bilan'] = [
            'reponses' => (int) $bilan['n'],
            'bonnes'   => (int) $bilan['c'],
        ];
    }
    return $out;
}

/** Marque la veillée comme fraîchement modifiée. */
function veillee_touch(PDO $pdo, int $id, array $set = []): void {
    $cols = ['updated_at = ?'];
    $vals = [now_sql()];
    foreach ($set as $col => $val) {
        $cols[] = $col . ' = ?';
        $vals[] = $val;
    }
    $vals[] = $id;
    $pdo->prepare('UPDATE veillees SET ' . implode(', ', $cols) . ' WHERE id = ?')->execute($vals);
}

/* ---- POST /api/veillees — créer une salle (animateur, compte requis) -------- */

function handle_veillees_create(PDO $pdo): never {
    $user = require_user($pdo);
    veillee_cleanup($pdo);
    $body = read_json_body();

    $nb = $body['nb'] ?? VEILLEE_DEFAULT_QUESTIONS;
    if (!is_int($nb) || $nb < VEILLEE_MIN_QUESTIONS || $nb > VEILLEE_MAX_QUESTIONS) {
        json_error('Nombre de questions : entre ' . VEILLEE_MIN_QUESTIONS . ' et ' . VEILLEE_MAX_QUESTIONS . '.', 400);
    }
    $seconds = $body['seconds'] ?? VEILLEE_DEFAULT_SECONDS;
    if (!is_int($seconds) || $seconds < VEILLEE_MIN_SECONDS || $seconds > VEILLEE_MAX_SECONDS) {
        json_error('Temps par question : entre ' . VEILLEE_MIN_SECONDS . ' et ' . VEILLEE_MAX_SECONDS . ' secondes.', 400);
    }
    $categorie = $body['categorie'] ?? null;
    if ($categorie !== null && (!is_string($categorie) || mb_strlen($categorie) > 60)) {
        json_error('Catégorie invalide.', 400);
    }
    $niveau = $body['niveau'] ?? null;
    if ($niveau !== null && (!is_int($niveau) || $niveau < 1 || $niveau > 3)) {
        json_error('Niveau invalide (1 à 3).', 400);
    }

    $questions = veillee_pick_questions($pdo, $nb, $categorie, $niveau);
    $code = veillee_generate_code($pdo);
    $st = $pdo->prepare(
        'INSERT INTO veillees (code, host_user_id, statut, questions_json, current_q, seconds, created_at, updated_at)
         VALUES (?, ?, ?, ?, -1, ?, ?, ?)'
    );
    $st->execute([
        $code,
        $user['id'],
        'lobby',
        json_encode($questions, JSON_UNESCAPED_UNICODE),
        $seconds,
        now_sql(),
        now_sql(),
    ]);

    $v = veillee_load($pdo, $code);
    json_out(['veillee' => veillee_state_payload($pdo, $v, null)], 201);
}

/* ---- GET /api/veillees/{code}/state — état pollable (public) ---------------- */

function handle_veillees_state(PDO $pdo, string $code): never {
    $v = veillee_load($pdo, $code);
    $me = null;
    $key = (string) ($_GET['player'] ?? '');
    if ($key !== '' && preg_match('/^[a-f0-9]{32}$/', $key)) {
        $st = $pdo->prepare('SELECT * FROM veillee_players WHERE veillee_id = ? AND player_key = ?');
        $st->execute([(int) $v['id'], $key]);
        $me = $st->fetch() ?: null;
    }
    json_out(['veillee' => veillee_state_payload($pdo, $v, $me)]);
}

/* ---- POST /api/veillees/{code}/join — rejoindre (prénom, sans compte) ------- */

function handle_veillees_join(PDO $pdo, string $code): never {
    $v = veillee_load($pdo, $code);
    if ($v['statut'] === 'done') {
        json_error('Ce quiz est déjà terminé.', 410);
    }
    $prenom = validate_pseudo(read_json_body()['prenom'] ?? null);
    if ($prenom === null) {
        json_error('Ton prénom : 2 à 20 caractères (lettres, chiffres, espaces ou tirets).', 422);
    }

    $st = $pdo->prepare('SELECT COUNT(*) AS n FROM veillee_players WHERE veillee_id = ?');
    $st->execute([(int) $v['id']]);
    if ((int) $st->fetch()['n'] >= VEILLEE_MAX_PLAYERS) {
        json_error('Le quiz est au complet (' . VEILLEE_MAX_PLAYERS . ' participants).', 409);
    }
    // Un prénom = une personne sur le grand écran : pas de doublon.
    $st = $pdo->prepare('SELECT 1 FROM veillee_players WHERE veillee_id = ? AND prenom = ?');
    $st->execute([(int) $v['id'], $prenom]);
    if ($st->fetch() !== false) {
        json_error('Ce prénom est déjà pris dans ce quiz — ajoute une initiale.', 409);
    }

    $playerKey = bin2hex(random_bytes(16));
    $st = $pdo->prepare(
        'INSERT INTO veillee_players (veillee_id, player_key, prenom, score, joined_at)
         VALUES (?, ?, ?, 0, ?)'
    );
    $st->execute([(int) $v['id'], $playerKey, $prenom, now_sql()]);
    veillee_touch($pdo, (int) $v['id']);

    json_out(['playerKey' => $playerKey, 'prenom' => $prenom], 201);
}

/* ---- POST /api/veillees/{code}/answer — répondre à la question en cours ----- */

function handle_veillees_answer(PDO $pdo, string $code): never {
    $v = veillee_load($pdo, $code);
    $body = read_json_body();

    $key = (string) ($body['playerKey'] ?? '');
    if (!preg_match('/^[a-f0-9]{32}$/', $key)) {
        json_error('Participant inconnu — rejoins le quiz d\'abord.', 401);
    }
    $st = $pdo->prepare('SELECT * FROM veillee_players WHERE veillee_id = ? AND player_key = ?');
    $st->execute([(int) $v['id'], $key]);
    $me = $st->fetch();
    if ($me === false) {
        json_error('Participant inconnu — rejoins le quiz d\'abord.', 401);
    }

    $qIndex = (int) $v['current_q'];
    if ($v['statut'] !== 'question' || ($body['q'] ?? null) !== $qIndex) {
        json_error('Cette question est fermée — regarde le grand écran.', 409);
    }
    $questions = json_decode($v['questions_json'], true);
    $q = $questions[$qIndex];
    $answer = $body['answer'] ?? null;
    if (!is_int($answer) || $answer < 0 || $answer >= count($q['options'])) {
        json_error('Réponse invalide.', 400);
    }

    $started = veillee_ts($v['question_started_at']);
    $elapsed = $started === null ? PHP_INT_MAX : time() - $started;
    if ($elapsed > (int) $v['seconds'] + VEILLEE_GRACE_SECONDS) {
        json_error('Trop tard pour cette question — la suite arrive !', 409);
    }

    $correct = ($answer === (int) $q['bonne']);
    $remaining = max(0, (int) $v['seconds'] - $elapsed);
    $points = $correct
        ? VEILLEE_POINTS_BASE + (int) round(VEILLEE_POINTS_SPEED * $remaining / max(1, (int) $v['seconds']))
        : 0;

    try {
        $st = $pdo->prepare(
            'INSERT INTO veillee_answers (veillee_id, q_index, player_id, answer, correct, points, answered_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        $st->execute([(int) $v['id'], $qIndex, (int) $me['id'], $answer, $correct ? 1 : 0, $points, now_sql()]);
    } catch (PDOException $e) {
        // Clé primaire (veillee, question, joueur) : un doublon = déjà répondu.
        json_error('Tu as déjà répondu à cette question.', 409);
    }
    $pdo->prepare('UPDATE veillee_players SET score = score + ? WHERE id = ?')
        ->execute([$points, (int) $me['id']]);

    json_out(['ok' => true]);
}

/* ---- POST /api/veillees/{code}/advance — piloter (animateur seul) ----------- */

function handle_veillees_advance(PDO $pdo, string $code): never {
    $user = require_user($pdo);
    $v = veillee_load($pdo, $code);
    if ((int) $v['host_user_id'] !== (int) $user['id']) {
        json_error('Seul l\'animateur de ce quiz peut le piloter.', 403);
    }

    $action = (string) (read_json_body()['action'] ?? '');
    $questions = json_decode($v['questions_json'], true);
    $qIndex = (int) $v['current_q'];

    if ($action === 'start') {
        if ($v['statut'] !== 'lobby') {
            json_error('Le quiz est déjà lancé.', 409);
        }
        $st = $pdo->prepare('SELECT COUNT(*) AS n FROM veillee_players WHERE veillee_id = ?');
        $st->execute([(int) $v['id']]);
        if ((int) $st->fetch()['n'] < 1) {
            json_error('Attends qu\'au moins une personne ait rejoint le quiz.', 409);
        }
        veillee_touch($pdo, (int) $v['id'], ['statut' => 'question', 'current_q' => 0, 'question_started_at' => now_sql()]);
    } elseif ($action === 'reveal') {
        if ($v['statut'] !== 'question') {
            json_error('Aucune question en cours à révéler.', 409);
        }
        veillee_touch($pdo, (int) $v['id'], ['statut' => 'reveal']);
    } elseif ($action === 'next') {
        if ($v['statut'] !== 'reveal') {
            json_error('Révèle d\'abord la réponse de la question en cours.', 409);
        }
        if ($qIndex + 1 < count($questions)) {
            veillee_touch($pdo, (int) $v['id'], ['statut' => 'question', 'current_q' => $qIndex + 1, 'question_started_at' => now_sql()]);
        } else {
            veillee_touch($pdo, (int) $v['id'], ['statut' => 'done']);
        }
    } elseif ($action === 'end') {
        veillee_touch($pdo, (int) $v['id'], ['statut' => 'done']);
    } else {
        json_error('Action inconnue (start, reveal, next ou end).', 400);
    }

    $v = veillee_load($pdo, $code);
    json_out(['veillee' => veillee_state_payload($pdo, $v, null)]);
}
