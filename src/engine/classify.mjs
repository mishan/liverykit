// ---------------------------------------------------------------------------
// Which texture is the bodywork?
//
// A livery wants to say `body` and mean it. What `body` resolves to varies
// completely between cars: across a 235-car fleet the generated role names came
// to 1912 distinct names, 1082 of them appearing on exactly one car, and a role
// literally called `body` existed on only 86. Filenames are not a shared
// vocabulary and never were.
//
// So this classifies by measurement instead. Five signals, none of them a name:
//
//   area       fraction of the car's SURFACE AREA. Square metres, not vertices —
//              a cockpit is the densest geometry on a car and the bodywork among
//              the sparsest, so ranking by vertex count puts an interior
//              occlusion map above the paint on essentially every car.
//   straddles  does the geometry cross the centreline? Bodywork does; a single
//              corner part does not.
//   skins      how many stock skins override the file. This is the car author
//              stating outright that the surface is meant to vary per livery.
//              Authoritative about intent, useless about size: metal_detail.dds
//              ships in nearly every road-car skin and on several of those cars
//              is bound to no mesh at all.
//   shader     the material shader. ksPerPixelMultiMap_damage_dirt is a body
//              panel in all but name; ksTyres and ksBrakeDisc are disqualifying.
//   visible    ray-cast trackside visibility. The decisive one, and the
//              expensive one.
//
// MEASURED ACCURACY. Scored against a held-out label — the 175 fleet cars whose
// filename is unambiguous, which this code never sees — the first four signals
// pick the right body on 158/175 (90%). The failures are a coherent group:
// interior occlusion maps, engine bays and undertrays, all large, all symmetric,
// all invisible. Adding visibility takes it to 172/175 (98.3%), and two of the
// three remaining misses are the LABEL being wrong: on the Evora GTE this picks
// Carpaint_D, which all seven stock skins override and which is 80% visible,
// over a labelled Skin_soft that no skin overrides and that is 0.2% visible.
// Counted properly, 174/175.
//
// Re-measure with `node tools/survey.mjs cars --all --visibility` after any
// change to the weights. That number is the thing to defend.
//
// Everything here RANKS AND EXPLAINS. It never decides. A binding it proposes is
// marked `auto` and a human confirms it once per car — 98% is very good and is
// not the same as trustworthy without looking.
// ---------------------------------------------------------------------------

import { meshesUsingTexture, triangles, vertex } from './kn5.mjs';

/** Terms whose scoring has been measured against the fleet. */
export const VALIDATED = new Set(['body']);

const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Measure every texture in a model: area covered, where it sits, whether it
 * straddles the centreline, which shaders bind it.
 *
 * This is the classifier's input contract, and it is deliberately separate from
 * the scoring. The measurements are facts about the car and are worth having
 * regardless of what any weighting later does with them.
 *
 * `skinCounts` maps lowercased filename -> how many stock skins ship it.
 * `visibleByFile` maps filename -> mean trackside visibility, when computed.
 */
export function textureFeatures(model, { roles = {}, skinCounts = new Map(), skinCount = 0, visibleByFile = new Map() } = {}) {
  const areaOf = new Map();
  const boxOf = new Map();
  let X0 = Infinity, X1 = -Infinity, Y0 = Infinity, Y1 = -Infinity, Z0 = Infinity, Z1 = -Infinity;

  for (const mesh of model.meshes) {
    let a = 0;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [i, j, k] of triangles(model, mesh)) {
      const p0 = vertex(model, mesh, i), p1 = vertex(model, mesh, j), p2 = vertex(model, mesh, k);
      const e1 = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
      const e2 = [p2.x - p0.x, p2.y - p0.y, p2.z - p0.z];
      const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      a += Math.hypot(c[0], c[1], c[2]) / 2;
      for (const p of [p0, p1, p2]) {
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
        if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
      }
    }
    areaOf.set(mesh, a);
    // Only meshes with real geometry define the car's extent. An empty mesh
    // would otherwise drag the bounds to infinity and normalise everything to 0.
    if (x0 <= x1) {
      boxOf.set(mesh, [x0, x1, y0, y1, z0, z1]);
      if (x0 < X0) X0 = x0; if (x1 > X1) X1 = x1;
      if (y0 < Y0) Y0 = y0; if (y1 > Y1) Y1 = y1;
      if (z0 < Z0) Z0 = z0; if (z1 > Z1) Z1 = z1;
    }
  }

  const totalArea = [...areaOf.values()].reduce((a, b) => a + b, 0) || 1;
  const span = (lo, hi) => (hi - lo) || 1;
  const halfWidth = Math.max(Math.abs(X0), Math.abs(X1)) || 1;

  const shadersFor = new Map();
  for (const mesh of model.meshes) {
    const mat = model.materials[mesh.materialId];
    if (!mat) continue;
    for (const tex of Object.values(mat.slots)) {
      if (!shadersFor.has(tex)) shadersFor.set(tex, new Set());
      shadersFor.get(tex).add(mat.shader);
    }
  }

  const out = [];
  for (const [role, tex] of Object.entries(roles)) {
    const file = typeof tex === 'string' ? tex : tex.file;
    const ms = meshesUsingTexture(model, file);
    let area = 0;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const m of ms) {
      area += areaOf.get(m) ?? 0;
      const b = boxOf.get(m);
      if (!b) continue;
      if (b[0] < x0) x0 = b[0]; if (b[1] > x1) x1 = b[1];
      if (b[2] < y0) y0 = b[2]; if (b[3] > y1) y1 = b[3];
      if (b[4] < z0) z0 = b[4]; if (b[5] > z1) z1 = b[5];
    }
    const bound = ms.length > 0 && x0 <= x1;

    out.push({
      role,
      file,
      meshes: ms.length,
      // A texture bound to no mesh paints nothing. 1133 of the fleet's 8569
      // paintable-looking textures are in this state, so it is not an edge case.
      area: bound ? r3(area / totalArea) : 0,
      box: bound ? [
        r3((x0 - X0) / span(X0, X1)), r3((x1 - X0) / span(X0, X1)),
        r3((y0 - Y0) / span(Y0, Y1)), r3((y1 - Y0) / span(Y0, Y1)),
        r3((z0 - Z0) / span(Z0, Z1)), r3((z1 - Z0) / span(Z0, Z1)),
      ] : null,
      straddles: bound && x0 < -0.08 * halfWidth && x1 > 0.08 * halfWidth,
      skinFraction: skinCount ? (skinCounts.get(file.toLowerCase()) ?? 0) / skinCount : 0,
      shaders: [...(shadersFor.get(file) ?? [])],
      ...(visibleByFile.has(file) ? { visible: visibleByFile.get(file) } : {}),
    });
  }
  return out;
}

/**
 * The livery vocabulary.
 *
 * Each term needs a definition a person can check against a render, because a
 * vocabulary whose terms are defined only by what the classifier happens to pick
 * is not a vocabulary. `score` returns a number; higher wins; 0 excludes.
 */
export const VOCABULARY = {
  body: {
    describes: 'The main painted bodywork — the surface a livery design lives on.',
    score: scoreBody,
  },
  tyres: {
    describes: 'Tyre sidewalls and tread.',
    score: (f) => (f.shaders.some((s) => /ksTyres/i.test(s)) ? f.area : 0),
  },
  brakes: {
    describes: 'Brake discs.',
    score: (f) => (f.shaders.some((s) => /ksBrakeDisc/i.test(s)) ? f.area : 0),
  },
};

/**
 * Bodywork score.
 *
 * Multiplicative rather than additive on purpose: these signals are conjunctive.
 * A surface that is large but invisible is not bodywork, and no amount of size
 * compensates. An additive score lets one strong term outvote a disqualifying
 * one, which is exactly how engine bays win.
 */
function scoreBody(f) {
  let s = f.area;

  // Bodywork crosses the centreline. A part that sits entirely on one side is a
  // corner piece, and knocking it down rather than out keeps single-sided
  // bodywork (a Le Mans car's asymmetric panel) in the running.
  if (!f.straddles) s *= 0.25;

  // Intent. A file every stock skin replaces is per-livery by construction.
  s *= 1 + 2 * f.skinFraction;

  // The shader an author picked says what the surface IS.
  if (f.shaders.some((x) => /damage_dirt/i.test(x))) s *= 1.8;
  if (f.shaders.some((x) => /ksTyres|ksBrakeDisc/i.test(x))) s *= 0.1;

  if (f.box) {
    const [, , , top, front, back] = f.box;
    s *= 1 + (back - front);          // bodywork runs the length of the car
    if (top < 0.45) s *= 0.6;         // sits entirely low: floor, undertray
  }

  // Visibility, when it has been computed. Superlinear because the gap between
  // "seen" and "not seen" is the whole question — engine bays measured 0.14 to
  // 0.19, interior occlusion 0.02, real bodywork 0.55 to 0.89.
  if (typeof f.visible === 'number') s *= f.visible ** 1.5;

  return s;
}

/**
 * Rank a car's textures for one vocabulary term.
 *
 * `features` is one object per candidate texture:
 *   { role, file, area, straddles, skinFraction, shaders, box, visible? }
 *
 * Returns every candidate, best first, each carrying the evidence that produced
 * its score. `confidence` is the margin over the runner-up, normalised — a clear
 * winner scores near 1, a coin-toss near 0. It is a statement about how
 * separated the candidates are, NOT a probability of being right.
 */
export function rank(features, term = 'body') {
  const spec = VOCABULARY[term];
  if (!spec) {
    throw new Error(
      `Unknown vocabulary term "${term}". Known terms: ${Object.keys(VOCABULARY).join(', ')}.`
    );
  }

  const scored = features
    .map((f) => ({ ...f, score: spec.score(f) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return [];

  const [best, next] = scored;
  const confidence = next ? (best.score - next.score) / best.score : 1;
  scored[0] = { ...best, confidence: Math.round(confidence * 100) / 100 };
  return scored;
}

/** Whether a proposal is worth making at all, or whether the field is too flat. */
export function propose(features, term = 'body') {
  const ranked = rank(features, term);
  if (!ranked.length) return null;
  return {
    role: ranked[0].role,
    confidence: ranked[0].confidence,
    source: 'auto',
    validated: VALIDATED.has(term),
  };
}

const pct = (n) => `${Math.round(n * 100)}%`.padStart(4);

/**
 * A human-readable ranking, for `liverykit --explain`.
 *
 * The evidence matters more than the answer. Confirming a binding is a
 * thirty-second job with the numbers in front of you and an unbounded one
 * without them.
 */
export function explain(features, term = 'body', { limit = 8 } = {}) {
  const ranked = rank(features, term);
  const spec = VOCABULARY[term];
  const lines = [];

  lines.push(`${term} — ${spec.describes}`);
  if (!VALIDATED.has(term)) {
    lines.push('  ! This term\'s scoring has NOT been measured against the fleet. Treat it as a hint.');
  }
  if (!ranked.length) {
    lines.push('  No candidate scored above zero. This car may genuinely lack the surface;');
    lines.push('  bind it to null in the profile to say so explicitly.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('  ' + 'role'.padEnd(24) + 'file'.padEnd(30) +
    'area  seen  skins  sym  shader');
  for (const f of ranked.slice(0, limit)) {
    const sym = f.straddles ? ' yes' : '  no';
    const seen = typeof f.visible === 'number' ? pct(f.visible) : '   ?';
    const shader = f.shaders.find((s) => /damage_dirt|ksTyres|ksBrakeDisc/i.test(s)) ?? f.shaders[0] ?? '';
    lines.push('  ' + f.role.slice(0, 23).padEnd(24) + f.file.slice(0, 29).padEnd(30) +
      pct(f.area) + '  ' + seen + '  ' + pct(f.skinFraction) + ' ' + sym + '  ' + shader.slice(0, 28));
  }

  const best = ranked[0];
  lines.push('');
  lines.push(`  proposal: ${best.role}  (confidence ${best.confidence}, margin over runner-up)`);
  if (best.confidence < 0.2) {
    lines.push('  ! The top two are close. Look at the car before accepting this.');
  }
  if (!ranked.some((f) => typeof f.visible === 'number')) {
    lines.push('  ! Visibility was not computed. It is the signal that separates bodywork');
    lines.push('    from engine bays and interior occlusion maps — 90% accurate without it,');
    lines.push('    98% with. Regenerate with visibility enabled before trusting this.');
  }
  return lines.join('\n');
}
