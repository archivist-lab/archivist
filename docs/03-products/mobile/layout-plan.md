---
title: "Archivist — Mobile Layout Plan"
document_type: product-specification
status: draft
classified: 2026-08-16
---
# Archivist — Mobile Layout Plan

Target device for this pass: **iPhone 14 Pro Max** (430 × 932 CSS px, portrait), but the
work should hold for any phone ≥ 360px wide.

## 0. The single most important fact

`client/src/index.css` applies `html { zoom: 0.85 }` globally. Zoom enlarges the
layout viewport, so a 430px phone reports a CSS/media width of **≈ 506px**
(`430 / 0.85`).

Tailwind's breakpoints are `sm:640 md:768 lg:1024 xl:1280`. **None of them are met
at 506px.** Therefore on this phone **only the unprefixed (base) classes render** —
every `sm:`/`md:`/`lg:` style is desktop-only. Any component whose *base* classes
assume a wide viewport is broken on mobile.

Consequence for the whole plan: **base classes must be the mobile layout**, and
`sm:`/`md:`/`lg:` become the *widen-for-desktop* layer. Several components today do
the opposite (base = desktop row, `md:` = nothing new), which is why they overflow.

## 1. Root causes (why the page isn't fully viewable)

| # | Cause | Where | Effect on mobile |
|---|---|---|---|
| 1 | **`overflow-x-clip` on the content wrapper** | `App.tsx` `<main>…<div class="p-4 lg:p-6 w-full min-w-0 overflow-x-clip">` | Anything wider than the viewport is **clipped and unreachable** (no scroll). This is the primary "can't see the whole page." |
| 2 | **Permanent sidebar rail** | `Sidebar.tsx` `fixed … w-14 lg:w-52`; `<main class="ml-14 lg:ml-52">` | A 56px icon rail is always on screen, stealing width; there is no mobile drawer/hamburger. Content lives in ~450px. |
| 3 | **Desktop-first rows** (base = non-wrapping `flex`) | Episode drawer rows; `FilmsTabBar`/`SeriesTabBar` (`p-4 flex items-stretch gap-3`); Acquisition Console action rows | Rows exceed the viewport → clipped by (1). |
| 4 | **Fixed-width clusters** | Episode row: 3× `min-w-[112px]` scan buttons + `min-w-[104px]` monitoring + 104px label + 52px quality + title ≈ 600px+ | Impossible to fit ~450px; right side is cut off. `min-w` counts: films 19, series 16. |
| 5 | **Huge gaps/padding at base** | Detail grid `gap-x-16 gap-y-16`; `px-6`, `gap-6` rows | Wastes scarce width, forces overflow. |
| 6 | **`zoom: 0.85` everywhere** | global | Shrinks tap targets; Apple's min is 44×44px. Many controls are already tiny (`text-[8px]`, `w-7 h-7`) and get smaller. |

What is *already fine*: poster grids (`grid-cols-2 sm:grid-cols-3 …` → 2-up on mobile),
the detail 12-col grids (`col-span-12 lg:col-span-3` → stack on mobile), and the
search-bar rows that use `flex flex-col md:flex-row` (stack on mobile). We build on those.

## 2. Strategy

1. **Mobile-first refactor of offending components.** Base classes = phone layout;
   add `md:`/`lg:` to *expand* to the current desktop layout. Never remove desktop styling.
2. **Stop clipping.** Replace `overflow-x-clip` with `overflow-x-hidden` on the page
   wrapper, and make individual wide surfaces (tables, long control rows) either wrap
   or scroll **inside their own `overflow-x-auto` container** — never the page body.
3. **Reclaim width from the sidebar** with a real mobile nav (below).
4. **Reconsider `zoom` on mobile** so tap targets meet 44px.
5. Verify at **375px and 430px** (Tailwind base), and at ≥1024px (unchanged desktop).

## 3. Navigation (the shell)

Current: fixed sidebar, always a 56px rail on mobile; `<main>` offset by `ml-14`.

Plan — **off-canvas drawer + top bar on mobile, unchanged sidebar on desktop**:
- Below `lg` (`< 1024px`, i.e. all phones): hide the sidebar off-canvas
  (`-translate-x-full`), remove the `ml-*` offset (main goes full-width), and add a
  slim **mobile top bar** with a hamburger (opens the drawer) + the Archivist logo +
  current section title.
- Drawer slides in over a scrim; tapping a nav item or the scrim closes it.
- `lg:` and up: exactly today's fixed sidebar + `lg:ml-52` (no visual change).
- Alternative considered: bottom tab bar. Rejected for v1 — there are 8–10 nav items
  (Home, Films, Series, Music, Books, Comics, Games, Channels, Acquisitions, Settings),
  too many for a bottom bar; a drawer scales better. Revisit if the item set shrinks.

Files: `App.tsx` (main offset + top bar), `Sidebar.tsx` (drawer state, translate,
scrim), a small `useMediaQuery`/context for open state.

## 4. Content wrapper

- `App.tsx`: `overflow-x-clip` → `overflow-x-hidden`; keep `min-w-0`.
- Reduce base padding: `p-4 lg:p-6` is fine, but audit inner sections that add more.

## 5. Item pages — library grid + controls

- **Tab bars** (`FilmsTabBar`/`SeriesTabBar`, `p-4 flex items-stretch gap-3`): make base
  `flex-wrap` (or `grid grid-cols-2`) so `Library / Add / Edit` (+ LibrarySelector) wrap
  to two rows on mobile; keep single-row at `md:`. Buttons: full-width-ish, ≥40px tall.
- **Search/filter rows** already `flex flex-col md:flex-row` — good. Confirm each control
  is `w-full` when stacked, and the field-selector dropdown + `+` button wrap sensibly.
- **Poster grid**: keep `grid-cols-2` base (good). Consider `gap-3` base.
- **Compound filter chips**: already wrap (`flex-wrap`) — fine.

## 6. Series episode drawer (the worst offender)

Today each row is one non-wrapping flex line ≈ 600px+ (E# · title · Quick/Deep/Auto
scan · quality · monitoring · status). On mobile the right half is clipped.

Plan — **two-tier responsive row**:
- **Base (mobile):** show only the essentials inline — `E# · title (truncate) · status
  label`. Tapping the row already opens the **episode detail panel**, which now holds the
  processing icons + per-track editors and the scan actions. So on mobile the row is a
  compact, tappable summary and all actions live in the detail panel.
- **Hide the inline Quick/Deep/Auto scan buttons and monitoring toggle below `md:`**
  (`hidden md:flex`), surfacing them in the detail panel instead (the detail panel's
  action row already has Manual/Auto scan; add Quick + a monitoring toggle there).
- `md:` and up: today's full inline cluster (unchanged).
- Drop the fixed `min-w-[112px]`/`w-[104px]`/`w-[52px]` on mobile (they only make sense
  for the desktop columnar layout); scope them to `md:`.

## 7. Detail pages (film / series)

- 12-col grids already stack (`col-span-12 lg:col-span-*`). Fixes needed:
  - `gap-x-16 gap-y-16` → `gap-6 lg:gap-x-16 lg:gap-y-16` (huge gaps waste mobile width).
  - Right-aligned logo/awards column (`items-end text-right`) → left-align on mobile.
  - Acquisition Console action row (Quick/Deep/Auto or Manual/Auto buttons via
    `QualityPolicyPanel action=`): make the action wrap/stack full-width on mobile.
  - Cast/crew horizontal scrollers already scroll (`overflow-x-auto`) — good.
- Metadata rows (`flex flex-wrap gap-x-12`) → smaller base gap.

## 8. Modals

- `Modal` is `w-full max-w-lg … max-h-[90vh]` inside `p-4` — acceptable. Verify wide
  inner content (release lists, metadata editor tabs, field grids) uses `overflow-x-auto`
  or stacks; the FileMetadataEditor's audio/subtitle tables should scroll inside the modal.
- Bottom-sheet style (slide up from bottom, full-width) is a nice-to-have, not required.

## 9. Tap targets & the `zoom` question

- With `zoom: 0.85`, an `h-9` (36px) control renders ~30px — below Apple's 44px.
- Options:
  1. **Scope the zoom to desktop**: `@media (min-width: 1024px){ html{zoom:.85} }` and
     `html{zoom:1}` on mobile. Cleanest for tap targets; means mobile uses true px, so
     spacing/type feel a touch larger — usually desirable on a phone.
  2. Keep global zoom and bump base control sizes (`min-h-[44px]`) on interactive rows.
- **Recommendation:** option 1 (mobile `zoom:1`), and re-verify the portal/dropdown
  positioning math (`readEffectiveZoom`) still cancels correctly when zoom is 1 (it
  returns 1 → no scaling, so it's already safe).

## 10. Reusable primitives to add

- `useIsMobile()` / `useMediaQuery('(max-width: 1023px)')` hook for the drawer + any
  JS-driven layout branches.
- A `MobileTopBar` component (hamburger + logo + title).
- Audit helper: grep for `min-w-[`, `w-[NNNpx]`, `whitespace-nowrap`, and bare `flex `
  (no `flex-col`/`flex-wrap`) in `modules/*` to find remaining non-wrapping rows.

## 11. Delivery phases

**Phase 1 — Make everything reachable (highest impact, lowest risk)**
- `overflow-x-clip` → `overflow-x-hidden`.
- Mobile drawer nav + top bar; main goes full-width below `lg`.
- Tab bars wrap on mobile.
- Episode drawer: hide inline scan/monitoring below `md`, keep `E# · title · status`;
  ensure detail panel carries those actions.
- Result: no clipped/unreachable content on any page.

**Phase 2 — Polish & ergonomics**
- Scope `zoom` to desktop (mobile `zoom:1`); enforce 44px tap targets on controls.
- Reduce base gaps/padding on detail grids and metadata rows.
- Left-align the detail right-column on mobile; wrap console actions.
- Modal inner-content overflow audit.

**Phase 3 — Nice-to-haves**
- Bottom-sheet modals; per-section sticky sub-headers; swipe-to-close drawer;
  pull-to-refresh on library grids.

## 12. Acceptance criteria

1. On a 430px (and 375px) viewport, **no horizontal page scroll or clipped content** on:
   Home, Films/Series library, Add Films/Series, film/series detail, episode drawer +
   detail panel, Acquisitions, Settings.
2. Sidebar is a drawer on mobile; main content uses the full width.
3. Every interactive control is reachable and ≥ 44px tall.
4. Desktop (≥ 1024px) is visually unchanged.
5. Client typechecks, builds, and existing behaviour is intact.

## 13. Out of scope (for now)
- The separate **Player** app (`apps/player`) — has its own living-room UI spec.
- Native gestures beyond drawer open/close.
- Landscape-specific tuning (portrait is the priority).
