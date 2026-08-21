---
title: "Archivist Player implementation plan"
document_type: plan
status: historical
classified: 2026-08-16
---
# Archivist Player implementation plan

Status: priorities 1–6 implemented as of 18 July 2026  
North star: [Arctic Fuse 3](https://github.com/jurialmunkey/skin.arctic.fuse.3) by Jurial Munkey  
Reference version: v3.2.13, released 8 July 2026

## Purpose

Archivist Player should reach the same standard of living-room polish, information density,
remote-first navigation and bounded customisation as Arctic Fuse 3. The objective is not to
copy Kodi or reproduce every Kodi subsystem. It is to adopt the parts that define Arctic
Fuse's experience while using Archivist's native server, database and web component model.

The older `../kodi/player-gap-analysis.md` is useful for broad Kodi capability comparisons,
but it is no longer a reliable implementation roadmap. Watched completion, skip intro and
credits, OpenSubtitles acquisition, spatial navigation, focus restoration, stream selectors,
queue playback and Up Next have all moved beyond the status recorded there.

## Current corrected baseline

### Implemented or substantially implemented

- Server-persisted resume and watched completion, including film Mark Watched/Unwatched.
- Watched and progress indicators on media cards and episodes.
- Intro and credit detection, skip buttons, automatic skip behavior and Up Next interaction.
- Direct play, compatibility transcoding and loudness normalization.
- Audio and subtitle stream selection.
- OpenSubtitles search, download and automatic acquisition in the Archivist server/manager.
- Full D-pad/keyboard focus navigation, focus restoration and gamepad polling.
- Full-bleed artwork, clearlogo support, spotlight presentation and a noir visual baseline.
- Four Player views: poster, landscape, wall and list.
- Category-separated search for films, series and episodes.
- Player presets, widget preferences, accessibility preferences and conflict-safe persistence.

### Completed plan scope

- Configurable hubs, widgets, layouts, spotlight sources and saved-filter browsing.
- Collections, reusable filters, alphabet navigation and server-side browse aggregation.
- Configurable visual tokens, artwork behavior, backdrop cycling and persistent Now Playing.
- Rebuilt film, series, season, episode and person information surfaces.
- Complete playback OSD controls, chapters, bookmarks, online subtitles, queue/cast overlays,
  Still Watching and film post-play recommendations.
- Profile-scoped home configuration and progress, watched rollups and media-state indicators.

### Remaining outside this plan

- Remote-control API and music Player surfaces remain deliberately later projects.

## Priority 1 — Real hub and widget system

This is the defining Arctic Fuse feature and the highest-leverage Player change.

### Scope

- Up to nine user-configurable hubs, each with a name, icon, enabled state and ordering.
- A protected default Home hub plus addable/removable custom hubs.
- Standard, Combined and Wall layouts independently selectable per hub.
- Optional spotlight per hub with a selectable source widget.
- Add, remove, rename, reorder, enable and disable widgets.
- A labelled content-source picker rather than internal source identifiers.
- Per-widget view, sort field, sort direction, item limit and autoscroll interval.
- Show More navigation from bounded widgets into the matching full library.
- Stable empty-widget placeholders so a temporarily empty source does not collapse the page.
- Backward-compatible migration of the original single Home widget configuration.

### Acceptance criteria

- Existing installations retain their current Home widgets after upgrade.
- A user can create a hub, configure it, save, reload and navigate to it from the Player rail.
- Each hub renders correctly in Standard, Combined and Wall modes.
- Combined mode switches between configured widget categories without mixing their content.
- Spotlight can be disabled or sourced from any enabled widget in that hub.
- Widget sorting and ordering are applied by the server, not only rearranged in the browser.
- Widget autoscroll updates the focused presentation without stealing keyboard focus.
- Empty widgets remain visible with a useful empty state.
- Preference validation rejects unsafe identifiers, invalid options and oversized documents.
- Server and Player tests cover migration, validation, custom hub retrieval and editor helpers.

## Priority 2 — Browsing and saved-filter engine

Status: completed 18 July 2026.

- Add genre, year, studio, rating, availability and watched-state filters.
- Add collections, recently played, random, top-rated and unwatched episode/series sources.
- Allow combinations of filters to be saved and reused as a hub, widget or spotlight source.
- Add one consistent Options drawer for view, sort, order, filter and search.
- Add Pin to Home/Hub for the current filtered view.
- Persist allowed/default view choices by content type: films, series, seasons, episodes,
  collections and people.
- Add alphabet jumping for long title lists.

### Implemented

- One server-side browse engine now applies combined search, genre, year, studio/network,
  minimum-rating, availability, watched-state, alphabet and collection filters to films,
  series, episodes and collections.
- Saved views persist the filter combination, media type, view, sort and order in Player
  preference schema v3. Existing schema v1 and v2 preferences migrate automatically.
- Saved views can be reopened as full browse pages, used as hub widgets and selected as a
  hub spotlight source.
- The shared Options drawer provides view, sort, order, filter, search, Save View, Pin to Hub
  and Set as Default controls.
- Films, series, seasons, episodes, collections and people have persisted default view choices.
- Collections use TMDB collection metadata captured during film add and metadata refresh;
  existing film libraries are backfilled automatically in bounded background batches.
- Recently Played, Collections, Random, Top Rated, Unwatched Series and Unwatched Episodes
  are available as widget sources.
- Full browse pages include server-paginated alphabet jumping and stable daily random ordering.

### Acceptance checks

- Combined filters, availability and watched-state aggregation are covered by Player API tests.
- Saved-filter validation rejects missing references and unsafe or oversized documents.
- Schema v1/v2 migration, schema v3 database constraints and collection fields are tested.
- Pin to Hub and safe saved-view deletion are covered by Player component tests.

## Priority 3 — Visual and artwork system

Status: completed 18 July 2026.

- Formalise opacity-based foreground, panel, dialog and background design tokens.
- Replace hard-coded cyan with one configurable focus/accent colour.
- Standardise focus, fade, slide and dialog motion primitives.
- Add artwork blur strength and adaptive dialog tinting.
- Make browse-screen artwork consistently follow the focused item.
- Use clearlogos first with a consistent text fallback.
- Add a persistent Now Playing strip while browsing.

### Implemented

- A formal opacity/token layer now controls foreground, panels, dialogs, tint and backgrounds.
- Accent colour, artwork blur, dialog tint and backdrop-cycle interval are Player preferences.
- Focus, fade, slide, rail, backdrop and dialog motion use shared primitives with reduced-motion
  support.
- Hubs and browse rails publish the focused item as the active artwork/context source.
- Detail heroes prefer clearlogos with a consistent title fallback.
- Playback is global: it can minimize into a persistent Now Playing strip without ending.

## Priority 4 — Information-rich detail surfaces

Status: completed 18 July 2026. The item-page overhaul is part of this priority, not deferred
cosmetic work.

- Configurable rows for cast, crew, collection, gallery, recommendations, seasons and episodes.
- Multiple rating providers with configurable rating slots.
- Configurable primary actions and an overflow menu.
- Trailer, artwork, file information, metadata refresh and edition-selection actions.
- Film collection and edition presentation.
- Person pages with biography and filmography.
- Similar, same-genre and same-collection widgets.
- Rich season surfaces and complete episode information dialogs.

### Implemented

- Film and series pages now use cinematic, artwork-led heroes with configurable actions,
  ratings and information-row ordering.
- Film details expose collection membership, selectable editions, cast, crew, artwork,
  recommendations, file/codec data and durable metadata refresh.
- Series details include poster-led seasons, synopsis and watched rollups, rich episode rows
  and focus-safe episode information dialogs.
- Person routes provide library filmographies; recommendations link back into full detail
  pages.
- Detail contracts include trailers, ratings, files, editions, artwork variants, episode
  airtimes and local recommendation cards.

## Priority 5 — OSD completion

Status: completed 18 July 2026.

- Playback-speed control.
- Audio and subtitle delay controls.
- Chapter navigation and bookmarks.
- OpenSubtitles search/download in the subtitle panel.
- Configurable OSD timeout, pause behavior and elapsed/remaining time display.
- Codec/process information.
- Cast and episode-queue overlays.
- Still Watching prompts and film post-play recommendations.

### Implemented

- Playback speed, audio delay and subtitle delay controls are available from the OSD.
- Embedded chapters and profile-scoped bookmarks are seekable from side panels.
- OpenSubtitles can be searched and downloaded during playback; downloaded sidecars become
  selectable immediately and work over direct or compatibility video.
- Timeout, paused-information mode, elapsed/remaining time and Still Watching interval are
  configurable.
- The information panel reports direct/transcode process and codec/container details.
- Cast, episode queue, Up Next, persistent minimize and film post-play recommendations are
  integrated into the global Player.

## Priority 6 — Secondary depth

Status: completed 18 July 2026.

- Collections across cards, search and hubs.
- Episode/season manual watched controls and series watched rollups.
- Downloading, upgrading, premiere and finale indicators.
- Profiles with separate home configurations.
- Contextual widgets driven by the currently focused item.
- Multiple backdrop cycling and richer artwork types.

### Implemented

- Collections participate in cards, full browse, search, hubs and film detail pages.
- Episode, season and series watched controls update profile-scoped progress and rollups.
- Cards and episode data expose download/upgrade, premiere/finale and availability context.
- Profiles have separate preferences, home hubs, progress and bookmarks and can be switched
  or created from Player Settings.
- Focused cards drive the shell artwork and expanded contextual presentation; detail pages
  provide local recommendations and related collection context.
- Detail heroes cycle available backdrop artwork at the configured interval.

## Deliberately later

The remote-control API and music Player remain worthwhile Kodi-parity projects, but they do
less to make the current film/series experience feel like Arctic Fuse. They should follow the
hub, browse, detail and OSD work unless product scope changes.

## Priority 7 — Visual convergence

Status: in progress from 18 July 2026.

The first six priorities established the required data and interactions. This phase closes the
remaining gap between feature-complete pages and a cohesive Arctic Fuse-quality living-room
experience.

### 7.1 Film and series detail surfaces

- [x] Establish a shared artwork-led hero, content dock, section language and right-side drawer.
- [x] Replace the centred film-information modal with a focus-safe information drawer.
- [x] Add pre-play media selection for film audio and subtitle tracks.
- [x] Add pre-play media selection for the next episode on a series page.
- [x] Add per-episode audio and subtitle selection to the episode information surface.
- [x] Carry explicit item-page track selections into playback ahead of profile defaults.
- [x] Enlarge season artwork and give the active season a dedicated synopsis/episode surface.
- [x] Complete a visual QA pass with deterministic 1080p artwork-rich and missing-art baselines.
- [x] Replace temporary glyphs in detail actions with the shared SVG icon set.

### 7.2 Hub and widget composition

- [x] Give Standard, Combined and Wall layouts clearly differentiated compositions.
- [x] Refine focused-card scale, adjacent-card de-emphasis, spacing and context transitions.
- [x] Apply the saved edge-rail mode in the shell.

### 7.3 Interaction and device polish

- [x] Complete remote focus, scroll restoration and Back behavior across every detail drawer.
- [x] Simplify the first OSD layer and profile it on low-powered television clients.
- [x] Add 1080p and 4K visual-regression fixtures for major Player routes.
