// ---------------------------------------------------------------------------
// What the fleet tools share: finding a car's model, and choosing which cars.
//
// survey.mjs and sweep.mjs both walk a folder of installed cars. The rule for
// which kn5 in a car folder is the one a skin is authored against lived in the
// survey alone, and the hand sweep that came before sweep.mjs used a rule of
// its own, which threw away a car whose only model is `<id>_LODA.kn5`. Two
// rules for one question give two fleets, so there is one, here.
// ---------------------------------------------------------------------------

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The highest-detail model in a car folder.
 *
 * collider.kn5 is a physics hull with no textures worth reading, and LOD B/C/D
 * are decimated copies whose UV islands are NOT the ones a skin is authored
 * against. Some cars call the full model `<id>.kn5` and others `<id>_lod_a.kn5`,
 * so both spellings have to be accepted.
 */
export async function bestKn5(dir) {
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

/**
 * Every car folder, sorted. `readdir` returns the filesystem's order, so without
 * the sort "every eleventh car" would name different cars on two machines with
 * the same install.
 */
export async function carIds(carsDir) {
  const entries = await readdir(carsDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** Every nth id, starting with the first. */
export function everyNth(ids, n) {
  return ids.filter((_, i) => i % n === 0);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const listIds = (xs, max = 6) =>
  xs.slice(0, max).join(', ') + (xs.length > max ? `, and ${xs.length - max} more` : '');

/**
 * What emptied a tag selection on one car, as the summary counts it. A tie is
 * named as a tie: crediting the first tag in list order is how a car where
 * `mid` and `visible` did equally well was counted against `mid`. A texture
 * with no panels is named as that, since every count is zero there and
 * blaming "two or more tags" sent somebody to the tagger for a binding fault.
 */
const blockedBy = (near) =>
  near?.panels === 0 ? 'a texture with no panels'
    : near?.tied?.length ? `${near.tied.join(' or ')} (tied)`
    : near?.blocking ?? 'two or more tags';

/**
 * The backlog's table, recomputed from sweep records.
 *
 * Returns lines rather than printing, so a test can read them. Each figure is
 * one the backlog quoted by hand, in the same terms, so a before-and-after pair
 * of sweeps reads as a diff of that table. A car counts as missing a tag rule
 * only when the rule matched on none of the textures its surface binds, which
 * is what "landed nowhere" means to someone looking at the car.
 */
export function summarise(records) {
  const ok = records.filter((r) => !r.error);
  const failed = records.filter((r) => r.error);
  const n = ok.length;
  const lines = [`${n} car(s) swept` +
    (failed.length ? `; ${failed.length} failed: ${failed.map((r) => `${r.id} (${r.error})`).join('; ')}` : '')];
  if (!n) return lines;
  const fatal = ok.filter((r) => r.fatal);
  if (fatal.length) lines.push(`could not resolve at all on ${fatal.length}: ${fatal.map((r) => `${r.id} (${r.fatal})`).join('; ')}`);

  // The body binding, split the way the backlog split it. Confidence is the
  // margin over the runner-up, so "a guess" is a close call, not a low chance.
  const withBody = ok.filter((r) => r.bindings?.body?.roles?.length);
  const human = withBody.filter((r) => r.bindings.body.source === 'human');
  const auto = withBody.filter((r) => r.bindings.body.source === 'auto');
  const conf = (r) => r.bindings.body.confidence ?? 0;
  const guesses = auto.filter((r) => conf(r) < 0.2);
  lines.push(`body bound on ${withBody.length} of ${n}` +
    (human.length ? `, ${human.length} by a person` : '') +
    (auto.length ? `; of ${auto.length} proposed, ${auto.filter((r) => conf(r) >= 0.7).length} confident (>= 0.7), ` +
      `${auto.filter((r) => conf(r) >= 0.2 && conf(r) < 0.7).length} shaky, ${guesses.length} a guess (< 0.2)` +
      (guesses.length ? `: ${guesses.map((r) => `${r.id} ${conf(r)}`).join(', ')}` : '') : ''));
  const empty = withBody.filter((r) => r.bindings.body.panels === 0);
  lines.push(`body bound to a texture with no panels: ${empty.length}` +
    (empty.length ? ` (${listIds(empty.map((r) => r.id))})` : ''));

  // Tag rules. Grouped by surface and tag set, because several regions share
  // one selection — the piping and the number both ask for [left, visible].
  const rules = new Map();
  for (const r of ok) {
    const mine = new Map();
    for (const g of r.regions ?? []) {
      if (g.kind !== 'tags') continue;
      const key = `${g.from} [${g.tags.join(', ')}]`;
      const seen = mine.get(key) ?? { matched: false, blocking: new Set() };
      if (g.status === 'matched') seen.matched = true;
      else seen.blocking.add(blockedBy(g.nearMiss));
      mine.set(key, seen);
    }
    for (const [key, seen] of mine) {
      const rule = rules.get(key) ?? { cars: 0, missed: [], blocking: new Map() };
      rule.cars++;
      if (!seen.matched) {
        rule.missed.push(r.id);
        for (const b of seen.blocking) rule.blocking.set(b, (rule.blocking.get(b) ?? 0) + 1);
      }
      rules.set(key, rule);
    }
  }
  for (const [key, rule] of [...rules].sort(([a], [b]) => a.localeCompare(b))) {
    if (!rule.missed.length) { lines.push(`${key} matched on all ${rule.cars}`); continue; }
    const why = [...rule.blocking].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} ${c}`).join(', ');
    lines.push(`${key} matched nothing on ${rule.missed.length} of ${rule.cars} — blocked by ${why}`);
  }

  // Surfaces the design paints, found bound on arrival.
  const present = ok.map((r) => new Set((r.surfaces ?? []).filter((s) => s.status === 'present').map((s) => s.from)).size);
  const wanted = Math.max(...ok.map((r) => new Set((r.surfaces ?? []).map((s) => s.from)).size));
  lines.push(`surfaces the design paints that were bound: ${Math.min(...present)} to ${Math.max(...present)} ` +
    `of ${wanted}, mean ${mean(present).toFixed(1)}`);

  // What the classifier proposed, per term.
  const terms = new Map();
  for (const r of ok) {
    for (const [term, b] of Object.entries(r.bindings ?? {})) {
      if (b.source !== 'auto' || !b.roles?.length) continue;
      terms.set(term, [...(terms.get(term) ?? []), b.confidence ?? 0]);
    }
  }
  for (const [term, cs] of [...terms].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`proposed ${term} on ${cs.length} of ${n}, mean confidence ${mean(cs).toFixed(2)}`);
  }

  // The tiled-material cars were found as the ones with almost no panels. Until
  // the profile says `uvLayout`, this is still how to find them.
  const fewest = [...ok].sort((a, b) => a.panels - b.panels).slice(0, 3);
  lines.push(`fewest panels: ${fewest.map((r) => `${r.id} ${r.panels} from ${r.textures} textures`).join('; ')}`);
  return lines;
}
