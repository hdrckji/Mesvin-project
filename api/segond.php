<?php
/* ============================================================================
   Lecture du texte Segond 1910 embarqué (lire/data/*.json), côté serveur.

   Sert à un SEUL usage : prévenir un responsable d'église quand la parole
   qu'il vient d'écrire ne se trouve pas à la référence qu'il cite. C'est un
   AVERTISSEMENT, jamais un refus — une église reste libre de ses questions,
   et se réserve d'écrire ce qu'elle veut (voir groupes-series.php).

   Règle d'or : ne jamais crier au loup. Si la référence n'est pas lisible
   (abréviation, livre inconnu, verset hors bornes), on ne dit RIEN — on ne
   sait pas vérifier, ce n'est pas la même chose que « c'est faux ».
   ========================================================================== */

defined('GRAINE_API') || exit;

/** Normalise pour comparer : casse, accents, apostrophes, ponctuation. */
function segond_normalise(string $t): string {
    $t = mb_strtolower($t, 'UTF-8');
    $t = strtr($t, [
        'à' => 'a', 'â' => 'a', 'ä' => 'a', 'á' => 'a', 'ã' => 'a', 'å' => 'a',
        'é' => 'e', 'è' => 'e', 'ê' => 'e', 'ë' => 'e',
        'î' => 'i', 'ï' => 'i', 'í' => 'i',
        'ô' => 'o', 'ö' => 'o', 'ó' => 'o', 'õ' => 'o',
        'ù' => 'u', 'û' => 'u', 'ü' => 'u', 'ú' => 'u',
        'ç' => 'c', 'ñ' => 'n', 'œ' => 'oe', 'æ' => 'ae',
    ]);
    // L'apostrophe est traitée comme une séparation, pas comme une lettre :
    // « qu'à » et « qu à » doivent se ressembler. Un avertissement injustifié
    // coûte bien plus cher qu'un avertissement manqué.
    $t = preg_replace('/[^a-z0-9]+/u', ' ', $t);
    return trim((string) $t);
}

/** Clé de livre : « 1 Samuel » → « 1samuel », qui est aussi le nom du fichier. */
function segond_clef_livre(string $nom): string {
    return preg_replace('/[^a-z0-9]/', '', segond_normalise($nom)) ?? '';
}

/* Seuls écarts entre le nom d'un livre et son fichier, plus les façons
   courantes de le nommer. Tout le reste tombe juste tout seul. */
const SEGOND_ALIAS = [
    'cantiquedescantiques' => 'cantique',
    'cantiquedessalomon'   => 'cantique',
    'psaume'               => 'psaumes',
    'apocalypsedejean'     => 'apocalypse',
    'lamentationsdejeremie' => 'lamentations',
    'ecclesiastes'         => 'ecclesiaste',
];

/**
 * Texte exact d'une référence (« Jean 14.6 », « Marc 10.22-24 »), ou null si
 * elle n'est pas lisible ou n'existe pas. Un null veut dire « je ne sais pas
 * vérifier », jamais « c'est faux ».
 */
function segond_verset(string $ref): ?string {
    if (!preg_match('/^\s*(.+?)\s+(\d+)\s*[.:]\s*(\d+)(?:\s*-\s*(\d+))?\s*$/u', $ref, $m)) {
        return null;
    }
    $clef = segond_clef_livre($m[1]);
    $clef = SEGOND_ALIAS[$clef] ?? $clef;
    if ($clef === '' || !preg_match('/^[a-z0-9]+$/', $clef)) {
        return null; // jamais de nom de fichier venu de l'extérieur sans filtre
    }
    $chemin = __DIR__ . '/../lire/data/' . $clef . '.json';
    if (!is_file($chemin)) {
        return null;
    }
    $data = json_decode((string) file_get_contents($chemin), true);
    $chapitres = is_array($data) ? ($data['chapitres'] ?? null) : null;
    if (!is_array($chapitres)) {
        return null;
    }
    $ch = (int) $m[2];
    if ($ch < 1 || $ch > count($chapitres) || !is_array($chapitres[$ch - 1])) {
        return null;
    }
    $versets = $chapitres[$ch - 1];
    $debut = (int) $m[3];
    $fin = isset($m[4]) && $m[4] !== '' ? (int) $m[4] : $debut;
    if ($debut < 1 || $fin < $debut || $fin > count($versets)) {
        return null;
    }
    return implode(' ', array_slice($versets, $debut - 1, $fin - $debut + 1));
}

/**
 * L'extrait figure-t-il mot pour mot à cette référence ?
 *   true  : oui ;
 *   false : la référence est lisible mais l'extrait n'y est pas ;
 *   null  : on ne sait pas vérifier (référence illisible ou introuvable).
 * Une citation peut élider son milieu par « … » : chaque fragment est alors
 * cherché à son tour, dans l'ordre.
 */
function segond_contient(string $ref, string $extrait): ?bool {
    $source = segond_verset($ref);
    if ($source === null) {
        return null;
    }
    $foin = segond_normalise($source);
    $position = 0;
    foreach (preg_split('/\s*(?:…|\.\.\.)\s*/u', $extrait) ?: [] as $fragment) {
        $aiguille = segond_normalise($fragment);
        if ($aiguille === '') {
            continue;
        }
        $trouve = mb_strpos($foin, $aiguille, $position, 'UTF-8');
        if ($trouve === false) {
            return false;
        }
        $position = $trouve + mb_strlen($aiguille, 'UTF-8');
    }
    return true;
}
