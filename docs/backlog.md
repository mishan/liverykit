# Backlog

Things known to be wrong, or known to be guessed, that nobody has got to yet.
Each entry says what the symptom is, what causes it, and what the fix would
have to establish — because the expensive part of every one of these has been
identifying the surface, not changing the code.

Ordered roughly by how much they cost the person looking at the preview.

## Portability, measured: what a portable design does on an untouched car

> The fixes for the five entries under this heading are planned in
> [portability-plan.md](portability-plan.md); the wider direction they sit in
> is [roadmap.md](roadmap.md).

Written from a sweep rather than an impression, so the entries under it can be
argued with. 26 cars were sampled from a 254-car install — every eleventh,
sorted, plus the three this repository already knows — profiled from scratch
with `profileFromKn5` (no prior, no aliases, no hand-work of any kind), and
then `liveries/neon-grid-any.mjs` was resolved against each. Sizes ran 25-75
textures and 2-855 panels.

The sweep was first done by hand, and is now a script:

    node tools/sweep.mjs neon-grid-any --cars <install>/content/cars

The figures below are the script's, on the engine with the shifted-sheet fix
described further down; where that fix moved one, the entry says what it was
before. Run on the
engine as it stood when this was first written (`1562ef1`), it reproduces the
hand sweep's bindings exactly. It differs from the hand sweep in two places,
both understood: it profiles `pm3dm_bmw_320i_stw`, whose only model is
`_LODA.kn5` and which the hand sampler's "not a LOD" filter threw away, so it
covers 26 cars rather than 25; and it counts a tag rule as missed by cars, not
by regions, which halves the flank figures the first write-up gave (see below).

**The format and the checker held.** The hand sweep also ran each of its 25
cars through `fitment`, and found zero fatal findings; everything reported was
a low-severity overlap or mirror mismatch from the design's own layering.
`tools/sweep.mjs` does not run `fitment`, so that figure is the hand sweep's
and has not been measured again. Nothing about the design file, the fit file
or the fitment machinery is the weak part. `fitment` ran without a model, so
the geometry checks — `unseen`, `off-mesh`, `unpainted-twin` — did not run,
and neither sweep built or rendered anything: this measures resolution and
placement.

**The design painted two surfaces on every car**: `body` and `tyres`. What
follows is why, in the order worth fixing.

## A candidate with no islands was eligible to be the body — fixed

Of 26 cars, the body binding is confident (>= 0.7) on 23, shaky on 2, and a
guess on 1: `ks_mclaren_650_gt3` at 0.04, whose pick is right and whose margin
is the next entry's problem. The mp412c was the other guess. It bound `body` to
a role called `black` that has ZERO panels, on a car whose `interior` has 90
and whose `rims` have 84 — so the design painted a sheet with nothing mapped on
it, and every tag selection then matched nothing.

The classifier ranks candidates on surface area, whether they straddle the
centreline, how many stock skins override them, shader, how much of the car's
length and height they span, and visibility — never on the name — and it now
also knows how many islands each has, and gives a texture with none a score of
0. That alone did not fix the mp412c: its paint, `SKIN_00`, had kept 1 panel of
102, because one strip on its chassis with UVs 1,222 sheets wide carried almost
all of the texture's UV area and the panel threshold is a share of it. With
islands spanning more than a sheet left out of that total, `SKIN_00` has 62
panels, and the mp412c binds it at 0.82. Excluding tiled textures as well, as
the plan first said, cost two real bodies and was dropped (see the plan's
step 2).

## An auto binding the profile calls a guess is painted anyway — measured

`resolveTargets` files an `unconfirmed` note for an `auto` binding and then
paints it, with the same conviction at 0.04 as at 0.95. The idea was a
threshold below which the honest answer is to paint nothing and say so.

Measured across the fleet, after the classifier learned to count islands,
there is nothing below any plausible threshold to refuse: the three body
proposals under 0.2 — the BAC Mono at 0.03, the 650 GT3 at 0.04, the McLaren
P1 at 0.10 — are all right, and the one the label disagrees with is at 0.8.
So no floor is set; `tools/evaluate.mjs` prints the table, and the question is
worth asking again whenever the fleet or the classifier changes. What the
table did find was 11 cars whose `tyres` bound the tread and not the sidewall;
tyres and brakes now bind every texture only their own shader draws. See the
plan's step 3.

## Tag selections that match nothing

`[left, visible]` and `[right, visible]` now land on all 26 cars. The last miss
was the mp412c, whose body was bound to a tiled swatch with no islands until
the classifier learned to count them; before the shifted-sheet fix below it
was 5, every one a car whose body had no usable panels. The first write-up said 10 each,
"about 40% of cars"; that counted the design's two `[left, visible]` regions,
the piping and the number, as two misses per car.

What genuinely missed was the upper middle of the flank. Before the tagger read
extents, `[left, mid, upper, visible]` matched nothing on 7 cars with a right
body and `[right, mid, upper, visible]` on 6. The cause was the centroid, and
mostly for the level rather than the section: on the Exige, the Quattro, the
650 GT3 and the RX3 a visible door runs along the middle of the car from low
down to well above its midline, and was tagged `lower`, or not `mid`, because
its centroid sat just short of the line. Profiles now record each panel's
`extent3d`, and a panel is tagged with every section and level it reaches
(see `src/engine/tags.mjs`). Those four cars now match, and the misses are 3
on the left and 2 on the right. What is left is honest: the 906's visible
mid-length flank lies wholly below the midline, the Lotus 49 has no visible
side panel in the middle of the car, and the Morgan 3-Wheeler has two panels
on its left to choose from. `visible` emptied no selection, before or after.

`[shared, visible]` found nothing on 16, every one of them because the car has
no instanced bodywork. `shared` is a tag a portable design should not lean on
without saying the miss is expected, and the portable example now says so: the
rule is `optional`, so on those cars the build says nothing and the portability
report lists it as expected. Every other miss now says which tag emptied it.

## A texture listed under two spellings tied with itself — fixed

`ac_legends_gt_porsche_906` bound `body` to its window sheet at 0.88 — confident,
and wrong — until the shifted-sheet fix below, and that bug was the whole cause.
Its paint, `906_EXT_Body_Diff.DDS`, which every one of its 39 stock skins
overrides, sits one sheet below [0, 1]. All but one of its islands were dropped,
so its visibility was measured on the one left, at 1%, while the window sheet
kept a panel measuring 100%. With its islands back the paint has 34 panels,
56% visible, and wins.

It won at confidence 0. The model binds the file under two spellings,
`906_EXT_Body_Diff.DDS` and `906_EXT_Body_Diff.dds`, so the profile listed it
as two roles with identical measurements, and the margin over the runner-up,
which was itself, was nothing. A confidence floor, as the portability plan's
step 3 proposes, would then have refused to paint the right answer. And the
profile would not load at all: `validateProfile` refuses one that names a file
twice, since it would ship it twice to a filesystem that holds it once.

It was 11 cars, not one. Eight list a texture under two case spellings — the
906, the Glickenhaus, the MC12 GT1's `skin_00`, both MX-5s, the 570S's
`EXT_skin` and both Evoras — and three list one spelling twice. Profiles now
have one role per file, keyed by the lowercased name wherever the generator
indexes textures, and keep the spelling most of the car's skins use when
`--skins` is given, and the model's first otherwise, saying which; a build
writes that one, which on Windows overrides every spelling of it, and on a
case-sensitive filesystem matches the stock skins it sits beside. All 11 profiles load, and
the 906 binds its paint at 0.79. Two of them, the 458 GT2 and the MX-5 Cup, had
a second reason not to load, hidden behind the first: a panel's safe area,
taken from raw UVs on an island overhanging the sheet, reached off it. It is
now confined to the panel. A panel with no readable area left on it is marked
hidden, with `visible: 0`, and logged, where a missing safe area used to read
as the whole panel being readable.

## An unwrap shifted by whole sheets lost every island — fixed

Three of the 26 — `tando_buddies_180sx` (2 panels from 66 textures),
`btcc_toyota_avensis` (3) and `tc_legends_mazda_rx3` (7) — had essentially no
UV islands anywhere. This entry first put that down to seamless tiled
materials. Measured, it was nothing of the kind, and `findIslands` was not
returning nothing correctly.

The Avensis body is one mesh of 13,562 vertices whose UVs run from v = -0.96 to
-0.01: an ordinary unwrap, sitting one copy of the sheet below [0, 1]. Textures
are sampled with wrap addressing, so the game draws it exactly as it would at
v = 0 to 1. `findIslands` finds its islands and then clamps each rectangle into
[0, 1]; an island lying wholly on another copy clamps to zero height, and the
next line drops it as "collapsed to a line". The RX3's body is the same, one
sheet down. The 180SX's sits 60 sheets down and straddles a sheet boundary, so
only 54% of its surface lies on any one copy.

It was not three cars. Across the fleet, 316 textures carrying real geometry,
on 45 cars, are unwraps shifted by whole sheets, and on 13 cars it was the
texture the classifier proposes as the body: the Capri, the Corvette, the
365 GTB, the Giulietta, the RS3, the Civic, the Avensis, the Mygale, the GTA,
the A110, the 300 SEL, the 2002 and the RX3. Every one of those bodies had no
panels.

**The fix.** `placeOnSheet` in `src/engine/kn5.mjs` moves each island that fits
on another copy of the sheet, within the bleed `SHEET_SPAN` allows (0.025 at
each edge), back onto the copy in [0, 1], by whole sheets, when the model is
parsed, and `vertex()` applies the move. Everything
that reads UVs reads them through `vertex()` — islands, seams, outlines, safe
areas, wheels, the software renderer, the geometry the editor draws — so they
all see a moved island in the same place. An island goes to the copy of the
sheet holding most of it, [0, 1] winning a tie, so a sliver lying just past
the sheet's edge and a flange hard-edged to a shifted body land where their
neighbours do rather than clamping to nothing. One that spans more than a
sheet, and one straddling a boundary, are left exactly as stored, and a
texture's `uvTile` still records where the model put it.

Checked against the sweep's 26 cars, profiled before and after: the profiler
is deterministic, 14 profiles come out byte-identical, and every texture that
changed on the other 12 is on a car where islands moved. The Avensis's body
goes from 0 panels to 48 and binds at 0.79 rather than 0.5; the RX3's goes to
13, the 180SX's to 30, and the Porsche 906's from 1 to 34. The first version
of the rule read the tile off `floor(lo + slack)`, which sent islands lying
against the sheet's far edge one sheet the wrong way; the before-and-after
diff caught that at once, as four rim panels missing on the SF15T.

One consequence to know before regenerating a profile: `minPanelArea` is a
share of each texture's island area, so recovered islands can push slivers
under it. The NSX's `ext_mechanics_colour` gains 5 islands, grows 74% in area,
and loses 14 slivers of 0.09% to 0.12%, going from 64 panels to 55.

**Still open, on purpose.** An island straddling a sheet boundary, which the
game wraps across the image's edge, cannot move whole and is left where it is;
its panel stops at the edge. The generator counts such islands by texture, over
every island of at least `minVertices` vertices, including those on another
copy of the sheet that keep no panel at all; counting only the islands that
kept a panel said nothing about the 180SX, whose unwrap sits 60 sheets down.
Measured across the fleet after the fix, counting that narrower way, there are
165 of them on 70 textures on 49 cars, and not one is on a texture the
classifier proposes as a body; the wider count has not been re-measured. The
textures most covered by them are flat swatches, glass and cockpit sheets —
the S2000's `black.dds`, the GT40's `Grey.dds`, the Alpine's clear glass, the
962C's cockpit — and on most of those the clamp loses a few percent of the
island's area. A real fix needs a panel of two or four rectangles, one per
piece the wrap leaves on the image, and every consumer of a panel's rect to
handle it. That is not worth doing for surfaces nobody paints; it is worth
doing the first time a sweep finds one on a body.

## The design finds two of its fourteen surfaces bound

The vocabulary has 20 terms and three of them can be proposed automatically:
`body` (26/26, mean confidence 0.78), `tyres` (25/26, 0.96) and `brakes`
(23/26, 0.96). `neon-grid-any` paints 14 terms and `brakes` is not one of
them, so on arrival it found two. The other twelve — `rims`, `interior`,
`belts`, `steeringWheel`, `wing`, `metalTrim`, `heatShield`, `helmet`, `suit`,
`gloves`, `crew` and `numberPlate` — came back unbound on every car in the
sweep.

That is the ceiling on "portable": everything past the body and the tyres is a
per-car `--explain` and a human confirmation, which is a thirty-second job
repeated twelve times per car. Both halves are worth attention — teaching the
classifier the regular ones (`rims` and `interior` look highly patterned across
the fleet), and making confirming the rest one pass rather than twelve.

Both halves are in, as the portability plan's step 5.

- **The scorers:** `rims` and `interior` are now proposed on every car in
  the sweep. They land on a labelled texture on 91% and 74% of the fleet
  (`docs/naming.md`), and the sweep's cars arrive with a mean of 4.0 of the
  design's 14 surfaces bound, where it was 2.0.
- **The one-pass confirmation:** `--explain --all` and the editor's Bindings
  panel.

The rest of the twelve are bound by hand. The driver kit is next, to be
proposed from AC's own filenames. Whether a fresh car really goes
from unbound to confirmed in one sitting is for a person to time. Nothing here
can.

## A panel only a secondary texture has cannot be painted through its surface

**Symptom.** Where a term binds two textures, as the RSS4's `body` binds
`body` and `bodyRear`, `find_panels` and `find_space` answer about the second
texture's panels. But a region naming one of them through `surfaces.body` is a
high `unmatched`, and the build throws on it. Naming it through
`paint.bodyRear` instead is refused, because `surfaces.body` already paints
that texture.

**Cause.** A region on a surface is drawn on every texture the term binds.
That is right for tags and wrong for a panel name only one of them has. `once`
keeps a region on the primary (`src/build.mjs`), but nothing keeps one on the
texture that has its panel.

**What the fix has to establish.** That a region naming a panel is placed only
on the bound textures that have it, in the build, the renderer, fitment and the
editor alike, or they disagree about the car; and that a panel no bound texture
has is still `unmatched`.

## The CLI renderer has one light rig, not the car's materials

The editor reads `ksAmbient`, `ksDiffuse`, `ksSpecular` and `ksSpecularEXP` off
each material and lights by them; `shade()` here has a single hardcoded rig, so
the same surface is a different brightness in the two renderers even now that
they agree about its texture. The groups already carry `light`.

The obstacle is that the editor's `lightingFor` scales those numbers against a
`PAINT` constant taken from this car's carpaint, which is a calibration and not
a measurement (see below). Porting the calibration into a second renderer would
make one car's paint the reference for two of them.

## `INT_ELECTRONICS` and its kind still render grey

29k triangles of dash switchgear on this car. The material is
`ksPerPixelMultiMap` with `useDetail: 0`, so `detailLayer` correctly declines
it, and `trustworthyDiffuse` then refuses its diffuse because the shader name
says MultiMap — leaving the honest grey.

But `INT_Electronics_Colour.dds` is a genuine colour map, near-black with small
bright switch detail. Shown raw it would look right. The reason it cannot
simply be trusted is that `Cockpit_LR_Colour.dds` is the same shape — MultiMap,
no detail — and is a palette of team colour swatches that renders as stitched
nonsense.

Nothing in the material distinguishes them. This wants the same treatment the
`bake` fact just got: a recorded per-texture choice in the profile saying
whether a MultiMap diffuse is a standalone image, seeded by the generator and
correctable by a human who can see the car.

## Some of the car's own textures decode in the browser and not in Node

Both Node renderers now dress an unpainted part in the car's own artwork, and
`decodeDds` — which shells out to ImageMagick — returns null for four of this
NSX's textures. Three are uncompressed 16-bit A8L8: `INT_Bakes_2.dds`,
`SEAMLESS_PLASTIC.dds` and `metal_detail_2.dds`, all `DDPF_LUMINANCE |
DDPF_ALPHAPIXELS`, no fourCC, no mip chain. The RSS4's `HUB_1.dds` is another.
The parts wearing them draw grey; the build's log and the shot's
`x-liverykit-absent` header name them rather than dropping them quietly, which
is the only reason this is written down rather than still invisible.

The editor shows all four correctly, which is the tell. `decodeDds` in
`view3d.js` reads exactly this layout — it grew its luminance branch for
`metal_detail_2.dds`, through the channel masks rather than by assuming a byte
order — so the same file decodes in the browser and not in Node. That is the
two renderers disagreeing about the car again, this time across a decoder this
project owns on one side and rents on the other.

So the fix is probably to stop asking ImageMagick first: that pixel loop is
about forty lines of arithmetic with no DOM in it, and lifting it into
`engine/` would give both sides one answer, leaving ImageMagick the block
formats it does handle. What it would have to establish is that the lift is
faithful — it is the viewer's hot path, it is written for `ArrayBuffer` and
`Uint8Array` rather than `Buffer`, and a test that decodes one known file both
ways is what would say so.

`Display.dds` is the fourth and a different question. It carries a DX10 header
with `dxgiFormat` 98, which is BC7 — and AC is a DX9 engine that silently
ignores a DDS with a DX10 header, so the game does not draw this file either.
Whatever is on that display in the car, it is not this texture, and decoding
it would make the render show something the game does not.

## A texture whose slot is spelled in another case vanished from the profile — fixed

`profilegen` built `boundAs` keyed by the spelling in the material's SLOT and
then looked it up by the spelling in the texture ENTRY. A kn5 where those
differ in case only — which nothing in the format forbids, and which
`meshesUsingTexture` already guarded against by lowercasing both — filed the
texture as "shipped but never bound" and dropped it. Not merely unpaintable:
absent.

`boundAs`, `coverage` and `shadersOf`, and the classifier's own shader lookup,
are now keyed by the lowercased name where they are built, which is also what
fixed the doubled-texture entry above. The test in carconfig.test.mjs that
asserted the texture vanished now asserts it is kept, and still a bake.

## `trustworthyDiffuse` is still an inference

Same class of problem as the one `bake` was moved out of. It decides from the
shader NAME whether a diffuse can stand alone, and its own comment admits the
weakness. Once the entry above exists, this function should read the profile
and the name-matching should be confined to the generator, where a wrong guess
is visible in a file rather than invisible at draw time.

## The occlusion bake's resolution shows through up close

`INT_HR_Occlusion.dds` is a single 1024x1024 sheet covering the whole interior,
so any one part gets a small slice of it. Magnified on the seat you can see its
texels, and the grain on top only partly hides them.

There is no obvious fix and it may not want one — the game has the same sheet.
Worth writing down so the next person does not spend an afternoon looking for
a bug in the detail maps, which is what happened the first time. Blurring the
bake is NOT the answer: it also carries the seat's printed lettering.

## A painted `interior` can be invisible in the editor, and nothing says so

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

## The lighting calibration is anchored to one car's paint

`lightingFor` in `view3d.js` scales each material's `ksAmbient` / `ksDiffuse` /
`ksSpecular` against a `PAINT` constant taken from this NSX's carpaint, so that
bodywork renders exactly as it did before per-material lighting existed. That
is a deliberate calibration, not a measurement, and it is stated as such — but
if another car's carpaint constants differ materially, its whole interior moves
relative to a reference that has nothing to do with it. Worth revisiting once
there is a second car to compare against.

## highp is assumed, and only guarded

Detail maps are sampled at `vUv * detailUVMultiplier`, which reaches ~377 on
this car's carbon. In `mediump` that quantises to roughly three sample
positions per repeat and the weave collapses into a coarse mosaic. The shader
asks for `highp` behind `#ifdef GL_FRAGMENT_PRECISION_HIGH`, so it compiles
everywhere — but on a device without highp the mosaic comes back, silently.

If that ever matters, the fix is to take the fractional part before the
multiply survives the precision loss, or to cap the effective tiling. Both
change what the material looks like, so neither should be done on a guess.

## `additive` is still read off the filename

`additive(file)` matches `/emissive/i` and says so plainly, because at the time
the model gave us nothing better. It does: every material carries an
`isAdditive` property, sitting in the same `props` map the lighting terms come
out of. Read that, and keep the name as a fallback for a car that leaves it
zero — with the disagreement reported rather than silently resolved, since a
plate's emissive twin drawn the wrong way is a black slab over the plate.

Same lesson as `alphaBlendMode`: the model states this, and we were inferring
it from a string.

## Nothing checks the model against the profile's recorded facts

`bake`, `alphaHides` and the shader list are all measured once at profile
generation and read forever after. A car updated in place — mod cars are
updated often — leaves them describing a model that no longer exists, and every
one of them fails silently: a hide that no longer works, a sheet drawn as
artwork that is now a bake.

The profile records the model's size and mtime already. Comparing them at load
and saying "this profile was made against a different model" costs one `stat`
and would have caught this class of thing before a picture did.

## The glass fresnel is invented where the material states one

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

## What else is inferred that the model states

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
