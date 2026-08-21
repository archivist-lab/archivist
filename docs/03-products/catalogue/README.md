---
title: Archivist Catalogue
document_type: product-reference
status: canonical
updated: 2026-08-16
evidence:
  - apps/catalogue/src/App.tsx
  - apps/server/src/catalogue-routes.ts
  - apps/server/src/catalogue-runner.ts
  - apps/server/src/catalogue-database.ts
  - packages/catalogue/src
---

# Archivist Catalogue

Catalogue is the metadata ingestion, identity, and flow-operations surface at `/catalogue/` on production port `2424`. It uses the shared application authentication and a separate Catalogue SQLite database.

## Implemented UI

- Health overview: media/person/artwork counts, completeness, queues, provider configuration, database/artwork storage, and latest flow.
- Start/resume, stop, and typed-confirmation clear/reset controls.
- Item browsing/filtering/search with artwork, completeness, credits, sources, and organisations.
- Cross-media people browser.
- Flow Studio: draft graph editing, nodes/edges/configuration, publish, run/cancel, run/node status, logs, and mapping issues.
- Allowlisted table browser/editor plus database checkpoint.

## Runtime

Catalogue API routes live in the main API process. Flow execution, schedules, queue recovery, and backlog work belong to the leased background worker. The database contains film-oriented legacy tables and the universal Catalogue schema; both are current and must be backed up together.

Providers are conditional. The UI reports IMDb/OMDb/TVDB/TMDB configuration and the runner skips unavailable enrichment sources. Direct TVDB use requires `TVDB_API_KEY`; PIN behavior follows the account/key. Do not describe an unconfigured provider as a product outage.

## Boundary

Catalogue is not yet the sole metadata source for every Library domain and must not be documented as a completed replacement for the main media schema. The dated film gap analysis is historical context.
