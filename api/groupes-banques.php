<?php
/* ============================================================================
   La banque d'église PAR ÉPREUVE — quiadit, ecritoupas, portrait.

   Même esprit que le quiz d'église (groupes-quiz.php), généralisé aux trois
   épreuves « à fichier » (banques.php) : chaque église choisit ce que SES
   parties utilisent — toute la banque commune (mode « toutes », défaut), une
   SÉLECTION de celle-ci, et/ou ses PROPRES items (id « egl-… », écrits par le
   responsable, validés par les MÊMES règles que ceux de l'administration :
   banque_item_propre). RÈGLE ABSOLUE, la même qu'au quiz : cela ne touche que
   les parties lancées « dans mon église » — les pages publiques restent
   mondiales.

   - GET    /api/groupes/{code}/banques/{module}            : réglages + items.
   - POST   /api/groupes/{code}/banques/{module}/mode       : 'toutes' | 'selection'.
   - PUT    /api/groupes/{code}/banques/{module}/selection  : REMPLACE la sélection.
   - POST   /api/groupes/{code}/banques/{module}/items      : créer ou modifier.
   - DELETE /api/groupes/{code}/banques/{module}/items/{id} : supprimer pour de bon.
   - GET    /api/groupes/{code}/banque/{module}  : la banque FUSIONNÉE de
     l'église, au MÊME format que la banque publique (/api/banque/{module}) —
     c'est elle que les pages d'épreuves chargent pour animer « dans mon
     église », en changeant seulement l'URL du fetch.

   TOUT est réservé au RESPONSABLE (403 sinon) — y compris la lecture : les
   items portent la bonne réponse, et un membre qui lirait la banque avant la
   veillée pourrait tricher (même précédent que les questions propres du
   quiz d'église). Garde-fous : 2000 ids dans la sélection, 300 items propres
   par (groupe, module). À la suppression du groupe, groupe_banques_purge
   efface tout. Tables : groupe_banques et groupe_banque_items (étape 2 des
   migrations, db.php).
   ========================================================================== */

defined('GRAINE_API') || exit;

const GROUPE_BANQUE_MAX_SELECTION = 2000;
const GROUPE_BANQUE_MAX_ITEMS     = 300;

/* ---- Aides ------------------------------------------------------------------ */

/**
 * Vérifie le module (404), l'utilisateur (401), le groupe (404) et le rôle
 * (403 : responsable seul, lecture comprise — voir l'en-tête). Renvoie le
 * groupe chargé.
 */
function groupe_banque_responsable(PDO $pdo, string $rawCode, string $module): array {
    if (!isset(BANQUE_MODULES[$module])) {
        json_error('Banque inconnue : ' . $module, 404);
    }
    $user = require_user($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    if (groupe_role($pdo, (int) $groupe['id'], (int) $user['id']) !== 'responsable') {
        json_error('Seul le responsable du groupe règle la banque de son église.', 403);
    }
    return $groupe;
}

/** Réglages du couple (groupe, module) — mode et sélection, avec défauts. */
function groupe_banque_reglages(PDO $pdo, int $groupeId, string $module): array {
    $st = $pdo->prepare('SELECT mode, selection FROM groupe_banques WHERE groupe_id = ? AND module = ?');
    $st->execute([$groupeId, $module]);
    $row = $st->fetch();
    $selection = [];
    if ($row !== false && $row['selection'] !== null) {
        $ids = json_decode((string) $row['selection'], true);
        if (is_array($ids)) {
            $selection = array_values(array_map('strval', $ids));
        }
    }
    return [
        'mode'      => $row === false ? 'toutes' : (string) $row['mode'],
        'selection' => $selection,
    ];
}

/** Écrit (crée ou remplace) les réglages du couple (groupe, module). */
function groupe_banque_reglages_save(PDO $pdo, int $groupeId, string $module, string $mode, array $selection): void {
    $json = json_encode(array_values($selection), JSON_UNESCAPED_UNICODE);
    $st = $pdo->prepare(
        'UPDATE groupe_banques SET mode = ?, selection = ?, updated_at = ? WHERE groupe_id = ? AND module = ?'
    );
    $st->execute([$mode, $json, now_sql(), $groupeId, $module]);
    if ($st->rowCount() === 0) {
        try {
            $pdo->prepare(
                'INSERT INTO groupe_banques (groupe_id, module, mode, selection, updated_at) VALUES (?, ?, ?, ?, ?)'
            )->execute([$groupeId, $module, $mode, $json, now_sql()]);
        } catch (PDOException $e) {
            // Deux requêtes en même temps : l'autre a créé la ligne — on la met à jour.
            $st->execute([$mode, $json, now_sql(), $groupeId, $module]);
        }
    }
}

/** Les items propres du couple (groupe, module), id inclus, plus anciens d'abord. */
function groupe_banque_items(PDO $pdo, int $groupeId, string $module): array {
    $st = $pdo->prepare(
        'SELECT item_id, item FROM groupe_banque_items
         WHERE groupe_id = ? AND module = ? ORDER BY created_at ASC, item_id ASC'
    );
    $st->execute([$groupeId, $module]);
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
 * Le résumé complet servi au responsable : réglages, comptes et items. La
 * sélection est recoupée avec la banque commune du moment — un item retiré
 * par l'administration disparaît d'elle sans bruit.
 */
function groupe_banque_payload(PDO $pdo, int $groupeId, string $module): array {
    $reglages = groupe_banque_reglages($pdo, $groupeId, $module);
    $items = groupe_banque_items($pdo, $groupeId, $module);
    $commune = banque_bank($pdo, $module);
    $communeIds = array_map(static fn (array $i): string => (string) $i['id'], $commune);
    $selection = array_values(array_intersect($reglages['selection'], $communeIds));
    $nbCommune = $reglages['mode'] === 'selection' ? count($selection) : count($commune);
    return [
        'module'      => $module,
        'mode'        => $reglages['mode'],
        'selection'   => $selection,
        'nbSelection' => count($selection),
        'nbCommune'   => count($commune),
        'nbPropres'   => count($items),
        'nbTotal'     => $nbCommune + count($items),
        'items'       => $items,
    ];
}

/** Purge tout ce qu'un groupe possède ici — appelée par groupe_delete_completely. */
function groupe_banques_purge(PDO $pdo, int $groupeId): void {
    $pdo->prepare('DELETE FROM groupe_banque_items WHERE groupe_id = ?')->execute([$groupeId]);
    $pdo->prepare('DELETE FROM groupe_banques WHERE groupe_id = ?')->execute([$groupeId]);
}

/* ---- GET /api/groupes/{code}/banques/{module} — réglages + items --------------- */

function handle_groupe_banque_get(PDO $pdo, string $rawCode, string $module): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    json_out(['banque' => groupe_banque_payload($pdo, (int) $groupe['id'], $module)]);
}

/* ---- POST /api/groupes/{code}/banques/{module}/mode ----------------------------- */

function handle_groupe_banque_mode(PDO $pdo, string $rawCode, string $module): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    $body = read_json_body();
    $mode = $body['mode'] ?? null;
    if (!in_array($mode, ['toutes', 'selection'], true)) {
        json_error('Le mode est « toutes » ou « selection ».', 400);
    }
    $reglages = groupe_banque_reglages($pdo, (int) $groupe['id'], $module);
    // La sélection est GARDÉE en changeant de mode : revenir à « toutes »
    // n'efface pas le tri patiemment fait — il attend, simplement.
    groupe_banque_reglages_save($pdo, (int) $groupe['id'], $module, $mode, $reglages['selection']);
    json_out(['banque' => groupe_banque_payload($pdo, (int) $groupe['id'], $module)]);
}

/* ---- PUT /api/groupes/{code}/banques/{module}/selection ------------------------- */

function handle_groupe_banque_selection(PDO $pdo, string $rawCode, string $module): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    $body = read_json_body();
    $ids = $body['ids'] ?? null;
    if (!is_array($ids) || count($ids) > GROUPE_BANQUE_MAX_SELECTION) {
        json_error('La sélection est une liste d\'au plus ' . GROUPE_BANQUE_MAX_SELECTION . ' identifiants.', 400);
    }
    $propres = [];
    foreach ($ids as $id) {
        if (!is_string($id) || $id === '' || mb_strlen($id) > 60) {
            json_error('Chaque identifiant de la sélection est un texte d\'au plus 60 caractères.', 400);
        }
        $propres[$id] = true; // dédoublonne en passant
    }
    // Seuls les ids réellement présents dans la banque commune sont retenus :
    // une faute de frappe n'encombre pas la sélection pour toujours.
    $communeIds = array_map(static fn (array $i): string => (string) $i['id'], banque_bank($pdo, $module));
    $retenus = array_values(array_intersect(array_keys($propres), $communeIds));

    $reglages = groupe_banque_reglages($pdo, (int) $groupe['id'], $module);
    groupe_banque_reglages_save($pdo, (int) $groupe['id'], $module, $reglages['mode'], $retenus);
    json_out(['banque' => groupe_banque_payload($pdo, (int) $groupe['id'], $module)]);
}

/* ---- POST /api/groupes/{code}/banques/{module}/items — créer ou modifier -------- */

function handle_groupe_banque_item_save(PDO $pdo, string $rawCode, string $module): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    $groupeId = (int) $groupe['id'];
    $body = read_json_body();
    // Les MÊMES règles de validation que les items de l'administration
    // (banque_item_propre) : un item d'église passe toujours l'adaptateur de
    // la page cliente et la création de parties, sans jamais en casser une.
    $item = banque_item_propre($module, $body);
    $json = json_encode($item, JSON_UNESCAPED_UNICODE);

    $id = $body['id'] ?? null;
    if ($id === null) {
        $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_banque_items WHERE groupe_id = ? AND module = ?');
        $st->execute([$groupeId, $module]);
        if ((int) $st->fetch()['n'] >= GROUPE_BANQUE_MAX_ITEMS) {
            json_error('Cette église a déjà ' . GROUPE_BANQUE_MAX_ITEMS . ' items pour cette épreuve — c\'est le maximum.', 400);
        }
        // Id neuf « egl-<6 hex> » — même famille que les questions du quiz d'église.
        $st = $pdo->prepare('SELECT 1 FROM groupe_banque_items WHERE groupe_id = ? AND module = ? AND item_id = ?');
        do {
            $id = 'egl-' . bin2hex(random_bytes(3));
            $st->execute([$groupeId, $module, $id]);
        } while ($st->fetch() !== false);
        $pdo->prepare(
            'INSERT INTO groupe_banque_items (groupe_id, module, item_id, item, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([$groupeId, $module, $id, $json, now_sql(), now_sql()]);
        $status = 201;
    } else {
        if (!is_string($id) || !preg_match('/^egl-[a-f0-9]{6}$/', $id)) {
            json_error('Identifiant d\'item invalide.', 400);
        }
        $st = $pdo->prepare(
            'UPDATE groupe_banque_items SET item = ?, updated_at = ? WHERE groupe_id = ? AND module = ? AND item_id = ?'
        );
        $st->execute([$json, now_sql(), $groupeId, $module, $id]);
        if ($st->rowCount() === 0) {
            json_error('Item introuvable dans la banque de ce groupe.', 404);
        }
        $status = 200;
    }
    json_out(['item' => ['id' => $id] + $item], $status);
}

/* ---- DELETE /api/groupes/{code}/banques/{module}/items/{id} --------------------- */

function handle_groupe_banque_item_delete(PDO $pdo, string $rawCode, string $module, string $id): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    $st = $pdo->prepare('DELETE FROM groupe_banque_items WHERE groupe_id = ? AND module = ? AND item_id = ?');
    $st->execute([(int) $groupe['id'], $module, $id]);
    if ($st->rowCount() === 0) {
        json_error('Item introuvable dans la banque de ce groupe.', 404);
    }
    json_out(['ok' => true]);
}

/* ---- GET /api/groupes/{code}/banque/{module} — la banque FUSIONNÉE -------------- */

/**
 * La banque que les pages d'épreuves chargent pour animer « dans mon
 * église » : même format que la banque publique ({version, items}), le
 * contenu en plus — sélection appliquée, items propres ajoutés. Responsable
 * seul : les items portent les bonnes réponses.
 */
function handle_groupe_banque_fusion(PDO $pdo, string $rawCode, string $module): never {
    $groupe = groupe_banque_responsable($pdo, $rawCode, $module);
    $reglages = groupe_banque_reglages($pdo, (int) $groupe['id'], $module);
    $commune = banque_bank($pdo, $module);
    if ($reglages['mode'] === 'selection') {
        $retenus = array_flip($reglages['selection']);
        $commune = array_values(array_filter(
            $commune,
            static fn (array $i): bool => isset($retenus[(string) $i['id']])
        ));
    }
    $fichier = banque_file_bank($module);
    json_out([
        'version' => $fichier['version'] ?? 1,
        'items'   => array_merge($commune, groupe_banque_items($pdo, (int) $groupe['id'], $module)),
    ]);
}
