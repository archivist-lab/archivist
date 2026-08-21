---
title: "Channels and programmed viewing"
document_type: plan
status: historical
classified: 2026-08-16
---
# Channels and programmed viewing

## Objective

Present Archivist Channels as curated programmed viewing from the owned library, not as a partial imitation of broadcast PVR.

## Experience

- The Channels destination appears only when enabled and at least one channel is playable.
- A guide shows channel identity, now, next and later using local time.
- Joining a channel starts at the correct programme position when session rules support it.
- Programme detail reuses the film/episode information model and links to the full exhibit.
- Channel branding uses the shared Archivist system with curator-provided logo/artwork accents.
- A current programme can be minimised into the global Now Playing surface.

## Curation

Channel schedules, eligibility, repeats and continuity are configured on the server. Useful channel concepts include a universe marathon, director retrospective, seasonal exhibition and a stable general channel. The Player does not edit schedules.

## State and edge cases

- Clearly distinguish “programme has not started,” “channel offline,” “item unavailable” and network/playback failure.
- Timezone changes and daylight-saving boundaries are calculated server-side from UTC schedule instances.
- If a scheduled item becomes unavailable, apply the server’s explicit skip/filler policy and report the actual now-playing item.
- Progress from linear viewing follows a documented rule; it should not incorrectly mark a partially joined film watched.

## Acceptance criteria

- Guide times match the Player locale and remain stable across DST boundaries.
- Now/next changes do not reset guide focus.
- Programme details and playback use the same contracts as library items.
- The UI never suggests tuner recording or PVR capabilities that Archivist does not provide.
