#!/usr/bin/env bash
#
# push — stage every change, commit, and push to your GitHub repo in one step.
#
#   pnpm push                  # commit with an auto, timestamped message
#   pnpm push "your message"   # commit with your own message
#
set -euo pipefail

# Run from the repo root regardless of where it's invoked.
cd "$(dirname "$0")/.."

branch="$(git rev-parse --abbrev-ref HEAD)"
url="$(git remote get-url origin 2>/dev/null || echo origin)"
msg="${1:-Update Archivist ($(date '+%Y-%m-%d %H:%M'))}"

echo "→ Staging all changes…"
git add -A

if git diff --cached --quiet; then
  echo "→ Nothing new to commit."
else
  git commit -m "$msg"
  echo "→ Committed: $msg"
fi

# Integrate any remote commits first so the push isn't rejected as non-fast-forward.
echo "→ Syncing with origin/$branch…"
git pull --rebase --autostash origin "$branch"

echo "→ Pushing to origin/$branch…"
git push origin "$branch"
echo "✓ Pushed to $url ($branch)"
