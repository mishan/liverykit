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
export function applyFit(regions, fit, { profile, role, used = new Set(), notes = [] } = {}) {
  if (!fit?.regions) return { regions, notes };

  const out = [];
  for (const region of regions) {
    const o = region.id !== undefined ? fit.regions[region.id] : undefined;
    if (!o) { out.push(region); continue; }
    used.add(region.id);

    if (o.drop) continue;

    const next = { ...region };
    for (const k of OVERRIDABLE) {
      if (k === 'drop' || o[k] === undefined) continue;
      next[k] = o[k];
    }

    if (o.panel !== undefined) {
      if (!profile?.panels?.[role]?.[o.panel] && !profile?.aliases?.[role]?.[o.panel]) {
        notes.push({
          term: region.id, status: 'fit-stale',
          text: `fit: "${region.id}" points at panel "${o.panel}", which ${role} does not have — ` +
                `the region was left as the livery placed it`,
        });
        out.push(region);
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

/** Ids a fit mentions that the livery does not declare. */
export function unusedFitIds(fit, used) {
  return Object.keys(fit?.regions ?? {}).filter((id) => !used.has(id));
}
