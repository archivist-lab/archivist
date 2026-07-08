# Custom Tiers / Quality — fill this in

Fill in the blanks below and hand it back. This defines how "entirely custom" tiers
should work so I can build the tier builder + scoring around *your* model.

Today tiers are a fixed **Tier 1 / 2 / 3**, where each tier is just a list of keyword
terms per media type. This template lets you redefine that completely.

---

## Part A — The big picture (answer these first)

1. **How many tiers?**  Fixed at 3, or any number you can add/remove?
   → `__________`

2. **Per media type, or shared?**  One set of tiers for everything, or different
   tiers for films vs series vs music vs books vs comics vs games?
   → `__________`

3. **Ranking:** is Tier 1 the *best* (top preference) and higher numbers worse? Or
   the reverse? Or is each tier just a labeled bucket with an explicit score?
   → `__________`

4. **What decides which tier a release lands in?** (tick all that apply)
   - [ ] Keywords in the release title (e.g. `REMUX`, `IMAX`, group names)
   - [ ] Resolution (2160p / 1080p / 720p…)
   - [ ] Source (BluRay / WEB-DL / WEBRip / HDTV…)
   - [ ] Codec (x265/HEVC / x264 / AV1…)
   - [ ] Release group / uploader
   - [ ] File size range
   - [ ] Something else: `__________`

5. **Upgrades:** should Archivist keep replacing a file until it reaches your top
   tier (a "cutoff"), or grab once and stop? Where's the cutoff?
   → `__________`

---

## Part B — Define each tier (copy this block per tier)

Leave any field blank if it doesn't apply. "Required" = must be present to qualify
for this tier; "Preferred" = nice-to-have that adds score; "Excluded" = disqualifies.

```
Tier name:            ______________________   (e.g. "Pristine", "Standard", "Trash")
Rank / priority:      ____   (1 = most preferred)
Score (optional):     ____   (a number, if you score rather than rank)
Applies to:           [ ] all   or  types: __________________________
Required keywords:    __________________________________________
Preferred keywords:   __________________________________________
Excluded keywords:    __________________________________________
Allowed resolutions:  __________________________________________
Allowed sources:      __________________________________________
Allowed codecs:       __________________________________________
Preferred groups:     __________________________________________
Min size:             ________   Max size: ________   (per item / per hour / GB?)
Notes:                __________________________________________
```

### Example (so you can see the shape — delete or edit)

```
Tier name:            Pristine
Rank / priority:      1
Applies to:           films, series
Required keywords:    REMUX
Preferred keywords:   IMAX, Dolby Vision, Atmos
Excluded keywords:    CAM, TS, HDTS
Allowed resolutions:  2160p, 1080p
Allowed sources:      BluRay
Allowed codecs:       x265, x264
Preferred groups:     FraMeSToR, 3L, BMF
Min size:             (none)     Max size: (none)
Notes:                Only true remuxes; never a re-encode.
```

---

## Part C — Your existing setup

You mentioned you already have fields/tiers of your own. Paste them here in whatever
form they're in (a screenshot description, a config export, or just a list) — I'll
map them onto the model above. If they'd make a good **one-click "Recommended tiers"
preset** on the wizard's quality page, note that too.

```
(paste here)
```

---

## Part D — Anything the tier system should do that it can't today?

e.g. "prefer smaller files when tiers tie", "block a specific group globally",
"different tiers for kids' films", "language/subtitle requirements"…

```
(notes)
```
