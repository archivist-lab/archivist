---
title: "Archivist Style and Branding Review"
document_type: assessment
status: historical
classified: 2026-08-16
---
# Archivist Style and Branding Review

Date: 28 July 2026

## Executive assessment

Archivist has a clear and distinctive brand, but it is not yet a unified design system.

The server item pages establish the strongest identity: restrained cyber-noir surfaces, small technical typography, disciplined cyan and violet accents, editorial artwork, and a dense information hierarchy. The Player shares the palette and shell, but its detail pages, dialogs, settings, controls, and interaction effects still resemble a generic streaming interface.

Overall convergence:

| Area | Alignment | Assessment |
|---|---:|---|
| Color foundations | 85% | Shared palette is strong |
| Fonts | 70% | Same families, inconsistent semantic use |
| App shell and navigation | 90% | Closest match |
| Browse and page headers | 85% | Mostly aligned |
| Media cards | 60% | Typography matches; construction differs |
| Film and series detail | 30% | Largest brand divergence |
| Settings and forms | 40% | Different component language |
| Dialogs and drawers | 40% | Player uses a separate system |
| Motion and focus | 65% | Good accessibility foundation, overly cinematic |
| Responsive behavior | 50% | Server is responsive; Player is TV-centric |
| Shared implementation | 35% | Tokens shared, components duplicated |

The main conclusion is that the Player is wearing Archivist colors, but only portions of it are actually built from Archivist's visual grammar.

## The canonical Archivist brand

The server film and series item pages define this system:

- Canvas: `#0A0A0F`
- Surfaces: `#111118`, `#1A1A24`, `#242430`
- Film and action cyan: `#00D4FF`
- Series violet: `#9B59B6`
- Music pink: `#FF2D78`
- Display typography: Bebas Neue, uppercase, with wide or deliberately tight tracking
- UI and prose: DM Sans
- Technical metadata: JetBrains Mono
- Item-page labels: approximately `10.5px`, uppercase mono, `white/40`
- Item-page values: approximately `12.5px`, DM Sans, medium, white
- Page titles: Bebas Neue `text-5xl`
- Layout: maximum width `1600px`, using a 12-column editorial grid
- Surfaces: subtle borders, low-opacity noir panels, and restrained blur
- Controls: predominantly rounded rectangles with uppercase compact labels
- Artwork: poster-led, controlled backdrops, and a clear hierarchy rather than a full streaming-service takeover

The authoritative implementation is in:

- `archivist/client/src/modules/films/index.tsx`
- `archivist/client/src/modules/series/index.tsx`
- `archivist/client/src/components/ui.tsx`

## What is aligned

### Foundations

Both applications import the same three typefaces and the shared token file. Canvas, noir surfaces, foreground opacities, category colors, radii, and focus color are centrally defined in `archivist/packages/design-system/tokens.css`.

Both applications also share:

- The same scrollbar treatment
- The same 85% desktop presentation scale
- Cyan as the principal interaction color
- Violet for series
- Pink for destructive and high-priority actions
- Subtle `white/5` and `white/10` borders
- `rounded-xl` as a common card radius

### Sidebar and brand mark

The Player sidebar is a close reproduction of the server sidebar:

- Same Archivist mark
- Same expanded and collapsed width behavior
- Same 48px logo
- Same Bebas Neue gradient wordmark
- Same 44px navigation rows
- Same active cyan and violet states
- Same low-contrast inactive state

The relevant implementations are `archivist/client/src/components/Sidebar.tsx` and `archivist/apps/player/src/components/Shell.tsx`. This is the best-converged component family.

### Page frame and browse headings

The Player's v2 shell uses the same content offset and `p-4 lg:p-6` page padding as the server. Browse, Search, Settings, TV Guide, and Home generally use:

- Bebas Neue `text-5xl`
- Uppercase headings
- Wide tracking
- Category accent colors
- Small mono subtitles

The v2 Browse page is particularly close to the server's `PageHeader` component.

### Card typography

Player cards correctly use:

- Bebas Neue for titles
- 13px uppercase, tracked titles
- JetBrains Mono at 10px for metadata
- 2:3 poster ratios
- `rounded-xl`
- Cyan progress indicators

Those roles match the server's `LibraryCard`.

### Playback-specific elements

The Player's strong focus ring, D-pad focus management, minimum control size, OSD, Up Next, track selection, and progress state are legitimate Player-specific additions. They should remain while adopting the same type, color, and surface grammar as the server.

## What is not aligned

### Film and series detail pages

This is the largest difference.

The server uses an editorial 12-column layout:

- Poster on the left
- Overview and metadata in the center
- Logo or title and secondary identity on the right
- Compact 10.5px labels and 12.5px values
- Cast presented as small square portraits
- Thin section dividers and restrained headings
- Technical detail treated as a first-class part of the page

The Player uses a streaming hero:

- A `72vh` full-width artwork area
- The title in bold DM Sans at up to roughly 6rem
- A poster isolated on the far right
- Large horizontal action pills
- Ratings presented as pill badges
- A floating `rounded-3xl` detail dock
- Large DM Sans section headings with colored vertical bars
- Side drawers and cinematic episode dialogs

The relevant Player implementation is `archivist/apps/player/src/components/DetailSurface.tsx`. Its title, hero proportions, action treatment, and section grammar are all outside the server standard.

The Player detail pages should instead share the server item-page composition, substituting capabilities as follows:

| Server capability | Player equivalent |
|---|---|
| Acquisition actions | Play, Resume, Restart |
| Quality profile | Edition and media selection |
| File maintenance | Audio, subtitle, and chapter selection |
| Monitoring controls | Watched state and next-up behavior |

The job changes; the component family should not.

### Media cards

Player card typography is aligned, but card construction is not.

Server cards have:

- Artwork at roughly 80% opacity
- A contained noir footer
- Title, subtitle, and status inside that footer
- Category and status tinting
- A consistent fixed composition

Player poster cards place title and metadata outside the artwork. The newer `MediaCard` overlays most information onto images and varies substantially among poster, wall, landscape, and list modes.

The server card should become the canonical base, with optional Player slots for:

- Watched indicator
- Playback progress
- Availability
- Remote focus

Horizontal rails are appropriate for television navigation. Divergent cards inside those rails are not necessary.

### Controls

The server predominantly uses compact rounded rectangles:

- `rounded-lg`, `rounded-xl`, or `rounded-2xl`
- 10px to 10.5px labels
- Uppercase text
- Wide tracking
- Cyan fill or a tinted border

The Player uses `rounded-full` extensively, especially for actions, selectors, filters, dialogs, and settings. This produces a softer streaming-service aesthetic.

Pills should be retained only where the server already establishes them: back controls, compact state chips, toggles, and isolated playback controls. Ordinary buttons and segmented controls should use the server's rectangular grammar.

### Settings and forms

The Player Settings title is aligned, but the contents are not. The Player uses:

- Large DM Sans section headings
- A `rounded-3xl` content container
- White filled pill buttons
- Numerous pill toggles
- Forms implemented separately from the server's `Field`, `Input`, `Select`, `TabSelect`, and `Toggle`

Player Settings should use the same panel, field, segmented-control, toggle, and action components as server Settings.

### Dialogs and drawers

The server modal language is:

- A noir-800 surface
- `rounded-2xl`
- A subtle border
- A Bebas Neue heading
- A compact header
- A centered desktop modal or mobile bottom sheet

The Player uses right-side drawers, `rounded-3xl` or 2rem dialogs, bold DM Sans headings, and large pill actions.

Drawers can remain where television navigation benefits from them, but their internal header, fields, borders, typography, and controls should use the server modal language.

### Cast and people

Server item pages use compact 87px square portraits with uppercase 9.5px names. Player detail pages use 128px, 3:4 portraits with larger sentence-case DM Sans text.

This materially changes the density and personality. The server pattern should be reused, with slightly larger focus targets around, rather than inside, the visual component.

### Motion and focus

Player focus currently scales focused cards to `1.075`, dims siblings to `0.58`, and reduces their saturation. That is more dramatic than the server's restrained hover and glow behavior.

The strong cyan focus ring should remain, but visual disruption should be reduced:

- Scale closer to `1.025` to `1.04`
- Do not globally desaturate siblings
- Do not reduce sibling opacity below approximately `0.8`
- Use a cyan border and glow as the dominant focus signal

### Responsive scale

The server applies `zoom: 0.85` only at desktop widths. The Player applies it unconditionally. This causes smaller browser and tablet targets and means the applications no longer match below 1024px.

The Player should follow the same breakpoint rule or establish an explicit television viewport mode rather than changing the entire document at every width.

### Legacy Player

When `uiV2Enabled` is false, the application still exposes a top-navigation legacy interface with bold DM Sans headings and streaming-style controls in `archivist/apps/player/src/App.tsx`.

Branding therefore changes depending on a feature flag. The legacy branch should either be retired or routed through the same shared shell and primitives.

## Design-system problems affecting both apps

### Tokens are shared; components are not

The shared package only defines foundational CSS variables. Sidebar, cards, headings, modals, buttons, filters, empty states, and detail layouts are duplicated.

Create an `@archivist/ui` package containing:

- `BrandMark`
- `AppSidebar`
- `PageHeader`
- `MediaCard`
- `StatusBadge`
- `SectionLabel`
- `MetaLabel` and `MetaValue`
- `Button`
- `SegmentedControl`
- `Field`, `Input`, `Select`, and `Toggle`
- `ModalSurface` and `DrawerSurface`
- `EmptyState`
- `Skeleton`
- `DetailScaffold`

Components can support `density="server" | "player"` where television needs larger hit areas, without changing their visual grammar.

### Excessive hardcoded colors

The server contains roughly 500 direct `#00D4FF` references and over 100 direct `#9B59B6` references. This prevents semantic evolution and makes consistency difficult to enforce.

Replace direct color references with semantic names such as:

- `--color-action`
- `--color-media-accent`
- `--color-success`
- `--color-warning`
- `--color-danger`
- `--color-text-primary`
- `--color-text-secondary`
- `--color-text-metadata`

### Fonts depend on Google Fonts

Both applications load fonts from Google. Offline or blocked-network use can silently replace the brand typefaces. WOFF2 files should be self-hosted and preloaded from the shared design package.

### Low-contrast microcopy

The gold-standard item pages frequently combine 10px to 10.5px text with `white/30` or `white/40`. On the noir canvas, some of this falls below accessible contrast for normal text.

The muted appearance can be preserved while raising informational text to approximately `white/55` to `white/60`. `white/30` to `white/40` should be reserved for decorative or genuinely nonessential content.

### Iconography is platform-dependent

Both sidebars use emoji. Emoji appearance changes by operating system, which weakens brand consistency. The Player already has a vector icon component; this should become a shared icon set used by both applications.

### Appearance preferences are disconnected from the brand contract

The Player exposes accent color, artwork blur, and dialog tint preferences. The current Player token CSS fixes `--player-accent` to Archivist cyan and `--player-artwork-blur` to zero, and there is no clear runtime application of those preferences in the v2 shell.

This produces two problems:

- The settings suggest customization that may not take effect consistently.
- If fully enabled, arbitrary accent customization would undermine category and brand semantics.

The recommended direction is to remove arbitrary brand-accent customization. If a configurable focus color is retained for accessibility, it should affect only the focus indicator and should not replace film, series, status, or action colors.

## Target component mapping

| Current server component | Current Player equivalent | Target |
|---|---|---|
| `Sidebar` | `SideRail` | One shared `AppSidebar` |
| `PageHeader` | Per-page headings | One shared `PageHeader` |
| `LibraryCard` | `PosterCard` and `MediaCard` | One `MediaCard` with playback slots |
| `CollectionFilterBar` and `TabSelect` | Pills and alphabet buttons | Shared segmented-control grammar |
| `Modal` | `DetailDrawer`, dialogs, options drawer | Shared modal surface with drawer variant |
| `DetailPage` and item-page grid | `DetailHero`, `DetailDock`, `DetailSection` | Shared `DetailScaffold` |
| `StatusBadge` | Availability and watched treatments | Shared status vocabulary |
| `Field`, `Input`, `Select`, `Toggle` | Player-specific fields and pills | Shared form primitives |
| Server cast cards | `PeopleRow` | Shared people-card primitive |
| Server section labels | Large Player section headings | Shared compact section hierarchy |

## Recommended convergence order

1. Lock a written token contract for type roles, text opacity, spacing, radius, elevation, control heights, and motion.
2. Self-host the three fonts.
3. Extract the shared sidebar, page header, card, button, segmented control, form, modal, and status components.
4. Replace Player cards with the canonical server card plus playback-state slots.
5. Rebuild Player film and series detail pages on a shared `DetailScaffold` matching the server's 12-column layout.
6. Convert Player Settings and browse drawers to the server form and modal grammar.
7. Retire or restyle the legacy Player branch.
8. Reduce Player focus scale and sibling dimming while retaining the cyan focus ring.
9. Replace emoji and raw glyph navigation with shared SVG icons.
10. Add paired server and Player screenshot tests at desktop, 1080p TV, 4K TV, tablet, and mobile widths.

## Suggested delivery phases

### Phase 1: Foundation

- Expand the design-system tokens
- Self-host fonts
- Define semantic typography utilities
- Define the radius, surface, control, focus, and motion contracts
- Add linting or review rules discouraging new hardcoded brand colors

### Phase 2: Shared primitives

- Extract the brand mark and sidebar
- Extract page headings and section labels
- Extract buttons, fields, selectors, toggles, dialogs, status badges, and empty states
- Introduce density variants for server and television contexts

### Phase 3: Browse convergence

- Replace Player poster and media cards
- Align filters and sorting controls
- Preserve horizontal rails while adopting canonical card construction
- Align loading, empty, unavailable, watched, and progress states

### Phase 4: Detail convergence

- Introduce the shared 12-column `DetailScaffold`
- Move Player film details to the canonical hierarchy
- Move Player series details and episode navigation to the same hierarchy
- Substitute playback capabilities into the server action regions
- Retain fullscreen playback and the OSD as explicit Player-only surfaces

### Phase 5: Settings and secondary surfaces

- Align Player Settings with server form components
- Align search, person, channels, browse options, and media-selection surfaces
- Remove obsolete appearance controls and the legacy visual branch

### Phase 6: Verification

- Create deterministic shared media fixtures
- Capture paired server and Player screenshots
- Test typography, spacing, component geometry, focus, contrast, and responsive behavior
- Prevent independent visual changes from landing without paired review

## Acceptance criteria

- Player and server page headings use the same family, casing, scale, and tracking.
- The sidebar and content frame align at matching desktop widths.
- Film and series cards are structurally equivalent across both applications.
- Film and series details share the same poster, backdrop, metadata, and section composition; only their task-specific actions differ.
- Metadata uses JetBrains Mono consistently and prose uses DM Sans consistently.
- Rounded pills are no longer the default Player control shape.
- Player preferences cannot alter core brand or category semantics.
- Remote focus is clear without substantially dimming or desaturating the rest of the interface.
- Both applications render correctly without internet access.
- Informational microcopy meets accessible contrast requirements.
- Shared components have paired visual-regression coverage.
- Fullscreen playback and the OSD remain documented Player-only exceptions.

## Final direction

Archivist should feel like one product with two jobs:

- The server is the curatorial and administrative workspace.
- The Player is the public gallery and playback surface.

Density, interaction distance, and capabilities can differ. Typography roles, layout grammar, cards, surfaces, controls, iconography, color semantics, and brand expression should not.

## Implementation status — 28 July 2026

The first six convergence slices described in this review are now implemented:

- Shared semantic design tokens now define Archivist typography, surfaces, action/focus color, contrast, controls, shadows, and motion for both applications.
- Both frontends now bundle Bebas Neue, variable DM Sans, and variable JetBrains Mono through Fontsource; all Google Fonts imports, stylesheet links, and preconnects have been removed.
- Server and Player page-title and section-label roles now share the same Bebas Neue and JetBrains Mono hierarchy.
- Player appearance preferences no longer expose brand-breaking accent, density, card-radius, or background choices.
- Player browse and hub media cards now follow the server card anatomy: subdued artwork, noir information footer, Bebas title, mono metadata, compact state slots, and restrained focus scaling.
- Player film and series detail pages now follow the server item-page grammar: editorial poster/content/identity grid, compact metadata, rectangular controls, ruled section headings, noir utility panels, square people tiles, compact season navigation, and server-style episode information dialogs.
- Player Settings, Search, Browse options, TV Guide, person details, and media selection now use shared server-aligned panels, fields, control labels, segmented choices, actions, empty states, and dialog hierarchy.
- Settings establishes a deterministic active-section focus target, free-text fields no longer trap remote spatial navigation, and its action row remains navigable as a coherent group.
- Playback, progress, track selection, watched state, remote focus, missing-art fallbacks, and dialog focus restoration remain Player-specific functional behavior.
- A deterministic “The Archive” film fixture now drives paired server and Player detail coverage at 1920×1080 and 834×1112, using the same title, artwork direction, overview, release facts, quality, and edition data.
- The server film detail keeps its canonical 3/6/3 desktop grid and now changes to a composed 4/8 tablet grid, with the identity/logo row following beneath it; narrow padding also scales down instead of forcing desktop gutters.
- Artwork logos no longer replace document structure: server and Player film details expose exactly one semantic H1 while treating the visible logo as decorative artwork.
- The server poster edit surface is now a labelled native button, trailers have an accessible label, and every standard server interactive control receives the shared cyan keyboard focus outline.
- The film page’s 29 informational metadata labels now use the shared section-label role and accessible muted-text token; 40%-white remains available only for decorative content.

Verification completed after the convergence work:

- Server-client TypeScript and production build pass.
- Player TypeScript and production build pass.
- All 30 Player unit/component tests pass.
- Six Player end-to-end cases pass against an isolated current-source Vite instance, including the complete remote-only journey.
- Two server-client film-detail audits pass at 1080p and tablet widths using a dedicated Playwright harness.
- The paired detail assertions verify one named H1, zero document-level horizontal overflow, a keyboard-visible focus indicator, Archivist cyan as the focus token, and at least 4.5:1 contrast for the shared informational metadata token against the noir canvas.
- The canonical hub test asserts that rendering makes no requests to any non-local host.
- Hub, Settings, Search, film detail, series detail, and episode-dialog visual regression pass at 1080p and 4K; film detail also passes at tablet width in both server and Player.
- Visual assertions allow no more than 20 pixels of rasterization variance at either resolution.
- The updated visual baselines are checked in alongside the Player end-to-end tests.

Remaining work from the roadmap:

- Extend paired responsive/accessibility coverage beyond the canonical film detail to series detail, browse/card grids, and mobile widths.
- Move the new Player secondary-surface primitives into the shared design-system package where server reuse is appropriate.
- Replace the remaining Player-only reference images with paired server/Player fixtures where the two products share a surface.
- Replace platform-dependent server emoji navigation with the shared SVG icon vocabulary.
- Remove the legacy Player visual branch when the v2 feature flag and rollback path are formally retired.
