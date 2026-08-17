<?php
/* ============================================================================
   Notifications — « Le verset offert ».

   Chaque jour, à l'heure choisie, une notification push OFFRE un verset.
   Philosophie : la notification DONNE, elle ne réclame jamais rien — pas de
   « viens faire ta session », pas de « tu as manqué hier ». L'utilisateur
   l'active et la désactive librement ; son silence n'entraîne JAMAIS de
   relance.

   Routes :
   - GET  /api/push/cle         : clé publique VAPID (générée au premier appel).
   - POST /api/push/subscribe   : enregistre un abonnement (connecté ou anonyme).
   - POST /api/push/unsubscribe : supprime un abonnement (l'endpoint suffit :
                                  il est secret par nature).
   - GET  /api/cron/notify?key= : appelé toutes les heures par un cron externe ;
                                  envoie le verset du jour aux abonnements dont
                                  c'est l'heure locale.

   Le tout SANS bibliothèque : le chiffrement Web Push (RFC 8291, aes128gcm :
   ECDH P-256 + HKDF SHA-256 + AES-128-GCM) et la signature VAPID (RFC 8292,
   JWT ES256) sont implémentés ci-dessous avec openssl et hash_hkdf. La partie
   crypto est PURE (clé éphémère et sel injectables) et validée à l'octet près
   contre le vecteur de test de l'annexe A du RFC 8291 — voir
   api/tests/push-crypto-test.php. Les clés VAPID et la clé de cron sont
   auto-générées au premier besoin et rangées en base (table vapid) : aucune
   variable d'environnement à configurer.
   ========================================================================== */

defined('GRAINE_API') || exit;

const PUSH_SUBJECT = 'mailto:contact@biblehorizon.fr'; // sujet VAPID (contact)
const PUSH_TITLE   = '🌱 Un verset pour toi';          // un cadeau, jamais une injonction
const PUSH_TTL     = 86400;    // le service push garde le message un jour au plus
const PUSH_MAX_ECHECS = 5;     // au 5e échec d'affilée, l'abonnement est retiré

/* ============================================================================
   Petites briques binaires (base64url, DER) — communes à tout le fichier.
   ========================================================================== */

/** Encode en base64url sans padding (JWT, clés Web Push). */
function push_b64u_encode(string $bin): string {
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

/** Décode du base64url (padding facultatif). Retourne false si invalide. */
function push_b64u_decode(string $s): string|false {
    if ($s === '' || preg_match('/[^A-Za-z0-9_-]/', $s)) {
        return false;
    }
    $reste = strlen($s) % 4;
    if ($reste === 1) {
        return false;
    }
    if ($reste !== 0) {
        $s .= str_repeat('=', 4 - $reste);
    }
    return base64_decode(strtr($s, '-_', '+/'), true);
}

/* ============================================================================
   Clés elliptiques P-256 via openssl.

   Les clés Web Push circulent en « point brut non compressé » : 65 octets,
   0x04 || X (32) || Y (32). openssl, lui, ne parle que DER/PEM : les deux
   fonctions de conversion ci-dessous font le pont, en construisant l'enveloppe
   ASN.1 à la main (elle est FIXE pour P-256, aucun parseur nécessaire).
   ========================================================================== */

/** Génère une paire de clés EC P-256 (clés VAPID, clé éphémère de chiffrement). */
function push_ec_generate(): OpenSSLAsymmetricKey {
    $key = openssl_pkey_new([
        'curve_name'       => 'prime256v1',
        'private_key_type' => OPENSSL_KEYTYPE_EC,
    ]);
    if ($key === false) {
        throw new RuntimeException('openssl : impossible de générer une clé P-256.');
    }
    return $key;
}

/** Point public brut (65 octets, 0x04||X||Y) d'une clé openssl. */
function push_ec_public_raw(OpenSSLAsymmetricKey $key): string {
    $details = openssl_pkey_get_details($key);
    if ($details === false || !isset($details['ec']['x'], $details['ec']['y'])) {
        throw new RuntimeException('openssl : clé EC illisible.');
    }
    // X et Y peuvent perdre leurs octets nuls de tête : on recale sur 32.
    $x = str_pad($details['ec']['x'], 32, "\0", STR_PAD_LEFT);
    $y = str_pad($details['ec']['y'], 32, "\0", STR_PAD_LEFT);
    return "\x04" . $x . $y;
}

/** Enveloppe PEM « PUBLIC KEY » (SubjectPublicKeyInfo) d'un point brut P-256. */
function push_ec_public_pem(string $point65): string {
    // Préfixe DER constant pour une clé publique EC prime256v1 non compressée.
    $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $point65;
    return "-----BEGIN PUBLIC KEY-----\n"
        . chunk_split(base64_encode($der), 64, "\n")
        . "-----END PUBLIC KEY-----\n";
}

/**
 * Enveloppe PEM « EC PRIVATE KEY » (RFC 5915) d'un scalaire privé brut (32
 * octets) et de son point public (65 octets). Sert au test du vecteur RFC 8291,
 * dont les clés sont imposées sous forme brute.
 */
function push_ec_private_pem(string $d32, string $point65): string {
    $der = "\x30\x77\x02\x01\x01\x04\x20" . $d32                    // INTEGER 1, OCTET STRING d
        . "\xa0\x0a\x06\x08\x2a\x86\x48\xce\x3d\x03\x01\x07"        // [0] OID prime256v1
        . "\xa1\x44\x03\x42\x00" . $point65;                        // [1] BIT STRING point
    return "-----BEGIN EC PRIVATE KEY-----\n"
        . chunk_split(base64_encode($der), 64, "\n")
        . "-----END EC PRIVATE KEY-----\n";
}

/* ============================================================================
   Chiffrement RFC 8291 (aes128gcm) — le message que le navigateur déchiffre.
   ========================================================================== */

/**
 * Chiffre $plaintext pour un abonnement push (RFC 8291 + RFC 8188).
 *
 * @param string  $uaPublic65    clé publique du navigateur (p256dh, 65 octets bruts)
 * @param string  $authSecret16  secret d'authentification (auth, 16 octets bruts)
 * @param ?string $asPrivatePem  clé éphémère IMPOSÉE (PEM) — uniquement pour le
 *                               test du vecteur RFC 8291 ; null = clé fraîche.
 * @param ?string $salt16        sel IMPOSÉ (16 octets) — idem ; null = aléatoire.
 * @return string le corps complet à POSTer : en-tête aes128gcm + chiffré + tag.
 */
function push_encrypt(string $plaintext, string $uaPublic65, string $authSecret16,
                      ?string $asPrivatePem = null, ?string $salt16 = null): string {
    if (strlen($uaPublic65) !== 65 || $uaPublic65[0] !== "\x04") {
        throw new InvalidArgumentException('Clé p256dh invalide (65 octets, préfixe 0x04 attendus).');
    }
    if (strlen($authSecret16) !== 16) {
        throw new InvalidArgumentException('Secret auth invalide (16 octets attendus).');
    }
    // Un seul enregistrement de 4096 octets : 16 (tag) + 1 (délimiteur) réservés.
    if (strlen($plaintext) > 4096 - 16 - 1) {
        throw new InvalidArgumentException('Message trop long pour un envoi push.');
    }

    // Paire de clés éphémère du serveur d'application (« as » dans le RFC).
    $asKey = $asPrivatePem === null
        ? push_ec_generate()
        : (openssl_pkey_get_private($asPrivatePem) ?: throw new RuntimeException('Clé éphémère PEM illisible.'));
    $asPublic65 = push_ec_public_raw($asKey);
    $salt = $salt16 ?? random_bytes(16);
    if (strlen($salt) !== 16) {
        throw new InvalidArgumentException('Sel invalide (16 octets attendus).');
    }

    // 1) ECDH : secret partagé avec la clé publique du navigateur (« ua »).
    $uaKey = openssl_pkey_get_public(push_ec_public_pem($uaPublic65));
    if ($uaKey === false) {
        throw new RuntimeException('openssl : clé publique du navigateur illisible.');
    }
    $ecdh = openssl_pkey_derive($uaKey, $asKey);
    if ($ecdh === false) {
        throw new RuntimeException('openssl : échec de l\'accord de clés ECDH.');
    }

    // 2) RFC 8291 : IKM = HKDF(sel=auth, ecdh, "WebPush: info"||0x00||ua||as, 32).
    $ikm = hash_hkdf('sha256', $ecdh, 32, "WebPush: info\x00" . $uaPublic65 . $asPublic65, $authSecret16);
    // 3) RFC 8188 : clé de contenu et nonce dérivés du sel de l'en-tête.
    $cek   = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\x00", $salt);
    $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\x00", $salt);

    // 4) AES-128-GCM sur l'unique enregistrement : texte + délimiteur 0x02
    //    (« dernier enregistrement »), tag de 16 octets à la suite.
    $tag = '';
    $chiffre = openssl_encrypt($plaintext . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
    if ($chiffre === false) {
        throw new RuntimeException('openssl : échec du chiffrement AES-GCM.');
    }

    // 5) En-tête de codage : sel (16) || taille d'enregistrement (4) ||
    //    longueur du keyid (1) || keyid = clé publique éphémère (65).
    return $salt . pack('N', 4096) . chr(65) . $asPublic65 . $chiffre . $tag;
}

/* ============================================================================
   VAPID (RFC 8292) — le serveur s'identifie auprès du service push.
   ========================================================================== */

/** Signature ECDSA : DER (openssl) → r||s brut de 64 octets (format JWS). */
function push_ecdsa_der_to_raw(string $der): string {
    // SEQUENCE { INTEGER r, INTEGER s } — longueurs sur 1 octet pour P-256.
    if ($der === '' || $der[0] !== "\x30") {
        throw new RuntimeException('Signature DER inattendue.');
    }
    $pos = 2;
    $out = '';
    for ($i = 0; $i < 2; $i++) {
        if (($der[$pos] ?? '') !== "\x02") {
            throw new RuntimeException('Signature DER inattendue.');
        }
        $len = ord($der[$pos + 1]);
        $int = ltrim(substr($der, $pos + 2, $len), "\x00");
        if (strlen($int) > 32) {
            throw new RuntimeException('Signature DER inattendue.');
        }
        $out .= str_pad($int, 32, "\x00", STR_PAD_LEFT);
        $pos += 2 + $len;
    }
    return $out;
}

/** Signature ECDSA : r||s brut (64 octets) → DER — pour openssl_verify (tests). */
function push_ecdsa_raw_to_der(string $raw): string {
    $entier = function (string $i): string {
        $i = ltrim($i, "\x00");
        if ($i === '' ) {
            $i = "\x00";
        }
        if (ord($i[0]) > 0x7f) {
            $i = "\x00" . $i; // bit de signe : l'entier DER est signé
        }
        return "\x02" . chr(strlen($i)) . $i;
    };
    $corps = $entier(substr($raw, 0, 32)) . $entier(substr($raw, 32, 32));
    return "\x30" . chr(strlen($corps)) . $corps;
}

/**
 * Construit le JWT VAPID (ES256) pour un endpoint donné : l'audience est
 * l'ORIGINE du service push (pas l'endpoint complet), expiration 12 h.
 */
function push_vapid_jwt(string $endpoint, string $privatePem, string $subject): string {
    $u = parse_url($endpoint);
    if ($u === false || !isset($u['scheme'], $u['host'])) {
        throw new InvalidArgumentException('Endpoint push invalide.');
    }
    $aud = $u['scheme'] . '://' . $u['host'] . (isset($u['port']) ? ':' . $u['port'] : '');

    $entete  = push_b64u_encode((string) json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
    $charge  = push_b64u_encode((string) json_encode([
        'aud' => $aud,
        'exp' => time() + 12 * 3600,
        'sub' => $subject,
    ]));
    $aSigner = $entete . '.' . $charge;

    $key = openssl_pkey_get_private($privatePem);
    if ($key === false || !openssl_sign($aSigner, $der, $key, OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('openssl : signature VAPID impossible.');
    }
    return $aSigner . '.' . push_b64u_encode(push_ecdsa_der_to_raw($der));
}

/* ============================================================================
   Configuration serveur : clés VAPID + clé de cron, auto-générées en base.
   ========================================================================== */

/**
 * La rangée unique de la table vapid : clé privée PEM, clé publique brute en
 * base64url, sujet, clé de cron. Null si rien n'existe et $create est false ;
 * sinon tout est généré d'un coup au premier besoin (AUCUNE variable
 * d'environnement à configurer).
 */
function push_config(PDO $pdo, bool $create = false): ?array {
    $row = $pdo->query('SELECT * FROM vapid WHERE id = 1')->fetch();
    if ($row !== false) {
        return $row;
    }
    if (!$create) {
        return null;
    }
    $key = push_ec_generate();
    if (!openssl_pkey_export($key, $pem)) {
        throw new RuntimeException('openssl : export de la clé VAPID impossible.');
    }
    try {
        $st = $pdo->prepare(
            'INSERT INTO vapid (id, private_pem, public_b64u, subject, cron_key, created_at)
             VALUES (1, ?, ?, ?, ?, ?)'
        );
        $st->execute([$pem, push_b64u_encode(push_ec_public_raw($key)), PUSH_SUBJECT,
                      bin2hex(random_bytes(32)), now_sql()]);
    } catch (PDOException $e) {
        // Deux requêtes simultanées : la première a gagné, on relit la sienne.
    }
    $row = $pdo->query('SELECT * FROM vapid WHERE id = 1')->fetch();
    return $row === false ? null : $row;
}

/** Clé publique VAPID (base64url), ou null tant que personne n'a activé. */
function push_public_key(PDO $pdo): ?string {
    $cfg = push_config($pdo);
    return $cfg === null ? null : (string) $cfg['public_b64u'];
}

/* ============================================================================
   Envoi d'une notification à un abonnement (curl vers le service push).
   ========================================================================== */

/**
 * Chiffre puis POSTe $payload (JSON) à l'endpoint de l'abonnement.
 * Retour : ['ok' => bool, 'status' => int, 'gone' => bool] — gone signale un
 * abonnement mort (404/410 du service push, ou clés inexploitables) à
 * supprimer immédiatement.
 */
function push_send(array $abo, string $payload, array $cfg): array {
    $p256dh = push_b64u_decode((string) $abo['p256dh']);
    $auth   = push_b64u_decode((string) $abo['auth']);
    try {
        if ($p256dh === false || $auth === false) {
            throw new InvalidArgumentException('Clés d\'abonnement illisibles.');
        }
        $corps = push_encrypt($payload, $p256dh, $auth);
        $jwt   = push_vapid_jwt((string) $abo['endpoint'], (string) $cfg['private_pem'], (string) $cfg['subject']);
    } catch (Throwable $e) {
        // Clés corrompues : cet abonnement ne pourra jamais rien déchiffrer.
        return ['ok' => false, 'status' => 0, 'gone' => true];
    }

    $ch = curl_init((string) $abo['endpoint']);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $corps,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/octet-stream',
            'Content-Encoding: aes128gcm',
            'TTL: ' . PUSH_TTL,
            'Urgency: normal',
            'Authorization: vapid t=' . $jwt . ', k=' . $cfg['public_b64u'],
        ],
    ]);
    curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    return [
        'ok'     => $status >= 200 && $status < 300,
        'status' => $status,
        // 404/410 : le service push déclare l'abonnement expiré ou résilié.
        'gone'   => in_array($status, [404, 410], true),
    ];
}

/* ============================================================================
   Choix du verset — l'âme de la fonctionnalité.

   Compte connecté avec un jardin (blob sync « memo ») : un verset de SON
   jardin, celui dont la révision (due) est la plus proche — l'offrir, c'est
   déjà l'arroser. Sinon (anonyme, ou jardin vide) : la bibliothèque
   data/verses.json, en rotation déterministe par jour de l'année.
   ========================================================================== */

/** La bibliothèque de versets (data/verses.json), chargée une fois par requête. */
function push_library(): array {
    static $verses = null;
    if ($verses === null) {
        $lib = json_decode((string) @file_get_contents(dirname(__DIR__) . '/data/verses.json'), true);
        $verses = is_array($lib['verses'] ?? null) ? array_values($lib['verses']) : [];
    }
    return $verses;
}

/**
 * Le corps de la notification pour cet abonnement : « texte » — Référence,
 * tronqué proprement (~240 caractères). $localTs est l'horodatage décalé dans
 * le fuseau de l'abonné (pour une rotation calée sur SON jour).
 */
function push_choose_verse(PDO $pdo, array $abo, int $localTs): string {
    $ref = null;
    $texte = null;

    // 1) Le jardin du compte lié, s'il y en a un.
    if (!empty($abo['user_id'])) {
        $st = $pdo->prepare("SELECT payload FROM sync_blobs WHERE user_id = ? AND module = 'memo'");
        $st->execute([(int) $abo['user_id']]);
        $row = $st->fetch();
        if ($row !== false) {
            $memo = json_decode((string) $row['payload'], true);
            $cards = is_array($memo['cards'] ?? null) ? $memo['cards'] : [];
            $meilleur = null;
            foreach ($cards as $c) {
                // Format des cards du store de app.js : { id, ref, text, due, … }.
                if (!is_array($c) || !is_string($c['ref'] ?? null) || !is_string($c['text'] ?? null)
                    || trim($c['text']) === '' || !is_numeric($c['due'] ?? null)) {
                    continue;
                }
                if ($meilleur === null || (float) $c['due'] < (float) $meilleur['due']) {
                    $meilleur = $c;
                }
            }
            if ($meilleur !== null) {
                $ref = $meilleur['ref'];
                $texte = $meilleur['text'];
            }
        }
    }

    // 2) Repli : la bibliothèque, en rotation déterministe par jour de l'année.
    if ($texte === null) {
        $verses = push_library();
        if ($verses === []) {
            return '';
        }
        $v = $verses[((int) gmdate('z', $localTs)) % count($verses)];
        $ref = (string) ($v['ref'] ?? '');
        $texte = (string) ($v['text'] ?? '');
    }

    // « texte » — Référence, tronqué au dernier mot entier (~240 caractères).
    $suffixe = ' — ' . $ref;
    $max = 240 - mb_strlen('« ' . ' »' . $suffixe) - 1; // -1 pour l'ellipse éventuelle
    if (mb_strlen($texte) > $max) {
        $coupe = mb_substr($texte, 0, $max);
        $espace = mb_strrpos($coupe, ' ');
        if ($espace !== false && $espace > $max - 40) {
            $coupe = mb_substr($coupe, 0, $espace);
        }
        $texte = rtrim($coupe, " \u{00A0},;:.") . '…';
    }
    return '« ' . $texte . ' »' . $suffixe;
}

/* ============================================================================
   Routes.
   ========================================================================== */

/* ---- GET /api/push/cle : clé publique VAPID (générée au premier appel) ---- */

function handle_push_key(PDO $pdo): never {
    throttle_or_429($pdo, 'push', 30);
    $cfg = push_config($pdo, true);
    if ($cfg === null) {
        json_error('Configuration des notifications indisponible.', 500);
    }
    json_out(['vapidPublicKey' => (string) $cfg['public_b64u']]);
}

/* ---- POST /api/push/subscribe --------------------------------------------- */

function handle_push_subscribe(PDO $pdo): never {
    throttle_or_429($pdo, 'push', 30);
    $user = optional_user($pdo); // connecté OU anonyme : les deux sont bienvenus
    $body = read_json_body();

    $sub = $body['subscription'] ?? null;
    if (!is_array($sub)) {
        json_error('Abonnement push manquant.', 400);
    }
    $endpoint = (string) ($sub['endpoint'] ?? '');
    if (!str_starts_with($endpoint, 'https://') || strlen($endpoint) > 2048
        || filter_var($endpoint, FILTER_VALIDATE_URL) === false) {
        json_error('Endpoint push invalide (adresse https attendue).', 400);
    }
    $keys = is_array($sub['keys'] ?? null) ? $sub['keys'] : [];
    $p256dh = (string) ($keys['p256dh'] ?? '');
    $auth   = (string) ($keys['auth'] ?? '');
    $p256dhBin = push_b64u_decode($p256dh);
    $authBin   = push_b64u_decode($auth);
    if ($p256dhBin === false || strlen($p256dhBin) !== 65 || $p256dhBin[0] !== "\x04") {
        json_error('Clé p256dh invalide.', 400);
    }
    if ($authBin === false || strlen($authBin) !== 16) {
        json_error('Clé auth invalide.', 400);
    }
    $heure = $body['heure'] ?? 8;
    if (!is_int($heure) || $heure < 0 || $heure > 23) {
        json_error('Heure invalide (0 à 23).', 400);
    }
    // tz : la valeur JS de getTimezoneOffset(), en minutes — UTC+2 donne -120.
    $tz = $body['tz'] ?? 0;
    if (!is_int($tz) || $tz < -900 || $tz > 900) {
        json_error('Fuseau horaire invalide.', 400);
    }

    // Un abonnement par endpoint : REPLACE (l'unicité passe par un haché
    // SHA-256, les endpoints dépassant la taille indexable en MySQL).
    $st = $pdo->prepare(
        'REPLACE INTO push_abonnements
            (endpoint, endpoint_hash, p256dh, auth, user_id, heure, tz_offset, last_sent_day, echecs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)'
    );
    $st->execute([$endpoint, hash('sha256', $endpoint), $p256dh, $auth,
                  $user === null ? null : (int) $user['id'], $heure, $tz, now_sql()]);
    json_out(['ok' => true]);
}

/* ---- POST /api/push/unsubscribe -------------------------------------------- */

function handle_push_unsubscribe(PDO $pdo): never {
    throttle_or_429($pdo, 'push', 30);
    $endpoint = (string) (read_json_body()['endpoint'] ?? '');
    if ($endpoint === '' || strlen($endpoint) > 2048) {
        json_error('Endpoint manquant.', 400);
    }
    // Pas d'authentification : connaître l'endpoint suffit, il est secret par
    // nature (seuls le navigateur abonné et notre base le connaissent).
    $st = $pdo->prepare('DELETE FROM push_abonnements WHERE endpoint_hash = ?');
    $st->execute([hash('sha256', $endpoint)]);
    json_out(['ok' => true]);
}

/* ---- GET /api/cron/notify?key=… --------------------------------------------
   Appelé toutes les heures (cron Railway ou pinger externe — voir
   api/README.md). Pour chaque abonnement dont l'heure LOCALE courante vaut
   l'heure choisie et qui n'a rien reçu aujourd'hui (dans SON fuseau) : verset
   choisi puis envoyé. Idempotent : last_sent_day est posé AVANT l'envoi, une
   deuxième exécution dans la même heure ne renvoie rien. */

function handle_cron_notify(PDO $pdo): never {
    $cfg = push_config($pdo);
    $key = (string) ($_GET['key'] ?? '');
    // Pas de configuration = personne n'a jamais activé : aucune clé ne peut
    // être bonne. hash_equals : comparaison en temps constant.
    if ($cfg === null || $key === '' || !hash_equals((string) $cfg['cron_key'], $key)) {
        json_error('Clé de cron invalide.', 403);
    }

    $maintenant = time();
    $envoyes = 0;
    $supprimes = 0;

    foreach ($pdo->query('SELECT * FROM push_abonnements')->fetchAll() as $abo) {
        // Heure locale de l'abonné : getTimezoneOffset() donne UTC − locale,
        // donc locale = UTC − tz_offset minutes.
        $local = $maintenant - ((int) $abo['tz_offset']) * 60;
        if ((int) gmdate('G', $local) !== (int) $abo['heure']) {
            continue;
        }
        $jour = gmdate('Y-m-d', $local);
        if ($abo['last_sent_day'] === $jour) {
            continue; // déjà offert aujourd'hui (dans son fuseau)
        }
        // Idempotence : le jour est posé AVANT l'envoi — en cas de relance du
        // cron, personne ne reçoit deux fois (rater un jour vaut mieux que
        // harceler ; la notification est un cadeau, pas une dette).
        $pdo->prepare('UPDATE push_abonnements SET last_sent_day = ? WHERE id = ?')
            ->execute([$jour, $abo['id']]);

        $corps = push_choose_verse($pdo, $abo, $local);
        if ($corps === '') {
            continue; // bibliothèque introuvable : rien à offrir, on n'insiste pas
        }
        $payload = (string) json_encode(
            ['title' => PUSH_TITLE, 'body' => $corps, 'url' => '/'],
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        );
        $res = push_send($abo, $payload, $cfg);
        if ($res['ok']) {
            $envoyes++;
            if ((int) $abo['echecs'] > 0) {
                $pdo->prepare('UPDATE push_abonnements SET echecs = 0 WHERE id = ?')->execute([$abo['id']]);
            }
        } elseif ($res['gone']) {
            // 404/410 : abonnement résilié côté service push — on efface.
            $pdo->prepare('DELETE FROM push_abonnements WHERE id = ?')->execute([$abo['id']]);
            $supprimes++;
        } else {
            // Échec passager (réseau, 5xx…) : on compte, et au 5e d'affilée
            // l'abonnement est réputé mort et retiré sans bruit.
            $echecs = (int) $abo['echecs'] + 1;
            if ($echecs >= PUSH_MAX_ECHECS) {
                $pdo->prepare('DELETE FROM push_abonnements WHERE id = ?')->execute([$abo['id']]);
                $supprimes++;
            } else {
                $pdo->prepare('UPDATE push_abonnements SET echecs = ? WHERE id = ?')->execute([$echecs, $abo['id']]);
            }
        }
    }
    // Les défis entre amis restés sans réponse : la notification PATIENTE.
    $defis = push_defis_en_attente($pdo, $cfg);
    // Les services d'église de demain : UN rappel, la veille au soir, à ceux
    // qui ont levé la main ET activé les notifications de l'appli.
    $services = push_rappels_services($pdo, $cfg);
    json_out(['ok' => true, 'envoyes' => $envoyes, 'supprimes' => $supprimes, 'defis' => $defis, 'services' => $services]);
}

/* ---- Le rappel de MON service, la veille ------------------------------------
   La seule notification d'église (décision produit) : elle sert le membre
   dans son propre engagement — « tu as levé la main pour demain » — jamais
   l'assemblée pour le faire revenir. Une seule fois par inscription
   (rappel_envoye marqué AVANT l'envoi, comme push_defis : rater vaut mieux
   que harceler), le soir de la veille dans le fuseau de l'abonné, et
   seulement si les notifications de l'appli sont déjà actives — lever la
   main n'abonne personne à quoi que ce soit. */
function push_rappels_services(PDO $pdo, array $cfg): int {
    $envoyes = 0;
    $st = $pdo->prepare(
        'SELECT i.service_id, i.user_id, s.titre, g.nom AS eglise
         FROM groupe_service_inscriptions i
         JOIN groupe_services s ON s.id = i.service_id
         JOIN groupes g ON g.id = s.groupe_id
         WHERE i.rappel_envoye = 0 AND s.date_service = ?'
    );
    $st->execute([gmdate('Y-m-d', time() + 86400)]);
    foreach ($st->fetchAll() as $r) {
        $abos = $pdo->prepare('SELECT * FROM push_abonnements WHERE user_id = ?');
        $abos->execute([(int) $r['user_id']]);
        // Le soir de la veille chez l'abonné (17 h – 22 h locales) : avant,
        // on repassera à l'heure suivante ; sans abonnement, on repassera
        // aussi — activer ses notifications dans la journée suffit.
        $prets = array_filter($abos->fetchAll(), static function (array $abo): bool {
            $h = (int) gmdate('G', time() - ((int) $abo['tz_offset']) * 60);
            return $h >= 17 && $h <= 22;
        });
        if ($prets === []) {
            continue;
        }
        $pdo->prepare('UPDATE groupe_service_inscriptions SET rappel_envoye = 1 WHERE service_id = ? AND user_id = ?')
            ->execute([(int) $r['service_id'], (int) $r['user_id']]);

        $payload = (string) json_encode([
            'title' => '🤝 Ton service, demain',
            'body'  => $r['titre'] . ' (' . $r['eglise'] . ') — merci de t\'être proposé 🙂',
            'url'   => '/',
            'tag'   => 'service-demain',
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        foreach ($prets as $abo) {
            $res = push_send($abo, $payload, $cfg);
            if ($res['ok']) {
                $envoyes++;
            } elseif ($res['gone']) {
                $pdo->prepare('DELETE FROM push_abonnements WHERE id = ?')->execute([$abo['id']]);
            }
            // échec passager : tant pis pour cette fois — le compteur
            // d'échecs de l'abonnement vit dans la boucle quotidienne.
        }
    }
    return $envoyes;
}

/* ---- Les défis qui attendent ------------------------------------------------
   Voulu ainsi (décision produit) : JAMAIS de notification à chaud — si
   l'adversaire vient de lui-même dans l'heure, il n'est jamais dérangé.
   Passé ce délai, UNE seule notification (table push_defis, marquée avant
   l'envoi : un cron rejoué ne renvoie rien), et jamais de relance. La
   notification propose, elle ne réclame pas. Ne concerne que les duels
   entre amis (comptes) : les défis par code sont anonymes. */
function push_defis_en_attente(PDO $pdo, array $cfg): int {
    $envoyes = 0;
    $st = $pdo->prepare(
        'SELECT d.id, d.opponent_id, u.pseudo AS challenger
         FROM duels d
         JOIN users u ON u.id = d.challenger_id
         WHERE d.opponent_answers IS NULL AND d.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM push_defis p WHERE p.duel_id = d.id)'
    );
    $st->execute([now_sql_plus(-3600)]);
    foreach ($st->fetchAll() as $defi) {
        // Marqué AVANT tout envoi : une seule chance, même si le cron rejoue
        // ou si l'adversaire n'a pas (encore) activé les notifications —
        // rater une notification vaut mieux que harceler.
        $pdo->prepare('INSERT INTO push_defis (duel_id, notified_at) VALUES (?, ?)')
            ->execute([$defi['id'], now_sql()]);

        $payload = (string) json_encode([
            'title' => '🌱 Un défi t\'attend',
            'body'  => $defi['challenger'] . ' te propose un défi biblique — quand tu veux, rien ne presse.',
            'url'   => '/defi/',
            'tag'   => 'defi-attente',
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        $abos = $pdo->prepare('SELECT * FROM push_abonnements WHERE user_id = ?');
        $abos->execute([$defi['opponent_id']]);
        foreach ($abos->fetchAll() as $abo) {
            $res = push_send($abo, $payload, $cfg);
            if ($res['ok']) {
                $envoyes++;
            } elseif ($res['gone']) {
                $pdo->prepare('DELETE FROM push_abonnements WHERE id = ?')->execute([$abo['id']]);
            }
            // échec passager : tant pis pour cette fois — le compteur
            // d'échecs de l'abonnement vit dans la boucle quotidienne.
        }
    }
    return $envoyes;
}
