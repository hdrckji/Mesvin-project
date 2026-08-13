<?php
/* ============================================================================
   Envoi du code de connexion par e-mail.

   Trois modes, choisis automatiquement selon l'environnement :
   1. BREVO_API_KEY définie  → API HTTP de Brevo (simple et fiable).
   2. SMTP_HOST définie      → petit client SMTP maison (STARTTLS + AUTH LOGIN).
   3. Rien de configuré      → MODE DEV : pas d'envoi, le code est renvoyé
                               dans la réponse de /api/auth/request-code
                               (champ devCode) — jamais en production.

   Variables : BREVO_API_KEY — ou SMTP_HOST, SMTP_PORT (587 par défaut),
   SMTP_USER, SMTP_PASS — et MAIL_FROM (adresse d'expéditeur) dans les 2 cas.
   ========================================================================== */

defined('GRAINE_API') || exit;

/** Mode d'envoi actif : "brevo", "smtp" ou "dev". */
function mail_mode(): string {
    if ((string) getenv('BREVO_API_KEY') !== '') {
        return 'brevo';
    }
    if ((string) getenv('SMTP_HOST') !== '') {
        return 'smtp';
    }
    return 'dev';
}

/** Adresse d'expéditeur (MAIL_FROM, avec un repli explicite). */
function mail_from(): string {
    $from = (string) getenv('MAIL_FROM');
    // Le repli n'est PAS une adresse validée chez un fournisseur : en
    // production, MAIL_FROM doit être définie ET validée côté Brevo/SMTP,
    // sinon l'envoi sera refusé. /api/health affiche l'adresse utilisée.
    return $from !== '' ? $from : 'no-reply@bible-horizon.app';
}

/**
 * Envoie le code de connexion à $email.
 * Retourne true si l'envoi a réussi (toujours true en mode dev : le code
 * est alors montré dans la réponse HTTP, pas envoyé).
 */
function mail_send_code(string $email, string $code): bool {
    $mode = mail_mode();
    if ($mode === 'dev') {
        return true;
    }
    $subject = 'Ton code de connexion — Bible Horizon';
    $text = "Bonjour,\n\n"
        . "Ton code de connexion : $code\n\n"
        . "Il est valable 45 minutes. Si tu n'as rien demandé, ignore simplement ce message.\n\n"
        . "Bible Horizon";
    return $mode === 'brevo'
        ? mail_send_brevo($email, $subject, $text)
        : mail_send_smtp($email, $subject, $text);
}

/* --------------------------------------------------------------------------
   Option 1 : API HTTP de Brevo (https://developers.brevo.com)
   -------------------------------------------------------------------------- */

function mail_send_brevo(string $to, string $subject, string $text): bool {
    $payload = json_encode([
        'sender'      => ['name' => 'Bible Horizon', 'email' => mail_from()],
        'to'          => [['email' => $to]],
        'subject'     => $subject,
        'textContent' => $text,
    ], JSON_UNESCAPED_UNICODE);

    $ch = curl_init('https://api.brevo.com/v3/smtp/email');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_HTTPHEADER     => [
            'api-key: ' . getenv('BREVO_API_KEY'),
            'Content-Type: application/json',
            'Accept: application/json',
        ],
    ]);
    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false || $status >= 300) {
        $detail = "HTTP $status $curlError " . substr((string) $response, 0, 300);
        error_log("Brevo : échec d'envoi — $detail");
        mail_remember_error('brevo ' . $detail);
        return false;
    }
    mail_remember_error(null); // dernier envoi réussi : on efface la trace
    return true;
}

/**
 * Mémorise (ou efface) la dernière erreur d'envoi dans un petit fichier,
 * pour que /api/health puisse l'afficher sans fouiller les logs Railway.
 * Le texte ne contient jamais la clé API ni le destinataire.
 */
function mail_remember_error(?string $detail): void {
    $file = __DIR__ . '/data/mail-error.txt';
    try {
        if ($detail === null) {
            if (file_exists($file)) { @unlink($file); }
        } else {
            @file_put_contents($file, gmdate('Y-m-d\TH:i:s\Z') . ' ' . $detail);
        }
    } catch (Throwable $e) { /* le diagnostic ne doit jamais casser l'envoi */ }
}

/** Dernière erreur d'envoi mémorisée (ou null). */
function mail_last_error(): ?string {
    $file = __DIR__ . '/data/mail-error.txt';
    if (!is_file($file)) { return null; }
    $txt = (string) @file_get_contents($file);
    return $txt !== '' ? mb_substr($txt, 0, 400) : null;
}

/* --------------------------------------------------------------------------
   Option 2 : client SMTP minimal.
   Port 587 : connexion en clair puis STARTTLS. Port 465 : TLS implicite.
   -------------------------------------------------------------------------- */

function mail_send_smtp(string $to, string $subject, string $text): bool {
    $host = (string) getenv('SMTP_HOST');
    $port = (int) ((string) getenv('SMTP_PORT') !== '' ? getenv('SMTP_PORT') : 587);
    $user = (string) getenv('SMTP_USER');
    $pass = (string) getenv('SMTP_PASS');
    $from = mail_from();

    $address = ($port === 465 ? 'ssl://' : 'tcp://') . $host . ':' . $port;
    $fp = @stream_socket_client($address, $errno, $errstr, 15);
    if ($fp === false) {
        error_log("SMTP : connexion impossible à $address ($errno $errstr)");
        return false;
    }
    stream_set_timeout($fp, 15);

    // Lit une réponse du serveur (gère les lignes multiples "250-…")
    // et vérifie que son code fait partie des codes attendus.
    $expect = function (array $codes) use ($fp): bool {
        do {
            $line = fgets($fp, 2048);
            if ($line === false) {
                return false;
            }
        } while (isset($line[3]) && $line[3] === '-');
        return in_array((int) substr($line, 0, 3), $codes, true);
    };
    $send = function (string $command) use ($fp): void {
        fwrite($fp, $command . "\r\n");
    };
    $fail = function (string $step) use ($fp): bool {
        error_log("SMTP : échec à l'étape « $step »");
        fclose($fp);
        return false;
    };

    if (!$expect([220])) return $fail('accueil');
    $send('EHLO grainedeparole');
    if (!$expect([250])) return $fail('EHLO');

    if ($port !== 465) {
        $send('STARTTLS');
        if (!$expect([220])) return $fail('STARTTLS');
        if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            return $fail('négociation TLS');
        }
        $send('EHLO grainedeparole');
        if (!$expect([250])) return $fail('EHLO après TLS');
    }

    if ($user !== '') {
        $send('AUTH LOGIN');
        if (!$expect([334])) return $fail('AUTH LOGIN');
        $send(base64_encode($user));
        if (!$expect([334])) return $fail('identifiant');
        $send(base64_encode($pass));
        if (!$expect([235])) return $fail('mot de passe');
    }

    $send("MAIL FROM:<$from>");
    if (!$expect([250])) return $fail('MAIL FROM');
    $send("RCPT TO:<$to>");
    if (!$expect([250, 251])) return $fail('RCPT TO');
    $send('DATA');
    if (!$expect([354])) return $fail('DATA');

    $headers = "From: Bible Horizon <$from>\r\n"
        . "To: <$to>\r\n"
        . 'Subject: =?UTF-8?B?' . base64_encode($subject) . "?=\r\n"
        . 'Date: ' . gmdate('r') . "\r\n"
        . "MIME-Version: 1.0\r\n"
        . "Content-Type: text/plain; charset=utf-8\r\n"
        . "Content-Transfer-Encoding: base64\r\n";
    $send($headers . "\r\n" . chunk_split(base64_encode($text)) . '.');
    if (!$expect([250])) return $fail('corps du message');

    $send('QUIT');
    fclose($fp);
    return true;
}
