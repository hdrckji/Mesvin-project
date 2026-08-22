<?php
/* ============================================================================
   Les veillées d'ÉPREUVE qui avancent d'elles-mêmes.

   Le Défi a été réparé le premier : sa révélation tombe côté serveur, au
   premier sondage venu. Les quatre épreuves — « Qui a dit ça ? », « Écrit… ou
   pas ? », « De qui parle-t-on ? » et la frise — n'avançaient encore que sur
   un geste de l'animateur. Son téléphone se verrouille dans une salle sombre,
   et le grand écran reste figé devant toute l'assemblée.

   Ce fichier ne porte que les BRIQUES communes : compter les présents, dire si
   le temps est écoulé. La transition elle-même reste dans chaque module, parce
   que leurs phases diffèrent vraiment — le portrait fait tomber des indices
   avant de révéler, la frise place des cartes. Une fonction unique qui
   prétendrait tout couvrir se paierait en cas particuliers illisibles.

   Le mode s'active à l'ouverture de la salle et se coupe en cours de route.
   À 0 — le défaut — RIEN ne change : l'animateur mène, comme depuis toujours.
   ========================================================================== */

defined('GRAINE_API') || exit;

/** Au-delà, un participant qui ne sonde plus n'est plus attendu. */
const EPREUVE_PRESENCE_SECONDS = 30;
/** Grâce réseau : on ne révèle pas au moment où une réponse est en vol. */
const EPREUVE_GRACE_SECONDS = 2;
/** Temps de lecture d'une réponse avant d'enchaîner, mode automatique. */
const EPREUVE_ENCHAINEMENT_SECONDS = 8;
/** Bornes du chrono : de quoi lire une question, sans laisser la salle attendre. */
const EPREUVE_SECONDES_MIN = 10;
const EPREUVE_SECONDES_MAX = 90;
const EPREUVE_SECONDES_DEFAUT = 25;

/**
 * Note qu'un participant vient d'être vu. ÉCHOUE EN SILENCE, et c'est voulu :
 * cette écriture a lieu à chaque sondage, c'est la plus fréquente de toutes.
 * Une base occupée ne doit pas figer l'écran de quelqu'un pour si peu — la
 * présence n'est qu'un confort, elle sert à ne plus attendre ceux qui sont
 * partis. (Leçon apprise sur le Défi, où le 500 tombait sans un mot.)
 */
function epreuve_auto_present(PDO $pdo, string $table, int $id): void {
    try {
        $pdo->prepare("UPDATE $table SET last_seen = ? WHERE id = ?")->execute([now_sql(), $id]);
    } catch (PDOException $e) {
        error_log('Présence non enregistrée (sans gravité) — ' . $e->getMessage());
    }
}

/**
 * Combien sont ENCORE là, et combien d'entre eux ont répondu.
 * On compare les présents aux réponses des présents : mêler les deux
 * populations couperait la parole à quelqu'un qui réfléchit encore, pendant
 * qu'un autre a répondu puis rangé son téléphone.
 * `last_seen` à NULL = jamais sondé depuis la migration : on le compte présent
 * plutôt que de faire disparaître quelqu'un d'une veillée déjà commencée.
 */
function epreuve_auto_compte(PDO $pdo, string $table, string $code): array {
    $st = $pdo->prepare(
        "SELECT last_seen, reponse FROM $table WHERE code = ?"
    );
    $st->execute([$code]);
    $limite = now_sql_plus(-EPREUVE_PRESENCE_SECONDS);
    $present = $repondu = 0;
    foreach ($st->fetchAll() as $p) {
        $ici = $p['last_seen'] === null || (string) $p['last_seen'] >= $limite;
        if (!$ici) {
            continue;
        }
        $present++;
        if ($p['reponse'] !== null) {
            $repondu++;
        }
    }
    return ['present' => $present, 'repondu' => $repondu];
}

/** Tous ceux qui sont là ont répondu — et il y a quelqu'un. */
function epreuve_auto_tous_ont_repondu(array $compte): bool {
    return $compte['present'] > 0 && $compte['repondu'] >= $compte['present'];
}

/**
 * Le temps imparti est-il écoulé, GRÂCE COMPRISE ? On ne révèle qu'après le
 * délai au-delà duquel une réponse est refusée : sinon on volerait une réponse
 * encore en route. `seconds` à 0 = pas de chrono, le temps ne tranche jamais.
 */
function epreuve_auto_temps_ecoule(?string $debut, int $seconds): bool {
    if ($seconds <= 0 || $debut === null || $debut === '') {
        return false;
    }
    $t = strtotime($debut . ' UTC');
    return $t !== false && time() - $t > $seconds + EPREUVE_GRACE_SECONDS;
}

/** Le temps de lecture avant d'enchaîner est-il écoulé ? */
function epreuve_auto_lecture_finie(?string $debut): bool {
    if ($debut === null || $debut === '') {
        return false;
    }
    $t = strtotime($debut . ' UTC');
    return $t !== false && time() - $t >= EPREUVE_ENCHAINEMENT_SECONDS;
}

/** Secondes restantes à annoncer au grand écran (null si aucun chrono). */
function epreuve_auto_restant(?string $debut, int $seconds): ?int {
    if ($seconds <= 0 || $debut === null || $debut === '') {
        return null;
    }
    $t = strtotime($debut . ' UTC');
    return $t === false ? null : max(0, $seconds - (time() - $t));
}
