# Plan: a binding layer between livery vocabulary and car-specific names

## The idea

A livery should say `body` and mean it. What `body` resolves to — `Skin_00.dds`,
`paint.dds`, `LIVERY2.dds`, `SkinBase_DEFAULT.dds`, `chassis_A_D2.dds` — is a
property of the car, not of the design. So put a **binding** between them: the
livery names surfaces from a fixed vocabulary, and each car profile carries a
table saying which of its textures and panels each vocabulary term refers to.

That table should be proposed automatically and confirmed by a human, because the
measurements now say automatic proposal is very good and that "very good" is not
the same as "trustworthy without looking".

## What the fleet says

235 cars profiled straight from their models: 8,569 textures, 93,494 UV islands,
3,568 stock skins read for cross-reference. Reproduce with
`node tools/survey.mjs cars --all` (resumable; add `--visibility` for the slow,
decisive half).

Names are not a shared vocabulary and never were. The generated role names come
to **1,912 distinct names across 235 cars, 1,082 of them appearing on exactly one
car**. A role called `body` exists on 86 of 235. Ninety cars have no mesh named in
a way that reveals which end is the front. Only sixteen names appear on more than
half the fleet, and they are the incidental ones — `rims`, `glass`, `interior`,
`crew`, `mirror`, `belts`, `tyres`, plus numbered variants. Not one of them is the
paint.

Worse than absent, names are actively misleading: **1,133 of the 8,569 textures
that look paintable are bound to no mesh at all**. `metal_detail.dds` ships in
nearly every road-car skin and on several of those cars paints nothing. Anything
that trusts a filename inherits that.

## The classifier, and how well it actually works

Four measurements, none of which is a name:

*Area covered*, as a fraction of the car's total surface — square metres, not
vertices. Vertex count ranks a cockpit occlusion map above the paint on nearly
every car, because interiors are the densest geometry on a car and bodywork among
the sparsest.

*Whether the geometry straddles the centreline*, which separates bodywork from a
single corner part.

*How many stock skins override the file*, which is the author stating outright
that this surface is meant to vary per livery.

*The material shader*, since `ksPerPixelMultiMap_damage_dirt` is a body panel in
all but name, and `ksTyres` and `ksBrakeDisc` are disqualifying.

Scored together against a held-out label — the 175 cars where the *filename* is
unambiguous, which the classifier never sees — this picks the right body surface
on **158/175, 90%**. The failures are a coherent group: interior occlusion maps,
engine bays and undertrays, all of them large, symmetric, and invisible.

Adding ray-cast trackside visibility as a fifth term takes it to **172/175,
98.3%**, and two of the three remaining "failures" are the label being wrong
rather than the classifier. On the Evora GTE the classifier picks `Carpaint_D.dds`
— overridden by all seven stock skins, 80% visible — over the labelled
`Skin_soft.dds`, which no skin overrides and which is 0.2% visible. Counting those
correctly, it is **174/175**. The single genuine miss is a drift mod with PNG
textures where visibility didn't run.

Visibility costs about four seconds per car. It is worth every one of them, and it
already exists in `src/engine/visibility.mjs`.

## Design

### The vocabulary

Small, fixed, and versioned in the repo. Roughly: `body`, `wing`, `floor`,
`rims`, `tyres`, `brakes`, `glass`, `mirror`, `interior`, `seat`, `belts`,
`steeringWheel`, `wheelLogo`, `helmet`, `suit`, `gloves`, `crew`, `numberPlate`,
`heatShield`, `metalTrim`. Every term needs a one-line definition that a person
can check against a render, because a vocabulary whose terms are only defined by
what the classifier happens to pick is not a vocabulary.

Terms are **not** required to exist. A Formula car has no `numberPlate` and a
Transit has no `wing`; a livery targeting a missing term is a no-op that gets
reported, not an error.

The vocabulary is also **closed**: a profile binding a term outside it is
rejected. If any profile can invent a term then no livery can rely on one, and
the layer buys nothing. Terms the classifier cannot yet score — most of them —
are still perfectly valid targets for a human binding; the vocabulary is the
contract a livery writes against, and it should not be limited to whatever a
classifier currently happens to be good at.

### The binding, in the car profile

A new top-level `bind` block. Values reference roles that already exist in
`textures`, so nothing about the current profile format has to change:

```jsonc
"bind": {
  "body":        { "roles": ["body", "bodyRear"], "source": "human" },
  "belts":       { "roles": ["belts_2"], "confidence": 0.71, "source": "auto" },
  "numberPlate": { "roles": [], "source": "human" }
}
```

`source: "auto"` means the classifier proposed it and nobody looked. `"human"`
means someone confirmed it, and regeneration must never overwrite it — the same
guarantee `aliases` already has.

Two details changed during implementation. `roles` is a **list**: the RSS4
carries its bodywork across two chassis textures at 25% and 17% of the car's
surface, and a one-role binding would silently paint half the car. And absence is
an **empty array** rather than `null`, so there is exactly one shape to parse;
`{ "roles": [], "source": "human" }` is someone stating that this car has no
numberplate, which is a different thing from the term being missing because
nobody got round to it. The classifier is not allowed to make that claim — a term
it cannot find a candidate for is simply left out.

### Panel tags

Below the texture level the existing geometric naming is already portable —
`side_section_level` is derived from measurement and means the same thing on a
Lotus 49 and a Transit. Promote it from a name into a tag set on each panel:
side (`left`/`right`/`centre`), section (`nose`…`tail`), level (`upper`/`lower`),
plus `visible` and `cockpit` from the visibility pass, and `mirrored` where a
mirror pair was found.

A livery then addresses `body @ flank + left + upper` and gets whatever the car
actually has there, or nothing, reported.

### Resolution and reporting

Two blocks, one meaning each, rather than one block with precedence rules.
`paint` stays keyed by this car's own texture roles — exact, not portable, and
untouched. A new `surfaces` block is keyed by vocabulary terms and resolves
through `bind`.

Precedence was the tempting design and it is wrong. On the RSS4 `body` is both a
vocabulary term bound to two chassis textures AND a literal role naming one of
them, so a livery painting `body` and `bodyRear` differently would suddenly
render the same artwork on both. Splitting the blocks means no existing livery
can shift underfoot. Every term that resolves to nothing is collected and
printed at the end of a build as a summary — *this design asked for six surfaces,
this car provided four* — because the failure mode this project keeps rediscovering
is that painting nothing looks exactly like painting something, silently.

### The part-versus-panel problem

Unresolved and worth stating. `Rim500.DDS` on the Abarth is shared by all four
wheels: 64 panels at identical rectangles, four different 3D positions. You cannot
paint the left front differently from the right rear, because to the texture they
are one surface. Any vocabulary that assumes one panel is one part is wrong on
every car with symmetric wheels. The binding layer should carry an explicit
`shared: 4` marker so a livery can at least be told, rather than discovering it
in-game.

## Phases

**One — measure and propose.** *(done — `src/engine/classify.mjs`, `--explain`,
`tools/evaluate.mjs`.)* Move the scoring out of `tools/survey.mjs` and into
`src/engine/classify.mjs` as a real module, emitting ranked candidates with their
evidence rather than a single answer. Add `liverykit --explain <car>` to print the
ranking. This is the piece with the strongest evidence behind it and it changes
nothing downstream.

**Two — the format.** *(done — `bind` in the profile schema, `binding()` and
`mergeBindings()` in `src/profile.mjs`, RSS4 bound with 20 human-confirmed
entries.)* Add `bind` to the profile schema, teach `profileFromKn5` to
populate it from the classifier at `source: "auto"`, and make regeneration
preserve anything marked `"human"`. Add a schema test the way the existing
integrity tests work.

**Three — the resolver.** *(done — `resolveTargets` in `src/profile.mjs`, a
`surfaces` block in liveries, unresolved terms reported at the end of a build.
Six of neon-grid's surfaces now go through the vocabulary and all 23 output
files are byte-identical.)* Vocabulary constants, resolution order, graceful
degradation, and the end-of-build report of unresolved terms. Port `neon-grid` to
the vocabulary and confirm the output is byte-identical to today's, which is the
only honest proof that the layer changed nothing it shouldn't have.

**Four — panel tags.** Tags on panels, tag-based targeting in liveries, `shared`
markers for multi-part textures.

**Five — regression.** `tools/survey.mjs` becomes the harness: run the classifier
over all 235 cars and assert the accuracy figure doesn't drop. That number is the
thing to defend, and right now it is 174/175 on the labelled subset.

## Known gaps, recorded so they don't get rediscovered

Three cars fail the kn5 parse outright — `ddm_honda_s2000_ap2`,
`dthwsh_nissan_180sx_gpsports`, `gue_porsche_911_gt3_cup_992` — each stopping
roughly halfway through the file. All three are mods, so this is likely a node
layout the reader hasn't seen. The parser refuses rather than half-parsing, which
is the correct behaviour, but a format this common in the mod scene is worth
supporting.

Two cars ship no kn5 at all in this install and were skipped.

Ninety of 235 cars have low-confidence axes. The classifier doesn't currently
depend on front/rear, but panel section tags do, so phase four needs a better
axis estimate than mesh names — probably from the wheel positions, which are
findable geometrically.
