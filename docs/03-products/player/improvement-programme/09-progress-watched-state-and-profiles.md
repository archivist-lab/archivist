---
title: "Progress, watched state and profiles"
document_type: plan
status: historical
classified: 2026-08-16
---
# Progress, watched state and profiles

## Objective

Make personal state trustworthy across Home, browse, details and playback while keeping the museum’s curation shared.

## Profile boundary

Profiles own:

- playback position and completion;
- play count and last played time;
- bookmarks;
- preferred languages and accessibility/playback settings;
- recommendation and Continue Watching history;
- optional explicit hide/dismiss actions.

Profiles do not own brand appearance, hub design, universe membership or curator ordering.

## Progress rules

- Start recording after a small threshold to avoid accidental opens.
- Mark completed at the defined percentage/end condition, consistently server-side.
- Rewatching a completed item creates progress without immediately removing watched history.
- Continue Watching excludes completed items and entries too close to the beginning unless explicitly bookmarked.
- Series rollups count only regular eligible episodes according to documented specials policy.
- Next Episode considers air/release, availability, ordering and watched state.

## Manual watched controls

Film, season and episode actions must update immediately with optimistic UI and server reconciliation. Series/season bulk changes require confirmation that states how many episodes are affected. Undo should be offered for bulk actions.

## Synchronisation

The server is authoritative. Writes carry revision/idempotency information where duplicate playback events are possible. Multiple Player tabs/devices receive state changes through events or bounded revalidation. Offline progress is queued locally with a conflict rule that favours the furthest recent credible position, not simply the last packet received.

## Privacy and profile switching

Profile switching is obvious, focus-safe and does not leak the prior profile’s Continue Watching during reload. A profile deletion explains that it removes progress/preferences, not library media. PIN/parental access is outside current scope unless separately approved.

## Acceptance criteria

- A watched change appears consistently on card, detail, season rollup, Home and next-episode selection.
- Two devices do not cause progress to jump backwards under normal use.
- Switching profiles cannot flash another profile’s history.
- Bulk season actions are reversible and tested.
- Continue Watching and Next Episode share one server definition of eligibility.
