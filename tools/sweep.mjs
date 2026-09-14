// ---------------------------------------------------------------------------
// Point one design at many cars and record what it would do on each.
//
// docs/backlog.md opens with a sweep of this kind: neon-grid-any against 26
// cars nobody had profiled, and a table of what went wrong. It was first done
// by hand, over 25 of them, so its numbers could be quoted and never re-run,
// and every fix in docs/portability-plan.md is supposed to move one of them.
// This is that sweep as a script: the same questions, asked the same way each
// time.
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
import { createHash } from 'node:crypto';
import { join, basename, resolve } from 'node:path';
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

// What a record's answer depends on besides the car, so a resume can tell a
// record this run would have written from one it would not. The key is the
// car and the design's name, and until this was recorded, other profiles,
// visibility turned off or the design edited all reused old records without
// a word. The design is hashed as loaded rather than as a file, since an .mjs
// can import what it places, and an edited comment changes nothing swept.
const designHash = createHash('sha256').update(JSON.stringify(design)).digest('hex').slice(0, 16);
const sweptWith = {
  kn5: { design: designHash, cars: carsDir && resolve(carsDir), visibility },
  profile: { design: designHash, profiles: profilesDir && resolve(profilesDir) },
};

/** How a record was swept differently from how this run would sweep it. */
function sweptOtherwise(was, now) {
  if (!was) return ['before the sweep recorded how it swept'];
  const why = [];
  if (was.design !== now.design) why.push('from a different version of the design');
  if ('cars' in now && was.cars !== now.cars) why.push(`with --cars ${was.cars}, not ${now.cars}`);
  if ('profiles' in now && was.profiles !== now.profiles) why.push(`with --profiles ${was.profiles}, not ${now.profiles}`);
  if ('visibility' in now && was.visibility !== now.visibility) {
    why.push(`with visibility ${was.visibility ? 'on' : 'off'}, not ${now.visibility ? 'on' : 'off'}`);
  }
  return why;
}

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

  // Refused, not re-swept. Quietly re-running the cars that differ would turn
  // a resume into a different sweep, and overwrite the numbers somebody may be
  // comparing against — a before-and-after pair is the point of the file. So
  // the person decides. Only the kinds of car this run sweeps are checked: a
  // run without --cars leaves the model records as they were, and says so in
  // their own group of the table.
  const sweeping = new Set([...(profilesDir ? ['profile'] : []), ...(carsDir ? ['kn5'] : [])]);
  const otherwise = new Map();
  for (const r of records) {
    if (summaryOnly ? !r.sweptWith || r.sweptWith.design === designHash : !sweeping.has(r.from)) continue;
    const why = summaryOnly ? ['from a different version of the design'] : sweptOtherwise(r.sweptWith, sweptWith[r.from]);
    for (const w of why) otherwise.set(w, (otherwise.get(w) ?? 0) + 1);
  }
  // A summary reads what is there, whatever the options, but not in silence
  // when the design has moved on since.
  if (summaryOnly) {
    for (const [w, n] of otherwise) console.log(`! ${n} record(s) were swept ${w} than ${liveryPath} holds now`);
  } else if (otherwise.size) {
    throw new Error(`${outPath} holds records this run would not have written: ` +
      [...otherwise].map(([w, n]) => `${n} of them ${w}`).join('; ') +
      '. Pass --fresh to sweep again from scratch, or another --out.');
  }
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

// A car that failed is tried again. It used to count as done, so the only way
// to retry it was --fresh, which throws away every car that worked.
const done = new Set(records.filter((r) => !r.error).map((r) => r.key));
const failed = new Set(records.filter((r) => r.error).map((r) => r.key));
const todo = plan.filter((p) => !done.has(p.key)).slice(0, limit);
const retrying = todo.filter((p) => failed.has(p.key)).length;
console.log(`${plan.length} planned, ${done.size} already done, ${todo.length} this pass` +
  (retrying ? ` (${retrying} failed last time)` : ''));

// --- the sweep --------------------------------------------------------------

const LAYOUTS = ['unwrapped', 'mixed', 'tiled'];

/**
 * Every bound texture's `uvLayout`, and the worst of them as `uvLayout`, which
 * the summary reads. Worst, because a region placed on any tiled texture of a
 * body is refused, so a body with one is on a tiled material in the sense that
 * matters. Reading the first role alone said nothing of a tiled second.
 */
function layouts(profile, roles) {
  const each = Object.fromEntries(roles.filter((r) => profile.textures?.[r]?.uvLayout)
    .map((r) => [r, profile.textures[r].uvLayout]));
  const worst = Object.values(each).sort((a, b) => LAYOUTS.indexOf(b) - LAYOUTS.indexOf(a))[0];
  return worst ? { uvLayout: worst, uvLayouts: each } : {};
}

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
      // Every bound texture's panels, summed. Zero is the backlog's McLaren: a
      // body bound to sheets nothing is mapped onto. Counting only the first
      // said 10 for a body whose other texture carries 44.
      panels: roles.reduce((s, role) => s + Object.keys(profile.panels?.[role] ?? {}).length, 0),
      ...layouts(profile, roles),
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
  record.sweptWith = sweptWith[item.from];
  record.ms = Date.now() - t0;
  records = records.filter((r) => r.key !== record.key);
  records.push(record);

  if (record.error) {
    console.log(`  ${record.id.padEnd(40)} FAILED: ${record.error}`);
  } else {
    // Every region the build would not paint: a selection that found nothing,
    // and one refused on a tiled texture. Counting only the first, the mp412c,
    // whose regions were all refused, read "0 region(s) missing".
    const missed = record.regions.filter((g) => g.status === 'missing' || g.status === 'unplaceable').length;
    const body = record.bindings.body;
    console.log(`  ${record.id.padEnd(40)} ${record.panels} panels, ${missed} region(s) not placed, ` +
      `body ${body ? `${body.roles.join('+') || '(none)'} ${body.source}${body.confidence !== undefined ? ` ${body.confidence}` : ''}` : 'unbound'}`);
  }
  await writeFile(outPath, JSON.stringify(records, null, 2));   // checkpoint every car
}

printSummary();
