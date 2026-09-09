<?php
/* ============================================================================
   Test CLI des lettres envoyées par l'application (api/mail.php) — lancé par
   run-tests.sh :

       php api/tests/mail-test.php

   Le corps d'une lettre est une fonction PURE : on peut donc le relire sans
   réseau, sans base et sans clé Brevo. Ce qui est vérifié ici, c'est ce qui
   coûte cher à rater — un responsable qui reçoit une lettre SANS le code de
   son église n'a plus rien à partager à son assemblée, et le lien du guide
   qui pointe à côté est un lien mort dans une première impression.

   Code de sortie : 0 si tout passe, 1 sinon.
   ========================================================================== */

declare(strict_types=1);

define('GRAINE_API', true);
require __DIR__ . '/../mail.php';

$pass = 0;
$fail = 0;

function verif(string $nom, bool $vrai): void {
    global $pass, $fail;
    if ($vrai) { $pass++; printf("   ok   %s\n", $nom); }
    else       { $fail++; printf("   FAIL %s\n", $nom); }
}

/* ---- La lettre d'accueil d'un responsable ------------------------------------ */

$texte = mail_texte_eglise_ouverte('Église de la Colline', 'GRP-XUH57');

verif("le nom de l'église y est",            str_contains($texte, 'Église de la Colline'));
verif('le code du groupe y est',             str_contains($texte, 'GRP-XUH57'));
verif('le guide est donné par son lien',     str_contains($texte, 'https://biblehorizon.fr/guide/guide-du-responsable.pdf'));
verif("l'adresse du site y est",             str_contains($texte, 'https://biblehorizon.fr'));
verif('une adresse de contact est offerte',  str_contains($texte, 'contact@biblehorizon.fr'));
verif("l'onglet à ouvrir est nommé",         str_contains($texte, 'Mon église'));

/* ---- Le courrier d'un signalement --------------------------------------------
   Il doit permettre de JUGER depuis le téléphone : quoi, pourquoi, d'où, et le
   lien vers la pile. Et ne jamais porter l'adresse e-mail de l'auteur. */

$sig = mail_texte_signalement([
    'genre'       => 'annonce',
    'cible'       => 'annonce:42',
    'contexte'    => 'Vente de gâteaux — Rendez-vous dimanche après le culte.',
    'motif'       => 'Le lien dans le texte mène vers un site commercial.',
    'raison'      => 'spam',
    'groupe_code' => 'GRP-XUH57',
    'auteur'      => 'Chloé',
]);

verif('le genre est dit en clair',                 str_contains($sig, "une annonce d'église"));
verif('le motif choisi est traduit',               str_contains($sig, 'Spam ou publicité'));
verif('la cible y est',                            str_contains($sig, 'annonce:42'));
verif("le code de l'église y est",                 str_contains($sig, 'GRP-XUH57'));
verif("l'auteur apparaît par son pseudo",          str_contains($sig, 'Chloé'));
verif('le commentaire est cité',                   str_contains($sig, 'site commercial'));
verif('le contexte figé est repris',               str_contains($sig, 'Vente de gâteaux'));
verif("le lien vers l'administration y est",       str_contains($sig, 'https://biblehorizon.fr/admin/'));
verif('aucune adresse e-mail ne fuit',             !str_contains($sig, '@'));

$anon = mail_texte_signalement(['genre' => 'question', 'cible' => 'question:lieu-80', 'contexte' => '', 'motif' => '', 'raison' => null, 'groupe_code' => null, 'auteur' => null]);
verif('sans compte, on le dit',                    str_contains($anon, 'un lecteur sans compte'));
verif('sans raison, « Non précisée »',             str_contains($anon, 'Non précisée'));
verif("sans église, pas de ligne Église",          !str_contains($anon, 'Église :'));
verif('le destinataire par défaut est le contact', mail_signalement_destinataire() === 'contact@biblehorizon.fr' || getenv('SIGNALEMENT_EMAIL') !== false);
verif('les trois premiers gestes y sont',    str_contains($texte, "1.") && str_contains($texte, "2.") && str_contains($texte, "3."));
verif('rien ne reste à substituer',          !str_contains($texte, '{') && !str_contains($texte, '%s'));

// Un nom d'église est saisi par un humain : la lettre est du TEXTE BRUT, donc
// rien à échapper — mais rien ne doit non plus être tronqué ou déformé.
$exotique = mail_texte_eglise_ouverte("L'Église « Béthel » & Cie", 'GRP-ABCDE');
verif('un nom avec apostrophe et guillemets passe entier',
    str_contains($exotique, "L'Église « Béthel » & Cie"));

/* ---- Le mode dev n'envoie rien, et ne bloque jamais --------------------------- */

// putenv() sans valeur retire la variable : mail_mode() retombe sur « dev ».
putenv('BREVO_API_KEY');
putenv('SMTP_HOST');
verif('sans configuration, le mode est « dev »', mail_mode() === 'dev');
verif('en dev, la lettre est un succès sans envoi',
    mail_send_eglise_ouverte('personne@example.org', 'Église de la Colline', 'GRP-XUH57') === true);

printf("\n%d réussites, %d échecs\n", $pass, $fail);
exit($fail === 0 ? 0 : 1);
