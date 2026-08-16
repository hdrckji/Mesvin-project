<?php
/* ============================================================================
   Fréquentation — des COMPTEURS, rien d'autre.

   Choix délibéré, aligné sur « vie privée d'abord » (VISION.md) : aucun
   identifiant, aucune adresse IP, aucun cookie, aucun recoupement possible.
   Une ligne par (jour, page) qui s'incrémente — on sait « 340 ouvertures
   hier, dont 120 sur Lire », jamais qui, ni combien de personnes distinctes.

   Conséquences assumées, dites à l'administrateur sur l'écran du rapport :
   - l'appli est hors-ligne d'abord : une ouverture sans réseau n'envoie
     rien, et ne se rattrape pas (la stocker pour plus tard reviendrait à
     garder un historique sur l'appareil) — les chiffres SOUS-ESTIMENT ;
   - sans identifiant, rien n'empêche de gonfler un compteur : ces chiffres
     sont un ordre de grandeur pour l'administrateur, pas une mesure.
     C'est pourquoi on ne s'encombre pas du plafond par IP (throttle) : il
     écrirait une ligne par visiteur pour protéger un simple compteur.

   - POST /api/visite         : le signal ({page}) — public, réponse minimale.
   - GET  /api/admin/visites  : le rapport — administrateur seul.
   ========================================================================== */

defined('GRAINE_API') || exit;

/* Liste blanche des pages comptées : tout le reste est ignoré sans bruit.
   (Un signal libre laisserait n'importe qui écrire n'importe quoi en base.) */
const VISITE_PAGES = ['accueil', 'lire', 'defi', 'frise', 'quiadit',
    'ecritoupas', 'portrait', 'memoriser'];
const VISITE_JOURS_GARDES = 400; // ~13 mois : de quoi comparer une année

/* ---- POST /api/visite — le signal, anonyme --------------------------------- */

function handle_visite_post(PDO $pdo): never {
    $page = read_json_body()['page'] ?? null;
    if (!is_string($page) || !in_array($page, VISITE_PAGES, true)) {
        json_out(['ok' => true]); // pas d'erreur : un signal ne se discute pas
    }
    $jour = gmdate('Y-m-d');

    // UPDATE d'abord : la ligne du jour existe dès la deuxième ouverture.
    // (Même prudence que veillee_marquer_present : rowCount() à 0 ne prouve
    // rien de plus que « rien n'a changé », donc l'INSERT retombe sur
    // l'UPDATE s'il perd la course contre un autre signal.)
    $st = $pdo->prepare('UPDATE visites SET n = n + 1 WHERE jour = ? AND page = ?');
    $st->execute([$jour, $page]);
    if ($st->rowCount() === 0) {
        try {
            $pdo->prepare('INSERT INTO visites (jour, page, n) VALUES (?, ?, 1)')
                ->execute([$jour, $page]);
        } catch (PDOException $e) {
            $pdo->prepare('UPDATE visites SET n = n + 1 WHERE jour = ? AND page = ?')
                ->execute([$jour, $page]);
        }
    }
    json_out(['ok' => true]);
}

/* ---- GET /api/admin/visites — le rapport ------------------------------------ */

function handle_admin_visites(PDO $pdo): never {
    require_admin($pdo);

    // Ménage au passage : les compteurs au-delà de la fenêtre gardée.
    $pdo->prepare('DELETE FROM visites WHERE jour < ?')
        ->execute([gmdate('Y-m-d', time() - VISITE_JOURS_GARDES * 86400)]);

    $depuis30 = gmdate('Y-m-d', time() - 30 * 86400);

    // Les 30 derniers jours, jour par jour (toutes pages confondues).
    $st = $pdo->prepare(
        'SELECT jour, SUM(n) AS total FROM visites WHERE jour >= ? GROUP BY jour ORDER BY jour'
    );
    $st->execute([$depuis30]);
    $parJour = array_map(
        static fn (array $r): array => ['jour' => $r['jour'], 'n' => (int) $r['total']],
        $st->fetchAll()
    );

    // Les mêmes 30 jours, page par page.
    $st = $pdo->prepare(
        'SELECT page, SUM(n) AS total FROM visites WHERE jour >= ? GROUP BY page ORDER BY total DESC'
    );
    $st->execute([$depuis30]);
    $parPage = array_map(
        static fn (array $r): array => ['page' => $r['page'], 'n' => (int) $r['total']],
        $st->fetchAll()
    );

    json_out([
        'aujourdhui' => (int) ($pdo->query(
            "SELECT COALESCE(SUM(n), 0) FROM visites WHERE jour = '" . gmdate('Y-m-d') . "'"
        )->fetchColumn()),
        'parJour' => $parJour,
        'parPage' => $parPage,
    ]);
}
