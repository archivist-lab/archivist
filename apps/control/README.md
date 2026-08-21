---
title: "Archivist Control"
document_type: application-guide
status: canonical
classified: 2026-08-16
---
# Archivist Control

Archivist Control is the bare-metal operations surface for the Archivist ecosystem. It is deliberately separate from the Admin API so it remains available when the media application is unhealthy.

## Included in v0.1

- Host CPU, load, memory, uptime, thermal-zone, and volume telemetry
- One-minute performance history with bounded seven-day local retention
- Immutable release inventory with bootability and rollback-readiness checks
- Sanitized backup freshness, manifest, file-size, and SQLite integrity verification
- Token-protected File Browser for the full filesystem and a direct Cardigann definitions root
- Audited upload, directory creation, move, recoverable trash, restore, and single-use download tickets within allowlisted write paths
- Unix-socket-only control agent with canonical path containment and no network access
- Health probes for Library (`/library`), Player (`/player`), Catalogue (`/catalogue`) and the API (`/ping`), all on `2424`
- Allowlisted `systemd` lifecycle control for `archivist.service`
- Bounded `journald` output for the Archivist runtime
- Optional-tool detection for SMART, lm-sensors, Btrfs, and ZFS
- Token-gated mutations and an append-only action audit log
- Localhost-only binding by default

The control service is not a general-purpose shell. It never accepts a unit name or command from the browser; service IDs and actions are mapped through server-side allowlists.

## Development

```bash
corepack pnpm --filter archivist-control build
ARCHIVIST_CONTROL_TOKEN='replace-me' corepack pnpm --filter archivist-control start
```

The production listener is `http://127.0.0.1:2429`. Put it behind an authenticated TLS reverse proxy for remote access. A non-loopback bind refuses to start without `ARCHIVIST_CONTROL_TOKEN` and then requires that token for every API read and mutation.

For UI development, run the API and Vite dev server separately:

```bash
corepack pnpm --filter archivist-control dev
corepack pnpm --filter archivist-control dev:ui
```

## Install on bare metal

The installer is plan-only unless `--apply` is present. Start with the read-only preflight and plan:

```bash
./deploy/preflight-bare-metal.sh
sudo ./deploy/install-bare-metal.sh
```

Review the resolved users and paths, then apply:

```bash
sudo ./deploy/install-bare-metal.sh --apply
```

The installer creates locked `archivist` and `archivist-control` accounts, builds a timestamped release, links persistent state, installs separate environment files, installs the systemd units and polkit rule, and performs an API health check. Existing persistent directories are never re-owned or re-permissioned: the installer verifies that the runtime account already has access and stops if it does not.

Updating through the installer requires the explicit `--allow-update` flag because application startup can apply database migrations. It creates a new release and retains the former target as `/opt/archivist/previous`:

```bash
sudo ./deploy/install-bare-metal.sh --allow-update --apply
```

Binary rollback is explicit and plan-only by default:

```bash
sudo ./deploy/rollback-bare-metal.sh
sudo ./deploy/rollback-bare-metal.sh --apply
```

Rollback does not rewind database migrations. The script says so before acting and automatically restores the original release if the rollback target fails its health check.

### Migrate Docker bind mounts

Stop Docker Compose first. For a migrating installation, install without starting Archivist so the targets stay empty. Migration is copy-only, requires `sqlite3` when source databases are present, validates every copied database, and never removes the source:

```bash
sudo ./deploy/install-bare-metal.sh --no-start --apply

sudo ./deploy/migrate-docker-data.sh \
  --source-data /path/to/docker/data \
  --source-media /path/to/docker/media \
  --source-downloads /path/to/docker/downloads

sudo ./deploy/migrate-docker-data.sh \
  --source-data /path/to/docker/data \
  --source-media /path/to/docker/media \
  --source-downloads /path/to/docker/downloads \
  --docker-stopped --apply

sudo systemctl enable --now archivist.service archivist-control.service
```

The first invocation prints counts and byte totals without changing either side. The confirmation flag makes the SQLite/download quiescence assumption explicit.

To remove system integration while preserving every release and all user data:

```bash
sudo ./deploy/uninstall-bare-metal.sh --apply
```

## Bare-metal layout

The supplied units preserve Archivist's existing runtime contract:

```text
systemd
├── archivist.service
│   └── supervisor
│       ├── API (2424)
│       └── worker (restart backoff remains internal)
├── archivist-control-agent.service (root-owned Unix socket; DAC read/search override only)
└── archivist-control.service (127.0.0.1:2429)
```

The default filesystem layout is:

```text
/opt/archivist/releases/<timestamp>-<revision>  immutable application release
/opt/archivist/current                         active release symlink
/opt/archivist/previous                        rollback release symlink
/var/lib/archivist/data                        databases and application state
/srv/archivist/media                           media library
/srv/archivist/downloads                       download workspace
/var/lib/archivist-control                     append-only control audit state
/etc/archivist                                 configuration and credentials
```

The installer creates separate environment files:

- `/etc/archivist/archivist.env` contains the existing Archivist runtime configuration.
- `/etc/archivist/control.env` is root-readable and contains only `ARCHIVIST_CONTROL_TOKEN` plus optional control-specific overrides. systemd loads it before dropping to the control account.

Archivist Control runs as the locked, unprivileged `archivist-control` user. Its polkit rule checks the caller user, originating systemd unit, target unit, and verb. It permits only `start`, `stop`, and `restart` of `archivist.service`; enablement, unit-file changes, daemon reloads, arbitrary units, and shell execution remain unavailable. The process has an empty capability set, read-only access to releases, and read/write access only to its private state directory.

The separate Control Agent listens only on `/run/archivist-control/agent.sock`. It exposes the filesystem root and a direct Cardigann definitions root, canonicalizes paths, rejects parent traversal and escaping symlinks, and blocks `/etc/archivist`, `/proc`, `/sys`, `/dev`, and `/run`. Reads remain subject to Unix permissions. Writes are limited by `ARCHIVIST_FILE_WRITE_PATHS`; the supplied unit permits `/home`, `/mnt`, `/media`, `/srv`, `/tmp`, `/var/tmp`, and `/var/lib/archivist/data/indexer-definitions`. The agent supports upload, directory creation, move, recoverable trash, and restore. The service has no network namespace. File operations require the control token; downloads use single-use 30-second tickets so the long-lived token never appears in a URL.

## Docker-parity direction

Docker currently provides process lifecycle, restart policy, log collection, health visibility, network publication, resource visibility, configuration injection, persistent paths, upgrades, and rollback through image pinning. Bare-metal parity will be accepted capability-by-capability:

| Capability | v0.1 state | Direction |
|---|---|---|
| Lifecycle and restart | Implemented | systemd + existing supervisor |
| Logs | Implemented | journald with filters/export |
| Health checks | Implemented | Add dependency and deep-health checks |
| Persistent paths | Implemented | Preflight, external state roots, copy-only Docker migration |
| File management | Browser plus audited upload/mkdir/move/trash/restore | Add long-running job progress and richer permission diagnostics |
| Resources | Implemented | Add cgroup limits, GPU, and fan telemetry |
| Configuration | Environment files | Add redacted validation and guided editor |
| Updates | Release recovery inventory | Add signed release preview, backup gate, and canary promotion |
| Storage recovery | Backup verification | Add SMART, scrub, snapshots, and restore drills |
| Privilege boundary | Implemented | Unprivileged service + unit/verb-scoped polkit |
| Authentication | Bearer token | WebAuthn/passkeys and short-lived sessions |

Destructive disk operations, arbitrary terminal access, and unattended upgrades are intentionally excluded until containment, rollback, and auditable authorization exist.
