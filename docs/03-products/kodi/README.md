---
title: Archivist Kodi integration
document_type: product-reference
status: canonical
updated: 2026-08-16
evidence:
  - apps/kodi/addon.xml
  - apps/kodi/default.py
  - apps/kodi/service.py
  - apps/kodi/resources
  - apps/kodi/tests
  - apps/server/src/player/routes.ts
---

# Archivist Kodi integration

The Kodi client is a Python video add-on and background service packaged outside the pnpm workspace. The repository currently contains add-on version `0.4.2` and repository packaging.

Implemented code/tests cover API access, routing/presentation, artwork, playable source selection, playback/progress and rating synchronization, library manifest/change feeds, offline cache, library sync, and sync status. Device access uses revocable Archivist device credentials created by an authenticated user.

Build with `python3 apps/kodi/build.py` and verify with `pnpm test:kodi`. Kodi tests are part of root `pnpm verify`; packaging output is maintained under `apps/kodi/repository/public`.

The former phased roadmap and Player gap analysis are historical planning records. They are not an assertion that every Kodi-native library or playback capability is complete.
