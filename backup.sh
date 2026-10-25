#!/bin/sh
# Backup consistente (VACUUM INTO) + criptografia (age) + envio ao bucket. Rodar a cada hora via cron/systemd timer.
# Requer: sqlite3 (ou node), age, aws-cli (ou rclone). Variáveis: DB_PATH, BACKUP_DIR, AGE_RECIPIENT, S3_BUCKET
set -eu
DB_PATH="${DB_PATH:-/data/tobus.db}"; BACKUP_DIR="${BACKUP_DIR:-/backups}"; TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/tobus-$TS.db"
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});d.exec(\"VACUUM INTO '\"+process.argv[2]+\"'\")" "$DB_PATH" "$OUT"
age -r "$AGE_RECIPIENT" -o "$OUT.age" "$OUT" && rm -f "$OUT"
[ -n "${S3_BUCKET:-}" ] && aws s3 cp "$OUT.age" "s3://$S3_BUCKET/tobus/$TS.db.age" --sse AES256
find "$BACKUP_DIR" -name 'tobus-*.age' -mtime +14 -delete
echo "backup ok: $OUT.age"
