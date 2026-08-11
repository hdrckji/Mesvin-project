<?php
/* ============================================================================
   Groupes d'église — FONDATIONS SERVEUR SEULEMENT (aucune interface encore).

   L'esprit (VISION.md, « dimension communautaire ») : on rejoint le groupe
   de son église avec un code court (GRP-XXXXX) ; le responsable pousse le
   verset de la semaine au groupe ; le suivi reste bienveillant — jamais de
   classement individuel public, et les e-mails des membres ne sont JAMAIS
   exposés aux autres.

   - POST   /api/groupes                    : créer (le créateur devient responsable).
   - POST   /api/groupes/rejoindre          : rejoindre par code (en membre).
   - GET    /api/groupes                    : mes groupes.
   - GET    /api/groupes/{code}             : détail — membres seulement (403 sinon).
   - POST   /api/groupes/{code}/verset      : verset de la semaine — responsable seul.
   - DELETE /api/groupes/{code}/membres/moi : quitter le groupe.
   - DELETE /api/groupes/{code}             : supprimer — responsable seul.

   Garde-fous : 5 groupes au plus par responsable, 500 membres au plus par
   groupe. Un responsable ne quitte pas tant qu'il reste d'autres membres
   (il faut d'abord transmettre — la passation viendra plus tard) ; s'il est
   le dernier, le groupe est supprimé avec lui. À la suppression d'un compte,
   voir delete_user_completely (auth.php) : adhésions retirées, groupes
   transmis au membre le plus ancien ou supprimés.
   ========================================================================== */

defined('GRAINE_API') || exit;

const GROUPE_MAX_PAR_RESPONSABLE = 5;    // anti-abus : pas d'usine à groupes
const GROUPE_MAX_MEMBRES         = 500;  // largement assez pour une assemblée

/* ---- Aides ------------------------------------------------------------------ */

/** Charge le groupe depuis un code d'URL (400 mal formé, 404 inconnu). */
function groupe_load(PDO $pdo, string $rawCode): array {
    $code = normalize_group_code(rawurldecode($rawCode));
    if ($code === null) {
        json_error('Code de groupe invalide (format attendu : GRP-XXXXX).', 400);
    }
    $st = $pdo->prepare('SELECT * FROM groupes WHERE code = ?');
    $st->execute([$code]);
    $groupe = $st->fetch();
    if ($groupe === false) {
        json_error('Groupe introuvable — vérifie le code.', 404);
    }
    return $groupe;
}

/** Rôle de l'utilisateur dans le groupe ('responsable' | 'membre'), ou null. */
function groupe_role(PDO $pdo, int $groupeId, int $userId): ?string {
    $st = $pdo->prepare('SELECT role FROM groupe_membres WHERE groupe_id = ? AND user_id = ?');
    $st->execute([$groupeId, $userId]);
    $row = $st->fetch();
    return $row === false ? null : (string) $row['role'];
}

/** Nombre de membres du groupe (responsable compris). */
function groupe_nb_membres(PDO $pdo, int $groupeId): int {
    $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_membres WHERE groupe_id = ?');
    $st->execute([$groupeId]);
    return (int) $st->fetch()['n'];
}

/**
 * Payload « groupe » commun à toutes les routes : code, nom, role (celui du
 * demandeur), nbMembres, verset { reference, texte, depuis } ou null.
 * Jamais d'id interne, jamais d'e-mail.
 */
function groupe_payload(PDO $pdo, array $groupe, string $role, ?int $nbMembres = null): array {
    $verset = null;
    if ($groupe['verset_ref'] !== null && $groupe['verset_ref'] !== '') {
        $verset = [
            'reference' => $groupe['verset_ref'],
            'texte'     => $groupe['verset_texte'],
            'depuis'    => sql_to_iso($groupe['verset_updated_at']),
        ];
    }
    return [
        'code'      => $groupe['code'],
        'nom'       => $groupe['nom'],
        'role'      => $role,
        'nbMembres' => $nbMembres ?? groupe_nb_membres($pdo, (int) $groupe['id']),
        'verset'    => $verset,
    ];
}

/* ---- POST /api/groupes — créer un groupe ------------------------------------- */

function handle_groupes_create(PDO $pdo): never {
    $user = require_user($pdo);
    $nom = validate_group_name(read_json_body()['nom'] ?? null);
    if ($nom === null) {
        json_error('Nom de groupe invalide : 2 à 40 caractères (lettres, chiffres, espaces, tirets ou apostrophes).', 400);
    }

    // Anti-abus : personne n'a besoin d'être responsable de plus de 5 groupes.
    $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupes WHERE responsable_id = ?');
    $st->execute([$user['id']]);
    if ((int) $st->fetch()['n'] >= GROUPE_MAX_PAR_RESPONSABLE) {
        json_error('Tu es déjà responsable de ' . GROUPE_MAX_PAR_RESPONSABLE . ' groupes — c\'est le maximum.', 400);
    }

    $code = generate_group_code($pdo);
    $pdo->beginTransaction();
    try {
        $st = $pdo->prepare(
            'INSERT INTO groupes (code, nom, responsable_id, created_at) VALUES (?, ?, ?, ?)'
        );
        $st->execute([$code, $nom, $user['id'], now_sql()]);
        $groupeId = (int) $pdo->lastInsertId();
        $st = $pdo->prepare(
            'INSERT INTO groupe_membres (groupe_id, user_id, role, joined_at)
             VALUES (?, ?, \'responsable\', ?)'
        );
        $st->execute([$groupeId, $user['id'], now_sql()]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    $st = $pdo->prepare('SELECT * FROM groupes WHERE id = ?');
    $st->execute([$groupeId]);
    json_out(['groupe' => groupe_payload($pdo, $st->fetch(), 'responsable', 1)], 201);
}

/* ---- POST /api/groupes/rejoindre — rejoindre par code ------------------------- */

function handle_groupes_join(PDO $pdo): never {
    $user = require_user($pdo);
    $code = normalize_group_code(read_json_body()['code'] ?? null);
    if ($code === null) {
        json_error('Code de groupe invalide (format attendu : GRP-XXXXX).', 400);
    }

    $st = $pdo->prepare('SELECT * FROM groupes WHERE code = ?');
    $st->execute([$code]);
    $groupe = $st->fetch();
    if ($groupe === false) {
        json_error('Groupe introuvable — vérifie le code avec ton responsable.', 404);
    }
    if (groupe_role($pdo, (int) $groupe['id'], (int) $user['id']) !== null) {
        json_error('Tu fais déjà partie de ce groupe.', 409);
    }
    if (groupe_nb_membres($pdo, (int) $groupe['id']) >= GROUPE_MAX_MEMBRES) {
        json_error('Ce groupe est complet (' . GROUPE_MAX_MEMBRES . ' membres au maximum).', 409);
    }

    $st = $pdo->prepare(
        'INSERT INTO groupe_membres (groupe_id, user_id, role, joined_at)
         VALUES (?, ?, \'membre\', ?)'
    );
    $st->execute([$groupe['id'], $user['id'], now_sql()]);

    json_out(['groupe' => groupe_payload($pdo, $groupe, 'membre')]);
}

/* ---- GET /api/groupes — mes groupes -------------------------------------------- */

function handle_groupes_list(PDO $pdo): never {
    $user = require_user($pdo);
    $st = $pdo->prepare(
        'SELECT g.*, m.role,
                (SELECT COUNT(*) FROM groupe_membres m2 WHERE m2.groupe_id = g.id) AS nb
         FROM groupe_membres m
         JOIN groupes g ON g.id = m.groupe_id
         WHERE m.user_id = ?
         ORDER BY m.joined_at ASC, g.id ASC'
    );
    $st->execute([$user['id']]);

    $groupes = [];
    foreach ($st->fetchAll() as $row) {
        $groupes[] = groupe_payload($pdo, $row, (string) $row['role'], (int) $row['nb']);
    }
    json_out(['groupes' => $groupes]);
}

/* ---- GET /api/groupes/{code} — détail, membres seulement ------------------------ */

function handle_groupes_detail(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    $role = groupe_role($pdo, (int) $groupe['id'], (int) $user['id']);
    if ($role === null) {
        json_error('Réservé aux membres du groupe.', 403);
    }

    // La liste des membres n'expose que le pseudo et le rôle — JAMAIS les
    // e-mails : on est dans une assemblée, pas dans un annuaire.
    $st = $pdo->prepare(
        'SELECT u.pseudo, m.role
         FROM groupe_membres m
         JOIN users u ON u.id = m.user_id
         WHERE m.groupe_id = ?
         ORDER BY m.joined_at ASC, u.pseudo ASC'
    );
    $st->execute([$groupe['id']]);
    $membres = [];
    foreach ($st->fetchAll() as $row) {
        $membres[] = ['pseudo' => $row['pseudo'], 'role' => $row['role']];
    }

    $payload = groupe_payload($pdo, $groupe, $role, count($membres));
    $payload['membres'] = $membres;
    json_out(['groupe' => $payload]);
}

/* ---- POST /api/groupes/{code}/verset — verset de la semaine --------------------- */

function handle_groupes_verset(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    $role = groupe_role($pdo, (int) $groupe['id'], (int) $user['id']);
    if ($role !== 'responsable') {
        json_error('Seul le responsable du groupe peut poser le verset de la semaine.', 403);
    }

    $body = read_json_body();
    $reference = trim((string) ($body['reference'] ?? ''));
    if ($reference === '' || mb_strlen($reference) > 60) {
        json_error('La référence doit faire entre 1 et 60 caractères.', 400);
    }
    $texte = trim((string) ($body['texte'] ?? ''));
    if ($texte === '' || mb_strlen($texte) > 500) {
        json_error('Le texte du verset doit faire entre 1 et 500 caractères.', 400);
    }

    $st = $pdo->prepare(
        'UPDATE groupes SET verset_ref = ?, verset_texte = ?, verset_updated_at = ? WHERE id = ?'
    );
    $st->execute([$reference, $texte, now_sql(), $groupe['id']]);

    $st = $pdo->prepare('SELECT * FROM groupes WHERE id = ?');
    $st->execute([$groupe['id']]);
    json_out(['groupe' => groupe_payload($pdo, $st->fetch(), 'responsable')]);
}

/* ---- DELETE /api/groupes/{code}/membres/moi — quitter le groupe ----------------- */

function handle_groupes_leave(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    $role = groupe_role($pdo, (int) $groupe['id'], (int) $user['id']);
    if ($role === null) {
        json_error('Tu ne fais pas partie de ce groupe.', 404);
    }

    if ($role === 'responsable') {
        $nb = groupe_nb_membres($pdo, (int) $groupe['id']);
        if ($nb > 1) {
            // Pas d'assemblée sans berger : la passation de responsabilité
            // viendra dans une prochaine version.
            json_error(
                'Tu es responsable de ce groupe : transmets d\'abord la responsabilité avant de le quitter (la passation arrive dans une prochaine version).',
                400
            );
        }
        // Dernier membre : le groupe disparaît avec lui.
        groupe_delete_completely($pdo, (int) $groupe['id']);
        json_out(['ok' => true]);
    }

    $st = $pdo->prepare('DELETE FROM groupe_membres WHERE groupe_id = ? AND user_id = ?');
    $st->execute([$groupe['id'], $user['id']]);
    json_out(['ok' => true]);
}

/* ---- DELETE /api/groupes/{code} — suppression par le responsable ---------------- */

/**
 * Supprime un groupe, toutes ses adhésions, ses réglages de quiz (mode,
 * sélection, questions propres, liens veillée ↔ groupe — voir
 * groupe_quiz_purge dans groupes-quiz.php) et TOUTE sa page d'église
 * (annonces, rendez-vous, services et inscriptions — voir groupes-page.php).
 * Seul chemin de suppression d'un groupe : la route DELETE, le responsable
 * dernier membre qui quitte, la suppression d'un compte
 * (delete_user_completely, auth.php).
 */
function groupe_delete_completely(PDO $pdo, int $groupeId): void {
    groupe_quiz_purge($pdo, $groupeId);
    $pdo->prepare(
        'DELETE FROM groupe_service_inscriptions
         WHERE service_id IN (SELECT id FROM groupe_services WHERE groupe_id = ?)'
    )->execute([$groupeId]);
    $pdo->prepare('DELETE FROM groupe_services WHERE groupe_id = ?')->execute([$groupeId]);
    $pdo->prepare('DELETE FROM groupe_rdv WHERE groupe_id = ?')->execute([$groupeId]);
    $pdo->prepare('DELETE FROM groupe_annonces WHERE groupe_id = ?')->execute([$groupeId]);
    $pdo->prepare('DELETE FROM groupe_membres WHERE groupe_id = ?')->execute([$groupeId]);
    $pdo->prepare('DELETE FROM groupes WHERE id = ?')->execute([$groupeId]);
}

function handle_groupes_delete(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    if (groupe_role($pdo, (int) $groupe['id'], (int) $user['id']) !== 'responsable') {
        json_error('Seul le responsable peut supprimer le groupe.', 403);
    }
    groupe_delete_completely($pdo, (int) $groupe['id']);
    json_out(['ok' => true]);
}
