---
title: "Downloads, availability and processing"
document_type: plan
status: historical
classified: 2026-08-16
---
# Downloads, availability and processing

## Objective

Keep the normal Player focused on playable exhibits while offering a clear, honest window into active acquisitions and conservation work.

## Availability policy

- Home discovery, Films, Series, general Search and recommendations show available items by default.
- A series is available if at least one episode is playable; episode lists show exact per-episode state.
- Downloads is the explicit exception and may show wanted, queued, searching, downloading, importing and failed items.
- Upgrades remain playable using the current file and are labelled Upgrading rather than unavailable.

## Download presentation

- **Films:** poster, title, percent, state and useful ETA.
- **Series aggregate:** series poster and overall progress when multiple episode acquisitions are grouped.
- **Season aggregate:** season poster with overlay `Series Name S02 · 45%`.
- **Episode:** episode still; smaller series + season line, larger `E05 · Episode Title`, then percent/ETA.
- Unknown total size shows an indeterminate state, not `0%`.
- Completed imports leave the row only after the playable entity is visible elsewhere.

Downloads should be grouped into Films and Series. A server-level Player policy may enable other media types later; the Player should not expose an incomplete per-profile layout editor.

## Conservation/processing

Encoding, audio encoding, loudness normalisation, track cleaning and intro/credit analysis may be shown on the relevant detail information drawer and a compact activity surface. The Player is read-only: pause/start/reorder controls remain in the server’s System processing monitor.

Show process name, item, progress, queued/running/paused/failed state and whether the current file remains playable. Do not combine download percent and post-processing percent into a misleading single number.

## Data and update behaviour

The Player consumes the server’s unified acquisition/job view, not torrent-client-specific data. Prefer event updates with periodic reconciliation. Group IDs must be stable across refreshes, and aggregate percentages should be byte-weighted when totals are known.

## Acceptance criteria

- An acquiring item does not appear as playable in ordinary rows.
- Download entities use the correct artwork and labelling at film/series/season/episode level.
- Live updates preserve focus and card identity.
- Upgrade and post-processing states do not hide an already playable file.
- Failed work provides a concise state and directs administration to the server without exposing admin controls.
