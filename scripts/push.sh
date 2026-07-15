#!/usr/bin/env bash
#
# Safe project publish helper.
#
#   pnpm push                  # build, commit with timestamped message, push current branch
#   pnpm push "message"        # build, commit with custom message, push current branch
#   SKIP_BUILD=1 pnpm push      # skip local build if you already ran it
#
# This intentionally stages source/config/test files only. Runtime data, media,
# secrets, node_modules, and generated dist output stay local.

set -euo pipefail

cd "$(dirname "$0")/.."

branch="$(git rev-parse --abbrev-ref HEAD)"
remote="${GIT_REMOTE:-origin}"
url="$(git remote get-url "$remote" 2>/dev/null || true)"
msg="${1:-Update Archivist ($(date '+%Y-%m-%d %H:%M'))}"

if [[ -z "$url" ]]; then
  echo "No git remote named '$remote' exists."
  exit 1
fi

if [[ "$branch" == "HEAD" ]]; then
  echo "Refusing to push from detached HEAD. Check out a branch first."
  exit 1
fi

echo "==> Branch: $branch"
echo "==> Remote: $remote ($url)"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Running build"
  pnpm build
else
  echo "==> Skipping build because SKIP_BUILD=1"
fi

echo "==> Staging source changes"
git add \
  .env.example \
  .github \
  Dockerfile \
  README.md \
  docker-compose.yml \
  package.json \
  pnpm-lock.yaml \
  apps \
  client \
  packages \
  data/indexer-definitions

echo "==> Ensuring local-only artifacts are not staged"
git restore --staged --quiet -- \
  .env \
  data/archivist.sqlite \
  data/archivist.sqlite-shm \
  data/archivist.sqlite-wal \
  data/backups \
  data/resume \
  data/torrents \
  media \
  downloads \
  node_modules \
  apps/server/dist \
  apps/player/dist \
  client/dist \
  packages/*/dist \
  packages/*/node_modules 2>/dev/null || true

if git diff --cached --name-only | grep -E '(^|/)\.env$|^data/(archivist\.sqlite|backups|resume|torrents)|^media/|^downloads/|(^|/)node_modules/|(^|/)dist/' >/dev/null; then
  echo "Refusing to commit local data, secrets, dependencies, or build output:"
  git diff --cached --name-only | grep -E '(^|/)\.env$|^data/(archivist\.sqlite|backups|resume|torrents)|^media/|^downloads/|(^|/)node_modules/|(^|/)dist/'
  exit 1
fi

echo "==> Files staged for commit"
git --no-pager diff --cached --name-status

if git diff --cached --quiet; then
  echo "==> Nothing staged to commit. Syncing and pushing branch anyway."
else
  git commit -m "$msg"
  echo "==> Committed: $msg"
fi

echo "==> Rebasing on $remote/$branch"
git pull --rebase --autostash "$remote" "$branch"

echo "==> Pushing to $remote/$branch"
git push "$remote" "$branch"

echo "==> Push complete. GitHub Actions will publish the Docker image after the workflow passes."
