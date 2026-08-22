<?php
/* ============================================================================
   Signaler ce qui cloche.

   Deux besoins se rejoignent dans ce fichier.

   Le nôtre : les 600 questions du Défi ont été relues deux fois devant le
   texte, mais elles restent écrites par des humains. La personne qui verra
   la 601e coquille, c'est le lecteur, sa Bible ouverte à côté du téléphone.
   Sans un geste à sa portée, ce qu'il voit meurt avec sa soirée.

   Celui de Google Play : une appli qui laisse publier du texte — nos annonces
   d'église — doit offrir un moyen de signaler un contenu, sinon la fiche est
   refusée.

   Deux règles de dessin, dérivées de ces besoins :

   - SIGNALER NE DEMANDE PAS DE COMPTE. L'exiger reviendrait à ne rien
     recevoir : celui qui repère une erreur en veillée n'ouvrira pas une
     session pour la dire. Le garde-fou est un plafond horaire par réseau.
   - ON NE GARDE AUCUNE IP. Le plafond passe par la table throttle, qui ne
     conserve qu'un compteur haché à l'heure. Un signalement, lui, ne laisse
     derrière lui que ce que son auteur a volontairement écrit.
   ========================================================================== */

defined('GRAINE_API') || exit;

/** Ce qui peut être signalé. Tout le reste est refusé — pas de fourre-tout. */
const SIGNALEMENT_GENRES = ['question', 'annonce', 'serie', 'rdv'];

/** Plafond par réseau et par heure. Large pour une salle, étroit pour un robot. */
const SIGNALEMENT_PAR_HEURE = 20;

/**
 * POST /api/signalement — reçoit un signalement.
 *
 * Aucun compte requis. Si un token valable accompagne l'appel, on retient
 * l'auteur (il pourra être remercié, et un signalement nominatif pèse plus
 * lourd) ; sinon la trace est anonyme et le reste.
 */
function handle_signalement_post(PDO $pdo): never {
    throttle_or_429($pdo, 'signalement', SIGNALEMENT_PAR_HEURE);

    $body = read_json_body();

    $genre = trim((string) ($body['genre'] ?? ''));
    if (!in_array($genre, SIGNALEMENT_GENRES, true)) {
        json_error('Genre de signalement inconnu.', 400);
    }

    $cible = trim((string) ($body['cible'] ?? ''));
    if ($cible === '' || mb_strlen($cible) > 120) {
        json_error('Signalement sans cible identifiable.', 400);
    }

    /* Le contexte est figé ici, volontairement. Une question corrigée demain
       ne doit pas effacer la trace de ce qui a été signalé aujourd'hui —
       sinon on relit une fiche vide en se demandant ce qu'elle voulait dire. */
    $contexte = mb_substr(trim((string) ($body['contexte'] ?? '')), 0, 2000);
    $motif    = mb_substr(trim((string) ($body['motif'] ?? '')), 0, 500);

    $auteur = optional_user($pdo);

    $pdo->prepare(
        'INSERT INTO signalements (genre, cible, contexte, motif, auteur_id, statut, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)'
    )->execute([
        $genre,
        $cible,
        $contexte,
        $motif,
        $auteur === null ? null : (int) $auteur['id'],
        'nouveau',
        now_sql(),
    ]);

    /* On ne renvoie ni identifiant ni compteur : le lecteur n'a pas à savoir
       combien de signalements existent, et rien à consulter ensuite. */
    json_out(['ok' => true]);
}

/**
 * GET /api/admin/signalements — la pile à traiter.
 *
 * Les nouveaux d'abord, puis les classés, du plus récent au plus ancien.
 * L'auteur n'apparaît que par son pseudo : l'adresse e-mail n'a rien à faire
 * dans un écran qu'on ouvre pour lire une remarque sur un verset.
 */
function handle_admin_signalements(PDO $pdo): never {
    require_admin($pdo);

    $st = $pdo->query(
        "SELECT s.id, s.genre, s.cible, s.contexte, s.motif, s.statut,
                s.created_at, s.traite_at, u.pseudo AS auteur
         FROM signalements s
         LEFT JOIN users u ON u.id = s.auteur_id
         ORDER BY CASE WHEN s.statut = 'nouveau' THEN 0 ELSE 1 END, s.created_at DESC
         LIMIT 200"
    );

    $liste = [];
    $nouveaux = 0;
    foreach ($st->fetchAll() as $row) {
        if ($row['statut'] === 'nouveau') {
            $nouveaux++;
        }
        $liste[] = [
            'id'        => (int) $row['id'],
            'genre'     => (string) $row['genre'],
            'cible'     => (string) $row['cible'],
            'contexte'  => (string) $row['contexte'],
            'motif'     => (string) $row['motif'],
            'statut'    => (string) $row['statut'],
            'auteur'    => $row['auteur'] === null ? null : (string) $row['auteur'],
            'created_at' => sql_to_iso($row['created_at']),
            'traite_at'  => sql_to_iso($row['traite_at']),
        ];
    }

    json_out(['signalements' => $liste, 'nouveaux' => $nouveaux]);
}

/**
 * POST /api/admin/signalements/{id} — classer (ou rouvrir).
 *
 * On ne supprime jamais : une trace classée dit qu'on a regardé, et permet
 * de rouvrir si la correction s'avère fausse.
 */
function handle_admin_signalement_classer(PDO $pdo, int $id): never {
    $admin = require_admin($pdo);

    $body = read_json_body();
    $statut = ($body['statut'] ?? 'traite') === 'nouveau' ? 'nouveau' : 'traite';

    $st = $pdo->prepare('SELECT id, genre, cible FROM signalements WHERE id = ?');
    $st->execute([$id]);
    $ligne = $st->fetch();
    if ($ligne === false) {
        json_error('Signalement introuvable.', 404);
    }

    $pdo->prepare('UPDATE signalements SET statut = ?, traite_at = ? WHERE id = ?')
        ->execute([$statut, $statut === 'traite' ? now_sql() : null, $id]);

    admin_log($pdo, $admin, 'signalement.' . $statut, $ligne['genre'] . ' — ' . $ligne['cible']);

    json_out(['ok' => true, 'statut' => $statut]);
}
