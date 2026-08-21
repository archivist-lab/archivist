---
title: "Jellyfin Enhanced review for Archivist"
document_type: research
status: historical
classified: 2026-08-16
---
# Jellyfin Enhanced review for Archivist

## Purpose

This folder records a source-level review of [Jellyfin Enhanced](https://github.com/n00bcodr/Jellyfin-Enhanced) and recommends which product ideas Archivist should adopt.

The review covers upstream commit [`b416dfe2`](https://github.com/n00bcodr/Jellyfin-Enhanced/tree/b416dfe2ac2577b8912184f0c12b8576b52290e2), dated 20 July 2026. It considers the C# plugin, injected browser runtime, configuration model, response filters, scheduled services, integrations and published feature documentation.

This is an inspiration and planning exercise only. No Archivist code was changed.

## Executive conclusion

Jellyfin Enhanced is best understood as a broad product-experiment layer over Jellyfin. It combines useful viewing behaviours with substantial compatibility machinery needed to alter a web client the plugin does not own. Archivist owns both Server and Player, so it can implement the strongest behaviours far more cleanly.

The most valuable ideas for Archivist are:

1. profile-scoped hiding and non-destructive dismissal from Continue Watching and Next Up;
2. a first-class Spoiler Guard enforced by the server;
3. richer bookmarks, including timeline markers, management and cross-edition synchronisation;
4. event-maintained media badges and compact technical summaries;
5. continuity-aware “what next” acquisition policies;
6. an active-playback sessions view for administrators.

The strongest idea is Spoiler Guard. It fits Archivist's museum concept: exhibits can preserve discovery and context without revealing episode imagery, titles or summaries before a viewer reaches them.

The largest mistake would be to copy the plugin's delivery architecture. Archivist should not adopt runtime script injection, DOM mutation observers, page scraping, a monolithic controller, duplicated public/private configuration payloads or third-party integration proxies for capabilities already native to Archivist.

## Documents

- [Architecture and implementation analysis](architecture-analysis.md)
- [Feature comparison matrix](feature-matrix.md)
- [Recommended port roadmap](port-roadmap.md)

## Recommendation in one sentence

Port the durable product behaviours, re-design them around Archivist's typed contracts and authoritative database, and leave Jellyfin-specific patching and duplicate acquisition integrations behind.

