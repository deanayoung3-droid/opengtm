#!/bin/sh
# Prove the latest backup restores: load it into a scratch database and count rows.
#   docker compose exec backup restore-check.sh [file.dump]
set -eu
file="${1:-$(ls -1t /backups/gtm-*.dump | head -1)}"
db="gtm_restore_check"
echo "restoring $file into $db"
psql -d postgres -c "DROP DATABASE IF EXISTS $db" >/dev/null
psql -d postgres -c "CREATE DATABASE $db" >/dev/null
pg_restore --no-owner -d "$db" "$file"
for t in companies contacts messages events suppression; do
  printf '%-12s %s\n' "$t" "$(psql -d "$db" -tAc "select count(*) from $t")"
done
psql -d postgres -c "DROP DATABASE $db" >/dev/null
echo "restore check OK"
