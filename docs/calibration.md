# The calibration skin

Paint every texture as a labelled coordinate system, install it, photograph the
car, and read each panel's position straight off the bodywork.

> **Most people won't need this.** `--from-kn5` reads panel positions, anisotropy
> and visibility out of the car's model — exactly, in one command, and everything
> below is an approximation of it. See the README.
>
> Reach for the grid when the model is encrypted, when you're mapping a separate
> driver or crew model, or to check a generated profile against what the game
> actually draws.


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

**Edges that never appear in any shot** are why `safe` exists — being inside a
UV island is not the same as being visible. `--from-kn5` derives this by ray
casting, so you only record it by hand when working from screenshots.

Don't infer one from a single bad-looking render. Lettering that reads badly is
usually just too low on the car, not clipped by geometry — a surface angled a
little downward is still perfectly visible from trackside.

## 4. Name probes

Because a filename matching nothing overrides nothing — silently and harmlessly
— guessing filenames is free.

```sh
node bin/liverykit.mjs <livery> --uvgrid \
  --probe RSS4_Tire_D.dds,RSS4_Tire.dds,RSS4_Tyre_D.dds,tyres_all.dds
```

Each candidate ships in its own loud colour with its own filename printed on it.
One look at the car identifies the winner; the rest are inert. This is the only
way to find a texture that no stock skin overrides, short of reading the model.

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
  "confidence": "estimated",
  "cells": "A1-H4",
  "notes": "Columns run REAR->FRONT, so the nose end is the high-x edge. Below y~0.18 the surface curls under the floor."
}
```

Anything read off a screenshot is `"estimated"`; `"measured"` is reserved for
values derived from a model. A profile that admits which panels are guesses is
much more useful than one pretending they're all exact, because it tells the next
person where to be careful and where a flat colour is the wise choice.

