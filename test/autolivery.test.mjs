import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startUi } from '../src/ui/server.mjs';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { carKn5, vert, CAR } from './fixtures/kn5.mjs';
import { connect } from '../autolivery/mcp.mjs';
import { createTrace } from '../autolivery/trace.mjs';
import { run } from '../autolivery/loop.mjs';
import { createPlanner } from '../autolivery/claude.mjs';
import * as local from '../autolivery/openai.mjs';
import '../src/index.mjs';

const ROOT = process.cwd();

// The whole loop, with no model in it: a real editor on the synthetic car, the
// real `liverykit --mcp` as a subprocess, and a planner and critic that are
// scripts. What is under test is the harness — that the gate is the harness's
// measurement and not the planner's word, and that nothing reaches the editor
// until a draft has passed.
async function fixtureEditor({ kn5 = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-'));
  const modelPath = join(dir, 'fixture.kn5');
  await writeFile(modelPath, carKn5(kn5));
  const profile = await profileFromKn5(modelPath, { id: 'fixture_car', log: () => {} });
  // Primer and nothing else, like the demo's starting design: a design that
  // paints nothing at all is refused outright, which is right for a build.
  const livery = {
    name: 'Blank', folder: 'blank', car: 'fixture_car', packs: ['core'], identity: {},
    palette: { primer: '#8a8d91' }, surfaces: { body: { background: 'primer', regions: [] } },
  };
  const { server, url } = await startUi({
    livery, profile, modelPath,
    fitPath: join(dir, 'blank@fixture_car.json'),
    liveryId: 'blank', liveryPath: join(dir, 'blank.json'),
    port: 0, log: () => {},
  });
  const mcp = await connect({ args: [join(ROOT, 'bin/liverykit.mjs'), '--mcp', '--editor', url] });
  return {
    dir, url, mcp,
    async stop() {
      mcp.close();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const get = async (url, path) => (await fetch(new URL(path, url).href)).json();

test('a draft is rendered as drafted, and nothing is proposed by looking at it', async () => {
  const ed = await fixtureEditor();
  try {
    const draft = { design: [
      { op: 'set-palette', name: 'hot', value: '#ff00ff' },
      { op: 'add-region', surface: 'surfaces.body', region: { id: 'base', treatment: 'fill', color: 'hot' } },
    ] };
    const plain = await ed.mcp.callTool('render_car', { view: 'left', width: 200, height: 150 });
    const drafted = await ed.mcp.callTool('render_car', { view: 'left', width: 200, height: 150, proposal: draft });
    assert.ok(!plain.isError && !drafted.isError, `${plain.content[0].text ?? ''} ${drafted.content[0].text ?? ''}`);
    assert.notEqual(plain.content[0].data, drafted.content[0].data, 'the draft is what gets drawn');

    const again = await ed.mcp.callTool('render_car', { view: 'left', width: 200, height: 150 });
    assert.equal(again.content[0].data, plain.content[0].data, 'and drawing it adopted nothing');
    assert.equal((await get(ed.url, 'api/proposal')).proposal, null, 'nor proposed anything');
  } finally {
    await ed.stop();
  }
});

test('the loop gates on its own measurement, and only a passing draft reaches the inbox', async () => {
  const ed = await fixtureEditor();
  try {
    const feedbacks = [];
    const planner = {
      async round({ n, feedback, call }) {
        feedbacks.push(feedback);
        await call('describe_car');
        const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
        const panel = panels[0].panel;
        const region = (at) => ({ id: 'number-left', treatment: 'text', text: '85', panel, at, color: 'ink' });
        // A refused operation must leave the draft as it was.
        const bad = await call('draft_design', { design: [{ op: 'no-such-op' }] });
        assert.ok(bad.isError, 'an operation the editor would refuse is refused');
        if (n === 1) {
          // Claims to be done having drafted nothing. The gate must not take
          // its word for it: an empty draft measures clean.
          await call('finish_round', { summary: 'all done' });
        } else if (n === 2) {
          await call('draft_design', { design: [
            { op: 'set-palette', name: 'ink', value: '#101014' },
            { op: 'add-region', surface: 'surfaces.body', region: region([0.3, 0.45, 0.4, 0.005]) },
          ] });
          await call('finish_round', { summary: 'a number on the left' });
        } else {
          await call('draft_design', { design: [{ op: 'set-region', id: 'number-left', region: region([0.1, 0.3, 0.8, 0.4]) }] });
          await call('finish_round', { summary: 'a number on the left, big enough to read' });
        }
        // Submitted is sealed: a call after finish_round is not run, so the
        // gate judges the draft the summary describes.
        const late = await call('draft_design', { design: [{ op: 'remove-region', id: 'number-left' }] });
        assert.ok(late.isError);
        assert.match(late.content[0].text, /already submitted/);
      },
    };
    const critic = {
      async judge({ images }) {
        assert.ok(images.length > 0, 'the critic is shown pictures');
        return { reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true, notes: [] };
      },
    };
    const trace = await createTrace({ dir: join(ed.dir, 'run') });
    const result = await run({
      brief: 'number 85', mcp: ed.mcp, planner, critic, trace,
      out: join(ed.dir, 'run'), rounds: 4, views: ['left'], shot: { width: 200, height: 150 },
    });

    assert.equal(result.passedIn, 3, JSON.stringify(result.history.map((h) => h.failures), null, 2));
    assert.match(feedbacks[1].text, /empty/, 'round 2 heard that round 1 drafted nothing');
    assert.match(feedbacks[2].text, /unreadable/, 'round 3 heard the measurement, in its own words');
    assert.ok(feedbacks[2].images.length > 0, 'and saw what the critic saw');

    // The working design is untouched: the loop never committed anything.
    const state = await get(ed.url, 'api/state');
    assert.equal(JSON.stringify(state.design).includes('number-left'), false);

    // The draft reached the inbox as one ordinary proposal, reasons attached.
    const { proposal } = await get(ed.url, 'api/proposal');
    assert.equal(proposal?.id, result.proposalId);
    assert.deepEqual(proposal.design, result.draft.design);
    assert.match(proposal.why, /every fitment check ran/);

    // Every call is in the trace, the gate's own included.
    const spans = (await readFile(join(ed.dir, 'run', 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const tools = spans.filter((s) => s.kind === 'tool').map((s) => s.name);
    for (const t of ['describe_car', 'draft_design', 'check_fitment', 'render_car', 'propose_design']) {
      assert.ok(tools.includes(t), `${t} is traced: ${[...new Set(tools)]}`);
    }
    assert.equal(spans.filter((s) => s.kind === 'task' && s.name === 'gate').length, 3);
    assert.ok(spans.some((s) => s.name === 'draft_design' && !s.ok), 'a refusal is traced as a failure');
  } finally {
    await ed.stop();
  }
});

test('the planner answers every tool call before saying anything else, across rounds too', async () => {
  // The API refuses a conversation in which a tool call goes unanswered, or is
  // answered anywhere but first in the very next message. finish_round ends a
  // round mid-conversation, so its answer is held over and has to open the
  // next round's message ahead of the gate's verdict — get that wrong and the
  // second round of every run is a 400, which no test with a scripted planner
  // would ever see.
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-planner-'));
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const reply = (content, stop_reason = 'tool_use') => ({ id: 'msg', model: 'claude-opus-5', content, stop_reason, usage });
  const script = [
    reply([{ type: 'text', text: 'looking first' }, { type: 'tool_use', id: 't1', name: 'describe_car', input: {} }]),
    reply([{ type: 'tool_use', id: 't2', name: 'finish_round', input: { summary: 'first go' } }]),
    reply([{ type: 'text', text: 'revised' }], 'end_turn'),
    reply([{ type: 'tool_use', id: 't3', name: 'finish_round', input: { summary: 'revised' } }]),
  ];
  const sent = [];
  const client = { beta: { messages: { create: async (params) => {
    sent.push(structuredClone(params));
    return script.shift();
  } } } };

  const answered = (messages) => {
    for (const [i, m] of messages.entries()) {
      if (m.role !== 'assistant') continue;
      const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
      if (!ids.length) continue;
      const next = messages[i + 1]?.content ?? [];
      const leading = next.slice(0, ids.length);
      assert.deepEqual(leading.map((b) => b.type === 'tool_result' && b.tool_use_id), ids,
        `message ${i + 1} opens with the answers to ${ids}`);
    }
  };

  try {
    const trace = await createTrace({ dir });
    const planner = createPlanner({ client, model: 'claude-opus-5', effort: 'high', trace, fallback: false });
    const call = async (name) => (name === 'describe_car'
      ? { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }
      : { content: [{ type: 'text', text: 'ok' }] });

    const one = await planner.round({ n: 1, rounds: 2, brief: 'b', feedback: null, tools: [], call });
    assert.equal(one.summary, 'first go');
    const two = await planner.round({ n: 2, rounds: 2, brief: 'b', tools: [], call,
      feedback: { text: '{"passed": false}', images: [{ view: 'left', data: 'BBBB' }] } });
    assert.equal(two.summary, 'revised');

    for (const params of sent) answered(params.messages);
    const opening = sent[2].messages.at(-1).content;
    assert.equal(opening[0].tool_use_id, 't2', 'the held-over answer comes first');
    assert.ok(opening.some((b) => b.type === 'text' && /verdict on round 1/.test(b.text)), 'then the verdict');
    assert.ok(opening.some((b) => b.type === 'image' && b.source.data === 'BBBB'), 'with the picture the critic saw');
    const image = sent[1].messages.at(-1).content[0].content[0];
    assert.deepEqual(image, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      'an MCP image reaches the model as an image');

    const s = await trace.finish({ ok: true });
    assert.equal(s.llmCalls, 4);
    assert.equal(s.unpriced, 0);
    assert.ok(Math.abs(s.cost - 4 * (1000 * 5 + 200 * 25) / 1e6) < 1e-9, `priced at list: ${s.cost}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- the same, over an OpenAI-compatible server ----------------------------------

function fakeServer({ vision, replies }) {
  const sent = [];
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    if (path === '/v1/models') return json({ data: [{ id: 'local-model' }] });
    if (path === '/props') return json({ default_generation_settings: { n_ctx: 65536 }, modalities: { vision } });
    if (path === '/v1/chat/completions') {
      sent.push(JSON.parse(opts.body));
      return json(replies.shift());
    }
    return json({ error: 'not found' }, 404);
  };
  return { fetchImpl, sent };
}
const usage = { prompt_tokens: 100, completion_tokens: 10 };
const calls = (...list) => ({ id: 'r', model: 'local-model', usage, choices: [{ finish_reason: 'tool_calls', message: {
  role: 'assistant', content: '',
  tool_calls: list.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
} }] });
const words = (text) => ({ id: 'r', model: 'local-model', usage, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] });

async function twoRounds(vision) {
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-local-'));
  const { fetchImpl, sent } = fakeServer({ vision, replies: [
    calls(['a1', 'render_car', { view: 'left' }]),
    calls(['a2', 'finish_round', { summary: 'first go' }]),
    words('revised'),
    calls(['a3', 'finish_round', { summary: 'revised' }]),
  ] });
  const endpoint = await local.connectEndpoint({ baseUrl: 'http://fake/v1', fetchImpl });
  const trace = await createTrace({ dir });
  const planner = local.createPlanner({ endpoint, model: 'local-model', trace });
  const call = async (name) => (name === 'render_car'
    ? { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }
    : { content: [{ type: 'text', text: 'ok' }] });
  const tools = [{ name: 'render_car', description: 'a picture', input_schema: { type: 'object', properties: {} } }];
  const one = await planner.round({ n: 1, rounds: 2, brief: 'b', feedback: null, tools, call });
  const two = await planner.round({ n: 2, rounds: 2, brief: 'b', tools, call,
    feedback: { text: '{"passed": false}', images: [{ view: 'left', data: 'BBBB' }] } });
  const summary = await trace.finish({ ok: true });
  await rm(dir, { recursive: true, force: true });
  return { endpoint, sent, one, two, summary };
}

test('over an OpenAI-compatible server, every tool call is answered in order, and pictures follow', async () => {
  const { endpoint, sent, one, two, summary } = await twoRounds(true);
  assert.equal(endpoint.vision, true);
  assert.equal(endpoint.context, 65536, 'llama-server says how much context a request gets');
  assert.equal(one.summary, 'first go');
  assert.equal(two.summary, 'revised');
  assert.equal(sent[0].tools[0].function.name, 'render_car');

  for (const body of sent) {
    for (const [i, m] of body.messages.entries()) {
      if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
      assert.deepEqual(body.messages.slice(i + 1, i + 1 + m.tool_calls.length).map((x) => x.role === 'tool' && x.tool_call_id),
        m.tool_calls.map((c) => c.id), `message ${i + 1} onward answers ${m.tool_calls.map((c) => c.id)}`);
    }
  }
  // A tool message is text only, so the render rides in the user message after it.
  const second = sent[1].messages;
  const at = second.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'a1');
  assert.ok(second[at + 1].content.some((p) => p.type === 'image_url' && p.image_url.url === 'data:image/png;base64,AAAA'),
    JSON.stringify(second[at + 1]));
  assert.ok(sent[2].messages.at(-1).content.some((p) => p.type === 'image_url' && p.image_url.url.endsWith('BBBB')),
    'round 2 sees what the critic saw');
  // Self-hosted: tokens counted, cost not invented.
  assert.equal(summary.tokensIn, 400);
  assert.equal(summary.unpriced, 4);
  assert.equal(summary.cost, 0);
});

test('a model that takes no images is told a picture was taken, and sent none', async () => {
  const { sent } = await twoRounds(false);
  assert.equal(JSON.stringify(sent).includes('image_url'), false, 'the server would reject one');
  const answer = sent[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'a1');
  assert.match(answer.content, /cannot see images/, 'rather than believing render_car returned nothing');
  assert.match(JSON.stringify(sent[2].messages.at(-1)), /cannot see/);
});

test('the local critic is held to the schema, and a verdict that is not one is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-critic-'));
  try {
    const good = { reads_at_distance: true, number_legible: false, palette_ok: true, matches_brief: true,
      requirements: [{ asked: 'number 85', present: true, where: 'left door' }], cut_off: [], unreadable: [],
      notes: ['the 85 is tiny'] };
    const { fetchImpl, sent } = fakeServer({ vision: true, replies: [
      words(JSON.stringify(good)),
      words('It looks great!'),
      words(JSON.stringify({ ...good, number_legible: 'false' })),
      words(JSON.stringify({ ...good, requirements: [{ asked: 'number 85', present: true }] })),
      words(JSON.stringify({ ...good, cut_off: [{ what: 'the roundel', where: 'left door' }] })),
    ] });
    const endpoint = await local.connectEndpoint({ baseUrl: 'http://fake/v1', fetchImpl });
    const critic = local.createCritic({ endpoint, model: 'local-model', trace: await createTrace({ dir }) });
    const ask = () => critic.judge({ brief: 'b', summary: 's', images: [{ view: 'left', data: 'CCCC' }] });

    assert.deepEqual(await ask(), good);
    assert.deepEqual(sent[0].response_format.json_schema.schema.required,
      ['reads_at_distance', 'number_legible', 'palette_ok', 'matches_brief', 'requirements', 'cut_off',
        'unreadable', 'notes']);
    assert.ok(sent[0].messages[1].content.some((p) => p.type === 'image_url'), 'it is shown the render');
    await assert.rejects(ask(), /not JSON/);
    // "false" is truthy. A gate that took it would pass a round the critic failed.
    await assert.rejects(ask(), /number_legible/);
    // A server need not honour response_format: a requirement ticked with no
    // "where" is a critic that did not say where it saw it.
    await assert.rejects(ask(), /requirements/);
    // Nor a cut-off piece with no id: the gate holds those against the count
    // by id, and one without is a claim nothing can check.
    await assert.rejects(ask(), /cut_off/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a reply cut off by the output limit is answered with why, and its calls are not run', async () => {
  // The planner repeated itself into the 4096-token limit, and the cut-off
  // text was taken as its summary: the round closed on an empty draft, and the
  // model never heard that it had been cut off, so it had no reason to change.
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-cut-'));
  try {
    const cut = calls(['c1', 'draft_design', { design: [] }]);
    cut.choices[0].finish_reason = 'length';
    const { fetchImpl, sent } = fakeServer({ vision: true, replies: [
      cut,
      calls(['c2', 'finish_round', { summary: 'done properly' }]),
    ] });
    const endpoint = await local.connectEndpoint({ baseUrl: 'http://fake/v1', fetchImpl });
    const planner = local.createPlanner({ endpoint, model: 'local-model', trace: await createTrace({ dir }), maxTokens: 64 });
    const ran = [];
    const call = async (name) => { ran.push(name); return { content: [{ type: 'text', text: 'ok' }] }; };

    const out = await planner.round({ n: 1, rounds: 1, brief: 'b', feedback: null, tools: [], call });
    assert.equal(out.summary, 'done properly', 'the round went on after the cut');
    assert.deepEqual(ran, ['finish_round'], 'the truncated call was not run');
    const told = sent[1].messages.at(-1);
    assert.equal(told.role, 'user');
    assert.match(told.content, /cut off at the 64-token limit.*were not run/);
    assert.equal(sent[1].messages.at(-2).tool_calls, undefined, 'and no call is left unanswered');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a critic that says the brief is met while listing something missing does not pass the round', async () => {
  // Seen live: matches_brief true, and in the same verdict "no text or logo
  // for 'Neon Doll Racing' is visible on the car in any view". The gate read
  // the boolean and sent the design to the inbox without the team name.
  const ed = await fixtureEditor();
  try {
    const planner = {
      async round({ call }) {
        const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
        await call('draft_design', { design: [
          { op: 'set-palette', name: 'ink', value: '#101014' },
          { op: 'add-region', surface: 'surfaces.body', region: {
            id: 'number-left', treatment: 'text', text: '85', panel: panels[0].panel, at: [0.1, 0.3, 0.8, 0.4], color: 'ink' } },
        ] });
        await call('finish_round', { summary: 'a number' });
      },
    };
    const critic = {
      judge: async () => ({
        reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
        requirements: [
          { asked: 'number 85', present: true, where: 'left door' },
          { asked: 'the team name Neon Doll Racing', present: false, where: 'not visible' },
        ],
        notes: ['Neon Doll Racing is not on the car'],
      }),
    };
    const lines = [];
    const result = await run({
      brief: 'number 85, Neon Doll Racing', mcp: ed.mcp, planner, critic,
      trace: await createTrace({ dir: join(ed.dir, 'run') }), out: join(ed.dir, 'run'),
      rounds: 1, views: ['left'], shot: { width: 200, height: 150 }, log: (l) => lines.push(l),
    });
    assert.equal(result.passed, false, 'the missing requirement fails the round');
    assert.equal(result.history[0].gates.fitment, 'pass', 'fitment had nothing against it');
    assert.equal(result.history[0].gates.critic, 'fail');
    assert.equal(result.proposalId, undefined, 'and nothing reaches the inbox');
    assert.ok(lines.some((l) => /missing: the team name Neon Doll Racing/.test(l)), lines.join('\n'));
  } finally {
    await ed.stop();
  }
});

test('a turn that ends in prose is sent back to act, and a model that never acts still ends the round', async () => {
  // Seen live: the planner wrote every operation out as JSON in its reply —
  // "```json { "op": "render_car" } ```" — and stopped, six rounds running.
  // Each reply was taken as a finished round, and the gate was handed an
  // empty draft six times.
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-prose-'));
  try {
    const trace = await createTrace({ dir });
    const ran = [];
    const call = async (name) => { ran.push(name); return { content: [{ type: 'text', text: 'ok' }] }; };

    const acts = fakeServer({ vision: true, replies: [
      words('I will now draft: ```json {"op": "set-palette", "name": "blue", "value": "#00f"}```'),
      calls(['p1', 'finish_round', { summary: 'acted' }]),
    ] });
    const endpoint = await local.connectEndpoint({ baseUrl: 'http://fake/v1', fetchImpl: acts.fetchImpl });
    const out = await local.createPlanner({ endpoint, model: 'local-model', trace })
      .round({ n: 1, rounds: 1, brief: 'b', feedback: null, tools: [], call });
    assert.equal(out.summary, 'acted', 'the round went on to a real finish_round');
    assert.deepEqual(ran, ['finish_round'], 'nothing was run out of the prose');
    assert.match(acts.sent[1].messages.at(-1).content, /without calling a tool/);

    const never = fakeServer({ vision: true, replies: Array.from({ length: 10 }, () => words('thinking about it')) });
    const idle = await local.connectEndpoint({ baseUrl: 'http://fake/v1', fetchImpl: never.fetchImpl });
    await local.createPlanner({ endpoint: idle, model: 'local-model', trace, maxNudges: 2 })
      .round({ n: 1, rounds: 1, brief: 'b', feedback: null, tools: [], call });
    assert.equal(never.sent.length, 3, 'asked twice more, then the round ends for the gate to judge');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a model repeating itself into the limit ends the round, and is not fed its own repetition', async () => {
  // Seen live: eleven replies in a row, each 4096 tokens of the same text and
  // each kept whole in the conversation. The prompt grew 4161 tokens a turn
  // until the server refused it, and the run died mid-round.
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-rant-'));
  try {
    const rant = 'I will now render the car again to check. '.repeat(300);
    const cut = () => {
      const r = words(rant);
      r.choices[0].finish_reason = 'length';
      return r;
    };
    const { fetchImpl, sent } = fakeServer({ vision: true, replies: Array.from({ length: 10 }, cut) });
    const endpoint = await local.connectEndpoint({ baseUrl: 'http://fake/v1', fetchImpl });
    const planner = local.createPlanner({ endpoint, model: 'local-model', trace: await createTrace({ dir }), maxNudges: 2 });
    await planner.round({ n: 1, rounds: 1, brief: 'b', feedback: null, tools: [],
      call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });

    assert.equal(sent.length, 3, 'told twice, then the round ends for the gate to judge');
    const kept = sent[2].messages.filter((m) => m.role === 'assistant').map((m) => m.content.length);
    assert.ok(kept.length === 2 && kept.every((n) => n < 400), `only the start of each is kept: ${kept}`);
    assert.match(sent[2].messages.find((m) => m.role === 'assistant').content, /\[…cut off\]$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fresh round starts from where things stand, not from the whole history', async () => {
  // Run 8 died in round 6 at 72k tokens on a 64k model: every round's
  // findings and every re-sent region stayed in the conversation, and the
  // planner kept writing a tag the gate had rejected four rounds running.
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-fresh-'));
  try {
    const script = () => [
      calls(['f1', 'describe_car', {}]),
      calls(['f2', 'finish_round', { summary: 'a blue car' }]),
      calls(['f3', 'finish_round', { summary: 'now with a number' }]),
    ];
    const feedback = { text: '{"passed": false, "failures": ["unmatched number-left"]}', images: [],
      design: '{"surfaces":{"body":{"regions":[{"id":"base-fill","treatment":"fill"}]}}}' };
    const play = async (fresh) => {
      const { fetchImpl, sent } = fakeServer({ vision: true, replies: script() });
      const endpoint = await local.connectEndpoint({ baseUrl: 'http://fake/v1', fetchImpl });
      const planner = local.createPlanner({ endpoint, model: 'local-model', trace: await createTrace({ dir }), fresh });
      const call = async () => ({ content: [{ type: 'text', text: 'ok' }] });
      await planner.round({ n: 1, rounds: 2, brief: 'Gulf, number 85', feedback: null, tools: [], call });
      await planner.round({ n: 2, rounds: 2, brief: 'Gulf, number 85', feedback, tools: [], call });
      return sent[2].messages;
    };

    const fresh = await play(true);
    assert.deepEqual(fresh.map((m) => m.role), ['system', 'user'], 'nothing from round 1 comes along');
    const said = fresh[1].content.map((p) => p.text ?? '').join('\n');
    assert.match(said, /Brief: Gulf, number 85/);
    assert.match(said, /you said: a blue car/);
    assert.match(said, /"id":"base-fill"/, 'the design as it stands, so its ids can be reused');
    assert.match(said, /verdict on round 1:[\s\S]*unmatched number-left/);
    assert.equal(JSON.stringify(fresh).includes('f1'), false);

    const full = await play(false);
    assert.ok(full.length > 2 && JSON.stringify(full).includes('f1'), '--full-history keeps it all');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a Claude run stops before the call that would go past its budget', async () => {
  // Credits with no top-up: a planner going in circles made 155 calls on the
  // local model. On the API that has to end as a stopped run, not a spent one.
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-budget-'));
  try {
    // A million tokens in at $5 a million: every call costs exactly $5.
    const pricey = { input_tokens: 1_000_000, output_tokens: 0 };
    let made = 0;
    const client = { beta: { messages: { create: async () => {
      made++;
      return { id: 'm', model: 'claude-opus-5', stop_reason: 'tool_use', usage: pricey,
        content: [{ type: 'tool_use', id: `t${made}`, name: 'describe_car', input: {} }] };
    } } } };
    const budget = { max: 7, spent: 0 };
    const planner = createPlanner({ client, model: 'claude-opus-5', effort: 'high', fallback: false,
      trace: await createTrace({ dir }), budget });
    await assert.rejects(
      planner.round({ n: 1, rounds: 1, brief: 'b', feedback: null, tools: [],
        call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }),
      /stopped before another model call: \$10\.00 spent, and the budget is \$7\.00/);
    assert.equal(made, 2, 'the second call took it past $7; the third was never made');
    assert.equal(budget.spent, 10);

    const unknown = { beta: { messages: { create: async () => ({ id: 'm', model: 'claude-mystery', stop_reason: 'end_turn',
      usage: pricey, content: [{ type: 'text', text: 'hi' }] }) } } };
    const traced = await createTrace({ dir: join(dir, 'unpriced') });
    await assert.rejects(
      createPlanner({ client: unknown, model: 'claude-mystery', effort: 'high', fallback: false,
        trace: traced, budget: { max: 7, spent: 0 } })
        .round({ n: 1, rounds: 1, brief: 'b', feedback: null, tools: [], call: async () => ({ content: [] }) }),
      /no known price, so a --max-cost budget cannot be enforced/);
    // The call was made and paid for before its price was found unknown, so it
    // is in the trace, failed, with its tokens: not lost with the error.
    await traced.flush();
    const spans = (await readFile(join(dir, 'unpriced', 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const call = spans.find((s) => s.kind === 'llm');
    assert.ok(call, 'the unpriced call is traced');
    assert.equal(call.ok, false);
    assert.match(call.error, /no known price/);
    assert.equal(call.attrs['gen_ai.usage.prompt_tokens'], 1_000_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a sheet is four different views in one picture, the size it was asked for', async () => {
  const ed = await fixtureEditor();
  try {
    const r = await ed.mcp.callTool('render_car', { view: 'sheet', width: 400, height: 300 });
    assert.ok(!r.isError, r.content[0].text);
    const { default: sharp } = await import('sharp');
    const png = Buffer.from(r.content[0].data, 'base64');
    const meta = await sharp(png).metadata();
    assert.deepEqual([meta.width, meta.height], [400, 300]);
    const quarter = (left, top) => sharp(png).extract({ left, top, width: 200, height: 150 }).raw().toBuffer();
    assert.notDeepEqual(await quarter(0, 150), await quarter(200, 150), 'left and right are different pictures');
    // Odd sizes too: halving 401 x 301 used to lose a pixel each way.
    const odd = await ed.mcp.callTool('render_car', { view: 'sheet', width: 401, height: 301 });
    const oddMeta = await sharp(Buffer.from(odd.content[0].data, 'base64')).metadata();
    assert.deepEqual([oddMeta.width, oddMeta.height], [401, 301]);
    const listed = (await ed.mcp.listTools()).find((t) => t.name === 'render_car');
    assert.match(listed.description, /"sheet" is six labelled views/);
  } finally {
    await ed.stop();
  }
});

test('a constraint that failed cannot be lowered to pass, and looks run out', async () => {
  // The first Claude run passed by lowering its own minOnCar on a door number
  // from 0.95 to 0.90 after the gate failed it at 93%, and the roundel went
  // onto the car cut in half by the shut line the measurement had found.
  const ed = await fixtureEditor();
  try {
    const looked = [];
    const planner = {
      async round({ n, call }) {
        if (n === 1) {
          const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
          await call('draft_design', { design: [
            { op: 'set-palette', name: 'ink', value: '#101014' },
            { op: 'add-region', surface: 'surfaces.body', region: {
              id: 'number-left', treatment: 'text', text: '85', panel: panels[0].panel,
              at: [0.3, 0.45, 0.4, 0.02], color: 'ink', constraints: { minMm: 100 } } },
          ] });
          for (let i = 0; i < 3; i++) looked.push(await call('render_car', { view: 'left' }));
        } else {
          // Nothing moved; the requirement it failed is simply made smaller.
          await call('draft_design', { design: [{ op: 'set-constraint', id: 'number-left', key: 'minMm', value: 10 }] });
        }
        await call('finish_round', { summary: `round ${n}` });
      },
    };
    const critic = { judge: async () => ({ reads_at_distance: true, number_legible: true, palette_ok: true,
      matches_brief: true, requirements: [{ asked: 'number 85', present: true, where: 'left door' }], notes: [] }) };
    const result = await run({
      brief: 'number 85', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: join(ed.dir, 'run') }),
      out: join(ed.dir, 'run'), rounds: 2, views: ['left'], shot: { width: 200, height: 150 }, looks: 2,
    });

    assert.ok(result.history[0].failures.some((f) => /unreadable/.test(f)), JSON.stringify(result.history[0].failures));
    assert.equal(result.history[1].passed, false, 'the lowered constraint does not buy a pass');
    assert.ok(result.history[1].failures.some((f) => /number-left: minMm lowered from 100 to 10 after it failed round 1/.test(f)),
      JSON.stringify(result.history[1].failures));
    assert.equal(result.proposalId, undefined);

    assert.deepEqual(looked.map((r) => Boolean(r.isError)), [false, false, true], 'two looks, then no');
    assert.match(looked[2].content[0].text, /looks are spent/);
  } finally {
    await ed.stop();
  }
});

test('a group that failed cannot be undeclared to pass', async () => {
  // Letting go of groupWith after the name was found on the wrong panel gets
  // out of the group exactly as lowering a floor gets under it.
  const ed = await fixtureEditor();
  try {
    const planner = {
      async round({ n, call }) {
        if (n === 1) {
          const side = async (tag) => JSON.parse((await call('find_panels', { tag })).content[0].text).panels[0].panel;
          const [left, right] = [await side('left'), await side('right')];
          const text = (id, panel, extra = {}) => ({ op: 'add-region', surface: 'surfaces.body', region: {
            id, treatment: 'text', text: id === 'number-left' ? '85' : 'NDR', panel, at: [0.1, 0.3, 0.8, 0.4], color: 'ink', ...extra } });
          await call('draft_design', { design: [
            { op: 'set-palette', name: 'ink', value: '#101014' },
            text('number-left', left),
            text('team-left', right, { constraints: { groupWith: 'number-left' } }),
          ] });
        } else {
          await call('draft_design', { design: [{ op: 'set-constraint', id: 'team-left', key: 'groupWith', value: null }] });
        }
        await call('finish_round', { summary: `round ${n}` });
      },
    };
    const critic = { judge: async () => ({ reads_at_distance: true, number_legible: true, palette_ok: true,
      matches_brief: true, requirements: [{ asked: 'number 85', present: true, where: 'left door' }],
      cut_off: [], unreadable: [], notes: [] }) };
    const result = await run({
      brief: 'number 85', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: join(ed.dir, 'run') }),
      out: join(ed.dir, 'run'), rounds: 2, views: ['left'], shot: { width: 200, height: 150 }, propose: false,
    });
    assert.ok(result.history[0].failures.some((f) => /high ungrouped: team-left asked to sit with number-left/.test(f)),
      JSON.stringify(result.history[0].failures));
    assert.equal(result.history[1].passed, false);
    assert.ok(result.history[1].failures.some((f) => /team-left: groupWith removed after it failed round 1/.test(f)),
      JSON.stringify(result.history[1].failures));
  } finally {
    await ed.stop();
  }
});

test('a critic that passes everything but lists a cut-off piece does not pass the round', async () => {
  // Seen live: every field true, and in the notes "the roundel is cut off on
  // the left side where it meets the door gap". The gate read the fields.
  const ed = await fixtureEditor();
  try {
    const planner = {
      async round({ call }) {
        const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
        await call('draft_design', { design: [
          { op: 'set-palette', name: 'ink', value: '#101014' },
          { op: 'add-region', surface: 'surfaces.body', region: {
            id: 'number-left', treatment: 'text', text: '85', panel: panels[0].panel, at: [0.1, 0.3, 0.8, 0.4], color: 'ink' } },
        ] });
        await call('finish_round', { summary: 'a number' });
      },
    };
    const critic = { judge: async () => ({
      reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
      requirements: [{ asked: 'number 85', present: true, where: 'left door' }],
      cut_off: [{ what: 'the roundel behind 85', where: 'three-quarter view, top edge under the window frame' }],
      notes: [],
    }) };
    const lines = [];
    const result = await run({
      brief: 'number 85', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: join(ed.dir, 'run') }),
      out: join(ed.dir, 'run'), rounds: 1, views: ['left'], shot: { width: 200, height: 150 }, log: (l) => lines.push(l),
    });
    assert.equal(result.passed, false);
    assert.equal(result.history[0].gates.critic, 'fail');
    assert.ok(lines.some((l) => /cut off: the roundel behind 85, three-quarter view/.test(l)), lines.join('\n'));
  } finally {
    await ed.stop();
  }
});

test('a critic that fails a clean draft gets a closer second look, and the second look decides', async () => {
  // Seen live: a local critic failed three rounds on a roundel that was whole
  // in every render, fitment having measured it whole each time, and the
  // planner shrank it to please the critic.
  const ed = await fixtureEditor();
  try {
    const drafting = {
      async round({ call }) {
        const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
        await call('draft_design', { design: [
          { op: 'set-palette', name: 'ink', value: '#101014' },
          { op: 'add-region', surface: 'surfaces.body', region: {
            id: 'number-left', treatment: 'text', text: '85', panel: panels[0].panel, at: [0.1, 0.3, 0.8, 0.4], color: 'ink' } },
        ] });
        await call('finish_round', { summary: 'a number' });
      },
    };
    const flagged = {
      reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
      requirements: [{ asked: 'number 85', present: true, where: 'left door' }],
      cut_off: [{ what: 'the roundel behind 85', where: 'left view, door shut line' }],
      notes: [],
    };
    const judging = (answer) => {
      const j = { asked: [], judge: async (a) => { j.asked.push(a); return answer; } };
      return j;
    };
    const go = async (planner, critic, referee, tag) => {
      const lines = [];
      const out = join(ed.dir, tag);
      const result = await run({
        brief: 'number 85', mcp: ed.mcp, planner, critic, referee, trace: await createTrace({ dir: out }), out,
        rounds: 1, views: ['left'], shot: { width: 200, height: 150 }, closeShot: { width: 200, height: 150 },
        propose: false, log: (l) => lines.push(l),
      });
      return { result, lines };
    };

    const critic = judging(flagged);
    const referee = judging({ ...flagged, cut_off: [] });
    const cleared = await go(drafting, critic, referee, 'cleared');
    assert.equal(cleared.result.passed, true, cleared.lines.join('\n'));
    assert.equal(critic.asked.length, 1);
    assert.equal(referee.asked.length, 1, 'the referee, not the critic again');
    const asked = referee.asked[0];
    assert.equal(asked.recheck, flagged, 'told what the first look flagged');
    assert.equal(asked.name, 'referee');
    assert.deepEqual(asked.images.map((i) => i.view), ['left', 'left', 'right'], "the round's picture, then closer sides");
    assert.deepEqual(cleared.result.history[0].critic.cut_off, flagged.cut_off, 'the first verdict is kept');
    assert.deepEqual(cleared.result.history[0].secondLook.cut_off, []);
    assert.ok(cleared.lines.some((l) => /critic FAIL \(cut off: the roundel behind 85.*→ closer look PASS/.test(l)),
      cleared.lines.join('\n'));

    // A second look that agrees keeps the round failed.
    const upheld = await go(drafting, judging(flagged), judging(flagged), 'upheld');
    assert.equal(upheld.result.passed, false);
    assert.equal(upheld.result.history[0].gates.critic, 'fail');
    assert.ok(upheld.lines.some((l) => /→ closer look FAIL \(cut off: the roundel behind 85/.test(l)), upheld.lines.join('\n'));

    // Closer views that do not render leave the second look nothing new to see:
    // the critic's verdict stands, and the referee is not asked to clear it.
    const blind = judging({ ...flagged, cut_off: [] });
    const out = join(ed.dir, 'blind');
    const unseen = await run({
      brief: 'number 85', mcp: ed.mcp, planner: drafting, critic: judging(flagged), referee: blind,
      trace: await createTrace({ dir: out }), out, rounds: 1, views: ['left'], shot: { width: 200, height: 150 },
      closer: ['no-such-view'], closeShot: { width: 200, height: 150 }, propose: false,
    });
    assert.equal(unseen.passed, false);
    assert.equal(blind.asked.length, 0);
    assert.match(unseen.history[0].secondLook.error, /closer views did not render/);

    // And a draft that failed fitment is revised anyway: no second look to pay for.
    const idle = { async round({ call }) { await call('finish_round', { summary: 'nothing yet' }); } };
    const unasked = judging({ ...flagged, cut_off: [] });
    const empty = await go(idle, judging(flagged), unasked, 'empty');
    assert.equal(empty.result.passed, false);
    assert.equal(unasked.asked.length, 0);
    assert.equal(empty.result.history[0].secondLook, undefined);
  } finally {
    await ed.stop();
  }
});

test('a verdict that lists something unreadable does not pass the round, however its fields read', async () => {
  // Seen live: a second look wrote that the team name "will not read from
  // trackside" and answered reads_at_distance: true. The gate read the field.
  const ed = await fixtureEditor();
  try {
    const planner = {
      async round({ call }) {
        const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
        await call('draft_design', { design: [
          { op: 'set-palette', name: 'ink', value: '#101014' },
          { op: 'add-region', surface: 'surfaces.body', region: {
            id: 'number-left', treatment: 'text', text: '85', panel: panels[0].panel, at: [0.1, 0.3, 0.8, 0.4], color: 'ink' } },
        ] });
        await call('finish_round', { summary: 'a number' });
      },
    };
    const faint = { judge: async () => ({
      reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
      requirements: [{ asked: 'Neon Doll Racing', present: true, where: 'both doors' }],
      cut_off: [],
      unreadable: [{ what: 'Neon Doll Racing', where: 'left door', why: 'pale grey on light blue, and small' }],
      notes: [],
    }) };
    const lines = [];
    const result = await run({
      brief: 'number 85', mcp: ed.mcp, planner, critic: faint, referee: faint,
      trace: await createTrace({ dir: join(ed.dir, 'run') }), out: join(ed.dir, 'run'), rounds: 1,
      views: ['left'], shot: { width: 200, height: 150 }, closeShot: { width: 200, height: 150 },
      propose: false, log: (l) => lines.push(l),
    });
    assert.equal(result.passed, false);
    assert.equal(result.history[0].gates.critic, 'fail');
    assert.ok(lines.some((l) => /will not read: Neon Doll Racing, pale grey on light blue/.test(l)), lines.join('\n'));
  } finally {
    await ed.stop();
  }
});

test('a run can be replayed round by round against today\'s gate, with no planner model at all', async () => {
  // Most changes are to the harness, and each was being tested by paying a
  // model to design a livery again. The designs already exist.
  const { loadRecording, createReplayPlanner } = await import('../autolivery/replay.mjs');
  const ed = await fixtureEditor();
  try {
    const drafting = {
      async round({ n, call }) {
        const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
        const region = (at) => ({ id: 'number-left', treatment: 'text', text: '85', panel: panels[0].panel, at, color: 'ink' });
        await call('draft_design', { design: n === 1
          ? [{ op: 'set-palette', name: 'ink', value: '#101014' }, { op: 'add-region', surface: 'surfaces.body', region: region([0.3, 0.45, 0.4, 0.005]) }]
          : [{ op: 'set-region', id: 'number-left', region: region([0.1, 0.3, 0.8, 0.4]) }] });
        await call('finish_round', { summary: `round ${n}` });
      },
    };
    const critic = { judge: async () => ({ reads_at_distance: true, number_legible: true, palette_ok: true,
      matches_brief: true, requirements: [{ asked: 'number 85', present: true, where: 'left door' }],
      cut_off: [], unreadable: [], notes: [] }) };
    const go = async (planner, tag, rounds) => run({
      brief: 'number 85', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: join(ed.dir, tag) }),
      out: join(ed.dir, tag), rounds, views: ['left'], shot: { width: 200, height: 150 }, propose: false,
    });

    const original = await go(drafting, 'original', 3);
    assert.equal(original.passedIn, 2, JSON.stringify(original.history.map((h) => h.failures)));

    const recording = await loadRecording(join(ed.dir, 'original'));
    assert.equal(recording.perRound, true);
    assert.deepEqual(recording.rounds.map((r) => r.summary), ['round 1', 'round 2']);
    const replayed = await go(createReplayPlanner(recording), 'replayed', recording.rounds.length);
    assert.deepEqual(replayed.history.map((h) => h.gates), original.history.map((h) => h.gates),
      'the same rounds pass and fail');
    assert.deepEqual(replayed.draft, original.draft, 'with the same design');

    // A run from before rounds were recorded replays its final draft, once.
    const old = JSON.parse(await readFile(join(ed.dir, 'original', 'result.json'), 'utf8'));
    for (const h of old.history) delete h.draft;
    await writeFile(join(ed.dir, 'original', 'result.json'), JSON.stringify(old));
    const legacy = await loadRecording(join(ed.dir, 'original'));
    assert.equal(legacy.perRound, false);
    assert.equal(legacy.rounds.length, 1);
    assert.deepEqual(legacy.rounds[0].draft, original.draft);
  } finally {
    await ed.stop();
  }
});

// A panel standing 10 cm off the left flank over its front half, the way a
// mirror or a handle stands off a door. It wears the body's own texture, at a
// corner of the sheet no island uses, because on the NSX the handle is on the
// same painted sheet as the door it hides — the case where "what is in front"
// cannot be told apart by texture alone.
const SHIELD = (() => {
  const x = CAR.width / 2 + 0.1;
  const n = [1, 0, 0];
  return {
    name: 'MIRROR_L',
    verts: [vert(x, 0.2, 0.3, 0.990, 0.990, n), vert(x, 0.2, 1.85, 0.995, 0.990, n),
      vert(x, 1.3, 1.85, 0.995, 0.995, n), vert(x, 1.3, 0.3, 0.990, 0.995, n)],
    indices: [0, 1, 2, 0, 2, 3],
  };
})();

// On the fixture's left panel `at` x runs nose to tail from z = -1.85 and y up
// from the ground, so the shield covers x from 0.58 and y from 0.13 to 0.87.
const plate = (id, panel, at) => ({ op: 'add-region', surface: 'surfaces.body', region: {
  id, treatment: 'fill', panel, at, color: 'ink', constraints: { minVisible: 0.5 } } });

test('each view is counted for how much of a piece it shows, and what stands in front is named', async () => {
  // The critic called a whole roundel "cut off" in four of six cases a person
  // had checked. Whether a piece is whole in a picture this project draws is
  // a count, not an opinion.
  const ed = await fixtureEditor({ kn5: { extraMeshes: [SHIELD] } });
  try {
    const { panels } = JSON.parse((await ed.mcp.callTool('find_panels', { tag: 'left' })).content[0].text);
    const left = panels[0].panel;
    const proposal = { design: [
      { op: 'set-palette', name: 'ink', value: '#101014' },
      plate('plate-clear', left, [0.1, 0.3, 0.3, 0.4]),
      plate('plate-hidden', left, [0.5, 0.3, 0.3, 0.4]),
    ] };
    const r = await ed.mcp.callTool('check_fitment', { proposal });
    assert.ok(!r.isError, r.content[0].text);
    const out = JSON.parse(r.content[0].text);
    assert.ok(out.checked.includes('hidden-in-view'), JSON.stringify(out.checked));
    const by = Object.fromEntries(out.inView.map((m) => [m.id, m]));

    assert.equal(by['plate-clear'].home, 'left', 'held to the view that shows it best');
    assert.equal(by['plate-clear'].whole, true, JSON.stringify(by['plate-clear']));
    assert.equal(by['plate-clear'].views.right, undefined, 'the far side does not count through the car');

    const hidden = by['plate-hidden'];
    assert.equal(hidden.whole, false);
    assert.ok(hidden.visible > 0.1 && hidden.visible < 0.5, JSON.stringify(hidden));
    assert.equal(hidden.hiddenBy, 'MIRROR_L', 'by the mesh, not the texture it shares with the door');

    const found = out.findings.filter((f) => f.kind === 'hidden-in-view');
    assert.deepEqual(found.map((f) => [f.ids[0], f.severity]), [['plate-hidden', 'high']]);
    assert.match(found[0].why, /MIRROR_L, a part painted from the same texture/);

    // Without a proposal this is the editor's panel, which answers while
    // somebody drags and does not pay for the count.
    const plain = JSON.parse((await ed.mcp.callTool('check_fitment', {})).content[0].text);
    assert.equal(plain.inView, undefined);
  } finally {
    await ed.stop();
  }
});

test('a piece with a floor that no view shows enough of to count fails, not passes', async () => {
  // Said as low, which passes a gate: a `minVisible` piece nobody can see in
  // any picture went through as though it had met its floor.
  const ed = await fixtureEditor();
  try {
    const { panels } = JSON.parse((await ed.mcp.callTool('find_panels', { tag: 'left' })).content[0].text);
    const proposal = { design: [
      { op: 'set-palette', name: 'ink', value: '#101014' },
      plate('speck', panels[0].panel, [0.2, 0.5, 0.004, 0.004]),
    ] };
    const out = JSON.parse((await ed.mcp.callTool('check_fitment', { proposal })).content[0].text);
    const found = out.findings.filter((f) => f.kind === 'hidden-in-view');
    assert.deepEqual(found.map((f) => [f.ids[0], f.severity]), [['speck', 'high']], JSON.stringify(out.inView));
    assert.match(found[0].why, /fewer than 30 pixels in every view .*minVisible 0\.5 could not be counted/);
  } finally {
    await ed.stop();
  }
});

test('a "cut off" the count contradicts is overruled, and one it cannot place is not', async () => {
  const ed = await fixtureEditor({ kn5: { extraMeshes: [SHIELD] } });
  try {
    const planner = {
      async round({ call }) {
        const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
        await call('draft_design', { design: [
          { op: 'set-palette', name: 'ink', value: '#101014' },
          plate('plate-clear', panels[0].panel, [0.1, 0.3, 0.3, 0.4]),
        ] });
        await call('finish_round', { summary: 'a plate' });
      },
    };
    const verdict = (cut) => ({ reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
      requirements: [{ asked: 'a plate', present: true, where: 'left door' }], cut_off: cut, unreadable: [], notes: [] });
    const go = async (cut, tag) => {
      const asked = [];
      const lines = [];
      const out = join(ed.dir, tag);
      const result = await run({
        brief: 'a plate', mcp: ed.mcp, planner, critic: { judge: async (a) => { asked.push(a); return verdict(cut); } },
        trace: await createTrace({ dir: out }), out, rounds: 1, views: ['left'], shot: { width: 200, height: 150 },
        closer: [], propose: false, log: (l) => lines.push(l),
      });
      return { result, asked, lines };
    };

    const cleared = await go([{ what: 'the plate', where: 'left view, front edge', id: 'plate-clear' }], 'cleared');
    assert.equal(cleared.result.passed, true, cleared.lines.join('\n'));
    const kept = cleared.result.history[0].critic;
    assert.deepEqual(kept.cut_off, []);
    assert.deepEqual(kept.overruled.map((c) => c.id), ['plate-clear'], 'kept beside the verdict, not thrown away');
    assert.ok(cleared.lines.some((l) => /measured whole, so not cut off: plate-clear/.test(l)), cleared.lines.join('\n'));
    assert.ok(cleared.asked[0].measured.some((m) => m.id === 'plate-clear' && m.whole), 'and the critic was told');
    assert.deepEqual(cleared.result.history[0].fitment.inView.map((m) => m.id), ['plate-clear']);

    // No id, or one the count never measured: nothing to hold it against.
    const upheld = await go([{ what: 'the plate', where: 'left view', id: '' }], 'upheld');
    assert.equal(upheld.result.passed, false);
    assert.equal(upheld.result.history[0].critic.overruled, undefined);
  } finally {
    await ed.stop();
  }
});

test('a critic\'s verdict is scored against what a person said about the same picture', async () => {
  const { score } = await import('../autolivery/cases.mjs');
  const verdict = (over = {}) => ({ reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
    requirements: [{ asked: 'Gulf orange centre stripe', present: true, where: 'top' }, { asked: 'Neon Doll Racing', present: true, where: 'doors' }],
    cut_off: [], unreadable: [], notes: [], ...over });
  assert.deepEqual(score(verdict(), { notCutOff: ['roundel'], present: ['stripe', 'neon'], passes: true }), []);
  assert.match(score(verdict({ cut_off: [{ what: 'number 85 roundel', where: 'left' }] }), { notCutOff: ['roundel'] })[0],
    /called \/roundel\/ cut off/);
  assert.match(score(verdict(), { flagged: ['neon'] })[0], /did not flag/);
  assert.deepEqual(score(verdict({ unreadable: [{ what: 'NEON DOLL RACING', where: 'door', why: 'faint' }] }), { flagged: ['neon'] }), []);
  assert.match(score(verdict(), { missing: ['stripe'] })[0], /did not say \/stripe\/ is missing/);
  assert.match(score(verdict(), { palette_ok: false })[0], /palette_ok true; a person says false/);
  assert.match(score(verdict({ cut_off: [{ what: 'x', where: 'y' }] }), { passes: true })[0], /the gate would fail this/);
  assert.match(score({ error: 'timeout' }, {})[0], /no verdict/);
});

test('find_space returns measured spots on a panel, and refuses a panel that is not there', async () => {
  const ed = await fixtureEditor();
  try {
    const { panels } = JSON.parse((await ed.mcp.callTool('find_panels', { tag: 'left' })).content[0].text);
    const r = await ed.mcp.callTool('find_space', { panel: panels[0].panel, widthMm: 300, marginMm: 50, count: 3 });
    assert.ok(!r.isError, r.content[0].text);
    const s = JSON.parse(r.content[0].text);
    assert.ok(s.candidates.length > 0 && s.candidates.length <= 3, JSON.stringify(s.candidates));
    for (const c of s.candidates) {
      assert.equal(c.at.length, 4);
      assert.ok(c.marginMm >= 50);
      assert.ok(c.onCar >= 0.98 && c.visible >= 0.98, JSON.stringify(c));
    }
    assert.ok(Array.isArray(s.map) && s.map.length > 0);

    // And the limit, rather than a guess: the largest shape of a proportion.
    const big = await ed.mcp.callTool('find_space', { panel: panels[0].panel, largest: true, aspect: 0.8, marginMm: 50 });
    assert.ok(!big.isError, big.content[0].text);
    const L = JSON.parse(big.content[0].text);
    assert.ok(L.largest && L.largest.widthMm > 300, JSON.stringify(L));
    assert.ok(Math.abs(L.largest.heightMm - L.largest.widthMm * 0.8) <= 1, 'in the proportion asked for');
    assert.ok(L.largest.marginMm >= 50 && L.largest.at.length === 4);

    const bad = await ed.mcp.callTool('find_space', { panel: 'no_such_panel', widthMm: 300 });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /No panel called "no_such_panel"/);
  } finally {
    await ed.stop();
  }
});
