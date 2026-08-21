#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SOURCE_DATA=''
SOURCE_MEDIA=''
SOURCE_DOWNLOADS=''
TARGET_STATE='/var/lib/archivist/data'
TARGET_MEDIA='/srv/archivist/media'
TARGET_DOWNLOADS='/srv/archivist/downloads'
RUNTIME_USER='archivist'
APPLY=0
DOCKER_STOPPED=0

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: sudo ./deploy/migrate-docker-data.sh --source-data PATH --source-media PATH --source-downloads PATH [options]'
  printf '%s\n' '' 'Required for writes:' '  --docker-stopped   Confirm the Docker/Compose runtime is stopped' '  --apply            Copy data after validation (source data is never removed)'
}
validate_path() { [[ "$2" == /* && "$2" != '/' && "$2" =~ ^[A-Za-z0-9_./-]+$ ]] || die "$1 must be a safe absolute path without whitespace"; }

while (($#)); do
  case "$1" in
    --source-data) [[ $# -ge 2 ]] || die '--source-data requires a value'; SOURCE_DATA="$2"; shift 2 ;;
    --source-media) [[ $# -ge 2 ]] || die '--source-media requires a value'; SOURCE_MEDIA="$2"; shift 2 ;;
    --source-downloads) [[ $# -ge 2 ]] || die '--source-downloads requires a value'; SOURCE_DOWNLOADS="$2"; shift 2 ;;
    --target-state) [[ $# -ge 2 ]] || die '--target-state requires a value'; TARGET_STATE="$2"; shift 2 ;;
    --target-media) [[ $# -ge 2 ]] || die '--target-media requires a value'; TARGET_MEDIA="$2"; shift 2 ;;
    --target-downloads) [[ $# -ge 2 ]] || die '--target-downloads requires a value'; TARGET_DOWNLOADS="$2"; shift 2 ;;
    --runtime-user) [[ $# -ge 2 ]] || die '--runtime-user requires a value'; RUNTIME_USER="$2"; shift 2 ;;
    --docker-stopped) DOCKER_STOPPED=1; shift ;;
    --apply) APPLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

for pair in "--source-data:$SOURCE_DATA" "--source-media:$SOURCE_MEDIA" "--source-downloads:$SOURCE_DOWNLOADS" "--target-state:$TARGET_STATE" "--target-media:$TARGET_MEDIA" "--target-downloads:$TARGET_DOWNLOADS"; do
  validate_path "${pair%%:*}" "${pair#*:}"
done
[[ "$RUNTIME_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die 'runtime user is invalid'
command -v rsync >/dev/null || die 'rsync is required'

for source in "$SOURCE_DATA" "$SOURCE_MEDIA" "$SOURCE_DOWNLOADS"; do [[ -d "$source" ]] || die "source directory does not exist: $source"; done
if [[ -n "$(find "$SOURCE_DATA" -type f -name '*.sqlite' -print -quit)" ]] && ! command -v sqlite3 >/dev/null 2>&1; then
  die 'sqlite3 is required to verify Docker database copies before migration'
fi
for mapping in "$SOURCE_DATA:$TARGET_STATE" "$SOURCE_MEDIA:$TARGET_MEDIA" "$SOURCE_DOWNLOADS:$TARGET_DOWNLOADS"; do
  source="${mapping%%:*}"; target="${mapping#*:}"
  [[ "$(realpath -m "$source")" != "$(realpath -m "$target")" ]] || die "source and target are the same: $source"
  if [[ -d "$target" && -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then die "target must be empty: $target"; fi
done

if systemctl is-active --quiet archivist.service 2>/dev/null; then die 'archivist.service must be stopped before migration'; fi

printf 'Docker migration plan (copy-only; sources remain untouched)\n'
for mapping in "$SOURCE_DATA:$TARGET_STATE" "$SOURCE_MEDIA:$TARGET_MEDIA" "$SOURCE_DOWNLOADS:$TARGET_DOWNLOADS"; do
  source="${mapping%%:*}"; target="${mapping#*:}"
  printf '  %s -> %s (%s)\n' "$source" "$target" "$(du -sh "$source" | awk '{print $1}')"
  rsync -a --numeric-ids --dry-run --stats "$source/" "$target/" | awk '/Number of files:|Total file size:/'
done

if (( ! APPLY )); then printf '\nPlan only; no changes were made. Re-run with --docker-stopped --apply.\n'; exit 0; fi
(( EUID == 0 )) || die '--apply must run as root'
(( DOCKER_STOPPED == 1 )) || die '--docker-stopped is required to confirm SQLite and download state are quiescent'
getent passwd "$RUNTIME_USER" >/dev/null || die "runtime user does not exist: $RUNTIME_USER"

for mapping in "$SOURCE_DATA:$TARGET_STATE" "$SOURCE_MEDIA:$TARGET_MEDIA" "$SOURCE_DOWNLOADS:$TARGET_DOWNLOADS"; do
  source="${mapping%%:*}"; target="${mapping#*:}"
  install -d -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0750 "$target"
  rsync -a --numeric-ids "$source/" "$target/"
  chown -R "$RUNTIME_USER:$RUNTIME_USER" "$target"
done

if command -v sqlite3 >/dev/null 2>&1; then
  while IFS= read -r -d '' database; do
    result="$(sqlite3 "$database" 'PRAGMA quick_check;' 2>/dev/null || true)"
    [[ "$result" == 'ok' ]] || die 'a migrated SQLite database failed PRAGMA quick_check'
  done < <(find "$TARGET_STATE" -type f -name '*.sqlite' -print0)
fi

manifest="$(dirname "$TARGET_STATE")/docker-migration.manifest"
install -d -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0750 "$(dirname "$manifest")"
manifest_temp="$(mktemp /tmp/archivist-migration.XXXXXX)"
printf 'completed_at=%s\ndata_bytes=%s\nmedia_bytes=%s\ndownload_bytes=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(du -sb "$TARGET_STATE" | awk '{print $1}')" "$(du -sb "$TARGET_MEDIA" | awk '{print $1}')" "$(du -sb "$TARGET_DOWNLOADS" | awk '{print $1}')" \
  > "$manifest_temp"
install -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0640 "$manifest_temp" "$manifest"
rm -f -- "$manifest_temp"

printf 'Migration complete. Sources were not modified. Review the manifest at %s before starting Archivist.\n' "$manifest"
