---
title: "@archivist/backup"
document_type: recovery-guide
status: reference
classified: 2026-08-16
evidence:
  - apps/server/src/system/backups.ts
  - apps/server/src/system/admin-routes.ts
---
# @archivist/backup

Private backup manifest package for Archivist.

This package is intentionally kept outside the active pnpm workspace. Do **not** move it under `packages/*` unless you also update the lockfile and build pipeline. The goal is to keep a private recovery anchor in the repository without changing the production build graph.

## What this backs up

### Source backup

Use Git refs for source-code snapshots. A branch or tag is a complete repository snapshot without duplicating files inside the repo.

Recommended commands:

```bash
git fetch origin main
git branch --force backup/local-main origin/main
```

For remote snapshots, create branches named like:

```text
backup/main-YYYY-MM-DD
```

### Runtime backup

Archivist also has an application-level backup system for selected runtime state:

- main SQLite database (`archivist.sqlite`)
- torrent resume state
- torrent files
- optional `.env` copy

It does not currently back up the separate Catalogue database, Catalogue artwork, media, completed downloads, or Control/agent state, and it does not implement restore. Treat it as a component of a host-level backup plan, not complete disaster recovery. Because `.env` may be copied, backup storage has the same sensitivity as live credentials.

Default backup location:

```text
./data/backups
```

Override with:

```bash
ARCHIVIST_BACKUP_DIR=/path/to/backups
```

Manual API run:

```bash
curl -X POST http://localhost:2424/api/v1/system/backups/run \
  -H "X-API-Key: $ARCHIVIST_API_TOKEN"
```

## What not to do

Do not clone the full repository into a subfolder of itself. That creates duplicate source, stale code, broken search results, larger Docker contexts, and false confidence. Use Git branches/tags for source recovery and the app backup system for data recovery.
