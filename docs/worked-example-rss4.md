# Worked example: calibrating the RSS Formula RSS 4

A real calibration end to end, including the parts that went wrong. The finished
artifact is `cars/rss_formula_rss_4.json`; the general procedure is
[calibration.md](calibration.md). This is the reasoning behind that profile,
kept because the *kinds* of thing calibration turns up transfer better than the
numbers do.

## RSS4_Chassis_D.dds — measured UV map

Read off the `--uvgrid` calibration screenshots, 2026-08-04. Columns A–T are 5%
of texture width each; rows 1–20 are 5% of height each. Cell A1 is the top-left
corner of the texture.

**Confidence is marked per panel.** "High" means consecutive cell labels were
legible across the whole panel in more than one screenshot. "Low" means it was
inferred from two or three labels at an angle, and should be treated as a
starting guess rather than a measurement.

---

## Orientation, established

Working out which side of the car is which took a moment, so it is written down:
viewing a car's **left** side puts its nose on the image **left**. So the
side-on shot with the nose pointing right is the car's **right** flank.

---

## The important structural findings

### 1. The two flanks are separate UV islands, and neither is mirrored

Left flank is columns M–T. Right flank is columns A–H. They do not share texture
space.

Two consequences, both good:

- **Text will not appear backwards on either side.** On the right flank, columns
  run rear→front (A at the rear, H at the nose); on the left flank they run
  front→rear (M at the nose, T at the rear). In both cases a viewer standing
  beside that side of the car sees increasing column number running left to
  right, so text drawn normally reads normally. This is the sane layout and it
  is worth knowing we got it.
- **The sides can carry different artwork** — different sponsor text, an
  asymmetric design, a number on one side only. Nothing forces them to match.

The cost is that anything meant to look continuous along the car has to be drawn
**twice**, once per island, at matching positions. There is no single rectangle
that paints "the whole side of the car".

### 2. This is why the team name broke mid-word

The old config put the team name at x 0.45–0.99, y 0.10–0.20 — columns J–T,
rows 3–4. That starts in the cockpit-area island around J/K and runs into the
**left flank** island at M. The letters that landed in J–L went somewhere else
on the car entirely, which is exactly the "partly disappears" symptom.

### 3. Panels

| Panel | Cells | x | y | w | h | Confidence |
|---|---|---|---|---|---|---|
| **Right flank** (rear→front as A→H) | A1–H4 | 0.00 | 0.00 | 0.40 | 0.20 | high |
| **Left flank** (front→rear as M→T) | M1–T4 | 0.60 | 0.00 | 0.40 | 0.20 | high |
| **Nose** (tip at row 6 → cockpit at row 15; crest along column F) | C6–H15 | 0.10 | 0.25 | 0.30 | 0.50 | high |
| **Engine cover** (front at row 9 → rear at row 16; car-left L–N, car-right O–Q, crest at the N/O boundary, x≈0.70) | L9–Q16 | 0.55 | 0.40 | 0.30 | 0.40 | high |
| Cockpit surround / upper front body | G13–I15, I1–K5 | — | — | — | — | medium |
| Rear wing planes | D18–H20, spilling past H | 0.11 | 0.84 | 0.33 | 0.16 | medium |
| Front wing **planes** | T5–T10 | 0.95 | 0.20 | 0.05 | 0.30 | low |
| Front wing **endplates + canards** | N18–R20 | 0.63 | 0.84 | 0.37 | 0.16 | low |

The front wing is split across two unrelated parts of the texture: its main
planes are a narrow vertical strip at column T rows 5–10, while its endplates
and canards live in the bottom band around N18–R20. Column T rows 18–20 has
nothing to do with column T rows 5–10 — which is convenient, because it means
the canards can be blacked out without touching the planes.

The rear wing's black fill originally stopped at x = 0.40, the right edge of
column H, and a pink stripe appeared along the wing's trailing edge — so the
wing carries on past column H. The fill now runs 0.11–0.44. Overshooting into
unmapped texture is free; undershooting shows.

Everything not listed is unmapped. Painting it is harmless — it either lands
somewhere small or lands nowhere.

### 3b. Safe area on the flanks

Being *inside* an island is not sufficient — the edges curl out of sight.

The bottom of the flank islands, below roughly **y = 0.18** (the lower part of
row 4), wraps under the floor and is not visible from trackside. Found by
putting the driver name at y 0.168–0.198 and getting it back with the lower half
of every glyph missing.

**Keep type above y = 0.17 on the flanks.** The same caution presumably applies
at the other island edges; those haven't been tested.

### 4. Anisotropy — the thing that will still look slightly wrong

A grid cell is square in the texture (102 × 102 px at 2048). It does **not**
come out square on the car. On the flanks the cells read roughly 1.4× wider than
tall, because the island packs the car's whole length into 8 columns while
giving its height 4 rows.

So anything square in the texture appears wide on the car, and text drawn
normally comes out stretched. The car profile carries `"anisotropy": 1.39` on
each flank panel and the `text` treatment pre-narrows glyphs by its reciprocal —
about 0.72 — automatically. (`aspect` on a region still overrides it by hand.)

**This number is eyeballed off a perspective render and is the weakest figure in
this document.** It wants one more screenshot to confirm, or exact UVs from the
kn5.

---

## What would make this exact

Everything above is measured off perspective screenshots, which caps the
accuracy at "good enough to iterate". The definitive version is to parse
`rss_formula_rss_4.kn5` directly: it stores per-vertex UVs alongside per-vertex
positions, so panel rectangles and per-panel anisotropy both fall out as
arithmetic rather than estimates. That would also list every texture name in the
model, which is how the tyre question should have been settled in the first
place.

Copying the kn5 off the machine running the game is one drag-and-drop.

---

## Tyres — name solved, layout still open

`RSS4_Tire.dds`. Confirmed by the probe coming back orange with its own filename
printed on the sidewall. It is now painted in the livery config and also carries
a calibration grid in `--uvgrid`.

One texture covers tread and sidewall together, and **its internal layout is
still unmapped**. The current design works around that rather than solving it:
a dark rubber base with an even magenta halftone is position-independent and
cannot break the way misplaced text does, and the concentric rings are a hedge —
if the sidewall is a radial unwrap centred on the texture (which the probe
screenshots hint at) they land as proper sidewall bands.

One `--uvgrid` screenshot of a tyre settles it, and then `radialText` can put
the team name on the sidewall properly. That is what `radialText` was written
for in the first place.
