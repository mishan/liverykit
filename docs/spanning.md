# Plan: one region across several panels

## The problem

A panel is a UV island, and a rectangle is a rectangle in one island's sheet.
Nothing about that stops a design wanting a band that runs from the door onto
the rear quarter, and until now the answer was two regions, two rectangles and
a seam that never quite lined up — because the unwrapper put the quarter
somewhere else on the sheet, rotated, and nothing in the profile said by how
much.

The profile did know that the two islands *touch*. `adjacent` has been there
since the islands were, and the README said what it was for: "which lets
artwork continue across a UV seam". It could not, in fact, do that. Touching is
a fact about the car; continuing artwork needs a fact about the *sheets* —
where in each one the touching edge is, and which way round.

## What is measured

Two islands that touch share vertices along the seam: the same point on the
car, two sets of texture coordinates. That is the correspondence, and it is in
the model already.

For every adjacent pair, `findSeams` fits a map from one island's sheet to the
other's. Fitted in **metres**, not fractions: each island's `metresPerUv` turns
its sheet into a scale drawing of itself, and between two scale drawings that
meet along an edge the relationship is rigid — a rotation and a shift, and a
reflection where the unwrapper flipped one. A general affine was tempting and
wrong. A seam is a line, and a line of points cannot say what happens away
from the line; rigid is what "unfold the neighbour flat against this panel"
means, and two points determine it.

The one thing a line genuinely cannot tell is which *side* the neighbour
continues on: a rotation and a reflection across the seam fit collinear points
equally well, and on a four-point seam the residuals tie by noise. The first
version let the residuals decide and got the NSX's quarter reflected against
its intake surround while the door's seams to both said otherwise. The islands'
own handedness settles it — whether (u, v, outward) is a right-handed frame,
with "outward" the vertex normal rather than the winding, because the test
fixture winds two of its six faces inward and a mod car may well do the same.

Each seam is written into the profile on both islands:

```jsonc
"left_mid": {
  "seams": {
    "left_rear_upper": {
      "matrix": [1.00974, 0.0082, -0.0082, 1.00979, 0.0163, -0.02051],
      "here":   [[0.4741, 0.853], [0.4741, 0.9371]],
      "points": 39,
      "rmsMm":  7.1
    }
  },
  "outline": [[0.3174, 0.8089], …]
}
```

`matrix` takes this island's fractions to the neighbour's, in SVG order.
`here` is the seam as a polyline through the shared points, in this sheet —
where the seam is. A line and not a box, because the front clip meets the
roof along the windscreen base and down both A-pillars, an L whose box is
mostly sheet the seam is nowhere near.
`points` and `rmsMm` say how much the fit rests on and how far the shared
points miss under it: near zero for a crease, larger where the seam curves and
"unfold flat" is an approximation worth knowing about.

`outline` is the island's boundary polygon, simplified. It exists because a
panel's `rect` is a bounding box and islands are not boxes: unwrappers pack a
small island into the concave corner of a big one, and artwork clipped to the
box paints texels that belong to the neighbour. Only islands with seams carry
one; a profile is long enough.

## What a design says

```js
{ id: 'band', treatment: 'stripe', panel: 'left_mid', span: true,
  at: [-0.3, 0.62, 2.2, 0.10], color: 'white' }
```

`span: true` lets `at` run past the panel's edge. The part past the edge is
continued onto whichever islands it reaches. Everything else about the region
is unchanged: it has one treatment, one set of options, one seed.

## How it is drawn

Once. The treatment is called for the home rectangle, in the home panel's
frame, and the resulting SVG is placed on every reached panel under that
panel's map, clipped to that panel's outline. The home copy is clipped too:
the part of the rectangle past the home panel's edge belongs to some other
island, or to nobody, and painting it there would put a stray band on whatever
the unwrapper packed alongside.

The same drawing, not a re-rolled one. A stripe's edge, a trace's routing and
a word's letters continue across the seam because they are the same pixels
under a different transform. Two independent draws with the same seed would
diverge the moment their rectangles differed in size.

`clip-path` and `transform` go on separate groups. A clip-path on an element
is evaluated in that element's own coordinate system, transform included, and
the first version carried the clip along with the artwork and clipped every
copy but the home to the wrong place.

## Which panels are reached

The rule is easy to state and took three tries to get right:

**A neighbour is reached when the part of the region on the panel it is
leaving contains at least 3 cm of the seam to it.**

"The part on the panel" is the region's mapped quad clipped to the panel, as
a polygon. Boxes were tried first and a band mapped through a seam at -17
degrees is a parallelogram whose bounding box is mostly not band; tested as a
box it crossed seams it never touched and reached the roof from the door.

*Not* "when the unfolded rectangle overlaps the neighbour's box". A band on
the NSX's door reached the bonnet that way: the door touches the bonnet at one
corner, and unfolding the whole door across that corner laid the band over the
bonnet's sheet. It never crossed the seam.

*Not* "when the region crosses the seam", either, testing the whole unfolded
band. That let an 8 cm spill onto the fender strip carry the band's other
three metres across every seam the strip has. Only the piece that is on the
current panel can cross out of it.

The 3 cm floor (`minCross`) is measured along the seam itself, so a corner
where three islands meet — the door and the rear quarter share a centimetre
and a half — cannot clear it however the region sits on it. Without the
floor, a band reached the quarter through that corner, at the corner's angle.

Panels are reached breadth-first: fewest seams wins, since every seam crossed
is an approximation, and among routes of equal length the one crossing more
seam. A panel nobody can see — a wheel arch liner, the inside of a sill — can
be *reached*, because that is where a band physically goes when it runs off a
fender and it costs nothing to paint it there, but is not a way *through*. A
route that continued through one came out somewhere else entirely: door,
fender, front arch liner, rear arch liner, quarter, under the car and back up,
with three seams' worth of unfolding error and a band on the quarter at an
angle nobody asked for.

## What the NSX said

The first real test. A band across the door at mid height, 30% past the front
edge and 120% past the rear:

- forward, it runs onto the fender strip ahead of the door, level, and onto
  the wedge of front clip at the foot of the A-pillar, which sits at the same
  beltline height as the band's top edge and looks like a mistake until you
  find it on the car;
- rearward, it runs onto the intake surround, level — the seam map between
  those two is an identity to half a degree, on 39 shared points, and the
  unwrapper had in fact laid them side by side;
- and there it stops. The surround and the rear quarter touch at a corner,
  three shared points. Between them is the side intake, which is a hole.

That last is the measurement being right and the wish being wrong. The black
flank on this design reads as continuous across the intake because both sides
of the hole are black; a *band* cannot cross a hole, and the profile says so.
Two maps to the quarter exist — directly from the door at -17°, through the
surround at -49° — and they disagree by the curvature of the quarter between
the two corners they were measured at. Both are right where they were measured
and neither is a way to carry a stripe over an opening.

## What the fitment check does with it

A spanning region is several placements, one per reached panel, each checked
where it actually lies. Checking the home rectangle alone would report the
part past the edge as off-mesh, which is the one place it is meant to be. A
finding on a spilled piece names the panel (`band@left_rear_upper`), which is
what somebody needs to go and look at the right sheet.

The `unseen` check is quiet about a spilled piece that is not words. Out of
sight is where a band that ran into the wheel arch is allowed to be; it is only
worth a word when it is words.

## What this does not do yet

**The editor.** The overlay draws the home rectangle, and a drag clamps to
the panel, so a spanning region is written by hand or proposed over MCP for
now. The right gesture is not obvious — a rectangle that can leave its panel
needs to show where it went — and it is worth its own plan.

**Holes.** An outline is the outer loop of an island; a window cut-out inside
it is painted. Nothing on the car shows it, and a polygon with holes is a job
for the day something does.

**Curvature.** Each seam map is exact at its own seam. Artwork continued far
across a curved island drifts by the curvature, which is what `rmsMm` is for:
a seam that reports 15 mm is one where the flattening is already visible at
the seam itself.
