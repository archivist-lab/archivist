---
title: Products and application surfaces
document_type: index
status: canonical
updated: 2026-08-16
---

# Products and application surfaces

- [`library/`](library/README.md) — administration, acquisition, curation, settings, and application operations.
- [`player/`](player/README.md) — living-room browsing and playback.
- [`catalogue/`](catalogue/README.md) — metadata catalogue and flow operations.
- [`control/`](control/README.md) — host-native operations and recovery cockpit.
- [`kodi/`](kodi/README.md) — packaged Kodi client and synchronization service.
- [`mobile/`](mobile/README.md) — draft companion/remote proposals; no separate app is delivered.

Production Library, Player, and Catalogue are path prefixes on port `2424`. Control is a separate host-native service on loopback port `2429` by default.
