// ---------------------------------------------------------------------------
// Pack a survey into the fleet fixture the classifier test reads.
//
// test/fixtures/fleet-features.json.gz is what lets CI, which has no cars,
// defend the classifier's accuracy figure. It used to be made by a script that
// ran once and was never committed, so the fixture could be read by anyone and
// rebuilt by nobody — and when the classifier came to need a field the survey
// already recorded, the island count, there was nothing to carry it across.
//
// Packing keeps everything the classifier reads and drops what it does not:
// mesh names, axes, timings. Shader names are interned, because 27 of them
// repeat across more than nine thousand textures.
//
//   node tools/survey.mjs <carsDir> --all --visibility --out fleet.json
//   node tools/pack-fleet.mjs fleet.json [--out test/fixtures/fleet-features.json.gz]
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const at = argv.indexOf('--out');
const outPath = at >= 0 ? argv[at + 1]
  : fileURLToPath(new URL('../test/fixtures/fleet-features.json.gz', import.meta.url));
const inPath = argv.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
if (!inPath) {
  console.error('usage: node tools/pack-fleet.mjs <survey.json> [--out fleet-features.json.gz]');
  process.exit(2);
}

const survey = JSON.parse(await readFile(inPath, 'utf8'));
const failed = survey.filter((c) => c.error);
// Sorted by id, so regenerating from the same survey gives the same bytes and a
// changed fixture is a changed measurement rather than a reshuffle.
const cars = survey.filter((c) => !c.error).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// Refused rather than packed without. A texture with no island count would
// read as a texture with none, and the classifier is about to exclude exactly
// those from being the body.
for (const c of cars) {
  // Skin counts are refused the same way. A car without one reads as a car no
  // skin overrides, and a texture without one gives a NaN the body's score
  // then carries, so either would pack and quietly score something else.
  if (typeof c.skinCount !== 'number') {
    throw new Error(`${c.id}: no skin count. Re-run tools/survey.mjs before packing.`);
  }
  const noSkins = Object.entries(c.roles).find(([, t]) => typeof t.skins !== 'number');
  if (noSkins) {
    throw new Error(`${c.id}: role "${noSkins[0]}" has no skin-override count. Re-run tools/survey.mjs before packing.`);
  }
  const bare = Object.entries(c.roles).find(([, t]) => typeof t.panels !== 'number');
  if (bare) {
    throw new Error(`${c.id}: role "${bare[0]}" has no island count. This survey predates it; ` +
      're-run tools/survey.mjs before packing.');
  }
  // The same for the wheel evidence the rims scorer reads: missing, it would
  // read as "no wheel islands", and the scorer excludes exactly those.
  const noWheels = Object.entries(c.roles).find(([, t]) => typeof t.wheelIslands !== 'number');
  if (noWheels) {
    throw new Error(`${c.id}: role "${noWheels[0]}" has no wheel-island count. This survey predates it; ` +
      're-run tools/survey.mjs before packing.');
  }
}

const shaders = [...new Set(cars.flatMap((c) => Object.values(c.roles).flatMap((t) => t.shaders)))].sort();
const index = new Map(shaders.map((s, i) => [s, i]));

const doc = {
  note: 'Measurements only — no game assets. Regenerate with tools/survey.mjs <carsDir> --all --visibility --out fleet.json, ' +
    'then tools/pack-fleet.mjs fleet.json.',
  shaders,
  cars: cars.map((c) => ({
    id: c.id,
    skinCount: c.skinCount,
    roles: Object.fromEntries(Object.entries(c.roles).map(([role, t]) => [role, {
      file: t.file,
      cover: t.cover,
      straddles: t.straddles,
      skins: t.skins,
      sh: t.shaders.map((s) => index.get(s)),
      box: t.box,
      ...(typeof t.visible === 'number' ? { visible: t.visible } : {}),
      panels: t.panels,
      wheelIslands: t.wheelIslands,
      sidewalls: t.sidewalls,
      instances: t.instances,
      ...(typeof t.cockpit === 'number' ? { cockpit: t.cockpit } : {}),
      ...(t.uvLayout ? { uvLayout: t.uvLayout } : {}),
    }])),
  })),
};

await writeFile(outPath, gzipSync(JSON.stringify(doc), { level: 9 }));

const roles = cars.reduce((s, c) => s + Object.keys(c.roles).length, 0);
console.log(`${cars.length} cars, ${roles} textures, ${shaders.length} shaders -> ${outPath}`);
if (failed.length) console.log(`  left out ${failed.length} the survey could not profile: ${failed.map((c) => c.id).join(', ')}`);
// Visibility is what takes the classifier from 90% to 98%, so a fixture short
// of it defends a different figure than the one the docs quote.
const noVis = cars.filter((c) => !Object.values(c.roles).some((t) => typeof t.visible === 'number'));
if (noVis.length) console.log(`  ! ${noVis.length} car(s) have no visibility: ${noVis.map((c) => c.id).join(', ')}`);
// Cockpit visibility needs a steering wheel to stand behind, and a car
// without one is scored for interior without its deciding signal.
const noCockpit = cars.filter((c) => !Object.values(c.roles).some((t) => typeof t.cockpit === 'number'));
if (noCockpit.length) console.log(`  ! ${noCockpit.length} car(s) have no cockpit visibility: ${noCockpit.map((c) => c.id).join(', ')}`);
