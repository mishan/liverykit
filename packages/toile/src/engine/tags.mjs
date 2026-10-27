// ---------------------------------------------------------------------------
// Panel tags.
//
// A binding gets a livery as far as "this car's bodywork is that texture". It
// does not get it to "the upper left flank", because panel NAMES are per-car in
// exactly the way texture names are: `left_mid_upper` exists on one model and
// not on another, and a portable design cannot address it.
//
// Tags fix that by describing each panel in terms that are true of any car:
//
//   side      left | right | centre        which side of the centerline
//   section   nose | front | mid | rear | tail, on a car;
//             front | mid | back on anything else (calibration.kind)
//   level     upper | lower
//   visible   readable from trackside
//   cockpit   readable from the driver's seat
//   flat      turns less than FLAT_DEG across the whole panel (`bend`)
//   mirrored  has a mirror-image partner on the other side
//   sidewall  a tire's sidewall; tread, its tread — from the wheel measurement
//
// A livery then says `{ tags: ['left', 'mid'] }` and gets whatever this car has
// there, or nothing, reported.
//
// COMPUTED FROM THE PROFILE, NOT THE MODEL. Everything here comes out of fields
// a profile already stores — centroid3d, extent3d, visible, visibleFromCockpit,
// mirrorOf — so an existing hand-tuned profile can be tagged without
// regenerating it and losing its aliases, renames and notes. It also means one
// implementation rather than one for generation and another for migration.
//
// `level` is measured against the CAR's vertical extent rather than each
// island's own bounding box. The per-island version is nearly content-free: an
// island's centroid sits above or below its own centre for reasons that have
// nothing to do with where it is on the car. "In the top half of the car" is a
// fact a livery can use.
//
// SECTION AND LEVEL BY REACH, where the profile says how far an island reaches.
// A centroid is where an island's vertices are densest, which is the
// unwrapper's business: a door running from the sill to the window line, most
// of it along the middle of the car, was `lower` on the Exige, the Quattro and
// the 650 GT3 because its centroid sat a little below half height, and a design
// asking for the upper middle of the flank found nothing on any of them. So a
// panel carrying `extent3d` is tagged with every section and level it reaches
// into, as well as the one its centroid is in. A panel without it — every
// profile generated before it was recorded — is tagged as it always was.
// Reaching a section is not being in it, though, and where a selection keeps
// only its biggest matches, a panel centred there still comes first: see
// `reachOnly` here and `limit` in panelsWithTags.
// ---------------------------------------------------------------------------

import { SECTIONS, sectionAt, sectionsOf } from '../frame.mjs';

/** A panel whose surface turns this far or less across most of it is `flat`. */
export const FLAT_DEG = 25;

/** The two levels as bands, in the order tags are written, as SECTIONS are. */
const LEVEL_BANDS = [['upper', 0.5, Infinity, 0.5], ['lower', -Infinity, 0.5, 0.5]];

/**
 * Whether an extent [a, b] reaches into a band far enough to claim it: by a
 * quarter of its own length, or by half the band's.
 *
 * A quarter of the panel is what the doors above needed, 36% to 38% of their
 * height above the car's midline, and it keeps a panel that merely clips a
 * band from claiming it: the 906's rear quarter panels reach 11% to 20% into
 * `mid` and are not in the middle of the car. Half the band is what gives a
 * long flank every section it runs through, since no band is a quarter of a
 * panel that runs the car's whole length.
 */
function reaches(a, b, lo, hi, width) {
  const overlap = Math.min(b, hi) - Math.max(a, lo);
  return overlap > 0 && (overlap >= 0.25 * (b - a) || overlap >= 0.5 * width);
}

/**
 * A panel's `extent3d`, if it has a well-formed one: [[x0, y0, z0], [x1, y1, z1]].
 * A malformed one is refused by validateProfile, so the fallback here is for a
 * profile that never went through it, not a way of passing one over.
 */
function extentOf(p) {
  const e = p.extent3d;
  return Array.isArray(e) && e.length === 2
    && e.every((q) => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite)) ? e : null;
}

/**
 * Panels that occupy the same rectangle of the same texture.
 *
 * A PART is a thing on the car; a PANEL is a region of a texture. They are not
 * one to one, and assuming they are is wrong on nearly every car: across a
 * sample of eight, 42.8% of all panels shared their rectangle with another.
 * Instanced geometry is the usual cause — four wheels reusing one rim texture,
 * two mirrors, a row of identical bolts — and the four wheels really are drawn
 * from the same texels.
 *
 * This matters for two reasons, both of which used to bite silently.
 *
 * Tags on such panels CONTRADICT each other: the Abarth's wheel face is tagged
 * `left` on one instance and `right` on another, for the same pixels. A livery
 * asking for the left side would paint all four wheels and look like it worked.
 *
 * And painting a group once per instance stacks the artwork. Four passes of a
 * halftone at 0.3 opacity is not a 0.3 halftone, it is a 0.76 one.
 *
 * Keyed on the stored rectangle. Instanced geometry shares UV data exactly, so
 * the grouping is stable to the last decimal the profile records — checked
 * against 3, 4 and 6 places, which give the same answer.
 */
export function rectGroups(panels) {
  const groups = new Map();
  for (const [name, p] of Object.entries(panels)) {
    if (!Array.isArray(p.rect)) continue;
    const key = p.rect.join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }
  for (const names of groups.values()) names.sort();
  return groups;
}

/**
 * Tag every panel in a profile.
 *
 * Returns `{ [role]: { [panel]: string[] } }`. Panels with no `centroid3d` — a
 * hand-written profile, or one from the old screenshot workflow — get only the
 * tags that don't need geometry, rather than being skipped or guessed at.
 */
/**
 * The car's frame: which way it faces, and its extent, from the panels
 * themselves. A profile is the only input, so the bounds have to come from it.
 */
function frameOf(profile) {
  const axes = profile.calibration?.axes ?? {};
  // Absent on every profile from before there was anything but a car.
  const kind = profile.calibration?.kind ?? 'car';
  sectionsOf(kind);
  let xMax = 0, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  const ext = [[Infinity, Infinity], [-Infinity, -Infinity]];
  for (const panels of Object.values(profile.panels ?? {})) {
    for (const p of Object.values(panels)) {
      const c = p.centroid3d;
      if (!Array.isArray(c) || c.length !== 3) continue;
      xMax = Math.max(xMax, Math.abs(c[0]));
      yMin = Math.min(yMin, c[1]); yMax = Math.max(yMax, c[1]);
      zMin = Math.min(zMin, c[2]); zMax = Math.max(zMax, c[2]);
      const box = extentOf(p);
      if (box) for (const k of [0, 1]) {
        ext[0][k] = Math.min(ext[0][k], box[0][k + 1]);
        ext[1][k] = Math.max(ext[1][k], box[1][k + 1]);
      }
    }
  }
  // Where every centroid sits at one height or one length, as on a model of two
  // mirrored halves, their spread is no frame at all: each panel landed at the
  // tail and the bottom, whatever it covered. The panels' extents are the
  // model's size there. Only there: a car's centroids always spread, and
  // measuring cars against extents instead would move every car's tags.
  if (yMax === yMin && ext[1][0] > ext[0][0]) [yMin, yMax] = [ext[0][0], ext[1][0]];
  if (zMax === zMin && ext[1][1] > ext[0][1]) [zMin, zMax] = [ext[0][1], ext[1][1]];
  return {
    kind,
    left: axes.left === '-X' ? -1 : 1,
    front: axes.front === '-Z' ? -1 : 1,
    halfWidth: xMax || 1,
    yMin, ySpan: (yMax - yMin) || 1,
    zMin, zSpan: (zMax - zMin) || 1,
  };
}

/**
 * Where one panel is on the car: its side, the section and level its centroid
 * is in, and `reach`, the other sections and levels its extent reaches. Null
 * for a panel with no centroid.
 */
function placeOf(frame, p) {
  const c = p.centroid3d;
  if (!Array.isArray(c) || c.length !== 3) return p.plan ? planPlace(frame, p.plan) : null;
  const { left, front, halfWidth, yMin, ySpan, zMin, zSpan } = frame;
  const xr = (c[0] * left) / halfWidth;
  const side = Math.abs(xr) < 0.18 ? 'centre' : xr > 0 ? 'left' : 'right';

  let zr = (c[2] - zMin) / zSpan;
  if (front < 0) zr = 1 - zr;
  const section = sectionAt(zr, frame.kind);
  const level = (c[1] - yMin) / ySpan > 0.5 ? 'upper' : 'lower';

  // In the centroid's frame, so the centroid's own section and level are the
  // ones it always had.
  const reach = [];
  const box = extentOf(p);
  if (box) {
    let z0 = (box[0][2] - zMin) / zSpan, z1 = (box[1][2] - zMin) / zSpan;
    if (front < 0) [z0, z1] = [1 - z1, 1 - z0];
    const y0 = (box[0][1] - yMin) / ySpan, y1 = (box[1][1] - yMin) / ySpan;
    for (const [name, lo, hi, width] of SECTIONS[frame.kind]) {
      if (name !== section && reaches(z0, z1, lo, hi, width)) reach.push(name);
    }
    for (const [name, lo, hi, width] of LEVEL_BANDS) {
      if (name !== level && reaches(y0, y1, lo, hi, width)) reach.push(name);
    }
  }
  return { side, section, level, reach };
}

/**
 * Where a panel is by `plan`: its place in a template drawn as the car seen
 * from above, `across` from the car's right (-1) to its left (1) and `along`
 * from its tail (0) to its nose (1). Height is not in a plan, so there is no
 * level, rather than a guessed one.
 */
function planPlace(frame, { across: [x0, x1], along: [z0, z1] }) {
  const x = (x0 + x1) / 2;
  const side = Math.abs(x) < 0.18 ? 'centre' : x > 0 ? 'left' : 'right';
  const section = sectionAt((z0 + z1) / 2, frame.kind);
  const reach = SECTIONS[frame.kind].filter(([name, lo, hi, width]) => name !== section && reaches(z0, z1, lo, hi, width)).map(([n]) => n);
  return { side, section, level: null, reach };
}

/**
 * The sections and levels each panel carries only because its extent reaches
 * them, not because its centroid is there.
 *
 * Returns `{ [role]: { [panel]: string[] } }`, empty for a panel with no
 * extent. Tags only grow, so the tag list cannot say which of a flank's three
 * sections it is centred in, and two things need to: `limit`, which must not
 * let a panel that merely reaches a section take the pick from one centred
 * there, and the editor, which frees a region onto the section its panel is
 * in rather than every one it touches. Computed, not stored, so the profile
 * format does not change and a profile tagged before this still answers.
 */
export function reachOnly(profile) {
  const frame = frameOf(profile);
  const out = {};
  for (const [role, panels] of Object.entries(profile.panels ?? {})) {
    out[role] = {};
    for (const [name, p] of Object.entries(panels)) out[role][name] = placeOf(frame, p)?.reach ?? [];
  }
  return out;
}

export function computeTags(profile) {
  const frame = frameOf(profile);
  const tyreRoles = Array.isArray(profile.bind?.tyres?.roles) ? profile.bind.tyres.roles : null;
  const out = {};
  for (const [role, panels] of Object.entries(profile.panels ?? {})) {
    out[role] = {};
    const perPanel = {};
    for (const [name, p] of Object.entries(panels)) {
      const tags = [];
      const at = placeOf(frame, p);

      if (at) {
        // The centroid's own section and level, kept alongside whatever else
        // the extent reaches: tags only grow, so no selection that matched a
        // panel before stops matching it. Written in band order.
        const within = (n) => n === at.section || n === at.level || at.reach.includes(n);
        tags.push(at.side,
          ...SECTIONS[frame.kind].map(([n]) => n).filter(within),
          ...LEVEL_BANDS.map(([n]) => n).filter(within));
      }

      // Visibility thresholds, not raw fractions. A livery asking for "the bits
      // you can see" should not have to pick a number, and the number would not
      // mean the same thing on two cars anyway.
      // Or, where nothing measured it, as proposed: see `profileFromTemplate`.
      if ((typeof p.visible === 'number' && p.visible >= 0.5) || p.visibleBy) tags.push('visible');
      if (typeof p.visibleFromCockpit === 'number' && p.visibleFromCockpit >= 0.3) tags.push('cockpit');
      // A whole panel turns more than any rectangle on it, so this asks less
      // of a panel than the check asks of lettering: the Tatuus's flank reads
      // 18 degrees across all of it, the Abarth's door 27 and the NSX's 43.
      if (typeof p.bend === 'number' && p.bend <= FLAT_DEG) tags.push('flat');
      if (p.mirrorOf) tags.push('mirrored');
      // Tire parts, from the wheel measurement. `sidewall` is what a design
      // means by "the tire": the part with the lettering, that a spectator
      // sees. The tread is the other part, and a design painting it is
      // painting the road.
      // Only on the texture bound as the tires: a rim's face and a brake
      // disc sit by a wheel and face along the axle too, and would otherwise
      // be called sidewalls. The `wheel` measurement stays on all of them.
      if (tyreRoles === null || tyreRoles.includes(role)) {
        if (p.wheel?.part === 'sidewall') tags.push('sidewall');
        if (p.wheel?.part === 'tread') tags.push('tread');
      }

      perPanel[name] = tags;
    }

    // Reconcile panels that share a rectangle. Every member of a group gets the
    // INTERSECTION of what its members claim, so the four corners of a car keep
    // `lower` and `visible` but lose the side and section they disagree about.
    // Claiming `left` for texels that also appear on the right is the kind of
    // confident wrongness that renders fine and looks like it worked.
    for (const [, names] of rectGroups(panels)) {
      if (names.length === 1) { out[role][names[0]] = perPanel[names[0]]; continue; }
      const agreed = perPanel[names[0]].filter((t) => names.every((n) => perPanel[n].includes(t)));
      agreed.push('shared');
      for (const n of names) out[role][n] = agreed;
    }
  }
  return out;
}

/**
 * Attach tags to a profile in place.
 *
 * Also records `instances` and `sharesRectWith` on any panel that is one of
 * several drawn from the same texels, so the fact is visible to a person reading
 * the profile rather than only to the resolver.
 */
export function tagProfile(profile) {
  const tags = computeTags(profile);
  let tagged = 0;
  let shared = 0;

  for (const [role, byPanel] of Object.entries(tags)) {
    for (const [name, list] of Object.entries(byPanel)) {
      if (!list.length) continue;
      profile.panels[role][name].tags = list;
      tagged++;
    }
    // Clear before writing. Tagging runs again whenever a profile is regenerated
    // or edited, and a panel that used to share its rectangle may not any more —
    // a rect corrected by hand, an island that split. Leaving the old
    // `instances: 4` behind would describe a grouping that no longer exists, and
    // a stale claim is worse than none because it still reads as measured.
    for (const p of Object.values(profile.panels[role])) {
      delete p.instances;
      delete p.sharesRectWith;
    }

    for (const [, names] of rectGroups(profile.panels[role])) {
      if (names.length === 1) continue;
      shared += names.length;
      for (const n of names) {
        const p = profile.panels[role][n];
        p.instances = names.length;
        p.sharesRectWith = names.filter((x) => x !== n);
      }
    }
  }
  return { tagged, shared };
}
