<?php
/* ============================================================================
   Test CLI de la crypto Web Push (api/push.php) — lancé par run-tests.sh :

       php api/tests/push-crypto-test.php

   1) Rejoue INTÉGRALEMENT le vecteur de test de l'annexe A du RFC 8291 :
      clés, sel et message imposés → le chiffré attendu doit sortir À L'OCTET
      PRÈS (valeurs intermédiaires vérifiées aussi, pour diagnostiquer vite).
      C'est binaire : si ça ne colle pas, aucun navigateur ne déchiffrera rien.
   2) Vérifie un JWT VAPID (RFC 8292) : signature ES256 contrôlée par
      openssl_verify, en-tête et claims conformes.
   3) Boucle complète : un message chiffré par push_encrypt est déchiffré avec
      la clé privée du navigateur du vecteur (preuve indépendante du point 1).

   Code de sortie : 0 si tout passe, 1 sinon.
   ========================================================================== */

declare(strict_types=1);

define('GRAINE_API', true);
require __DIR__ . '/../push.php';

$pass = 0;
$fail = 0;

/** Compare attendu/obtenu (chaînes binaires affichées en base64url). */
function verif(string $nom, string $attendu, string $obtenu): void {
    global $pass, $fail;
    if ($attendu === $obtenu) {
        $pass++;
        printf("   ok   %s\n", $nom);
    } else {
        $fail++;
        printf("   FAIL %s\n        attendu : %s\n        obtenu  : %s\n",
            $nom, push_b64u_encode($attendu), push_b64u_encode($obtenu));
    }
}

function verif_vrai(string $nom, bool $ok, string $detail = ''): void {
    global $pass, $fail;
    if ($ok) {
        $pass++;
        printf("   ok   %s\n", $nom);
    } else {
        $fail++;
        printf("   FAIL %s%s\n", $nom, $detail === '' ? '' : " — $detail");
    }
}

$b64u = fn (string $s): string => (string) push_b64u_decode($s);

/* ---------------------------------------------------------------------------
   1) RFC 8291, annexe A — toutes les valeurs sont IMPOSÉES par le RFC.
   -------------------------------------------------------------------------- */
printf("\n== RFC 8291 annexe A : chiffrement aes128gcm à l'octet près\n");

$plaintext  = 'When I grow up, I want to be a watermelon';
$uaPublic   = $b64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
$uaPrivate  = $b64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94');
$asPublic   = $b64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
$asPrivate  = $b64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw');
$authSecret = $b64u('BTBZMqHH6r4Tts7J_aSIgg');
$salt       = $b64u('DGv6ra1nlYgDCS1FRnbzlw');

// Le message complet attendu (en-tête aes128gcm + chiffré + tag), tel quel.
$attendu = $b64u(
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlml'
    . 'MoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
);

// La clé éphémère injectée doit d'abord se relire correctement.
$asPem = push_ec_private_pem($asPrivate, $asPublic);
$asKey = openssl_pkey_get_private($asPem);
verif_vrai('clé éphémère PEM (RFC 5915) relue par openssl', $asKey !== false);
verif('point public retrouvé depuis la clé privée', $asPublic, push_ec_public_raw($asKey));

// Valeurs intermédiaires du RFC (diagnostic précis si un maillon casse).
$uaKey = openssl_pkey_get_public(push_ec_public_pem($uaPublic));
$ecdh = openssl_pkey_derive($uaKey, $asKey);
verif('secret ECDH partagé', $b64u('kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs'), (string) $ecdh);

$ikm = hash_hkdf('sha256', (string) $ecdh, 32, "WebPush: info\x00" . $uaPublic . $asPublic, $authSecret);
verif('IKM (HKDF « WebPush: info »)', $b64u('S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg'), $ikm);

$cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\x00", $salt);
verif('CEK (clé de contenu)', $b64u('oIhVW04MRdy2XN9CiKLxTg'), $cek);

$nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\x00", $salt);
verif('NONCE', $b64u('4h_95klXJ5E_qnoN'), $nonce);

// Et enfin le verdict : le message COMPLET, à l'octet près.
$obtenu = push_encrypt($plaintext, $uaPublic, $authSecret, $asPem, $salt);
verif('message chiffré complet (annexe A, à l\'octet près)', $attendu, $obtenu);

/* ---------------------------------------------------------------------------
   2) VAPID (RFC 8292) : JWT ES256 vérifié par openssl_verify.
   -------------------------------------------------------------------------- */
printf("\n== VAPID : JWT ES256 signé puis vérifié par openssl_verify\n");

$vapidKey = push_ec_generate();
openssl_pkey_export($vapidKey, $vapidPem);
$endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def';
$jwt = push_vapid_jwt($endpoint, $vapidPem, 'mailto:contact@biblehorizon.fr');

$parts = explode('.', $jwt);
verif_vrai('JWT en trois parties', count($parts) === 3);

$entete = json_decode((string) push_b64u_decode($parts[0]), true);
verif_vrai('en-tête alg=ES256, typ=JWT',
    is_array($entete) && ($entete['alg'] ?? '') === 'ES256' && ($entete['typ'] ?? '') === 'JWT');

$claims = json_decode((string) push_b64u_decode($parts[1]), true);
verif_vrai('aud = origine de l\'endpoint', ($claims['aud'] ?? '') === 'https://fcm.googleapis.com');
verif_vrai('sub = mailto de contact', ($claims['sub'] ?? '') === 'mailto:contact@biblehorizon.fr');
verif_vrai('exp dans le futur (≤ 24 h)',
    is_int($claims['exp'] ?? null) && $claims['exp'] > time() && $claims['exp'] <= time() + 86400);

$signature = (string) push_b64u_decode($parts[2]);
verif_vrai('signature brute de 64 octets (r||s)', strlen($signature) === 64);
$pub = openssl_pkey_get_public(push_ec_public_pem(push_ec_public_raw($vapidKey)));
$valide = openssl_verify($parts[0] . '.' . $parts[1], push_ecdsa_raw_to_der($signature), $pub, OPENSSL_ALGO_SHA256);
verif_vrai('openssl_verify accepte la signature', $valide === 1);
$invalide = openssl_verify($parts[0] . '.' . $parts[1] . 'x', push_ecdsa_raw_to_der($signature), $pub, OPENSSL_ALGO_SHA256);
verif_vrai('openssl_verify rejette un contenu altéré', $invalide === 0);

/* ---------------------------------------------------------------------------
   3) Boucle complète : chiffrer (clé éphémère fraîche), déchiffrer comme le
      ferait le navigateur du vecteur (sa clé privée est fournie par le RFC).
   -------------------------------------------------------------------------- */
printf("\n== Aller-retour : chiffré par nous, déchiffré comme un navigateur\n");

$message = '{"title":"🌱 Un verset pour toi","body":"« Je puis tout par celui qui me fortifie. » — Philippiens 4.13"}';
$corps = push_encrypt($message, $uaPublic, $authSecret); // clé et sel ALÉATOIRES cette fois

// Déchiffrement côté « navigateur » : mêmes RFC, dans l'autre sens.
$saltR   = substr($corps, 0, 16);
$rs      = unpack('N', substr($corps, 16, 4))[1];
$idlen   = ord($corps[20]);
$asPubR  = substr($corps, 21, $idlen);
$chiffre = substr($corps, 21 + $idlen);
verif_vrai('en-tête : rs=4096, keyid de 65 octets', $rs === 4096 && $idlen === 65);

$uaPem = push_ec_private_pem($uaPrivate, $uaPublic);
$ecdhR = openssl_pkey_derive(openssl_pkey_get_public(push_ec_public_pem($asPubR)), openssl_pkey_get_private($uaPem));
$ikmR   = hash_hkdf('sha256', (string) $ecdhR, 32, "WebPush: info\x00" . $uaPublic . $asPubR, $authSecret);
$cekR   = hash_hkdf('sha256', $ikmR, 16, "Content-Encoding: aes128gcm\x00", $saltR);
$nonceR = hash_hkdf('sha256', $ikmR, 12, "Content-Encoding: nonce\x00", $saltR);
$clair = openssl_decrypt(
    substr($chiffre, 0, -16), 'aes-128-gcm', $cekR, OPENSSL_RAW_DATA, $nonceR, substr($chiffre, -16)
);
verif_vrai('AES-GCM : tag accepté au déchiffrement', $clair !== false);
verif_vrai('délimiteur de bourrage 0x02 en fin d\'enregistrement', is_string($clair) && str_ends_with($clair, "\x02"));
verif('le texte clair ressort intact', $message, is_string($clair) ? substr($clair, 0, -1) : '');

/* ---------------------------------------------------------------------------
   4) Choix du verset (l'âme de la fonctionnalité) : jardin d'abord (due le
      plus proche), sinon rotation déterministe de la bibliothèque ; corps
      toujours « texte » — Référence, ≤ 240 caractères.
   -------------------------------------------------------------------------- */
printf("\n== Choix du verset : jardin, rotation, troncature\n");

// now_sql() de helpers.php n'est pas chargé ici : push_choose_verse n'en a
// pas besoin, une base SQLite en mémoire suffit.
$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('CREATE TABLE sync_blobs (user_id INTEGER, module TEXT, payload TEXT, updated_at TEXT)');
$memo = json_encode(['cards' => [
    'jean-3-16' => ['id' => 'jean-3-16', 'ref' => 'Jean 3.16', 'text' => 'Car Dieu a tant aimé le monde…', 'due' => 20650],
    'ps-23-1'   => ['id' => 'ps-23-1', 'ref' => 'Psaumes 23.1', 'text' => 'L\'Éternel est mon berger: je ne manquerai de rien.', 'due' => 20620],
    'cassee'    => ['id' => 'cassee', 'due' => 1], // carte sans ref/text : ignorée
]], JSON_UNESCAPED_UNICODE);
$pdo->prepare('INSERT INTO sync_blobs VALUES (7, ?, ?, ?)')->execute(['memo', $memo, '2026-08-10 00:00:00']);

$ts = time();
$corps = push_choose_verse($pdo, ['user_id' => 7, 'tz_offset' => 0], $ts);
verif_vrai('compte avec jardin : le verset au due le plus proche',
    $corps === '« L\'Éternel est mon berger: je ne manquerai de rien. » — Psaumes 23.1', "obtenu : $corps");

$anonyme = push_choose_verse($pdo, ['user_id' => null, 'tz_offset' => 0], $ts);
$verses = push_library();
$attenduV = $verses[((int) gmdate('z', $ts)) % count($verses)];
verif_vrai('anonyme : rotation déterministe par jour de l\'année',
    str_contains($anonyme, (string) $attenduV['ref']), "obtenu : $anonyme");
verif_vrai('anonyme : même verset au 2e tirage du même jour',
    $anonyme === push_choose_verse($pdo, ['user_id' => null, 'tz_offset' => 0], $ts));

// Jardin vide (blob présent mais aucune carte exploitable) → repli bibliothèque.
$pdo->prepare('INSERT INTO sync_blobs VALUES (8, ?, ?, ?)')
    ->execute(['memo', '{"cards":{}}', '2026-08-10 00:00:00']);
verif_vrai('jardin vide : repli sur la bibliothèque',
    push_choose_verse($pdo, ['user_id' => 8, 'tz_offset' => 0], $ts) === $anonyme);

// Un texte interminable est tronqué proprement (≤ 240, ellipse, référence intacte).
$long = str_repeat('Que la paix de Dieu garde vos cœurs et vos pensées ', 12);
$memoLong = json_encode(['cards' => ['x' => ['ref' => 'Philippiens 4.7', 'text' => $long, 'due' => 1]]]);
$pdo->prepare('UPDATE sync_blobs SET payload = ? WHERE user_id = 7')->execute([$memoLong]);
$tronque = push_choose_verse($pdo, ['user_id' => 7, 'tz_offset' => 0], $ts);
verif_vrai('texte long : corps ≤ 240 caractères', mb_strlen($tronque) <= 240, 'longueur : ' . mb_strlen($tronque));
verif_vrai('texte long : ellipse et référence préservées',
    str_contains($tronque, '…') && str_ends_with($tronque, ' — Philippiens 4.7'));

/* -------------------------------------------------------------------------- */
printf("\nCrypto Web Push : %d réussites, %d échecs\n", $pass, $fail);
exit($fail === 0 ? 0 : 1);
