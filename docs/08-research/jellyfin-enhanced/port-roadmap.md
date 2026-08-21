---
title: "Recommended Jellyfin Enhanced port roadmap"
document_type: research
status: historical
classified: 2026-08-16
---
# Recommended Jellyfin Enhanced port roadmap

## Product constraints

All work should follow the current Archivist direction:

- Server and Player remain a paired visual system.
- Player presentation is authored and locked; no theme marketplace or arbitrary appearance controls.
- The server owns shared curation and media truth.
- Profiles own personal viewing state.
- Available content is the default Player surface; acquisition status appears only where intentionally exposed.
- Relationships and continuity should be explainable rather than generated as unexplained recommendations.

## P0 — Viewer agency and spoiler safety

### 1. Profile-scoped dismissal and hiding

Create one server model with explicit scopes:

- `global`;
- `continue_watching`;
- `next_up`;
- `search` only if later justified;
- item, season or series target.

“Remove from Continue Watching” must not alter position, completion or availability. Playing the item again should clear that row-specific dismissal. Global hiding should require confirmation and remain manageable from the profile area.

Server queries should apply visibility before pagination and totals are calculated. Client-side filtering alone would produce short pages, incorrect counts and cross-surface leaks.

Acceptance criteria:

- the same dismissal is respected on every device using the profile;
- Continue Watching and Next Up can be dismissed independently;
- resuming a dismissed item restores it to Continue Watching;
- progress and watched state never change as a side effect;
- profile switching cannot leak another profile's hidden state;
- the management page can search, filter and undo entries.

### 2. Archivist Spoiler Guard

Implement Spoiler Guard as a profile policy, not a CSS effect.

Supported scopes:

- series;
- movie;
- season as an optional advanced scope;
- collection/universe;
- pending external identity before acquisition.

Protected fields should be policy-driven:

- episode still/backdrop;
- episode title;
- synopsis;
- guest cast;
- chapter names;
- rating;
- air date;
- optional season artwork.

Series identity, series poster and episode position should normally remain visible so navigation is possible. A watched episode reveals automatically. Marking it unwatched protects it again.

Artwork delivery should use a profile-aware protected variant:

1. safe parent artwork when available;
2. generated blur when configured;
3. neutral authored fallback if generation fails.

Do not reproduce Jellyfin's anonymous-image identity-marker workaround. Archivist should authenticate/profile-scope image requests or issue signed URLs whose cache key includes the protection revision.

Pending protection should use TMDB/TVDB identity. When an item is imported, a transaction promotes the pending rule to the new internal ID.

Acceptance criteria:

- protected metadata never appears briefly before client filtering;
- direct API responses and image routes enforce the same policy;
- cache keys vary by profile/policy revision;
- watched changes update cards and details immediately;
- collection/universe scope inherits to members without destroying direct item overrides;
- unsupported or ambiguous identity fails safely;
- all rules are tested across Home, browse, search, detail and next-episode responses.

## P1 — Playback depth without visual clutter

### 3. Complete the bookmark lifecycle

Archivist already has profile-scoped bookmarks, OSD listing and persistence. Extend it with:

- label entry when adding;
- visible timeline markers;
- global bookmark management;
- orphan detection after media replacement/removal;
- export and import;
- edition/duplicate synchronisation based on stable media identity;
- optional per-edition time offsets.

Do not automatically merge bookmarks solely by title. Use provider IDs plus media kind and duration tolerance, and require confirmation when confidence is weak.

### 4. One input-command registry

Define semantic commands such as:

- play/pause;
- seek;
- audio/subtitle menu;
- cycle audio/subtitles;
- playback information;
- add bookmark;
- skip active segment;
- speed adjustment;
- aspect mode;
- frame step where the browser supports it.

Keyboard and remote adapters should map into the same command registry. OSD buttons should invoke the same commands. Commands unavailable in the current state should be disabled by the state machine, not ignored silently.

### 5. Quiet pause surface

After a short pause delay, show:

- title and episode identity;
- logo or restrained artwork;
- elapsed, remaining and expected finish time;
- current stream summary;
- a short synopsis only when Spoiler Guard permits it.

Any input should return promptly to the primary OSD. Reduced-motion mode must remove decorative movement. This should mirror Archivist's detail hierarchy rather than copy Jellyfin Enhanced's spinning-disc presentation.

### 6. Event-maintained media summary

Build a compact summary during import/track cleaning and update it on media replacement:

- resolution;
- HDR/Dolby Vision;
- video codec;
- primary audio codec and channels;
- Atmos/DTS:X when reliably detected;
- available audio/subtitle languages.

Store structured values, not preformatted badge strings. Player cards may show at most a small prioritised subset. Full detail belongs in the media selector or information panel.

Use the upstream cache lesson: import/update events enqueue cheap IDs, background workers coalesce recalculation, and a periodic reconciliation covers missed changes.

### 7. Active playback sessions

Add an administrator-only Server view showing:

- profile and device;
- title/episode;
- current position and state;
- direct play or compatibility mode;
- selected streams;
- bitrate;
- last heartbeat;
- playback errors/correlation ID.

Session termination is useful but should be a separate confirmed action. Broadcast messaging is lower priority and should not block the read-only monitor.

## P1 — Viewing-led acquisition

### 8. Continue collecting a series

Adapt automatic next-season requests into an Archivist-native policy:

- opt-in per series or profile;
- trigger when the viewer reaches a configurable remaining-episode threshold;
- verify the next season exists and has released content;
- inherit the series tier and quality policy;
- respect monitoring exclusions;
- create an explainable acquisition event;
- deduplicate against owned, active, queued and previously rejected items.

The default should be suggestion/approval, not silent acquisition. Administrators may enable automatic execution.

### 9. Continue a continuity or universe

Use Archivist's relationship graph rather than TMDB collection order alone:

- curator-defined canonical sequence;
- alternate viewing orders;
- availability and release checks;
- profile progress;
- explicit reason such as “Next in the X-Men continuity”.

If the next item is unavailable, offer “Add to collection” or submit automatically only under an approved policy. Never silently change tier/quality selection.

## P2 — Discovery and context

### 10. Explainable discovery pages

Extend existing person/browse work with:

- person filmography intersected with the local library;
- network/studio/label pages;
- collection and universe journeys;
- genre pages;
- similar items with an explicit reason.

External TMDB discovery may supplement empty local results, but unavailable titles must be visually and behaviourally distinct from playable exhibits.

### 11. External availability

A restrained “Available elsewhere” section could use TMDB watch-provider data:

- profile region;
- provider logo and access type;
- last-refreshed timestamp;
- server-side caching;
- no claim that provider data guarantees present availability.

This is contextual metadata, not a substitute for Archivist acquisition or a new primary navigation surface.

### 12. Optional browser behaviours

Consider profile-level accessibility/playback settings for:

- pause when the tab becomes hidden;
- resume when it becomes visible, only if that same transition caused the pause;
- Picture-in-Picture when supported.

These must default conservatively and be separated from visual customisation.

## P3 — Defer unless demand appears

- user-written reviews and moderation;
- Letterboxd links;
- two-way third-party watchlist synchronisation;
- administrator broadcast messages;
- maintenance mode exposed through Player;
- broad provider-driven recommendation feeds.

## Explicit non-goals

Do not port:

- theme selector;
- custom CSS;
- interchangeable icon packs;
- branding upload;
- splash-screen customisation;
- Jellyfin plugin-dashboard enhancements;
- Seerr as a second acquisition system;
- Sonarr/Radarr as the live source of truth;
- request-time script injection;
- MutationObserver-based feature mounting;
- runtime CDN asset fetching;
- one omnibus feature controller;
- client-visible external-service credentials.

## Suggested delivery order

1. profile visibility schema and query policy;
2. row dismissals and management UI;
3. Spoiler Guard metadata enforcement;
4. protected artwork pipeline;
5. cross-surface events and tests;
6. bookmark lifecycle;
7. input registry and pause surface;
8. media summaries;
9. active sessions;
10. viewing-led acquisition policies;
11. discovery and external availability.

## Relationship to the existing Player roadmap

This roadmap supplements, rather than replaces, `docs/player-improvements`.

- visibility and Spoiler Guard extend profile-state work;
- bookmark/input/pause work belongs in playback hardening;
- media summaries extend artwork/metadata and playback-information contracts;
- active sessions belong primarily in Server;
- continuity-led acquisition depends on the relationship graph;
- no recommendation reopens the removed theme or hub-layout customisation.
