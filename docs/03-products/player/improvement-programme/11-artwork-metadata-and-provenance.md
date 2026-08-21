---
title: "Artwork, metadata and provenance"
document_type: plan
status: historical
classified: 2026-08-16
---
# Artwork, metadata and provenance

## Objective

Treat metadata and artwork as exhibition material: selected intentionally, refreshed predictably and rendered gracefully when incomplete.

## Artwork roles

- **Poster:** library identity for films, series and seasons.
- **Backdrop/fanart:** hero and ambient context.
- **Episode still:** episode identity and episode/download cards.
- **Clearlogo:** optional title treatment when contrast and resolution are sufficient.
- **Portrait:** people.
- **Journey key art:** curator-selected image or deterministic mosaic.

The server supplies a preferred image for each role plus useful variants. The Player selects for role and viewport, not provider order. It must not stretch posters into backdrops or use a series poster as an episode still when a designed text fallback would be clearer.

## Fallback ladder

1. Curator-locked local artwork.
2. Server preferred provider artwork.
3. Parent entity artwork where semantically correct.
4. Generated palette/text composition with entity icon.

Broken URLs, transparent logos and low-resolution images need separate handling. Dominant-colour extraction may support subtle atmosphere but must never override the locked brand/focus colours.

## Metadata hierarchy

Primary display metadata should be stable across server and Player: title, original title where relevant, year/air time, certification, runtime, genres, network/studio and rating. Provider IDs, file paths, codecs and refresh diagnostics belong in the information drawer or server app.

Episode air time is displayed in the Player/browser’s local timezone while retaining the source network timezone and UTC value server-side. Unknown time is labelled “time not announced,” not midnight.

## Refresh and provenance

- Preserve curator-locked fields and artwork through provider refresh.
- Record provider/source and last refreshed time for diagnostics.
- Surface a quiet “metadata updating” state only when it affects the current exhibit.
- Future episode metadata refreshes after airing and film refreshes after release are server responsibilities; Player caches must invalidate when those updates land.
- Distinguish provider metadata, file-derived media info and curator edits.

## Image delivery

Provide responsive sizes, modern formats where supported, correct cache validators and a stable placeholder ratio. Preload only the active/forthcoming hero; lazy-load off-screen cards. Avoid backdrop cycling that downloads many full-resolution images on low-powered devices.

## Acceptance criteria

- Every entity has a designed missing-art state.
- Curator locks survive automated refresh.
- Episode date/time is timezone-correct and never fabricates midnight.
- Layout does not shift when art loads.
- Image payload and decode budgets are measured at 1080p and 4K.
