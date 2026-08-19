// ---------------------------------------------------------------------------
// Do the wheels agree with the name heuristic?
//
// `axesFromWheels` reads a car's orientation from the WHEEL_LF/RF/LR/RR nodes
// Assetto Corsa's physics requires every car to have. `axisHints` guesses from
// whatever directional words happen to be in the mesh names, and on 91 of 235
// fleet cars it could not reach a conclusion at all.
//
// This scores the exact method against the heuristic on the cars where the
// heuristic WAS confident — a held-out label, in the same spirit as
// tools/evaluate.mjs. Disagreement on those is the thing to worry about.
//
//   node tools/axes.mjs <carsDir> [--out axes.json]
//
// Resumable: cars already in --out are skipped.
// ---------------------------------------------------------------------------

import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseKn5, axisHints, axesFromWheels } from '../src/engine/kn5.mjs';

const argv = process.argv.slice(2);
const carsDir = argv.find((a) => !a.startsWith('--')) ?? 'cars';
const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'axes.json';

async function bestKn5(dir) {
  const files = (await readdir(dir)).filter((f) =>
    /\.kn5$/i.test(f) && !/^collider\.kn5$/i.test(f) && !/_lod_[bcd]\.kn5$/i.test(f));
  if (!files.length) return null;
  const sized = await Promise.all(files.map(async (f) => ({ f, n: (await stat(join(dir, f))).size })));
  return join(dir, sized.sort((a, b) => b.n - a.n)[0].f);
}

let results = [];
try { results = JSON.parse(await readFile(outPath, 'utf8')); } catch { /* first run */ }
const done = new Set(results.map((r) => r.id));

const dirs = (await readdir(carsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
for (const d of dirs) {
  if (done.has(d.name)) continue;
  const kn5 = await bestKn5(join(carsDir, d.name)).catch(() => null);
  if (!kn5) { results.push({ id: d.name, error: 'no kn5' }); continue; }
  try {
    const model = await parseKn5(kn5, { keepTextureData: false });
    const hint = axisHints(model);
    const wheels = axesFromWheels(model);
    results.push({ id: d.name, hint, wheels });
    process.stdout.write(`  ${d.name.padEnd(34)} hint ${hint.confident ? 'conf' : 'LOW '} ` +
      `${hint.left > 0 ? '+X' : '-X'}/${hint.front > 0 ? '+Z' : '-Z'}   wheels ` +
      (wheels ? `${wheels.left > 0 ? '+X' : '-X'}/${wheels.front > 0 ? '+Z' : '-Z'} ` +
        `track ${wheels.trackWidth.toFixed(2)}m wb ${wheels.wheelbase.toFixed(2)}m` : 'NONE') + '\n');
  } catch (e) {
    results.push({ id: d.name, error: e.message.split('\n')[0] });
  }
  await writeFile(outPath, JSON.stringify(results, null, 2));
}
console.log(`\n${results.length} cars -> ${outPath}`);
