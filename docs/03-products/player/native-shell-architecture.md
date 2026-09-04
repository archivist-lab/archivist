---
title: "Archivist Player — Android TV Architecture"
document_type: product-specification
status: proposal
updated: 2026-09-04
evidence:
  - apps/player/src/components/Player.tsx
  - apps/player/src/components/SessionPlayer.tsx
  - apps/player/src/focus/navigation.ts
  - apps/player/src/focus/FocusProvider.tsx
  - apps/player/src/styles/tokens.css
  - packages/design-system/tokens.css
  - apps/server/src/player/media.ts
  - apps/server/src/player/playback-plan.ts
  - apps/kodi/resources/lib/archivist
---

# Archivist Player — Android TV Architecture

Proposal for an Android TV Player with native HEVC and AV1 playback that
preserves the existing visual language and extends the consumption surface to
music, audiobooks, podcasts, retro games and ebooks.

## Confidence markers

- **[Certain]** — grounded in this repository or in documented platform behaviour.
- **[Likely]** — strong inference from the evidence above.
- **[Guessing]** — directional; needs a spike to confirm.

---

## 1. Decision summary

**Build a Kotlin Android TV app whose UI is the existing `apps/player` React
application in a transparent WebView, composited over a Media3 ExoPlayer
`SurfaceView`. Do not fork Kodi. Do not use libmpv.**

| Layer | Choice | Reason |
| --- | --- | --- |
| Shell | Kotlin, Android TV (Leanback) | Only native option on the platform |
| A/V engine | Media3 ExoPlayer | Built-in Matroska extractor; HEVC/AV1 via MediaCodec; AC3/E-AC3/DTS/TrueHD passthrough |
| UI | `apps/player` in a transparent WebView | Tokens, Tailwind, focus model and component tree carry over verbatim |
| Bridge | `@JavascriptInterface` | React OSD drives ExoPlayer; playback state flows back |
| Games | RetroArch / libretro Android cores | Native; EmulatorJS in a TV WebView will not perform |
| Books/comics | WebView reader (foliate-js, pdf.js) | Rendering documents is a web problem |
| Backend | `/api/v1/player/*` | Already mature; needs capability-aware planning and new media domains |

The architectural line is unchanged from the desktop analysis: **the WebView
does everything except A/V decode.** What changes is that Android TV's own
media stack performs that decode, so no third-party engine is needed.

---

## 2. What Android TV changes

The desktop analysis concluded that libmpv was required because Chromium
cannot demux Matroska and ships no DTS or TrueHD decoder. **That conclusion
does not carry to Android TV.** Media3 ExoPlayer clears all three barriers
natively:

| Barrier | Chromium (desktop) | Media3 ExoPlayer (Android TV) |
| --- | --- | --- |
| Container | No Matroska demuxer [Certain] | `MatroskaExtractor` built in [Certain] |
| Video | HEVC hardware-only where the OS provides it [Likely] | HEVC, AV1, VP9 via MediaCodec [Certain] |
| Audio | No DTS/TrueHD/Atmos [Certain] | Passthrough to the HDMI sink via `AudioCapabilities` [Certain] |

[Likely] This is a **better** outcome than the desktop plan, not merely an
equivalent one. Passthrough means the AV receiver gets the original TrueHD or
DTS-HD bitstream. The current implementation transcodes to stereo AAC — see
`BROWSER_AUDIO` in `apps/server/src/player/media.ts` — so this recovers audio
quality that is presently discarded.

Four further platform capabilities have no desktop equivalent and are worth
having:

- **Tunneled playback** (`setTunnelingEnabled`) for 4K HDR — reduces A/V sync
  drift and CPU load on TV hardware. [Likely]
- **Frame-rate matching** via `Surface.setFrameRate()` and display `MODE_SWITCH`
  — eliminates 24fps judder on 60Hz panels. This is one of Kodi's signature
  strengths and is available directly from the platform. [Likely]
- **Watch Next / home-screen channels** via `TvProvider` — Continue Watching
  surfaces on the Android TV home screen, outside the app. [Certain]
- **Media3 `DownloadManager`** for offline playback, against the `/sync/manifest`
  and `/sync/changes` endpoints that already exist. [Certain]

---

## 3. The AV1 caveat

[Likely] "AV1 native" is device-dependent on Android TV, and the two most
common enthusiast devices do not have it:

| Device | HEVC hardware | AV1 hardware |
| --- | --- | --- |
| NVIDIA Shield TV / Pro (Tegra X1) | Yes | **No** |
| Chromecast with Google TV 4K (Amlogic S905D3) | Yes | **No** |
| Google TV Streamer (2024) | Yes | Yes |
| Fire TV Stick 4K Max (2nd gen) | Yes | Yes |
| 2023+ Google TV panels (Sony/TCL/Hisense) | Yes | Usually |

[Likely] Android 10 and later mandate AV1 *software* decode (libgav1/dav1d),
which is adequate at 1080p and unreliable at 4K on the SoCs above.

**Implication.** If the library is being encoded to AV1 for storage efficiency,
confirm the target device decodes it in hardware before committing. Otherwise
HEVC remains the correct archival codec for this playback path, and AV1 becomes
a forward-looking capability rather than a present one. Either way ExoPlayer
selects the best available decoder and falls back to software automatically —
nothing breaks, it degrades.

---

## 4. Why not Kodi

[Certain] Kodi's presentation layer is an XML skinning engine with its own
layout and animation DSL. None of the current styling survives:
`packages/design-system/tokens.css` (371 lines of `--archivist-*` custom
properties), `apps/player/src/styles/tokens.css`, `combined.css`, and roughly
812 `className` sites across `apps/player/src`. "Kodi skeleton" and "maintain
the styling I currently have" are mutually exclusive at the presentation layer.

[Certain] `apps/player` is already a working product — approximately 7,900 LOC
with home hubs, browse and filtering, film/series/episode/person detail,
recommendations, Leaving Soon, box sets, shelves, bookmarks, programmed
channels, play sessions, offline sync manifest, telemetry, spatial remote
navigation, text scaling and high contrast. `apps/kodi` is a second player
surface. A Kodi fork would be a third.

[Likely] The reason to want Kodi was its playback core. On Android TV that core
is supplied by the platform. Media3 provides HEVC, AV1, MKV, audio passthrough,
tunneling and frame-rate matching — the same capabilities, maintained by
Google, behind a supported API.

[Certain] Kodi is GPLv2; this repository is GPLv3. Deriving from Kodi would
permanently constrain relicensing for a capability obtainable without it.

**What is worth taking from Kodi** is its `IPlayer` abstraction — one player
interface with distinct video, audio and game implementations. See section 6.

---

## 5. UI strategy: WebView versus Compose for TV

This is the real decision, and it is a genuine trade-off.

| | WebView hybrid | Compose for TV |
| --- | --- | --- |
| Existing styling | Preserved literally | Reimplemented; tokens port as a Kotlin theme |
| Existing 7,900 LOC | Preserved | Rewritten |
| Spatial navigation | Already built and working | Rewritten against TV focus APIs |
| Time to first working app | Weeks | Months |
| Performance on low-end TV hardware | **Risk** | Strong |
| One codebase for web and TV | Yes | No |
| Android TV platform integration | Via bridge | Native |

**Recommendation: WebView hybrid.** [Likely] The stated requirement is styling
preservation, and this is the only path that delivers it literally rather than
by reconstruction.

Two properties make this less risky than it first appears:

[Certain] The D-pad already works. `FocusProvider.tsx` binds `ArrowLeft/Right/
Up/Down`, `Enter`, `Escape`/`BrowserBack`/`Backspace`, and reads gamepad axes.
Android TV remote D-pad events arrive in a WebView as exactly those key events.
The spatial navigation in `focus/navigation.ts` — scored candidate selection
with explicit neighbour overrides and per-route focus memory — is already a TV
navigation model, not a desktop one adapted.

[Likely] The compositing is a well-trodden Android pattern, not the research
problem it was on desktop. A `SurfaceView` composites beneath the window; a
WebView above it with `setBackgroundColor(Color.TRANSPARENT)` renders the OSD
over video. The desktop plan's principal risk largely disappears here.

### The decision rule

The risk moves from compositing to **WebView rendering performance on the
target device**, and that is answerable only by measurement:

- **Shield TV / Shield Pro, Google TV Streamer, 2023+ Google TV panel, 3GB+ RAM**
  → WebView is expected to hold. [Guessing]
- **Chromecast with Google TV 4K (2GB, Amlogic S905D3), budget TCL/Hisense panels**
  → expect dropped frames scrolling artwork rails; Compose for TV becomes
  necessary. [Guessing]

**Gate the choice on a one-week spike** (section 9, Phase 0) that loads the real
`apps/player` bundle on the real device and scrolls a populated Home. Do not
decide this from argument.

[Likely] If Compose becomes necessary, the design system still transfers — the
`--archivist-*` tokens are values, portable to a Kotlin theme object. What is
lost is the component implementation, not the design.

---

## 6. Playback engine abstraction

[Certain] `Player.tsx` (521 lines) and `SessionPlayer.tsx` (399 lines) contain
overlapping direct-play, transcode and track-selection logic today.

[Likely] Consolidate both behind one interface **before** adding five media
domains, or the same fallback logic will be reimplemented per domain. This is
the single highest-leverage change in the plan, and it is unchanged from the
desktop analysis — only the native implementation differs.

```ts
interface PlaybackEngine {
  load(target: PlaybackTarget): Promise<void>
  play(): void
  pause(): void
  seek(seconds: number): void
  setAudioTrack(index: number): void
  setSubtitleTrack(index: number | null): void
  setVolume(gain: number): void
  readonly state: Observable<PlaybackState>
  dispose(): void
}
```

Implementations:

| Implementation | Serves | Backend |
| --- | --- | --- |
| `HtmlVideoEngine` | browser build | `<video>` + transcode fallback (existing) |
| `ExoPlayerEngine` | film, series, music, audiobook, podcast | `@JavascriptInterface` bridge to Media3 |
| `LibretroEngine` | retro games | RetroArch intent, then in-process libretro cores |
| `ReaderEngine` | ebooks, comics | foliate-js, pdf.js, CBZ/CBR unpacker in the WebView |

[Likely] Routing all audio through ExoPlayer is a direct upgrade. The
client-side Web Audio normalisation in `useMediaGain.ts` is superseded by
ExoPlayer's loudness handling, gapless playback becomes available for albums
and audiobook chapters, and playback survives the WebView being backgrounded —
which an `<audio>` element in a TV WebView does not reliably do.

---

## 7. Media domain coverage

| Domain | Backend today | Player API today | Work required |
| --- | --- | --- | --- |
| Films | Complete | Complete | Direct-play plan only |
| Series | Complete | Complete | Direct-play plan only |
| Music | Complete (artists/albums/tracks) | **Absent** | Player API surface, hubs, queue, gapless |
| Audiobooks | Book editions carry audiobook formats | **Absent** | Chapter model, position resume, speed control |
| Podcasts | **Absent everywhere** | **Absent** | Full domain: subscriptions, RSS ingest, episodes, retention |
| Retro games | Library + arcade routes | Arcade only | Promote out of the Konami easter egg; libretro; save states |
| Ebooks | Book editions, `/stream/book-editions/:id` | Stream only | Reader, position sync, library shape |
| Comics | Comic series/issues | **Absent** | Reader, page position sync |

[Certain] Podcasts are the only requested domain with no backend at all.
Subscription management, RSS polling, episode ingest and retention are
Archivist-side work, not player work, and should be scoped separately.

[Likely] Audiobooks currently exist as a book *edition format* rather than a
first-class domain. Consumption needs a chapter model and second-resolution
position resume that the book edition shape does not express.

[Likely] Retro games change character on Android TV. `Arcade.tsx` runs
EmulatorJS in an iframe, which will perform poorly on TV hardware. Android has
first-class libretro cores and RetroArch as an installable app; launching by
intent is the cheap first step, in-process cores the better end state.

---

## 8. Server-side changes

1. **Capability-aware stream planning.** `playback-plan.ts` decides direct-play
   versus transcode from browser assumptions. The Android client must declare
   its own profile — Matroska, HEVC/AV1, and whatever `AudioCapabilities`
   reports the HDMI sink accepts — so the server stops proposing transcodes.
   This is the single change that makes native playback work end to end. [Certain]
2. **Extend `PlayerMediaType`.** Currently `'film' | 'series' | 'episode' |
   'collection' | 'download'` in `packages/contracts/src/player.ts`. Needs
   `track`, `album`, `audiobook`, `podcast-episode`, `book`, `comic`, `game`. [Certain]
3. **Progress model.** Beyond seconds-into-video: reading position for books and
   comics, chapter plus offset for audiobooks, save state for games.
4. **Browse and hub services** for the new domains, mirroring `browse-service.ts`
   and `hub-service.ts`.
5. **Stream endpoints** for tracks, audiobook files, podcast episodes and comic
   archives, with range support matching the existing film/episode handlers.
6. **Scoped player tokens.** A TV in a shared room should not hold the admin API
   key. Pairing-code flow with a read/play/progress scope — on-screen code,
   approval in the Archivist UI.

The transcode path is retained, not removed — it remains correct for the browser
build and for remote access over constrained links.

---

## 9. Phasing

**Phase 0 — Device spike (1 week).** Load the real `apps/player` bundle in a
WebView on the actual target device. Scroll a populated Home with artwork rails.
Composite a transparent WebView over an ExoPlayer `SurfaceView` playing a 4K
HEVC MKV. Measure frame pacing and memory. **Outcome: WebView or Compose.** No
other work starts until this resolves.

**Phase 1 — Native film and series.** `PlaybackEngine` extraction,
`ExoPlayerEngine` and the JS bridge, capability-aware stream planning, OSD wired
to ExoPlayer state, track and subtitle selection through Media3, audio
passthrough, tunneled playback, frame-rate matching, HDR verification.
*Exit criterion: a 4K HEVC MKV with TrueHD audio plays with bitstream
passthrough to the AVR and zero server CPU.*

**Phase 2 — Android TV platform citizenship.** Leanback manifest and banner,
D-pad-only audit, Watch Next channel integration, Play Store TV quality
guidelines, offline downloads via Media3 `DownloadManager`.

**Phase 3 — Music and audiobooks.** Player API for artists/albums/tracks, queue
and gapless playback, loudness handling, audiobook chapters, speed control,
now-playing UI, background playback via `MediaSessionService`.

**Phase 4 — Books and comics.** Reader engine, EPUB and PDF, CBZ/CBR, position
sync, reading-progress hubs.

**Phase 5 — Games.** Promote the arcade out of the Konami code, libretro cores,
save states, controller mapping.

**Phase 6 — Podcasts.** Archivist-side subscription and RSS ingest first, then
the player surface.

[Likely] Phases 3–6 are independently shippable once Phase 1 establishes the
engine abstraction; the ordering reflects value per unit of work, not a hard
dependency chain.

---

## 10. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| WebView too slow on target hardware | High | Phase 0 spike gates the decision; Compose fallback, tokens still port |
| AV1 not hardware-decoded on target device | Medium | Confirm the device before encoding the library to AV1; HEVC remains safe |
| Scope inflation across seven media domains | High | Phase 1 must ship alone and prove the engine before domains are added |
| Three player surfaces to maintain | Medium | Deprecate `apps/kodi` once the Android TV app ships |
| WebView version fragmentation across TV vendors | Medium | Pin a minimum WebView version; test on each target vendor |
| Fire TV is a fork — no Play Store, no Google TV channels | Medium | Decide early whether Fire TV is a target; it changes distribution and Watch Next |
| Podcasts pull backend scope into a player project | Medium | Scope podcast ingest as separate Archivist work, last in sequence |

---

## 11. Open decisions

1. **Which device is the target?** This gates the WebView/Compose choice, AV1
   viability, and distribution. The most consequential open question here.
2. Is Fire TV a target alongside Google TV / Android TV?
3. Do native clients retain the transcode path at all, or is direct play the
   only mode?
4. Does progress remain server-stored for all domains, or do games keep save
   states locally?
5. Is `apps/kodi` deprecated when the Android TV app ships, or maintained as an
   interop surface?
6. Do podcasts belong in Archivist at all, or is subscribing to external feeds
   outside the archive thesis?

---

## Appendix — superseded desktop analysis

An earlier revision of this document proposed an Electron shell with libmpv.
That is retained here only as rationale for why it does not apply:

- [Certain] Electron does not exist on Android; the shell must be Kotlin.
- [Likely] libmpv is unnecessary because Media3 ExoPlayer supplies Matroska
  demuxing, HEVC/AV1 hardware decode and lossless audio passthrough natively.
- [Likely] The desktop plan's principal risk — compositing a transparent webview
  over a native video surface — is a standard `SurfaceView` pattern on Android.

The two conclusions that survive unchanged: **do not fork Kodi**, and **extract
the `PlaybackEngine` interface before adding media domains**.
