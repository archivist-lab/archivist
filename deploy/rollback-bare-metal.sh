#!/usr/bin/env bash
set -Eeuo pipefail

PREFIX='/opt/archivist'
APPLY=0

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
usage() { printf 'Usage: sudo ./deploy/rollback-bare-metal.sh [--prefix PATH] --apply\n'; }

while (($#)); do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --prefix) [[ $# -ge 2 ]] || die '--prefix requires a value'; PREFIX="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$PREFIX" == /* && "$PREFIX" != '/' && "$PREFIX" =~ ^[A-Za-z0-9_./-]+$ ]] || die 'prefix must be a safe absolute path other than /'
[[ -L "$PREFIX/current" ]] || die "current release link is missing under $PREFIX"
[[ -L "$PREFIX/previous" ]] || die "previous release link is missing under $PREFIX"

current_release="$(readlink -f "$PREFIX/current")"
previous_release="$(readlink -f "$PREFIX/previous")"
[[ -d "$current_release" && -d "$previous_release" ]] || die 'release links must resolve to existing directories'

printf 'Current release:  %s\n' "$current_release"
printf 'Rollback target:  %s\n' "$previous_release"
printf '%s\n' 'Database state is not changed. Do not continue if the current release applied an incompatible schema migration.'

if (( ! APPLY )); then printf '\nPlan only; no changes were made. Re-run as root with --apply.\n'; exit 0; fi
(( EUID == 0 )) || die '--apply must run as root'

systemctl stop archivist.service
ln -sfnT "$previous_release" "$PREFIX/current"
ln -sfnT "$current_release" "$PREFIX/previous"
systemctl start archivist.service

if command -v curl >/dev/null 2>&1; then
  healthy=0
  for _ in {1..30}; do
    if curl -fsS --max-time 2 http://127.0.0.1:2424/api/v1/health >/dev/null; then healthy=1; break; fi
    sleep 1
  done
  if (( healthy == 0 )); then
    systemctl stop archivist.service
    ln -sfnT "$current_release" "$PREFIX/current"
    ln -sfnT "$previous_release" "$PREFIX/previous"
    systemctl start archivist.service
    die 'rollback target failed its health check; original release was restored'
  fi
fi

printf 'Rollback complete: %s\n' "$previous_release"
