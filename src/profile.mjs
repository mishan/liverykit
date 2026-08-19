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
    if (!VOCABULARY[term]) {
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
  const entry = profile.bind?.[term];
  if (!entry) return { roles: [], source: null, confidence: undefined, status: 'unbound' };
  return {
    roles: entry.roles,
    source: entry.source,
    confidence: entry.confidence,
    status: entry.roles.length ? 'bound' : 'absent',
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

  const claim = (role, spec, from) => {
    const prior = claimedBy.get(role);
    if (prior) {
      // Both would write the same file, and the second would win silently.
      throw new Error(
        `Livery "${livery.name}" paints texture role "${role}" twice — once via ${prior}, ` +
        `once via ${from}. They write the same file, so one would overwrite the other.`
      );
    }
    claimedBy.set(role, from);
    targets.push({ role, spec, from });
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
    for (const role of b.roles) {
      claim(role, spec, `surfaces.${term}`);
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
    }
    if (b.source === 'auto') {
      notes.push({
        term, status: 'unconfirmed',
        text: `${term} -> ${b.roles.join(', ')} was proposed by measurement and never confirmed` +
              (b.confidence !== undefined ? ` (confidence ${b.confidence})` : ''),
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

function checkRect(r, what, err) {
  if (!Array.isArray(r) || r.length !== 4) err(`${what} must be [x, y, w, h]`);
  if (r.some((n) => typeof n !== 'number' || n < 0 || n > 1)) {
    err(`${what} must be fractions in 0..1, got [${r}]`);
  }
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
export function resolveRect(profile, role, spec) {
  const at = spec.at ?? [0, 0, 1, 1];
  checkRect(at, `region "at"`, (m) => { throw new Error(m); });

  if (!spec.panel) return { x: at[0], y: at[1], w: at[2], h: at[3], anisotropy: 1 };

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
