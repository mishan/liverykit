// ---------------------------------------------------------------------------
// Where on a panel a shape of a given size fits whole.
//
// A panel's `rect` is the bounding box of an irregular island, and the box is
// not the panel. Measured on the Honda NSX, the top quarter of the left door's
// box is not door at all and the row below it is tucked under the window
// frame, so the middle of the box sits against the window line. Everything
// that places artwork by "the middle of the panel" — a person reading the
// numbers, an agent writing `at` — put a roundel's top edge in the hidden row,
// and the fix an agent reached for was to probe the door with tiny rings one
// at a time, which is this module done by hand.
//
// So it is done here, by measurement, in two parts. `cleanGrid` sweeps the
// panel's box in cells a few centimetres across; each is CLEAN when it lands
// on the model and is seen from trackside, by the same ray casting
// `check_fitment` uses. That is the expensive half and it depends only on the
// panel, so a caller keeps it. `findSpace` then slides a shape of the asked
// size over the clean cells and scores every position by its clearance: how
// far, in millimetres, to the nearest cell that is not clean or to the edge of
// the box. The best few, spaced apart, come back as panel-relative `at`
// rectangles, re-measured at full resolution.
//
// It says where a shape CAN go and how much room it has there. It does not say
// where it should go: that is still the design's decision, and a person's.
// ---------------------------------------------------------------------------

import { texture, panelName, resolveTargets } from './profile.mjs';
import { meshesUsingTexture } from './engine/kn5.mjs';
import { rectVisibility, gridVisibility } from './engine/visibility.mjs';
import { MARGIN_CLEAN, FINE_MM, CAP, NUMBER_MM, NAME_MM, fitment, letterHeights } from './fitment.mjs';

/**
 * How much of a cell must be on the car, and seen, to count as clean.
 *
 * Not 1: a cell at the rim of an island shares its boundary with the space
 * beside it, and a strict 100% marks cells unclean for a sample landing on
 * the line rather than for an edge anybody could see.
 */
const CLEAN = 0.98;

/**
 * Which texture a question about a panel means.
 *
 * Named outright, named by the design's surface (`surfaces.body`, or `body`),
 * or found from the panel's name. That last is where it goes wrong: panel
 * names are geometric, so `left_mid` is the left middle of the bodywork AND of
 * the interior, the glass, the belts and five other sheets — nine on the NSX —
 * and an agent asking about the door was refused twice before it thought to
 * say which texture it meant. The texture the design PAINTS is what a question
 * about placing its artwork is about, so when exactly one of the candidates is
 * painted, that one is taken and the answer says so. Two or none is still a
 * refusal, with the names: that is a genuine ambiguity, not a missing default.
 */
export function spaceRole(profile, design, asked, panel) {
  const roles = Object.keys(profile.panels ?? {});
  if (asked) {
    const term = String(asked).replace(/^(surfaces|paint)\./, '');
    // A surface can bind several textures (a formula car's body binds body
    // AND bodyRear), and the panel asked about can be on any of them. The
    // term is often also the name of one of its textures, so "body" matched
    // the texture before the binding was ever read, and a panel on bodyRear
    // was reported absent from the surface that paints it.
    const bound = (profile.bind?.[term]?.roles ?? []).filter((r) => roles.includes(r));
    const texture = String(asked).startsWith('paint.')
      || (!String(asked).startsWith('surfaces.') && roles.includes(term) && bound.length <= 1);
    if (texture && roles.includes(term)) return { role: term };
    if (bound.length === 1 || (bound.length && !panel)) return { role: bound[0] };
    if (bound.length) {
      const holding = bound.filter((r) => Boolean(profile.panels[r]?.[resolvedName(profile, r, panel)]));
      if (holding.length === 1) return { role: holding[0] };
      return {
        error: holding.length
          ? `${JSON.stringify(panel)} is a panel on ${holding.join(' and ')}, which ${JSON.stringify(asked)} ` +
            `both paints; pass ${holding.map((r) => `paint.${r}`).join(' or ')} to say which.`
          : `${JSON.stringify(asked)} paints ${bound.join(', ')}, and none of them has a panel called ` +
            `${JSON.stringify(panel)}. find_panels lists them.`,
      };
    }
    if (roles.includes(term)) return { role: term };
    return { error: `No texture role or surface called ${JSON.stringify(asked)}.` };
  }
  const has = roles.filter((r) => Boolean(profile.panels[r]?.[resolvedName(profile, r, panel)]));
  if (has.length === 1) return { role: has[0] };
  if (!has.length) return { error: `No panel called ${JSON.stringify(panel)} on this car. find_panels lists them.` };

  let painted = [];
  try {
    painted = [...new Set(resolveTargets(profile, design ?? {}).targets.map((t) => t.role))];
  } catch { /* a design that resolves to nothing paints nothing */ }
  const mine = has.filter((r) => painted.includes(r));
  if (mine.length === 1) {
    return {
      role: mine[0],
      chosen: `${JSON.stringify(panel)} is a panel on ${has.length} textures; ${mine[0]} is the only one ` +
        'this design paints, so that is the one measured. Pass role to ask about another.',
    };
  }
  return {
    error: `${JSON.stringify(panel)} is a panel on ${has.join(', ')}` +
      (mine.length ? `, and this design paints ${mine.join(' and ')}` : '') + '; pass role to say which.',
  };
}

function resolvedName(profile, role, name) {
  try {
    return panelName(profile, role, name) ?? name;
  } catch {
    return name;
  }
}

/**
 * The panel swept into cells, each marked clean or not. The expensive half,
 * and it depends only on the panel and the cell size — keep it and ask
 * `findSpace` as many questions of it as you like.
 */
export function cleanGrid({ profile, model, prepared, role, panel: asked, cellMm = 50, across = 5 }) {
  const name = resolvedName(profile, role, asked);
  const pan = profile.panels?.[role]?.[name];
  if (!pan) throw new Error(`No panel called ${JSON.stringify(asked)} on ${role}. find_panels lists them.`);
  const mpu = pan.metresPerUv;
  if (!(mpu?.[0] > 0 && mpu?.[1] > 0)) {
    throw new Error(`${name} has no measured scale (metresPerUv), so millimetres cannot be placed on it. ` +
      'Regenerate the profile with --from-kn5.');
  }

  const [, , pw, ph] = pan.rect;
  const boxMm = [pw * mpu[0] * 1000, ph * mpu[1] * 1000];
  const cols = Math.max(4, Math.min(48, Math.round(boxMm[0] / cellMm)));
  const rows = Math.max(4, Math.min(48, Math.round(boxMm[1] / cellMm)));
  const meshes = meshesUsingTexture(model, texture(profile, role).file);

  // One walk over the car's triangles for the whole panel, not one per cell:
  // the walk costs the same however small the rectangle, and 609 of them
  // over the NSX door took half a minute.
  const clean = gridVisibility(model, prepared, meshes, pan.rect, cols, rows, { per: across })
    .map((row) => row.map((v) => v.samples > 0 && v.samples / v.of >= CLEAN && v.fraction >= CLEAN));
  return { role, name, rect: pan.rect, boxMm, cols, rows, clean, meshes };
}

export function findSpace({
  grid = null, profile, model, prepared, role, panel,
  widthMm, heightMm = widthMm, marginMm = 0, count = 5, tries = count * 3, cellMm, across,
}) {
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new Error('find_space needs a size on the car: widthMm, and heightMm (which defaults to it), above zero.');
  }
  // Refused rather than coerced. A negative margin returned spots with less
  // clearance than was asked for, and a count of NaN disabled both limits on
  // the loop below, each of which walks the whole mesh.
  checkMargin(marginMm);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`find_space's count is how many spots to return, a whole number from 1; got ${JSON.stringify(count)}.`);
  }
  const g = grid ?? cleanGrid({ profile, model, prepared, role, panel,
    ...(cellMm ? { cellMm } : {}), ...(across ? { across } : {}) });
  const { boxMm, cols, rows, clean } = g;
  const [px, py, pw, ph] = g.rect;
  const cw = boxMm[0] / cols, ch = boxMm[1] / rows;

  const unclean = [];                         // [x0, y0, x1, y1] in mm within the box
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!clean[r][c]) unclean.push([c * cw, r * ch, (c + 1) * cw, (r + 1) * ch]);
    }
  }

  const wc = Math.ceil(widthMm / cw), hc = Math.ceil(heightMm / ch);
  const found = [];
  if (wc <= cols && hc <= rows) {
    for (let r0 = 0; r0 + hc <= rows; r0++) {
      for (let c0 = 0; c0 + wc <= cols; c0++) {
        let whole = true;
        for (let r = r0; r < r0 + hc && whole; r++) {
          for (let c = c0; c < c0 + wc; c++) if (!clean[r][c]) { whole = false; break; }
        }
        if (!whole) continue;
        // The shape centred in the run of clean cells it fits.
        const x0 = c0 * cw + (wc * cw - widthMm) / 2, y0 = r0 * ch + (hc * ch - heightMm) / 2;
        const shape = [x0, y0, x0 + widthMm, y0 + heightMm];
        let clearance = Math.min(shape[0], shape[1], boxMm[0] - shape[2], boxMm[1] - shape[3]);
        for (const u of unclean) clearance = Math.min(clearance, gap(shape, u));
        if (clearance + 1e-6 < marginMm) continue;
        found.push({ shape, clearance });
      }
    }
  }

  // The roomiest first, and not five spellings of the same spot. Each is
  // measured again at full resolution and dropped if it fails there: the
  // cells are coarse, and a caller is told to hold what comes back to 100%.
  // A dropped spot still keeps its neighbours out, or the next one tried
  // would be the same spot again; the attempts are capped because each
  // measurement walks the whole mesh.
  found.sort((a, b) => b.clearance - a.clearance);
  const tried = [];
  const candidates = [];
  for (const { shape, clearance } of found) {
    if (candidates.length >= count || tried.length >= tries) break;
    if (tried.some((s) => overlapShare(s, shape) > 0.5)) continue;
    tried.push(shape);
    const at = [shape[0] / boxMm[0], shape[1] / boxMm[1], widthMm / boxMm[0], heightMm / boxMm[1]];
    const v = rectVisibility(model, prepared, g.meshes,
      [px + at[0] * pw, py + at[1] * ph, at[2] * pw, at[3] * ph], { across: 16 });
    const onCar = v ? v.samples / v.of : 0;
    const visible = v ? v.fraction : 0;
    if (onCar < CLEAN || visible < CLEAN) continue;
    // The margin too, as `minMargin` will hold it: the box grown by it on
    // every side, sampled every few millimetres, against the same bar. The
    // clearance above came from the coarse cells alone, and an edge or a
    // fitting narrower than a cell could sit inside it and fail the constraint
    // the caller is told to add. Measured on the `at` the caller is handed,
    // rounded as it is, so that a margin found right at its limit is not
    // then lost to the rounding.
    const sent = at.map(r3);
    const holds = (mm) => {
      const m = [sent[0] * boxMm[0] - mm, sent[1] * boxMm[1] - mm,
        (sent[0] + sent[2]) * boxMm[0] + mm, (sent[1] + sent[3]) * boxMm[1] + mm];
      const fine = (d) => Math.max(14, Math.min(160, Math.ceil(d / FINE_MM)));
      const around = rectVisibility(model, prepared, g.meshes,
        [px + (m[0] / boxMm[0]) * pw, py + (m[1] / boxMm[1]) * ph,
          ((m[2] - m[0]) / boxMm[0]) * pw, ((m[3] - m[1]) / boxMm[1]) * ph],
        { grid: [fine(m[2] - m[0]), fine(m[3] - m[1])] });
      return !!around && around.samples / around.of >= MARGIN_CLEAN && around.fraction >= MARGIN_CLEAN;
    };
    if (marginMm > 0 && !holds(marginMm)) continue;
    // And the clearance REPORTED is one the fine grid has held too. It came
    // from the cells, and the planner is told to write it as `minMargin`: a
    // handle narrower than a cell could sit inside it, and the margin the
    // caller was told would pass then failed. Where the cells' figure does not
    // hold, the largest that does is found by halving between it and what was
    // asked, which has been held. Falling back to what was asked reported
    // zero for a spot with hundreds of millimetres of room whenever no margin
    // was asked, and a planner told zero has no margin to write. The halving
    // stops at the fine grid's own step, below which it samples nothing new;
    // each question walks the whole mesh, so this is a handful per spot.
    let held = marginMm;
    const roomy = Math.floor(clearance);
    if (roomy > held) {
      if (holds(roomy)) held = roomy;
      else {
        let over = roomy;
        while (over - held > FINE_MM) {
          const mid = Math.floor((held + over) / 2);
          if (holds(mid)) held = mid;
          else over = mid;
        }
      }
    }
    candidates.push({ at: sent, marginMm: held, onCar: r2(onCar), visible: r2(visible) });
  }

  return {
    role: g.role,
    panel: g.name,
    boxMm: boxMm.map(Math.round),
    cellMm: [Math.round(cw), Math.round(ch)],
    // Texture top first: '#' is on the car and seen, '.' is not.
    map: clean.map((row) => row.map((ok) => (ok ? '#' : '.')).join('')),
    candidates,
    ...(candidates.length ? {} : {
      note: `No spot on ${g.name} fits ${Math.round(widthMm)} x ${Math.round(heightMm)} mm with ` +
        `${marginMm} mm of clean bodywork all round. Try a smaller size or margin, or another panel.`,
    }),
  };
}

/**
 * The largest shape of a given proportion that fits whole on a panel, and where.
 *
 * A sweep of sizes, not a guess at one. Fitting only gets easier as a shape
 * shrinks, so the limit is found by halving: about a dozen questions of the
 * panel's sweep, which is kept, so each costs a slide and a re-measure. An
 * agent told "a roundel about 400 mm" put a 240 mm one on a door that held
 * 400, and a name box half the size a person had fitted by hand; asked for
 * the limit, it gets the limit, and can stand back from it deliberately.
 *
 * `aspect` is height over width. What comes back is the largest `widthMm` and
 * `heightMm` that fit with `marginMm` all round, and the spot, as `find_space`
 * gives one.
 */
export function largestSpace({
  grid = null, profile, model, prepared, role, panel, aspect = 1, marginMm = 0, cellMm, across, precisionMm = 10,
}) {
  if (!(aspect > 0)) {
    throw new Error('find_space with largest needs an aspect above zero: the shape\'s height over its width.');
  }
  checkMargin(marginMm);
  const g = grid ?? cleanGrid({ profile, model, prepared, role, panel,
    ...(cellMm ? { cellMm } : {}), ...(across ? { across } : {}) });
  let lo = 0, hi = Math.min(g.boxMm[0], g.boxMm[1] / aspect);
  let largest = null, sizesTried = 0;
  // More spots tried per size than find_space's own three for one. A size
  // judged not to fit is never asked about again, so three roomy spots
  // failing the fine check on a fitting narrower than a cell, with a fourth
  // clear, reported 300 mm on a panel that held 390.
  const tries = 12;
  while (hi - lo > precisionMm && sizesTried < 16) {
    sizesTried++;
    const w = (lo + hi) / 2;
    const r = findSpace({ grid: g, model, prepared, widthMm: w, heightMm: w * aspect, marginMm, count: 1, tries });
    if (r.candidates.length) {
      lo = w;
      // Reported at a size that was itself measured. Rounded to the nearest
      // millimetre, the size could be larger than the shape that passed, and
      // the spot, clearance and fractions beside it were for another shape.
      const fw = Math.floor(w), fh = Math.floor(w * aspect);
      const at = fw > 0 && fh > 0 ? findSpace({ grid: g, model, prepared, widthMm: fw, heightMm: fh, marginMm, count: 1, tries }) : null;
      if (at?.candidates.length) largest = { widthMm: fw, heightMm: fh, ...at.candidates[0] };
    } else {
      hi = w;
    }
  }
  return {
    role: g.role,
    panel: g.name,
    boxMm: g.boxMm.map(Math.round),
    aspect,
    marginMm,
    largest,
    sizesTried,
    ...(largest ? {} : {
      note: `Nothing of that proportion fits whole on ${g.name} with ${marginMm} mm of clean bodywork all round. ` +
        'Try a smaller margin, another proportion, or another panel.',
    }),
  };
}

// ---------------------------------------------------------------------------
// A race number in a roundel with a name under it, laid out as large as a panel
// allows and handed back as regions.
//
// `largest` finds the biggest rectangle of one proportion, and the planner was
// told what to draw inside it: a roundel 55% of the width, the name in the
// bottom quarter. Nothing in that recipe knew the letters have floors. On the
// NSX door the largest group of that proportion is 572 mm wide, which makes a
// 315 mm roundel, and a two-digit number whose letters fit inside a disc that
// size is about 110 mm tall against a floor of 140. So every run found that out
// by drafting: run 21's planner measured a 97 mm number, then an overlap, then
// 123 mm, and spent eight of its twelve turns and more than half the run's cost
// arriving at a 370 mm roundel. Run 20's went the other way, gave the room to
// the name, and shipped a 93 mm number.
//
// Here it is arithmetic, done once. Each proportion is swept for the largest
// group that fits whole, the room inside is divided between the disc and the
// name by the same letter arithmetic `too-small` uses, and the layout chosen is
// checked by `fitment` itself before it is returned, so what comes back passes
// the checks it was sized for rather than an estimate of them.
// ---------------------------------------------------------------------------

/**
 * Group proportions tried, as height over width on the car. Finely around the
 * middle, where a door's answer is: on the NSX the largest group is 787 mm wide
 * at 0.5 and 572 at 0.85, and a one-line name needs the width while the number
 * needs the height.
 */
const GROUP_ASPECTS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.85, 1];

/**
 * The text treatment's default tracking, and the advance per glyph it
 * estimates to fit a box. `inkBox` tests a ring against a wider 0.72 em, but
 * never wider than the box: so the number's box is made exactly as wide as its
 * letters, and the disc is tested against the letters rather than against an
 * estimate that cost the number a tenth of its size.
 */
const TRACKING = 0.08;
const ADVANCE = 0.62 + TRACKING;

/**
 * A name's font size over its line's height. The treatment's 0.7 leaves the
 * capitals half the box, and stacked, the two lines of a name were mostly air:
 * the layout gave a door a 42 mm name where run 21's planner, drawing at 1.4,
 * got 54. At 1 the capitals are 0.72 of the box and still inside it (baseline
 * at 0.78, capitals reaching 0.75 em above it), with the rest between lines.
 */
const NAME_SCALE = 1;

/**
 * The number's font size over its box height that puts its capitals in the
 * middle of the box: the treatment sets the baseline at 0.78 of the height and
 * `inkBox` has capitals reach 0.75 em above it and 0.02 below, so the ink's
 * middle is 0.365 em above the baseline, and that sits at 0.5 of the box when
 * the font size is 0.28 / 0.365 of it. Centred on the disc's centre, the ink
 * is as far from the rim as it can be on every side.
 */
const NUMBER_SCALE = 0.767;

/**
 * How big the number and the name are aimed to be against each other: a door
 * a person laid out by hand had a 147 mm number over 47 mm capitals. The
 * layout is the one where the smaller of the two, as a share of its aim, is
 * largest, so neither is starved for the other.
 */
const AIM = { number: 147, name: 47 };

/** How much of the disc's radius the number's ink may reach: some air inside the rim. */
const INSIDE = [0.95, 0.9, 0.85];

/** How much wider than its letters the number's box is, so the treatment does not shrink them. */
const SPARE = 1.01;

/** The two lines a name splits into that make its longer line shortest, or null for one word. */
function nameLines(name) {
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return null;
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const pair = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    if (!best || Math.max(...pair.map((l) => l.length)) < Math.max(...best.map((l) => l.length))) best = pair;
  }
  return best;
}

/**
 * The room in an upright group W x H (mm) divided between the disc and the
 * name's lines: the line height, tried in steps, that gives the best balance.
 * Estimates; the layout chosen is measured before it is returned.
 *
 * The disc and the letters are sized in texture pixels, because that is where
 * the ring is drawn and tested: a circle of the box's shorter side in pixels,
 * which on a panel whose pixels are not square on the car is an ellipse there,
 * and laid out in millimetres the number's ink ran out through its rim on the
 * test car's doors. `ah` and `av` are pixels per millimetre across and down the
 * upright group, and `ax` is how the treatment narrows glyphs for the panel's
 * stretch. Font sizes (`em`) are in pixels down the letters.
 */
function divide({ W, H, number, lines, inside, ah, av, ax }) {
  const widest = Math.max(...lines.map((l) => l.length));
  const nameEmMax = (W * ah) / (widest * ADVANCE * ax);   // the width's limit on the name's font size
  // The name's box has air above its capitals already (see NAME_SCALE).
  const gap = Math.max(10, 0.02 * W);
  // The ink's corner, from the middle of the box in ems: half the box's width
  // across, and 0.385 em up or down (see NUMBER_SCALE).
  const numberEm = (s) => (inside * s / 2) / Math.hypot(number.length * ADVANCE * ax * SPARE / 2, 0.385);
  let best = null;
  for (let i = 1; i <= 40; i++) {
    const line = (nameEmMax / NAME_SCALE / av) * (i / 40);   // taller than that adds nothing
    const s = Math.min(W * ah, (H - gap - lines.length * line) * av);   // the disc, in pixels
    if (!(s > 0)) break;
    const numberMm = CAP * numberEm(s) / av, nameMm = CAP * Math.min(NAME_SCALE * line * av, nameEmMax) / av;
    const score = Math.min(numberMm / AIM.number, nameMm / AIM.name);
    if (!best || score > best.score) best = { s, gap, line, numberEm: numberEm(s), numberMm, nameMm, score };
  }
  return best;
}

export function groupLayout({
  grid = null, profile, model, prepared, role, panel, number, name, marginMm = 30, cellMm, across,
}) {
  for (const [k, v] of [['number', number], ['name', name]]) {
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`find_space's layout needs ${k} as the text to lay out, e.g. { number: "85", name: "NEON DOLL RACING" }; ` +
        `got ${JSON.stringify(v)}.`);
    }
  }
  number = number.trim();
  name = name.trim();
  checkMargin(marginMm);
  const g = grid ?? cleanGrid({ profile, model, prepared, role, panel,
    ...(cellMm ? { cellMm } : {}), ...(across ? { across } : {}) });
  const pan = profile.panels[g.role][g.name];
  const turn = ((Number(pan.textRotation ?? 0) % 360) + 360) % 360;
  if (turn % 90 !== 0) {
    throw new Error(`${g.name} is laid at ${turn}° in its texture, and text keeps its letters along one axis of ` +
      'the texture only at a quarter turn, so no layout on it could be measured. Choose another panel.');
  }
  const quarter = turn === 90 || turn === 270;
  const [bw, bh] = g.boxMm;
  // Pixels per millimetre along the texture's u and v, then across and down
  // the upright group, which a quarter turn swaps.
  const tex = texture(profile, g.role);
  const perU = tex.width / (pan.metresPerUv[0] * 1000), perV = tex.height / (pan.metresPerUv[1] * 1000);
  const [ah, av] = quarter ? [perV, perU] : [perU, perV];
  const ax = pan.anisotropy ? 1 / pan.anisotropy : 1;
  const splits = [[name], ...(nameLines(name) ? [nameLines(name)] : [])];

  // Every proportion, and the name on one line and on two.
  const options = [];
  for (const aspect of GROUP_ASPECTS) {
    const sp = largestSpace({ grid: g, model, prepared, aspect: quarter ? 1 / aspect : aspect, marginMm });
    if (!sp.largest) continue;
    const { widthMm, heightMm } = sp.largest;
    const [W, H] = quarter ? [heightMm, widthMm] : [widthMm, heightMm];
    for (const lines of splits) options.push({ aspect, lines, space: sp.largest, W, H });
  }

  // Upright rectangles, [x, y, w, h] in mm from the group's top left, turned
  // into the panel's own frame the way the renderer turns text: about the
  // centre, (dx, dy) to (-dy, dx) at 90 with y down. A quarter-turned box is
  // written with its sides swapped, as the treatment expects.
  const turned = (o) => ([x, y, w, h]) => {
    const [gx, gy, gw, gh] = o.space.at;
    const cx = (gx + gw / 2) * bw, cy = (gy + gh / 2) * bh;
    const du = x + w / 2 - o.W / 2, dv = y + h / 2 - o.H / 2;
    const [dx, dy] = turn === 90 ? [-dv, du] : turn === 180 ? [-du, -dv] : turn === 270 ? [dv, -du] : [du, dv];
    const [tw, th] = quarter ? [h, w] : [w, h];
    return [(cx + dx - tw / 2) / bw, (cy + dy - th / 2) / bh, tw / bw, th / bh].map(r4);
  };
  const regionsFor = (o, d) => {
    const Dw = d.s / ah, Dh = d.s / av;   // the disc's box in mm: square in pixels
    const top = (o.H - (Dh + d.gap + o.lines.length * d.line)) / 2;
    const at = turned(o);
    const h = d.numberEm / NUMBER_SCALE / av, w = number.length * d.numberEm * ADVANCE * ax * SPARE / ah;
    return {
      roundel: { treatment: 'ring', panel: g.name, at: at([(o.W - Dw) / 2, top, Dw, Dh]), radius: 0.25, width: 0.5 },
      // Heavy, because weight is legibility at distance: run 22's critic called
      // a name the planner left at the default "thin" and likely to blur.
      number: { treatment: 'text', panel: g.name, at: at([(o.W - w) / 2, top + Dh / 2 - h / 2, w, h]),
        text: number, scale: NUMBER_SCALE, weight: 900, rotate: 'auto' },
      name: o.lines.map((text, i) => ({ treatment: 'text', panel: g.name,
        at: at([0, top + Dh + d.gap + i * d.line, o.W, d.line]), text, scale: NAME_SCALE, weight: 800, rotate: 'auto' })),
    };
  };

  // Measured, not estimated: the letters by `too-small`'s own arithmetic and
  // the disc against them by `fitment`'s overlap check. A layout that fails
  // either is tried again with more air inside the rim, then given up, and
  // what failed it is kept for the answer: none passing is not "nothing fits".
  const rejected = [];
  const measure = (o) => {
    for (const inside of INSIDE) {
      const d = divide({ W: o.W, H: o.H, number, lines: o.lines, inside, ah, av, ax });
      if (!d) return null;
      const regions = regionsFor(o, d);
      const ids = ['roundel', 'number', ...regions.name.map((_, i) => `name-${i + 1}`)];
      const design = { name: 'layout', packs: ['core'], palette: { ink: '#101014', disc: '#ffffff' },
        identity: { number, team: name },
        paint: { [g.role]: { regions: [{ id: 'roundel', ...regions.roundel, color: 'disc' },
          { id: 'number', ...regions.number, color: 'ink' },
          ...regions.name.map((r, i) => ({ id: `name-${i + 1}`, ...r, color: 'ink' }))] } } };
      // Contrast and mirroring are about the design this goes into, which
      // chooses the colours and paints the other side; neither is the layout's.
      const wrong = fitment(design, profile).findings.filter((f) => (f.severity === 'high' || f.severity === 'fatal')
        && !['low-contrast', 'unmirrored', 'too-small'].includes(f.kind) && (f.ids ?? []).some((id) => ids.includes(id)));
      if (wrong.length) {
        rejected.push(`${wrong[0].kind}: ${wrong[0].why}`);
        continue;
      }
      const mm = letterHeights(design, profile);
      if (ids.slice(1).some((id) => mm[id]?.mm === undefined)) {
        throw new Error(`the letters on ${g.name} could not be measured: ${ids.map((id) => mm[id]?.why).find(Boolean)}`);
      }
      const numberMm = mm.number.mm, nameMm = Math.min(...ids.slice(2).map((id) => mm[id].mm));
      return { o, regions, numberMm, nameMm, score: Math.min(numberMm / AIM.number, nameMm / AIM.name),
        clears: numberMm >= NUMBER_MM && nameMm >= NAME_MM };
    }
    return null;
  };
  const measured = options.map(measure).filter(Boolean)
    .sort((a, b) => Number(b.clears) - Number(a.clears) || b.score - a.score);
  let chosen = measured[0] ?? null;
  // One line where it costs little. A name split over two lines reads, but a
  // person looking at run 20 did not like it, and a number that is a tenth
  // smaller is still well over its floor when the best one was. Nor is a
  // number already the size of the hand-laid door's worth a second line.
  const oneLine = measured.find((m) => m.o.lines.length === 1 && m.clears);
  if (chosen && chosen.o.lines.length > 1 && oneLine
    && (oneLine.numberMm >= 0.9 * chosen.numberMm || oneLine.numberMm >= AIM.number)) chosen = oneLine;
  const other = chosen && measured.find((m) => m.o.lines.length !== chosen.o.lines.length);

  const said = (m) => ({
    aspect: m.o.aspect,
    groupMm: [Math.round(m.o.W), Math.round(m.o.H)],
    marginMm: m.o.space.marginMm,
    lines: m.o.lines.length,
    lettersMm: { number: Math.round(m.numberMm), name: Math.round(m.nameMm) },
    regions: m.regions,
  });
  return {
    role: g.role,
    panel: g.name,
    boxMm: g.boxMm.map(Math.round),
    textRotation: turn,
    layout: chosen ? said(chosen) : null,
    alternative: other ? said(other) : null,
    ...(!chosen ? {
      note: options.length
        ? `Every layout tried on ${g.name} failed fitment, the first with ${rejected[0] ?? 'nothing said'}.`
        : `No group of a roundel over a name fits whole on ${g.name} with ${marginMm} mm of clean bodywork all ` +
          'round. Try a smaller margin or another panel.',
    } : !chosen.clears ? {
      note: `The largest layout on ${g.name} gives the number ${Math.round(chosen.numberMm)} mm capitals and the ` +
        `name ${Math.round(chosen.nameMm)} mm, and check_fitment wants at least ${NUMBER_MM} and ${NAME_MM}. ` +
        'Try a smaller margin, a shorter name, or another panel.',
    } : {}),
  };
}

/**
 * How far rectangle `a` can grow on every side before it touches `b`: zero
 * when they touch or overlap. The larger of the two gaps, not the diagonal,
 * because minMargin grows the box by the same amount on every side, and a
 * cell 40 mm off both a side and the top is inside a box grown by 50 mm even
 * though it is 57 mm away diagonally.
 */
const gap = (a, b) => Math.max(0, b[0] - a[2], a[0] - b[2], b[1] - a[3], a[1] - b[3]);

function checkMargin(marginMm) {
  if (!Number.isFinite(marginMm) || marginMm < 0) {
    throw new Error(`find_space's marginMm is clean bodywork all round in mm, zero or more; got ${JSON.stringify(marginMm)}.`);
  }
}

/** How much of rectangle `a` rectangle `b` covers. */
const overlapShare = (a, b) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return (w * h) / ((a[2] - a[0]) * (a[3] - a[1]));
};

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;
