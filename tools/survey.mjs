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
import { parseKn5 } from '../src/engine/kn5.mjs';
import { countSkinOverrides } from '../src/engine/scan.mjs';
import { textureFeatures } from '../src/engine/classify.mjs';

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

const r3 = (n) => Math.round(n * 1000) / 1000;


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
    const { skinCount, counts } = await countSkinOverrides(join(carsDir, id, 'skins'));

    // The measurement itself lives in the engine, so the survey and the shipped
    // classifier cannot drift apart. Two copies of the area maths would be two
    // different accuracy figures within a month.
    const visibleByFile = new Map();
    for (const [role, v] of visOf) visibleByFile.set(prof.textures[role].file, v);
    const features = textureFeatures(model, {
      roles: prof.textures, skinCounts: counts, skinCount, visibleByFile,
    });
    const byRole = new Map(features.map((f) => [f.role, f]));

    const panels = Object.fromEntries(Object.entries(prof.panels).map(([r, p]) => [r, Object.keys(p).length]));
    results.push({
      id, klass, ms: Date.now() - t0,
      model: kn5.split('/').pop(),
      skinCount,
      roles: Object.fromEntries(Object.entries(prof.textures).map(([role, t]) => {
        const f = byRole.get(role);
        return [role, {
          file: t.file, w: t.width, h: t.height,
          panels: panels[role] ?? 0,
          cover: f.area, meshes: f.meshes, box: f.box, straddles: f.straddles,
          ...(typeof f.visible === 'number' ? { visible: f.visible } : {}),
          skins: counts.get(t.file.toLowerCase()) ?? 0,
          shaders: f.shaders,
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
