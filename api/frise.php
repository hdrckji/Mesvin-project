<?php
/* ============================================================================
   La Frise (ATELIER D'ESSAI — voir frise-essai.html, page non reliée au site).

   Duels et veillées « par code », SANS compte : l'atelier doit se tester avec
   n'importe qui, sans créer d'utilisateurs. Aucune route existante n'est
   touchée — l'appli en production ignore tout de ce module.

   - POST /api/frise/duel                    : créer un défi (renvoie code + clé)
   - GET  /api/frise/duel/{code}             : le paquet et les scores
   - POST /api/frise/duel/{code}/score       : poser son score (clé = créateur)
   - POST /api/frise/veillee                 : ouvrir une veillée (code + clé)
   - POST /api/frise/veillee/{code}/rejoindre: entrer avec un prénom (jeton)
   - POST /api/frise/veillee/{code}/avancer  : l'animateur fait avancer (clé)
   - POST /api/frise/veillee/{code}/reponse  : proposer une position (jeton)
   - GET  /api/frise/veillee/{code}/etat     : l'état, poli par tout le monde

   Le PAQUET (deck) est fourni par le client à la création : une liste de
   cartes { t: titre, r: référence|null, o: rang } — la première est déjà
   posée pour amorcer la frise. Le serveur ne connaît pas les données
   bibliques : il ne fait que garder le paquet, arbitrer les positions (les
   rangs `o` suffisent) et compter les points. L'état d'une veillée ne révèle
   JAMAIS les cartes pas encore jouées.

   Ménage : les défis de plus de 7 jours et les veillées de plus de 24 h sont
   balayés à chaque création. Plafonds par IP sur toutes les créations.
   ========================================================================== */

defined('GRAINE_API') || exit;

const FRISE_DECK_MIN = 4;     // 3 cartes à placer + la carte d'amorce
const FRISE_DECK_MAX = 80;
const FRISE_VEILLEE_MAX_PARTICIPANTS = 40;

/* ---- Aides ------------------------------------------------------------------ */

/** Code court à partager (alphabet sans caractères ambigus, préfixé). */
function frise_code(PDO $pdo, string $table, string $prefixe): string {
    $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for ($try = 0; $try < 50; $try++) {
        $code = $prefixe;
        for ($i = 0; $i < 5; $i++) {
            $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        $st = $pdo->prepare("SELECT 1 FROM $table WHERE code = ?");
        $st->execute([$code]);
        if ($st->fetch() === false) {
            return $code;
        }
    }
    throw new RuntimeException('Impossible de générer un code de frise unique.');
}

/**
 * Valide le paquet reçu et le rend sous forme normalisée [{t, r, o}] :
 * titres bornés, rangs entiers TOUS DISTINCTS (sinon l'arbitrage du
 * placement deviendrait ambigu). 400 si le paquet ne tient pas debout.
 */
function frise_deck_propre(mixed $deck): array {
    if (!is_array($deck) || count($deck) < FRISE_DECK_MIN || count($deck) > FRISE_DECK_MAX) {
        json_error('Paquet invalide (entre ' . FRISE_DECK_MIN . ' et ' . FRISE_DECK_MAX . ' cartes).', 400);
    }
    $propre = [];
    $rangs = [];
    foreach (array_values($deck) as $carte) {
        $t = is_array($carte) ? trim((string) ($carte['t'] ?? '')) : '';
        $r = is_array($carte) && isset($carte['r']) && is_string($carte['r']) ? trim($carte['r']) : null;
        $o = is_array($carte) && is_int($carte['o'] ?? null) ? $carte['o'] : null;
        if ($t === '' || mb_strlen($t) > 90 || $o === null || isset($rangs[$o])
            || ($r !== null && mb_strlen($r) > 60)) {
            json_error('Paquet invalide (carte mal formée ou rangs en double).', 400);
        }
        $rangs[$o] = true;
        $propre[] = ['t' => $t, 'r' => $r === '' ? null : $r, 'o' => $o];
    }
    return $propre;
}

/** Pseudo/prénom présentable (1 à 20 caractères). */
function frise_prenom(mixed $v): string {
    $p = is_string($v) ? trim($v) : '';
    if ($p === '' || mb_strlen($p) > 20) {
        json_error('Prénom requis (20 caractères maximum).', 400);
    }
    return $p;
}

/**
 * L'unique position juste d'une carte dans une frise triée par rang :
 * l'index du premier élément de rang supérieur (ou la fin).
 */
function frise_position_juste(array $frise, int $rang): int {
    foreach ($frise as $i => $c) {
        if ($c['o'] > $rang) {
            return $i;
        }
    }
    return count($frise);
}

/** Balaie les parties finies d'être utiles (défis 7 j, veillées 24 h). */
function frise_menage(PDO $pdo): void {
    $pdo->prepare('DELETE FROM frise_duels WHERE created_at < ?')->execute([now_sql_plus(-7 * 86400)]);
    $st = $pdo->prepare('SELECT code FROM frise_veillees WHERE created_at < ?');
    $st->execute([now_sql_plus(-86400)]);
    foreach ($st->fetchAll() as $row) {
        $pdo->prepare('DELETE FROM frise_participants WHERE code = ?')->execute([$row['code']]);
        $pdo->prepare('DELETE FROM frise_veillees WHERE code = ?')->execute([$row['code']]);
    }
}

/* ---- Duel par code ----------------------------------------------------------- */

function frise_duel_create(PDO $pdo): never {
    throttle_or_429($pdo, 'frise-creer', 10);
    frise_menage($pdo);
    $body = read_json_body();
    $deck = frise_deck_propre($body['deck'] ?? null);
    $mode = is_string($body['mode'] ?? null) ? mb_substr(trim($body['mode']), 0, 40) : 'La Frise';
    $pseudo = frise_prenom($body['pseudo'] ?? null);

    $code = frise_code($pdo, 'frise_duels', 'FD-');
    $cle = bin2hex(random_bytes(16));
    $st = $pdo->prepare(
        'INSERT INTO frise_duels (code, cle, mode, deck, total, p1_pseudo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    $st->execute([$code, $cle, $mode, json_encode($deck, JSON_UNESCAPED_UNICODE),
        count($deck) - 1, $pseudo, now_sql()]);
    json_out(['code' => $code, 'cle' => $cle]);
}

function frise_duel_row(PDO $pdo, string $code): array {
    $st = $pdo->prepare('SELECT * FROM frise_duels WHERE code = ?');
    $st->execute([$code]);
    $duel = $st->fetch();
    if ($duel === false) {
        json_error('Défi introuvable — vérifie le code.', 404);
    }
    return $duel;
}

function frise_duel_get(PDO $pdo, string $code): never {
    $duel = frise_duel_row($pdo, $code);
    json_out([
        'mode'  => $duel['mode'],
        'deck'  => json_decode((string) $duel['deck'], true),
        'total' => (int) $duel['total'],
        'p1'    => ['pseudo' => $duel['p1_pseudo'],
                    'score'  => $duel['p1_score'] === null ? null : (int) $duel['p1_score']],
        'p2'    => $duel['p2_pseudo'] === null ? null
                 : ['pseudo' => $duel['p2_pseudo'],
                    'score'  => $duel['p2_score'] === null ? null : (int) $duel['p2_score']],
    ]);
}

/**
 * Pose un score. Avec la clé du créateur → case 1 ; sans clé → la case 2, si
 * elle est libre (premier arrivé). Chaque case ne s'écrit qu'une fois.
 */
function frise_duel_score(PDO $pdo, string $code): never {
    throttle_or_429($pdo, 'frise-score', 60);
    $duel = frise_duel_row($pdo, $code);
    $body = read_json_body();
    $score = $body['score'] ?? null;
    if (!is_int($score) || $score < 0 || $score > (int) $duel['total']) {
        json_error('Score invalide.', 400);
    }
    $cle = is_string($body['cle'] ?? null) ? $body['cle'] : '';

    if ($cle !== '' && hash_equals((string) $duel['cle'], $cle)) {
        if ($duel['p1_score'] !== null) {
            json_error('Ton score est déjà posé.', 409);
        }
        $pdo->prepare('UPDATE frise_duels SET p1_score = ? WHERE code = ? AND p1_score IS NULL')->execute([$score, $code]);
    } else {
        if ($duel['p2_pseudo'] !== null) {
            json_error('Ce défi a déjà trouvé son adversaire.', 409);
        }
        $pseudo = frise_prenom($body['pseudo'] ?? null);
        $pdo->prepare('UPDATE frise_duels SET p2_pseudo = ?, p2_score = ? WHERE code = ? AND p2_pseudo IS NULL')
            ->execute([$pseudo, $score, $code]);
    }
    frise_duel_get($pdo, $code);
}

/* ---- Veillée en direct -------------------------------------------------------- */

function frise_veillee_row(PDO $pdo, string $code): array {
    $st = $pdo->prepare('SELECT * FROM frise_veillees WHERE code = ?');
    $st->execute([$code]);
    $v = $st->fetch();
    if ($v === false) {
        json_error('Veillée introuvable — vérifie le code.', 404);
    }
    return $v;
}

function frise_veillee_create(PDO $pdo): never {
    throttle_or_429($pdo, 'frise-creer', 10);
    frise_menage($pdo);
    $body = read_json_body();
    $deck = frise_deck_propre($body['deck'] ?? null);
    $mode = is_string($body['mode'] ?? null) ? mb_substr(trim($body['mode']), 0, 40) : 'La Frise';

    $code = frise_code($pdo, 'frise_veillees', 'FV-');
    $cle = bin2hex(random_bytes(16));
    $st = $pdo->prepare(
        "INSERT INTO frise_veillees (code, cle, mode, deck, phase, carte, created_at)
         VALUES (?, ?, ?, ?, 'attente', 0, ?)"
    );
    $st->execute([$code, $cle, $mode, json_encode($deck, JSON_UNESCAPED_UNICODE), now_sql()]);
    json_out(['code' => $code, 'cle' => $cle]);
}

function frise_veillee_rejoindre(PDO $pdo, string $code): never {
    throttle_or_429($pdo, 'frise-rejoindre', 60);
    $v = frise_veillee_row($pdo, $code);
    if ($v['phase'] === 'fin') {
        json_error('Cette veillée est terminée.', 409);
    }
    $st = $pdo->prepare('SELECT COUNT(*) FROM frise_participants WHERE code = ?');
    $st->execute([$code]);
    if ((int) $st->fetchColumn() >= FRISE_VEILLEE_MAX_PARTICIPANTS) {
        json_error('La veillée est au complet.', 409);
    }
    $prenom = frise_prenom(read_json_body()['prenom'] ?? null);
    $jeton = bin2hex(random_bytes(16));
    $st = $pdo->prepare(
        'INSERT INTO frise_participants (code, jeton, prenom, score, created_at)
         VALUES (?, ?, ?, 0, ?)'
    );
    $st->execute([$code, $jeton, $prenom, now_sql()]);
    json_out(['jeton' => $jeton]);
}

/**
 * L'animateur fait avancer la veillée :
 * attente → placement (carte 1) → révélation → placement (carte suivante,
 * réponses remises à zéro) → … → fin quand toutes les cartes sont passées.
 */
function frise_veillee_avancer(PDO $pdo, string $code): never {
    $v = frise_veillee_row($pdo, $code);
    $cle = read_json_body()['cle'] ?? null;
    if (!is_string($cle) || !hash_equals((string) $v['cle'], $cle)) {
        json_error("Seul l'animateur peut faire avancer la veillée.", 403);
    }
    $deck = json_decode((string) $v['deck'], true);
    $total = count($deck) - 1;

    if ($v['phase'] === 'attente') {
        $pdo->prepare("UPDATE frise_veillees SET phase = 'placement', carte = 1 WHERE code = ?")
            ->execute([$code]);
    } elseif ($v['phase'] === 'placement') {
        $pdo->prepare("UPDATE frise_veillees SET phase = 'revele' WHERE code = ?")->execute([$code]);
    } elseif ($v['phase'] === 'revele') {
        if ((int) $v['carte'] >= $total) {
            $pdo->prepare("UPDATE frise_veillees SET phase = 'fin' WHERE code = ?")->execute([$code]);
        } else {
            // Conditionné sur (phase, carte) lues : deux « avancer » simultanés
            // (animateur à deux onglets) n'avancent qu'une fois ; le reset des
            // réponses ne suit que si l'avancement a bien eu lieu.
            $st = $pdo->prepare("UPDATE frise_veillees SET phase = 'placement', carte = carte + 1 WHERE code = ? AND phase = 'revele' AND carte = ?");
            $st->execute([$code, (int) $v['carte']]);
            if ($st->rowCount() > 0) {
                $pdo->prepare('UPDATE frise_participants SET reponse = NULL, bon = NULL WHERE code = ?')
                    ->execute([$code]);
            }
        }
    } else {
        json_error('La veillée est déjà terminée.', 409);
    }
    frise_veillee_etat($pdo, $code, null, $cle);
}

/** Un participant propose une position pour la carte en cours. */
function frise_veillee_reponse(PDO $pdo, string $code): never {
    $v = frise_veillee_row($pdo, $code);
    $body = read_json_body();
    $jeton = is_string($body['jeton'] ?? null) ? $body['jeton'] : '';
    $st = $pdo->prepare('SELECT * FROM frise_participants WHERE code = ? AND jeton = ?');
    $st->execute([$code, $jeton]);
    $moi = $st->fetch();
    if ($moi === false) {
        json_error('Participant inconnu dans cette veillée.', 403);
    }
    if ($v['phase'] !== 'placement') {
        json_error("Ce n'est pas le moment de répondre.", 409);
    }
    if ($moi['reponse'] !== null) {
        json_error('Ta réponse est déjà posée pour cette carte.', 409);
    }
    $carte = $body['carte'] ?? null;
    $position = $body['position'] ?? null;
    if (!is_int($carte) || $carte !== (int) $v['carte'] || !is_int($position) || $position < 0) {
        json_error('Réponse invalide (mauvaise carte ou position).', 400);
    }

    // La frise au moment de cette carte : l'amorce + les cartes déjà révélées,
    // chacune à sa vraie place — tout le monde a donc la même sous les yeux.
    $deck = json_decode((string) $v['deck'], true);
    $frise = array_slice($deck, 0, $carte);
    usort($frise, fn (array $a, array $b): int => $a['o'] <=> $b['o']);
    if ($position > count($frise)) {
        json_error('Réponse invalide (position hors de la frise).', 400);
    }
    $bon = $position === frise_position_juste($frise, (int) $deck[$carte]['o']) ? 1 : 0;
    $pdo->prepare('UPDATE frise_participants SET reponse = ?, bon = ?, score = score + ? WHERE id = ? AND reponse IS NULL')
        ->execute([$position, $bon, $bon, $moi['id']]);
    frise_veillee_etat($pdo, $code, $jeton, null);
}

/**
 * L'état que tout le monde polle. Ne révèle JAMAIS les cartes à venir :
 * seulement la frise déjà posée, la carte en cours, et — en phase de
 * révélation seulement — la position juste et les verdicts.
 */
function frise_veillee_etat(PDO $pdo, string $code, ?string $jeton, ?string $cle): never {
    $v = frise_veillee_row($pdo, $code);
    $deck = json_decode((string) $v['deck'], true);
    $total = count($deck) - 1;
    $carte = (int) $v['carte'];
    $phase = (string) $v['phase'];

    $st = $pdo->prepare('SELECT * FROM frise_participants WHERE code = ? ORDER BY score DESC, prenom');
    $st->execute([$code]);
    $rows = $st->fetchAll();

    $participants = [];
    $moi = null;
    foreach ($rows as $p) {
        $participants[] = [
            'prenom'   => $p['prenom'],
            'score'    => (int) $p['score'],
            'aRepondu' => $p['reponse'] !== null,
            // le verdict des autres n'apparaît qu'à la révélation
            'bon'      => $phase === 'revele' && $p['bon'] !== null ? (bool) $p['bon'] : null,
        ];
        if ($jeton !== null && hash_equals((string) $p['jeton'], $jeton)) {
            $moi = ['prenom' => $p['prenom'], 'score' => (int) $p['score'],
                'reponse' => $p['reponse'] === null ? null : (int) $p['reponse'],
                'bon'     => $p['bon'] === null ? null : (bool) $p['bon']];
        }
    }

    $frise = [];
    $enCours = null;
    $positionJuste = null;
    if ($phase === 'placement' || $phase === 'revele' || $phase === 'fin') {
        // Les cartes déjà tombées (avant la carte en cours), à leur place.
        $bornes = $phase === 'fin' ? $total + 1 : $carte;
        $posees = array_slice($deck, 0, $bornes);
        usort($posees, fn (array $a, array $b): int => $a['o'] <=> $b['o']);
        $frise = array_map(fn (array $c): array => ['t' => $c['t'], 'r' => $c['r']], $posees);
        if ($phase !== 'fin') {
            $enCours = ['t' => $deck[$carte]['t'], 'r' => $phase === 'revele' ? $deck[$carte]['r'] : null];
            if ($phase === 'revele') {
                $avant = array_slice($deck, 0, $carte);
                usort($avant, fn (array $a, array $b): int => $a['o'] <=> $b['o']);
                $positionJuste = frise_position_juste($avant, (int) $deck[$carte]['o']);
            }
        }
    }

    json_out([
        'phase'         => $phase,
        'mode'          => $v['mode'],
        'carte'         => $carte,
        'total'         => $total,
        'participants'  => $participants,
        'moi'           => $moi,
        'frise'         => $frise,
        'enCours'       => $enCours,
        'positionJuste' => $positionJuste,
        'animateur'     => $cle !== null && hash_equals((string) $v['cle'], $cle),
    ]);
}
