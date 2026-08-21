---
title: Current system architecture
document_type: architecture
status: canonical
updated: 2026-08-17
applies_to:
  - full-bare-metal
  - docker-application
  - host-control
evidence:
  - apps/server/src/supervisor.ts
  - apps/server/src/server.ts
  - apps/server/src/worker.ts
  - apps/server/src/gateway.ts
  - apps/server/src/app.ts
  - apps/control/src/server/index.ts
  - apps/control-agent/src/index.ts
---

# Current system architecture

## Runtime topology

```text
                           production port 2424
browser / Kodi ───────────────────┬─────────────────────────────────┐
                                 │ HTTP gateway                    │
             ┌───────────────────┼──────────────────┐              │
             │ /library          │ /player         │ /catalogue    │
             │ static SPA        │ static SPA      │ static SPA    │
             └───────────────────┴──────────────────┘              │
                                 │ /api/v1, /media, /ping           │
                                 ▼                                 │
                           Express API process                     │
                                 │ SQLite / IPC state               │
                                 ▼                                 │
                           background worker                       │
              jobs, schedulers, torrents, catalogue flows          │
                                                                   │
production supervisor ─ starts API + worker; restarts worker ──────┘

host loopback port 2429
browser ── Archivist Control (unprivileged) ── Unix socket ── Control Agent
                 │ systemd via polkit                 host filesystem reads/writes
                 └ journald, /proc, release and backup inspection
```

The application is not one Node process. `supervisor.ts` starts an API child and a worker child. The API owns the only public application listener; the worker owns background execution. Health is degraded until the worker heartbeat reports ready.

Control is deliberately outside that failure domain. Its web process listens on loopback by default and delegates filesystem operations to a separately sandboxed agent over `/run/archivist-control/agent.sock`.

## HTTP ownership

`gateway.ts` owns static routing and the chooser. It forwards only `/api/v1`, `/media`, and `/ping` to Express. The API does not mount SPA builds itself. Same-origin production routing means the earlier Player network isolation no longer exists; authentication is the application boundary.

The Library surface currently has no strict CSP because existing inline React styles have not been audited. Player and Catalogue receive strict CSP. Arcade receives a narrowly scoped exception for EmulatorJS WebAssembly, blob workers, inline runtime setup, and Emscripten `eval` behavior.

## API process responsibilities

- Open and migrate the main SQLite database.
- Ensure default logical libraries.
- Open the catalogue database and construct the Catalogue runner API.
- Load indexer definitions/configuration for request-time search and testing.
- Optionally initialize the torrent RPC client.
- Authenticate API, browser session, bootstrap, and device credentials.
- Serve domain/platform routes, protected media, Server-Sent Events, and health.
- Relay durable events and maintain API process registration/heartbeat.

## Worker responsibilities

The worker acquires the `background-worker` runtime lease (20-second TTL, renewed every 5 seconds) before starting owned work. It registers itself in the process table and runs:

- system, catalogue, media, and automation job lanes;
- durable user-triggered item searches in a serial-by-default `searches` lane;
- indexer bridge and optional embedded torrent session;
- media import and media-processing jobs;
- backup, integrity, and maintenance scheduling;
- download monitoring;
- RSS release orchestration, new-release and missing/backlog search;
- film and series metadata refresh;
- Channels, Lists, Leaving Soon, and Recommendations scheduling;
- video optimisation execution;
- loudness and segment-detection queues;
- Catalogue schedules and queue recovery.

The worker is the only intended background owner. Durable state allows restart recovery; not every external provider action is transactionally reversible.

Interactive film/series search follows the same producer/executor boundary: API routes enqueue and expose durable state, while the worker contacts indexers and download clients. Page navigation can cancel client polling without cancelling the job. Completed results are retained for 15 minutes so a returning page can restore them.

## Data boundaries

Archivist uses two SQLite databases:

- Main: library, media, acquisition, downloads, playback, authentication, automation, operational jobs/events, and settings.
- Catalogue: catalogue entities, identities, artwork, discovery, queues, flow definitions/runs/logs, and settings.

SQLite also coordinates process liveness and the worker lease. There is no external queue, cache, or database service. See [`data-model.md`](data/data-model.md).

## Trust boundaries

1. The shared application listener is reachable wherever port `2424` is published.
2. Application `/api/v1` routes are authenticated except status/login/setup/logout and public aggregate `GET /api/v1/health`. `/media` is protected; `/ping` is public liveness.
3. Browser sessions use HTTP-only, SameSite=Strict cookies; `Secure` follows TLS/forwarded protocol when proxy trust is explicitly configured.
4. API service keys and revocable device credentials are alternate principals. Authorization is currently single-tier after authentication—there is no role model.
5. Control uses a separate token and never reads application provider secrets. Remote Control requires a token and should be placed behind authenticated TLS.
6. The Control web process has no general privileged channel. systemd actions are allowlisted; filesystem requests are checked by the agent; arbitrary shell execution is absent.

## Deployment mapping

| Profile | Application supervisor | Web surfaces/API | Control | Current packaging truth |
|---|---|---|---|---|
| Docker application | Container | One container, port `2424` | Host only | Delivered by `Dockerfile` and `docker-compose.yml` |
| Full bare metal | `archivist.service` | Host, port `2424` | Host services, port `2429` | Delivered using split FHS defaults |
| Host Control | N/A or application adapter | Observes application | Always host-native | systemd application adapter delivered; Docker adapter not delivered |

The unified `/archivist` bare-metal hierarchy is accepted direction, not current installer behavior. Today’s installer defaults to `/opt/archivist`, `/var/lib/archivist`, `/srv/archivist`, and `/etc/archivist`.

## Architectural constraints

- Keep API and background ownership separate.
- Keep one production application listener unless an accepted ADR changes it.
- Preserve both databases and transactional, append-only migration history.
- Do not give Control’s web process a Docker socket, root shell, block devices, or arbitrary systemd control.
- File-moving and destructive media operations require containment, recoverability where possible, and auditability.
- Specs and plans never override executable behavior; unresolved mismatches belong in the limitations register.
