---
title: "Server and Player interface parity"
document_type: plan
status: historical
classified: 2026-08-16
---
# Server and Player interface parity

## Decision

The server application is the visual source of truth for the Player. The target is not “similar colours”, a loose family resemblance, or a reinterpretation of a third-party skin. It is a recognisable mirror of the server with playback-facing capabilities in place of acquisition and administration capabilities.

The Player currently diverges structurally even where colour values match. It uses a separate ambient shell, different navigation geometry, oversized cinematic headings, floating docks, pervasive pill controls and its own card/detail compositions. Loading the same fonts and colours does not correct those differences.

## Audited source-of-truth components

The parity baseline is the actual server implementation:

- `client/src/App.tsx` defines the fixed left sidebar, content offset and page padding.
- `client/src/components/Sidebar.tsx` defines brand placement, collapsed/expanded widths, navigation rows, selected states and content-type accents.
- `client/src/components/PageHeader.tsx` defines destination titles, subtitles and tabs.
- `client/src/components/ui.tsx` defines library cards, filters, status badges, search, empty states, dialogs and media detail primitives.
- Server Film and Series pages define the authoritative detail hierarchy, metadata ordering, poster/backdrop treatment and nested season/episode patterns.

Player components should reuse shared primitives where feasible and otherwise reproduce their measured composition. A separate Player design system is not an acceptable long-term state.

## Typography contract

The three families are not interchangeable style options. Each has a fixed semantic job.

| Role | Typeface | Server treatment to mirror |
|---|---|---|
| Brand and display | Bebas Neue | Wordmark, page titles, entity/card titles, large display values and status labels; normally uppercase with deliberate tracking |
| Interface and prose | DM Sans | Body copy, synopsis, ordinary actions, form values and readable supporting content |
| Metadata and system | JetBrains Mono | Dates, runtimes, episode codes, technical values, secondary card lines, compact labels and machine/status detail |

Rules:

- Importing the family is insufficient; components must assign the same semantic role as the server.
- Player destination and entity headings must not silently fall back to bold DM Sans when the equivalent server heading uses `font-display`.
- Metadata, dates, stream details and compact labels use the server's mono/uppercase/tracking conventions.
- Button casing, weight and tracking follow the corresponding server control. The Player does not introduce title-case pill controls as a default style.
- Fonts must ultimately be self-hosted so both apps render identically without internet access.

## Layout contract

### Application shell

- Mirror the server's fixed left sidebar, actual Archivist mark, collapsed/expanded widths, border, surface and selected-row treatment.
- Mirror the server's content offset and responsive page-padding logic.
- Do not place an ambient focused-item backdrop behind the entire application shell.
- Player navigation destinations differ by job, but their row geometry, typography, icon treatment and state language do not.
- Remote focus may add a stronger cyan outline and slightly larger target without changing the underlying component.

### Browse and Home

- Use the server's `PageHeader`, panel, grid, section-label and `LibraryCard` grammar.
- Home is the playback analogue of the server Dashboard, not a separate streaming-service spotlight template.
- Cards retain the server's radius, border, image opacity, title block, display-title and mono-subtitle pattern.
- Horizontal rails may be used where remote navigation requires them, but the card itself and its surrounding section heading remain Archivist components.
- No generic full-width hero or focused-art backdrop is part of the default Home shell unless an equivalent server composition is adopted in both apps.

### Detail surfaces

- Start from the server `DetailPage`, `DetailHeader`, `DetailPoster`, `DetailMain`, `DetailStoryline` and `DetailMetaItem` composition.
- Use the same backdrop height, scrim recipe, poster sizing, maximum width, spacing and title roles at equivalent breakpoints.
- Replace acquisition actions with Play, Resume, Restart, Edition and Media controls in the same action region.
- Player-only episode, track and playback surfaces use the server modal/drawer language rather than a separate floating-glass system.
- Full-screen playback and its OSD are valid Player-only layouts; the browsing/detail shell is not.

## Capability substitution map

| Server capability | Player mirror |
|---|---|
| Add, search or automatic scan | Play, Resume or Restart |
| Quality/tier selection | Edition/version selection |
| Download status | Availability, progress and playable state |
| File/track maintenance | Audio, subtitle and chapter selection |
| Monitoring controls | Watched state and next-up behaviour |
| Metadata edit/refresh | Read-only information and relationship navigation |
| Processing queue | Read-only processing availability where useful |

The substitution changes the task, not the component family.

## Shared foundations

| Token family | Locked direction |
|---|---|
| Canvas | `#0A0A0F` |
| Surfaces | `#111118`, `#1A1A24`, `#242430` plus server-defined alpha variants |
| Foreground | Server semantic white opacities |
| Focus/action | cyan `#00D4FF` |
| Secondary brand | violet `#9B59B6` |
| Error/destructive | pink `#FF2D78` |
| Film / Series / Music | cyan / violet / pink |
| Books / Comics / Games | `#F1C40F` / `#E67E22` / `#2ECC71` |

Colour is one input to the system, not the system itself. Parity also requires typography roles, spacing, dimensions, borders, radii, image treatment, control grammar, iconography and state behaviour.

## Permitted Player exceptions

- A visible D-pad focus state stronger than server hover.
- Minimum target enlargement required for television distance or accessibility.
- Television safe-area padding when device overscan requires it.
- Full-screen playback, OSD, Up Next and stream selection flows that have no server equivalent.
- Hiding unavailable media outside Downloads.

Each exception must be explicit and should still use Archivist tokens, type roles and primitives. “More cinematic” is not an exception.

## Implementation order

1. Capture reference screenshots and computed measurements for server Home/Dashboard, Films, Series, Film detail, Series detail, modal and Settings.
2. Share or port the server Sidebar, PageHeader, LibraryCard, status, dialog and detail primitives.
3. Assign Player content to the exact typography roles above.
4. Replace the ambient shell and bespoke Home spotlight with the server page frame and dashboard grammar.
5. Replace bespoke Player detail/dock/button composition with the server detail grammar and playback substitutions.
6. Replace raw glyphs and divergent controls with the server icon and control treatments.
7. Self-host fonts and add paired visual-regression fixtures.

## Acceptance criteria

- Without logos or colour accents, paired screenshots still share the same typography, spacing, shell, card, surface and control grammar.
- Player and server page headings use the same family, casing and tracking.
- The Player sidebar and content frame align with the server at matching desktop widths.
- Film and series cards are structurally equivalent across apps.
- Film and series detail pages share the same measured header and content composition; only their actions differ.
- No Player preference changes brand, typography, colour, surface, radius, layout or hub composition.
- Exceptions for remote focus and playback are documented and visually tested.
