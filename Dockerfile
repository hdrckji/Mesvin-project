# « Graine de Parole » — application web statique servie par Caddy.
# Railway détecte ce Dockerfile, construit l'image et fournit $PORT au runtime.

FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile

# Fichiers de l'application (on ne copie pas les fichiers d'infrastructure dans /srv).
COPY index.html app.css app.js sw.js manifest.webmanifest icon.svg /srv/
COPY data/ /srv/data/

# Port par défaut en local ; Railway injecte $PORT, lu par le Caddyfile.
ENV PORT=8080
EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
