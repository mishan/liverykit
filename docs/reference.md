# Reference

The command line, the car profile's fields, and the MCP tools. The
[guide](guide.md) explains how they fit together.

## Commands

Run from a clone with `node bin/liverykit.mjs`, or `npm link` once if you'd
rather type `liverykit`. `--help` is authoritative.

```
<livery>                          build + ZIP
<livery> --flat                   solid color, no art — the smoke test
<livery> --seed hotline-07        re-roll all procedural placement
<livery> --size 4096              render bigger (powers of two only)
<livery> --keep-png               keep intermediate PNGs, written beside the skin
<livery> --no-zip                 folder only
<livery> --zip-layout folder      ZIP of just the skin's folder, for a server
                                  upload, as <folder>.folder.zip; the default,
                                  cm, keeps the path Content Manager installs from
<livery> --profile <path>         use a different car profile — how you port a
                                  design between cars
<livery> --fit <path>             per-car placement overrides for this design
                                  (default: fits/<livery>@<car>.json, if present)
<livery> --ui                     open the fitting editor instead of building
  --model <car>.kn5                 model for the editor's 3D views; defaults to
                                    the one the profile was generated from
  --port 7391                       where to serve it (loopback only)
<livery> --check                  run the editor's fitment check and exit 1 on
                                  a high or fatal finding; finds the model as
                                  --ui does, and names the checks it cannot run
                                  without one
  --fail-on low                     fail on low findings too (fatal, high, low)
  --json                            the whole report on stdout, for a script
<livery> --pack ./my-pack.mjs     load an extra treatment pack (repeatable)
<livery> --uvgrid                 build a calibration skin (see the guide)
<livery> --uvgrid --cells 40      finer grid, for small parts
<livery> --uvgrid --probe a,b,c   ship candidate filenames as color-coded probes
--from-kn5 <car>.kn5              generate a car profile from the model
  --skins <dir>                     cross-reference real texture sizes
  --car-id <id> --car-name <name>
--explain <car>.kn5               rank which texture is the bodywork, with the
                                  evidence, so you can confirm the binding
  --term rims                       explain a different vocabulary term
  --all                             every scored term, then a bind block to paste
  --no-visibility                   skip the ray casting: faster, less accurate
--scan <skins dir>                classify textures without a model
--mcp                             start the MCP stdio protocol server (attaches to running --ui)
  --editor <url>                    editor URL for --mcp (default: http://127.0.0.1:7391/)
--out <dir>                       output directory (default: dist)
```

`npm run build` builds the bundled `neon-grid` example; `npm test` runs the
suite.

## Car profile fields

Per panel:

| field | |
|---|---|
| `rect` | the UV island's bounds — `[x, y, w, h]` as fractions of the texture |
| `anisotropy` | how much wider than tall a square of texture lands on the bodywork. The `text` treatment cancels it for you |
| `mirrorOf` | the matching panel on the other side of the car, if there is one |
| `adjacent` | panels that physically touch this one on the car |
| `wheel` | on a tire part: `part` (sidewall or tread), `unwrap` (strip or annulus), `radiusM` [rim, shoulder]; for a strip `around` (which coordinate runs round the circumference), `rim` (which panel edge is the rim) and `across` [at rim, at shoulder]; for an annulus `hub` and `radiusUv`. `fit` is the correlation the verdict rests on |
| `seams` | for each adjacent panel, the affine `matrix` from this sheet to its sheet, fitted in meters from the vertices they share; `here` is where the seam sits in this sheet, `points` and `rmsMm` how much the fit rests on and how far it misses. See [docs/spanning.md](spanning.md) |
| `outline` | the island's boundary polygon in sheet fractions, on panels with seams — a `rect` is a box and islands are not |
| `reflected` | the island is a mirror image in the texture, so lettering needs `rotate: 'auto'` to read |
| `visible` | fraction of the panel readable from trackside |
| `bend` | how far the surface turns across the panel, in degrees: the angle between its mean normal and the normals at the 90th percentile. Under 25, the panel is tagged `flat` |
| `visibleFromCockpit` | the same, cast from the driver's eye — inverts the answer for interior surfaces |
| `safe` | the sub-rect that's actually visible, when smaller than `rect` |
| `tiled` | the UVs run past 0..1 because the texture repeats, so `rect` is clamped and panel-relative coordinates mean little |
| `uvBounds` | present only when `tiled`: the true UV extent, before clamping |
| `confidence` | `measured` if derived from a model, `estimated` if a human filled it in |

Top level: `schemaVersion` (a profile from a newer liverykit is refused rather
than misread), `calibration.model` (the size and SHA-256 of the kn5 it was
measured from; a different model is reported as stale), `textures` (role → file,
size, alpha), `aliases`, `caseCollisions`, and two different "don't paint this"
lists:

- **`doNotPaint`** — textures the model binds as something other than color:
  normal maps, shader maps, dirt masks. Painting one corrupts the thing it
  encodes.
- **`leaveStock`** — textures that genuinely *are* color maps and will happily
  accept artwork, but shouldn't get it: baked shadow overlays, mirror surfaces,
  motion-blur variants, and the car maker's own badges. Each entry says why.

## Model Context Protocol (MCP)

An MCP server over stdio, so an agent can read the car, measure a draft and
propose changes. It attaches to a running editor (`--ui`), never to files: it
reads the working design and fit from the editor, and what it proposes waits in
the editor's inbox until a person accepts it.

### Starting it

1. Start the fitting editor:
   ```sh
   node bin/liverykit.mjs neon-grid-any --profile cars/abarth500.json --ui
   ```

2. Point an MCP client at:
   ```sh
   node bin/liverykit.mjs --mcp
   ```
   If the editor is running on a non-default port, pass `--editor <url>`:
   ```sh
   node bin/liverykit.mjs --mcp --editor http://127.0.0.1:7391/
   ```

### Tools

**Knowing.**

- **`describe_car`**: Profile metadata, texture roles, panel counts, bind table, and axes.
- **`find_panels`**: Query panels filtered by `role`, `tag`, `minVisibility`, `minArea`, `maxAnisotropy`, or `hasMirror`.
- **`find_space`**: Where a shape of a given size fits whole on a panel — on the car, visible, on bodywork turning no more than 30 degrees, and furthest from any edge — as ranked panel-relative spots with their clearance in mm and `bendDeg`, measured by the same ray casting as `check_fitment`. With `largest` and an `aspect`, the largest shape of that proportion that fits. With `layout: { number, name }`, a race number in a roundel with the name under it, laid out as large as the panel allows and returned as regions ready to use.
- **`list_treatments`**: Catalog of all loaded treatment options and schemas.
- **`list_constraints`**: The constraints a region may declare, and what each enforces.
- **`read_design`**: Read working design data held in the running editor.
- **`read_fit`**: Read working fit overrides and copies, including stale region IDs.
- **`report`**: Detailed report of which surfaces and textures this design paints on this car.

**Measuring and seeing.**

- **`check_fitment`**: What is *wrong* with the working design on this car — text
  landing on text, artwork outside a panel's readable area, text too small at the
  car's real scale, broken mirroring, placements painted into texture space no
  triangle uses, and placements the bodywork hides. Read `notChecked`: it names
  checks that could not run, and an empty findings list from a partial run does
  not mean the design is good. Pass `proposal` — operations in the shape
  `propose_design` takes — to measure a change before offering it; nothing is
  proposed and nothing in the editor changes.
- **`render_view`**: Texture SVG and placement data for one surface, or all of them.
- **`render_car`**: A picture of the working design on the car, returned as an
  image. Eight named views — or `sheet`, six of them in one picture — with the car's own textures on whatever the design
  leaves unpainted. Its limits are in the tool description rather than left to be
  discovered: no environment reflections, and one fixed light rig. Takes
  `proposal` the same way `check_fitment` does.

**Proposing.**

- **`propose_design`**: Propose design changes (palette, regions, options, identity, constraints) to the editor's inbox, optionally with the fit operations that place what it adds, so they are reviewed as one change.
- **`propose_fit`**: Propose fit placement overrides or copies to the editor's inbox.
- **`place_at`**: Point at a pixel of a `render_car` picture and propose moving a region there, as shift-clicking the car does in the editor: on the panel under it, centred, at the same size on the car in millimetres.

Proposals land in the editor's proposal banner (`#proposal-banner`) where the human user can visually inspect, drag, and **Accept** or **Discard** them using the undo stack. The MCP server never writes directly to disk.

See [docs/mcp.md](mcp.md) for full protocol details and design rationale.

[autolivery](https://github.com/mishan/autolivery) is an agent built on these
tools. It takes a brief, iterates on a draft until the fitment check and a critic
both pass, and then sends the result here for a person to accept.
