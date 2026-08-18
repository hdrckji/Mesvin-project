<?php
/* ============================================================================
   Épreuves à choix (« Qui a dit ça ? », « Écrit… ou pas ? »…) — défis par
   code et veillées en direct, SANS compte. Généralisation du modèle de la
   Frise (api/frise.php) pour des paquets de QUESTIONS À CHOIX.

   - POST /api/epreuve/duel                     : créer un défi (code + clé)
   - GET  /api/epreuve/duel/{code}              : le paquet et les scores
   - POST /api/epreuve/duel/{code}/score        : poser son score
   - POST /api/epreuve/veillee                  : ouvrir une veillée
   - POST /api/epreuve/veillee/{code}/rejoindre : entrer avec un prénom
   - POST /api/epreuve/veillee/{code}/avancer   : l'animateur rythme (clé)
   - POST /api/epreuve/veillee/{code}/reponse   : choisir une option (jeton)
   - GET  /api/epreuve/veillee/{code}/etat      : l'état, poli par tous

   Le paquet est fourni par le client à la création : des cartes
   { q: énoncé, options: [2..4], bonne: index, ref: référence|null,
     rev: précision révélée|null }. En veillée, l'état ne transmet JAMAIS
   `bonne`, `ref` ni `rev` pendant la phase de réponse — seulement à la
   révélation : impossible de tricher en lisant le réseau.

   Codes ED- (défis, 7 jours) et EV- (veillées, 24 h). Mêmes plafonds et le
   même ménage que la Frise (frise_menage s'occupe des tables de la Frise ;
   epreuve_menage des siennes).
   ========================================================================== */

defined('GRAINE_API') || exit;

const EPREUVE_DECK_MIN = 3;
const EPREUVE_DECK_MAX = 40;
const EPREUVE_VEILLEE_MAX_PARTICIPANTS = 40;

/* ---- Aides ------------------------------------------------------------------ */

/**
 * Valide le paquet reçu → [{q, options, bonne, ref, rev}] normalisé.
 * 400 si une carte ne tient pas debout.
 */
function epreuve_deck_propre(mixed $deck): array {
    if (!is_array($deck) || count($deck) < EPREUVE_DECK_MIN || count($deck) > EPREUVE_DECK_MAX) {
        json_error('Paquet invalide (entre ' . EPREUVE_DECK_MIN . ' et ' . EPREUVE_DECK_MAX . ' cartes).', 400);
    }
    $propre = [];
    foreach (array_values($deck) as $carte) {
        if (!is_array($carte)) {
            json_error('Paquet invalide (carte mal formée).', 400);
        }
        $q = trim((string) ($carte['q'] ?? ''));
        $options = $carte['options'] ?? null;
        $bonne = $carte['bonne'] ?? null;
        $ref = isset($carte['ref']) && is_string($carte['ref']) ? trim($carte['ref']) : null;
        $rev = isset($carte['rev']) && is_string($carte['rev']) ? trim($carte['rev']) : null;
        if ($q === '' || mb_strlen($q) > 300
            || !is_array($options) || count($options) < 2 || count($options) > 4
            || !is_int($bonne) || $bonne < 0 || $bonne >= count($options)
            || ($ref !== null && mb_strlen($ref) > 60)
            || ($rev !== null && mb_strlen($rev) > 300)) {
            json_error('Paquet invalide (carte mal formée).', 400);
        }
        $opts = [];
        foreach (array_values($options) as $o) {
            $o = is_string($o) ? trim($o) : '';
            if ($o === '' || mb_strlen($o) > 90) {
                json_error('Paquet invalide (option mal formée).', 400);
            }
            $opts[] = $o;
        }
        $propre[] = ['q' => $q, 'options' => $opts, 'bonne' => $bonne,
            'ref' => $ref === '' ? null : $ref, 'rev' => $rev === '' ? null : $rev];
    }
    return $propre;
}

/** Balaie les parties finies d'être utiles (défis 7 j, veillées 24 h). */
function epreuve_menage(PDO $pdo): void {
    $pdo->prepare('DELETE FROM epreuve_duels WHERE created_at < ?')->execute([now_sql_plus(-7 * 86400)]);
    $st = $pdo->prepare('SELECT code FROM epreuve_veillees WHERE created_at < ?');
    $st->execute([now_sql_plus(-86400)]);
    foreach ($st->fetchAll() as $row) {
        $pdo->prepare('DELETE FROM epreuve_participants WHERE code = ?')->execute([$row['code']]);
        $pdo->prepare('DELETE FROM epreuve_veillees WHERE code = ?')->execute([$row['code']]);
    }
}

/* ---- Duel par code ----------------------------------------------------------- */

function epreuve_duel_create(PDO $pdo): never {
    // 40 et non 10 : un animateur qui prépare sa soirée ouvre, essaie, referme
    // et recommence — et toute l'église partage son adresse. Dix salles par
    // heure, c'était épuisé avant même que la veillée commence.
    throttle_or_429($pdo, 'epreuve-creer', 40);
    epreuve_menage($pdo);
    $body = read_json_body();
    $deck = epreuve_deck_propre($body['deck'] ?? null);
    $mode = is_string($body['mode'] ?? null) ? mb_substr(trim($body['mode']), 0, 40) : 'Épreuve';
    $pseudo = frise_prenom($body['pseudo'] ?? null);

    $code = frise_code($pdo, 'epreuve_duels', 'ED-');
    $cle = bin2hex(random_bytes(16));
    $st = $pdo->prepare(
        'INSERT INTO epreuve_duels (code, cle, mode, deck, total, p1_pseudo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    $st->execute([$code, $cle, $mode, json_encode($deck, JSON_UNESCAPED_UNICODE),
        count($deck), $pseudo, now_sql()]);
    json_out(['code' => $code, 'cle' => $cle]);
}

function epreuve_duel_row(PDO $pdo, string $code): array {
    $st = $pdo->prepare('SELECT * FROM epreuve_duels WHERE code = ?');
    $st->execute([$code]);
    $duel = $st->fetch();
    if ($duel === false) {
        json_error('Défi introuvable — vérifie le code.', 404);
    }
    return $duel;
}

function epreuve_duel_get(PDO $pdo, string $code): never {
    $duel = epreuve_duel_row($pdo, $code);
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

/** Même règle que la Frise : la clé → case 1 ; sans clé → case 2, une fois. */
function epreuve_duel_score(PDO $pdo, string $code): never {
    throttle_or_429($pdo, 'epreuve-score', 60);
    $duel = epreuve_duel_row($pdo, $code);
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
        $pdo->prepare('UPDATE epreuve_duels SET p1_score = ? WHERE code = ? AND p1_score IS NULL')->execute([$score, $code]);
    } else {
        if ($duel['p2_pseudo'] !== null) {
            json_error('Ce défi a déjà trouvé son adversaire.', 409);
        }
        $pseudo = frise_prenom($body['pseudo'] ?? null);
        $pdo->prepare('UPDATE epreuve_duels SET p2_pseudo = ?, p2_score = ? WHERE code = ? AND p2_pseudo IS NULL')
            ->execute([$pseudo, $score, $code]);
    }
    epreuve_duel_get($pdo, $code);
}

/* ---- Veillée en direct -------------------------------------------------------- */

function epreuve_veillee_row(PDO $pdo, string $code): array {
    $st = $pdo->prepare('SELECT * FROM epreuve_veillees WHERE code = ?');
    $st->execute([$code]);
    $v = $st->fetch();
    if ($v === false) {
        json_error('Veillée introuvable — vérifie le code.', 404);
    }
    return $v;
}

function epreuve_veillee_create(PDO $pdo): never {
    // 40 et non 10 : un animateur qui prépare sa soirée ouvre, essaie, referme
    // et recommence — et toute l'église partage son adresse. Dix salles par
    // heure, c'était épuisé avant même que la veillée commence.
    throttle_or_429($pdo, 'epreuve-creer', 40);
    epreuve_menage($pdo);
    $body = read_json_body();
    $deck = epreuve_deck_propre($body['deck'] ?? null);
    $mode = is_string($body['mode'] ?? null) ? mb_substr(trim($body['mode']), 0, 40) : 'Épreuve';

    $code = frise_code($pdo, 'epreuve_veillees', 'EV-');
    $cle = bin2hex(random_bytes(16));
    $st = $pdo->prepare(
        "INSERT INTO epreuve_veillees (code, cle, mode, deck, phase, carte, created_at)
         VALUES (?, ?, ?, ?, 'attente', 0, ?)"
    );
    $st->execute([$code, $cle, $mode, json_encode($deck, JSON_UNESCAPED_UNICODE), now_sql()]);
    json_out(['code' => $code, 'cle' => $cle]);
}

function epreuve_veillee_rejoindre(PDO $pdo, string $code): never {
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
    $v = epreuve_veillee_row($pdo, $code);
    if ($v['phase'] === 'fin') {
        json_error('Cette veillée est terminée.', 409);
    }
    $st = $pdo->prepare('SELECT COUNT(*) FROM epreuve_participants WHERE code = ?');
    $st->execute([$code]);
    if ((int) $st->fetchColumn() >= EPREUVE_VEILLEE_MAX_PARTICIPANTS) {
        json_error('La veillée est au complet.', 409);
    }
    $prenom = frise_prenom(read_json_body()['prenom'] ?? null);
    $jeton = bin2hex(random_bytes(16));
    $st = $pdo->prepare(
        'INSERT INTO epreuve_participants (code, jeton, prenom, score, created_at)
         VALUES (?, ?, ?, 0, ?)'
    );
    $st->execute([$code, $jeton, $prenom, now_sql()]);
    json_out(['jeton' => $jeton]);
}

/** attente → question (carte 1) → revele → question suivante → … → fin. */
function epreuve_veillee_avancer(PDO $pdo, string $code): never {
    $v = epreuve_veillee_row($pdo, $code);
    $cle = read_json_body()['cle'] ?? null;
    if (!is_string($cle) || !hash_equals((string) $v['cle'], $cle)) {
        json_error("Seul l'animateur peut faire avancer la veillée.", 403);
    }
    $deck = json_decode((string) $v['deck'], true);
    $total = count($deck);

    if ($v['phase'] === 'attente') {
        $pdo->prepare("UPDATE epreuve_veillees SET phase = 'question', carte = 1 WHERE code = ?")
            ->execute([$code]);
    } elseif ($v['phase'] === 'question') {
        $pdo->prepare("UPDATE epreuve_veillees SET phase = 'revele' WHERE code = ?")->execute([$code]);
    } elseif ($v['phase'] === 'revele') {
        if ((int) $v['carte'] >= $total) {
            $pdo->prepare("UPDATE epreuve_veillees SET phase = 'fin' WHERE code = ?")->execute([$code]);
        } else {
            // Conditionné sur (phase, carte) lues — cf. frise_veillee_avancer.
            $st = $pdo->prepare("UPDATE epreuve_veillees SET phase = 'question', carte = carte + 1 WHERE code = ? AND phase = 'revele' AND carte = ?");
            $st->execute([$code, (int) $v['carte']]);
            if ($st->rowCount() > 0) {
                $pdo->prepare('UPDATE epreuve_participants SET reponse = NULL, bon = NULL WHERE code = ?')
                    ->execute([$code]);
            }
        }
    } else {
        json_error('La veillée est déjà terminée.', 409);
    }
    epreuve_veillee_etat($pdo, $code, null, $cle);
}

/** Un participant choisit une option pour la question en cours. */
function epreuve_veillee_reponse(PDO $pdo, string $code): never {
    $v = epreuve_veillee_row($pdo, $code);
    $body = read_json_body();
    $jeton = is_string($body['jeton'] ?? null) ? $body['jeton'] : '';
    $st = $pdo->prepare('SELECT * FROM epreuve_participants WHERE code = ? AND jeton = ?');
    $st->execute([$code, $jeton]);
    $moi = $st->fetch();
    if ($moi === false) {
        json_error('Participant inconnu dans cette veillée.', 403);
    }
    if ($v['phase'] !== 'question') {
        json_error("Ce n'est pas le moment de répondre.", 409);
    }
    if ($moi['reponse'] !== null) {
        json_error('Ta réponse est déjà posée pour cette question.', 409);
    }
    $carte = $body['carte'] ?? null;
    $choix = $body['choix'] ?? null;
    $deck = json_decode((string) $v['deck'], true);
    $item = $deck[(int) $v['carte'] - 1] ?? null;
    if (!is_int($carte) || $carte !== (int) $v['carte'] || !is_int($choix)
        || $item === null || $choix < 0 || $choix >= count($item['options'])) {
        json_error('Réponse invalide (mauvaise question ou choix).', 400);
    }
    $bon = $choix === (int) $item['bonne'] ? 1 : 0;
    $pdo->prepare('UPDATE epreuve_participants SET reponse = ?, bon = ?, score = score + ? WHERE id = ? AND reponse IS NULL')
        ->execute([$choix, $bon, $bon, $moi['id']]);
    epreuve_veillee_etat($pdo, $code, $jeton, null);
}

/**
 * L'état que tout le monde polle. Pendant la phase « question », la carte en
 * cours n'expose QUE l'énoncé et les options — jamais `bonne`, `ref` ni
 * `rev`, servis à la révélation seulement. Les cartes à venir : jamais.
 */
function epreuve_veillee_etat(PDO $pdo, string $code, ?string $jeton, ?string $cle): never {
    $v = epreuve_veillee_row($pdo, $code);
    $deck = json_decode((string) $v['deck'], true);
    $total = count($deck);
    $carte = (int) $v['carte'];
    $phase = (string) $v['phase'];

    $st = $pdo->prepare('SELECT * FROM epreuve_participants WHERE code = ? ORDER BY score DESC, prenom');
    $st->execute([$code]);
    $rows = $st->fetchAll();

    $participants = [];
    $moi = null;
    foreach ($rows as $p) {
        $participants[] = [
            'prenom'   => $p['prenom'],
            'score'    => (int) $p['score'],
            'aRepondu' => $p['reponse'] !== null,
            'bon'      => $phase === 'revele' && $p['bon'] !== null ? (bool) $p['bon'] : null,
        ];
        if ($jeton !== null && hash_equals((string) $p['jeton'], $jeton)) {
            $moi = ['prenom' => $p['prenom'], 'score' => (int) $p['score'],
                'reponse' => $p['reponse'] === null ? null : (int) $p['reponse'],
                'bon'     => $p['bon'] === null ? null : (bool) $p['bon']];
        }
    }

    $enCours = null;
    if (($phase === 'question' || $phase === 'revele') && isset($deck[$carte - 1])) {
        $item = $deck[$carte - 1];
        $enCours = ['q' => $item['q'], 'options' => $item['options']];
        if ($phase === 'revele') {
            $enCours['bonne'] = (int) $item['bonne'];
            $enCours['ref'] = $item['ref'];
            $enCours['rev'] = $item['rev'];
        }
    }

    json_out([
        'phase'        => $phase,
        'mode'         => $v['mode'],
        'carte'        => $carte,
        'total'        => $total,
        'participants' => $participants,
        'moi'          => $moi,
        'enCours'      => $enCours,
        'animateur'    => $cle !== null && hash_equals((string) $v['cle'], $cle),
    ]);
}
