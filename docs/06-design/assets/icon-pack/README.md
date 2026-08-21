---
title: "Archivist icon pack"
document_type: asset-guide
status: canonical
classified: 2026-08-19
---

# Archivist icon pack

One icon system for Library, Player, Catalogue and Control. 180 icons,
18 aliases, one drawing per concept.

Built on the accepted 18-08-2026 set, extended to cover every surface found in
the [2026-08-19 iconography review](../../iconography-review-2026-08-19.md).

## Contract

- **Grid** 64 × 64, no exceptions.
- **Stroke** 3 units, round caps, round joins. Secondary detail may use 2.
- **Colour** `currentColor` only. No gradients, no hard-coded hex, no CSS
  variables, no editor metadata.
- **Solid marks** are allowed as emphasis (a hub dot, a live centre) but never as
  the whole drawing.
- **Safe area** all geometry sits inside `1.5 … 62.5` so a 3-unit stroke never
  clips at the viewBox edge.

## Files

| File | Use |
|---|---|
| `Icon.tsx` | React component. The intended integration path. |
| `archivist-icons.svg` | `<symbol>` sprite for non-React surfaces. |
| `svg/<name>.svg` | One standalone file per icon, for design tools and Kodi. |
| `icons.json` | Manifest: group, aliases, retired glyphs, surfaces served. |
| `archivist-icons.html` | Preview sheet. Open it in a browser, or see the [published specimen sheet](https://claude.ai/code/artifact/49951458-93f5-4d9f-8174-f966dec7fb7c). |
| `build/` | Generator and its inputs. |

## Using it

```tsx
import { Icon } from '@archivist/design-system';

<Icon name="film" size={20} />                    // decorative, aria-hidden
<Icon name="leaving-soon" size={24} title="Leaving soon" />  // announced
<Icon name="music" className="text-pink" />        // colour via currentColor
```

Size drives an optical stroke compensation — 3 at 40px and above, 3.6 at 24–39px,
5 below 24px — so weight stays constant as icons shrink. Do not override
`strokeWidth` on the element; change `size` instead.

Aliases are accepted wherever a name is: `<Icon name="tables" />` renders
`database`. Where a surface stores free text rather than a typed name, guard it
with `isIconName(value)` so unmigrated values keep rendering as they did.

For the sprite:

```html
<svg class="icon" width="20" height="20"><use href="/archivist-icons.svg#i-film" /></svg>
```

## Rules

- Never communicate media type, health or destructive intent with an icon alone.
  Pair it with text or state, as the design system requires.
- Decorative icons render `aria-hidden`. Pass `title` only when the icon is the
  sole carrier of meaning.
- Two concepts that want the same picture become an **alias**, never a second
  drawing. The build fails on duplicate geometry.
- No emoji in product UI. If a concept has no icon, add one here.

## Adding an icon

1. Add the geometry to `build/additions.py` under `NEW`, following the contract.
2. Add what it retires and where it is used to `build/retires.py`.
3. Run `python3 build_pack.py --sync` from `build/`. The `--sync` flag also
   refreshes `packages/design-system/src/Icon.tsx`, which is what the
   applications import — never edit that copy by hand.

The build fails if a name collides, a group is unknown, an alias points nowhere,
or two icons end up with identical geometry.

## Not in this pack

- **Country flags.** Deliberately excluded; render ISO codes as mono chips
  instead. The reasoning is in the review document.
- **`client/src/icon.svg` and `client/src/spinner.svg`.** The product mark and
  the loading animation are a separate tier. `archivist-mark` is the monoline
  reduction for icon-scale use.

## In use

- `client/src/components/Sidebar.tsx` — Library navigation.
- `apps/player/src/components/Shell.tsx` — Player side rail.
- `client/src/modules/settings/` — Settings landing, groups, media-type chips,
  the About capability grid and every sub-tab control.
- `client/src/components/ui.tsx` — `EmptyState`, via `isIconName`.

## Supersedes

- `../idents/` — same instinct, different stroke weight, stray marker dots.
- `../media-icons/` — decorative gradient tiles, not interface icons.
- `apps/player/src/components/Icons.tsx` — 24-grid, 11 icons, all covered here.
