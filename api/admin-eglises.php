<?php
/* ============================================================================
   Ce que l'administration peut voir et retirer du contenu publié par une
   église — et RIEN de plus.

   Ce n'est pas de la modération a priori : personne ne relit une église avant
   qu'elle publie, et chaque église répond de ce qu'elle écrit. C'est le
   minimum pour pouvoir AGIR SUR SIGNALEMENT — ce que les mentions légales
   promettent, et qu'un hébergeur informé d'un contenu manifestement illicite
   doit pouvoir faire. Sans ces routes, la seule issue serait d'ouvrir la base
   à la main.

   - GET    /api/admin/groupes                              : les églises et ce qu'elles pèsent.
   - GET    /api/admin/groupes/{code}                       : tout le texte qu'une église a publié.
   - DELETE /api/admin/groupes/{code}/contenu/{type}/{id}   : en retirer une pièce.

   Tout retrait passe par admin_log : qui, quoi, quand. Une suppression est
   définitive — c'est voulu : on ne cache pas un contenu illicite, on l'ôte.
   ========================================================================== */

defined('GRAINE_API') || exit;

/** Ce qu'on sait retirer, et où cela vit. */
const ADMIN_CONTENU = [
    'annonce'     => ['table' => 'groupe_annonces',      'cle' => 'id',      'entier' => true],
    'question'    => ['table' => 'groupe_questions',     'cle' => 'id',      'entier' => false],
    'item'        => ['table' => 'groupe_banque_items',  'cle' => 'item_id', 'entier' => false],
    'serie'       => ['table' => 'groupe_series',        'cle' => 'id',      'entier' => true],
    'proposition' => ['table' => 'groupe_propositions',  'cle' => 'id',      'entier' => true],
];

/* ---- GET /api/admin/groupes — la liste ---------------------------------------- */

function handle_admin_groupes(PDO $pdo): never {
    require_admin($pdo);
    $compte = static function (PDO $pdo, string $table, int $id): int {
        $st = $pdo->prepare("SELECT COUNT(*) AS n FROM $table WHERE groupe_id = ?");
        $st->execute([$id]);
        return (int) $st->fetch()['n'];
    };
    $groupes = [];
    foreach ($pdo->query('SELECT * FROM groupes ORDER BY id')->fetchAll() as $g) {
        $id = (int) $g['id'];
        $groupes[] = [
            'code'          => (string) $g['code'],
            'nom'           => (string) $g['nom'],
            'creee'         => sql_to_iso($g['created_at']),
            'nbMembres'     => $compte($pdo, 'groupe_membres', $id),
            'nbAnnonces'    => $compte($pdo, 'groupe_annonces', $id),
            'nbQuestions'   => $compte($pdo, 'groupe_questions', $id),
            'nbSeries'      => $compte($pdo, 'groupe_series', $id),
            'nbItems'       => $compte($pdo, 'groupe_banque_items', $id),
            'nbPropositions' => $compte($pdo, 'groupe_propositions', $id),
        ];
    }
    json_out(['groupes' => $groupes]);
}

/* ---- GET /api/admin/groupes/{code} — tout le texte publié --------------------- */

function handle_admin_groupe_contenu(PDO $pdo, string $rawCode): never {
    require_admin($pdo);
    $groupe = groupe_load($pdo, $rawCode);
    $id = (int) $groupe['id'];
    $lire = static function (PDO $pdo, string $sql, int $id): array {
        $st = $pdo->prepare($sql);
        $st->execute([$id]);
        return $st->fetchAll();
    };

    $annonces = array_map(static fn (array $r): array => [
        'id' => (int) $r['id'], 'titre' => (string) $r['titre'],
        'texte' => (string) $r['texte'], 'date' => sql_to_iso($r['created_at']),
    ], $lire($pdo, 'SELECT * FROM groupe_annonces WHERE groupe_id = ? ORDER BY id DESC', $id));

    $questions = array_map(static fn (array $r): array => [
        'id' => (string) $r['id'], 'question' => (string) $r['question'],
        'reference' => (string) $r['reference'], 'categorie' => (string) $r['categorie'],
    ], $lire($pdo, 'SELECT * FROM groupe_questions WHERE groupe_id = ? ORDER BY id', $id));

    $series = array_map(static fn (array $r): array => [
        'id' => (int) $r['id'], 'module' => (string) $r['module'],
        'nom' => (string) $r['nom'], 'etat' => (string) $r['etat'],
    ], $lire($pdo, 'SELECT * FROM groupe_series WHERE groupe_id = ? ORDER BY id', $id));

    // Les items portent leur JSON : on en sort de quoi juger sur pièces sans
    // avoir à connaître la forme propre à chaque épreuve.
    $items = [];
    foreach ($lire($pdo, 'SELECT * FROM groupe_banque_items WHERE groupe_id = ? ORDER BY created_at, item_id', $id) as $r) {
        $item = json_decode((string) $r['item'], true);
        $item = is_array($item) ? $item : [];
        $items[] = [
            'id'      => (string) $r['item_id'],
            'module'  => (string) $r['module'],
            'serieId' => $r['serie_id'] !== null ? (int) $r['serie_id'] : null,
            'texte'   => (string) ($item['parole'] ?? $item['phrase'] ?? $item['reponse'] ?? ''),
            'reference' => (string) ($item['reference'] ?? ''),
        ];
    }

    $propositions = array_map(static fn (array $r): array => [
        'id' => (int) $r['id'], 'genre' => (string) $r['genre'],
        'titre' => (string) $r['titre'], 'description' => (string) ($r['description'] ?? ''),
    ], $lire($pdo, 'SELECT * FROM groupe_propositions WHERE groupe_id = ? ORDER BY id', $id));

    json_out([
        'groupe' => ['code' => (string) $groupe['code'], 'nom' => (string) $groupe['nom']],
        'annonces' => $annonces, 'questions' => $questions,
        'series' => $series, 'items' => $items, 'propositions' => $propositions,
    ]);
}

/* ---- DELETE /api/admin/groupes/{code}/contenu/{type}/{id} --------------------- */

function handle_admin_groupe_retirer(PDO $pdo, string $rawCode, string $type, string $id): never {
    $admin = require_admin($pdo);
    if (!isset(ADMIN_CONTENU[$type])) {
        json_error('Type de contenu inconnu : ' . $type, 404);
    }
    $groupe = groupe_load($pdo, $rawCode);
    $groupeId = (int) $groupe['id'];
    $spec = ADMIN_CONTENU[$type];
    $valeur = $spec['entier'] ? (int) $id : $id;
    if ($spec['entier'] && $valeur <= 0) {
        json_error('Identifiant invalide.', 400);
    }

    // Retirer une série emporte ses questions : les laisser orphelines
    // reviendrait à les garder en base sans jamais pouvoir les revoir.
    if ($type === 'serie') {
        $pdo->prepare('DELETE FROM groupe_banque_items WHERE groupe_id = ? AND serie_id = ?')
            ->execute([$groupeId, $valeur]);
    }

    $st = $pdo->prepare(
        'DELETE FROM ' . $spec['table'] . ' WHERE groupe_id = ? AND ' . $spec['cle'] . ' = ?'
    );
    $st->execute([$groupeId, $valeur]);
    if ($st->rowCount() === 0) {
        json_error('Contenu introuvable dans cette église.', 404);
    }
    admin_log($pdo, $admin, 'retrait-' . $type, $groupe['code'] . ' / ' . $id);
    json_out(['retire' => true]);
}
