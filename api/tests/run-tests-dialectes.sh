#!/usr/bin/env bash
# ===========================================================================
# La suite complète, DANS LES DEUX DIALECTES.
#
# Pourquoi : db_migrate() porte deux blocs DDL distincts (MySQL et SQLite) qui
# divergent vraiment — ENUM contre CHECK, sémantique de rowCount, types de
# dates. Ne jouer que SQLite revient à déployer le bloc MySQL sans l'avoir
# jamais exécuté une seule fois. La production, elle, tourne sur MySQL.
#
#   ./run-tests-dialectes.sh                     # SQLite seul (rapide)
#   BH_TEST_MYSQL_URL=mysql://u:p@h:port/base \
#     ./run-tests-dialectes.sh                   # SQLite PUIS MySQL
#
# La base MySQL indiquée est VIDÉE à chaque passe : ne jamais pointer une base
# qui contient quoi que ce soit d'utile. Une seconde base, suffixée « _mig »,
# sert au contrôle de migration et doit être accessible au même compte.
# ===========================================================================
set -u
ICI="$(cd "$(dirname "$0")" && pwd)"
ROUGE=$'\033[31m'; VERT=$'\033[32m'; GRAS=$'\033[1m'; FIN_C=$'\033[0m'

echecs=0

printf '%s\n' "${GRAS}── Passe 1 : SQLite ─────────────────────────────────${FIN_C}"
if env -u BH_TEST_MYSQL_URL bash "$ICI/run-tests.sh"; then
  printf '%s\n\n' "${VERT}SQLite : vert${FIN_C}"
else
  printf '%s\n\n' "${ROUGE}SQLite : ÉCHEC${FIN_C}"; echecs=$((echecs + 1))
fi

if [ -n "${BH_TEST_MYSQL_URL:-}" ]; then
  printf '%s\n' "${GRAS}── Passe 2 : MySQL ──────────────────────────────────${FIN_C}"
  if bash "$ICI/run-tests.sh"; then
    printf '%s\n\n' "${VERT}MySQL : vert${FIN_C}"
  else
    printf '%s\n\n' "${ROUGE}MySQL : ÉCHEC${FIN_C}"; echecs=$((echecs + 1))
  fi
else
  printf '%s\n\n' "${ROUGE}MySQL : NON JOUÉ — BH_TEST_MYSQL_URL absente.${FIN_C}
Le dialecte de la PRODUCTION n'a donc pas été vérifié par cette exécution."
fi

[ "$echecs" -eq 0 ] && printf '%s\n' "${VERT}${GRAS}Tous les dialectes joués sont verts.${FIN_C}" \
                    || printf '%s\n' "${ROUGE}${GRAS}$echecs dialecte(s) en échec.${FIN_C}"
exit "$echecs"
