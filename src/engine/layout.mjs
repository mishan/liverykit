// ---------------------------------------------------------------------------
// Outlines and seam maps, measured again from the car's own model.
//
// A shipped profile leaves them out. Together they sketch every island's shape
// and how it joins its neighbors, which is the car maker's UV layout and theirs
// to publish, where the rest of a profile is facts about it. They are also the
// only part that needs nothing but the model to recompute, so whoever has the
// model gets them back when it is found, and the file on disk stays as shipped.
// ---------------------------------------------------------------------------

import { profileFromKn5 } from './profilegen.mjs';

/**
 * The roles shipped without their layout: those where no panel has an outline.
 * By role rather than for the whole profile, so a role pasted in fresh from a
 * regeneration does not stop the others being filled.
 */
export function rolesWithoutLayout(profile) {
  return Object.entries(profile.panels ?? {})
    .filter(([, ps]) => !Object.values(ps).some((p) => p.outline !== undefined)).map(([role]) => role);
}

const sameRect = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);

/**
 * Give each panel of the given roles its outline and seams from a fresh
 * measurement of the model.
 *
 * Roles are matched by texture file, since a person may have renamed one.
 * Panels are matched by rectangle first and by name only between panels that
 * share one, because generated names get reused: correcting the naming once
 * gave `centre_mid` to a different island. A seam is renamed to the profile's
 * name for its neighbor, and left out when the neighbor matched nothing,
 * rather than pointed at whatever has that name. A panel that matches nothing
 * is listed in `missed`, and so is each seam left out.
 *
 * The measurement is made as the profile was: from the facing it records as
 * stated, and with the skins it was given, so an encrypted model measures.
 */
export async function fillLayout(profile, modelPath, { roles = rolesWithoutLayout(profile), skinsDir = null, measure = profileFromKn5 } = {}) {
  const axes = profile.calibration?.axes;
  const facing = axes?.from === 'stated' ? { left: axes.left, front: axes.front } : undefined;
  const fresh = await measure(modelPath, { log: () => {}, facing, skinsDir });
  const roleOf = new Map(Object.entries(fresh.textures).map(([r, t]) => [t.file.toLowerCase(), r]));
  let filled = 0;
  const missed = [];
  for (const role of roles) {
    const panels = profile.panels[role] ?? {};
    const theirs = fresh.panels[roleOf.get(profile.textures[role]?.file?.toLowerCase())] ?? {};
    const ours = new Map();   // fresh name -> profile name
    for (const [name, p] of Object.entries(panels)) {
      const same = Object.keys(theirs).filter((n) => sameRect(theirs[n].rect, p.rect) && !ours.has(n));
      const match = same.length > 1 && same.includes(name) ? name : same[0];
      if (match !== undefined) ours.set(match, name);
    }
    const mine = new Map([...ours].map(([f, n]) => [n, f]));
    for (const [name, p] of Object.entries(panels)) {
      if (p.outline !== undefined) continue;
      if (!mine.has(name)) { missed.push(`${role}.${name}`); continue; }
      const q = theirs[mine.get(name)];
      if (q.outline !== undefined) p.outline = q.outline;
      const seams = [];
      for (const [n, seam] of Object.entries(q.seams ?? {})) {
        if (ours.has(n)) seams.push([ours.get(n), seam]);
        else missed.push(`${role}.${name} seam to ${n}`);
      }
      if (seams.length) p.seams = Object.fromEntries(seams);
      filled++;
    }
  }
  return { filled, missed };
}
