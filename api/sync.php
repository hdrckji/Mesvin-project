<?php
/* ============================================================================
   Synchronisation : un blob JSON par module (memo, lire, defi).

   Le serveur stocke tel quel et horodate ; la fusion intelligente se fait
   côté client (cf. API-CONTRAT.md). Taille max : 512 Ko par module.
   ========================================================================== */

defined('GRAINE_API') || exit;

const SYNC_MODULES        = ['memo', 'lire', 'defi'];
const SYNC_MAX_BLOB_BYTES = 512 * 1024;

/* ---- GET /api/sync -------------------------------------------------------- */

function handle_sync_get(PDO $pdo): never {
    $user = require_user($pdo);

    $st = $pdo->prepare('SELECT module, blob, updated_at FROM sync_blobs WHERE user_id = ?');
    $st->execute([$user['id']]);

    $out = ['memo' => null, 'lire' => null, 'defi' => null, 'updatedAt' => null];
    $latest = null;
    foreach ($st->fetchAll() as $row) {
        $out[$row['module']] = json_decode($row['blob'], true);
        if ($latest === null || $row['updated_at'] > $latest) {
            $latest = $row['updated_at'];
        }
    }
    $out['updatedAt'] = sql_to_iso($latest);
    json_out($out);
}

/* ---- PUT /api/sync -------------------------------------------------------- */

function handle_sync_put(PDO $pdo): never {
    $user = require_user($pdo);
    $body = read_json_body();
    $now = now_sql();
    $updated = 0;

    foreach (SYNC_MODULES as $module) {
        if (!array_key_exists($module, $body)) {
            continue; // clé facultative : on ne touche pas aux modules absents
        }
        if (!is_array($body[$module])) {
            json_error("Le module « $module » doit être un objet JSON.", 400);
        }
        $blob = json_encode($body[$module], JSON_UNESCAPED_UNICODE);
        if ($blob === false) {
            json_error("Impossible d'encoder les données du module « $module ».", 400);
        }
        if (strlen($blob) > SYNC_MAX_BLOB_BYTES) {
            json_error("Données trop volumineuses pour « $module » (512 Ko max).", 413);
        }
        // REPLACE INTO fonctionne à l'identique en MySQL et en SQLite.
        $st = $pdo->prepare(
            'REPLACE INTO sync_blobs (user_id, module, blob, updated_at) VALUES (?, ?, ?, ?)'
        );
        $st->execute([$user['id'], $module, $blob, $now]);
        $updated++;
    }

    if ($updated === 0) {
        json_error('Aucun module à synchroniser (clés attendues : memo, lire, defi).', 400);
    }
    json_out(['ok' => true, 'updatedAt' => sql_to_iso($now)]);
}
