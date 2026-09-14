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

The figures below are the script's, on the engine at `d16e8a0`. Run on the
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

## A candidate with no islands is still eligible to be the body

Of 26 cars, the body binding was confident (>= 0.7) on 21, shaky on 3, and a
guess on 2: `ks_mclaren_650_gt3` and `mclaren_mp412c_gt3`, both at 0.04. They
were 0.11 and 0.19 when first measured; the visibility changes of 2026-09-13
narrowed both margins and changed neither pick. The second is the instructive
one. It bound `body` to a role called `black` that
has ZERO panels, on a car whose `interior` has 90 and whose `rims` have 84 —
so the design painted a sheet with nothing mapped on it, and every tag
selection then matched nothing.

The classifier ranks candidates on surface area, whether they straddle the
centreline, how many stock skins override them, shader, how much of the car's
length and height they span, and visibility — never on the name. It does not
ask whether a candidate has any paintable islands, which is the one piece of
evidence that would have settled the second of these. A texture no island lives
on cannot be the thing a livery paints, and that is a measurement already
sitting in the profile beside the binding. The first McLaren is a different
case: its pick, `skin`, has 47 panels, and the problem is only that the call
was close — which is the next entry's.

## An auto binding the profile calls a guess is painted anyway

`resolveTargets` files an `unconfirmed` note for an `auto` binding and then
paints it — with the same conviction at 0.19 as at 0.95. On the two cars above
that means artwork on the wrong sheet, reported in a note nobody reads before
looking at the car.

There is a threshold below which the honest answer is to paint nothing and say
which term went unpainted, exactly as an absent surface is handled today. Where
that threshold sits wants looking at across the fleet rather than picking a
round number: the same sweep can answer it.

## Tag selections that match nothing

`[left, visible]` and `[right, visible]` found no panel on 5 of 26 cars each,
and those five are every car whose body has no usable panels: the three whose
body sheet is shifted off [0, 1] and lost its islands (below), the McLaren
bound to a sheet with no panels, and the Porsche 906 bound to its window. On
every car with a right body that kept its panels, the flank rules landed. The first
write-up said 10 each, "about 40% of cars"; that counted the design's two
`[left, visible]` regions, the piping and the number, as two misses per car.

What genuinely misses is `mid`. Leaving those five cars out,
`[left, mid, upper, visible]` matched nothing on 5 cars and
`[right, mid, upper, visible]` on 4, and on six of those nine misses the tag
that emptied the selection was `mid` — on `ks_mclaren_650_gt3`, `lotus_49`,
`lotus_exige_240` and `ks_audi_sport_quattro_s1`, only 3 to 13 body panels are
`mid` at all. That is the centroid tagging: a flank that spans the middle of the
car is `mid` only if its centroid happens to land there. `visible` was the tag
that emptied a selection on none of them.

`[shared, visible]` found nothing on 18, 13 of them cars with a correct body,
and every one of those because the car has no instanced bodywork. `shared` is a
tag a portable design should not lean on without saying the miss is expected.

## A see-through sheet can outrank the paint on visibility

`ac_legends_gt_porsche_906` binds `body` to `906_EXT_WINDOW_DIFF.dds` at 0.88:
confident, and wrong. Its paint is `906_EXT_Body_Diff.DDS`, which every one of
its 39 stock skins overrides and which covers 32% of the car — but its one
panel measures 1% visible, while the window sheet, an alpha-tested
`ksPerPixelMultiMap_AT` material that 23 skins override, measures 100%.
Visibility is the classifier's decisive term, so the window wins.

It was the same on the engine this section's sweep was first run on (0.77), so
it predates the visibility changes of 2026-09-13, and the hand sweep counted it
among the confident bindings. Nothing in the portability plan catches it: the
window has a panel, so a rule against empty sheets passes it, and 0.88 clears
any plausible floor. What the fix has to establish is what the rays aimed at
the body are stopping on, and that the body ranks first once they stop on the
right thing.

## An unwrap shifted by whole sheets loses every island

Three of the 26 — `tando_buddies_180sx` (2 panels from 66 textures),
`btcc_toyota_avensis` (3) and `tc_legends_mazda_rx3` (7) — have essentially no
UV islands anywhere. This entry first put that down to seamless tiled
materials. Measured, it is nothing of the kind, and `findIslands` is not
returning nothing correctly.

The Avensis body is one mesh of 13,562 vertices whose UVs run from v = -0.96 to
-0.01: an ordinary unwrap, sitting one copy of the sheet below [0, 1]. Textures
are sampled with wrap addressing, so the game draws it exactly as it would at
v = 0 to 1. `findIslands` finds its islands and then clamps each rectangle into
[0, 1]; an island lying wholly on another copy clamps to zero height, and the
next line drops it as "collapsed to a line". The RX3's body is the same, one
sheet down. The 180SX's sits 60 sheets down and straddles a sheet boundary, so
only 54% of its surface lies on any one copy.

It is not three cars. Across the fleet, 316 textures carrying real geometry,
on 45 cars, are unwraps shifted by whole sheets, and on 13 cars it is the
texture the classifier proposes as the body: the Capri, the Corvette, the
365 GTB, the Giulietta, the RS3, the Civic, the Avensis, the Mygale, the GTA,
the A110, the 300 SEL, the 2002 and the RX3. Every one of those bodies has no
panels.

Profiles now say so: a texture's `uvTile` records the offset, and the
generator logs the shifted textures by name. What the fix has to establish is
that an island is measured on its own copy of the sheet, with its rectangle,
seams, outline and every other UV-derived figure shifted back by the same
whole number; that a sheet straddling a boundary is either split where it
wraps or reported as such; and that the Avensis's body comes out with panels
while every unshifted profile comes out byte-identical.

## The design finds two of its fourteen surfaces bound

The vocabulary has 20 terms and three of them can be proposed automatically:
`body` (26/26, mean confidence 0.77), `tyres` (25/26, 0.96) and `brakes`
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

## A texture whose slot is spelled in another case vanishes from the profile

`profilegen` builds `boundAs` keyed by the spelling in the material's SLOT and
then looks it up by the spelling in the texture ENTRY. A kn5 where those differ
in case only — which nothing in the format forbids, and which `meshesUsingTexture`
already guards against by lowercasing both — files the texture as "shipped but
never bound" and drops it. Not merely unpaintable: absent. It is in no list, it
gets no `bake` seed, and the report has nothing to say about it.

`headers`, `coverage` and `shadersOf` are keyed the same way, so the fix is to
normalise the key once where these maps are built rather than at each lookup.
There is a test in carconfig.test.mjs asserting the current behaviour, so that
whoever changes it can see what changes.

No car here has triggered it. It is written down because it was found while
removing a redundant case-sensitive comparison one layer further in, and the
outer one is the one that actually bites.

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
