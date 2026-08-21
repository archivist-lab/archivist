---
title: "Archivist iconography review and unified icon pack"
document_type: design
status: canonical
classified: 2026-08-19
supersedes: docs/06-design/iconography.md
evidence:
  - docs/06-design/assets/icon-pack/icons.json
  - docs/06-design/assets/icons-svg-18-08-2026.zip
  - docs/06-design/assets/idents/
  - docs/06-design/assets/media-icons/
  - client/src
  - apps/player/src
  - apps/catalogue/src
  - apps/control/src
  - apps/server/src/player
---

# Archivist iconography review and unified icon pack

A full sweep of every icon, ident, emoji and glyph that Archivist renders,
deduplicated by meaning, plus the single icon pack that now covers all of it.

The earlier inventory at [`iconography.md`](iconography.md) is kept unchanged for
comparison. Where the two disagree, this document is current.

- **Pack:** [`assets/icon-pack/`](assets/icon-pack/)
- **Preview:** open `assets/icon-pack/archivist-icons.html`, or the published
  specimen sheet at <https://claude.ai/code/artifact/49951458-93f5-4d9f-8174-f966dec7fb7c>
- **Manifest:** `assets/icon-pack/icons.json`

## What was reviewed

483 source files across `client/`, `apps/player`, `apps/catalogue`, `apps/control`,
`apps/server` and `packages/`, scanned for emoji, Unicode symbol ranges, geometric
shapes, braille, dingbats and inline `<svg>`, plus every SVG and PNG asset in the
repository and in `docs/06-design/assets/`.

Typographic punctuation that is not doing an icon's job — ellipses, em dashes,
middots, multiplication signs used as `1920 × 1080` — was excluded. Arrows were
only counted where they render as a control rather than inside prose.

## Headline findings

**1. 108 distinct non-ASCII glyphs are being used as icons.** They resolve to 96
distinct concepts. The rest is the same idea drawn twice.

**2. Emoji are the primary icon system.** Roughly two thirds of Archivist's
iconography is emoji, rendered by the host font. That means the Library sidebar,
the Player navigation rail and the Catalogue nav all look materially different on
Linux, Windows, macOS and a TV browser — and none of them look like Archivist.
The design system already says "prefer the established vector/icon system over
emoji in primary UI"; in practice almost nothing followed it.

**3. The same emoji carries different meanings in different places.** `💿` is an
album placeholder in Music and the original PlayStation in the Arcade. `🎮` is
both the Games module and five separate PlayStation entries. `⚡` is a marketing
flourish in the setup wizard, an auto-grab action in Games and a get-issue action
in Comics. `✨` is Recommendations, natural-language search, the Golden Globes and
a settings marketing tile. `⚙️` is both Settings and Processing, which are two
different sidebar destinations. `🔒` is a locked channel slot and a
self-hosting privacy claim. Colour-only or emoji-only differentiation like this
also fails the accessibility rule in the design system.

**4. Some glyphs are placeholders that never got designed.** The Games module
identifies Xbox with `💚`, the Nintendo Switch with `🔴`, Sega with `🌀`, the Mega
Drive with `🦔`, the N64 with `🌟`, the Master System with `🎯` and the Saturn
with `🪐`. These are jokes standing in for platform marks.

**5. Four separate icon systems already exist and none of them agree.**

| System | Grid | Stroke | Coverage |
|---|---|---|---|
| `apps/player/src/components/Icons.tsx` | 24 | 1.8 | 11 icons |
| `docs/06-design/assets/idents/` | 64 | 3.2 | 10 idents |
| `docs/06-design/assets/media-icons/` | 200 | filled gradients | 6 marks |
| `assets/icons-svg-18-08-2026.zip` | 64 | 3 | 128 icons |

Plus loose inline SVG in `Cards.tsx`, `Sidebar.tsx`, `ui.tsx`, `App.tsx` and
`main.tsx` that belongs to no system at all.

**6. Player hub icons are free text.** `apps/player/src/pages/Settings.tsx` lets a
user type any character into a hub icon field, and the server seeds defaults of
`▯`, `▤`, `◉` and `⌂` in `apps/server/src/player/hub-service.ts:436`. Whatever
the pack does, that field will keep producing inconsistent results until it
becomes a picker over a fixed registry.

## Assessment of the 18-08-2026 set

This is the right look and feel and the pack is built on it directly. It is
coherent, correctly weighted for a dark interface, and its optical stroke
compensation (`strokeFor`) is a genuinely good decision that the pack keeps.

Three things needed fixing before it could be the single source.

**Seven names shared geometry with another name.** `expand-right` was byte-identical
to `chevron-right`; `auto-grab` and `quick-action` were both identical to `bolt`;
`featured` was identical to `sparkle`; `platform-pc-steam` was identical to
`platform-pc`; `award-academy` was identical to `award`. Each of those pairs is a
real distinction in the product, so all six now carry their own drawing rather
than being silently the same shape.

**Coverage stopped at the Library.** The set had nothing for the Control cockpit,
nothing for Catalogue, nothing for the media processing pipeline that Films and
Series both surface, and nothing for the library status vocabulary.

**No alias layer.** Several concepts genuinely are the same picture — "All" in the
status dropdown and "All" in the search categories, or an artist avatar and an
author avatar. Without aliases those become copy-pasted duplicates within weeks.

## Assessment of the legacy asset sets

**`assets/idents/` — superseded.** Correct instinct, same 64 grid, but a different
stroke weight (3.2 against 3), and every ident carries a small solid dot placed
off the drawing — `films.svg` puts it at `52,14`, floating in empty space with no
relationship to the reel. It reads as a rendering artefact rather than a motif.
The pack's `reel`, `groove`, `folio` and module icons replace all ten.

**`assets/media-icons/` — superseded.** These are 200×200 filled marks with
layered gradients derived from `spinner.svg`. They are decorative brand tiles, not
interface icons, and their treatment is directly at odds with the monoline
language you selected. They also duplicate module identity the pack now owns:
films, tv, music, photos, channels, collections. Two of those six — `photos` and
`collections` — did not exist anywhere in the pack or the codebase, so both are
now covered (`photos` aliases `artwork`; `collections` is newly drawn).

Both folders are left in place so you can compare, with a superseded note in
their READMEs. Nothing in the applications imports them.

**`client/src/icon.svg` and `client/src/spinner.svg` — keep.** These are the
product mark and the loading animation, a separate tier from an icon pack, and
they are the origin of the palette. The pack adds `archivist-mark` as a monoline
reduction for places where the full mark is too detailed to read at 20px.

## The pack

180 icons, one drawing per concept, plus 18 aliases. 64-unit grid, 3-unit stroke,
`currentColor` throughout, round caps and joins, solid marks used sparingly for
emphasis.

| Group | Icons |
|---|---|
| Player marks | 4 |
| Modules | 10 |
| Navigation | 28 |
| Playback | 28 |
| Actions | 40 |
| Status | 24 |
| Infrastructure | 19 |
| Platforms | 17 |
| Awards | 10 |

The build asserts that no two icons share geometry, so the pack cannot drift back
into duplication. Anything that is genuinely the same picture must be declared an
alias instead.

### What is new relative to the 18-08 set

Forty-nine drawings, covering the surfaces the set did not reach.

- **Music, properly:** `music` was a cassette shell, which named a format rather
  than the domain; it is now a beamed pair of quavers. `artist` (a microphone,
  promoted from an alias of `user`) and `song` (a single quaver) join `album` so
  the domain has all four of its nouns.
- **Library navigation the sidebar actually has:** `leaving-soon`, `collections`,
  `libraries`, `definitions`, `system`, `processing`, `torrents`.
- **Catalogue:** `catalogue`, `people`, `flows`.
- **Control cockpit:** `control`, `performance`, `services`, `recovery`,
  `journal`, `capabilities`, `files`, `folder-up`.
- **Library status vocabulary:** `collected`, `missing`, `continuing`, `ended`,
  `in-cinemas`, `at-home`, `trending`, `upcoming`.
- **Media processing pipeline:** `loudness`, `track-cleaning`, `segments`,
  `chapters`, `subtitles`, `headphones`, `scan`.
- **Transport the Player OSD will need:** `volume`, `volume-muted`, `skip-next`,
  `skip-previous`, `fullscreen`, `fullscreen-exit`, `cast`.
- **Ordinary controls that were missing:** `import`, `logout`, `minus`, `undo`,
  `more`, `menu`, `link`.
- **Brand:** `archivist-mark`.

### Deliberate exclusion: country flags

`apps/player/src/components/MediaSelector.tsx` generates a flag emoji per audio
and subtitle track, currently across 41 mapped countries, and any BCP-47 tag with
a region can produce any other ISO country flag. A hand-drawn flag set is not
viable in this language: flags are colour-and-fill artefacts, they carry political
weight, a monoline 3-stroke rendering of most of them is illegible at 20px, and
the mapping is open-ended rather than a fixed 41.

The recommendation is to stop drawing flags. Render the ISO code in JetBrains Mono
as a small chip — `EN`, `FR`, `JA` — which is what the design system already
reserves the mono face for, and use `language-unknown` for undetermined tracks.
This is more accurate too: a flag names a country, and an audio track has a
language.

## Deduplicated inventory

Every icon in the pack, the emoji or glyph it retires, its aliases, and the
surfaces it serves. An em dash under **Retires** means the icon is new capability
rather than a replacement.


### Player marks (4)

| Icon | Retires | Aliases | Surfaces |
|---|---|---|---|
| `archivist-mark` | — | — | compact product mark at icon scale |
| `folio` | — | — | Player books ident; idents/books.svg |
| `groove` | — | — | Player music ident; idents/music.svg |
| `reel` | 🎞️ | `items` | Player film ident; catalogue Items nav; idents/films.svg |

### Modules (10)

| Icon | Retires | Aliases | Surfaces |
|---|---|---|---|
| `album` | 💿 | — | client music album placeholder |
| `artist` | 🎵 | — | client music artist detail poster; artist placeholders |
| `book` | 📖 📚 | — | client Sidebar; client books/comics/dashboard; ImportFilesTab |
| `comics` | 🦸 | — | client Sidebar; client comics/dashboard/setup |
| `film` | 🎬 | — | client Sidebar; client films/series/dashboard/setup; player Shell; catalogue poster fallback |
| `games` | 🎮 | — | client Sidebar; client games/dashboard; player Arcade default |
| `music` | 🎵 | — | client Sidebar; client music/dashboard; catalogue poster fallback |
| `retrozone` | — | — | player Arcade shell |
| `series` | 📺 | `episode` | client Sidebar; client series/channels/dashboard; player Shell |
| `song` | — | — | album track listings |

### Navigation (28)

| Icon | Retires | Aliases | Surfaces |
|---|---|---|---|
| `acquisitions` | ⏬ | — | client Sidebar |
| `activity` | ● | — | settings rapid-poll badge |
| `all-media` | 🌐 ◉ | `status-all` | ManualSearch All; LibraryStatusDropdown All |
| `artwork` | 🖼️ | `photos` | MetadataEditorModal; films artwork editor |
| `bell` | — | `notifications` | notification surfaces |
| `calendar` | — | — | client calendar surfaces |
| `catalogue` | — | — | Catalogue product mark |
| `channels` | 📡 | `on-the-air` | client Sidebar/channels; player Shell TV; series On The Air |
| `collections` | 🗃️ | — | client Sidebar; settings index |
| `control` | — | — | Control product mark |
| `custom-hub` | ◆ | — | player Settings new hub default |
| `dashboard` | 🏠 | `overview` | catalogue Overview nav |
| `definitions` | 📐 | — | client Sidebar; settings groups |
| `flows` | 🔄 | — | catalogue Flows nav |
| `history` | — | — | activity history surfaces |
| `home` | 🏠 ⌂ | — | client Sidebar; player Shell; catalogue nav; server hub defaults |
| `leaving-soon` | ⌛ | — | client Sidebar; player Shell; settings index |
| `libraries` | 🗂️ | — | client Sidebar; settings groups |
| `library` | ◈ | — | client LibrarySelector |
| `lists` | ☷ | — | client Sidebar; settings index |
| `people` | 👥 | — | catalogue People nav |
| `processing` | ⚙️ 🛠️ | — | client Sidebar; settings groups; ProcessingMonitorTab |
| `queue` | — | — | processing + download queues |
| `search` | 🔍 🔎 | — | client search inputs; ManualSearch; UnifiedAddMedia; player Shell |
| `settings` | ⚙️ | — | client Sidebar; player Shell/App |
| `system` | 🖥️ | — | client Sidebar; settings groups |
| `torrents` | ⠿ | — | client TorrentsPage; DownloadMonitor |
| `user` | — | `author` | catalogue username; people/artist/author fallbacks |

### Playback (28)

| Icon | Retires | Aliases | Surfaces |
|---|---|---|---|
| `audio` | — | — | player audio-track controls |
| `captions` | CC | — | player subtitle controls |
| `cast` | — | — | player device targeting |
| `chapters` | 🔖 | — | client series chapter editor |
| `forward-10` | +10 | — | player OSD |
| `fullscreen` | — | — | player transport |
| `fullscreen-exit` | — | — | player transport |
| `headphones` | 🎧 | — | client series audio-track editor |
| `language-unknown` | 🌐 | — | player MediaSelector undefined language |
| `loudness` | 🔊 | — | client series/films volume normalisation |
| `lyrics` | — | — | client music track lyrics editor |
| `media-tracks` | — | — | player Icons.tsx; TrackMenu |
| `pause` | ⏸ Ⅱ | — | player OSD; settings queue; ProcessingMonitorTab; DownloadMonitor |
| `play` | ▶ | — | client film hero; player OSD/Rail/Channels; queue resume; DownloadMonitor |
| `quality-bars` | — | — | release quality display |
| `rating` | — | — | rating meters |
| `restart` | — | — | player Icons.tsx |
| `rewind-10` | −10 | — | player OSD |
| `segments` | ⏭️ | — | client series/films intro & credit detection |
| `skip-next` | — | — | player transport |
| `skip-previous` | — | — | player transport |
| `stop` | ■ | — | player OSD |
| `subtitles` | 💬 | `subtitles-edit` | client series subtitle editor |
| `track-cleaning` | 🧹 | — | client series/films track cleaning |
| `trailer` | — | — | player Icons.tsx |
| `volume` | — | — | player volume control |
| `volume-muted` | — | — | player mute state |
| `watched` | ✓ | — | player Icons.tsx; Cards.tsx inline SVG; player Channels |

### Actions (40)

| Icon | Retires | Aliases | Surfaces |
|---|---|---|---|
| `add` | + ＋ | — | client add-media buttons; ImportFilesTab; bookmarks/sources |
| `auto-grab` | ⚡ | — | games auto grab; comics get issue |
| `backspace` | ⌫ | — | player on-screen keyboard |
| `bolt` | ⚡ | — | SetupWizard accent |
| `chevron-down` | ▼ ▾ | — | every disclosure and dropdown; Sidebar inline SVG |
| `chevron-left` | ← | — | back, previous day |
| `chevron-right` | → | — | next, continue; player Icons.tsx |
| `chevron-up` | ▲ | — | collapse and reorder |
| `close` | ✕ × | — | every modal close; filter chips; catalogue; control; player Arcade/Channels |
| `copy` | — | — | copy to clipboard |
| `delete` | 🗑 | — | DownloadMonitor delete files |
| `download` | ↓ ⬇️ | `downloads` | client grab buttons; Sidebar Downloads; transfer rates |
| `drag-handle` | ⠿ | — | TorrentsPage row drag |
| `edit` | ✎ | — | client ui.tsx hover edit; films edition editor |
| `expand-right` | ▶ | — | client file-tree disclosure; Dashboard groups; TorrentsPage |
| `external` | ↗ | — | control file open |
| `filter` | — | — | client filter builders |
| `grid-view` | — | `preview` | library layout toggle |
| `hidden` | — | — | hidden/excluded state |
| `import` | 📥 | — | settings library import |
| `link` | — | — | linked records |
| `list-view` | ▤ | — | library layout toggle; control file rows |
| `lock` | 🔒 | — | channels locked slot; settings self-hosted copy |
| `logout` | — | — | catalogue sign out |
| `menu` | ≡ | — | control journal nav; compact navigation |
| `minus` | − | — | client Dashboard partial checkbox |
| `more` | — | — | overflow menus |
| `move-down` | ▼ ↓ | — | queue/source/rail reordering |
| `move-up` | ▲ ↑ | — | queue/source/rail reordering |
| `quick-action` | ⚡ | — | accelerated actions |
| `refresh` | ↻ | — | settings tools; player Arcade refresh; player Icons.tsx |
| `save` | 💾 | — | settings save buttons |
| `scan` | 🔍 | `scan-library` | settings Scan Library |
| `sort` | — | — | client sortable columns |
| `sync` | — | — | in-flight synchronisation |
| `tag` | — | — | client tags |
| `undo` | ↶ | — | control recovery; FileMetadataEditorModal undo |
| `unlock` | 🔓 | — | channels unlock slot |
| `unwatched` | — | — | player card state |
| `upload` | ↑ | — | transfer rates |

### Status (24)

| Icon | Retires | Aliases | Surfaces |
|---|---|---|---|
| `at-home` | ⌂ | — | LibraryStatusDropdown At Home |
| `check` | ✓ ✔ ✅ | `grabbed` | client selection lists; TrackMenu; SetupWizard; notify |
| `collected` | ✓ | — | LibraryStatusDropdown Collected |
| `continuing` | ↻ | — | LibraryStatusDropdown Continuing |
| `ended` | ■ | — | LibraryStatusDropdown Ended |
| `failure` | ✕ ! | — | notify; IndexersPage test fail |
| `featured` | ✨ | — | recognition/featured state |
| `in-cinemas` | ▷ | — | LibraryStatusDropdown In Cinemas |
| `information` | — | — | player Icons.tsx; more-information affordances |
| `live` | ● | — | player Channels on-now; live programme |
| `missing` | ○ | — | LibraryStatusDropdown Missing |
| `pending` | ◷ | — | work in flight |
| `rating-star` | ★ | `top-rated` | ratings; player Icons.tsx; Cards.tsx inline SVG; hub icons |
| `rating-star-empty` | ☆ | — | empty rating |
| `rating-star-half` | — | — | half-star rating, replaces clipped SVG |
| `recommendation-empty` | ✦ | — | no recommendation findings |
| `set-default` | ★ ☆ | `default-edition` | films default edition |
| `signal` | 📶 | — | availability/network |
| `sparkle` | ✨ | `natural-language` | recommendations; natural-language search; settings marketing grid |
| `success` | ✓ ✅ | — | notify; IndexersPage test OK; tool availability |
| `trending` | ↗ | — | films/series discovery Trending |
| `unknown` | ❓ | — | books/games/music/comics not-found states |
| `upcoming` | ◷ | — | LibraryStatusDropdown; films/series discovery |
| `warning` | ⚠️ | — | notify; settings hardware note; films load error |

### Infrastructure (19)

| Icon | Retires | Aliases | Surfaces |
|---|---|---|---|
| `capabilities` | ◇ | — | control Capabilities nav |
| `cpu` | 🧠 | — | hardware, field-aware search copy |
| `database` | 🗄️ | `tables` | catalogue Tables nav; SetupWizard storage step |
| `disk` | — | — | storage devices |
| `files` | ▱ ▰ | — | control file browser |
| `folder` | ▱ | — | root folders; control Files nav |
| `folder-up` | ↰ | — | control parent directory |
| `indexer` | ◈ | — | IndexersPage |
| `journal` | ≡ | — | control Journal nav |
| `key` | 🔑 | `api-key` | API keys; catalogue primary-key column |
| `magnet` | — | — | torrent/magnet links |
| `network` | — | — | network health |
| `performance` | ⌇ | — | control Performance nav |
| `recovery` | ↶ | — | control Recovery nav |
| `server` | — | — | server health |
| `services` | ◫ | — | control Services nav |
| `shield` | 🔒 | — | security/privacy surfaces |
| `storage` | 🗄️ ◉ | — | SetupWizard storage step; control Storage nav |
| `test-connection` | ◈ | — | IndexersPage test button |

### Platforms (17)

| Icon | Retires | Aliases | Surfaces |
|---|---|---|---|
| `platform-arcade` | 🕹️ | — | generic arcade system |
| `platform-cartridge` | — | — | cartridge-era generic |
| `platform-disc` | 💿 | — | disc-era generic |
| `platform-genesis` | 🦔 | — | player Arcade genesis |
| `platform-handheld` | 🕹️ | — | player Arcade gameboy; Game Gear |
| `platform-master-system` | 🎯 | — | player Arcade mastersystem |
| `platform-n64` | 🌟 | — | player Arcade n64 |
| `platform-nintendo-classic` | 🕹️ | — | games NES/SNES/N64/Wii/Wii U/3DS; player Arcade nes/snes |
| `platform-nintendo-switch` | 🔴 | — | games Nintendo Switch |
| `platform-pc` | — | — | generic PC platform |
| `platform-pc-steam` | 💻 | — | games Steam/PC |
| `platform-playstation` | 🎮 | — | games PlayStation 1-5 |
| `platform-playstation-classic` | 💿 | — | games PlayStation 1; player Arcade psx |
| `platform-playstation-handheld` | 📟 | — | games PSP and Vita |
| `platform-saturn` | 🪐 | — | player Arcade saturn |
| `platform-sega` | 🌀 | — | games Sega family |
| `platform-xbox` | 💚 | — | games Xbox family |

### Awards (10)

| Icon | Retires | Aliases | Surfaces |
|---|---|---|---|
| `award` | 🏆 | — | generic award |
| `award-academy` | 🏆 | — | films Academy Awards |
| `award-bafta` | 🎭 | — | films BAFTA |
| `award-berlin` | 🐻 | — | films Berlin |
| `award-cannes` | 🌿 | — | films Cannes |
| `award-golden-globes` | ✨ | — | films Golden Globes |
| `award-laurel` | — | — | festival selection |
| `award-sundance` | ☀️ | — | films Sundance |
| `award-tiff` | 🍁 | — | films TIFF |
| `award-venice` | 🦁 | — | films Venice |

## Aliases

Eighteen second names that resolve to an existing drawing. They exist so call
sites can say what they mean without the pack growing a near-duplicate.

| Alias | Resolves to | Why |
|---|---|---|
| `status-all` | `all-media` | "All" in the status dropdown and "All" in search categories are the same idea |
| `on-the-air` | `channels` | Series discovery filter |
| `top-rated` | `rating-star` | Discovery filter |
| `natural-language` | `sparkle` | Smart search shares the generated-content mark |
| `photos` | `artwork` | Retires the legacy `media-icons/photos.svg` |
| `preview` | `grid-view` | Retires the legacy `media-icons/preview.svg` |
| `subtitles-edit` | `subtitles` | Editor and display are one concept |
| `scan-library` | `scan` | Settings action |
| `default-edition` | `set-default` | Films edition marker |
| `episode` | `series` | Episode placeholders |
| `author` | `user` | Books author avatar fallback |
| `notifications` | `bell` | — |
| `downloads` | `download` | Sidebar destination and the action |
| `api-key` | `key` | — |
| `tables` | `database` | Catalogue nav |
| `items` | `reel` | Catalogue nav |
| `overview` | `dashboard` | Catalogue and Control nav |
| `grabbed` | `check` | Release grabbed confirmation |

## Adoption

Steps 1 and 2 are done. The rest is in order, cheapest and most visible first.

1. ~~Export `Icon.tsx` from `packages/design-system`.~~ **Done.**
   `packages/design-system/src/Icon.tsx` is a generated copy — regenerate it with
   `python3 build_pack.py --sync` rather than editing it. It has no dependencies
   beyond React and inlines every path, so there is no sprite to host.
2. ~~Replace the two navigation surfaces.~~ **Done.** `Sidebar.tsx` and the
   Player's `SideRail` now draw from the pack, removing 18 emoji and the inline
   disclosure chevron. Player hub icons resolve through `hubIcon()`: a pack name
   or a glyph the server used to seed becomes a drawing; anything else a user
   typed is still rendered as their character, until step 7 gives them a picker.
3. Retire `apps/player/src/components/Icons.tsx`. All 11 of its names exist in the
   pack; the 24-grid drawings are the only thing lost, and the pack's optical
   stroke compensation covers the sizes they were serving.
4. Replace the inline SVG in `Cards.tsx`, `Sidebar.tsx`, `ui.tsx`,
   `catalogue/App.tsx` and `control/ui/main.tsx`.
5. Convert the Games platform table in `client/src/modules/games/index.tsx` and
   the Arcade map in `apps/player/src/components/Arcade.tsx` to `platform-*`
   names. This is where the emoji are least defensible.
6. Convert `LibraryStatusDropdown`, the Films and Series discovery filters, and
   the processing pipeline rows.
7. Turn the Player hub icon field into a picker over `ICON_NAMES`, and change the
   server defaults in `apps/server/src/player/hub-service.ts:436` from `▯ ▤ ◉ ⌂`
   to `film`, `series`, `channels`, `home`. The rail already maps those four, so
   this is a cleanup rather than a fix; once it lands, drop `LEGACY_HUB_GLYPHS`
   and the free-text branch from `Shell.tsx`.
8. Replace flag emoji in `MediaSelector.tsx` with mono ISO chips.

Steps 3–4 remove the rest of the cross-platform inconsistency. Steps 5–8 are
where the product stops looking borrowed.

## Regenerating

The pack is generated, not hand-maintained.

```bash
cd docs/06-design/assets/icon-pack/build
python3 build_pack.py
```

Pass `--sync` to also refresh `packages/design-system/src/Icon.tsx`, which is
what the applications import.

`additions.py` holds new and redesigned geometry plus the alias map, `retires.py`
holds what each icon replaces and where, `preview.py` renders the specimen sheet,
and `source-2026-08-18.svg` is the accepted set preserved as the base layer. The build writes the sprite, the React
component, the manifest, the preview sheet and 177 standalone SVGs, and fails if
any two icons end up with identical geometry.
