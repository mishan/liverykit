# Plan: closing the portability gap

## The problem

`docs/backlog.md` opens with a measurement: `neon-grid-any` resolved against 26
cars it had never seen, profiled from scratch with no hand-work. The format
held, the fit machinery held, and the fitment checker reported nothing fatal.
What did not hold was the part that decides *where* a portable design lands:

| what went wrong | on how many of 26 |
|---|---|
| body bound to a texture with no UV islands at all | 1 (`mclaren_mp412c_gt3`, confidence 0.04), and the 3 tiled cars |
| body bound confidently to the wrong texture | 1 (`ac_legends_gt_porsche_906`, 0.88; see the backlog) |
| an `auto` binding painted with the same conviction at 0.04 as at 0.97 | every car with an auto body |
| `[left, visible]` or `[right, visible]` matched no panel | 5 each, every one a car with a wrong body |
| a `mid` selection matched nothing on a car with a right body | 5 |
| `[shared, visible]` matched no panel | 18 |
| a car whose paint is a tiled material, not an unwrapped sheet | 3 |
| surfaces the design paints that were bound on arrival | 2 of 14 |

These are the output of `tools/sweep.mjs` (step 0). The first version of this
table was the hand sweep's, and two of its rows were wrong in ways the script
showed: the flank misses were counted per region, twice per car, and the
second "no islands" car had 47 panels on its body.

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

*Last checked against the code on 2026-09-13, at `d16e8a0`. Step 0 is built;
steps 1 to 5 are not.*

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
of the harness, and it is missing the field step 2 needs. Its per-texture
records carry `cover`, `straddles`, `skins`, `sh`, `box` and `visible`, and
none of its 6,526 roles says how many islands the texture has. `survey.mjs`
already writes that count, as `panels`, into every role it records; the field
is lost afterwards, because the fixture is not the survey's output. It is a
packed copy, with shader names interned into `sh`, made by a script that lives
only in the commit that introduced the fixture. That script has to come into
`tools/` so the fixture can be rebuilt by something in the tree, and it has to
carry `panels` and the `uvLayout` from step 1. Regenerating the fixture is the
only step in this plan that needs the fleet on disk, so it should be done once,
early, and the result committed.

That script is now `tools/pack-fleet.mjs`, and the fixture was regenerated on
2026-09-13 from a fresh survey of 252 cars (two ship no kn5). With visibility
as it now measures, the classifier scores 189/193 on the held-out label. Two of
the four misses are the Evora labels `docs/naming.md` already explains; the
other two are `mclaren_mp412c_gt3` and `tando_buddies_180sx`, which are steps 2
and 1 of this plan. `uvLayout` does not exist yet, so the fixture is packed
again when step 1 lands; the survey takes a quarter of an hour.

Three places rebuild classifier features from records instead of from a model:
`survey.mjs` itself, `tools/evaluate.mjs`, which reads the survey's raw output,
and `test/classifier.test.mjs`, which reads the packed fixture. Each maps
fields by hand. The regenerated fixture is not enough on its own: all three
have to pass `panels` through as `islands`, or the accuracy figure step 2
defends will be measured on a classifier that does not ship. One exported
function that turns a record into features, used by both readers, is cheaper
than remembering.

## 1. Say when a car cannot be painted this way

**Symptom.** `tando_buddies_180sx` profiles to 2 panels from 66 textures. The
profile loads, validates, and offers a design a sheet with nothing on it.

**Cause.** The paint is a tiling material: UVs run to v = -59 and u = ±32000.
`findIslands` marks an island `tiled` when its bounds leave [0, 1] by more than
a thousandth and clamps its rect, and the generator copies that onto the panel
as `tiled` with the raw `uvBounds`. Nothing reads either field. And on the
three sweep cars the islands mostly do not survive the pass at all: what
reaches the profile is a texture with few or no panels, which reads exactly
like one that was never decomposed. A texture-level answer therefore cannot
be derived from the panels that were kept; it has to be measured from the
triangles.

**Fix.**

- In `profileFromKn5`, in the island pass, classify each decomposed texture's
  layout: `unwrapped` if the UV area inside [0, 1] carries most of its
  triangles, `tiled` if most of its UV extent lies outside, `mixed` otherwise.
  Write it as `textures[role].uvLayout`. Measure it over the texture's
  triangles before `minPanelArea` filters islands out, since on these cars the
  filter is what leaves nothing behind. Textures below `minCoverage` never
  reach the island pass, so for them the field is absent, meaning "not
  measured", and nothing may read an absent `uvLayout` as `unwrapped`.
- Log it as one line per car: `N of M paintable textures are tiled materials;
  nothing on them can be placed.` A car whose largest visible straddling
  texture is tiled gets a second line saying so in plain words, because that is
  the car that cannot wear a skin made this way, and finding that out should
  cost a line of output rather than an afternoon.
- In `resolveTargets`, a term bound to a texture whose `uvLayout` is `tiled`
  is a new note status, `tiled`, in the `MISSING` set in `build.mjs`, with text
  that names the file and says why placement is meaningless there. Painting it
  is still allowed: a flat colour or an even pattern on a tiled material is a
  perfectly good livery. Only placement is refused, so `expandRegions` skips
  any region with `at`, `panel` or `tags` on such a texture and says which.
  The panel-level `tiled` flag gets its first reader in the same place: a
  region placed on a tiled panel of a `mixed` texture is refused and reported
  the same way.

**What it must establish.** The synthetic fixture gains a mesh whose UVs run
0 to 40. The profile that comes out says `tiled` on that texture, the log line
appears with the right count, a flat fill on it builds, and a tagged region on
it is reported and skipped. The three sweep cars then come out of the sweep
with a `tiled` note instead of a design that painted nothing and said it did.

## 2. A texture with no islands cannot be the body

**Symptom.** `mclaren_mp412c_gt3` bound `body` to a role called `black` that
has zero panels, on a car whose interior has 90 and whose rims have 84.
`ks_mclaren_650_gt3` came out at confidence 0.11 for the same class of reason.

**Cause.** `scoreBody` in `src/engine/classify.mjs` weighs area, whether the
texture straddles the centreline, skin overrides, shader, how much of the
car's length and height it spans, and visibility. It never asks whether the
candidate has a paintable island on it. That is the one piece of evidence that
would have settled both cars, and it is already known in the function that
calls `propose`: `profileFromKn5` builds `panels` before it proposes bindings,
and `--explain` builds a full profile before it explains.

**Fix.**

- `textureFeatures` gains two fields: `islands`, the number of panels above
  threshold on that texture, and `uvLayout` from step 1. The generator and
  `--explain` both have the profile in hand and pass them from it, so their two
  rankings cannot disagree; the record readers from step 0 pass them from the
  survey's fields.
- `scoreBody` returns 0 for `islands === 0` and for `uvLayout === 'tiled'`.
  Zero, not a penalty: the comment on `VOCABULARY` says "0 excludes", and a
  sheet nothing is mapped onto is not a weaker body candidate, it is not a
  candidate. The `minCoverage` gate in the generator also leaves a texture with
  no panels, but a texture under 0.8% of the car's coverage was never going to
  outscore a real body on area, so the exclusion changes nothing there.
- On a car where every texture is tiled or empty, nothing scores, `propose`
  returns null, and `body` is left out of `bind`. `resolveTargets` already
  reports that as `unbound`. That is the right answer for such a car, and it
  arrives next to step 1's `tiled` line rather than as a mystery.
- `explain` prints the island count as a column, and says `no islands` in
  words next to a candidate it excluded for that reason, so a person reading
  the ranking sees why a large, visible, symmetric texture is not on it.

**What it must establish.** Re-run the survey and `tools/evaluate.mjs` with
islands as an input. The figure to hold is 189/193 as the evaluator counts it on
the fixture regenerated in step 0; the old fixture measured 172/175.
`docs/naming.md` quotes the figure after correcting two wrong labels, and that
number is downstream of this one. It must not fall, and the two McLarens must move. Then
`test/classifier.test.mjs` gets a third test: a feature set copied from one of
the two, in which the correct answer is now ranked first. The synthetic
fixture covers the mechanism with a car whose largest, most visible texture
has no islands.

## 3. A guess below a floor is not painted

**Symptom.** `resolveTargets` files an `unconfirmed` note for an `auto`
binding and then paints it. On the two cars above that put artwork on the
wrong sheet, reported in a note nobody reads before looking at the car.

**Cause.** `binding()` returns `confidence` and the resolver reads it only to
format the note. There is no status between `bound` and `unbound`.

**What the number is.** `confidence` is the winner's margin over the
runner-up, normalised. `rank` says in as many words that it is not a
probability of being right. So the floor is a statement about separation: it
catches a close call, and it cannot catch a candidate that wins alone and is
wrong, because a field of one scores 1. Removing the wrong lone candidates is
step 2's job, which is one more reason it comes first.

**Fix.**

- Add a status, `uncertain`, returned by `binding()` when `source` is `auto`
  and `confidence` is below a floor. `resolveTargets` treats it exactly like
  `unbound`: nothing painted, a note that names the term, the role it would
  have picked, the confidence, and the `--explain` command that confirms or
  corrects it. `build.mjs` adds it to `MISSING`.
- `portability()` reports it as a surface status of its own, so the editor's
  **On another car** panel shows it before anyone builds. That needs a change
  to how `portability()` works out surface statuses. Today it lists every
  surface the design wanted and `resolveTargets` did not return as `absent`,
  so a term the car confirmably lacks and a term nobody has bound already
  read the same, and `uncertain` would join them. It should take the status
  from `resolveTargets`' notes, keeping `absent`, `unbound` and `uncertain`
  apart, since each asks the person for something different.
- A human binding is never subject to the floor. `source: "human"` at any
  confidence paints. That is what the field is for.
- **Where the floor sits is measured, not picked.** `tools/evaluate.mjs` gains a
  table: for every labelled car, the proposal's confidence and whether it was
  right. The floor is the highest confidence at which a proposal was wrong,
  after step 2 has removed the no-island cases, rounded up to two places. If
  that turns out to be a number that also excludes many right answers, say so
  in the doc and choose the trade explicitly; the point is that the number has
  a provenance. The backlog's own guess is that 0.2 is roughly where it lands,
  since `explain` already warns below that, but a guess is what this step
  exists to replace.
- `tyres` and `brakes` are shader-gated and scored 0.95 and 0.96 across the
  sweep. They are not in `VALIDATED`, and this plan does not add them, but the
  floor will apply to them, so the evaluation table has to cover them too.
  Today the evaluator only has a label for `body`. They need one of the same
  kind: filenames that plainly say tyre or disc, which the scorer never sees.

**What it must establish.** A test in `test/integrity.test.mjs` with a
profile whose `body` is `auto` at 0.1: the build reports `body` as uncertain,
paints nothing on it, and the same profile with `source: "human"` paints. A
test on `portability()` that an unbound and an uncertain term come back as
their own statuses, not as `absent`. And the sweep: after steps 2 and 3, no
car in the 25 has artwork on a sheet the classifier was guessing about, and
the count of cars where the body was painted is recorded, so that the cost of
the floor is a number too.

## 4. Tag selections that match nothing

**Symptom.** With the wrong-body cars set aside, `[left, visible]` and
`[right, visible]` landed on every car in the sweep. What misses is `mid`:
`[left, mid, upper, visible]` matched nothing on 5 cars with a right body and
`[right, mid, upper, visible]` on 4, and on six of those nine the tag that
emptied the selection was `mid`. `[shared, visible]` matched nothing on 18, 13
of them with a right body.

**Causes.** The five cars with a wrong body miss every tag rule, and steps 1
to 3 are what fix them; their misses say nothing about tagging. The rest are
cars whose body panels genuinely lack a tag, and there are three ways that
happens in `computeTags`:

- **Section and level are read off the centroid.** `mid` is the band from 0.38
  to 0.62 of the car's length, and a panel is `mid` only if its centroid falls
  in it. A GT3 flank is one island from the A-pillar to the rear arch; its
  centroid lands wherever the unwrapper's vertex density puts it, and on the
  NSX only 10 of 72 body panels are `mid` at all. `upper` and `lower` split at
  half the car's height the same way. The island's `box3d` is computed in
  `findIslands` and never written to the profile, so the tagger, which reads
  only the profile by design, has nothing else to go on.
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
  level tags by overlap rather than centroid. A panel spanning 0.30 to 0.70 of
  the car's length is `front`, `mid` and `rear`; a design asking for `mid` gets
  it. The centroid stays for `left`, `right` and `centre`, where it is the
  right measure, since a flank does not straddle the centreline and a bonnet
  does. `extent3d` comes from the model, so `tagProfile` on an existing
  profile cannot invent it: a panel without it keeps its centroid tags, the way
  a panel without `centroid3d` already gets only the tags that need no
  geometry. The shipped profiles change only when they are regenerated from
  their models, and the regeneration keeps everything
  `src/engine/preserve.mjs` protects.
- **Check that retagging moves nothing that was fitted.** This is the riskiest
  part of the step, and the plan's first draft said CI would catch it. It
  would not. CI builds `neon-grid-any` on the RSS and the Abarth and compares
  the output filenames; artwork can move to another panel and the check still
  passes. The fits are where it matters. `neon-grid-any@abarth500.json`
  overrides `team-left` with an `at` and no `panel`, so that placement rides on
  whichever panel `[left, mid, visible]` with `limit: 1` picks, and a retag
  that picks a different one moves the name somewhere nobody chose while the
  fit still reads perfectly well — the failure the note on `at` in `AGENTS.md`
  describes. So step 4 lands with a test over the three shipped profiles and
  both fits that records which panel every tag-selected region resolves to,
  written before the tagging changes. Where a pick changes, the fit gets an
  explicit `panel` or is re-fitted by eye; it is never left to drift.
- **Give every miss its near-miss explanation.** The sweep already records
  one for each `no-match`, from `nearMiss` in `src/profile.mjs`: how many
  panels carry each tag alone, how many match with each tag dropped, and which
  tag emptied the selection. That is how the sweep knows it was `mid` and not
  `visible`. Put the same line in the `no-match` note text and in the
  portability report, whose `why` today says only that no panel carries the
  tags, because a person hitting this on a car of their own needs the same
  answer. Leave the visibility threshold alone until a sweep shows `visible`
  emptying a selection, and then re-measure it on those cars rather than
  nudging it.
- **Let a region say a miss is expected.** `optional: true` on a region turns
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
counts on cars with a right body, 5 and 4 today, are recorded before and after,
alongside the shipped profiles' baseline from step 0, and the backlog entry is
rewritten with the new numbers rather than deleted.

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
ranked, so the floor from step 3 is the wrong gate for them. Record the
binding as named, not measured, in a field of its own, and let the resolver
state that in its note instead of comparing a made-up number to a measured
one.

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

**1. Tiled materials.** `uvLayout` per texture, measured before the island
filter, the log line, the `tiled` note, placement refused and fill allowed.
Synthetic fixture case.

**2. Islands as a classifier input.** `islands` and `uvLayout` in
`textureFeatures` at every call site, zero score without them, the column in
`explain`. Fleet accuracy re-measured; the two McLarens as a regression test.

**3. The confidence floor.** `uncertain` status, measured floor, evaluation
table with labels for `tyres` and `brakes`, reported in build and, as its own
status, in portability. Integrity test.

**4. Tags.** `extent3d` in the profile, overlap-based section and level, a
test pinning which panel every fitted region resolves to, nearest-miss
explanation in every `no-match`, `optional` on regions, the portable example
updated. Sweep before and after.

**5. Vocabulary.** `rims` and `interior` scored and validated, driver kit
proposed from exact skin filenames, `--explain --all`, the editor's Bindings
panel on a route of its own.

Steps 1 through 4 are each a day or two, and they run in order: step 2 reads
step 1's `uvLayout`, and step 3's floor is measured after step 2 has removed
the no-island cases. Step 5's second half, the one-pass confirmation, depends
on none of them, and is worth doing before its first half, because it makes
every car cheap to bind by hand whether or not the scorers arrive.
