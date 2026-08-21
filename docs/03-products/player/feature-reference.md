---
title: "Player App Features — Arctic Fuse 3 as the North Star"
document_type: product-specification
status: historical
classified: 2026-08-16
---
# Player App Features — Arctic Fuse 3 as the North Star

**Purpose.** This document is a deep, source-derived analysis of the **Arctic Fuse 3** Kodi skin
by Jurial Munkey (https://github.com/jurialmunkey/skin.arctic.fuse.3), and a mapping of every
feature and customisation surface onto **Archivist Player**. Arctic Fuse 3 is the north star:
the goal is not to clone Kodi, but to reach the same level of polish, configurability, and
information density — adapted to a web app backed by the Archivist server.

**Method.** Everything below was read directly from the skin's source (cloned at v3.2.13,
`addon.xml`). Key sources: the 211 window/include XML files in `1080i/`, the declarative
configuration JSON in `shortcuts/`, the string table in
`language/resource.language.en_gb/strings.po`, colour definitions in `colors/`, and bundled
assets in `extras/`. File paths are cited throughout so claims can be verified. Nothing is
inferred from screenshots or memory.

**Scale for context:** the skin is ~45,700 lines of XML plus ~2,300 lines of JSON config,
supporting 8 aspect ratios (16:9 through 21:9 and 19.5:9, per `addon.xml`), 14 languages, and
depends on companion add-ons (TMDbHelper, SkinVariables, TextureMaker, UpNext) for data and
code-generation. Archivist Player replaces that entire add-on constellation with the Archivist
server API — which is a structural advantage: the Player can do natively what the skin must
assemble from plugins.

---

## Table of contents

1. [Design identity](#1-design-identity)
2. [Home system: hubs, menus, submenus](#2-home-system)
3. [Spotlight (hero) system](#3-spotlight-hero-system)
4. [The widget system](#4-the-widget-system) — the heart of the skin
5. [Widget content sources](#5-widget-content-sources)
6. [Library browsing: 23 view types](#6-library-browsing-view-types)
7. [View options & list tooling](#7-view-options--list-tooling)
8. [Search](#8-search)
9. [Info (detail) dialogs](#9-info-detail-dialogs)
10. [Ratings system](#10-ratings-system)
11. [Indicators & badges](#11-indicators--badges)
12. [Playback OSD](#12-playback-osd)
13. [Up Next & post-play](#13-up-next--post-play)
14. [Appearance & theming](#14-appearance--theming)
15. [Backgrounds & artwork pipeline](#15-backgrounds--artwork-pipeline)
16. [Seasonal themes](#16-seasonal-themes)
17. [Header / footer furniture](#17-header--footer-furniture)
18. [Startup experience](#18-startup-experience)
19. [Skin users (pseudo-profiles)](#19-skin-users-pseudo-profiles)
20. [Power menu & system shortcuts](#20-power-menu--system-shortcuts)
21. [Settings UX itself](#21-settings-ux-itself)
22. [Behaviour & performance options](#22-behaviour--performance-options)
23. [Accessibility, input & navigation](#23-accessibility-input--navigation)
24. [Features that don't translate](#24-features-that-dont-translate)
25. [Adaptation roadmap for Archivist Player](#25-adaptation-roadmap)

---

## 1. Design identity

Source: `addon.xml` ("A minimal row based skin … with customisable widgets"),
`colors/defaults.xml`, `1080i/Includes_Colors.xml`, `1080i/Font.xml`.

- **Row-based minimalism.** The entire skin is organised around horizontal rows of media
  items over full-bleed artwork. Chrome is minimal: a thin header (date/weather), a footer
  (now playing / studio), and rows. Everything else appears on demand.
- **Opacity-token colour system.** `colors/defaults.xml` defines no ad-hoc colours; it defines
  *roles at opacities*: `main_fg_100/90/70/50/30/12/06`, `main_bg_*`, `dialog_fg_*`,
  `dialog_bg_*`, `panel_fg_*`, `panel_bg_*`, plus `overlay_soft/hard`, `shadow_soft/hard/full`
  and a single accent semantic (`yellow_star` for ratings). Foregrounds are near-white
  (`ededed`) on near-black. A second theme file ("Skin default - Light dialogs.xml") swaps
  dialog tokens only — proof the token system supports themes without touching layouts.
- **One accent colour drives focus.** The user-selectable highlight colour (`focuscolor.name`,
  see §14) is used for focus rings, selected menu items, and active icons; everything else is
  monochrome. This is why the skin reads as calm despite its density.
- **Motion language.** A small set of reusable animation includes (`Includes_Animations.xml`,
  `Home_Animation`, `Animation_BounceIn_Dialog`, `Hub_Window_Side_Slide_Animation`) define the
  motion: 200–400 ms fades and slides with cubic easing, "bounce-in" dialogs, and conditional
  slides that re-position layouts when elements (header, search) are disabled.

### Adaptation
Archivist Player already has a locked noir look, which matches this philosophy. What to adopt:
- Formalise the **opacity-token palette** (fg/bg/panel/dialog at 100/90/70/50/30/12/6) as CSS
  custom properties instead of one-off colours.
- Add a single **user-selectable accent colour** (see §14) that drives focus/selection only.
- Codify the **motion tokens** (2 durations, 1 easing, 3 patterns: fade, slide, bounce-in) as
  shared CSS/Framer-style primitives, so every new surface animates identically.

---

## 2. Home system

Sources: `1080i/Home.xml`, `1080i/Includes_Home.xml`, `1080i/Custom_1101–1104_Hub.xml`,
`1080i/Includes_Hubs.xml`, `1080i/Custom_1181_Dialog_Submenu.xml`,
`shortcuts/skinvariables-shortcut-homesubmenu.json`, `1080i/Dialog_DialogShortcuts.xml`.

### 2.1 Multiple home "hubs"
The home experience is not one screen — it is a **switcher across up to 9 windows**
(`Includes_Home.xml`, `Home_ControlList_Items`):

| Slot | Window | Nature |
|---|---|---|
| Search | 1105 | dedicated search hub (§8) |
| Home | Home | always present |
| Hub 1–4 | 1101–1104 | **user-created hubs**, each with own name, icon, shortcut, spotlight, submenu, and widgets |
| Next Aired | 1106 | TV calendar hub (library or Trakt calendar mode — `HomeSwitcher.1106.UpNextMode`) |
| Live TV | 1107 | PVR hub (toggleable sections: search, channels, groups, recordings) |
| Add-ons | 1108 | add-on browser hub (toggleable per add-on type) |

Each custom hub is enabled with a toggle (`HomeSwitcher.110x.Toggle`) and configured via the
shortcuts editor: **rename** (`HomeSwitcher.110x.Name`), **icon** (icon-picker window 1117),
**click-through shortcut** (path + target), **layout mode**, **spotlight**, **submenu items**,
and **widgets** (`Dialog_DialogShortcuts.xml` lines 581–806).

### 2.2 Per-hub layout modes
Every hub independently chooses one of **three layout modes**
(`Dialog_DialogSelect.xml` → `DialogSelect_WidgetMode_Items`, previews in `extras/modes/`):

- **Standard** — full-width rows with a spotlight/hero region above.
- **Combined** — a vertical rail of widget names on the left with a single content row on the
  right, plus a large info panel for the focused item (`Hub_Combined_Widget`,
  `Hub_Combined_Info`).
- **Wall** — a grid/wall presentation with an info overlay (`Hub_Wall_Widget`, `Hub_Wall_Info`).

Defaults per `shortcuts/skinvariables-startup.json`: Home and hubs 1101–1106 default to
Standard; Live TV (1107) and Add-ons (1108) default to Wall.

### 2.3 Menu position & style
`Includes_SkinSettings.xml` (Menus section):

- **Horizontal top menu or vertical side menu** (`HomeSwitcher.Vertical` toggle) — the whole
  home chrome re-arranges (`Home_Switcher_Horz` vs `Home_Switcher_Vert`).
- **Text or icon mode** for the horizontal menu (`HomeSwitcher.EnableIcons`).
- **Header display cycles** three states: date+header → header only → hidden
  (`HomeSwitcher.DisableDate` / `HomeSwitcher.DisableHeader`).
- **Menu loop-back** toggle (`HomeSwitcher.LoopBack`) — whether the horizontal menu wraps.
- **Startup focus** option: focus menu vs. first widget on start
  (`HomeSwitcher.DisableFirstWidgetFocus`).

### 2.4 Submenus
Each hub has an editable **submenu** (drop-down panel, `Home_Submenu_Panel`) whose items come
from the same shortcut-picker as widgets. The default home submenu is Videos / Music / Pictures
(`skinvariables-shortcut-homesubmenu.json`). The submenu panel auto-sizes to item count
(1080i/Includes_Home.xml lines 538–610). A "Hub Submenu" overlay window (1181) opens on
up-navigation from the menu.

### Adaptation
Archivist Player currently has one Home with rails. The Arctic Fuse model generalises this:
- **User-defined hubs** map naturally to "custom pages": e.g. a "Films" hub, a "Kids" hub, a
  "Recently Added" hub — each a named tab with its own rail stack, hero, and layout mode.
  Implement as a `pages[]` array in Player settings (name, icon, layout, rails, hero source).
- **Three layout modes per page** (Standard rows / Combined rail-list / Wall grid) is a
  high-value, low-cost addition since the Player already renders rails and walls.
- **Menu position** (top bar vs. left sidebar) as a global setting; sidebar suits TV-distance
  and desktop, top bar suits compact.
- **Submenu → per-page quick links** (chips under the page title linking to filtered library
  views).
- Next Aired hub → a **Calendar page** fed by Archivist's episode air-date data (the server
  already tracks upcoming episodes for monitoring). Live TV / Add-ons hubs are N/A (§24).

---

## 3. Spotlight (hero) system

Sources: `Includes_Hubs.xml` (`Hub_Spotlight*`), `Dialog_DialogShortcuts.xml` lines 613–666,
`shortcuts/generator/data/setup/widgets_spotlight.xml`, `Includes_SkinSettings.xml`.

Every hub has a **Spotlight**: a full-bleed hero region fed by a user-chosen content path.

Configuration per hub (`HomeSwitcher.<hub>.Spotlight.*`):
- **Label** — displayed name.
- **Path** — any content source (default on first run: `RandomMovies.xsp` smart playlist with
  label "Random Movies", per `skinvariables-startup.json`).
- **Limit** — numeric item cap.
- **Sort by** — 29 sort keys offered (label, random, dateadded, lastplayed, playcount, year,
  rating, userrating, votes, genre, studio, episodenumber, watchedepisodes, tvshowstatus, …).
- **Sort order** — ascending/descending radio (hidden when sort=random).

Global spotlight behaviour (`Includes_SkinSettings.xml` Menus/Layout):
- **Slide** (`Spotlight.EnableSlide`) — content slides between spotlight items
  (`Hub_Spotlight_Content_Slide`).
- **Spotlight button behaviour** (`Spotlight.UseMenuButton`) — whether the hero's button opens
  info or a context menu (`Action_FullscreenWidget_InfoButton` in `Includes_Actions.xml`).

The spotlight renders logo art, plotline, metadata chips and a call-to-action button
(`Hub_Spotlight_Info`, `Hub_Spotlight_Button`), and the background artwork system (§15)
follows the focused spotlight item.

### Adaptation
The Player's "Spotlight" rail style is the seed of this. Upgrade path:
- Make the hero a **first-class per-page slot** with its own source, limit, sort — not just a
  rail style. Content sources: any Player rail source (continue watching, random unwatched,
  new, a specific library, a saved filter).
- Add **auto-advance (slide)** with the autoscroll interval setting (§22).
- Hero button behaviour setting: Play vs. Details (mirrors `Spotlight.UseMenuButton`).

---

## 4. The widget system

Sources: `1080i/Custom_1115_Window_Shortcuts.xml`, `1080i/Custom_1116_Dialog_Shortcuts.xml`,
`1080i/Dialog_DialogShortcuts.xml`, `1080i/Includes_Widgets.xml`,
`shortcuts/generator/**` (code-generated widget includes),
`shortcuts/skinvariables-shortcut-homewidgets.json` (defaults).

This is the skin's core feature and the reason it needs a code-generator: widget rows are
**generated XML** built from the user's widget list (SkinVariables plugin
`get_shortcuts_node` supplies the data; `generator/data/parts/*.xmltemplate` are the row
templates; `widgets_row.xml` assigns each widget an ID in the 501+ range with prev/next
chaining).

### 4.1 Default widget stack (first run)
`skinvariables-shortcut-homewidgets.json`: On Deck (in-progress movies), In-Progress
(episodes), New Movies, New Shows, Recent Shows, Top 250 — all from bundled smart playlists.

### 4.2 The widget editor
A dedicated two-pane editor window (1115/1116 + `DialogShortcuts` include):
- Left pane: the widget list with **reorder up/down, add, delete** buttons that appear inline
  on the focused row (`DialogShortcuts_ShortcutList_FakeButtons`), plus top actions:
  **Add item, Add list (bulk, up to 80), Delete list, Restore**.
- Right pane: contextual settings for the focused widget.

Per-widget settings (`DialogShortcuts_Items_Basic` + `DialogShortcuts_Items_Widget`):
| Setting | Detail |
|---|---|
| Enable/disable | toggle without deleting |
| Shortcut (content) | opens the grouped content browser (§5) |
| Path | raw path/action editor |
| Rename | custom label |
| Icon | icon picker (window 1117) |
| **Style** | Poster / Landscape / Square / Board / Circle / Card (`Action_Shortcut_SetWidgetStyle`, `Includes_Actions.xml`) |
| Sort by | same 29-key list as spotlight |
| Sort order | asc/desc (hidden for random) |
| Limit | numeric cap |
| Autoscroll | per-widget auto-advance |
| Prevent reload | pins the widget's content (sortby=userpreference) |

### 4.3 Stacked (contextual) widgets — "experimental"
`shortcuts/skinvariables-shortcut-config.json` (`widgets/experimental/`) +
`generator/data/setup/widgets_row.xml` rules. A stacked widget derives its content from the
**item focused in the previous widget**, updating live:
- **Stacked Folder** — opens the focused folder's contents as a row.
- **Stacked Movie/TVShow Recommendations** — "Recommendations (Title)" row for the focused item.
- **Stacked Movie/TVShow Year** — "Year (1999)" row.
- **Stacked Movie/TVShow Genre** — "Genre (Action)" row.
- A **Parent widget** offset setting (1 or 2 rows above) controls which widget it tracks
  (`widget_parent`, `Settings_Stacked_Button` in `Dialog_DialogShortcuts.xml`).
- Stacked widgets are only visible while their parent is visible/focused
  (`widget_visible` / `widget_altvisible` rules).

### 4.4 Special widget types
- **Weather widget** (`{item_path}==Weather` → `Weather_Details_HighLow_Items`).
- **Custom Submenu widget** — renders a user-built shortcut group as a row
  (`Custom_Submenu` path handled in `widgets_row.xml`).
- **"Show More" folder item** — limited widgets can append a More tile linking to the full
  list (`Widgets.EnableShowMore`, `Includes_SkinSettings.xml` Behaviour).
- **Empty-widget placeholder** — a "No Results" tile keeps layout stable; hiding empty widgets
  entirely is possible but gated behind a warning dialog about positioning/refresh costs
  (`Widgets.DisableNoResultsItem`, strings 31519–31524).
- **Busy/updating states** — every widget row has spinner + "Loading" handling
  (`Furniture_Busy`, `widget_busy_isupdating`).

### Adaptation
The Player's rails system (source × style, reorder/toggle in Settings) is a mini version of
this. The gap analysis:
1. **Rail editor as a first-class surface** — inline reorder/add/remove on the home screen
   itself (edit mode), not only in Settings; contextual per-rail settings panel.
2. **Six rail styles** — Player has 3 (Spotlight/Posters/Landscape). Add Square, Board
   (backdrop w/ text panel), Circle (people), Card. All are CSS variants of existing rails.
3. **Per-rail sort/limit/order** — the Player server contract already exposes sort parameters
   for library queries; wire them per rail.
4. **Stacked/contextual rails** — a marquee differentiator: "Because you're looking at X"
   rails that track the focused card (same-genre / same-year / same-collection from the
   Archivist DB). The web app can do this with a simple focus-change subscription, far more
   easily than Kodi's window-property plumbing.
5. **Per-rail autoscroll + prevent-reload (pin)** as rail options.
6. **Show More tile** at the end of limited rails → navigates to the corresponding library
   view with the same filter.
7. **Stable empty states** — Player should keep a placeholder tile for empty rails (with the
   same "hide costs layout stability" trade-off Arctic Fuse documents).

---

## 5. Widget content sources

Source: `shortcuts/skinvariables-shortcut-config.json` (the grouped content browser used by
every "choose shortcut" flow) + `extras/playlists/*.xsp` + `extras/nodes/videolibrary.json`.

The picker is a hierarchical catalogue. Groups (top level): None, Subgroup, Default,
Experimental, Videos, Music, Add-ons, Live TV & PVR, Playlists, Sources, TMDbHelper,
Miscellaneous, Kodi Commands.

**Default curated lists** (per media type):
- *Movies*: New, Recent, Random, In-Progress, Top Rated, Top 250, Unwatched, Movie Nodes,
  Genres, Sets.
- *TV Shows*: New, Recent, In-Progress, Random, Top Rated, Unwatched, Nodes, Genres.
- *Episodes*: New, Recent, Random, Unwatched, In-Progress, Top Rated.
- *Music*: New/Recent/Top/Random Albums, Random Artists, Music Nodes.
- *Live TV / Radio*: last played, all channels, grouped, recordings (active/deleted,
  flat/grouped), timers.

These are backed by **24 bundled smart playlists** (`extras/playlists/`: NewMovies, RecentMovies,
RandomMovies, InProgressMovies, TopRatedMovies, Top250Movies, UnwatchedMovies, equivalents for
shows/episodes, RandomAlbums/Artists/Songs, AllMovies, AllShows, Null).

**Search shortcuts as content** (`grouping://shortcuts/search/`): a widget/tile can *be* a
search: by title (movies/shows/episodes), actor, director, plot, tagline, outline, tag, genre,
year, studio, country, albums/artists/songs, plus plugin searches (YouTube, Netflix, Disney+,
Spotify, TMDb movies/shows/sets/people/keywords, Trakt lists, MDbList…).

**Miscellaneous links**: internal windows (Favourites 1160, Weather 1161, Options 1170,
Skin Settings, System Info, Event Log) and **Kodi Commands** (quit, reboot, suspend, log-off,
screensaver, clean/update library, reload skin…).

### Adaptation
Map to an Archivist Player "rail source catalogue":
- **Curated defaults** — the Player already has Continue Watching / Recently Added / New
  Episodes / Downloading / Unwatched / A–Z. Extend to match the skin's spread: Random,
  Top Rated (by rating metadata), In-Progress vs On-Deck (movie vs episode distinction),
  Genres row, Collections row, per-library rows.
- **Saved-filter sources** — the equivalent of smart playlists: a filter builder (genre, year,
  watched-state, rating, library) whose saved result is usable as any rail/hero/page source.
  This replaces `.xsp` playlists 1:1.
- **Search-as-source** — a rail can be defined as "search: actor = X". Powered by Archivist's
  search endpoint.
- **Action tiles** — tiles that trigger app actions (open Settings, open a library, trigger
  library refresh via the Archivist API) mirror the "Kodi Commands" group, filtered to what a
  web client can do.

---

## 6. Library browsing: view types

Sources: `shortcuts/skinviewtypes.json` (definitive list + rules),
`1080i/Includes_Views*.xml` (implementations), `extras/viewtypes/*.jpg` (previews),
strings 31002–31021, 31100–31113, 31418–31424, 31554–31581.

Arctic Fuse ships **23 view types in 4 families**, selected per content type:

| Family | Views (id) |
|---|---|
| **Row** (horizontal rows) | Square 500, Landscape 501, Poster 502, Circle 503, Board 504, Card 505 |
| **List** (vertical lists) | Basic 506, Media 507, Expanded 508, FlixArt 509, FlixArt 2 549 |
| **Wall** (grids) | Square 510, Landscape 511, Poster 512, Circle 513, Board 514 |
| **Combined** (rail + list hybrid) | Square 520, Landscape 521, Poster 522, Circle 523, Board 524, List 526, Expanded 528 |

**Per-content rules** (`skinviewtypes.json → rules`): each of 30 content classes (movies, sets,
tvshows, seasons, episodes, genres, years, studios, actors, playlists, albums, artists, songs,
files, addons, recordings, games, videoversions, watch-providers, calendar…) declares which
views are allowed and its default for library vs plugin content. Examples: movies default to
Row Poster (502) and allow 14 views; episodes default to Row Landscape (501) and exclude poster
shapes; actors only allow poster/circle-ish views.

**User view configuration** is generated: "Select viewtypes" runs
`script.skinvariables action=buildviews,configure` (SkinSettings → Viewtypes) letting users
re-map default view per content class. The view dialog (§7) also jumps straight into this.

**View furniture** shared by all views (`Includes_Views.xml`): heading line with item count and
sort info (`View_Line`), spinners, scrollbar strip, info panels for the focused item
(`View_Row_Info`, `View_Combined_Info_Panel` showing artwork, plot, metadata), and a
**category selector** row (`Includes_Categories.xml`) for switching between sibling nodes.

**Detail toggles**: "Use simple text" (`View.UseDetailedListLabels`) switches list labels
between detailed (multi-line metadata) and plain; FlixArt views have configurable art size
(§15).

### Adaptation
Player currently has poster / wall / list. Target:
- Implement the **4-family × shape matrix** as component variants: Row and Wall already exist
  (shape variants are cheap); add **List family** (Basic, Media = artwork+metadata line,
  Expanded = tall art + plot, FlixArt = full-bleed background driven list) and **Combined**
  (left list, right info panel — excellent for desktop).
- **Per-content defaults with per-user overrides**: a `viewRules` map (content class → allowed
  views + default), configurable in Settings, exactly mirroring `skinviewtypes.json`. Content
  classes for the Player: films, series, seasons, episodes, collections, genres, years,
  studios, people.
- **Persist view choice per content class** (not per URL), like the skin does.
- Focused-item **info panel** in wall/list views (art, plot, chips) — Player detail pages
  already have the components to reuse.

---

## 7. View options & list tooling

Sources: `1080i/Custom_1171_Dialog_Views.xml` + `1080i/Dialog_DialogView.xml`,
`1080i/Custom_1170_Dialog_Options.xml`, `1080i/Includes_ButtonMenu.xml`.

A side "Options" dialog (1171) opens from any media window with contextual actions
(`DialogView_Items`):
- **View** (current view name, opens view selector with preview thumbnails),
- **Sort** (current sort method), **Order** (asc/desc with direction icon),
- **Watched filter** toggle (videos), **Filter** (opens Kodi filter UI), **Search**,
- **Update library** (when browsing local library), **Add-on settings** (when in a plugin),
- **Add Shortcut** (pin current path to home), and PVR-specific jumps (guide/channels/
  recordings/timers/search).

The options panel itself is customisable: **tile layout 2/3/4 columns**
(`OptionsTiles.Layout`), optional bottom tray (`Options.DisableBottomTray`), and an
"options tray" on the context menu can be disabled (`ContextMenu.DisableOptionsTray`).
The dialog header shows the current time — useful on TV.

**Alphabet jump**: scrolling behaviour setting `Navigation.DisableAlphabetJump` (Behaviour →
OnScroll) — long lists jump by initial letter when scrolling by page ("Letter" indicator,
string 31459).

### Adaptation
- Player's per-library toolbars should consolidate into a consistent **Options panel**
  (view / sort / order / watched filter / hide-unavailable / search / pin-to-home), invoked by
  one button everywhere, with a 2/3/4-column density option.
- **Pin current view to home** ("Add Shortcut") — saves the current library+filter as a rail
  or page tab.
- **Alphabet rail / letter jump** for A–Z browsing on long lists (already have A–Z source;
  add the jump UI).

---

## 8. Search

Sources: `1080i/Custom_1105_Search.xml`, `1080i/Includes_Search.xml`,
`shortcuts/skinvariables-shortcut-searchwidgets.json`,
`shortcuts/generator/data/base/search_*.xml`.

Search is a **full hub**, not a modal:
- **Search bar** with text edit, icon, and on-screen key row (`Search_Bar_Edit/Icon/Keys`),
  plus an **autocompletion dropdown** (`Search_Autocompletion_Dropdown`).
- Results render as **multiple simultaneous category widgets** — default set (configurable
  via the same shortcuts editor, `searchwidgets.json`): Movies (Poster), TV Shows (Poster),
  Albums (Square), Artists (Square), TMDb Movies, TMDb Shows. Each search widget has label,
  icon, path, target, and **widget_style**.
- **Two layout modes** (`Search.DisableCombined`): *Combined* — vertical rail of categories
  with one row visible plus a big info panel; *Standard* — stacked rows.
- **Discover row** (`Search.DisableDiscover`): a TMDb discover query seeded by the search term,
  shown above results in combined mode.
- **No-results messaging**: "There were no search results found / Please try another search"
  (strings 31500/31501) with dedicated layout.
- The search **term is double-encoded** for plugin URLs (`Search_Term_DoubleEncoder`) — an
  implementation detail showing search terms are piped into arbitrary content paths.
- Search can be disabled entirely from the menu (`HomeSwitcher.DisableSearch`).

### Adaptation
Player has library search. Upgrade to the hub model:
- **Category-sectioned results**: Films / Series / Episodes / People / Collections rows from
  one query (Archivist's unified DB makes this a single endpoint).
- **Configurable search sections** (order, style, on/off) like search widgets.
- **Autocomplete dropdown** from title index.
- **Deep-field search** options (actor, director, year, studio, plot) mirroring the skin's
  search shortcuts — the Archivist DB stores this metadata.
- Combined layout (rail of categories + focused row + info panel) for TV/desktop.

---

## 9. Info (detail) dialogs

Sources: `1080i/DialogVideoInfo.xml`, `1080i/Includes_DialogInfo.xml` (1,939 lines),
`1080i/Custom_1113/1114_Dialog_Plot.xml`, `1080i/Custom_1120_Dialog_SelectCrew.xml`,
`1080i/Custom_1122/1123` (trailer select/play), `1080i/Custom_1126_Dialog_FileProperties.xml`,
`1080i/DialogMusicInfo.xml`, `Dialog_DialogCustom.xml` (buttons config).

The info dialog is artwork-forward (full-bleed fanart, clearlogo) with a metadata block, action
buttons, and a **vertical stack of content widgets** below.

### 9.1 Configurable action buttons
Three button slots each for **Movies** and **Others** (TV/etc.), chosen from a 10-type
catalogue (`DialogCustom_Buttons_Items_Type`): **Trailer, Trakt, Wikipedia, Plot, Artwork,
User Rating, Versions, Extras, Refresh** (+ implicit primary Play/Browse). Defaults
(startup.json): Trailer / Trakt / Wikipedia. Overflow lives behind a "More options" button
(`DialogInfo_VideoButtons_Overflow`), including **File info** (opens the file-properties
dialog with codec/stream details) and **Position** in list.

### 9.2 Info widget rows (each individually toggleable)
`DialogCustom_VideoInfo_Items` — per-row disable switches:
Director, Writer, Creator, Starring (cast), Collection, Seasons, Episodes, Studio, Year, Crew,
Videos (trailers), Comments (Trakt reviews), Recommendations, Gallery. Plus data-source
options: **online vs local cast** (`Info.UseLocalCast`), **local vs online collection**,
**online gallery** on/off.

### 9.3 Supporting dialogs
- **Plot dialog** (1113/1114): full-plot reader; plus "Critics Consensus" surface (string
  31024) from ratings data.
- **Crew selector** (1120/DialogViewCrew): grouped crew browsing — Writer+Composer,
  Director+Photography+Producer groupings with role filters; clicking a person opens their
  TMDb person details.
- **Person view**: biography, age/birthday ("Years Old", "Birthday" strings), filmography
  widgets ("Movies and tv shows starring this actor", 31298).
- **Trailer selection** (1122) + windowed trailer player (1123), and a **picture-in-picture
  video** concept (string 31394).
- **Gallery** (`DialogInfo_GalleryWidget`) — fanart/image browsing per item.
- **File properties** (1126): container, video/audio/subtitle stream details.
- **Plotline** (home/hub subtitle under titles) configurable per type: Movies → Genre /
  Director / None; TV → Genre / Episodes / None (`Plotline.Movie`, `Plotline.TVShow`).

### Adaptation
Player detail pages already do backdrop/logo/chips/seasons. Additions in priority order:
1. **Toggleable detail-page sections** (cast, crew, collection, seasons, episodes, gallery,
   recommendations, comments/reviews if data exists) with a settings surface identical in
   spirit to `DialogCustom_VideoInfo_Items`.
2. **Configurable action buttons** (3 slots + overflow): Play, Trailer, Mark watched, Artwork
   picker, File info, Refresh metadata — all backed by existing Archivist endpoints.
3. **People pages** with filmography from the Archivist DB (cast/crew tables exist server-side).
4. **File info panel** — Archivist stores media stream metadata; expose it.
5. **Recommendations/Similar** — same-genre/same-collection queries server-side.
6. **Plotline setting** for card subtitles (genre / director / episode count / none).

---

## 10. Ratings system

Sources: `Dialog_DialogCustom.xml` (`DialogCustom_Ratings_*`), `Includes_Actions.xml`
(`Action_RatingsMonitor`), `Includes_SkinSettings.xml` (Details), startup defaults.

- **Three rating slots** each for Movies and TV Shows, individually assignable from **9
  providers**: Metacritic, Trakt, TMDb, RottenTomatoes User, RottenTomatoes Critic, IMDb,
  MDbList, Letterboxd, or None (plus "Awards" appears in the monitor list). Selecting a
  provider already used in another slot swaps them (swap logic in
  `DialogCustom_Ratings_Items_Template`).
- Defaults: Trakt + Metacritic (startup.json).
- **Ratings style** toggle: coloured vs monochrome rating badges (`Ratings.EnableColor`).
- **Star rating** display toggle (`InfoTags.DisableStarRating`).
- Ratings render in info dialogs, OSD info, and spotlight metadata rows.

### Adaptation
Archivist already aggregates external metadata. Implement:
- **Rating slots** (2–3 per media type) selectable from whatever providers Archivist stores
  (TMDb/TVDB community ratings now; extensible).
- Colour vs monochrome badge style; star-rating on/off.
- This is mostly a data question: define a `ratings[]` array on the player contract with
  provider + value + votes, and let the client map slots.

---

## 11. Indicators & badges

Source: `Dialog_DialogCustom.xml` → `DialogCustom_Settings_Items_Indicators`;
`shortcuts/skinvariables.xml` (`Defs_PercentPlayed`); strings 31210–31218, 31227.

Each indicator is individually toggleable:
- **Watched** check overlay (`Indicator.DisableWatched`)
- **Latest/New** badge (`Indicator.DisableLatest`)
- **In library** badge (`Indicator.DisableLibrary`) — for plugin/online items
- **Collection** badge (`Indicator.DisableCollection`)
- **Progress bar** on partially-watched items (`Indicator.DisableProgress`; percent logic
  combines `PercentPlayed` and custom `WatchedProgress` properties)
- **Episode progress** on shows: watched-episode **percentage**, or optional **unwatched
  count** mode (`Indicator.DisableEpisodes` / `Indicator.EnableUnwatchedCount`)
- **PVR catch-up** badge
- **Trakt watchlist / Trakt favourites** badges (needs TMDbHelper service)
- **Premiere/Finale banners** on episodes: Series/Season/Mid-Season Premiere and Finale
  (strings 31210–31218; toggle `Indicator.EpisodeTypeBanner`)
- **Movie version banner** (multiple versions of a film; `Indicator.MovieVersionBanner`)

### Adaptation
Player has watched/progress basics. Add, each with a toggle in one "Indicators" settings group:
- Unwatched-count vs percent mode for series cards.
- **New/Recently-added** badge (Archivist knows import dates).
- **Premiere/Finale** episode banners (episode numbering + season episode counts are in the
  DB; "Series Finale" needs show-ended status which Archivist tracks from metadata).
- **Downloading/Upgrading** badge — a Player-specific indicator the skin can't do: Archivist
  knows queue state (the "Downloading" rail already exists; surface it per-card).
- Collection badge on films that belong to a collection.

---

## 12. Playback OSD

Sources: `1080i/VideoFullScreen.xml`, `1080i/VideoOSD.xml`, `1080i/Includes_OSD.xml` (1,256
lines), `1080i/DialogSeekBar.xml`, `Custom_1140–1153_OSD_*.xml`,
`1080i/DialogPlayerProcessInfo.xml`, `1080i/MusicOSD.xml`, `1080i/MusicVisualisation.xml`.

### 12.1 Main OSD (VideoOSD.xml)
Left cluster: **Play/Pause, Skip-prev, Skip-next, Stop** (for live TV the middle buttons become
Guide and Record). Right cluster: **Info, Audio, Subtitles, Video settings** — the audio/
subtitle/video buttons show current language labels and open **custom stream-selector
overlays** (1146/1147/1148) on focus/up, with the native Kodi settings on click. A top slider
(8200) provides direct **seek scrubbing** with a progress nib.

### 12.2 OSD companion overlays (separate windows layered over video)
- **1145 Info panel** — auto-shows above the controls; content configurable: plot+ratings
  on/off, landscape art on/off (`OSD.DisplayInfoOnControls`, `OSD.DisablePlotRatingsOnInfo`).
- **1152/1153 Video info overlays** — title/metadata overlays top or bottom.
- **1140 Playlist / episodes** — up-next queue browsing during playback.
- **1141 Cast** — cast row over video (`Includes_OSD_CastInfo.xml` renders hint text +
  directional navigation).
- **1142 Music tracks**, **1151 music info overlay**.
- **1143 Next overlay** (§13).
- **OnDown carousel is configurable**: which panels are reachable by pressing down from the
  OSD, each toggleable — PVR guide, PVR channels, Playlist+Episodes, Bookmarks+Chapters, Cast
  (`OSD.OnDown.*` toggles in `DialogCustom_VideoOSD_Items`).

### 12.3 Seekbar & timing behaviour
- **Autoclose timeout** — user-set seconds (`OSD_Timeout`, numeric input).
- **Behaviour on pause**: keep seekbar / switch to info / hide, plus a **delay** of 0–3 s
  (`OSD.AutoOnPause`, `OSD.AutoOnPause.Delay`).
- **Time display**: Elapsed / Remaining / Combined (`Seekbar.TimeDisplay`, strings 31353–31355).
- **Seek-to label** ("Seek to", 31233) during scrub.

### 12.4 Advanced playback surfaces
- **Tempo/playspeed control** (`OSD_TempoControl`, "Playback Speed" 31071) with FF/RW step
  indicators.
- **Codec/process info** (DialogPlayerProcessInfo): decoder, pixel format, EOTF/gamut, bits,
  FPS, resource usage (CPU/RAM/FPS strings 31256–31263).
- **Bookmarks & chapters** (VideoOSDBookmarks.xml; "No bookmarks / Add a bookmark here"
  31088/31089, chapters 31429).
- **Subtitle search dialog** (DialogSubtitles.xml) with custom layout.
- **Music visualisation** with lyrics support (`script-cu-lrclyrics-main.xml`) and artist
  slideshow integration.
- **Volume/mute overlay** (DialogVolumeBar.xml), **notification toast** (DialogNotification).

### Adaptation
The Player's HTML5 player (space/arrows/f/m/Esc) is the foundation. Roadmap:
1. **OSD parity**: play/skip±/stop cluster; audio/subtitle stream selectors (HTML5 audio
   tracks & text tracks; Archivist streams provide track metadata); info toggle.
2. **Pause behaviour + autoclose + time-display settings** — direct ports.
3. **OnDown/secondary panels**: episode queue (next episodes of the show), cast strip, and
   chapters — as slide-up panels over the video.
4. **Playback speed control** (native `playbackRate`).
5. **Seek preview**: the skin lacks thumbnail scrubbing (no trickplay in Kodi skinning);
   Archivist could exceed the north star here by generating preview thumbnails server-side.
6. **Stats for nerds** panel from the file's stream metadata.

---

## 13. Up Next & post-play

Sources: `1080i/Custom_1143_OSD_NextOverlay.xml`, `script-upnext-upnext.xml`,
`script-upnext-stillwatching.xml`, `Includes_OSD.xml` (`OSD_UpNext*`), strings 31129–31131.

Three cooperating mechanisms:
- **Skin-native next overlay (1143)**: appears when a playlist has a next item **or fewer than
  10 minutes remain**, suppressed while chapters indicate credits haven't started. Shows
  landscape art + "Up Next – Title" and a skip-next action.
- **UpNext service integration** (`service.upnext` dependency): custom-skinned prompts —
  "Up next in N seconds" countdown (31129/31130) and a **"Still watching?"** interstitial
  (`script-upnext-stillwatching.xml`, "Continue watching in…" 31131).
- **Next-recommendation path** (`Path_OSD_NextRecommendation`) feeds the overlay's content.

### Adaptation
Direct port, and easier in the Player because it controls playback:
- **Up Next card** in the last N seconds (configurable) with countdown & auto-advance for
  episodes; Archivist knows the next episode ordinally.
- **Still Watching** prompt after X consecutive auto-advances.
- Post-play screen for films: "From the same collection / director" recommendations.

---

## 14. Appearance & theming

Sources: `Dialog_DialogCustom.xml` (ColourPresets/ColourHighlights/BackgroundImage/
BackgroundDialogImage/BackgroundStyle), `Custom_1111_Dialog_ColourPicker.xml`,
`colors/*.xml`, strings 31138–31148, 31220–31243.

### 14.1 Colour presets (one-tap looks)
Six curated presets (`DialogCustom_Settings_Items_ColourPresets`): **Bright White, Miami
Vaporwave, Aqua Classic, Tropical Sunset, Blue Slate, Midnight Purple** — each preset sets the
highlight colour *and* coordinated backgrounds.

### 14.2 Highlight colour
Preset swatches (Aqua `ff00b8d4`, Tropical `fff4511e`, Miami/Pink `ffe91e63`, Blue `ff0091ea`,
Purple `ff5528a8`, White default) **plus a full custom colour picker** (window 1111,
DialogColorPicker) with an "Invert Text Colour" companion (`RevertSelectedText`) so light
accents keep readable focused text.

### 14.3 Backgrounds — three independent layers
1. **Window background** (`Background.Image`): bundled blur images (Purple, Blue, Pink,
   Orange, Slate, Coal, Onyx) **or any user image** (file picker) — the chosen image is run
   through TMDbHelper's blur pipeline.
2. **Dialog background** (`Background.DialogImage`): **Adaptive** (derived from current
   artwork; default) or fixed (Classic, Blue, Purple, Pink, Green, Slate, Coal, Chalk, Onyx,
   Blush).
3. **Artwork background style** (`TMDbHelper.Blur.*`): fanart blur quality High(720)/
   Medium(480)/Low(240)/Off, each pairing blur radius; plus **FlixArt size** Normal 1280×720 /
   Large 1440×810 / XL 1600×900 with dedicated constants files
   (`Includes_Constants_FlixArt_*.xml`).

### 14.4 Themes
Two colour themes ship (`colors/defaults.xml` dark; "Skin default - Light dialogs.xml") — the
token system carries the rest.

### Adaptation
Player's "no skins, one look" stance can hold while adopting the *safe* subset:
- **Accent colour presets + custom picker** (focus/selection only) — this is the single
  highest-visibility customisation in Arctic Fuse and doesn't break the design language.
- **Background style setting**: artwork-blur intensity (High/Medium/Low/Off) for browse
  screens; static noir gradient as the Off state. Implement blur server-side (Archivist image
  proxy with a blur param) or CSS `filter` on downscaled art.
- **Adaptive dialog backgrounds** — tint detail modals from the item's artwork (CSS
  `color-mix` from a server-computed dominant colour).
- Light theme: defer; the token system makes it possible later without redesign.

---

## 15. Backgrounds & artwork pipeline

Sources: `1080i/Includes_Background.xml` (302 lines), `Includes_SkinSettings.xml`
(Behaviour → Extra fanart, Playback → Background video), `resource.images.*` deps in
`Includes_SkinSettings.xml` dependencies section.

- **Focused-item fanart** everywhere: the background follows focus (widgets, spotlight,
  lists), via blur or crop pipeline; quadrant-based blur loading (`Background_Blur_Quadrants`).
- **Extra fanart cycling** (`Background.ExtraFanart`): rotates through multiple fanarts of the
  focused item.
- **Background video** (`Background.DisableVideo` inverse): video keeps playing as the app
  background when returning home during playback (`Background_Video`, `Background_Video_
  Offscreen`).
- **FlixArt**: a full-bleed artwork mode for lists with size tiers (§14.3).
- **Resource packs**: studio logos (white + coloured), weather fanart, country-map icons —
  installable image libraries the skin uses for chips/flair.
- **Clearlogo-first titling**: logos render instead of text titles wherever available, with
  text fallback (`Includes_Fallbacks.xml`).

### Adaptation
- **Focus-follows artwork** backdrop on browse screens (Player detail pages already do
  full-bleed; extend to home/library with the blur setting).
- **Continue playing video in background/miniplayer** when navigating away — the web PiP API
  or an in-app miniplayer exceeds Kodi's capability here.
- **Multi-fanart cycling** on detail pages (Archivist stores multiple backdrops).
- **Studio logo chips** — Archivist has studio metadata; ship a curated SVG logo set.
- Clearlogo-first titles with text fallback (already partially done in Player).

---

## 16. Seasonal themes

Sources: `1080i/Includes_SeasonalThemes.xml`, `1080i/Custom_1192_SeasonalTheme.xml`,
`extras/backgrounds/holiday/`, strings 31610–31625, settings in `Includes_SkinSettings.xml`.

A fully optional, date-driven delight system (master toggle `SeasonalTheme.Enable`):
- **Christmas** (Dec 7 – Jan 7): theme variants **Winter Frost** or **Aussie Christmas**, or Off.
- **Summer Breeze** (Jun 21 – Aug 15), **Halloween Spook** (Oct 1 – Nov 1) — each toggleable.
- Granular layers, each with its own switch: **Background Overlay**, **Background Atmosphere**
  (looping ambience), **Fly-by Animations**, **Falling Props Density** (Off/Normal/High —
  snow/leaves particles).

### Adaptation
Low priority but cheap and brand-building: date-gated CSS particle/overlay layers with the
same master toggle + per-layer switches. Ship Off by default? Arctic Fuse ships it as opt-in
(`SeasonalTheme.Enable` is not in startup defaults) — mirror that.

---

## 17. Header / footer furniture

Sources: `1080i/Includes_Furniture.xml` (524 lines), `Includes_SkinSettings.xml` (Interface),
`1080i/MyWeather.xml`, `Custom_1161_Dialog_Weather.xml`.

- **Header**: date (or profile name when date disabled — `Home_Header_Label` variable),
  **weather chip** (temp + condition; toggle `Header.DisableWeather`), clock.
- **Footer**: **Now Playing bar** (`Footer.DisableNowPlaying`) showing current media with
  artwork while browsing; **Studio logo** of focused item (`Footer.DisableStudio`); optional
  **codec flags** (commented-out `Footer.EnableCodecs` — deliberately dormant).
- **Busy system**: unified spinner/branding treatment (`Furniture_Busy*`) with floating
  status text.
- Weather has a **full custom window** (1161) with forecast, rain chance, wind gusts, fire
  danger, radar, air quality (strings 31465–31531) — powered by weather add-ons.

### Adaptation
- **Persistent mini "Now Playing" bar** while browsing (Player controls playback, so this is
  natural) with resume-to-player click-through.
- Header clock/date for TV-mode; profile name display.
- Weather is out of scope for a media player (skip; it exists because Kodi is a whole-HTPC
  shell).
- Unified **loading/busy language**: one spinner treatment + status line (Player already has
  loading states; consolidate).

---

## 18. Startup experience

Sources: `1080i/Startup.xml`, `1080i/Custom_1198_Dialog_Startup.xml`,
`shortcuts/skinvariables-startup.json` (181 lines), `shortcuts/skinvariables-splash.json`,
`Dialog_DialogCustom.xml` (Startup items), settings in `Includes_SkinSettings.xml` (Other).

- **Splash screen (1198)** hides initialisation: status line cycles "Initialising Skin",
  "Reticulating Splines", "Waiting for PVR", "Preloading Hubs", "Loading Widgets" (strings
  31132/31133/31145/31249), with a timeout alarm as a fail-safe.
- **First-run defaults**: startup.json seeds a complete configuration on first launch
  (TMDbHelper service on, adaptive dialogs, purple background, PVR hub on, home spotlight =
  Random Movies, ratings/buttons defaults) — the skin is fully usable with zero setup.
- **Wait-for-load** (`Startup.DisableWaitForLoad`) — hide widget initialisation behind splash.
- **Hub preloading** (`Startup.EnableHubPreloading`) — visits each enabled hub during splash
  (300 ms apart) so first navigation is instant.
- **Custom startup visuals**: single image, image folder (rotates), or a **startup video**
  (`Startup.VideoPath`, played on launch), or warning-style default.
- **Startup window** choice honoured (`System.StartupWindow` replacement logic).

### Adaptation
- **Skeleton-splash**: the Player should render its shell instantly and hydrate rails behind
  a branded splash with status text; preload configured pages' first queries in parallel
  (the web equivalent of hub preloading is warming the query cache).
- **Sane first-run defaults**: seed a default page/rail config on first connect so the app
  looks great before any customisation — exactly what startup.json does.
- Custom startup image/video is a fun personalisation option; low priority.

---

## 19. Skin users (pseudo-profiles)

Sources: `1080i/LoginScreen.xml`, `1080i/Custom_1195_SkinUserLoginScreen.xml`,
`shortcuts/skinvariables-skinusers.xmltemplate`, `extras/profiles/` (15 bundled avatar images),
settings in `Includes_SkinSettings.xml` (Other), strings 31505–31508, 31359.

- **Skin users** are lightweight profiles *within* the skin ("pseudo profiles", 31507): each
  user gets an **independent widget/hub configuration** (the generator emits per-user include
  files: `script-skinvariables-generator-includes-{skinuser}.xml`).
- Per-user **name + avatar icon** (`SkinVariables.SkinUser.Name/Icon`), with bundled avatar
  art (`extras/profiles/Mountains (1-15).jpg`).
- **Login screen at startup** optional (`SkinUserLogin.StartupLoginScreen`), and a **Switch
  user** action available in menus/power menu (window 1195).
- Master toggle `SkinUserLogin.Disabled` resets user state.

### Adaptation
Maps to Player **profiles**: per-profile page/rail configuration, watch progress, and
avatar — stored per-profile in the browser (or server-side later, aligning with the Player
roadmap's "multi-profile sync" future phase). Start with: profile switcher on launch
(optional), per-profile home config + watch state.

---

## 20. Power menu & system shortcuts

Sources: `1080i/DialogButtonMenu.xml`, `1080i/Includes_ButtonMenu.xml`,
`shortcuts/skinvariables-shortcut-powermenu.json`,
`shortcuts/skinvariables-shortcut-config.json` (`links/commands/`),
`generator/data/base/power_*.xml`.

- The power menu is **user-configurable** (same editor as widgets): default items are
  Favourites, File Manager, Switch User, Quit; the full command catalogue includes log-off,
  screensaver, powerdown, minimise, reboot, reboot-to-Android, suspend, eject, reload skin,
  clean/update video & music libraries.
- A configurable **tray** variant (`power_tray.xml`) and tile-layout settings
  (`DialogShortcuts_Window_Settings_Power_Tiles`) exist.

### Adaptation
Most system commands are N/A for a web app. The Player equivalent is a **quick-actions menu**:
switch profile, refresh library (Archivist API), toggle TV mode/fullscreen, sign out, open
Archivist server UI. Keep it configurable only if cheap; otherwise fixed.

---

## 21. Settings UX itself

Sources: `1080i/SkinSettings.xml`, `1080i/Includes_Settings.xml`,
`1080i/Includes_SkinSettings.xml` (1,229 lines), `1080i/Custom_1118_Dialog_Settings.xml`,
`1080i/Custom_1119_Dialog_Select.xml`, strings 31550–31566.

The settings architecture is itself a feature:
- **Sectioned settings** with a category rail: Menus, Appearance, Viewtypes, Interface,
  Behaviour, Details, Other, Dependencies, Thanks — each with contextual description text
  ("This category contains customisation options for…", 31448).
- **Settings levels**: Basic / Standard / Advanced / Expert (`slevel` params on every item,
  descriptions 31564–31566: "General appearance and widget layout" → "Detailed adjustments"
  → "Development tools and experimental options"). Items hide below their level.
- **Reusable dialog machinery**: a generic settings dialog (1118) and select dialog (1119) are
  parameterised by window properties (`CustomDialogSettingsItems`, `CustomDialogSelectItems`) —
  every customisation flow reuses the same two shells.
- **Dependency manager**: lists each companion add-on with version, and install/enable/open-
  settings logic per state.
- **Reset**: full "Nuke Everything" reset that restarts the startup wizard (Expert level).
- **Debug tools** (Expert): debug grid overlay, info overlay, dialog test-harness buttons.

### Adaptation
- Player Settings should adopt **sections + levels**: default view shows Basic; an "Advanced"
  switch reveals the long tail. This keeps the huge option surface (everything in this
  document) approachable — the skin's key trick for offering ~150 options without overwhelm.
- **One reusable settings-sheet component** parameterised by config (mirrors 1118/1119).
- **Reset to defaults** per-section and global.
- Dependency manager is N/A (no add-ons); its analogue is a **server connection panel**
  (Archivist URL, API key, version, health).

---

## 22. Behaviour & performance options

Source: `Includes_SkinSettings.xml` (Behaviour), `Dialog_DialogCustom.xml` (Autoscroll).

- **Autoscroll interval** for auto-advancing widgets/spotlights: 5/8/10/12/15/20/30 s
  (`AutoScrollTime`).
- **Label autoscroll** (marquee) toggle; **textbox autoscroll** toggle; **fake textboxes**
  performance mode ("improves performance on Omega", `Textboxes.DisableFakeBox`).
- **Navigation OnBack**: Back goes to *Parent* folder vs *Previous* window
  (`Navigation.OnBack`).
- **Alphabet jump on scroll** toggle (§7).
- **Widget "prevent reload"** (§4.2) and **empty-placeholder** (§4.4) — both are
  performance/stability levers exposed honestly to the user.
- **Hub preloading**, **splash wait** (§18).
- **Mouse pointer size** 32/48/64 px; **touch mode** exists as a concept (string 31289);
  **on-screen keyboard size** option (31171).

### Adaptation
- Autoscroll interval, marquee toggles, and Back-behaviour (history vs hierarchy) port
  directly.
- The performance levers translate to: query cache warming, rail lazy-loading thresholds,
  image size tiers (§14.3's FlixArt sizes ≈ srcset policy), and reduced-motion mode (bonus:
  honor `prefers-reduced-motion`).

---

## 23. Accessibility, input & navigation

Sources: window `onup/ondown/onleft/onright` wiring throughout; `1080i/Pointer.xml`,
`1080i/DialogKeyboard.xml`, `1080i/DialogNumeric.xml`, `Includes_Home.xml` movement includes;
`defaultcontrol` declarations; hint-text includes (`OSD_CastInfo_HintText*`, "Press down"/
"Press right" strings 31594/31595).

- **Full D-pad navigation** with explicit focus chains everywhere — every list/button declares
  its neighbours; hidden "refocus" buttons preserve position across window switches
  (`Custom_refocuscustomwidgets` builtin, `FullscreenRefocus` property).
- **Directional hint labels** teach gestures in place ("Press down", "Press right").
- **Mouse/touch support** with pointer sizing and touch mode; custom on-screen **keyboard**
  and **numeric** dialogs, keyboard size setting.
- **Wrap vs bounded lists** ("Wrap" 31058), loop-back menu option (§2.3).
- Game-controller mappings for game content (`DialogGameControllers.xml`, "Select + X" style
  combos, strings 31336–31338).

### Adaptation
This is the area where the Player must be deliberate to reach north-star quality:
- **Complete keyboard/remote spatial navigation** (arrow keys + enter + back) across every
  screen with visible focus rings — the single biggest "feels like a real TV app" factor.
- Focus memory per rail/page (return to the same card).
- On-screen hint chips for discoverable gestures in player and walls.
- Touch/pointer already native to web; ensure parity rather than regression.

---

## 24. Features that don't translate

Explicitly out of scope for the Player, with reasons — listed so they're consciously excluded
rather than forgotten:

| Arctic Fuse feature | Why N/A for Archivist Player |
|---|---|
| Live TV / PVR hub, EPG grid, channel manager, timers, radio (`MyPVR*.xml`, 1107) | No PVR backend in Archivist (could return if a tuner integration ever lands) |
| Add-ons hub & browser (1108, `AddonBrowser.xml`) | No add-on ecosystem; Archivist provides content natively |
| Weather windows & widgets (`MyWeather.xml`, 1161) | Not a media concern; Kodi is an HTPC shell, the Player isn't |
| Kodi system commands (reboot/suspend/eject/etc.) | Browser sandbox |
| TMDbHelper/Trakt online-discovery widgets (untracked online content) | Player is deliberately library-first; discovery belongs to Archivist server features (requesting/monitoring) — though "recommended from your library" fills much of this space |
| Games windows (`MyGames.xml`, GameOSD, controllers) | Out of scope (note: Archivist has an arcade concept — see `../../04-features/arcade/overview.md` — so this could map someday) |
| Picture/slideshow windows (`MyPics.xml`, `SlideShow.xml`) | No image-library domain in Player MVP |
| Music visualisation/lyrics (`MusicVisualisation.xml`) | Music playback is a later Player phase |
| Screensaver (`screensaver-arctic-mirage.xml`) | Browser/OS handles idle; an in-app idle art mode is a possible delight feature |
| Skin dependency manager | No add-ons; replaced by server-connection panel |

---

## 25. Adaptation roadmap

A suggested phasing of everything above, by leverage:

### Tier 1 — Foundation (do first; unlocks everything else)
1. **Design tokens**: opacity-scale palette, accent-colour variable, motion primitives (§1).
2. **Full spatial keyboard/remote navigation + focus memory** (§23).
3. **Rail engine upgrade**: 6 styles, per-rail sort/limit/order, Show More tile, stable empty
   states, per-rail autoscroll (§4).
4. **Rail source catalogue + saved filters** (the smart-playlist equivalent) (§5).
5. **Settings architecture**: sections + Basic/Advanced levels + reusable sheet component (§21).

### Tier 2 — The customisation surface (the Arctic Fuse experience)
6. **Custom pages (hubs)** with per-page layout modes (Standard/Combined/Wall), name, icon,
   submenu links (§2).
7. **Per-page Spotlight** with source/limit/sort/auto-advance (§3).
8. **View-type matrix + per-content defaults** (§6) and the consolidated **Options panel** (§7).
9. **Accent colour presets + picker; background blur styles; adaptive dialog tints** (§14).
10. **Indicators group** with all toggles incl. unwatched counts and premiere/finale banners
    (§11).
11. **Detail-page section toggles + configurable action buttons + ratings slots** (§9, §10).

### Tier 3 — Playback polish
12. **OSD parity**: stream selectors, pause/timeout behaviours, time display modes (§12).
13. **Up Next / Still Watching / post-play** (§13).
14. **Now Playing footer bar + background/miniplayer video** (§15, §17).
15. **Playback speed, chapters/bookmarks, stats panel** (§12.4).

### Tier 4 — Character & depth
16. **Contextual (stacked) rails** — the standout innovation worth copying (§4.3).
17. **Search hub** with category widgets, autocomplete, deep-field search (§8).
18. **Profiles** with per-profile config and optional login screen (§19).
19. **Startup splash + cache warming + first-run defaults** (§18).
20. **People pages, crew browser, gallery** (§9.3).
21. **Seasonal themes** (§16), custom startup image/video, idle art mode.

---

### Closing note

Arctic Fuse 3's lesson is not any single feature — it is that **every surface is configurable
through one consistent, levelled settings system, while a strong default configuration means
nobody *has* to configure anything**. The skin achieves this on top of a hostile platform
(static XML + window properties + a code generator). Archivist Player, with a real database,
a real API, and a real component model, can reach the same destination with a fraction of the
machinery — and exceed it where Kodi is structurally limited (contextual rails, seek previews,
instant search, server-side artwork processing, true profiles).
