#!/usr/bin/env bash
set -Eeuo pipefail

APPLY=0

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --help|-h) printf 'Usage: sudo ./deploy/uninstall-bare-metal.sh --apply\n'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

printf '%s\n' 'This removes only Archivist systemd registration and its polkit rule.'
printf '%s\n' 'Releases, configuration, databases, media, downloads, audit logs, and system users are preserved.'

if (( ! APPLY )); then printf '\nPlan only; no changes were made. Re-run as root with --apply.\n'; exit 0; fi
(( EUID == 0 )) || die '--apply must run as root'

systemctl disable --now archivist-control.service archivist-control-agent.service archivist.service 2>/dev/null || true
for installed_file in /etc/systemd/system/archivist-control.service /etc/systemd/system/archivist-control-agent.service /etc/systemd/system/archivist.service /etc/polkit-1/rules.d/50-archivist-control.rules; do
  if [[ -f "$installed_file" ]]; then rm -f -- "$installed_file"; fi
done
systemctl daemon-reload
systemctl reset-failed archivist.service archivist-control-agent.service archivist-control.service 2>/dev/null || true

printf '%s\n' 'System integration removed. Persistent data and accounts were preserved for recovery or reinstallation.'
