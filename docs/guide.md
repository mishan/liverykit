# Guide

Making a livery, from a car's profile to a skin in the game. The
[README](../README.md) says what liverykit is; the [reference](reference.md) lists
every command and field.

## Making a livery

### 1. Generate a profile for your car

`<carId>` is the folder name under `content/cars/` — `ks_ferrari_488_gt3`,
`tatuusfa1`, and so on.

```sh
node bin/liverykit.mjs --from-kn5 "$AC_ROOT/content/cars/<carId>/<carId>.kn5" \
                       --skins    "$AC_ROOT/content/cars/<carId>/skins" \
                       --car-id   <carId> --out cars/
```

Both paths are into *your* Assetto Corsa install — see
[You supply the game's files](../README.md#you-supply-the-games-files). Nothing here is
found for you: `--from-kn5` and `--explain` take a path and read exactly it.

`--skins` matters. The textures inside a kn5 are the model's own low-resolution
defaults — often 512×512 where the skins ship 2048×2048 — so real sizes are
cross-referenced from a skin folder. The model is authoritative about *layout*,
not about *resolution*.

The car's display name comes from `ui/ui_car.json` beside the model — the name
its author gave it, which is what Content Manager shows. `--car-name` overrides
it, and a name already in the profile survives regeneration.

Panels come out with systematic geometric names (`left_mid`, `centre_nose`).
Give the ones you care about friendlier names in the profile's `aliases` block,
which survives regeneration:

```json
"aliases": { "body": { "flankLeft": "left_mid", "nose": "centre_nose" } }
```

### 2. Start a livery

```sh
cp liveries/neon-grid.mjs liveries/my-livery.mjs
```

Then edit the three fields at the top:

```js
name:   'My Livery',
folder: 'my_livery',        // becomes skins/my_livery/ in the game
car:    'ks_ferrari_488_gt3',   // must match the profile's id
```

### 3. Prove the plumbing before making art

```sh
node bin/liverykit.mjs my-livery --flat
```

Solid color, no artwork. Install it and check the car changes color.

Do this first on every new car. If a filename is wrong the skin still installs
cleanly, logs nothing, and renders the stock car — which looks exactly like "my
livery didn't work" with no clue as to why.

### 4. Make it yours

[`liveries/neon-grid.mjs`](../liveries/neon-grid.mjs) is commented as a tutorial —
palette, identity tokens, panel-relative coordinates and safe areas are all
explained inline. Then:

```sh
node bin/liverykit.mjs my-livery
```

### 5. Nudge it where it sits badly

Coordinates are a slow way to discover you were 3% off. `--ui` opens an editor
that shows the artwork on the texture *and* on the car, and writes what you drag
to a [fit](#the-fitting-editor) rather than to the design:

```sh
node bin/liverykit.mjs my-livery --ui
```

## What the model tells you that a texture can't

Two things in a profile are worth knowing about up front, because both catch
people out and neither is recoverable from the texture alone.

**Which panels touch.** An unwrapper is free to place two panels that meet on the
bodywork at opposite corners of the texture. To a livery they look unrelated; on
the car, a stripe crossing between them has to line up. `adjacent` lists them —
on a typical open-wheeler there are around 190 such pairs, and the front and rear
halves of a single sidepod are routinely separate islands. Paint one and half the
pod stays stock.

**How big a panel is on the car.** Each measured panel records `metresPerUv`,
the world size of one unit of texture along each axis. `anisotropy` says a panel
is 3.9 times wider than tall in texture terms, which is what the renderer needs
to un-stretch a glyph; it cannot say whether that glyph lands 40 mm tall or 400,
because a ratio has no size in it. The editor shows the figure for whatever
region is selected. Profiles generated before this existed say *not measured*
rather than guessing — regenerate with `--from-kn5` to get it.

**Which panels are visible, and from where.** Being inside a UV island doesn't
mean anyone can see it — duct interiors, bulkhead backs and floor undersides are
all ordinary parts of an island. liverykit ray-casts against the whole car,
wheels and wings included, and reports `visible` per panel. On the Tatuus FA01
78 panels are completely unseeable from trackside.

Clicking a part the design does not paint names its texture and offers to take
it into the design — which is how you find out which of the four 1024-square
plate textures a GT3 car ships is the one on the door, without painting each in
turn to see which rectangle changes. It writes `paint.<role>`, addressing the texture
directly, because these surfaces have no binding and usually no panels: a banner
is too small a share of the car to survive the panel threshold. Normal maps and
shader maps are named but not offered, since painting one gives a car that loads
and lights wrongly.

The **Whole car** view shows every texture at once, with your design on the
surfaces it paints and the car's own artwork — read from your kn5, never shipped
— on the ones it does not. So what you are looking at is the car, not a livery
floating on a gray mannequin.

The stock artwork goes to the GPU as compressed blocks with no decoding step,
which means it covers DXT1, DXT3 and DXT5 — the great majority of what a car
ships — and nothing else. A PNG texture, an uncompressed DDS, or a browser
without `WEBGL_compressed_texture_s3tc` stays flat gray, as does an encrypted
car, whose embedded textures are 1×1 placeholders. Gray means *this part is not
yours and could not be shown*, never a guess at what belongs there.

It also reports `visibleFromCockpit`, cast from the driver's eye, and the two
disagree sharply: the flanks score 100% outside and 0% from the seat, the
cockpit's side walls 0% and 62%. If you race in cockpit view, that second number is
the one that matters — and the surfaces you stare at all race are on entirely
separate textures from the bodywork, so an exterior-only livery leaves them
stock. `liveries/neon-grid.mjs` paints them.

## Decals: images a livery brings with it

Everything else a design does is code that emits vectors, which is what lets one
livery render on several cars and read as a diff. A sponsor's logo is not that:
it is somebody else's artwork, it arrives as a file, and the honest thing to do
is put its pixels on the car.

So a livery can be a **folder** instead of a file:

```
liveries/my-livery/
  livery.mjs          the design (livery.json works too)
  decals/
    sponsor.png
    flag.svg
```

Everything in `decals/` is loaded when the livery is opened or built, and a
design addresses one by its name without the extension:

```js
{ id: 'sponsor-left', treatment: 'decal', image: 'sponsor',
  panel: 'flankLeft', at: [0.1, 0.4, 0.6, 0.2] }
```

A decal is an ordinary region, so everything that already works on regions works
on it: `panel` or `tags`, `rotate`, `span`, a fit that moves it per car, and
dragging it in the editor.

| option | what it does |
|---|---|
| `image` | the file's name in `decals/`, without its extension |
| `fit` | `contain` (default), `cover` — filled and clipped to the region — or `stretch` |
| `opacity` | 0 to 1 |
| `glow` | put it in the emissive pass as well, so it lights |

**Aspect ratio is handled for you.** A square of texture does not land square on
the car, and a logo fitted to its own pixel ratio comes out stretched by exactly
the panel's distortion. `contain` and `cover` fit the artwork to the aspect it
should have ON the car, using the panel's measured `anisotropy` — the same
correction the `text` treatment makes. `stretch` is there for when you mean it.

**PNG, JPEG and SVG.** An SVG is rasterized when it is loaded, at 2048 on its
longest side, and never travels as markup: a design is a file people download
from each other and the editor renders the finished sheet as `innerHTML`, so
foreign markup inside it is a way to lose. Its pixels are what reach the car.

**A decal that cannot be placed says so.** An image the livery does not carry, a
region with no `image` at all, a file that is not an image, two files whose names
a design could not tell apart — each is reported by name, in the build's own
report and in the editor, rather than rendering as nothing and looking like a
design that paints nothing there.

Single-file liveries still work exactly as before; they simply have nowhere to
keep images, and a decal in one is told so.

[`liveries/decal-demo/`](../liveries/decal-demo/) is a working example.

## Making a livery that works on more than one car

The problem: cars do not agree on anything. Across a 235-car survey the
generated texture role names came to 1,912 distinct names, 1,082 of which appear
on exactly one car. The bodywork is called `Skin_00.dds` on one model,
`SkinBase_DEFAULT.dds` on another, `paint.dds`, `LIVERY2.dds`, `cobrabody.dds`.
A livery that names files can only ever work on the car it was written against.

So a car profile carries a **binding** from a small fixed vocabulary onto
whatever that car happens to call things:

```jsonc
"bind": {
  "body":        { "roles": ["body", "bodyRear"], "source": "human" },
  "rims":        { "roles": ["rimFace"], "source": "human" },
  "numberPlate": { "roles": [], "source": "human" }   // this car has none
}
```

and a livery paints **surfaces** instead of files:

```js
surfaces: {
  body: {
    background: 'base',
    regions: [
      { treatment: 'traces', lanes: 22, color: 'accent' },
      // Panels are named per car, so select them by what they ARE. This renders
      // once per matching panel — 10 islands on one car, 12 on another.
      { treatment: 'piping', tags: ['left', 'visible'], color: 'accent' },
    ],
  },
}
```

Panels also carry a measured **`textRotation`**: how far the unwrapper laid the
panel from upright. A road car routinely turns a door sideways to pack its
texture sheet — the Abarth's doors measure 270° and 90°, the Tatuus's flanks
180° and 0° — so text placed without compensating reads vertically down the
door, or upside down. An unwrapper may also lay a panel out as a mirror image,
as the Tatuus's left flank is, and no turn makes lettering on that read; the
profile marks such a panel `reflected`. Write `rotate: 'auto'` and artwork
follows the panel, mirrored back where it has to be; text on a reflected panel
without it is reported as reading backwards. Near-horizontal panels like a
roof have no meaningful "up" and are left alone rather than turned by a number
derived from rounding error.

Tags available on every panel of a generated profile: `left` `right` `centre`,
`nose` `front` `mid` `rear` `tail`, `upper` `lower`, `visible` (readable from
trackside), `cockpit` (readable from the driver's seat), `flat` (the surface
turns 25 degrees or less across most of the panel), `mirrored`, `shared`, and
on the tire texture `sidewall` and `tread`.

Tires deserve a word. A sidewall is a disc, and an unwrapper lays it out either
as a disc — polar about a hub, the way a photograph of a wheel looks — or cut
once and rolled out as a strip, u round the circumference and v from rim to
shoulder. The Abarth's is a disc; the NSX's is a strip. A design
that draws rings is right on the first and draws one big circle across the
second, which on the car is a few stray arcs where the circle crosses the
strip. The profile measures which it is, from the wheel centres AC requires
every car to name, and writes it on the panel as `wheel`; the `band` treatment
reads that and draws a band round the tire `along` the sidewall — 0 at the rim,
1 at the shoulder — whichever way it was unwrapped:

```js
tires: { regions: [
  { treatment: 'band', tags: ['sidewall'], along: 0.9, width: 0.08, color: 'accent', glow: true },
] }
```

On a profile generated before this measurement existed there is no `sidewall`
tag and `band` draws as `ring` did; regenerate with `--from-kn5` to get it.

`shared` is the one that surprises people. A *part* is a thing on the car; a
*panel* is a region of a texture, and across a sample of eight cars 42.8% of
panels shared their rectangle with another — all four wheels drawn from one rim
texture, or mirrored bodywork where the left and right flank occupy the same
texels. Those panels claim no side, because they are on both, and tag selection
paints each rectangle once rather than once per part. So you cannot give the left
front wheel different artwork from the right rear, and the profile now says so
instead of letting you find out in-game.

`liveries/neon-grid-any.mjs` is the worked example. It has no `car` field at all,
so you choose one at build time:

```sh
node bin/liverykit.mjs neon-grid-any --profile cars/tatuusfa1.json
node bin/liverykit.mjs neon-grid-any --profile cars/abarth500.json
```

`liveries/grand-touring-any.mjs` is the same idea in another vocabulary: the
`classic` pack's hockey stick, twin stripes, checkers and sponsor row over a
`gradient`, a number on a white board, and fits for the Abarth and the NSX.

[`liveries/raiden/`](../liveries/raiden/) goes the other way: written for one
car, the NSX GT3 Evo, to use as much of liverykit as a traditional design can.
Its flanks are written once and mirrored, its number, sponsors and name were
placed with `find_space`, its splitter and skirts are the aero layout, and it
carries a flag decal and an underglow.

Anything a given car lacks is **reported and skipped**, never silently dropped.

### Filling in the binding

`--from-kn5` proposes bindings automatically and marks them `source: "auto"`.
The proposal is right about 98% of the time, which is very good and is not the
same as trustworthy without looking, so confirm it:

```sh
# --explain takes a path; it never goes looking. Either from your install:
node bin/liverykit.mjs --explain "$AC_ROOT/content/cars/abarth500/abarth500.kn5" \
                       --skins   "$AC_ROOT/content/cars/abarth500/skins"
# or from a car unpacked into this checkout, which .gitignore already expects:
node bin/liverykit.mjs --explain cars/abarth500/abarth500.kn5 --skins cars/abarth500/skins
```

```
  role                    file                          area  seen  skins  sym  shader
  skinbase_default        SkinBase_DEFAULT.dds           37%   75%   90%  yes  ksPerPixelMultiMap_damage_di
  glass_2                 Glass.dds                       4%   94%    0%  yes  ksPerPixelReflection
  ...
  proposal: skinbase_default  (confidence 0.97, margin over runner-up)
```

Change the entry to `"source": "human"` once you agree. Regenerating the profile
preserves everything marked `human` and replaces everything marked `auto`, the
same way `aliases` are preserved.

Two ways to do a whole car at once. `--explain <kn5> --all` prints every scored
term's ranking and then a `"bind"` block to paste: the proposal at `auto`, with
anything already confirmed in `cars/<id>.json` kept at `human`, so pasting it
loses nothing. You set `human` on the ones you checked. Or open the editor (`--ui`) and use its
**Bindings** panel. Hovering a row in the whole-car view darkens every part but
the ones wearing that term's textures, and **Confirm** writes `"source": "human"`
for that term straight into the profile. That button is the only way the tool
writes `human`, and an agent's proposal cannot (see [docs/mcp.md](mcp.md)).

The driver's helmet, suit and gloves and the pit crew's kit live in separate
models, so nothing about them can be measured from the car. With `--skins`,
they are proposed from AC's own exact filenames (`ac_crew.dds`,
`2016_suit_diff.dds`, `helmet_2012.dds` and so on) and marked
`"evidence": "name"` instead of given a confidence.

### Fitting a portable design to one car

A portable design places its artwork on the largest visible panel of the right
side. Where on that panel is still the design's guess: the check reports
lettering that lands on a curve, and `find_space` measures where the flat part
is, but choosing the spot belongs to the pair of them.

A **fit** records the adjustment, and belongs to neither the design nor the car
but to the pair of them:

```jsonc
// fits/neon-grid-any@abarth500.json
{
  "livery": "neon-grid-any",
  "car": "abarth500",
  "regions": {
    "number-left": { "panel": "left_mid", "at": [0.24, 0.18, 0.52, 0.52] },
    "driver-left": { "drop": true }
  }
}
```

Picked up automatically as `fits/<livery>@<car>.json`, or passed with `--fit`.
Overrides are limited to placement (`panel`, `at`, `rotate`, `scale`, `safe`,
`drop`) because anything more and a fit becomes a second livery language. A fit
naming something that no longer exists is reported and ignored rather than fatal.

Give a region an `id` if you expect to adjust it. One without an id is still
addressable — by position, as `surfaces.body#3` or `paint.bodyRear#3` — but that
key means "whichever region is fourth", so inserting one above it silently moves
what the fit refers to. The editor labels those rows as addressed by position,
and the remedy is one line in the design.

### The fitting editor

Dragging rectangles in a text file, rebuilding, and installing to see where the
artwork landed is a slow way to find out you were 3% off. `--ui` opens a local
editor instead:

```sh
node bin/liverykit.mjs neon-grid-any --profile cars/abarth500.json --ui
# fitting editor at http://127.0.0.1:7391/
```

Drag a region to move it, drag a corner to resize, click a panel outline to send
it there. Every box you see is the rectangle the **renderer** resolved, not the
editor's own idea of where things are, so the two cannot quietly drift apart. The
re-render is a couple of milliseconds of JavaScript — no rasterizing, no DDS
encode — which is the whole reason this is worth having.

A livery written as code is edited in your own text editor, not this one, so the
editor watches the file and its `decals/` and reloads the design when either
changes. A change that does not load is reported, and the last version kept.
Only the livery's own module is reloaded; a pack it imports is not.

Three views, because the sheet is not the question:

- **UV** — the texture, with panel outlines over it.
- **Car** — the same texture on the actual geometry. Whether a spot is flat, or
  faces the camera, or wraps over a wheel arch, is not visible on a flat sheet.
  You can drag on the car itself, and the artwork follows the surface, or
  shift-click a spot to put the selected region there, centred on it and the
  same size on the car, on whichever panel you clicked.
- **Whole car** — every painted surface at once. A stripe can meet the bodywork
  perfectly and miss the sidepod beside it.

Both car views are **lit** — a hemisphere for sky and ground, one key light and a
clearcoat highlight — because an unlit slab cannot show how a stripe crosses a
curve. Shading distorts color, though, so the **lit** tick turns it off when you
need to read the paint as it is. The UV view is always the honest one.

The Car views need the car's `.kn5`, which is yours and not shipped here — see
[You supply the game's files](../README.md#you-supply-the-games-files). The profile records
which model it was generated from, so setting `AC_ROOT` is usually enough; `--model`
overrides it. Without one the UV view still works and the tab says why.

Nothing is written until **Save fit**, which writes `fits/<livery>@<car>.json`.
Undo and redo (Ctrl/Cmd-Z, Shift-Ctrl/Cmd-Z) cover everything that changes the
fit, including creating and deleting regions.

**Symmetry.** Regions whose ids name a side — `number-left` and `number-right`,
or `numberLeft`/`numberRight` — are treated as two halves of one idea and move
together, mirrored rather than copied: two flanks are not always unwrapped the
same way round, and copying the coordinates across puts the artwork at the wrong
end of the car. You can unlink a pair, pair two regions the convention missed, or
mirror one onto the other once.

A design can write only one half: `mirror: true` on a region placed on a panel
paints it again on that panel's twin, placed by the two panels' measured axes,
under its id with the side swapped (`number-left` gives `number-right`) or with
`-mirror` added. A fit can still move or drop the twin by that id. A panel with
no twin draws the region once and the build says so.

**Copies.** A fit may not add artwork, with one exception: it can say that an
existing region *also* appears somewhere else.

```jsonc
"copies": {
  "badge-mirror": { "of": "badge", "panel": "right_mid", "at": [0.3, 0.2, 0.2, 0.2] }
}
```

Treatment, colors and text all come from `of`; the only new information is a
placement, which is what a fit is for. It earns the exception because symmetry is
a property of the *car* — a design that paints one badge is portable to a car
with one flank worth painting and to a car with two, and the design cannot know
which it is being run against. **Create mirrored copy** and **Duplicate** in the
editor write these; the mirrored one measures where it should land from the
panels' own axes.

Full reasoning in [docs/fitting.md](fitting.md). Turning the editor into
something that can create design elements rather than only move them is
planned in [docs/authoring.md](dev/authoring.md).

### What is wrong with it, measured

The editor shows you the car and you can judge whether it looks right. What you
cannot see, from any angle, is that a name is painted into the gap between two UV
islands and exists on no triangle at all — it renders perfectly on the sheet and
is simply not on the car. **Check the fit**, under the editor's Checks tab, measures that
and several other things:

| finding | what it means |
|---|---|
| `unmatched` | a region whose tags select no panel, or whose panel this car lacks — it paints nothing |
| `overflows` | a ring drawn past its own box, so part of it is outside everything the checks measure |
| `margin` | a region that asked for clean bodywork all round it (`minMargin`) is too near an edge, gap or hidden area |
| `overlap` | two placements share space and at least one is text; high when both are, or when a ring's edge runs through text. Lettering on two different panels is compared too, since a panel's box can take in another panel's texels |
| `crossed` | something is painted across a region that asked to be kept clear |
| `off-mesh` | the box lands on texture space no triangle uses |
| `off-panel` | lettering whose box is mostly texture another panel wears, so it is drawn on that panel and not on the one it names |
| `unseen` | the bodywork hides it from trackside, or a fitting stands on it (a door handle, a number plate) |
| `curved` | lettering on bodywork that turns more than 30 degrees under it, so its far end is foreshortened; high past 45, where it wraps round the car as it would over a wheel arch |
| `hidden-in-view` | part of a number, word or ring is behind something in the view that shows it best, counted in the renderer's own pixels; only when a draft is measured over MCP |
| `low-contrast` | text in a color too close to what is painted under it: under 3:1 will not read from trackside |
| `unreadable` | too small in millimeters at the car's real scale |
| `ungrouped` | a region that declared `groupWith` is not on the same panel as the region it names |
| `stripe-across` | a piece of a declared `stripe` runs across the car on its panel: its long side is the axis find_panels names as across the car |
| `stripe-offset` | two pieces of one declared `stripe` do not line up where they meet: an edge steps more than 20 mm on the car |
| `stripe-gap` | a declared `stripe` does not cover the car nose to tail: a stretch of paintable bodywork, seen from above (or from the side, for a flank stripe), is bare — over a rear wing too — or a panel inside its band, such as a roof hatch, is left unpainted. Glass, grilles, openings and sheets the design does not paint are not counted |
| `too-small` | a race number's capitals under 140 mm tall on the car, or a team or driver name's under 45 mm, measured on the letters after the text is shrunk to fit its box |
| `outside-safe` | outside the part of the panel measurement found readable |
| `hidden-face` | on the face of a two-sided sheet the world cannot see |
| `clipped` | a spanning region stops at a panel edge the profile has no seam for |
| `unpainted-twin` | a sheet you paint has an unpainted duplicate on top of it |
| `bad-constraint` | a constraint nothing enforces — refused, not ignored |
| `unknown-field` | a field on a region that its treatment does not take and nothing else reads, such as `drop`, which belongs in a fit |

The panel leads with what it could **not** check. "No findings" from a run that
skipped the geometry and "no findings" from a run that did all of it are the same
sentence and opposite facts, so the two are never allowed to look alike.

The same check runs without the editor, for a script or a CI job:
`liverykit <livery> --check` prints the findings worst first and exits 1 on
anything high or fatal (`--fail-on low` to be stricter, `--json` for the whole
report).

And so does the picture: `liverykit <livery> --shot left,three-quarter,sheet`
renders those views of the car to `<out>/<folder>-<view>.png` with the editor's
own renderer, no editor or browser open. It needs the car's model.

### One region across several panels

A rectangle lives in one island's sheet. A band that runs from the door onto
the panel behind it is one region with `span: true`, whose `at` may run past
its panel's edge:

```js
{ id: 'band', treatment: 'stripe', panel: 'left_mid', span: true,
  at: [-0.3, 0.62, 2.2, 0.10], color: 'white' }
```

The part past the edge is continued onto whichever adjacent islands it crosses
a seam into, through the seam maps the profile measured — drawn once, placed
under each panel's map, clipped to each panel's outline, so a stripe's edge and
a word's letters carry straight across. It stops where the bodywork does: on
the NSX a band across the door runs onto the fender strip ahead and the intake
surround behind, and not across the intake, because that is a hole. The
fitment check reports each piece where it lands (`band@left_rear_upper`).

The editor draws the home rectangle only and a drag stays inside the panel, so
for now a spanning region is written by hand or proposed over MCP.
[docs/spanning.md](spanning.md) has the reasoning and the limits.

### A band at a height, and regions with a shape

A band along the side of a car, the classic lower-body sweep, is the car between
two heights, and on curved bodywork that is no rectangle in any panel's frame.
`find_space` with `flank: { fromMm, toMm }` traces it off the model: a stripe on
every panel the band crosses seen from that side, front wings included where no
seam joins them to the door, each the part of its panel between the two heights,
exactly. Surfaces nearly level are the top of the car and are left out, and each
side's pieces are one `stripe`.

Each piece carries a `shape`, a polygon in fractions of its own `at` box, which
the region is drawn and measured inside:

```js
{ id: 'sweep-left-left_mid', treatment: 'stripe', panel: 'left_mid',
  at: [0, 0.54, 0.97, 0.46], shape: [[0, 0.02], [1, 0], [1, 1], [0, 1]], color: 'indigo' }
```

Any region can have one. Because it is relative to `at`, moving the region moves
its shape with it.

### Saying what a region needs

Placement rules say where artwork goes. Constraints say what it needs wherever it
ends up, and they live on the **design** so they travel to every car:

```jsonc
{ "id": "team-left", "treatment": "text", "text": "{team}",
  "constraints": { "keepClear": true, "minMm": 40, "minOnCar": 0.9 } }
```

`keepClear` closes a real gap: the overlap check speaks up for text on text,
because layering is how a livery is built — but a stripe running the length of a
flank is artwork by that measure, and the team name under it is still lost.
`minMm` replaces the global 25 mm floor for this region and applies to any
treatment. `minOnCar` does the same for how much of the box must land on
geometry, since a background fill is meant to bleed off an island and a name is
not. `minVisible` sets a floor on how much of the box can be seen from trackside,
by the same ray casting as `unseen`, which on its own only speaks up below 35% — a
roundel tucked under a window frame is on the car and still cut off. Paint with a
fitting standing on it counts as unseen however many angles slip round the fitting:
the ray straight out from the surface is tested exactly against the triangles within
5 cm, since a door handle a few millimeters proud is finer than the voxel grid. A region
with any of these constraints is sampled every 5 mm or so, so its edges are tested
too. `minMargin`, in
millimeters, asks for that much clean bodywork all round: with it added on every
side, the box must still be on the car and visible. `groupWith` names another region
this one must share a panel with, as a team name belongs beside the race number,
and they are reported as `ungrouped` when they part. Unlike the floors it is never
assumed: a brief may want the name on the roof, so it applies only where the design
declares it. `stripe` names a stripe along the car that the region is a piece of, and
every region given the same name is another piece of it. Each piece must run along the
car on its panel (`stripe-across`), and where one piece meets the next, measured on the
model, their edges must agree within 20 mm (`stripe-offset`). Together the pieces must
cover the car nose to tail, and over the top of a rear wing, which seen from above is the
surface over the deck: a stretch of paintable bodywork left bare is a `stripe-gap`. A gap
is fine where the car has glass, a vent or a grille, since paint does not go on a hole.
It is never assumed either: a band across the bonnet is a design too. A misspelled constraint is refused rather than ignored: it would otherwise
read as a rule in force and enforce nothing.

### Surfaces the car should not draw

A GT3 car ships one set of number plate meshes per racing series and renders all
of them — this Honda has eight on the left flank alone, stacked in one patch of
door. Painting one leaves the others wearing their stock artwork on top of yours.
`hide` names the ones you are not using, by texture role:

```jsonc
"hide": ["imsa_numberplate_l", "blancpain_numberplate_silver_colour"]
```

A role the car does not have is ignored, because designs travel, and a surface
the design paints is never hidden.

In the editor a hidden surface is simply not drawn. In the game there is no such
switch, so the build ships a **fully transparent texture** for it — which works
when the part's material honors alpha, and not otherwise. The profile records
`alphaHides` for each texture: true when every material that wears it blends,
alpha-tests or uses alpha to coverage, each of which draws nothing of a fully
transparent texel. The build reads it and says what happened to every hidden
role:

- shipped transparent (a 4x4 sheet — a texture with nothing on it needs no
  resolution);
- no sheet would work, but the car's own config hides every mesh wearing it in
  the game;
- no sheet would work and nothing else hides it, so the game will show it —
  because a material wearing it draws every texel, because no mesh in the car's
  model wears it at all (the driver's suit, the crew: known only from the skins
  folder, drawn by another model, and treated as opaque), or because the profile
  predates `alphaHides` and needs regenerating;
- the design paints it too, and painting wins;
- or the car has no such role.

That "car's own config" is `extension/ext_config.ini` beside the model, where a
Custom Shaders Patch `MODEL_REPLACEMENT` can hide meshes — the usual arrangement
on cars converted from ACC is that every plate set is hidden there and a skin
un-hides one. `--from-kn5` reads it and writes `hiddenByCar` into the profile:
the meshes hidden, how each was matched, and any pattern that matched nothing.
A texture worn only by hidden meshes carries `hiddenByCar: true`; the editor
stops drawing it, the fitment check stops reporting it as an unpainted twin,
and a design that paints it is told so, since it is painting a part the game
never shows.

That config is applied by the game running Custom Shaders Patch and by nothing
else: Content Manager's showroom draws the stock model, plates and all. So the
transparent texture is shipped whether or not the car hides the mesh — it is
the one thing honored by everything that draws the part — and `hiddenByCar`
only changes what is reported when no transparent texture would work.

### Painting over the car's own texture

Some surfaces have to start from what the car already has. Glass is the usual
one: the windows texture's alpha is what makes the windows clear, and a
windscreen banner sits in an opaque strip of it. `background: 'stock'` paints
the regions over the car's own texture, read from the model, instead of over a
fill:

```js
paint: {
  windows_civic: {
    background: 'stock',
    regions: [
      { treatment: 'fill', at: [0, 0.4375, 1, 0.1875], color: 'bg' },
      { treatment: 'text', at: [0.2, 0.53, 0.6, 0.07], text: 'HONDA DOLL' },
    ],
  },
},
```

The car's alpha is kept exactly, so nothing the design draws can show on the
glass. It needs the model: the build and the editor both read the texture from
the kn5, and a car whose kn5 carries only placeholders (see `--skins`) has none
to give, which is reported and the surface painted on transparency.

A texture whose size is not a power of two — this one is 2048x1280 — is drawn
at its own size and written at the next powers of two up, 2048x2048, so the DDS
keeps its mip chain. UVs are fractions of the sheet, so the art lands where it
was drawn.

### Lights: an underglow

Paint cannot make a light. In the game an extra light is a Custom Shaders
Patch `[LIGHT_EXTRA_...]` section in an `ext_config.ini`, which CSP also reads
from a skin's own folder, so a design that asks for one gets that file in its
skin:

```js
underglow: 'pink',            // or { color: 'pink', intensity: 6, range: 1.2 }
lights: [                     // any others, in the car's own metres
  { from: [0.6, 0.15, 1.0], to: [0.6, 0.15, -1.0], color: 'accent' },
],
```

`underglow` is placed from the model: a line under each sill, between the
wheels the car hangs on its `WHEEL_` nodes, and one down the middle, all
pointing at the road and on with the headlights. It needs the model, so the
build reads it with `--model` or from the game folder. `lights` take `at` for a
point or `from` and `to` for a line, and `color`, `intensity`, `range`, `spot`,
`direction` and `bind` (`headlights`, `brakes`, or anything else for none).

The editor's whole-car view and the build's pictures draw the pool each light
throws on the floor from the same numbers the config gives the game. Neither
draws the light on the car itself, and how bright it reads at night is the
game's to say: check it there.

### Two honest limits

A fit adjusts placement, so two things it cannot rescue. A portable design cannot
use panel **names** in the design itself, only tags. And it cannot treat the roles behind one term
differently — if `body` binds to two textures, both get the same artwork, though
`once: true` will keep a car number on the primary one. Portable means coarser; a
design written for one car will always look better on it.

## Writing your own treatments

A treatment takes a rectangle and returns SVG. Anything it puts in `emissive` is
rendered separately, blurred and screened back on to produce a glow.

```js
// my-pack.mjs
import { definePack, registerPack } from 'liverykit';

registerPack(definePack('my-team', {
  chevron: (rect, ctx) => ({
    base: `<path d="M${rect.x} ${rect.y} ..." fill="${ctx.color('accent')}"/>`,
    emissive: '',
  }),
}));
```

```sh
node bin/liverykit.mjs my-livery --pack ./my-pack.mjs
```

**On values from a livery.** Every string `ctx` hands you — `ctx.color(...)`,
`ctx.opts.*`, `ctx.palette`, `ctx.tokens` — is escaped for an ATTRIBUTE before
your treatment sees it, so interpolating one into `fill="…"` is safe: it cannot
close the quote and become markup. `ctx.opts.text` is the single exception. It
is content rather than a parameter, and arrives raw so that it can be escaped
for the text node you put it in — `core`'s `text` does that with `esc`, and
`radialText` does it a character at a time. If you put `text` anywhere other
than between two tags, escape it yourself.

Then list `'my-team'` in the livery's `packs`. `--pack` is repeatable and loads
before the livery, so the names are registered by the time it needs them.
[`src/packs/synthwave.mjs`](../src/packs/synthwave.mjs) is the worked example;
`core` holds the primitives and no house style, `gradient` among them, and
`classic` the shapes racing liveries are made of: `chevrons`, `checkers`,
`racingStripes`, `hockeyStick` and `sponsorRow`. Anything meant to be square on
the car is drawn square through the panel's anisotropy, and a `sponsorRow` is
lettering to the fitment check as `text` is.

Two notes on the registry: it's module-global, so two copies of liverykit in one
dependency tree get two of them; and `liverykit/packs/*` subpath imports hand you
the pack *object* without registering it — import `liverykit` itself for the
built-ins.

## Name probes

AC resolves a skin override against texture names inside the model, **not**
against whatever the stock skins happen to contain. A texture missing from every
skin folder tells you nothing about whether the car has it — which is how parts
get written off as unpaintable when they aren't.

If you have the model, `--from-kn5` lists every texture and this problem
disappears. If you don't, guessing is free: a filename that matches nothing
overrides nothing, silently and harmlessly.

```sh
node bin/liverykit.mjs my-livery --uvgrid --probe Tire_D.dds,Tire.dds,tyres_all.dds
```

Each candidate ships in a loud color with its own filename printed on it. One
look at the car identifies the winner; the rest are inert. The probes also draw
concentric rings, so if the part turns out to be radially unwrapped — as tire
sidewalls usually are — you learn the layout at the same time as the name.

## The calibration skin (optional)

`--uvgrid` paints every texture as a labelled coordinate system — columns A–T,
rows 1–20 — then you install it, photograph the car, and read panel positions
straight off the bodywork.

**Most people can skip this.** `--from-kn5` supersedes it for panel positions,
anisotropy, mirroring and visibility. It's still the answer when:

- **The model is encrypted.** Some mod cars ship kn5s the reader can't open.
- **You're mapping the driver or pit crew.** Those are separate models under
  `content/driver/`. Point `--from-kn5` at them too, or estimate and mark the
  panels `"estimated"`.
- **You want to check a profile against reality.** You parsed one file; the game
  loads whatever is installed. `--flat` catches *nothing overrode*; the grid
  catches *overrode the wrong thing*.

Full procedure in [docs/calibration.md](calibration.md).
