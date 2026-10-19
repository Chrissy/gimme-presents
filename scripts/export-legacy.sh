#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: sh scripts/export-legacy.sh /absolute/private/new-backup-directory' >&2
  exit 1
fi
case "$1" in
  /*) ;;
  *) printf '%s\n' 'Use an absolute path outside the repository for the new backup directory.' >&2; exit 1 ;;
esac
for legacy_tool in pg_dump pg_restore psql; do
  command -v "$legacy_tool" >/dev/null 2>&1 || {
    printf 'Required PostgreSQL client missing: %s\n' "$legacy_tool" >&2
    exit 1
  }
done

legacy_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
legacy_backup_dir=$1
# mkdir refuses an existing path, so neither backup nor export can be overwritten.
mkdir -m 700 -- "$legacy_backup_dir"

# libpq reads the connection from PGSERVICE/.pgpass or PG* environment variables.
# No connection URL or password is accepted as an argument or printed here.
pg_dump --no-password --format=custom --file="$legacy_backup_dir/legacy-backup.dump"
pg_restore --list "$legacy_backup_dir/legacy-backup.dump" >/dev/null
psql --no-psqlrc --no-password --quiet --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 --single-transaction \
  --file="$legacy_script_dir/export-legacy.sql" > "$legacy_backup_dir/legacy-export.json"

printf '%s\n' 'Backup and read-only export completed. Keep this directory private; it contains application data.'
