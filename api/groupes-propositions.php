<?php
/* ============================================================================
   Ce que l'église PROPOSE à son assemblée — packs de versets et chemins de
   lecture.

   Deux genres, une seule table (groupe_propositions, étape 5 des migrations) :
   - 'pack'    : une liste de versets à mémoriser ensemble. Les versets vivent
                 dans la proposition (référence + texte), comme le verset de
                 la semaine : ils ne viennent pas forcément de la bibliothèque
                 de l'appli, le responsable écrit ce qu'il veut offrir.
   - 'lecture' : une séquence de livres bibliques à parcourir. CHEMIN, PAS
                 CALENDRIER (voir lire/lire.js) : aucune date, aucun retard.

   Le pacte, le même que partout ici : le responsable et ses co-responsables
   PROPOSENT (groupe_peut_animer) ; tout membre LIT la liste ; ADOPTER est un
   geste strictement LOCAL — rien, jamais, n'enregistre qui a adopté quoi ni
   où il en est. Une proposition est une porte ouverte, pas une convocation.

   - GET    /api/groupes/{code}/propositions      : la liste (tout membre).
   - POST   /api/groupes/{code}/propositions      : créer ou modifier (équipe).
   - DELETE /api/groupes/{code}/propositions/{id} : supprimer (équipe).
   ========================================================================== */

defined('GRAINE_API') || exit;

const PROPOSITION_GENRES      = ['pack', 'lecture'];
const PROPOSITION_MAX         = 20;  // par groupe ET par genre
const PROPOSITION_MAX_VERSETS = 50;  // un pack reste à taille humaine
const PROPOSITION_MAX_LIVRES  = 66;  // toute la Bible, pas davantage

/* ---- Aides ------------------------------------------------------------------ */

/** Le groupe si l'appelant en est membre (lecture), avec son rôle. */
function proposition_load_membre(PDO $pdo, string $rawCode, array $user): array {
    $groupe = groupe_load($pdo, $rawCode);
    $role = groupe_role($pdo, (int) $groupe['id'], (int) $user['id']);
    if ($role === null) {
        json_error('Réservé aux membres du groupe.', 403);
    }
    return [$groupe, $role];
}

/** Le groupe si l'appelant peut NOURRIR l'assemblée (écritures). */
function proposition_load_equipe(PDO $pdo, string $rawCode, array $user): array {
    [$groupe, $role] = proposition_load_membre($pdo, $rawCode, $user);
    if (!groupe_peut_animer($role)) {
        json_error('Seuls le responsable et ses co-responsables proposent à l\'assemblée.', 403);
    }
    return $groupe;
}

/** Le genre demandé, validé (404 sinon — c'est un segment d'URL). */
function proposition_genre(mixed $genre): string {
    if (!in_array($genre, PROPOSITION_GENRES, true)) {
        json_error('Genre de proposition inconnu (pack ou lecture).', 400);
    }
    return (string) $genre;
}

/**
 * Les identifiants de livres que le module Lire sait ouvrir — déduits de ses
 * fichiers (lire/data/{id}.json) : la liste ne peut pas se désynchroniser.
 */
function proposition_livres_connus(): array {
    static $ids = null;
    if ($ids === null) {
        $ids = [];
        foreach (glob(dirname(__DIR__) . '/lire/data/*.json') ?: [] as $f) {
            $ids[] = basename($f, '.json');
        }
    }
    return $ids;
}

/** Valide le contenu selon le genre → contenu propre, prêt à ranger. */
function proposition_contenu_propre(string $genre, array $body): array {
    if ($genre === 'pack') {
        $versets = $body['versets'] ?? null;
        if (!is_array($versets) || count($versets) < 1 || count($versets) > PROPOSITION_MAX_VERSETS) {
            json_error('Un pack contient entre 1 et ' . PROPOSITION_MAX_VERSETS . ' versets.', 400);
        }
        $propres = [];
        foreach (array_values($versets) as $v) {
            if (!is_array($v)) {
                json_error('Chaque verset porte une référence et un texte.', 400);
            }
            $ref = trim((string) ($v['reference'] ?? ''));
            $texte = trim((string) ($v['texte'] ?? ''));
            if ($ref === '' || mb_strlen($ref) > 60) {
                json_error('Chaque référence doit faire entre 1 et 60 caractères.', 400);
            }
            if ($texte === '' || mb_strlen($texte) > 500) {
                json_error('Chaque texte de verset doit faire entre 1 et 500 caractères.', 400);
            }
            $propres[] = ['reference' => $ref, 'texte' => $texte];
        }
        return ['versets' => $propres];
    }

    // lecture
    $livres = $body['livres'] ?? null;
    if (!is_array($livres) || count($livres) < 1 || count($livres) > PROPOSITION_MAX_LIVRES) {
        json_error('Un chemin de lecture contient entre 1 et ' . PROPOSITION_MAX_LIVRES . ' livres.', 400);
    }
    $connus = proposition_livres_connus();
    $propres = [];
    foreach (array_values($livres) as $id) {
        // Liste blanche stricte : le client n'envoie qu'un identifiant que le
        // module Lire connaît déjà — jamais un chemin, jamais un nom libre.
        if (!is_string($id) || !in_array($id, $connus, true)) {
            json_error('Livre inconnu dans le chemin de lecture.', 400);
        }
        if (!in_array($id, $propres, true)) {
            $propres[] = $id; // un livre ne se marche pas deux fois
        }
    }
    return ['livres' => $propres];
}

function proposition_payload(array $row): array {
    $contenu = json_decode((string) $row['contenu'], true);
    return [
        'id'          => (int) $row['id'],
        'genre'       => $row['genre'],
        'titre'       => $row['titre'],
        'description' => ($row['description'] === null || $row['description'] === '') ? null : $row['description'],
        'contenu'     => is_array($contenu) ? $contenu : [],
        'date'        => sql_to_iso($row['updated_at']),
    ];
}

/** Efface les propositions d'un groupe — appelée par groupe_delete_completely. */
function groupe_propositions_purge(PDO $pdo, int $groupeId): void {
    $pdo->prepare('DELETE FROM groupe_propositions WHERE groupe_id = ?')->execute([$groupeId]);
}

/* ---- GET /api/groupes/{code}/propositions — la liste (tout membre) ------------- */

function handle_groupe_propositions_get(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    [$groupe] = proposition_load_membre($pdo, $rawCode, $user);
    $st = $pdo->prepare(
        'SELECT * FROM groupe_propositions WHERE groupe_id = ? ORDER BY genre ASC, id DESC'
    );
    $st->execute([(int) $groupe['id']]);
    json_out(['propositions' => array_map('proposition_payload', $st->fetchAll())]);
}

/* ---- POST /api/groupes/{code}/propositions — créer ou modifier ----------------- */

function handle_groupe_proposition_save(PDO $pdo, string $rawCode): never {
    $user = require_user($pdo);
    $groupe = proposition_load_equipe($pdo, $rawCode, $user);
    $groupeId = (int) $groupe['id'];
    $body = read_json_body();

    $genre = proposition_genre($body['genre'] ?? null);
    $titre = trim((string) ($body['titre'] ?? ''));
    if ($titre === '' || mb_strlen($titre) > 80) {
        json_error('Le titre doit faire entre 1 et 80 caractères.', 400);
    }
    $description = trim((string) ($body['description'] ?? ''));
    if (mb_strlen($description) > 500) {
        json_error('La description ne peut pas dépasser 500 caractères.', 400);
    }
    $contenu = (string) json_encode(proposition_contenu_propre($genre, $body), JSON_UNESCAPED_UNICODE);

    $id = $body['id'] ?? null;
    if ($id === null) {
        $st = $pdo->prepare('SELECT COUNT(*) AS n FROM groupe_propositions WHERE groupe_id = ? AND genre = ?');
        $st->execute([$groupeId, $genre]);
        if ((int) $st->fetch()['n'] >= PROPOSITION_MAX) {
            json_error('Ce groupe a déjà ' . PROPOSITION_MAX . ' propositions de ce genre — supprime les plus anciennes.', 400);
        }
        $pdo->prepare(
            'INSERT INTO groupe_propositions (groupe_id, genre, titre, description, contenu, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        )->execute([$groupeId, $genre, $titre, $description === '' ? null : $description, $contenu, now_sql(), now_sql()]);
        $id = (int) $pdo->lastInsertId();
        $status = 201;
    } else {
        $id = filter_var($id, FILTER_VALIDATE_INT);
        if ($id === false) {
            json_error('Identifiant de proposition invalide.', 400);
        }
        // Le genre ne change jamais en cours de route : une proposition reste
        // ce qu'elle est (le contenu adopté par les membres en dépend).
        $st = $pdo->prepare('UPDATE groupe_propositions SET titre = ?, description = ?, contenu = ?, updated_at = ?
                             WHERE id = ? AND groupe_id = ? AND genre = ?');
        $st->execute([$titre, $description === '' ? null : $description, $contenu, now_sql(), $id, $groupeId, $genre]);
        if ($st->rowCount() === 0) {
            json_error('Proposition introuvable dans ce groupe.', 404);
        }
        $status = 200;
    }

    $st = $pdo->prepare('SELECT * FROM groupe_propositions WHERE id = ?');
    $st->execute([$id]);
    json_out(['proposition' => proposition_payload($st->fetch())], $status);
}

/* ---- DELETE /api/groupes/{code}/propositions/{id} ------------------------------ */

function handle_groupe_proposition_delete(PDO $pdo, string $rawCode, int $id): never {
    $user = require_user($pdo);
    $groupe = proposition_load_equipe($pdo, $rawCode, $user);
    $st = $pdo->prepare('DELETE FROM groupe_propositions WHERE id = ? AND groupe_id = ?');
    $st->execute([$id, (int) $groupe['id']]);
    if ($st->rowCount() === 0) {
        json_error('Proposition introuvable dans ce groupe.', 404);
    }
    // Ce qu'un membre a déjà adopté lui reste : son jardin et son chemin de
    // lecture sont à lui, la proposition n'en était que l'origine.
    json_out(['ok' => true]);
}
