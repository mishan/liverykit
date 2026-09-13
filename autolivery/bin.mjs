#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './mcp.mjs';
import { createTrace } from './trace.mjs';
import { run } from './loop.mjs';
import { loadRecording, createReplayPlanner } from './replay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVERYKIT = resolve(HERE, '../bin/liverykit.mjs');

const USAGE = `autolivery — give it a brief; it designs a livery, fits it to the car's real
model, and revises until the fitment check and a critic both pass. The result
goes to the editor's inbox, where a person accepts or discards it.

  node autolivery/bin.mjs "<brief>" [options]

It attaches to a running editor through liverykit's MCP server, so start one:

  node bin/liverykit.mjs autolivery-nsx --ui

The loop:
  --editor <url>         the editor (default http://127.0.0.1:7391/)
  --rounds <n>           most rounds before giving up (default 6)
  --advisory-critic      log the critic's verdict, gate on fitment alone
  --views <a,b>          what the critic looks at (default sheet: six views in one picture)
  --looks <n>            planner renders per round before render_car says no (default 2)
  --no-seed              let the planner fetch the car's description itself, rather
                         than starting with it in its first message
  --replay <run dir>     no planner: put back what that run drafted, round by
                         round, and judge it with today's gate. The brief comes
                         from the run, the critic and second look default to the
                         local server, and nothing is proposed: free, by default
  --out <dir>            renders, trace and result.json (default autolivery/runs/<time>)
  --no-propose           keep the passing design out of the editor's inbox

The models:
  --backend <b>          anthropic (default), or openai for any OpenAI-compatible
                         server: llama.cpp's llama-server, Ollama, vLLM
  --base-url <url>       where that server is (default http://127.0.0.1:8080/v1)
  --model <id>           the planner (default claude-opus-5, or what the server serves)
  --critic-backend <b>   default: the planner's
  --critic-base-url <u>  default: the planner's
  --critic-model <id>    default: the planner's, when the backend is the same
  --effort <level>       Claude's effort: low, medium, high, xhigh, max (default medium,
                         which planned a round in half the time high did)
  --critic-effort <l>    the critic's (default medium)
  --critic-max-tokens <n>  an OpenAI-compatible critic's output limit (default 8192:
                         a model that thinks first needs room before its verdict)
  --referee <who>        a closer second look when fitment passes and the critic
                         does not: anthropic (the default when a key is set),
                         critic (the critic again, shown closer views), or none
  --no-fallback          do not retry a declined Claude request on another model
  --max-cost <usd>       stop before any Claude call once the run has spent this
                         much at list price (default 5; may overshoot by one call)
  --full-history         keep a local planner's whole conversation across rounds,
                         instead of starting each round from where things stand
  --sampling <json>      sampling for an OpenAI-compatible server, passed through,
                         e.g. '{"temperature":0.7,"top_p":0.8,"top_k":20}'

Environment:
  ANTHROPIC_API_KEY      for --backend anthropic
  AUTOLIVERY_OPENAI_KEY  a bearer token for an OpenAI-compatible server that wants one
  AGENTOPS_API_KEY       optional; the trace also goes to AgentOps
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    editor: { type: 'string', default: 'http://127.0.0.1:7391/' },
    rounds: { type: 'string', default: '6' },
    backend: { type: 'string', default: 'anthropic' },
    'base-url': { type: 'string', default: 'http://127.0.0.1:8080/v1' },
    model: { type: 'string' },
    'critic-backend': { type: 'string' },
    'critic-base-url': { type: 'string' },
    'critic-model': { type: 'string' },
    effort: { type: 'string', default: 'medium' },
    'critic-effort': { type: 'string', default: 'medium' },
    'critic-max-tokens': { type: 'string', default: '8192' },
    referee: { type: 'string' },
    replay: { type: 'string' },
    'advisory-critic': { type: 'boolean', default: false },
    views: { type: 'string', default: 'sheet' },
    looks: { type: 'string', default: '2' },
    'no-seed': { type: 'boolean', default: false },
    out: { type: 'string' },
    'no-propose': { type: 'boolean', default: false },
    'no-fallback': { type: 'boolean', default: false },
    'max-cost': { type: 'string', default: '5' },
    sampling: { type: 'string' },
    'full-history': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || (!positionals.length && !values.replay)) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 1);
}

const fail = (m) => {
  console.error(`autolivery: ${m}`);
  process.exit(1);
};
const log = (m) => console.log(m);

// A replay brings its own brief and its own number of rounds: it is the same
// designs, asked of today's gate.
let recording = null;
if (values.replay) {
  try {
    recording = await loadRecording(resolve(values.replay));
  } catch (e) {
    fail(`--replay: ${e.message}`);
  }
}
const replaying = Boolean(recording);
const brief = positionals.join(' ') || recording?.brief || '';
const rounds = replaying ? recording.rounds.length : Number(values.rounds);
if (!Number.isInteger(rounds) || rounds < 1) fail(`--rounds must be a whole number above zero, not ${values.rounds}`);
const looks = Number(values.looks);
if (!Number.isInteger(looks) || looks < 0) fail(`--looks must be a whole number, not ${values.looks}`);
// Refused rather than run. `--views ,` split to nothing, so nothing was
// rendered, the critic was never asked, and no round could pass a gate that
// needs its verdict.
const views = values.views.split(',').map((v) => v.trim()).filter(Boolean);
if (!views.length) fail(`--views names no view (${JSON.stringify(values.views)}): give one or more, e.g. sheet or left,right`);
const criticMaxTokens = Number(values['critic-max-tokens']);
if (!Number.isInteger(criticMaxTokens) || criticMaxTokens < 1) {
  fail(`--critic-max-tokens must be a whole number above zero, not ${values['critic-max-tokens']}`);
}
const maxCost = Number(values['max-cost']);
if (!(maxCost > 0)) fail(`--max-cost must be a positive number of dollars, not ${values['max-cost']}`);
// One budget for the whole run, planner and critic together.
const budget = { max: maxCost, spent: 0 };
let sampling = {};
if (values.sampling) {
  try {
    sampling = JSON.parse(values.sampling);
  } catch (e) {
    fail(`--sampling must be a JSON object, e.g. '{"temperature":0.7}': ${e.message}`);
  }
}

// A replay's point is to cost nothing, so its critic is the local one unless
// told otherwise.
const criticBackend = values['critic-backend'] ?? (replaying ? 'openai' : values.backend);
const sides = {
  planner: { backend: values.backend, baseUrl: values['base-url'], model: values.model, effort: values.effort },
  critic: {
    backend: criticBackend,
    baseUrl: values['critic-base-url'] ?? values['base-url'],
    model: values['critic-model'] ?? (criticBackend === values.backend ? values.model : undefined),
    effort: values['critic-effort'],
  },
};
for (const [role, s] of Object.entries(sides)) {
  if (s.backend !== 'anthropic' && s.backend !== 'openai') {
    fail(`the ${role}'s backend must be anthropic or openai, not ${JSON.stringify(s.backend)}`);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = resolve(values.out ?? join(HERE, 'runs', stamp));
const trace = await createTrace({
  dir: out,
  name: 'autolivery',
  tags: ['autolivery', values.backend],
  log,
  agentopsKey: process.env.AGENTOPS_API_KEY || null,
});

// Everything that can be asked before the loop starts, is. A missing key, a
// misspelt model id or a model server that is not up otherwise surfaces a
// round in, after the editor has been attached and the trace begun — on
// stage, the worst moment to learn it.
let anthropic = null;
const endpoints = new Map();
const build = async (role, s) => {
  if (s.backend === 'anthropic') {
    const claude = await import('./claude.mjs');
    if (!anthropic) {
      try {
        anthropic = await claude.createClient();
      } catch (e) {
        if (e.code === 'ERR_MODULE_NOT_FOUND') fail('its dependencies are not installed. Run: (cd autolivery && npm install)');
        fail(`no Anthropic credentials: ${e.message}`);
      }
    }
    const model = s.model ?? 'claude-opus-5';
    try {
      await anthropic.models.retrieve(model);   // costs no tokens
    } catch (e) {
      fail(`the Anthropic API would not serve ${model}: ${e.message}`);
    }
    const opts = { client: anthropic, model, effort: s.effort, trace, fallback: !values['no-fallback'], budget };
    return { model, made: role === 'planner' ? claude.createPlanner(opts) : claude.createCritic(opts) };
  }

  const local = await import('./openai.mjs');
  let endpoint = endpoints.get(s.baseUrl);
  if (!endpoint) {
    try {
      endpoint = await local.connectEndpoint({ baseUrl: s.baseUrl, apiKey: process.env.AUTOLIVERY_OPENAI_KEY || null });
    } catch (e) {
      fail(e.message);
    }
    endpoints.set(s.baseUrl, endpoint);
    if (endpoint.context !== null && endpoint.context < 32768) {
      log(`  ! ${endpoint.url} gives each request ${endpoint.context} tokens of context, and a run ` +
        'needs about 32k. Restart it with a larger -c, or fewer parallel slots (-np).');
    }
  }
  const model = s.model ?? endpoint.models[0];
  if (!model) fail(`${endpoint.url} lists no models`);
  if (role === 'critic' && endpoint.vision === false) {
    fail(`the critic judges renders, and ${endpoint.url} serves a model that takes no images. Load a ` +
      'vision model with its --mmproj, or pass --critic-backend anthropic.');
  }
  if (role === 'planner' && endpoint.vision === false) {
    log(`  (${model} takes no images: the planner works from the critic's notes, not the renders)`);
  }
  const opts = { endpoint, model, trace, sampling, fresh: !values['full-history'] };
  return { model, made: role === 'planner' ? local.createPlanner(opts) : local.createCritic({ ...opts, maxTokens: criticMaxTokens }) };
};
const planner = replaying
  ? { model: `replay of ${relative(process.cwd(), recording.dir) || recording.dir}` +
      (recording.perRound ? '' : ' (final draft only: recorded before rounds were kept)'),
    made: createReplayPlanner(recording) }
  : await build('planner', sides.planner);
const critic = await build('critic', sides.critic);
// The second look: Claude beside a local critic, when there is a key. It is
// asked only of a round that measured clean and failed on the critic's word
// alone, which is where a local model's false alarms cost a round each.
const refereeMode = values.referee
  ?? (replaying ? 'critic'
    : process.env.ANTHROPIC_API_KEY || sides.planner.backend === 'anthropic' ? 'anthropic' : 'critic');
if (!['anthropic', 'critic', 'none'].includes(refereeMode)) {
  fail(`--referee must be anthropic, critic or none, not ${JSON.stringify(refereeMode)}`);
}
const referee = refereeMode === 'anthropic' && sides.critic.backend !== 'anthropic'
  ? await build('critic', {
    backend: 'anthropic',
    model: sides.planner.backend === 'anthropic' ? sides.planner.model : undefined,
    effort: values['critic-effort'],
  })
  : null;

let mcp;
try {
  mcp = await connect({ args: [LIVERYKIT, '--mcp', '--editor', values.editor] });
} catch (e) {
  fail(e.message);
}

console.log(`brief: ${brief}`);
// A replay's planner is no model at all, and its run pays for nothing unless
// the critic or second look is Claude: say so, rather than print a budget.
console.log(`planner: ${planner.model}${replaying ? '' : ` (${sides.planner.backend})`} · ` +
  `critic: ${critic.model} (${sides.critic.backend})` +
  (referee ? ` · second look: ${referee.model} (anthropic)` : refereeMode === 'none' ? ' · no second look' : '') +
  ((!replaying && sides.planner.backend === 'anthropic') || sides.critic.backend === 'anthropic' || referee
    ? ` · budget $${maxCost.toFixed(2)}` : ' · no paid calls') + '\n');
let result;
try {
  result = await run({
    brief,
    mcp,
    out,
    trace,
    rounds,
    log,
    views,
    criticGates: !values['advisory-critic'],
    looks,
    // A replay is a test of the gate, not a design for the inbox.
    propose: !values['no-propose'] && !replaying,
    planner: planner.made,
    critic: critic.made,
    referee: referee?.made ?? null,
    closer: refereeMode === 'none' ? [] : undefined,
    seed: !values['no-seed'],
  });
} catch (e) {
  await trace.finish({ ok: false, attrs: { error: e.message } });
  mcp.close();
  fail(e.message);
}

// Success is a design in front of a person, and the trace says what the exit
// code says. It said passed for a pass the editor refused to take, which
// delivered nothing.
const delivered = result.passed && Boolean(result.proposalId || values['no-propose']);
const s = await trace.finish({ ok: delivered, attrs: { rounds: result.rounds, passed: result.passed } });
mcp.close();

const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const selfHosted = sides.planner.backend === 'openai' || sides.critic.backend === 'openai';
console.log('');
console.log(result.passed
  ? `passed in round ${result.passedIn} of ${rounds}`
  : `did not pass in ${result.rounds} round(s): ` +
    `${result.stopped ?? result.history.at(-1)?.failures?.[0] ?? 'the critic did not pass it'}`);
console.log(`model calls: ${s.llmCalls} · tokens ${k(s.tokensIn)} in / ${k(s.tokensOut)} out · ` +
  `$${s.cost.toFixed(2)} at list price` +
  (s.unpriced ? ` + ${s.unpriced} call(s) not priced${selfHosted ? ' (self-hosted)' : ''}` : ''));
console.log(`tool calls: ${s.toolCalls}${s.toolFailures ? ` (${s.toolFailures} refused or failed)` : ''} · ${secs(s.ms)} wall`);
console.log(`renders and trace: ${relative(process.cwd(), out) || '.'}`);
if (s.link) console.log(`AgentOps: ${s.link}${s.undelivered ? ` (${s.undelivered} span(s) did not arrive)` : ''}`);
if (result.proposalId) {
  console.log(`\nproposal ${result.proposalId} is in the editor's inbox at ${values.editor} — accept or discard it there.`);
} else if (result.proposalError) {
  console.log(`\nthe editor refused the proposal: ${result.proposalError}`);
}
process.exit(delivered ? 0 : 1);
