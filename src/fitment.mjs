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

import { resolveTargets, expandRegions, resolveRect, texture, metresNarrowest, metresAcross, spanPlacements, panel as panelOf, panelName, axesOf } from './profile.mjs';
import { applyFit } from './fit.mjs';
import { getPack } from './registry.mjs';
import { hidePlan, hideTakesEffect } from './hide.mjs';
import { occupancyFor, rectVisibility, carOccluders, sampleRects } from './engine/visibility.mjs';
import { polyArea, sharedArea, rectPoly, inPoly } from './engine/poly.mjs';
import { meshesUsingTexture, vertex, triangles, blends, isGlass } from './engine/kn5.mjs';
import { colord, extend } from 'colord';
import namesPlugin from 'colord/plugins/names';
// From the editor's op module, because the BROWSER needs this list too — to
// build the controls and to refuse a constraint nothing enforces — and
// `fitment.mjs` is not one of the files served to it. One list, so the thing
// the editor lets you write and the thing this checks cannot drift apart.
export { CONSTRAINTS } from './ui/ops.js';
import { CONSTRAINTS } from './ui/ops.js';

// CSS colour names, as the palette accepts them (see ui/uses.js).
extend([namesPlugin]);

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
 *   minVisible  the fraction of the box that must be seen from trackside,
 *               replacing the 35% below which `unseen` speaks up. Being on the
 *               car is not being visible: a roundel measured 99% on the door
 *               and had its top strip 44% visible, under the window frame, and
 *               nothing said so.
 *   minMargin   millimetres of clean bodywork all round: with that much added
 *               on every side, the box must still be on the car and seen. A
 *               roundel does not sit against a shut line or tuck its top edge
 *               under a window frame, and "not too close to an edge" is only a
 *               rule once it has a number.
 */

/**
 * Fields on a region that nothing will read.
 *
 * The renderer hands a treatment the whole region as `ctx.opts` and the
 * treatment takes what it wants, so a field it does not know is carried along
 * and ignored. An agent spent four rounds making a race number bigger with
 * `options: { scale: 1.5 }` — a wrapper no treatment reads — and the number
 * stayed exactly the size it was, with every check passing, because nothing
 * about a field that does nothing is measurable. Same shape as a misspelled
 * constraint, which is already refused for the same reason.
 *
 * Known is what the treatment DESCRIBES plus what the placement code itself
 * reads. A treatment its pack does not describe is left alone: there is
 * nothing to compare against, and guessing would report fields that work.
 *
 * Not `drop`. It was listed here because the editor offers it, but only a fit
 * reads it, so `drop: true` on a design region removed nothing and passed.
 * `optional` is, because the expander reads it: missing from this list, it made
 * the shipped portable design's piping a high finding on every car.
 */
const PLACEMENT_FIELDS = new Set([
  'id', 'treatment', 'panel', 'tags', 'at', 'rotate', 'scale', 'safe',
  'span', 'once', 'limit', 'optional', 'constraints', '__key',
]);

/** What a treatment describes, by the design's own packs, later packs winning. */
function describedOptions(design, treatment) {
  let options = null;
  for (const name of design.packs ?? ['core']) {
    let pack;
    try {
      pack = getPack(name);
    } catch { continue; }                     // an unknown pack is reported where it is loaded
    if (!pack.treatments[treatment]) continue;
    options = pack.describe?.[treatment]?.options ?? null;
  }
  return options;
}

function unknownFields(regions, t, design, say) {
  regions.forEach((region, i) => {
    if (!region || typeof region !== 'object') return;
    const options = describedOptions(design, region.treatment);
    if (!options) return;
    const id = region.id ?? `${t.from}#${i}`;
    for (const field of Object.keys(region)) {
      if (PLACEMENT_FIELDS.has(field) || Object.hasOwn(options, field)) continue;
      const instead = field === 'options'
        ? ` Options go on the region itself — e.g. "scale": 1.5 — not inside "options".`
        : field === 'drop'
          ? ` drop belongs in a fit, which is what removes a region on one car: "regions": { "${id}": { "drop": true } }.`
          : Object.hasOwn(CONSTRAINTS, field)
            ? ` ${field} is a constraint: write "constraints": { "${field}": ${JSON.stringify(region[field])} }.`
            : '';
      say({
        kind: 'unknown-field', severity: 'high', surface: t.from, ids: [id], field,
        why: `${id} has "${field}", which ${region.treatment} does not take and nothing else reads, ` +
          `so it does nothing.${instead} ${region.treatment} takes: ${Object.keys(options).join(', ') || 'no options'}.`,
      });
    }
  });
}

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

  // The VALUE too, not only the name. `keepClear: 'yes'` is truthy and reads as
  // a rule in force; `minMm: NaN` fails every comparison it is put in and so
  // enforces nothing. Both are the same silent pass as a misspelled name, and
  // checking the name alone was half a check.
  const bad = (k, why) => say({
    kind: 'bad-constraint', severity: 'fatal', surface: t.from, ids: [id],
    why: `${name(t, id)} has ${k}: ${JSON.stringify(c[k])}, which ${why}`,
  });
  const kept = {};
  for (const [k, v] of Object.entries(c)) {
    if (!Object.hasOwn(CONSTRAINTS, k)) continue;          // already reported
    if (k === 'keepClear') {
      if (typeof v !== 'boolean') { bad(k, 'must be true or false.'); continue; }
    } else if (k === 'groupWith') {
      if (typeof v !== 'string' || !v.trim()) { bad(k, 'must be the id of another region.'); continue; }
      if (v === region.id) { bad(k, 'names this region itself.'); continue; }
    } else if (k === 'stripe') {
      // A name, not `true`: the name is what makes three regions on three
      // panels one stripe, and a piece measured against no neighbours would
      // pass a check that never looked at where the pieces meet.
      if (typeof v !== 'string' || !v.trim() || v !== v.trim()) {
        bad(k, 'must be the stripe\'s name, shared exactly by every piece of it, e.g. "centre".'); continue;
      }
    } else if (typeof v !== 'number' || !Number.isFinite(v)) {
      bad(k, 'must be a number.'); continue;
    } else if ((k === 'minOnCar' || k === 'minVisible') && (v < 0 || v > 1)) {
      bad(k, 'must be a fraction between 0 and 1.'); continue;
    } else if ((k === 'minMm' || k === 'minMargin') && v <= 0) {
      bad(k, 'must be a size in millimetres above zero.'); continue;
    }
    kept[k] = v;
  }
  // Only what survived: a refused constraint must not go on to be enforced
  // half-way by whatever check reads it next.
  return kept;
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
    return { car: profile.id, checked: [], notChecked: ['everything'], unsupported: [], findings: [
      { kind: 'unresolvable', severity: 'fatal', why: e.message },
    ] };
  }

  // Prepared once for the whole car, not once per region: the occupancy grid is
  // the expensive part of a visibility question and it does not depend on which
  // rectangle is being asked about.
  const seen = model ? { model, prepared: preparedFor(model, profile) } : null;

  const failed = [];
  let wantsMargin = false;
  let wantsStripe = false;
  // A check that could not measure one region, by name. It used to skip the
  // region and stay in `checked`, so a name nobody measured read exactly
  // like one that passed.
  const unmeasured = [];
  // And which of those the car's PROFILE could not support, so a gate can
  // tell them from a check the draft kept from running. RSS4's helmet has no
  // scale, and a gate that failed every unmeasured name failed every round
  // with a driver name on it, whatever the planner drafted.
  const unsupported = [];
  const skip = (s, cannot = null) => {
    unmeasured.push(s);
    if (cannot) unsupported.push({ ...cannot, notChecked: s });
  };
  // Every surface's placements, for the one check that asks about two regions
  // that may be on different surfaces.
  const all = [];
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
    unknownFields(spec.regions ?? [], t, design, sayHere);

    // Per TARGET, so one broken surface does not hide the findings on the rest
    // — and so the run says which surface went unchecked instead of returning a
    // short list of findings that reads like a clean bill of health.
    let placed;
    try {
      placed = placements(profile, t, spec, fit, sayHere);
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
    if (placed.some((p) => typeof p.constraints.minMargin === 'number')) wantsMargin = true;
    if (placed.some((p) => typeof p.constraints.stripe === 'string')) wantsStripe = true;
    all.push({ t, placed });

    const size = texSize(profile, t.role);
    overlaps(placed, t, sayHere, size, design.identity ?? {});
    ringOverflow(placed, t, sayHere);
    contrast(placed, t, design, sayHere, size);
    outsideSafe(placed, profile, t, sayHere);
    hiddenFace(placed, profile, t, sayHere);
    unreadable(placed, profile, t, sayHere, skip);
    tooSmall(placed, t, sayHere, size, design.identity ?? {}, skip);
    unmirrored(placed, profile, t, sayHere);
    if (seen) unseen(placed, profile, t, seen, sayHere);
    if (seen) margins(placed, profile, t, seen, sayHere);
  }

  // Across surfaces rather than within one, so these cannot live in the loop above.
  grouped(all, design, fit, profile, say);
  stripes(all, profile, seen, say, skip);
  if (model) stacked(model, profile, targets, say, { design });

  return {
    car: profile.id,
    name: profile.name || profile.id,
    checked: model ? ALL_CHECKS : ALL_CHECKS.filter((c) => !NEEDS_MODEL.includes(c)),
    // Named, so "no findings" cannot be mistaken for "nothing was skipped".
    notChecked: [...(model ? [] : ['unseen', 'off-mesh', 'unpainted-twin', ...(wantsMargin ? ['margin'] : []),
      ...(wantsStripe ? ['stripe-offset', 'stripe-gap'] : [])]), ...unmeasured],
    // The entries of notChecked that nothing in a design can make run, each
    // with the entry it explains. Still in notChecked, so nothing that reads
    // only that stops seeing them.
    unsupported,
    // Surfaces that threw. Empty is the answer callers want; non-empty means
    // the findings below cover less of the car than they appear to.
    notPlaced: failed,
    findings,
  };
}

/**
 * The occupancy grid for a car, built once and kept with the model.
 *
 * It depends on the geometry and on which meshes the car hides, not on the
 * design, and it was being rebuilt for every call: an agent checks a draft a
 * dozen times a round, and each paid a second for the same grid. Keyed on the
 * model object, so a model that is let go takes its grid with it.
 */
/**
 * How tall each text region's capitals are on the car, in millimetres, by the
 * arithmetic `too-small` holds them to: `{ mm, shrunk }` by placement id, or
 * `{ why }` where the letters cannot be measured.
 *
 * For a caller laying text out rather than checking it. find_space's group
 * layout sizes a number and a name to clear the floors, and a copy of this
 * arithmetic there would drift from the check it has to pass, which is how
 * `inkBox` and `letterSize` once came apart.
 */
export function letterHeights(design, profile, fit = null) {
  const out = {};
  const { targets } = resolveTargets(profile, design);
  for (const t of targets) {
    const size = texSize(profile, t.role);
    for (const p of placements(profile, t, t.spec ?? {}, fit)) {
      if (p.region.treatment !== 'text') continue;
      const got = letterSize(p, size, design.identity ?? {});
      out[p.id] = got.why ? { why: got.why } : { mm: got.mm, shrunk: got.shrunk };
    }
  }
  return out;
}

const preparedCache = new WeakMap();
function preparedFor(model, profile) {
  const hides = JSON.stringify(Object.keys(profile?.hiddenByCar?.meshes ?? {}).sort());
  let byHides = preparedCache.get(model);
  if (!byHides) preparedCache.set(model, (byHides = new Map()));
  if (!byHides.has(hides)) byHides.set(hides, occupancyFor(model, { occluders: carOccluders(model, profile) }));
  return byHides.get(hides);
}

const ALL_CHECKS = ['unmatched', 'unknown-field', 'overflows', 'margin', 'overlap', 'low-contrast', 'outside-safe', 'hidden-face', 'unreadable', 'too-small', 'ungrouped', 'unmirrored',
  'unseen', 'off-mesh', 'crossed', 'clipped', 'bad-constraint', 'unpainted-twin', 'stripe-across', 'stripe-offset', 'stripe-gap'];

/** The checks that stand on the car's geometry, and do not run without its model. */
const NEEDS_MODEL = ['unseen', 'off-mesh', 'unpainted-twin', 'margin', 'stripe-offset', 'stripe-gap'];

/**
 * Where each region actually lands, after the fit has had its say.
 *
 * The FITTED regions, not the design's — a fit exists precisely to move things,
 * and checking where the design wanted them would report problems nobody has
 * and miss the ones they do. `applyFit` then `expandRegions`, which is the same
 * order `renderSurface` uses, because any other order asks about a car nobody
 * is looking at.
 */
function placements(profile, t, spec, fit, say = () => {}) {
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
  // A region that lands NOWHERE, said out loud.
  //
  // Both of these used to vanish here: the tag selection's note was dropped
  // on the floor, and a panel this car lacks was caught and returned as no
  // placements. So a design whose every region selected a tag the car does
  // not have — an agent wrote `tags: ['left', 'body']` for three rounds
  // running — came back with no findings at all, and read as a clean pass
  // over a car that was still bare primer. Nothing about artwork that paints
  // nothing is measurable, which is exactly why it has to be a finding.
  //
  // A region a tiled material refuses is the same news — the build skips it
  // and the portability report lists it — and forwarding only `no-match` let
  // that design through as clean. An `optional` miss is not forwarded: the
  // design said, in the file, that it may find nothing.
  for (const n of expanded.notes) {
    if (n.status !== 'no-match' && n.status !== 'unplaceable') continue;
    say({ kind: 'unmatched', severity: 'high', surface: t.from, ids: [n.id ?? t.from], why: n.text });
  }
  const out = expanded.regions.flatMap((r, i) => {
    let frac = null;
    try {
      frac = resolveRect(profile, t.role, r);
    } catch (e) {
      // Which of the two it was, asked of the panel directly. `resolveRect`
      // checks `at` before it looks the panel up, and labelling every throw as
      // a missing panel sent a region with an `at` past its edge, on a panel
      // the car has, looking for a panel that was never missing.
      let missing = null;
      if (r.panel) {
        try { panelOf(profile, t.role, r.panel); } catch (p) { missing = p; }
      }
      say({ kind: 'unmatched', severity: 'high', surface: t.from, panel: r.panel,
        ids: [r.id ?? r.__key ?? `${t.from}#${i}`],
        why: missing
          ? `${r.id ?? 'a region'} names a panel this car does not have, so it paints nothing: ${missing.message}`
          : `${r.id ?? 'a region'} cannot be placed as written, so it paints nothing: ${e.message}` });
      return [];
    }
    if (!frac) return [];
    // A region with no `id` is addressed by position, and a TAG selection
    // becomes one entry per matching panel — so position alone is not unique
    // once expanded, and two different placements can print the same name. The
    // panel disambiguates them, which is also what somebody would need in order
    // to go and find the thing being complained about.
    const key = r.id ?? r.__key ?? `${t.from}#${i}`;
    // A spanning region is several placements: the piece on each panel it
    // reaches, each checked where it actually lies. Checking the home
    // rectangle alone would report the part past the panel's edge as
    // off-mesh, which is the one place it is meant to be.
    if (r.span === true && frac.panel) {
      // A span the car cannot honour is clipped to its home panel and reported
      // — see spanPlacements. It is a finding here as well as a note in the
      // render, because this is where somebody looks to find out what is wrong
      // with a design on a car, and "the band stops at the door's edge" is
      // exactly that.
      const clipped = [];
      const pieces = spanPlacements(profile, t.role, r.panel, frac, { notes: clipped });
      for (const n of clipped) {
        say({
          kind: 'clipped',
          // Words stop being words when half of them is missing; a band that
          // stops short is wrong and legible.
          severity: r.treatment === 'text' || r.treatment === 'radialText' ? 'high' : 'low',
          surface: t.from,
          panel: r.panel,
          ids: [key],
          why: n.text,
        });
      }
      return pieces.map((p) => ({
        region: { ...r, panel: p.panel },
        key,
        spilled: p.hops > 0,
        // The box AND the shape. Every check below measures the shape where
        // there is one: a piece that arrived through a seam is a parallelogram
        // filling roughly half the box drawn around it, and the box's half
        // that is not artwork was being reported as overlapping its
        // neighbours, off the mesh, and big enough to read.
        frac: {
          ...p.on,
          poly: p.poly,
          anisotropy: panelOf(profile, t.role, p.panel).anisotropy ?? 1,
          panel: panelOf(profile, t.role, p.panel),
        },
        constraints: {},
      }));
    }
    return [{ region: r, key, frac, constraints: {} }];
  });

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
function overlaps(placed, t, say, size = { w: 1, h: 1 }, identity = {}) {
  for (let a = 0; a < placed.length; a++) {
    for (let b = a + 1; b < placed.length; b++) {
      const A = placed[a], B = placed[b];
      if (A.region.panel !== B.region.panel) continue;
      const over = intersect(A.frac, B.frac);
      if (!over) continue;
      const smaller = Math.min(area(A.frac), area(B.frac));
      const share = over / (smaller || 1);

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

      // A RING and some text: measured by the circle, not by the boxes.
      //
      // The box of a halo contains the box of the number it surrounds, and it
      // contains the box of a number it runs straight through — the two
      // overlap identically, so this said "low" about both and the agent
      // called it intended. The question is whether an edge of the circle
      // crosses the text: a number wholly inside a solid disc, or wholly
      // inside a ring's hole, is a roundel or a halo doing its job.
      //
      // Unless the ring is painted AFTER the text. Later paints over earlier,
      // and asking only about edges let a solid disc painted over a number
      // pass as a roundel: it has no edge inside the number and hides all of
      // it. On top, any of the stroke landing on the text is the finding.
      const aRing = A.region.treatment === 'ring', bRing = B.region.treatment === 'ring';
      if ((aRing && bText) || (bRing && aText)) {
        const [ring, text] = aRing ? [A, B] : [B, A];
        if (bRing && ringOnText(ring, text, size, identity)) {
          say({
            kind: 'overlap', severity: 'high', surface: t.from, panel: A.region.panel,
            ids: [ring.id, text.id], share: round(share),
            why: `${name(t, ring.id)} paints over ${name(t, text.id)}: the ring comes later in the design, ` +
              'so its stroke is drawn on top of the text. Move the text after the ring, or the ring off it.',
          });
        } else if (ringThroughText(ring, text, size, identity)) {
          say({
            kind: 'overlap', severity: 'high', surface: t.from, panel: A.region.panel,
            ids: [ring.id, text.id], share: round(share),
            why: `${name(t, ring.id)}'s circle runs through ${name(t, text.id)}: an edge of the ring ` +
              'crosses the text. Put the text wholly inside the ring, or move the ring outside it.',
          });
        }
        continue;
      }

      // After the circle, not before. A threshold on the boxes is what keeps
      // layering quiet, and it ran first: a ring whose box met a name's at one
      // corner, 12.5% of the smaller, was turned away while its stroke ran
      // straight through the name.
      if (share < 0.25) continue;

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
 * How much of a placement's surroundings must be on the car, and seen, to
 * count as clean. Not 1, for the same reason as find_space's cells: samples on
 * the rim of the grown box sit on boundaries, and a strict 100% fails a
 * placement for a rounding error rather than for an edge.
 */
export const MARGIN_CLEAN = 0.98;

/**
 * Clean bodywork all round a placement, when it asked for some.
 *
 * The rule a person applies without thinking and an agent cannot apply at all,
 * because a panel's box is not the panel: on the NSX the top quarter of the
 * door's box is not door and its middle is under the window line. `minMargin`
 * gives the rule a number, and this measures it the same way `unseen` does —
 * the box grown by the margin on every side must be on the car and visible.
 */
/**
 * Samples every few millimetres across a placement, for a region that has said
 * it must be whole.
 *
 * Samples sit at cell centres, so a grid of N leaves a band half a cell wide
 * round the edge that nothing tests — and the edge is where things intrude.
 * At the default fourteen across, a 680 mm team name on the NSX door had its
 * outer 24 mm unmeasured, and the door handle ran through its last letter in
 * the last 14 mm. A region asking to be 100% seen is owed a measurement that
 * could find the 1% that is not.
 *
 * `null` without a scale, or for a region that asked nothing: the default grid
 * answers "is this mostly seen", which is the question those regions put.
 */
/** A percentage that does not round a shortfall away: 99.9% seen is not 100%. */
const pct = (x) => (x < 1 && Math.round(x * 100) === 100
  ? (Math.floor(x * 1000) / 10).toFixed(1)
  : (x * 100).toFixed(0));

/** What stands on top of the paint, by name — the thing to move away from. */
const underWhat = (answer) => {
  const u = Object.entries(answer?.under ?? {}).sort((a, b) => b[1] - a[1]);
  return u.length ? `; ${u.map(([m, n]) => `${n} of its points are directly under ${m}`).join(', ')}` : '';
};

export const FINE_MM = 5;
function fineGrid(p, w = p.frac.w, h = p.frac.h) {
  const c = p.constraints;
  if (typeof c.minVisible !== 'number' && typeof c.minOnCar !== 'number' && typeof c.minMargin !== 'number') return null;
  const mpu = p.frac.panel?.metresPerUv;
  if (!(mpu?.[0] > 0 && mpu?.[1] > 0)) return null;
  const n = (uv, s) => Math.max(14, Math.min(160, Math.ceil((uv * s * 1000) / FINE_MM)));
  return [n(w, mpu[0]), n(h, mpu[1])];
}

function margins(placed, profile, t, seen, say) {
  let meshes = null;
  for (const p of placed) {
    const m = p.constraints.minMargin;
    if (typeof m !== 'number') continue;
    const mpu = p.frac.panel?.metresPerUv;
    if (!(mpu?.[0] > 0 && mpu?.[1] > 0)) {
      say({ kind: 'margin', severity: 'high', surface: t.from, panel: p.region.panel, ids: [p.id],
        why: `${name(t, p.id)} asks for ${m} mm of margin, and its panel has no measured scale ` +
          '(metresPerUv) to turn millimetres into texture: regenerate the profile with --from-kn5.' });
      continue;
    }
    try {
      meshes ??= meshesUsingTexture(seen.model, texture(profile, t.role).file);
    } catch {
      return;                                  // reported as unresolvable by `unseen`
    }
    const gx = m / 1000 / mpu[0], gy = m / 1000 / mpu[1];
    const f = p.frac;
    const answer = rectVisibility(seen.model, seen.prepared, meshes,
      [f.x - gx, f.y - gy, f.w + 2 * gx, f.h + 2 * gy], { grid: fineGrid(p, f.w + 2 * gx, f.h + 2 * gy) });
    const onCar = answer ? answer.samples / answer.of : 0;
    const visible = answer ? answer.fraction : 0;
    if (onCar >= MARGIN_CLEAN && visible >= MARGIN_CLEAN) continue;
    say({
      kind: 'margin', severity: 'high', surface: t.from, panel: p.region.panel, ids: [p.id],
      margin: m, onCar: round(onCar), visible: round(visible),
      why: `${name(t, p.id)} does not have ${m} mm of clean bodywork all round: with that margin added ` +
        `on every side, ${pct(onCar)}% is on the car and ${pct(visible)}% is ` +
        `seen from trackside${underWhat(answer)}. Move it away from the edge or make it smaller; find_space lists spots that fit.`,
    });
  }
}

/** The texture's size in pixels, for the checks that need a circle to be round. */
function texSize(profile, role) {
  try {
    const tx = texture(profile, role);
    return { w: tx.width || 1, h: tx.height || 1 };
  } catch {
    return { w: 1, h: 1 };
  }
}

/** A ring's centre, and the inner and outer edges of its stroke, in pixels. */
function ringGeometry(p, size) {
  const R = p.frac;
  const s = Math.min(R.w * size.w, R.h * size.h);
  const r = (p.region.radius ?? 0.4) * s, w = (p.region.width ?? 0.03) * s;
  return {
    cx: (R.x + R.w / 2) * size.w, cy: (R.y + R.h / 2) * size.h,
    inner: Math.max(0, r - w / 2), outer: r + w / 2, half: s / 2,
  };
}

/**
 * Where a text placement's letters are, in pixels: not its box.
 *
 * The core text treatment sets the letters at `scale` (0.7) of the box's
 * height, shrinks them until an estimated advance fits the width, centres
 * them and puts the baseline at 0.78 of the height. So a number's box is
 * mostly air at the corners, and a ring tested against the box failed a
 * roundel a person had laid out by hand, whose "85" sat well inside the disc.
 * Worked out the same way here, but estimated wider than the treatment does
 * (0.72 em a glyph against its 0.62), so an error leans toward the ring
 * touching. At an angle that is not a quarter turn the answer is the whole
 * box.
 *
 * A quarter turn used to be the whole box too, while `letterSize` handled it —
 * so on the Abarth's doors, which measure 90 and 270, a number in a roundel
 * got the high overlap this exists to prevent. Both now take the frame from
 * `textFrame`, so they cannot drift apart again.
 */
function inkBox(p, size, identity = {}) {
  const T = p.frac;
  const x0 = T.x * size.w, y0 = T.y * size.h, w = T.w * size.w, h = T.h * size.h;
  const box = [x0, y0, x0 + w, y0 + h];
  const o = p.region;
  if (o.treatment !== 'text') return box;
  const f = textFrame(p, size, identity);
  if (!f) return box;
  const { s, turn, em, ax } = f;
  // The frame the treatment draws in, about the box's centre (see render.mjs).
  const cx = x0 + w / 2, cy = y0 + h / 2;
  const fx = cx - f.w / 2, fy = cy - f.h / 2;
  const inkW = Math.min(f.w, s.length * em * (0.72 + (o.tracking ?? 0.08)) * ax);
  const anchor = o.anchor ?? 'middle';
  const left = anchor === 'start' ? fx : anchor === 'end' ? fx + f.w - inkW : fx + (f.w - inkW) / 2;
  const base = fy + f.h * 0.78;
  const top = base - 0.75 * em;
  const bottom = base + (/[a-z]/.test(s) ? 0.22 * em : 0.02 * em);
  // Then turned as SVG's rotate(turn, cx, cy) turns it: (dx, dy) goes to
  // (-dy, dx) at 90, y being down.
  const turned = [[left, top], [left + inkW, bottom]].map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    return turn === 90 ? [cx - dy, cy + dx] : turn === 180 ? [cx - dx, cy - dy]
      : turn === 270 ? [cx + dy, cy - dx] : [x, y];
  });
  const [[ax0, ay0], [ax1, ay1]] = turned;
  return [Math.max(x0, Math.min(ax0, ax1)), Math.max(y0, Math.min(ay0, ay1)),
    Math.min(x0 + w, Math.max(ax0, ax1)), Math.min(y0 + h, Math.max(ay0, ay1))];
}

/**
 * How the text treatment sets a placement's letters, in the frame it draws
 * them in: `w` along the line and `h` across it, which on a panel laid a
 * quarter turn are the box's height and width, and the font size `em` after
 * shrinking to fit. Null where there are no letters or the turn is not a
 * multiple of a quarter.
 *
 * "auto" is whatever turn the panel's unwrap needs, which the profile states.
 */
function textFrame(p, size, identity) {
  const T = p.frac, o = p.region;
  const asked = o.rotate === 'auto' ? (T.panel?.textRotation ?? 0) : (o.rotate ?? 0);
  const turn = ((Number(asked) % 360) + 360) % 360;
  if (turn % 90 !== 0) return null;
  const s = String(o.text ?? '').replace(/\{(\w+)\}/g, (_, k) => String(identity?.[k] ?? ''));
  if (!s.trim()) return null;
  const quarter = turn === 90 || turn === 270;
  const w = quarter ? T.h * size.h : T.w * size.w;
  const h = quarter ? T.w * size.w : T.h * size.h;
  const an = T.anisotropy ?? T.panel?.anisotropy;
  const ax = o.aspect ?? (an ? 1 / an : 1);
  let em = h * (o.scale ?? 0.7);
  let shrunk = false;
  if (o.fit !== false) {
    const est = s.length * em * (0.62 + (o.tracking ?? 0.08)) * ax;
    if (est > w) { em *= w / est; shrunk = true; }
  }
  return { s, turn, quarter, w, h, em, ax, shrunk };
}

/**
 * The pieces of a design that are meant to be seen whole, as shapes on their
 * texture — for `inView`, which counts how much of each a picture of the car
 * shows.
 *
 * Text is its letters (`inkBox`), not its box: a number's box is mostly air,
 * and a corner of it under a window frame hides nothing anybody would miss. A
 * ring is its stroke, which for a filled disc is the disc. Anything else that
 * declares minVisible is its placed shape. Fills and stripes are meant to bleed
 * off an edge and are not asked about.
 *
 * Placed exactly as `fitment` places them, fit and all. A surface that cannot
 * be placed is skipped here because `fitment` reports it, in the same answer.
 */
export function wholePieces(design, profile, fit = null) {
  const out = [];
  let targets;
  try {
    ({ targets } = resolveTargets(profile, design));
  } catch {
    return out;
  }
  for (const t of targets) {
    let placed;
    try {
      placed = placements(profile, t, t.spec ?? {}, fit);
    } catch {
      continue;
    }
    const size = texSize(profile, t.role);
    for (const p of placed) {
      const tr = p.region.treatment;
      const c = constraintsOf(p.region, p.id, t, () => {});
      const minVisible = typeof c.minVisible === 'number' ? c.minVisible : null;
      let box; let contains; let what; let text = null;
      if (tr === 'text') {
        text = String(p.region.text ?? '').replace(/\{(\w+)\}/g, (_, k) => String(design.identity?.[k] ?? ''));
        if (!text.trim()) continue;
        const [x0, y0, x1, y1] = inkBox(p, size, design.identity ?? {});
        box = [x0 / size.w, y0 / size.h, x1 / size.w, y1 / size.h];
        contains = (u, v) => u >= box[0] && u <= box[2] && v >= box[1] && v <= box[3];
        what = `the text "${text}"`;
      } else if (tr === 'ring') {
        const g = ringGeometry(p, size);
        box = [(g.cx - g.outer) / size.w, (g.cy - g.outer) / size.h, (g.cx + g.outer) / size.w, (g.cy + g.outer) / size.h];
        contains = (u, v) => {
          const d = Math.hypot(u * size.w - g.cx, v * size.h - g.cy);
          return d >= g.inner && d <= g.outer;
        };
        what = g.inner > 0 ? `a ring in ${p.region.color ?? 'its colour'}` : `a disc in ${p.region.color ?? 'its colour'}`;
      } else if (minVisible !== null) {
        const poly = shapeOf(p.frac);
        box = [Math.min(...poly.map((q) => q[0])), Math.min(...poly.map((q) => q[1])),
          Math.max(...poly.map((q) => q[0])), Math.max(...poly.map((q) => q[1]))];
        contains = (u, v) => inPoly(poly, [u, v]);
        what = tr;
      } else continue;
      out.push({ id: p.id, role: t.role, surface: t.from, panel: p.region.panel, treatment: tr, what, text,
        minVisible, box, contains });
    }
  }
  return out;
}

/** A ring's stroke, and how near and how far from its centre a text placement's letters reach. */
function ringAndText(ring, text, size, identity = {}) {
  const g = ringGeometry(ring, size);
  const [x0, y0, x1, y1] = inkBox(text, size, identity);
  const nearest = Math.hypot(Math.max(x0, Math.min(g.cx, x1)) - g.cx, Math.max(y0, Math.min(g.cy, y1)) - g.cy);
  const farthest = Math.max(...[[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => Math.hypot(x - g.cx, y - g.cy)));
  return { g, nearest, farthest };
}

/** Whether either edge of a ring's stroke passes through the letters of a text placement. */
function ringThroughText(ring, text, size, identity = {}) {
  const { g, nearest, farthest } = ringAndText(ring, text, size, identity);
  const crosses = (edge) => edge > 0 && nearest < edge && edge < farthest;
  return crosses(g.inner) || crosses(g.outer);
}

/** Whether any of a ring's stroke lands on the letters of a text placement. */
function ringOnText(ring, text, size, identity = {}) {
  const { g, nearest, farthest } = ringAndText(ring, text, size, identity);
  return nearest < g.outer && farthest > g.inner;
}

/**
 * Lettering in a colour too close to what is painted under it.
 *
 * Measured, not judged. Round one of three runs in a row failed on the team
 * name for this and nothing else: white script on Gulf blue, then thin orange
 * on Gulf blue, each reported by the critic a whole round after it was
 * drafted. The design says what colour the letters are and what is painted
 * beneath them, so the contrast is arithmetic, and a planner told while it is
 * still drafting fixes it before it submits. 3:1 is WCAG's floor for large
 * text: Gulf orange on Gulf blue is 1.4, white on it 2.3; white on the orange,
 * or navy on the blue, clears it.
 *
 * What is under the letters is the last region painted before them that
 * covers their centre. If that is a treatment whose colour at that point is
 * not one known colour (a halftone, a gradient, a logo), nothing is said:
 * a guess would be a finding somebody learns to ignore.
 */
const CONTRAST_FLOOR = 3;

function luminance({ r, g, b }) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
}

const contrastRatio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function contrast(placed, t, design, say, size) {
  const palette = design.palette ?? {};
  // Whatever the palette accepts, which is anything colord parses. Only
  // `#rrggbb` used to be read, so `#fff`, `steelblue` or the text treatment's
  // own default of `white` switched the check off without a word.
  const rgb = (c) => {
    const v = palette[c] ?? c;
    const parsed = typeof v === 'string' ? colord(v) : null;
    return parsed?.isValid() ? parsed.toRgb() : null;
  };
  // What `q` paints at (x, y), in texture fractions: a colour name, undefined
  // where it paints nothing there, or null where it paints something whose
  // colour is not one known colour.
  const paintAt = (q, x, y) => {
    const f = q.frac;
    if (x < f.x || x > f.x + f.w || y < f.y || y > f.y + f.h) return undefined;
    const tr = q.region.treatment;
    // The core treatments' own defaults where a region names no colour, as
    // they paint it (packs/core.mjs). A fill with none used to be "not one
    // known colour", and the lettering on it went unmeasured.
    if (tr === 'fill') return q.region.color ?? 'pink';
    if (tr === 'stripe') return q.region.color ?? 'cyan';
    if (tr === 'ring') {
      const g = ringGeometry(q, size);
      const d = Math.hypot(x * size.w - g.cx, y * size.h - g.cy);
      return d >= g.inner && d <= g.outer ? (q.region.color ?? 'cyan') : undefined;
    }
    if (tr === 'text') return undefined;          // letters over letters: overlap's business
    return null;
  };
  for (const [i, p] of placed.entries()) {
    if (p.region.treatment !== 'text' || p.region.glow) continue;
    const inkName = p.region.color ?? 'white';     // the text treatment's default
    const ink = rgb(inkName);
    if (!ink) continue;
    const cx = p.frac.x + p.frac.w / 2, cy = p.frac.y + p.frac.h / 2;
    // Black where none is declared, because that is what render.mjs paints.
    let underName = t.spec?.background ?? 'black', what = 'the surface\'s background';
    for (let j = i - 1; j >= 0; j--) {
      const c = paintAt(placed[j], cx, cy);
      if (c === undefined) continue;
      underName = c;
      what = placed[j].id;
      break;
    }
    const under = underName ? rgb(underName) : null;
    if (!under) continue;
    const ratio = contrastRatio(ink, under);
    if (ratio >= CONTRAST_FLOOR) continue;
    say({
      kind: 'low-contrast', severity: 'high', surface: t.from, panel: p.region.panel,
      ids: [p.id], contrast: round(ratio),
      why: `${name(t, p.id)} is ${inkName} on ${underName} (${what}): a contrast of ${ratio.toFixed(1)}:1, and ` +
        `lettering needs at least ${CONTRAST_FLOOR}:1 to read from trackside. Use a dark colour on a light base, ` +
        'white on a dark one, or put a band of a contrasting colour behind it.',
    });
  }
}

/**
 * A ring drawn past its own box.
 *
 * Every check here measures the region's box — how much of it is on the car,
 * how much is visible, what it overlaps — and the ring treatment's stroke is
 * centred on its radius, so it reaches radius + width/2 of the box's shorter
 * side while the box ends at half. A roundel of radius 0.5 and width 0.5
 * painted a white band out to 0.75: a quarter of the box's size beyond the
 * rectangle its minOnCar 1 and minVisible 1 were measured on, so those passed
 * about a box while the paint went somewhere else. With constraints declared
 * the guarantee is void and that is high; without, it is bleed, and low.
 */
function ringOverflow(placed, t, say) {
  for (const p of placed) {
    if (p.region.treatment !== 'ring') continue;
    const reach = (p.region.radius ?? 0.4) + (p.region.width ?? 0.03) / 2;
    if (reach <= 0.5 + 1e-9) continue;
    const declared = Object.keys(p.constraints ?? {}).length > 0;
    say({
      kind: 'overflows', severity: declared ? 'high' : 'low', surface: t.from, panel: p.region.panel,
      ids: [p.id], reach: round(reach),
      why: `${name(t, p.id)} draws its ring out to ${round(reach)} of its box's shorter side, past the ` +
        'box\'s edge at 0.5, and every check here measures the box, so the part outside it is unchecked' +
        (declared ? ' — including the constraints it declares' : '') +
        '. Keep radius + width/2 at or under 0.5 (a filled disc is radius 0.25, width 0.5), or enlarge the box.',
    });
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
 * Artwork on the face of a sheet nobody outside the car can see.
 *
 * A two-sided part shares ONE texture between the side the world sees and the
 * side only the driver does. This Honda's windscreen banner is exactly that:
 * EXT_Banner and INT_Banner on one sheet, the outward face in its top half and
 * the underside plus the interior mesh in its bottom. A team name placed in
 * sheet coordinates landed in the bottom half, read perfectly from the driver's
 * seat, and appeared nowhere from outside. Nothing said so; it took somebody
 * noticing it from the wrong seat.
 *
 * `unseen` looks as though it should have caught it and cannot. That check
 * casts at the placement's BOX, and a box straddling both faces collects
 * enough visible samples from the outward half to pass while every glyph
 * inside it sits on the inward one.
 *
 * Panel rects are bounding boxes and overlap each other, so the shares here are
 * the largest single panel of each kind rather than a sum — summing would
 * credit more area than the placement has.
 *
 * SILENT where the whole sheet is out of sight. An interior, a tub, the
 * underside of a floor: painting those is deliberate, and a checker that
 * reports it teaches people to ignore it.
 */
function hiddenFace(placed, profile, t, say) {
  const named = Object.entries(profile.panels?.[t.role] ?? {})
    .filter(([, q]) => Array.isArray(q.rect) && typeof q.visible === 'number');
  const outward = named.filter(([, q]) => q.visible > 0);
  const inward = named.filter(([, q]) => q.visible === 0);
  // Nothing to compare. A sheet with no measured visibility, one the world sees
  // all of, or one it sees none of — in every case this has no question to ask.
  if (!outward.length || !inward.length) return;

  // The name a design would write, where the profile carries one.
  const friendly = (n) => {
    const alias = Object.entries(profile.aliases?.[t.role] ?? {}).find(([, v]) => v === n);
    return alias ? `${alias[0]} (${n})` : n;
  };
  const best = (list, p) => list.reduce((won, [n, q]) => {
    const covered = intersect(p.frac, rectOf(q.rect));
    return covered > won.covered ? { name: n, panel: q, covered } : won;
  }, { name: null, panel: null, covered: 0 });
  // The face to send somebody to when the placement reaches none of them —
  // which is the WORST case of this and was the one that crashed: a region
  // wholly on the inward face overlaps no outward panel at all, so there is no
  // "most overlapped" one to name. The sheet's most visible face is the honest
  // answer to "where should this have gone", and it does not depend on where
  // the artwork wrongly is.
  const mostVisible = outward.reduce((won, e) => (e[1].visible > won[1].visible ? e : won));

  for (const p of placed) {
    // A BACKGROUND IS NOT A PLACEMENT ON A FACE. A fill over the sheet covers
    // both of them by definition, and saying so about every design's first
    // region is how a checker earns its way into being ignored.
    const size = area(p.frac);
    if (size > 0.5) continue;
    const hidden = best(inward, p);
    const shown = best(outward, p);
    const onIn = hidden.covered / (size || 1);
    const onOut = shown.covered / (size || 1);
    if (onIn < 0.5 || onIn <= onOut) continue;
    // A SPILLED PIECE IS ALLOWED TO BE HERE, which is the same forgiveness
    // `unseen` extends and for the same reason: a band that runs off a fender
    // continues into the wheel arch liner, because that is where the bodywork
    // goes. Nobody placed that piece and out of sight is exactly where it
    // belongs. Words are the exception — a name is placed wherever it lands.
    if (p.region.span === true && p.spilled && p.region.treatment !== 'text') continue;
    const cockpit = hidden.panel.visibleFromCockpit;
    // `shown` is empty when the placement touches no outward panel, and that is
    // the strongest form of this finding rather than a case to skip.
    const [suggestName, suggest] = shown.panel ? [shown.name, shown.panel] : mostVisible;
    say({
      kind: 'hidden-face',
      // Text is the case that matters: a name or a number painted where the
      // world cannot read it is the whole point of the surface being missed.
      severity: onOut < 0.15 || p.region.treatment === 'text' ? 'high' : 'low',
      surface: t.from,
      panel: p.region.panel,
      ids: [p.id],
      onto: hidden.name,
      instead: suggestName,
      share: round(onIn),
      why: `${Math.round(onIn * 100)}% of ${name(t, p.id)} is on ${friendly(hidden.name)}, ` +
        'which measurement puts at 0% visible from trackside' +
        (typeof cockpit === 'number' && cockpit > 0
          ? ` and ${Math.round(cockpit * 100)}% from the driver's seat — so it shows to the driver and to nobody else`
          : ' — so it shows nowhere') +
        `. ${friendly(suggestName)} is the face of this same sheet the world sees ` +
        `(${Math.round(suggest.visible * 100)}% visible)` +
        (onOut > 0
          ? `, and only ${Math.round(onOut * 100)}% of this lands there`
          : ', and none of this reaches it'),
    });
  }
}

/** Why a placement has no size on the car, for the checks that need one. */
const noScale = (p) => (p.frac.panel
  ? `its panel ${p.region.panel} has no measured scale (metresPerUv); regenerate the profile with --from-kn5`
  : 'it names no panel, so nothing says how big it is on the car');

/** Whether a placement's panel is there and has no scale: the profile's gap, not the design's. */
const scaleless = (p) => {
  const per = p.frac.panel?.metresPerUv;
  return Boolean(p.frac.panel) && !(Array.isArray(per) && per.length === 2 && per[0] > 0 && per[1] > 0);
};

/**
 * Text too small to read on the car.
 *
 * Needs `metresPerUv`, which only profiles regenerated since it existed carry.
 * Without it nothing is guessed, and nothing is passed either: a region that
 * declared a floor gets the high finding `margins` gives the same absence, and
 * any other is named in `notChecked` and marked as the profile's. Text placed
 * on no panel is the design's choice, and a low finding says it went
 * unmeasured, as `tooSmall` says of a span. The height is the region's box,
 * not the glyphs: `text` fits itself to the box and may end up smaller, so this is an
 * upper bound and a clean one. If the box is 20 mm the lettering cannot be
 * bigger than that.
 */
function unreadable(placed, profile, t, say, skip) {
  for (const p of placed) {
    // A declared floor applies to ANY treatment, because a design that says
    // "never smaller than 40 mm" knows something about its artwork that the
    // word `text` does not carry — a sponsor mark is not text and still has a
    // size below which it is a smudge.
    const declared = typeof p.constraints.minMm === 'number' ? p.constraints.minMm : null;
    if (declared === null && p.region.treatment !== 'text') continue;
    // The narrowest the SHAPE is, which for a piece that crossed a seam is not
    // the short side of the box around it.
    const m = metresNarrowest(p.frac);
    if (m === null) {
      if (declared !== null) {
        say({ kind: 'unreadable', severity: 'high', surface: t.from, panel: p.region.panel, ids: [p.id],
          why: `${name(t, p.id)} asks for at least ${declared} mm, and ${noScale(p)}.` });
      } else if (!p.frac.panel) {
        say({ kind: 'unreadable', severity: 'low', surface: t.from, ids: [p.id], measured: false,
          why: `${name(t, p.id)} could not be measured, because ${noScale(p)}; check its size in a picture of the car.` });
      } else {
        skip(`unreadable for ${name(t, p.id)}: ${noScale(p)}`, scaleless(p) &&
          { check: 'unreadable', surface: t.from, role: t.role, ids: [p.id], why: noScale(p) });
      }
      continue;
    }
    const mm = m * 1000;
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
 * How tall a race number's and a name's letters must be on the car, in mm of
 * capital height.
 *
 * Set from the door a person laid out by hand and passed: an 85 with capitals
 * about 147 mm tall and NEON DOLL RACING at about 47. The handoff guessed 200
 * and 100, measured as 0.7 of the box, and both would have failed that door —
 * a long name is shrunk to fit its box's WIDTH, so a 150 mm box held 47 mm
 * letters. Run 16's name, which a person called too small to read, is 40.
 */
export const NUMBER_MM = 140;
export const NAME_MM = 45;

/** Capital height over font size, for the bold sans the text treatment sets. */
export const CAP = 0.72;

const wordsOf = (s) => String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Whether a text region is the race number, a team or driver name, or neither.
 *
 * By its placeholders, and by its words when it has none: a planner split the
 * team name into "NEON DOLL" and "RACING" on two lines, which is a name on the
 * car whatever the region says.
 */
function textIs(region, identity) {
  const raw = String(region.text ?? '');
  const shown = raw.replace(/\{(\w+)\}/g, (_, k) => String(identity?.[k] ?? ''));
  if (/\{number\}/.test(raw) || (identity?.number != null && shown.trim() === String(identity.number))) return 'number';
  if (/\{(team|driver)\}/.test(raw)) return 'name';
  const names = [identity?.team, identity?.driver].flatMap(wordsOf);
  const words = wordsOf(shown);
  return words.length && names.length && words.every((w) => names.includes(w)) ? 'name' : null;
}

/**
 * How tall a text placement's capitals are on the car, in millimetres, worked
 * out the way the text treatment sets them: 0.7 of the box's height, shrunk
 * until an estimated advance fits the width. On a panel laid a quarter turn,
 * the treatment draws in the box turned about its centre, so the letters stand
 * along the texture's u rather than its v.
 *
 * `{ why }` where it cannot be said: no `metresPerUv` (`noScale` too), an
 * angle that is not a multiple of a quarter turn, or a spanning region, whose
 * pieces are the band cut up by seams rather than the frame it was drawn in.
 */
function letterSize(p, size, identity) {
  const per = p.frac.panel?.metresPerUv;
  if (!Array.isArray(per) || per.length !== 2) return { noScale: true, why: noScale(p) };
  if (p.region.span === true) {
    return { why: 'it spans panels, and its pieces are the band cut up by seams rather than the frame its letters were set in' };
  }
  const f = textFrame(p, size, identity);
  if (!f) {
    const o = p.region;
    return { why: `it is turned to ${o.rotate === 'auto' ? `${p.frac.panel?.textRotation}° (its panel's own turn)` : `${o.rotate}°`}, ` +
      'and only a quarter turn keeps its letters along one axis of the texture' };
  }
  const { quarter, w, h, em, shrunk } = f;
  // Pixels along the axis the letters stand on, to metres along that axis.
  const mm = (px, alongU) => (alongU ? (px / size.w) * per[0] : (px / size.h) * per[1]) * 1000;
  return { mm: mm(CAP * em, quarter), shrunk, boxMm: [mm(w, !quarter), mm(h, quarter)] };
}

/**
 * A race number or a name whose letters are too small to read from trackside.
 *
 * Runs 17, 18 and 20 each lost a round to a team name the critic called too
 * small, a round after it was drafted. Size is arithmetic, and the planner
 * hears it while it is still drafting.
 *
 * The LETTERS, not the box — which is what `unreadable` measures, and why it
 * passed these: a 150 mm box with sixteen letters in it holds 47 mm capitals,
 * because text is shrunk to fit the width. A declared minMm does not replace
 * this floor. It is a floor on the box, planners are told to declare one on
 * every name, and run 18's 125 would have waved through letters a third that
 * size.
 */
function tooSmall(placed, t, say, size, identity, skip) {
  for (const p of placed) {
    if (p.region.treatment !== 'text') continue;
    const is = textIs(p.region, identity);
    if (!is || !String(p.region.text ?? '').replace(/\{(\w+)\}/g, (_, k) => String(identity?.[k] ?? '')).trim()) continue;
    const got = letterSize(p, size, identity);
    // Unmeasured is said, never passed. No scale on a panel is the profile's
    // to fix, named in `notChecked` and marked as the profile's as `unreadable`
    // does; no panel at all, a span or an angle is the design's own choice, so
    // a low finding says so without failing a gate over something no planner
    // could measure either.
    if (got.noScale && p.frac.panel) {
      skip(`too-small for ${name(t, p.id)}: ${got.why}`, scaleless(p) &&
        { check: 'too-small', surface: t.from, role: t.role, ids: [p.id], why: got.why });
      continue;
    }
    if (got.why) {
      say({ kind: 'too-small', severity: 'low', surface: t.from, panel: p.region.panel, ids: [p.id], measured: false,
        why: `${name(t, p.id)}'s letters could not be measured, because ${got.why}; check their size in a picture of the car.` });
      continue;
    }
    const floor = is === 'number' ? NUMBER_MM : NAME_MM;
    if (got.mm >= floor) continue;
    const [bw, bh] = got.boxMm.map(Math.round);
    say({
      kind: 'too-small', severity: 'high', surface: t.from, panel: p.region.panel, ids: [p.id],
      mm: Math.round(got.mm), floor,
      why: `${name(t, p.id)}'s letters are ${Math.round(got.mm)} mm tall on the car, and ` +
        `${is === 'number' ? 'a race number\'s' : 'a team or driver name\'s'} need at least ${floor} mm to read ` +
        'from trackside' + (got.shrunk
        ? `. Its box is ${bh} mm tall, but the text is shrunk to fit the box's ${bw} mm width: widen the box` +
          (is === 'name' ? ', or split the name over two lines.' : '.')
        : `. Make its box taller (it is ${bh} mm).`),
    });
  }
}

/**
 * A region that asked to sit with another and is on a different panel.
 *
 * A person marked run 18's team name, on the rear quarter, as nowhere a
 * spectator looks; run 17 did the same. The planner was asked to put the name
 * under the number on the door, and sometimes did not, and nothing measured
 * it. This does — but only where the design says `groupWith`. A brief may want
 * the name on the roof, and a rule nobody declared would be this checker's
 * taste standing in for the design's.
 *
 * The same panel, after aliases, on the same texture: the whole of what is
 * measured. A neighbouring panel would need the adjacency spans use, and
 * "beside" is not yet a question with an answer here.
 */
function grouped(all, design, fit, profile, say) {
  const byKey = new Map();
  for (const { t, placed } of all) {
    for (const p of placed) {
      if (!byKey.has(p.key)) byKey.set(p.key, []);
      byKey.get(p.key).push({ t, p });
    }
  }
  const known = new Set(Object.keys(fit?.copies ?? {}));
  for (const group of ['surfaces', 'paint']) {
    for (const spec of Object.values(design?.[group] ?? {})) {
      for (const r of spec?.regions ?? []) if (r?.id) known.add(r.id);
    }
  }
  const where = ({ t, p }) => (p.region.panel ? `${t.role}\u0000${panelName(profile, t.role, p.region.panel)}` : null);

  for (const { t, placed } of all) {
    for (const p of placed) {
      const g = p.constraints?.groupWith;
      if (typeof g !== 'string') continue;
      const partners = byKey.get(g) ?? [];
      if (!partners.length) {
        // A misspelled id is the worst case — a rule that reads as in force
        // and holds nothing — so it is refused like a misspelled constraint.
        say(known.has(g)
          ? { kind: 'ungrouped', severity: 'high', role: t.role, surface: t.from, panel: p.region.panel, ids: [p.id, g],
            why: `${name(t, p.id)} asked to sit with ${g} (groupWith), and ${g} is not placed on this car, ` +
              'so there is nothing for it to sit with' }
          : { kind: 'bad-constraint', severity: 'fatal', role: t.role, surface: t.from, ids: [p.id],
            why: `${name(t, p.id)} has groupWith: ${JSON.stringify(g)}, and no region in this design is called that.` });
        continue;
      }
      const mine = where({ t, p });
      if (mine && partners.some((q) => where(q) === mine)) continue;
      const theirs = [...new Set(partners.map((q) => q.p.region.panel ?? 'the whole sheet'))].join(', ');
      say({
        kind: 'ungrouped', severity: 'high', role: t.role, surface: t.from, panel: p.region.panel, ids: [p.id, g],
        why: `${name(t, p.id)} asked to sit with ${g} (groupWith), and is on ${p.region.panel ?? 'the whole sheet'} ` +
          `while ${g} is on ${theirs}. Move it onto the same panel as ${g}.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// A stripe along the car, checked as one line of paint rather than as the
// rectangles it is drawn with.
//
// A Gulf centre stripe went wrong twice, and both times only the critic
// noticed, from a picture. Run 19 wrote [0.4, 0, 0.2, 1] on a bonnet, a roof
// and an engine cover whose x runs along the car, and painted three bands
// ACROSS it. Run 20's first round drew the same fractions on six panels of
// different widths, and the stripe came out as rectangles that did not meet.
// Both are geometry: the profile says which way each panel runs, and the model
// says where every piece of paint lands.
//
// Only where the design says `stripe`. Which regions make one stripe along the
// car cannot be read off their ids or their treatment — a band across the
// bonnet is a design choice too, and a guess would be this checker's taste
// standing in for the design's, as it would be for `groupWith`.
// ---------------------------------------------------------------------------

/**
 * How far one piece's edge may step from the last one's where they meet.
 *
 * Measured on the NSX. Run 20's final draft, nose to tail in seven pieces,
 * meets within 8 mm at every join and reads as one stripe; its first round,
 * which read as offset rectangles, was out by 63 to 236 mm, and run 21's
 * stripe, which the critic called offset round the roof, by 60 to 295. The
 * measurement's own error is a few millimetres — samples every 8 mm, so an
 * edge is found to within 4 — which 20 mm is well clear of, and it is under
 * the step anybody would see from trackside.
 */
const STRIPE_STEP_MM = 20;

/**
 * How long a stretch of bare bodywork may be before it is a gap in the stripe.
 * Two islands meeting at a seam leave nothing and a shut line a few
 * millimetres, but the car is looked at through a 20 mm grid, so one cell of
 * it is the measurement's own edge and two are a gap.
 */
const STRIPE_GAP_MM = 30;

/**
 * How much of each piece's end is its end. Not one row of samples: a shut line
 * crossing the stripe on a curve, as the bonnet's does at the windscreen,
 * cuts the corners of the piece off at different lengths, and the width that
 * meets the next piece is the width over the last few centimetres.
 */
const STRIPE_END_MM = 60;

const STRIPE_SAMPLE_MM = 8;

/** How far beyond a band's edges `stripeAt` reads the panel to fit it. */
const STRIPE_FIT_MM = 100;

function stripes(all, profile, seen, say, skip) {
  const byName = new Map();
  for (const { t, placed } of all) {
    for (const p of placed) {
      const s = p.constraints?.stripe;
      if (typeof s !== 'string') continue;
      if (!byName.has(s)) byName.set(s, []);
      byName.get(s).push({ t, p });
    }
  }
  for (const [stripe, pieces] of byName) {
    for (const piece of pieces) stripeDirection(piece, stripe, say, skip);
  }
  // Without the model the joins are named in `notChecked` by the caller.
  if (seen && byName.size) stripeJoins(byName, profile, seen, say);
}

/**
 * A piece of a stripe along the car whose long side runs across it: run 19.
 *
 * Asked of the PANEL'S AXES as find_panels reports them, not re-derived here,
 * because that is what the planner was told to write its stripe by — so a
 * finding and the tool it is sent back to cannot disagree about which way the
 * bonnet runs. Of a panel's two axes, the one running across the car must be
 * the piece's short side; where neither is named across, the one running
 * along is its long side, which is the case on a flank, whose other axis is
 * up and down. The long side is in millimetres, not fractions: a stripe that
 * is 20% of a panel's length is still the long side if the panel is five times
 * longer than it is wide.
 *
 * A piece that covers its panel end to end along the car is left alone,
 * whatever its shape: a stripe crossing a panel shorter than the stripe is
 * wide is exactly what a stripe does. And no model is needed, so this runs
 * wherever fitment does.
 */
function stripeDirection({ t, p }, stripe, say, skip) {
  // A piece that arrived through a seam runs whichever way the seam turned
  // the band, inside a box drawn round a parallelogram. Its home piece says
  // which way the band runs, and is asked.
  if (p.spilled) return;
  const id = name(t, p.id);
  const pan = p.frac.panel;
  const where = { kind: 'stripe-across', surface: t.from, role: t.role, panel: p.region.panel, ids: [p.id], stripe };
  if (!pan) {
    say({ ...where, severity: 'low', measured: false,
      why: `${id} is part of the stripe "${stripe}" and names no panel, so which way it runs on the car ` +
        'could not be measured; check it in a picture of the car.' });
    return;
  }
  const axes = axesOf(pan);
  const m = metresAcross(p.frac);
  if (!axes || !m) {
    // The profile's gap, not the draft's, as a missing scale is for `unreadable`.
    const why = !axes
      ? `its panel ${p.region.panel} has no measured axes (uAxis, vAxis); regenerate the profile with --from-kn5`
      : noScale(p);
    skip(`stripe-across for ${id}: ${why}`, { check: 'stripe-across', surface: t.from, role: t.role, ids: [p.id], why });
    // And said, like the unclear panel below: `notChecked` alone left a piece
    // nobody measured with no finding to its name, which a planner reading
    // the findings takes for a piece that passed.
    say({ ...where, severity: 'low', measured: false,
      why: `${id} is part of the stripe "${stripe}", and which way it runs could not be checked: ${why}.` });
    return;
  }
  // Both axes named, or neither is used: with y unclear, that x runs across
  // the car does not make y run along it, and a piece judged by it could be
  // passed or failed for a direction nobody measured.
  const across = !axes.x || !axes.y ? null
    : axes.x === 'across the car' ? 'x' : axes.y === 'across the car' ? 'y'
      : axes.x === 'along the car' ? 'y' : axes.y === 'along the car' ? 'x' : null;
  if (!across) {
    say({ ...where, severity: 'low', measured: false,
      why: `${id} is part of the stripe "${stripe}", and which way it runs could not be checked: find_panels ` +
        `does not name both of ${p.region.panel}'s axes as one of along the car, across it, or up and down ` +
        `(${axes.unclear ?? `x runs ${axes.x}, y ${axes.y}`}).` });
    return;
  }
  const along = across === 'x' ? 'y' : 'x';
  const mm = { x: Math.round(m.w * 1000), y: Math.round(m.h * 1000) };
  if (mm[along] >= mm[across]) return;
  const r = pan.rect;
  if ((along === 'x' ? p.frac.w / r[2] : p.frac.h / r[3]) >= 0.9) return;
  // The same numbers turned a quarter, which is what run 19 meant, offered
  // only where it would run the panel's whole length.
  const a = p.region.at;
  const turned = Array.isArray(a) && a.length === 4 && p.region.span !== true && (across === 'x' ? a[2] : a[3]) >= 0.9
    ? `, as at [${[a[1], a[0], a[3], a[2]].map(round).join(', ')}] would be` : '';
  say({
    ...where, severity: 'high', along: mm[along], across: mm[across],
    why: `${id} is part of the stripe "${stripe}", which runs along the car, and on ${p.region.panel} it runs ` +
      `across the car instead: it is ${mm[across]} mm across the car and ${mm[along]} mm along it. ` +
      `${p.region.panel}'s x runs ${axes.x ?? 'unclear'} and its y ${axes.y ?? 'unclear'} (find_panels' "axes"), ` +
      `so a stripe along the car is long in ${along} and narrow in ${across}${turned}.`,
  });
}

/**
 * Where one piece of a stripe meets the next, measured on the car: the run 20
 * mistake. Then whether the pieces together cover the car: `stripeCoverage`.
 *
 * Every piece is sampled onto the model and the pieces are put in order from
 * the front of the car to the back. Two pieces side by side — a roof split
 * down the middle — are one step of the stripe, not two. Then, where each
 * piece meets the next, the ends are compared across the stripe: across the
 * car for one over the top, up and down for one along a flank, whichever
 * direction lies in the paint and not along the stripe.
 */
function stripeJoins(byName, profile, seen, say) {
  const ax = profile.calibration?.axes ?? {};
  const F = ax.front === '-Z' ? -1 : 1;
  const L = ax.left === '-X' ? -1 : 1;

  // Sampled with one walk of the triangles for every piece they could hold:
  // the piece's own panel's mesh where the profile names it (see
  // `ownMeshes`), else every mesh of its sheet.
  const byMeshes = new Map();
  for (const pieces of byName.values()) {
    for (const piece of pieces) {
      const meshes = ownMeshes(seen.model, profile, piece.t.role, piece.p.frac.panel);
      const key = meshes.map((m) => seen.model.meshes.indexOf(m)).join(',');
      if (!byMeshes.has(key)) byMeshes.set(key, { meshes, pieces: [] });
      byMeshes.get(key).pieces.push(piece);
    }
  }
  for (const { meshes, pieces } of byMeshes.values()) {
    const cells = (uv, per) => Math.max(8, Math.min(200, Math.ceil((uv * per * 1000) / STRIPE_SAMPLE_MM)));
    // On the piece's own island: its box covers whatever else the unwrap put
    // beside it, which is paint, but not this stripe's.
    const asks = pieces.map(({ p }) => {
      const f = p.frac, per = f.panel?.metresPerUv;
      const scaled = per?.[0] > 0 && per?.[1] > 0;
      return { rect: [f.x, f.y, f.w, f.h], nu: scaled ? cells(f.w, per[0]) : 40, nv: scaled ? cells(f.h, per[1]) : 40,
        poly: f.poly ?? null, within: f.panel?.outline ?? null };
    });
    const got = meshes.length ? sampleRects(seen.model, meshes, asks) : asks.map(() => ({ points: [] }));
    pieces.forEach((piece, i) => {
      piece.points = got[i].points;
      for (const q of piece.points) q.piece = piece;
    });
  }

  for (const [stripe, pieces] of byName) {
    const onCar = [];
    for (const piece of pieces) {
      if (piece.points.length >= 3) {
        onCar.push({ ...piece, ...meanOf(piece.points) });
        continue;
      }
      // off-mesh says where it went; this says what that cost the stripe.
      say({ kind: 'stripe-offset', severity: 'low', measured: false, surface: piece.t.from, role: piece.t.role,
        panel: piece.p.region.panel, ids: [piece.p.id], stripe,
        why: `${name(piece.t, piece.p.id)} is part of the stripe "${stripe}" and lands on no geometry, so whether ` +
          'it lines up with the rest of the stripe could not be measured.' });
    }

    // A piece is part of the step before it when it sits beside it across the
    // car, or when its stretch along the car lies within a step's, at the
    // same height: the NSX's roof hatch is a piece of its own inside the
    // roof's 1.8 m, and compared end to end with the roof it was reported as
    // offset from it by the width of the roof.
    const alongOf = (pts) => pts.reduce(([lo, hi], q) => [Math.min(lo, q.z), Math.max(hi, q.z)], [Infinity, -Infinity]);
    const steps = [];
    for (const piece of onCar.sort((a, b) => (b.c[2] - a.c[2]) * F)) {
      const [zlo, zhi] = alongOf(piece.points);
      const last = steps.at(-1);
      const d = last && [0, 1, 2].map((k) => piece.c[k] - last.c[k]);
      const beside = d && Math.abs(d[0]) > Math.abs(d[1]) && Math.abs(d[0]) > Math.abs(d[2]);
      const within = (s) => (Math.min(zhi, s.z[1]) - Math.max(zlo, s.z[0])) / Math.max(zhi - zlo, 1e-6) >= 0.8
        && Math.abs([0, 1, 2].reduce((sum, k) => sum + (piece.c[k] - s.c[k]) * s.n[k], 0)) < 0.15;
      const host = beside ? last : steps.find(within);
      if (host) {
        host.pieces.push(piece);
        host.points = host.points.concat(piece.points);
        Object.assign(host, meanOf(host.points));
        host.z = [Math.min(host.z[0], zlo), Math.max(host.z[1], zhi)];
        continue;
      }
      steps.push({ pieces: [piece], points: piece.points, c: piece.c, n: piece.n, z: [zlo, zhi] });
    }
    for (let i = 0; i + 1 < steps.length; i++) {
      stripeJoin(steps[i], steps[i + 1], { stripe, say, F, L });
    }
    if (onCar.length) stripeCoverage(stripe, onCar, pieces, { profile, seen, say, F, L });
  }
}

/** Where a set of surface points is, and which way it faces, on average. */
function meanOf(points) {
  const c = [0, 0, 0], n = [0, 0, 0];
  for (const q of points) {
    c[0] += q.x; c[1] += q.y; c[2] += q.z;
    n[0] += q.nx; n[1] += q.ny; n[2] += q.nz;
  }
  const nl = Math.hypot(...n) || 1;
  return { c: c.map((v) => v / points.length), n: n.map((v) => v / nl) };
}

function stripeJoin(A, B, { stripe, say, F, L }) {
  const dl = Math.hypot(B.c[0] - A.c[0], B.c[1] - A.c[1], B.c[2] - A.c[2]) || 1;
  const d = [0, 1, 2].map((k) => (B.c[k] - A.c[k]) / dl);
  const nl = Math.hypot(A.n[0] + B.n[0], A.n[1] + B.n[1], A.n[2] + B.n[2]) || 1;
  const n = [0, 1, 2].map((k) => (A.n[k] + B.n[k]) / nl);
  // Across the stripe: the car's own axis that lies least along the stripe
  // and least out of the paint. Across the car over a roof, up and down on a
  // flank, and across the car again down the face of the nose.
  const k = [1, 2].reduce((best, i) => (Math.abs(d[i]) + Math.abs(n[i]) < Math.abs(d[best]) + Math.abs(n[best]) ? i : best), 0);
  const s = (q) => q.x * d[0] + q.y * d[1] + q.z * d[2];
  const lat = (q) => (k === 0 ? q.x * L : k === 1 ? q.y : q.z * F);

  let sA = -Infinity, sB = Infinity;
  for (const q of A.points) sA = Math.max(sA, s(q));
  for (const q of B.points) sB = Math.min(sB, s(q));
  const end = STRIPE_END_MM / 1000;
  const bandA = A.points.filter((q) => s(q) >= sA - end);
  const bandB = B.points.filter((q) => s(q) <= sB + end);
  const span = (band) => band.reduce(([lo, hi], q) => [Math.min(lo, lat(q)), Math.max(hi, lat(q))], [Infinity, -Infinity]);
  const [loA, hiA] = span(bandA), [loB, hiB] = span(bandB);
  const at = (band) => [...new Set(band.map((q) => q.piece))];
  const endA = at(bandA), endB = at(bandB);
  const idsOf = (list) => list.map(({ t, p }) => name(t, p.id));
  const panelsOf = (list) => [...new Set(list.map(({ p }) => p.region.panel ?? 'the whole sheet'))].join(' and ');
  const ids = [...new Set([...endA, ...endB].map(({ p }) => p.id))];
  const who = (list) => idsOf(list).join(' and ');
  const mm = (v) => Math.round(v * 1000);

  const words = [
    { hi: 'left edge', lo: 'right edge', more: 'further left', less: 'further right',
      at: (v) => (Math.abs(v) < 0.0005 ? 'the centreline' : `${Math.abs(mm(v))} mm ${v > 0 ? 'left' : 'right'} of the centreline`) },
    { hi: 'top edge', lo: 'bottom edge', more: 'higher', less: 'lower', at: (v) => `${mm(v)} mm up` },
    { hi: 'front edge', lo: 'rear edge', more: 'further forward', less: 'further back', at: (v) => `${mm(v)} mm along` },
  ][k];
  const dHi = hiB - hiA, dLo = loB - loA;
  const worst = Math.max(Math.abs(dHi), Math.abs(dLo)) * 1000;
  if (worst > STRIPE_STEP_MM) {
    const step = (dv, edge) => `${edge} ${Math.abs(mm(dv))} mm ${dv > 0 ? words.more : words.less}`;
    say({
      kind: 'stripe-offset', severity: 'high', surface: endB[0].t.from, role: endB[0].t.role,
      panel: endB[0].p.region.panel, ids, stripe, mm: Math.round(worst),
      why: `${who(endA)} and ${who(endB)} are pieces of the stripe "${stripe}" and do not line up where they meet: ` +
        `${who(endA)} ends ${mm(hiA - loA)} mm wide on ${panelsOf(endA)}, from ${words.at(loA)} to ${words.at(hiA)}, and ` +
        `${who(endB)} begins ${mm(hiB - loB)} mm wide on ${panelsOf(endB)}, with its ${step(dHi, words.hi)} and its ` +
        `${step(dLo, words.lo)}. Where two pieces of one stripe meet their edges must agree within ${STRIPE_STEP_MM} mm, ` +
        'or the stripe reads as offset rectangles: size and place them to the same line on the car.',
    });
  }
}

/**
 * Whether the pieces of a stripe along the car, together, cover the car nose
 * to tail — over the rear wing too, where the car has one — apart from where
 * there is nothing to paint.
 *
 * A stripe along the car runs its whole length: a Gulf centre stripe that
 * stops at the engine cover, or passes under the wing instead of over it, is
 * not the livery. And a stripe is interrupted wherever the car has glass, a
 * vent or a grille, because paint does not go on a hole: the local critic
 * failed run 20 for exactly that, and it is the distinction this has to draw.
 *
 * So it is asked of the car as the stripe is seen, from above for one over the
 * top and from the side for one along a flank: across the stripe's width, what
 * is the surface nearest the eye, all the way from the front of the car to the
 * back. Where that surface is a panel of the stripe's own sheet that the world
 * sees, it is bodywork this design paints, and the stripe must be on it —
 * which is read off the texture, not guessed: the surface's own place on the
 * sheet is inside one of the stripe's pieces or it is not. Where the nearest
 * surface is glass, a grille, anything on a sheet the design does not paint,
 * or nothing at all, the gap is the car's. A rear wing needs no name: seen from
 * above it is the surface over the deck, and a stripe on the deck beneath it
 * is not on the wing.
 *
 * The stretch the pieces must cover is the stripe's own width, taken as the
 * middle one of its pieces' widths so that one piece drawn wrong — which
 * `stripe-offset` reports — does not move the band the rest are held to.
 */
function stripeCoverage(stripe, onCar, pieces, { profile, seen, say, F, L }) {
  const model = seen.model;
  const ids = [...new Set(pieces.map(({ p }) => p.id))];
  const first = onCar[0];
  let points = [];
  for (const piece of onCar) points = points.concat(piece.points);
  const { n } = meanOf(points);
  const axis = [1, 2].reduce((b, i) => (Math.abs(n[i]) > Math.abs(n[b]) ? i : b), 0);
  const unmeasured = (why) => say({ kind: 'stripe-gap', severity: 'low', measured: false, surface: first.t.from,
    role: first.t.role, ids, stripe, why: `Whether the stripe "${stripe}" runs nose to tail could not be measured: ${why}; ` +
      'check it in a picture of the car.' });
  if (axis === 2) {
    unmeasured('its paint faces the front or the back of the car more than it faces up or out to a side, ' +
      'so there is no one view of the car it runs the length of');
    return;
  }
  const sign = n[axis] >= 0 ? 1 : -1;
  const env = envelope(model, profile, axis, sign);
  const across = env.across;

  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const extents = onCar.map((piece) => piece.points.reduce(([lo, hi], q) => {
    const v = across === 0 ? q.x : q.y;
    return [Math.min(lo, v), Math.max(hi, v)];
  }, [Infinity, -Infinity]));
  const lo = median(extents.map((e) => e[0])), hi = median(extents.map((e) => e[1]));
  const cols = [];
  for (let i = 0; i < env.cols; i++) {
    const c = env.c0 + (i + 0.5) * ENVELOPE_CELL;
    if (c >= lo && c <= hi) cols.push(i);
  }
  if (!cols.length) {
    unmeasured(`it is narrower than the ${ENVELOPE_CELL * 1000} mm grid the car is looked at through`);
    return;
  }

  // Per sheet: the panels on it that the world sees, and the stripe's paint.
  const sheets = new Map();
  for (const piece of pieces) {
    let file;
    try {
      file = texture(profile, piece.t.role).file.toLowerCase();
    } catch { continue; }
    if (!sheets.has(file)) {
      sheets.set(file, {
        role: piece.t.role, surface: piece.t.from,
        panels: seenPanels(profile, piece.t.role),
        paint: [],
      });
    }
    const poly = shapeOf(piece.p.frac);
    sheets.get(file).paint.push({ piece, poly, box: [Math.min(...poly.map((q) => q[0])), Math.min(...poly.map((q) => q[1])),
      Math.max(...poly.map((q) => q[0])), Math.max(...poly.map((q) => q[1]))] });
  }
  // Which sheet each panel in the band is on, so a finding names that one.
  // Taken from the stripe's first piece, a formula car's body, which binds
  // body and bodyRear, reported a gap on the rear sheet as the front one's.
  const home = new Map();

  // Front to back, a row of cells at a time across the stripe's width.
  const order = [...Array(env.rows).keys()];
  if (F > 0) order.reverse();
  const rows = order.map((j) => {
    const row = { j, any: false, req: 0, cov: 0, on: new Map(), h: 0, by: null, cells: [] };
    for (const i of cols) {
      const k = j * env.cols + i, m = env.M[k];
      if (m < 0) continue;
      row.any = true;
      const sheet = sheets.get(sheetOf(model, m));
      if (!sheet) continue;
      const u = env.U[k], v = env.V[k];
      const pan = panelAtUv(sheet.panels, u, v, model.meshes[m].name);
      if (!pan) continue;
      home.set(pan, sheet);
      row.req++;
      row.h += env.H[k];
      row.on.set(pan, (row.on.get(pan) ?? 0) + 1);
      const hit = sheet.paint.find(({ box, poly }) => u >= box[0] && u <= box[2] && v >= box[1] && v <= box[3] && inPoly(poly, [u, v]));
      row.cells.push({ pan, hit: Boolean(hit), h: env.H[k] });
      if (hit) {
        row.cov++;
        row.by ??= hit.piece;
      }
    }
    if (row.req) row.h /= row.req;
    return row;
  });
  if (!rows.some((r) => r.any)) return;
  // Present where a quarter of the paintable width carries it: how wide it
  // is there is `stripe-offset`'s business, and a stripe drawn too narrow on
  // one panel is not missing from it.
  const painted = (r) => r.req > 0 && r.cov * 4 >= r.req;
  const unpainted = (r) => r.req * 2 >= cols.length && !painted(r);

  // Millimetres behind the car's nose of a row's front edge and its back one:
  // the frontmost point of the car, as `panelOnCar` measures from.
  const noseZ = F > 0 ? env.r1 : env.r0;
  const edgeMm = (z) => Math.max(0, Math.round((noseZ - z) * F * 1000));
  const frontOf = (x) => edgeMm(env.r0 + (rows[x].j + (F > 0 ? 1 : 0)) * ENVELOPE_CELL);
  const backOf = (x) => edgeMm(env.r0 + (rows[x].j + (F > 0 ? 0 : 1)) * ENVELOPE_CELL);
  const seenFrom = axis === 1 ? 'seen from above' : `seen from the car's ${n[0] * L > 0 ? 'left' : 'right'}`;
  const idOf = (row) => name(row.by.t, row.by.p.id);
  // Panels the stripe looks into through a hole somewhere in its band: the
  // inside of a vent, whose lip can come up to the skin and would otherwise
  // read as a notch in the stripe at the vent's edge.
  const holes = new Set();
  for (let a = 0; a < rows.length; a++) {
    if (!unpainted(rows[a])) continue;
    const runStart = a;
    while (a + 1 < rows.length && unpainted(rows[a + 1])) a++;
    let ai = runStart - 1, bi = a + 1;
    while (ai >= 0 && !painted(rows[ai])) ai--;
    while (bi < rows.length && !painted(rows[bi])) bi++;
    const ahead = ai >= 0 ? rows[ai] : null, behind = bi < rows.length ? rows[bi] : null;
    const where = ahead && behind
      ? (ahead.by === behind.by ? ` in the middle of ${idOf(ahead)}` : ` between ${idOf(ahead)} and ${idOf(behind)}`)
      : ahead ? ` behind ${idOf(ahead)}` : behind ? ` ahead of ${idOf(behind)}` : '';

    const body = bodyworkIn(rows, runStart, a, ahead ? ai : -1, behind ? bi : -1);
    for (let x = runStart; x <= a; x++) {
      if (body.some(([s, e]) => x >= s && x <= e)) continue;
      for (const c of rows[x].cells) holes.add(c.pan);
    }
    for (const [s, e] of body) {
      const run = rows.slice(s, e + 1);
      const from = frontOf(s), to = backOf(e), length = to - from;
      if (length <= STRIPE_GAP_MM) continue;
      const count = new Map();
      for (const r of run) for (const [pan, c] of r.on) count.set(pan, (count.get(pan) ?? 0) + c);
      const on = [...count.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([pan]) => pan);
      // Standing proud of the stripe ahead of it, as a wing does: said,
      // because a planner looking at the deck beneath it will think it is
      // covered.
      const h = run.reduce((sum, r) => sum + r.h, 0) / run.length;
      const raised = ahead && h - ahead.h > 0.08
        ? ` It stands ${Math.round((h - ahead.h) * 1000)} mm above the stripe ahead of it, as a rear wing does, and the ` +
          'stripe runs over its top as well: paint on the bodywork beneath it does not count.'
        : '';
      say({
        kind: 'stripe-gap', severity: 'high', surface: home.get(on[0]).surface, role: home.get(on[0]).role,
        panel: on[0].panel, ids, stripe, from, to, mm: length,
        why: `The stripe "${stripe}" leaves ${length} mm of the car bare ${seenFrom}, from ${from} to ${to} mm behind the ` +
          `nose${where}: that stretch is ${on.map((q) => `${q.panel} (${Math.round(q.visible * 100)}% visible)`).join(', ')}, ` +
          'bodywork this design paints and the world sees, not glass or an opening. A stripe along the car runs nose to ' +
          `tail: add a piece on ${on[0].panel} with constraints { stripe: "${stripe}" }, lined up with the rest.${raised}`,
      });
    }
  }

  // A panel inside the band that the stripe paints none of, where the rest of
  // the stripe is present: a notch, not a stretch, so the rows above never
  // see it. The NSX's roof has a hatch that is an island of its own, 433 mm
  // square and set off the centreline, and a centred stripe crosses 110 mm of
  // it. Runs 21 and 22 painted the roof and not the hatch, and the stripe had
  // a bite of the base colour taken out of it. Found by where the panel is,
  // never by what it is called: the hatch is tagged `left`.
  const notched = new Map();
  rows.forEach((r, x) => {
    if (!painted(r)) return;
    const on = r.cells.filter((c) => c.hit);
    const skin = on.reduce((sum, c) => sum + c.h, 0) / on.length;
    const here = new Map();
    for (const c of r.cells) {
      if (c.h < skin - OPENING_DEPTH) {                  // seen through a hole in the skin
        holes.add(c.pan);
        continue;
      }
      const e = here.get(c.pan) ?? { req: 0, bare: 0 };
      e.req++;
      if (!c.hit) e.bare++;
      here.set(c.pan, e);
    }
    for (const [pan, e] of here) {
      const s = notched.get(pan) ?? { req: 0, bare: 0, rows: [], widest: 0, around: new Map() };
      s.req += e.req;
      s.bare += e.bare;
      if (e.bare) {
        s.rows.push(x);
        s.widest = Math.max(s.widest, e.bare);
        for (const c of on) if (c.pan !== pan) s.around.set(c.pan, (s.around.get(c.pan) ?? 0) + 1);
      }
      notched.set(pan, s);
    }
  });
  const band = cols.length * ENVELOPE_CELL * 1000;
  for (const [pan, s] of notched) {
    // Mostly unpainted, and more than one cell of the grid each way: a piece
    // drawn a little narrower than the rest leaves its own panel's edge bare,
    // and that is `stripe-offset`'s to say.
    if (s.bare * 4 < s.req * 3 || holes.has(pan)) continue;
    const from = frontOf(s.rows[0]), to = backOf(s.rows.at(-1));
    const carries = Math.round(s.widest * ENVELOPE_CELL * 1000);
    const { surface, role } = home.get(pan);
    if (s.rows.length < 2 || s.widest < 2) {
      // Too thin to judge is not the same as fine. Passed over in silence, a
      // panel the band clips by 20 mm read as one the stripe had covered, and
      // `stripeLayout` leaves the same panel out, under `skipped`.
      const thin = [s.widest < 2 && `${carries} mm of the band's ${Math.round(band)} mm width`,
        s.rows.length < 2 && `${Math.round(ENVELOPE_CELL * 1000)} mm along the car`].filter(Boolean).join(' and ');
      say({
        kind: 'stripe-gap', severity: 'low', measured: false, surface, role, panel: pan.panel, ids, stripe, from, to,
        why: `${pan.panel} lies inside the stripe "${stripe}" from ${from} to ${to} mm behind the nose and the stripe ` +
          `does not paint it, but it carries only ${thin} there: too little of the ` +
          `${Math.round(ENVELOPE_CELL * 1000)} mm grid the car is looked at through to tell a notch in the stripe ` +
          `from the edge of a piece drawn a little narrow, so whether it needs a piece of its own could not be ` +
          'measured; check it in a picture of the car.',
      });
      continue;
    }
    const around = [...s.around.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    say({
      kind: 'stripe-gap', severity: 'high', surface, role, panel: pan.panel, ids, stripe,
      from, to, mm: carries,
      why: `${pan.panel} lies inside the stripe "${stripe}" from ${from} to ${to} mm behind the nose, carrying ` +
        `${carries} mm of its ${Math.round(band)} mm width there, and the stripe does not paint it: a notch of the base ` +
        `colour in the stripe${around ? ` where it crosses ${around.panel}` : ''}. ${pan.panel} is ` +
        `${Math.round(pan.visible * 100)}% visible, and a panel inside the stripe's band is bodywork the stripe runs over, ` +
        `whatever it is called: add a piece on ${pan.panel} with constraints { stripe: "${stripe}" }, at the same place ` +
        'across the car as the rest.',
    });
  }
}

/**
 * The car's frame, as the wheels measured it: which way along z is forward,
 * which way along x is left, and where along z its nose is — the frontmost
 * point of anything it shows, which is what "behind the nose" is measured
 * from here and in every stripe finding.
 */
function carFrame(model, profile) {
  const ax = profile.calibration?.axes ?? {};
  const F = ax.front === '-Z' ? -1 : 1;
  const env = envelope(model, profile, 1, 1);
  return { F, L: ax.left === '-X' ? -1 : 1, noseZ: F > 0 ? env.r1 : env.r0 };
}

/**
 * The meshes a panel's island is on: the one the profile says it came from,
 * where it says and that mesh wears the sheet, else every mesh of the sheet.
 *
 * A panel's outline does not keep other islands out. The NSX's roof has the
 * bonnet's and the nose's texels laid out inside its outline, and sampled on
 * every mesh of the sheet the roof's stripe was measured partly on the bonnet:
 * `stripeAt` fitted the roof 425 mm off a straight line, and a stripe on it
 * began at the front of the car.
 */
function ownMeshes(model, profile, role, pan) {
  let meshes;
  try {
    meshes = meshesUsingTexture(model, texture(profile, role).file);
  } catch {
    return [];                                  // reported as unresolvable by `unseen`
  }
  const own = pan?.source?.mesh;
  const mine = own ? meshes.filter((m) => m.name === own) : [];
  return mine.length ? mine : meshes;
}

/** Surface points across a rectangle on a panel, and on that panel's island only. */
function panelSamples(model, profile, role, panel, at) {
  const f = resolveRect(profile, role, { panel, at, safe: false });
  const meshes = ownMeshes(model, profile, role, f.panel);
  const per = f.panel?.metresPerUv;
  const scaled = per?.[0] > 0 && per?.[1] > 0;
  const cells = (uv, s) => Math.max(8, Math.min(200, Math.ceil((uv * s * 1000) / STRIPE_SAMPLE_MM)));
  const [got] = sampleRects(model, meshes, [{ rect: [f.x, f.y, f.w, f.h], nu: scaled ? cells(f.w, per[0]) : 40,
    nv: scaled ? cells(f.h, per[1]) : 40, within: f.panel?.outline ?? null }]);
  return { points: got.points, rect: f.panel.rect };
}

/**
 * Where a panel, or a rectangle on it, lands on the car, in millimetres:
 * `across` (left of the centreline is positive), `up`, and `behindNose`, each
 * as [least, most]. Measured on the model, on the panel's own island, a
 * sample every 8 mm or so, so an edge is found to within 4. Null where it
 * lands on no geometry.
 *
 * The mapping the stripe check stands on, handed out: a fraction of a panel
 * means nothing on the car until it is this.
 */
export function panelOnCar(model, profile, role, panel, at = [0, 0, 1, 1]) {
  const { points } = panelSamples(model, profile, role, panel, at);
  if (!points.length) return null;
  const { F, L, noseZ } = carFrame(model, profile);
  const extent = (f) => points.reduce(([lo, hi], q) => [Math.min(lo, f(q)), Math.max(hi, f(q))], [Infinity, -Infinity])
    .map((v) => Math.round(v * 1000));
  return {
    across: extent((q) => q.x * L), up: extent((q) => q.y), behindNose: extent((q) => (noseZ - q.z) * F),
    samples: points.length,
  };
}

/**
 * The `at` on a panel that paints a band of the car: `across` as [from, to] in
 * millimetres left of the centreline, or `up` in millimetres up for a band
 * along a flank, running the panel's whole length the other way. The inverse
 * of `panelOnCar`, and what a stripe's pieces want: the same band across the
 * car, whatever fractions each panel needs for it.
 *
 * Fitted, not assumed: which of the panel's axes runs across the band and how
 * fast are read off the samples, and `error` says in millimetres how far the
 * panel strays from that straight line — a few on a flat bonnet, more on one
 * that curls or is laid out on a slant. Null, with `why`, where the band misses
 * the panel or the panel has no geometry.
 */
export function stripeAt(model, profile, role, panel, { across = null, up = null } = {}) {
  const want = across ?? up;
  if (!Array.isArray(want) || want.length !== 2) throw new Error('stripeAt needs across: [from, to] or up: [from, to], in millimetres');
  const { points: all, rect: [rx, ry, rw, rh] } = panelSamples(model, profile, role, panel, [0, 0, 1, 1]);
  if (all.length < 3) return { at: null, why: `${panel} lands on no geometry` };
  const { L } = carFrame(model, profile);
  const lat = across ? (q) => q.x * L * 1000 : (q) => q.y * 1000;
  // Fitted where the band is, not over the whole island. Islands wrap down
  // the sides and round the corners, where across the car stops changing:
  // fitted over all of it the NSX's roof strayed 708 mm from a straight line,
  // and its bumper's stripe came out 590 mm wide where 500 was asked for.
  const [lo, hi] = [...want].sort((m, n) => m - n);
  const points = all.filter((q) => lat(q) >= lo - STRIPE_FIT_MM && lat(q) <= hi + STRIPE_FIT_MM);
  if (points.length < 3) return { at: null, why: `the band misses ${panel}` };
  const fit = (f) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (const q of points) {
      const x = f(q), y = lat(q);
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
    }
    const vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n, cxy = sxy - (sx * sy) / n;
    const b = vx > 0 ? cxy / vx : 0;
    return { a: (sy - b * sx) / n, b, r2: vx > 0 && vy > 0 ? (cxy * cxy) / (vx * vy) : 0 };
  };
  const byX = fit((q) => (q.u - rx) / rw), byY = fit((q) => (q.v - ry) / rh);
  const axis = byX.r2 >= byY.r2 ? 'x' : 'y';
  const { a, b } = axis === 'x' ? byX : byY;
  if (!(Math.abs(b) > 1e-6)) return { at: null, why: `nothing across ${panel} moves ${across ? 'across the car' : 'up it'}` };
  const [f0, f1] = want.map((mm) => (mm - a) / b).sort((m, n) => m - n).map((f) => Math.max(0, Math.min(1, f)));
  if (!(f1 > f0)) return { at: null, why: `the band misses ${panel}` };
  const frac = (q) => (axis === 'x' ? (q.u - rx) / rw : (q.v - ry) / rh);
  const error = Math.round(points.reduce((worst, q) => Math.max(worst, Math.abs(lat(q) - (a + b * frac(q)))), 0));
  const r4 = (n) => Math.round(n * 10000) / 10000;
  return { at: axis === 'x' ? [r4(f0), 0, r4(f1 - f0), 1] : [0, r4(f0), 1, r4(f1 - f0)], error };
}

/** The panels of a sheet the world sees, BARELY_SEEN or more: the ones a stripe is held to. */
const seenPanels = (profile, role) => Object.entries(profile.panels?.[role] ?? {})
  .filter(([, q]) => Array.isArray(q.rect) && typeof q.visible === 'number' && q.visible >= BARELY_SEEN)
  .map(([panel, q]) => ({ panel, visible: q.visible, rect: q.rect, mesh: q.source?.mesh ?? null,
    outline: Array.isArray(q.outline) && q.outline.length >= 3 ? q.outline : null }));

/**
 * The sheet a mesh wears as paint, lower-cased, or '' for glass. By its
 * diffuse file, and never for glass, told as the renderer tells it (`glass`
 * in engine/geometry.mjs): a windscreen may reuse the body's diffuse file,
 * and taken by filename alone it is bodywork a stripe must cover, which is
 * the one thing glass is not.
 */
function sheetOf(model, m) {
  const mat = model.materials?.[model.meshes[m].materialId];
  return blends(mat) && isGlass(mat?.shader) ? '' : (mat?.slots?.txDiffuse ?? '').toLowerCase();
}

/**
 * Which of those panels a point on the sheet lies on: its box, then its
 * outline, and its own mesh where the profile names one — outlines enclose
 * other islands' texels (see `ownMeshes`), and the mesh tells them apart.
 */
const panelAtUv = (panels, u, v, mesh = null) => panels.find(({ rect: [x, y, w, h], outline, mesh: own }) =>
  u >= x && u <= x + w && v >= y && v <= y + h && (!own || !mesh || own === mesh) && (!outline || inPoly(outline, [u, v])));

/**
 * The panels of one sheet a band along the car crosses, seen from above, front
 * to back: what a stripe of that band is painted on. `across` is [from, to] in
 * millimetres left of the centreline. Each comes with where it lies along the
 * car, `behindNose`, and the most of the band's width it carries, `carriesMm`;
 * one the band covers too little of to measure, under two cells of the grid
 * either way, comes marked `measured: false`, as the coverage check says of it.
 * Glass is never one, whichever sheet its diffuse is (see `sheetOf`).
 *
 * Read off the same view of the car `stripeCoverage` holds a stripe to, so a
 * stripe laid out from this is the one that check asks for. A hatch set into
 * the roof is in it because it is in the band, whatever it is called; a rear
 * wing is in it because seen from above it is the surface over the deck. What
 * is seen through a hole is not: a stretch enclosed along the car by one
 * panel that dips more than OPENING_DEPTH below it, as the NSX's bonnet vent
 * does, is that panel's hole and gets no piece.
 */
export function stripePanels(model, profile, role, across) {
  const { F, L, noseZ } = carFrame(model, profile);
  const env = envelope(model, profile, 1, 1);
  const file = texture(profile, role).file.toLowerCase();
  const panels = seenPanels(profile, role);
  const [lo, hi] = across.map((mm) => (mm / 1000) * L).sort((a, b) => a - b);
  const cols = [];
  for (let i = 0; i < env.cols; i++) {
    const c = env.c0 + (i + 0.5) * ENVELOPE_CELL;
    if (c >= lo && c <= hi) cols.push(i);
  }
  const order = [...Array(env.rows).keys()];
  if (F > 0) order.reverse();
  const rows = order.map((j) => {
    const row = { j, cells: [], h: 0, top: null };
    const count = new Map();
    for (const i of cols) {
      const k = j * env.cols + i, m = env.M[k];
      if (m < 0 || sheetOf(model, m) !== file) continue;
      const pan = panelAtUv(panels, env.U[k], env.V[k], model.meshes[m].name);
      if (!pan) continue;
      row.cells.push(pan);
      row.h += env.H[k];
      count.set(pan, (count.get(pan) ?? 0) + 1);
    }
    if (row.cells.length) {
      row.h /= row.cells.length;
      row.top = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    return row;
  });

  // Runs of rows under one main panel; a panel's next run with rows under
  // others between encloses them, and they are its hole if any dips too far.
  const runs = [];
  rows.forEach((r, x) => {
    if (!r.top) return;
    const last = runs.at(-1);
    if (last && last.top === r.top && last.to === x - 1) last.to = x;
    else runs.push({ top: r.top, from: x, to: x });
  });
  const hole = new Set();
  runs.forEach((a, n) => {
    const b = runs.slice(n + 1).find((q) => q.top === a.top);
    if (!b || b === runs[n + 1] && b.from === a.to + 1) return;
    const h0 = rows[a.to].h, h1 = rows[b.from].h;
    const line = (x) => h0 + ((x - a.to) / (b.from - a.to)) * (h1 - h0);
    let deep = false;
    for (let x = a.to + 1; x < b.from; x++) if (rows[x].top && rows[x].h < line(x) - OPENING_DEPTH) deep = true;
    if (deep) for (let x = a.to + 1; x < b.from; x++) hole.add(x);
  });

  const edgeMm = (z) => Math.max(0, Math.round((noseZ - z) * F * 1000));
  const byPanel = new Map();
  rows.forEach((r, x) => {
    if (hole.has(x)) return;
    const here = new Map();
    for (const pan of r.cells) here.set(pan, (here.get(pan) ?? 0) + 1);
    for (const [pan, n] of here) {
      const s = byPanel.get(pan) ?? { rows: [], widest: 0 };
      s.rows.push(x);
      s.widest = Math.max(s.widest, n);
      byPanel.set(pan, s);
    }
  });
  return [...byPanel.entries()]
    .sort((a, b) => a[1].rows[0] - b[1].rows[0])
    .map(([pan, s]) => ({
      panel: pan.panel, visible: pan.visible,
      behindNose: [edgeMm(env.r0 + (rows[s.rows[0]].j + (F > 0 ? 1 : 0)) * ENVELOPE_CELL),
        edgeMm(env.r0 + (rows[s.rows.at(-1)].j + (F > 0 ? 0 : 1)) * ENVELOPE_CELL)],
      carriesMm: Math.round(s.widest * ENVELOPE_CELL * 1000),
      // More than one cell of the grid each way, as a notch must be to be one.
      // Less is still a panel the band crosses, and was once filtered out
      // here, so a layout neither laid a piece on it nor said it had not.
      ...(s.rows.length >= 2 && s.widest >= 2 ? {} : { measured: false }),
    }));
}

/**
 * How far below the stripe a surface may be seen and still be the car's skin
 * rather than something seen through a hole in it.
 *
 * The NSX's bonnet has a vent behind the radiator, and seen from above the
 * nearest surface through it is the duct beneath, on the body's own sheet and
 * 79% visible — so the first version of this check told run 20 to paint a
 * stripe down a vent, which is the mistake the critic made in the same run.
 * The duct's floor is 440 mm below the bonnet. Bodywork a stripe crosses
 * between two of its pieces bends away from a straight line between them by
 * far less than 100 mm, and a hole goes far deeper.
 */
const OPENING_DEPTH = 0.1;

/**
 * The stretches of a bare run of rows, [first, last], that are bodywork and
 * not a view into an opening; `ahead` and `behind` are the painted rows either
 * side of it, or -1 at an end of the stripe.
 *
 * A row is looking into an opening when its nearest surface is more than
 * OPENING_DEPTH below a straight line between the stripe on either side. And
 * when the stripe's own piece is painted on both sides, the whole run is one
 * hole in that piece's panel as soon as any of it is that deep: the second
 * version measured the NSX's vent row by row, and the duct's rear wall, which
 * climbs back up to meet the bonnet, came out as 140 mm of bodywork to paint.
 * The stripe is drawn right across that hole already; the panel is what has
 * none there. Between two different pieces, only the deep rows are left out,
 * so bare bodywork beside a vent is still bare.
 *
 * Never at an end. The bodywork falls away down the nose and the tail, which
 * is no hole, and a stripe that stops short there has stopped short.
 */
function bodyworkIn(rows, start, end, ahead, behind) {
  if (ahead < 0 || behind < 0) return [[start, end]];
  const line = (i) => rows[ahead].h + ((i - ahead) / (behind - ahead)) * (rows[behind].h - rows[ahead].h);
  const deep = (i) => rows[i].h < line(i) - OPENING_DEPTH;
  let any = false;
  for (let i = start; i <= end; i++) if (deep(i)) any = true;
  if (!any) return [[start, end]];
  if (rows[ahead].by === rows[behind].by) return [];
  const out = [];
  let from = -1;
  for (let i = start; i <= end + 1; i++) {
    const body = i <= end && !deep(i);
    if (body && from < 0) from = i;
    if (!body && from >= 0) { out.push([from, i - 1]); from = -1; }
  }
  return out;
}

/**
 * The car as seen from one side, a 20 mm cell at a time: for each cell, the
 * surface nearest the eye — which mesh, how near, and where on its sheet.
 *
 * From above (`axis` 1) the cells run along the car and across it; from a
 * side (`axis` 0, `sign` the side) along the car and up it. Every mesh the car
 * shows is drawn, glass and grilles included, because what is in front of the
 * bodywork is the whole question. It depends on the car and nothing in the
 * design, so it is built once a model and view and kept with the model, like
 * the occupancy grid: on the NSX that is 610,000 triangles, once.
 */
const ENVELOPE_CELL = 0.02;
const envelopeCache = new WeakMap();
function envelope(model, profile, axis, sign) {
  const key = `${JSON.stringify(Object.keys(profile?.hiddenByCar?.meshes ?? {}).sort())}|${axis}|${sign}`;
  let byKey = envelopeCache.get(model);
  if (!byKey) envelopeCache.set(model, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key);

  const across = axis === 1 ? 0 : 1;
  const meshes = carOccluders(model, profile);
  const at = (p) => [p.z, across === 0 ? p.x : p.y, (axis === 1 ? p.y : p.x) * sign];
  let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.vertexCount; i++) {
      const [r, c] = at(vertex(model, mesh, i));
      if (r < r0) r0 = r; if (r > r1) r1 = r;
      if (c < c0) c0 = c; if (c > c1) c1 = c;
    }
  }
  const rows = Number.isFinite(r0) ? Math.max(1, Math.ceil((r1 - r0) / ENVELOPE_CELL - 1e-9)) : 0;
  const cols = Number.isFinite(c0) ? Math.max(1, Math.ceil((c1 - c0) / ENVELOPE_CELL - 1e-9)) : 0;
  const H = new Float64Array(rows * cols).fill(-Infinity);
  const M = new Int32Array(rows * cols).fill(-1);
  const U = new Float32Array(rows * cols), V = new Float32Array(rows * cols);
  for (const mesh of meshes) {
    const own = model.meshes.indexOf(mesh);
    for (const [ia, ib, ic] of triangles(model, mesh)) {
      const A = vertex(model, mesh, ia), B = vertex(model, mesh, ib), C = vertex(model, mesh, ic);
      const [ar, ac, ah] = at(A), [br, bc, bh] = at(B), [cr, cc, ch] = at(C);
      const det = (br - ar) * (cc - ac) - (cr - ar) * (bc - ac);
      if (Math.abs(det) < 1e-14) continue;              // edge-on to the eye: covers nothing
      const j0 = Math.max(0, Math.ceil((Math.min(ar, br, cr) - r0) / ENVELOPE_CELL - 0.5));
      const j1 = Math.min(rows - 1, Math.floor((Math.max(ar, br, cr) - r0) / ENVELOPE_CELL - 0.5));
      const i0 = Math.max(0, Math.ceil((Math.min(ac, bc, cc) - c0) / ENVELOPE_CELL - 0.5));
      const i1 = Math.min(cols - 1, Math.floor((Math.max(ac, bc, cc) - c0) / ENVELOPE_CELL - 0.5));
      for (let j = j0; j <= j1; j++) {
        const r = r0 + (j + 0.5) * ENVELOPE_CELL;
        for (let i = i0; i <= i1; i++) {
          const c = c0 + (i + 0.5) * ENVELOPE_CELL;
          const b1 = ((r - ar) * (cc - ac) - (cr - ar) * (c - ac)) / det;
          const b2 = ((br - ar) * (c - ac) - (r - ar) * (bc - ac)) / det;
          const b0 = 1 - b1 - b2;
          if (b0 < 0 || b1 < 0 || b2 < 0) continue;
          const h = ah * b0 + bh * b1 + ch * b2;
          const k = j * cols + i;
          if (h <= H[k]) continue;
          H[k] = h;
          M[k] = own;
          U[k] = A.u * b0 + B.u * b1 + C.u * b2;
          V[k] = A.v * b0 + B.v * b1 + C.v * b2;
        }
      }
    }
  }
  const out = { across, r0, r1, c0, rows, cols, H, M, U, V };
  byKey.set(key, out);
  return out;
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
  // A mismatch between the profile and the model is a FINDING, not a quiet
  // return. Both geometry checks live in this function, so bailing out here
  // skipped them while `checked` still claimed they had run — the exact shape
  // of silent pass this module exists to refuse.
  let file;
  try {
    file = texture(profile, t.role).file;
  } catch (e) {
    say({ kind: 'unresolvable', severity: 'fatal', surface: t.from, ids: [],
      why: `${t.role} has no texture in this car's profile, so nothing about where ` +
        `it lands on the model could be checked: ${e.message}` });
    return;
  }
  const meshes = meshesUsingTexture(seen.model, file);
  if (!meshes.length) {
    say({ kind: 'unresolvable', severity: 'fatal', surface: t.from, ids: [],
      why: `no mesh in this car's model uses ${file}, which the profile says ${t.role} ` +
        'paints. Nothing could be checked about visibility or coverage for it — the ' +
        'profile and the model disagree.' });
    return;
  }

  for (const p of placed) {
    const at = [p.frac.x, p.frac.y, p.frac.w, p.frac.h];
    // Sampled over the placement's own shape where it has one. Cast at the box
    // instead, a piece that arrived through a seam spends half its samples on
    // texture it does not paint, and both answers below — how much is on the
    // car, how much can be seen — come back describing that empty half.
    const answer = rectVisibility(seen.model, seen.prepared, meshes, at,
      { poly: p.frac.poly ?? null, grid: fineGrid(p) });

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
    // A declared floor replaces the default one, and makes the finding high:
    // the design said how much of this has to be seen, and it is not.
    const askedSeen = typeof p.constraints.minVisible === 'number' ? p.constraints.minVisible : null;
    if (answer.fraction >= (askedSeen ?? BARELY_SEEN)) continue;
    // A band that runs off a fender continues into the wheel arch liner,
    // because that is where the bodywork goes. The piece a spanning region
    // leaves on a panel it merely spilled onto is not a placement anybody
    // chose, and out of sight is exactly where such a piece is allowed to
    // be; it is only worth a word when it is words. The home piece is held
    // to the usual standard.
    const spilled = p.region.span === true && p.spilled;
    if (spilled && !carries && askedSeen === null) continue;
    say({
      kind: 'unseen',
      severity: askedSeen !== null || (answer.fraction < 0.1 && !spilled) ? 'high' : 'low',
      surface: t.from,
      panel: p.region.panel,
      ids: [p.id],
      visible: round(answer.fraction),
      samples: answer.samples,
      why: `${p.id} is ${pct(answer.fraction)}% visible from trackside ` +
        `(${answer.samples} points cast), on a panel measured at ` +
        `${((p.frac.panel?.visible ?? 1) * 100).toFixed(0)}% — so it is in the part ` +
        'of the panel something else stands in front of' +
        underWhat(answer) +
        (askedSeen !== null ? `; it asked for at least ${Math.round(askedSeen * 100)}%` : ''),
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

const rectOf = ([x, y, w, h]) => ({ x, y, w, h });
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * How much texture a placement covers, and how much two of them share.
 *
 * A placement is a box until it crosses a seam, and then it is whatever shape
 * the fold left. Both are handled here rather than at four call sites, because
 * the failure of getting it wrong is quiet in both directions: measured as
 * boxes, two diagonal bands that pass each other are reported as a collision,
 * and a band that does cover a name is reported as covering less of it than it
 * does. Every placement's polygon is convex — an affine image of a rectangle,
 * clipped to rectangles — which is what `sharedArea` needs.
 */
const shapeOf = (r) => (Array.isArray(r.poly) && r.poly.length >= 3
  ? r.poly
  : rectPoly([r.x, r.y, r.w, r.h]));
const area = (r) => (Array.isArray(r.poly) && r.poly.length >= 3 ? polyArea(r.poly) : r.w * r.h);
const boxesMeet = (a, b) =>
  Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
// Boxes first: two rectangles that miss cannot share anything, and answering
// that with arithmetic rather than with a clip keeps this cheap for the design
// with two hundred regions in it.
const intersect = (a, b) => (boxesMeet(a, b) ? sharedArea(shapeOf(a), shapeOf(b)) : 0);

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
  // Unrolled. The tidy version allocated a three-element array of pairs per
  // vertex, and a GT3 car is a quarter of a million vertices per pass.
  for (let i = 0; i < mesh.vertexCount; i++) {
    const p = vertex(model, mesh, i);
    if (p.x < lo[0]) lo[0] = p.x; if (p.x > hi[0]) hi[0] = p.x;
    if (p.y < lo[1]) lo[1] = p.y; if (p.y > hi[1]) hi[1] = p.y;
    if (p.z < lo[2]) lo[2] = p.z; if (p.z > hi[2]) hi[2] = p.z;
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

function stacked(model, profile, targets, say, { design = {} } = {}) {
  const painted = new Map();                    // texture file -> role that paints it
  for (const t of targets) {
    const file = texture(profile, t.role)?.file;
    if (file) painted.set(file.toLowerCase(), { role: t.role, from: t.from });
  }

  // A twin that is not drawn draws over nothing. Two ways for that to be so:
  // the design hides its texture, which the build now ships transparent; or
  // the car's own config hides the mesh, as the profile recorded. This check
  // used to report the NSX's IGT emissive plate as an unpainted twin with both
  // of those true — a high finding about a part the game never shows, and the
  // kind of noise that teaches people to stop reading the list.
  //
  // A hide is only worth this silence when it WORKS. Naming a role under
  // `hide` is a request, and the build answers it five different ways: an
  // opaque shader takes no clear sheet, and the surface is drawn in the game
  // exactly as before. Reading the request rather than the answer, this check
  // went quiet about a twin that is still there, still unpainted, and still
  // putting the car's own artwork over the design's — which is the finding it
  // exists for, silenced by the design asking for the opposite.
  const paintedRoles = new Set(targets.map((t) => t.role));
  const designHides = new Set(hidePlan(profile, design, { paintedRoles })
    .filter((h) => hideTakesEffect(h.action))
    .map((h) => h.file?.toLowerCase()).filter(Boolean));
  const carHides = new Set(Object.keys(profile.hiddenByCar?.meshes ?? {}));

  // Bounds once per mesh, keyed by the texture it wears.
  const byFile = new Map();
  for (const mesh of model.meshes ?? []) {
    if (carHides.has(mesh.name)) continue;
    const file = (model.materials?.[mesh.materialId]?.slots?.txDiffuse ?? '').toLowerCase();
    if (!file || designHides.has(file)) continue;
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
        // Hoisted: whether the OTHER texture is painted is a fact about the
        // texture, and testing it once per mesh walked the whole list to reach
        // the same answer every time.
        if (painted.has(other)) continue;
        for (const q of theirs) {
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
