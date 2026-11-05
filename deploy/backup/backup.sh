#!/bin/sh
# Nightly pg_dump to ./backups and, if RCLONE_REMOTE is set, to offsite storage.
#   backup.sh once   # one backup now
#   backup.sh loop   # (container default) back up daily at BACKUP_HOUR local time
set -eu
BACKUP_DIR=/backups
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
HOUR="${BACKUP_HOUR:-3}"

run_once() {
  ts=$(date +%Y%m%d-%H%M%S)
  file="$BACKUP_DIR/gtm-$ts.dump"
  pg_dump -Fc --no-owner -f "$file.partial"
  mv "$file.partial" "$file"
  echo "backup written: $file ($(du -h "$file" | cut -f1))"
  if [ -n "${RCLONE_REMOTE:-}" ]; then
    rclone copy "$file" "$RCLONE_REMOTE/" && echo "uploaded to $RCLONE_REMOTE"
    rclone delete "$RCLONE_REMOTE/" --min-age "${KEEP_DAYS}d" || true
  fi
  find "$BACKUP_DIR" -name 'gtm-*.dump' -mtime +"$KEEP_DAYS" -delete
}

if [ "${1:-loop}" = "once" ]; then
  run_once
  exit 0
fi

while true; do
  now_h=$(date +%H | sed 's/^0//')
  if [ "$now_h" -eq "$HOUR" ]; then
    run_once || echo "BACKUP FAILED" >&2
    sleep 3700
  else
    sleep 600
  fi
done
