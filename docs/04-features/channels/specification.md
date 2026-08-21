---
title: "Archivist Channels — Tunarr as the North Star"
document_type: feature-specification
status: historical
classified: 2026-08-16
---
# Archivist Channels — Tunarr as the North Star

**Purpose.** This document is a source-derived analysis of **Tunarr**
(https://github.com/chrisbenincasa/tunarr) — an app that builds virtual "live TV" channels out
of media libraries — followed by a design for integrating the same capability **natively into
Archivist** as a "Channels" tab (visible when the user has films and/or series libraries), with
channels exposed to **Archivist Player** through the player contract.

**Method.** Cloned Tunarr at v1.2.0-dev.1 (`package.json`; license Zlib) and read the source:
the 51-page docs tree (`docs/`), the shared type schemas (`types/src/`), the server
(`server/src/` — Fastify + SQLite), and the web app (`web/src/` — React). File paths are cited
throughout. Nothing is inferred from memory.

**Structure.** Part I analyses Tunarr. Part II designs the Archivist integration. Part III
adds demand analysis (Tunarr's issue tracker) and clean-slate design notes. **Part IV
incorporates the "Personal TV Network / Scheduled VOD Guide" product brief** — which reframes
the primary product as a *clickable guide* ("watch from here") rather than a broadcast
simulator — and reconciles it with everything before it, ending in a revised build order that
supersedes §21.

**The one-sentence takeaway.** Tunarr's concepts (channels, lineups, slots, filler, flex, EPG)
are exactly right and worth adopting wholesale — but its architecture (static precalculated
schedules over external media servers, ffmpeg re-streaming) is shaped by constraints Archivist
doesn't have. Building channels *inside* Archivist lets us keep the concepts, delete most of
the machinery, and add the thing Tunarr fundamentally cannot do: **watch-state-aware dynamic
slots** — e.g. "Sunday night: latest unwatched Sopranos, then latest unwatched Breaking Bad,
then latest unwatched The Wire, with priority fallbacks per slot."

---

## Part I — What Tunarr is and how it works

### 1. Product overview

From `README.md` and `docs/`:

- Create live-TV-style channels from media on **Plex, Jellyfin, Emby, or local files**.
- Watch via a **spoofed HDHomeRun tuner** (so Plex/Jellyfin/Emby treat Tunarr as a real
  tuner), an **M3U/IPTV playlist** (Tivimate, UHF, xTeVe, Threadfin, Dispatcharr), or
  **directly in the browser**.
- **XMLTV EPG** generation for guide data in any client.
- Drag-and-drop lineup editing, slot-based scheduling tools, filler/commercial simulation,
  watermarks, per-channel transcoding with hardware acceleration (NVENC, VAAPI, QSV,
  VideoToolbox).
- Successor to dizqueTV (a migration path exists — `docs/getting-started/migration/`).

### 2. Architecture

Monorepo (`pnpm` + `turbo`): `server/` (Node, **Fastify**, SQLite via **Drizzle + Kysely**,
**Inversify** DI), `web/` (React + MUI + TanStack Router), `types/` (shared **Zod** schemas —
the API contract), `shared/`. Notable infrastructure choices:

- **Embedded Meilisearch** for library search/filtering (`services/MeilisearchService.ts`,
  `services/search/SearchParser.ts`) — Tunarr must index external media servers' content
  itself to offer "advanced search, filter, sort across all connected libraries".
- **Canonicalization layer** (`services/*Canonicalizer.ts` for Plex/Jellyfin/Emby/local):
  every external item is normalized into Tunarr's own `Program` tables with external-ID
  mappings (`db/schema/ProgramExternalId.ts`) — a large fraction of the codebase exists to
  mirror other systems' libraries.
- **Task system** (`server/src/tasks/`): scheduled jobs for library scans/refresh, XMLTV
  regeneration, collection/custom-show sync, session cleanup, backups, subtitle extraction,
  on-demand channel state, program-duration reconciliation.
- **Event service** for server → UI push, health checks, backup service
  (`docs/configure/system/backup.md`), structured logging, trash/soft-delete, troubleshooting
  and debug endpoints.

### 3. Domain model

From `server/src/db/schema/` (39 tables) — the ones that matter for us:

| Entity | Key fields / notes |
|---|---|
| **Channel** (`Channel.ts`) | uuid, **number** (unique), name, icon (custom/default/none), `groupTitle` (channel groups), `startTime`, `duration` (total lineup cycle length), `stealth` (hidden from HDHR/M3U/EPG), `streamMode` (hls default), per-channel `transcoding` overrides + `transcodeConfigId`, `watermark` JSON, `offline` settings, `guideFlexTitle`, `guideMinimumDuration`, `fillerRepeatCooldown`, `subtitlesEnabled`, `streamSelectionProfileId`, `disableFillerOverlay` |
| **Lineup** (JSON per channel, `db/derived_types/Lineup.ts`) | `items[]` (content / offline(flex) / redirect), **`startTimeOffsets[]`** (precomputed running durations for O(log n) "what's on now" lookup), `schedule` (the slot ruleset that generated it), `dynamicContentConfig`, `pendingPrograms`, `schedulingOperations`, `onDemandConfig` |
| **Program** + groupings | episodes/movies/tracks with `ProgramGrouping` (show/season/artist/album), media files/streams/chapters/subtitles, credits, genres, studios, tags, artwork |
| **CustomShow** (+content) | ordered playlists usable as pseudo-shows; optional external sync to Plex playlists (`CustomShowSyncService`) |
| **FillerShow** (+content) | filler lists (commercials/bumpers); `ChannelFillerShow` links with weight/cooldown |
| **SmartCollection** | saved searches, evaluated dynamically when queried |
| **ProgramPlayHistory** | what aired, used for cooldowns/repeat avoidance |
| **TranscodeConfig** / **StreamSelectionProfile** | named ffmpeg profiles; CEL-expression-based audio/subtitle track selection (see §8) |

### 4. Channel features (the configuration surface)

From `docs/configure/channels/*` and `db/schema/base.ts`:

- **Properties**: name, unique number, group title, icon (upload/URL; explicit "no icon"
  state removes it from M3U/XMLTV/watermark), stealth mode.
- **On-Demand mode** (`docs/configure/channels/properties.md`,
  `services/OnDemandChannelService.ts`): channel progress only advances **while someone is
  watching** — a cursor (`onDemandConfig: state/lastResumed/lastPaused/cursor`) pauses and
  resumes; default is broadcast behaviour (time marches on whether watched or not).
- **Offline/fallback settings** (`ChannelOfflineSettingsSchema`): picture or clip mode +
  optional soundtrack — what plays when there's flex time and no filler.
- **Watermarks** (`ChannelWatermarkSchema`): position (4 corners), width %, margins, opacity,
  fixed size, animated support, **fade config per program type** (period in minutes, leading
  edge on/off) and a **total watermark duration** cap per program
  (`docs/configure/channels/watermarks.md`).
- **Per-channel transcoding overrides** (resolution, bitrate, buffer) on top of named global
  transcode configs; **per-channel audio language & subtitle preferences** (README).

### 5. Scheduling — the heart of Tunarr

From `docs/configure/scheduling/*` and `types/src/api/{CommonSlots,TimeSlots,RandomSlots}.ts`,
`server/src/services/scheduling/*`.

#### 5.1 Concepts (`concepts.md`)
- **Lineup** = the channel's program sequence, **looped infinitely** from the channel's
  `startTime`. **Programming** = the actual media. **Flex** = unscheduled time filled at
  stream time. **Filler** = media used to fill flex. **Padding** = flex added so programs
  start at "nice" times. **Slot** = a grouping of programming with a set duration or start
  time.

#### 5.2 Two slot schedulers
1. **Time Slots** (`TimeSlotScheduleSchema`): programs assigned to wall-clock start times on a
   **daily or weekly period** (`period: day|week`, `timeZoneOffset`, `startTomorrow`).
   Options: global `padMs` (align to :00/:30 etc.), **per-slot pad override**, `latenessMs`
   (**max lateness** — how far a program may run past the next slot's start before being
   skipped), `flexPreference: distribute|end`, `maxDays` to precalculate.
2. **Slot Editor / Random Slots** (`RandomSlotScheduleSchema`): slots with **fixed duration**
   (e.g. 30 min) or **dynamic duration** (a count of programs, e.g. 3 episodes). Slot choice
   is **sequential** (defined order) or **random**, with **uniform or weighted**
   distribution (per-slot `weight`), plus per-slot **cooldown** (`cooldownMs`). Pad options:
   pad slot start vs pad each episode; flex placement between programs or at slot end.

#### 5.3 Slot content types (`CommonSlots.ts`)
Movie pool, **Show**, Custom Show (playlist), **Smart Collection** (saved search evaluated at
generation time), Filler, Flex, Redirect (to another channel). Shows support **season
include/exclude filters** (`random-slots.md` "Season Exclusion").

#### 5.4 Per-slot ordering
`order: next | shuffle | ordered_shuffle | alphanumeric | chronological` with
`direction: asc|desc`. "Next" walks episode order; each slot keeps its **own iterator cursor**
("slot isolation").

#### 5.5 Slot linking (`slot-linking.md`, `LinkableSlot`)
Slots can join an **iteration group** (shared UUID) to share one program iterator:
- **Continue** mode: the shared cursor advances on every play — spread one show across many
  slots, each episode airs once.
- **Rerun** mode: cursor advances only after *every* group member has played the current
  episode — simulates same-day reruns (`rerunOverflow: flex|continue`).
- Linked slots share content/order/filler config; keep independent duration, weight,
  cooldown, padding. Validation enforces consistent content and link mode per group.

#### 5.6 Filler & flex system (`library/filler.md`, `channels/flex.md`)
Filler lists attach to channels (simple flex-fill) or **per-slot with positional types**:
**Head** (slot start), **Pre** (before each program), **Post** (after each program), **Tail**
(slot end), **Mid** (mid-roll breaks), **Fallback** (during flex). Filler ordering策:
`shuffle_prefer_short | shuffle_prefer_long | uniform`; channel-level
`fillerRepeatCooldown` and play-history-based repeat avoidance (`FillerPickerV2.ts`).

#### 5.7 Mid-roll breaks (`mid-roll-breaks.md`, `MidRollConfigSchema`)
Commercial breaks *inside* programs: positioning rules (**fixed interval**, **percentage
points**, **initial delay + interval**), duration (fixed or random min–max range), limits
(max breaks, minimum program duration, **tail buffer** protecting the ending), program-type
filters, and **eager vs lazy strategy** — eager embeds specific filler at schedule time (guide
shows real titles); lazy inserts "Commercial Break" placeholders resolved at stream time with
fresh cooldown state (more variety).

#### 5.8 One-shot tools
**Block Shuffle** (N episodes per show, rotate; "perfect schedule loop" option to make all
shows end together), **Cyclic Shuffle** (block shuffle with count=1, random rotation
preserving episode order), **Replicate** (copy a schedule N times), **Consolidate** (merge
adjacent flex/redirect blocks), Balance (TBD in docs), plus **scheduling operations** persisted
on the lineup (`SchedulingOperationSchema`: random sort, release-date sort, add padding,
**scheduled redirect** — carve out a daily window that redirects to another channel).

#### 5.9 The critical limitation: schedules are static
`random-slots.md`: *"Currently, Tunarr can only statically precalculate a schedule"*
(`maxDays` / "Days to Precalculate"). The generated lineup is a frozen array; it loops.
**Dynamic content** exists only as a narrow feature (`DynamicContentConfigSchema`): a **cron
updater** re-runs a **Plex search** and stages results as `pendingPrograms` to be merged on
the next schedule update. There is **no watch-state awareness** — Tunarr cannot schedule "the
next unwatched episode" because (a) schedules freeze days in advance and (b) watch state lives
in Plex/Jellyfin per user, outside Tunarr's loop. Slot iterators (`ProgramIterator.ts`)
advance by *airing*, not by *watching*. This is exactly the gap Archivist can close (§12).

### 6. Guide / EPG

`services/TvGuideService.ts`, `services/XmlTvWriter.ts`, `docs/configure/channels/epg.md`:
- **XMLTV** output at `/api/xmltv.xml`, refreshed by a scheduled task (`UpdateXmlTvTask`);
  includes title, episode title, description, air date, content rating, credits, and
  **genres** as `<category>` tags.
- Guide API (`guideApi.ts`) serves the web UI's guide grid (`web/src/routes/guide.tsx`) for
  any time range, computed from lineup + `startTimeOffsets` (binary search —
  `util/binarySearch.ts`).
- Channel-level guide knobs: `guideFlexTitle` (what flex blocks are called in the guide),
  `guideMinimumDuration` (merge tiny items so the guide stays readable), stealth channels
  excluded.

### 7. Outputs & clients

- **HDHomeRun emulation** (`services/HDHRService.ts`): SSDP/UPnP announcement
  (`device.xml`, `lineup.json`) so Plex/Jellyfin/Emby add Tunarr as a network tuner.
- **M3U playlist** (`services/M3UService.ts`): `#EXTINF` per channel with tvg-id, channel
  number, logo, group-title; cached and invalidated on channel changes.
- **Browser watch page** (`web/src/pages/watch/ChannelWatchPage.tsx`) — direct in-app viewing.
- **Stream endpoints** (`api/videoApi.ts`, `api/streamApi.ts`): per-channel `.ts`/`.m3u8`
  URLs; session-based.

### 8. Streaming pipeline

`docs/configure/channels/transcoding.md`, `server/src/stream/*`:

- **Stream modes** per channel: **HLS** (default; one ffmpeg per program, playlists
  interleaved — `stream/hls/HlsSession.ts`), **HLS alt** (two-process: per-program rawvideo →
  concat encoder), **HLS Direct** (no normalization; single-item playlist remuxed),
  **HLS Direct v2** (segmented remux, no transcode), **MPEG-TS** (dizqueTV-style concat).
- **StreamProgramCalculator** (`stream/StreamProgramCalculator.ts`): given a channel and a
  timestamp, binary-searches `startTimeOffsets` to find the current item and elapsed offset —
  the core of "tune in mid-program".
- **SessionManager / ConnectionTracker**: shared sessions per channel (all viewers of a
  channel share one transcode), cleanup task when viewers leave.
- **Transcode configs**: named profiles (resolution, bitrate, codecs, HW accel) assignable
  per channel; **stream selection profiles** use **CEL expressions**
  (`services/CelEvaluationService.ts`) over a context of audio/subtitle streams, channel and
  program metadata to pick tracks (e.g. "prefer jpn audio for anime channels");
  per-channel subtitle burn-in (`subtitlesEnabled`) with an extraction task
  (`SubtitleExtractorTask`), external subtitle download support.
- **Watch-state write-back**: none to external servers; Tunarr keeps its own
  `ProgramPlayHistory` for cooldowns.

### 9. Media sources & library

- Sources: **Plex, Jellyfin, Emby** (API-scanned) and **local folders**
  (`docs/configure/media_sources/local/*` — movies, shows, music, music videos, other videos;
  NFO metadata parsing in `server/src/nfo/`).
- Library UI: search across sources with filter grammar, **Smart Collections** (saved
  searches), **Custom Shows** (playlists, Plex-syncable), **Filler lists**, **Trash**.
- Scheduled **library refresh** with configurable rescan interval; media added to channels is
  snapshot-copied into Tunarr's DB and reconciled by tasks (duration reconciliation, dangling
  program cleanup).

### 10. System & operational features

Backups (scheduled, configurable), structured logging with roll tasks, system status page,
task runner UI (`web/src/routes/system/*`), troubleshooting bundle, feature flags
(`FeatureFlagService`), welcome/onboarding wizard (`routes/welcome.tsx`), theming
(`types/src/Theme.ts`), i18n (`web/src/locales`), dizqueTV migration, Docker/binaries/Unraid/
Proxmox packaging.

### 11. Web UI surface (for parity checklist)

Routes (`web/src/routes/`): Channels list → channel editor (Properties / Programming with
drag-drop + Tools menu / Flex / EPG / Transcoding / Watermark tabs) → slot editors; **Guide**
grid; **Watch** page; Library (custom shows, fillers, trash); Search; Media sources; Settings
(general, ffmpeg, transcode configs, HDHR, XMLTV, scanner, sources, features); System
(status, logs, tasks, debug, troubleshoot).

---

## Part II — Integration design for Archivist

### 12. Positioning: native module, not a sidecar

Tunarr spends most of its code compensating for being *outside* the media system: scanners,
canonicalizers, external-ID mapping, its own search index, its own play history, cron-based
"dynamic content" that re-runs Plex searches. **Archivist Channels should be a first-class
module inside the Archivist server**, because:

| Tunarr needs | Archivist already has |
|---|---|
| Scan Plex/Jellyfin/Emby into its own Program tables | Films/series/episodes with files, durations, streams **already in the unified DB** |
| Meilisearch to search mirrored content | Library search endpoints |
| Cron re-query for "dynamic" content | Live queries at schedule-resolution time |
| Its own artwork cache | Existing artwork/image services |
| Its own play history only | **Real watch state** (once Player sync lands) + play history |
| ffmpeg re-streaming for all clients | Player direct-plays library files natively |

**Placement.** A `channels` domain service in the Archivist server (alongside films/series),
its tables in the unified SQLite DB, surfaced as a **"Channels" tab in the Archivist web UI —
visible only when at least one films or series library exists** (per requirement), and exposed
read-only through the **`/api/v1/player` contract** for the Player app.

### 13. Domain model for Archivist Channels

Adopt Tunarr's shapes, simplified because programs are native library rows:

- **channel**: id, number (unique), name, icon, group, enabled/stealth,
  mode (`broadcast | on_demand`), offline behaviour, guide options (flex title, minimum
  guide duration), created/updated.
- **channel_schedule**: the *ruleset* (time-slot or sequence/random-slot definition,
  period day/week, pad, lateness, flex preference, timezone) — stored as the **source of
  truth**, not a frozen lineup (see §14).
- **slot**: type (`series_dynamic | series_static | film_pool | playlist | saved_filter |
  flex | redirect`), start time or duration/count, ordering, direction, weight, cooldown,
  link group + link mode, season include/exclude, filler bindings, **priority list** (§15).
- **channel_lineup_cache**: materialized guide window (rolling ~48–72 h) with
  `startTimeOffsets`-style index — a *cache*, rebuildable at any time, never the truth.
- **filler_list** (+items): items reference library rows (any video item; e.g. a dedicated
  "Interstitials" library/folder) — plus **generated interstitials** (§17).
- **channel_play_history**: what aired when (cooldowns, "aired" cursors, analytics).
- Reuse existing: media items, watch state (server-side, §16), saved filters (the smart-
  collection equivalent proposed in `../../03-products/player/feature-reference.md` §5 — one feature serves both).

### 14. The key architectural change: resolve lazily, not statically

Tunarr precalculates N days and freezes them. Archivist should **keep the ruleset as truth
and materialize the lineup just-in-time** for a rolling window:

- The guide/lineup for the next ~48–72 h is computed on demand (and cached) from the slot
  rules; anything beyond the window is computed when asked.
- Slot iterators (cursor per slot / link group) are persisted, but **content queries run at
  materialization time** — so "next unwatched", "latest additions", or a saved filter are
  always current.
- Re-materialization triggers: watch-state change affecting a dynamic slot, library import
  (new episode), channel edit, and a periodic safety refresh. Only the affected window is
  rebuilt; what already aired is immutable history.
- **Determinism rule**: the *currently airing* and *imminently airing* (e.g. next 15 min)
  items are pinned once materialized, so the stream never changes underneath a viewer, and
  guide data close to "now" is stable.

This preserves every Tunarr concept (slots, linking, padding, lateness, flex) while unlocking
dynamic behaviour Tunarr's static model forbids.

### 15. Dynamic series slots — the flagship use case

The requested scenario: *a channel that shows the latest unwatched episode of a sequence of
series on a particular night — Sopranos, then Breaking Bad, then The Wire — with multiple
shows per slot on priorities.*

**Slot type: `series_dynamic`.** Configuration:

- **Selection policy** (per slot):
  - `next_unwatched` — earliest unwatched episode in order (the "continue the show" policy;
    this is the natural reading of "latest unwatched" for serial dramas);
  - `latest_unwatched` — most recent unwatched (for topical/episodic shows);
  - `random_unwatched`, `random_any`, `rerun_watched` (only watched episodes — a true rerun
    channel), `next_aired` (episode order regardless of watch state — Tunarr-equivalent).
- **Priority stack** (the "multiple shows per slot" requirement): an *ordered list* of
  candidate sources with a per-entry policy and an exhaustion rule:

  ```
  Slot 20:00 Sunday  —  "Prestige Hour 1"
    1. The Sopranos      next_unwatched
    2. Mad Men           next_unwatched     (if Sopranos fully watched/unavailable)
    3. Saved filter: "Unwatched HBO dramas"  random_unwatched
  Slot 21:00 Sunday  —  "Prestige Hour 2"   → Breaking Bad → Better Call Saul → …
  Slot 22:00 Sunday  —  "Prestige Hour 3"   → The Wire → …
  ```

  Resolution walks the stack top-down at materialization time; the first source that yields
  an episode wins. Optionally **weighted mode** instead of strict priority (Tunarr's
  uniform/weighted random slot choice, applied *within* a slot's candidates).
- **Exhaustion behaviour** per slot: fall through to next priority / flex / restart series /
  hide slot.
- **Availability filter**: only episodes with a playable file qualify (monitored-but-not-
  downloaded episodes are skipped — or, as a later option, trigger an Archivist grab, which
  is an integration Tunarr could never do).
- **Watch-state edge**: if the viewer watches Sunday's episode on Tuesday via the Player,
  next Sunday's materialization picks the *following* episode automatically. If they didn't
  watch it, policy decides: re-air the same episode (`next_unwatched` naturally re-selects
  it) — which is precisely the requested behaviour.
- **Slot linking carries over**: link the Sunday slot with a Wednesday rerun slot in *rerun*
  mode (same episode twice a week), or *continue* mode (two fresh episodes a week) — Tunarr's
  iteration-group semantics (§5.5) applied to dynamic selection.
- **Fallback when watch state is absent** (see §16): the slot degrades to an "aired cursor" —
  identical to Tunarr's `next` ordering — so the feature ships before watch-state sync does.

Everything else from Tunarr's scheduler ports unchanged: pad-to-:00/:30, max lateness,
flex distribute/end, per-slot filler (head/pre/post/tail/fallback/mid), mid-roll rules,
cooldowns, block/cyclic shuffle presets, replicate/consolidate, scheduled redirects.

### 16. Watch state: the one prerequisite

Today Archivist Player stores watch progress **locally in the browser** (Player README:
"Archivist-hosted sync is a later phase"). Dynamic slots need watch state **server-side**:

1. **Phase A (no dependency)**: ship channels with static/aired-cursor policies (full Tunarr
   parity) + priority stacks. Dynamic policies appear but resolve from channel play history
   ("aired" ≈ "watched" — classic TV assumption; Tunarr's exact behaviour).
2. **Phase B**: implement the already-planned watch-state sync in the player contract
   (progress reports from Player → server). Dynamic policies switch to true watch state.
   Channel viewing itself reports progress, so **watching the channel advances the series'
   watch state**, which feeds the next materialization — the loop closes.
3. Multi-profile: when Player profiles land, channels can be global (shared watch state à la
   family TV) or per-profile (personal channels) — a policy flag per channel.

### 17. Streaming: two tiers

**Tier 1 — virtual tuning (ship first; zero transcoding).** The Player is Archivist's own
client and direct-plays library files. A channel doesn't need a continuous video stream — it
needs an answer to *"what's on channel N right now, and how far in?"*:

- Player contract additions: `GET channels` (list + icons + now/next), `GET channels/:id/guide?from&to`,
  `GET channels/:id/now` → `{ item, startOffsetMs, endsAt, next }` (the
  `StreamProgramCalculator` equivalent — binary search over the materialized window's
  offsets).
- The Player "tunes" by fetching `now`, direct-playing the file seeking to `startOffsetMs`,
  and at program end fetching `now` again (or using the prefetched `next`). Program
  transitions are client-side — acceptable and even desirable in a controlled client (we can
  render branded transitions).
- **Flex/filler in Tier 1**: filler items direct-play like anything else; empty flex renders
  as a branded channel card with countdown ("Up next at 8:30 — The Wire") — arguably *better*
  than Tunarr's offline soundtrack screen, and free.
- Seeking/pausing: in broadcast mode, pause then resume re-syncs to live (like real TV);
  in **on-demand mode** (Tunarr §4 feature, port it) the channel cursor pauses with the
  viewer — trivial since the Player reports sessions.

**Tier 2 — real streams for external clients (later, optional).** For the Tunarr parity
outputs — **M3U + XMLTV** (any IPTV app) and **HDHomeRun emulation** (Plex/Jellyfin as
clients) — an ffmpeg HLS/MPEG-TS pipeline is required (Archivist's Docker image already
bundles ffmpeg). Start with the two highest-value modes: HLS (per-program transcode) and HLS
Direct v2 (remux-only for homogeneous libraries). Watermarks, subtitle burn-in, and stream
selection profiles (CEL-style rules) belong to this tier only — in Tier 1 the Player handles
tracks natively per its own preferences.

### 18. Guide & Player exposure

- **Archivist web UI ("Channels" tab, gated on films/series libraries)**: channel list
  (number, name, icon, group, enabled, now-playing), channel editor (Properties / Programming
  + scheduling tools / Filler / Guide options), guide preview, and a "watch now" preview
  (Tier 1 tuning works in the admin UI too).
- **Player app**: a **Live TV / Channels section** (fits the Arctic Fuse hub model from
  `../../03-products/player/feature-reference.md` §2 — a dedicated hub/page): channel rail with now/next cards,
  a **guide grid** (time × channel, the `tunarr-guide` view), channel zapping (up/down),
  and an info overlay showing current program metadata from the same library records the
  rest of the Player uses — artwork, plot, chips come for free.
- **EPG data**: guide endpoints in the player contract (Tier 1); XMLTV file output only with
  Tier 2 for external consumers.

### 19. Feature mapping summary

| Tunarr feature | Archivist Channels plan |
|---|---|
| Channels (number, name, icon, group, stealth) | Port as-is (§13) |
| On-demand channels | Port; easier with Player session reporting (§17) |
| Offline/fallback picture+soundtrack | Branded flex card in Player (Tier 1); ffmpeg screen (Tier 2) |
| Watermarks, subtitle burn-in, transcode profiles, CEL track selection | Tier 2 only (external clients) |
| Time slots (day/week, pad, lateness, per-slot pad) | Port as-is |
| Slot editor (fixed/dynamic length, sequential/random, uniform/weighted, cooldown) | Port as-is |
| Slot content: movie pool / show / custom show / smart collection / filler / flex / redirect | Port; playlists + **saved filters** (shared with Player rails); add **`series_dynamic`** (§15) |
| Slot ordering (next/shuffle/ordered_shuffle/alphanumeric/chronological, asc/desc) | Port; superseded for series by selection policies |
| Season include/exclude | Port as-is |
| Slot linking (continue/rerun, iteration groups, validation) | Port; extended to dynamic slots |
| Filler types (head/pre/post/tail/mid/fallback), filler ordering, cooldowns | Port as-is |
| Mid-roll breaks (interval/percentage/delay rules, duration ranges, tail buffer, eager/lazy) | Port; lazy is the natural default in a lazy-materialization engine |
| Block/cyclic shuffle, replicate, consolidate, scheduled redirect, sort operations | Port as lineup tools |
| Static precalculation + pendingPrograms + cron Plex-search updater | **Replaced** by lazy materialization over live queries (§14) |
| TV guide (web grid) + XMLTV with genres/credits/ratings | Guide API + Player guide grid (Tier 1); XMLTV (Tier 2) |
| HDHR spoof, M3U output | Tier 2 |
| Browser watch page | Player + admin preview via virtual tuning (Tier 1) |
| HLS/HLS-alt/Direct/v2/MPEG-TS session pipeline, shared sessions | Tier 2, HLS + Direct v2 first |
| Media source scanners/canonicalizers/Meilisearch/custom show Plex sync/NFO | **Not needed** — native library |
| Play history | Port (cooldowns + aired-cursors + analytics) |
| Backups, tasks, logging, health, trash | Use Archivist's existing job/event infrastructure |
| dizqueTV migration, Unraid/Proxmox packaging | N/A |

### 20. Edge cases to design for (learned from Tunarr's code)

- **Deleted/missing media**: Tunarr materializes slots with `missingShow` / `isMissing`
  markers (`TimeSlots.ts` Materialized* schemas) and reconciliation tasks — Archivist
  should validate slots against the library on materialization and surface "missing content"
  warnings in the channel editor rather than airing dead slots.
- **Duration drift**: Tunarr has a `ReconcileProgramDurationsTask` because durations change
  after re-analysis; Archivist owns the files, but re-imports/upgrades change durations —
  re-materialize affected windows on file replacement (quality upgrades are an Archivist
  routine event).
- **Guide readability**: port `guideMinimumDuration` (merge sub-minimum items in guide
  display) and `guideFlexTitle`.
- **Channel edits during viewing**: pin the live window (§14); Tunarr's on-demand code
  comments flag this exact race (`OnDemandChannelService.ts` TODO).
- **Cooldown correctness across restarts**: persist play history and slot cursors (Tunarr
  does; keep it).
- **Timezones/DST**: time slots carry a timezone offset (`timeZoneOffset`) — store zone
  names, not offsets, to survive DST.

### 21. Suggested phasing

1. **MVP (Tier 1)** — channel CRUD + numbers/icons/groups; time-slot & sequence schedulers
   with pad/lateness/flex; slot types: series (aired-cursor policies), film pool, saved
   filter, flex, redirect; lazy materialization + guide cache; player-contract endpoints
   (list/guide/now); Player channels rail + guide grid + virtual tuning; Channels tab gated
   on films/series libraries.
2. **Dynamic slots** — priority stacks, exhaustion rules, availability filtering; watch-state
   sync in the player contract; `next_unwatched`/`latest_unwatched`/`rerun_watched` policies;
   channel viewing writes watch state back.
3. **TV texture** — filler lists + head/pre/post/tail/fallback, cooldowns; branded flex
   cards; slot linking (continue/rerun); block/cyclic shuffle presets; on-demand channels;
   mid-roll breaks (lazy).
4. **External reach (Tier 2)** — ffmpeg HLS + Direct v2 sessions, M3U + XMLTV, HDHR
   emulation, watermarks, transcode profiles, track-selection rules.

---

## Part III — Demand analysis & clean-slate design notes

This part answers two questions: *what are Tunarr users actually asking for that they don't
have*, and *what would a from-scratch design add that studying Tunarr alone wouldn't surface*.
The demand data comes from Tunarr's open GitHub issue tracker (fetched 2026-07-09, ~340 open
issues; reaction counts cited per issue).

### 22. What users are asking for (and don't have)

**The #1 open feature request, by a wide margin, validates this document's core thesis:**

> **#15 — "Infinite schedules + dynamically updating channels" (+20 👍, the most-upvoted open
> issue in the tracker).** Users want channels defined by a *live query* (a collection, a
> search, "sync this show") that automatically absorbs new content and recalculates. This is
> precisely the static-precalculation limitation (§5.9) and precisely what lazy
> materialization (§14) solves. Related: #1195 ("Allow channels to be *defined by* filters" —
> the user maintains a Sci-Fi channel from a genre filter and is frustrated that new library
> content doesn't flow in), #1750 (+2, "Use Smart Collections as Filler"), #1670 (append
> extra filter criteria per slot), #1896 ("add ability to filter by **watched/unwatched**" —
> watch-state awareness, requested directly).

The rest of the demand clusters, with the highest-signal issues:

| Theme | Issues | What they want | Archivist plan |
|---|---|---|---|
| **Calendar-aware scheduling** | #1848 (+1), #1785, #1552 | Seasonal schedules (Christmas movies in December, horror at Halloween, Star Wars on May 4th), a "schedule of schedules" decoupled from channels, day-specific overrides (Friday-night movie replaces normal slots) | Add a **calendar layer** (§23.3) — date-rule → schedule variant. Natural in a lazy engine; near-impossible in a frozen lineup |
| **Auto-generated channels** | #850 (+3) | Auto-create channels from metadata — e.g. one channel per original **TV network** (recreate a cable package); user calls manual channel-building "cumbersome and tedious", notes PseudoTV/ErsatzTV suffer the same | **Channel templates + auto-channels** from library facets (genre/network/studio/decade/collection) (§23.4) |
| **Instant tuning / zap speed** | #1610 (+4) | Pre-cached "fast start" segments so switching channels isn't slow | Tier-1 virtual tuning makes zap ≈ a seek; prefetch `now` for all visible channels in the guide |
| **Live/remote sources in channels** | #1574 (+9) | Mix real remote streams (news, weather, IPTV) into channel lineups | Out of scope for MVP; note as a future slot type (`external_stream`) — Tier 2 only |
| **Auth & multi-user** | #1032 (+5), #574 | Tunarr has **no authentication**; Plex user switching | Free — channels inherit Archivist auth/API keys; per-profile channels (§16) |
| **Audio/subtitle control** | #1230 (+4), #1219, #1547 | Finer per-channel track selection, subtitle styling, ASS fonts | Tier 1: Player handles tracks natively; Tier 2 ports CEL profiles |
| **Cross-show event ordering** | #650 | Air crossover events in broadcast order across different series (Arrowverse: Supergirl → Batwoman → Flash → Arrow → Legends) | Add **air-date interleaved ordering** across a slot's series set (§23.5) — trivial with native air-date data |
| **Time-shift channels** | #1886 (+1) | ITV+1-style: same channel delayed one hour | A **redirect-with-offset** channel — cheap in a lazy engine (materialize source at t−offset) |
| **EPG quality & control** | #1294 (+1), #1741, #1672, #1119 | Custom EPG text formatting, granular guide generation, slot-as-single-EPG-entry ("Sitcom Block"), show flex as a program | Port `guideFlexTitle`/`guideMinimumDuration` + add per-slot guide labels (block billing) |
| **Channel portability** | #1265 (+2), #1791 (+1), #180 (+3) | Import/export channel lineups, webhooks on M3U/XMLTV change, drag-drop channel ordering | Channel definitions as exportable JSON → **shareable community presets** (§23.6) |
| **Presentation flair** | #1781 (+3), #1766, #1947, #1292 | Filename/metadata as watermark, dynamic text rendered on stream (ErsatzTV parity), artist/title overlay for music videos, custom error screens | Tier 1 renders overlays in the Player for free (DOM, not ffmpeg) — a structural win |
| **Scheduling niceties** | #1629, #1025, #1777, #1743, #1900, #1936, #1939 | Per-slot lateness override, greedy shuffle, one-season-per-show collections, cyclic shuffle from series start, **chapter-marker mid-rolls**, folder-order slots, flex filled by non-filler content | Small additions to the ported scheduler; chapter-aware mid-rolls are easy (chapters are in Archivist's DB) |
| **Other media channels** | #1281, #1232, #1857 | Photo channels, audio-only channels, music metadata/lyrics overlays | Aligns with Archivist's music domain — later phase |
| **Ops** | #1944, #1940, #810 | Bundled ffmpeg, background trash, log hygiene | Already Archivist's model |

Two conclusions from the tracker as a whole. First, the community's biggest pains are
*architectural* (dynamic content, auth, zap latency, calendar logic) — things bolted-on fixes
can't reach, and things the native-module design gets structurally. Second, a large minority
of issues are **integration friction with Plex/Jellyfin/Emby** (sync bugs, path replacements,
library-type changes, plaintext credentials) — an entire failure class that doesn't exist when
the channel engine and the library are the same system.

### 23. Clean-slate additions (what Tunarr wouldn't teach you)

If designing from scratch, these principles and features go beyond the Part II port:

1. **The schedule is a pure function.** `lineup = f(ruleset, libraryState, watchState,
   calendar, seed, t)`. Use a **persisted per-channel random seed** and versioned rulesets so
   materialization is *deterministic and replayable*: the same inputs always produce the same
   lineup. This gives (a) reproducible bugs, (b) an auditable "why did this air?" answer,
   (c) safe re-materialization — regenerating an un-aired window with unchanged inputs is a
   no-op. Tunarr's mutable frozen-array-plus-tools model can't offer this.
2. **Four cleanly separated components.** *Scheduler* (pure function above) → *Materializer*
   (rolling window cache + pinning) → *Tuner* (now/next/offset API) → *Presenter* (the
   Player renders transitions, overlays, branding in the DOM). Video processing appears
   nowhere until Tier 2, and when it does it's a fifth, optional component — not the
   foundation. Tunarr is built the other way up (the ffmpeg pipeline is the core, and five
   stream modes exist because it's hard).
3. **A calendar layer, first-class.** Date rules (month, season, weekday, specific dates,
   holidays) select between named schedule variants per channel: `December → "Christmas
   variant"`, `Fridays 19:00–22:00 → "Movie Night override"`, `May 4 → "Star Wars marathon"`.
   This directly answers the #1848/#1785/#1552 cluster and makes "special programming" a
   feature instead of a manual chore.
4. **Auto-channels and templates.** One-click channels generated from library facets — by
   network (#850), genre, decade, studio, collection/franchise — that stay current because
   they're saved filters underneath. Ship starter templates: *Marathon channel* (one series,
   next_unwatched), *Network night* (the §15 priority-stack pattern), *Decade movies*,
   *Kids' Saturday morning* (time-boxed + calendar rule), *Rerun channel* (rerun_watched).
5. **Air-date interleaved ordering.** An ordering policy that merges several series into one
   broadcast-historical sequence by original air date — crossovers air correctly (#650), and
   "the 1994 NBC Thursday" becomes reconstructable. Archivist has air dates natively.
6. **Channels as shareable documents.** The ruleset (not the materialized lineup) is a small
   JSON document with no local IDs beyond resolvable references (titles/TMDb IDs). Export,
   import, and eventually a community preset gallery (#1265) — the same pattern as sharing
   saved filters.
7. **Guide-first product thinking.** The EPG grid *is* the product surface; the stream is
   just "play this item at this offset". Design the guide data model (block billing, flex
   labels, per-slot guide titles like "Prime-Time Movie") before the playback path — the
   Tunarr tracker shows guide-polish requests keep coming (#1294, #1672, #1119, #1741)
   because the guide is what users actually look at.
8. **Watch-state as a two-way contract from day one.** Playing a channel writes progress;
   progress drives selection (§15–16). Design the player-contract events for this in the MVP
   even if Phase A ignores them — retrofitting bidirectional state is harder than ignoring an
   unused field.

### 24. Exhaustiveness statement

Part I is feature-complete at the *concept and configuration-surface* level: every documented
feature (all 51 docs pages), every slot/scheduling schema in `types/src/api`, the full DB
schema list, all stream modes, outputs, and background tasks are covered. It deliberately
does **not** exhaustively describe: the ffmpeg command-builder internals
(`server/src/ffmpeg/builder/`), per-client setup guides (`docs/configure/clients/*`), NFO
parsing rules, HLS session state machines and heartbeat mechanics, or settings-page minutiae —
these are implementation details of paths Archivist won't reuse (Tier 2 excepted, to be
studied if/when built). Part III adds the demand-side evidence that Parts I–II were missing.

---

## Part IV — The product brief: Scheduled VOD Guide ("Watch from here")

This part incorporates the *Personal TV Network / Scheduled VOD Guide* brief and reconciles
it with Parts I–III. The brief's framing is adopted as the **product definition**; Parts I–II
remain the **capability ceiling** (what the engine grows into).

### 25. The reframe: guide-first, playback-on-demand

The brief's core statement, adopted verbatim as the product promise:

> *This is **not** primarily an IPTV creator. The core product is a **TV guide where every
> scheduled item is playable on demand**, and playback continues through the rest of the
> slate like a real channel. … Programme your own TV network, then watch any slot from the
> guide as if the channel starts from there.*

This changes the MVP's centre of gravity. Parts I–II led with *live tuning* ("what's on
now"); the brief makes tuning just one of **three playback modes**, and makes the primary
interaction *clicking any card in the guide*:

| Mode | Behaviour | Notes |
|---|---|---|
| **WATCH_FROM_HERE** (default; button label "Watch from here") | Play the selected item from the beginning, then auto-advance through every following slot on that channel until the slate ends | The signature behaviour: click `RoboCop` in Friday Night Classics → RoboCop → Escape from New York → next → … |
| **PLAY_THIS_ONLY** | Play the selected item, stop | Plain VOD escape hatch |
| **JOIN_LIVE** | If the item is currently airing, compute offset from scheduled start and join in progress, then continue the slate | This is §17's "virtual tuning", demoted from *the* model to *a* mode |

The target feeling, kept as a design test: *the user should feel like the CEO / programming
director of their own TV network.* Every feature below either builds the network (authoring)
or delivers the broadcast illusion (consumption).

Implication for the engine: the lazy-materialization design (§14) is unchanged, but the
**pinning rule relaxes** — only the JOIN_LIVE path and near-now guide stability need pinned
materialization; WATCH_FROM_HERE sessions snapshot their queue at session-creation time, so
mid-session re-materialization never disturbs an active viewer.

### 26. The authoring hierarchy: Channel → Block → Slot

The brief introduces **programming blocks** — a missing middle layer that Parts I–II lacked
(Tunarr goes straight from channel to slots). Adopted hierarchy:

- **Channel** — a branded lane: name, description, **brand colour**, logo, active flag,
  default scheduling rules. (Brief's examples set the tone: *NathFlicks One, NathFlicks
  Classics, After Dark, Saturday Morning Cartoons, Sunday Premiere, Christmas Channel*.)
- **Programming block** — a *recurring themed window*: channel, name, day(s) of week,
  start–end time, recurrence, **rules**, **priority** (resolves overlapping blocks — and
  note this is the same priority concept as §15's stacks, one level up). Examples:
  `Saturday Morning Cartoons — every Saturday 07:00–11:00`,
  `Friday Night Classics — every Friday 20:00–00:00`,
  `Late Night Horror — Fri/Sat 23:00–02:00`.
- **Slot** — one scheduled item materialized inside a block: item ref, start/end, sequence
  number, slot type (programme vs interstitial), **status** (`scheduled | airing | watched`),
  **locked** flag.

Blocks come in two flavours, unifying the brief with Part II:
1. **Rule-filled blocks** (the brief's model): a rules object filters candidates —
   `content_types`, `genres_any`, `max_runtime_minutes`, `prefer_unwatched`,
   `exclude_aired_within_days`, `allow_repeats` — and the scoring scheduler (§27) fills the
   window. These rules are the saved-filter concept (§13) plus block-local constraints.
- 2. **Sequence blocks** (Part II's model): explicit slot definitions — including §15's
   `series_dynamic` priority stacks ("Prestige Drama Night" is a sequence block of three
   dynamic slots) and Tunarr-style ordering/linking. The calendar layer (§23.3) selects
   between block sets by date (Christmas Channel = channel whose blocks carry December date
   rules).

### 27. The scoring scheduler (adopt as the block-fill engine)

The brief prescribes a deliberately simple **additive scoring** pass instead of Tunarr's
iterator machinery — adopted as the fill algorithm for rule-filled blocks:

```
+50 content type matches      -40 aired recently
+30 genre matches             -30 runtime exceeds available slot
+20 unwatched                 -20 same title/franchise aired recently
+15 recently added
+10 fits remaining block time cleanly
```

Loop: read active blocks → find matching items → score → place highest → repeat until the
window is filled or no candidate scores acceptably. `last_aired_at` per item and per-channel
play history (§13) feed the repeat penalties. Reconciliation with Part III: scoring ties are
broken by the channel's **persisted seed** (§23.1), so generation stays deterministic and
replayable; and dynamic-policy slots (§15) bypass scoring entirely — policies for serials,
scoring for themed pools. The two compose: a priority-stack entry may itself be a rule query
scored at resolution time.

### 28. Manual slate editing with locks

The generated slate is a *draft the programming director edits*. Required actions (brief):
**move item, replace item, remove item, lock item, regenerate unlocked items**. A locked slot
is a pinned input to the materializer — regeneration flows around it. This is the missing
answer to "I mostly want automation but Friday's 21:00 film is *my* pick." Guide cards carry
status (`scheduled / airing / watched`) so the editor doubles as a review surface.

### 29. Interstitials — network packaging as first-class content

The brief elevates what Tunarr calls "filler" into a **typed packaging system**:
`ident | bumper | trailer | advert | short` (media-item types alongside movie/episode).
Adopted:

- In Archivist these are library items tagged with a packaging type (a dedicated
  "Packaging"/interstitials library or folder; type stored per item).
- **MVP: manual placement** — insert an ident before a block, a trailer reel between films
  (exactly the brief's `Friday Night Classics` example: ident 20:00 → Terminator → trailer
  reel → RoboCop → …). **Later: automated packaging rules** per block/channel (this is where
  Tunarr's head/pre/post/tail/mid/fallback grammar (§5.6) returns as the rule vocabulary).
- Clean-slate bonus (new): a **self-promoting trailer reel** — auto-assemble trailer slots
  from the trailers of items *scheduled later in the week on this network* ("Coming up on
  NathFlicks One…"). Trivial with Archivist's trailer metadata; impossible to feel this
  integrated from outside the library.
- The brief's future list (fake adverts, host intros, AI-generated bumpers) slots in here
  without schema change — they're just more packaging items.

### 30. Playback sessions — the consumption contract

Adopted from the brief, replacing the bare `now/next` endpoints of §17 with a session model:

- `POST /api/v1/player/play-sessions` with `{ channelId, startSlotId, mode }` → a session
  containing the ordered queue: for each item `queuePosition`, `scheduleSlotId`, item ref,
  `startOffsetSeconds` (0 except JOIN_LIVE's first item), `runtimeSeconds`.
- Player requirements (brief, all adopted): start item → track progress → **auto-advance on
  completion** → "Up next" display → skip-to-next → stop session → **persist session state
  and resume interrupted sessions**.
- Sessions are persisted server-side (`play_sessions`, `play_session_items`), which gives
  three things for free: resume-across-devices, the §16 watch-state write-back (completing a
  queue item marks the underlying episode/film watched **and** stamps the slot `watched` and
  the item's `last_aired_at`), and the on-demand channel mode (§4/§17) — an on-demand channel
  is just a channel whose "live" position is its most recent session cursor.

### 31. Data model (brief schema, mapped to Archivist)

The brief's tables map almost 1:1 onto §13, with renames and two deletions:

| Brief table | Archivist disposition |
|---|---|
| `media_items` (synced from Jellyfin) | **Deleted** — Archivist's library *is* the source; add per-item `packaging_type` and `last_aired_at` only |
| `users` | Existing Archivist auth; Player profiles later (§16) |
| `channels` | §13 `channel` + brief's `brand_color`, `description`, `is_active` |
| `programming_blocks` | **New** (§26) — day_of_week, start/end, recurrence, rules JSON, priority |
| `schedule_slots` | §13 `channel_lineup_cache`, upgraded to a real table: block_id, media ref, starts/ends, sequence, slot_type, status, **locked** |
| `play_sessions` / `play_session_items` | **New** (§30) — mode, status, started_from_slot, queue with offsets and completion timestamps |

The brief's "Library Sync Service" and Jellyfin client layer are the components §12 already
deleted; its stack prescription (Next.js/Postgres/Prisma) applies to the standalone build the
brief assumed — inside Archivist we use the existing Express + better-sqlite3 server and the
React/Vite Player, per §12. Retained from its dev rules regardless of stack: **seed data so
the guide/player UI is testable without a full library**, tests for the scheduler and the
session builder, incremental commits, README coverage.

### 32. Surfaces (brief pages → Archivist placement)

| Brief page | Where it lives |
|---|---|
| `/channels`, `/blocks`, slate editor, `/settings` | **Archivist web UI — the "Channels" tab** (authoring; gated on films/series libraries per §12) |
| `/guide` (week/day view, channel rows, time grid, clickable cards, now/next indicator, channel & block filters) | **Both**: authoring-flavoured in Archivist (edit/lock/regenerate), consumption-flavoured in Player (watch from here / join live / play only) |
| `/player/:sessionId` (now playing, up next, queue, skip, stop, return to guide) | **Player app** — extends the existing video player with queue UI |
| `/dashboard` (active channels, on now, on next, upcoming premieres, recent slates) | Player home rail ("On now across your network") + Channels-tab landing |
| `/library` (incl. packaging-type filters) | Existing Archivist library UI + packaging-type filter |

Guide card contents per the brief: title, poster thumbnail, start/end, runtime, programme
type, block name, status.

### 33. MVP acceptance criteria (adapted)

The brief's Given/When/Then set, with the sync criterion replaced (no sync layer needed):

1. **Channel creation** — create "Friday Night Classics" on the Channels tab → appears in list.
2. **Block creation** — add a Friday 20:00–00:00 block with rules → persisted.
3. **Slate generation** — with library content + a block, generate next week → schedule slots
   exist and render in the guide grid.
4. **Guide playback** — click a programme, choose *Watch from here* → session created, Player
   starts that programme, next scheduled item is queued.
5. **Auto-advance** — current item ends → next item starts automatically.
6. **Join live** — click the currently-airing card, choose *Join live* → playback starts at
   the correct offset and continues the slate.
7. **Lock & regenerate** — lock a slot, regenerate → locked slot untouched, others refilled.

### 34. Revised build order (supersedes §21)

The brief's "build the guide-and-playback loop before broadcast simulation" ordering, merged
with Parts II–III:

1. **Schema + authoring CRUD** — channel/block/slot/session tables (§31); Channels tab with
   channel & block CRUD; seed data.
2. **Scoring scheduler + slate generation** (§27) — fill rule-blocks for a week; regenerate
   action.
3. **Guide grid** — week/day views, channel rows, clickable cards, now/next indicator, in
   both surfaces (§32).
4. **Playback sessions in the Player** (§30) — WATCH_FROM_HERE + PLAY_THIS_ONLY,
   auto-advance, up-next, skip/stop, session resume. *← MVP complete here (criteria 1–5).*
5. **JOIN_LIVE + now/next APIs** — virtual tuning (§17) as the third mode; dashboard "on
   now" rails.
6. **Manual editing + locks** (§28).
7. **Interstitials, manual placement** (§29); packaging-type tagging.
8. **Dynamic series slots + priority stacks** (§15) inside sequence blocks; watch-state
   policies as sync lands (§16).
9. **Broadcast texture** — automated packaging rules (filler grammar §5.6), slot linking,
   cooldowns, on-demand channels, calendar layer (§23.3), auto-channels/templates (§23.4).
10. **Tier 2 external reach** — ffmpeg HLS, M3U/XMLTV, HDHR (§17) — explicitly *last*, per
    the brief's "What Not To Build First" (no IPTV server, no transcoding engine, no
    Netflix clone in MVP).

---

### Closing note

Tunarr's genius is the *vocabulary* — channels, lineups, slots, linking, flex, filler, pad,
lateness — a complete, battle-tested grammar for simulated TV, refined from dizqueTV. Its
burden is everything it must do to sit outside the media server. The product brief supplies
the second insight: the *guide is the product* — every card playable, the channel experience
beginning wherever you press play. Archivist can uniquely deliver both: the library, watch
state, artwork, search, jobs, and the client are all in-house, so the channels module reduces
to **a scheduler, a materializer, a guide, and a session builder** — a personal TV network
that updates itself, knows the calendar, knows what you've watched, and starts the show the
moment you click it.
