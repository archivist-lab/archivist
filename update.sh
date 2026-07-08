#!/usr/bin/env bash
#
# update.sh — pull the latest published Archivist image and restart.
#
# Run this on the machine hosting Archivist, in the same folder as your
# docker-compose.yml (and .env):
#
#   ./update.sh
#
# It does not build anything — it fetches the image CI published to GHCR.
# Your ./data and ./media are bind-mounted and left untouched.
# (If your user isn't in the `docker` group, run: sudo ./update.sh)
#
set -euo pipefail

cd "$(dirname "$0")"

echo "→ Pulling latest image…"
docker compose pull

echo "→ Restarting container…"
docker compose up -d

echo "→ Removing dangling images…"
docker image prune -f >/dev/null 2>&1 || true

echo "→ Waiting for health…"
for _ in $(seq 1 45); do
  if curl -fsS -m 2 http://127.0.0.1:2424/ping >/dev/null 2>&1; then
    echo "✓ Archivist is up at http://localhost:2424"
    exit 0
  fi
  sleep 2
done

echo "⚠ Started, but /ping hasn't responded yet — check: docker compose logs -f"
exit 1
