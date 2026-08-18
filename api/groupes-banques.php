<?php
/* ============================================================================
   Les SÉRIES de questions d'une église — quiadit, ecritoupas, portrait.

   Une église n'écrase plus la banque commune : elle propose des SÉRIES
   nommées (« Prédication du 10 août — Jonas ») que le joueur CHOISIT au
   lancement. La banque commune reste toujours là, par défaut. Ajouter des
   questions n'en retire donc jamais : c'était le défaut du modèle précédent
   (mode « toutes » / « ma sélection »), que ce fichier remplace.

   Trois états :
     - brouillon : invisible des membres — on écrit en plusieurs fois ;
     - publiee   : jouable, et comptée sous le plafond des séries visibles ;
     - archivee  : rangée, jamais perdue. Archiver libère une place ; rien
                   n'oblige jamais à détruire le travail d'un bénévole.

   - GET    /api/groupes/{code}/series/{module}                    : la liste.
   - POST   /api/groupes/{code}/series/{module}                    : créer.
   - PATCH  /api/groupes/{code}/series/{module}/{id}               : renommer, changer d'état.
   - DELETE /api/groupes/{code}/series/{module}/{id}               : supprimer (avec ses items).
   - POST   /api/groupes/{code}/series/{module}/{id}/items         : créer ou modifier un item.
   - DELETE /api/groupes/{code}/series/{module}/{id}/items/{itemId}: supprimer un item.
   - GET    /api/groupes/{code}/series/{module}/{id}/items         : JOUER la série.

   Qui voit quoi : l'écriture et les brouillons sont réservés au responsable
   et à ses co-responsables (403 sinon) ; un MEMBRE lit la liste des séries
   publiées et leurs items, faute de quoi il ne pourrait pas y jouer. Les
   items portent la bonne réponse — c'est déjà le cas de la banque commune,
   qui est publique : le risque de triche est le même, et il est assumé.

   L'église répond de ce qu'elle publie. Le serveur ne juge pas le fond : il
   se contente d'AVERTIR quand une parole citée ne se trouve pas à sa
   référence (segond.php), sans jamais refuser.

   Tables : groupe_series et groupe_banque_items (étapes 2 et 6, db.php).
   ========================================================================== */

defined('GRAINE_API') || exit;

const GROUPE_SERIE_MAX_PUBLIEES = 8;    // séries visibles à la fois, par épreuve
const GROUPE_SERIE_MAX_TOTAL    = 40;   // séries par épreuve, tous états confondus
const GROUPE_SERIE_MIN_ITEMS    = 3;    // en dessous, une série ne se publie pas
const GROUPE_SERIE_MAX_ITEMS    = 50;   // items dans une série
const GROUPE_EGLISE_MAX_ITEMS   = 600;  // items d'une église, TOUTES épreuves
const GROUPE_SERIE_NOM_MAX      = 80;

const GROUPE_SERIE_ETATS = ['brouillon', 'publiee', 'archivee'];

/* ---- Accès ------------------------------------------------------------------- */

/** Module connu (404) + utilisateur (401) + groupe (404). */
function groupe_serie_contexte(PDO $pdo, string $rawCode, string $module): array {
    if (!isset(BANQUE_MODULES[$module])) {
        json_error('Banque inconnue : ' . $module, 404);
    }
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    $role = groupe_role($pdo, (int) $groupe['id'], (int) $user['id']);
    return [$groupe, $role];
}

/** Responsable ou co-responsable — seuls à écrire et à voir les brouillons. */
function groupe_banque_responsable(PDO $pdo, string $rawCode, string $module): array {
    [$groupe, $role] = groupe_serie_contexte($pdo, $rawCode, $module);
    if (!groupe_peut_animer($role)) {
        json_error('Seuls le responsable et ses co-responsables tiennent les séries de leur église.', 403);
    }
    return $groupe;
}

/** Membre du groupe, quel que soit son rôle — pour lire et jouer les séries. */
function groupe_serie_membre(PDO $pdo, string $rawCode, string $module): array {
    [$groupe, $role] = groupe_serie_contexte($pdo, $rawCode, $module);
    if ($role === null) {
        json_error('Il faut être membre de cette église pour voir ses séries.', 403);
    }
    return [$groupe, groupe_peut_animer($role)];
}

/* ---- Aides ------------------------------------------------------------------- */

/** Une série du groupe, ou 404. Le couple (groupe, module) est toujours revérifié. */
function groupe_serie_charger(PDO $pdo, int $groupeId, string $module, int $serieId): array {
    $st = $pdo->prepare('SELECT * FROM groupe_series WHERE id = ? AND groupe_id = ? AND module = ?');
    $st->execute([$serieId, $groupeId, $module]);
    $row = $st->fetch();
    if ($row === false) {
        json_error('Série introuvable dans cette église.', 404);
    }
    return $row;
}

function groupe_serie_nb_items(PDO $pdo, int $serieId): int {
    $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_banque_items WHERE serie_id = ?');
    $st->execute([$serieId]);
    return (int) $st->fetch()['n'];
}

function groupe_serie_nb_publiees(PDO $pdo, int $groupeId, string $module, int $sauf = 0): int {
    $st = $pdo->prepare(
        'SELECT COUNT(*) AS n FROM groupe_series
         WHERE groupe_id = ? AND module = ? AND etat = ? AND id <> ?'
    );
    $st->execute([$groupeId, $module, 'publiee', $sauf]);
    return (int) $st->fetch()['n'];
}

/** Items d'une église, toutes épreuves — pour le plafond global. */
function groupe_serie_nb_items_eglise(PDO $pdo, int $groupeId): int {
    $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_banque_items WHERE groupe_id = ?');
    $st->execute([$groupeId]);
    return (int) $st->fetch()['n'];
}

function groupe_serie_publique(array $row, int $nbItems): array {
    return [
        'id'        => (int) $row['id'],
        'nom'       => (string) $row['nom'],
        'etat'      => (string) $row['etat'],
        'nbItems'   => $nbItems,
        'jouable'   => $nbItems >= GROUPE_SERIE_MIN_ITEMS,
        'creee'     => (string) $row['created_at'],
        'publiee'   => $row['publiee_at'] !== null ? (string) $row['publiee_at'] : null,
    ];
}

/** Les items d'une série, au format des pages d'épreuve. */
function groupe_serie_items(PDO $pdo, int $serieId): array {
    $st = $pdo->prepare(
        'SELECT item_id, item FROM groupe_banque_items
         WHERE serie_id = ? ORDER BY created_at ASC, item_id ASC'
    );
    $st->execute([$serieId]);
    $items = [];
    foreach ($st->fetchAll() as $row) {
        $item = json_decode((string) $row['item'], true);
        if (is_array($item)) {
            $items[] = ['id' => (string) $row['item_id']] + $item;
        }
    }
    return $items;
}

/**
 * Avertissement de conformité au texte — jamais un refus. Renvoie null quand
 * il n'y a rien à dire OU quand la référence n'est pas lisible : on ne crie
 * pas au loup pour une abréviation qu'on ne sait pas résoudre.
 */
function groupe_serie_avertissement(string $module, array $item): ?string {
    $ref = $item['reference'] ?? null;
    if (!is_string($ref) || $ref === '') {
        return null;
    }
    $extrait = null;
    if ($module === 'quiadit') {
        $extrait = $item['parole'] ?? null;
    } elseif ($module === 'ecritoupas' && ($item['ecrit'] ?? false) === true) {
        $extrait = $item['phrase'] ?? null;
    }
    if (!is_string($extrait) || $extrait === '') {
        return null;
    }
    return segond_contient($ref, $extrait) === false
        ? 'Cette parole ne se trouve pas en ' . $ref . ' dans la Segond 1910. '
          . 'La question est enregistrée — vérifie la référence si tu citais le texte.'
        : null;
}

/** Purge tout ce qu'un groupe possède ici — appelée par groupe_delete_completely. */
function groupe_banques_purge(PDO $pdo, int $groupeId): void {
    $pdo->prepare('DELETE FROM groupe_banque_items WHERE groupe_id = ?')->execute([$groupeId]);
    $pdo->prepare('DELETE FROM groupe_series WHERE groupe_id = ?')->execute([$groupeId]);
    $pdo->prepare('DELETE FROM groupe_banques WHERE groupe_id = ?')->execute([$groupeId]);
}

/* ---- GET /api/groupes/{code}/series/{module} — la liste ------------------------ */

function handle_groupe_series_list(PDO $pdo, string $rawCode, string $module): never {
    [$groupe, $anime] = groupe_serie_membre($pdo, $rawCode, $module);
    $sql = 'SELECT * FROM groupe_series WHERE groupe_id = ? AND module = ?';
    $params = [(int) $groupe['id'], $module];
    if (!$anime) {
        $sql .= ' AND etat = ?';           // un membre ne voit que le publié
        $params[] = 'publiee';
    }
    $sql .= ' ORDER BY COALESCE(publiee_at, created_at) DESC, id DESC';
    $st = $pdo->prepare($sql);
    $st->execute($params);

    $series = [];
    foreach ($st->fetchAll() as $row) {
        $nb = groupe_serie_nb_items($pdo, (int) $row['id']);
        if (!$anime && $nb < GROUPE_SERIE_MIN_ITEMS) {
            continue;                       // publiée mais vidée depuis : on ne la propose pas
        }
        $series[] = groupe_serie_publique($row, $nb);
    }
    json_out([
        'module'      => $module,
        // Le nom de l'église voyage avec la liste : les pages d'épreuve
        // vivent hors de l'application et ne connaissent qu'un code. Sans
        // lui, quelqu'un qui appartient à deux assemblées ne saurait pas
        // laquelle lui propose ces séries.
        'eglise'      => (string) $groupe['nom'],
        'anime'       => $anime,
        'series'      => $series,
        'maxPubliees' => GROUPE_SERIE_MAX_PUBLIEES,
        'minItems'    => GROUPE_SERIE_MIN_ITEMS,
        'maxItems'    => GROUPE_SERIE_MAX_ITEMS,
    ]);
}

/* ---- POST /api/groupes/{code}/series/{module} — créer -------------------------- */

function handle_groupe_serie_creer(PDO $pdo, string $rawCode, string $module): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    $groupeId = (int) $groupe['id'];
    $body = read_json_body();
    $nom = trim((string) ($body['nom'] ?? ''));
    if ($nom === '' || mb_strlen($nom) > GROUPE_SERIE_NOM_MAX) {
        json_error('Le nom de la série doit faire entre 1 et ' . GROUPE_SERIE_NOM_MAX . ' caractères.', 400);
    }
    $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_series WHERE groupe_id = ? AND module = ?');
    $st->execute([$groupeId, $module]);
    if ((int) $st->fetch()['n'] >= GROUPE_SERIE_MAX_TOTAL) {
        json_error('Cette église a déjà ' . GROUPE_SERIE_MAX_TOTAL . ' séries pour cette épreuve — '
            . 'supprimes-en une avant d\'en créer une autre.', 400);
    }
    $st = $pdo->prepare(
        'INSERT INTO groupe_series (groupe_id, module, nom, etat, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)'
    );
    $st->execute([$groupeId, $module, $nom, 'brouillon', now_sql(), now_sql()]);
    $id = (int) $pdo->lastInsertId();
    json_out(['serie' => groupe_serie_publique(
        groupe_serie_charger($pdo, $groupeId, $module, $id), 0)], 201);
}

/* ---- PATCH /api/groupes/{code}/series/{module}/{id} — renommer, publier -------- */

function handle_groupe_serie_maj(PDO $pdo, string $rawCode, string $module, int $serieId): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    $groupeId = (int) $groupe['id'];
    $serie = groupe_serie_charger($pdo, $groupeId, $module, $serieId);
    $body = read_json_body();

    $nom = $serie['nom'];
    if (array_key_exists('nom', $body)) {
        $nom = trim((string) $body['nom']);
        if ($nom === '' || mb_strlen($nom) > GROUPE_SERIE_NOM_MAX) {
            json_error('Le nom de la série doit faire entre 1 et ' . GROUPE_SERIE_NOM_MAX . ' caractères.', 400);
        }
    }

    $etat = (string) $serie['etat'];
    $publieeAt = $serie['publiee_at'];
    if (array_key_exists('etat', $body)) {
        $vise = $body['etat'];
        if (!in_array($vise, GROUPE_SERIE_ETATS, true)) {
            json_error('État inconnu : brouillon, publiee ou archivee.', 400);
        }
        if ($vise === 'publiee' && $etat !== 'publiee') {
            $nb = groupe_serie_nb_items($pdo, $serieId);
            if ($nb < GROUPE_SERIE_MIN_ITEMS) {
                json_error('Il faut au moins ' . GROUPE_SERIE_MIN_ITEMS
                    . ' questions pour publier une série — celle-ci en compte ' . $nb . '.', 400);
            }
            if (groupe_serie_nb_publiees($pdo, $groupeId, $module, $serieId) >= GROUPE_SERIE_MAX_PUBLIEES) {
                json_error(GROUPE_SERIE_MAX_PUBLIEES . ' séries sont déjà publiées pour cette épreuve — '
                    . 'archives-en une pour faire de la place. Rien ne sera perdu.', 409);
            }
            $publieeAt = now_sql();
        }
        $etat = $vise;
    }

    $pdo->prepare('UPDATE groupe_series SET nom = ?, etat = ?, publiee_at = ?, updated_at = ? WHERE id = ?')
        ->execute([$nom, $etat, $publieeAt, now_sql(), $serieId]);

    $frais = groupe_serie_charger($pdo, $groupeId, $module, $serieId);
    json_out(['serie' => groupe_serie_publique($frais, groupe_serie_nb_items($pdo, $serieId))]);
}

/* ---- DELETE /api/groupes/{code}/series/{module}/{id} --------------------------- */

function handle_groupe_serie_supprimer(PDO $pdo, string $rawCode, string $module, int $serieId): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    $groupeId = (int) $groupe['id'];
    groupe_serie_charger($pdo, $groupeId, $module, $serieId);
    $pdo->prepare('DELETE FROM groupe_banque_items WHERE serie_id = ?')->execute([$serieId]);
    $pdo->prepare('DELETE FROM groupe_series WHERE id = ?')->execute([$serieId]);
    json_out(['supprime' => true]);
}

/* ---- POST /api/groupes/{code}/series/{module}/{id}/items ----------------------- */

function handle_groupe_serie_item_save(PDO $pdo, string $rawCode, string $module, int $serieId): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    $groupeId = (int) $groupe['id'];
    groupe_serie_charger($pdo, $groupeId, $module, $serieId);
    $body = read_json_body();
    // Les MÊMES règles que les items de l'administration : un item d'église
    // passe toujours l'adaptateur des pages clientes, sans jamais casser une partie.
    $item = banque_item_propre($module, $body);
    $json = json_encode($item, JSON_UNESCAPED_UNICODE);
    $avertissement = groupe_serie_avertissement($module, $item);

    $id = $body['id'] ?? null;
    if ($id === null) {
        if (groupe_serie_nb_items($pdo, $serieId) >= GROUPE_SERIE_MAX_ITEMS) {
            json_error('Cette série a déjà ' . GROUPE_SERIE_MAX_ITEMS . ' questions — c\'est le maximum.', 400);
        }
        if (groupe_serie_nb_items_eglise($pdo, $groupeId) >= GROUPE_EGLISE_MAX_ITEMS) {
            json_error('Cette église a déjà ' . GROUPE_EGLISE_MAX_ITEMS
                . ' questions toutes épreuves confondues — c\'est le maximum.', 400);
        }
        $st = $pdo->prepare('SELECT 1 FROM groupe_banque_items WHERE groupe_id = ? AND module = ? AND item_id = ?');
        do {
            $id = 'egl-' . bin2hex(random_bytes(3));
            $st->execute([$groupeId, $module, $id]);
        } while ($st->fetch() !== false);
        $pdo->prepare(
            'INSERT INTO groupe_banque_items (groupe_id, module, serie_id, item_id, item, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        )->execute([$groupeId, $module, $serieId, $id, $json, now_sql(), now_sql()]);
        $status = 201;
    } else {
        if (!is_string($id) || !preg_match('/^egl-[a-f0-9]{6}$/', $id)) {
            json_error('Identifiant d\'item invalide.', 400);
        }
        $st = $pdo->prepare(
            'UPDATE groupe_banque_items SET item = ?, updated_at = ?
             WHERE groupe_id = ? AND module = ? AND item_id = ? AND serie_id = ?'
        );
        $st->execute([$json, now_sql(), $groupeId, $module, $id, $serieId]);
        if ($st->rowCount() === 0) {
            json_error('Item introuvable dans cette série.', 404);
        }
        $status = 200;
    }
    json_out(['item' => ['id' => $id] + $item, 'avertissement' => $avertissement], $status);
}

/* ---- DELETE /api/groupes/{code}/series/{module}/{id}/items/{itemId} ------------ */

function handle_groupe_serie_item_delete(PDO $pdo, string $rawCode, string $module,
                                         int $serieId, string $itemId): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    $groupeId = (int) $groupe['id'];
    $serie = groupe_serie_charger($pdo, $groupeId, $module, $serieId);
    $st = $pdo->prepare(
        'DELETE FROM groupe_banque_items WHERE groupe_id = ? AND module = ? AND item_id = ? AND serie_id = ?'
    );
    $st->execute([$groupeId, $module, $itemId, $serieId]);
    if ($st->rowCount() === 0) {
        json_error('Item introuvable dans cette série.', 404);
    }
    // Une série publiée qui tombe sous le minimum redevient un brouillon :
    // mieux vaut la retirer que la servir trop maigre aux membres.
    $reste = groupe_serie_nb_items($pdo, $serieId);
    $depubliee = false;
    if ((string) $serie['etat'] === 'publiee' && $reste < GROUPE_SERIE_MIN_ITEMS) {
        $pdo->prepare('UPDATE groupe_series SET etat = ?, updated_at = ? WHERE id = ?')
            ->execute(['brouillon', now_sql(), $serieId]);
        $depubliee = true;
    }
    json_out(['supprime' => true, 'nbItems' => $reste, 'depubliee' => $depubliee]);
}

/* ---- GET /api/groupes/{code}/series/{module}/{id}/items — JOUER ---------------- */

function handle_groupe_serie_jouer(PDO $pdo, string $rawCode, string $module, int $serieId): never {
    [$groupe, $anime] = groupe_serie_membre($pdo, $rawCode, $module);
    $serie = groupe_serie_charger($pdo, (int) $groupe['id'], $module, $serieId);
    if (!$anime && (string) $serie['etat'] !== 'publiee') {
        json_error('Cette série n\'est pas publiée.', 403);
    }
    $fichier = banque_file_bank($module);
    json_out([
        'version' => $fichier['version'] ?? 1,
        'serie'   => ['id' => (int) $serie['id'], 'nom' => (string) $serie['nom']],
        'items'   => groupe_serie_items($pdo, $serieId),
    ]);
}
