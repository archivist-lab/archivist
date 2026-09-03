---
title: "Archivist Player — Native Shell Architecture"
document_type: product-specification
status: proposal
updated: 2026-09-03
evidence:
  - apps/player/src/components/Player.tsx
  - apps/player/src/components/SessionPlayer.tsx
  - apps/player/src/styles/tokens.css
  - packages/design-system/tokens.css
  - apps/server/src/player/media.ts
  - apps/server/src/player/playback-plan.ts
  - apps/server/src/player/routes.ts
  - apps/kodi/resources/lib/archivist
---

# Archivist Player — Native Shell Architecture

Proposal for a native, HEVC/AV1-capable Player that preserves the existing
visual language and extends the consumption surface to music, audiobooks,
podcasts, retro games and ebooks.

## Confidence markers

- **[Certain]** — grounded in this repository or in verifiable platform behaviour.
- **[Likely]** — strong inference from the evidence above.
- **[Guessing]** — directional; needs a spike to confirm.

---

## 1. Decision summary

**Build an Electron shell around the existing `apps/player` React application,
and replace the HTML5 `<video>` element with libmpv. Do not fork Kodi.**

| Layer | Choice | Reason |
| --- | --- | --- |
| Shell | Electron | One Chromium on all platforms — the existing styling renders identically everywhere |
| A/V engine | libmpv | Demuxes MKV; decodes HEVC/AV1/VVC, DTS-HD/TrueHD/Atmos; HDR tone-mapping; libass |
| UI | `apps/player`, unchanged | Tokens, Tailwind, focus model and component tree carry over verbatim |
| Games | EmulatorJS (v1) → libretro (v2) | Already working in `Arcade.tsx`; native cores are a later upgrade |
| Books/comics | webview reader (foliate-js, pdf.js) | Rendering documents is a web problem; it belongs in the webview |
| Backend | `/api/v1/player/*` | Already mature; needs capability-aware planning and new media domains |

The architectural line is simple: **the webview does everything except A/V decode.**

---

## 2. Why not a Kodi skeleton

[Certain] Kodi's presentation layer is an XML skinning engine with its own
layout and animation DSL. None of the current styling survives the move:
`packages/design-system/tokens.css` (371 lines of `--archivist-*` custom
properties), `apps/player/src/styles/tokens.css`, `combined.css`, and roughly
812 `className` sites across `apps/player/src`. "Kodi skeleton" and "maintain
the styling I currently have" are mutually exclusive requirements at the
presentation layer.

[Certain] `apps/player` is already a working product — approximately 7,900 LOC
with home hubs, browse and filtering, film/series/episode/person detail,
recommendations, Leaving Soon, box sets, shelves, bookmarks, programmed
channels, play sessions, offline sync manifest, telemetry, spatial remote
navigation, text scaling and high contrast. `apps/kodi` is a second player
surface. A Kodi fork would be a third surface to keep in sync.

[Likely] The only part of Kodi worth having is its playback core, which is
substantially ffmpeg plus a windowing and render layer. libmpv provides the
same capability behind a small C API. Forking Kodi to obtain it means adopting
roughly two million lines of C++ whose architecture exists to serve the skin,
addon, scraper and source customisation that this product explicitly does not
want.

[Certain] Kodi is GPLv2. This repository is GPLv3. Deriving from Kodi would
constrain relicensing options permanently for a capability obtainable without
that constraint.

**What is worth taking from Kodi** is its `IPlayer` abstraction — a single
player interface with distinct video, audio and game implementations. See
section 5.

---

## 3. The constraint that decides the architecture

The problem is commonly stated as "browsers can't decode HEVC." That
understates it. Three independent barriers exist, and codec support only
addresses one:

| Barrier | Chromium | Consequence |
| --- | --- | --- |
| Container | No Matroska demuxer [Certain] | MKV files never play, whatever the codec |
| Video | AV1 yes; HEVC hardware-only where the OS provides a decoder [Likely] | Unreliable across the target platforms |
| Audio | No DTS, no TrueHD, no Atmos; AC3/E-AC3 not enabled in stock builds [Certain] | Silent playback on typical library files |

[Certain] `apps/server/src/player/media.ts` already encodes this reality:
`BROWSER_VIDEO` excludes HEVC, `BROWSER_AUDIO` excludes AC3/E-AC3/DTS, and the
system falls back to an ffmpeg transcode to H.264 plus stereo AAC.

[Certain] Because the container barrier is absolute, **no Electron flag,
`PlatformHEVCDecoderSupport` feature, or WebCodecs path resolves this.** A real
media engine is required.

[Certain] libmpv clears all three barriers: full ffmpeg demux including
Matroska; HEVC, AV1, VVC, VP9; DTS-HD, TrueHD and Atmos with bitstream
passthrough; hardware decode through VideoToolbox, D3D11VA and VAAPI/NVDEC;
HDR passthrough and libplacebo tone-mapping; ASS/SSA subtitles via libass and
bitmap PGS/VobSub; ReplayGain and gapless audio.

[Likely] mpv is GPLv2+, compatible with this repository's GPLv3. An LGPL build
is available if licensing flexibility later matters.

---

## 4. Shell selection

**Recommendation: Electron.** [Likely]

The requirement is styling fidelity. Tauri uses the platform webview —
WebKitGTK on Linux, WKWebView on macOS, WebView2 on Windows — which means the
existing Tailwind utilities, CSS custom properties, `color-mix()` usage,
`@media (min-aspect-ratio)` queries and focus-ring treatment would need
validating and maintaining against three separate rendering engines. Electron
pins one Chromium build across all targets. Binary size, Tauri's main
advantage, is irrelevant for an application installed once on a living-room
device.

Electron additionally provides an in-process Node runtime for mpv IPC, local
file access for manual libraries, and a local HTTP shim if one is needed.

### The principal technical risk

[Likely] Compositing a transparent webview over the mpv video surface is the
single highest-risk element of this design. mpv paints into a native surface;
the React OSD must float above it with alpha. The approaches, in order of
preference:

1. `--wid` embedding — mpv renders into a child native window handle (HWND on
   Windows, NSView on macOS, X11 window on Linux) beneath a transparent
   `BrowserWindow`.
2. Two stacked frameless windows — mpv below, transparent Electron above.
3. `mpv_render_context` into a shared GPU texture composited by the shell.

[Guessing] Wayland is the most likely failure point; X11, Windows and macOS are
expected to behave.

**Mitigation.** Spike this in week one across all three targets before any
other work. If Electron cannot hold the composite, fall back to Qt6
`QWebEngineView` plus libmpv — the arrangement Jellyfin Media Player uses in
production. That fallback is still Chromium, so the React bundle and the
styling survive intact either way. The UI investment is protected under both
outcomes; only the shell language changes.

---

## 5. Playback engine abstraction

[Certain] `Player.tsx` (521 lines) and `SessionPlayer.tsx` (399 lines) contain
overlapping direct-play/transcode/track-selection logic today.

[Likely] Consolidate both behind one interface **before** adding five media
domains, or the same fallback logic will be reimplemented per domain.

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

Three implementations:

| Implementation | Serves | Backend |
| --- | --- | --- |
| `MpvEngine` | film, series, music, audiobook, podcast | libmpv IPC |
| `LibretroEngine` | retro games | EmulatorJS (v1), libretro cores (v2) |
| `ReaderEngine` | ebooks, comics | foliate-js, pdf.js, CBZ/CBR unpacker |

[Likely] A single `HtmlVideoEngine` implementation retains the existing browser
build (section 8) with no divergence in the UI layer.

[Likely] Routing all audio through mpv is a direct upgrade: the client-side Web
Audio normalisation in `useMediaGain.ts` is superseded by mpv's `replaygain`
and `loudnorm`, and gapless playback becomes available for albums and
audiobook chapters — something the current `<audio>`-shaped approach cannot
offer.

---

## 6. Media domain coverage

| Domain | Backend today | Player API today | Work required |
| --- | --- | --- | --- |
| Films | Complete | Complete | Direct-play plan only |
| Series | Complete | Complete | Direct-play plan only |
| Music | Complete (artists/albums/tracks) | **Absent** | Player API surface, hubs, queue, gapless |
| Audiobooks | Book editions carry audiobook formats | **Absent** | Chapter model, position resume, speed control |
| Podcasts | **Absent everywhere** | **Absent** | Full domain: subscriptions, RSS ingest, episodes, retention |
| Retro games | Library + arcade routes | Arcade only | Promote out of the Konami easter egg; save states |
| Ebooks | Book editions, `/stream/book-editions/:id` | Stream only | Reader, position sync, library shape |
| Comics | Comic series/issues | **Absent** | Reader, page position sync |

[Certain] Podcasts are the only requested domain with no backend at all.
Subscription management, RSS polling, episode ingest and retention are
Archivist-side work, not player work, and should be scoped separately.

[Likely] Audiobooks currently exist as a book *edition format* rather than a
first-class domain. Consumption needs a chapter model and second-resolution
position resume that the book edition shape does not currently express.

---

## 7. Server-side changes

1. **Capability-aware stream planning.** `playback-plan.ts` decides between
   direct play and transcode from browser assumptions. The native client must
   declare its own profile (`container: any`, `video: any`, `audio: any`) so
   the server never proposes a transcode. This is the single change that makes
   HEVC/AV1 native playback work end to end. [Certain]
2. **Extend `PlayerMediaType`.** Currently `'film' | 'series' | 'episode' |
   'collection' | 'download'` in `packages/contracts/src/player.ts`. Needs
   `track`, `album`, `audiobook`, `podcast-episode`, `book`, `comic`, `game`.
   [Certain]
3. **Progress model.** Extend beyond seconds-into-video: reading position for
   books and comics, chapter plus offset for audiobooks, save state for games.
4. **Browse and hub services** for the new domains, mirroring
   `browse-service.ts` and `hub-service.ts`.
5. **Stream endpoints** for tracks, audiobook files, podcast episodes and comic
   archives, with range support matching the existing film/episode handlers.
6. **Scoped player tokens.** Native clients on shared devices should not carry
   the admin API key. Pairing-code flow with a read/play/progress scope.

The transcode path is retained, not removed — it remains correct for the
browser build and for remote access over constrained links.

---

## 8. Build targets

[Likely] The native shell should be a build target of `apps/player`, not a new
application.

```
apps/player/
  src/                     shared UI — one codebase
  src/playback/
    engine.ts              PlaybackEngine interface
    html-video.ts          browser build
    mpv.ts                 native build
  shell/                   Electron main process, mpv IPC, packaging
```

| Target | Engine | Use |
| --- | --- | --- |
| Browser (`vite build`) | `HtmlVideoEngine` + transcode fallback | Remote, casual, any device |
| Native (`electron-builder`) | `MpvEngine`, direct play only | Living room |

[Likely] Once the native shell ships, `apps/kodi` should be deprecated rather
than maintained as a third surface. Retain it only if Kodi interoperability is
a deliberate product commitment.

---

## 9. Phasing

**Phase 0 — Composite spike (1 week).** Electron plus mpv overlay on Windows,
macOS and Linux/Wayland. Decide Electron or Qt6 fallback. No other work starts
until this resolves.

**Phase 1 — Native film and series.** `PlaybackEngine` extraction, `MpvEngine`,
capability-aware stream planning, OSD wired to mpv state, track and subtitle
selection through mpv, HDR verification. Exit criterion: a 4K HEVC MKV with
TrueHD audio direct-plays with zero server CPU.

**Phase 2 — Music and audiobooks.** Player API for artists/albums/tracks,
queue and gapless playback, ReplayGain, audiobook chapters, speed control,
now-playing UI.

**Phase 3 — Books and comics.** Reader engine, EPUB and PDF, CBZ/CBR, position
sync, reading-progress hubs.

**Phase 4 — Games.** Promote the arcade out of the Konami code, libretro cores,
save states, controller mapping.

**Phase 5 — Podcasts.** Archivist-side subscription and RSS ingest first, then
the player surface.

[Likely] Phases 2–5 are independently shippable once Phase 1 establishes the
engine abstraction; the ordering above reflects value per unit of work, not a
hard dependency chain.

---

## 10. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Webview/mpv compositing fails on a target | High | Phase 0 spike; Qt6 WebEngine fallback preserves the UI investment |
| Native shell diverges from the browser build | Medium | One codebase, two engines behind one interface |
| Scope inflation across seven media domains | High | Phase 1 must ship alone and prove the engine before domains are added |
| Three player surfaces to maintain | Medium | Deprecate `apps/kodi` once native ships |
| mpv GPLv2 licensing | Low | Compatible with this repository's GPLv3; LGPL build available |
| Podcasts pull backend scope into a player project | Medium | Scope podcast ingest as separate Archivist work, last in sequence |

---

## 11. Open decisions

1. Electron or Qt6 — resolved by the Phase 0 spike, not by discussion.
2. Do native clients ship with the transcode path available at all, or is
   direct play the only mode?
3. Does progress remain server-stored for all domains, or do games keep save
   states locally?
4. Is `apps/kodi` deprecated on native ship, or maintained as an interop
   surface?
5. Which platforms are actually targeted first? Living-room hardware choice
   materially changes the hardware-decode and packaging work.
6. Do podcasts belong in Archivist at all, or is subscribing to external feeds
   outside the archive thesis?
