#!/usr/bin/env node
import { stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { buildSkin, buildCalibration, packSkin } from '../src/build.mjs';
import { loadProfile, doNotPaint, mergeBindings, binding } from '../src/profile.mjs';
import { scanSkins, formatScan, countSkinOverrides } from '../src/engine/scan.mjs';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { parseKn5 } from '../src/engine/kn5.mjs';
import { textureFeatures, explain } from '../src/engine/classify.mjs';
import '../src/index.mjs'; // registers the built-in packs

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
liverykit — generate Assetto Corsa liveries from code

  liverykit <livery> [options]        build a livery
  liverykit <livery> --uvgrid         build its car's UV calibration skin
  liverykit --scan <path>             inspect a car's textures, emit a profile
  liverykit --explain <kn5>           rank which texture is the bodywork, with
                                      the evidence, so you can confirm it

Arguments
  <livery>            path to a livery module, or a name in ./liveries/

Options
  --out <dir>         output directory                        (default: dist)
  --size <px>         render size for the largest texture; scales everything
  --seed <string>     re-roll all procedural placement
  --flat              solid colour, no art — proves the plumbing first
  --keep-png          keep the intermediate PNGs for inspection
  --no-zip            write the folder only

  --uvgrid            build the calibration skin instead of the livery
  --cells <n>         calibration grid columns (default 20 = 5% steps)
  --probe <a,b,c>     also ship these filenames as colour-coded name probes

  --scan <path>       point at a car's skins/ directory
  --explain <kn5>     rank candidates for a vocabulary term and show why
  --term <name>       which term to explain (default: body)
  --no-visibility     skip the ray casting; faster, and 90% accurate not 98%
  --from-kn5 <path>   generate a car profile from the 3D model (best source)
  --skins <dir>       cross-reference real texture sizes (kn5 embeds low-res)
  --profile <path>    override the car profile (default: cars/<livery.car>.json)
  --pack <module>     load an extra treatment pack (repeatable)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'dist' },
    size: { type: 'string' },
    seed: { type: 'string' },
    flat: { type: 'boolean', default: false },
    'keep-png': { type: 'boolean', default: false },
    'no-zip': { type: 'boolean', default: false },
    uvgrid: { type: 'boolean', default: false },
    cells: { type: 'string' },
    probe: { type: 'string' },
    scan: { type: 'string' },
    explain: { type: 'string' },
    term: { type: 'string', default: 'body' },
    'no-visibility': { type: 'boolean', default: false },
    'from-kn5': { type: 'string' },
    'car-id': { type: 'string' },
    'car-name': { type: 'string' },
    skins: { type: 'string' },
    profile: { type: 'string' },
    pack: { type: 'string', multiple: true, default: [] },
    help: { type: 'boolean', default: false },
  },
});

// Everything below runs at top level, so without this every failure — including
// the deliberate, well-worded ones — reaches the user as an uncaught-rejection
// dump with internal Node frames in it.
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
function fail(err) {
  console.error(`\n${err?.message ?? err}\n`);
  process.exit(1);
}

/** parseArgs gives us strings; anything numeric has to be checked explicitly. */
function num(value, name, { min, max, integer = false }) {
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    fail(new Error(
      `--${name} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}, got "${value}".`
    ));
  }
  return n;
}

if (values.help) { console.log(USAGE); process.exit(0); }

// --- profile generation from the model --------------------------------------
//
// The best available source. A scan of skin folders only sees textures somebody
// chose to override, and a photographed calibration grid only approximates
// where panels are. The model has both, exactly.
if (values['from-kn5']) {
  const src = resolve(values['from-kn5']);
  console.log(`Reading ${src}\n`);
  const profile = await profileFromKn5(src, {
    id: values['car-id'],
    name: values['car-name'] ?? '',
    skinsDir: values.skins ? resolve(values.skins) : null,
    log: console.log,
  });
  // Regenerating must never cost hand-checked work. If a profile for this car
  // already exists, anything a human confirmed in its `bind` block survives; the
  // machine's own earlier guesses are replaced by the current ones.
  const priorPath = join(ROOT, 'cars', `${profile.id}.json`);
  const prior = await readFile(priorPath, 'utf8').then(JSON.parse).catch(() => null);
  if (prior?.bind) {
    const kept = Object.entries(prior.bind).filter(([, e]) => e?.source === 'human').length;
    profile.bind = mergeBindings(prior.bind, profile.bind);
    if (kept) console.log(`  kept ${kept} human-confirmed binding(s) from ${priorPath}`);
  }

  const outPath = join(values.out, `${profile.id}.json`);
  await mkdir(values.out, { recursive: true });
  await writeFile(outPath, JSON.stringify(profile, null, 2) + '\n');

  const panelCount = Object.values(profile.panels).reduce((s, p) => s + Object.keys(p).length, 0);
  console.log(`\n  ${outPath}`);
  console.log(`  ${Object.keys(profile.textures).length} paintable textures, ${panelCount} panels, ` +
    `${profile.doNotPaint.length} excluded`);
  console.log(`  Move it to cars/${profile.id}.json and rename panels to taste — liveries`);
  console.log(`  address them by name, so the names are yours to choose.`);
  process.exit(0);
}

// --- explain mode -----------------------------------------------------------
//
// Ranks candidates for a vocabulary term and shows the measurements behind each
// one. It never writes anything: the point is that a human confirms the binding
// once per car, and confirming is a thirty-second job with the evidence printed
// and an unbounded one without it.
if (values.explain) {
  const src = resolve(values.explain);
  const useVisibility = !values['no-visibility'];
  console.log(`Reading ${src}${useVisibility ? '' : '  (visibility skipped)'}\n`);

  const profile = await profileFromKn5(src, {
    id: values['car-id'],
    skinsDir: values.skins ? resolve(values.skins) : null,
    visibility: useVisibility,
    log: () => {},
  });
  const model = await parseKn5(src, { keepTextureData: false });

  // Stock skins are evidence of intent: a file every skin replaces is meant to
  // vary per livery. Absent a skins directory the classifier simply loses that
  // signal, which costs accuracy but breaks nothing.
  const { skinCounts, skinCount } = values.skins
    ? await countSkinOverrides(resolve(values.skins))
        .then((r) => ({ skinCounts: r.counts, skinCount: r.skinCount }))
    : { skinCounts: new Map(), skinCount: 0 };
  if (!skinCount) {
    console.log('  ! No --skins given, so "how many stock skins override this" is unavailable.');
    console.log('    That signal is worth a few points of accuracy; pass --skins for the best ranking.\n');
  }

  // Panel visibility, averaged per texture.
  const visibleByFile = new Map();
  for (const [role, panels] of Object.entries(profile.panels)) {
    const vals = Object.values(panels).map((p) => p.visible).filter((v) => typeof v === 'number');
    if (vals.length) visibleByFile.set(profile.textures[role].file, vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  const features = textureFeatures(model, { roles: profile.textures, skinCounts, skinCount, visibleByFile });
  console.log(explain(features, values.term));
  console.log(`\n  Nothing was written. Record the binding in cars/${profile.id}.json under "bind".`);
  process.exit(0);
}

// --- scan mode --------------------------------------------------------------
if (values.scan) {
  const dir = resolve(values.scan);
  const list = await scanSkins(dir).catch((e) => {
    fail(new Error(
      e.code === 'ENOENT'
        ? `No such directory: ${dir}\n  Point --scan at a car's skins/ folder, or at one skin inside it.`
        : `Could not read ${dir}: ${e.message}`
    ));
  });
  if (!list.length) {
    console.error(`No .dds files found under ${dir}`);
    process.exit(1);
  }
  console.log(formatScan(list));
  process.exit(0);
}

// --- load livery + profile --------------------------------------------------
const liveryArg = positionals[0];
if (!liveryArg) { console.log(USAGE); process.exit(1); }

// Extra packs load BEFORE the livery, since the livery names the packs it wants
// and they have to be registered by then.
for (const p of values.pack) {
  await import(pathToFileURL(resolve(p)).href);
}

const liveryPath = await resolveLivery(liveryArg);
const livery = (await import(pathToFileURL(liveryPath).href)).default;
if (!livery) throw new Error(`${liveryArg} has no default export`);
if (!livery.car) throw new Error(`${liveryArg} does not say which car it is for (missing "car")`);
if (!livery.folder) throw new Error(`${liveryArg} has no "folder" — that is the skin directory name`);

const profilePath = values.profile
  ? resolve(values.profile)
  : join(ROOT, 'cars', `${livery.car}.json`);
const profile = await loadProfile(profilePath);

const folder = values.uvgrid ? `${livery.folder}_uvgrid` : livery.folder;
const outDir = join(values.out, folder);

console.log(`${livery.name}  ->  ${profile.name ?? profile.id}\n`);

// --- build ------------------------------------------------------------------
if (values.uvgrid) {
  const pngDir = join(values.out, `${folder}_png`);
  await buildCalibration({
    profile,
    outDir,
    folder,
    cells: values.cells ? num(values.cells, 'cells', { min: 2, max: 260, integer: true }) : 20,
    probes: values.probe ? values.probe.split(',').map((s) => s.trim()).filter(Boolean) : [],
    font: livery.render?.font ?? 'sans-serif',
    pngDir,
  });
  console.log(`\n  Reference PNGs: ${pngDir}`);
} else {
  const size = values.size ? num(values.size, 'size', { min: 64, max: 8192, integer: true }) : null;
  await buildSkin({
    profile,
    livery,
    outDir,
    scale: size ? size / largestTexture(profile) : 1,
    seed: values.seed,
    flat: values.flat,
    // Never inside outDir: packaging zips whatever it finds there.
    pngDir: values['keep-png'] ? join(values.out, `${folder}_png`) : null,
    liveryDir: dirname(liveryPath),
  });
  if (values['keep-png']) console.log(`\n  Intermediate PNGs: ${join(values.out, `${folder}_png`)}`);

  // A livery that paints something the profile warns against — normal maps,
  // shader maps — recolours nothing and corrupts the model's lighting.
  const banned = new Map(doNotPaint(profile).map((d) => [d.file.toLowerCase(), d.reason]));
  for (const role of Object.keys(livery.paint ?? {})) {
    const f = profile.textures[role]?.file?.toLowerCase();
    if (f && banned.has(f)) {
      console.warn(`  ! ${role} paints ${profile.textures[role].file}, which this profile marks do-not-paint:\n    ${banned.get(f)}`);
    }
  }
}

// --- package ----------------------------------------------------------------
if (!values['no-zip']) {
  await mkdir(values.out, { recursive: true });
  const zipPath = join(values.out, `${folder}.zip`);
  const n = await packSkin({ skinDir: outDir, zipPath, carId: profile.id, folder });
  const kb = (await stat(zipPath)).size / 1024;
  console.log(`\n  ${zipPath}  (${n} files, ${kb.toFixed(0)} KB)`);
  console.log(`  Drag onto Content Manager — the archive carries the full`);
  console.log(`  content/cars/${profile.id}/skins/${folder}/ path, so it installs without asking.`);
} else {
  console.log(`\n  Copy ${outDir} into content/cars/${profile.id}/skins/`);
}

// ---------------------------------------------------------------------------

/**
 * A bare name means a livery in ./liveries/; anything with a separator or an
 * extension is a path.
 *
 * Order matters. Resolving against the CWD first meant an unrelated file or
 * directory named `neon-grid` sitting in the working directory would shadow the
 * shipped livery and fail with a confusing import error.
 */
async function resolveLivery(arg) {
  const looksLikePath = /[\\/]/.test(arg) || arg.endsWith('.mjs') || arg.endsWith('.js');
  const candidates = looksLikePath
    ? [resolve(arg)]
    : [
        join(ROOT, 'liveries', `${arg}.mjs`),
        join(ROOT, 'liveries', `${arg}.local.mjs`),
        join(ROOT, 'liveries', arg),
        resolve(arg),
      ];

  for (const c of candidates) {
    try {
      if ((await stat(c)).isFile()) return c;
    } catch { /* next */ }
  }
  throw new Error(`Livery "${arg}" not found. Tried:\n  ${candidates.join('\n  ')}`);
}

// Declared as a function, not a const arrow: it is called above, and a const
// would be in the temporal dead zone at that point.
function largestTexture(p) {
  return Math.max(...Object.values(p.textures).map((t) => Math.max(t.width, t.height)));
}
