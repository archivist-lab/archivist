---
title: Archivist Player
document_type: product-reference
status: canonical
updated: 2026-08-16
evidence:
  - apps/player/src/App.tsx
  - apps/player/src/components
  - apps/player/src/pages
  - apps/server/src/player/routes.ts
  - apps/player/test
  - apps/player/e2e
---

# Archivist Player

Player is the authenticated living-room and playback surface at `/player/` on production port `2424`. Its current interface is enabled by `PLAYER_UI_V2_ENABLED`; a legacy route shell remains in code as a fallback, not the product direction.

## Implemented experience

- Profile-aware bootstrap, local profile choice, server-stored preferences (schema `5`), legacy-setting migration, reset, and profile create/delete.
- Home hubs, library/domain browsing, filters, search, film/series/episode/person detail, recommendations, Leaving Soon, and keep actions.
- Resume/progress/watched state, bookmarks, film edition selection, play sessions, and synchronization change/manifest endpoints.
- Film and episode streaming with range support, stream planning, direct/transcode selection, track inspection, subtitle extraction/download, loudness state, and OSD controls.
- Programmed Channels guide/current programme and session playback.
- Remote/keyboard spatial navigation, persistent sidebar rail, accessibility text scaling/high contrast, and responsive safe areas.
- Hidden Konami-code Arcade with self-hosted EmulatorJS runtime and game records from the Library.

Playback availability depends on the file, browser codec support, FFmpeg, selected tracks/subtitles, and hardware/runtime configuration. A stream-plan endpoint chooses a path; the existence of a media record alone does not guarantee direct play.

## Configuration

Relevant environment flags include V2 enablement, default preset, maximum widget items, and telemetry enablement. Most personal presentation choices are versioned Player preferences rather than deployment configuration.

## Verification

Player has Vitest unit/component coverage and Playwright browser coverage. Because root lint/typecheck does not independently lint the Player tree, changes must run its own build and tests. CI installs Chromium and runs Player Playwright after repository verification.

## Historical design material

The documents in this folder and `improvement-programme/` are retained as design history. Their roadmaps and “north star” comparisons do not prove current behavior. This page, the capability map, route code, and tests are the current-state sources.
