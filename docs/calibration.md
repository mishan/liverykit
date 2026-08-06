# Calibration — reading the car instead of guessing at it

> **Start with `--from-kn5`.** The model contains the UV mapping exactly, and
> `--from-kn5` now derives visibility too, so this screenshot workflow is no
> longer needed to *find* anything on a car you can parse.
>
> It is still worth running to **check** a generated profile against what the
> game actually draws, and it is the only option for encrypted kn5s. Everything
> below still works; it is just no longer the first thing to reach for.


Region coordinates are fractions of a texture. Nothing in the texture tells you
which fraction lands on the sidepod: that mapping lives in the car's 3D model,
and it is not evenly distributed, not symmetric, and not guessable.

So paint the car with a coordinate system and photograph it. Every visible
surface then reports its own UV address, and *"the sidepod runs from about G4 to
N9"* becomes a measurement rather than a guess.

The output is a **car profile** (`cars/<carId>.json`), reusable by any livery for
that car, by anyone. It is the expensive artifact and the one worth sharing.

---

## 1. Scan

```sh
node bin/liverykit.mjs --scan /path/to/content/cars/<carId>/skins
```

Reads every DDS header it finds, classifies each texture, warns about
case-colliding filenames, and prints a profile skeleton. Save it as
`cars/<carId>.json`.

Three roles are excluded automatically, because painting them doesn't recolour
anything — it corrupts the model:

- **`_NM` / large uncompressed** — normal maps. They encode surface direction.
- **`_map`** — AC shader maps: gloss and reflectivity per texel, not colour.
- **glass / visor** — alpha-blended, easy to ruin.

> ⚠️ **A scan cannot tell you what the model has, only what some stock skin
> chose to override.** A texture's absence from every skin folder proves
> nothing at all. See [name probes](#4-name-probes) — this distinction has
> already caused one part to be written off as unpaintable when it wasn't.

## 2. Prove the plumbing first

```sh
node bin/liverykit.mjs <livery> --flat
```

Solid colour, no artwork. Install it. If the car doesn't change colour, a
filename or the DDS format is wrong and no amount of art will fix it.

Do this before making anything. The failure is completely silent: a skin folder
whose filenames match nothing installs cleanly, logs no error, and renders the
stock car — which looks exactly like "my livery didn't work".

## 3. Photograph the grid

```sh
node bin/liverykit.mjs <livery> --uvgrid
```

Installs as a **separate** skin next to the real one, so both appear in Content
Manager and you can flip between them without reinstalling anything.

Every texture becomes a labelled coordinate system: columns `A`–`T` left to
right, rows `1`–`20` top to bottom, 5% each. Three redundant encodings, because
a screenshot may be small, angled or compressed and any one of them can fail:

| | |
|---|---|
| cell labels | `A1`, `B1`, … exact, needs a close and sharp view |
| per-cell colour | hue tracks the column, lightness the row — a blurry magenta cell still narrows it down |
| quadrant marks | huge faint labels, readable from across the showroom |

Take one shot of each, as large and sharp as you can:

1. Front three-quarter, one side
2. Rear three-quarter, same side
3. **Direct side-on** — the flanks carry most of the artwork
4. **Direct side-on, other side** — how you find out whether the sides share a mirrored island
5. Top-down
6. Close on the nose, and on any small part you plan to paint

**Small parts** — canards, winglets, mirrors — can sit entirely inside one 5%
cell, which tells you the cell but not where in it:

```sh
node bin/liverykit.mjs <livery> --uvgrid --cells 40
```

Past about 40 the labels stop being readable and the hue ramp is doing all the
work.

### Reading the results

**Labels reading backwards on one side** means that side shares a mirrored UV
island, and anything asymmetric — text, the number — will appear reversed
there. Better to know before it surprises you on track.

**A whole panel in one flat colour with no visible label** means its island is
smaller than one grid cell. Re-run with more cells.

**Cells that aren't square on the car** are anisotropy. A cell *is* square in
the texture, so however far from square it looks on the bodywork is distortion
your artwork has to cancel. Record it as `"anisotropy": 1.4` on the panel and
the `text` treatment compensates automatically.

**Edges that never appear in any shot** are why `safe` exists. Being inside a UV
island is not the same as being visible. `--from-kn5` now derives this by ray
casting, so record it by hand only when working from screenshots — and be
careful about inferring it from one bad-looking render. A safe rect was once
added to this project's own profile on the theory that a flank edge "curls under
the floor"; the model later showed that surface is visible from 98% of
viewpoints, and the real problem was that the text was simply too low to read.

## 4. Name probes

Because a filename matching nothing overrides nothing — silently and harmlessly
— guessing filenames is free.

```sh
node bin/liverykit.mjs <livery> --uvgrid \
  --probe RSS4_Tire_D.dds,RSS4_Tire.dds,RSS4_Tyre_D.dds,tyres_all.dds
```

Each candidate ships in its own loud colour with its own filename printed on it.
One look at the car identifies the winner; the rest are inert. This found a tyre
diffuse on a car where the part had been documented as not skin-overridable, in
a single build.

The probes also draw concentric rings. If the part turns out to be radially
unwrapped — as tyre sidewalls usually are — they come back as clean concentric
bands, so you learn the layout at the same time as the name.

**One caution:** no two candidates may differ only in case. Those are one file
on NTFS, where the second to extract silently overwrites the first. `--probe`
refuses rather than shipping an archive that quietly loses one.

## 5. Fill in the profile

Turn what you read into `panels`, and **be honest about confidence**:

```json
"flankRight": {
  "rect": [0.00, 0.00, 0.40, 0.20],
  "safe": [0.00, 0.00, 0.40, 0.17],
  "anisotropy": 1.39,
  "confidence": "high",
  "cells": "A1-H4",
  "notes": "Columns run REAR->FRONT, so the nose end is the high-x edge. Below y~0.18 the surface curls under the floor."
}
```

`"high"` should mean you could read consecutive cell labels across the whole
panel in more than one screenshot — not that it felt about right. A profile that
admits which panels are guesses is much more useful than one pretending they are
all measured, because it tells the next person where to be careful and where a
flat colour is the wise choice.

Then use it: [docs/worked-example-rss4.md](worked-example-rss4.md) is a real
calibration end to end, including the mistakes.

---

## Doing it exactly

Everything above is measured off perspective renders, which caps accuracy at
"good enough to iterate". The exact version is to parse the car's `.kn5`
directly: it stores per-vertex UVs alongside per-vertex positions, so panel
rectangles and per-panel anisotropy both fall out as arithmetic rather than
estimates — and it lists every texture name in the model, which settles the
probe question outright.

**This is now implemented** — `--from-kn5`. The screenshot workflow above
remains as a fallback and as a check.

The reader validates by consuming the file to its exact final byte. The format
is reverse-engineered and has no specification, so any misread field shifts
every subsequent offset; finishing precisely at EOF is very unlikely to happen
by accident, and a failure means the layout is wrong rather than something to
work around.
