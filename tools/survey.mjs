// ---------------------------------------------------------------------------
// Cross-car naming survey.
//
// Profiles a spread of cars and reports what the texture and mesh names ACTUALLY
// look like across classes, so a tag vocabulary can be designed against measured
// naming rather than against the one mod car this project started with.
//
// Not part of the shipped tool. It reads car content that is deliberately not in
// this repo, so it is only useful to someone with a game install.
//
//   node tools/survey.mjs <carsDir> [--out survey.json] [--all] [carId ...]
// ---------------------------------------------------------------------------

import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { parseKn5, meshesUsingTexture, triangles, vertex } from '../src/engine/kn5.mjs';

// A deliberate spread: if a naming scheme only holds for one class it is not a
// scheme, it is a coincidence.
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

const args = process.argv.slice(2);
const carsDir = args.find((a) => !a.startsWith('--')) ?? 'cars';
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'survey.json';
const explicit = args.filter((a) => !a.startsWith('--') && a !== carsDir && a !== outPath);

let plan;
if (explicit.length) {
  plan = explicit.map((id) => ({ id, klass: 'requested' }));
} else if (args.includes('--all')) {
  const dirs = (await readdir(carsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  const known = new Map(Object.entries(SAMPLE).flatMap(([k, v]) => v.map((id) => [id, k])));
  plan = dirs.map((d) => ({ id: d.name, klass: known.get(d.name) ?? 'unclassified' }));
} else {
  plan = Object.entries(SAMPLE).flatMap(([klass, ids]) => ids.map((id) => ({ id, klass })));
}

const results = [];
for (const { id, klass } of plan) {
  const kn5 = await bestKn5(join(carsDir, id));
  if (!kn5) { results.push({ id, klass, error: 'no kn5' }); continue; }

  const skins = join(carsDir, id, 'skins');
  const t0 = Date.now();
  try {
    // Visibility is the expensive half and says nothing about naming, which is
    // the question here. cockpitEye is still exercised, because whether it finds
    // a steering wheel at all is itself a naming finding.
    const prof = await profileFromKn5(kn5, { id, skinsDir: skins, visibility: false });

    // How much of the car each texture actually covers. This is the measurement
    // that no filename and no skin folder can give you: metal_detail.dds is the
    // file most road-car skins override, and on some of those cars it is bound
    // to no mesh at all — overriding it paints nothing, silently.
    const model = await parseKn5(kn5, { keepTextureData: false });

    // Coverage must be measured in SQUARE METRES, not in vertices. A cockpit is
    // the densest geometry on a car — dials, switches, stitching — and the
    // bodywork is among the sparsest, so counting vertices ranks an interior
    // occlusion map above the paint on every car in the sample. Area is what a
    // livery actually covers.
    const areaOf = new Map();
    for (const mesh of model.meshes) {
      let a = 0;
      for (const [i, j, k] of triangles(model, mesh)) {
        const p0 = vertex(model, mesh, i), p1 = vertex(model, mesh, j), p2 = vertex(model, mesh, k);
        const e1 = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
        const e2 = [p2.x - p0.x, p2.y - p0.y, p2.z - p0.z];
        const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        a += Math.hypot(c[0], c[1], c[2]) / 2;
      }
      areaOf.set(mesh, a);
    }
    const totalArea = [...areaOf.values()].reduce((a, b) => a + b, 0);
    const cover = (file) => meshesUsingTexture(model, file).reduce((a, m) => a + (areaOf.get(m) ?? 0), 0) / (totalArea || 1);
    const panels = Object.fromEntries(Object.entries(prof.panels).map(([r, p]) => [r, Object.keys(p).length]));
    results.push({
      id, klass, ms: Date.now() - t0,
      model: kn5.split('/').pop(),
      roles: Object.fromEntries(Object.entries(prof.textures).map(([r, t]) =>
        [r, { file: t.file, w: t.width, h: t.height, panels: panels[r] ?? 0, cover: +cover(t.file).toFixed(4) }])),
      doNotPaint: prof.doNotPaint.length,
      panelTotal: Object.values(panels).reduce((a, b) => a + b, 0),
      axes: prof.calibration.axes,
      // Panel names encode side/section/level, and the mesh each came from is
      // the raw naming evidence the tag vocabulary has to be designed against.
      meshes: [...new Set(Object.values(prof.panels).flatMap((p) => Object.values(p).map((v) => v.mesh)))].filter(Boolean),
    });
    process.stdout.write(`  ${id.padEnd(38)} ${Object.keys(prof.textures).length} roles, ` +
      `${Object.values(panels).reduce((a, b) => a + b, 0)} panels\n`);
  } catch (e) {
    results.push({ id, klass, error: e.message });
    process.stdout.write(`  ${id.padEnd(38)} FAILED: ${e.message}\n`);
  }
}

await writeFile(outPath, JSON.stringify(results, null, 2));
const ok = results.filter((r) => !r.error);
console.log(`\n${ok.length}/${results.length} profiled -> ${outPath}`);
