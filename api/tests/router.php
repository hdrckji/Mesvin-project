<?php
/* ============================================================================
   Routeur pour le serveur de développement PHP.

   Simule la réécriture du Caddyfile (/api/* → api/index.php) :

       cd <racine du projet>
       php -S 127.0.0.1:8180 api/tests/router.php

   Les autres chemins sont servis en statique par php -S (return false).
   ========================================================================== */

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';

if ($path === '/api' || str_starts_with($path, '/api/')) {
    require __DIR__ . '/../index.php';
    return true;
}

return false;
