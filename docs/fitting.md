# Plan: fitting a portable design to a specific car

## The problem

`liveries/neon-grid-any.mjs` renders on any car with a bound profile. It does so
by giving up two things, both documented in `docs/naming.md` and both real: it
cannot name a panel, and it cannot treat the several textures behind one term
differently.

Adding identity text made the cost concrete. A car number has to go *somewhere*,
and the tool can pick the largest visible panel on the correct side — that much
is measured. What it cannot know is **which part of that panel is flat**, which
way is up on it, or whether the middle of the rectangle lands on a door or wraps
over a wheel arch. So the number sits centred, clear of the edges, and hopes.

That is the right default and it will never be better than a guess. The fix is
not a cleverer heuristic; it is a person looking at the car for thirty seconds.

## Where a fit belongs

Not in the livery. Putting `abarth500: { number: { at: [...] } }` into the design
de-genericises the thing we built the vocabulary to keep generic, and it grows
without limit — one block per car anyone ever runs it on.

Not in the car profile either. Where *this design's* number sits is not a fact
about the Abarth. The profile is shared by everyone who owns that car and should
stay free of any one design's opinions, exactly as it is free of any one design's
colours.

A fit is a property of the **(design, car) pair**, so it is a third artefact:

```
fits/neon-grid-any@abarth500.json
```

The same shape as `bind`, one level up. `bind` translates a design's vocabulary
into a car's texture names; a fit translates a design's *placements* into a car's
geometry. Both are per-car, both are hand-confirmed, and neither belongs to the
thing it adapts.

A car with no fit file renders exactly as it does today. Nothing becomes
mandatory.

## The format

Overrides only — never a copy of the region:

```jsonc
{
  "livery": "neon-grid-any",
  "car": "abarth500",
  "regions": {
    "number-left":  { "panel": "left_mid", "at": [0.30, 0.30, 0.40, 0.40] },
    "number-right": { "panel": "right_mid", "at": [0.30, 0.30, 0.40, 0.40] },
    "team-left":    { "at": [0.10, 0.70, 0.80, 0.12], "rotate": 0 },
    "driver-left":  { "drop": true }
  }
}
```

`panel` replaces whatever the tags selected. `at`, `rotate`, `scale` and friends
replace the region's own values. `drop` removes a region on this car, which is
the honest answer when a design asks for something a particular body shape has
nowhere to put.

Everything else about the region — its treatment, colours, glow — stays in the
design, because that is the design.

### Prerequisite: regions need names

Regions are anonymous array entries today, so there is nothing for a fit to key
on. They need an optional `id`, unique across the WHOLE livery rather than within
a surface — that is how a fit refers to them, and a fit should not have to know
which surface a region lives on:

```js
{ id: 'number-left', treatment: 'text', tags: ['left', 'visible'], limit: 1, … }
```

Only regions a fit might want to move need one. An unnamed region is simply not
addressable, which is fine for a background wash.

### Drift

A fit names regions and panels, and both can disappear — a design is edited, a
profile is regenerated, a panel is renamed. An override that no longer matches
anything is **skipped and reported**, alongside the unbound surfaces and
unmatched tags already in the build summary.

This is the same rule as everywhere else here, and for the same reason: the
failure this project keeps rediscovering is that painting nothing looks exactly
like painting something. A fit silently doing nothing would be that bug again,
one level up. Failing the build instead was considered and rejected — a stale fit
is a nuisance, not a corruption, and refusing to build punishes the person who
edited the design rather than the one who wrote the fit.

## Why a UI is worth it here

Because the preview is nearly free, which was not obvious until measured.

`renderTexture` is pure JavaScript. It produces the Abarth's entire body texture
in **2.2 ms** as a **213 KB self-contained SVG** — no ImageMagick, no DDS, no
external references. A browser renders SVG natively. So the edit loop is drag,
re-render, see it, at interactive speed, with none of the encoding pipeline
involved.

That changes the economics. A fitting tool that had to shell out to ImageMagick
and re-encode a 2048² DDS on every nudge would be too slow to use; one that
re-runs 2 ms of JavaScript is not.

## Shape

**Local only.** `liverykit ui` starts a server on localhost and opens a browser.
It reads the user's kn5 files and stock skins, which this project deliberately
never ships and never uploads. There is no hosted version and should not be.

**Three stages, cheapest first.**

*The UV editor.* Panel rectangles and their tags drawn over the live preview.
Click a region, drag it, see the texture re-render, save a fit. This alone solves
the problem that prompted it.

*The 3D viewport.* `src/engine/kn5.mjs` already yields positions, normals, UVs,
indices and accumulated node transforms — everything three.js needs — and the
same SVG becomes the material's map. This is the stage that answers the question
a UV view cannot: is that spot flat, and can anyone see it? It would be the first
front-end dependency, vendored rather than loaded from a CDN so the tool works
offline.

*Binding confirmation.* Pick `body` from a ranked list with the evidence beside
it. Genuinely the weakest case — `--explain` already prints the ranking and the
edit is thirty seconds — so it is last, not first.

## What this does not fix

A portable design stays coarser than one written for a car. `neon-grid.mjs` knows
the RSS4 has canards and a rear wing endplate worth treating differently, and no
amount of fitting will give `neon-grid-any` that knowledge.

What a fit buys is that specialising stops being a rewrite. The design stays one
file, the car profile stays shared, and the difference between "renders" and
"looks like it was made for this car" becomes a small JSON file someone produced
by dragging a number onto a door.

## Questions that are now settled

**`at` stays panel-relative**, the same as everywhere else in this system. A tool
that lets you drag on a texture naturally produces absolute coordinates and
should convert them on save, rather than introducing a second meaning for the
same field.

**A fit may not add regions**, only adjust the ones a design declares. Wanting to
add one — a sponsor patch that only makes sense on a particular car — is a good
sign the design needs the change rather than this car's copy of it. Left open,
the format becomes a second livery language.

**This repo ships examples, not a catalogue.** `fits/` carries the two cars the
project already profiles, because a format nobody can see an example of is a
format nobody implements. Two hundred of them is somebody else's repository.

## Still open

Whether a fit should be able to override which PANEL a region uses per side
independently of `at` — it can today, and it is not obvious whether that is one
override or two.

Whether the UI should write `notes` into a fit the way the two shipped examples
do by hand. The prose in those files is the most useful part of them, and no tool
is going to produce it.

## Copies

A fit may not add a region. That rule has one exception, and it is worth
spelling out because it is the only place the boundary bends.

```json
"copies": {
  "badge-mirror": { "of": "badge", "panel": "right_mid", "at": [0.3, 0.2, 0.2, 0.2] },
  "badge-copy":   { "of": "badge", "panel": "left_mid",  "at": [0.5, 0.4, 0.2, 0.2] }
}
```

This creates a second and third `badge`. A MIRRORED copy and a DUPLICATE are
the same entry: both take their artwork from `of` and state a placement, and
mirroring is only how that placement was arrived at. The block was called
`mirrors` first; that spelling still loads. It invents no artwork:
treatment, colours, text and glow all come from the region named in `of`, and
the only new information is a placement — which is exactly what a fit is for.
Setting anything else is rejected, so a mirrored copy cannot quietly become a
second way of writing a livery.

It earns the exception because **symmetry is a property of the car, not of the
design**. A livery that paints one badge is portable to a car with one flank
worth painting and to a car with two, and the design cannot know which it is
being run against. Recording that in the fit is recording a fact about the car,
which is what the file is for.

Where the copy goes is measured rather than assumed. The source panel's
`mirrorOf` gives the opposite panel, and the two panels' `uAxis` and `vAxis`
say whether the sheet runs the same way across both — a pair that is reversed
in UV needs `1 - x - w`, and copying the coordinates across without checking
puts the artwork at the wrong end of the car. That is not hypothetical: it
shipped that way, and moving a number forward on one flank moved it backward on
the other.

A panel with no `mirrorOf` straddles the centreline — a nose, an engine cover —
so it is its own mirror, and the copy lands on the same panel with its position
reflected within it. Which axis the centreline cuts is measured too, since an
island the unwrapper packed sideways has that role fall to `v`.
