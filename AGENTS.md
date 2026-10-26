# Working in this repository

liverykit generates Assetto Corsa car liveries from code. It reads a car's 3D
model to find out where each texture lands on the bodywork, so a design can say
"the front 40% of the nose" instead of guessing at coordinates.

Read [README.md](README.md) for what it does and [docs/](docs/) for why the
awkward parts are shaped the way they are. This file is the short version of
what tends to bite.

## Commands

```sh
npm test                      # everything, serially
npm run test:fast             # the three quick suites, no browser
npm run build                 # build the bundled example end to end
node bin/liverykit.mjs --help # authoritative for the CLI
```

`npm test` needs no game content and no network. Some of it drives a real
Firefox; see [Tests](#tests).

## Layout

| | |
|---|---|
| `bin/liverykit.mjs` | the CLI, and the only place that reads argv |
| `packages/toile/` | the half that measures and places, for any model; imports nothing from liverykit |
| `…/src/build.mjs` | orchestration: profile + livery -> rendered surfaces -> an output |
| `…/src/output.mjs` | what an output does, and the default: one PNG per surface |
| `…/src/model.mjs` | a model, whichever format read it, and what each mesh is (`meshTraits`) |
| `…/src/formats/` | kn5, through ac-kn5, and binary glTF |
| `…/src/generate.mjs` | a profile from any model, with nothing but the model to go on |
| `…/src/frame.mjs` | which way a model faces, and its sections nose to tail |
| `…/src/vocabulary.mjs` | the terms a design paints by, as a game supplies them |
| `…/src/profile.mjs` | profiles: roles, bindings, panels, tags |
| `…/src/fit.mjs` | fits: per-car placement overrides and copies |
| `…/src/render.mjs` | regions -> SVG. Pure, and deliberately fast |
| `…/src/engine/` | UV islands, panels (`measure.mjs`), visibility, tags, wheels, encoding |
| `src/engine/skin.mjs` | Assetto Corsa's output: DDS, clear sheets, lights, preview, ZIP |
| `src/engine/classify.mjs` | Assetto Corsa's vocabulary, and the classifier that proposes it |
| `src/engine/` | the rest of Assetto Corsa: the kn5 profile generator, lights, shots |
| `src/ui/` | the fitting editor: a server and a no-build-step browser app |
| `src/packs/` | treatments; `core`, the primitives with no house style, is toile's |
| `cars/`, `liveries/`, `fits/` | data, not code |

Every file that moved to toile left a re-export at its old `src/` path, and
liverykit's own code imports through those. The ones whose module reads
profiles also load Assetto Corsa's vocabulary, so `liverykit/src/profile.mjs`
loads a shipped car as it always did; only `classify.mjs`, which the
vocabulary is built from, imports toile directly, along with the files toile
gained since the move, which have no old path to import through. Liverykit reaches
toile by relative path rather than by package name, because liverykit is
published and toile is not: `packages/toile/src` ships inside liverykit until
it is.

`content/`, `cars/*/`, `assets/` and `*.kn5` are gitignored on purpose: they are
car makers' assets. Never commit one, and never write a test that reads one —
see [Tests](#tests).

## Things that are easy to get wrong

**Nothing may fail silently.** This is the project's whole disposition, and it
comes from the format: in Assetto Corsa a texture filename that matches nothing
overrides nothing, with no error anywhere, and the result is indistinguishable
from a livery that simply did not work. So a surface the car lacks, a tag that
matched no panel, a fit naming a region that is gone — all of them are *reported
and skipped*, never dropped quietly and rarely fatal. When you add a way for
something to not happen, add the note that says so.

**`at` is panel-relative. Everywhere.** `[0.5, 0, 0.5, 1]` is the rear half of
whatever panel the region is on. An editor that lets you drag naturally produces
absolute texture fractions, so it converts once, on the way into the fit. A
second meaning for the field depending on where it was written would be far worse
than a conversion — and the one time the conversion was skipped, artwork moved
somewhere nobody asked for and the fit still read perfectly well.

**A panel name may be an alias.** A livery says `flankLeft`; the profile calls
that island `left_mid`, and only the second is a key in `profile.panels`.
Resolve with `panelName(profile, role, name)` before looking anything up.

**A livery is untrusted input.** People download each other's designs, and the
editor renders one into the page as `innerHTML` from a local server that writes
files — so a value that can close an attribute is a value that can run code.
Treatments build markup by interpolation, which is what makes them nice to
write, and 40 fields took a payload before this was fixed. `renderTexture`
escapes every string on the way in — `opts`, and `palette` and `tokens` too, not
just what `ctx.color` returns — at the boundary rather than at the 40 call sites,
so a treatment cannot get it wrong, including one in somebody else's
pack. `ctx.opts.text` is the deliberate exception: it is content, its emitters
escape it for the text node, and `radialText` draws it a character at a time so
a pre-escaped `&quot;` would appear as five glyphs on the car.
`test/injection.test.mjs` re-derives the field list from the packs' own
descriptions, so a new option is covered without anybody remembering.

**The whole-car view has three sources of texture, in order.** The design's own
render for a surface it paints; the car's own texture, straight out of the kn5,
for one it does not; and a gray for anything neither can supply. The gray used to
be shared with the handle the per-surface view uploads into, so unpainted glass
wore the body design — and it was never noticed, because it made the car look
whole. DDS goes to the GPU as S3TC blocks with no decode step.

**Fit ids are flat across the whole livery**, while `applyFit` runs once per
surface. Any question of the form "is this id taken?" or "does this id match
anything?" is therefore a question about all the surfaces, not the one in front
of you — see `allRegionKeys` and `fitUsage`. Getting this wrong reports another
surface's ids as stale, or lets a copy claim a name that is already in use.

**Measurement wins where measurement has something to say; hand-work wins where
it does not.** Regenerating a car profile must not cost anything a person chose:
role names, aliases, size overrides, notes, the car's display name, and human
bindings all survive. `packages/toile/src/engine/preserve.mjs` is that rule, and
it is worth reading before changing anything that writes a profile.

**Generated names get reused.** Correcting the panel naming turned one car's
`centre_mid` into `centre_rear` and gave `centre_mid` to a different island. So
an alias is followed by *rectangle* first and by name only as a fallback.

## Tests

`test/` is plain `node:test`. Four suites:

- `integrity.test.mjs` — the things that fail silently: DDS headers, mip chain
  lengths, ZIP paths, UV rectangles, bindings, fits.
- `ui.test.mjs` — the editor through a fake DOM, plus the server's own logic.
- `preserve.test.mjs` — naming, and what survives a regeneration.
- `browser.test.mjs` — the editor in a real Firefox, driven by hit-testing.

**No test may read game content.** A test that opens `content/cars/...` passes
only on a machine that owns that car; CI has none. `test/fixtures/kn5.mjs` builds
a small synthetic car — six UV islands, four wheels where AC requires them — and
states its own dimensions, so assertions can be exact.

**The browser suite** skips when no browser is on PATH, which is right locally
and wrong in CI: a skip prints a green tick, so coverage can disappear without
anyone noticing. `LIVERYKIT_REQUIRE_BROWSER=1` turns a missing browser, and an
absent WebGL stack, into named failures. CI sets it and installs `xvfb xauth
x11-utils libgl1-mesa-dri` — without an X server Firefox reports no WebGL and
every renderer test passes without touching a shader.

If a browser test fails with the browser never reporting back, the assertion
tells you the command, whether it died or hung, and what it printed. That is
usually enough; `LIVERYKIT_BROWSER_TIMEOUT_MS` raises the 90s limit.

**Write the test that fails first.** Several bugs here have been fixed
underneath a test that passed either way — most recently a copy that rendered on
the car and was missing from the editor's list, checked only by inspecting the
JSON. Revert your fix, watch the new test fail, then put it back.

## Code

No build step, no transpiler, ESM throughout, six runtime dependencies
(`sharp`, `colord`, `ac-cardata`, `ac-kn5`, `ac-dds` and `mullion`). Please keep it small — but small is the
goal, not zero: `colord` replaced a regex that called `red` an unresolved palette
name and told `#00F0FF` from `gulf-bleu` by its first character, which is not a
wheel worth rebuilding, and `ac-cardata`, `ac-kn5` and `ac-dds` read and write
`data.acd`, the kn5 model and DDS, formats shared with other tools rather than
reimplemented here. `mullion` tiles the editor on a wide window with a mouse —
splits, tabs and dividers over the page's own elements, which it puts back as
the three-column page when the window narrows — and has no dependencies of its
own.

The browser gets `colord`, `ac-dds/decode` and `mullion` through an **import map** in
`src/ui/index.html`, and the server hands over each package's own ESM from
`node_modules`. So a bare specifier means the same package on both sides and the
editor and the tests run the identical file. That is the pattern to copy if the
browser ever needs another — not a vendored copy, and not a bundler.

Two spaces, semicolons, single quotes.

**Comments explain why, not what.** The prevailing style is a short prose block
above anything with judgement in it, naming the alternative that was rejected and
the failure that motivated the choice — usually a real one, in the past tense.
Match it. A comment restating the code is worse than none.

## Assetto Corsa things that will bite you

The format's own hazards, and the reason "nothing may fail silently" above is a
rule rather than a preference. Every one of these produces a file that installs,
loads, and is wrong, with no error anywhere. Most of the guards in `src/engine/`
exist because of a specific line below, so check here before deciding one of them
is over-cautious.

- **Some mod cars ship an encrypted kn5.** Geometry, materials and UV layout read
  normally, but every embedded texture is a 1x1 placeholder with the real ones in
  a Custom Shaders Patch blob appended to the file. liverykit detects this, uses
  the geometry, and takes texture sizes from the car's skin folders — so pass
  `--skins`. It does not decrypt anything and is not going to: that is the
  author's artwork, protected on purpose. For textures no stock skin overrides,
  `--assume-size 2048` paints them at a size you choose, recorded in the profile
  as `"sizeFrom": "assumed"` so it is never mistaken for a measurement.
- **Which way a car faces is read from its wheels, not its mesh names.** AC
  requires `WHEEL_LF`/`RF`/`LR`/`RR` on every car for the physics, so the axes
  are exact. Mesh names were inconclusive on 91 of 235 cars and wrong on two. The
  profile records the resulting track width and wheelbase, which are worth a
  glance against a spec sheet — they are the only numbers in there you can check
  independently. A model with no wheel nodes takes `--facing=+X,+Z`, recorded
  as `from: 'stated'` and kept by regeneration; the wheels win where they exist.
- **librsvg ignores SVG `<filter>` entirely.** `feGaussianBlur` renders as
  nothing, so glow is done at the raster stage instead. Don't put filters in
  generated SVG.
- **A DDS needs its whole mip chain.** Chain length is `log2(max(w,h)) + 1`;
  note the `max`, so a 2048×512 texture needs 12 levels, not 10. No mipmaps
  means heavy shimmering at distance. `ac-dds` writes them; it replaced
  ImageMagick, which picked DXT1 or DXT5 from the image's alpha
  whatever it was asked for and wrote a chain of one from a define it could not
  parse, both with exit 0.
- **Non-power-of-two DDS cannot be trusted to keep its mipmaps** in a DX9
  game. `toDDS` refuses them; the build draws such a texture at its own size
  and writes it at the next powers of two up, which UVs being fractions makes
  safe.
- **Not every texture is a DDS.** Models bind `.png` textures too — on one
  mod car the wheel faces are a 28×28 PNG covering nearly twenty thousand
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

## Git

Work on a branch. Do not prefix branch names with `claude/`, and do not add
`Co-authored-by` trailers.

Commit messages: a sentence-case subject line under ~72 characters saying what
changed, a blank line, then prose explaining what was wrong and why this is the
fix. No bullet lists of files, no conventional-commit prefixes.

`npm test` before opening a PR.
