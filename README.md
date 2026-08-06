# liverykit

Generate [Assetto Corsa](https://www.assettocorsa.net/) liveries from code —
and, more usefully, **measure** where a car's UV panels actually are instead of
guessing at them.

```sh
node bin/liverykit.mjs neon-grid
# -> dist/neon_grid.zip — drag onto Content Manager, it installs without asking
```

Not Competizione. AC's DDS pipeline is the whole point.

---

## The problem this actually solves

Writing code that emits a nice-looking 2048×2048 texture is the easy part. The
hard part is that **nothing tells you which part of the texture lands on the
sidepod.** Region coordinates are fractions of an image; the mapping from those
fractions to the bodywork lives in the car's 3D model, and it is not evenly
distributed, not symmetric, and not guessable.

Guess, and you get a team name that walks off a UV island halfway through the
word — rendering fine in the texture, broken on the car.

**The answer is to read the car's 3D model.** A `.kn5` stores, per vertex, both
a position and a UV coordinate — which is exactly the mapping, exactly, for
free:

```sh
node bin/liverykit.mjs --from-kn5 /path/to/content/cars/<carId>/<carId>.kn5 \
                       --skins    /path/to/content/cars/<carId>/skins
```

That writes a **car profile**: every texture the model references, every UV
island as an exact rectangle, true anisotropy per island, and — the part
nothing else gives you — which islands physically touch on the car.

Liveries then address panels by name, and never see a coordinate that was
guessed.

<!-- A before/after of a livery on a car belongs here. -->

### Do you still need the calibration skin?

For a car you can parse: no, not to *find* anything. `--from-kn5` supersedes it
for panel rectangles, anisotropy, mirroring, texture discovery, and visibility.
It remains useful for three things:

- **Confirming the profile matches the car you have.** You parsed one file; the
  game loads whatever is installed. `--flat` catches "nothing overrode"; the
  grid catches "overrode the wrong thing".
- **Cars you can't parse** — some mod kn5s ship encrypted, and the reader will
  refuse them.
- **Separate models.** The driver and pit crew are their own kn5s. Point
  `--from-kn5` at those too, or estimate and mark them `"confidence":
  "estimated"`.

`--uvgrid` paints every texture as a labelled coordinate system; you install it,
photograph the car, and read panel positions off the grid. It is how this tool
started, and it is an approximation of something the model states exactly — on
the first car profiled that way the nose was half its real size, both wings were
in the wrong place, a second body texture was missed entirely, anisotropy was out
by 40%, and a safe-area rect was recorded from a misdiagnosis.

---

## Three layers

| | what it describes | who it's for |
|---|---|---|
| **car profile** (`cars/*.json`) | textures, named UV panels, safe areas, what not to paint | expensive to measure, identical for everyone who owns the car — **share these** |
| **livery** (`liveries/*.mjs`) | palette, identity, which treatment goes on which named panel | cheap to write, this is the fun part |
| **pack** (`src/packs/*.mjs`) | the treatments themselves | bring your own without forking |

Because liveries name panels rather than coordinates:

```js
{ treatment: 'fill', panel: 'nose', at: [0, 0, 1, 0.4] }
```

…means *"the front 40% of the nose, wherever that is on this car"*, and follows
the car profile if you point it at a different model. Absolute coordinates still
work as an escape hatch for textures nobody has mapped yet.

---

## Install

```sh
sudo apt install imagemagick fonts-dejavu-core
npm install
```

Node 18+. `sharp` ships prebuilt libvips binaries, so there's no build toolchain
to set up. ImageMagick is called as a subprocess and works with either `magick`
(IM7) or `convert` (IM6).

---

## Workflow for a new car

**1. Generate the profile from the model.**

```sh
node bin/liverykit.mjs --from-kn5 <car>.kn5 --skins <car>/skins \
                       --car-id <carId> --out cars/
```

`--skins` matters: the textures embedded in a kn5 are the model's own
low-resolution defaults — 512×512 where the skins ship 2048×2048 — so real
sizes are cross-referenced from a skin folder. The model is authoritative about
layout, not about resolution.

Then rename panels to taste using the profile's `aliases` block, which survives
regeneration in a way that renaming in place would not.

*No model?* `--scan <skins dir>` reads DDS headers and prints a skeleton. But
⚠️ a scan only sees textures that some stock skin chose to override. **Absence
from a skin folder does not mean the model lacks it.** See "name probes" below.

**2. Prove the plumbing before making any art.**

```sh
node bin/liverykit.mjs <livery> --flat
```

Solid colour, no artwork. If the car doesn't change colour, a filename or the
DDS format is wrong, and no amount of art will fix it. This failure is silent —
a skin folder whose filenames match nothing installs cleanly, logs nothing, and
renders the stock car.

**3. Check it on the car** (optional but cheap). `--uvgrid` builds a calibration
skin that installs *alongside* the real one, so you can confirm the profile
matches what the game actually draws. Procedure in
[docs/calibration.md](docs/calibration.md);
[docs/worked-example-rss4.md](docs/worked-example-rss4.md) walks a real one
through, including what it got wrong.

**4. Write the livery.** Start from [`liveries/neon-grid.mjs`](liveries/neon-grid.mjs),
which is commented as a tutorial.

---

## What a profile knows that you'd otherwise get wrong

All real findings from the first car, none of them guessable from a texture:

- **Which islands are separate.** The two flanks are separate islands running in
  opposite directions. No single rectangle paints "the side of the car".
- **Which islands are the same panel.** The forward part of each sidepod is a
  *different* island from the rear part, sitting elsewhere in the texture. Miss
  that and half the sidepod stays unpainted.
- **Which islands touch.** `adjacent` lists islands that meet on the bodywork
  even when they are far apart in UV. This is what lets a stripe continue from
  a sidepod onto the intake behind it — and it exists nowhere in the texture.
- **Whether artwork will be mirrored.** Mirrored islands make asymmetric artwork
  come out reversed on one side.
- **Anisotropy.** How much a square of texture is stretched on the bodywork. The
  `text` treatment cancels it automatically from the profile.
- **Which parts are actually visible.** `visible` and `safe` come from ray
  casting against the whole car: an air duct's inner wall and the underside of
  a floor are ordinary parts of an island and hopeless places for artwork. 87
  panels on this car turn out to be entirely unseeable.
- **Textures you didn't know existed.** This car has a *second* body texture
  covering the rear bodywork. Nothing about a skin folder makes that obvious.

## Name probes

A filename that matches nothing overrides nothing, silently and harmlessly. So
guessing is free: ship every plausible spelling at once, each in a loud colour
printing its own filename, and look at the car.

```sh
node bin/liverykit.mjs <livery> --uvgrid --probe RSS4_Tire_D.dds,RSS4_Tire.dds,tyres_all.dds
```

This found a tyre texture on a car where the part had been written off as
unpaintable, in a single build. The probes also draw concentric rings, so if the
part is radially unwrapped — as tyre sidewalls usually are — you learn the
layout at the same time as the name.

---

## Writing your own treatments

A treatment takes a rectangle and returns SVG. Anything in `emissive` gets the
glow pass.

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

Load it and list `'my-team'` in your livery's `packs`:

```sh
node bin/liverykit.mjs my-livery --pack ./my-pack.mjs
```

`--pack` is repeatable, and runs before the livery is imported so the names are
registered by the time it needs them. `src/packs/synthwave.mjs` is the worked
example.

Two things worth knowing about the registry: it is module-global, so two copies
of liverykit in one dependency tree get two separate registries; and the
`liverykit/packs/*` subpath exports hand you the pack **object** without
registering it — import `liverykit` itself for the built-ins.

---

## Commands

Run from a clone with `node bin/liverykit.mjs`. If you'd rather type
`liverykit`, `npm link` once in the checkout.

```sh
node bin/liverykit.mjs <livery>                     build + ZIP
node bin/liverykit.mjs <livery> --flat              solid colour — pipeline smoke test
node bin/liverykit.mjs <livery> --seed hotline-07   re-roll all procedural placement
node bin/liverykit.mjs <livery> --size 4096         render bigger; every coord is a fraction
node bin/liverykit.mjs <livery> --keep-png          keep intermediate PNGs (written alongside, not inside, the skin)
node bin/liverykit.mjs <livery> --no-zip            folder only
node bin/liverykit.mjs <livery> --pack ./my-pack.mjs   load an extra treatment pack
node bin/liverykit.mjs <livery> --uvgrid            calibration skin
node bin/liverykit.mjs <livery> --uvgrid --cells 40 finer grid for small parts
node bin/liverykit.mjs --scan <skins dir>           classify textures, emit a profile skeleton
node bin/liverykit.mjs --from-kn5 <car>.kn5 --skins <dir> --out cars/
                                                   generate a profile from the model
```

`npm run build` and `npm test` are shortcuts for the first and for the suite.

`--size` must be a power of two (512, 1024, 2048, 4096). ImageMagick will not
generate mipmaps for a non-power-of-two DDS, and a mipless texture shimmers
badly at distance in-game, so anything else is refused rather than silently
shipped broken.

---

## Things that bit during development

Every one of these was found by testing, not by reading documentation.

- **librsvg ignores SVG `<filter>` entirely.** `feGaussianBlur` renders as
  nothing. Glow is therefore a raster-stage operation: the emissive layer is
  rendered separately, blurred, screened onto the base twice, then the crisp
  copy composited over the top. Don't put filters in generated SVG.
- **ImageMagick picks the DXT variant from alpha presence, not from your
  `dds:compression` define.** Ask for dxt5 on an image with no alpha and you
  silently get DXT1. `-alpha on|off` is set explicitly for this reason.
- **`dds:mipmaps=0` means ZERO mipmaps** — the opposite of texconv's `-m 0`,
  which means "full chain". Chain length is `log2(max(w,h)) + 1`; note the
  `max`, so a 2048×512 texture needs 12 levels, not 10. Shipping without
  mipmaps produces heavy shimmering at distance.
- **AC is a DX9 engine and silently ignores DDS files with a DX10 extension
  header.** ImageMagick writes legacy FourCC headers so this is a non-issue
  here, but it's the classic cause of "why is my car white" with other tools.
- **A filename that matches nothing overrides nothing, silently.** No error
  anywhere; you just get the stock car.
- **Case collisions.** `2016_Suit_DIFF.dds` and `2016_SUIT_DIFF.dds` coexist on
  ext4 and are *one file* on NTFS, where the second to extract silently wins.
  Ship one spelling per pair; `--scan` and profile validation both warn.
- **librsvg does no text reflow or auto-shrink.** The `text` treatment estimates
  advance width and scales down to fit. Check the output if you change fonts.
- **`<textPath>` support in librsvg is inconsistent.** `radialText` places
  glyphs individually with per-character transforms instead.
- **The emissive layer always composites above the base.** Sparkles landed on
  top of the driver name until `sparkles` grew rejection-sampled `avoid` rects —
  which, unlike nudged coordinates, keeps `--seed` safe to re-roll.
- **`archiver` was dropped.** Its ESM exports move between versions and it broke
  immediately on Node 22. ZIP writing is ~70 dependency-free lines against
  `node:zlib`, verified against Python's `zipfile` and `unzip -t`.

---

## Contributing

Car profiles are the most valuable thing you can contribute — one command now
produces one, and they're identical for everyone who owns the car. See
[CONTRIBUTING.md](CONTRIBUTING.md).

The kn5 reader is reverse-engineered from a format with no specification. It
validates by consuming the file to its exact final byte, which catches a wrong
layout rather than silently mis-parsing; if it throws on your car, that's a bug
worth reporting with the version number it prints.

## Licence

MIT. Not affiliated with Kunos Simulazioni or with any car maker; this tool
ships no game assets and no third-party textures.
