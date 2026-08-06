# Contributing

## Car profiles are the useful thing

A car profile is expensive to produce — install a calibration skin, photograph
the car from several angles, read coordinates off the grid — and completely
identical for everyone who owns that car. Every profile contributed is work
nobody else has to repeat.

A livery is the opposite: cheap to write, and personal. Feel free to contribute
those too, but profiles are what make the project worth publishing.

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

**Record safe areas where you find them.** Being inside a UV island is not the
same as being visible; edges curl under the bodywork. If you discover an edge
the hard way, `"safe"` saves the next person from discovering it the same way.

**Note anisotropy if the panel is stretched.** A grid cell is square in the
texture. If it looks 1.4× wider than tall on the car, put `"anisotropy": 1.4`
and the `text` treatment compensates automatically.

**Use `notes` freely.** "Columns run rear→front" and "the crest is at x≈0.275,
so a spine stripe is vertical here" are the kind of thing that takes an hour to
work out and one sentence to pass on.

### Panel naming

Liveries address panels by name, so **consistent names across cars are what let
one design render on more than one model.** Prefer these where they apply:

```
flankLeft  flankRight  nose  engineCover  roof  rearWing  frontWingPlanes
frontWingEndplates  floor  mirrors  airbox
```

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
Please keep it that way; the appeal of this tool is partly that it's readable in
an afternoon.

`npm test` before opening a PR. The tests check the things that fail
*silently* — DDS headers, mip chain lengths, ZIP integrity, case collisions —
because those are the bugs that reach the game without anyone noticing.
