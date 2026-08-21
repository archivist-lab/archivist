---
title: "Jellyfin Enhanced architecture and implementation analysis"
document_type: research
status: historical
classified: 2026-08-16
---
# Jellyfin Enhanced architecture and implementation analysis

## What the plugin actually is

Jellyfin Enhanced is not a conventional isolated server plugin. It is a combined system:

- a C# Jellyfin plugin registering services, scheduled tasks, event consumers, middleware and global MVC response filters;
- a large authenticated API facade for user state, TMDB, Seerr, Sonarr and Radarr operations;
- a JavaScript application injected into Jellyfin Web at request time;
- many browser modules that observe and modify Jellyfin's existing DOM;
- per-user JSON files plus server-side caches for state not represented in Jellyfin's core database.

This makes it unusually capable for a plugin, but also explains much of its complexity.

## Server-side composition

### Request-time web injection

`ScriptInjectionStartupFilter` buffers Jellyfin Web's `index.html`, inserts the plugin script before `</body>`, removes response validators and then serves the altered document. It is defensive and idempotent, and it has an older on-disk rewrite fallback.

This is a sensible workaround for Jellyfin's extension limits. It is not appropriate for Archivist, where Player is a first-party React application and features can be imported normally.

Source: [ScriptInjectionStartupFilter.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/Services/ScriptInjectionStartupFilter.cs)

### Global response filters

The plugin installs global MVC action filters that post-process native Jellyfin responses:

- hidden-content filtering removes items from selected list surfaces;
- spoiler identity tagging places a user marker in image tags;
- spoiler field stripping removes protected metadata;
- spoiler image filtering substitutes or blurs image bytes.

The order is deliberate because post-processing executes in reverse registration order.

This is one of the plugin's best architectural ideas: a privacy or visibility rule should be enforced at the server boundary, not merely hidden with CSS. Archivist should preserve that principle, but express it in its own serializers/query services instead of generic post-response interception.

Source: [PluginServiceRegistrator.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/PluginServiceRegistrator.cs)

### Event consumers and background services

Playback and library events drive:

- automatic next-season requests;
- automatic next-film requests;
- watchlist synchronisation;
- tag-cache updates;
- removal/reappearance in Continue Watching;
- automatic Spoiler Guard enrolment;
- promotion of pre-acquisition spoiler intents when media arrives.

This event-driven approach is preferable to repeated full-library polling. The tag pipeline is especially thoughtful: synchronous library events only enqueue item IDs; a debounced background worker coalesces updates and performs heavier extraction later.

Sources:

- [TagCacheMonitor.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/Services/TagCacheMonitor.cs)
- [TagCacheService.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/Services/TagCacheService.cs)
- [AutoSeasonRequestService.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/Services/AutoSeasonRequestService.cs)
- [AutoMovieRequestService.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/Services/AutoMovieRequestService.cs)

### Large controller facade

`JellyfinEnhancedController` is approximately 9,250 lines and covers configuration, user files, bookmarks, hidden content, spoiler state, reviews, cache data, Seerr requests, TMDB discovery, Arr validation, queues, calendars, active streams, branding and maintenance.

It generally uses authenticated endpoints and adds explicit user/admin checks around sensitive operations. However, the concentration of unrelated domains in one controller increases review cost and the chance of accidental coupling.

Archivist should use one router/service boundary per capability and keep credentials server-side behind purpose-specific responses.

Source: [JellyfinEnhancedController.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/Controllers/JellyfinEnhancedController.cs)

## Client-side composition

The injected bootstrap creates a global `window.JellyfinEnhanced` object, loads configuration and translations, then dynamically loads many independent scripts.

Because it does not control Jellyfin Web's component tree, the plugin relies heavily on:

- route and Jellyfin view events;
- a shared body `MutationObserver`;
- targeted observers for transient controls and dialogs;
- DOM queries and element injection;
- cache-busted runtime script loading;
- CSS inserted by JavaScript.

The project has worked to centralise observers and clean them up, which is good engineering within its constraints. Nevertheless, selectors and observed DOM shapes remain coupled to Jellyfin Web internals.

Archivist should implement the same features as React components, hooks and typed state. There should be no feature that discovers its host by repeatedly scanning `document.body`.

Sources:

- [plugin.js](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/js/plugin.js)
- [helpers.js](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/helpers.js)
- [playback.js](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/playback.js)

## State and persistence

Per-user settings, bookmarks, hidden-content rules and Spoiler Guard state are stored as JSON below the plugin configuration directory.

The persistence implementation is more careful than a basic file store:

- user IDs are normalised;
- paths and file names are guarded against traversal;
- read-modify-write operations use per-file locks;
- writes use a uniquely named temporary file and atomic move;
- strict reads back up corrupt data rather than silently overwriting it;
- migrations handle historical case-variant user folders.

Those are sound patterns, but Archivist already has SQLite and should store these records relationally. JSON files make querying, migrations, referential cleanup and multi-process coordination harder than necessary.

Source: [UserConfigurationManager.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/Configuration/UserConfigurationManager.cs)

## Feature systems worth understanding

### Hidden content

Hidden content is not a single boolean. It has scopes such as global, episode, show, Next Up and Continue Watching, plus per-surface filtering preferences. Dismissing an item from a home row is deliberately non-destructive: progress and watched state are retained, and resuming an item can restore it.

The server filter is the important part. Client-side removal only provides immediate feedback.

### Spoiler Guard

Spoiler Guard is the plugin's most sophisticated feature. Its design includes:

- profile-specific enrolment for series, movies and collections;
- pending TMDB-based enrolment before acquisition;
- automatic promotion when matching media enters the library;
- server-side image blur or safe parent-art replacement;
- removal of descriptions, titles, chapter names, cast, ratings and dates;
- automatic reveal when an episode becomes watched;
- per-user overrides bounded by the administrator's maximum policy;
- cache-bust tokens and identity markers for image requests;
- fail-closed handling when a user cannot be identified safely.

The identity-marker system exists because Jellyfin image requests may be anonymous. Archivist controls its image routes and profile contract, so it should use authenticated/profile-scoped image requests or signed variant URLs instead.

Sources:

- [Spoiler Guard documentation](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/docs/spoiler-guard/spoiler-guard-features.md)
- [SpoilerBlurImageFilter.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/Services/SpoilerGuard/SpoilerBlurImageFilter.cs)
- [SpoilerFieldStripFilter.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/Services/SpoilerGuard/SpoilerFieldStripFilter.cs)

### Bookmarks

Bookmarks support labels, timeline markers, import/export, orphan cleanup, offset correction and synchronisation across duplicate items using provider IDs. Archivist already has profile-scoped bookmarks and OSD controls; the upstream value is the lifecycle around them, not the basic create/delete operation.

Source: [bookmarks.js](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/b416dfe2ac2577b8912184f0c12b8576b52290e2/Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/bookmarks.js)

### Tags and badges

Quality, language, genre and rating tags are computed into a server cache. Library changes enqueue incremental updates, while periodic reconciliation covers missed events and removals. Clients can fetch cache versions/deltas rather than probing every card.

The caching approach is portable. The visual density is not: Archivist should expose only useful technical facts and preserve its exhibit hierarchy.

### Playback helpers

The plugin adds keyboard shortcuts, auto-pause/resume on tab visibility, Picture-in-Picture, speed and aspect controls, intro/outro skipping, a delayed pause screen and subtitle styling.

Archivist already owns its OSD, segments, track selection, playback speed and bookmarks. The useful remaining ideas are a coherent command map, a restrained informational pause surface, and optional visibility/PiP behaviour for browser clients.

### Acquisition integrations

Seerr and Arr support is extensive: search/request state, issue reporting, discovery, watchlist sync, multi-instance links, queue monitoring, calendar data and automated sequel/season requests.

For Jellyfin this closes a major boundary between playback and acquisition. Archivist already owns acquisition, queues, tiers, quality, release monitoring and calendars. Porting these integrations would duplicate native capability. The portable idea is to let viewing state create an acquisition suggestion or policy event inside Archivist.

## Strengths

- Server enforcement is used for sensitive visibility behaviour.
- Most personal state is correctly profile-scoped.
- Background cache maintenance is incremental and debounced.
- Corrupt user data is handled defensively.
- Features have explicit kill switches and fallbacks.
- External-service errors and redirects are treated deliberately.
- The project has broad documentation and localisation.

## Architectural liabilities

- Runtime injection and DOM patching are inherently brittle.
- The client is a global-script system rather than a typed module graph.
- The main controller is too broad.
- Many settings exist because the plugin bundles unrelated products.
- Several caches and identity workarounds compensate for Jellyfin constraints that Archivist does not have.
- Multiple external integrations duplicate data and authority.
- Per-user JSON persistence is less suitable than Archivist's database.

## Licensing

Jellyfin Enhanced and Archivist are both GPLv3 projects at the reviewed revisions, so their licences are broadly compatible. Even so, implementation should begin from an Archivist specification. If source is copied or adapted, preserve copyright and licence notices and record provenance in the commit or source file. Product ideas and observed behaviours can be independently implemented without copying source.

## Architectural rule for every port

For each selected feature:

1. define the server-owned domain state;
2. add a typed contract;
3. expose the smallest purpose-specific route;
4. render it as a first-party Player component;
5. publish state changes through existing event infrastructure;
6. avoid DOM discovery, generic response rewriting and client-held service credentials.

