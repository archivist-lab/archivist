---
title: "Archivist Player vs Kodi — Feature Gap Analysis"
document_type: product-specification
status: historical
classified: 2026-08-16
---
# Archivist Player vs Kodi — Feature Gap Analysis

Status: living document. Companion to `../player/living-room-ui-specification.md`.
Purpose: capture the features Kodi offers that the **Archivist server + Player** do not yet implement, so we know what the living-room skin needs underneath it to function as a full Kodi replacement — and, honestly, which gaps are worth closing vs. which are intentional or structurally impossible for a browser-based player.

## Scope

- **Archivist Player** is a browser SPA (React) served on port `4242`, consuming a read/play/progress/preferences slice of the server API. It surfaces **Films, Series/Episodes, and Channels** (pseudo-live sessions built from your own library). Playback is browser `<video>` with server-side compatibility transcoding.
- This is compared against **Kodi** as a native media-center application.
- Three distinct kinds of "gap" are called out and must not be conflated:
  - **Server gap** — a feature the skin wants but the Archivist server doesn't yet expose. *These are the actionable ones.*
  - **Browser-structural** — Kodi can do it because it's a native app with direct hardware/audio access; a web `<video>` player fundamentally cannot. Not fixable without a native client (an explicit non-goal in the UI spec §3.6).
  - **Intentional non-goal** — deliberately excluded by the Player spec (§3), e.g. add-ons, PIN profiles, acquisition control.

## Legend

| Mark | Meaning |
|---|---|
| ✅ | Implemented (server + Player) |
| 🟡 | Partial — data exists but the Player/contract doesn't fully surface it |
| ❌ | Not implemented |
| 🌐 | Browser-structural limitation (needs a native client) |
| 🚫 | Intentional non-goal per the Player spec |

## Executive summary — the gaps that actually matter

If the goal is "great living-room player for **my** library," the highest-value **server gaps** to close, in order:

1. **Mark watched / unwatched + play counts** (episode, season rollup, film) — the skin's action row and "unwatched" widgets assume it. *Small, high impact.*
2. **In-player audio/subtitle delay + playback speed** — the two most-missed transport controls from Kodi. *Client-side, no server change.*
3. **Skip intro / intro & credit markers** — expected of any modern TV UI. Needs server-stored chapter/segment data.
4. **Richer library filtering** (genre, year, rating, watched, unwatched) beyond the current title/added/year/rating sort.
5. **Movie sets / collections** grouping (Kodi's "Movie Sets"). Server has no collection grouping today.
6. **Online subtitle search/download** (OpenSubtitles-style) — the server extracts embedded subs but can't fetch missing ones on demand.
7. **A remote-control API** (WebSocket/REST) so a phone can drive the player — Kodi's JSON-RPC + Kore/Yatse ecosystem is a headline feature.
8. **Music in the Player** — the server already *has* a music library; the Player just doesn't surface it (spec non-goal, but the single biggest content-type gap vs Kodi).

Everything below the line (audio passthrough/bitstreaming, HDR tone-mapping, refresh-rate switching, HDMI-CEC, 3D) is **browser-structural** and should be set as an explicit expectation with users, not chased.

---

## 1. Content types

| Kodi | Archivist | Status | Notes |
|---|---|---|---|
| Movies | Films | ✅ | Full detail, resume, transcode |
| TV Shows / Episodes | Series / Episodes | ✅ | Season tabs, per-episode progress |
| Live TV / PVR | Channels (sessions) | 🟡 | *Different model* — Channels are scheduled playlists of **your own files**, not a broadcast tuner. No EPG-from-backend, timers, or recordings (see §5). |
| Music (artists/albums/songs) | Music library exists in the manager | 🟡→❌ | **Server has the data; the Player does not expose it.** Biggest content gap. Player contract has no music types. |
| Music videos | — | ❌ | No server concept |
| Photos / slideshows | — | ❌ | No photo library server-side |
| Games / RetroPlayer | Games library (files) exist | ❌🚫 | Server tracks game files; no emulation/launch, and the Player spec excludes games |
| Books / Comics | Libraries exist in manager | 🚫 | Kodi has no native ebook/comic reader either (addon-only); Player spec excludes them |

## 2. Metadata & artwork

| Kodi | Archivist | Status | Notes |
|---|---|---|---|
| Poster / fanart(backdrop) / banner / clearlogo | poster, backdrop, logo, banner | ✅ | Core four present |
| clearart, discart, characterart, keyart, extrafanart | — | ❌ | Only the core four artwork types are stored/served |
| Movie **sets / collections** | — | ❌ | **Server gap** — no collection grouping (e.g. a "Batman Collection" node) |
| Free-form **tags** | genres only | 🟡 | Genres yes; arbitrary user tags no |
| Multiple ratings (IMDb/TMDb/user) + user rating | single `rating` | 🟡 | One rating; no user rating |
| Cast/crew with headshots + roles | cast/crew JSON | 🟡 | Data present; Player detail "Cast" zone is spec'd but Related/rich-credits are thin |
| Studio, country, certification, tagline, premiered | studio, country, certification, release dates | ✅ | Good coverage |
| Local NFO / multiple scrapers | TMDB/TVDB scraping | ✅ | Different mechanism, equivalent outcome for a managed library |
| Multi-version movies (Theatrical/Director's cut) | film **editions** (`film_editions`, `default_edition_id`) | ✅ | Already modeled — surface it fully in the Player |

## 3. Watched state & progress

| Kodi | Archivist | Status | Notes |
|---|---|---|---|
| Resume points | `playback_progress` (profile, type, id) | ✅ | 10s interval + on pause/exit |
| **Mark watched / unwatched** | — | ❌ | **Server gap** — the Player action row + "unwatched-films" widget assume this; no endpoint to set watched state today |
| Play counts | — | ❌ | No per-item play count |
| Season/series watched rollup | — | 🟡 | Episode progress exists; no aggregate "watched N of M" surfaced to the Player |
| Multiple bookmarks per item | single resume point | 🟡 | Kodi supports many named bookmarks |
| Per-profile watched state | single `default` profile | 🚫 | Profiles are a non-goal (see §9) |

## 4. Playback & transport

| Kodi | Archivist | Status | Notes |
|---|---|---|---|
| Direct play | ✅ | ✅ | |
| Compatibility transcoding | ✅ (server-side) | ✅ | FFmpeg on the server |
| Loudness normalization | 🟡 (addons) | ✅ | Archivist is actually *ahead* here (built-in loudness) |
| Audio/subtitle track selection | ✅ | ✅ | Track menu present |
| Subtitle rendering | ASS/SSA + SRT native | 🟡 | VTT conversion loses ASS/SSA styling/positioning |
| **Online subtitle download** (OpenSubtitles) | ✅ (addon) | ❌ | **Server gap** — extracts embedded subs only; can't fetch missing ones |
| **Audio / subtitle delay offset** | ✅ | ❌ | **Client gap** — heavily used Kodi control; add to OSD |
| **Playback speed** | ✅ | ❌ | **Client gap** — simple `video.playbackRate` control |
| **Chapters** | ✅ | ❌ | No chapter markers stored/served |
| **Skip intro / outro** (EDL / segments) | ✅ (addons) | ❌ | **Server gap** — needs intro/credit segment data + skip UI |
| Audio **passthrough / bitstream** (Dolby/DTS/TrueHD/Atmos) | ✅ | 🌐 | Browser `<video>` decodes to stereo/PCM; cannot bitstream HD audio to a receiver |
| **HDR / Dolby Vision** tone-mapping | ✅ | 🌐 | Browser-dependent; no tone-mapping control |
| **Refresh-rate switching** (24p/50/60) | ✅ | 🌐 | Native-only; browser can't change display mode |
| 3D playback | ✅ | 🚫🌐 | Non-goal + native-only |
| Deinterlace / video calibration / A-V calibration | ✅ | 🌐 | Native-only |

## 5. Live TV / PVR

| Kodi PVR | Archivist Channels | Status | Notes |
|---|---|---|---|
| Backend EPG (real broadcast guide) | Session guide (your files on a schedule) | 🟡 | Different, deliberate model — a "pseudo-channel" of owned content |
| Timers / one-off & series recordings | — | ❌ | No recording concept (you already own the files) |
| Channel groups, radio, reminders | — | ❌ | No radio; groups minimal |
| Tuner / IPTV client integration | — | 🚫🌐 | Out of scope; would need a real PVR backend |

*Assessment:* This is not a straight gap — Channels solves a different problem (curated linear playback of a personal library) that Kodi arguably does *worse*. Frame it as a feature, not a shortfall.

## 6. Remote control & hardware

| Kodi | Archivist | Status | Notes |
|---|---|---|---|
| D-pad / keyboard / gamepad navigation | ✅ (focus engine, gamepad polling) | ✅ | Spec §12.3 implemented |
| **HDMI-CEC** (TV remote drives the app) | ✅ | 🌐 | Browsers can't access CEC — mitigated by gamepad/keyboard |
| IR remotes / LIRC | ✅ | 🌐 | Native-only |
| **JSON-RPC remote-control API** | ✅ | ❌ | **Server gap** — no API to control playback from another device |
| Companion mobile apps (Kore, Yatse) | ✅ (via JSON-RPC) | ❌ | Blocked on the control API above |
| Voice control | ✅ (addon) | ❌ | Out of scope |

## 7. Library intelligence

| Kodi | Archivist | Status | Notes |
|---|---|---|---|
| Sort (title/added/year/rating) | ✅ | ✅ | Present in library prefs |
| **Rich filters** (genre, year, rating, watched, tag, unwatched) | ✅ | ❌ | **Server gap** — only sort + hide-unavailable today |
| **Smart playlists** (rule-based) | ✅ | ❌ | No rule engine |
| Custom nodes / views | ✅ | 🟡 | Fixed hubs + 4 presets + widget editor (bounded by design) |
| "Recently added" / "In progress" nodes | ✅ | ✅ | Home widgets: recent-films, recent-episodes, continue, downloading |
| Stacked / multi-part files | ✅ | 🟡 | Unclear coverage |

## 8. Casting / streaming out

| Kodi | Archivist | Status | Notes |
|---|---|---|---|
| UPnP/DLNA server + renderer | ✅ | ❌ | No UPnP |
| "Play to" / Cast to Chromecast / AirPlay | ✅ | ❌ | A browser player *could* add the Cast SDK later; out of scope now |

## 9. Users, ecosystem & shell

| Kodi | Archivist | Status | Notes |
|---|---|---|---|
| Multiple **profiles** + PIN lock + parental controls | single `default` profile | 🚫 | Explicit non-goal (spec §3.6) |
| **Add-ons / scrapers / plugins / repositories** | huge ecosystem | 🚫 | Explicit non-goal (spec §3.8) — bounded presets instead |
| Skins (hundreds) | 4 presets + widget editor | 🚫 | Intentional: safe, bounded customization (AD-009), not an open theme platform |
| Weather / RSS / favourites / system info widgets | ✅ | 🚫 | Non-goals |
| Screensaver / ambient / visualizations | ✅ | ❌ | Minor; could add an ambient/backdrop screensaver |

---

## Recommended server roadmap (to feed the skin)

Ordered by value-per-effort for making the living-room UI a complete player frontend:

1. **Watched-state API** — `POST /player/watched` (film/episode) + `watched`/`playCount` on detail & card contracts, plus a `series-a-z` style "unwatched" rollup. Unblocks the Mark Watched action + unwatched widgets. *Small.*
2. **Transport controls (client-only)** — audio/subtitle delay + playback speed in the OSD. No server work. *Small.*
3. **Library filters** — extend `/films` & `/series` with `genre`, `year`, `minRating`, `watched` params; add a filter drawer in the Player. *Medium.*
4. **Intro/credit segments + Skip Intro** — store per-episode segment markers (server), add the skip button + Up Next handoff. *Medium.*
5. **Collections / sets** — a `collection` grouping in the schema + a hub source + detail route. *Medium.*
6. **Online subtitle fetch** — server-side OpenSubtitles (or similar) search/download into the existing subtitle pipeline. *Medium.*
7. **Remote-control API** — a scoped WebSocket/REST play/pause/seek/nav surface on `4242` for a companion remote. *Larger.*
8. **Music in the Player** — new contract types + hub sources + detail/now-playing surfaces over the existing server music library. *Larger; and a spec non-goal to revisit.*

## Set-expectations list (won't fix in a browser player)

These should be documented for users as inherent to a web-based player, not bugs:

- HD audio **bitstreaming/passthrough** (Atmos/TrueHD/DTS-HD) — browser decodes to PCM.
- **HDR/Dolby Vision** fidelity and **refresh-rate matching** — display-mode control is native-only.
- **HDMI-CEC / IR** remote integration — no browser API; use a gamepad or keyboard, or (roadmap item 7) a phone remote.
- **3D**, deinterlacing/video calibration — native-only.

Closing these last four would require the native TV client that the Player spec (§3.6) explicitly rules out for this release.
