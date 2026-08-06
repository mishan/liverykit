# Contributing

## Car profiles are the useful thing

A car profile is one command to produce, and completely identical for everyone
who owns that car. Every one contributed is work nobody else has to repeat, which
makes it the highest-leverage thing you can send.

Liveries are welcome too, but they're personal — profiles are the shared part.

### Submitting a profile

```sh
node bin/liverykit.mjs --from-kn5 <car>.kn5 --skins <car>/skins \
                       --car-id <carId> --car-name "Full Name" --out cars/
```

Then add an `aliases` block giving friendly names to the panels a livery would
actually use, and open a PR with the JSON.

**Never commit the kn5 itself**, or any game texture. A profile is
measurements — filenames, dimensions, rectangles — which is yours to share.
The assets are not.

If you don't have the model, `--uvgrid` calibration still works; see
[docs/calibration.md](docs/calibration.md).

### What a good profile looks like

**Mark your confidence honestly, per panel.** Generated profiles say
`"confidence": "measured"`, which is a real claim. Anything you fill in by hand
should say `"estimated"` and mean it. A profile that admits which panels are
guesses is far more useful than one that pretends they're all measured, because
the next person knows where to be careful and where to just use a flat colour.

**`safe` and `anisotropy` are derived for you** when the profile comes from a
model, so leave them alone unless you're working from screenshots. If you are,
`"safe"` bounds the part of a panel that's actually visible, and
`"anisotropy": 1.4` means a square of texture lands 1.4× wider than tall.

Don't infer a safe area from one bad-looking render. Lettering that reads badly
is usually just too low on the car, not clipped by geometry — check with a
`--flat` build and a screenshot before you write a `safe` rect.

**Use `notes` freely.** "Columns run rear→front" and "the crest is at x≈0.275,
so a spine stripe is vertical here" are the kind of thing that takes an hour to
work out and one sentence to pass on.

### Panel naming

Liveries address panels by name, so **consistent names across cars are what let
one design render on more than one model.** Prefer these where they apply:

```
flankLeft   flankRight   flankLeftFront  flankRightFront
nose        noseTip      cockpitFront    cockpitLeft   cockpitRight
engineCover spine        underbody       intakeLeft    intakeRight
frontWing   frontWingEndplateLeft   frontWingEndplateRight   rearWing
```

`cars/rss_formula_rss_4.json` uses these; copy its `aliases` block as a
starting point.

If a car genuinely has something these don't cover, add it and say so in the PR
— if it recurs, it belongs on this list.

### Don't include game assets

Profiles are measurements: filenames, dimensions, and rectangles. Never commit
textures, `.kn5` files, or anything exported from a car maker's livery template.
Measurements about a file are fine; the file is not.

## Treatment packs

New packs are welcome. Keep the core pack free of house style — if a treatment
implies an aesthetic, it belongs in its own pack so people who don't want it
never load it.

## Code

No build step, no transpiler, ESM throughout, one runtime dependency (`sharp`).
Please keep it that way.

`npm test` before opening a PR. The tests check the things that fail
*silently* — DDS headers, mip chain lengths, ZIP integrity, case collisions —
because those are the bugs that reach the game without anyone noticing.
