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
//   side      left | right | centre        which side of the centreline
//   section   nose | front | mid | rear | tail
//   level     upper | lower
//   visible   readable from trackside
//   cockpit   readable from the driver's seat
//   mirrored  has a mirror-image partner on the other side
//   sidewall  a tyre's sidewall; tread, its tread — from the wheel measurement
//
// A livery then says `{ tags: ['left', 'mid'] }` and gets whatever this car has
// there, or nothing, reported.
//
// COMPUTED FROM THE PROFILE, NOT THE MODEL. Everything here comes out of fields
// a profile already stores — centroid3d, visible, visibleFromCockpit, mirrorOf —
// so an existing hand-tuned profile can be tagged without regenerating it and
// losing its aliases, renames and notes. It also means one implementation rather
// than one for generation and another for migration.
//
// `level` is measured against the CAR's vertical extent rather than each
// island's own bounding box. The per-island version is nearly content-free: an
// island's centroid sits above or below its own centre for reasons that have
// nothing to do with where it is on the car. "In the top half of the car" is a
// fact a livery can use.
// ---------------------------------------------------------------------------

/** Cut points as fractions of the car's length, tail (0) to nose (1). */
const SECTIONS = [
  [0.82, 'nose'], [0.62, 'front'], [0.38, 'mid'], [0.18, 'rear'], [-Infinity, 'tail'],
];

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
export function computeTags(profile) {
  const axes = profile.calibration?.axes ?? {};
  const left = axes.left === '-X' ? -1 : 1;
  const front = axes.front === '-Z' ? -1 : 1;

  // The car's extent, from the panels themselves. A profile is the only input,
  // so the bounds have to come from it.
  let xMax = 0, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (const panels of Object.values(profile.panels ?? {})) {
    for (const p of Object.values(panels)) {
      const c = p.centroid3d;
      if (!Array.isArray(c) || c.length !== 3) continue;
      xMax = Math.max(xMax, Math.abs(c[0]));
      yMin = Math.min(yMin, c[1]); yMax = Math.max(yMax, c[1]);
      zMin = Math.min(zMin, c[2]); zMax = Math.max(zMax, c[2]);
    }
  }
  const halfWidth = xMax || 1;
  const ySpan = (yMax - yMin) || 1;
  const zSpan = (zMax - zMin) || 1;

  const tyreRoles = Array.isArray(profile.bind?.tyres?.roles) ? profile.bind.tyres.roles : null;
  const out = {};
  for (const [role, panels] of Object.entries(profile.panels ?? {})) {
    out[role] = {};
    const perPanel = {};
    for (const [name, p] of Object.entries(panels)) {
      const tags = [];
      const c = p.centroid3d;

      if (Array.isArray(c) && c.length === 3) {
        const xr = (c[0] * left) / halfWidth;
        tags.push(Math.abs(xr) < 0.18 ? 'centre' : xr > 0 ? 'left' : 'right');

        let zr = (c[2] - zMin) / zSpan;
        if (front < 0) zr = 1 - zr;
        tags.push(SECTIONS.find(([cut]) => zr > cut)[1]);

        tags.push((c[1] - yMin) / ySpan > 0.5 ? 'upper' : 'lower');
      }

      // Visibility thresholds, not raw fractions. A livery asking for "the bits
      // you can see" should not have to pick a number, and the number would not
      // mean the same thing on two cars anyway.
      if (typeof p.visible === 'number' && p.visible >= 0.5) tags.push('visible');
      if (typeof p.visibleFromCockpit === 'number' && p.visibleFromCockpit >= 0.3) tags.push('cockpit');
      if (p.mirrorOf) tags.push('mirrored');
      // Tyre parts, from the wheel measurement. `sidewall` is what a design
      // means by "the tyre": the part with the lettering, that a spectator
      // sees. The tread is the other part, and a design painting it is
      // painting the road.
      // Only on the texture bound as the tyres: a rim's face and a brake
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
