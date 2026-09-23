# Roadmap: what liverykit is, what it could be, and what to build

Written after reading the whole tree at 227 commits, five weeks in. It is an
argument, not a schedule, and the numbers in it are the ones the docs and the
code already state; nothing here was re-measured.

## What it is now

The README calls it a livery generator. It is more accurately three things,
in order of how hard they would be to replace:

**A measurement of an unwrapped surface.** From a model, `profileFromKn5`
derives named UV islands with exact rectangles, metres per UV unit, ray-cast
visibility from trackside and from the driver's seat, adjacency, rigid seam
maps between touching islands, outlines, mirror pairs, wheel layout and text
rotation. No texture painter produces this, because a painter works on one
object and does not need to describe it to anyone else. A profile is a
description of the surface that another program can reason about.

**A design as data, with a checker.** A region names a panel or a tag set in
panel-relative coordinates. A binding maps a fixed vocabulary onto whatever a
car calls its textures, proposed by a classifier that scores 192 of 195 on a
held-out label and confirmed by a person. A fit holds the per-pair
adjustments and nothing else. `fitment` reports what is wrong with a
placement in millimetres. Together these are what let one design travel and
be diffed, which a painted texture cannot do.

**A disposition.** Nothing fails silently, a guess is labelled a guess, a
machine's proposal is kept apart from a person's confirmation, and an agent
may propose but never commit. That is a product stance rather than a feature,
and it is the thing most likely to be lost if the project grows fast.

The Assetto Corsa specific layer is thinner than the vocabulary of the
codebase suggests. It is the kn5 parser, the axes taken from wheel nodes, the
skins-folder cross-reference, the shader-name heuristics in `kn5.mjs`, the
DDS encoding through ImageMagick, `car.ini`, and the Content Manager ZIP
layout. The measurement engine reaches the model only through `vertex` and
`triangles`, and the whole tree touches about a dozen fields of the model
object, nearly all of them `meshes` and `materials`. The synthetic fixture in
`test/fixtures/kn5.mjs` is already a de facto contract for that shape.

## The idea: any design on any 3D object

Half right, and the halves are worth separating.

**"Any object" is close.** Islands, seams, anisotropy, visibility, outlines,
spans, fitment, decals, the editor and the software rasteriser are
object-agnostic in substance. A glTF loader that fills the same model shape
would make the profile generator work on any mesh with UVs. What is
car-shaped in the generic path: the orientation frame comes from wheels; the
tags are `nose`, `tail`, `flank`; the classifier's evidence includes stock
skin overrides and AC shader names; the output is DDS in a skins folder; and
the words `car`, `livery` and `skin` are in every identifier.

**"Any design" is the real gap, in three places.**

1. **Designs live in sheet space.** A region says "this panel, this
   rectangle". To place anything you must know the unwrap, which is exactly
   the knowledge a generic tool should remove. The 3D view can drag a region,
   but the drag is resolved as a UV delta on one sheet, and `docs/fitting.md`
   says in as many words that nothing knows which part of a panel is flat.
2. **Spanning is one seam deep.** Seam maps take an island to its neighbour.
   A stripe around a whole car needs a path of seams composed into one
   flattened canvas, and nothing walks that graph.
3. **Nothing measures flatness.** The profile says whether a spot is visible
   and not whether it is curved. The normals are in the model; the number is
   computable per rectangle and is not computed.

**A caution about the market.** Free painting on one object is a solved and
crowded problem: Substance Painter, Blender, Mari, ArmorPaint. Building a
brush would put liverykit in that field with none of their years. Its edge is
the opposite thing: fitting one design to many objects with measured feedback
and an honest report. The problems that actually share that shape are

- a team identity across several cars in one sim, which is the current
  product;
- other sims that take UV-mapped DDS skins in a folder: Automobilista 2,
  rFactor 2, Le Mans Ultimate, BeamNG. iRacing is closed to custom textures
  beyond its templates and is not a target;
- all-over-print apparel, where pattern pieces are UV islands and sewing
  seams are literally seams, and where "does the stripe line up across the
  side seam" is the same question `findSeams` answers today.

The third is the biggest idea and a different business. The second reuses
nearly everything and reaches people who already know what a skin is.

## What to build, in order

Each step says what it is for and what would show it worked. The order puts
cheap correctness before generality, because a generic kernel inherits every
flaw the car-specific one has.

**1. Close the portability gap — done.** `docs/portability-plan.md`. A sweep
harness, tiled materials named, islands as a classifier input, a measured
confidence floor, extent-based tags with a nearest-miss explanation, and
one-pass binding. Done when the 25-car sweep is a script and its numbers have
moved: it is `tools/sweep.mjs`, it covers 26 cars, all five steps of the plan
are in, and a car arrives with a mean of 4.0 of the portable design's 14
surfaces bound where it was 2.0. The confidence floor the plan proposed was
measured and deliberately not set; see `docs/backlog.md`. **Step 2 is the next
one.**

**2. Extract the kernel.** Document the model contract that `vertex` and
`triangles` already imply. Add a glTF loader that fills it, since binary glTF
is a few hundred lines and every DCC tool exports it. Make the orientation
frame pluggable: from wheels for cars, from a stated up and forward for
anything else, with the tag names derived from the frame so `nose` becomes
`front` on an object that has no nose. Put DDS and the ZIP layout behind an
output adapter with PNG as the default. Keep the name liverykit for the AC
product and give the kernel its own package rather than renaming everything;
the AC users lose nothing and the split is cheap now and expensive later.
Done when the synthetic fixture profiles identically through both loaders
and a glTF teapot gets a profile with islands, seams and visibility.

**3. Placement in 3D, as data.** A region gains an anchor: a surface point, an
up direction on the surface, and a size in millimetres. The resolver turns it
into per-island UV placements through the seam maps, and the fit file holds
the result, so the design is still data and still diffs. The editor already
has the barycentric pick, `metresPerUv` already gives the scale, and the
"which part of a panel is flat" guess goes away because the person clicks
the flat spot. This single step is most of "any design on any object", and
it is placement, not painting: the artwork is still a treatment or a decal,
still rendered by `renderTexture`, still checked by `fitment`. Done when a
number placed by clicking the door lands on the door on all three shipped
cars, and the fit that records it reads as three numbers a person can
understand.

**4. Flatness.** A per-rectangle curvature figure from the vertex normals,
reported by `fitment` beside visibility and used by the tag pass as a
threshold tag. Small, and it removes the last guess in placing text. Done when
the checker names a rectangle that wraps a wheel arch.

**5. Multi-hop flattening.** Generalise `span` from one seam to a path:
compose the rigid seam maps along a route between islands, render once on the
flattened canvas, clip by outlines, split back. Wrap-around stripes and
full-length lettering follow. Done when a stripe drawn from the nose lands
continuous on the tail of the NSX.

**6. A sanitised vector import.** Decals cover raster. A designer exporting an
SVG from Illustrator or Figma is the missing "any design" input. The threat
model in `AGENTS.md` already says how: rasterise on load, never travel as
markup. Done when a downloaded SVG with a script in it renders as pixels and
nothing else.

**7. A second adapter.** Pick one sim from the list above and take it through
loader, frame, classifier evidence and output. Its purpose is to prove that
step 2 drew the line in the right place, and every place it did not is a
finding worth more than the adapter. Done when the portable example builds
for both games from one design file.

**8. A profile registry.** Profiles are the artifact worth sharing and the
thing that will bring people in. An index of profiles by car id, with the
model's size and mtime recorded so a stale one is detectable, and a way to
submit one that does not require a pull request. Done when someone who is not
the author has contributed a profile.

## What not to build

A brush. See above.

An agent that places artwork. `docs/mcp.md` already made this argument and it
holds: the eye is load-bearing, and step 3 makes the eye more useful rather
than less necessary. `autolivery/` is not that agent: it drafts, measures and
proposes, never commits, and a person still decides in the editor's inbox —
see the trust boundary in [its README](../autolivery/README.md).

A renderer that competes with the game. Two renderers already disagree about
the car, and `docs/backlog.md` is a list of the places they do. The preview
answers "does the artwork land where I said", not "is this the game", and
every hour spent on fresnel is an hour not spent on steps 1 through 3.

## What is not known

The repository is five weeks old, has one star and no issues, so everything
above is reasoning about fit and nothing is observed demand. The first real
signal will be whether other Assetto Corsa players contribute profiles once
step 1 lands and binding a new car is a ten-minute job. If that does not
happen, step 8 is the question to answer before steps 2 through 7, because a
kernel nobody feeds objects into is a library, not a tool.
