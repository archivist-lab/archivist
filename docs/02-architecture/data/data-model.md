---
title: Current data architecture and ownership
document_type: architecture
status: canonical
updated: 2026-08-21
evidence:
  - packages/db/src/schema.ts
  - packages/db/src/migrations.ts
  - apps/server/src/catalogue-database.ts
  - packages/catalogue/src/schema.ts
---

# Current data architecture and ownership

## Database files

| Store | Default path | Owner | Purpose |
|---|---|---|---|
| Main | `data/archivist.sqlite` | API and leased worker | Application state and operational coordination |
| Catalogue | `data/catalogue/catalogue.sqlite` | API and leased worker | Catalogue ingestion, identity, artwork, discovery, and flows |

Paths are configurable. `ARCHIVIST_DB` changes the main database; `ARCHIVIST_CATALOGUE_DB` changes Catalogue. Both must be included in backup, integrity verification, migration, and recovery procedures.

## Main database domains

The main schema is defined by `packages/db/src/schema.ts`; migrations currently run through version `40` and are recorded in `_migrations`.

- Library/configuration: `libraries`, `app_settings`, `root_folders`, quality profiles/definitions, custom formats, download clients, and indexers.
- Runtime: durable jobs, process heartbeats, leases, torrent runtime state/commands, and system events.
- Curation: Lists and refresh state, Collections and ordered membership, Recommendations and feedback/exposure/engagement, Leaving Soon rules/requests/runs/notifications, and Ratings.
- Acquisition: acquisition decisions, release blocklist, RSS/search state, durable `item_searches`, media imports, staged-download ignores, and torrent match overrides.
- Media: films/editions/rules; series/seasons/episodes/files; artists/albums/tracks; authors/books/editions; comic series/issues; games.
- Playback: progress, bookmarks, preferences, sync changes, media probes, Channels/programming blocks/schedule slots/play sessions, loudness, track cleaning, credits/people, and segments/fingerprints/links/overrides.
- Security: users, browser sessions, and device credentials.
- Processing: library scan candidates and video optimisation jobs.

Some service modules defensively create tables also present in the consolidated schema. This supports upgraded installations but does not create a second ownership model.

## Catalogue database domains

`apps/server/src/catalogue-database.ts` initializes the existing film-oriented catalogue tables, queues, and flow runtime. `packages/catalogue` then applies the universal catalogue schema and identity operations. Both currently coexist in one Catalogue database.

The database contains:

- film metadata, collections, companies, countries, genres, people, cast/crew, releases, alternate titles, editions, videos, keywords, watch availability, artwork, recommendations, and discovery feeds;
- provider/source identifiers, movie/artwork queues, sync state, and catalogue settings;
- flow graph definitions, runs, node state, logs, and mapping issues;
- universal entities and identity data supplied by `packages/catalogue`.

Do not document Catalogue as the replacement for the main Library database. It is a separate operational catalogue today, and some models overlap while migration/convergence work remains incomplete.

## Migration rules

- Main migrations are numbered, transactional, append-only entries passed to `runMigrations`.
- Add a new version; never renumber or reinterpret a migration that may have run on user data.
- Startup applies migrations automatically. There is no separate production migration command.
- Installer update and binary rollback do not rewind schema changes. Back up and validate databases before an update.
- Tests must use temporary databases, not checked-in/live `data/`.

## Ownership and concurrency

- API routes perform request-time reads/writes.
- The worker owns scheduled work after obtaining the renewable background lease.
- `runtime_processes` exposes liveness/metadata; `runtime_leases` prevents two workers from owning the same background role.
- Durable job/event/search/queue tables are recovery state, not an external broker.
- `item_searches` links a library-scoped film/series/season/episode request to `system_jobs`, stores incremental JSON results and terminal outcome, deduplicates active subject/mode work, and expires terminal records after 15 minutes.
- SQLite write contention and long-running transactions should be kept bounded; media/provider work belongs outside transactions.

## Identity rules

Provider IDs and source provenance are authoritative identity evidence. Names and titles are display/search attributes, not safe merge keys. People, media, companies, and editions must not be merged solely because normalized names resemble one another.

## Filesystem relationship

Databases store metadata, state, and paths; media and download payloads remain on disk. The configured media root is served only through authenticated `/media` or Player stream endpoints. Import, organisation, optimisation, and Sweep operations may move or remove real files and must use the repository’s containment and recovery protections.
