# Backlog

Things known to be wrong, or known to be guessed, that nobody has got to yet.
Each entry says what the symptom is, what causes it, and what the fix would
have to establish — because the expensive part of every one of these has been
identifying the surface, not changing the code.

Ordered roughly by how much they cost the person looking at the preview.

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

## The base normal map is never sampled

Only `txNormalDetail` is read. `txNormal` carries per-part relief — stitching,
panel seams, the moulding around a switch — at the bake's UV rather than tiled.
The tangent frame and the upload path both already exist, so this is one more
sampler and one more blend; it was left out to keep the first normal-mapping
change to one thing.

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
