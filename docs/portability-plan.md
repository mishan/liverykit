# Plan: closing the portability gap

## The problem

`docs/backlog.md` opens with a measurement: `neon-grid-any` resolved against 26
cars it had never seen, profiled from scratch with no hand-work. The format
held, the fit machinery held, and the fitment checker reported nothing fatal.
What did not hold was the part that decides *where* a portable design lands:

| what went wrong | on how many of 26 |
|---|---|
| body bound to a texture with no UV islands at all | 0; 1 (`mclaren_mp412c_gt3`) before step 2, which now binds its paint at 0.82 |
| body bound to the right texture, whose islands were all dropped | 0; 2 (Avensis, RX3) before the shifted-sheet fix, and the 180SX's kept 2 panels |
| body bound confidently to the wrong texture | 0; the Porsche 906 was, at 0.88, before the same fix, and now binds its paint at 0.79 |
| an `auto` body proposal below 0.2 that is wrong | none; the three there are right, so no floor is set (step 3) |
| `tyres` bound to one of a car's two tyre textures | 0; 11 of 176 labelled cars before step 3, which binds both |
| `[left, visible]` or `[right, visible]` matched no panel | 0; 1 each, the mp412c, before step 2 |
| a `[mid, upper, visible]` selection matched nothing on a car with a right body | 3 on the left, 2 on the right; 7 and 6 before tags read each panel's extent |
| `[shared, visible]` matched no panel | 16, every one a car without instanced flanks; the rule is `optional` now, so these are expected (step 4) |
| a body on a tiled material, not an unwrapped sheet | 0; the mp412c's `black.dds` before step 2 |
| surfaces the design paints that were bound on arrival | 2 of 14 |

These are the output of `tools/sweep.mjs` (step 0). The first version of this
table was the hand sweep's, and two of its rows were wrong in ways the script
showed: the flank misses were counted per region, twice per car, and the
second "no islands" car had 47 panels on its body. A third was wrong in a way
step 1's measurement showed: it listed three cars as painted with tiled
materials, and none of the three is. Two are unwraps shifted off the sheet by
a whole copy of it, and the third mostly is. The fix for that moved those
cars' islands back onto the sheet, and the table is the sweep on that engine,
with step 4's first fix, tags read from each panel's extent, in place, and step
2, so that no body is bound to a sheet without islands.

Every one of these is a case of the tool doing something confidently that it
had the information to doubt. The classifier had the island counts beside it.
The resolver had the confidence in its hand. The tagger had the island's 3D
extent and threw it away for a centroid. This plan is about making each of
those pieces use what it already knows, and about making the number at the top
of this table re-measurable, so that each fix is checked against the same 26
cars rather than against an impression.

The order below is deliberate. The harness comes first because nothing else can
be shown to work without it. The tiled-material case comes second because it is
cheap and the classifier fix depends on it. The two classifier items come before
the tag items because a wrong body binding produces tag misses as a side
effect, and the tag numbers cannot be read until that noise is out of them.

*Last checked against the code on 2026-09-13, at `d16e8a0`. Steps 0 to 3
are done — step 3 by measuring that its floor is not needed — and so are the
shifted-sheet fix step 1 turned up and all of step 4; step 5 is not.*

## 0. A harness that re-runs the sweep

The 25-car sweep was done by hand and lives only in the backlog's prose. It has
to become a script, for the same reason `tools/evaluate.mjs` exists: a number
nobody can re-run is a number that will be quoted after it has stopped being
true.

`tools/sweep.mjs <livery> [--cars <carsDir>] [--every N] [--out sweep.json]`:

- Profiles each car with `profileFromKn5`, no prior, exactly as the sweep did.
- Runs `resolveTargets`, `expandRegions` and `portability` for the design.
- Records, per car: every binding with its confidence and source, every region's
  status from `portability()`, and, for a `no-match`, which single tag removed
  the most panels (see step 4).
- Resumable and keyed by car id, like `survey.mjs`. Committing the output is
  fine: it is statuses and counts, not assets.

Two things it must establish. First, that it reproduces the backlog's figures
on the same sample, or the difference is understood. Second, that it runs
without a model on the machine for cars whose profile already exists, so that
the checked-in profiles are part of the sweep too.

**What it established.** Run on the engine as it stood when the backlog was
written (`1562ef1`), the script reproduces the hand sweep's bindings exactly:
20 confident bodies, 3 shaky, guesses at 0.11 and 0.19, tyres on 24 and brakes
on 22. It differs in two places, both understood. It takes a lone
`_LODA.kn5`, so `pm3dm_bmw_320i_stw` is swept and the sample is 26 cars, not
25. And the hand sweep's "10 of 25" for the flank rules counted regions: the
design has two `[left, visible]` regions, and five cars miss both. On today's
engine the tag rules miss on the same cars, bar one — `ks_ferrari_sf15t` now
has a visible shared panel — and the McLarens' margins fall to 0.04. The shipped
profiles sweep with no model on the machine, and `test/sweep.test.mjs` does so
in CI.

Those three profiles give a baseline that needs no game content. Counting
panels on each car's `body` binding, today:

| car | body panels | `mid` | `[left, visible]` | `[right, visible]` | `[shared, visible]` |
|---|---|---|---|---|---|
| NSX GT3 | 72 | 10 | 16 | 13 | 0 |
| Abarth 500 | 44 | 13 | 6 | 8 | 10 |
| RSS Formula 4 | 39 | 24 | 10 | 10 | 0 |

The fleet fixture in `test/fixtures/fleet-features.json.gz` is the other half
of the harness, and when this plan was first written it was missing the field
step 2 needs. Its per-texture records carried `cover`, `straddles`, `skins`,
`sh`, `box` and `visible`, and none of its 6,526 roles said how many islands
the texture had. `survey.mjs` already wrote that count, as `panels`, into
every role it recorded; the field was lost afterwards, because the fixture was
not the survey's output. It was a packed copy, with shader names interned into
`sh`, made by a script that lived only in the commit that introduced the
fixture. That script had to come into `tools/` so the fixture could be rebuilt
by something in the tree, and it had to carry `panels` and the `uvLayout` from
step 1. Regenerating the fixture was the only step in this plan that needed
the fleet on disk, so it was to be done once, early, and the result committed.

That script is now `tools/pack-fleet.mjs`, and the fixture was regenerated on
2026-09-13 from a fresh survey of 252 cars (two ship no kn5). With visibility
as it now measures, the classifier scores 189/193 on the held-out label. Two of
the four misses are the Evora labels `docs/naming.md` already explains; the
other two are `mclaren_mp412c_gt3` and `tando_buddies_180sx`, which are steps 2
and 1 of this plan. It was packed again from a second survey when step 1
landed, so it carries each texture's `uvLayout` too, and again with the
shifted-sheet fix, which gives 101 cars new island counts or visibility and
leaves only 2 without visibility at all; the classifier still scored 189/193.
It was packed once more when a texture the model names twice became one role,
which turns two ambiguous labels into clean ones: 191/195, with the same four
disagreements. And once more for step 2, when an island repeating across many
sheets stopped crowding real panels out of the threshold: 192/195, with the
mp412c among the right ones.

Three places rebuild classifier features from records instead of from a model:
`survey.mjs` itself, `tools/evaluate.mjs`, which reads the survey's raw output,
and `test/classifier.test.mjs`, which reads the packed fixture. Each maps
fields by hand. The regenerated fixture is not enough on its own: all three
have to pass `panels` through as `islands`, or the accuracy figure step 2
defends will be measured on a classifier that does not ship. One exported
function that turns a record into features, used by both readers, is cheaper
than remembering.

## 1. Say when a texture tiles

**Symptom, as first written.** `tando_buddies_180sx` profiles to 2 panels
from 66 textures, and two other sweep cars to 3 and 7. The profile loads,
validates, and offers a design a sheet with nothing on it. The first draft of
this step put all three down to tiling materials.

**What was measured instead.** Textures are sampled with wrap addressing, so an
unwrap shifted by a whole sheet draws exactly as one that is not. The Avensis
and RX3 bodies are ordinary unwraps one sheet below [0, 1]; the 180SX's sits
60 sheets down and straddles a sheet boundary. What leaves them without panels
is `findIslands` clamping each island into [0, 1], where an island on another
copy of the sheet collapses and is dropped — not tiling. It reaches 316
textures on 45 cars, 13 of them a proposed body, has its own entry in the
backlog, and is fixed by `placeOnSheet` in `src/engine/kn5.mjs`. Genuine tiling exists too: 523 of the fleet's 4,026 measured textures
have less than half their surface on any one copy of the sheet, and one of
them is a proposed body in the sweep, the mp412c's `black.dds`.

**What was built.**

- `src/engine/uvlayout.mjs` measures, per texture and before any island is
  filtered out, the share of its surface on islands no wider or taller than one
  sheet, wherever they sit (`SHEET_SPAN`, 1.05, allowing for edge bleed). The
  constant lives in `src/engine/kn5.mjs`, and `placeOnSheet` and the straddle
  count use the same span, so an island the layout calls one sheet is either
  moved back whole or counted as straddling; three thresholds for the one idea
  had left islands 1.02 to 1.05 sheets wide as unmoved slivers nobody counted.
  `textures[role].uvLayout` is `tiled` below 0.5, `unwrapped` at 0.9 or above
  and `mixed` between; `uvInside` records the share, and `uvTile` the copy of
  the sheet holding most of the surface when that is not [0, 0]. The 0.5 sits in
  the fleet's valley: of 4,026 textures, 3,455 are at 0.9 or above, 468 below
  0.5, and 19 between 0.4 and 0.5. Two measures came first, and each was wrong
  on real bodies. "Inside [0, 1]" would have called 316 whole-copy shifts
  tiled. "On the one copy of the sheet holding most of it", which this step
  first shipped, called the S14 Zenki's livery tiled — an ordinary unwrap
  straddling a sheet boundary — and so refused placement on it; step 2 found
  that. Textures below `minCoverage` are not measured, and an absent
  `uvLayout` means exactly that.
- The generator logs `N of M paintable textures are tiled materials; nothing
  on them can be placed`, a second line in words when the largest texture
  spanning the car is tiled, and a line naming the shifted sheets whose
  islands are not measured yet.
- `resolveTargets` gives a surface on a tiled texture a `tiled` note. The first
  draft put that in `MISSING`, but the surface is painted — a fill or an even
  pattern lands — so it is a caveat, and "asked for and not painted" would be
  false. What is not painted is placed artwork. `expandRegions` first checks
  every region's shape, so a malformed one throws on any texture, tiled or
  not; it then skips any region with `at`, `panel` or `tags` on a tiled
  texture with an `unplaceable` note, which is in `MISSING`. `portability()`
  reports the same region as `unplaceable`, and fitment as an `unmatched`
  finding, so a gate that passes the draft does not pass artwork the build
  skips. The report and the build both ask `placementRefusal`, so the report
  cannot call a region placeable that the build skips. The editor lists it with
  the other misses.
- The panel-level `tiled` flag still has no reader. The first draft refused a
  region on a tiled panel of a mixed texture too. Measured, 10 of the 41 flagged
  panels in the shipped profiles overhang the sheet by 0.01 or less, which is
  rounding on an ordinary unwrap, so refusing on the flag would refuse good
  panels. It wants the span test the texture measure now uses, in place of its
  thousandth of overhang, which is a change to `findIslands` not made here.

**What it established.** `test/uvlayout.test.mjs` gives the synthetic car a
cushion on its own texture. Repeated 40 times across it, the texture is `tiled`
and logged; shifted one sheet, it is `unwrapped` with `uvTile` `[0, -1]`, and
its missing panels are pinned as the known gap; a fill on the tiled texture
paints, and the two regions placed on it are `unplaceable`; the surface's
`tiled` note is a caveat; and `portability()` reports the placed region. In the
sweep, one body is on a tiled material, the mp412c's: its 11 regions placed by
tag now come out `unplaceable`, naming `black.dds`, rather than as selections
that matched nothing, and the surface carries the caveat. The 180SX, the
Avensis and the RX3 come out `mixed`, `unwrapped` and `unwrapped`, with their
shifted sheets named in the log, because tiling was never their problem.

## 2. A texture with no islands cannot be the body

**Symptom.** `mclaren_mp412c_gt3` bound `body` to a role called `black` that
has zero panels, on a car whose interior has 90 and whose rims have 84.
`black.dds` is also a tiled material: a quarter of its surface lies on islands
that fit within a sheet. `ks_mclaren_650_gt3`, the other close call, is not this case: its
pick has 47 panels, and only the margin is thin, which is step 3's business.

**Cause.** `scoreBody` in `src/engine/classify.mjs` weighs area, whether the
texture straddles the centreline, skin overrides, shader, how much of the
car's length and height it spans, and visibility. It never asks whether the
candidate has a paintable island on it. That is the one piece of evidence that
would have settled the mp412c, and it is already known in the function that
calls `propose`: `profileFromKn5` builds `panels` before it proposes bindings,
and `--explain` builds a full profile before it explains.

**What was built.**

- `textureFeatures` gains `islands`, the number of panels on each texture,
  from the caller's profile, and `uvLayout` from its texture entry. The
  generator and `--explain` pass the same profile's panels, and
  `featuresFromRecord` reads both from survey records, so no ranking the tool
  prints can disagree with the one that proposed the binding.
- `excludedWhy` in `classify.mjs` holds the rule, and `scoreBody` returns 0
  when it applies: a texture with no islands is not a candidate. Zero, not a
  penalty: the comment on `VOCABULARY` says "0 excludes", and a sheet nothing
  is mapped onto is not a weaker body candidate. The `minCoverage` gate also
  leaves a texture with no panels, but one under 0.8% of the car's coverage was
  never going to outscore a real body on area.
- **Not** `uvLayout === 'tiled'`, though this step first said so. Measured on
  the fleet it cost two points: it excluded the S14 Zenki's livery and the 992
  Cup's body sheet, whose islands run 1.3 to 1.9 sheets. Every swatch it would
  have caught has no islands and is caught by the rule above.
- The mp412c then showed a second problem underneath. Its paint, `SKIN_00`,
  kept 1 panel of 102, measured 14% visible on that one, and lost to a carbon
  bake: one 111-vertex strip on its chassis, with UVs running 1,222 sheets
  wide, carried 11,123 of the texture's 11,124 units of UV area, and
  `minPanelArea` is a share of that total. Islands spanning more than a sheet
  now stay out of it, which leaves `SKIN_00` 62 panels and changes nothing on a
  texture without such an island.
- Step 1's measure was wrong on the Zenki too, and is now asked per island (see
  step 1), so its livery is placeable again.
- On a car where every texture has no islands, nothing scores, `propose`
  returns null, and `body` is left out of `bind`, which `resolveTargets`
  already reports as `unbound`.
- `explain` prints the island count as a column, and names in words the
  largest textures it excluded and why, so a person reading the ranking sees
  why a large, visible, symmetric texture is not on it.

**What it must establish.** Re-run the survey and `tools/evaluate.mjs` with
islands as an input. The figure to hold is 191/195 as the evaluator counts it on
the fixture regenerated in step 0; the old fixture measured 172/175.
`docs/naming.md` quotes the figure after correcting two wrong labels, and that
number is downstream of this one. It must not fall, and the mp412c must move. Then
`test/classifier.test.mjs` gets a third test: a feature set copied from one of
the two, in which the correct answer is now ranked first. The synthetic
fixture covers the mechanism with a car whose largest, most visible texture
has no islands.

**What it established.** On the sweep no body is bound to a texture without
islands, and the mp412c binds its paint, `SKIN_00`, at 0.82 rather than
`black.dds` at 0.04, so every one of the 26 cars now takes the flank rules and
`[upper, visible]`. 23 bodies are confident, 2 shaky and 1 a guess — the 650
GT3 at 0.04, whose pick is right and whose margin is step 3's business — and
the mean confidence rises from 0.78 to 0.83, because a runner-up with no
islands no longer narrows anyone's margin. Profiled before and after, every
sample profile changes, since `uvInside` now measures the per-island share;
beyond that, panel sets change only on textures carrying an island that spans
more than a sheet, and tags move on a few others, where the new panels shift
the car-wide frame the tagger measures in. The new tests — the exclusion rule
on hand-built features, the mp412c from the fleet fixture, a canopy with no
islands that outscores the synthetic car's body on area, the repeating island
and the straddling unwrap — each fail with the change reverted. On the fleet
fixture the classifier scores 192/195, up from 191, and 175/195 without
visibility. The three it gets wrong are the two Evora labels and the 180SX,
whose label names a LOD texture with no islands while the pick is the paint
nine skins override — the label, most likely, again.

## 3. A guess below a floor is not painted — measured, and not needed

**Symptom.** `resolveTargets` files an `unconfirmed` note for an `auto`
binding and then paints it. On the two McLarens that put artwork on the
wrong sheet, reported in a note nobody reads before looking at the car.

**Cause.** `binding()` returns `confidence` and the resolver reads it only to
format the note. There is no status between `bound` and `unbound`.

**What the number is.** `confidence` is the winner's margin over the
runner-up, normalised. `rank` says in as many words that it is not a
probability of being right. So the floor is a statement about separation: it
catches a close call, and it cannot catch a candidate that wins alone and is
wrong, because a field of one scores 1. Removing the wrong lone candidates is
step 2's job, which is one more reason it comes first.

**The plan, as first written.** An `uncertain` status for an `auto` binding
below a floor, treated like `unbound`: nothing painted, a note naming the term,
the role it would have picked, its confidence and the `--explain` command that
settles it, reported by the build and by `portability()`. A human binding never
subject to it. And the floor measured, not picked: the highest confidence at
which a proposal was wrong, from a table the evaluator would gain, with the
trade stated if it also refused right answers.

**What the measurement said.** `tools/evaluate.mjs` now prints that table, and
after steps 1 and 2 it leaves nothing for a floor to catch. The body is wrong
on no labelled car at low confidence. The proposals it is least sure of are the
BAC Mono at 0.03, the 650 GT3 at 0.04 and the McLaren P1 at 0.10, and all three
are right. A floor at 0.05 or 0.1 would refuse two right bodies and nothing
else; at 0.2, three. The one car the label disagrees with, the 180SX, it
disagrees with at 0.8, and there the label names a LOD texture with no islands.
The wrong low-confidence picks this step was written against were the mp412c's,
and step 2 removed them. So no floor is set: by the step's own rule there is
none to set, and one set anyway would only refuse correct bindings.

The table found a different problem. `tyres` was wrong on 11 of 176 labelled
cars, all at 0.45 to 0.58, and all the same case: a car with two tyre textures,
a tread and a sidewall, where the tread was bound and the sidewall, where the
lettering goes, was not. Every tyre proposal under 0.6 was one of the 17 cars
with two such textures. A floor would have left all 17 unpainted rather than
half-painted. That is not what a floor is for.

**What was built instead.**

- `tyres` and `brakes` bind every texture that only their own shader draws
  (`bindsEvery` and `gate` in `VOCABULARY`), at confidence 1, since no such
  texture is left out. A texture another shader also draws is a swatch shared
  with other parts and stays out: the Morgan's tyres had been bound to a
  `white.dds` its body materials use, and are now bound to its three tyre
  textures. A car with no texture only the shader draws keeps the single best
  candidate. Every car with one candidate binds exactly as before.
- `tools/evaluate.mjs` scores `tyres` and `brakes` against filenames that
  plainly say tyre or tread, disc or rotor, and prints the body's confidence
  table and what floors at 0.05, 0.1 and 0.2 would refuse, so the question can
  be asked again on any survey.
- Not built: `portability()` still reports a term nobody has bound as `absent`,
  the same as one the car confirmably lacks. The plan meant to separate them
  for `uncertain`'s sake; they are worth separating anyway, and that is small.

**What it established.** Tyres now bind every labelled texture on 182 of 184
cars, from 165 of 176 binding the labelled one. Of the two left, the Morgan has
a rear sidewall its tyre materials do not draw, and the 180SX's tyres are not
drawn with the tyre shader at all. Brakes bind every labelled disc on 193 of
202; seven of the nine misses are discs no brake-disc material draws, which no
rule that reads the shader can reach, and are a scoring gap for step 5. The
body is unchanged at 192/195. `test/classifier.test.mjs` holds both terms to
their measured figures across the fleet fixture, and a hand-built case to the
shared-swatch rule; both fail with the change reverted. On the sweep's 26
cars, profiled before and after, only two change, and only in their tyres: the
Avensis binds its tread and its sidewall, and the Morgan its three tyre
textures instead of the shared swatch. The other 24 are byte-identical, and
tyres are proposed at a mean confidence of 1.00, from 0.96.

## 4. Tag selections that match nothing

**Symptom.** `[left, visible]` and `[right, visible]` landed on every car in
the sweep but the mp412c, whose body is a tiled material. What misses is
`mid`: `[left, mid, upper, visible]` matched nothing on 7 cars with a right
body and `[right, mid, upper, visible]` on 6, and on eight of those thirteen
the tag that emptied the selection was `mid`. `[shared, visible]` matched
nothing on 16, 15 of them with a right body. With the first fix below in
place, the `mid` misses fall to 3 and 2.

**Causes.** The mp412c misses every tag rule because its body is a tiled
material, which steps 1 and 2 deal with; its misses say nothing about tagging.
The rest are
cars whose body panels genuinely lack a tag, and there are three ways that
happens in `computeTags`:

- **Section and level are read off the centroid.** `mid` is the band from 0.38
  to 0.62 of the car's length, and a panel is `mid` only if its centroid falls
  in it. A GT3 flank is one island from the A-pillar to the rear arch; its
  centroid lands wherever the unwrapper's vertex density puts it, and on the
  NSX only 10 of 72 body panels are `mid` at all. `upper` and `lower` split at
  half the car's height the same way. The island's `box3d` was computed in
  `findIslands` and not written to the profile, so the tagger, which reads
  only the profile by design, had nothing else to go on.
- **`visible` is a threshold at 0.5.** A low, wide car whose flank curls under
  can score 0.45 and lose the tag while being the most visible thing on the
  car. The number is a fraction of sampled viewpoints, which is not the same
  question as "can a spectator read it". But in the sweep `visible` was the
  tag that emptied a selection on no car at all, so this is a possible cause
  with no case behind it yet.
- **`shared` is a fact about instancing, not a side.** The portable design uses
  it as a third side, to catch a road car whose flanks are mirrored onto the
  same texels. On a car with no instanced bodywork it matches nothing, which is
  correct and is reported as a miss, which is not. Of the three shipped cars,
  only the Abarth has any.

**Fix, in the order the causes rank.**

- **Write `extent3d` into the profile** from `box3d`, and assign section and
  level tags by overlap rather than centroid. *Done.* A panel reaches a band
  when it overlaps it by a quarter of its own span or by half the band's,
  thresholds taken from the doors that missed and the panels that must not
  claim `mid` (see `tags.mjs`), and it keeps its centroid's tags too. A panel
  spanning 0.20 to 0.80 of the car's length is `front`, `mid` and `rear`; a
  design asking for `mid` gets it. Where a selection keeps only its biggest
  matches (`limit`), a panel whose centroid is in the section comes before one
  that only reaches it, so reach fills a selection without moving a pick that
  was already made. The centroid stays for `left`, `right` and `centre`, where it is the
  right measure, since a flank does not straddle the centreline and a bonnet
  does. `extent3d` comes from the model, so `tagProfile` on an existing
  profile cannot invent it: a panel without it keeps its centroid tags, the way
  a panel without `centroid3d` already gets only the tags that need no
  geometry. The shipped profiles change only when they are regenerated from
  their models, and the regeneration keeps everything
  `src/engine/preserve.mjs` protects.
- **Check that retagging moves nothing that was fitted.** *Done, as
  `test/fitpicks.test.mjs`.* This is the riskiest
  part of the step, and the plan's first draft said CI would catch it. It
  would not. CI builds `neon-grid-any` on the RSS and the Abarth and compares
  the output filenames; artwork can move to another panel and the check still
  passes. The fits are where it matters. `neon-grid-any@abarth500.json`
  overrode `team-left` with an `at` and no `panel`, so that placement rode on
  whichever panel `[left, mid, visible]` with `limit: 1` picked, and a retag
  that picked a different one would move the name somewhere nobody chose while
  the fit still read perfectly well — the failure the note on `at` in
  `AGENTS.md` describes. So step 4 lands with a test over the three shipped
  profiles and both fits that records which panel every tag-selected region
  resolves to, written before the tagging changes. Where a pick changes, the
  fit gets an explicit `panel` or is re-fitted by eye; it is never left to
  drift. That test could not see the change it guards, because no shipped
  profile carries `extent3d` until it is regenerated, and regenerating the
  Abarth did move `team-left` and `team-right` to the rear quarters. So the
  shipped fits now name the panel of every placement on a `limit` selection, a
  test requires that of every fit, and `limit` ranks a panel centred in the
  section before one that only reaches it.
- **Give every miss its near-miss explanation.** *Done, as `missExplanation`
  in `src/profile.mjs`.* The sweep already records
  one for each `no-match`, from `nearMiss` in `src/profile.mjs`: how many
  panels carry each tag alone, how many match with each tag dropped, and which
  tag emptied the selection, or every tag tied for it. That is how the sweep
  knows it was `mid` and not
  `visible`. Put the same line in the `no-match` note text and in the
  portability report, whose `why` today says only that no panel carries the
  tags, because a person hitting this on a car of their own needs the same
  answer. Leave the visibility threshold alone until a sweep shows `visible`
  emptying a selection, and then re-measure it on those cars rather than
  nudging it.
- **Let a region say a miss is expected.** *Done.* `optional: true` on a region turns
  its `no-match` from a reported skip in the build into a silent one. The
  portable example's `[shared, visible]` rule is exactly this: it exists for
  cars that have instanced flanks and should say nothing on cars that do not.
  The portability report still lists it, as an expected miss rather than a
  `missing`, because that report is where a person goes to see everything the
  design will and will not do on a car. `Nothing may fail silently` is
  preserved because the design has said, in the file, that this one may.
- **Do not add OR to tag matching.** It was considered, as `[['left',
  'shared'], 'visible']`. It would let the left rule also paint a shared panel,
  and the right rule would then paint it again, stacking the artwork the way
  `rectGroups` exists to prevent. Three rules with the third marked optional
  is the honest shape.

**What it must establish.** The synthetic fixture gets an island spanning two
sections; the tag test asserts it carries both. The picks test above passes,
or every change it reports is resolved in the fit. The sweep's `mid` miss
counts on cars with a right body, 7 and 6 today, are recorded before and after,
alongside the shipped profiles' baseline from step 0, and the backlog entry is
rewritten with the new numbers rather than deleted.

**What it established.** `test/fitpicks.test.mjs` pins where
the portable design lands on the three shipped profiles and passes unchanged,
since none of them carries `extent3d` until it is regenerated. The tag tests
give a flank running 0.2 to 0.8 of the car every section it reaches and both
levels, leave a panel clipping a fifth of the way into `mid` in `rear`, and
give the synthetic car's full-length side face all five sections. On the
sweep the `mid` misses on cars with a right body fall from 7 and 6 to 3 and 2:
the Exige, the Quattro, the 650 GT3 and the RX3 now match. What is left is the
906, whose visible mid-length flank is wholly below the midline; the Lotus 49,
which has no visible side panel in the middle of the car; and the Morgan's
left side, with two panels on it. No other rule's count moved.

A miss now says which tag emptied it, in the build's note and in the
portability report alike: "Dropping `mid` would match 5 (left 14, mid 0, upper
9, visible 23)", followed by the texture's own tags, which is what someone
guessing at the vocabulary needs. And a region may say `optional: true`. Its
miss is noted under its own status, which the build does not print, fitment
does not turn into a finding, and the portability report and the editor list
as expected rather than as `missing`; it must be a boolean, is refused on a
region that does not select by tags, and a fit or the
editor that pins the region to a panel drops it, since there is no selection
left to miss. The portable example's `[shared, visible]` rule is the first
user, and on the sweep it now reads "found nothing on 16 of 26, as its design
allows" rather than as 16 misses; every other figure is as step 3 left it.

## 5. Binding more of the vocabulary

**Symptom.** The vocabulary has 20 terms, and three of them have a scoring
rule: `body`, `tyres` and `brakes`. `neon-grid-any` paints 14 terms, and
`brakes` is not one of them, so on arrival it found two surfaces bound.
`rims`, `interior`, `belts`, `steeringWheel`, `wing`, `metalTrim`,
`heatShield`, `helmet`, `suit`, `gloves`, `crew` and `numberPlate` came back
unbound on every car, so everything past the body and the tyres is a per-car
`--explain` and a human confirmation, twelve times per car.

**Two halves, and the second is the cheaper one.**

**Scoring the regular terms.** Two of them are highly patterned across the
fleet and have measurements already in the profile:

- `rims`: the texture whose islands `measureWheels` places at the wheel
  centres AC requires every car to name, that face along the axle, that are
  not tyre parts, and whose shader is neither `ksTyres` nor `ksBrakeDisc`.
  `computeTags` already keeps the `wheel` measurement on rim and disc panels
  for this reason. Four instances sharing one rectangle is the confirming
  signal; the Abarth's `rims` has 64 panels for that reason.
- `interior`: large area, straddles, low trackside visibility, high cockpit
  visibility, and a box centred inside the car's own. `visibleFromCockpit` is
  the decisive term here the way `visible` is for the body, and it is only
  measured when a steering wheel is found, so the score has to say when it is
  missing the way `explain` already does for visibility.

Both go in with a `score` in `VOCABULARY`, neither goes in `VALIDATED` until
`tools/evaluate.mjs` has a held-out label for them. The label for `rims` can be
the same shape as the body's: filenames that unambiguously say `rim` or
`wheel`, which the scorer never sees. `interior` is harder to label from names
and may have to be validated on fewer cars; say how many.

`helmet`, `suit`, `gloves` and `crew` are not in the car's model at all. They
are the shared driver and crew kn5s, and the only evidence a car has about
them is which files its skins ship. The files are AC's own with fixed
spellings rather than a modder's choice, so for these four a name is
acceptable evidence. But the evidence is the fixed spelling, not a pattern:
`guessRole` in `scan.mjs` also calls anything with `driver` in it a suit and
anything with `pit` in it crew, which is fine for naming a role and too loose
to bind one. Match the exact filenames and propose them from the skins scan at
`source: "auto"`. Their `confidence` cannot be a margin, because nothing was
ranked. Record the binding as named, not measured, in a field of its own, and
let the resolver state that in its note rather than print a made-up number
beside measured ones. Step 3 found no floor to compare it with in any case.

`wing`, `floor`, `metalTrim`, `heatShield`, `belts`, `steeringWheel`,
`numberPlate`, `glass`, `mirror`, `seat` and `wheelLogo` stay human. Nothing
measured separates a wing from a bumper on every car, and a scoring rule that
is right on open-wheelers and wrong on road cars is worse than none.

**Confirming in one pass instead of twelve.** This is where the thirty-second
job actually goes.

- `liverykit --explain <kn5> --all` prints every scorable term with its top
  candidates and evidence, then a ready-to-paste `bind` block with every entry
  at `source: "auto"`. A person reads it, changes the ones that are wrong,
  flips `auto` to `human` on the ones they looked at, and pastes it once. The
  tool still never writes `human`.
- In the editor, a **Bindings** panel that lists each term with its proposal,
  highlights the candidate texture's meshes on the car when a row is hovered,
  and has one **Confirm** button per row that writes `source: "human"` to the
  profile. A person clicking after seeing the part lit up on the car is the
  human confirmation the field was designed to record. This is the one route
  by which the tool writes `human`, and it is a click on a picture, which is
  the whole distinction `docs/mcp.md` draws. The MCP still may not.
  The Confirm has to be its own server route, reachable only from the button.
  `applyProposalDiff` in `src/ui/ops.js` refuses any proposal that contains
  `source: "human"`, and the MCP tools refuse it too. Both refusals stay: if
  Confirm went through the proposal path, the refusal would have to be relaxed
  for it, and an agent's proposal would then be one string away from the same
  write.

**Built, the one-pass half.** `--explain --all` prints the three scored terms'
rankings, names the seventeen that are bound by hand, and ends with the `bind`
block. The block comes from `proposeAll` in `classify.mjs`, the function the
generator now calls too, so what a person pastes is what a regeneration would
have written; a test checks that against the generator on the fixture car, and
against the old per-term loop on every car in the fleet fixture.

The editor's Bindings panel lists every bound term, with its files and what
stands behind it: the confidence, "close call" under 0.2, "unmeasured rule" for
a scorer not in `VALIDATED`. It names the unbound terms in one line, so the
list does not pass for the whole vocabulary. Hovering a row in the whole-car or
cockpit view darkens every part not wearing that term's textures, by a
per-group `dim` uniform. A term whose files are on no part of the model, a
helmet say, is said in the status line rather than drawn as a car gone dark.
Confirm posts to `/api/bindings/confirm`. Four things the text above did not
say, each because the first version without it could have lost work:

- The route re-reads the profile from disk rather than writing back the copy
  the editor loaded, and refuses (409) unless the file still binds the term to
  the roles the person was shown.
- Only `source` changes. The file is validated and then written beside itself
  and renamed over, so a failed write leaves the old profile.
- Confirmations are queued, so two clicks cannot each write a file the other
  has not seen.
- "Reachable only from the button" is an Origin check: a browser sets the
  header itself, and the MCP client and scripts send none. A local process
  forging it could get through, and could equally write the file itself.

The route answers 409 when the editor was started without a profile file, and
the panel then offers no button and says why. The proposal refusal is
unchanged, and a test checks it still refuses with the route in place, and
that a regeneration's merge keeps what the route wrote. Removing the Origin
check, the roles check or the proposal refusal each fails its test.

Not measured: the timed sitting. Only a person confirming a fresh car can
measure that.

**What it must establish.** For `rims` and `interior`, an accuracy figure on a
held-out label, recorded in `docs/naming.md` beside the body's. For the
one-pass confirmation, that a fresh car goes from an unbound profile to a
fully human-confirmed one in one sitting, timed, and that regenerating the
profile afterwards keeps every confirmation, which `preserve.test.mjs` already
checks for the field and should now check for the route. And a test that a
proposal carrying `source: "human"` is still refused after the Confirm route
exists.

## What this does not do

It does not make a portable design place text well. After all of the above a
number still sits centred in the biggest matching panel and hopes, because
nothing here measures which part of a panel is flat. That is the next plan,
not this one; see `docs/roadmap.md`.

It does not change the fit format or the checker, and the design format gains
one field, `optional` on a region, that no existing design needs. The sweep
said those held, and nothing in the table at the top is about them. Step 4 may
edit the shipped fits, but that is data, not format.

## Shape of the work

**0. Harness.** `tools/sweep.mjs`, the fixture's packing script brought into
the tree, `panels` and `uvLayout` carried into a regenerated fleet fixture, and
one feature reader shared by the evaluator and the classifier test. Needs the
fleet on disk once.

**1. Tiled materials.** `uvLayout` per texture, measured per island before the
island filter, `uvTile` for a shifted sheet, the log lines, the `tiled` caveat
and `unplaceable` notes, placement refused and fill allowed. Synthetic fixture
case.

**2. Islands as a classifier input.** `islands` and `uvLayout` in
`textureFeatures` at every call site, zero score without islands, repeating
islands out of the panel threshold, the column in `explain`. Fleet accuracy
re-measured; the mp412c as a regression test.

**3. The confidence floor, measured.** The evaluator's confidence table and its
labels for `tyres` and `brakes`; no floor, since the table shows none is
justified; `tyres` and `brakes` binding every texture only their own shader
draws, which is what the table showed was wrong instead.

**4. Tags.** `extent3d` in the profile, overlap-based section and level, a
test pinning which panel every fitted region resolves to, nearest-miss
explanation in every `no-match`, `optional` on regions, the portable example
updated. Sweep before and after.

**5. Vocabulary.** `rims` and `interior` scored and validated, driver kit
proposed from exact skin filenames, `--explain --all`, the editor's Bindings
panel on a route of its own. The last two are in, first, as the paragraph
below said they should be.

Steps 1 through 4 are each a day or two, and they run in order: step 2 reads
step 1's `uvLayout`, and step 3's measurement meant something only once step 2
had removed the no-island cases. Step 5's second half, the one-pass confirmation, depends
on none of them, and is worth doing before its first half, because it makes
every car cheap to bind by hand whether or not the scorers arrive.
