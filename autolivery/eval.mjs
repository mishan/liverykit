#!/usr/bin/env node
/**
 * The critic, measured against what a person said about the same pictures.
 *
 * Every case is a set of renders from a real run, the brief, and a person's
 * verdict on them (see cases.mjs). With the local critic it costs nothing, so a
 * change to the critic's prompt is tried against every past mistake before a
 * paid run discovers a new one. The renders live in autolivery/runs/, which is
 * not committed; a case whose pictures are not on this machine is skipped and
 * said to be.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrace } from './trace.mjs';
import { score } from './cases.mjs';
import { overrule } from './loop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const USAGE = `usage: node autolivery/eval.mjs [options]

  --cases <file>         the cases (default autolivery/critic-cases.json)
  --only <id,id>         just these cases
  --critic-backend <b>   openai (default: the local server, free) or anthropic
  --critic-base-url <u>  default http://127.0.0.1:8081/v1
  --critic-model <id>    default: what the server serves, or claude-opus-5
  --critic-effort <l>    Claude's effort (default medium)
  --max-cost <usd>       with anthropic, stop past this at list price (default 0.5)
`;

const { values } = parseArgs({
  options: {
    cases: { type: 'string', default: join(HERE, 'critic-cases.json') },
    only: { type: 'string' },
    'critic-backend': { type: 'string', default: 'openai' },
    'critic-base-url': { type: 'string', default: 'http://127.0.0.1:8081/v1' },
    'critic-model': { type: 'string' },
    'critic-effort': { type: 'string', default: 'medium' },
    'max-cost': { type: 'string', default: '0.5' },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const set = JSON.parse(await readFile(resolve(values.cases), 'utf8'));
const wanted = values.only ? new Set(values.only.split(',').map((s) => s.trim())) : null;
const cases = set.cases.filter((c) => !wanted || wanted.has(c.id));

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const trace = await createTrace({ dir: join(HERE, 'runs', `eval-${stamp}`), name: 'autolivery-eval', tags: ['eval'] });

let critic;
let model;
const backend = values['critic-backend'];
if (backend === 'anthropic') {
  const claude = await import('./claude.mjs');
  const client = await claude.createClient();
  model = values['critic-model'] ?? 'claude-opus-5';
  critic = claude.createCritic({ client, model, effort: values['critic-effort'], trace,
    budget: { max: Number(values['max-cost']), spent: 0 } });
} else if (backend === 'openai') {
  const local = await import('./openai.mjs');
  const endpoint = await local.connectEndpoint({ baseUrl: values['critic-base-url'],
    apiKey: process.env.AUTOLIVERY_OPENAI_KEY || null });
  model = values['critic-model'] ?? endpoint.models[0];
  critic = local.createCritic({ endpoint, model, trace });
} else {
  console.error(`--critic-backend must be openai or anthropic, not ${JSON.stringify(backend)}`);
  process.exit(2);
}

let agreed = 0;
let disagreed = 0;
let skipped = 0;
for (const c of cases) {
  const images = [];
  let absent = null;
  for (const im of c.images) {
    try {
      images.push({ view: im.view, data: (await readFile(resolve(ROOT, im.path))).toString('base64') });
    } catch {
      absent = im.path;
      break;
    }
  }
  if (absent) {
    skipped++;
    console.log(`- ${c.id}: skipped, ${absent} is not on this machine`);
    continue;
  }
  let v;
  try {
    // A case that carries what the renderer counted is judged as the gate
    // judges it: the critic is told the count, and a "cut off" the count
    // contradicts is overruled before the verdict is scored.
    v = await critic.judge({
      brief: c.brief ?? set.brief, summary: c.summary ?? '', images, parent: null,
      ...(c.recheck ? { recheck: c.recheck, name: 'referee' } : {}),
      measured: c.measured ?? null,
    });
    if (c.measured) v = overrule(v, new Set(c.measured.filter((m) => m.whole).map((m) => m.id)));
  } catch (e) {
    v = { error: e.message };
  }
  const fails = score(v, c.expect);
  const overruled = v?.overruled?.length ? ` (${v.overruled.length} "cut off" overruled by the count)` : '';
  if (fails.length) {
    disagreed++;
    console.log(`✗ ${c.id}: ${fails.join('; ')}${overruled}`);
  } else {
    agreed++;
    console.log(`✓ ${c.id}${overruled}`);
  }
}

const s = await trace.finish({ ok: disagreed === 0 });
console.log(`\n${agreed} agreed with a person, ${disagreed} did not, ${skipped} skipped · ` +
  `critic ${model} (${backend})${s?.cost ? ` · $${s.cost.toFixed(2)} at list price` : ''}`);
process.exit(disagreed ? 1 : 0);
