<?php
/* ============================================================================
   Quiz d'église — la banque de questions PAR GROUPE (fondations serveur
   seulement, aucune interface encore).

   Chaque église (groupe) choisit ce que SES quiz utilisent : toute la banque
   commune (mode « toutes », défaut), une SÉLECTION de celle-ci (mode
   « selection »), et/ou ses PROPRES questions (id « egl-… », écrites par le
   responsable). RÈGLE ABSOLUE : cela ne touche que les quiz lancés dans
   l'église (POST /api/veillees avec « groupe ») — le Défi du jour et le solo
   des membres restent mondiaux.

   - GET    /api/groupes/{code}/quiz                : réglages — membres.
   - POST   /api/groupes/{code}/quiz/mode           : 'toutes' | 'selection'.
   - PUT    /api/groupes/{code}/quiz/selection      : REMPLACE la sélection.
   - GET    /api/groupes/{code}/quiz/questions      : questions propres —
            responsable seul (elles portent la bonne réponse).
   - POST   /api/groupes/{code}/quiz/questions      : créer ou modifier.
   - DELETE /api/groupes/{code}/quiz/questions/{id} : supprimer pour de bon.

   Lecture aux membres, écriture au responsable seul (403 sinon). Garde-fous :
   2000 ids au plus dans la sélection, 300 questions propres par groupe.
   À la suppression du groupe, groupe_quiz_purge efface tout (réglages,
   sélection, questions propres, liens veillée ↔ groupe).
   ========================================================================== */

defined('GRAINE_API') || exit;

const GROUPE_QUIZ_MAX_SELECTION = 2000;  // ids retenus dans la banque commune
const GROUPE_QUIZ_MAX_PROPRES   = 300;   // questions écrites par le groupe

/* ---- Aides ------------------------------------------------------------------ */

/**
 * Charge le groupe et vérifie les droits : membre pour lire, responsable pour
 * écrire (403 sinon). Retourne la ligne `groupes`.
 */
function groupe_quiz_ctx(PDO $pdo, string $rawCode, bool $responsableSeul): array {
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    $role = groupe_role($pdo, (int) $groupe['id'], (int) $user['id']);
    if ($role === null) {
        json_error('Réservé aux membres du groupe.', 403);
    }
    if ($responsableSeul && $role !== 'responsable') {
        json_error('Seul le responsable du groupe peut gérer la banque de quiz.', 403);
    }
    return $groupe;
}

/** Mode de la banque du groupe : 'toutes' (défaut) ou 'selection'. */
function groupe_quiz_mode(PDO $pdo, int $groupeId): string {
    $st = $pdo->prepare('SELECT mode FROM groupe_quiz_reglages WHERE groupe_id = ?');
    $st->execute([$groupeId]);
    $row = $st->fetch();
    return $row === false ? 'toutes' : (string) $row['mode'];
}

/** Ids de la banque commune retenus par le groupe (mode 'selection'). */
function groupe_quiz_selection_ids(PDO $pdo, int $groupeId): array {
    $st = $pdo->prepare('SELECT question_id FROM groupe_quiz_selection WHERE groupe_id = ?');
    $st->execute([$groupeId]);
    return array_column($st->fetchAll(), 'question_id');
}

/** Questions propres ACTIVES du groupe, dans la forme de quiz_bank. */
function groupe_quiz_propres(PDO $pdo, int $groupeId): array {
    $st = $pdo->prepare(
        'SELECT * FROM groupe_questions WHERE groupe_id = ? AND actif = 1 ORDER BY id ASC'
    );
    $st->execute([$groupeId]);
    return array_map('quiz_row_to_question', $st->fetchAll());
}

/**
 * La banque du GROUPE, celle où tirent ses quiz d'église — même forme de
 * sortie que quiz_bank (id, categorie, niveau, question, options, bonne,
 * reference) :
 * - mode 'toutes'    : la banque commune entière + les propres actives ;
 * - mode 'selection' : seulement les questions de la banque commune dont
 *   l'id est retenu dans groupe_quiz_selection + les propres actives.
 */
function groupe_quiz_bank(PDO $pdo, int $groupeId): array {
    $commune = quiz_bank($pdo);
    if (groupe_quiz_mode($pdo, $groupeId) === 'selection') {
        $retenus = array_flip(groupe_quiz_selection_ids($pdo, $groupeId));
        $commune = array_values(array_filter(
            $commune,
            fn (array $q): bool => isset($retenus[(string) $q['id']])
        ));
    }
    return array_merge($commune, groupe_quiz_propres($pdo, $groupeId));
}

/**
 * Purge TOUT ce qui touche au quiz d'un groupe : réglages, sélection,
 * questions propres et liens veillée ↔ groupe. Appelée par
 * groupe_delete_completely (groupes.php) sur chaque chemin de suppression :
 * route DELETE, responsable dernier membre qui part, suppression de compte.
 */
function groupe_quiz_purge(PDO $pdo, int $groupeId): void {
    $pdo->prepare('DELETE FROM groupe_quiz_reglages WHERE groupe_id = ?')->execute([$groupeId]);
    $pdo->prepare('DELETE FROM groupe_quiz_selection WHERE groupe_id = ?')->execute([$groupeId]);
    $pdo->prepare('DELETE FROM groupe_questions WHERE groupe_id = ?')->execute([$groupeId]);
    $pdo->prepare('DELETE FROM veillee_groupes WHERE groupe_id = ?')->execute([$groupeId]);
}

/** Payload « quiz » commun : mode, nbSelection, nbPropres, nbTotal. */
function groupe_quiz_payload(PDO $pdo, int $groupeId): array {
    $st = $pdo->prepare(
        'SELECT COUNT(*) AS n FROM groupe_questions WHERE groupe_id = ? AND actif = 1'
    );
    $st->execute([$groupeId]);
    $selection = groupe_quiz_selection_ids($pdo, $groupeId);
    return [
        'mode'        => groupe_quiz_mode($pdo, $groupeId),
        // Les ids eux-mêmes : l'éditeur unifié des banques (onglet Mon église)
        // relit la sélection d'où qu'on vienne — pas besoin d'un miroir local.
        'selection'   => $selection,
        'nbSelection' => count($selection),
        'nbPropres'   => (int) $st->fetch()['n'],
        // La taille de la banque RÉSULTANTE — ce que tirera un quiz d'église.
        'nbTotal'     => count(groupe_quiz_bank($pdo, $groupeId)),
    ];
}

/* ---- GET /api/groupes/{code}/quiz — réglages (membres) ------------------------ */

function handle_groupe_quiz_get(PDO $pdo, string $rawCode): never {
    $groupe = groupe_quiz_ctx($pdo, $rawCode, false);
    json_out(['quiz' => groupe_quiz_payload($pdo, (int) $groupe['id'])]);
}

/* ---- POST /api/groupes/{code}/quiz/mode — 'toutes' | 'selection' -------------- */

function handle_groupe_quiz_mode(PDO $pdo, string $rawCode): never {
    $groupe = groupe_quiz_ctx($pdo, $rawCode, true);
    $mode = read_json_body()['mode'] ?? null;
    if (!is_string($mode) || !in_array($mode, ['toutes', 'selection'], true)) {
        json_error("Mode invalide : 'toutes' ou 'selection'.", 400);
    }

    $groupeId = (int) $groupe['id'];
    $st = $pdo->prepare('SELECT 1 FROM groupe_quiz_reglages WHERE groupe_id = ?');
    $st->execute([$groupeId]);
    if ($st->fetch() !== false) {
        $pdo->prepare('UPDATE groupe_quiz_reglages SET mode = ?, updated_at = ? WHERE groupe_id = ?')
            ->execute([$mode, now_sql(), $groupeId]);
    } else {
        $pdo->prepare('INSERT INTO groupe_quiz_reglages (groupe_id, mode, updated_at) VALUES (?, ?, ?)')
            ->execute([$groupeId, $mode, now_sql()]);
    }
    json_out(['quiz' => groupe_quiz_payload($pdo, $groupeId)]);
}

/* ---- PUT /api/groupes/{code}/quiz/selection — REMPLACE la sélection ------------ */

function handle_groupe_quiz_selection(PDO $pdo, string $rawCode): never {
    $groupe = groupe_quiz_ctx($pdo, $rawCode, true);
    $ids = read_json_body()['ids'] ?? null;
    if (!is_array($ids)) {
        json_error('Corps attendu : { "ids": [ … ] }.', 400);
    }
    if (count($ids) > GROUPE_QUIZ_MAX_SELECTION) {
        json_error('Sélection trop grande (' . GROUPE_QUIZ_MAX_SELECTION . ' questions au maximum).', 400);
    }

    // Chaque id doit exister dans la banque commune fusionnée (l'id fautif
    // est nommé dans l'erreur) ; les doublons sont fondus silencieusement.
    $connus = array_flip(array_map(
        fn (array $q): string => (string) $q['id'],
        quiz_bank($pdo)
    ));
    $retenus = [];
    foreach ($ids as $id) {
        if (!is_string($id) || !isset($connus[$id])) {
            json_error(
                'Question inconnue dans la banque commune : '
                . (is_string($id) ? mb_substr($id, 0, 60) : '(id non textuel)'),
                400
            );
        }
        $retenus[$id] = true;
    }

    $groupeId = (int) $groupe['id'];
    $pdo->beginTransaction();
    try {
        $pdo->prepare('DELETE FROM groupe_quiz_selection WHERE groupe_id = ?')->execute([$groupeId]);
        $st = $pdo->prepare('INSERT INTO groupe_quiz_selection (groupe_id, question_id) VALUES (?, ?)');
        foreach (array_keys($retenus) as $id) {
            $st->execute([$groupeId, $id]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    json_out(['quiz' => groupe_quiz_payload($pdo, $groupeId)]);
}

/* ---- GET /api/groupes/{code}/quiz/questions — propres (responsable seul) ------- */

function handle_groupe_quiz_questions_list(PDO $pdo, string $rawCode): never {
    // Responsable SEUL : les questions propres portent la bonne réponse.
    $groupe = groupe_quiz_ctx($pdo, $rawCode, true);
    json_out(['questions' => groupe_quiz_propres($pdo, (int) $groupe['id'])]);
}

/* ---- POST /api/groupes/{code}/quiz/questions — créer ou modifier --------------- */

function handle_groupe_quiz_question_save(PDO $pdo, string $rawCode): never {
    $groupe = groupe_quiz_ctx($pdo, $rawCode, true);
    $groupeId = (int) $groupe['id'];
    $body = read_json_body();

    // Validations STRICTEMENT identiques à handle_admin_question_save
    // (admin.php) : catégories du fichier, niveau 1-3, longueurs, 4 options,
    // bonne 0-3, référence.
    $categories = array_values(array_filter(quiz_file_bank()['categories'] ?? [], 'is_string'));
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

    // Sans id : une CRÉATION (id neuf « egl-<6 hex> », plafond de 300).
    // Avec id : la MODIFICATION d'une question egl- de CE groupe (404 sinon).
    $id = $body['id'] ?? null;
    if ($id === null || $id === '') {
        $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_questions WHERE groupe_id = ?');
        $st->execute([$groupeId]);
        if ((int) $st->fetch()['n'] >= GROUPE_QUIZ_MAX_PROPRES) {
            json_error('Le groupe a déjà ' . GROUPE_QUIZ_MAX_PROPRES . ' questions propres — c\'est le maximum.', 400);
        }
        // L'id est une clé primaire GLOBALE (tous groupes confondus) : on
        // retire au sort jusqu'à tomber sur un id libre.
        $st = $pdo->prepare('SELECT 1 FROM groupe_questions WHERE id = ?');
        for ($try = 0; $try < 50; $try++) {
            $id = 'egl-' . bin2hex(random_bytes(3));
            $st->execute([$id]);
            if ($st->fetch() === false) {
                break;
            }
            $id = null;
        }
        if ($id === null) {
            throw new RuntimeException('Impossible de générer un id de question de groupe unique.');
        }
        $st = $pdo->prepare(
            'INSERT INTO groupe_questions
             (id, groupe_id, categorie, niveau, question, options_json, bonne, reference, actif, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
        );
        $st->execute([$id, $groupeId, $categorie, $niveau, $question,
            json_encode($clean, JSON_UNESCAPED_UNICODE), $bonne, $reference, now_sql()]);
    } else {
        if (!is_string($id) || !preg_match('/^egl-[a-f0-9]{6}$/', $id)) {
            json_error('Identifiant de question invalide (attendu : egl-…).', 400);
        }
        $st = $pdo->prepare('SELECT 1 FROM groupe_questions WHERE id = ? AND groupe_id = ?');
        $st->execute([$id, $groupeId]);
        if ($st->fetch() === false) {
            json_error('Question introuvable dans ce groupe : ' . $id, 404);
        }
        $st = $pdo->prepare(
            'UPDATE groupe_questions
             SET categorie = ?, niveau = ?, question = ?, options_json = ?,
                 bonne = ?, reference = ?, actif = 1, updated_at = ?
             WHERE id = ? AND groupe_id = ?'
        );
        $st->execute([$categorie, $niveau, $question,
            json_encode($clean, JSON_UNESCAPED_UNICODE), $bonne, $reference, now_sql(),
            $id, $groupeId]);
    }

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

/* ---- DELETE /api/groupes/{code}/quiz/questions/{id} — supprimer ----------------- */

function handle_groupe_quiz_question_delete(PDO $pdo, string $rawCode, string $id): never {
    $groupe = groupe_quiz_ctx($pdo, $rawCode, true);
    $groupeId = (int) $groupe['id'];
    $st = $pdo->prepare('SELECT 1 FROM groupe_questions WHERE id = ? AND groupe_id = ?');
    $st->execute([$id, $groupeId]);
    if ($st->fetch() === false) {
        json_error('Question introuvable dans ce groupe : ' . $id, 404);
    }
    // Les questions propres s'effacent pour de bon — pas de désactivation ici.
    $pdo->prepare('DELETE FROM groupe_questions WHERE id = ? AND groupe_id = ?')
        ->execute([$id, $groupeId]);
    json_out(['ok' => true]);
}
