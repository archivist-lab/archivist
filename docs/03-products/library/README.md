---
title: Archivist Library
document_type: product-reference
status: canonical
updated: 2026-08-21
evidence:
  - client/src/App.tsx
  - client/src/modules
  - apps/server/src/routes.ts
  - client/src/modules/music/index.tsx
---

# Archivist Library

Library is Archivist’s administration and curation application. In production it is served at `/library/` on the shared port `2424`. Its source lives in `client/`; the historical “Admin” name still appears in code and comments.

## Current navigation and modules

- Home: dashboard, calendar, add media, manual search, and active-download monitor.
- Media: Films, Series, Music, Books, Comics, and Games with list/detail/add/edit/refresh workflows appropriate to each domain.
  Music detail follows the Series layout — albums stand in for seasons and tracks for
  episodes — with the artist's logo, portrait, biography, rating, top three genres, band
  members, and per-item status carried in the same positions. Its quality/codec profile
  is set once for the artist and cascades to every album. Metadata editing is available
  at all three levels; for a track that means lyrics.
- Curation: Lists, Collections, Recommendations, Ratings surfaces, Channels, and Leaving Soon.
- Acquisition: acquisition decisions/history, release search/grab, torrents, indexers, download clients, root folders, quality profiles/definitions, custom formats, and priorities.
- Operations/settings: onboarding, enabled media types, API/provider keys, imports, processing, media metadata, track cleaning, segment detection, backups/integrity/maintenance visibility, and application settings.

Logical libraries are still called tabs in API and UI code. The selected tab is sent through `X-Tab-Context`, allowing separate roots and settings for multiple libraries of one media type while retaining one main database.

## Boundaries

Library is not the playback-first interface; Player owns living-room interaction. Library is not host administration; Control owns host/service/file recovery. Library can initiate application-level file processing and media lifecycle operations, so those paths must retain containment, validation, quarantine/trash where implemented, and audit/event records.

## Development

The Library Vite server defaults to `5173`. Production does not expose that port: the built SPA is mounted by the gateway at `/library/`.
