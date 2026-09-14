// ---------------------------------------------------------------------------
// Point one design at many cars and record what it would do on each.
//
// docs/backlog.md opens with a sweep of this kind: neon-grid-any against 25
// cars nobody had profiled, and a table of what went wrong. It was done by
// hand, so its numbers could be quoted and never re-run, and every fix in
// docs/portability-plan.md is supposed to move one of them. This is that sweep
// as a script: the same questions, asked the same way each time.
//
// Nothing is built or rendered. It asks `portability()`, which asks the
// resolver and the region expander the build itself uses, so a region reported
// matched here is one the build would paint.
//
//   node tools/sweep.mjs <livery> [--cars <carsDir>] [--every N] [--all]
//                        [--profiles <dir> | --no-profiles] [--no-visibility]
//                        [--out sweep.json] [--fresh] [--limit N] [--summary]
//                        [carId ...]
//
// Two kinds of car. With --cars, each sampled car is profiled from its model
// from scratch — no prior profile, no aliases, no hand-work — as a stranger's
// car would be. And the profiles in --profiles, the repository's cars/ unless
// told otherwise, are swept as they stand, human bindings and all, which needs
// no model on the machine and so says something on any checkout.
//
// The default sample is the backlog's: every eleventh car in the install,
// sorted, plus the cars this repository ships profiles for. Resumes by default;
// --summary reprints the table from --out without sweeping anything.
// ---------------------------------------------------------------------------

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { loadProfile, resolveTargets, nearMiss } from '../src/profile.mjs';
import { portability } from '../src/portability.mjs';
import { loadLivery, resolveLivery } from '../src/livery.mjs';
import { bestKn5, carIds, everyNth, summarise } from './fleet.mjs';

const REPO_CARS = fileURLToPath(new URL('../cars/', import.meta.url));

// --- argument handling ------------------------------------------------------

const argv = process.argv.slice(2);
const VALUED = new Set(['--cars', '--every', '--profiles', '--out', '--limit']);
// A valued flag with nothing after it used to fall back to its default, so
// `--out` at the end of a line wrote to sweep.json and `--limit` there swept
// everything.
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${name} wants a value`);
  return argv[i + 1];
};
const bare = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const [liveryArg, ...explicit] = bare;
if (!liveryArg) {
  console.error('usage: node tools/sweep.mjs <livery> [--cars <carsDir>] [--every N] [--all] ' +
    '[--profiles <dir> | --no-profiles] [--out sweep.json] [--fresh] [--summary] [carId ...]');
  process.exit(2);
}

const outPath = flag('--out', 'sweep.json');
const carsDir = flag('--cars', null);
const every = Number(flag('--every', '11'));
const limit = Number(flag('--limit', 'Infinity'));
const profilesDir = argv.includes('--no-profiles') ? null : flag('--profiles', REPO_CARS);
const visibility = !argv.includes('--no-visibility');

if (!Number.isInteger(every) || every < 1) throw new Error(`--every wants a whole number, 1 or more; got ${flag('--every')}`);
// `nope` read as no limit at all, and -1 as "all but the last" by way of slice.
if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) {
  throw new Error(`--limit wants a whole number, 1 or more; got ${flag('--limit')}`);
}
// Named rather than ignored: ids with nowhere to find their models would
// sweep nothing and report a clean run of zero cars.
if (explicit.length && !carsDir) throw new Error(`car ids (${explicit.join(', ')}) need --cars to say where their models are`);

const { path: liveryPath, dir: liveryDir } = await resolveLivery(liveryArg);
const liveryName = basename(liveryDir ?? liveryPath).replace(/\.(mjs|json)$/, '');
const design = await loadLivery(liveryPath);

// Resume, unless the file is something else. A sweep of another design mixed
// into this one's table would be a wrong number that looks like a right one.
//
// A file that is not there is a first run when sweeping, and a mistake when
// summarising: --summary on a mistyped --out used to print an empty table and
// exit 0, which reads as a sweep of no cars.
const summaryOnly = argv.includes('--summary');
if (summaryOnly && argv.includes('--fresh')) throw new Error('--summary reads --out, and --fresh would discard it; pass one or the other');
let records = [];
if (!argv.includes('--fresh')) {
  try {
    records = JSON.parse(await readFile(outPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${outPath} is not a sweep this can resume (${e.message}); pass --fresh to start over`);
    if (summaryOnly) throw new Error(`there is no sweep at ${outPath} to summarise; pass the --out the sweep wrote`);
  }
  if (!Array.isArray(records)) throw new Error(`${outPath} is not a sweep this can resume (not a list of records); pass --fresh to start over`);
  if (summaryOnly && !records.length) throw new Error(`${outPath} holds no sweep records, so there is nothing to summarise`);
  const other = records.find((r) => r.livery !== liveryName);
  if (other) throw new Error(`${outPath} holds a sweep of "${other.livery}", not "${liveryName}"; pass --fresh or another --out`);
}

function printSummary() {
  const groups = [
    ['kn5', 'profiled from the model, no hand-work'],
    ['profile', 'shipped profiles, as they stand'],
  ];
  for (const [from, label] of groups) {
    const group = records.filter((r) => r.from === from);
    if (!group.length) continue;
    console.log(`\n${liveryName} on ${label}:`);
    for (const line of summarise(group)) console.log(`  ${line}`);
  }
}

if (argv.includes('--summary')) {
  printSummary();
  process.exit(0);
}

// --- what to sweep ----------------------------------------------------------

const plan = [];
if (profilesDir) {
  for (const f of (await readdir(profilesDir)).filter((f) => f.endsWith('.json')).sort()) {
    plan.push({ key: `profile:${f}`, from: 'profile', id: f.slice(0, -5), path: join(profilesDir, f) });
  }
}
if (carsDir) {
  const all = await carIds(carsDir);
  let ids;
  if (explicit.length) ids = explicit;
  else if (argv.includes('--all')) ids = all;
  else {
    const shipped = (await readdir(REPO_CARS)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    ids = [...new Set([...everyNth(all, every), ...shipped.filter((id) => all.includes(id))])].sort();
  }
  for (const id of ids) plan.push({ key: `kn5:${id}`, from: 'kn5', id });
}

const done = new Set(records.map((r) => r.key));
const todo = plan.filter((p) => !done.has(p.key)).slice(0, limit);
console.log(`${plan.length} planned, ${done.size} already done, ${todo.length} this pass`);

// --- the sweep --------------------------------------------------------------

/** What the design would do on this profile, reduced to statuses and counts. */
function sweepOne(profile) {
  const report = portability(design, profile);

  const bindings = {};
  for (const [term, entry] of Object.entries(profile.bind ?? {})) {
    const roles = Array.isArray(entry?.roles) ? entry.roles : [];
    bindings[term] = {
      roles,
      source: entry?.source ?? null,
      ...(entry?.confidence !== undefined ? { confidence: entry.confidence } : {}),
      // The primary texture's panel count. Zero is the backlog's McLaren: a
      // body bound to a sheet nothing is mapped onto.
      panels: roles.length ? Object.keys(profile.panels?.[roles[0]] ?? {}).length : 0,
    };
  }

  const regions = report.regions.map((g) => ({
    id: g.id,
    from: g.from,
    role: g.role,
    kind: g.kind,
    ...(g.tags ? { tags: g.tags } : {}),
    status: g.status,
    panels: g.panels.length,
    ...(g.status === 'missing' && g.kind === 'tags' ? { nearMiss: nearMiss(profile, g.role, g.tags) } : {}),
  }));

  return {
    textures: Object.keys(profile.textures ?? {}).length,
    panels: Object.values(profile.panels ?? {}).reduce((s, ps) => s + Object.keys(ps).length, 0),
    bindings,
    surfaces: report.surfaces,
    regions,
    notes: report.fatal ? [] : resolveTargets(profile, design).notes.map(({ term, status }) => ({ term, status })),
    ...(report.fatal ? { fatal: report.fatal } : {}),
  };
}

for (const item of todo) {
  const t0 = Date.now();
  let record;
  try {
    if (item.from === 'profile') {
      const profile = await loadProfile(item.path);
      record = { key: item.key, id: profile.id, from: 'profile', source: basename(item.path), ...sweepOne(profile) };
    } else {
      const kn5 = await bestKn5(join(carsDir, item.id));
      if (!kn5) throw new Error('no kn5');
      const profile = await profileFromKn5(kn5, { id: item.id, skinsDir: join(carsDir, item.id, 'skins'), visibility });
      record = { key: item.key, id: item.id, from: 'kn5', source: basename(kn5), visibility, ...sweepOne(profile) };
    }
  } catch (e) {
    // Recorded, not skipped: a car the sweep could not read is part of what the
    // sweep found, and a table over the cars that happened to work would be a
    // table over a different sample.
    record = { key: item.key, id: item.id, from: item.from, error: e instanceof Error ? e.message : String(e) };
  }
  record.livery = liveryName;
  record.ms = Date.now() - t0;
  records.push(record);

  if (record.error) {
    console.log(`  ${record.id.padEnd(40)} FAILED: ${record.error}`);
  } else {
    const missed = record.regions.filter((g) => g.status === 'missing').length;
    const body = record.bindings.body;
    console.log(`  ${record.id.padEnd(40)} ${record.panels} panels, ${missed} region(s) missing, ` +
      `body ${body ? `${body.roles.join('+') || '(none)'} ${body.source}${body.confidence !== undefined ? ` ${body.confidence}` : ''}` : 'unbound'}`);
  }
  await writeFile(outPath, JSON.stringify(records, null, 2));   // checkpoint every car
}

printSummary();
