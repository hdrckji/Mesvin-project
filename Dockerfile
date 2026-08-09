# « Graine de Parole » — PWA statique + API PHP, servies par FrankenPHP
# (c'est Caddy avec PHP intégré : même stack que les autres projets Railway).
# Railway détecte ce Dockerfile, construit l'image et fournit $PORT au runtime.

FROM dunglas/frankenphp:1-php8.3

# Extensions PDO : MySQL pour Railway, SQLite pour le repli local/dev.
RUN install-php-extensions pdo_mysql pdo_sqlite

COPY Caddyfile /etc/frankenphp/Caddyfile

# L'image de base livre une page de démonstration dans /app/public (index.php) :
# on vide le dossier, sinon elle prend le pas sur notre index.html.
RUN rm -rf /app/public && mkdir -p /app/public

# Fichiers statiques de l'application (inchangés par rapport à la version Caddy).
WORKDIR /app/public
COPY index.html app.css app.js api-client.js sw.js manifest.webmanifest icon.svg ./
COPY data/ ./data/
COPY lire/ ./lire/
COPY defi/ ./defi/

# Backend PHP. Toutes les requêtes /api/* passent par api/index.php
# (réécriture dans le Caddyfile) : les autres .php ne sont jamais servis.
COPY api/ ./api/
# Le repli SQLite doit pouvoir écrire dans api/data (utile sans MySQL ;
# sur Railway, MYSQL_URL est définie et ce dossier ne sert pas).
RUN mkdir -p api/data && chmod 777 api/data

# Ceinture et bretelles : quel que soit l'état des couches précédentes, la
# page de démonstration de l'image de base ne doit pas survivre au build.
RUN rm -f /app/public/index.php && ls -la /app/public | head -20

# Port par défaut en local ; Railway injecte $PORT, lu par le Caddyfile.
ENV PORT=8080
EXPOSE 8080

CMD ["frankenphp", "run", "--config", "/etc/frankenphp/Caddyfile"]
