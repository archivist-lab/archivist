# UI & Style Specification

This document details the UI/UX design, layout, and styling elements for the Archivist application, specifically focusing on the Film pages to ensure perfect replication in future development.

## 1. Global Theme

Archivist uses a dark, "cyber-noir" aesthetic with high-contrast accents and a heavy emphasis on typography and glassmorphism.

### App Structure
*   **Navigation**: A fixed left Sidebar (`ml-52` expanded, `ml-14` collapsed) providing access to Dashboard, Media Libraries, Acquisitions, and Settings.
*   **Main Container**: Flex-1 area with `p-4 lg:p-6` padding.
*   **Transitions**: All page navigations and layout shifts use a `duration-300` transition.

### Sidebar Specification
*   **Logo**: `icon.svg` followed by "ARCHIVIST" in `text-gradient-full` (Cyan -> Violet -> Pink).
*   **Nav Items**: 
    *   **Inactive**: `text-white/30`, `hover:text-white/65`, `hover:bg-white/5`.
    *   **Active States**: Each category uses a themed active pill with `bg-[color]/10`, `text-[color]`, `border-[color]/60`, and a subtle glow `shadow-[0_0_15px_[color]/10]`.
*   **Tab Switching**: For multi-tab media types, the sidebar displays an expand/collapse arrow. It remembers the last selected tab for each media type.
*   **Manage Libraries**: A footer link in `text-[#00D4FF]/40` tracking-widest uppercase.

### Colors
*   **Backgrounds**:
    *   `noir-950`: `#0a0a0f` (Main body background)
    *   `noir-900`: `#111118` (Card backgrounds, modals)
    *   `noir-800`: `#1a1a24` (Hover states, nested elements)
    *   `noir-700`: `#242430` (Borders, subtle highlights)
*   **Accents**:
    *   `cyan`: `#00D4FF` (Primary brand color, primary buttons, progress bars)
    *   `violet`: `#9B59B6` (Secondary accents)
    *   `pink`: `#FF2D78` (High-priority indicators, warnings)
    *   `emerald-500`: `#10b981` (Success, seeding)
    *   `amber-500`: `#f59e0b` (Warnings, pending states)
    *   `red-500`: `#ef4444` (Errors, delete actions)

### Typography
*   **Display Font**: `Bebas Neue`
    *   Usage: Large headers, page titles, brand elements.
    *   Style: Uppercase, tracking-widest.
*   **Sans Font**: `DM Sans`
    *   Usage: Body text, descriptions, general UI.
    *   Weights: 300, 400, 500, 600.
*   **Mono Font**: `JetBrains Mono`
    *   Usage: Technical data, file sizes, codec info, labels, acquisition history.
    *   Weights: 400, 500.

### Global Effects
*   **Gradients**:
    *   `.text-gradient-cyan`: `linear-gradient(135deg, #00D4FF, #9B59B6)`
    *   `.text-gradient-full`: `linear-gradient(135deg, #00D4FF, #9B59B6, #FF2D78)`
*   **Glassmorphism**: Heavy use of `backdrop-blur-sm` and `bg-noir-900/40`.
*   **Borders**: Typically `border-white/5` or `border-white/10` for subtle separation.
*   **Scrollbars**: Minimalist 4px wide scrolls with `rgba(255,255,255,0.1)` thumbs.

---

## 2. Film Library Page

The library view is a responsive grid designed for quick browsing and status monitoring.

### Layout
*   **Header**:
    *   Page Title: `FILMS` in `font-display` (Bebas Neue), size `5xl`, tracking `widest`, color `#00D4FF`.
    *   Library Stats: Inline stats below the title in `font-mono`, size `12.5px`, uppercase.
*   **Filter Bar**:
    *   Standardized `CollectionFilterBar` (All / Missing / Collected / Acquiring).
    *   Segmented control style with `bg-noir-950/50` and `rounded-xl`.
*   **Grid**:
    *   Responsive `grid` using `LibraryCard` components.
    *   Poster-focused cards with status badges overlayed.

### Component Details: LibraryCard
*   **Structure**: Poster image with gradient overlay, footer with title and metadata.
*   **Poster Overlay**: `bg-gradient-to-t from-noir-950/60 to-transparent`.
*   **Typography**: 
    *   Title: `font-display`, `text-[13px]`, uppercase, tracking-wide.
    *   Subtitle: `font-mono`, `text-[10px]`, uppercase, tracking-tight, `text-white/60`.
*   **Hover Effect**: Scale transform and dynamic shadow based on `accentColor`.
*   **Overlay Shades**: 
    *   Missing: `rgba(128, 128, 128, 0.1)` (Gray).
    *   Acquiring: `rgba(191, 0, 255, 0.1)` (Purple).
    *   Collected: 10% opacity of category accent color.

---

## 3. Film Detail Page

An immersive, content-rich page utilizing a complex 12-column grid and backdrop effects.

### Layout System
The page is wrapped in an `animate-fade-in` container with a fixed, blurred backdrop.

*   **Backdrop**:
    *   `film.backdrop_path` image at `opacity-50`, `blur-[10px]`, `scale-110`.
    *   `bg-noir-950/40` overlay for legibility.
*   **Main Grid**: `grid grid-cols-12 gap-x-16 gap-y-16`.

### Sections

#### Top Left: Poster (col-span-3)
*   Poster Image: `aspect-[2/3]`, `rounded-3xl`, `shadow-[0_0_60px_rgba(0,0,0,0.6)]`.
*   Hover State: Blue glow overlay (`#00D4FF/20`) with "Edit Metadata" label.
*   Bottom: `StatusBadge` and `CertificationBadge` / `CountryFlag` group.

#### Top Center: Overview (col-span-6)
*   **Overview Text**: `text-[12.5px]`, `leading-relaxed`, `font-medium`.
*   **Metadata Grid**: Flex wrap with `gap-x-12 gap-y-6`. Labels are `text-[10.5px]`, `font-mono`, `text-white/40`. Values are `text-[12.5px]`, `text-white`.
*   **Quality Policy Panel**: Integrated at the bottom of the center section.

#### Top Right: Identity & Awards (col-span-3)
*   **Logo/Title**: `min-h-[140px]`. Prefers `logo_path`. Fallback to `font-display` title in `#00D4FF`.
*   **Awards Stack**: Vertical list of awards with custom drop-shadow icons (e.g., 🏆, 🌿).

#### Middle Row: Cast & Crew / Trailer
*   **Cast/Crew (col-span-6)**: Horizontal scrolling list of `aspect-square` avatars (`rounded-2xl`). Names in `text-[9.5px]`, bold, uppercase.
*   **Trailer (col-span-6)**: `aspect-video`, `rounded-3xl`, `border-white/10`. Custom play button overlay in `#00D4FF`.

#### Bottom: File Details & Chapters
*   **File Details**: 2-column layout (nested).
    *   **Editions**: Rounded button chips with selection states (`bg-[#00D4FF]` for active).
    *   **Technical Specs**: Stacked mono labels and bold values for Tier, Res, Codec, Size.
    *   **Audio/Subtitle Streams**: Individual chips with `LanguageFlag` and format indicators.
*   **Chapters**: Scrollable table with `font-mono` timestamps in `#00D4FF/70`.

#### Acquisition Console
*   **Filters**: Segmented button groups for Tier, Res, Source, and Codec.
    *   Unselected: `text-white/30`.
    *   Selected: `bg-[#00D4FF]`, `text-noir-950`, `shadow-lg`.
*   **Scan Button**: `bg-[#00D4FF]/10`, `border-[#00D4FF]/30`, `text-[#00D4FF]`.
*   **Release List**: Detailed list of indexer results with `onGrab` interaction.

---

## 4. Home Page (Dashboard)

The Dashboard provides a high-level overview of the entire library, current infrastructure status, and upcoming releases.

### Layout
*   **Header**: `DASHBOARD` in `font-display` (Bebas Neue), `text-4xl`, tracking `[0.2em]`.
*   **Library Quick Stats**: A 6-column grid of interactive cards.
    *   **Card Design**: `bg-noir-900/40`, `border-white/5`, `rounded-2xl`, `p-4`, `min-h-[100px]`.
    *   **Colors**: Category signature colors (Cyan, Violet, Pink, Yellow, Orange, Emerald).
    *   **Interaction**: Hover state increases border brightness (`border-white/20`) and background opacity.
    *   **Visual Accent**: A 1px progress bar at the bottom matching the category color.

### Main Content Split
On desktop, the dashboard uses a `grid-cols-12` layout:
*   **Left (6 columns)**: Release Calendar.
*   **Right (6 columns)**: Infrastructure & Node Status.

---

## 5. Release Calendar

The calendar is a 21-day (3-week) grid showing upcoming media releases across all tracked libraries.

### Grid Setup
*   **Structure**: `grid grid-cols-7 gap-px` (7-day week).
*   **Cell Design**: `min-h-[110px]`, `bg-noir-950/40`, `border-b border-white/5`.
*   **Today Highlight**: `bg-cyan/30`, `z-10`, `shadow-[inset_0_0_20px_rgba(0,212,255,0.1)]`.
*   **Navigation**: Tab switching for library isolation uses `#00D4FF` active state.

### Event Chips
Events are displayed as small, high-contrast chips within the day cells:
*   **Typography**: `text-[9px]`, `p-1 px-2`, `font-bold`, uppercase, `tracking-tighter`.
*   **Interaction**: `cursor-pointer`, `hover:brightness-125` transition.
*   **Categorical Colors (20% Opacity Background)**:
    *   `Series`: `#9B59B6` (Violet)
    *   `Films`: `#00D4FF` (Cyan)
    *   `Music`: `#FF2D78` (Pink)
    *   `Games`: `#2ECC71` (Emerald)
    *   `Books`: `#F1C40F` (Yellow)
    *   `Comics`: `#E67E22` (Orange)

---

## 6. Infrastructure & System Status

Located in the right column of the dashboard.

### Storage Monitoring
*   **Panel**: `bg-noir-900/50`, `border-white/5`, `rounded-3xl`, `p-5`, `backdrop-blur-sm`.
*   **Progress Bars**:
    *   `Normal (<75%)`: `#00D4FF/60` (Cyan)
    *   `Warning (>75%)`: `#f59e0b` (Orange)
    *   `Critical (>90%)`: `#ef4444` (Red)

### Node Status
*   **Encrypted Status**: `text-green-500` with a pulsing dot `shadow-[0_0_8px_rgba(34,197,94,0.5)]`.
*   **Uptime**: High-visibility `font-mono` percentage.

---

## 7. Series Library Page

The Series library follows the same high-contrast grid pattern but with its own signature accent color.

### Layout
*   **Header**: `SERIES` in `font-display`, `text-5xl`, tracking `widest`, color `#9B59B6` (Violet).
*   **Filters**: Includes an additional "Airing Status" filter bar (All / Continuing / Upcoming / Ended).
*   **Grid Cards**: Uses `LibraryCard` with `#9B59B6` accent. Subtitle displays episode progress (e.g., "12/12 EPISODES").

---

## 8. Series Detail Page

The Series detail page shares the immersive backdrop and 12-column grid system of the Film detail page, but adapts the content for episodic navigation.

### Layout System
*   **Backdrop**: `series.backdrop_path` at `opacity-50`, `blur-[10px]`, `scale-110`.
*   **Accent Color**: Consistent use of `#9B59B6` for branding and status.

### Sections

#### Top Sections (Same as Film)
*   **Poster (col-span-3)**: Standard poster with `StatusBadge` (Violet for Acquiring/Upcoming).
*   **Overview (col-span-6)**: Series summary, metadata grid (Released, Network, Rating, Seasons), and `QualityPolicyPanel`.
*   **Identity (col-span-3)**: Series logo or display title in top right.

#### Middle Row: Seasons & Episodes (col-span-6)
The primary navigation element for TV content.
*   **Season List**: A vertical stack of accordion-style cards (`bg-noir-900/40`, `border-white/[0.03]`).
    *   **Season Row**: Thumbnail, title, air date, episode count, and "Search Season" button.
    *   **Expansion**: Clicking a season expands to show the episode list with `animate-slide-down`.
*   **Episode Rows**: 
    *   **Typography**: Episode numbers in `text-white/10`, titles in `text-white/70`, uppercase.
    *   **Actions**: Inline search button (🔍) and an "UP" toggle (Upgrade Allowed) using `#9B59B6/70`.
    *   **Status**: `StatusBadge` per episode.

---

## 9. Books Library & Author Pages

### Library Page
*   **Signature Color**: `#F1C40F` (Yellow)
*   **Header**: `BOOKS` in `font-display`, `text-5xl`, color `#F1C40F`.
*   **Grid Cards**: `LibraryCard` with `#F1C40F` accent and `aspect-square`. Subtitle: `X/Y BOOKS`.

### Author Detail Page
*   **Layout**: `DetailHeader` with author image and yellow display name.
*   **Content**: Books are grouped by series name.
*   **Series Headers**: `text-[10px]`, bold, `yellow-400`, uppercase with a full-width divider.
*   **Book Rows**: Accordion cards with `bg-noir-900/40`.
    *   **Typography**: Title transitions to `yellow-400` on hover.
    *   **Book Detail**: Expanded view shows cover, synopsis, ISBN-13, and page count.

---

## 10. Comics Library & Series Pages

### Library Page
*   **Signature Color**: `#E67E22` / `#FB923C` (Orange)
*   **Header**: `COMICS` in `font-display`, `text-5xl`, color `orange-400`.
*   **Grid Cards**: `LibraryCard` with `#E67E22` accent and `aspect-square`. Subtitle: `X/Y ISSUES`.

### Comic Series Detail Page
*   **Layout**: `DetailHeader` with series title in `orange-400`.
*   **Issue List**: Vertical stack of accordion-style cards.
    *   **Issue Row**: Thumbnail, issue number/name, and status.
    *   **Issue Detail**: Features a `QualityPolicyPanel`, synopsis, and a large `GET ISSUE` button in `orange-400`.

---

## 11. Music Library & Artist Pages

### Library Page
*   **Signature Color**: `#FF2D78` (Pink)
*   **Header**: `MUSIC` in `font-display`, `text-5xl`, color `#FF2D78`.
*   **Grid Cards**: `LibraryCard` with `#FF2D78` accent and `aspect-square`. Subtitle: `X/Y ALBUMS`.

### Artist Detail Page
*   **Layout**: `DetailHeader` with artist backdrop and logo/name in `#FF2D78`.
*   **Album Sections**: Grouped by type (Studio Album, Live, Compilation, EP, Single).
    *   **Type Headers**: `text-[10px]`, bold, `#FF2D78`, uppercase.
*   **Album Detail**: 
    *   **Visuals**: CD Art with `animate-spin-slow` animation behind the cover.
    *   **Track List**: Numbered list with `track_number`, `title`, and `duration`.
    *   **Status**: Individual `StatusBadge` per track.

---

## 12. Games Library & Platform Pages

### Library Page
*   **Signature Color**: `#2ECC71` / `#10B981` (Emerald/Green)
*   **Header**: `GAMES` in `font-display`, `text-5xl`, color `emerald-400`.
*   **Grid Cards**: Grouped by **Platform** (e.g., Steam, PS5, Switch). 
    *   **Icons**: Unique platform icons (🎮, 💻, 🔴, etc.) used as fallbacks.
    *   **Subtitle**: `X/Y TITLES`.

---

## 13. Acquisitions & Torrents Page

The central hub for monitoring downloads and staging manual imports.

### Layout
*   **Accent Color**: `#00D4FF` (Cyan)
*   **Tabs**: Segmented control switching between **Torrents** and **Imports**.

### Torrent List Specification
*   **Grid Layout**: Fixed columns for selection, order (#), name, progress, speed, size, and ETA.
*   **Status Pills**:
    *   `Downloading`: `bg-emerald-500/10`, `text-emerald-400`, `border-emerald-500/20`.
    *   `Paused`: `bg-white/10`, `text-white/40`, `border-white/10`.
*   **Interactions**: 
    *   **Bulk Bar**: Floating footer bar with multi-action buttons.
    *   **Queue Reordering**: Drag-and-drop handles (`⠿`) with Up/Down buttons (`▲/▼`).

### Download Monitor Widget
*   **Location**: Dashboard footer.
*   **Status Badges**: `8px`, bold, uppercase, border-current. Colors: Emerald (Downloading), Cyan (Queued), Yellow (Checking), Red (Error).
*   **Speed Info**: `10px` mono, `emerald-500/60` for down, `cyan-500/60` for up.

---

## 14. Settings Page UI

### Library Tabs Management
*   **Grid**: 2-column layout of interactive cards (`bg-noir-900`, `shadow-xl`).
*   **Visuals**: Media-type emojis (🎬, 📺, 🎵, 🎮, 📚) and technical DB paths in mono-font blocks.
*   **Actions**: "Remove" (white/5) and "Delete DB" (red-500/10) buttons.

### Quality Profile Cards
*   **Layout**: `bg-noir-900`, `border-white/5`, `rounded-xl`.
*   **Content**: Lists cutoff tier/resolution and priority items in mono-font chips.

### Root Folders
*   **Accessibility Dot**: Cyan (`#00D4FF`) for accessible paths, Pink (`#FF2D78`) for unreachable.
*   **Conflict Warning**: Amber (`#f59e0b`) banner appearing when multiple tabs target the same path.

### System & Operations
*   **Stats Grid**: 4-column overview of technical metrics (Torrents, Jobs, Imports, Integrity).
*   **Maintenance & Backup Panels**: 
    *   **Retention Grids**: 7-column configuration panels for history retention (Daily, Weekly, Monthly, etc.).
    *   **Controls**: `bg-[#00D4FF]/10` "Run Now" buttons and standard `Toggle` switches.
*   **Integrity Report**:
    *   **Problems List**: Vertical stack of repairable issues with severity-based coloring (Pink/Amber).
    *   **Repair Action**: Interactive buttons with category-specific confirmation labels (e.g., "Clear stale acquisition?").

---

## 15. Indexer Management
*   **Engine Banner**: `bg-[#00D4FF]/5`, `border-[#00D4FF]/15`, `rounded-xl`, pulse indicator.
*   **Indexer List**: `bg-noir-900`, `border-white/5`, `rounded-xl`.
*   **Toggles**: Custom `#00D4FF` active state, `bg-white/10` inactive.

### Indexer Modal
*   **2-Pane Layout**: Searchable definition list on left (width: `64`), configuration form on right.
*   **Priority Grid**: 2 or 3-column grid of interactive cards per media type.

---

## 15. UI Components Specification

### Library Card (Standard)
*   **Hover**: `box-shadow` with 10% opacity category accent color.
*   **Status Overlays**: 10% opacity background colors based on library state.
*   **Selection Mode**: Top-left checkbox, Cyan (#00D4FF) when selected.

### Status Badge
*   **Typography**: `10px`, `font-display`, uppercase, `tracking-widest`.
*   **Logic**: Appends download percentage (e.g., "ACQUIRING - 85%") if applicable.

### Unified Media Switcher & Manual Search
*   **Layout**: `h-[44px]` container, `p-1`, `bg-noir-950/50`.
*   **Active Button**: `bg-[color]20`, `border-[color]40`, `text-[color]`.
*   **Manual Search Results**: Fixed-height scrollable list (`max-h-[500px]`). Displays indexer, size, seeders (`text-emerald-500/60`), and leechers (`text-cyan-500/60`) in mono font.

### Toggle Switch
*   **Structure**: `w-10 h-5` rounded pill with a `w-4 h-4` circular thumb.
*   **Colors**: `bg-[#00D4FF]/70` when active, `bg-white/10` when inactive.

### Tab Select (Segmented Control)
*   **Container**: `bg-noir-950/50`, `p-1`, `rounded-xl`, `border-white/5`.
*   **Buttons**: `rounded-lg`, `text-[10px]`, font-bold, uppercase.
*   **Active State**: `text-noir-950` with the category's signature background color.

### Selection Bar
*   **Usage**: Appears at the top of library grids in "Edit" mode.
*   **Layout**: `bg-noir-900`, `border-white/5`, `rounded-xl`, `animate-fade-in`.
*   **Content**: Selection counts in mono-font, "Select All/None" links, and a `bg-red-500/10` delete button.

### Empty State
*   **Layout**: Centered `py-24` block.
*   **Visuals**: Large icon (`text-6xl`, 10% opacity), followed by a `font-display` title and `font-mono` subtitle in `text-white/20`.

### Error Boundary UI
*   **Container**: `max-w-3xl` centered block.
*   **Visuals**: `bg-red-500/5` with a `border-red-500/30` frame.
*   **Typography**: Pink/Red error messages, technical stacks hidden within `text-white/40` details elements.

### Modals (Specialized)
*   **Platform Modal**: Single-column list of system chips for game imports.
*   **Film Modal**: Nested `TabSelect` grid for acquisition defaults (Tier, Res, Source, Codec).
*   **Missing Search Modal**: `max-w-md` width with standard `TabSelect`-like filter grids for Tier, Resolution, Source, and Codec, capped at 10 items. Uses a checkbox for strict enforcement.

### Language & Country Flags
*   **Structure**: 3px height image (for flags) or `text-lg` text (for text codes).
*   **Implementation**: Uses `flagcdn.com` for ISO code mapping.
*   **Visuals**: `opacity-80`, `object-contain`, `rounded-sm`.

### Edition Renamer & Rules
*   **Renamer Modal**: Standard `Modal` with a `Field`/`Input` for the new name.
*   **Rules Tab**: (In Settings) Lists active renaming rules with "Delete" actions.

### Subtitle Search & UI
*   **Search Modal**: Full-screen `fixed inset-0` with `bg-black/90` and `backdrop-blur-md`.
*   **Loading State**: Pulsing `text-white/20` text: "Searching OpenSubtitles...".
*   **Results List**: List of subtitle files with language flags and "Grab" buttons.
*   **Subtitle Badges**: Individual chips in media details with `LanguageFlag` and format indicators (SRT/ASS).

---

## 17. Technical Specifications

*   **Framework**: React (TypeScript)
*   **Styling**: Tailwind CSS
*   **Animations**: 
    *   `animate-fade-in`: Opacity 0 -> 1.
    *   `animate-slide-up`: TranslateY 16px -> 0.
    *   `poster-shimmer`: Shimmering gradient animation for skeleton loaders.
*   **Transitions**: Standard Tailwind transitions (`transition-all`, `duration-300`).
*   **Icons**: Mix of SVG Icons (Spinner, App Icon) and Emojis for status/fallbacks.
