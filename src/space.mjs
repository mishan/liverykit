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
// panel's box in cells a few centimeters across; each is CLEAN when it lands
// on the model and is seen from trackside, by the same ray casting
// `check_fitment` uses. That is the expensive half and it depends only on the
// panel, so a caller keeps it. `findSpace` then slides a shape of the asked
// size over the clean cells and scores every position by its clearance: how
// far, in millimeters, to the nearest cell that is not clean or to the edge of
// the box. The best few, spaced apart, come back as panel-relative `at`
// rectangles, re-measured at full resolution.
//
// It says where a shape CAN go and how much room it has there. It does not say
// where it should go: that is still the design's decision, and a person's.
// ---------------------------------------------------------------------------

import { texture, panelName, resolveTargets } from './profile.mjs';
import { meshesUsingTexture, blends, isGlass } from './engine/kn5.mjs';
import { rectVisibility, gridVisibility } from './engine/visibility.mjs';
import { MARGIN_CLEAN, FINE_MM, CAP, NUMBER_MM, NAME_MM, TEXT_ADVANCE, TEXT_TRACKING, fitment, letterHeights, stripePanels, stripeAt, panelOnCar, drawnBy, flankBottom, carLength, bodyWidthMm } from './fitment.mjs';

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
      if (holding.length) return picked(profile, holding, panel, `${JSON.stringify(asked)} paints`);
      return {
        error: `${JSON.stringify(asked)} paints ${bound.join(', ')}, and none of them has a panel called ` +
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
  if (mine.length > 1) return picked(profile, mine, panel, 'this design paints');
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

/**
 * One of several textures a design paints that each hold a panel of this
 * name: the one on which it is largest and most seen. Refused, the RSS4's
 * planner spent the first seven calls of run 29's round asking again with
 * role, for a sidepod that is plainly on `body`. Said, so a caller that meant
 * the other can ask for it.
 */
function picked(profile, roles, panel, painted) {
  const weight = (r) => {
    const q = profile.panels[r]?.[resolvedName(profile, r, panel)];
    const per = q?.metresPerUv;
    const m2 = Array.isArray(q?.rect) && Array.isArray(per) ? q.rect[2] * per[0] * q.rect[3] * per[1] : 0;
    return m2 * (typeof q?.visible === 'number' ? q.visible : 0);
  };
  const role = [...roles].sort((a, b) => weight(b) - weight(a))[0];
  return {
    role, roles,
    chosen: `${JSON.stringify(panel)} is a panel on ${roles.join(' and ')}, which ${painted} alike; measured on ` +
      `${role}, where it is largest and most seen. Pass role as paint.<texture> to ask about another.`,
  };
}

/**
 * A side's main flank panel on these textures: the largest, most seen panel
 * tagged with that side and the middle of the car — a door, or a formula
 * car's sidepod. What a number and name go on when the design names a side
 * rather than a panel; on the NSX, the RSS4 and the Abarth it is the door or
 * sidepod each time, where the largest panel on the NSX's side is the rear
 * quarter.
 */
export function flankPanel(profile, roles, side) {
  let best = null;
  for (const role of roles) {
    for (const [panel, q] of Object.entries(profile.panels?.[role] ?? {})) {
      const tags = q.tags ?? [];
      if (q.hidden || !tags.includes(side) || !tags.includes('mid') || !(q.visible >= 0.5)) continue;
      const per = q.metresPerUv;
      if (!Array.isArray(q.rect) || !Array.isArray(per)) continue;
      const score = q.rect[2] * per[0] * q.rect[3] * per[1] * q.visible;
      if (!best || score > best.score) best = { role, panel, score };
    }
  }
  return best && { role: best.role, panel: best.panel };
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
  widthMm, heightMm = widthMm, marginMm = 0, count = 5, tries = count * 3, cellMm, across, fine = true,
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
  // A dropped spot still keeps its neighbors out, or the next one tried
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
    // The cells' answer alone, unmeasured and said to be: for a caller that
    // ranks many sizes before measuring the few it will use (groupLayout).
    if (!fine) {
      candidates.push({ at: at.map(r3), marginMm: Math.floor(clearance), onCar: null, visible: null, coarse: true });
      continue;
    }
    const v = rectVisibility(model, prepared, g.meshes,
      [px + at[0] * pw, py + at[1] * ph, at[2] * pw, at[3] * ph], { across: 16 });
    const onCar = v ? v.samples / v.of : 0;
    const visible = v ? v.fraction : 0;
    if (onCar < CLEAN || visible < CLEAN) continue;
    // The margin too, as `minMargin` will hold it: the box grown by it on
    // every side, sampled every few millimeters, against the same bar. The
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
    // zero for a spot with hundreds of millimeters of room whenever no margin
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
  fine = true, near = null,
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
  const ask = (w) => {
    sizesTried++;
    const r = findSpace({ grid: g, model, prepared, widthMm: w, heightMm: w * aspect, marginMm, count: 1, tries, fine });
    if (!r.candidates.length) return false;
    // Reported at a size that was itself measured. Rounded to the nearest
    // millimeter, the size could be larger than the shape that passed, and
    // the spot, clearance and fractions beside it were for another shape.
    const fw = Math.floor(w), fh = Math.floor(w * aspect);
    const at = fw > 0 && fh > 0
      ? findSpace({ grid: g, model, prepared, widthMm: fw, heightMm: fh, marginMm, count: 1, tries, fine }) : null;
    if (at?.candidates.length) largest = { widthMm: fw, heightMm: fh, ...at.candidates[0] };
    return true;
  };
  // Started near a size the cells already gave, when there is one: each
  // question measures, and halving from nothing asked a dozen of them where a
  // few either side of the cells' answer find the same limit. The cells can
  // err either way by about a cell, so the search stays open above it.
  const bound = hi;
  let capped = null;
  if (near > 0) {
    capped = Math.min(hi, near * 1.15);
    hi = capped;
    if (ask(near * 0.85)) lo = near * 0.85;
  }
  const halve = (limit) => {
    while (hi - lo > precisionMm && sizesTried < limit) {
      const w = (lo + hi) / 2;
      if (ask(w)) lo = w;
      else hi = w;
    }
  };
  halve(16);
  // A cell the coarse sweep rejects whole can hide room a finer look finds,
  // so the cells' answer can be further under the panel's than the cap
  // allows. A search that found nothing too big under the cap was stopped by
  // the cap, not by the panel, and goes on up to the panel's own bound.
  if (capped !== null && hi === capped && capped < bound) {
    hi = bound;
    halve(sizesTried + 12);
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
const ADVANCE = TEXT_ADVANCE + TEXT_TRACKING;

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
 * How big the number and the name are aimed to be against each other. The
 * layout is the one where the smaller of the two, as a share of its aim, is
 * largest, so neither is starved for the other. A person's first door had a
 * 147 mm number over 47 mm capitals; given run 24's layout (171 over 53), a
 * person kept the number and spent the room on the name, 64 mm on a line
 * 997 mm wide, and the critic had called the name small beside the number.
 */
const AIM = { number: 171, name: 64 };

/**
 * The margin a name's line keeps from anything not clean. Lettering has to be
 * seen, not framed: the margin that keeps a roundel's rim off a shut line cost
 * a name a cell of width at each end, and the gate holds text to being seen
 * by its letters, not to a margin.
 */
const NAME_MARGIN = 10;

/**
 * How much taller than the swept group the roundel and name may stand. The
 * group is the largest rectangle that holds whole, and the person's name line
 * reached below it, onto bodywork the cells call clean. A taller stack is
 * held to the cells and measured before it is used, like a slid one.
 */
const GROW = [1, 1.15, 1.3];

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
 * and laid out in millimeters the number's ink ran out through its rim on the
 * test car's doors. `ah` and `av` are pixels per millimeter across and down the
 * upright group, and `ax` is how the treatment narrows glyphs for the panel's
 * stretch. Font sizes (`em`) are in pixels down the letters.
 */
function divide({ W, Wn = W, H, number, lines, inside, ah, av, ax }) {
  const widest = Math.max(...lines.map((l) => l.length));
  const nameEmMax = (Wn * ah) / (widest * ADVANCE * ax);   // the name's width limits its font size
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
  // Pixels per millimeter along the texture's u and v, then across and down
  // the upright group, which a quarter turn swaps.
  const tex = texture(profile, g.role);
  const perU = tex.width / (pan.metresPerUv[0] * 1000), perV = tex.height / (pan.metresPerUv[1] * 1000);
  const [ah, av] = quarter ? [perV, perU] : [perU, perV];
  const ax = pan.anisotropy ? 1 / pan.anisotropy : 1;
  const splits = [[name], ...(nameLines(name) ? [nameLines(name)] : [])];

  const optionsFor = (aspect, space) => {
    const [W, H] = quarter ? [space.heightMm, space.widthMm] : [space.widthMm, space.heightMm];
    return splits.map((lines) => ({ aspect, lines, space, W, H }));
  };

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
  const toMm = (at) => [at[0] * bw, at[1] * bh, at[2] * bw, at[3] * bh];

  // A T, not a box. The group is the largest rectangle that holds whole, and
  // a name kept inside it got a door's width at the roundel's height: 486 mm
  // on the NSX, two lines of 47 mm capitals that run 23's critic failed as too
  // small, and the planner answered with an orange patch behind the name that
  // a person called amateur. The door is 900 mm wide under the roundel. So
  // each line of the name is as wide as clean bodywork allows where it lands,
  // centred under the disc, from the group's own width (which the sweep held)
  // out towards the panel's, read off the cells here and measured finely
  // before a layout using it is returned.
  const nameMargin = Math.min(marginMm, NAME_MARGIN);
  // Inside the swept group, the group's own width has been held, whatever the
  // cells say a cell either way; outside it nothing has, and a band the cells
  // call unclean there has no room at all. It was given the group's width, so
  // a slid stack could put a name on bodywork nobody had looked at.
  const held = (o, y, h) => y >= -0.5 && y + h <= o.H + 0.5;
  const widest = (o, y, h) => {
    const fits = (w) => coarseFits(g, toMm(turned(o)([(o.W - w) / 2, y, w, h])), nameMargin);
    let lo = o.W, hi = quarter ? bh : bw;
    if (!fits(lo)) return held(o, y, h) ? o.W : 0;
    while (hi - lo > 10) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  // `shift` moves the whole stack down the upright group (up, when negative).
  const stack = (o, d) => {
    const Dh = d.s / av;
    return { Dh, top: (o.H - (Dh + d.gap + o.lines.length * d.line)) / 2 + (d.shift ?? 0) };
  };
  const roomFor = (o, d) => {
    const { Dh, top } = stack(o, d);
    return Math.min(...o.lines.map((_, i) => widest(o, top + Dh + d.gap + i * d.line, d.line)));
  };
  // Where the stack leaves the name the most room, with the disc still on
  // clean cells. The sweep puts a group wherever it has the most clearance,
  // which on a door narrow at the top and wide lower down can be the top, with
  // the name under the disc still in the narrow part and nothing to widen
  // into. Slid down, the same disc leaves the name the width below. A disc
  // moved off the group the sweep held is measured before it is used.
  // The room the name has with the stack moved by `s`, or null where the disc
  // would leave the group onto cells that are not clean.
  const roomAt = (o, d, s) => {
    const Dw = d.s / ah, { Dh } = stack(o, { ...d, shift: 0 });
    const y = (o.H - (Dh + d.gap + o.lines.length * d.line)) / 2 + s;
    if (!held(o, y, Dh) && !coarseFits(g, toMm(turned(o)([(o.W - Dw) / 2, y, Dw, Dh])), marginMm)) return null;
    const room = roomFor(o, { ...d, shift: s });
    return room > 0 ? room : null;
  };
  const bestShift = (o, d) => {
    const span = quarter ? bw : bh;
    const shifts = [0];
    for (let s = 20; s <= span; s += 20) shifts.push(s, -s);
    let best = null;
    for (const s of shifts) {
      const room = roomAt(o, d, s);
      if (room === null) continue;
      if (!best || room > best.room + 5 || (room > best.room - 5 && Math.abs(s) < Math.abs(best.shift))) best = { shift: s, room };
    }
    return best?.shift ?? null;
  };
  // The room divided, the name given the width it has where that puts it,
  // divided again with that width, until the two agree. `reach` takes only
  // part of the extra width, for when the whole of it did not measure clean;
  // `slide` lets the stack move to where the name has more; `grow` lets it
  // stand taller than the group (see GROW). Null where no place for it holds.
  const plan = (o, inside, reach = 1, slide = false, grow = 1) => {
    const H = o.H * grow;
    const cut = (Wn) => {
      const c = divide({ W: o.W, Wn, H, number, lines: o.lines, inside, ah, av, ax });
      if (!c) return null;
      const shift = slide ? bestShift(o, c) : (roomAt(o, c, 0) === null ? null : 0);
      return shift === null ? null : { ...c, Wn, H, shift };
    };
    let d = cut(o.W);
    for (let pass = 0; d && pass < 4; pass++) {
      const want = o.W + Math.max(0, roomFor(o, d) - o.W) * reach;
      if (Math.abs(want - d.Wn) < 5) break;
      d = cut(want);
    }
    if (d && roomFor(o, d) < d.Wn - 1) {
      const Wn = Math.max(o.W, roomFor(o, d));
      const c = divide({ W: o.W, Wn, H, number, lines: o.lines, inside, ah, av, ax });
      d = c && { ...c, Wn, H, shift: d.shift };
    }
    return d;
  };

  const regionsFor = (o, d) => {
    const Dw = d.s / ah;   // the disc's box in mm: square in pixels
    const { Dh, top } = stack(o, d);
    const at = turned(o);
    const h = d.numberEm / NUMBER_SCALE / av, w = number.length * d.numberEm * ADVANCE * ax * SPARE / ah;
    return {
      roundel: { treatment: 'ring', panel: g.name, at: at([(o.W - Dw) / 2, top, Dw, Dh]), radius: 0.25, width: 0.5 },
      // Heavy, because weight is legibility at distance: run 22's critic called
      // a name the planner left at the default "thin" and likely to blur.
      number: { treatment: 'text', panel: g.name, at: at([(o.W - w) / 2, top + Dh / 2 - h / 2, w, h]),
        text: number, scale: NUMBER_SCALE, weight: 900, rotate: 'auto' },
      name: o.lines.map((text, i) => ({ treatment: 'text', panel: g.name,
        at: at([(o.W - d.Wn) / 2, top + Dh + d.gap + i * d.line, d.Wn, d.line]), text, scale: NAME_SCALE, weight: 800,
        rotate: 'auto' })),
    };
  };

  // Measured, not estimated: the letters by `too-small`'s own arithmetic and
  // the disc against them by `fitment`'s overlap check. A layout that fails
  // either is tried again with more air inside the rim, then given up, and
  // what failed it is kept for the answer: none passing is not "nothing fits".
  const rejected = [];
  // The layout as a design of its own, for fitment to measure. `held` is what
  // the roundel declares, when the check is to be the planner's.
  const idsOf = (regions) => ['roundel', 'number', ...regions.name.map((_, i) => `name-${i + 1}`)];
  const asDesign = (regions, held = null) => ({ name: 'layout', packs: ['core'], palette: { ink: '#101014', disc: '#ffffff' },
    identity: { number, team: name },
    paint: { [g.role]: { regions: [{ id: 'roundel', ...regions.roundel, color: 'disc', ...(held ? { constraints: held } : {}) },
      { id: 'number', ...regions.number, color: 'ink' },
      ...regions.name.map((r, i) => ({ id: `name-${i + 1}`, ...r, color: 'ink' }))] } } });
  // Contrast and mirroring are about the design this goes into, which
  // chooses the colors and paints the other side; neither is the layout's.
  const wrongIn = (findings, ids, also = []) => findings.filter((f) => (f.severity === 'high' || f.severity === 'fatal')
    && !['low-contrast', 'unmirrored', ...also].includes(f.kind) && (f.ids ?? []).some((id) => ids.includes(id)));
  // The best that measures, over how tall the stack may stand.
  const measure = (o) => GROW.map((grow) => measureAt(o, grow)).filter(Boolean)
    .sort((a, b) => Number(b.clears) - Number(a.clears) || b.score - a.score)[0] ?? null;
  const measureAt = (o, grow) => {
    insides: for (const inside of INSIDE) for (const [reach, slide] of [[1, true], [1, false], [0.5, false], [0, false]]) {
      const d = plan(o, inside, reach, slide, grow);
      if (!d) continue;
      const regions = regionsFor(o, d);
      // A disc moved off the group or a stack taller than it, or a name wider
      // than it, is on bodywork the sweep did not hold, so it is held here, as
      // finely as the group was. A name to its own margin (see NAME_MARGIN).
      const off = d.shift !== 0 || d.H > o.H + 0.5;
      if (off && !fineFits(g, model, prepared, regions.roundel.at, marginMm)) {
        rejected.push(`the roundel moved ${Math.round(d.shift)} mm was not clean all round`);
        continue;
      }
      if ((off || d.Wn > o.W + 1) && !regions.name.every((r) => fineFits(g, model, prepared, r.at, nameMargin))) {
        rejected.push(`the name's line at ${Math.round(d.Wn)} mm wide was not clean all round`);
        continue;
      }
      const ids = idsOf(regions);
      const design = asDesign(regions);
      const wrong = wrongIn(fitment(design, profile).findings, ids, ['too-small']);
      if (wrong.length) {
        rejected.push(`${wrong[0].kind}: ${wrong[0].why}`);
        // Only this variant: a narrower name or an unslid stack is a different
        // layout, and can pass where this one did not.
        continue;
      }
      const mm = letterHeights(design, profile);
      if (ids.slice(1).some((id) => mm[id]?.mm === undefined)) {
        throw new Error(`the letters on ${g.name} could not be measured: ${ids.map((id) => mm[id]?.why).find(Boolean)}`);
      }
      const numberMm = mm.number.mm, nameMm = Math.min(...ids.slice(2).map((id) => mm[id].mm));
      // The margin this layout holds: the swept group's, measured all round
      // it, unless the stack moved off the group or stood taller than it,
      // where what was held finely is the margin asked for.
      return { o, regions, numberMm, nameMm, score: Math.min(numberMm / AIM.number, nameMm / AIM.name),
        clears: numberMm >= NUMBER_MM && nameMm >= NAME_MM, marginMm: off ? marginMm : o.space.marginMm };
    }
    return null;
  };
  // Ranked on the cells, measured only at the top. Every proportion swept
  // finely on both doors took 27 s of run 23, more than its planner's first
  // round, for seven answers of eight that were never used. The cells give each
  // proportion's size in milliseconds; the layouts they make are estimated and
  // ranked, and only the best three proportions, and the best one-line one, are
  // swept finely, starting near the size the cells gave.
  const ranked = [];
  for (const aspect of GROUP_ASPECTS) {
    const sp = largestSpace({ grid: g, model, prepared, aspect: quarter ? 1 / aspect : aspect, marginMm, fine: false }).largest;
    if (!sp) continue;
    for (const o of optionsFor(aspect, sp)) {
      for (const grow of GROW) {
        const d = plan(o, INSIDE[0], 1, true, grow);
        if (d) ranked.push({ o, clears: d.numberMm >= NUMBER_MM && d.nameMm >= NAME_MM,
          score: Math.min(d.numberMm / AIM.number, d.nameMm / AIM.name) });
      }
    }
  }
  ranked.sort((a, b) => Number(b.clears) - Number(a.clears) || b.score - a.score);
  const picked = pickProportions(ranked);
  const options = [];
  for (const aspect of picked) {
    const near = ranked.find((r) => r.o.aspect === aspect).o.space.widthMm;
    const sp = largestSpace({ grid: g, model, prepared, aspect: quarter ? 1 / aspect : aspect, marginMm, near }).largest;
    if (sp) options.push(...optionsFor(aspect, sp));
  }

  const measured = options.map(measure).filter(Boolean)
    .sort((a, b) => Number(b.clears) - Number(a.clears) || b.score - a.score);
  // Held to what the planner is told to declare, with the car. The sweep
  // calls a spot clean at 98% of it on the car and seen, and the prompt has
  // the roundel declare minOnCar 1, minVisible 1 and the layout's margin, so
  // a layout measured without the car could be handed out and then fail
  // check_fitment the moment the planner used it. Asked of the candidates a
  // layout could be, best first, and only once each.
  const heldOnCar = new Map();
  const holds = (m) => {
    if (!heldOnCar.has(m)) {
      const held = { minOnCar: 1, minVisible: 1, minMargin: m.marginMm };
      // The letter floors are the layout's own business, said in `clears`
      // and the note: a layout that misses them is still offered as the best
      // there is.
      const wrong = wrongIn(fitment(asDesign(m.regions, held), profile, null, { model }).findings, idsOf(m.regions),
        ['too-small']);
      if (wrong.length) rejected.push(`with the car and the roundel's constraints, ${wrong[0].kind}: ${wrong[0].why}`);
      heldOnCar.set(m, !wrong.length);
    }
    return heldOnCar.get(m);
  };
  const best = (pick) => measured.find((m) => pick(m) && holds(m)) ?? null;
  let chosen = best(() => true);
  // One line where it costs little. A name split over two lines reads, but a
  // person looking at run 20 did not like it, and a number that is a tenth
  // smaller is still well over its floor when the best one was. Nor is a
  // number already the size of the hand-laid door's worth a second line.
  const oneLine = best((m) => m.o.lines.length === 1 && m.clears);
  if (chosen && chosen.o.lines.length > 1 && oneLine
    && (oneLine.numberMm >= 0.9 * chosen.numberMm || oneLine.numberMm >= AIM.number)) chosen = oneLine;
  const other = chosen && best((m) => m.o.lines.length !== chosen.o.lines.length);
  // One sheet, when the surface paints several. The layout is measured on
  // this texture, and a design's `surfaces.<term>` paints every texture the
  // term binds: where another has a panel of the same name laid out
  // differently, the same regions land there at another size, or nowhere.
  const alsoOn = [...new Set(Object.values(profile.bind ?? {}).filter((b) => (b.roles ?? []).includes(g.role))
    .flatMap((b) => b.roles).filter((r) => r !== g.role && profile.panels?.[r]?.[g.name]))];

  const said = (m) => ({
    aspect: m.o.aspect,
    groupMm: [Math.round(m.o.W), Math.round(m.o.H)],
    marginMm: m.marginMm,
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
    ...(alsoOn.length ? {
      sheet: `The surface that paints ${g.role} also paints ${alsoOn.join(' and ')}, which has a panel called ` +
        `${g.name} too. Put these regions on paint.${g.role}, so they land on this sheet alone, where they were measured.`,
    } : {}),
    ...(!chosen ? {
      note: options.length
        ? `Every layout tried on ${g.name} failed fitment, the first with ${rejected[0] ?? 'nothing said'}.`
        : `No group of a roundel over a name fits whole on ${g.name} with ${marginMm} mm of clean bodywork all ` +
          'round. Try a smaller margin or another panel.',
    } : !chosen.clears ? {
      note: `The best layout on ${g.name} gives the number ${Math.round(chosen.numberMm)} mm capitals and the ` +
        `name ${Math.round(chosen.nameMm)} mm, and check_fitment wants at least ${NUMBER_MM} and ${NAME_MM}. ` +
        'Try a smaller margin, a shorter name, or another panel.',
    } : {}),
  };
}

/**
 * The proportions worth sweeping finely, from layouts ranked best first: the
 * best `n` different ones, and the best one-line layout's if that is another.
 *
 * Distinct proportions, not the top `n` entries. Each proportion is ranked
 * several times over, once per name split and per height, so the top three
 * entries could all be one proportion, and three meant to be swept were one.
 */
export function pickProportions(ranked, n = 3) {
  const picked = [];
  for (const r of ranked) {
    if (picked.length >= n) break;
    if (!picked.includes(r.o.aspect)) picked.push(r.o.aspect);
  }
  const oneLine = ranked.find((r) => r.o.lines.length === 1 && r.clears);
  if (oneLine && !picked.includes(oneLine.o.aspect)) picked.push(oneLine.o.aspect);
  return picked;
}

/**
 * Whether a rectangle, in mm within a panel's box, sits on clean cells with
 * `marginMm` of clean cells and box all round. By the cells alone, so
 * instant, and as coarse as they are: `fineFits` is the measurement.
 */
function coarseFits(g, [x, y, w, h], marginMm) {
  const [bw, bh] = g.boxMm;
  const cw = bw / g.cols, ch = bh / g.rows;
  const x0 = x - marginMm, y0 = y - marginMm, x1 = x + w + marginMm, y1 = y + h + marginMm;
  if (x0 < -1e-6 || y0 < -1e-6 || x1 > bw + 1e-6 || y1 > bh + 1e-6) return false;
  for (let r = Math.max(0, Math.floor(y0 / ch)); r < Math.min(g.rows, Math.ceil(y1 / ch)); r++) {
    for (let c = Math.max(0, Math.floor(x0 / cw)); c < Math.min(g.cols, Math.ceil(x1 / cw)); c++) {
      if (!g.clean[r][c]) return false;
    }
  }
  return true;
}

/**
 * Whether a panel-relative `at` is on the car and seen, and has `marginMm` of
 * clean bodywork all round, measured as `findSpace` measures a spot it
 * returns: the shape sampled 16 across, the margin every few millimeters.
 */
function fineFits(g, model, prepared, at, marginMm) {
  const [px, py, pw, ph] = g.rect;
  const [bw, bh] = g.boxMm;
  const v = rectVisibility(model, prepared, g.meshes, [px + at[0] * pw, py + at[1] * ph, at[2] * pw, at[3] * ph],
    { across: 16 });
  if (!v || v.samples / v.of < CLEAN || v.fraction < CLEAN) return false;
  if (!(marginMm > 0)) return true;
  const m = [at[0] * bw - marginMm, at[1] * bh - marginMm, (at[0] + at[2]) * bw + marginMm, (at[1] + at[3]) * bh + marginMm];
  const fine = (d) => Math.max(14, Math.min(160, Math.ceil(d / FINE_MM)));
  const around = rectVisibility(model, prepared, g.meshes,
    [px + (m[0] / bw) * pw, py + (m[1] / bh) * ph, ((m[2] - m[0]) / bw) * pw, ((m[3] - m[1]) / bh) * ph],
    { grid: [fine(m[2] - m[0]), fine(m[3] - m[1])] });
  return !!around && around.samples / around.of >= MARGIN_CLEAN && around.fraction >= MARGIN_CLEAN;
}

/**
 * A stripe along the car, laid out: a region for every panel of one sheet the
 * band crosses, seen from above and front to back, each with the `at` that
 * puts the band in the same place on the car, and the `stripe` constraint
 * that holds the pieces together.
 *
 * The planner was working out by hand, panel by panel, what the measurement
 * already knows, and it went wrong every way it could: run 20's first stripe
 * used one set of fractions on panels of different widths and came apart
 * into rectangles, and runs 21 and 22 left out the roof hatch and the rear
 * wing. `stripePanels` says which panels the band crosses and `stripeAt`
 * what each one needs, both from the model. The answer is held to fitment's
 * own stripe checks before it is given, and says what they found, if anything:
 * a layout that cannot pass them is not handed out as though it did. A panel
 * the band crosses that gets no piece is under `skipped`, with why.
 *
 * `design` is the one the stripe is for, where there is one: what it hides
 * and paints decides what the picture draws over the band, and a layout read
 * off a car with a hidden part still standing on it lays no piece under it.
 */
export function stripeLayout({ profile, model, role, widthMm, offsetMm = 0, name = 'centre', design = null }) {
  if (!(Number.isFinite(widthMm) && widthMm > 0)) {
    throw new Error(`find_space's stripe needs widthMm, the stripe's width on the car in mm, above zero; got ${JSON.stringify(widthMm)}.`);
  }
  if (!Number.isFinite(offsetMm)) {
    throw new Error(`find_space's stripe takes offsetMm, its centre's distance from the centerline in mm, left positive; got ${JSON.stringify(offsetMm)}.`);
  }
  if (typeof name !== 'string' || !name.trim() || name !== name.trim()) {
    throw new Error(`find_space's stripe takes name, the stripe's name for its ids and its constraint; got ${JSON.stringify(name)}.`);
  }
  const across = [offsetMm - widthMm / 2, offsetMm + widthMm / 2];
  const { hide, painted } = drawnBy(profile, design);
  const paints = [...new Set([...painted, role])];
  const { pieces, skipped } = bandPieces({ model, profile, role, band: across, name, hide, paints });
  const regions = pieces.map((p) => ({ id: p.id, treatment: 'stripe', panel: p.panel, at: p.at, constraints: { stripe: name } }));
  return {
    role, widthMm, offsetMm, name,
    regions,
    pieces: pieces.map((p) => ({ id: p.id, panel: p.panel, behindNoseMm: p.behindNose, carriesMm: p.carriesMm, errorMm: p.errorMm })),
    ...(skipped.length ? { skipped } : {}),
    findings: bandFindings({ profile, model, byRole: new Map([[role, regions]]), hide, paints }),
    ...(!regions.length ? {
      note: `A band ${widthMm} mm wide, ${offsetMm} mm from the centerline, crosses no panel of ${role} the world sees ` +
        'from above. Check the offset, or the sheet the panel named is on.',
    } : {}),
  };
}

/**
 * A ground-effect kit: the front splitter, the side skirts and the rear
 * diffuser, which is to say the car's lowest panels all the way round, from
 * the bottom of its bodywork up to `heightMm`. A Gulf car's orange kit is what
 * carries its colors in profile; its centre stripe runs over the top, where
 * a side view barely sees it.
 *
 * Panel by panel, and not as one band like `stripeLayout`'s, because the kit
 * is the car's own lowest panels in a color. On the NSX a band at one height
 * fitted the sill 56 mm off a straight line (its texture is laid on a slant),
 * took a sliver off the bottom of the door, and wrapped round the front of the
 * nose. So:
 *
 * - a panel the world sees lying wholly inside the height is part of the kit,
 *   and filled whole: the splitter's lip, the sills, the bumpers' lower
 *   corners, the diffuser;
 * - a taller panel on a flank, crossed by the height seen from that side, is
 *   drawn to the line of the kit's panel nearest it along the car, where a
 *   rectangle on it holds that line within AERO_FIT_MM, as the rear of the
 *   NSX's front wing does, so the skirt's top runs on rather than stepping;
 * - any other is left out, under `skipped`, with why: a door, which the line
 *   only grazes, or a panel laid out too unevenly to draw it on.
 */
export function aeroLayout({ profile, model, role, heightMm, name = 'aero', design = null }) {
  if (!(Number.isFinite(heightMm) && heightMm > 0)) {
    throw new Error(`find_space's aero needs heightMm, how far up the car the kit reaches from the bottom of the bodywork, in mm, above zero; got ${JSON.stringify(heightMm)}.`);
  }
  if (typeof name !== 'string' || !name.trim() || name !== name.trim()) {
    throw new Error(`find_space's aero takes name, the kit's name for its ids; got ${JSON.stringify(name)}.`);
  }
  const { hide, painted } = drawnBy(profile, design);
  const paints = [...new Set([...painted, role])];
  const flanks = [['left', 1], ['right', -1]].map(([side, sign]) => ({ side, sign,
    bottom: flankBottom(model, profile, role, sign, { hide, painted: paints, seen: AERO_SEEN }) })).filter((f) => f.bottom !== null);
  if (!flanks.length) {
    return { role, heightMm, name, regions: [], note: `Seen from either side, no panel of ${role} the world sees is in view.` };
  }
  const bottom = Math.min(...flanks.map((f) => f.bottom));
  const top = bottom + heightMm;
  const length = carLength(model, profile);
  const partOf = (on) => (on.across[0] < 0 && on.across[1] > 0
    ? ((on.behindNose[0] + on.behindNose[1]) / 2 < length / 2 ? 'front' : 'rear')
    // Touching the centerline from one side is that side.
    : on.across[0] >= 0 ? 'left' : 'right');

  const pieces = [];
  const skipped = [];
  const whole = new Set();
  // Glass on the body's sheet is not bodywork, told as the stripe's layout
  // tells it (`sheetOf`): a material that blends and is glass by its shader.
  const glass = (q) => {
    const mesh = q.source?.mesh ? model.meshes.find((m) => m.name === q.source.mesh) : null;
    const mat = mesh ? model.materials?.[mesh.materialId] : null;
    return Boolean(mat && blends(mat) && isGlass(mat.shader));
  };
  for (const [panel, q] of Object.entries(profile.panels?.[role] ?? {})) {
    const unknown = typeof q.visible !== 'number';
    if (!Array.isArray(q.rect) || q.hidden || (!unknown && q.visible < AERO_SEEN)) continue;
    // A panel's middle is inside its extent: one whose middle is above the kit
    // cannot lie inside it, and is not sampled to find that out.
    if (Array.isArray(q.centroid3d) && q.centroid3d[1] * 1000 > top + AERO_FIT_MM) continue;
    if (glass(q)) continue;
    const on = panelOnCar(model, profile, role, panel);
    // A panel the model has no geometry for is a profile out of step with
    // it, and said, as the flanks below say it, rather than dropped.
    if (!on || on.why) {
      skipped.push({ panel, why: on?.why ?? `${panel} lands on no geometry` });
      continue;
    }
    if (on.up[1] > top + AERO_FIT_MM) continue;
    // Said rather than dropped, as everything left out of the kit is: a panel
    // the profile never measured could be the kit or could be under the car.
    if (unknown) {
      skipped.push({ panel, upMm: on.up, why: `${panel} lies within the kit's height, but the profile has no measured ` +
        'visibility for it, so whether the world sees it could not be told; regenerate the profile with --from-kn5, ' +
        'and check it in a picture of the car meanwhile' });
      continue;
    }
    whole.add(panel);
    pieces.push({ id: `${name}-${panel}`, panel, at: [0, 0, 1, 1], part: partOf(on), whole: true, upMm: on.up, behindNoseMm: on.behindNose });
  }

  // A taller panel on a flank is drawn to the line of the kit nearest it along
  // the car, so the skirt's top runs on from the sill rather than stepping up
  // to the kit's height where the sill ends.
  const gapTo = (a, b) => Math.max(0, a[0] - b[1], b[0] - a[1]);
  for (const { side, sign } of flanks) {
    const kit = pieces.filter((p) => p.part === side);
    const crossed = stripePanels(model, profile, role, [bottom, top], { hide, painted: paints, side: sign, seen: AERO_SEEN });
    const seen = new Map(crossed.map((c) => [c.panel, c]));
    for (const c of crossed) {
      if (whole.has(c.panel) || skipped.some((k) => k.panel === c.panel)) continue;
      const on = panelOnCar(model, profile, role, c.panel);
      if (!on || on.why) {
        skipped.push({ panel: c.panel, why: on?.why ?? `${c.panel} lands on no geometry` });
        continue;
      }
      if (partOf(on) !== side) continue;          // the nose, the tail, or the far side
      // Too little of it seen from this side to fit a piece to, or never
      // measured: left out and said, as the stripe's layout says it.
      if (c.measured === false) {
        skipped.push({ panel: c.panel, upMm: on.up, why: c.why ?? `seen from the car's ${side} the kit's height covers at ` +
          `most ${c.carriesMm} mm of ${c.panel}, too little to fit a piece to or to tell its line by` });
        continue;
      }
      const near = kit.reduce((best, p) => (!best || gapTo(p.behindNoseMm, c.behindNose) < gapTo(best.behindNoseMm, c.behindNose) ? p : best), null);
      // Over the kit along the car rather than beside it — a door above its
      // sill — is not where the kit's line runs on: it would paint a band
      // along the door's foot, as it did on the Abarth's right side, whose sill
      // panel starts further forward than its left and so drew the line from
      // the sill's clear rear end.
      if (near) {
        const over = Math.min(c.behindNose[1], near.behindNoseMm[1]) - Math.max(c.behindNose[0], near.behindNoseMm[0]);
        if (over > 0.5 * (c.behindNose[1] - c.behindNose[0])) {
          skipped.push({ panel: c.panel, upMm: on.up, why: `${c.panel} lies over ${near.panel} along the car, above the ` +
            'kit rather than running on from it, so the kit leaves it alone' });
          continue;
        }
      }
      // The kit panel's top as the side view shows it at the end facing this
      // one, which is lower than its top where something stands in front of
      // it: on the NSX the door hangs over the sill's top edge, and a front
      // wing drawn to the sill's own top stepped up above the orange showing
      // beside it.
      const shown = near && seen.get(near.panel)?.seenTopMm;
      const end = shown && (c.behindNose[0] < near.behindNoseMm[0] ? shown.front : shown.back);
      const up = [bottom, near ? Math.min(top, near.upMm[1], end ?? Infinity) : top];
      // A panel whose bottom edge the line only grazes would carry a sliver.
      const got = on.up[0] <= up[1] - AERO_MIN_MM ? stripeAt(model, profile, role, c.panel, { up })
        : { at: null, why: `${c.panel} begins ${on.up[0]} mm up, and the kit's line at ${up[1]} mm would leave a sliver of under ${AERO_MIN_MM} mm on it` };
      // Beside the kit, where it meets it, a panel that curls away out of
      // sight is held to AERO_CURL_MM: the NSX's front wing ends in a curl in
      // front of the door's corner, and a rectangle on it strays 65 mm from the
      // line where it turns away, while its foot, the part seen, meets the
      // sill's orange. Left out, that foot was a blue sliver in the skirt.
      const beside = near && gapTo(near.behindNoseMm, c.behindNose) <= AERO_FIT_MM;
      const allowed = beside ? AERO_CURL_MM : AERO_FIT_MM;
      if (got.at && got.error <= allowed) {
        pieces.push({ id: `${name}-${c.panel}`, panel: c.panel, at: got.at, part: side, upMm: up, behindNoseMm: c.behindNose, errorMm: got.error });
        continue;
      }
      skipped.push({ panel: c.panel, upMm: on.up,
        why: got.at
          ? `${c.panel} reaches from ${on.up[0]} to ${on.up[1]} mm up, above the kit, and a rectangle on it strays ` +
            `${got.error} mm from the kit's top edge, over the ${allowed} mm a line along the car can take there.`
          : got.why });
    }
  }
  // Measured as check_fitment measures them, and a piece it would call unseen
  // left out: a panel's visibility is the whole island's, and on the RSS4 the
  // floor's rear panel is 18% visible while the part the kit fills, under the
  // engine cover, is 8% — a high finding in the planner's first check.
  if (pieces.length) {
    const regions = pieces.map((p) => ({ id: p.id, treatment: 'fill', panel: p.panel, ...(p.whole ? {} : { at: p.at }), safe: false, color: 'ink' }));
    const found = fitment({ name: 'aero', packs: ['core'], palette: { ink: '#101014' }, identity: {}, ...(hide.length ? { hide } : {}),
      paint: { ...Object.fromEntries(paints.map((r) => [r, { regions: [] }])), [role]: { regions } } }, profile, null, { model }).findings;
    const unseen = new Map();
    for (const f of found) if (f.kind === 'unseen' && f.severity === 'high') for (const id of f.ids ?? []) unseen.set(id, f.why);
    for (let i = pieces.length - 1; i >= 0; i--) {
      const why = unseen.get(pieces[i].id);
      if (!why) continue;
      skipped.push({ panel: pieces[i].panel, why: `left out of the kit: ${why}` });
      pieces.splice(i, 1);
    }
  }
  pieces.sort((a, b) => a.behindNoseMm[0] - b.behindNoseMm[0]);
  const parts = {};
  for (const p of pieces) (parts[p.part] ??= []).push(p.id);
  return {
    role, heightMm, name, upMm: [bottom, top],
    // `safe: false`: the kit is the whole panel, to its edge. Without it a
    // piece reaching past the panel's readable part, as a diffuser seen mostly
    // from behind does, was reported as high outside-safe, which run 25's
    // planner fixed by deleting the diffuser. A whole-panel fill is exempt
    // either way (`wholeFill`), since a planner copying these may drop it.
    // A whole panel carries no `at`: it is the default, and every region here
    // is copied out by the planner, a token at a time.
    regions: pieces.map((p) => ({ id: p.id, treatment: 'fill', panel: p.panel, ...(p.whole ? {} : { at: p.at }), safe: false })),
    parts,
    pieces: pieces.map(({ at, ...p }) => p),
    ...(skipped.length ? { skipped } : {}),
    ...(!pieces.length ? { note: `No panel of ${role} the world sees lies within ${heightMm} mm of the bottom of its bodywork.` } : {}),
  };
}

/**
 * How far a kit piece's top may stray from the kit's line: a whole panel
 * rising this far above it, or a rectangle on a taller one. Far below what a
 * step in a line along the car's bottom edge can hide, and the NSX's front
 * wing, the one panel it is drawn across, holds it to 3.
 */
const AERO_FIT_MM = 20;

/** How far a rectangle may stray on a panel that curls away beside the kit (see `aeroLayout`). */
const AERO_CURL_MM = 80;

/** The least of a taller panel a kit piece is laid on: less is a sliver along its bottom edge. */
const AERO_MIN_MM = 40;

/**
 * How visible a panel must be to be part of the kit. Below find_panels'
 * "visible" (0.35), because a diffuser is under the back of the car and seen
 * from behind it only: the NSX's is 0.23 to 0.29 visible, and without it the
 * kit stops at the rear wheels.
 */
const AERO_SEEN = 0.15;

/**
 * The pieces of a band along the car, one for each panel it crosses: across
 * the car seen from above, or with `side`, up a flank seen from that side.
 */
function bandPieces({ model, profile, role, band, name, hide, paints, side = 0, seenFrom = 'above' }) {
  const pieces = [];
  const skipped = [];
  for (const c of stripePanels(model, profile, role, band, { hide, painted: paints, side })) {
    if (c.measured === false) {
      skipped.push({ panel: c.panel, carriesMm: c.carriesMm,
        why: c.why ?? `seen from ${seenFrom} the band covers at most ${c.carriesMm} mm of ${c.panel} ` +
          `${side ? 'up the car' : 'across the car'} and ${c.behindNose[1] - c.behindNose[0]} mm along it, under 40 mm ` +
          'one way: too little to fit a piece to or to tell a gap by. Check it in a picture of the car, and add a ' +
          'piece by hand if the stripe needs one there.' });
      continue;
    }
    const got = stripeAt(model, profile, role, c.panel, side ? { up: band } : { across: band });
    if (got.at) pieces.push({ ...c, id: `${name}-${c.panel}`, at: got.at, errorMm: got.error });
    else skipped.push({ panel: c.panel, why: got.why });
  }
  return { pieces, skipped };
}

/**
 * What the stripe check finds with a layout's regions, on the car the layout
 * was read off: the design's hides, and its other sheets painted with nothing,
 * so the check draws what the layout saw.
 */
function bandFindings({ profile, model, byRole, hide, paints }) {
  if (![...byRole.values()].some((list) => list.length)) return [];
  const paint = Object.fromEntries(paints.map((r) => [r, { regions: [] }]));
  for (const [role, regions] of byRole) paint[role] = { regions: regions.map((r) => ({ ...r, color: 'ink' })) };
  return fitment({ name: 'stripe', packs: ['core'], palette: { ink: '#101014' }, identity: {}, ...(hide.length ? { hide } : {}),
    paint }, profile, null, { model })
    .findings.filter((f) => f.kind.startsWith('stripe-')).map((f) => `${f.severity} ${f.kind}: ${f.why}`);
}

/**
 * Region ids for layouts on several textures of one surface, by texture and
 * the id each layout gave: kept as they are, and a clash suffixed with the
 * texture it is on. Ids are named by panel, the RSS4's two body textures each
 * have a centre_tail, and two regions called centre-centre_tail made a design
 * the editor refused to load.
 */
function uniqueIds(each) {
  const taken = new Set();
  const out = new Map();
  for (const e of each) {
    for (const r of e.regions) {
      const id = taken.has(r.id) ? `${r.id}-${e.role}` : r.id;
      taken.add(id);
      out.set(`${e.role}\u0000${r.id}`, id);
    }
  }
  return out;
}

/**
 * A stripe laid over every texture of one surface, measured as one: the
 * RSS4's body is two, and the stripe runs over both. Each piece keeps the
 * texture it was laid on in `role` (see drawnOn). Without a width, sized to
 * the bodywork: a third of its width seen from above, 450 mm at most and 200
 * at least, which is 450 on a GT car and narrower on a formula car's nose.
 */
export function stripeLayoutAcross({ profile, model, roles, widthMm, offsetMm = 0, name = 'centre', design = null }) {
  const { hide, painted } = drawnBy(profile, design);
  const paints = [...new Set([...painted, ...roles])];
  const bodyMm = widthMm === undefined ? bodyWidthMm(model, profile, roles, { hide, painted: paints }) : null;
  let width = widthMm ?? (bodyMm ? Math.max(200, Math.min(450, Math.round((0.3 * bodyMm) / 10) * 10)) : 450);
  let each = roles.map((role) => stripeLayout({ profile, model, role, widthMm: width, offsetMm, name, design }));
  // Sized to the bodywork only where the pieces still line up at that width.
  // On the RSS4 a 310 mm band cut its rounded nose and cockpit part-way across
  // and four joins came out offset, where at 450 each of those panels carries
  // the band edge to edge and none does: the width that holds is used, and
  // the answer says why.
  let fell = null;
  if (widthMm === undefined && width < 450) {
    const joined = (list) => (roles.length > 1
      ? bandFindings({ profile, model, byRole: new Map(list.map((e) => [e.role, e.regions])), hide, paints })
      : list[0].findings).some((f) => f.startsWith('high'));
    if (joined(each)) {
      fell = `a ${width} mm stripe, a third of this bodywork's ${bodyMm} mm, did not line up across its panels, ` +
        'so it is 450 mm, which does';
      width = 450;
      each = roles.map((role) => stripeLayout({ profile, model, role, widthMm: width, offsetMm, name, design }));
    }
  }
  const ids = uniqueIds(each);
  const pin = (r, role) => (roles.length > 1 ? { ...r, id: ids.get(`${role}\u0000${r.id}`), role } : r);
  let byRole = new Map(each.map((e) => [e.role, e.regions.map((r) => pin(r, e.role))]));
  const skipped = each.flatMap((e) => (e.skipped ?? []).map((k) => ({ ...k, role: e.role })));
  // Measured as check_fitment measures them, and a piece it would call unseen
  // left out, as the kit leaves one out: seen from above, the RSS4's band
  // crosses a strip of floor behind the cockpit that trackside sees 2% of,
  // and the piece laid there was a high finding in the planner's first check.
  const unseen = new Map();
  if ([...byRole.values()].some((list) => list.length)) {
    const paint = Object.fromEntries(paints.map((r) => [r, { regions: [] }]));
    for (const [role, list] of byRole) paint[role] = { regions: list.map((r) => ({ ...r, color: 'ink' })) };
    for (const f of fitment({ name: 'stripe', packs: ['core'], palette: { ink: '#101014' }, identity: {}, ...(hide.length ? { hide } : {}),
      paint }, profile, null, { model }).findings) {
      if (f.kind === 'unseen' && f.severity === 'high') for (const id of f.ids ?? []) unseen.set(id, f.why);
    }
  }
  const out = new Set();
  if (unseen.size) {
    byRole = new Map([...byRole].map(([role, list]) => [role, list.filter((r) => {
      if (!unseen.has(r.id)) return true;
      skipped.push({ panel: r.panel, role, why: `left out of the stripe: ${unseen.get(r.id)}` });
      out.add(r.id);
      return false;
    })]));
  }
  const regions = [...byRole.values()].flat();
  return {
    roles, widthMm: width, ...(bodyMm ? { bodyWidthMm: bodyMm, sized: fell ?? 'to the bodywork, as no widthMm was given' } : {}),
    offsetMm, name, regions,
    pieces: each.flatMap((e) => e.pieces.map((p) => ({ ...p, id: roles.length > 1 ? ids.get(`${e.role}\u0000${p.id}`) : p.id, role: e.role })))
      .filter((p) => !out.has(p.id)),
    ...(skipped.length ? { skipped } : {}),
    findings: roles.length > 1 || out.size ? bandFindings({ profile, model, byRole, hide, paints }) : each[0].findings,
    ...(!regions.length ? { note: each.map((e) => e.note).filter(Boolean).join(' ') } : {}),
  };
}

/**
 * The ground-effect kit on every texture of one surface: each laid out on its
 * own (its lowest panels, its flanks), and each piece keeping its texture.
 */
export function aeroLayoutAcross({ profile, model, roles, heightMm, name = 'aero', design = null }) {
  const each = roles.map((role) => aeroLayout({ profile, model, role, heightMm, name, design }));
  if (roles.length === 1) return each[0];
  const parts = {};
  for (const e of each) for (const [k, ids] of Object.entries(e.parts ?? {})) (parts[k] ??= []).push(...ids);
  const skipped = each.flatMap((e) => (e.skipped ?? []).map((k) => ({ ...k, role: e.role })));
  const ids = uniqueIds(each);
  const idOf = (role, id) => ids.get(`${role}\u0000${id}`);
  for (const k of Object.keys(parts)) parts[k] = [];
  for (const e of each) for (const [k, list] of Object.entries(e.parts ?? {})) parts[k].push(...list.map((id) => idOf(e.role, id)));
  const regions = each.flatMap((e) => e.regions.map((r) => ({ ...r, id: idOf(e.role, r.id), role: e.role })));
  return {
    roles, heightMm, name, regions, parts,
    pieces: each.flatMap((e) => (e.pieces ?? []).map((p) => ({ ...p, id: idOf(e.role, p.id), role: e.role }))),
    upMm: Object.fromEntries(each.filter((e) => e.upMm).map((e) => [e.role, e.upMm])),
    ...(skipped.length ? { skipped } : {}),
    ...(!regions.length ? { note: each.map((e) => e.note).filter(Boolean).join(' ') } : {}),
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
