# Plan: authoring a design in the editor

## The problem

The fitting editor can move anything and create nothing. Every region it shows
came from a livery module somebody wrote by hand, and the only thing the editor
can add is a copy of one of them.

That is a strange place to stop. The expensive part of the editor is already
built and already paid for: `renderTexture` produces a whole body texture in a
couple of milliseconds, the browser draws it natively, and the overlay shows the
rectangle the *renderer* resolved rather than the editor's opinion of it. Drawing
a new rectangle and picking a treatment for it is a smaller step than anything
already working. What stops it is not the rendering. It is that there is nowhere
to put the result, and no way for the editor to know what a treatment takes.

## What is design and what is adjustment

A **fit** may not add a region. That rule has held since fits were designed, with
one exception — a copy, which invents no artwork and states only a placement —
and the exception was argued for at length because symmetry is a property of the
car rather than of the design.

A **duplicate** was a harder case, and on reflection the wrong one. `mirrors` was
the first name for that block and it was the better one: a mirrored copy says
*this car has two flanks*, which is a fact about the car. A duplicate says *I
want two badges*, which is a fact about the design, and it slipped in only
because the mechanism was already there. *Step 2 moved it:* Duplicate writes a
design region now, and `copies` means mirroring again.

A new element with its own treatment, its own colours and its own text is not
that either. It is design. It belongs to every car the livery is pointed at, not to the
pair, and putting it in a fit would mean the design looked different depending on
which car you built it for, with no file saying so.

**So authoring writes the LIVERY, and fits stay adjustment-only.** The boundary
does not move. What changes is that the editor can now write on both sides of it,
which makes it much more important that a person can tell which side they are
working on — see [Two modes](#two-modes-not-a-guess).

## Where authored work goes

A livery is `liveries/*.mjs`: an ES module whose default export is plain data.
`neon-grid.mjs` is also commented as a tutorial, and `neon-grid-any.mjs` explains
its own portability decisions inline. Generating those files from the editor
would destroy exactly the part of them that is worth having.

But the data itself is already plain. A region is `{ id, treatment, panel | tags,
at, ...options }` — no functions, no computation. It serialises perfectly.

So: **the editor owns a file, not a file format.**

- A livery may be **`liveries/<name>.json`**, with the same shape as the module's
  default export. The editor round-trips JSON losslessly, and readable diffs come
  free. Two small things in `bin` have to learn about it: `resolveLivery` only
  *finds* a file, so its candidate list gains `<name>.json`, and the load beside
  it branches — `JSON.parse` rather than `import(...).default`. `fitLiveryId`
  strips `.mjs` specifically, so it needs the second extension or a design called
  `my-livery.json` acquires a fit called `my-livery.json@abarth500.json`.
- A livery that wants code may **keep the code and delegate the drawing**:

  ```js
  // Read rather than imported: import attributes postdate this project's Node
  // floor of 20.9, and a livery that only runs on newer Node would be a strange
  // thing to hand somebody.
  const body = JSON.parse(
    readFileSync(new URL('./my-livery.body.json', import.meta.url)));

  export default {
    name: 'My Livery',
    palette: { … },              // still here, still commented
    surfaces: { body },          // this part is the editor's
  };
  ```

- The editor **never writes `.mjs`**. Open it on a module livery and authoring is
  offered read-only: you can place things, see them, and copy the result as JSON
  to paste in yourself. It also offers to convert — write a `.json` beside the
  module with everything serialisable — but that is a decision a person makes
  once, with the comments they are giving up in front of them.

The escape hatch matters more than it looks. A procedural design — regions built
in a loop, coordinates computed — cannot round-trip through JSON, and the editor
must refuse rather than flatten it into two hundred literal rectangles that no
longer mean anything. Refusing loudly is the whole disposition of this project;
this is the same rule one level up.

## Treatments have to describe themselves

This is the real work, and it is the reason authoring has not happened by
accident.

A treatment today is a bare function. It reads whatever it likes off `ctx.opts`,
with defaults inline:

```js
halftone: (r, c) => {
  const cell = c.opts.cell ?? Math.round(r.h / 22);
  const angle = c.opts.angle ?? 0;
  …
```

There are 12 treatments across `core` and `synthwave` and 35 distinct
option keys between them, and **nothing anywhere says what any of them are**. An
authoring UI built on that can offer a rectangle and a free-text JSON box, which
is not authoring, it is a worse text editor.

So a pack may describe its treatments. Optionally, and as data:

```js
definePack('core', treatments, {
  halftone: {
    label: 'Halftone dissolve',
    options: {
      cell:  { type: 'number', min: 2, max: 200, step: 1, hint: 'defaults to h/22' },
      angle: { type: 'number', min: 0, max: 360, step: 15, hint: '0' },
      color: { type: 'color', hint: 'cyan' },
      glow:  { type: 'boolean', hint: 'false' },
    },
  },
  …
});
```

Four things about that, each deliberate:

**It is optional and additive.** A third parameter on `definePack`, which keeps
its existing signature and keeps rejecting non-functions; the pack object grows a
`schemas` field beside `treatments`. Not on `registerPack`, whose second
parameter is already `{ overwrite }`. A pack with no schema still loads,
still builds, and its treatments still appear in the editor — with the raw JSON
box, which is where everyone starts today anyway. Nobody has to fork a pack or
rewrite one to keep using it. `--pack ./my-pack.mjs` is unaffected.

**The build never reads it.** A schema is UI metadata. If it is wrong, the editor
offers a bad slider; it cannot change what gets painted. That keeps a describing
mistake out of the class of bugs this project actually fears.

**Defaults are hints, not values.** The schema says `hint: 'defaults to h/22'`,
and the editor shows that as placeholder text. It does **not** write a value into
the design that the person did not choose. Two reasons: a design file should say
only what it means, and a schema that carried real defaults would be a second
source of truth for them, free to drift from the `?? 22` in the code — silently,
which is the failure mode this codebase is organised against.

**Drift is caught mechanically.** Every `c.opts.X` a pack reads is visible in its
source. A test walks each registered pack's file, collects those reads, and
asserts the schema describes each one. Adding an option without describing it
fails; describing one that does not exist fails. This is the same trick as the
test that checks `app.js` only queries ids `index.html` actually contains, and it
works for the same reason: the two halves are mechanically comparable, so nobody
has to remember.

Types worth having: `string`, `number` (min/max/step), `boolean`, `enum`,
`color`, and `rects` for things like `sparkles`' `avoid`. `color` is the
interesting one — treatments resolve colours through `ctx.color(name)` against
the livery's palette, so the control offers the palette's own names first and a
literal value as the escape. Anything a schema cannot express degrades to JSON
for that field alone, rather than for the whole treatment.

## Two modes, not a guess

Once the editor can write both files, "what does this drag change?" has two
answers, and guessing between them would be the worst possible behaviour.

So it is a mode, stated in the header, and it changes what the editor renders:

| | edits | renders |
|---|---|---|
| **Design** | the livery | the design alone, no fit applied |
| **Fit** | `fits/<livery>@<car>.json` | the design with this car's fit on top |

Design mode ignoring the fit is not a simplification, it is the point. If the fit
pins a region and you drag it in Design mode, the design changes and the picture
does not — the override still wins. You would be authoring against a view that
disagrees with what you are authoring. Rendering the design alone answers the
question Design mode is actually for: *what does every other car see?*

The two are connected by one explicit action. A region carrying a fit override
offers **Promote to design**: take the fitted rectangle, write it into the
livery, and clear the override. That is how a per-car nudge becomes the design's
own opinion once you decide it was right everywhere — and it is a decision, so it
is a button rather than a heuristic.

## Placing something new

Draw a rectangle on the UV sheet or on the car; pick a treatment; it appears. The
render loop already exists, so it appears immediately.

Two decisions the editor should put in front of you rather than choose silently,
because they are the difference between a design that travels and one that does
not:

**Panel or tags.** Drawing inside a panel could mean "on `left_mid`" or "on
whatever this car calls its left flank". The first is exact and pins the design
to this car's names; the second is portable and is the whole thesis of
`surfaces:`. The editor offers both, with the panel's actual tags listed, and
says which it wrote. A design with no `car` field defaults to tags, because it
has already declared what it wants to be.

**Order is paint order.** Regions are an array, later ones paint over earlier
ones, and the emissive layer always composites above the base. The region list
becomes reorderable, because "put the stripe under the numbers" is not an
advanced request and there is currently no way to express it from the editor at
all.

Ids are generated (`text-1`, `stripe-2`) and validated through the existing
`regionIds`, which already refuses duplicates across the whole livery — the same
check a fit relies on to address anything.

## Palette and identity

Both are design-level data, both are small, and both are already keyed by name:
`palette: { accent: '#00F0FF' }` and `identity: { driver: 'A. Driver' }`.

Editing them is a form, and the payoff is out of proportion to the work: changing
`accent` re-renders every region that mentions it, on the car, in about two
milliseconds. Identity tokens are what `{driver}` and `{number}` interpolate to,
so typing a real driver's name shows the actual text metrics — which matters,
because librsvg does no reflow and the `text` treatment estimates advance width
and scales to fit.

Adding a palette entry from the colour control closes the loop: pick a colour for
a region, name it, and it is available to everything else.

The names are the risk, though, and it took building it to see how much. Both a
palette entry and an identity token are referred to BY NAME, and both fail the
same quiet way when the name stops resolving: `ctx.color` is `palette[name] ??
name`, so an unknown colour is handed to the renderer as a literal and
`fill="ghost"` is not an error to librsvg; a `{token}` interpolates through
`tokens[k] ?? ''`, so a missing `number` renders "A. Driver #" and says nothing.

So this is not only a form. Every row shows what refers to it before you touch
it, renaming rewrites those references — regions, `colors` arrays, a surface's
`background`, every `{token}` in every text — and a panel underneath lists the
names the design uses and does not define. Removing that panel is how you would
make the editor able to break a design without saying so.

## What the server needs

The working-fit mechanism already solves this shape of problem, and authoring
needs the same thing for the design.

`POST /api/render` takes a working fit today because the fit lives in the browser
until Save. A working *design* travels the same way, and `POST /api/state` — which
already exists, because a region list computed from the saved fit was wrong the
moment the editor could create regions — takes it too.

- `GET  /api/treatments` — every treatment in the loaded packs, with its schema
  where it has one, and its pack name.
- `POST /api/design` — validate and write. Refuses to write `.mjs`; refuses a
  design that fails `regionIds`; reports the path it wrote, like `/api/fit`.
- `POST /api/render`, `/api/state`, `/api/preview` — accept a working design
  alongside the working fit.

Undo already snapshots the working fit and restores through a state reload. It
extends to the design by snapshotting both: the mechanism does not change, only
what it copies.

## Not silently doing nothing

A newly authored region that matches nothing is the oldest bug in this project
wearing its newest costume. The editor is the one place it can be caught while
the person is still looking:

- tags that match no panel **on this car** — say so beside the region, not only
  in the build summary;
- a treatment name from a pack the livery does not list in `packs` — the region
  will not render at all; offer to add the pack;
- a rectangle whose panel-relative coordinates leave the panel — already
  clamped for drags, and authoring must clamp the same way;
- a colour name absent from the palette — `makeColorResolver` returns
  `palette[name] ?? name`, so a typo is handed to the renderer as though it were
  a literal colour. `fill="accnt"` is not an error to librsvg, it is just not the
  colour you meant. The editor knows the palette and can say so.

## What this does not do

**It does not author treatments.** A treatment is a function that returns SVG,
and it stays code. `--pack` already loads one without forking anything, and the
schema block is how a pack joins the UI. Nothing here tries to make a visual
programming language out of it.

**It does not start new surfaces.** Painting a texture the design does not touch
today means choosing a vocabulary term or a role and knowing what will happen on
a car that lacks it. That is a real feature and a separate one; deliberately out
of scope here.

**It does not make a design portable by watching you.** The editor can point out
that you named a panel, and it can show what your tags select on a second
profile, but a design pinned to one car is a legitimate thing to want and the
tool should not argue.

## Shape of the work

Four steps, each of which is worth having on its own.

**1. Treatments describe themselves.** *Done.* Optional metadata on
`definePack`, exposed through `GET /api/treatments`, plus the drift test that
measures what each treatment reads rather than trusting the description. The
inspector has real controls for the selected region, previewing live, and a
*Copy as JSON* button. No file format decided, nothing written, and the fiddliest
part of authoring — "what does `dot` do?" — is answered.

**2. Data liveries.** *Done.* `liveries/*.json` loads; **Save design**, which
refuses far more than it accepts; add, delete, reorder and edit; and Duplicate
moved out of the fit into the design, leaving `copies` to mean mirroring again.

*The working design already travels with each render — step 1 needed it to
preview an option change, and it is the same mechanism, so step 2 inherits it.*

**3. Palette and identity.** *Done.* The rows, the live re-render, and naming a
colour into the palette from the region that wanted it. It grew one thing the
plan did not anticipate: both are keyed by NAME, and a name that stops resolving
fails silently in both directions — an unknown colour reaches the renderer as a
literal, a token with no value leaves a hole in the middle of a line. So every
row carries a count of what depends on it, renaming rewrites the references
rather than orphaning them, and a panel lists whatever the design refers to and
does not define.

**4. Portability.** *Done.* The panel-or-tags choice, and the second-profile
check.

Two departures from the plan above, both from building it. The choice is a
SWITCH in the inspector rather than a question asked once while placing: the
answer is genuinely revisable — a region drawn exactly where this car needs it
often turns out to belong everywhere, and the reverse happens too — and a
one-shot prompt would have made the commonest change the hardest one. It also
reaches designs that already exist, which a placement-time question cannot.

And the match count is read back from the RENDER rather than computed in the
browser. The editor has each panel's tags and could have counted them itself, at
the cost of a second implementation of `panelsWithTags` — including its
distinct-rectangle rule — free to drift from the one that paints. Switching to
tags re-renders anyway, so the number shown is how many panels the renderer
actually used.

The second-profile check went further than "what a tag selection matches",
because the same walk answers more for nothing: a `panel:` naming an island the
other car lacks, a surface it does not have at all, and a design that cannot be
resolved against it. `src/portability.mjs` asks `resolveTargets` and
`expandRegions` rather than reimplementing them, so a design that reports clean
is one the build will genuinely paint.

The interesting judgement is that an ABSOLUTE rectangle is reported as neither a
pass nor a failure. It resolves on every car, which is exactly why it is the
placement most likely to be quietly wrong on the next one.

The order is deliberate: step 1 is the only one that touches the pack API, and it
ships value with nothing else in place. If the file-format decision in step 2 is
ever revisited, step 1 survives it intact.
