# Backlog

Things known to be wrong, or known to be guessed, that nobody has got to yet.
Each entry says what the symptom is, what causes it, and what the fix would
have to establish — because the expensive part of every one of these has been
identifying the surface, not changing the code.

Open entries come first, ordered roughly by how much they cost the person
looking at the preview. What has been dealt with is summarized under
[Done](#done), a paragraph each — kept for the symptom, which is what the next
person will recognize, and for the measurement, which in several cases is
recorded nowhere else. This is a backlog, not a history of itself.

**The shape of what is left.** Nearly all of it is one mistake: *the model
states a fact and we infer it instead*. [What else is inferred that the model
states](#what-else-is-inferred-that-the-model-states) is the index of it.
Cheapest first — `additive`, whose `isAdditive` sits in the same props map the
lighting terms already come out of; then `trustworthyDiffuse` and
`INT_ELECTRONICS`, which are one recorded per-texture fact between them; then
the glass fresnel, four material properties replacing four constants of mine.
The other shape is the two renderers disagreeing about the car, and that is
down to the light rig now that the DDS decoder is one module both sides import.

*Last groomed against the code on 2026-09-22.*

## Open

### The CLI renderer has one light rig, not the car's materials

The editor reads `ksAmbient`, `ksDiffuse`, `ksSpecular` and `ksSpecularEXP` off
each material and lights by them; `shade()` here has a single hardcoded rig, so
the same surface is a different brightness in the two renderers even now that
they agree about its texture. The groups already carry `light`.

The obstacle is that the editor's `lightingFor` scales those numbers against a
`PAINT` constant taken from this car's carpaint, which is a calibration and not
a measurement (see below). Porting the calibration into a second renderer would
make one car's paint the reference for two of them.

### `INT_ELECTRONICS` and its kind still render gray

29k triangles of dash switchgear on this car. The material is
`ksPerPixelMultiMap` with `useDetail: 0`, so `detailLayer` correctly declines
it, and `trustworthyDiffuse` then refuses its diffuse because the shader name
says MultiMap — leaving the honest gray.

But `INT_Electronics_Colour.dds` is a genuine color map, near-black with small
bright switch detail. Shown raw it would look right. The reason it cannot
simply be trusted is that `Cockpit_LR_Colour.dds` is the same shape — MultiMap,
no detail — and is a palette of team color swatches that renders as stitched
nonsense.

Nothing in the material distinguishes them. This wants the same treatment the
`bake` fact just got: a recorded per-texture choice in the profile saying
whether a MultiMap diffuse is a standalone image, seeded by the generator and
correctable by a human who can see the car.

### `trustworthyDiffuse` is still an inference

Same class of problem as the one `bake` was moved out of. It decides from the
shader NAME whether a diffuse can stand alone, and its own comment admits the
weakness. Once the entry above exists, this function should read the profile
and the name-matching should be confined to the generator, where a wrong guess
is visible in a file rather than invisible at draw time.

### The occlusion bake's resolution shows through up close

`INT_HR_Occlusion.dds` is a single 1024x1024 sheet covering the whole interior,
so any one part gets a small slice of it. Magnified on the seat you can see its
texels, and the grain on top only partly hides them.

There is no obvious fix and it may not want one — the game has the same sheet.
Worth writing down so the next person does not spend an afternoon looking for
a bug in the detail maps, which is what happened the first time. Blurring the
bake is NOT the answer: it also carries the seat's printed lettering.

### A painted `interior` can be invisible in the editor, and nothing says so

On a car shipping two cockpits, the `interior` role can resolve to a texture
that only exists on the low-detail one — `Cockpit_LR_Colour.dds` here. In the
game it shows from outside and in replays, never from the driver's camera. In
the editor it now shows nowhere at all, because both views draw the
high-detail cockpit (see the note beside `paint` in `view3d.js`). Someone can
paint that surface, watch it render in the surface view, and never find it on
the car.

The fitment report already tells people when a design paints something the
car's config hides; this is the same kind of fact and should be reported the
same way rather than being worked out from a preview that never shows it.

The other half of this is making the low-detail cockpit renderable at all: its
materials state near-zero ambient and diffuse because AC lights an interior
with a term this viewer does not model. Give the viewer that term and the
external camera could show the LOD the game shows, which is what this was
briefly changed to do before it turned out to look black.

### The lighting calibration is anchored to one car's paint

`lightingFor` in `view3d.js` scales each material's `ksAmbient` / `ksDiffuse` /
`ksSpecular` against a `PAINT` constant taken from this NSX's carpaint, so that
bodywork renders exactly as it did before per-material lighting existed. That
is a deliberate calibration, not a measurement, and it is stated as such — but
if another car's carpaint constants differ materially, its whole interior moves
relative to a reference that has nothing to do with it. Worth revisiting once
there is a second car to compare against.

### highp is assumed, and only guarded

Detail maps are sampled at `vUv * detailUVMultiplier`, which reaches ~377 on
this car's carbon. In `mediump` that quantises to roughly three sample
positions per repeat and the weave collapses into a coarse mosaic. The shader
asks for `highp` behind `#ifdef GL_FRAGMENT_PRECISION_HIGH`, so it compiles
everywhere — but on a device without highp the mosaic comes back, silently.

If that ever matters, the fix is to take the fractional part before the
multiply survives the precision loss, or to cap the effective tiling. Both
change what the material looks like, so neither should be done on a guess.

### `additive` is still read off the filename

`additive(file)` matches `/emissive/i` and says so plainly, because at the time
the model gave us nothing better. It does: every material carries an
`isAdditive` property, sitting in the same `props` map the lighting terms come
out of. Read that, and keep the name as a fallback for a car that leaves it
zero — with the disagreement reported rather than silently resolved, since a
plate's emissive twin drawn the wrong way is a black slab over the plate.

Same lesson as `alphaBlendMode`: the model states this, and we were inferring
it from a string.

### Nothing checks the model against the profile's recorded facts

`bake`, `alphaHides` and the shader list are all measured once at profile
generation and read forever after. A car updated in place — mod cars are
updated often — leaves them describing a model that no longer exists, and every
one of them fails silently: a hide that no longer works, a sheet drawn as
artwork that is now a bake.

This entry used to say the profile records the model's size and mtime already,
and it does not. `calibration` records `method`, the model's FILENAME as
`source`, and the date — nothing about the file itself — and the `modelSize`
on each texture is that texture's dimensions inside the model, not the kn5's.
So this is two jobs, not one: record the kn5's byte size and mtime in
`calibration` when the profile is generated, and then compare them at load with
one `stat` and say "this profile was made against a different model". Only the
second half is the one-liner. The first half also decides what a profile made
before the field existed should do, which is say nothing rather than warn.

### The glass fresnel is invented where the material states one

Both renderers build a windscreen's transparency as `0.15 + 0.75 * rim` with
`rim = (1 - n·v)^2.5`. Every number in that is mine. The materials state their
own: `fresnelC` is the head-on term, `fresnelEXP` the falloff, and
`fresnelMaxLevel` the ceiling — 272 of the 328 composited reflective materials
across the 64 readable cars here state a maximum, ranging from 0 to 2.3 with a
median of 0.3, against the 0.9 this hard-codes.

That is the same shape of mistake as `alphaBlendMode`, `alphaTested` and the
glass alpha above it: a fact the model carries, replaced by a constant that
happened to look right on one car. It is also why the Abarth's side glass and
the NSX's read as the same material when they are not.

The lighting terms went through this exactly once already and it worked — see
`lightingFor`, which scales each material's own ksAmbient/ksDiffuse/ksSpecular.
The fresnel wants the same treatment, and the same calibration note: these are
AC's numbers for AC's renderer, so they need a reference point here rather than
being used raw.

### An island straddling a sheet boundary keeps a clipped panel — deferred

The other half of the shifted-sheet fix below, left undone on purpose. An
island that fits on another copy of the sheet is moved back whole; one that
straddles a boundary, which the game wraps across the image's edge, cannot be,
so its panel stops at the edge and loses whatever is past it. Measured after
the fix: 165 of them, on 70 textures on 49 cars, and not one on a texture the
classifier proposes as a body. They are flat swatches, glass and cockpit
sheets — the S2000's `black.dds`, the GT40's `Gray.dds`, the Alpine's clear
glass, the 962C's cockpit — and on most the clamp costs a few percent of the
island's area.

A real fix needs a panel of two or four rectangles, one per piece the wrap
leaves on the image, and every consumer of a panel's rect to handle it. Not
worth doing for surfaces nobody paints. Worth doing the first time a sweep
finds one on a body.

### What else is inferred that the model states

Worth keeping the list in one place, since three of them have now bitten:

- `isGlass` is still a set of shader NAMES. It is gated on the model's blend
  flag now, which is what made it safe, but the question it answers — does this
  surface get a fresnel — is really the fresnel properties above being present.
- `additive` reads the filename; `isAdditive` is in the material's props.
- `trustworthyDiffuse` reads the shader name (its own entry, above).
- The cockpit eye is estimated from a steering wheel's position. AC states the
  driver's eye in `car.ini` as `[GRAPHICS] DRIVEREYES` on most cars — a fact
  beside the model rather than in it, which is why it is listed here and not
  fixed with the rest.

## Done

### Portability, measured: what a portable design does on an untouched car

The sweep this file used to open with, and the roadmap's step 1.
`liveries/neon-grid-any.mjs` was resolved against 26 cars sampled from a
254-car install — every eleventh, sorted, plus the three this repository
already knows — each profiled from scratch with `profileFromKn5`, no prior, no
aliases, no hand-work. Sizes ran 25-75 textures and 2-855 panels. It is a
script now, so the figures can be re-run rather than quoted:

    node tools/sweep.mjs neon-grid-any --cars <install>/content/cars

**The format and the checker held.** The hand sweep ran each of its 25 cars
through `fitment` and found zero fatal findings; everything reported was a
low-severity overlap or mirror mismatch from the design's own layering. Nothing
about the design file, the fit file or the fitment machinery was the weak part.
(`tools/sweep.mjs` does not run `fitment`, so that figure has not been measured
again, and it ran without a model, so the geometry checks did not run.) What
did not hold was the part that decides *where* a portable design lands — the
six entries below. The before-and-after table is in
[portability-plan.md](portability-plan.md), whose five steps are all in; the
direction they sit in is [roadmap.md](roadmap.md).

- **A candidate with no islands was eligible to be the body.** The mp412c bound
  `body` to a role called `black` with ZERO panels, on a car whose `interior`
  had 90, so the design painted a sheet with nothing mapped on it and every tag
  selection then matched nothing. The classifier — which ranks on area,
  centerline, stock-skin overrides, shader, span and visibility, never on the
  name — now also counts islands and scores a texture with none at 0. That
  alone did not fix it: its real paint `SKIN_00` had kept 1 panel of 102,
  because one strip with UVs 1,222 sheets wide carried almost all the texture's
  UV area and the panel threshold is a share of it. With islands spanning more
  than a sheet out of that total, `SKIN_00` has 62 panels and binds at 0.82.
  Excluding tiled textures as well, as the plan first said, cost two real
  bodies and was dropped.

- **An unwrap shifted by whole sheets lost every island.** `findIslands`
  clamped each island's rectangle into [0, 1], so an island sitting on another
  copy of the sheet — an ordinary unwrap, which the game draws identically
  under wrap addressing — collapsed to a line and was dropped. Not three cars
  but 316 textures on 45, and on 13 of them it was the texture the classifier
  proposes as the body; every one of those bodies had no panels.
  `placeOnSheet` in `src/engine/kn5.mjs` now moves each such island back by
  whole sheets at parse time and `vertex()` applies the move, so islands,
  seams, outlines, safe areas, wheels and both renderers see it in the same
  place; an island goes to the copy holding most of it, [0, 1] winning a tie.
  The Avensis's body goes from 0 panels to 48 and binds at 0.79 rather than
  0.5; the 906's goes from 1 to 34. Checked by profiling the 26 before and
  after: 14 come out byte-identical and every texture that changed is on a car
  where islands moved. **Know before regenerating a profile:** `minPanelArea`
  is a share of each texture's island area, so recovered islands can push
  slivers under it — the NSX's `ext_mechanics_colour` gains 5 islands and 74%
  area, and drops from 64 panels to 55.

- **A texture listed under two spellings tied with itself.** The 906 bound
  `body` to its window sheet at 0.88 — confident and wrong — and won at
  confidence 0, because the model binds its real paint under two spellings and
  the profile listed it as two roles with identical measurements, so the margin
  over the runner-up, which was itself, was nothing. A confidence floor would
  then have refused to paint the right answer. It was 11 cars, not one: eight
  list a texture under two case spellings and three list one spelling twice,
  and `validateProfile` refused all 11, since a profile naming a file twice
  would ship it twice to a filesystem that holds it once. Profiles now hold one
  role per file, keyed by the lowercased name wherever the generator indexes
  textures, keeping the spelling most of the car's skins use with `--skins` and
  the model's first otherwise, saying which. All 11 load, and the 906 binds its
  paint at 0.79. Two had a second reason to fail hidden behind the first: a
  safe area taken from raw UVs on an overhanging island reached off the sheet.
  It is confined to the panel now, and a panel with no readable area left is
  marked hidden with `visible: 0` and logged, where a missing safe area used to
  read as the whole panel being readable.

- **Tag selections that match nothing.** `[left, visible]` and
  `[right, visible]` now land on all 26 cars. The genuine miss was the upper
  middle of the flank — `[left, mid, upper, visible]` matched nothing on 7 cars
  and `[right, mid, upper, visible]` on 6 — and the cause was the centroid: on
  the Exige, the Quattro, the 650 GT3 and the RX3 a visible door runs along the
  middle of the car from low down to well above its midline and was tagged
  `lower` because its centre sat just short of the line. Profiles record each
  panel's `extent3d` and a panel is tagged with every section and level it
  reaches (`src/engine/tags.mjs`). Three left and two right misses remain and
  are honest: the 906's visible mid-length flank lies wholly below the midline,
  the Lotus 49 has no visible side panel there, and the Morgan 3-Wheeler has
  two to choose from. `[shared, visible]` finds nothing on 16, every one a car
  without instanced bodywork — a tag a portable design should not lean on
  silently, so the portable example marks that rule `optional` and the
  portability report lists the miss as expected. Every other miss now names the
  tag that emptied it.

- **The design finds two of its fourteen surfaces bound.** Of the vocabulary's
  20 terms only `body`, `tires` and `brakes` could be proposed automatically,
  and `neon-grid-any` paints 14 terms of which `brakes` is not one — so a fresh
  car arrived with two surfaces bound and twelve `--explain`-and-confirm jobs.
  Both halves of the plan's step 5 are in. The scorers: `rims` and `interior`
  are proposed on every swept car and land on a labelled texture on 91% and 74%
  of the fleet (`docs/naming.md`). The one-pass confirmation: `--explain --all`
  and the editor's Bindings panel. The driver kit — `helmet`, `suit`, `gloves`,
  `crew` — is proposed from AC's own filenames and recorded as named, not
  measured. A swept car now arrives with a mean of 4.0 of the design's 14
  surfaces bound, where it was 2.0. The rest are still bound by hand, and
  whether a fresh car really goes from unbound to confirmed in one sitting is
  for a person to time; nothing here can.

- **An auto binding the profile calls a guess is painted anyway — measured, no
  floor set.** `resolveTargets` files an `unconfirmed` note for an `auto`
  binding and paints it with the same conviction at 0.04 as at 0.95, and the
  idea was a threshold below which the honest answer is to paint nothing. Once
  the classifier counted islands there was nothing below any plausible
  threshold to refuse: the three body proposals under 0.2 — the BAC Mono at
  0.03, the 650 GT3 at 0.04, the McLaren P1 at 0.10 — are all right, and the
  one the label disagrees with is at 0.8. So no floor. `tools/evaluate.mjs`
  prints the table, and **the question is worth asking again whenever the fleet
  or the classifier changes.** What the table did find was 11 cars whose
  `tires` bound the tread and not the sidewall, so tires and brakes now bind
  every texture only their own shader draws.

### A texture whose slot is spelled in another case vanished from the profile

`profilegen` built `boundAs` keyed by the spelling in the material's SLOT and
then looked it up by the spelling in the texture ENTRY. A kn5 where those
differ in case only — which nothing in the format forbids — filed the texture
as "shipped but never bound" and dropped it. Not merely unpaintable: absent.
`boundAs`, `coverage`, `shadersOf` and the classifier's shader lookup are now
keyed by the lowercased name where they are built, which is also what fixed the
doubled-texture entry above. The test in `carconfig.test.mjs` that asserted the
texture vanished now asserts it is kept, and still a bake.

### A panel only a secondary texture has could not be painted through its surface

Where a term binds two textures, as the RSS4's `body` binds `body` and
`bodyRear`, a region naming the second one's panel through `surfaces.body` was
a high `unmatched` and the build threw on it, while naming it through
`paint.bodyRear` was refused because `surfaces.body` already paints that
texture — so the panel was reachable by neither route, and a number laid out on
one sidepod landed on the floor as well, 62 high findings. A region may now
carry `role`, the one texture it is drawn on, and `drawnOn` in `src/fit.mjs` is
the single rule, applied inside `applyFit` after the key is stamped, so the
build, the renderer, fitment, the editor and the in-view count all agree about
the car and no positional key moves. `once` goes through it too, having been
honored by the build alone while the editor and fitment drew those regions on
every texture. A `role` its surface does not paint on this car is refused at
load, and a panel no bound texture has is still `unmatched`.

### Some of the car's own textures decode in the browser and not in Node

Both Node renderers dress an unpainted part in the car's own artwork, and
`decodeDds` shelled out to ImageMagick and nothing else — which refuses the
uncompressed 16-bit A8L8 sheets that are really in these cars: three on the
NSX (`INT_Bakes_2.dds`, `SEAMLESS_PLASTIC.dds`, `metal_detail_2.dds`) and the
RSS4's `HUB_1.dds`. Those parts drew gray while the editor showed them
correctly, which was the tell: the two renderers disagreeing about the car
across a decoder this project owns on one side and rents on the other. The
viewer's pixel loop is now `src/ui/dds.js` — no DOM, no GL — imported by
`view3d.js` in the browser and by `src/engine/pipeline.mjs` in Node, and served
to the browser by name (`SERVABLE` in `server.mjs`). ImageMagick is still asked
FIRST, being faster and downsizing on the way out; the shared decoder answers
for what it refuses, downsized the same way so a caller cannot tell which
replied, and `null` now means neither could read the file. `test/ui.test.mjs`
builds a DDS per format this fleet ships — 32-bit BGRA, 24-bit BGR, 16-bit
luminance-plus-alpha, DXT — and asserts the channel MASKS decide the byte
order, because guessing it turns a red car blue instead of failing.

**Not a bug, and worth not re-investigating:** `Display.dds` was the fourth
NSX texture and is a different question. It carries a DX10 header with
`dxgiFormat` 98, which is BC7, and AC is a DX9 engine that silently ignores a
DDS with a DX10 header — so the game does not draw this file either. Decoding
it would make the render show something the game does not.
