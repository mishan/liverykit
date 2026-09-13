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

import { resolveTargets, expandRegions, resolveRect, texture, metresNarrowest, spanPlacements, panel as panelOf, panelName } from './profile.mjs';
import { applyFit } from './fit.mjs';
import { getPack } from './registry.mjs';
import { hidePlan, hideTakesEffect } from './hide.mjs';
import { occupancyFor, rectVisibility, carOccluders } from './engine/visibility.mjs';
import { polyArea, sharedArea, rectPoly, inPoly } from './engine/poly.mjs';
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
 */
const PLACEMENT_FIELDS = new Set([
  'id', 'treatment', 'panel', 'tags', 'at', 'rotate', 'scale', 'safe',
  'span', 'once', 'limit', 'constraints', 'drop', '__key',
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
    return { car: profile.id, checked: [], notChecked: ['everything'], findings: [
      { kind: 'unresolvable', severity: 'fatal', why: e.message },
    ] };
  }

  // Prepared once for the whole car, not once per region: the occupancy grid is
  // the expensive part of a visibility question and it does not depend on which
  // rectangle is being asked about.
  const seen = model ? { model, prepared: preparedFor(model, profile) } : null;

  const failed = [];
  let wantsMargin = false;
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
    all.push({ t, placed });

    const size = texSize(profile, t.role);
    overlaps(placed, t, sayHere, size, design.identity ?? {});
    ringOverflow(placed, t, sayHere);
    contrast(placed, t, design, sayHere, size);
    outsideSafe(placed, profile, t, sayHere);
    hiddenFace(placed, profile, t, sayHere);
    unreadable(placed, profile, t, sayHere);
    tooSmall(placed, t, sayHere, size, design.identity ?? {});
    unmirrored(placed, profile, t, sayHere);
    if (seen) unseen(placed, profile, t, seen, sayHere);
    if (seen) margins(placed, profile, t, seen, sayHere);
  }

  // Across surfaces rather than within one, so these cannot live in the loop above.
  grouped(all, design, fit, profile, say);
  if (model) stacked(model, profile, targets, say, { design });

  return {
    car: profile.id,
    name: profile.name || profile.id,
    checked: model ? ALL_CHECKS : ALL_CHECKS.filter((c) => !['unseen', 'off-mesh', 'unpainted-twin', 'margin'].includes(c)),
    // Named, so "no findings" cannot be mistaken for "nothing was skipped".
    notChecked: model ? [] : ['unseen', 'off-mesh', 'unpainted-twin', ...(wantsMargin ? ['margin'] : [])],
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
const preparedCache = new WeakMap();
function preparedFor(model, profile) {
  const hides = JSON.stringify(Object.keys(profile?.hiddenByCar?.meshes ?? {}).sort());
  let byHides = preparedCache.get(model);
  if (!byHides) preparedCache.set(model, (byHides = new Map()));
  if (!byHides.has(hides)) byHides.set(hides, occupancyFor(model, { occluders: carOccluders(model, profile) }));
  return byHides.get(hides);
}

const ALL_CHECKS = ['unmatched', 'unknown-field', 'overflows', 'margin', 'overlap', 'low-contrast', 'outside-safe', 'hidden-face', 'unreadable', 'too-small', 'ungrouped', 'unmirrored',
  'unseen', 'off-mesh', 'crossed', 'clipped', 'bad-constraint', 'unpainted-twin'];

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
  for (const n of expanded.notes) {
    if (n.status !== 'no-match') continue;
    say({ kind: 'unmatched', severity: 'high', surface: t.from, ids: [n.id ?? t.from], why: n.text });
  }
  const out = expanded.regions.flatMap((r, i) => {
    let frac = null;
    try {
      frac = resolveRect(profile, t.role, r);
    } catch (e) {
      say({ kind: 'unmatched', severity: 'high', surface: t.from, panel: r.panel,
        ids: [r.id ?? r.__key ?? `${t.from}#${i}`],
        why: `${r.id ?? 'a region'} names a panel this car does not have, so it paints nothing: ${e.message}` });
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

      // A RING and some text: measured by the circle, not by the boxes.
      //
      // The box of a halo contains the box of the number it surrounds, and it
      // contains the box of a number it runs straight through — the two
      // overlap identically, so this said "low" about both and the agent
      // called it intended. The question is whether an edge of the circle
      // crosses the text: a number wholly inside a solid disc, or wholly
      // inside a ring's hole, is a roundel or a halo doing its job.
      const aRing = A.region.treatment === 'ring', bRing = B.region.treatment === 'ring';
      if ((aRing && bText) || (bRing && aText)) {
        const [ring, text] = aRing ? [A, B] : [B, A];
        if (ringThroughText(ring, text, size, identity)) {
          say({
            kind: 'overlap', severity: 'high', surface: t.from, panel: A.region.panel,
            ids: [ring.id, text.id], share: round(share),
            why: `${name(t, ring.id)}'s circle runs through ${name(t, text.id)}: an edge of the ring ` +
              'crosses the text. Put the text wholly inside the ring, or move the ring outside it.',
          });
        }
        continue;
      }

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

/** Whether either edge of a ring's stroke passes through the letters of a text placement. */
function ringThroughText(ring, text, size, identity = {}) {
  const g = ringGeometry(ring, size);
  const [x0, y0, x1, y1] = inkBox(text, size, identity);
  const nearest = Math.hypot(Math.max(x0, Math.min(g.cx, x1)) - g.cx, Math.max(y0, Math.min(g.cy, y1)) - g.cy);
  const farthest = Math.max(...[[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => Math.hypot(x - g.cx, y - g.cy)));
  const crosses = (edge) => edge > 0 && nearest < edge && edge < farthest;
  return crosses(g.inner) || crosses(g.outer);
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

function luminance(hex) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrastRatio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function contrast(placed, t, design, say, size) {
  const palette = design.palette ?? {};
  const hex = (c) => {
    const v = palette[c] ?? c;
    return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null;
  };
  // What `q` paints at (x, y), in texture fractions: a colour name, undefined
  // where it paints nothing there, or null where it paints something whose
  // colour is not one known colour.
  const paintAt = (q, x, y) => {
    const f = q.frac;
    if (x < f.x || x > f.x + f.w || y < f.y || y > f.y + f.h) return undefined;
    const tr = q.region.treatment;
    if (tr === 'fill' || tr === 'stripe') return q.region.color ?? null;
    if (tr === 'ring') {
      const g = ringGeometry(q, size);
      const d = Math.hypot(x * size.w - g.cx, y * size.h - g.cy);
      return d >= g.inner && d <= g.outer ? (q.region.color ?? null) : undefined;
    }
    if (tr === 'text') return undefined;          // letters over letters: overlap's business
    return null;
  };
  for (const [i, p] of placed.entries()) {
    if (p.region.treatment !== 'text' || p.region.glow) continue;
    const inkName = p.region.color ?? 'white';     // the text treatment's default
    const ink = hex(inkName);
    if (!ink) continue;
    const cx = p.frac.x + p.frac.w / 2, cy = p.frac.y + p.frac.h / 2;
    let underName = t.spec?.background ?? null, what = 'the surface\'s background';
    for (let j = i - 1; j >= 0; j--) {
      const c = paintAt(placed[j], cx, cy);
      if (c === undefined) continue;
      underName = c;
      what = placed[j].id;
      break;
    }
    const under = underName ? hex(underName) : null;
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
    // The narrowest the SHAPE is, which for a piece that crossed a seam is not
    // the short side of the box around it.
    const m = metresNarrowest(p.frac);
    if (m === null) continue;
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
const NUMBER_MM = 140;
const NAME_MM = 45;

/** Capital height over font size, for the bold sans the text treatment sets. */
const CAP = 0.72;

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
 * Null where it cannot be said: no `metresPerUv`, an angle that is not a
 * multiple of a quarter turn, or a spanning region, whose pieces are the band
 * cut up by seams rather than the frame it was drawn in.
 */
function letterSize(p, size, identity) {
  const per = p.frac.panel?.metresPerUv;
  if (!Array.isArray(per) || per.length !== 2 || p.region.span === true) return null;
  const f = textFrame(p, size, identity);
  if (!f) return null;
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
function tooSmall(placed, t, say, size, identity) {
  for (const p of placed) {
    if (p.region.treatment !== 'text') continue;
    const is = textIs(p.region, identity);
    if (!is) continue;
    const got = letterSize(p, size, identity);
    if (!got) continue;
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
