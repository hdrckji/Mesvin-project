<?php
/* ============================================================================
   « De qui parle-t-on ? » — le portrait à indices, à distance et en direct.

   Défis par code (PD-) : même modèle que les épreuves à choix — le paquet
   est un jeu de PORTRAITS, le score maximum vaut 5 points par portrait
   (répondre dès le premier indice en rapporte 5, au dernier 1).
   Ils vivent dans la table epreuve_duels (mêmes colonnes) avec leurs
   propres routes et leur propre validation.

   Veillées en direct (PV-) : l'animateur révèle les indices UN À UN ;
   chacun peut répondre (texte libre) à tout moment, une seule fois par
   portrait — plus tôt c'est, plus ça rapporte. L'état ne transmet que les
   indices déjà révélés ; la réponse et la référence n'apparaissent qu'à la
   révélation. La correspondance des réponses est TOLÉRANTE (minuscules,
   accents, traits d'union ignorés, une faute de frappe pardonnée — jamais
   une confusion) contre la liste `accepte` du portrait.

   - POST /api/portrait/duel                     → {code, cle}
   - GET  /api/portrait/duel/{code}
   - POST /api/portrait/duel/{code}/score        ({score, cle}|{score, pseudo})
   - POST /api/portrait/veillee                  → {code, cle}
   - POST /api/portrait/veillee/{code}/rejoindre {prenom} → {jeton}
   - POST /api/portrait/veillee/{code}/avancer   {cle, action: 'indice'|'reveler'|'suivant'}
   - POST /api/portrait/veillee/{code}/reponse   {jeton, carte, texte}
   - GET  /api/portrait/veillee/{code}/etat
   ========================================================================== */

defined('GRAINE_API') || exit;

const PORTRAIT_DECK_MIN = 3;
const PORTRAIT_DECK_MAX = 20;
const PORTRAIT_INDICES = 5;

/* ---- Aides ------------------------------------------------------------------ */

/** Normalisation tolérante, identique à celle du client. */
function portrait_norm(string $s): string {
    $s = mb_strtolower(trim($s));
    $s = strtr($s, [
        'à' => 'a', 'â' => 'a', 'ä' => 'a', 'é' => 'e', 'è' => 'e', 'ê' => 'e', 'ë' => 'e',
        'î' => 'i', 'ï' => 'i', 'ô' => 'o', 'ö' => 'o', 'ù' => 'u', 'û' => 'u', 'ü' => 'u',
        'ç' => 'c', 'œ' => 'oe', 'æ' => 'ae', '’' => ' ', "'" => ' ', '-' => ' ',
    ]);
    return trim(preg_replace('/\s+/', ' ', preg_replace('/[^a-z0-9 ]/', '', $s)) ?? '');
}

/**
 * La saisie d'un participant vaut-elle le portrait $idx du paquet ?
 * Une faute de frappe est tolérée, JAMAIS une confusion : la saisie est bonne
 * si, après normalisation,
 *   1. elle est exactement dans `accepte` (comportement historique) ; OU
 *   2. elle est à distance de Levenshtein ≤ 1 d'une entrée `accepte` d'au
 *      moins 5 caractères (les cibles courtes — Paul, Saül, Élie, Sara… —
 *      restent en correspondance exacte), ET elle n'est à distance ≤ 1
 *      d'aucune entrée `accepte` d'un AUTRE portrait du paquet (si c'est
 *      ambigu, on refuse — on ne devine jamais).
 * MÊME RÈGLE que portraitCorrespond() côté client (portrait/index.html) :
 * toute retouche ici doit y être reportée à l'identique.
 */
function portrait_correspond(string $texte, array $deck, int $idx): bool {
    $n = portrait_norm($texte);
    $accepte = $deck[$idx]['accepte'];
    if (in_array($n, $accepte, true)) {
        return true;
    }
    // levenshtein() de PHP compte les OCTETS, pas les caractères : c'est sans
    // danger ici UNIQUEMENT parce que portrait_norm ne laisse que [a-z0-9 ]
    // (un octet par caractère). Garde-fou : si autre chose s'est glissé dans
    // la chaîne normalisée, correspondance exacte seulement.
    if ($n === '' || preg_match('/[^a-z0-9 ]/', $n)) {
        return false;
    }
    $proche = false;
    foreach ($accepte as $a) {
        if (strlen($a) >= 5 && abs(strlen($a) - strlen($n)) <= 1 && levenshtein($n, $a) <= 1) {
            $proche = true;
            break;
        }
    }
    if (!$proche) {
        return false;
    }
    foreach ($deck as $i => $p) {
        if ($i === $idx) {
            continue;
        }
        foreach ($p['accepte'] as $a) {
            if (abs(strlen($a) - strlen($n)) <= 1 && levenshtein($n, $a) <= 1) {
                return false; // ambigu avec un autre portrait du paquet
            }
        }
    }
    return true;
}

/** Valide le paquet de portraits → [{reponse, accepte[], indices[5], ref}]. */
function portrait_deck_propre(mixed $deck): array {
    if (!is_array($deck) || count($deck) < PORTRAIT_DECK_MIN || count($deck) > PORTRAIT_DECK_MAX) {
        json_error('Paquet invalide (entre ' . PORTRAIT_DECK_MIN . ' et ' . PORTRAIT_DECK_MAX . ' portraits).', 400);
    }
    $propre = [];
    foreach (array_values($deck) as $p) {
        $reponse = is_array($p) ? trim((string) ($p['reponse'] ?? '')) : '';
        $accepte = is_array($p) && is_array($p['accepte'] ?? null) ? $p['accepte'] : [];
        $indices = is_array($p) && is_array($p['indices'] ?? null) ? $p['indices'] : [];
        $ref = is_array($p) && isset($p['ref']) && is_string($p['ref']) ? trim($p['ref']) : null;
        if ($reponse === '' || mb_strlen($reponse) > 60
            || count($indices) !== PORTRAIT_INDICES
            || ($ref !== null && mb_strlen($ref) > 60)) {
            json_error('Paquet invalide (portrait mal formé).', 400);
        }
        $inds = [];
        foreach ($indices as $i) {
            $i = is_string($i) ? trim($i) : '';
            if ($i === '' || mb_strlen($i) > 240) {
                json_error('Paquet invalide (indice mal formé).', 400);
            }
            $inds[] = $i;
        }
        $acc = [portrait_norm($reponse)];
        foreach ($accepte as $a) {
            if (is_string($a) && portrait_norm($a) !== '') {
                $acc[] = portrait_norm($a);
            }
        }
        // Le genre (personnage/lieu/chose) suit le paquet — sert à la révélation
        // d'un défi par code (« Ce lieu est bien… ») ; jamais exposé par l'état
        // d'une veillée. Liste blanche, défaut prudent.
        $genre = is_array($p) && in_array($p['genre'] ?? null, ['personnage', 'lieu', 'chose'], true)
            ? $p['genre'] : 'personnage';
        $propre[] = ['reponse' => $reponse, 'accepte' => array_values(array_unique($acc)),
            'indices' => $inds, 'ref' => $ref === '' ? null : $ref, 'genre' => $genre];
    }
    return $propre;
}

function portrait_menage(PDO $pdo): void {
    $st = $pdo->prepare('SELECT code FROM portrait_veillees WHERE created_at < ?');
    $st->execute([now_sql_plus(-86400)]);
    foreach ($st->fetchAll() as $row) {
        $pdo->prepare('DELETE FROM portrait_participants WHERE code = ?')->execute([$row['code']]);
        $pdo->prepare('DELETE FROM portrait_veillees WHERE code = ?')->execute([$row['code']]);
    }
}

/* ---- Duel par code (table epreuve_duels, codes PD-) --------------------------- */

function portrait_duel_create(PDO $pdo): never {
    // 40 et non 10 : un animateur qui prépare sa soirée ouvre, essaie, referme
    // et recommence — et toute l'église partage son adresse. Dix salles par
    // heure, c'était épuisé avant même que la veillée commence.
    throttle_or_429($pdo, 'epreuve-creer', 40);
    epreuve_menage($pdo);
    portrait_menage($pdo);
    $body = read_json_body();
    // Un joueur connecté peut viser un AMI directement (opponentCode) — même
    // mécanique que les épreuves à choix (epreuve_defi_ami, api/epreuve.php).
    $ami = epreuve_defi_ami($pdo, $body);
    $deck = portrait_deck_propre($body['deck'] ?? null);
    $pseudo = frise_prenom($body['pseudo'] ?? ($ami['pseudo'] ?? null));

    $code = frise_code($pdo, 'epreuve_duels', 'PD-');
    $cle = bin2hex(random_bytes(16));
    // total = score maximum (5 points par portrait), pour borner les scores.
    $st = $pdo->prepare(
        'INSERT INTO epreuve_duels (code, cle, mode, deck, total, p1_pseudo, p1_user, p2_user, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $st->execute([$code, $cle, 'De qui parle-t-on ?', json_encode($deck, JSON_UNESCAPED_UNICODE),
        count($deck) * PORTRAIT_INDICES, $pseudo, $ami['p1'] ?? epreuve_createur_connecte($pdo), $ami['p2'] ?? null, now_sql()]);
    json_out(['code' => $code, 'cle' => $cle]);
}

/* GET et score : mêmes règles que les épreuves à choix — on réutilise les
   handlers epreuve_* tels quels (la table est la même, le code PD- aussi). */

/* ---- Veillée en direct (PV-) --------------------------------------------------- */

function portrait_veillee_row(PDO $pdo, string $code): array {
    $st = $pdo->prepare('SELECT * FROM portrait_veillees WHERE code = ?');
    $st->execute([$code]);
    $v = $st->fetch();
    if ($v === false) {
        json_error('Veillée introuvable — vérifie le code.', 404);
    }
    return $v;
}

function portrait_veillee_create(PDO $pdo): never {
    // 40 et non 10 : un animateur qui prépare sa soirée ouvre, essaie, referme
    // et recommence — et toute l'église partage son adresse. Dix salles par
    // heure, c'était épuisé avant même que la veillée commence.
    throttle_or_429($pdo, 'epreuve-creer', 40);
    portrait_menage($pdo);
    $body = read_json_body();
    $deck = portrait_deck_propre($body['deck'] ?? null);

    // « La veillée s'enchaîne toute seule » : ici le chrono rythme les INDICES
    // — un indice tombe à chaque échéance, et après le dernier vient la
    // révélation. Désactivé par défaut : sans lui, rien ne change.
    $auto = !empty($body['auto']) ? 1 : 0;
    $seconds = $auto ? epreuve_secondes_propres($body['seconds'] ?? null) : 0;

    $code = frise_code($pdo, 'portrait_veillees', 'PV-');
    $cle = bin2hex(random_bytes(16));
    $st = $pdo->prepare(
        "INSERT INTO portrait_veillees (code, cle, mode, deck, phase, carte, indice, auto, seconds, created_at)
         VALUES (?, ?, 'De qui parle-t-on ?', ?, 'attente', 0, 0, ?, ?, ?)"
    );
    $st->execute([$code, $cle, json_encode($deck, JSON_UNESCAPED_UNICODE), $auto, $seconds, now_sql()]);
    json_out(['code' => $code, 'cle' => $cle, 'auto' => (bool) $auto, 'seconds' => $seconds]);
}

function portrait_veillee_rejoindre(PDO $pdo, string $code): never {
    // Plafonds calibrés sur une VEILLÉE D'ÉGLISE, pas sur un visiteur isolé :
    // toute l'assemblée sort par le même wifi, donc par la même adresse. Vingt
    // participants qui rejoignent quatre épreuves dans la soirée, cela fait
    // quatre-vingts passages ici — l'ancien plafond de 60 refoulait les
    // derniers arrivés en pleine veillée, avec un message parlant de réseau
    // qui n'expliquait rien. Rejoindre exige déjà un code de salle à cinq
    // caractères : l'abus à l'aveugle est barré par le code, pas par ce
    // compteur. Ce qui reste sévèrement tenu, c'est l'envoi d'e-mails
    // (scope « code », 30/heure) — le seul endroit où l'abus coûte cher.
    throttle_or_429($pdo, 'epreuve-rejoindre', 300);
    $v = portrait_veillee_row($pdo, $code);
    if ($v['phase'] === 'fin') {
        json_error('Cette veillée est terminée.', 409);
    }
    $st = $pdo->prepare('SELECT COUNT(*) FROM portrait_participants WHERE code = ?');
    $st->execute([$code]);
    if ((int) $st->fetchColumn() >= EPREUVE_VEILLEE_MAX_PARTICIPANTS) {
        json_error('La veillée est au complet.', 409);
    }
    $prenom = frise_prenom(read_json_body()['prenom'] ?? null);
    $jeton = bin2hex(random_bytes(16));
    $pdo->prepare(
        'INSERT INTO portrait_participants (code, jeton, prenom, score, created_at)
         VALUES (?, ?, ?, 0, ?)'
    )->execute([$code, $jeton, $prenom, now_sql()]);
    json_out(['jeton' => $jeton]);
}

/**
 * L'animateur rythme : action 'indice' (révéler le suivant), 'reveler'
 * (montrer la réponse), 'suivant' (portrait suivant, ou fin).
 * Depuis 'attente', toute action lance le premier portrait, premier indice.
 */
/**
 * Sonder l'état FAIT AVANCER la veillée — le même souffle que sur les autres
 * épreuves (cf. epreuve_veillee_souffle), avec la singularité du portrait :
 * le chrono ne révèle pas, il fait TOMBER LES INDICES. À chaque échéance,
 * l'indice suivant paraît et le temps repart — le barème (6 - indice points)
 * suit donc naturellement la cadence. Après le dernier indice, l'échéance
 * suivante révèle.
 *
 * Indépendamment du mode : quand tous les PRÉSENTS ont répondu, on révèle —
 * c'est la réparation commune aux quatre épreuves, pas une option.
 */
function portrait_veillee_souffle(PDO $pdo, string $code, array $v, ?string $jeton): array {
    if ($jeton !== null && $jeton !== '') {
        $st = $pdo->prepare('SELECT id FROM portrait_participants WHERE code = ? AND jeton = ?');
        $st->execute([$code, $jeton]);
        $moi = $st->fetchColumn();
        if ($moi !== false) {
            epreuve_auto_present($pdo, 'portrait_participants', (int) $moi);
        }
    }

    $phase = (string) $v['phase'];
    $auto = (int) ($v['auto'] ?? 0) === 1;
    $bouge = false;

    if ($phase === 'portrait') {
        $compte = epreuve_auto_compte($pdo, 'portrait_participants', $code);
        if (epreuve_auto_tous_ont_repondu($compte)) {
            $st = $pdo->prepare("UPDATE portrait_veillees SET phase = 'revele', phase_debut = ?
                                 WHERE code = ? AND phase = 'portrait' AND carte = ?");
            $st->execute([now_sql(), $code, (int) $v['carte']]);
            $bouge = true;
        } elseif ($auto && epreuve_auto_temps_ecoule($v['phase_debut'] ?? null, (int) ($v['seconds'] ?? 0))) {
            if ((int) $v['indice'] < PORTRAIT_INDICES) {
                // L'indice suivant tombe, le temps repart. Conditionné sur
                // (carte, indice) lus : deux sondages, un seul indice.
                $st = $pdo->prepare("UPDATE portrait_veillees SET indice = indice + 1, phase_debut = ?
                                     WHERE code = ? AND phase = 'portrait' AND carte = ? AND indice = ?");
                $st->execute([now_sql(), $code, (int) $v['carte'], (int) $v['indice']]);
            } else {
                $st = $pdo->prepare("UPDATE portrait_veillees SET phase = 'revele', phase_debut = ?
                                     WHERE code = ? AND phase = 'portrait' AND carte = ?");
                $st->execute([now_sql(), $code, (int) $v['carte']]);
            }
            $bouge = true;
        }
    } elseif ($phase === 'revele' && $auto && epreuve_auto_lecture_finie($v['phase_debut'] ?? null)) {
        $total = count(json_decode((string) $v['deck'], true) ?: []);
        if ((int) $v['carte'] >= $total) {
            $pdo->prepare("UPDATE portrait_veillees SET phase = 'fin' WHERE code = ? AND phase = 'revele'")
                ->execute([$code]);
        } else {
            $st = $pdo->prepare("UPDATE portrait_veillees SET phase = 'portrait', carte = carte + 1, indice = 1, phase_debut = ?
                                 WHERE code = ? AND phase = 'revele' AND carte = ?");
            $st->execute([now_sql(), $code, (int) $v['carte']]);
            if ($st->rowCount() > 0) {
                $pdo->prepare('UPDATE portrait_participants SET reponse = NULL, bon = NULL, points = NULL WHERE code = ?')
                    ->execute([$code]);
            }
        }
        $bouge = true;
    }

    // Rechargée quoi qu'il arrive : quand un autre sondage a gagné la course,
    // la vérité est en base, pas dans la ligne lue avant l'écriture.
    return $bouge ? portrait_veillee_row($pdo, $code) : $v;
}

/**
 * L'animateur coupe ou rallume le mode automatique en pleine veillée — même
 * geste, mêmes raisons que sur les autres épreuves.
 */
function portrait_veillee_auto(PDO $pdo, string $code): never {
    $v = portrait_veillee_row($pdo, $code);
    $body = read_json_body();
    $cle = $body['cle'] ?? null;
    if (!is_string($cle) || !hash_equals((string) $v['cle'], $cle)) {
        json_error("Seul l'animateur peut régler la veillée.", 403);
    }
    $actif = !empty($body['actif']) ? 1 : 0;
    $seconds = $actif ? epreuve_secondes_propres($body['seconds'] ?? ((int) $v['seconds'] ?: null)) : 0;
    // phase_debut repart de maintenant : on ne fait pas tomber un indice parce
    // qu'un chrono qu'on vient d'allumer courait déjà depuis deux minutes.
    $pdo->prepare('UPDATE portrait_veillees SET auto = ?, seconds = ?, phase_debut = ? WHERE code = ?')
        ->execute([$actif, $seconds, now_sql(), $code]);
    portrait_veillee_etat($pdo, $code, null, $cle);
}

function portrait_veillee_avancer(PDO $pdo, string $code): never {
    $v = portrait_veillee_row($pdo, $code);
    $body = read_json_body();
    $cle = $body['cle'] ?? null;
    if (!is_string($cle) || !hash_equals((string) $v['cle'], $cle)) {
        json_error("Seul l'animateur peut faire avancer la veillée.", 403);
    }
    $action = is_string($body['action'] ?? null) ? $body['action'] : '';
    $deck = json_decode((string) $v['deck'], true);
    $total = count($deck);

    // Chaque bascule s'horodate : le chrono des indices et le décompte avant
    // la carte suivante se lisent tous deux sur phase_debut.
    if ($v['phase'] === 'attente') {
        $pdo->prepare("UPDATE portrait_veillees SET phase = 'portrait', carte = 1, indice = 1, phase_debut = ? WHERE code = ?")
            ->execute([now_sql(), $code]);
    } elseif ($v['phase'] === 'portrait' && $action === 'indice') {
        if ((int) $v['indice'] >= PORTRAIT_INDICES) {
            json_error('Tous les indices sont déjà révélés.', 409);
        }
        $pdo->prepare('UPDATE portrait_veillees SET indice = indice + 1, phase_debut = ? WHERE code = ? AND phase = \'portrait\' AND indice = ?')->execute([now_sql(), $code, (int) $v['indice']]);
    } elseif ($v['phase'] === 'portrait' && $action === 'reveler') {
        $pdo->prepare("UPDATE portrait_veillees SET phase = 'revele', phase_debut = ? WHERE code = ?")->execute([now_sql(), $code]);
    } elseif ($v['phase'] === 'revele' && $action === 'suivant') {
        if ((int) $v['carte'] >= $total) {
            $pdo->prepare("UPDATE portrait_veillees SET phase = 'fin' WHERE code = ?")->execute([$code]);
        } else {
            // Conditionné sur (phase, carte) lues — cf. frise_veillee_avancer.
            $st = $pdo->prepare("UPDATE portrait_veillees SET phase = 'portrait', carte = carte + 1, indice = 1, phase_debut = ? WHERE code = ? AND phase = 'revele' AND carte = ?");
            $st->execute([now_sql(), $code, (int) $v['carte']]);
            if ($st->rowCount() > 0) {
                $pdo->prepare('UPDATE portrait_participants SET reponse = NULL, bon = NULL, points = NULL WHERE code = ?')
                    ->execute([$code]);
            }
        }
    } elseif ($v['phase'] === 'fin') {
        json_error('La veillée est déjà terminée.', 409);
    } else {
        json_error('Action impossible dans cette phase.', 400);
    }
    portrait_veillee_etat($pdo, $code, null, $cle);
}

/** Une réponse libre, une seule par portrait — plus tôt, plus de points. */
function portrait_veillee_reponse(PDO $pdo, string $code): never {
    $v = portrait_veillee_row($pdo, $code);
    $body = read_json_body();
    $jeton = is_string($body['jeton'] ?? null) ? $body['jeton'] : '';
    $st = $pdo->prepare('SELECT * FROM portrait_participants WHERE code = ? AND jeton = ?');
    $st->execute([$code, $jeton]);
    $moi = $st->fetch();
    if ($moi === false) {
        json_error('Participant inconnu dans cette veillée.', 403);
    }
    if ($v['phase'] !== 'portrait') {
        json_error("Ce n'est pas le moment de répondre.", 409);
    }
    if ($moi['reponse'] !== null) {
        json_error('Ta réponse est déjà posée pour ce portrait.', 409);
    }
    $carte = $body['carte'] ?? null;
    $texte = is_string($body['texte'] ?? null) ? trim($body['texte']) : '';
    if (!is_int($carte) || $carte !== (int) $v['carte'] || $texte === '' || mb_strlen($texte) > 60) {
        json_error('Réponse invalide.', 400);
    }
    $deck = json_decode((string) $v['deck'], true);
    $bon = portrait_correspond($texte, $deck, $carte - 1) ? 1 : 0;
    $points = $bon ? (PORTRAIT_INDICES + 1 - (int) $v['indice']) : 0;
    $pdo->prepare('UPDATE portrait_participants SET reponse = ?, bon = ?, points = ?, score = score + ? WHERE id = ? AND reponse IS NULL')
        ->execute([$texte, $bon, $points, $points, $moi['id']]);
    portrait_veillee_etat($pdo, $code, $jeton, null);
}

/**
 * L'état poli par tous. Pendant la phase « portrait » : seulement les
 * indices déjà révélés — jamais les suivants, jamais la réponse ni la
 * référence, jamais les textes proposés par les autres.
 */
function portrait_veillee_etat(PDO $pdo, string $code, ?string $jeton, ?string $cle): never {
    $v = portrait_veillee_row($pdo, $code);
    $v = portrait_veillee_souffle($pdo, $code, $v, $jeton);
    $deck = json_decode((string) $v['deck'], true);
    $total = count($deck);
    $carte = (int) $v['carte'];
    $indice = (int) $v['indice'];
    $phase = (string) $v['phase'];

    $st = $pdo->prepare('SELECT * FROM portrait_participants WHERE code = ? ORDER BY score DESC, prenom');
    $st->execute([$code]);
    $participants = [];
    $moi = null;
    foreach ($st->fetchAll() as $p) {
        $participants[] = [
            'prenom'   => $p['prenom'],
            'score'    => (int) $p['score'],
            'aRepondu' => $p['reponse'] !== null,
            'bon'      => $phase === 'revele' && $p['bon'] !== null ? (bool) $p['bon'] : null,
            'points'   => $phase === 'revele' && $p['points'] !== null ? (int) $p['points'] : null,
        ];
        if ($jeton !== null && hash_equals((string) $p['jeton'], $jeton)) {
            $moi = ['prenom' => $p['prenom'], 'score' => (int) $p['score'],
                'aRepondu' => $p['reponse'] !== null,
                'bon' => $p['bon'] === null ? null : (bool) $p['bon'],
                'points' => $p['points'] === null ? null : (int) $p['points']];
        }
    }

    $enCours = null;
    if (($phase === 'portrait' || $phase === 'revele') && isset($deck[$carte - 1])) {
        $p = $deck[$carte - 1];
        $enCours = [
            'indices'   => array_slice($p['indices'], 0, $phase === 'revele' ? PORTRAIT_INDICES : $indice),
            'nbIndices' => PORTRAIT_INDICES,
            'indice'    => $indice,
        ];
        if ($phase === 'revele') {
            $enCours['reponse'] = $p['reponse'];
            $enCours['ref'] = $p['ref'];
        }
    }

    // Le décompte est ANNONCÉ, jamais subi. En phase « portrait », il dit
    // quand le prochain indice tombera ; à la révélation, quand on enchaîne.
    $auto = (int) ($v['auto'] ?? 0) === 1;
    $restant = null;
    if ($auto && $phase === 'portrait') {
        $restant = epreuve_auto_restant($v['phase_debut'] ?? null, (int) ($v['seconds'] ?? 0));
    } elseif ($auto && $phase === 'revele') {
        $restant = epreuve_auto_restant($v['phase_debut'] ?? null, EPREUVE_ENCHAINEMENT_SECONDS);
    }

    json_out([
        'phase'        => $phase,
        'mode'         => (string) $v['mode'],
        'carte'        => $carte,
        'total'        => $total,
        'participants' => $participants,
        'moi'          => $moi,
        'enCours'      => $enCours,
        'auto'         => $auto,
        'seconds'      => (int) ($v['seconds'] ?? 0),
        'restant'      => $restant,
        'animateur'    => $cle !== null && hash_equals((string) $v['cle'], $cle),
    ]);
}
