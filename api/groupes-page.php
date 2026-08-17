<?php
/* ============================================================================
   La page de l'église — FONDATIONS SERVEUR SEULEMENT (aucune interface).

   Chaque groupe-église a sa « page », trois blocs :
   - les ANNONCES : nouvelles de l'assemblée, épinglables en tête de page ;
   - les RENDEZ-VOUS réguliers : « Culte, dimanche 10:30 » — la semaine
     de l'assemblée, toujours sous les yeux ;
   - les SERVICES ponctuels : « Nettoyage de la salle, samedi » — chacun
     lève la main s'il le veut, dans la limite des places.

   L'esprit maison : le responsable NOURRIT, il ne surveille pas ; le
   service est VOLONTAIRE — on lève la main, on n'est pas réquisitionné.
   Les pseudos des inscrits sont visibles des membres — JAMAIS les e-mails.

   - GET    /api/groupes/{code}/page          : tout d'un coup (tout membre).
   - POST   /api/groupes/{code}/annonces      : créer/modifier (responsable).
   - DELETE /api/groupes/{code}/annonces/{id} : supprimer (responsable).
   - POST   /api/groupes/{code}/rdv           : créer/modifier (responsable).
   - DELETE /api/groupes/{code}/rdv/{id}      : supprimer (responsable).
   - POST   /api/groupes/{code}/services      : créer/modifier (responsable).
   - DELETE /api/groupes/{code}/services/{id} : supprimer, inscriptions comprises.
   - POST   /api/groupes/{code}/services/{id}/inscription : lever la main (tout membre).
   - DELETE /api/groupes/{code}/services/{id}/inscription : se retirer (tout membre).

   Lecture pour tout MEMBRE du groupe, écriture pour le RESPONSABLE seul —
   sauf l'inscription aux services, ouverte à tout membre. 403 sinon,
   404 groupe inconnu. À la suppression du groupe, la page part avec lui
   (groupe_delete_completely, groupes.php) ; à la suppression d'un compte,
   ses inscriptions sont retirées (delete_user_completely, auth.php).
   ========================================================================== */

defined('GRAINE_API') || exit;

const PAGE_MAX_ANNONCES        = 100; // par groupe — la page reste à taille humaine
const PAGE_ANNONCES_VISIBLES   = 50;  // servies sur la page : épinglées puis récentes
const PAGE_MAX_RDV             = 30;  // par groupe
const PAGE_MAX_SERVICES_AVENIR = 100; // services à venir par groupe
const SERVICE_PLACES_MAX       = 50;  // mains levées au plus par service
const SERVICE_RETENTION_JOURS  = 90;  // ménage des services passés

/* ---- Aides ------------------------------------------------------------------ */

/** Charge le groupe et exige d'en être membre. Retourne [groupe, role]. */
function page_load_membre(PDO $pdo, string $rawCode, array $user): array {
    $groupe = groupe_load($pdo, $rawCode); // 400 code mal formé, 404 inconnu
    $role = groupe_role($pdo, (int) $groupe['id'], (int) $user['id']);
    if ($role === null) {
        json_error('Réservé aux membres du groupe.', 403);
    }
    return [$groupe, $role];
}

/** Charge le groupe et exige d'avoir le droit de nourrir la page (responsable
    ou co-responsable — voir groupe_peut_animer dans groupes.php). */
function page_load_responsable(PDO $pdo, string $rawCode, array $user): array {
    [$groupe, $role] = page_load_membre($pdo, $rawCode, $user);
    if (!groupe_peut_animer($role)) {
        json_error('Seuls le responsable et ses co-responsables nourrissent la page.', 403);
    }
    return $groupe;
}

/**
 * Lit un champ texte du corps : trim, puis longueur entre $min et $max
 * (400 sinon). $min = 0 → champ facultatif : null s'il est vide ou absent.
 */
function page_read_texte(array $body, string $champ, int $min, int $max): ?string {
    $val = trim((string) ($body[$champ] ?? ''));
    if ($val === '' && $min === 0) {
        return null;
    }
    $len = mb_strlen($val);
    if ($len < max($min, 1) || $len > $max) {
        json_error(sprintf('Le champ « %s » doit faire entre %d et %d caractères.', $champ, max($min, 1), $max), 400);
    }
    return $val;
}

/** Lit l'id facultatif du corps (création sans id, modification avec). */
function page_read_id(array $body): ?int {
    if (!isset($body['id'])) {
        return null;
    }
    $id = filter_var($body['id'], FILTER_VALIDATE_INT);
    if ($id === false || $id < 1) {
        json_error('Identifiant invalide.', 400);
    }
    return $id;
}

/** Représentation publique d'une annonce (date = dernière retouche). */
function annonce_payload(array $a): array {
    return [
        'id'      => (int) $a['id'],
        'titre'   => $a['titre'],
        'texte'   => $a['texte'],
        'epingle' => (bool) $a['epingle'],
        'date'    => sql_to_iso($a['updated_at']),
    ];
}

/** Représentation publique d'un rendez-vous régulier. */
function rdv_payload(array $r): array {
    return [
        'id'      => (int) $r['id'],
        'libelle' => $r['libelle'],
        'jour'    => (int) $r['jour'],
        'heure'   => $r['heure'],
        'lieu'    => ($r['lieu'] === null || $r['lieu'] === '') ? null : $r['lieu'],
    ];
}

/**
 * Représentation publique d'un service : inscrits = pseudos, dans l'ordre
 * des mains levées — jamais les e-mails.
 */
function service_payload(PDO $pdo, array $s, int $userId): array {
    $st = $pdo->prepare(
        'SELECT u.pseudo, i.user_id
         FROM groupe_service_inscriptions i
         JOIN users u ON u.id = i.user_id
         WHERE i.service_id = ?
         ORDER BY i.created_at ASC, u.pseudo ASC'
    );
    $st->execute([(int) $s['id']]);
    return service_payload_avec($s, $st->fetchAll(), $userId);
}

/** Même représentation, à partir d'inscriptions déjà chargées (page entière). */
function service_payload_avec(array $s, array $rows, int $userId): array {
    $inscrits = [];
    $jeSuisInscrit = false;
    foreach ($rows as $row) {
        $inscrits[] = $row['pseudo'];
        if ((int) $row['user_id'] === $userId) {
            $jeSuisInscrit = true;
        }
    }
    return [
        'id'            => (int) $s['id'],
        'titre'         => $s['titre'],
        'date'          => $s['date_service'],
        'details'       => ($s['details'] === null || $s['details'] === '') ? null : $s['details'],
        'places'        => (int) $s['places'],
        'inscrits'      => $inscrits,
        'jeSuisInscrit' => $jeSuisInscrit,
    ];
}

/** Charge un service de CE groupe (404 sinon). */
function service_load(PDO $pdo, int $groupeId, int $serviceId): array {
    $st = $pdo->prepare('SELECT * FROM groupe_services WHERE id = ? AND groupe_id = ?');
    $st->execute([$serviceId, $groupeId]);
    $service = $st->fetch();
    if ($service === false) {
        json_error('Service introuvable dans ce groupe.', 404);
    }
    return $service;
}

/**
 * Ménage opportuniste (appelé à chaque lecture de page) : les services dont
 * la date est passée depuis plus de 90 jours partent, inscriptions comprises.
 */
function services_menage(PDO $pdo): void {
    $limite = gmdate('Y-m-d', time() - SERVICE_RETENTION_JOURS * 86400);
    $pdo->prepare(
        'DELETE FROM groupe_service_inscriptions
         WHERE service_id IN (SELECT id FROM groupe_services WHERE date_service < ?)'
    )->execute([$limite]);
    $pdo->prepare('DELETE FROM groupe_services WHERE date_service < ?')->execute([$limite]);
}

/* ---- GET /api/groupes/{code}/page — tout d'un coup ---------------------------- */

function handle_groupe_page(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    [$groupe] = page_load_membre($pdo, $rawCode, $user);
    $groupeId = (int) $groupe['id'];

    services_menage($pdo);

    // Annonces : les épinglées d'abord, puis des plus récentes aux plus anciennes.
    $st = $pdo->prepare(
        'SELECT * FROM groupe_annonces WHERE groupe_id = ?
         ORDER BY epingle DESC, id DESC LIMIT ' . PAGE_ANNONCES_VISIBLES
    );
    $st->execute([$groupeId]);
    $annonces = array_map('annonce_payload', $st->fetchAll());

    // Rendez-vous : la semaine dans l'ordre (0 = dimanche), puis l'heure.
    $st = $pdo->prepare(
        'SELECT * FROM groupe_rdv WHERE groupe_id = ?
         ORDER BY jour ASC, heure ASC, ordre ASC, id ASC'
    );
    $st->execute([$groupeId]);
    $rdv = array_map('rdv_payload', $st->fetchAll());

    // Services : à venir seulement (aujourd'hui compris), du plus proche au
    // plus lointain.
    $st = $pdo->prepare(
        'SELECT * FROM groupe_services WHERE groupe_id = ? AND date_service >= ?
         ORDER BY date_service ASC, id ASC'
    );
    $st->execute([$groupeId, gmdate('Y-m-d')]);
    $rows = $st->fetchAll();

    // Toutes les inscriptions de ces services en UNE requête (au lieu d'une
    // par service — jusqu'à 100 sur une page bien remplie).
    $parService = [];
    if ($rows !== []) {
        $ids = array_map(static fn (array $r): int => (int) $r['id'], $rows);
        $marques = implode(',', array_fill(0, count($ids), '?'));
        $st = $pdo->prepare(
            'SELECT i.service_id, u.pseudo, i.user_id
             FROM groupe_service_inscriptions i
             JOIN users u ON u.id = i.user_id
             WHERE i.service_id IN (' . $marques . ')
             ORDER BY i.created_at ASC, u.pseudo ASC'
        );
        $st->execute($ids);
        foreach ($st->fetchAll() as $ins) {
            $parService[(int) $ins['service_id']][] = $ins;
        }
    }
    $services = [];
    foreach ($rows as $row) {
        $services[] = service_payload_avec($row, $parService[(int) $row['id']] ?? [], (int) $user['id']);
    }

    json_out(['annonces' => $annonces, 'rdv' => $rdv, 'services' => $services]);
}

/* ---- POST /api/groupes/{code}/annonces — créer ou modifier -------------------- */

function handle_groupe_annonce_save(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = page_load_responsable($pdo, $rawCode, $user);
    $body = read_json_body();

    $titre = page_read_texte($body, 'titre', 1, 80);
    $texte = page_read_texte($body, 'texte', 1, 2000);
    $epingle = empty($body['epingle']) ? 0 : 1;
    $id = page_read_id($body);

    if ($id === null) {
        // Création — plafonnée pour que la page reste à taille humaine.
        $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_annonces WHERE groupe_id = ?');
        $st->execute([$groupe['id']]);
        if ((int) $st->fetch()['n'] >= PAGE_MAX_ANNONCES) {
            json_error('Ce groupe a déjà ' . PAGE_MAX_ANNONCES . ' annonces — supprime d\'abord les plus anciennes.', 400);
        }
        $st = $pdo->prepare(
            'INSERT INTO groupe_annonces (groupe_id, titre, texte, epingle, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        $st->execute([$groupe['id'], $titre, $texte, $epingle, now_sql(), now_sql()]);
        $id = (int) $pdo->lastInsertId();
        $status = 201;
    } else {
        // Modification : l'annonce doit appartenir à CE groupe.
        $st = $pdo->prepare('SELECT 1 FROM groupe_annonces WHERE id = ? AND groupe_id = ?');
        $st->execute([$id, $groupe['id']]);
        if ($st->fetch() === false) {
            json_error('Annonce introuvable dans ce groupe.', 404);
        }
        $st = $pdo->prepare(
            'UPDATE groupe_annonces SET titre = ?, texte = ?, epingle = ?, updated_at = ? WHERE id = ?'
        );
        $st->execute([$titre, $texte, $epingle, now_sql(), $id]);
        $status = 200;
    }

    $st = $pdo->prepare('SELECT * FROM groupe_annonces WHERE id = ?');
    $st->execute([$id]);
    json_out(['annonce' => annonce_payload($st->fetch())], $status);
}

/* ---- DELETE /api/groupes/{code}/annonces/{id} ---------------------------------- */

function handle_groupe_annonce_delete(PDO $pdo, string $rawCode, int $id): never {
    $user = require_user($pdo);
    $groupe = page_load_responsable($pdo, $rawCode, $user);
    $st = $pdo->prepare('DELETE FROM groupe_annonces WHERE id = ? AND groupe_id = ?');
    $st->execute([$id, $groupe['id']]);
    if ($st->rowCount() === 0) {
        json_error('Annonce introuvable dans ce groupe.', 404);
    }
    json_out(['ok' => true]);
}

/* ---- POST /api/groupes/{code}/rdv — créer ou modifier -------------------------- */

function handle_groupe_rdv_save(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = page_load_responsable($pdo, $rawCode, $user);
    $body = read_json_body();

    $libelle = page_read_texte($body, 'libelle', 1, 80);
    $jour = filter_var($body['jour'] ?? null, FILTER_VALIDATE_INT);
    if ($jour === false || $jour < 0 || $jour > 6) {
        json_error('Le jour doit être un nombre entre 0 (dimanche) et 6 (samedi).', 400);
    }
    $heure = trim((string) ($body['heure'] ?? ''));
    if (!preg_match('/^([01][0-9]|2[0-3]):[0-5][0-9]$/', $heure)) {
        json_error("L'heure doit être au format HH:MM (ex. 10:30).", 400);
    }
    $lieu = page_read_texte($body, 'lieu', 0, 80);
    $ordre = filter_var($body['ordre'] ?? 0, FILTER_VALIDATE_INT);
    if ($ordre === false || $ordre < 0 || $ordre > 999) {
        json_error("L'ordre d'affichage doit être un nombre entre 0 et 999.", 400);
    }
    $id = page_read_id($body);

    if ($id === null) {
        $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_rdv WHERE groupe_id = ?');
        $st->execute([$groupe['id']]);
        if ((int) $st->fetch()['n'] >= PAGE_MAX_RDV) {
            json_error('Ce groupe a déjà ' . PAGE_MAX_RDV . ' rendez-vous réguliers — c\'est le maximum.', 400);
        }
        $st = $pdo->prepare(
            'INSERT INTO groupe_rdv (groupe_id, libelle, jour, heure, lieu, ordre)
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        $st->execute([$groupe['id'], $libelle, $jour, $heure, $lieu, $ordre]);
        $id = (int) $pdo->lastInsertId();
        $status = 201;
    } else {
        $st = $pdo->prepare('SELECT 1 FROM groupe_rdv WHERE id = ? AND groupe_id = ?');
        $st->execute([$id, $groupe['id']]);
        if ($st->fetch() === false) {
            json_error('Rendez-vous introuvable dans ce groupe.', 404);
        }
        $st = $pdo->prepare(
            'UPDATE groupe_rdv SET libelle = ?, jour = ?, heure = ?, lieu = ?, ordre = ? WHERE id = ?'
        );
        $st->execute([$libelle, $jour, $heure, $lieu, $ordre, $id]);
        $status = 200;
    }

    $st = $pdo->prepare('SELECT * FROM groupe_rdv WHERE id = ?');
    $st->execute([$id]);
    json_out(['rdv' => rdv_payload($st->fetch())], $status);
}

/* ---- DELETE /api/groupes/{code}/rdv/{id} ---------------------------------------- */

function handle_groupe_rdv_delete(PDO $pdo, string $rawCode, int $id): never {
    $user = require_user($pdo);
    $groupe = page_load_responsable($pdo, $rawCode, $user);
    $st = $pdo->prepare('DELETE FROM groupe_rdv WHERE id = ? AND groupe_id = ?');
    $st->execute([$id, $groupe['id']]);
    if ($st->rowCount() === 0) {
        json_error('Rendez-vous introuvable dans ce groupe.', 404);
    }
    json_out(['ok' => true]);
}

/* ---- POST /api/groupes/{code}/services — créer ou modifier ---------------------- */

function handle_groupe_service_save(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = page_load_responsable($pdo, $rawCode, $user);
    $body = read_json_body();

    $titre = page_read_texte($body, 'titre', 1, 80);
    $date = trim((string) ($body['date'] ?? ''));
    if (!preg_match('/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/', $date, $m)
        || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
        json_error('La date doit être un jour valide au format AAAA-MM-JJ.', 400);
    }
    // Un service ne se programme pas dans le passé (à la modification non
    // plus : il disparaîtrait aussitôt de la page — voir le tri « à venir »).
    if ($date < gmdate('Y-m-d')) {
        json_error('La date du service est déjà passée.', 400);
    }
    $details = page_read_texte($body, 'details', 0, 500);
    $places = filter_var($body['places'] ?? null, FILTER_VALIDATE_INT);
    if ($places === false || $places < 1 || $places > SERVICE_PLACES_MAX) {
        json_error('Le nombre de places doit être entre 1 et ' . SERVICE_PLACES_MAX . '.', 400);
    }
    $id = page_read_id($body);

    if ($id === null) {
        $st = $pdo->prepare(
            'SELECT COUNT(*) AS n FROM groupe_services WHERE groupe_id = ? AND date_service >= ?'
        );
        $st->execute([$groupe['id'], gmdate('Y-m-d')]);
        if ((int) $st->fetch()['n'] >= PAGE_MAX_SERVICES_AVENIR) {
            json_error('Ce groupe a déjà ' . PAGE_MAX_SERVICES_AVENIR . ' services à venir — c\'est le maximum.', 400);
        }
        $st = $pdo->prepare(
            'INSERT INTO groupe_services (groupe_id, titre, date_service, details, places, created_at)
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        $st->execute([$groupe['id'], $titre, $date, $details, $places, now_sql()]);
        $id = (int) $pdo->lastInsertId();
        $status = 201;
    } else {
        service_load($pdo, (int) $groupe['id'], $id); // 404 si pas de ce groupe
        // On ne réduit jamais les places sous le nombre de mains déjà levées.
        $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_service_inscriptions WHERE service_id = ?');
        $st->execute([$id]);
        $inscrits = (int) $st->fetch()['n'];
        if ($places < $inscrits) {
            json_error(sprintf('%d personnes ont déjà levé la main — impossible de descendre en dessous.', $inscrits), 400);
        }
        $st = $pdo->prepare(
            'UPDATE groupe_services SET titre = ?, date_service = ?, details = ?, places = ? WHERE id = ?'
        );
        $st->execute([$titre, $date, $details, $places, $id]);
        $status = 200;
    }

    $st = $pdo->prepare('SELECT * FROM groupe_services WHERE id = ?');
    $st->execute([$id]);
    json_out(['service' => service_payload($pdo, $st->fetch(), (int) $user['id'])], $status);
}

/* ---- DELETE /api/groupes/{code}/services/{id} ------------------------------------ */

function handle_groupe_service_delete(PDO $pdo, string $rawCode, int $id): never {
    $user = require_user($pdo);
    $groupe = page_load_responsable($pdo, $rawCode, $user);
    service_load($pdo, (int) $groupe['id'], $id); // 404 si pas de ce groupe
    // Les inscriptions partent avec le service.
    $pdo->prepare('DELETE FROM groupe_service_inscriptions WHERE service_id = ?')->execute([$id]);
    $pdo->prepare('DELETE FROM groupe_services WHERE id = ?')->execute([$id]);
    json_out(['ok' => true]);
}

/* ---- POST /api/groupes/{code}/services/{id}/inscription — lever la main ---------- */

function handle_groupe_service_inscription(PDO $pdo, string $rawCode, int $serviceId): never {
    $user = require_user($pdo);
    [$groupe] = page_load_membre($pdo, $rawCode, $user); // TOUT membre peut lever la main
    $service = service_load($pdo, (int) $groupe['id'], $serviceId);

    if ($service['date_service'] < gmdate('Y-m-d')) {
        json_error('Ce service est déjà passé.', 400);
    }
    $st = $pdo->prepare('SELECT 1 FROM groupe_service_inscriptions WHERE service_id = ? AND user_id = ?');
    $st->execute([$serviceId, $user['id']]);
    if ($st->fetch() !== false) {
        json_error('Tu es déjà inscrit à ce service.', 409);
    }
    $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_service_inscriptions WHERE service_id = ?');
    $st->execute([$serviceId]);
    if ((int) $st->fetch()['n'] >= (int) $service['places']) {
        json_error('Ce service est déjà complet — merci d\'avoir levé la main !', 409);
    }

    $st = $pdo->prepare(
        'INSERT INTO groupe_service_inscriptions (service_id, user_id, created_at) VALUES (?, ?, ?)'
    );
    $st->execute([$serviceId, $user['id'], now_sql()]);
    json_out(['service' => service_payload($pdo, $service, (int) $user['id'])]);
}

/* ---- DELETE /api/groupes/{code}/services/{id}/inscription — se retirer ------------ */

function handle_groupe_service_desinscription(PDO $pdo, string $rawCode, int $serviceId): never {
    $user = require_user($pdo);
    [$groupe] = page_load_membre($pdo, $rawCode, $user);
    $service = service_load($pdo, (int) $groupe['id'], $serviceId);

    $st = $pdo->prepare('DELETE FROM groupe_service_inscriptions WHERE service_id = ? AND user_id = ?');
    $st->execute([$serviceId, $user['id']]);
    if ($st->rowCount() === 0) {
        json_error("Tu n'es pas inscrit à ce service.", 404);
    }
    json_out(['service' => service_payload($pdo, $service, (int) $user['id'])]);
}
