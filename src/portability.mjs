// ---------------------------------------------------------------------------
// What would this design find on a car it has never been pointed at?
//
// `surfaces:` and tag selection exist so a livery can travel — "the left flank,
// whatever this car calls it" rather than "left_mid". The trouble is that a
// design's portability is invisible while you work on it, because you are
// looking at exactly one car and everything resolves. You find out it does not
// travel by pointing it at a second car and seeing a bare bonnet, which is late
// and reads as a bug in the tool.
//
// So: run the design's own placement rules against another profile and say what
// would happen. Nothing is rendered and nothing is written. The whole point is
// that the answer arrives before anybody has committed to anything.
//
// `expandRegions` and `resolveTargets` do the work, unchanged — this asks them
// the question rather than reimplementing their answer, so a design that reports
// clean here is one that the build will genuinely paint.
// ---------------------------------------------------------------------------

import { drawnOn } from './fit.mjs';
import { resolveTargets, expandRegions, placementRefusal, missExplanation, binding, panel as findPanel } from './profile.mjs';

/**
 * How a region says where it goes, which is the whole subject.
 *
 * `tags` travels, `panel` names one island on one car, and an absolute `at`
 * travels least of all — a rectangle in texture space means a different part of
 * the bodywork on every car, and looks perfectly reasonable in the file.
 */
function placementKind(region) {
  if (region.tags !== undefined) return 'tags';
  if (region.panel !== undefined) return 'panel';
  return 'absolute';
}

/**
 * What this design would paint on this profile, region by region.
 *
 * Returns plain data rather than prose, so the editor can render it and a test
 * can assert on it. `status` is the field worth reading:
 *
 *   'matched'  — landed somewhere, on `panels`
 *   'missing'  — its rule found nothing here; this is the portability failure
 *   'absolute' — placed by coordinate, so it lands SOMEWHERE on every car and
 *                nothing can say whether that somewhere is the right one
 *   'unplaceable' — placed on a texture that is a tiled material, where no
 *                placement means anything; `why` names the file
 *   'optional' — a tag selection that found nothing, which the design marked
 *                as allowed to: listed, so the report is complete, not a miss
 *
 * The third is deliberately not called a pass. An absolute rectangle always
 * resolves, which is exactly why it is the placement most likely to be quietly
 * wrong on a second car, and reporting it as fine would be the kind of
 * reassuring silence this project exists to refuse.
 */
export function portability(design, profile) {
  const regions = [];
  const surfaces = [];

  let targets;
  try {
    ({ targets } = resolveTargets(profile, design));
  } catch (e) {
    // A design that cannot even be resolved against this car — two surfaces
    // claiming one texture role, say — is a fact about the pair worth
    // reporting, not an exception for the caller to handle.
    return { car: profile.id, name: profile.name || profile.id, fatal: e.message, surfaces: [], regions: [] };
  }

  const wanted = new Set([
    ...Object.keys(design.paint ?? {}).map((r) => `paint.${r}`),
    ...Object.keys(design.surfaces ?? {}).map((t) => `surfaces.${t}`),
  ]);
  for (const t of targets) wanted.delete(t.from);
  // A surface the design paints and this car will not, for one of two reasons
  // that call for different things. `absent`: somebody confirmed the car has no
  // such surface, and the pairing simply leaves it unpainted. `unbound`: nobody
  // has said which texture it is, which is work to do on the car's profile, not
  // a fact about the car. Reported as one status, the second read as the
  // first, and a car nobody had bound looked like a car without rims.
  for (const from of wanted) {
    const term = from.startsWith('surfaces.') ? from.slice('surfaces.'.length) : null;
    if (term !== null && binding(profile, term).status === 'unbound') {
      surfaces.push({
        from, status: 'unbound',
        why: `nobody has bound "${term}" on this car yet; see --explain --all, or the editor's Bindings panel`,
      });
    } else {
      surfaces.push({ from, status: 'absent' });
    }
  }

  for (const t of targets) {
    surfaces.push({ from: t.from, role: t.role, status: 'present' });
    // The regions drawn on this texture: see `drawnOn`. Keyed by where each
    // stands in the whole list, as `applyFit` keys it, so leaving one off
    // this texture does not move the positional id of the next.
    const all = t.spec?.regions ?? [];
    const list = all.filter((r) => drawnOn(r, t.role, t.primary !== false));

    let expanded;
    try {
      expanded = expandRegions(profile, t.role, list);
    } catch (e) {
      // `tags: []`, or a region carrying both `panel` and `tags`. That is a
      // fault in the DESIGN rather than in this pairing, so it is reported
      // against the surface and the rest of the check continues. The expander
      // checks every region before refusing any on a tiled material, so the
      // refusals below are only ever asked about a well-formed design.
      surfaces[surfaces.length - 1] = { from: t.from, role: t.role, status: 'invalid', why: e.message };
      continue;
    }

    for (const [i, region] of list.entries()) {
      const kind = placementKind(region);
      const key = region.id ?? `${t.from}#${all.indexOf(region)}`;
      const refused = placementRefusal(profile, t.role, region);
      if (refused) {
        regions.push({
          id: key, from: t.from, role: t.role, kind,
          ...(kind === 'tags' ? { tags: region.tags } : {}),
          ...(region.optional ? { optional: true } : {}),
          status: 'unplaceable', panels: [], why: refused,
        });
        continue;
      }
      const landed = expanded.regions.filter((r) => r === region || sameRegion(r, region));

      if (kind === 'absolute') {
        regions.push({ id: key, from: t.from, role: t.role, kind, status: 'absolute', panels: [] });
        continue;
      }
      if (kind === 'panel') {
        const there = hasPanel(profile, t.role, region.panel);
        regions.push({
          id: key,
          from: t.from,
          role: t.role,
          kind,
          status: there ? 'matched' : 'missing',
          panels: there ? [region.panel] : [],
          // Named rather than described, because "left_mid" is the exact string
          // somebody has to change, and a car's panel names are the one thing a
          // portable design is trying not to depend on.
          why: there ? undefined : `this car has no panel called "${region.panel}"`,
        });
        continue;
      }
      const panels = landed.map((r) => r.panel);
      // The role and the tags travel with the answer, so a caller asking why a
      // selection missed can ask the profile about that texture, not every one
      // the surface binds. A miss the design marked `optional` is listed as
      // such, not as `missing`: it is part of what the design does on this
      // car, and this report is where a person looks to see all of that.
      // `optional` rides on the region matched or not, so a fleet summary can
      // keep it apart from a required region with the same tags.
      const miss = region.optional ? 'optional' : 'missing';
      regions.push({
        id: key,
        from: t.from,
        role: t.role,
        kind,
        tags: region.tags,
        ...(region.optional ? { optional: true } : {}),
        status: panels.length ? 'matched' : miss,
        panels,
        why: panels.length ? undefined
          : `no panel here is tagged [${(region.tags ?? []).join(', ')}]` +
            (region.optional ? ', which the design marks as optional' : `. ${missExplanation(profile, t.role, region.tags ?? [])}`),
      });
    }
  }

  return { car: profile.id, name: profile.name || profile.id, surfaces, regions };
}

/** Does this profile have a panel by this name on this role? */
function hasPanel(profile, role, name) {
  try {
    return !!findPanel(profile, role, name);
  } catch {
    // `panel()` throws with the known-names list, which is the right behaviour
    // for a build and the wrong one for a survey: the whole job here is to keep
    // going and report every region, not to stop at the first that does not fit.
    return false;
  }
}

/**
 * Is this expanded region the one that came from that source region?
 *
 * `expandRegions` returns `{ ...region, panel }` for each match, so identity is
 * gone and there is no marker to follow. Comparing the fields that survive is
 * enough here because the alternative — adding a marker to `expandRegions` — puts
 * something in the build's path to serve a report that the build never runs.
 */
function sameRegion(expanded, region) {
  if (region.id !== undefined) return expanded.id === region.id;
  return expanded.treatment === region.treatment
    && String(expanded.tags) === String(region.tags)
    && String(expanded.at) === String(region.at);
}
