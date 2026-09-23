# Spike: what a second game does to the kernel

[roadmap.md](roadmap.md)'s step 2 is "extract the kernel": document the model
contract, add a glTF loader, make the orientation frame pluggable, put DDS and
the ZIP layout behind an output adapter. Step 7 is "a second adapter", whose
stated purpose is to prove step 2 drew the line in the right place.

This is that proof attempted on paper first, because the adapter is the
expensive way to find out. Two games were read: one car game outside the
Assetto Corsa lineage, and one game with no cars in it at all. Neither was
built against — everything below comes from vendor documentation, and the last
section says which parts of it are thin.

The short version: **the measurement engine survives both, and the layer above
it does not.** The line the roadmap draws is in roughly the right place for
geometry and in the wrong place for everything that says what a livery IS.

## The two

**BeamNG.drive**, for a car game sharing no ancestry with AC — its own engine
out of the Torque3D line, its own part system, its own material format.

**Counter-Strike 2 weapon finishes**, for the non-car case. Picked over the
obvious flight-sim candidates (DCS liveries are DDS files in folders beside a
Lua manifest, which is AC with the words changed, and would have confirmed
rather than tested anything). CS2 is the opposite: a shipped, commercial
implementation of this project's own thesis, by people with more of everything.

## BeamNG.drive

**The formats are easier than AC's.** Models are COLLADA `.dae`, cached to
`.cdae` — v31, MessagePack with optional Zstandard, and specified by the
vendor rather than reverse-engineered the way `kn5.mjs` was. Skin textures
author as `.color.png` and a "texture cooker" produces the DDS. A BeamNG
loader would be less work than the kn5 parser already in the tree, and the
output adapter would be *simpler* than AC's: PNG out, no ImageMagick round
trip, none of `pipeline.mjs`'s mip and block-format care.

**A skin is not a texture.** It is a `materials.json` entry plus a jbeam part,
bound by the naming convention `materialName.skinType.skinName` against a
`globalSkin` value, with the paint slot called `paint_design`. Shipping a
BeamNG livery means emitting JSON and registering a part in a slot system.
`build.mjs` writes files into a skins folder; there is no seam in it for
"and also declare a material".

**`colorPaletteMap` puts three colorable channels in R, G and B**, each
driving a color slider in the game's UI. That is a livery that is partly
authored and partly chosen at runtime. This project's vocabulary has no term
for a region whose color is not decided by the design.

### The finding that matters: two UV sets, and paint is the second

BeamNG vehicles carry UV0 and UV1, and the split is deliberate. UV0 is
**mirrored**, laid out to save sheet space on mechanical components. UV1 is
**unmirrored and exists specifically for paint schemes** — because a paint
scheme cannot be mirrored, which is the same fact `findMirrorPairs` was
written to detect. UV1 also has the various option parts mapped *on top of
each other*, so that one skin covers whichever bumper or spoiler is fitted.

`vertex()` returns one `u, v`. It reads offsets 24 and 28 of the vertex and
that is the whole story, because a kn5 vertex has one UV and there has never
been a second to choose from. Nothing in a profile said which set its numbers
came from, because there was only ever one.

Point this project at a BeamNG `.dae` and read UV0 and **every measurement
succeeds and every number is about the wrong sheet.** Islands are found.
Panels get rects. Visibility ray-casts. Anisotropy computes. Mirror pairs
pair — off the mechanical unwrap, where the mirroring is an artifact of
packing rather than a fact about the car. Seams map. A profile comes out that
validates, loads, renders and describes a UV layout no livery is ever drawn
on. Nothing throws. Nothing looks broken. Only a person holding the profile
next to the car could tell.

That is the exact failure mode `AGENTS.md` forbids, in the one place nothing
was watching, and it is why the first change out of this spike is
`calibration.uvSet` (below) rather than anything about loaders.

### Two things that are open questions, not findings

**Option parts stacked in UV space.** A profile measures the configuration it
was given, so the sheet contains UV territory belonging to parts that are not
fitted. A design resolved against that profile leaves those regions unpainted,
and the car looks right until someone fits the other bumper. There is no term
in a profile for "this part of the sheet belongs to a part that may not be
there". This is NOT the `overlap` finding in `fitment.mjs` — that one compares
two regions a design places, not two islands a model has — and it is not
`unpainted-twin` either. It is unhandled rather than mishandled.

**Whether the sets are uniform per model.** The vendor docs imply normal maps
read UV0 while the skin reads UV1, which would make the set a property of the
texture rather than of the profile. Unknown without a real `.dae` in hand; see
the caveats.

## Counter-Strike 2 weapon finishes

**A finish is parameters, not pixels.** A creator submits a plain-text
parameter file generated by the Workshop Workbench, plus a pattern TGA. Nine
styles — Solid Color, Hydrographic, Spray-Paint, Anodized, Anodized
Multicolored, Anodized Airbrushed, Patina, Custom Paint, Gunsmith. That is
this project's central claim, that a design should be data rather than a
painted texture so it can travel and be diffed, already shipped and sold.

**Valve solved the portability problem the same way.** Their compositing
system combines finish data with weapon-specific textures and *adjusts the
pattern's scale per weapon automatically*, so one finish is applied across
many models. That is `metresPerUv` and the anisotropy figure, doing the job
this project measures them for. Strong outside evidence that the measurement
layer is the right layer.

**Paint-by-number masks assign up to four color influences per weapon.** That
is the same job as this project's `bind` vocabulary — saying which part of the
object each element of a design lands on — except it ships as game art
authored by Valve rather than being derived by measurement. On CS2 the
classifier in `classify.mjs` has nothing to do, and nothing to do it with:
there are no stock skins to count overrides against and no shader-name
evidence, because the mapping is simply stated.

**Two of nine styles are not UV placement at all.** Spray-Paint and Anodized
Airbrushed use triplanar projection: the pattern is thrown onto the mesh from
six directions, the way a stencil is sprayed onto a shape. A region in this
project is "this panel, this rect", in panel-relative UV coordinates. There is
no representation for a placement that never touches the unwrap. This is close
to the roadmap's step 3 — placement in 3D, as data — which means that step is
not only an ergonomics improvement for the editor, it is a portability
prerequisite. Worth re-reading step 3 in that light.

**No analogue for wear.** A pattern's alpha channel encodes durability, with
values near 196 subtracting from refinishable areas and values below 128
increasing durability, against wear ranges from Factory New to Battle Scarred.
Nothing here models a design that degrades.

## What the spike changes

The roadmap's premise is that the AC-specific layer is the kn5 parser, the
wheel-derived axes, the skins cross-reference, the shader heuristics, the DDS
encoding, `car.ini` and the ZIP layout — a loader, a frame and an output
adapter. Measured against two real games, that list is right about what it
names and incomplete about what it omits.

| Assumed by the tree today | BeamNG | CS2 |
|---|---|---|
| one UV set per mesh | two; paint is UV1 | not applicable |
| a profile describes the fitted object | option parts share UV space | one weapon, one layout |
| placement is a rect on an unwrap | yes | triplanar for 2 of 9 styles |
| the artifact is a texture file | material JSON plus texture | parameter file plus pattern |
| bindings are measured from the model | yes | shipped as game art |

None of those five are loader problems. `vertex`, `triangles`, `findIslands`,
`findSeams`, visibility and the anisotropy figure would survive both games
intact — the measurement engine really is object-agnostic, and that half of
the roadmap's claim holds up well under pressure. What does not survive is the
layer above: the **profile schema**, `fitment.mjs`'s **finding vocabulary**,
and the **output adapter's idea of an artifact**.

So the order in the roadmap is worth revisiting. Step 2 as written builds the
half that already works. A cheaper and more honest sequence is to make the
profile state the things it has been silently assuming — starting with the UV
set, which is the one that fails invisibly — and to let each such statement be
tested against AC alone, where the answer is known.

## Done here: `calibration.uvSet`

The first of those, because it is the one with a silent failure behind it.

- A profile records `calibration.uvSet`, the UV set its rects, safe areas,
  anisotropies, mirror pairs and seams were measured from. `profilegen` writes
  `0`, and the three shipped profiles now carry it.
- `validateProfile` refuses a profile whose `uvSet` is anything but `0`,
  because nothing in this build can read a second set and resolving such a
  profile against set 0 is exactly the silent wrong answer described above.
  Absent is allowed, and means a profile generated before the field existed.
- `vertex()` says at the point it reads the UV that this is the only set a kn5
  vertex has.

It is a no-op on Assetto Corsa by construction, and that is the point: it is a
tripwire, placed while the correct value is known, for the day something can
answer differently. The test is in `integrity.test.mjs`, which is where the
failures that install cleanly and log nothing are kept.

It is deliberately profile-wide rather than per-texture. That is what is true
of every format read so far, and a format that mixes sets across its textures
will fail this check rather than pass it quietly — which is the right way round
for a question this spike could not close.

## What was NOT done, and why

An earlier reading of this spike claimed BeamNG's stacked UV1 would be
reported by `fitment.mjs`'s `overlap` and `unmirrored` findings, and that those
should be made UV-set-aware. Reading the code, that is wrong: both are
**design-level** checks. `overlap` compares two regions a livery places against
each other, and `unmirrored` compares two regions whose ids differ by
`left`/`right`. Neither looks at model UV islands, so neither has an opinion
about which set was measured, and making them "UV-set-aware" would have been
churn with no meaning. The stacked-option-parts problem is real and is
unhandled somewhere else entirely — see the open question above.

## Caveats on the research

Nothing here was built. Both games were read from vendor documentation and no
model of either was opened.

BeamNG's skin documentation says outright that it is incomplete and under
active development. The UV0/UV1 split is stated on the skin tutorial page and
corroborated by the material docs and a community Blender importer, which is
good enough to justify a tripwire and not good enough to design an adapter
around. The `.cdae` format description is the vendor's own and looks solid.
**Open a real `.dae` before building anything on the UV claim**, and settle
whether the set varies per texture while doing it.

CS2's finish system is documented by Valve for creators rather than for
integrators, so the styles, the two application methods, the wear ranges and
the per-weapon scaling are reliable, and anything about the `.vmdl` format or
how the compositor actually works is not covered at all. CS2 is a reference
point for what the problem shape looks like when somebody else solves it, not
a plausible adapter: the pipeline runs through a closed Workbench.

Sources: BeamNG's [skin system](https://documentation.beamng.com/modding/materials/vehicle/skinsystem/),
[skin tutorial](https://documentation.beamng.com/modding/materials/vehicle/skinsystem/skintutorial/),
[materials](https://documentation.beamng.com/modding/vehicle/vehicle-art/materials/) and
[`.cdae` format](https://documentation.beamng.com/modding/file_formats/cdae/);
the [BeamNG COLLADA importer](https://github.com/Blenux/io_beamng_dae_dev);
Counter-Strike's [workshop finishes](https://www.counter-strike.net/workshop/workshopfinishes)
and [custom paint](https://www.counter-strike.net/workshop/wf_custompaint) pages.
