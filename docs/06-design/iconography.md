---
title: "Archivist Icons and Emojis"
document_type: design
status: historical
classified: 2026-08-16
---
# Archivist Icons and Emojis

This document inventories icons used by the Archivist Server web interface and the Archivist Player application. It covers:

- `archivist/client/src` — Server web interface;
- `archivist/apps/player/src` — Player application; and
- backend-provided Player hub icon defaults.

The Kodi add-on is not included.

No third-party icon library is currently used. The interfaces contain a mixture of emoji, Unicode symbols, a small internal SVG collection and two standalone SVG assets.

The list below is deduplicated primarily by semantic purpose. Where the same emoji represents two different concepts, separate replacement assets are recommended.

## Navigation and media types

| Proposed SVG name | Current glyph | Purpose |
|---|---:|---|
| `home` | 🏠 / ⌂ | Home navigation and default home hub |
| `film` | 🎬 | Films, film pools and film placeholders |
| `series` | 📺 | Series, television and episode placeholders |
| `music` | 🎵 | Music and artist placeholders |
| `album` | 💿 | Album artwork placeholder |
| `book` | 📖 | Authors and books |
| `comics` | 🦸 / 📚 | Comics and comic-series placeholders |
| `games` | 🎮 | Games and generic game platforms |
| `channels` | 📡 | Channels and live television |
| `acquisitions` | ⏬ | Acquisitions navigation |
| `settings` | ⚙ / ⚙️ | Settings navigation |
| `search` | 🔍 / 🔎 / ◈ | Search inputs and search results |
| `all-media` | 🌐 | “All” media search category |
| `language-unknown` | 🌐 | Unknown audio/subtitle language |
| `artwork` | 🖼️ | Missing artwork and artwork editor |
| `storage` | 🗄️ | Initial storage/setup step |
| `custom-hub` | ◆ | Newly created Player hubs |

## Playback and media controls

| Proposed SVG name | Current representation | Purpose |
|---|---:|---|
| `play` | ▶ | Play, resume and watch-from-here |
| `pause` | ⏸ / Ⅱ | Pause playback or processing |
| `stop` | ■ | Stop playback |
| `restart` | Inline SVG | Restart media from the beginning |
| `rewind-10` | `−10` | Seek backwards ten seconds |
| `forward-10` | `+10` | Seek forwards ten seconds |
| `trailer` | Inline SVG | Play trailer |
| `watched` | Eye SVG / ✓ | Watched state |
| `unwatched` | Empty state | Unwatched state |
| `media-tracks` | Inline slider SVG | Audio and subtitle selection |
| `captions` | `CC` | Subtitle controls |
| `audio` | Text currently | Audio-track controls |
| `check` | ✓ / ✅ | Selected or successful |
| `close` | ✕ / × / inline SVG | Close modal, remove or dismiss |
| `backspace` | ⌫ | Player onscreen keyboard |
| `add` | `+` | Add media, bookmark, source or setting |
| `delete` | 🗑 | Delete files/download |
| `edit` | ✎ | Edit metadata, editions or tracks |
| `save` | 💾 | Save/backup-related actions |
| `refresh` | ↻ / ⟳ | Refresh metadata, tools or arcade |
| `sync` | Circular arrow | Synchronization/in-flight activity |
| `chevron-left` | ← | Back and previous day |
| `chevron-right` | → / inline SVG | Next, continue and navigation |
| `chevron-up` | ▲ | Collapse or reorder upwards |
| `chevron-down` | ▼ / ▾ | Expand or reorder downwards |
| `expand-right` | ▶ | Expand file tree |
| `move-up` | ↑ | Queue/source reordering |
| `move-down` | ↓ | Queue/source reordering |
| `drag-handle` | ⠿ | Torrent/file drag handle |
| `download` | ↓ | Download/grab and download speed |
| `upload` | ↑ | Upload speed |
| `lock` | 🔒 | Locked channel slot |
| `unlock` | 🔓 | Unlock channel slot |
| `set-default` | ☆ / ★ | Set or display default film edition |
| `test-connection` | ◈ | Test indexer/connection |
| `auto-grab` | ⚡ | Automatic grab/search action |

## Status, rating and feedback

| Proposed SVG name | Current glyph | Purpose |
|---|---:|---|
| `success` | ✓ / ✅ | Successful operation or tool available |
| `failure` | ✕ / `!` | Failure or unavailable tool |
| `warning` | ⚠ / ⚠️ | Warning and load failure |
| `unknown` | ❓ | Missing/not-found item |
| `information` | Inline SVG | More information |
| `live` | ● | Live channel/current programme |
| `activity` | ● / ⟳ | Rapid polling or active operation |
| `signal` | 📶 | Availability/network signal |
| `recommendation-empty` | ✦ | No recommendation findings |
| `rating-star` | ★ / inline SVG | Ratings |
| `rating-star-empty` | ☆ | Empty rating/default star |
| `rating-star-half` | Clipped SVG | Half-star rating |
| `featured` | ✨ | Recognition/featured state |
| `quick-action` | ⚡ | Accelerated or automatic action |

## Game-platform icons

These should ideally become actual platform-family symbols rather than literal translations of the current emoji.

| Proposed SVG name | Current glyph | Platforms |
|---|---:|---|
| `platform-pc-steam` | 💻 | Steam/PC |
| `platform-playstation` | 🎮 | PlayStation 1–5 |
| `platform-playstation-handheld` | 📟 | PSP and Vita |
| `platform-xbox` | 💚 | Xbox, Xbox 360, Xbox One, Series X/S |
| `platform-nintendo-switch` | 🔴 | Nintendo Switch |
| `platform-nintendo-classic` | 🕹️ | NES, SNES, N64, Wii, Wii U and 3DS |
| `platform-sega` | 🌀 | Dreamcast, Saturn, Mega Drive and Master System |
| `platform-arcade` | 🕹️ | Generic arcade system |
| `platform-master-system` | 🎯 | Arcade Master System representation |
| `platform-genesis` | 🦔 | Mega Drive/Genesis |
| `platform-n64` | 🌟 | Nintendo 64 |
| `platform-playstation-classic` | 💿 | Original PlayStation |
| `platform-saturn` | 🪐 | Sega Saturn |

There is deliberate semantic duplication in this section. For example, `💿` currently means both an album and the original PlayStation. These should become separate SVG assets.

## Award and festival icons

These are hard-coded on the film information page.

| Proposed SVG name | Current glyph | Award |
|---|---:|---|
| `award-academy` | 🏆 | Academy Awards |
| `award-cannes` | 🌿 | Cannes/Palme d’Or |
| `award-golden-globes` | ✨ | Golden Globes |
| `award-bafta` | 🎭 | BAFTA |
| `award-venice` | 🦁 | Venice/Golden Lion |
| `award-berlin` | 🐻 | Berlin/Silver Bear |
| `award-sundance` | ☀️ | Sundance |
| `award-tiff` | 🍁 | Toronto International Film Festival |

Source: `archivist/client/src/modules/films/index.tsx`.

## Dynamic country flags

The Player dynamically generates flag emoji for audio and subtitle tracks. This requires either a flag SVG resolver or a complete country-flag asset set.

Currently mapped countries:

`SA, BG, BD, CZ, DK, DE, GR, GB, ES, EE, IR, FI, PH, FR, IL, IN, HR, HU, ID, IT, JP, KR, LT, LV, MY, NL, NO, PL, BR, RO, RU, SK, SI, RS, SE, TH, TR, UA, PK, VN, CN`

Language tags containing an explicit region can generate any other ISO two-letter country flag. The safest design is therefore an ISO-country SVG collection plus a generic `language-unknown` globe.

Source: `archivist/apps/player/src/components/MediaSelector.tsx`.

## Icons already implemented as SVG

The Player’s internal set in `archivist/apps/player/src/components/Icons.tsx` contains:

- `play`;
- `restart`;
- `trailer`;
- `watched`;
- `information`;
- `refresh`;
- `media-tracks`;
- `chevron-right`;
- `check`;
- `rating-star`; and
- `close`.

Additional inline SVGs:

- watched circle/check;
- rating star; and
- Sidebar chevron-down.

These are located in:

- `archivist/apps/player/src/components/Cards.tsx`; and
- `archivist/client/src/components/Sidebar.tsx`.

## Existing standalone SVG assets

- `archivist/client/src/icon.svg` — Archivist application logo;
- `archivist/client/src/spinner.svg` — loading spinner.

## Free-form Player hub icons

Player hub icons remain user-editable free-form text. The defaults are `⌂` and `◆`, but users can currently enter any character or emoji in `archivist/apps/player/src/pages/Settings.tsx`.

To eliminate emoji completely, this field should become an icon picker backed by the bespoke SVG registry.

## Exclusions

Typographic punctuation that is not acting as an icon has been excluded. Examples include middots, bullets, em dashes, ellipses, multiplication signs and section symbols.

