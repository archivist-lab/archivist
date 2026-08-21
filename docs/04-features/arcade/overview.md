---
title: "Archivist Arcade — hidden retro emulator (planning)"
document_type: feature-specification
status: historical
classified: 2026-08-16
---
# Archivist Arcade — hidden retro emulator (planning)

> Easter egg: the Konami code (already wired in `App.tsx` → `showKonami`, currently
> a "coming soon" modal) opens a native, in-app retro emulator. Explore-only; no
> code yet.

---

## 1. The tool: EmulatorJS (self-hosted libretro WASM cores)

- EmulatorJS is a self-hostable browser front-end around the same **libretro /
  RetroArch cores** RetroArch uses, compiled to **WebAssembly**.
- Runs **entirely client-side** in the user's browser. Once its assets are
  vendored into Archivist, there is **no external service** and **zero server
  CPU** — the user's machine does the emulation.
- "Native" here = **self-hosting mature cores**, not hand-writing emulators
  (writing cycle-accurate cores from scratch is months per system and pointless).
- Integration is **generic**: a system is a config value (`EJS_core = 'nes'`,
  `'snes'`, …), not per-system code — so supporting many systems costs ~nothing
  in code. Only the *hosted WASM payload* scales with how many you ship.
- Updates are **manual** (assets are vendored → re-pin + rebuild to adopt a new
  release). Non-issue for mature 8/16-bit cores.
- Licensing: EmulatorJS + cores are GPL-family; fine for self-hosted use — honor
  source-availability terms, and **never bundle copyrighted ROMs** (see §7).

---

## 2. Systems to support (Dreamcast dropped)

Dreamcast is **not** an EmulatorJS core (would need a separate Flycast-WASM
integration) — dropped. Final list, all EmulatorJS-native:

| System | Core | BIOS? | Media | In-browser perf |
|---|---|---|---|---|
| Master System | `genesis_plus_gx` | No | Cartridge (tiny) | Flawless |
| Genesis / Mega Drive | `genesis_plus_gx` (same core) | No | Cartridge (tiny) | Flawless |
| Game Boy | `gambatte` | No | Cartridge (tiny) | Flawless |
| NES | `fceumm` | No | Cartridge (tiny) | Flawless |
| SNES | `snes9x` | No | Cartridge (small) | Flawless |
| N64 | `mupen64plus_next` | No | Cartridge (small) | Heavy but OK on a decent machine; wants a gamepad |
| PSX / PlayStation | `pcsx_rearmed` | **Yes** | Disc (.bin/.cue, .chd — big) | Generally good |
| Saturn | `beetle_saturn` | **Yes** | Disc (big) | **Marginal** — often sluggish/glitchy in WASM |

### Tiers
- **Tier 1 (trivial):** Master System, Genesis, Game Boy, NES, SNES — no BIOS,
  tiny files, flawless.
- **Tier 2 (BIOS + disc/large-file + heavier):** N64 (no BIOS, heavy), PSX (BIOS
  + disc), Saturn (BIOS + disc + expect rough).

---

## 3. Size / image impact

Cores are small — this is *nothing* like the Chromium/CloudflareBypass conversation.

| Component | ~Size |
|---|---|
| EmulatorJS frontend/loader | ~5–10 MB |
| NES | ~3 MB |
| SNES | ~5 MB |
| Game Boy | ~2–3 MB |
| Master System + Genesis (one core) | ~4 MB |
| N64 | ~10–15 MB |
| PSX | ~5–10 MB |
| Saturn | ~15–25 MB |

- **Light five bundled:** ~20–25 MB.
- **All eight bundled:** ~55–90 MB (Saturn + N64 are >half).
- Image goes from ~260 MB → **~320–350 MB** (all eight). Modest.
- **Trim option:** bundle the light five (~25 MB), **lazy-fetch N64/PSX/Saturn
  only when enabled** → baked-in add stays ~25 MB.

**ROMs are separate and not shipped.** Cartridge games are KB–few MB; **PSX/Saturn
disc images are hundreds of MB–few GB each**, but they live in the user's ROM
folder on their disk — nothing to do with the Docker image.

---

## 4. Architecture / fit

- **Trigger:** replace the Konami "coming soon" modal with a full-screen **arcade
  overlay module** (e.g. `modules/arcade`).
- **First-run picker** (mirrors the setup wizard): first Konami entry →
  choose systems + set ROM location(s) + upload BIOS for systems that need it
  (PSX/Saturn). Store config; later entries jump straight to the arcade.
- **Module UI:** system shelf → pick system → grid of ROMs → launch. EmulatorJS
  mounts into a div, lazy-loads the core, boots the ROM.
- **Backend:** endpoint to **list ROMs** (scan `media/roms/<system>/` or a
  dedicated `data/roms/`, group by extension: `.nes`, `.sfc`/`.smc`, `.sms`,
  `.md`/`.gen`/`.bin`, `.z64`/`.n64`, `.bin`/`.cue`/`.chd`) and **serve ROM files
  with HTTP range support** (needed for large disc images; cartridges are trivial).
- **Free from EmulatorJS:** save states + SRAM, fullscreen, keyboard controls,
  **gamepad (Gamepad API)**, touch controls for mobile, fast-forward, shaders.
- **Saves (optional):** persist SRAM/save-states into the app's data dir per ROM
  so progress survives device/browser changes (EmulatorJS defaults to browser
  IndexedDB otherwise).

---

## 5. The one real technical wrinkle: cross-origin isolation

EmulatorJS's *multi-threaded* cores need `SharedArrayBuffer` → requires COOP/COEP
headers, and turning those on globally can **break YouTube trailer embeds and
remote images**. Escape hatch: for these systems, **single-threaded cores run
fine**, so ship non-threaded builds and sidestep cross-origin isolation entirely.
(Saturn/N64 single-threaded are the perf-sensitive ones, but still workable.)

---

## 6. Added scope vs an 8/16-bit-only plan

Including PSX/Saturn pulls in scope the cartridge systems don't have:
1. **BIOS provisioning** (PSX/Saturn) — first-run needs a BIOS-upload step.
2. **Disc images** — large files, `.chd`, sometimes multi-disc → backend needs
   range-serving, not just static file dumps.
3. **Performance ceiling** — Saturn rough, N64/PSX heavier; 8/16-bit flawless.

---

## 7. ROM legality (important)

- The app **ships no copyrighted ROMs.** Emulators are legal; distributing
  copyrighted ROMs is not. Model = **bring-your-own** (user supplies their own
  dumps/homebrew), exactly like RetroArch/EmulatorJS.
- **Modded/hacked ROMs of Mario/Sonic etc. cannot be shipped** — a ROM hack is a
  derivative work of the original copyrighted game code/assets; swapping
  characters and tweaking levels does not remove Nintendo's/Sega's copyright (or
  trademarks). That's why the hack scene distributes *patches* (IPS/BPS) applied
  to the user's own ROM, never the full modified ROM.
- **What *can* ship as a bundled demo:** a game authored **from scratch** — your
  own engine/code/assets (original homebrew). That's yours to distribute. Also
  fine: third-party homebrew released under a permissive license / with the
  author's permission.

---

## 8. What's free vs. what to build

Almost all the hard part is EmulatorJS. The build is thin glue:
1. Vendor/host EmulatorJS assets + the chosen cores.
2. ROM list + range-serving backend endpoint.
3. Arcade overlay React module wired to the Konami trigger.
4. First-run picker (systems + ROM path + BIOS upload).
5. Extension → system/core mapping.
6. *(optional)* server-side save persistence.

---

## 9. Phasing

1. **MVP:** Tier 1 (SMS/Genesis/GB/NES/SNES), single-threaded cores, BYO ROMs
   from a scanned folder, save states + gamepad, Konami overlay. Tiny, high-delight.
2. **Add Tier 2:** N64 + PSX + Saturn — introduce BIOS upload + disc-image
   range-serving. Set perf expectations (Saturn rough).
3. *(future)* A proper "Retro" library reusing IGDB metadata + acquisition for
   box art/organization (à la RomM); more systems; Dreamcast via Flycast if ever
   wanted.

---

## 10. Open questions

- ROM location: one folder with per-system subfolders, or per-system paths?
- Bundle all eight cores, or bundle light five + lazy-fetch heavy three?
- Save persistence: browser IndexedDB (simplest) or server-side per ROM?
- Ship an original homebrew demo game so the arcade isn't empty on first launch?
- Expose the arcade only via Konami, or also a hidden settings toggle once found?
