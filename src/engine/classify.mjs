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
//              panel in all but name; ksTyres and ksBrakeDisc weigh heavily
//              against, though they do not exclude outright — a car whose only
//              paintable surface shared a material with its tyres should still
//              produce a ranking rather than an empty one.
//   visible    ray-cast trackside visibility. The decisive one, and the
//              expensive one.
//
// MEASURED ACCURACY. Scored against a held-out label — the 195 fleet cars whose
// filename is unambiguous, which this code never sees — the first four signals
// pick the right body on 175/195 (90%). The failures are a coherent group:
// interior occlusion maps, engine bays and undertrays, all large, all symmetric,
// all invisible. Adding visibility, and the island count (see excludedWhy),
// takes it to 192/195 (98.5%), and two of the three remaining misses are the
// LABEL being wrong: on the Evora GTE and its
// carbon variant this picks Carpaint_D, which every stock skin overrides and
// which is 79% visible, over a labelled Skin_soft that no skin overrides and
// that is 0.1% visible. Counted properly, 194/195.
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
export function textureFeatures(model, { roles = {}, skinCounts = new Map(), skinCount = 0, visibleByFile = new Map(), panels = null } = {}) {
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
      // Lowercased, as meshesUsingTexture compares: a slot may spell the file
      // differently from the role that names it, and they are one file.
      const k = tex.toLowerCase();
      if (!shadersFor.has(k)) shadersFor.set(k, new Set());
      shadersFor.get(k).add(mat.shader);
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
      shaders: [...(shadersFor.get(file.toLowerCase()) ?? [])],
      ...(visibleByFile.has(file) ? { visible: visibleByFile.get(file) } : {}),
      // What the caller's profile found on the texture: how many paintable
      // islands, and how its UVs use the image. This function measures the
      // model and cannot know either, so both come from the profile that is
      // always in hand when bindings are proposed or explained. A caller
      // without one gets neither, and nothing is excluded on their account.
      ...(panels ? { islands: Object.keys(panels[role] ?? {}).length } : {}),
      ...(typeof tex === 'object' && tex.uvLayout ? { uvLayout: tex.uvLayout } : {}),
    });
  }
  return out;
}

/**
 * Classifier features from a recorded survey car rather than from a model.
 *
 * Two readers rebuild features from records — tools/evaluate.mjs from the
 * survey's raw output, test/classifier.test.mjs from the packed fixture — and
 * each used to map the fields by hand. A field the classifier gains then has to
 * be remembered in both, and forgetting it in either means the accuracy figure
 * is measured on a classifier that does not ship. So there is one mapping, here,
 * beside the function whose output it has to match.
 *
 * Shader names come either inline (`shaders`, the survey) or interned (`sh`,
 * indices into the fixture's `shaders` table). `panels`, the survey's island
 * count, becomes `islands`.
 */
export function featuresFromRecord(car, { shaderNames = [] } = {}) {
  return Object.entries(car.roles).map(([role, t]) => ({
    role,
    file: t.file,
    area: t.cover,
    straddles: t.straddles,
    box: t.box,
    skinFraction: car.skinCount ? t.skins / car.skinCount : 0,
    shaders: t.shaders ?? t.sh.map((i) => shaderNames[i]),
    ...(typeof t.visible === 'number' ? { visible: t.visible } : {}),
    ...(typeof t.panels === 'number' ? { islands: t.panels } : {}),
    ...(t.uvLayout ? { uvLayout: t.uvLayout } : {}),
  }));
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
  // Terms a car's own shader names, where the car may use several textures for
  // the one surface: a tread and a sidewall, a front disc and a rear. `propose`
  // binds every candidate that only the term's shader draws, rather than the
  // biggest, because picking one was wrong in the same way on every car that
  // had two — 11 of 176 labelled cars bound the tread and left the sidewall,
  // where the lettering goes, unpainted. A texture another shader also draws is
  // a swatch shared with other parts, and painting it paints them too: the
  // Morgan's tyres were bound to a white.dds its body materials use.
  tyres: {
    describes: 'Tyre sidewalls and tread.',
    gate: /ksTyres/i,
    bindsEvery: true,
    score: (f) => (f.shaders.some((s) => /ksTyres/i.test(s)) ? f.area : 0),
  },
  brakes: {
    describes: 'Brake discs.',
    gate: /ksBrakeDisc/i,
    bindsEvery: true,
    score: (f) => (f.shaders.some((s) => /ksBrakeDisc/i.test(s)) ? f.area : 0),
  },

  // Terms with no `score` are never proposed automatically, but they are valid
  // targets for a livery and for a human binding. That split matters: the
  // vocabulary is the CONTRACT a livery writes against, and it should not be
  // limited to whatever a classifier currently happens to be good at.
  wing: { describes: 'Aerodynamic wings and their endplates.' },
  floor: { describes: 'Underfloor, diffuser, splitter.' },
  rims: { describes: 'Wheel faces. Usually one texture shared by all four.' },
  glass: { describes: 'Windows and windscreen. Tintable in principle, easy to ruin.' },
  mirror: { describes: 'Mirror housings.' },
  interior: { describes: 'Cabin surfaces — tub, dash, trim.' },
  seat: { describes: 'Seat shell and cushions, where separable from the interior.' },
  belts: { describes: 'Harness straps. Usually an atlas of strips running down the texture.' },
  steeringWheel: { describes: 'Steering wheel rim and spokes.' },
  wheelLogo: { describes: 'The badge at the centre of the steering wheel.' },
  helmet: { describes: "The driver's helmet." },
  suit: { describes: "The driver's race suit." },
  gloves: { describes: "The driver's gloves." },
  crew: { describes: 'Pit crew kit. A shared AC asset, not part of the car.' },
  numberPlate: { describes: 'Road-car registration plate.' },
  heatShield: { describes: 'Exhaust heat-shield foil, gold as shipped on most cars.' },
  metalTrim: { describes: 'Bright metal detail — grilles, badges, exhaust tips.' },
};

/** Terms the classifier can propose. The rest are for a human to bind. */
export const SCORABLE = Object.keys(VOCABULARY).filter((t) => VOCABULARY[t].score);

/**
 * Why a texture cannot be the body at all, or null.
 *
 * A sheet no island lives on has nothing a livery could be placed on. It is not
 * a weaker candidate but no candidate, and the comment on VOCABULARY says what 0
 * means. The mp412c GT3 bound its body to `black.dds`, a flat swatch with no
 * islands, on a car whose interior has 90 panels — and every tag selection on
 * it then matched nothing.
 *
 * A tiled `uvLayout` is deliberately NOT a reason, though the plan first said it
 * should be. Measured on the fleet it excluded two real bodies and cost two
 * points: the S14 Zenki's livery is an ordinary unwrap straddling a sheet
 * boundary, which the layout measure reads as tiled, and the 992 Cup's body
 * sheet has islands running past one sheet. Every swatch it would have caught
 * has no islands and is caught here anyway.
 *
 * Only when the caller says: `islands` comes from a profile, and features
 * without it are scored as they always were.
 */
export function excludedWhy(f) {
  if (f.islands === 0) return 'no islands';
  return null;
}

/**
 * Bodywork score.
 *
 * Multiplicative rather than additive on purpose: these signals are conjunctive.
 * A surface that is large but invisible is not bodywork, and no amount of size
 * compensates. An additive score lets one strong term outvote a disqualifying
 * one, which is exactly how engine bays win.
 */
function scoreBody(f) {
  // Zero, not a penalty: see excludedWhy.
  if (excludedWhy(f)) return 0;
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
  // Object.hasOwn, not a truthiness test: VOCABULARY['toString'] inherits a
  // function from Object.prototype and would otherwise sail through as a valid
  // term, which is the opposite of a closed vocabulary.
  const spec = Object.hasOwn(VOCABULARY, term) ? VOCABULARY[term] : undefined;
  if (!spec) {
    throw new Error(
      `Unknown vocabulary term "${term}". Known terms: ${Object.keys(VOCABULARY).join(', ')}.`
    );
  }
  // Distinct from "no such term": this one is real, it just has no measurement
  // behind it yet, and inventing one would be worse than saying so.
  if (!spec.score) {
    throw new Error(
      `Vocabulary term "${term}" has no scoring rule, so it cannot be proposed automatically. ` +
      `Bind it by hand in the profile. Scorable terms: ${SCORABLE.join(', ')}.`
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
  const spec = VOCABULARY[term];
  // Every candidate only the term's own shader draws, for a term that binds
  // them all (see VOCABULARY). Its confidence is 1: nothing that shader alone
  // draws is left out, so there is no runner-up to be close to. A car with no
  // such texture keeps the single best candidate, as every term used to.
  const own = spec.bindsEvery
    ? ranked.filter((f) => f.shaders.length > 0 && f.shaders.every((s) => spec.gate.test(s)))
    : [];
  const roles = own.length ? own.map((f) => f.role) : [ranked[0].role];
  return {
    role: roles[0],
    roles,
    confidence: own.length ? 1 : ranked[0].confidence,
    source: 'auto',
    validated: VALIDATED.has(term),
    // The candidates the gate left out as shared swatches, for --explain to
    // name. Present only where the gate decided: with nothing the term's
    // shader alone draws, the margin decided, and there is nothing to name.
    ...(own.length ? { shared: ranked.filter((f) => !own.includes(f)).map((f) => f.role) } : {}),
  };
}

/**
 * Every scorable term's proposal, as the `bind` block a profile carries.
 *
 * One function for the generator and for `--explain --all`, so the block a
 * person is handed to paste is the block a regeneration would have written. Two
 * loops over the same terms would be two answers the day one of them changes.
 */
export function proposeAll(features) {
  const bind = {};
  for (const term of SCORABLE) {
    const p = propose(features, term);
    // A term with no candidate is left OUT rather than bound to an empty array.
    // An empty array means "this car has no such surface", which is a claim, and
    // the classifier is not entitled to make it — only a person is.
    if (p) bind[term] = { roles: p.roles, confidence: p.confidence, source: 'auto' };
  }
  return bind;
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
  // Named, because a large, visible, symmetric texture missing from the table
  // reads as the classifier overlooking it, not as a decision it made.
  const notCandidates = term === 'body'
    ? features.filter((f) => excludedWhy(f) && f.area >= 0.02).sort((a, b) => b.area - a.area).slice(0, 3)
    : [];
  const sayExcluded = () => {
    for (const f of notCandidates) {
      lines.push(`  not a candidate: ${f.file} — ${excludedWhy(f)}, ${pct(f.area).trim()} of the car's area`);
    }
  };
  if (!ranked.length) {
    lines.push('  No candidate scored above zero. This car may genuinely lack the surface;');
    lines.push('  bind it to an empty "roles" array in the profile to say so explicitly.');
    sayExcluded();
    return lines.join('\n');
  }

  lines.push('');
  lines.push('  ' + 'role'.padEnd(24) + 'file'.padEnd(30) +
    'area  seen  skins  sym  isl  shader');
  for (const f of ranked.slice(0, limit)) {
    const sym = f.straddles ? ' yes' : '  no';
    const seen = typeof f.visible === 'number' ? pct(f.visible) : '   ?';
    const isl = typeof f.islands === 'number' ? String(f.islands).padStart(3) : '  ?';
    const shader = f.shaders.find((s) => /damage_dirt|ksTyres|ksBrakeDisc/i.test(s)) ?? f.shaders[0] ?? '';
    lines.push('  ' + f.role.slice(0, 23).padEnd(24) + f.file.slice(0, 29).padEnd(30) +
      pct(f.area) + '  ' + seen + '  ' + pct(f.skinFraction) + ' ' + sym + '  ' + isl + '  ' + shader.slice(0, 28));
  }
  if (notCandidates.length) lines.push('');
  sayExcluded();

  // What propose binds, and on what grounds. That is not always the table's
  // top row: where the gate decided, a shared swatch can outrank everything
  // it binds, and printing that row with its margin named a proposal nobody
  // would get, then warned about a closeness that had decided nothing.
  const proposal = propose(features, term);
  lines.push('');
  if (proposal.shared) {
    lines.push(`  proposal: ${proposal.roles.join(', ')}  (confidence 1: every texture only ${spec.gate.source} draws)`);
    for (const f of ranked.filter((x) => proposal.shared.includes(x.role))) {
      const others = f.shaders.filter((s) => !spec.gate.test(s));
      lines.push(`  left out: ${f.role} (${f.file}) — ${others.join(', ')} draws it too, so painting it would paint those parts`);
    }
  } else {
    if (spec.bindsEvery) lines.push(`  No texture is drawn by ${spec.gate.source} alone, so the best candidate is proposed.`);
    lines.push(`  proposal: ${proposal.role}  (confidence ${proposal.confidence}, margin over runner-up)`);
    if (proposal.confidence < 0.2) {
      lines.push('  ! The top two are close. Look at the car before accepting this.');
    }
  }
  if (!ranked.some((f) => typeof f.visible === 'number')) {
    lines.push('  ! Visibility was not computed. It is the signal that separates bodywork');
    lines.push('    from engine bays and interior occlusion maps — 90% accurate without it,');
    lines.push('    98% with. Regenerate with visibility enabled before trusting this.');
  }
  return lines.join('\n');
}
