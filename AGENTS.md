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
| `src/build.mjs` | orchestration: profile + livery -> textures -> ZIP |
| `src/profile.mjs` | car profiles: roles, bindings, panels, tags |
| `src/fit.mjs` | fits: per-car placement overrides and copies |
| `src/render.mjs` | regions -> SVG. Pure, and deliberately fast |
| `src/engine/` | kn5 parsing, UV islands, visibility casting, encoding |
| `src/ui/` | the fitting editor: a server and a no-build-step browser app |
| `src/packs/` | treatments. `core` holds primitives and no house style |
| `cars/`, `liveries/`, `fits/` | data, not code |

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

**Fit ids are flat across the whole livery**, while `applyFit` runs once per
surface. Any question of the form "is this id taken?" or "does this id match
anything?" is therefore a question about all the surfaces, not the one in front
of you — see `allRegionKeys` and `fitUsage`. Getting this wrong reports another
surface's ids as stale, or lets a copy claim a name that is already in use.

**Measurement wins where measurement has something to say; hand-work wins where
it does not.** Regenerating a car profile must not cost anything a person chose:
role names, aliases, size overrides, notes, the car's display name, and human
bindings all survive. `src/engine/preserve.mjs` is that rule, and it is worth
reading before changing anything that writes a profile.

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

No build step, no transpiler, ESM throughout, one runtime dependency (`sharp`).
Please keep it that way. Two spaces, semicolons, single quotes.

**Comments explain why, not what.** The prevailing style is a short prose block
above anything with judgement in it, naming the alternative that was rejected and
the failure that motivated the choice — usually a real one, in the past tense.
Match it. A comment restating the code is worse than none.

## Git

Work on a branch. Do not prefix branch names with `claude/`, and do not add
`Co-authored-by` trailers.

Commit messages: a sentence-case subject line under ~72 characters saying what
changed, a blank line, then prose explaining what was wrong and why this is the
fix. No bullet lists of files, no conventional-commit prefixes.

`npm test` before opening a PR.
