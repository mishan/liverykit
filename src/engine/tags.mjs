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

  const out = {};
  for (const [role, panels] of Object.entries(profile.panels ?? {})) {
    out[role] = {};
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

      out[role][name] = tags;
    }
  }
  return out;
}

/** Attach tags to a profile in place, and report how many panels got them. */
export function tagProfile(profile) {
  const tags = computeTags(profile);
  let tagged = 0;
  for (const [role, byPanel] of Object.entries(tags)) {
    for (const [name, list] of Object.entries(byPanel)) {
      if (!list.length) continue;
      profile.panels[role][name].tags = list;
      tagged++;
    }
  }
  return { tagged };
}
