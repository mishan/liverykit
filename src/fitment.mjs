// ---------------------------------------------------------------------------
// What is wrong with this design ON THIS CAR.
//
// `portability.mjs` asks whether a design's placement rules FIND anything on a
// car. This asks the next question, and the harder one: having found somewhere,
// is that somewhere any good.
//
// Every finding here is measured rather than judged. The editor already shows
// you the car and you can see for yourself whether a livery looks right — what
// you cannot see, from any angle, is that the driver's name has landed on the
// twelve percent of a door that a number plate stands in front of. That is a
// fact about geometry, it is computable, and until now nothing computed it.
//
// The motivating mistake was mine. Asked to improve a fit, I moved a team name
// out of a collision with the race number and into a part of the same panel
// that cannot be seen. Every number I had said the move was fine: the panel is
// 88% visible, has no `safe` rectangle, and anisotropy 1.0. The panel was the
// wrong unit. A placement is a rectangle, and the question has to be asked of
// the rectangle.
//
// Nothing here writes anything or renders anything. It returns findings, and
// the editor, the MCP and a test all read the same ones.
// ---------------------------------------------------------------------------

import { resolveTargets, expandRegions, resolveRect, texture, metresAcross } from './profile.mjs';
import { applyFit } from './fit.mjs';
import { occupancyFor, rectVisibility } from './engine/visibility.mjs';
import { meshesUsingTexture, vertex } from './engine/kn5.mjs';
// From the editor's op module, because the BROWSER needs this list too — to
// build the controls and to refuse a constraint nothing enforces — and
// `fitment.mjs` is not one of the files served to it. One list, so the thing
// the editor lets you write and the thing this checks cannot drift apart.
export { CONSTRAINTS } from './ui/ops.js';
import { CONSTRAINTS } from './ui/ops.js';

/**
 * How little of a placement may be visible before it is worth saying so.
 *
 * Not zero. A rectangle clipped by a wheel arch at one corner is normal and
 * fine; one that is four percent visible is a name nobody will ever read, and
 * the two want telling apart. Held here rather than inline so the threshold is
 * a decision with a name instead of a number in a condition.
 */
const BARELY_SEEN = 0.35;

/** Below this a line of text is a smudge on the car, whatever it says. */
const TOO_SMALL_MM = 25;

/**
 * How much of a placement must land on actual bodywork.
 *
 * A uv rectangle is a rectangle in the TEXTURE, and a texture is mostly not the
 * car: islands are irregular, and the space between them is painted by nobody.
 * Artwork sitting in that space is rendered, looks perfect in the uv view, and
 * does not exist on the car.
 *
 * This is what happened to the team name. The move measured 86% VISIBLE — of
 * the 11% of it that was on the model. Visibility was answering honestly about
 * a sliver, and nothing was asking about the rest.
 */
const MUST_LAND_ON = 0.6;

/**
 * The same bar for artwork that is not carrying a message.
 *
 * Far lower, because a fill or a stripe SHOULD bleed off the island — a panel's
 * rect is the bounding box of an irregular shape, and painting only the inscribed
 * part would leave gaps at the edges. The first version of this check applied
 * one bar to everything and reported eight findings on a real design, all eight
 * being one background grid doing exactly what a background grid does. A check
 * that has to be ignored teaches you to ignore it, which is how the finding that
 * mattered would have been lost in the noise.
 *
 * A word, though, is either on the car or it is not.
 */
const BLEED_IS_FINE_BELOW = 0.15;

/**
 * What a region may declare about where it is allowed to end up.
 *
 * On the DESIGN rather than the fit, so it travels: "this is a team name, keep
 * artwork off it and never shrink it below 40 mm" is true of the design on
 * every car, and restating it per car is how it goes stale on the third one.
 *
 *   keepClear   nothing may be painted across this, whatever the treatment.
 *               The overlap check otherwise only speaks up for text on text —
 *               so a stripe drawn over a team name was invisible to it.
 *   minMm       the shortest side this must not go below ON THE CAR, replacing
 *               the global 25 mm floor for this region. A team name and a
 *               sponsor logo do not have the same legibility.
 *   minOnCar    the fraction of the box that must land on actual geometry,
 *               replacing the default. A background fill is meant to bleed off
 *               an island; a name is not.
 */

/**
 * A region's declared constraints, or a complaint that it tried and failed.
 *
 * A misspelled constraint is the worst thing this module could contain: it
 * reads as a rule being enforced and behaves as no rule at all, which is the
 * silent pass this project exists to refuse. `keepclear` is not `keepClear`,
 * and saying so is cheaper than wondering why the stripe still crosses.
 */
function constraintsOf(region, id, t, say) {
  const c = region.constraints;
  if (c === undefined) return {};
  if (c === null || typeof c !== 'object' || Array.isArray(c)) {
    say({ kind: 'bad-constraint', severity: 'fatal', surface: t.from, ids: [id],
      why: `${name(t, id)} has constraints: ${JSON.stringify(c)}. It must be an object, ` +
        `e.g. constraints: { keepClear: true }.` });
    return {};
  }
  for (const k of Object.keys(c)) {
    // hasOwn, not `in`. `'toString' in CONSTRAINTS` is true through the
    // prototype chain, so a region declaring `constraints: { toString: 1 }`
    // would have been accepted as a real rule and enforced as nothing.
    if (Object.hasOwn(CONSTRAINTS, k)) continue;
    say({ kind: 'bad-constraint', severity: 'fatal', surface: t.from, ids: [id],
      why: `${name(t, id)} declares a constraint called ${JSON.stringify(k)}, which nothing ` +
        `enforces. Known constraints: ${Object.keys(CONSTRAINTS).join(', ')}.` });
  }
  return c;
}

/**
 * Everything this design and this car have to say to each other.
 *
 * `model` is optional and is the difference between the checks that need
 * geometry and the ones that do not. Without it the visibility checks report
 * themselves as NOT RUN rather than as passing — a design that has never been
 * checked and a design that has been checked and is clean must not look alike,
 * which is the same distinction `metresAcross` draws between "not measured"
 * and zero.
 */
export function fitment(design, profile, fit = null, { model = null } = {}) {
  const findings = [];
  const say = (f) => findings.push(f);

  let targets;
  try {
    ({ targets } = resolveTargets(profile, design));
  } catch (e) {
    return { car: profile.id, checked: [], notChecked: ['everything'], findings: [
      { kind: 'unresolvable', severity: 'fatal', why: e.message },
    ] };
  }

  // Prepared once for the whole car, not once per region: the occupancy grid is
  // the expensive part of a visibility question and it does not depend on which
  // rectangle is being asked about.
  const seen = model ? { model, prepared: occupancyFor(model) } : null;

  const failed = [];
  for (const t of targets) {
    const spec = t.spec ?? {};

    // WHICH TEXTURE, not just which surface.
    //
    // One surface term can bind several texture roles — `surfaces.body` on a
    // formula car resolves to `body` AND `bodyRear` — and the design paints
    // every one of them, so a region really does land more than once, on
    // different parts of the car. That is two problems, not a double-counted
    // one. But every finding carried only `surface`, which is the same string
    // for both, so they arrived as exact duplicates and read like a bug in the
    // checker. The role is what tells them apart, and it is also what somebody
    // needs in order to go and look at the right sheet.
    const sayHere = (f) => say({ role: t.role, ...f });

    // Per TARGET, so one broken surface does not hide the findings on the rest
    // — and so the run says which surface went unchecked instead of returning a
    // short list of findings that reads like a clean bill of health.
    let placed;
    try {
      placed = placements(profile, t, spec, fit);
    } catch (e) {
      failed.push(t.from);
      say({
        kind: 'unresolvable', severity: 'fatal', surface: t.from, ids: [],
        why: `${t.from} could not be placed on this car, so nothing about it ` +
          `was checked: ${e.message}`,
      });
      continue;
    }

    // Parsed once, before any check reads them, so a misspelled constraint is
    // reported rather than quietly enforcing nothing.
    for (const p of placed) p.constraints = constraintsOf(p.region, p.id, t, sayHere);

    overlaps(placed, t, sayHere);
    outsideSafe(placed, profile, t, sayHere);
    unreadable(placed, profile, t, sayHere);
    unmirrored(placed, profile, t, sayHere);
    if (seen) unseen(placed, profile, t, seen, sayHere);
  }

  // Across surfaces rather than within one, so it cannot live in the loop above.
  if (model) stacked(model, profile, targets, say);

  return {
    car: profile.id,
    name: profile.name || profile.id,
    checked: model ? ALL_CHECKS : ALL_CHECKS.filter((c) => !['unseen', 'off-mesh', 'unpainted-twin'].includes(c)),
    // Named, so "no findings" cannot be mistaken for "nothing was skipped".
    notChecked: model ? [] : ['unseen', 'off-mesh', 'unpainted-twin'],
    // Surfaces that threw. Empty is the answer callers want; non-empty means
    // the findings below cover less of the car than they appear to.
    notPlaced: failed,
    findings,
  };
}

const ALL_CHECKS = ['overlap', 'outside-safe', 'unreadable', 'unmirrored', 'unseen',
  'off-mesh', 'crossed', 'bad-constraint', 'unpainted-twin'];

/**
 * Where each region actually lands, after the fit has had its say.
 *
 * The FITTED regions, not the design's — a fit exists precisely to move things,
 * and checking where the design wanted them would report problems nobody has
 * and miss the ones they do. `applyFit` then `expandRegions`, which is the same
 * order `renderSurface` uses, because any other order asks about a car nobody
 * is looking at.
 */
function placements(profile, t, spec, fit) {
  // `surfaceKey` is not optional in practice. Fit ids for unnamed regions are
  // `${surfaceKey}#${index}` — omitting it produced `#0`, which matches nothing
  // a fit ever wrote, so every override and copy on an unnamed region was
  // silently skipped and this module checked the design's own coordinates while
  // claiming to check the fitted ones.
  const fitted = applyFit(spec.regions ?? [], fit, {
    profile, role: t.role, surfaceKey: t.from,
  }).regions;
  // No try/catch. An invalid design is a finding, not an absence of them, and
  // swallowing this here made a livery that cannot be resolved at all look
  // identical to one that is clean. The caller turns the throw into a `fatal`.
  const expanded = expandRegions(profile, t.role, fitted);
  const out = expanded.regions.filter((r) => r.panel).map((r, i) => {
    let frac = null;
    try {
      frac = resolveRect(profile, t.role, r);
    } catch { /* a panel this car lacks; portability reports that one */ }
    // A region with no `id` is addressed by position, and a TAG selection
    // becomes one entry per matching panel — so position alone is not unique
    // once expanded, and two different placements can print the same name. The
    // panel disambiguates them, which is also what somebody would need in order
    // to go and find the thing being complained about.
    return { region: r, key: r.id ?? r.__key ?? `${t.from}#${i}`, frac, constraints: {} };
  }).filter((p) => p.frac);

  // `expandRegions` runs AFTER `applyFit`, so one region selecting by TAG
  // becomes several placements all carrying the key that was stamped before
  // anyone knew there would be more than one. Two findings would name the same
  // region and at least one would send you to the wrong panel.
  //
  // The panel is appended only where a key is genuinely shared. A key that
  // appears once is the key a FIT writes, and is what somebody needs in order
  // to go and change the thing being complained about — qualifying it
  // unconditionally would have made every id unique and none of them usable.
  const seenTimes = new Map();
  for (const p of out) seenTimes.set(p.key, (seenTimes.get(p.key) ?? 0) + 1);
  for (const p of out) {
    p.id = seenTimes.get(p.key) > 1 ? `${p.key}@${p.region.panel}` : p.key;
  }
  return out;
}

/**
 * Two regions painted over each other.
 *
 * Later paints over earlier, so the one underneath is the one damaged, and it
 * is worth naming both — "the number is under the team name" is actionable and
 * "two regions overlap" is not.
 *
 * Only pairs on the SAME panel and only where the overlap is a real share of
 * the smaller one. Artwork is layered on purpose all the time: a fill under a
 * halftone under a stripe is the design working. What is not on purpose is one
 * line of text landing on another, which is why this is measured against the
 * smaller box rather than reported for any intersection at all.
 */
function overlaps(placed, t, say) {
  for (let a = 0; a < placed.length; a++) {
    for (let b = a + 1; b < placed.length; b++) {
      const A = placed[a], B = placed[b];
      if (A.region.panel !== B.region.panel) continue;
      const over = intersect(A.frac, B.frac);
      if (!over) continue;
      const smaller = Math.min(area(A.frac), area(B.frac));
      const share = over / (smaller || 1);
      if (share < 0.25) continue;

      // AT LEAST ONE MUST BE TEXT, or this reports the design working.
      //
      // Layering is how a livery is built: a fill under a halftone under a
      // grid under scanlines, every one of them covering the whole sheet and
      // every pair overlapping completely. The first run of this check
      // produced thirty findings on a real design, twenty-eight of which were
      // "the artwork is on top of the artwork". A checker that has to be
      // ignored is worse than no checker, because it teaches you to ignore it.
      //
      // Text is different because it means something. A number under a team
      // name is not a layer, it is one of them lost, and neither can be read.
      const aText = A.region.treatment === 'text';
      const bText = B.region.treatment === 'text';

      // Unless one of them ASKED not to be covered. A design knows things the
      // treatment name cannot express — a cyan stripe running the length of the
      // flank is artwork by every measure here, and a team name is still lost
      // underneath it. `keepClear` is how a region says so once, on the design,
      // for every car it will ever be fitted to.
      const clearA = !!A.constraints.keepClear, clearB = !!B.constraints.keepClear;
      if (!aText && !bText && !clearA && !clearB) continue;

      const bothText = aText && bText;
      // Later paints over earlier, so B is on top and A is the one damaged.
      const crossed = clearA ? A : clearB ? B : null;
      const guarded = crossed && !bothText;

      say({
        kind: guarded ? 'crossed' : 'overlap',
        severity: bothText || guarded ? 'high' : 'low',
        surface: t.from,
        panel: A.region.panel,
        ids: [A.id, B.id],
        share: round(share),
        why: guarded
          ? `${name(t, crossed === A ? B.id : A.id)} covers ${(share * 100).toFixed(0)}% of ` +
            `${name(t, crossed.id)}, which asked to be kept clear`
          : `${name(t, B.id)} covers ${(share * 100).toFixed(0)}% of ${name(t, A.id)}` +
            (bothText ? ', and both are text' : ''),
      });
    }
  }
}

/**
 * Artwork outside the part of a panel that measurement found readable.
 *
 * `safe` is the UV bounds of the vertices that passed the visibility cast when
 * the profile was generated, so a region straying outside it is on geometry
 * that was measured and found wanting. Regions may say `safe: false` and mean
 * it — a background fill should reach the island's edge — so that is honoured
 * rather than argued with.
 */
function outsideSafe(placed, profile, t, say) {
  for (const p of placed) {
    if (p.region.safe === false) continue;
    const pan = p.frac.panel;
    if (!pan?.safe) continue;
    const inside = intersect(p.frac, rectOf(pan.safe));
    const share = inside / (area(p.frac) || 1);
    if (share > 0.9) continue;
    say({
      kind: 'outside-safe',
      severity: share < 0.5 ? 'high' : 'low',
      surface: t.from,
      panel: p.region.panel,
      ids: [p.id],
      share: round(share),
      why: `${(100 - share * 100).toFixed(0)}% of ${p.id} is outside the readable part of ` +
        `${p.region.panel}, which measurement put at [${pan.safe.map(round).join(', ')}]`,
    });
  }
}

/**
 * Text too small to read on the car.
 *
 * Needs `metresPerUv`, which only profiles regenerated since it existed carry —
 * so this reports nothing rather than guessing on an older one. The height is
 * the region's box, not the glyphs: `text` fits itself to the box and may end
 * up smaller, so this is an upper bound and a clean one. If the box is 20 mm
 * the lettering cannot be bigger than that.
 */
function unreadable(placed, profile, t, say) {
  for (const p of placed) {
    // A declared floor applies to ANY treatment, because a design that says
    // "never smaller than 40 mm" knows something about its artwork that the
    // word `text` does not carry — a sponsor mark is not text and still has a
    // size below which it is a smudge.
    const declared = typeof p.constraints.minMm === 'number' ? p.constraints.minMm : null;
    if (declared === null && p.region.treatment !== 'text') continue;
    const m = metresAcross(p.frac);
    if (!m) continue;
    const mm = Math.min(m.w, m.h) * 1000;
    const floor = declared ?? TOO_SMALL_MM;
    if (mm >= floor) continue;
    say({
      kind: 'unreadable',
      severity: declared !== null || mm < floor / 2 ? 'high' : 'low',
      surface: t.from,
      panel: p.region.panel,
      ids: [p.id],
      mm: Math.round(mm),
      why: declared !== null
        ? `${p.id} is ${Math.round(mm)} mm across on the car, and it asked for at least ` +
          `${declared} mm`
        : `${p.id} is ${Math.round(mm)} mm across on the car, which is under the ` +
        `${TOO_SMALL_MM} mm a line of text needs to read at any distance`,
    });
  }
}

/**
 * A pair that ought to mirror and does not.
 *
 * Only for regions whose ids differ by left/right, because that is the design
 * stating its own symmetry — much better evidence than guessing from geometry,
 * since two regions on mirrored panels can be deliberately different and often
 * are. Compared in PANEL-relative terms, so it holds however the unwrapper laid
 * the two islands out.
 */
function unmirrored(placed, profile, t, say) {
  const by = new Map(placed.map((p) => [p.id, p]));
  for (const p of placed) {
    const other = /left/.test(p.id) ? p.id.replace('left', 'right') : null;
    if (!other || !by.has(other)) continue;
    const q = by.get(other);

    const a = p.region.at ?? [0, 0, 1, 1];
    const b = q.region.at ?? [0, 0, 1, 1];
    // The convention the fits already follow: a v-flip about the panel.
    const want = 1 - (a[1] + a[3]);
    if (Math.abs(want - b[1]) < 0.02 && Math.abs(a[3] - b[3]) < 0.02
      && Math.abs(a[0] - b[0]) < 0.02 && Math.abs(a[2] - b[2]) < 0.02) continue;
    say({
      kind: 'unmirrored',
      severity: 'low',
      surface: t.from,
      ids: [p.id, other],
      why: `${p.id} is at [${a.map(round).join(', ')}] and ${other} at ` +
        `[${b.map(round).join(', ')}]; a mirrored pair would put ${other} at y ${round(want)}`,
    });
  }
}

/**
 * A placement nobody can see.
 *
 * The check the rest of this file exists for. A panel's `visible` is one number
 * for the whole rectangle, so an 88% visible door says nothing about the 12%
 * standing behind a number plate — and on the Honda NSX the plate meshes do
 * exactly that to the front doors.
 *
 * Cast at the placement's own rectangle, through the same grid and the same
 * forty-nine directions the profile was built with, so this and `visible` are
 * the same measurement asked at different scales rather than two opinions.
 */
function unseen(placed, profile, t, seen, say) {
  const file = texture(profile, t.role).file;
  const meshes = meshesUsingTexture(seen.model, file);
  if (!meshes.length) return;

  for (const p of placed) {
    const at = [p.frac.x, p.frac.y, p.frac.w, p.frac.h];
    const answer = rectVisibility(seen.model, seen.prepared, meshes, at);

    // Nothing there at all: the rectangle is off the model entirely, which is
    // not a visibility verdict and must not be reported as one.
    if (!answer) {
      say({
        kind: 'off-mesh', severity: p.region.treatment === 'text' ? 'high' : 'low',
        surface: t.from, panel: p.region.panel, ids: [p.id], coverage: 0,
        why: `${name(t, p.id)} lands on no geometry at all — it is painted into ` +
          'texture space this car does not use, so none of it appears',
      });
      continue;
    }

    // Partly there. Reported before visibility, because "86% visible" of a
    // tenth of a placement is a true sentence that misleads completely, and
    // whichever of the two is said first is the one that gets acted on.
    const coverage = answer.samples / answer.of;
    const carries = p.region.treatment === 'text';
    const asked = typeof p.constraints.minOnCar === 'number' ? p.constraints.minOnCar : null;
    if (coverage < (asked ?? (carries ? MUST_LAND_ON : BLEED_IS_FINE_BELOW))) {
      say({
        kind: 'off-mesh', severity: asked !== null || carries ? 'high' : 'low',
        surface: t.from, panel: p.region.panel,
        ids: [p.id], coverage: Math.round(coverage * 100) / 100,
        why: `${name(t, p.id)} has only ${Math.round(coverage * 100)}% of its area ` +
          'on the car — the rest is texture space no triangle uses, and is painted nowhere' +
          (asked !== null ? `; it asked for at least ${Math.round(asked * 100)}%` : ''),
      });
      continue;
    }
    if (answer.fraction >= BARELY_SEEN) continue;
    say({
      kind: 'unseen',
      severity: answer.fraction < 0.1 ? 'high' : 'low',
      surface: t.from,
      panel: p.region.panel,
      ids: [p.id],
      visible: round(answer.fraction),
      samples: answer.samples,
      why: `${p.id} is ${(answer.fraction * 100).toFixed(0)}% visible from trackside ` +
        `(${answer.samples} points cast), on a panel measured at ` +
        `${((p.frac.panel?.visible ?? 1) * 100).toFixed(0)}% — so it is in the part ` +
        'of the panel something else stands in front of',
    });
  }
}

/**
 * A region's name as somebody would go and look for it.
 *
 * A region with no `id` is addressed by position — `#6` — which is meaningless
 * on its own when the design paints eight surfaces. Qualified with the surface
 * it becomes something you can find.
 */
const name = (t, id) => (String(id).startsWith('#') ? `${t.from}${id}` : id);

const area = (r) => r.w * r.h;
const rectOf = ([x, y, w, h]) => ({ x, y, w, h });
const round = (n) => Math.round(n * 1000) / 1000;

function intersect(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

// ---------------------------------------------------------------------------
// Surfaces that occupy the same piece of car.
//
// The failure that produced this. Asked where the race number should go, I
// measured every candidate plate and recommended the one scoring 69% visible
// and 100% on the mesh. Both numbers were true. Painting it put a black slab
// across the door, because this car ships FOUR number plate sets — IGT, IMSA
// and two Blancpain variants — all rendering at once in the same patch of
// bodywork, each with an emissive duplicate at identical coordinates.
//
// Every check above asks about a rectangle in a texture: can it be seen, is it
// on the mesh, does other artwork cross it. None of them can see this, because
// the problem is not in the texture at all. It is that two textures are painted
// onto geometry standing in the same place, and which one you get is a draw
// order nobody controls.
//
// Cheap to detect and, once you have the model, obvious: compare world bounds.
// ---------------------------------------------------------------------------

/** Mean surface normal, which says which way a sheet looks. */
function facing(model, mesh) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const p = vertex(model, mesh, i);
    x += p.nx; y += p.ny; z += p.nz;
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Padded world AABB. Padded because plates are FLAT — a zero-thickness box has
 *  zero volume, and every overlap against it would divide by nothing. */
function bounds(model, mesh, pad = 0.005) {
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.vertexCount; i++) {
    const p = vertex(model, mesh, i);
    for (const [k, v] of [[0, p.x], [1, p.y], [2, p.z]]) {
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  for (let k = 0; k < 3; k++) { lo[k] -= pad; hi[k] += pad; }
  return { lo, hi };
}

const volume = (b) => (b.hi[0] - b.lo[0]) * (b.hi[1] - b.lo[1]) * (b.hi[2] - b.lo[2]);

/** How much of the SMALLER box sits inside the larger one, 0 to 1. */
function share(a, b) {
  let overlap = 1;
  for (let k = 0; k < 3; k++) {
    const d = Math.min(a.hi[k], b.hi[k]) - Math.max(a.lo[k], b.lo[k]);
    if (d <= 0) return 0;
    overlap *= d;
  }
  const smaller = Math.min(volume(a), volume(b));
  return smaller > 0 ? overlap / smaller : 0;
}

/**
 * NEAR-IDENTICAL, and nothing weaker.
 *
 * Two earlier versions of this check are worth recording, because both failed
 * the same way and the second failure is what fixed the design.
 *
 * First: report any painted surface whose bounds overlap another texture's by
 * half. Thirty-odd findings on a real design, nearly all of them a bounding box
 * doing what bounding boxes do — a steering wheel sits INSIDE the cockpit's
 * box, a roof banner's box reaches the windshield.
 *
 * Second: add "both must be thin sheets of similar size", on the reasoning that
 * the offending surfaces are plates and decals rather than solids. Still noisy,
 * and the reason is the important part: a car is BUILT from co-located sheets.
 * Decals sit on the bumper. Headlight glass sits in the bumper shell. Damage
 * overlays sit on everything. Geometrically those are indistinguishable from
 * four number plate sets stacked on a door, because geometrically they are the
 * same arrangement. One is how a car is modelled and one is a mistake, and no
 * amount of box comparison can tell you which.
 *
 * So the broad check is not shipped. What is shipped is the narrow one, which
 * has a signal the broad one lacks: a colour sheet and its emissive twin are
 * not overlapping, they are the SAME surface twice, to within a millimetre. If
 * you paint one and not the other, the car's own artwork is drawn over yours.
 * That is the black slab, and it is the specific thing that went wrong.
 */
const A_TWIN = 0.92;           // shared volume, over the smaller box
const SAME_SIZE = 0.9;         // smaller volume over larger
/**
 * And they must FACE THE SAME WAY.
 *
 * The last two false positives were DOOR_Left against DOOR_Left_INT, and the
 * hood's outer shell against its inner. Same box to within a percent, because
 * they are the two sides of one panel — and not the problem at all, since you
 * cannot see both at once.
 *
 * A colour sheet and its emissive twin face the same way, being the same
 * surface drawn twice. An inner shell faces the other way. That is structural
 * rather than tuned, and it is the difference between "this panel has a back"
 * and "this panel is drawn twice and you only painted one of them".
 */
const SAME_FACING = 0.5;

function stacked(model, profile, targets, say) {
  const painted = new Map();                    // texture file -> role that paints it
  for (const t of targets) {
    const file = texture(profile, t.role)?.file;
    if (file) painted.set(file.toLowerCase(), { role: t.role, from: t.from });
  }

  // Bounds once per mesh, keyed by the texture it wears.
  const byFile = new Map();
  for (const mesh of model.meshes ?? []) {
    const file = (model.materials?.[mesh.materialId]?.slots?.txDiffuse ?? '').toLowerCase();
    if (!file) continue;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ mesh, box: bounds(model, mesh), face: facing(model, mesh) });
  }

  // Reported once per PAIR OF TEXTURES, not per pair of meshes. Four plate sets
  // with emissive twins is forty-odd overlapping mesh pairs and four facts.
  const said = new Set();
  for (const [file, { role, from }] of painted) {
    for (const mine of byFile.get(file) ?? []) {
      for (const [other, theirs] of byFile) {
        if (other === file) continue;
        const pair = `${file}|${other}`;
        if (said.has(pair)) continue;
        for (const q of theirs) {
          // Painted already? Then both sheets carry your artwork and which one
          // shows does not matter nearly as much.
          if (painted.has(other)) continue;
          const va = volume(mine.box), vb = volume(q.box);
          if (Math.min(va, vb) / Math.max(va, vb) < SAME_SIZE) continue;
          const s = share(mine.box, q.box);
          if (s < A_TWIN) continue;
          const dot = mine.face[0] * q.face[0] + mine.face[1] * q.face[1] + mine.face[2] * q.face[2];
          if (dot < SAME_FACING) continue;      // an inner shell, not a twin
          said.add(pair);

          say({
            kind: 'unpainted-twin',
            severity: 'high',
            role, surface: from, ids: [],
            share: Math.round(s * 100) / 100,
            with: other,
            why: `${role} is painted onto ${mine.mesh.name}, and ${q.mesh.name} sits in the ` +
              `same place — ${Math.round(s * 100)}% of the same volume — wearing ${other}, ` +
              'which this design does not paint. The car\'s own artwork is drawn over yours ' +
              'there, and which of the two shows is not yours to decide.',
          });
          break;
        }
      }
    }
  }
}
