---
title: Deployment and configuration truth
document_type: runbook
status: canonical
updated: 2026-09-05
applies_to:
  - full-bare-metal
  - docker-application
  - host-control
evidence:
  - docker-compose.yml
  - Dockerfile
  - deploy/install-bare-metal.sh
  - deploy/preflight-bare-metal.sh
  - deploy/rollback-bare-metal.sh
  - apps/server/src/config.ts
  - apps/server/test/performance-workload.ts
  - .github/workflows/verify.yml
---

# Deployment and configuration truth

## Supported profiles

1. Docker application: Library, Player, Catalogue, API, worker, and embedded dependencies in one application container.
2. Full bare metal: application supervisor plus Control and Control Agent as host services.
3. Host Control: Control and agent remain host-native whether the application is bare metal or Docker.

Control is not in `docker-compose.yml`. The Docker-management adapter discussed in architecture is not implemented.

## Docker application

`docker compose up -d --build` builds one Node 20 Bookworm image. The runtime installs FFmpeg, FFprobe, Chromaprint/fpcalc, VAAPI tooling/drivers, runs as the image’s `node` user, exposes only `2424`, and mounts:

- `./data:/app/data`
- `./media:/app/media`
- `./downloads:/app/downloads`

The image vendors EmulatorJS and selected cores at build time, so that build requires network access. Its healthcheck requires `/api/v1/health` to report a healthy worker, not merely a responding API.

## Current bare-metal installer

Run preflight, then the plan-only installer, then explicit apply:

```bash
./deploy/preflight-bare-metal.sh
sudo ./deploy/install-bare-metal.sh
sudo ./deploy/install-bare-metal.sh --apply
```

Current defaults are:

```text
/opt/archivist/releases/<timestamp>-<revision>   immutable releases
/opt/archivist/current                          active symlink
/opt/archivist/previous                         rollback symlink
/var/lib/archivist/data                         application databases/state
/srv/archivist/media                            media
/srv/archivist/downloads                        download workspace
/var/lib/archivist-control                      Control audit/history
/var/lib/archivist-control-agent/trash          recoverable file trash
/etc/archivist                                  config and credentials
/run/archivist-control/agent.sock               agent socket
```

Custom `--prefix`, `--state-dir`, `--media-dir`, and `--downloads-dir` are supported. The proposed unified `/archivist` defaults are not yet implemented. Mount media drives beneath a custom media directory only after validating ownership, traversal permissions, and mount-failure behavior.

An existing installation requires `--allow-update`. Startup may migrate databases. Binary rollback switches releases but does not reverse database migrations. Docker-data migration is plan/copy-only by default and never removes its source. Uninstall preserves releases and user data.

## Configuration precedence

The server validates `config.toml` with Zod, then applies environment overrides:

```text
environment variables > config.toml > built-in defaults
```

Typed groups include server, authentication, database, media, definitions, downloads/embedded torrent engine, worker concurrency, provider limits/circuit breaker, and metadata credentials. Provider credentials are mirrored into environment variables for older provider clients. New configuration must be added to the schema and examples; avoid new ad-hoc environment reads.

Important defaults:

- Application: `0.0.0.0:2424`
- Main database: `./data/archivist.sqlite`
- Media: `./media`
- Definitions: `./data/indexer-definitions`
- Complete/incomplete downloads: `./downloads/complete`, `./downloads/incomplete`
- Embedded torrents: enabled
- Control: `127.0.0.1:2429`

Development ports are not production configuration: Library `5173`, Player `4242`, Catalogue `2428`, Control UI `2430`.

## Provider facts

- TMDB: API key and optional base URL.
- TVDB: API key; optional PIN, required when TVDB associates that key/login with a subscriber PIN.
- Google Books: optional API key.
- ComicVine: API key.
- IGDB: client ID and secret.
- Fanart: API key.
- MusicBrainz and other public/provider integrations have their own runtime behavior and rate requirements in provider modules.

Never place real credentials in documentation, examples committed as `.env`, logs, issue reports, or diagnostics.

## Verification

After any deployment:

```bash
curl -fsS http://127.0.0.1:2424/ping
curl -fsS -H 'X-API-Key: …' http://127.0.0.1:2424/api/v1/health
systemctl status archivist.service archivist-control-agent.service archivist-control.service
journalctl -u archivist.service -n 200 --no-pager
```

For Docker replace systemd inspection with `docker compose ps` and `docker compose logs`; do not expect Control inside the Compose project.

## Known operational caveats

- Bare-metal preflight/installer still checks retired production ports `2428` and `4242`; the application gateway itself uses only `2424`. Treat those checks as installer debt, not runtime architecture.
- Control filesystem visibility cannot override Unix permissions; an `EACCES` on a home directory requires deliberate host permission/ACL changes, not broader agent path parsing.
- File Browser writes are allowlisted and audited but still affect real host files. Trash is recoverable until its agent state is lost; it is not a backup.
- Exposing either application or Control beyond a trusted network requires TLS, proxy configuration, authentication, and an explicit threat review.

## Media capacity and verification prerequisites

`MAX_CONCURRENT_ENCODES` maps to validated `workers.encodes` (integer 1–8).
Independent local concurrency settings cannot bypass shared media admission.
Admission uses CPU affinity and Linux CFS quotas and reserves headroom where
available; changing deployment CPU limits requires a runtime restart.
Enabled VMAF rejects replacement if no finite passing score is available, including
missing filter support. Check capabilities against the actual deployed FFmpeg.

Run `pnpm verify` with the declared pnpm version and FFmpeg/FFprobe available.
CI installs system FFmpeg explicitly; binary installation is separate from JS
package installation when dependency lifecycle scripts are disabled.
`pnpm lint` rejects new diagnostics against the versioned baseline;
`pnpm lint:all` exposes remaining legacy diagnostics. Run `pnpm test:performance`
for isolated synthetic safety and UI scaling regressions. Hardware load/soak
acceptance must use disposable media and a representative deployment.

The synthetic workload defaults to five seconds and enforces warm browse p95 below
200 ms with 0/100/10,000 film rows and concurrent delayed subprocesses. Configure
`ARCHIVIST_PERF_SECONDS` (1–86400), `ARCHIVIST_PERF_API_P95_MS`, and optional
`ARCHIVIST_PERF_REPORT` when invoking `test/performance-workload.ts`. This does not
replace a real multi-viewer media/CPU/storage acceptance run.
