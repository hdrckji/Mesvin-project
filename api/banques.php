<?php
/* ============================================================================
   Banques des épreuves à fichier JSON — même système que le quiz (admin.php) :
   la banque de base vit dans {module}/data/banque.json, embarquée dans
   l'image Docker ; le système de fichiers de Railway étant éphémère, les
   retouches vivent dans la table banque_surcharges : une ligne dont l'id
   existe dans le fichier SURCHARGE l'item (édition, ou désactivation si
   actif = 0), une ligne à l'id nouveau (préfixe adm-) l'AJOUTE.

   - GET    /api/banque/{module}                    : banque FUSIONNÉE (publique).
   - POST   /api/admin/banque/{module}              : créer (id adm-…) ou modifier.
   - DELETE /api/admin/banque/{module}/{id}         : désactiver (id du fichier)
                                                      ou supprimer (adm-).
   - POST   /api/admin/banque/{module}/{id}/restore : retirer la surcharge.

   Trois modules, trois formes d'item — chacun validé contre les limites du
   moteur qui consommera ses cartes (voir epreuve_deck_propre dans epreuve.php
   et portrait_deck_propre dans portrait.php), pour qu'un item ajouté par
   l'admin passe toujours l'adaptateur de la page cliente et la création de
   défis ou de veillées sans jamais casser une partie :
   - quiadit    : {id, parole, options[4], bonne, reference, contexte}
   - ecritoupas : {id, phrase, ecrit, reference, precision}
   - portrait   : {id, reponse, accepte[], genre, indices[5], reference}
   ========================================================================== */

defined('GRAINE_API') || exit;

/** Les trois banques : module → fichier de base (relatif au dépôt). */
const BANQUE_MODULES = [
    'quiadit'    => 'quiadit/data/banque.json',
    'ecritoupas' => 'ecritoupas/data/banque.json',
    'portrait'   => 'portrait/data/banque.json',
];

/* ---- Fichier de base ---------------------------------------------------------- */

/** Vérifie le module (404 sinon) et lit son fichier de base {version, items}. */
function banque_file_bank(string $module): array {
    if (!isset(BANQUE_MODULES[$module])) {
        json_error('Banque inconnue : ' . $module, 404);
    }
    $file = dirname(__DIR__) . '/' . BANQUE_MODULES[$module];
    $bank = json_decode((string) file_get_contents($file), true);
    if (!is_array($bank) || !is_array($bank['items'] ?? null)) {
        throw new RuntimeException('Banque introuvable ou invalide : ' . $file);
    }
    return $bank;
}

/**
 * La banque FUSIONNÉE d'un module, celle que la page de l'épreuve tire :
 * les items du fichier — remplacés par leur surcharge active s'il y en a
 * une, retirés si la surcharge est inactive — plus les ajouts (adm-) actifs.
 */
function banque_bank(PDO $pdo, string $module): array {
    $bank = banque_file_bank($module);
    $overrides = [];
    $st = $pdo->prepare('SELECT * FROM banque_surcharges WHERE module = ?');
    $st->execute([$module]);
    foreach ($st->fetchAll() as $row) {
        $overrides[(string) $row['id']] = $row;
    }

    $merged = [];
    foreach ($bank['items'] as $item) {
        $row = $overrides[(string) $item['id']] ?? null;
        if ($row === null) {
            $merged[] = $item;                                        // version du fichier
        } elseif ((int) $row['actif'] === 1) {
            $merged[] = json_decode((string) $row['corps'], true);    // surcharge active
        }                                                             // sinon : désactivée
        unset($overrides[(string) $item['id']]);
    }
    foreach ($overrides as $row) {                                    // ajouts (id hors fichier)
        if ((int) $row['actif'] === 1) {
            $merged[] = json_decode((string) $row['corps'], true);
        }
    }
    return $merged;
}

/* ---- Validation par module ----------------------------------------------------
   Bornes ALIGNÉES sur les moteurs : epreuve_deck_propre (quiadit et
   ecritoupas passent par l'adaptateur {q ≤ 300, options ≤ 90, ref ≤ 60,
   rev ≤ 300}) et portrait_deck_propre (reponse ≤ 60, exactement 5 indices
   ≤ 240, ref ≤ 60). Un champ hors bornes → 400 avec un message doux. */

/** Un texte requis, entre 1 et $max caractères — 400 sinon. */
function banque_texte(array $body, string $champ, int $max): string {
    $texte = trim((string) ($body[$champ] ?? ''));
    if ($texte === '' || mb_strlen($texte) > $max) {
        json_error("Le champ « $champ » doit faire entre 1 et $max caractères.", 400);
    }
    return $texte;
}

/** Un texte optionnel (null accepté), au plus $max caractères — 400 sinon. */
function banque_texte_optionnel(array $body, string $champ, int $max): ?string {
    $valeur = $body[$champ] ?? null;
    if ($valeur === null) {
        return null;
    }
    if (!is_string($valeur) || mb_strlen(trim($valeur)) > $max) {
        json_error("Le champ « $champ » doit être un texte d'au plus $max caractères (ou null).", 400);
    }
    $valeur = trim($valeur);
    return $valeur === '' ? null : $valeur;
}

/** Valide le corps reçu pour un item du module → item propre (sans id). */
function banque_item_propre(string $module, array $body): array {
    if ($module === 'quiadit') {
        $parole = banque_texte($body, 'parole', 300);
        $options = $body['options'] ?? null;
        if (!is_array($options) || count($options) !== 4) {
            json_error('Il faut exactement 4 options.', 400);
        }
        $clean = [];
        foreach (array_values($options) as $o) {
            $o = is_string($o) ? trim($o) : '';
            if ($o === '' || mb_strlen($o) > 90) {
                json_error('Chaque option doit faire entre 1 et 90 caractères.', 400);
            }
            $clean[] = $o;
        }
        $bonne = $body['bonne'] ?? null;
        if (!is_int($bonne) || $bonne < 0 || $bonne > 3) {
            json_error("L'index de la bonne réponse va de 0 à 3.", 400);
        }
        return [
            'parole'    => $parole,
            'options'   => $clean,
            'bonne'     => $bonne,
            'reference' => banque_texte($body, 'reference', 60),
            'contexte'  => banque_texte_optionnel($body, 'contexte', 300),
        ];
    }

    if ($module === 'ecritoupas') {
        $ecrit = $body['ecrit'] ?? null;
        if (!is_bool($ecrit)) {
            json_error('Le champ « ecrit » doit être vrai ou faux.', 400);
        }
        // Une phrase écrite se prouve : sa référence est exigée ; une phrase
        // qui ne l'est pas peut rester sans référence (null).
        $reference = $ecrit
            ? banque_texte($body, 'reference', 60)
            : banque_texte_optionnel($body, 'reference', 60);
        return [
            'phrase'    => banque_texte($body, 'phrase', 300),
            'ecrit'     => $ecrit,
            'reference' => $reference,
            'precision' => banque_texte_optionnel($body, 'precision', 300),
        ];
    }

    // portrait
    $reponse = banque_texte($body, 'reponse', 60);
    $accepte = $body['accepte'] ?? null;
    if (!is_array($accepte) || count($accepte) === 0) {
        json_error('Il faut au moins une orthographe acceptée.', 400);
    }
    $acc = [];
    foreach (array_values($accepte) as $a) {
        $a = is_string($a) ? trim($a) : '';
        if ($a === '' || mb_strlen($a) > 60 || portrait_norm($a) === '') {
            json_error('Chaque orthographe acceptée doit faire entre 1 et 60 caractères.', 400);
        }
        $acc[] = $a;
    }
    $genre = $body['genre'] ?? 'personnage';
    if (!in_array($genre, ['personnage', 'lieu', 'chose'], true)) {
        json_error('Genre invalide (personnage, lieu ou chose).', 400);
    }
    $indices = $body['indices'] ?? null;
    if (!is_array($indices) || count($indices) !== PORTRAIT_INDICES) {
        json_error('Il faut exactement ' . PORTRAIT_INDICES . ' indices.', 400);
    }
    $inds = [];
    foreach (array_values($indices) as $i) {
        $i = is_string($i) ? trim($i) : '';
        if ($i === '' || mb_strlen($i) > 240) {
            json_error('Chaque indice doit faire entre 1 et 240 caractères.', 400);
        }
        $inds[] = $i;
    }
    return [
        'reponse'   => $reponse,
        'accepte'   => $acc,
        'genre'     => $genre,
        'indices'   => $inds,
        'reference' => banque_texte($body, 'reference', 60),
    ];
}

/* ---- GET /api/banque/{module} — banque publique (sans authentification) ------- */

function handle_banque_get(PDO $pdo, string $module): never {
    $bank = banque_file_bank($module);
    json_out([
        'version' => $bank['version'] ?? 1,
        'items'   => banque_bank($pdo, $module),
    ]);
}

/* ---- POST /api/admin/banque/{module} — créer ou modifier un item -------------- */

function handle_admin_banque_save(PDO $pdo, string $module): never {
    $bank = banque_file_bank($module);   // 404 d'abord si module inconnu
    $admin = require_admin($pdo);
    $body = read_json_body();
    $item = banque_item_propre($module, $body);

    // Sans id : un AJOUT, identifié par un id neuf préfixé adm-.
    // Avec id : un item du fichier (surcharge) ou un ajout existant.
    $id = $body['id'] ?? null;
    if ($id === null || $id === '') {
        $id = 'adm-' . bin2hex(random_bytes(3));
    } elseif (!is_string($id) || !preg_match('/^[A-Za-z0-9-]{1,40}$/', $id)) {
        json_error("Identifiant d'item invalide.", 400);
    } elseif (!str_starts_with($id, 'adm-')
        && !in_array($id, array_column($bank['items'], 'id'), true)) {
        json_error('Item introuvable : ' . $id, 404);
    }
    $item = ['id' => $id] + $item;
    $corps = json_encode($item, JSON_UNESCAPED_UNICODE);

    $st = $pdo->prepare('SELECT 1 FROM banque_surcharges WHERE module = ? AND id = ?');
    $st->execute([$module, $id]);
    if ($st->fetch() !== false) {
        $pdo->prepare(
            'UPDATE banque_surcharges SET corps = ?, actif = 1, created_at = ?
             WHERE module = ? AND id = ?'
        )->execute([$corps, now_sql(), $module, $id]);
    } else {
        $pdo->prepare(
            'INSERT INTO banque_surcharges (module, id, corps, actif, created_at)
             VALUES (?, ?, ?, 1, ?)'
        )->execute([$module, $id, $corps, now_sql()]);
    }

    $resume = $item['parole'] ?? $item['phrase'] ?? $item['reponse'] ?? '';
    admin_log($pdo, $admin, 'banque.enregistrement', $module . '/' . $id . ' — ' . $resume);
    json_out(['item' => $item]);
}

/* ---- DELETE /api/admin/banque/{module}/{id} — désactiver ou supprimer --------- */

function handle_admin_banque_delete(PDO $pdo, string $module, string $id): never {
    $bank = banque_file_bank($module);
    $admin = require_admin($pdo);
    $st = $pdo->prepare('SELECT * FROM banque_surcharges WHERE module = ? AND id = ?');
    $st->execute([$module, $id]);
    $row = $st->fetch();

    $fileItem = null;
    foreach ($bank['items'] as $item) {
        if ((string) $item['id'] === $id) {
            $fileItem = $item;
            break;
        }
    }
    if ($row === false && $fileItem === null) {
        json_error('Item introuvable : ' . $id, 404);
    }

    if ($fileItem !== null) {
        // Item du fichier : impossible de l'en retirer — on pose (ou on
        // garde) une surcharge inactive. Réversible avec /restore.
        if ($row !== false) {
            $pdo->prepare('UPDATE banque_surcharges SET actif = 0, created_at = ? WHERE module = ? AND id = ?')
                ->execute([now_sql(), $module, $id]);
        } else {
            $pdo->prepare(
                'INSERT INTO banque_surcharges (module, id, corps, actif, created_at)
                 VALUES (?, ?, ?, 0, ?)'
            )->execute([$module, $id, json_encode($fileItem, JSON_UNESCAPED_UNICODE), now_sql()]);
        }
    } else {
        // Ajout (adm-…) : la ligne disparaît pour de bon.
        $pdo->prepare('DELETE FROM banque_surcharges WHERE module = ? AND id = ?')->execute([$module, $id]);
    }
    admin_log($pdo, $admin,
        $fileItem !== null ? 'banque.desactivation' : 'banque.suppression', $module . '/' . $id);
    json_out(['ok' => true]);
}

/* ---- POST /api/admin/banque/{module}/{id}/restore — retirer la surcharge ------ */

function handle_admin_banque_restore(PDO $pdo, string $module, string $id): never {
    $bank = banque_file_bank($module);
    $admin = require_admin($pdo);
    $st = $pdo->prepare('SELECT 1 FROM banque_surcharges WHERE module = ? AND id = ?');
    $st->execute([$module, $id]);
    if ($st->fetch() === false
        || !in_array($id, array_column($bank['items'], 'id'), true)) {
        json_error('Aucune surcharge à retirer pour cet item.', 404);
    }
    $pdo->prepare('DELETE FROM banque_surcharges WHERE module = ? AND id = ?')->execute([$module, $id]);
    admin_log($pdo, $admin, 'banque.retablissement', $module . '/' . $id);
    json_out(['ok' => true]);
}
