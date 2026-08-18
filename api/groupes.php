<?php
/* ============================================================================
   Groupes d'église — FONDATIONS SERVEUR SEULEMENT (aucune interface encore).

   L'esprit (VISION.md, « dimension communautaire ») : on rejoint le groupe
   de son église avec un code court (GRP-XXXXX) ; le responsable pousse le
   verset de la semaine au groupe ; le suivi reste bienveillant — jamais de
   classement individuel public, et les e-mails des membres ne sont JAMAIS
   exposés aux autres.

   - POST   /api/groupes                    : FERMÉE (403) — la création passe par
                                              une demande (voir groupes-demandes.php).
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

/* Deux assemblées au plus par responsable. Cinq n'avait jamais été décidé :
   c'était un chiffre rond posé contre la création en masse. Deux couvre les
   cas réels — un pasteur qui dessert deux petites assemblées, une église qui
   tient un groupe séparé pour sa jeunesse — et ferme l'usine à groupes, qui
   élargirait la surface de contenu à surveiller. Être MEMBRE d'autant
   d'églises qu'on veut reste libre : ce plafond porte sur la charge, jamais
   sur la fréquentation. La passation (groupes.php) est la porte de sortie. */
const GROUPE_MAX_PAR_RESPONSABLE = 2;
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

/* ---- Les trois rôles -------------------------------------------------------
   - responsable   : le porteur du groupe. Seul à nommer des co-responsables,
                     transmettre le groupe, le supprimer, mettre en forme son
                     nom. Il n'y en a qu'UN (groupe_set_responsable y veille).
   - coresponsable : l'équipe qui NOURRIT avec lui — verset de la semaine,
                     page de l'église, banques de questions, quiz d'église.
                     Autant que nécessaire, dans la limite ci-dessous.
   - membre        : lit la page, lève la main, apprend les versets.
   Toute autorisation d'animation passe par groupe_peut_animer() — un seul
   endroit à relire pour savoir qui peut nourrir l'assemblée. */
const GROUPE_MAX_CORESPONSABLES = 10;

function groupe_peut_animer(?string $role): bool {
    return $role === 'responsable' || $role === 'coresponsable';
}

/** Rôle de l'utilisateur dans le groupe ('responsable' | 'coresponsable' | 'membre'), ou null. */
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
        // L'identité visuelle du nom (en-tête de la page Mon église) : des
        // MOTS-CLÉS d'une liste blanche, jamais une police ou une taille
        // libres — voir handle_groupes_identite.
        'nomStyle'  => in_array($groupe['nom_style'] ?? null, GROUPE_NOM_STYLES, true) ? $groupe['nom_style'] : 'classique',
        'nomTaille' => in_array($groupe['nom_taille'] ?? null, GROUPE_NOM_TAILLES, true) ? $groupe['nom_taille'] : 'posee',
        'role'      => $role,
        'nbMembres' => $nbMembres ?? groupe_nb_membres($pdo, (int) $groupe['id']),
        'verset'    => $verset,
    ];
}

/* ---- POST /api/groupes/{code}/identite — le nom, mis en forme ------------------- */

// Les seules valeurs admises — le client n'envoie jamais une police ni une
// taille : des mots-clés, rendus par des classes CSS. Rien d'autre ne passe.
const GROUPE_NOM_STYLES  = ['classique', 'moderne', 'solennelle'];
const GROUPE_NOM_TAILLES = ['discrete', 'posee', 'majestueuse'];

function handle_groupes_identite(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    if (groupe_role($pdo, (int) $groupe['id'], (int) $user['id']) !== 'responsable') {
        json_error('Seul le responsable du groupe met en forme le nom de son église.', 403);
    }
    $body = read_json_body();
    $style = $body['style'] ?? null;
    $taille = $body['taille'] ?? null;
    if (!in_array($style, GROUPE_NOM_STYLES, true)) {
        json_error('Style inconnu (classique, moderne ou solennelle).', 400);
    }
    if (!in_array($taille, GROUPE_NOM_TAILLES, true)) {
        json_error('Taille inconnue (discrete, posee ou majestueuse).', 400);
    }
    $pdo->prepare('UPDATE groupes SET nom_style = ?, nom_taille = ? WHERE id = ?')
        ->execute([$style, $taille, $groupe['id']]);
    $st = $pdo->prepare('SELECT * FROM groupes WHERE id = ?');
    $st->execute([$groupe['id']]);
    json_out(['groupe' => groupe_payload($pdo, $st->fetch(), 'responsable')]);
}

/* ---- POST /api/groupes — la création directe est FERMÉE ----------------------- */

/**
 * Crée réellement un groupe : la ligne `groupes` (code GRP- unique) et
 * l'adhésion du porteur en responsable, sous transaction. Retourne la ligne
 * `groupes` créée. Seul chemin de création d'un groupe : l'acceptation d'une
 * demande par l'administration (voir groupes-demandes.php) — la route POST
 * /api/groupes ne crée plus, elle oriente vers la demande.
 */
function groupe_creer(PDO $pdo, int $userId, string $nom): array {
    $code = generate_group_code($pdo);
    $pdo->beginTransaction();
    try {
        $st = $pdo->prepare(
            'INSERT INTO groupes (code, nom, responsable_id, created_at) VALUES (?, ?, ?, ?)'
        );
        $st->execute([$code, $nom, $userId, now_sql()]);
        $groupeId = (int) $pdo->lastInsertId();
        $st = $pdo->prepare(
            'INSERT INTO groupe_membres (groupe_id, user_id, role, joined_at)
             VALUES (?, ?, \'responsable\', ?)'
        );
        $st->execute([$groupeId, $userId, now_sql()]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    $st = $pdo->prepare('SELECT * FROM groupes WHERE id = ?');
    $st->execute([$groupeId]);
    return $st->fetch();
}

function handle_groupes_create(PDO $pdo): never {
    require_user($pdo);
    // La porte reste visible mais fermée : le message oriente vers le nouveau
    // chemin plutôt que de laisser croire à une panne.
    json_error(
        "La création d'un groupe passe par une demande : dépose-la depuis « Mon église », dans l'écran Moi — elle sera examinée avec soin.",
        403
    );
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
    if (!groupe_peut_animer($role)) {
        json_error('Seuls le responsable et ses co-responsables posent le verset de la semaine.', 403);
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
    // Le rôle rendu est celui de l'appelant — un co-responsable ne se voit
    // pas promu par le simple fait d'avoir posé le verset.
    json_out(['groupe' => groupe_payload($pdo, $st->fetch(), $role)]);
}

/* ---- Les co-responsables : l'équipe qui nourrit avec le responsable ------------- */

/**
 * Le membre désigné par son pseudo, dans ce groupe, hors l'appelant — la
 * seule identité que le groupe expose. 404 s'il n'y est pas, 409 si deux
 * membres le portent (on refuse plutôt que de deviner).
 */
function groupe_membre_par_pseudo(PDO $pdo, int $groupeId, string $pseudo, int $saufUserId): array {
    $st = $pdo->prepare(
        'SELECT u.id, m.role FROM groupe_membres m JOIN users u ON u.id = m.user_id
         WHERE m.groupe_id = ? AND u.pseudo = ? AND u.id <> ?'
    );
    $st->execute([$groupeId, $pseudo, $saufUserId]);
    $trouves = $st->fetchAll();
    if ($trouves === []) {
        json_error('Aucun autre membre de ce groupe ne porte ce pseudo.', 404);
    }
    if (count($trouves) > 1) {
        json_error('Deux membres portent ce pseudo — demande à l\'un d\'eux d\'en changer, puis réessaie.', 409);
    }
    return $trouves[0];
}

/* ---- POST /api/groupes/{code}/coresponsables — nommer -------------------------- */

function handle_groupes_coresp_add(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    $groupeId = (int) $groupe['id'];
    // Nommer et retirer restent au responsable SEUL : une équipe ne se
    // co-opte pas elle-même, sinon le porteur perd la main sur son groupe.
    if (groupe_role($pdo, $groupeId, (int) $user['id']) !== 'responsable') {
        json_error('Seul le responsable du groupe nomme ses co-responsables.', 403);
    }
    $body = read_json_body();
    $pseudo = trim((string) ($body['pseudo'] ?? ''));
    if ($pseudo === '' || mb_strlen($pseudo) > 40) {
        json_error('Indique le pseudo du membre à nommer co-responsable.', 400);
    }
    $membre = groupe_membre_par_pseudo($pdo, $groupeId, $pseudo, (int) $user['id']);
    if ($membre['role'] === 'coresponsable') {
        json_error('Ce membre est déjà co-responsable.', 409);
    }
    $st = $pdo->prepare("SELECT COUNT(*) AS n FROM groupe_membres WHERE groupe_id = ? AND role = 'coresponsable'");
    $st->execute([$groupeId]);
    if ((int) $st->fetch()['n'] >= GROUPE_MAX_CORESPONSABLES) {
        json_error('Ce groupe a déjà ' . GROUPE_MAX_CORESPONSABLES . ' co-responsables — c\'est le maximum.', 400);
    }
    $pdo->prepare("UPDATE groupe_membres SET role = 'coresponsable' WHERE groupe_id = ? AND user_id = ?")
        ->execute([$groupeId, (int) $membre['id']]);
    json_out(['ok' => true]);
}

/* ---- DELETE /api/groupes/{code}/coresponsables/{pseudo} — retirer -------------- */

function handle_groupes_coresp_remove(PDO $pdo, string $rawCode, string $pseudo): never {
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    $groupeId = (int) $groupe['id'];
    if (groupe_role($pdo, $groupeId, (int) $user['id']) !== 'responsable') {
        json_error('Seul le responsable du groupe retire un co-responsable.', 403);
    }
    $membre = groupe_membre_par_pseudo($pdo, $groupeId, $pseudo, (int) $user['id']);
    if ($membre['role'] !== 'coresponsable') {
        json_error('Ce membre n\'est pas co-responsable.', 404);
    }
    // Il redevient simple membre — il ne perd jamais sa place dans le groupe.
    $pdo->prepare("UPDATE groupe_membres SET role = 'membre' WHERE groupe_id = ? AND user_id = ?")
        ->execute([$groupeId, (int) $membre['id']]);
    json_out(['ok' => true]);
}

/* ---- La passation de responsabilité --------------------------------------------- */

/**
 * L'entonnoir UNIQUE du changement de responsable : les deux écritures
 * (groupes.responsable_id et groupe_membres.role) ne se font jamais
 * ailleurs, et jamais séparément — sinon un groupe finirait avec deux
 * responsables, ou aucun. Utilisé par la passation volontaire ci-dessous
 * ET par l'héritage à la suppression d'un compte (auth.php).
 */
function groupe_set_responsable(PDO $pdo, int $groupeId, int $userId): void {
    $ownTx = !$pdo->inTransaction();
    if ($ownTx) $pdo->beginTransaction();
    try {
        $pdo->prepare('UPDATE groupes SET responsable_id = ? WHERE id = ?')
            ->execute([$userId, $groupeId]);
        $pdo->prepare("UPDATE groupe_membres SET role = 'membre' WHERE groupe_id = ? AND role = 'responsable'")
            ->execute([$groupeId]);
        $pdo->prepare("UPDATE groupe_membres SET role = 'responsable' WHERE groupe_id = ? AND user_id = ?")
            ->execute([$groupeId, $userId]);
        if ($ownTx) $pdo->commit();
    } catch (Throwable $e) {
        if ($ownTx) $pdo->rollBack();
        throw $e;
    }
}

/* ---- POST /api/groupes/{code}/passation — confier la responsabilité ------------- */

function handle_groupes_passation(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    $groupeId = (int) $groupe['id'];
    if (groupe_role($pdo, $groupeId, (int) $user['id']) !== 'responsable') {
        json_error('Seul le responsable du groupe peut transmettre la responsabilité.', 403);
    }

    // Le successeur se désigne par son pseudo — la seule identité que le
    // groupe expose (jamais d'e-mail, jamais d'identifiant technique).
    $body = read_json_body();
    $pseudo = trim((string) ($body['pseudo'] ?? ''));
    if ($pseudo === '' || mb_strlen($pseudo) > 40) {
        json_error('Indique le pseudo du membre à qui confier le groupe.', 400);
    }
    // Les pseudos ne sont pas uniques : la recherche refuse les homonymes
    // plutôt que de deviner (groupe_membre_par_pseudo).
    $successeur = groupe_membre_par_pseudo($pdo, $groupeId, $pseudo, (int) $user['id']);
    groupe_set_responsable($pdo, $groupeId, (int) $successeur['id']);

    // L'appelant est désormais simple membre : son nouveau regard sur le groupe.
    $st = $pdo->prepare('SELECT * FROM groupes WHERE id = ?');
    $st->execute([$groupeId]);
    json_out(['groupe' => groupe_payload($pdo, $st->fetch(), 'membre')]);
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
            // Pas d'assemblée sans berger : on transmet d'abord (la passation,
            // ci-dessus), on quitte ensuite.
            json_error(
                'Tu es responsable de ce groupe : confie d\'abord la responsabilité à un membre (depuis la liste des membres), puis quitte le groupe.',
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
    // Tout ou rien : une dizaine de tables sont touchées — un échec en cours
    // de route ne doit pas laisser de miettes rattachées à un groupe disparu.
    // (delete_user_completely appelle déjà sous transaction : on ne rouvre pas.)
    $ownTx = !$pdo->inTransaction();
    if ($ownTx) $pdo->beginTransaction();
    try {
        groupe_quiz_purge($pdo, $groupeId);
        groupe_banques_purge($pdo, $groupeId);      // banques des épreuves (groupes-banques.php)
        groupe_propositions_purge($pdo, $groupeId); // packs et chemins (groupes-propositions.php)
        $pdo->prepare(
            'DELETE FROM groupe_service_inscriptions
             WHERE service_id IN (SELECT id FROM groupe_services WHERE groupe_id = ?)'
        )->execute([$groupeId]);
        $pdo->prepare('DELETE FROM groupe_services WHERE groupe_id = ?')->execute([$groupeId]);
        $pdo->prepare('DELETE FROM groupe_rdv WHERE groupe_id = ?')->execute([$groupeId]);
        $pdo->prepare('DELETE FROM groupe_annonces WHERE groupe_id = ?')->execute([$groupeId]);
        $pdo->prepare('DELETE FROM groupe_membres WHERE groupe_id = ?')->execute([$groupeId]);
        $pdo->prepare('DELETE FROM groupes WHERE id = ?')->execute([$groupeId]);
        if ($ownTx) $pdo->commit();
    } catch (Throwable $e) {
        if ($ownTx) $pdo->rollBack();
        throw $e;
    }
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
