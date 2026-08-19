// ---------------------------------------------------------------------------
// Cross-car naming survey.
//
// Profiles a fleet of cars and records, per texture, the features a name-free
// classifier could plausibly key on. The point is to design the high-level ->
// car-specific translation layer against measured naming rather than against the
// one mod car this project started with.
//
// What it records per texture, and why:
//
//   cover      fraction of the car's SURFACE AREA, not its vertices. A cockpit
//              is the densest geometry on a car and the bodywork among the
//              sparsest, so counting vertices ranks an interior occlusion map
//              above the paint on essentially every car.
//   skins      how many stock skins override the file. Authoritative about
//              intent — an author who ships it in every skin means it to vary
//              per livery — and useless about size: metal_detail.dds is in every
//              road-car skin and on some of those cars binds to no mesh at all.
//   box        where the geometry sits, normalised to the car's own bounding
//              box, so "high and central" means the same thing on a Formula car
//              and a van.
//   symmetry   whether the geometry straddles the centreline. Bodywork does;
//              a single wheel does not; four wheels sharing one texture do.
//   shaders    the material shader names. ksPerPixelMultiMap_damage_dirt is a
//              body panel in all but name.
//
// Not part of the shipped tool. It reads car content that is deliberately not in
// this repo, so it is only useful to someone with a game install.
//
//   node tools/survey.mjs <carsDir> [--out survey.json] [--all] [--limit N]
//                                   [--fresh] [--visibility] [carId ...]
//
// Resumes by default: cars already present in --out are skipped, so a large
// fleet can be swept in several passes.
// ---------------------------------------------------------------------------

import { readdir, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { parseKn5, meshesUsingTexture, triangles, vertex } from '../src/engine/kn5.mjs';

// A deliberate spread, used when no car ids and no --all are given. If a naming
// scheme only holds for one class it is not a scheme, it is a coincidence.
const SAMPLE = {
  'GT3 / GTE': ['ks_audi_r8_lms_2016', 'ks_ferrari_488_gt3', 'ks_mercedes_amg_gt3',
                'ks_porsche_911_gt3_r_2016', 'ks_nissan_gtr_gt3', 'bmw_m3_gt2'],
  'open wheel': ['rss_formula_rss_4', 'ks_ferrari_sf70h', 'ks_ferrari_f2004', 'dallara_f317',
                 'tatuusfa1', 'ks_lotus_72d', 'lotus_49', 'ks_maserati_250f_6cyl'],
  prototype: ['ks_porsche_919_hybrid_2016', 'ks_audi_r18_etron_quattro', 'ks_toyota_ts040',
              'ks_mazda_787b', 'ks_porsche_962c_shorttail'],
  'road car': ['abarth500', 'ks_mazda_miata', 'ks_toyota_ae86', 'ks_porsche_991_carrera_s',
               'ferrari_458', 'ks_lamborghini_huracan_performante', 'ks_nissan_skyline_r34'],
  vintage: ['ks_ferrari_250_gto', 'ks_porsche_917_k', 'shelby_cobra_427sc',
            'ks_alfa_33_stradale', 'ks_ford_gt40', 'tc_legends_bmw_2002'],
  touring: ['btcc_honda_civic', 'pm3dm_volvo_s40_btcc', 'ks_alfa_romeo_155_v6',
            'ks_bmw_m235i_racing', 'ks_audi_tt_cup'],
  outlier: ['ktm_xbow_r', 'ford_transit', 'ft_morgan_3_wheeler', 'rt_bacmono', 'lotus_2_eleven'],
};

/**
 * The highest-detail model in a car folder.
 *
 * collider.kn5 is a physics hull with no textures worth reading, and LOD B/C/D
 * are decimated copies whose UV islands are NOT the ones a skin is authored
 * against. Some cars call the full model `<id>.kn5` and others `<id>_lod_a.kn5`,
 * so both spellings have to be accepted.
 */
async function bestKn5(dir) {
  let files;
  try {
    files = (await readdir(dir)).filter((f) => /\.kn5$/i.test(f));
  } catch {
    return null;
  }
  const candidates = files.filter((f) => !/^collider\.kn5$/i.test(f) && !/_lod_[bcd]\.kn5$/i.test(f));
  if (!candidates.length) return null;
  const sized = await Promise.all(candidates.map(async (f) => {
    const p = join(dir, f);
    return { path: p, bytes: (await stat(p)).size };
  }));
  return sized.sort((a, b) => b.bytes - a.bytes)[0].path;
}

/** How many stock skins override each texture file, keyed lowercase. */
async function skinOverrides(dir) {
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return { skinCount: 0, counts: new Map() };
  }
  const counts = new Map();
  let skinCount = 0;
  for (const e of names) {
    if (!e.isDirectory()) continue;
    let files;
    try { files = await readdir(join(dir, e.name)); } catch { continue; }
    skinCount++;
    for (const f of files) {
      if (!/\.(dds|png)$/i.test(f)) continue;
      const k = f.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return { skinCount, counts };
}

const r3 = (n) => Math.round(n * 1000) / 1000;

/** Per-texture geometry: area, where it sits, and whether it straddles the centreline. */
function geometry(model) {
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
    if (x0 <= x1) {
      boxOf.set(mesh, [x0, x1, y0, y1, z0, z1]);
      // The car's own extent comes from meshes with real geometry only. An empty
      // mesh would otherwise drag the bounds to infinity and normalise everything
      // to zero.
      if (x0 < X0) X0 = x0; if (x1 > X1) X1 = x1;
      if (y0 < Y0) Y0 = y0; if (y1 > Y1) Y1 = y1;
      if (z0 < Z0) Z0 = z0; if (z1 > Z1) Z1 = z1;
    }
  }

  const totalArea = [...areaOf.values()].reduce((a, b) => a + b, 0) || 1;
  const span = (lo, hi) => (hi - lo) || 1;

  return function describe(file) {
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
    if (!ms.length || x0 > x1) return { cover: 0, meshes: ms.length, box: null, straddles: false };

    // Normalised 0..1 against the whole car, so "high and central" reads the
    // same on a Formula car and a Transit.
    const box = [
      r3((x0 - X0) / span(X0, X1)), r3((x1 - X0) / span(X0, X1)),
      r3((y0 - Y0) / span(Y0, Y1)), r3((y1 - Y0) / span(Y0, Y1)),
      r3((z0 - Z0) / span(Z0, Z1)), r3((z1 - Z0) / span(Z0, Z1)),
    ];
    // Straddling the centreline separates bodywork from a single corner part.
    // Four wheels sharing one texture also straddle, which is exactly the case
    // that breaks the assumption that one panel is one part.
    const halfWidth = Math.max(Math.abs(X0), Math.abs(X1)) || 1;
    const straddles = x0 < -0.08 * halfWidth && x1 > 0.08 * halfWidth;

    return { cover: r3(area / totalArea), meshes: ms.length, box, straddles };
  };
}

// --- argument handling ------------------------------------------------------

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const outPath = flagValue('--out', 'survey.json');
const limit = Number(flagValue('--limit', '0')) || Infinity;
const consumed = new Set(['--out', outPath, '--limit', flagValue('--limit', '')]);
const bare = argv.filter((a) => !a.startsWith('--') && !consumed.has(a));
const carsDir = bare[0] ?? 'cars';
const explicit = bare.slice(1);

let plan;
if (explicit.length) {
  plan = explicit.map((id) => ({ id, klass: 'requested' }));
} else if (argv.includes('--all')) {
  const dirs = (await readdir(carsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  const known = new Map(Object.entries(SAMPLE).flatMap(([k, v]) => v.map((id) => [id, k])));
  plan = dirs.map((d) => ({ id: d.name, klass: known.get(d.name) ?? 'unclassified' }));
} else {
  plan = Object.entries(SAMPLE).flatMap(([klass, ids]) => ids.map((id) => ({ id, klass })));
}

// Resume. A fleet sweep is minutes of work and there is no reason to redo the
// part that already succeeded.
let results = [];
if (!argv.includes('--fresh')) {
  try { results = JSON.parse(await readFile(outPath, 'utf8')); } catch { /* first run */ }
}
const done = new Set(results.map((r) => r.id));
const todo = plan.filter((p) => !done.has(p.id)).slice(0, limit);
console.log(`${plan.length} planned, ${done.size} already done, ${todo.length} this pass\n`);

// --- the sweep --------------------------------------------------------------

for (const { id, klass } of todo) {
  const kn5 = await bestKn5(join(carsDir, id));
  if (!kn5) { results.push({ id, klass, error: 'no kn5' }); continue; }

  const t0 = Date.now();
  try {
    // Visibility is the expensive half and says nothing about naming, which is
    // the question here. cockpitEye is still exercised, because whether it finds
    // a steering wheel at all is itself a naming finding.
    const wantVis = argv.includes('--visibility');
    const prof = await profileFromKn5(kn5, { id, skinsDir: join(carsDir, id, 'skins'), visibility: wantVis });

    // Area-weighted mean trackside visibility per texture. This is the signal
    // that separates bodywork from the two things that otherwise outrank it —
    // interior occlusion maps and engine bays — both of which are large and both
    // of which nobody can see.
    const visOf = new Map();
    if (wantVis) {
      for (const [role, ps] of Object.entries(prof.panels)) {
        const vals = Object.values(ps).map((v) => v.visible).filter((v) => typeof v === 'number');
        if (vals.length) visOf.set(role, +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3));
      }
    }
    const model = await parseKn5(kn5, { keepTextureData: false });
    const describe = geometry(model);
    const { skinCount, counts } = await skinOverrides(join(carsDir, id, 'skins'));

    // Shader names per texture. A material shader is a stronger statement of
    // intent than a filename: an author picks it for what the surface IS.
    const shadersFor = new Map();
    for (const mesh of model.meshes) {
      const mat = model.materials[mesh.materialId];
      if (!mat) continue;
      for (const tex of Object.values(mat.slots)) {
        if (!shadersFor.has(tex)) shadersFor.set(tex, new Set());
        shadersFor.get(tex).add(mat.shader);
      }
    }

    const panels = Object.fromEntries(Object.entries(prof.panels).map(([r, p]) => [r, Object.keys(p).length]));
    results.push({
      id, klass, ms: Date.now() - t0,
      model: kn5.split('/').pop(),
      skinCount,
      roles: Object.fromEntries(Object.entries(prof.textures).map(([role, t]) => {
        const g = describe(t.file);
        return [role, {
          file: t.file, w: t.width, h: t.height,
          panels: panels[role] ?? 0,
          cover: g.cover, meshes: g.meshes, box: g.box, straddles: g.straddles,
          ...(visOf.has(role) ? { visible: visOf.get(role) } : {}),
          skins: counts.get(t.file.toLowerCase()) ?? 0,
          shaders: [...(shadersFor.get(t.file) ?? [])],
        }];
      })),
      doNotPaint: prof.doNotPaint.length,
      panelTotal: Object.values(panels).reduce((a, b) => a + b, 0),
      axes: prof.calibration.axes,
      meshes: [...new Set(model.meshes.map((m) => m.name))],
    });
    process.stdout.write(`  ${id.padEnd(40)} ${Object.keys(prof.textures).length} roles, ` +
      `${Object.values(panels).reduce((a, b) => a + b, 0)} panels, ${skinCount} skins\n`);
  } catch (e) {
    results.push({ id, klass, error: e.message });
    process.stdout.write(`  ${id.padEnd(40)} FAILED: ${e.message}\n`);
  }
  await writeFile(outPath, JSON.stringify(results, null, 2));   // checkpoint every car
}

const ok = results.filter((r) => !r.error);
console.log(`\n${ok.length} profiled, ${results.length - ok.length} failed -> ${outPath}`);
