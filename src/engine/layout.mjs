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

/** Whether a profile was shipped without its layout: no panel has an outline. */
export function lacksLayout(profile) {
  return !Object.values(profile.panels ?? {}).some((ps) => Object.values(ps).some((p) => p.outline !== undefined));
}

const sameRect = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);

/**
 * Give each panel its outline and seams from a fresh measurement of the model.
 *
 * Roles are matched by texture file, since a person may have renamed one, and
 * panels by name and rectangle, since generated names get reused. A panel
 * either does not match is listed in `missed`, and a seam to a neighbor that
 * did not match is left out rather than pointed at whatever has that name.
 */
export async function fillLayout(profile, modelPath, { measure = profileFromKn5 } = {}) {
  const fresh = await measure(modelPath, { log: () => {} });
  const roleOf = new Map(Object.entries(fresh.textures).map(([r, t]) => [t.file.toLowerCase(), r]));
  let filled = 0;
  const missed = [];
  for (const [role, panels] of Object.entries(profile.panels ?? {})) {
    const theirs = fresh.panels[roleOf.get(profile.textures[role]?.file?.toLowerCase())] ?? {};
    const matched = new Set(Object.keys(panels).filter((n) => sameRect(theirs[n]?.rect, panels[n].rect)));
    for (const [name, p] of Object.entries(panels)) {
      if (p.outline !== undefined) continue;
      if (!matched.has(name)) { missed.push(`${role}.${name}`); continue; }
      const q = theirs[name];
      if (q.outline !== undefined) p.outline = q.outline;
      const seams = Object.entries(q.seams ?? {}).filter(([n]) => matched.has(n));
      if (seams.length) p.seams = Object.fromEntries(seams);
      filled++;
    }
  }
  return { filled, missed };
}
