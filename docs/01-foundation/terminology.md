---
title: Archivist terminology
document_type: reference
status: canonical
updated: 2026-08-16
---

# Archivist terminology

| Term | Meaning |
|---|---|
| Archivist | The complete self-hosted media lifecycle ecosystem |
| Library | The administrative SPA; also a logical scoped collection stored in `libraries` |
| tab | Legacy/current API term for a logical library; selected by `X-Tab-Context` |
| Player | Playback-first living-room web application |
| Catalogue | Separate metadata/identity/flow database, runtime, API, and SPA |
| Control | Unprivileged host operations web service on port `2429` |
| Control Agent | Restricted root-owned, Unix-socket-only host filesystem boundary |
| supervisor | Production parent that starts API and worker child processes |
| API process | Request/static-gateway process on port `2424` |
| worker | Leased background process that owns jobs, schedulers, torrents, and Catalogue execution |
| indexer | Configured searchable release source using Cardigann-style or Torznab behavior |
| definition | YAML description of an indexer’s settings, requests, selectors, and mappings |
| RSS | Latest-release polling workflow; not necessarily a literal external RSS URL for every definition |
| acquisition decision | Recorded accept/reject result after identity and policy evaluation |
| embedded engine | Archivist’s in-process BitTorrent session, controlled from API through shared runtime state |
| root folder | Library destination root, distinct from the server’s overall media base |
| monitored | Eligible for automatic missing/release acquisition, subject to child and policy state |
| wanted/missing | Media state eligible for acquisition; not a promise a candidate exists |
| `air_at` | Absolute episode release timestamp used by rapid RSS/targeted scheduling |
| Channel | Archivist-programmed pseudo-live schedule and play-session model |
| flow | Catalogue directed graph definition executed and observed as runs/nodes/logs |
| canonical | Current authoritative documentation reconciled with implementation evidence |
| accepted | Agreed architecture/direction that may not yet be delivered |
