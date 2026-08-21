---
title: "Jellyfin Enhanced feature matrix"
document_type: research
status: historical
classified: 2026-08-16
---
# Jellyfin Enhanced feature matrix

## Reading the matrix

- **Port** means the idea is valuable and Archivist has a meaningful gap.
- **Extend** means Archivist already has the core capability and should adopt selected refinements.
- **Do not port** means it duplicates Archivist, conflicts with the product direction or exists only as a Jellyfin workaround.

| Jellyfin Enhanced capability | Archivist position | Decision | Rationale |
|---|---|---|---|
| Hidden content by profile and surface | No equivalent first-class model found | **Port — P0** | Gives viewers control without corrupting progress or shared curation. |
| Remove from Continue Watching / Next Up | Rows exist; no durable dismissal model found | **Port — P0** | High-value, low-concept feature; must remain distinct from watched state. |
| Spoiler Guard | No equivalent found | **Port — P0** | Excellent fit for an exhibit-led museum that should not reveal future episode details. |
| Smart bookmarks | Core database, API and OSD already exist | **Extend — P1** | Add labels at creation, timeline markers, management, import/export and edition syncing. |
| Keyboard shortcut map | OSD/keyboard support exists but is distributed | **Extend — P1** | Formalise one command registry shared by keyboard and remote input. |
| Pause information screen | Playback has OSD but no equivalent mature pause exhibit identified | **Extend — P1** | Useful if quiet, delayed and consistent with Server styling; avoid decorative disc effects. |
| Auto-pause/resume on tab change | No clear equivalent found | **Optional — P2** | Useful on desktop browsers, potentially surprising on television devices. |
| Automatic Picture-in-Picture | No clear equivalent found | **Optional — P2** | Browser-specific convenience, not a core museum capability. |
| Playback speed, chapters, audio/subtitle selection | Already present | **Do not duplicate** | Continue hardening the existing OSD and media selector. |
| Auto-skip intro/outro | Native segment system exists | **Do not duplicate** | Improve confidence and detection in Archivist's own segment pipeline. |
| Subtitle appearance controls | Some accessibility/playback preferences exist | **Selective extend — P1** | Retain accessibility controls, not open-ended theming. |
| Quality/audio/language badges | Track metadata exists; card badges are incomplete | **Port selectively — P1** | Use a restrained server-derived summary, not a wall of tags. |
| Genre/rating/person tags on every card | Metadata exists | **Mostly reject** | Too visually noisy for the locked exhibit design; place depth on detail surfaces. |
| Random playback/discovery | Random film/series hubs already exist | **No action** | Already native. |
| Seerr search and requesting | Archivist owns search and acquisition | **Do not port** | Adds another authority and credentials for a native responsibility. |
| Sonarr/Radarr queue and calendar pages | Archivist owns queues/calendars and can import from Arr | **Do not port** | Treat Arr as import/interoperability, not the active control plane. |
| Auto-request next season | Archivist owns series monitoring/acquisition | **Adapt — P1** | Translate into an optional native “continue collecting” policy with tier/quality inheritance. |
| Auto-request next collection movie | Continuity/universe roadmap exists | **Adapt — P1** | Use Archivist relationships, availability and curator ordering instead of TMDB collection order alone. |
| Watchlist sync | List import exists | **Later — P2** | Only add ongoing two-way sync after identity/conflict rules are specified. |
| Similar/recommended/genre/network/person discovery | Player has browse/person work and relationship roadmap | **Extend — P1** | Prefer explainable Archivist relationships over opaque external recommendations. |
| Streaming provider lookup (“Elsewhere”) | No equivalent identified | **Later — P2** | Useful context, but not required for local playback; provider data is region-sensitive. |
| User reviews | No equivalent identified | **Defer — P3** | Moderation, spoilers and multi-user semantics cost more than the likely value. |
| Active streams widget and broadcast | Processing activity exists, playback sessions UI not identified | **Port — P1** | Valuable operational view for administrators; broadcast can follow later. |
| Hidden-content admin management | No equivalent | **Port with hidden content** | Needed for support, but cross-profile access must be audited and explicit. |
| Maintenance mode | Server administration exists | **Consider separately — P2** | Useful operational capability, not a Player priority. |
| Themes, icon packs and arbitrary CSS | Explicitly conflicts with locked Archivist styling | **Do not port** | Archivist has one authored museum identity. |
| Custom branding and splash screens | Conflicts with current product direction | **Do not port** | Avoid multiplying visual states. |
| Login image and plugin icon replacement | Jellyfin-specific | **Do not port** | No equivalent plugin dashboard problem. |
| Letterboxd links | No equivalent | **Defer — P3** | Low-value outbound link compared with native relationships and provenance. |
| Local CDN proxy/cache | Archivist can bundle assets directly | **Do not port as-is** | Self-host fonts/icons at build time; do not add runtime CDN dependency. |
| Script injection and DOM observers | First-party Player exists | **Never port** | Would reduce reliability, type safety and testability. |

## Highest-value combined slice

The best first delivery is not a collection of unrelated enhancements. It is one coherent “viewer agency and spoiler safety” slice:

1. profile-scoped dismissals;
2. hidden-content management;
3. Spoiler Guard;
4. server events so all Player surfaces update immediately;
5. tests proving search, Home, browse, details and playback agree.

That slice establishes the profile-policy foundation used later by bookmarks, recommendations and acquisition suggestions.

