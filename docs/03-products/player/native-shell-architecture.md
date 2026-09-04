---
title: "Archivist Player — Fire TV and Android TV Architecture"
document_type: product-specification
status: draft
updated: 2026-09-04
evidence:
  - apps/player/src/components/Player.tsx
  - apps/player/src/components/SessionPlayer.tsx
  - apps/player/src/focus/navigation.ts
  - apps/player/src/focus/FocusProvider.tsx
  - apps/player/src/lib/sdk.ts
  - apps/player/src/lib/store.ts
  - apps/player/src/styles/tokens.css
  - packages/design-system/tokens.css
  - apps/server/src/player/media.ts
  - apps/server/src/player/playback-plan.ts
---

# Archivist Player — Fire TV and Android TV Architecture

Proposal for a television Player with native HEVC and AV1 playback that
preserves the existing visual language and extends the consumption surface to
music, audiobooks, podcasts, retro games and ebooks.

**Primary target: Fire TV Stick 4K Max. Secondary: Google TV.**

## Confidence markers

- **[Certain]** — grounded in this repository or in documented platform behaviour.
- **[Likely]** — strong inference from the evidence above.
- **[Guessing]** — directional; needs measurement on the actual device.

---

## 1. Decision summary

**Build a React Native television app on Media3 ExoPlayer. Do not fork Kodi. Do
not use libmpv.**

The UI recommendation changed from WebView to React Native on discovering that
Amazon has moved new Fire TV Sticks to **Vega OS**, a Linux platform that is not
Android and whose application model is React Native. WebView and Compose both
stop working there; React Native spans all three targets. See sections 3.4 and 5.

| Layer | Choice | Reason |
| --- | --- | --- |
| Shell | Kotlin, Fire OS / Android TV | Only native option on the platform |
| A/V engine | Media3 ExoPlayer | Built-in Matroska extractor; HEVC/AV1 via MediaCodec; audio passthrough |
| UI | **React Native for TV** | The only option spanning Fire OS, Google TV and Vega OS; see section 5 |
| Games | libretro cores | RetroArch intent on Android; needs a Vega answer separately |
| Books/comics | Document reader | RN reader components; EPUB/PDF/CBZ |
| Backend | `/api/v1/player/*` | Already mature; needs capability-aware planning and new media domains |

Two conclusions are settled regardless of the UI outcome: **the platform decodes
A/V, not the UI layer**, and **the `PlaybackEngine` interface must be extracted
before any new media domain is added**.

---

## 2. Why the platform media stack replaces libmpv

An earlier revision proposed Electron plus libmpv, on the reasoning that
Chromium cannot demux Matroska and ships no DTS or TrueHD decoder. Neither
premise survives the move to Fire TV: Electron does not exist on Android, and
Media3 ExoPlayer clears all three barriers natively.

| Barrier | Chromium (desktop) | Media3 ExoPlayer |
| --- | --- | --- |
| Container | No Matroska demuxer [Certain] | `MatroskaExtractor` built in [Certain] |
| Video | HEVC hardware-only where the OS provides it [Likely] | HEVC, AV1, VP9 via MediaCodec [Certain] |
| Audio | No DTS/TrueHD/Atmos [Certain] | Passthrough to the sink via `AudioCapabilities` [Certain] |

[Likely] This recovers audio quality currently discarded. `BROWSER_AUDIO` in
`apps/server/src/player/media.ts` forces a transcode to stereo AAC today;
passthrough sends the original bitstream to the receiver instead.

Platform capabilities with no desktop equivalent, worth having:

- **Tunneled playback** (`setTunnelingEnabled`) for 4K HDR — reduces A/V sync
  drift and CPU load. [Likely]
- **Frame-rate matching** via `Surface.setFrameRate()` and display `MODE_SWITCH`
  — eliminates 24fps judder on 60Hz panels. One of Kodi's signature strengths,
  available directly from the platform. [Likely]
- **Media3 `DownloadManager`** for offline playback, against the
  `/sync/manifest` and `/sync/changes` endpoints that already exist. [Certain]

---

## 3. Fire TV constraints

Fire OS is an Android fork, and three of its differences bear directly on this
design.

### 3.1 Hardware is weak

[Likely] Most Fire TV devices ship 1–2GB of RAM on modest quad-core silicon.
This is the low-end scenario in which a React UI in a WebView is expected to
drop frames scrolling artwork rails.

**The confirmed target is a Fire TV Stick 4K Max.** That places it in the middle
of this range rather than at the floor — the WebView option is plausible rather
than hopeless, and the 1GB Stick is out of scope.

[Guessing] The device's memory has been reported as 8GB, which does not match
any published Fire TV Stick specification — Amazon ships these with 2GB of RAM
and 8GB or 16GB of flash storage, so the figure is most likely the storage
number. This matters because it is the difference between a comfortable WebView
and a marginal one. `scripts/probe-firetv.sh` reads `MemTotal` directly and
settles it; nothing downstream should be planned on the 8GB figure until it
does. If the device genuinely reports 8GB of RAM, the WebView option becomes
the clear favourite and the frame-pacing spike is close to a formality.

The generation matters more than the memory either way:

- **1st generation (2021)** — quad A55, Wi-Fi 6, **no AV1 hardware decoder**.
  AV1 falls back to software dav1d, which is adequate at 1080p and unreliable at
  4K on this silicon. [Likely]
- **2nd generation (2023)** — faster silicon, Wi-Fi 6E, **AV1 hardware decode**.
  [Likely]

[Certain] Which one is in hand decides whether "AV1 native" is achievable at 4K
on the primary device, and it is the first thing the Phase 0 probe reports.

| Device | RAM | HEVC | AV1 |
| --- | --- | --- | --- |
| Fire TV Stick 4K (2018) | 1.5GB | Yes | No |
| Fire TV Stick (3rd gen, 2020) | 1GB | Yes | No |
| **Fire TV Stick 4K Max (1st gen, 2021)** | 2GB | Yes | **No** |
| **Fire TV Stick 4K Max (2nd gen, 2023)** | 2GB | Yes | **Yes** |
| Fire TV Cube (3rd gen, 2022) | 2GB | Yes | Unconfirmed [Guessing] |
| Google TV Streamer (2024) | 4GB | Yes | Yes |

Rows in bold are the confirmed target. The Google TV device is a useful control
but must not be the one measured — it is faster than the device that has to
work.

### 3.2 Amazon ships its own WebView

[Likely] Fire OS uses an Amazon Chromium build rather than Google's Android
System WebView, and it has historically lagged upstream. This is not a
theoretical concern for this codebase:

[Certain] The styling uses `color-mix()` in 24 places across
`packages/design-system/tokens.css` and `apps/player/src/styles/tokens.css` —
specifically in the per-domain media identity treatments (the film/series/music/
books/comics/games accent borders, fills and glows) and in the Player's accent
tokens.

[Certain] `color-mix()` requires Chromium 111 or later. If the Fire TV WebView
predates it, every one of those 24 declarations fails and the media identity
colour system silently degrades — **on the very path chosen to preserve the
styling.**

This is measurable in about ten minutes and must be measured before anything
else. See section 9, Phase 0.

### 3.3 Distribution and home-screen integration differ

[Certain] No Google Play. Distribution for a self-hosted personal application is
ADB sideload, which removes store review entirely — a simplification, not a
limitation.

**Watch Next does work on Fire TV, and is in scope.** [Likely] An earlier
revision of this document wrongly dropped it. Fire OS is an Android fork, so the
standard `androidx.tvprovider` `WatchNextPrograms` content provider is available
to third-party apps, and the Jellyfin Android TV client uses exactly this path
to place resume entries on the Fire TV home screen. Amazon *separately* operates
a partner-only Watch Activity SDK, which is how the large commercial services
(Disney+, Hulu, Max, Peacock, Netflix) integrate; partner approval applies to
that path, not to `WatchNextPrograms`. The earlier claim over-generalised from
the partner programme to the whole feature.

[Likely] What remains Google-TV-only is app-owned **preview channels** — custom
home-screen rows the app populates and names. Watch Next is a single shared
system row and is available to both.

### 3.4 Vega OS ends the Android path on new hardware

[Certain] Amazon has replaced Fire OS with **Vega OS** — a Linux-based operating
system that is *not* Android — on new Fire TV Sticks, beginning with the Fire TV
Stick 4K Select (2025) and the Fire TV Stick HD (2026). Amazon has stated that
no future Fire TV Stick will ship on the Android-based Fire OS.

[Certain] On Vega OS:

- Android APKs cannot be sideloaded, and ADB APK install does not apply.
- Media3 / ExoPlayer, Kotlin, and Compose for TV are all unavailable.
- Jellyfin is absent and cannot be installed; the community response has been
  to write new Vega-native clients from scratch.

[Certain] **Vega's application model is React Native.** Amazon ships
`@amazon-devices/react-native-kepler`, porting React Common, Yoga and Hermes
onto Vega's native UI framework, with Vega Studio and a Vega CLI as the
toolchain.

This is the single most consequential fact in this document. It means the UI
technology choice is not merely a performance trade-off on today's hardware —
it decides whether the application has a future on Amazon hardware at all. See
section 5.

[Guessing] DTS passthrough support is inconsistent across Fire TV stick devices;
Dolby Digital Plus and Atmos passthrough are well supported. The Cube is the
stronger audio device. Verify on the actual hardware rather than assuming the
full lossless-audio win.

---

## 4. Why not Kodi

[Certain] Kodi's presentation layer is an XML skinning engine with its own
layout and animation DSL. None of the current styling survives: 371 lines of
`--archivist-*` custom properties, `apps/player/src/styles/tokens.css`,
`combined.css`, and roughly 812 `className` sites. "Kodi skeleton" and "maintain
the styling I currently have" are mutually exclusive at the presentation layer.

[Certain] `apps/player` is already a working product — approximately 7,900 LOC
covering home hubs, browse and filtering, detail pages, recommendations, Leaving
Soon, box sets, shelves, bookmarks, programmed channels, play sessions, offline
sync manifest, telemetry, spatial remote navigation, text scaling and high
contrast. `apps/kodi` is a second player surface. A Kodi fork would be a third.

[Likely] The reason to want Kodi was its playback core. On this platform that
core is supplied by Media3 — HEVC, AV1, MKV, audio passthrough, tunneling and
frame-rate matching, maintained by Google behind a supported API.

[Certain] Kodi is GPLv2; this repository is GPLv3. Deriving from Kodi would
permanently constrain relicensing for a capability obtainable without it.

**What is worth taking from Kodi** is its `IPlayer` abstraction — one player
interface with distinct video, audio and game implementations. See section 6.

---

## 5. The UI decision

**Recommendation: React Native for TV.** This reverses the earlier
WebView-first position, and Vega OS is the reason.

| | WebView hybrid | **React Native for TV** | Compose for TV |
| --- | --- | --- | --- |
| CSS / styling | Preserved literally | Rewritten (NativeWind covers a subset) | Rewritten; tokens port as a Kotlin theme |
| `sdk.ts`, `store.ts`, hooks, page logic | Preserved | **Preserved** | Rewritten in Kotlin |
| Component structure | Preserved | Mostly preserved | Rewritten |
| Focus / spatial navigation | Already working | Rewritten against RN TV focus | Rewritten against TV focus APIs |
| Performance on a 2GB stick | Risk | Moderate | Strong |
| Exposure to Amazon WebView version | Total | None | None |
| Runs on today's Fire OS | Yes | Yes (`react-native-tvos`) | Yes |
| Runs on Google TV | Yes | Yes (`react-native-tvos`) | Yes |
| **Runs on Vega OS** | **No** | **Yes** (`react-native-kepler`) | **No** |
| Time to a working app | Weeks | ~2 months | ~4 months |

### Why the recommendation changed

[Certain] React Native is the only one of the three that spans all three
platforms the product must reach: current Android-based Fire TV via
`react-native-tvos`, Google TV via the same, and Vega OS via Amazon's
`react-native-kepler`. WebView and Compose both terminate at Vega.

[Likely] Amazon has committed all future Fire TV Sticks to Vega. Choosing
WebView or Compose is therefore choosing an architecture with a known end date
on the primary target platform. The four months saved by WebView are borrowed
against a rewrite whose timing Amazon controls.

[Certain] React Native also preserves the more expensive half of the existing
codebase — `lib/sdk.ts` (363 lines), `lib/store.ts` (276), `lib/preferences.ts`,
page composition, hooks and data flow. Only the styling and focus layers are
reconstructed.

[Likely] The design survives even though its implementation does not. The
`--archivist-*` tokens are values, portable to a NativeWind config. What is lost
is the CSS: the 24 `color-mix()` declarations become precomputed values, and the
812 `className` sites are rewritten against a Tailwind subset.

### What is genuinely lost

Honesty about the cost: the spatial navigation in `focus/navigation.ts` and
`focus/FocusProvider.tsx` — scored candidate selection, explicit neighbour
overrides, per-route focus memory, gamepad axis handling — is replaced by React
Native's TV focus engine. That is working, tested code being discarded, and the
RN focus model is less expressive. Budget for it rather than discovering it.

### Where WebView still wins

[Likely] If Vega is judged irrelevant — the current device is Android-based, it
is not being replaced, and Google TV is the long-term home — WebView remains the
fastest path and preserves everything. That case is legitimate. It should be
chosen deliberately, with the Vega end-date understood, not by default.

Under that choice the two Phase 0 gates still apply: WebView at Chromium 111 or
later for `color-mix()`, and acceptable frame pacing on the target device.

## 6. Playback engine abstraction

[Certain] `Player.tsx` (521 lines) and `SessionPlayer.tsx` (399 lines) contain
overlapping direct-play, transcode and track-selection logic today.

[Likely] Consolidate both behind one interface **before** adding five media
domains, or the same fallback logic is reimplemented per domain. This is the
highest-leverage change in the plan, it is independent of the UI decision, and
it can begin immediately.

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

| Implementation | Serves | Backend |
| --- | --- | --- |
| `HtmlVideoEngine` | browser build | `<video>` + transcode fallback (existing) |
| `ExoPlayerEngine` | film, series, music, audiobook, podcast | Media3, via JS bridge or `react-native-video` |
| `LibretroEngine` | retro games | RetroArch intent, then in-process libretro cores |
| `ReaderEngine` | ebooks, comics | foliate-js / pdf.js, or native |

[Likely] Routing audio through ExoPlayer is a direct upgrade: the client-side
Web Audio normalisation in `useMediaGain.ts` is superseded, gapless playback
becomes available for albums and audiobook chapters, and playback survives
backgrounding via `MediaSessionService` — which an `<audio>` element in a TV
WebView does not reliably do.

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

[Likely] Audiobooks exist as a book *edition format* rather than a first-class
domain. Consumption needs a chapter model and second-resolution position resume
the edition shape does not express.

[Likely] `Arcade.tsx` runs EmulatorJS in an iframe. On a 1–2GB Fire TV stick
this will not perform. Android has first-class libretro cores and RetroArch as
an installable app; launching by intent is the cheap first step.

---

## 8. Server-side changes

1. **Capability-aware stream planning.** `playback-plan.ts` decides direct-play
   versus transcode from browser assumptions. The television client must declare
   its real profile — the codecs `MediaCodecList` reports and the formats
   `AudioCapabilities` says the sink accepts — so the server stops proposing
   transcodes. This is the single change that makes native playback work end to
   end, and the Phase 0 probe produces exactly this payload. [Certain]
2. **Extend `PlayerMediaType`.** Currently `'film' | 'series' | 'episode' |
   'collection' | 'download'` in `packages/contracts/src/player.ts`. Needs
   `track`, `album`, `audiobook`, `podcast-episode`, `book`, `comic`, `game`. [Certain]
3. **Progress model.** Beyond seconds-into-video: reading position for books and
   comics, chapter plus offset for audiobooks, save state for games.
4. **Browse and hub services** for the new domains, mirroring `browse-service.ts`
   and `hub-service.ts`.
5. **Stream endpoints** for tracks, audiobook files, podcast episodes and comic
   archives, with range support matching the existing film/episode handlers.
6. **Scoped player tokens.** A sideloaded TV app should not hold the admin API
   key. Pairing-code flow with a read/play/progress scope — on-screen code,
   approval in the Archivist UI.

The transcode path is retained, not removed — it remains correct for the browser
build and for remote access over constrained links.

---

## 9. Phasing

**Phase 0 — Capability probe (days, not weeks).** `scripts/probe-firetv.sh`
answers most of this over ADB with no build step; a minimal Kotlin APK using
`MediaCodecList` and `AudioCapabilities` confirms anything the shell probe
cannot read. Between them they report:

- `MediaCodecList.getCodecInfos()` — which codecs decode in hardware, and at
  what profile and level. Settles HEVC and AV1 per device.
- `AudioCapabilities` — what the connected receiver accepts. Settles the DTS and
  TrueHD passthrough question.
- WebView package name and version. **Settles the `color-mix()` question and
  therefore the UI decision.**
- Display modes and supported refresh rates. Settles frame-rate matching.

[Likely] This is not throwaway spike code. The same payload is the capability
profile the client sends to `playback-plan.ts` in Phase 1 — build it as the
real thing.

**Phase 0b — Platform census (hours).** Establish which OS each target device
runs. A device that refuses `adb connect` entirely is likely Vega, not
misconfigured. Decide whether Vega is in scope; that answer, not the frame-pacing
result, is what selects the UI technology.

**Phase 0c — WebView frame pacing (1 week, only if Vega is ruled out of scope
and the WebView version check passes).** Load the real `apps/player` bundle on
the weakest target device; scroll a populated Home. This is the one path on
which WebView remains defensible.

**Phase 1 — Native film and series.** `PlaybackEngine` extraction (start now,
independent of Phase 0), `ExoPlayerEngine`, capability-aware stream planning,
OSD wired to ExoPlayer state, track and subtitle selection through Media3, audio
passthrough, tunneled playback, frame-rate matching, HDR verification.
*Exit criterion: a 4K HEVC MKV plays on the Fire TV with the best audio the sink
accepts and zero server CPU.*

**Phase 2 — Platform citizenship.** Leanback manifest and banner, D-pad-only
audit, ADB sideload packaging, offline downloads via Media3 `DownloadManager`,
and **Watch Next on both Fire TV and Google TV** via `WatchNextPrograms`.
App-owned preview channels are Google TV only.

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
| Target device RAM assumed rather than measured | Medium | `probe-firetv.sh` reads `MemTotal`; do not plan on the reported 8GB until confirmed |
| **Vega OS ends the Android path on new Fire TV hardware** | **High** | React Native spans Fire OS, Google TV and Vega; WebView and Compose do not |
| Vega playback stack is unproven for this use | High | Vega's media capabilities are not ExoPlayer; verify HEVC/AV1/passthrough before committing to Vega support |
| RN focus engine less expressive than the current one | Medium | `focus/navigation.ts` is discarded work; budget for it rather than discovering it |
| Amazon WebView predates `color-mix()` | Medium | Only matters if WebView is chosen; measurable in minutes |
| AV1 absent on a 1st-gen 4K Max | **High** | Phase 0 probe settles it in minutes; HEVC remains the safe archival codec |
| DTS/TrueHD passthrough weak on Fire TV sticks | Medium | Phase 0 probe reports sink capability; plan around DD+/Atmos |
| Scope inflation across seven media domains | High | Phase 1 ships alone and proves the engine before domains are added |
| Fire TV and Google TV diverge into two apps | Medium | One app; Watch Next is the only Google-TV-only feature |
| Three player surfaces to maintain | Medium | Deprecate `apps/kodi` once the television app ships |
| Podcasts pull backend scope into a player project | Medium | Scope podcast ingest as separate Archivist work, last in sequence |

---

## 11. Open decisions

1. **Which generation is the 4K Max?** Settled by the Phase 0 probe, and it
   decides whether AV1 is a present capability or a forward-looking one.
2. **Is Vega OS in scope?** If yes, React Native is forced and the Vega media
   stack needs its own investigation. If no, WebView becomes defensible again
   and the plan is materially cheaper — but Amazon controls the expiry date.
3. Does Google TV stay a first-class target, or a best-effort second?
4. Do television clients retain the transcode path at all, or is direct play the
   only mode?
5. Does progress remain server-stored for all domains, or do games keep save
   states locally?
6. Is `apps/kodi` deprecated when the television app ships, or maintained as an
   interop surface?
7. Do podcasts belong in Archivist at all, or is subscribing to external feeds
   outside the archive thesis?

---

## Appendix — superseded desktop analysis

An earlier revision proposed an Electron shell with libmpv. Retained only as
rationale for why it does not apply:

- [Certain] Electron does not exist on Android; the shell must be Kotlin.
- [Likely] libmpv is unnecessary because Media3 ExoPlayer supplies Matroska
  demuxing, HEVC/AV1 hardware decode and audio passthrough natively.
- [Likely] The desktop plan's principal risk — compositing a transparent webview
  over a native video surface — is a standard `SurfaceView` pattern on Android,
  and is moot under the React Native and Compose outcomes.

The conclusions that survive every retarget: **do not fork Kodi**, and **extract
the `PlaybackEngine` interface before adding media domains**.

Two corrections to earlier revisions of this document are recorded here rather
than silently edited away:

- **Watch Next was wrongly dropped from Fire TV scope.** It works, Jellyfin uses
  it, and it is restored. The partner-approval requirement applies to Amazon's
  separate Watch Activity SDK, not to `WatchNextPrograms`. See section 3.3.
- **WebView was recommended before Vega OS was accounted for.** Section 5 now
  recommends React Native for TV.
