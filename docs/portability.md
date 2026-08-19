# Does a livery travel between cars?

Not yet, and the reason is worth writing down, because the obvious fixes are all
wrong in a way that only shows up when you measure.

This project began against a single mod car and grew a convention along the way:
a livery names a *role* (`body`, `rims`, `belts`) and the car profile maps that
role to a texture file. The question is whether a role name means the same thing
on two different cars. To find out, 42 cars were profiled straight from their
models — 6 GT3/GTE, 8 open-wheelers, 5 prototypes, 7 road cars, 6 vintage, 5
touring, 5 deliberate outliers including a van and a three-wheeler. 1,423
textures, 18,460 UV islands, 30 seconds of compute.

Reproduce with `node tools/survey.mjs <carsDir>`.

## Names do not travel

Across 42 cars the generated role names produced **566 distinct names, 445 of
which appear on exactly one car**. The median car has 32 paintable textures and
shares almost none of its vocabulary with its neighbours.

A role called `body` exists on **16 of 42** cars — five of the six vintage cars,
none of the five prototypes. The rest call the same surface `skin_00`, `skin.dds`,
`ext_skin00`, `livery_d`, `paint`, `SkinBase_DEFAULT`, `chassi_787b`,
`car_skin_00`, `cobrabody`, `chassis_A_D2`, `detail_color` or
`exterior_body_diffuse`. A livery that says `paint: { body: … }` therefore renders
a blank car on roughly two thirds of the sample, and does it silently, because a
texture name that matches nothing overrides nothing.

Fifteen of the 42 also came back with **low-confidence axes** — no mesh named in a
way that reveals which end is the front — so even the geometric fallback naming
(`left_mid_upper`) is guessing on more than a third of cars.

## Three plausible signals, all of them wrong alone

If the name can't identify the paint surface, something measurable has to.

**Which files the stock skins override.** Appealing, and half right: every car
ships skins, and the files a skin folder replaces are by definition the ones its
author intended to be per-livery. Cross-checking the 178 files that *every* stock
skin of a car overrides against what the model says is paintable came back with
zero unexplained cases — 42 were `livery.png`, a Content Manager thumbnail that
isn't a texture at all, 24 were normal or shader maps the profiler already
refuses, and the remaining 112 were exactly the textures the profile lists as
paintable. The classifier and the skin authors agree completely.

But it does not find the *body*. The single most-overridden file on five of the
seven road cars is `metal_detail.dds` — and on the Miata that file **is bound to
no mesh at all**. Every stock skin ships it; overriding it paints nothing. It is
the same failure this project hit on its first day, preserved in the shipping
content of the game.

**Vertex count.** Rank each texture by how much geometry it covers and take the
top one. This picks an interior occlusion map on nearly every car in the sample,
because a cockpit is the densest geometry on a car — dials, switches, stitching —
and bodywork is among the sparsest. It agreed with the skin-override signal on
**3 of 41** cars.

**Surface area.** Better, and the correct unit: a livery covers square metres,
not vertices. But taken alone it selects engine bays, undertrays and cockpit
occlusion maps, which really are the largest surfaces on a racing car. `engine_d`
is 28% of a BAC Mono; `EXT_Engine_Bottom` is 28% of a 488 GT3.

## What actually works

Intersect them. **Among the textures at least one stock skin overrides, take the
one covering the most surface area.** Skin overrides say "the author meant this to
vary per livery"; area says "and it is the big surface, not a 32×32 tint swatch".

That rule finds the right body texture on about two thirds of the sample, and
where it fails it fails visibly rather than silently — the residue is a specific,
identifiable group: road cars whose stock skins are factory colour options that
ship *no* body texture at all. The Miata's eight colour variants each contain
four files, none of them bodywork. Those cars still have a paintable
`Skin_00.dds` in the model covering 15% of the car; Kunos simply didn't use it
for the factory colours. A livery can paint it. The heuristic just can't confirm
it from the skins, because there is nothing there to confirm.

## Where this leaves the design

The honest conclusion is that automatic role naming should stop pretending. No
measurement available identifies "the body" with certainty on an arbitrary car,
and the ones that come close disagree in ways that matter.

So the profile generator should rank candidates and show its evidence — area
covered, how many stock skins override it, dimensions, what the material slot
says — and let a human confirm the paint surface **once per car**. That is a
thirty-second job with the evidence in front of you and an unbounded one without
it. Everything downstream of that confirmation is already portable: the panel
namer's `side_section_level` scheme is derived from geometry and means the same
thing on a Formula car and a Transit van.

The intended mechanism is therefore semantic **tags** rather than role names. The
profile tags each panel from measured geometry — `bodywork`, `flank`, `left`,
`upper`, `visible`, `cockpit` — and a livery targets tags instead of filenames. A
design asking for a stripe along `flank + left` degrades gracefully on a car
without one, instead of throwing or, worse, rendering nothing and saying nothing.

One caution that falls out of the same survey and applies before any of this:
`Rim500.DDS` on the Abarth is shared by all four wheels, 64 panels at identical
rectangles and four different 3D positions. "Panel" and "part" are not 1:1, and a
tag vocabulary that assumes they are will be wrong on every car with symmetric
wheels — which is to say all of them.
