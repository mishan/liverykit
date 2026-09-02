// ---------------------------------------------------------------------------
// Car profiles.
//
// A car profile answers questions about a *car* — which textures it has, which
// of them are safe to paint, and where each body panel lives in UV space. It
// says nothing about any particular livery. That separation is the whole point:
//
//   * A profile is expensive to produce (install a calibration skin, photograph
//     the car, read coordinates off the grid) and is identical for everyone who
//     owns that car. Exactly the kind of thing worth sharing.
//   * A livery is cheap to write and is the part you actually want to be
//     creative in. If it addresses panels by NAME rather than by coordinate, the
//     same livery renders on any car that has a profile with matching panel
//     names.
//
// So `{ panel: 'flankLeft', at: [0, 0, 0.4, 1] }` means "the front 40% of the
// left flank, whatever that happens to be on this car", and survives being
// pointed at a different model. `{ at: [0.6, 0, 0.16, 0.2] }` means a literal
// rectangle in the texture, and does not.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VOCABULARY } from './engine/classify.mjs';

export async function loadProfile(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  return validateProfile(raw, path);
}

export function validateProfile(p, source = '<inline>') {
  const err = (m) => { throw new Error(`Car profile ${source}: ${m}`); };

  if (!p.id) err('missing "id" (the folder name under content/cars/)');
  if (!p.textures || !Object.keys(p.textures).length) err('has no textures');

  for (const [role, t] of Object.entries(p.textures)) {
    if (!t.file) err(`texture role "${role}" has no file`);
    if (!t.width || !t.height) err(`texture "${t.file}" needs width and height`);
    if (!isPow2(t.width) || !isPow2(t.height)) {
      console.warn(`  ! ${t.file} is ${t.width}x${t.height}; DDS mip chains want powers of two.`);
    }
  }

  // Two files differing only in case are ONE file on NTFS. On Windows the
  // second to extract silently wins, so a profile must never list both.
  const byLower = new Map();
  for (const t of Object.values(p.textures)) {
    const k = t.file.toLowerCase();
    byLower.set(k, [...(byLower.get(k) ?? []), t.file]);
  }
  for (const v of byLower.values()) {
    if (v.length > 1) err(`case-colliding filenames, which are one file on Windows: ${v.join(' == ')}`);
  }

  // `caseCollisions` records pairs that exist in the CAR and collide on NTFS.
  // The profile may reference at most one spelling from each pair — shipping
  // both means the second to extract silently overwrites the first.
  for (const pair of p.caseCollisions ?? []) {
    const shipped = pair.filter((f) =>
      Object.values(p.textures).some((t) => t.file === f));
    if (shipped.length > 1) {
      err(`textures include ${shipped.join(' and ')}, which are one file on Windows. Pick one spelling.`);
    }
  }

  validateBind(p, err);

  for (const [role, panels] of Object.entries(p.panels ?? {})) {
    if (!p.textures[role]) err(`panels are defined for unknown texture role "${role}"`);
    for (const [name, panel] of Object.entries(panels)) {
      checkRect(panel.rect, `${role}.${name}.rect`, err);
      if (panel.safe) checkRect(panel.safe, `${role}.${name}.safe`, err);
    }
  }

  return p;
}

// ---------------------------------------------------------------------------
// Bindings: the layer between what a livery asks for and what a car calls it.
//
// A livery says `body`. What `body` IS varies completely between cars — across a
// 235-car fleet the generated role names came to 1912 distinct names, 1082 of
// them on exactly one car, and a role literally called `body` existed on 86.
// So the car profile carries the translation:
//
//   "bind": {
//     "body":  { "roles": ["body", "body_2"], "source": "human" },
//     "belts": { "roles": ["belts_2"], "confidence": 0.71, "source": "auto" },
//     "wing":  { "roles": [], "source": "human" }
//   }
//
// One form only, deliberately. An entry is always an object with a `roles`
// array, and an EMPTY array is a positive statement that this car does not have
// the surface — different from the term being absent because nobody got round to
// it. `source` distinguishes a machine proposal from a human confirmation, and
// regeneration must never overwrite the latter.
//
// `roles` is a list rather than a single name because a term genuinely can map
// to more than one texture: the RSS4 carries the bodywork across
// RSS4_Chassis_D and RSS4_Chassis_C, 25% and 17% of the car's surface.
// ---------------------------------------------------------------------------

const BIND_SOURCES = new Set(['auto', 'human']);

// Terms that live in a DIFFERENT kn5 by design. The driver and the pit crew are
// separate models which a car skin overrides, so "this car's model never
// references it" is the expected state for them and warning about it every build
// would be pure noise. For anything else it is the signal that matters.
const ELSEWHERE = new Set(['helmet', 'suit', 'gloves', 'crew']);

function validateBind(p, err) {
  for (const [term, entry] of Object.entries(p.bind ?? {})) {
    // The vocabulary is fixed on purpose. If any profile can invent a term then
    // a livery cannot rely on one, and the whole layer buys nothing.
    //
    // Object.hasOwn, not a truthiness test: VOCABULARY['toString'] inherits a
    // function from Object.prototype, so bind."toString" would otherwise pass
    // validation and reopen the vocabulary through the back door.
    if (!Object.hasOwn(VOCABULARY, term)) {
      err(`bind has an unknown term "${term}". The vocabulary is fixed so that liveries can ` +
          `rely on it: ${Object.keys(VOCABULARY).join(', ')}`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      err(`bind."${term}" must be an object like { "roles": [...], "source": "auto" }. ` +
          `Use an empty roles array to say this car has no such surface.`);
    }
    if (!Array.isArray(entry.roles)) err(`bind."${term}".roles must be an array of texture role names`);
    if (!BIND_SOURCES.has(entry.source)) {
      err(`bind."${term}".source must be "auto" (proposed by measurement) or ` +
          `"human" (confirmed by a person), got ${JSON.stringify(entry.source)}`);
    }
    if (entry.confidence !== undefined &&
        (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1)) {
      err(`bind."${term}".confidence must be a number in 0..1, got ${JSON.stringify(entry.confidence)}`);
    }
    for (const role of entry.roles) {
      // The whole point of the layer is that a livery stops guessing at names.
      // A binding pointing at a role that does not exist would reintroduce the
      // silent-no-op this project keeps rediscovering.
      if (!p.textures[role]) {
        err(`bind."${term}" points at texture role "${role}", which this profile does not define. ` +
            `Known roles: ${Object.keys(p.textures).join(', ')}`);
      }
    }
  }
}

/**
 * The texture roles a vocabulary term resolves to on this car.
 *
 * Returns `{ roles, source, confidence, status }` where status is one of:
 *   'bound'       — the car has this surface and the roles are listed
 *   'absent'      — the car genuinely has no such surface (empty roles array)
 *   'unbound'     — nobody has said either way
 *
 * It never throws. A design asking for a surface a car lacks should degrade to a
 * reported no-op, not an error: a Formula car has no numberPlate and a van has
 * no wing, and neither fact should stop a build. The reporting is the point —
 * painting nothing looks exactly like painting something.
 */
export function binding(profile, term) {
  // Deliberately defensive about its own input. validateProfile guarantees the
  // shape, but this is exported and a caller may hand over a profile that never
  // went through it — a hand-written fixture, or one read straight from disk.
  // "It never throws" has to be true of the function, not only of the happy path.
  const entry = Object.hasOwn(profile.bind ?? {}, term) ? profile.bind[term] : undefined;
  const roles = Array.isArray(entry?.roles) ? entry.roles : null;
  if (!roles) return { roles: [], source: null, confidence: undefined, status: 'unbound' };
  return {
    roles,
    source: entry.source ?? null,
    confidence: entry.confidence,
    status: roles.length ? 'bound' : 'absent',
  };
}

/**
 * Merge freshly proposed bindings into whatever the profile already had.
 *
 * A human confirmation is never overwritten. This is the same guarantee
 * `aliases` already carries, and for the same reason: a profile is regenerated
 * every time the model or the classifier changes, and losing hand-checked work
 * on each regeneration would make confirming it pointless.
 */
export function mergeBindings(existing = {}, proposed = {}) {
  const out = { ...proposed };
  for (const [term, entry] of Object.entries(existing)) {
    if (entry?.source === 'human') out[term] = entry;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Work out which textures a livery actually paints on this car.
 *
 * A livery has two ways to name a surface, and they are kept separate on purpose
 * rather than resolved by precedence:
 *
 *   paint    — keyed by this car's own texture ROLES. Exact, not portable, and
 *              the only thing that existed before bindings. Untouched.
 *   surfaces — keyed by VOCABULARY TERMS, resolved through the profile's bind
 *              table. Portable, and the point of the whole exercise.
 *
 * Precedence would have been the tempting design — try the bind table, fall back
 * to a literal role — but it silently changes what existing liveries do. On the
 * RSS4 `body` is both a vocabulary term bound to two chassis textures AND a
 * literal role naming one of them, so a livery that paints `body` and `bodyRear`
 * differently would suddenly render the same artwork on both. Two blocks, one
 * meaning each.
 *
 * Returns `{ targets, notes }`. Nothing throws for a surface the car lacks: a
 * design asking for a wing on a van should degrade to a reported no-op. The
 * report is the whole safety mechanism, because painting nothing looks exactly
 * like painting something.
 */
export function resolveTargets(profile, livery) {
  const targets = [];
  const notes = [];
  const claimedBy = new Map();

  const claim = (role, spec, from, primary = true) => {
    const prior = claimedBy.get(role);
    if (prior) {
      // Both would write the same file, and the second would win silently.
      throw new Error(
        `Livery "${livery.name}" paints texture role "${role}" twice — once via ${prior}, ` +
        `once via ${from}. They write the same file, so one would overwrite the other.`
      );
    }
    claimedBy.set(role, from);
    targets.push({ role, spec, from, primary });
  };

  for (const [role, spec] of Object.entries(livery.paint ?? {})) {
    texture(profile, role);            // throws with the known-roles list
    claim(role, spec, `paint.${role}`);
  }

  for (const [term, spec] of Object.entries(livery.surfaces ?? {})) {
    if (!VOCABULARY[term]) {
      throw new Error(
        `Livery "${livery.name}" paints surface "${term}", which is not in the vocabulary. ` +
        `Known surfaces: ${Object.keys(VOCABULARY).join(', ')}`
      );
    }
    const b = binding(profile, term);
    if (b.status === 'absent') {
      notes.push({ term, status: 'absent', text: `${term}: this car has no such surface (confirmed)` });
      continue;
    }
    if (b.status === 'unbound') {
      notes.push({
        term, status: 'unbound',
        text: `${term}: not bound on this car — run "liverykit --explain" and record it under "bind"`,
      });
      continue;
    }
    b.roles.forEach((role, i) => {
      // The FIRST role a term resolves to is its primary surface. A term can
      // cover several textures — `body` on the RSS4 is two chassis textures —
      // and a pattern belongs on all of them, but a car number belongs on the
      // car once. A region marked `once` is drawn only here.
      claim(role, spec, `surfaces.${term}`, i === 0);
      // A texture the car's own model never references may still be real — the
      // driver and pit crew live in separate kn5 files that a car skin overrides
      // — or it may be a leftover that paints nothing at all. metal_detail.dds
      // ships in nearly every road-car skin and on several of those cars is
      // bound to no mesh anywhere. This cannot be settled without the other
      // model, so it is flagged rather than guessed at.
      if (profile.textures[role]?.sizeFrom === 'skin' && !ELSEWHERE.has(term)) {
        notes.push({
          term, status: 'unverified',
          text: `${term} -> ${profile.textures[role].file} is not referenced by this car's model. ` +
                `Expected for driver and crew kit; for anything else it may paint nothing`,
        });
      }
    });
    if (b.source === 'auto') {
      notes.push({
        term, status: 'unconfirmed',
        text: `${term} -> ${b.roles.join(', ')} was proposed by measurement and never confirmed` +
              (b.confidence !== undefined ? ` (confidence ${b.confidence})` : ''),
      });
    }
  }

  // Painted onto a part the game never draws. The profile records which meshes
  // the car's own CSP config hides; a design painting one of those textures
  // is painting nothing, and the texture it ships is dead weight. This design
  // did exactly that with a number plate for a month, and the only reason it
  // did not matter is that it could not be seen not to.
  for (const t of targets) {
    const tex = profile.textures[t.role];
    if (tex?.hiddenByCar) {
      notes.push({
        term: t.from, status: 'car-hidden',
        text: `${t.from} -> ${tex.file}: the car's own config hides every mesh wearing it, so this paints nothing the game shows`,
      });
    }
  }

  if (!targets.length) {
    throw new Error(
      `Livery "${livery.name}" paints nothing on car "${profile.id}". ` +
      (notes.length ? `\n  ${notes.map((n) => n.text).join('\n  ')}` : '')
    );
  }
  return { targets, notes };
}

const isPow2 = (n) => Number.isInteger(Math.log2(n));

function checkRect(r, what, err, { loose = false } = {}) {
  if (!Array.isArray(r) || r.length !== 4) err(`${what} must be [x, y, w, h]`);
  if (r.some((n) => typeof n !== 'number' || !Number.isFinite(n))) err(`${what} must be numbers, got [${r}]`);
  // A spanning region is ALLOWED past its panel's edge: that is the point of
  // it, and the part past the edge is what continues onto the neighbour.
  if (loose) {
    if (r[2] <= 0 || r[3] <= 0) err(`${what} must have positive width and height, got [${r}]`);
    return;
  }
  if (r.some((n) => n < 0 || n > 1)) err(`${what} must be fractions in 0..1, got [${r}]`);
  if (r[0] + r[2] > 1.0001 || r[1] + r[3] > 1.0001) err(`${what} extends past the texture edge`);
}

/** The texture definition for a role, e.g. 'body'. */
export function texture(profile, role) {
  const t = profile.textures[role];
  if (!t) {
    throw new Error(
      `Car profile "${profile.id}" has no texture role "${role}". ` +
      `Known roles: ${Object.keys(profile.textures).join(', ')}`
    );
  }
  return t;
}

/**
 * Where this car's `.kn5` might be, in the order worth trying.
 *
 * A model belongs to whoever made the car, so this project ships none and never
 * will — which leaves the person to supply one, and makes "the 3D view is
 * broken" and "you have not said where your game is" look identical unless the
 * tool lists what it tried. Hence a list rather than a single guess.
 *
 * `AC_ROOT`, or `ASSETTOCORSA` which some tools already set, points at the game
 * install. Failing that a car unpacked into the checkout works, under either the
 * game's own `content/cars/<id>/` layout or the flatter `cars/<id>/` that
 * --from-kn5 tends to be pointed at. Both are gitignored.
 *
 * Pure, and separate from the looking, so the ORDER can be tested without a
 * filesystem: it is the part that decides whose copy of a car you get.
 */
export function carModelCandidates(profile, { root, env = {} } = {}) {
  const file = profile?.calibration?.source;
  if (!file) return [];
  const id = profile.id;
  const installs = [env.AC_ROOT, env.ASSETTOCORSA, root].filter(Boolean);
  return [
    ...installs.map((r) => join(r, 'content', 'cars', id, file)),
    ...(root ? [join(root, 'cars', id, file)] : []),
  ];
}

/**
 * The profile's OWN name for a panel, following an alias if that is what it is.
 *
 * A livery may say `flankLeft` where the profile calls the island `left_mid`,
 * and both are correct — that is what an alias block is for. But only one of
 * them is a key in `profile.panels`, so anything that looks a panel up by name
 * has to agree on which. Two names for one thing is exactly the shape of bug
 * that renders correctly and then fails somewhere that only had the other one.
 */
export function panelName(profile, role, name) {
  return profile?.aliases?.[role]?.[name] ?? name;
}

/**
 * The named panel within a texture role, with its metadata.
 *
 * `aliases` let a profile carry friendly names alongside generated ones. A
 * profile built from a model gets systematic geometric names — `left_mid`,
 * `centre_nose` — which are honest but not memorable, and which would be
 * clobbered every time the profile is regenerated if you renamed them in place.
 * An alias block maps `flankLeft -> left_mid` and survives regeneration.
 */
export function panel(profile, role, name) {
  const alias = profile.aliases?.[role]?.[name];
  const found = profile.panels?.[role]?.[alias ?? name];
  if (!found) {
    // This is the same class of failure as a skin filename that matches nothing
    // in the car: silent, and it looks exactly like "the livery didn't work".
    // So it throws rather than falling back to the whole texture.
    const known = Object.keys(profile.panels?.[role] ?? {});
    const aliases = Object.keys(profile.aliases?.[role] ?? {});
    throw new Error(
      `Car profile "${profile.id}" has no panel "${name}" on texture role "${role}".` +
      (aliases.length ? `\n  Aliases: ${aliases.join(', ')}` : '') +
      (known.length ? `\n  Panels: ${known.join(', ')}` : '\n  That role has no panels mapped at all.')
    );
  }
  return found;
}

/**
 * Panels on a texture role carrying every one of the given tags.
 *
 * AND, not OR, and deliberately so. `['left', 'mid']` means the left middle of
 * the car; if it meant "left or middle" a design could not express anything
 * specific, and the failure would be a region painted across half the car rather
 * than an error.
 */
export function panelsWithTags(profile, role, tags, { limit = Infinity } = {}) {
  const panels = profile.panels?.[role] ?? {};
  const matching = Object.entries(panels)
    .filter(([, p]) => tags.every((t) => (p.tags ?? []).includes(t)))
    .map(([name]) => name);

  // One name per DISTINCT RECTANGLE. Four wheels sharing a rim texture are four
  // panels over the same texels, and painting them one at a time would stack the
  // artwork — four passes of a 0.3 halftone is a 0.76 halftone, not a 0.3 one.
  // Selecting by name still reaches an individual panel; only tag selection,
  // which cannot know it matched instances of one thing, dedupes.
  const seen = new Set();
  const distinct = matching.filter((name) => {
    const key = (panels[name].rect ?? []).join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!Number.isFinite(limit)) return distinct;

  // `limit` takes the BIGGEST matches rather than the first ones. A pattern
  // wants every panel it matches; a piece of text wants one, and wants it to be
  // the panel with room for it. Sorted by rectangle area, with the name as a
  // tiebreak so the choice does not depend on object key order.
  const area = (n) => {
    const r = panels[n].rect ?? [0, 0, 0, 0];
    return r[2] * r[3];
  };
  return [...distinct]
    .sort((a, b) => area(b) - area(a) || a.localeCompare(b))
    .slice(0, limit);
}

/**
 * Expand a livery's regions against one texture role.
 *
 * A region selecting by `tags` becomes one region per matching panel — the same
 * artwork on every panel that qualifies. That is what makes a design portable:
 * `{ tags: ['left', 'mid'] }` renders on however many islands this particular
 * car happens to split its left flank into, which is three on one model and one
 * on another.
 *
 * A region matching nothing is dropped and reported. Silence here would be the
 * same failure as everywhere else in this project.
 */
export function expandRegions(profile, role, regions = []) {
  const out = [];
  const notes = [];

  for (const region of regions) {
    if (region.tags === undefined) { out.push(region); continue; }

    // An empty array would match EVERY panel, because `every` on an empty list
    // is vacuously true — so `tags: []` would silently paint the whole texture
    // instead of nothing. A non-array fails inside `every` with "tags.every is
    // not a function", which says nothing useful about the livery.
    if (!Array.isArray(region.tags) || region.tags.length === 0) {
      throw new Error(
        `"${region.treatment ?? 'region'}" on role "${role}" has tags: ` +
        `${JSON.stringify(region.tags)}. It must be a non-empty array of tag names, ` +
        `e.g. tags: ['left', 'visible'].`
      );
    }
    if (region.panel) {
      throw new Error(
        `A region on role "${role}" has both "panel" and "tags". Use one: ` +
        `"panel" names a single panel on this car, "tags" selects whichever panels match.`
      );
    }
    if (region.limit !== undefined
        && (!Number.isInteger(region.limit) || region.limit < 1)) {
      throw new Error(
        `"${region.treatment ?? 'region'}" on role "${role}" has limit: ` +
        `${JSON.stringify(region.limit)}. It must be a whole number of panels, 1 or more.`
      );
    }
    const matches = panelsWithTags(profile, role, region.tags, { limit: region.limit ?? Infinity });
    if (!matches.length) {
      notes.push({
        status: 'no-match',
        text: `${role}: no panel tagged [${region.tags.join(', ')}] — ` +
              `"${region.treatment ?? 'region'}" was skipped`,
      });
      continue;
    }
    for (const panel of matches) out.push({ ...region, panel });
  }
  return { regions: out, notes };
}

/**
 * Turn a livery region spec into an absolute rectangle in texture fractions.
 *
 * `at` is always relative to the panel's full `rect` — [0,0,1,1] (the default)
 * is the whole panel, [0.5,0,0.5,1] its rear half. Without `panel`, `at` is
 * read as absolute texture coordinates, which is the escape hatch for anything
 * unmapped.
 *
 * A panel's `safe` rect does NOT change that basis. It would be tempting to
 * make `at` relative to the safe rect when one exists, but then every
 * coordinate in a livery shifts meaning depending on whether the car profile
 * happens to declare a safe area — and the numbers stop being readable. So the
 * safe rect only *checks*: anything that strays outside it gets a warning
 * naming the region, because a safe-area violation is invisible at build time
 * and only shows up as half a word missing on the car.
 *
 * `safe: false` silences the check for regions that legitimately want the full
 * panel — a background fill should reach the island edge even though type
 * shouldn't.
 */
/**
 * How big a resolved rectangle is on the actual car, in metres.
 *
 * Takes what `resolveRect` returned, because the panel it landed on is what
 * carries the measurement. Answers `null` rather than a guess when the profile
 * predates `metresPerUv` or the region is placed absolutely with no panel under
 * it — a plausible-looking wrong number here would be worse than no number,
 * since the whole point is to be able to trust it.
 *
 * Written once, here, because getting the axis order wrong is silent: swapping
 * the two gives a sensible-looking answer that is wrong by the anisotropy, and
 * on a 1:1 panel it is not wrong at all, so the mistake survives testing on the
 * first panel somebody tries it on.
 */
export function metresAcross(frac) {
  const per = frac?.panel?.metresPerUv;
  if (!Array.isArray(per) || per.length !== 2) return null;
  return { w: frac.w * per[0], h: frac.h * per[1] };
}

export function resolveRect(profile, role, spec) {
  const at = spec.at ?? [0, 0, 1, 1];
  checkRect(at, `region "at"`, (m) => { throw new Error(m); }, { loose: spec.span === true });

  if (!spec.panel) {
    if (spec.span) throw new Error(`A spanning region needs a panel to start from; "${spec.treatment ?? 'region'}" on role "${role}" has none.`);
    return { x: at[0], y: at[1], w: at[2], h: at[3], anisotropy: 1 };
  }

  const pan = panel(profile, role, spec.panel);
  const [bx, by, bw, bh] = pan.rect;
  const out = {
    x: bx + at[0] * bw,
    y: by + at[1] * bh,
    w: at[2] * bw,
    h: at[3] * bh,
    anisotropy: pan.anisotropy ?? 1,
    panel: pan,
  };

  if (pan.safe && spec.safe !== false) {
    const [sx, sy, sw, sh] = pan.safe;
    const over =
      out.x < sx - 1e-9 || out.y < sy - 1e-9 ||
      out.x + out.w > sx + sw + 1e-9 || out.y + out.h > sy + sh + 1e-9;
    if (over) {
      console.warn(
        `  ! "${spec.treatment ?? 'region'}" on panel ${role}.${spec.panel} extends outside its safe area.\n` +
        `    Safe areas mark where a UV island curls out of sight — this may render\n` +
        `    clipped on the car. Pass safe:false if that is intended.`
      );
    }
  }

  return out;
}

/** Textures the profile explicitly warns against painting, with reasons. */
export function doNotPaint(profile) {
  return profile.doNotPaint ?? [];
}

// ---------------------------------------------------------------------------
// Spanning: one region, several islands.
//
// A panel is a UV island, and a rectangle is a rectangle in ONE island's
// sheet. Nothing about that stops a design wanting a band that runs from the
// door onto the rear quarter, and until now the answer was two regions, two
// rectangles, and a seam that never quite lined up.
//
// `span: true` lets a region's `at` run past its panel's edge. The part past
// the edge is continued onto whichever neighbouring islands it reaches,
// through the SEAM MAPS the profile measured — an affine from one island's
// sheet to its neighbour's, fitted in metres from the vertices the two share
// (see findSeams). The artwork is drawn once, in the home panel's frame, and
// drawn again on each reached panel under that panel's map, clipped to it.
//
// Islands are reached by walking `seams` outward from the home panel and
// keeping any whose rectangle the mapped region overlaps. A panel reached by
// two routes takes the SHORTER one, and this is not a tidy-up: each seam map
// is exact at its own seam and approximate away from it, so on a curved
// island two routes disagree by the curvature between them — on the NSX the
// door meets the quarter directly at -17 degrees and through the intake
// surround at -49, and both are right where they were measured.
// ---------------------------------------------------------------------------

/** [a,b,c,d,e,f] applied to a point, SVG order. */
export function applyMatrix([a, b, c, d, e, f], [x, y]) {
  return [a * x + c * y + e, b * x + d * y + f];
}

/** second AFTER first: (M2 ∘ M1). */
export function composeMatrix(first, second) {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = second;
  return [
    a2 * a1 + c2 * b1, b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1, b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2, b2 * e1 + d2 * f1 + f2,
  ];
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** A rect's four corners under a matrix, as a polygon. */
function mappedQuad(m, r) {
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map((p) => applyMatrix(m, p));
}

/**
 * A polygon clipped to a rectangle (Sutherland-Hodgman), or null if nothing
 * is left. Polygons rather than boxes throughout, because a band mapped
 * through a seam at -17 degrees is a parallelogram whose bounding box is
 * mostly not band — and tested as a box it crossed seams it never touched
 * and reached the roof from the door.
 */
function clipPoly(poly, [bx, by, bw, bh]) {
  const edges = [
    (p) => p[0] >= bx, (p) => p[0] <= bx + bw, (p) => p[1] >= by, (p) => p[1] <= by + bh,
  ];
  const cross = [
    (a, b) => { const t = (bx - a[0]) / (b[0] - a[0]); return [bx, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (bx + bw - a[0]) / (b[0] - a[0]); return [bx + bw, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (by - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), by]; },
    (a, b) => { const t = (by + bh - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), by + bh]; },
  ];
  let out = poly;
  for (let e = 0; e < 4 && out.length; e++) {
    const inside = edges[e], at = cross[e];
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      const ia = inside(a), ib = inside(b);
      if (ia) next.push(a);
      if (ia !== ib) next.push(at(a, b));
    }
    out = next;
  }
  return out.length >= 3 ? out : null;
}

function polyBox(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function inPoly(poly, [x, y]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A convex polygon pushed outward by `d` from its centroid, roughly. */
function grow(poly, d) {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const l = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / l) * d, y + ((y - cy) / l) * d];
  });
}

function overlap(a, [bx, by, bw, bh]) {
  const w = Math.min(a.x + a.w, bx + bw) - Math.max(a.x, bx);
  const h = Math.min(a.y + a.h, by + bh) - Math.max(a.y, by);
  return w > 0 && h > 0 ? { x: Math.max(a.x, bx), y: Math.max(a.y, by), w, h } : null;
}

/**
 * Where a spanning region lands: the home panel and every neighbour it
 * reaches, each with the matrix that takes the home sheet's fractions to
 * that panel's, and the part of the mapped rectangle that lies on it.
 *
 * A neighbour is reached only when the part of the region ON the panel it
 * is leaving crosses the seam to it — overlaps the seam's own box, by at
 * least `minCross` metres. Two mistakes are ruled out by that sentence, and
 * both were made first. Asking only whether the unfolded rectangle overlapped
 * the neighbour's box let a band on the NSX's door reach the bonnet, which
 * the door touches at one corner the band never crosses. And testing the
 * WHOLE unfolded band for crossings, rather than the piece on the current
 * panel, let an 8 cm spill onto the fender strip carry the band's other
 * three metres across every seam the strip has.
 *
 * Panels are reached breadth-first — fewest seams wins, since every seam
 * crossed is an approximation — and among routes of equal length the one
 * crossing more seam. The door meets the rear quarter along a corner a
 * centimetre and a half across and the intake surround along its whole rear
 * edge; `minCross` is what sends a band through the surround.
 */
export function spanPlacements(profile, role, homeName, home, { depth = 3, minCross = 0.03 } = {}) {
  const panels = profile.panels?.[role] ?? {};
  const start = panelName(profile, role, homeName);
  const rect = { x: home.x, y: home.y, w: home.w, h: home.h };
  // A seam box is a line for a straight seam; pad it so a rectangle whose
  // edge sits exactly on it still counts as crossing.
  // How much of the seam, in metres, lies inside the piece. The seam is a
  // polyline through the shared points; each segment is sampled and the
  // samples inside the piece (grown by a texel or two, so a rectangle whose
  // edge sits exactly on the seam still counts) are what crosses. Sampling
  // rather than clipping, because it is a few dozen points per seam and a
  // closed form for a segment against a polygon is more code than this
  // question deserves.
  const PAD = 0.003;
  const crossing = (piece, seam, name) => {
    if (!Array.isArray(seam.here) || !seam.here.length || !Array.isArray(seam.here[0])) return 0;
    const per = panels[name].metresPerUv ?? [1, 1];
    const grown = grow(piece, PAD);
    let inside = 0;
    for (let i = 0; i + 1 < seam.here.length; i++) {
      const [a, b] = [seam.here[i], seam.here[i + 1]];
      const len = Math.hypot((b[0] - a[0]) * per[0], (b[1] - a[1]) * per[1]);
      const n = Math.max(2, Math.ceil(len / 0.01));            // a sample per centimetre
      let hit = 0;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        if (inPoly(grown, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])) hit++;
      }
      inside += (len * hit) / (n + 1);
    }
    // A seam that is a single point has no length and cannot be crossed.
    return inside;
  };
  // The piece of the region on a panel: the mapped quad clipped to the panel.
  const pieceOn = (matrix, name) => clipPoly(mappedQuad(matrix, rect), panels[name].rect);

  const homePiece = pieceOn(IDENTITY, start) ?? mappedQuad(IDENTITY, rect);
  const best = new Map([[start, { panel: start, matrix: IDENTITY, piece: homePiece, on: polyBox(homePiece), hops: 0, crossed: Infinity }]]);
  let frontier = [best.get(start)];
  for (let hop = 1; hop <= depth && frontier.length; hop++) {
    const next = [];
    for (const here of frontier) {
      for (const [there, seam] of Object.entries(panels[here.panel]?.seams ?? {})) {
        if (!panels[there] || !seam.here) continue;
        // Only the piece of the region that is on THIS panel can cross out.
        const crossed = crossing(here.piece, seam, here.panel);
        if (crossed < minCross) continue;
        const matrix = composeMatrix(here.matrix, seam.matrix);
        const piece = pieceOn(matrix, there);
        if (!piece || polyArea(piece) < 1e-7) continue;
        const on = polyBox(piece);
        const prior = best.get(there);
        if (prior && (prior.hops < hop || prior.crossed >= crossed)) continue;
        const entry = { panel: there, matrix, piece, on, hops: hop, via: here.panel, crossed: Math.round(crossed * 1000) / 1000, rmsMm: seam.rmsMm };
        best.set(there, entry);
        // Reached, but not a way through. An island nobody can see — a wheel
        // arch liner, the inside of a sill — is where a band physically goes
        // when it runs off a fender, and it costs nothing to paint it there.
        // But a route that continues THROUGH it comes out somewhere else
        // entirely: door, fender, front arch liner, rear arch liner, quarter,
        // under the car and back up, with three seams' worth of unfolding
        // error and a band on the quarter at an angle nobody asked for.
        const through = typeof panels[there].visible !== 'number' || panels[there].visible >= 0.3;
        if (!through) continue;
        if (!prior) next.push(entry);
        else next[next.findIndex((e) => e.panel === there)] = entry;
      }
    }
    frontier = next;
  }
  return [...best.values()].map(({ piece, ...p }) => p);
}
