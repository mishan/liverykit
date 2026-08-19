# liverykit

[![CI](https://github.com/mishan/liverykit/actions/workflows/ci.yml/badge.svg)](https://github.com/mishan/liverykit/actions/workflows/ci.yml)

Generate [Assetto Corsa](https://www.assettocorsa.net/) car liveries from code.

```sh
# Linux:  sudo apt install imagemagick fonts-dejavu-core
# macOS:  brew install imagemagick
# Windows: imagemagick.org/script/download.php  (tick "Add to PATH")

npm install
node bin/liverykit.mjs neon-grid
# -> dist/neon_grid.zip — drag it onto Content Manager to install
```

Assetto Corsa 1 only. Competizione uses an unrelated skin system.

> The bundled example targets the RSS Formula RSS 4, a paid mod car. If you
> don't own it the build still works, you just can't install the result — skip
> to [Making a livery](#making-a-livery) and point it at a car you have.

---

## Why not just paint a texture?

Emitting a good-looking 2048×2048 image is the easy part. The hard part is that
**nothing in the texture tells you which bit of it lands on the sidepod.**

Coordinates in a texture are just fractions of an image. The mapping from those
fractions onto bodywork lives in the car's 3D model, and it is not evenly
spaced, not symmetric, and not guessable. Get it wrong and a sponsor name walks
off the edge of a *UV island* — a contiguous patch of texture that maps to one
region of bodywork — halfway through the word. Perfect in the texture, broken on
the car.

liverykit reads the car's model to find out. A `.kn5` (Assetto Corsa's model
format) stores a 3D position *and* a UV coordinate for every vertex, which is
precisely the mapping a livery needs.

<!-- TODO: an in-game screenshot of a generated livery belongs here, and one of
     the calibration grid on bodywork further down. -->

---

## How it works

Three layers, deliberately separate:

| | what it describes | |
|---|---|---|
| **car profile** — `cars/*.json` | what a *car* is: its textures, and its UV islands given names and measurements | generated once per car, identical for everyone who owns it — **worth sharing** |
| **livery** — `liveries/*.mjs` | what a *design* is: palette, identity, and which **treatment** (a function that fills a rectangle with art) goes on which named **panel** (a named UV island) | quick to write, this is the fun part |
| **pack** — `src/packs/*.mjs` | what a *style* is: the treatments themselves | bring your own without forking |

Because a livery names panels instead of coordinates:

```js
{ treatment: 'fill', panel: 'nose', at: [0, 0, 1, 0.4] }
```

reads *"the front 40% of the nose"* — and keeps meaning that if you point the
same design at a different car with `--profile`. Absolute coordinates still work
as an escape hatch for anything unmapped.

### What the model tells you that a texture can't

Two things in a profile are worth knowing about up front, because both catch
people out and neither is recoverable from the texture alone.

**Which panels touch.** An unwrapper is free to place two panels that meet on the
bodywork at opposite corners of the texture. To a livery they look unrelated; on
the car, a stripe crossing between them has to line up. `adjacent` lists them —
on a typical open-wheeler there are around 190 such pairs, and the front and rear
halves of a single sidepod are routinely separate islands. Paint one and half the
pod stays stock.

**Which panels are visible, and from where.** Being inside a UV island doesn't
mean anyone can see it — duct interiors, bulkhead backs and floor undersides are
all ordinary parts of an island. liverykit ray-casts against the whole car,
wheels and wings included, and reports `visible` per panel. On the example car
87 panels are completely unseeable from trackside.

It also reports `visibleFromCockpit`, cast from the driver's eye, and the two
disagree sharply: the flanks score 99% outside and 6% from the seat, the tub
interior the other way about. If you race in cockpit view, that second number is
the one that matters — and the surfaces you stare at all race are on entirely
separate textures from the bodywork, so an exterior-only livery leaves them
stock. `liveries/neon-grid.mjs` paints them.

---

## Install

```sh
npm install
```

Node 20.9 or newer — that is what sharp's prebuilt binaries require, so it is
the real floor rather than a preference. One npm dependency (`sharp`, which ships prebuilt binaries, so there's
no build toolchain), plus **ImageMagick on your PATH** — it's called as a
subprocess and works with either `magick` (IM7) or `convert` (IM6).

Text rendering needs a font the renderer can find. The examples use DejaVu Sans;
on Windows or macOS, change `render.font` in your livery to something installed
locally.

*Developed and tested on Linux. The output is Windows-bound either way, since
that's where the game runs.*

---

## Making a livery

### 1. Generate a profile for your car

`<carId>` is the folder name under `content/cars/` — `ks_ferrari_488_gt3`,
`rss_formula_rss_4`, and so on.

```sh
node bin/liverykit.mjs --from-kn5 <AC>/content/cars/<carId>/<carId>.kn5 \
                       --skins    <AC>/content/cars/<carId>/skins \
                       --car-id   <carId> --out cars/
```

`<AC>` is your install: on Windows usually
`C:\Program Files (x86)\Steam\steamapps\common\assettocorsa`.

`--skins` matters. The textures inside a kn5 are the model's own low-resolution
defaults — often 512×512 where the skins ship 2048×2048 — so real sizes are
cross-referenced from a skin folder. The model is authoritative about *layout*,
not about *resolution*.

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

Solid colour, no artwork. Install it and check the car changes colour.

Do this first on every new car. If a filename is wrong the skin still installs
cleanly, logs nothing, and renders the stock car — which looks exactly like "my
livery didn't work" with no clue as to why.

### 4. Make it yours

[`liveries/neon-grid.mjs`](liveries/neon-grid.mjs) is commented as a tutorial —
palette, identity tokens, panel-relative coordinates and safe areas are all
explained inline. Then:

```sh
node bin/liverykit.mjs my-livery
```

---

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

Tags available on every panel of a generated profile: `left` `right` `centre`,
`nose` `front` `mid` `rear` `tail`, `upper` `lower`, `visible` (readable from
trackside), `cockpit` (readable from the driver's seat), `mirrored`.

`liveries/neon-grid-any.mjs` is the worked example. It has no `car` field at all,
so you choose one at build time:

```sh
node bin/liverykit.mjs neon-grid-any --profile cars/rss_formula_rss_4.json
node bin/liverykit.mjs neon-grid-any --profile cars/abarth500.json
```

Anything a given car lacks is **reported and skipped**, never silently dropped.

### Filling in the binding

`--from-kn5` proposes bindings automatically and marks them `source: "auto"`.
The proposal is right about 98% of the time, which is very good and is not the
same as trustworthy without looking, so confirm it:

```sh
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

Two honest limits. A portable design cannot use panel **names**, only tags. And
it cannot treat the roles behind one term differently — if `body` binds to two
textures, both get the same artwork. Portable means coarser; a design written for
one car will always look better on it.

---

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

Then list `'my-team'` in the livery's `packs`. `--pack` is repeatable and loads
before the livery, so the names are registered by the time it needs them.
[`src/packs/synthwave.mjs`](src/packs/synthwave.mjs) is the worked example;
`core` holds the primitives and no house style.

Two notes on the registry: it's module-global, so two copies of liverykit in one
dependency tree get two of them; and `liverykit/packs/*` subpath imports hand you
the pack *object* without registering it — import `liverykit` itself for the
built-ins.

---

## Car profile reference

Per panel:

| field | |
|---|---|
| `rect` | the UV island's bounds — `[x, y, w, h]` as fractions of the texture |
| `anisotropy` | how much wider than tall a square of texture lands on the bodywork. The `text` treatment cancels it for you |
| `mirrorOf` | the matching panel on the other side of the car, if there is one |
| `adjacent` | panels that physically touch this one on the car |
| `visible` | fraction of the panel readable from trackside |
| `visibleFromCockpit` | the same, cast from the driver's eye — inverts the answer for interior surfaces |
| `safe` | the sub-rect that's actually visible, when smaller than `rect` |
| `tiled` | the UVs run past 0..1 because the texture repeats, so `rect` is clamped and panel-relative coordinates mean little |
| `uvBounds` | present only when `tiled`: the true UV extent, before clamping |
| `confidence` | `measured` if derived from a model, `estimated` if a human filled it in |

Top level: `textures` (role → file, size, alpha), `aliases`, `caseCollisions`,
and two different "don't paint this" lists:

- **`doNotPaint`** — textures the model binds as something other than colour:
  normal maps, shader maps, dirt masks. Painting one corrupts the thing it
  encodes.
- **`leaveStock`** — textures that genuinely *are* colour maps and will happily
  accept artwork, but shouldn't get it: baked shadow overlays, mirror surfaces,
  motion-blur variants, and the car maker's own badges. Each entry says why.

---

## Commands

Run from a clone with `node bin/liverykit.mjs`, or `npm link` once if you'd
rather type `liverykit`. `--help` is authoritative.

```
<livery>                          build + ZIP
<livery> --flat                   solid colour, no art — the smoke test
<livery> --seed hotline-07        re-roll all procedural placement
<livery> --size 4096              render bigger (powers of two only)
<livery> --keep-png               keep intermediate PNGs, written beside the skin
<livery> --no-zip                 folder only
<livery> --profile <path>         use a different car profile — how you port a
                                  design between cars
<livery> --pack ./my-pack.mjs     load an extra treatment pack (repeatable)
<livery> --uvgrid                 build a calibration skin (see below)
<livery> --uvgrid --cells 40      finer grid, for small parts
<livery> --uvgrid --probe a,b,c   ship candidate filenames as colour-coded probes
--from-kn5 <car>.kn5              generate a car profile from the model
  --skins <dir>                     cross-reference real texture sizes
  --car-id <id> --car-name <name>
--explain <car>.kn5               rank which texture is the bodywork, with the
                                  evidence, so you can confirm the binding
  --term rims                       explain a different vocabulary term
  --no-visibility                   skip the ray casting: faster, less accurate
--scan <skins dir>                classify textures without a model
--out <dir>                       output directory (default: dist)
```

`npm run build` builds the bundled `neon-grid` example; `npm test` runs the
suite.

---

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

Each candidate ships in a loud colour with its own filename printed on it. One
look at the car identifies the winner; the rest are inert. The probes also draw
concentric rings, so if the part turns out to be radially unwrapped — as tyre
sidewalls usually are — you learn the layout at the same time as the name.

---

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

Full procedure in [docs/calibration.md](docs/calibration.md).

---

## Assetto Corsa things that will bite you

All of these fail silently.

- **librsvg ignores SVG `<filter>` entirely.** `feGaussianBlur` renders as
  nothing, so glow is done at the raster stage instead. Don't put filters in
  generated SVG.
- **ImageMagick picks the DXT variant from alpha presence**, not from your
  `dds:compression` define. Ask for dxt5 on an image without alpha and you get
  DXT1.
- **`dds:mipmaps=0` means zero mipmaps** — the opposite of texconv's `-m 0`.
  Chain length is `log2(max(w,h)) + 1`; note the `max`, so a 2048×512 texture
  needs 12 levels, not 10. No mipmaps means heavy shimmering at distance.
- **Non-power-of-two DDS gets no mipmaps at all.** ImageMagick won't generate
  them and exits 0. liverykit refuses these outright.
- **Not every texture is a DDS.** Models bind `.png` textures too — on the
  example car the wheel faces are a 28×28 PNG covering nearly twenty thousand
  vertices. Those are written as PNG; forcing a DDS would produce a filename
  that matches nothing.
- **AC is a DX9 engine and silently ignores DDS files with a DX10 header.** The
  classic cause of "why is my car white" with other tools.
- **A filename that matches nothing overrides nothing.** No error anywhere; you
  just get the stock car.
- **Case collisions.** `Suit_DIFF.dds` and `SUIT_DIFF.dds` coexist on ext4 and
  are *one file* on NTFS, where the second to extract wins. Ship one spelling.
- **librsvg does no text reflow or auto-shrink.** The `text` treatment estimates
  advance width and scales down to fit.
- **`<textPath>` support in librsvg is inconsistent.** `radialText` places glyphs
  individually instead.
- **The emissive layer always composites above the base**, so decoration lands on
  top of lettering unless you exclude it — `sparkles` takes `avoid` rects.

---

## Contributing

Car profiles are the most valuable thing to contribute: one command produces one,
and it's identical for everyone who owns that car. See
[CONTRIBUTING.md](CONTRIBUTING.md).

The kn5 reader is reverse-engineered from a format with no public specification.
It validates by consuming the file to its exact final byte, so a wrong layout
fails loudly instead of parsing into nonsense. If it throws on your car, please
[open an issue](https://github.com/mishan/liverykit/issues) with the version
number it prints.

## Licence

MIT. Not affiliated with Kunos Simulazioni or any car maker. Ships no game
assets, and profiles contain measurements only — never textures or models.
