// ---------------------------------------------------------------------------
// Fits: adjusting a portable design for one particular car.
//
// A portable livery picks the largest visible panel on the correct side and
// places its artwork centred there. That is the best a measurement can do. What
// no measurement knows is which PART of that panel is flat, which way is up on
// it, or whether the middle of the rectangle lands on a door or wraps over a
// wheel arch — so a car number sometimes wants nudging, and only a person
// looking at the car can say where.
//
// A fit records that nudge. It belongs to neither side:
//
//   * not to the livery, because writing per-car blocks into a design
//     de-genericises the thing the vocabulary exists to keep generic, and grows
//     without limit — one block per car anyone ever runs it on
//   * not to the car profile, which is shared by everyone who owns that car and
//     should stay as free of one design's opinions as it is of its colours
//
// It is a property of the (design, car) PAIR, so it is a third artefact:
//
//   fits/neon-grid-any@abarth500.json
//
// Overrides only, never a copy of the region. Treatment, colours and glow stay
// in the design, because that is the design. A car with no fit renders exactly
// as it would have; nothing here is mandatory.
//
// See docs/fitting.md.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * The name a fit knows a design by.
 *
 * A fit lives at `fits/<livery>@<car>.json` and repeats both halves of that pair
 * inside itself, so the two have to be derived the same way or the file
 * disagrees with its own name. This is the module basename — `neon-grid-any` —
 * and NOT `livery.folder`, which is the skin directory the game installs
 * (`neon_grid_any`) and is a different string on every design that has both.
 */
export function fitLiveryId(liveryPath) {
  return basename(liveryPath).replace(/\.mjs$/, '');
}

/**
 * Refuse a fit that is for some other design, or some other car.
 *
 * `--fit` takes an arbitrary path and the conventional one can go stale, so
 * nothing guarantees the file loaded describes the pair being worked on. Left
 * unchecked, the editor opens on one design's regions, resolves them against
 * another car's panels and writes the result back over the original — silently,
 * because each step on its own is valid.
 */
export function checkFitIdentity(f, { livery, car, source = '<inline>' }) {
  const mismatch = (field, want, got) => {
    throw new Error(
      `Fit ${source}: "${field}" is ${JSON.stringify(got)}, but this is a fit for ` +
      `${field} ${JSON.stringify(want)}. A fit belongs to one (design, car) pair — ` +
      `using it for another places one design's region ids on a car that never declared them.`
    );
  };
  if (livery && f.livery !== livery) mismatch('livery', livery, f.livery);
  if (car && f.car !== car) mismatch('car', car, f.car);
  return f;
}

/**
 * What a fit may change about a region.
 *
 * Deliberately short. `at`, `rotate` and `scale` move and turn artwork; `panel`
 * overrides which panel the tags chose. Everything absent from this list — the
 * treatment, the colours, the lane counts — is the design's business, and a fit
 * that could reach it would slowly become a second livery language.
 *
 * A fit also cannot ADD a region. Wanting to is a good sign the design needs the
 * change, not this car's copy of it.
 */
const OVERRIDABLE = new Set(['panel', 'at', 'rotate', 'scale', 'safe', 'drop']);

export async function loadFit(path) {
  return validateFit(JSON.parse(await readFile(path, 'utf8')), path);
}

export function validateFit(f, source = '<inline>') {
  const err = (m) => { throw new Error(`Fit ${source}: ${m}`); };

  if (!f.livery) err('missing "livery" — the design this fit adjusts');
  if (!f.car) err('missing "car" — the profile id this fit is for');
  if (f.regions && (typeof f.regions !== 'object' || Array.isArray(f.regions))) {
    err('"regions" must be an object keyed by region id');
  }
  for (const block of ['copies', 'mirrors']) {
    if (f[block] && (typeof f[block] !== 'object' || Array.isArray(f[block]))) {
      err(`"${block}" must be an object keyed by the new region id`);
    }
  }

  const declared = new Set(Object.keys(f.regions ?? {}));
  for (const [id, m] of Object.entries(copiesOf(f))) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      err(`copies."${id}" must be an object`);
    }
    if (!m.of || typeof m.of !== 'string') {
      err(`copies."${id}" needs "of": the id of the region it is a copy of`);
    }
    if (m.of === id) err(`copies."${id}" cannot be a copy of itself`);
    if (declared.has(id)) {
      err(`"${id}" is both a copied region and an override; it can only be one`);
    }
    for (const k of Object.keys(m)) {
      if (k !== 'of' && !OVERRIDABLE.has(k)) {
        err(`copies."${id}" may not set "${k}". A copy states where a region ALSO ` +
            `appears: ${['of', ...OVERRIDABLE].join(', ')}. It takes its artwork from ` +
            `"${m.of}" and cannot have any of its own.`);
      }
    }
    if (m.drop !== undefined) {
      err(`copies."${id}" cannot be dropped — delete the entry instead`);
    }
  }

  for (const [id, o] of Object.entries(f.regions ?? {})) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      err(`regions."${id}" must be an object of overrides`);
    }
    for (const k of Object.keys(o)) {
      if (!OVERRIDABLE.has(k)) {
        err(`regions."${id}" may not override "${k}". A fit adjusts placement only: ` +
            `${[...OVERRIDABLE].join(', ')}. Anything else belongs in the livery.`);
      }
    }
    if (o.drop !== undefined && typeof o.drop !== 'boolean') {
      err(`regions."${id}".drop must be true or false`);
    }
  }
  return f;
}

/**
 * The regions a fit adds, from either spelling.
 *
 * `mirrors` was the first name, before duplicating a region without mirroring
 * it turned out to be the same feature: a copy that takes its artwork from
 * another region and states a placement. A mirrored copy is one whose placement
 * was computed by reflecting; that is a fact about how the number was arrived
 * at, not about what the entry means. Both spellings load, `copies` is written.
 */
export function copiesOf(fit) {
  return { ...(fit?.mirrors ?? {}), ...(fit?.copies ?? {}) };
}

/**
 * The key a fit uses to address a region.
 *
 * An explicit `id` if the design gave one, and otherwise a POSITIONAL key made
 * from the surface and the region's index. Without this an existing livery is
 * entirely uneditable: neon-grid has 95 regions and not one id, so every row in
 * the editor read "no id" and nothing could be selected at all. The tool did
 * exactly what it was told and was useless, which is a flaw in the design rather
 * than in the code.
 *
 * A positional key is weaker than a name and is honestly worse: inserting a
 * region above it shifts what it refers to, and the fit then adjusts the wrong
 * thing. That is a real cost, so the editor labels these as derived and the
 * remedy — give the region an `id` in the livery — is one line. Being able to
 * work at all beats being unable to start.
 */
export function regionKey(surfaceKey, region, index) {
  return region.id ?? `${surfaceKey}#${index}`;
}

/**
 * Collect every region id a livery declares, and reject duplicates.
 *
 * Ids are flat across the whole livery rather than per surface, because that is
 * how a fit refers to them and a fit should not have to know which surface a
 * region lives on. Two regions sharing an id would make an override ambiguous,
 * which is the sort of thing that silently adjusts the wrong one.
 */
export function regionIds(livery) {
  const seen = new Map();
  const blocks = [
    ...Object.entries(livery.paint ?? {}),
    ...Object.entries(livery.surfaces ?? {}),
  ];
  for (const [where, spec] of blocks) {
    for (const r of spec.regions ?? []) {
      if (r.id === undefined) continue;
      if (typeof r.id !== 'string' || !r.id) {
        throw new Error(`Livery "${livery.name}": a region on "${where}" has a non-string id.`);
      }
      if (seen.has(r.id)) {
        throw new Error(
          `Livery "${livery.name}" uses the region id "${r.id}" twice — on ` +
          `"${seen.get(r.id)}" and "${where}". Ids are how a fit addresses a region, ` +
          `so they have to be unique across the livery.`
        );
      }
      seen.set(r.id, where);
    }
  }
  return seen;
}

/**
 * Apply a fit's overrides to one surface's regions.
 *
 * `at` stays PANEL-RELATIVE, the same as everywhere else in this system. A tool
 * that lets you drag on a texture naturally produces absolute coordinates, and
 * it should convert them on save rather than introducing a second meaning for
 * the same field.
 *
 * Anything a fit names that no longer exists is skipped and reported, not fatal.
 * A design gets edited, a profile gets regenerated, a panel gets renamed; a
 * stale fit is a nuisance rather than a corruption, and failing the build would
 * punish whoever edited the design rather than whoever wrote the fit. Silence is
 * the one option not on the table — a fit quietly doing nothing is this
 * project's oldest bug wearing yet another costume.
 */
export function applyFit(regions, fit, { profile, role, surfaceKey = '', used = new Set(), notes = [] } = {}) {
  // Keys are stamped even with no fit at all. A car nobody has tuned is the
  // common case, and the editor still has to be able to name every region in
  // order to let you start tuning one.
  const overrides = fit?.regions ?? {};

  const out = [];
  for (const [i, region] of regions.entries()) {
    const key = regionKey(surfaceKey, region, i);
    // Stamped on every region, overridden or not, so everything downstream —
    // the overlay, the placement report — can name it without recomputing the
    // index it came from.
    const o = overrides[key];
    if (!o) { out.push({ ...region, __key: key }); continue; }
    used.add(key);

    if (o.drop) continue;

    const next = { ...region, __key: key };
    for (const k of OVERRIDABLE) {
      if (k === 'drop' || o[k] === undefined) continue;
      next[k] = o[k];
    }

    if (o.panel !== undefined) {
      if (!profile?.panels?.[role]?.[o.panel] && !profile?.aliases?.[role]?.[o.panel]) {  // stale
        notes.push({
          term: key, status: 'fit-stale',
          text: `fit: "${key}" points at panel "${o.panel}", which ${role} does not have — ` +
                `the region was left as the livery placed it`,
        });
        out.push({ ...region, __key: key });
        continue;
      }
      // An explicit panel replaces the tag selection outright. Leaving the tags
      // in place would trip the "both panel and tags" guard, and keeping both
      // meanings would be ambiguous anyway.
      delete next.tags;
      delete next.limit;
    }

    out.push(next);
  }

  // --- mirrored copies ------------------------------------------------------
  //
  // This is the one place a fit adds a region, and it is worth being honest
  // about the tension. The rule above says a fit cannot ADD a region, because
  // wanting to usually means the DESIGN needs the change. A mirrored copy is
  // the exception that proves it rather than breaking it: it invents no
  // artwork. Treatment, colours, glow, text all come from the region it names,
  // and the only new information is a placement — which is exactly what a fit
  // is for.
  //
  // It earns the exception because symmetry is a property of the CAR, not of
  // the design. A livery that paints one badge is portable to a car with one
  // flank worth painting and to a car with two, and which of those you have is
  // not something the design can know.
  //
  // A mirror whose source lives on another surface is skipped in silence, not
  // reported: applyFit runs once per surface and every one of them would
  // otherwise report every other surface's mirrors as stale.
  for (const [id, m] of Object.entries(copiesOf(fit))) {
    const at = regions.findIndex((r, i) => regionKey(surfaceKey, r, i) === m.of);
    if (at < 0) continue;
    used.add(id);
    used.add(m.of);

    const src = out.find((r) => r.__key === m.of) ?? regions[at];
    const clone = { ...src, __key: id, id };
    // An explicit panel replaces tag selection outright, the same as an
    // override does; leaving the tags on would trip the "both panel and tags"
    // guard and would be ambiguous anyway.
    delete clone.tags;
    delete clone.limit;
    delete clone.once;
    for (const k of ['panel', 'at', 'rotate', 'scale', 'safe']) {
      if (m[k] !== undefined) clone[k] = m[k];
    }
    if (m.panel && !profile?.panels?.[role]?.[m.panel] && !profile?.aliases?.[role]?.[m.panel]) {
      notes.push({
        term: id, status: 'fit-stale',
        text: `fit: copied region "${id}" points at panel "${m.panel}", which ${role} ` +
              `does not have — it was not drawn`,
      });
      continue;
    }
    out.push(clone);
  }

  return { regions: out, notes };
}

// ---------------------------------------------------------------------------
// Coordinates.
//
// `at` is PANEL-RELATIVE everywhere in this system: [0, 0, 1, 1] is the whole
// panel and [0.5, 0, 0.5, 1] its rear half. An editor that lets you drag on a
// texture works in absolute texture fractions, because that is what a mouse
// gives you, so it converts on save. Introducing a second meaning for `at`
// depending on where it was written would be much worse than a conversion.
// ---------------------------------------------------------------------------

const r4 = (n) => Math.round(n * 10000) / 10000;

/** Panel-relative `at` -> absolute texture fractions. */
export function toAbsolute(panelRect, at = [0, 0, 1, 1]) {
  const [px, py, pw, ph] = panelRect;
  return [r4(px + at[0] * pw), r4(py + at[1] * ph), r4(at[2] * pw), r4(at[3] * ph)];
}

/**
 * Absolute texture fractions -> panel-relative `at`.
 *
 * A panel with zero width or height cannot express anything relative to itself;
 * those are dropped at profile generation, but an editor should not divide by
 * zero if one ever reaches it.
 */
export function toPanelRelative(panelRect, abs) {
  const [px, py, pw, ph] = panelRect;
  if (!pw || !ph) return [0, 0, 1, 1];
  return [r4((abs[0] - px) / pw), r4((abs[1] - py) / ph), r4(abs[2] / pw), r4(abs[3] / ph)];
}

// ---------------------------------------------------------------------------
// Mirroring a placement onto the opposite flank.
//
// `mirrorOf` is measured from GEOMETRY and says only that two panels are mirror
// images on the car. It says nothing about how each was unwrapped, and that is
// the part that matters. Copying a panel-relative `at` across assumes both
// islands run the same way in UV; on the RSS4 they do not, so moving the number
// forward on one flank moved it backward on the other. Reported from the car,
// exactly the shape the bug predicts.
//
// So the direction is measured too. Each panel records `uAxis` and `vAxis`: the
// world directions +u and +v travel in. Reflect one panel's axis through the
// centreline and compare it with the other's — agreement means the coordinate
// runs the same way, disagreement means it is reversed.
// ---------------------------------------------------------------------------

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Reflect through the centreline. Left and right differ only in x. */
const reflect = (v) => [-v[0], v[1], v[2]];

/**
 * Which of a mirrored pair's texture axes run opposite to each other.
 *
 * A panel with no measured axes — hand-written, or from a profile built before
 * this was recorded — reports no flip rather than a guess. That is exactly the
 * old behaviour: right about as often as it is wrong, but no worse than what
 * was there before, and it degrades quietly rather than inventing a direction.
 */
export function mirrorFlips(a, b) {
  const axis = (p, k) => (Array.isArray(p?.[k]) && p[k].length === 3 ? p[k] : null);
  const flip = (k) => {
    const x = axis(a, k), y = axis(b, k);
    return x && y ? dot3(reflect(x), y) < 0 : false;
  };
  return { u: flip('uAxis'), v: flip('vAxis') };
}

/**
 * Mirroring WITHIN one panel, for a panel that has no twin.
 *
 * A nose, an engine cover, a rear wing: these straddle the centreline, so they
 * are their own mirror and `mirrorOf` is rightly absent. Dragging one half of a
 * pair onto such a panel used to have no good answer — leaving the other half
 * behind splits an idea the design said was one, and unlinking silently decides
 * something the person did not ask for. Both halves go onto the panel, mirrored
 * within it, which is what a real car does with two numbers on a nose.
 *
 * Which axis to reverse is measured rather than assumed: whichever of the
 * panel's own axes runs most nearly across the car is the one the centreline
 * cuts. An island rotated in the unwrap has that role fall to `v`, and guessing
 * `u` would mirror it top to bottom instead of side to side.
 */
export function selfMirrorFlips(panel) {
  const across = (k) => (Array.isArray(panel?.[k]) && panel[k].length === 3 ? Math.abs(panel[k][0]) : -1);
  const [u, v] = [across('uAxis'), across('vAxis')];
  if (u < 0 && v < 0) return { u: false, v: false };   // nothing measured
  return { u: u >= v, v: v > u };
}

/** A panel-relative rectangle, moved to the equivalent place on the twin. */
export function mirrorAt(at, flips) {
  const [x, y, w, h] = at;
  return [
    r4(flips.u ? 1 - x - w : x),
    r4(flips.v ? 1 - y - h : y),
    r4(w), r4(h),
  ];
}

/**
 * The rotation that keeps artwork the same way up on the twin.
 *
 * Only the V axis matters, which is worth stating because it looks wrong at
 * first. Rotation is about which way the artwork READS, and "up" in an image is
 * the -v direction. Reversing u moves the artwork to the other end of the panel
 * without turning it over; reversing v inverts the panel's idea of up, so the
 * artwork needs half a turn to match.
 *
 * `auto` passes through untouched, because it is not an angle. It defers to
 * each panel's own measured textRotation, which already accounts for all of it.
 */
export function mirrorRotation(rotate, flips) {
  if (typeof rotate !== 'number' || !Number.isFinite(rotate)) return rotate;
  return flips.v ? (((rotate + 180) % 360) + 360) % 360 : rotate;
}

/** Ids a fit mentions that the livery does not declare. */
export function unusedFitIds(fit, used) {
  return [...Object.keys(fit?.regions ?? {}), ...Object.keys(copiesOf(fit))]
    .filter((id) => !used.has(id));
}
