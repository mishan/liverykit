# autolivery backlog

Ideas worth doing that are not yet being worked on. The work ahead of them moves
the judgments the critic keeps getting wrong into measurement. In order:

- what each view shows of a region, from an ID render (done: `hidden-in-view`,
  and the count the critic is told)
- minimum sizes for numbers and names
- a table of well-known liveries
- a rule that keeps the team name with the number

## Check a stripe's direction and continuity in 3D

**What went wrong.** A Gulf centre stripe went wrong twice, in two different ways:

- **Across the car (run 19).** The planner wrote `[0.4, 0, 0.2, 1]` on bonnet and
  roof panels whose x runs along the car. That paints a band across the car, not
  a stripe down it. `find_panels` now reports each panel's `axes`, and the prompt
  says how to write a stripe either way, but nothing checks the result.
- **Offset pieces (run 20, round 1).** The stripe broke into rectangles that did
  not line up from one panel to the next.

Both were found only by the critic looking at a picture — once too late, and
once argued about for a round.

**The idea.** The profile already relates each panel's texture to the car (the
`uAxis` and `vAxis` directions, the island's outline, and the mesh itself). For a
region whose id or brief marks it as a stripe along the car, map its pieces on
each panel to 3D and check three things:

- **Direction.** Each piece's long side runs along the car's length (the z
  axis). A piece whose long side runs across the car is the run 19 mistake.
- **Alignment.** Consecutive pieces sit at the same lateral position and width
  within a tolerance, say 20 mm. Offset rectangles are the run 20 mistake.
- **Coverage.** Together the pieces cover the stretch the brief asks for, for
  example nose to rear deck, apart from gaps where the car has no paintable
  surface (glass, vents, louvres).

Report failures as fitment findings, so the planner hears them while drafting.
A stripe interrupted by the car's own openings is not a failure; that is the
distinction the critic got wrong in run 20.

**Where to start.**

- `src/profile.mjs`, which has `panel`, `resolveRect` and the spans code (it
  knows which panels neighbour which)
- `src/engine/visibility.mjs`, whose `scanGrid` maps a UV rectangle to surface
  points
- the ID render, once it exists (each region drawn in a flat, unique colour so
  its pixels in a view can be counted), could measure the top view's coverage
  of the stripe as a cross-check

**Test with.**

- `--replay` on runs 19 and 20
- the eval cases `run19-r2-stripe-across`, `run20-r1-stripe-gaps-are-the-car`
  and `run20-r4-stripe-present`
