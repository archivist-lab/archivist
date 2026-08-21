#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVIST_SOURCE="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
errors=0
warnings=0

pass() { printf '  [ok] %s\n' "$1"; }
warn() { printf '  [warn] %s\n' "$1"; warnings=$((warnings + 1)); }
fail() { printf '  [fail] %s\n' "$1"; errors=$((errors + 1)); }

printf 'Archivist bare-metal preflight\n\n'

if [[ "$(uname -s)" == 'Linux' ]]; then pass 'Linux host detected'; else fail 'Linux is required'; fi
if [[ -d /run/systemd/system ]]; then pass 'systemd is the active init system'; else fail 'systemd is required'; fi

for command in node corepack systemctl journalctl rsync openssl runuser pkaction useradd nologin ffmpeg ffprobe fpcalc; do
  if command -v "$command" >/dev/null 2>&1; then pass "$command is available"; else fail "$command is required"; fi
done

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
  if (( node_major >= 20 )); then pass "Node.js $(node --version) satisfies Node 20+"; else fail 'Node.js 20 or newer is required'; fi
fi

for command in sqlite3 curl; do
  if command -v "$command" >/dev/null 2>&1; then pass "$command is available"; else warn "$command is recommended but was not found"; fi
done

for required in package.json pnpm-lock.yaml apps/server/package.json apps/control/package.json apps/control-agent/package.json deploy/systemd/archivist.service deploy/systemd/archivist-control-agent.service deploy/polkit/50-archivist-control.rules; do
  if [[ -e "$ARCHIVIST_SOURCE/$required" ]]; then pass "source contains $required"; else fail "source is missing $required"; fi
done

if command -v ss >/dev/null 2>&1; then
  for port in 2424 2428 4242 2429; do
    if ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .; then warn "TCP port $port is already listening"; else pass "TCP port $port is available"; fi
  done
else
  warn 'ss is unavailable; port conflicts were not checked'
fi

printf '\nPreflight result: %d error(s), %d warning(s)\n' "$errors" "$warnings"
(( errors == 0 ))
