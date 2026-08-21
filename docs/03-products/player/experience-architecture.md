---
title: "Archivist Player Experience Architecture Specification"
document_type: product-specification
status: historical
classified: 2026-08-16
---
# Archivist Player Experience Architecture Specification

| Field | Value |
| --- | --- |
| Status | Draft for review |
| Version | 0.1 |
| Date | 2026-07-22 |
| Scope | Player reliability, living-room UI, playback services, and migration |

### Implementation status

- 2026-07-22: Phase 1 foundation started. Versioned client capability and playback-plan contracts, strict capability validation, deterministic direct/transcode planning, and `POST /api/v1/player/stream/:type/:id/plan` are implemented.
- Remux remains a declared target mode but is not selected until a real segmented remux transport exists.

## 1. Executive summary

Archivist will combine Jellyfin-class playback reliability and usability with a clean-room visual language derived from the owner's configured Arctic Fuse 3 setup.

This is not a Kodi skin engine, theme platform, or clone. Archivist owns a fixed information architecture, component system, interaction model, and playback stack. Users may control playback behaviour, accessibility, and selected feature visibility, but may not rearrange the interface, construct widgets, install skins, or alter its visual identity.

Playback stability takes precedence over aesthetics. Capability negotiation, stream selection, remuxing, segmented playback, hardware acceleration, recovery, and observability must be hardened before the new presentation layer is completed.

## 2. Current state and problem

Archivist already supports direct play, compatibility transcoding, progress, tracks, chapters, bookmarks, intro/credits handling, loudness normalization, remote navigation, and Channels sessions. Key gaps are:

- Static browser compatibility rules instead of negotiated device capabilities.
- Direct play or transcode, without a mature remux/direct-stream tier.
- Process-oriented transcoding rather than persistent segmented sessions; seeking can restart FFmpeg.
- Incomplete hardware acceleration, HDR/tone mapping, session reuse, and capacity management.
- Immature device pairing and managed TV clients.
- Extensive hub, widget, layout, colour, blur, and details customization that conflicts with a fixed product.
- Insufficient diagnostics for startup delay, stalls, fallbacks, and failures.

## 3. Principles

1. Playback continuity outranks animation and effects.
2. Complexity belongs on the server, not in the viewer's workflow.
3. One intentional interface is preferable to a skin framework.
4. Remote focus behaviour is a first-class contract.
5. Prefer direct play, then remux, then controlled transcode.
6. Keep the video element and active session mounted wherever possible.
7. Optional features must be independently loadable and hideable.
8. Implement Arctic Fuse 3 influence clean-room with Archivist-owned code and assets.
9. Performance budgets are release gates.
10. Playback decisions must be observable and explainable.

## 4. Goals and non-goals

### Goals

- Reliable playback on supported browsers and target TV-class devices.
- Capability-based direct, remux, or transcode selection.
- Segmented playback, stable seeking, cancellation, retry, and capacity control.
- Verified hardware acceleration and HDR/tone-mapping matrix.
- One fixed Archivist design system based on the approved reference.
- Accessibility and meaningful playback preferences.
- Acquisition state integrated without disrupting consumption.
- Measurable responsiveness on modest living-room hardware.

### Non-goals

- Executing Kodi XML, add-ons, Skin Variables, or widget-provider logic.
- User themes, arbitrary layouts, custom CSS, or installable skins.
- Copying Arctic Fuse 3 code, artwork, fonts, or protected assets.
- Immediate parity with every Jellyfin client.
- Native clients for every platform before the core stabilizes.
- Routine codec/transcode complexity in viewer settings.

## 5. Success measures

| Measure | Initial target |
| --- | --- |
| Direct-play startup on LAN | p95 <= 1.0 s after request acceptance |
| Remux startup on LAN | p95 <= 2.0 s |
| Warm hardware-transcode startup | p95 <= 3.0 s |
| Focus response | p95 <= 16 ms; no lost/duplicate action |
| Warm hub transition | p95 <= 500 ms |
| Recoverable interruption | Resume within 5 s |
| Progress durability | <= 10 s beyond last acknowledgement lost |
| Unexpected termination | < 0.5% after stabilization |
| Overlay impact | No sustained dropped-frame regression |

Targets must be re-baselined on representative low-powered hardware.

## 6. Functional requirements

P0 is foundational, P1 is required for product completion, and P2 is later scope.

### Playback

| ID | Priority | Requirement |
| --- | --- | --- |
| PB-001 | P0 | Clients register versioned capabilities covering containers, codecs, profiles, levels, resolution, bitrate, HDR, subtitles, channels, and constraints. |
| PB-002 | P0 | One deterministic service selects direct, remux, or transcode and returns machine-readable and viewer-safe reasons. |
| PB-003 | P0 | Compatibility delivery uses seekable segmented streaming. |
| PB-004 | P0 | Sessions support start, heartbeat, progress, pause, seek, track change, stop, failure, and completion. |
| PB-005 | P0 | The server cancels orphaned work and bounds concurrent transcodes. |
| PB-006 | P0 | Capacity exhaustion queues, degrades within policy, or returns structured retry information. |
| PB-007 | P0 | Progress persists locally and server-side using monotonic conflict rules. |
| PB-008 | P1 | Hardware decode, filtering, tone mapping, and encode use verified host capability. |
| PB-009 | P1 | Track defaults combine user preference, metadata, device capability, and session override. |
| PB-010 | P1 | Text subtitles are converted/cached; incompatible bitmap subtitles may trigger burn-in. |
| PB-011 | P1 | Recoverable manifest, segment, and network failures retry without resetting the UI. |
| PB-012 | P1 | Intro, credits, bookmarks, up-next, still-watching, and post-play share one state machine. |
| PB-013 | P2 | Sync playback, casting, offline, and native clients extend these contracts. |

### User experience

| ID | Priority | Requirement |
| --- | --- | --- |
| UX-001 | P0 | Navigation, hubs, layouts, typography, colour, focus, and motion are fixed and product-owned. |
| UX-002 | P0 | OSD, queue, information, and track controls do not remount video. |
| UX-003 | P0 | Every surface defines directional focus, initial focus, Back, and restoration. |
| UX-004 | P0 | Loading, empty, offline, capacity, unsupported, and recovery conditions have designed states. |
| UX-005 | P1 | Home uses fixed server-backed hubs, not user-created widgets. |
| UX-006 | P1 | Details combine consumption information with concise acquisition state. |
| UX-007 | P1 | OSD prioritizes transport, time, chapters, tracks, and playback information with minimal layers. |
| UX-008 | P1 | Design supports 1080p/4K, safe areas, and distance-appropriate type. |
| UX-009 | P1 | Motion, text/contrast, subtitles, language, autoplay, skip, quality, and OSD timing remain configurable. |
| UX-010 | P1 | Arbitrary accents, blur, layouts, hubs, widgets, and detail rows are retired. |

## 7. Target architecture

```text
Capability profile
       |
       v
View-model API ------> Fixed Archivist UI
       |                       |
       v                       v
Playback decision ---> Client playback state machine
  |       |       |            |
Direct  Remux  Transcode   Session/event API
                  |
                  v
          Hardware/media workers
                  |
                  v
       Metrics, logs, diagnostics
```

- **Playback core:** framework-independent state machine for loading, playing, seeking, buffering, recovery, completion, tracks, heartbeat, and progress. React subscribes and issues commands; it does not own playback policy.
- **Decision service:** normalizes capabilities and policy, probes media, and returns a versioned deterministic plan backed by device fixtures.
- **Session manager:** owns manifests, segments, worker capacity, cancellation, retries, expiry, and cleanup.
- **Media workers:** isolate FFmpeg and hardware configuration with verified platform adapters and explicit fallback.
- **View-model API:** returns presentation-ready home, hub, detail, continuation, and acquisition summaries.
- **Presentation shell:** fixed React navigation, spotlight, rail, grid, detail, dialog, and OSD primitives. Secondary features are code-split.

## 8. Playback plan contract

```ts
type PlaybackPlan = {
  version: 1;
  sessionId: string;
  mode: "direct" | "remux" | "transcode";
  manifestUrl?: string;
  mediaUrl?: string;
  selectedAudioTrackId?: string;
  selectedSubtitleTrackId?: string;
  subtitleMode: "none" | "native" | "convert" | "burn-in";
  videoDecision: { action: "copy" | "transcode"; reason: string };
  audioDecision: { action: "copy" | "transcode"; reason: string };
  hdrDecision: { action: "preserve" | "tone-map" | "not-applicable"; reason: string };
  quality: { width?: number; height?: number; bitrate?: number };
  retryPolicy: { retryable: boolean; retryAfterMs?: number };
};
```

Public contracts contain no raw commands, secrets, paths, or unfiltered probe output. Selection validates access and edition, resolves tracks, matches capabilities, then chooses direct, remux, or the least destructive permitted transcode.

## 9. UI specification

The initial shell contains Home, Films, Series, Music, Channels, Search, and Settings when enabled. Viewers cannot reorder destinations or construct new ones. Home is server-composed from fixed sections such as Continue Watching, Next Up, Recently Added, Recommendations, and acquisition notices.

The configured Arctic Fuse 3 installation is a visual and interaction specification. Extraction documents navigation geometry, spotlight composition, layouts, typography, metadata density, spacing, safe areas, surfaces, focus, OSD, dialogs, system states, and motion. Kodi XML and add-on configuration do not ship; the approved result becomes design tokens, components, an interaction matrix, and visual-regression corpus.

Permitted settings cover languages, subtitles, autoplay, next episode, still-watching, intro/credits, administrator-approved quality, OSD timing, reduced motion, text scaling, and contrast. Prohibited customization includes skins, CSS, fonts, icon packs, arbitrary hubs/widgets/layouts/order, accents, blur/tint/backdrop algorithms, and custom detail composition.

## 10. Performance requirements

- Keep video mounted through overlays and normal transitions.
- Restrict playback animation to transform/opacity unless profiling approves an exception.
- Avoid live backdrop blur and large translucent stacks over video.
- Virtualize grids and bound rail overscan.
- Serve responsive AVIF/WebP artwork with dimensions and cache policy.
- Prefetch predicted navigation only and cancel stale requests.
- Lazy-load settings, people, administration, and non-playback features.
- Use a local/system font or one subset family and an SVG sprite.
- Gate compressed JS/CSS/images, memory, long tasks, and GPU layers in CI after baselining.
- Profile overlays on low-powered target hardware.

## 11. Reliability, security, privacy, accessibility

- Events are idempotent and session-sequenced.
- Segment work uses bounded queues, deadlines, cancellation, quotas, and cleanup.
- Restart leaves no permanent locks; optional service failure cannot block direct play.
- Media, manifests, segments, subtitles, artwork, and sessions require scoped authorization.
- URLs are short-lived or authenticated and do not disclose filesystem paths.
- Pairing codes are single-use and short-lived.
- Probe/FFmpeg output is sanitized; telemetry is local by default.
- Every function works by keyboard and directional remote.
- Focus remains visible; semantics survive TV optimization.
- Reduced motion, text scaling, and readable subtitle controls are supported.

## 12. Observability and validation

Each session correlates client/server events with a non-secret identifier. Diagnostics capture device class, capability/plan versions, decision reasons, probe/plan/manifest/first-frame timings, seeks, recovery, tracks, subtitle mode, worker/hardware path, queues, segment latency, transcode speed, buffering, retries, progress acknowledgements, and terminal outcome.

Validation includes unit fixtures for playback decisions; API contract tests; FFmpeg direct/remux/transcode/subtitle/HDR fixtures; saturation, interruption, cancellation, corruption, restart, and hardware-fallback tests; playback state-machine tests; remote navigation; accessibility; 1080p/4K visual regressions; and bundle/runtime performance gates.

The device matrix includes supported desktop browsers, a low-powered TV target, H.264/HEVC, SDR/HDR, stereo/surround, text/bitmap subtitles, and constrained bandwidth. Each profile has fixtures, an owner, and a last-verified version.

## 13. Migration and rollout

### Phase 0: reference and design freeze

Collect/sanitize Kodi configuration, record every important screen and focus path, approve information architecture/tokens/components, and record asset/font provenance.

### Phase 1: playback reliability

Add capabilities, deterministic planning, remux, segmented sessions, cancellation, queues, retries, diagnostics, and verified hardware/HDR paths. Preserve the current UI while measuring regressions.

### Phase 2: fixed shell

Build navigation, home, hubs, browse, details, search, and system states. Replace custom widgets with fixed server-backed sections, migrate retained settings, and keep a rollback flag during validation.

### Phase 3: playback UI and optimization

Add OSD, track selectors, chapters, queue, and post-play. Validate frame stability, enforce budgets, then remove the old customization schema after the rollback window.

### Phase 4: expansion

Add TV pairing/device administration and evaluate native clients, casting, synchronization, and offline support against demand.

Existing preferences are classified as preserve (playback, language, subtitles, accessibility), convert (feature visibility), or retire (custom hubs/widgets/layouts/colours/effects). Migration is versioned, idempotent, rollback-compatible, and documented.

## 14. Risks and decisions

| Risk | Mitigation |
| --- | --- |
| Visual work precedes hardening | Gate UI rollout on Phase 1 measures |
| Arctic Fuse code/assets are copied | Clean-room work, provenance, permission review |
| Hardware support varies | Verified adapters, self-test, software fallback |
| Capability profiles sprawl | Normalize constraints and use fixtures |
| Fixed UI removes needed settings | Retain behaviour/accessibility; publish migration |
| Rich overlays drop frames | Minimal layers, target profiling, performance gates |
| Segment storage grows | Quotas, expiry, cancellation, startup cleanup |
| Scope expands to full parity | Enforce goals, priorities, and phase criteria |

Architecture decisions: one fixed design system; Arctic Fuse as reference only; playback core separated from React; deterministic server-owned planning; remux as a first-class mode; segmented compatibility delivery; behavioural/accessibility customization only; performance budgets as release gates.

## 15. Acceptance criteria

- P0/P1 requirements pass automated and device tests.
- Direct, remux, and transcode meet approved startup/recovery targets.
- Remote-only navigation completes critical journeys without lost focus.
- UI matches approved 1080p/4K references within documented differences.
- Overlays cause no material dropped-frame regression.
- Preference migration passes representative profiles.
- Operators can diagnose failures from sanitized local diagnostics.
- No Arctic Fuse runtime, code, or unapproved asset ships.

## 16. Required Arctic Fuse 3 package

- `userdata/guisettings.xml`
- `userdata/addon_data/skin.arctic.fuse.3/`
- `userdata/addon_data/script.skinvariables/`
- `userdata/favourites.xml` when used
- Relevant widget-provider config only where it affects content mapping
- Exact Kodi, Arctic Fuse 3, Skin Variables, and provider versions
- Platform, resolution, scaling, safe area, and controller model
- Screenshots/recordings of home, hubs, browse, details, search, dialogs, OSD, up-next, loading, empty, offline, and error states
- A narrated walkthrough explaining choices and Back/focus behaviour

Remove credentials, tokens, cookies, private paths, and unrelated databases.

## 17. Open decisions

- Initial living-room device matrix
- LAN-only versus remote streaming in the first milestone
- Mandatory hardware acceleration platforms
- Initial HDR and tone-mapping matrix
- Whether Music joins the first redesign
- Optional destinations administrators may hide
- Whether Direct/Remux/Transcode is normally visible or information-only
- Font/icon characteristics requiring original replacements

## 18. References

- Jellyfin codec support: <https://jellyfin.org/docs/general/clients/codec-support/>
- Jellyfin transcoding: <https://jellyfin.org/docs/general/post-install/transcoding/>
- Jellyfin hardware acceleration: <https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/>
- Jellyfin clients: <https://jellyfin.org/docs/general/clients/>
- Jellyfin users: <https://jellyfin.org/docs/general/server/users/>
- Jellyfin Quick Connect: <https://jellyfin.org/docs/general/server/quick-connect/>
- Arctic Fuse 3 repository/license: <https://github.com/jurialmunkey/skin.arctic.fuse.3>
- Arctic Fuse 3 screen definitions: <https://github.com/jurialmunkey/skin.arctic.fuse.3/tree/omega/1080i>
- Arctic Fuse 3 shortcuts: <https://github.com/jurialmunkey/skin.arctic.fuse.3/tree/omega/shortcuts>
