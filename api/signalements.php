<?php
/* ============================================================================
   Signaler ce qui cloche.

   Deux besoins se rejoignent dans ce fichier.

   Le nôtre : les 2 500 questions du Défi ont été relues deux fois devant le
   texte, mais elles restent écrites par des humains. La personne qui verra
   la 2 501e coquille, c'est le lecteur, sa Bible ouverte à côté du téléphone.
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

/** Les motifs proposés — une liste courte, pour que le geste reste un geste. */
const SIGNALEMENT_RAISONS = ['inapproprie', 'spam', 'erreur', 'autre'];

/** Les genres qui appartiennent à une église, et se retirent donc depuis la pile. */
const SIGNALEMENT_GENRES_EGLISE = ['annonce', 'serie', 'rdv'];

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

    /* Le motif choisi dans la liste. Facultatif : un signalement sans raison
       vaut mieux qu'un signalement qui n'est pas parti — le Défi, lui, n'en
       propose pas (un tap suffit), et il continue de passer. Une valeur hors
       liste est refusée : la liste est courte pour que la pile se lise vite. */
    $raison = trim((string) ($body['raison'] ?? ''));
    if ($raison === '') {
        $raison = null;
    } elseif (!in_array($raison, SIGNALEMENT_RAISONS, true)) {
        json_error('Motif de signalement inconnu.', 400);
    }

    /* L'église d'où vient le contenu, pour pouvoir le retirer depuis la pile.
       On vérifie la FORME du code, pas son existence : un signalement n'est
       pas le moment de révéler si un groupe existe. */
    $groupe = null;
    if (isset($body['groupe']) && (string) $body['groupe'] !== '') {
        $groupe = normalize_group_code($body['groupe']);
        if ($groupe === null) {
            json_error('Code de groupe invalide.', 400);
        }
    }

    $auteur = optional_user($pdo);

    $pdo->prepare(
        'INSERT INTO signalements (genre, cible, contexte, motif, raison, groupe_code, auteur_id, statut, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )->execute([
        $genre,
        $cible,
        $contexte,
        $motif,
        $raison,
        $groupe,
        $auteur === null ? null : (int) $auteur['id'],
        'nouveau',
        now_sql(),
    ]);

    /* Le courrier part APRÈS l'écriture, et son sort n'entre pas dans la
       réponse : la trace est en base quoi qu'il arrive, et un envoi raté se
       lit dans l'onglet Système (mail_remember_error). */
    mail_send_signalement([
        'genre'       => $genre,
        'cible'       => $cible,
        'contexte'    => $contexte,
        'motif'       => $motif,
        'raison'      => $raison,
        'groupe_code' => $groupe,
        'auteur'      => $auteur === null ? null : (string) $auteur['pseudo'],
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
        "SELECT s.id, s.genre, s.cible, s.contexte, s.motif, s.raison, s.groupe_code, s.statut,
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
            'raison'    => $row['raison'] === null ? null : (string) $row['raison'],
            'groupe'    => $row['groupe_code'] === null ? null : (string) $row['groupe_code'],
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

/**
 * POST /api/admin/signalements/{id}/retirer — retirer le contenu signalé.
 *
 * L'autre issue d'un signalement, à côté de « classer sans suite » : le
 * contenu d'église visé (annonce, rendez-vous, série) est supprimé, et la
 * trace passe en statut « retire ». Le retrait passe par la même porte que
 * l'onglet Églises (admin_retirer_contenu) : un seul chemin, un seul journal.
 * Une question du Défi ne se retire pas d'ici — elle se corrige dans la banque.
 */
function handle_admin_signalement_retirer(PDO $pdo, int $id): never {
    $admin = require_admin($pdo);

    $st = $pdo->prepare('SELECT id, genre, cible, groupe_code, statut FROM signalements WHERE id = ?');
    $st->execute([$id]);
    $ligne = $st->fetch();
    if ($ligne === false) {
        json_error('Signalement introuvable.', 404);
    }
    if (!in_array($ligne['genre'], SIGNALEMENT_GENRES_EGLISE, true)) {
        json_error("Ce signalement ne vise pas un contenu d'église : rien à retirer d'ici.", 400);
    }
    if ($ligne['groupe_code'] === null || $ligne['groupe_code'] === '') {
        json_error("Ce signalement ne dit pas de quelle église vient le contenu.", 400);
    }
    if ($ligne['statut'] === 'retire') {
        json_error('Ce contenu a déjà été retiré.', 409);
    }

    /* La cible est « genre:id » — l'identifiant du contenu dans son église. */
    $morceaux = explode(':', (string) $ligne['cible'], 2);
    $contenuId = trim($morceaux[1] ?? '');
    if ($contenuId === '') {
        json_error('Cible de signalement illisible.', 400);
    }

    $groupe = groupe_load($pdo, (string) $ligne['groupe_code']);
    $retire = admin_retirer_contenu($pdo, $admin, $groupe, (string) $ligne['genre'], $contenuId);

    $pdo->prepare('UPDATE signalements SET statut = ?, traite_at = ? WHERE id = ?')
        ->execute(['retire', now_sql(), $id]);
    admin_log($pdo, $admin, 'signalement.retire', $ligne['genre'] . ' — ' . $ligne['cible']);

    /* `retire` dit si le contenu existait encore : l'église a pu le supprimer
       elle-même entre-temps, et la trace se ferme quand même. */
    json_out(['ok' => true, 'statut' => 'retire', 'retire' => $retire]);
}
