<?php
/* ============================================================================
   Demandes de groupe d'église — la création n'est plus libre.

   L'esprit : un groupe d'église engage toute une assemblée ; sa création se
   demande (le nom souhaité, l'adresse de l'église, et un e-mail de contact
   si différent de celui du compte) et seule l'administration l'accepte — le
   groupe naît alors, le demandeur en devient responsable — ou la refuse.
   UNE demande par compte à la fois ; une demande refusée est REMPLACÉE par
   la suivante, jamais un mur définitif.

   Les détails (adresse, e-mail de contact) vivent dans la table COMPAGNE
   groupe_demande_details (pas d'ALTER sur groupe_demandes déjà déployée) :
   la ligne suit la demande dans tout son cycle — écrite au dépôt, remplacée
   avec une refusée, effacée à l'annulation et à l'acceptation (restaurée si
   la création du groupe échoue), CONSERVÉE au refus.

   Côté compte :
   - POST   /api/groupes/demande : déposer sa demande (201).
   - GET    /api/groupes/demande : où en est ma demande (null si aucune).
   - DELETE /api/groupes/demande : l'annuler (efface aussi une refusée).

   Côté administration (require_admin) :
   - GET  /api/admin/eglises                        : demandes en attente + groupes.
   - POST /api/admin/eglises/demandes/{id}/accepter : le groupe naît (voir
          groupe_creer dans groupes.php), la demande disparaît.
   - POST /api/admin/eglises/demandes/{id}/refuser  : statut 'refusee'.

   Les e-mails des demandeurs ne sortent QUE vers l'administration (qui voit
   déjà les comptes) — jamais dans les réponses côté compte.
   ========================================================================== */

defined('GRAINE_API') || exit;

/* ---- Aides ------------------------------------------------------------------ */

/** La demande de ce compte (une seule à la fois), détails compris, ou null. */
function groupe_demande_de(PDO $pdo, int $userId): ?array {
    $st = $pdo->prepare(
        'SELECT d.*, det.adresse, det.email AS email_contact
         FROM groupe_demandes d
         LEFT JOIN groupe_demande_details det ON det.demande_id = d.id
         WHERE d.user_id = ?'
    );
    $st->execute([$userId]);
    $demande = $st->fetch();
    return $demande === false ? null : $demande;
}

/** Payload « demande » côté compte : nom, adresse, email, statut, createdAt — jamais d'id. */
function groupe_demande_payload(array $demande): array {
    return [
        'nom'       => $demande['nom'],
        'adresse'   => $demande['adresse'],
        'email'     => $demande['email_contact'],
        'statut'    => $demande['statut'],
        'createdAt' => sql_to_iso($demande['created_at']),
    ];
}

/** Adresse de l'église : texte libre, 5 à 120 caractères après trim, ou null. */
function groupe_demande_adresse(mixed $adresse): ?string {
    if (!is_string($adresse)) {
        return null;
    }
    $adresse = trim($adresse);
    $length = mb_strlen($adresse);
    return ($length < 5 || $length > 120) ? null : $adresse;
}

/** Efface la ligne compagne (détails) d'une demande. */
function groupe_demande_details_effacer(PDO $pdo, int $demandeId): void {
    $pdo->prepare('DELETE FROM groupe_demande_details WHERE demande_id = ?')->execute([$demandeId]);
}

/** Nombre de groupes dont ce compte est responsable (plafond anti-abus). */
function groupe_nb_en_responsable(PDO $pdo, int $userId): int {
    $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupes WHERE responsable_id = ?');
    $st->execute([$userId]);
    return (int) $st->fetch()['n'];
}

/* ---- POST /api/groupes/demande — déposer sa demande --------------------------- */

function handle_groupe_demande_create(PDO $pdo): never {
    $user = require_user($pdo);
    // Une demande à la fois par compte, mais annuler/redéposer en boucle
    // resterait gratuit : le plafond horaire par IP ferme cette porte-là.
    throttle_or_429($pdo, 'groupe-demande', 30);
    $body = read_json_body();
    $nom = validate_group_name($body['nom'] ?? null);
    if ($nom === null) {
        json_error('Nom de groupe invalide : 2 à 40 caractères (lettres, chiffres, espaces, tirets ou apostrophes).', 400);
    }
    // L'adresse de l'église est OBLIGATOIRE : elle aide l'administration à
    // juger que la demande porte bien une assemblée réelle.
    $adresse = groupe_demande_adresse($body['adresse'] ?? null);
    if ($adresse === null) {
        json_error('Adresse de l\'église invalide : 5 à 120 caractères.', 400);
    }
    // E-mail de contact FACULTATIF (si différent de celui du compte) —
    // mêmes règles qu'à la connexion (auth_read_email, auth.php).
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    if ($email === '') {
        $email = null;
    } elseif (strlen($email) > 255 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        json_error('Adresse e-mail invalide.', 400);
    }

    // Même plafond qu'à l'acceptation : inutile de laisser mûrir une demande
    // condamnée d'avance.
    if (groupe_nb_en_responsable($pdo, (int) $user['id']) >= GROUPE_MAX_PAR_RESPONSABLE) {
        json_error('Tu es déjà responsable de ' . GROUPE_MAX_PAR_RESPONSABLE . ' groupes — c\'est le maximum.', 409);
    }

    $existante = groupe_demande_de($pdo, (int) $user['id']);
    if ($existante !== null && $existante['statut'] === 'attente') {
        json_error('Ta demande « ' . $existante['nom'] . ' » est déjà en attente — une seule à la fois.', 409);
    }
    // Une demande refusée est REMPLACÉE par la nouvelle : on repart propre
    // — ses détails aussi.
    if ($existante !== null) {
        $pdo->prepare('DELETE FROM groupe_demandes WHERE id = ?')->execute([$existante['id']]);
        groupe_demande_details_effacer($pdo, (int) $existante['id']);
    }

    $st = $pdo->prepare(
        'INSERT INTO groupe_demandes (user_id, nom, statut, created_at) VALUES (?, ?, \'attente\', ?)'
    );
    $st->execute([$user['id'], $nom, now_sql()]);
    $pdo->prepare('INSERT INTO groupe_demande_details (demande_id, adresse, email) VALUES (?, ?, ?)')
        ->execute([(int) $pdo->lastInsertId(), $adresse, $email]);

    json_out(['demande' => [
        'nom'       => $nom,
        'adresse'   => $adresse,
        'email'     => $email,
        'statut'    => 'attente',
        'createdAt' => sql_to_iso(now_sql()),
    ]], 201);
}

/* ---- GET /api/groupes/demande — où en est ma demande --------------------------- */

function handle_groupe_demande_get(PDO $pdo): never {
    $user = require_user($pdo);
    $demande = groupe_demande_de($pdo, (int) $user['id']);
    json_out(['demande' => $demande === null ? null : groupe_demande_payload($demande)]);
}

/* ---- DELETE /api/groupes/demande — annuler (ou effacer une refusée) ------------- */

function handle_groupe_demande_delete(PDO $pdo): never {
    $user = require_user($pdo);
    $demande = groupe_demande_de($pdo, (int) $user['id']);
    if ($demande === null) {
        json_error('Aucune demande à annuler.', 404);
    }
    $pdo->prepare('DELETE FROM groupe_demandes WHERE id = ?')->execute([$demande['id']]);
    groupe_demande_details_effacer($pdo, (int) $demande['id']);
    json_out(['ok' => true]);
}

/* ---- GET /api/admin/eglises — demandes en attente + groupes existants ----------- */

function handle_admin_eglises(PDO $pdo): never {
    require_admin($pdo);

    // Les demandes en attente, les plus anciennes d'abord (ordre d'arrivée),
    // avec leurs détails (adresse, e-mail de contact) pour juger sur pièces.
    $demandes = [];
    $st = $pdo->query(
        'SELECT d.id, d.nom, d.created_at, u.pseudo, u.email,
                det.adresse, det.email AS email_contact
         FROM groupe_demandes d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN groupe_demande_details det ON det.demande_id = d.id
         WHERE d.statut = \'attente\'
         ORDER BY d.id ASC'
    );
    foreach ($st->fetchAll() as $row) {
        // emailContact : null si identique à celui du compte (ou absent) —
        // l'admin ne voit un second e-mail que s'il apporte quelque chose.
        $contact = $row['email_contact'];
        if ($contact !== null && $contact === strtolower((string) $row['email'])) {
            $contact = null;
        }
        $demandes[] = [
            'id'           => (int) $row['id'],
            'nom'          => $row['nom'],
            'adresse'      => $row['adresse'],
            'emailContact' => $contact,
            'pseudo'       => $row['pseudo'],
            'email'        => $row['email'],
            'createdAt'    => sql_to_iso($row['created_at']),
        ];
    }

    // Tous les groupes existants, les plus récents d'abord.
    $groupes = [];
    $st = $pdo->query(
        'SELECT g.code, g.nom, g.created_at, u.pseudo AS responsable,
                (SELECT COUNT(*) FROM groupe_membres m WHERE m.groupe_id = g.id) AS nb
         FROM groupes g
         JOIN users u ON u.id = g.responsable_id
         ORDER BY g.id DESC'
    );
    foreach ($st->fetchAll() as $row) {
        $groupes[] = [
            'code'        => $row['code'],
            'nom'         => $row['nom'],
            'nbMembres'   => (int) $row['nb'],
            'responsable' => $row['responsable'],
            'createdAt'   => sql_to_iso($row['created_at']),
        ];
    }

    json_out(['demandes' => $demandes, 'groupes' => $groupes]);
}

/** Charge une demande EN ATTENTE par id (404 sinon — inconnue ou déjà tranchée). */
function groupe_demande_en_attente(PDO $pdo, int $id): array {
    $st = $pdo->prepare(
        'SELECT d.*, det.adresse, det.email AS email_contact
         FROM groupe_demandes d
         LEFT JOIN groupe_demande_details det ON det.demande_id = d.id
         WHERE d.id = ? AND d.statut = \'attente\''
    );
    $st->execute([$id]);
    $demande = $st->fetch();
    if ($demande === false) {
        json_error('Demande introuvable — déjà tranchée, ou annulée par son porteur.', 404);
    }
    return $demande;
}

/* ---- POST /api/admin/eglises/demandes/{id}/accepter — le groupe naît ------------ */

function handle_admin_eglise_accepter(PDO $pdo, int $id): never {
    $admin = require_admin($pdo);
    $demande = groupe_demande_en_attente($pdo, $id);

    // Le plafond se revérifie ICI : le demandeur a pu devenir responsable
    // d'autres groupes depuis le dépôt. Refus doux, demande conservée.
    if (groupe_nb_en_responsable($pdo, (int) $demande['user_id']) >= GROUPE_MAX_PAR_RESPONSABLE) {
        json_error('Ce compte est déjà responsable de ' . GROUPE_MAX_PAR_RESPONSABLE . ' groupes — c\'est le maximum.', 409);
    }

    // La demande est REVENDIQUÉE d'abord, par une suppression conditionnelle :
    // deux administrateurs qui acceptent en même temps ne peuvent pas créer
    // deux groupes — un seul DELETE gagne, l'autre reçoit un 404. Si la
    // création échoue ensuite, la demande est remise en place.
    $st = $pdo->prepare("DELETE FROM groupe_demandes WHERE id = ? AND statut = 'attente'");
    $st->execute([$demande['id']]);
    if ($st->rowCount() === 0) {
        json_error('Cette demande vient déjà d\'être tranchée.', 404);
    }
    // La ligne compagne suit la demande : effacée avec elle (ses détails,
    // chargés plus haut, restent sous la main pour le rattrapage ci-dessous).
    groupe_demande_details_effacer($pdo, (int) $demande['id']);
    try {
        // Même mécanique que l'ancienne création directe : code GRP- unique,
        // demandeur responsable (groupe_creer, groupes.php).
        $groupe = groupe_creer($pdo, (int) $demande['user_id'], (string) $demande['nom']);
    } catch (Throwable $e) {
        // Rattrapage : la demande est remise en place, détails compris
        // (nouvel id auto-généré — une demande d'avant la table compagne
        // n'a pas de détails, adresse null, rien à restaurer).
        $pdo->prepare('INSERT INTO groupe_demandes (user_id, nom, statut, created_at) VALUES (?, ?, ?, ?)')
            ->execute([(int) $demande['user_id'], (string) $demande['nom'], 'attente', (string) $demande['created_at']]);
        if ($demande['adresse'] !== null) {
            $pdo->prepare('INSERT INTO groupe_demande_details (demande_id, adresse, email) VALUES (?, ?, ?)')
                ->execute([(int) $pdo->lastInsertId(), $demande['adresse'], $demande['email_contact']]);
        }
        throw $e;
    }

    admin_log($pdo, $admin, 'eglise.acceptation', $groupe['code'] . ' — ' . $groupe['nom']);
    json_out(['code' => $groupe['code'], 'nom' => $groupe['nom']]);
}

/* ---- POST /api/admin/eglises/demandes/{id}/refuser — statut 'refusee' ----------- */

function handle_admin_eglise_refuser(PDO $pdo, int $id): never {
    $admin = require_admin($pdo);
    $demande = groupe_demande_en_attente($pdo, $id);

    // Le refus n'efface pas : le porteur le voit (GET), et sa PROCHAINE
    // demande remplacera celle-ci.
    $pdo->prepare('UPDATE groupe_demandes SET statut = \'refusee\' WHERE id = ?')
        ->execute([$demande['id']]);

    admin_log($pdo, $admin, 'eglise.refus', $demande['nom']);
    json_out(['ok' => true]);
}
