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
   accents, traits d'union ignorés) contre la liste `accepte` du portrait.

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
        $propre[] = ['reponse' => $reponse, 'accepte' => array_values(array_unique($acc)),
            'indices' => $inds, 'ref' => $ref === '' ? null : $ref];
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
    throttle_or_429($pdo, 'epreuve-creer', 10);
    epreuve_menage($pdo);
    portrait_menage($pdo);
    $body = read_json_body();
    $deck = portrait_deck_propre($body['deck'] ?? null);
    $pseudo = frise_prenom($body['pseudo'] ?? null);

    $code = frise_code($pdo, 'epreuve_duels', 'PD-');
    $cle = bin2hex(random_bytes(16));
    // total = score maximum (5 points par portrait), pour borner les scores.
    $st = $pdo->prepare(
        'INSERT INTO epreuve_duels (code, cle, mode, deck, total, p1_pseudo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    $st->execute([$code, $cle, 'De qui parle-t-on ?', json_encode($deck, JSON_UNESCAPED_UNICODE),
        count($deck) * PORTRAIT_INDICES, $pseudo, now_sql()]);
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
    throttle_or_429($pdo, 'epreuve-creer', 10);
    portrait_menage($pdo);
    $body = read_json_body();
    $deck = portrait_deck_propre($body['deck'] ?? null);

    $code = frise_code($pdo, 'portrait_veillees', 'PV-');
    $cle = bin2hex(random_bytes(16));
    $st = $pdo->prepare(
        "INSERT INTO portrait_veillees (code, cle, mode, deck, phase, carte, indice, created_at)
         VALUES (?, ?, 'De qui parle-t-on ?', ?, 'attente', 0, 0, ?)"
    );
    $st->execute([$code, $cle, json_encode($deck, JSON_UNESCAPED_UNICODE), now_sql()]);
    json_out(['code' => $code, 'cle' => $cle]);
}

function portrait_veillee_rejoindre(PDO $pdo, string $code): never {
    throttle_or_429($pdo, 'epreuve-rejoindre', 60);
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

    if ($v['phase'] === 'attente') {
        $pdo->prepare("UPDATE portrait_veillees SET phase = 'portrait', carte = 1, indice = 1 WHERE code = ?")
            ->execute([$code]);
    } elseif ($v['phase'] === 'portrait' && $action === 'indice') {
        if ((int) $v['indice'] >= PORTRAIT_INDICES) {
            json_error('Tous les indices sont déjà révélés.', 409);
        }
        $pdo->prepare('UPDATE portrait_veillees SET indice = indice + 1 WHERE code = ?')->execute([$code]);
    } elseif ($v['phase'] === 'portrait' && $action === 'reveler') {
        $pdo->prepare("UPDATE portrait_veillees SET phase = 'revele' WHERE code = ?")->execute([$code]);
    } elseif ($v['phase'] === 'revele' && $action === 'suivant') {
        if ((int) $v['carte'] >= $total) {
            $pdo->prepare("UPDATE portrait_veillees SET phase = 'fin' WHERE code = ?")->execute([$code]);
        } else {
            $pdo->prepare("UPDATE portrait_veillees SET phase = 'portrait', carte = carte + 1, indice = 1 WHERE code = ?")
                ->execute([$code]);
            $pdo->prepare('UPDATE portrait_participants SET reponse = NULL, bon = NULL, points = NULL WHERE code = ?')
                ->execute([$code]);
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
    $portrait = $deck[$carte - 1];
    $bon = in_array(portrait_norm($texte), $portrait['accepte'], true) ? 1 : 0;
    $points = $bon ? (PORTRAIT_INDICES + 1 - (int) $v['indice']) : 0;
    $pdo->prepare('UPDATE portrait_participants SET reponse = ?, bon = ?, points = ?, score = score + ? WHERE id = ?')
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

    json_out([
        'phase'        => $phase,
        'mode'         => (string) $v['mode'],
        'carte'        => $carte,
        'total'        => $total,
        'participants' => $participants,
        'moi'          => $moi,
        'enCours'      => $enCours,
        'animateur'    => $cle !== null && hash_equals((string) $v['cle'], $cle),
    ]);
}
