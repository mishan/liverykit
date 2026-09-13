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
  widthMm, heightMm = widthMm, marginMm = 0, count = 5, cellMm, across,
}) {
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new Error('find_space needs a size on the car: widthMm, and heightMm (which defaults to it), above zero.');
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
    if (candidates.length >= count || tried.length >= count * 3) break;
    if (tried.some((s) => overlapShare(s, shape) > 0.5)) continue;
    tried.push(shape);
    const at = [shape[0] / boxMm[0], shape[1] / boxMm[1], widthMm / boxMm[0], heightMm / boxMm[1]];
    const v = rectVisibility(model, prepared, g.meshes,
      [px + at[0] * pw, py + at[1] * ph, at[2] * pw, at[3] * ph], { across: 16 });
    const onCar = v ? v.samples / v.of : 0;
    const visible = v ? v.fraction : 0;
    if (onCar < CLEAN || visible < CLEAN) continue;
    candidates.push({ at: at.map(r3), marginMm: Math.round(clearance), onCar: r2(onCar), visible: r2(visible) });
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
  const g = grid ?? cleanGrid({ profile, model, prepared, role, panel,
    ...(cellMm ? { cellMm } : {}), ...(across ? { across } : {}) });
  let lo = 0, hi = Math.min(g.boxMm[0], g.boxMm[1] / aspect);
  let largest = null, sizesTried = 0;
  while (hi - lo > precisionMm && sizesTried < 16) {
    sizesTried++;
    const w = (lo + hi) / 2;
    const r = findSpace({ grid: g, model, prepared, widthMm: w, heightMm: w * aspect, marginMm, count: 1 });
    if (r.candidates.length) {
      lo = w;
      // Reported at a size that was itself measured. Rounded to the nearest
      // millimetre, the size could be larger than the shape that passed, and
      // the spot, clearance and fractions beside it were for another shape.
      const fw = Math.floor(w), fh = Math.floor(w * aspect);
      const at = fw > 0 && fh > 0 ? findSpace({ grid: g, model, prepared, widthMm: fw, heightMm: fh, marginMm, count: 1 }) : null;
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

/**
 * How far rectangle `a` can grow on every side before it touches `b`: zero
 * when they touch or overlap. The larger of the two gaps, not the diagonal,
 * because minMargin grows the box by the same amount on every side, and a
 * cell 40 mm off both a side and the top is inside a box grown by 50 mm even
 * though it is 57 mm away diagonally.
 */
const gap = (a, b) => Math.max(0, b[0] - a[2], a[0] - b[2], b[1] - a[3], a[1] - b[3]);

/** How much of rectangle `a` rectangle `b` covers. */
const overlapShare = (a, b) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return (w * h) / ((a[2] - a[0]) * (a[3] - a[1]));
};

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
