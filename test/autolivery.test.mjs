import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startUi } from '../src/ui/server.mjs';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { carKn5, vert, CAR } from './fixtures/kn5.mjs';
import { connect, ServerGone } from '../autolivery/mcp.mjs';
import { existsSync } from 'node:fs';
import { createTrace } from '../autolivery/trace.mjs';
import { run } from '../autolivery/loop.mjs';
import { piecesInView } from '../src/engine/shot.mjs';
import { createPlanner } from '../autolivery/claude.mjs';
import * as local from '../autolivery/openai.mjs';
import { PLANNER_SYSTEM, plannerSystem } from '../autolivery/prompts.mjs';
import { fitment } from '../src/fitment.mjs';
import { createToolHandler } from '../src/mcp/tools.mjs';
import '../src/index.mjs';

const ROOT = process.cwd();

// The whole loop, with no model in it: a real editor on the synthetic car, the
// real `liverykit --mcp` as a subprocess, and a planner and critic that are
// scripts. What is under test is the harness — that the gate is the harness's
// measurement and not the planner's word, and that nothing reaches the editor
// until a draft has passed.
async function fixtureEditor({ kn5 = {}, tweak = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-'));
  const modelPath = join(dir, 'fixture.kn5');
  await writeFile(modelPath, carKn5(kn5));
  const profile = await profileFromKn5(modelPath, { id: 'fixture_car', log: () => {} });
  tweak?.(profile);
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
  const closeEditor = async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  };
  return {
    dir, url, mcp, closeEditor,
    async stop() {
      mcp.close();
      await closeEditor();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const get = async (url, path) => (await fetch(new URL(path, url).href)).json();
const cli = (script, ...args) => new Promise((ok) => execFile(process.execPath,
  [join(ROOT, 'autolivery', script), ...args], (e, stdout, stderr) => ok({ code: e?.code ?? 0, stdout, stderr })));

test('the planner is told to take the number group from find_space\'s layout, which the tool offers', async () => {
  // It was told a recipe to draw inside the largest rectangle of one
  // proportion, and the recipe could not give the NSX door a number that
  // cleared its floor: run 21 spent most of a round finding that out. The
  // layout is measured by the server now; the prompt and the tool must agree
  // on how it is asked for.
  assert.match(PLANNER_SYSTEM, /find_space with \{ panel, layout: \{ number, name \}, marginMm: 30 \}/);
  assert.doesNotMatch(PLANNER_SYSTEM, /aspect 0\.85|55% of the group/, 'and no recipe is left beside it');
  const tools = await createToolHandler({}).listTools();
  const schema = tools.find((t) => t.name === 'find_space').inputSchema.properties;
  assert.deepEqual(schema.layout?.required, ['number', 'name']);
  assert.doesNotMatch(schema.aspect.description, /0\.85/);
});

test('the critic is told a stripe the check measured whole, and only the top of the wing is the stripe', async () => {
  // Run 25's critic and its second look both called the centre stripe
  // missing from the wing, judging its end plates in the side views, while
  // the top view showed it across the wing and the check had measured it
  // there. The planner spent a paid round painting the end plates and the
  // whole deck orange to answer it.
  const { measuredNote } = await import('../autolivery/prompts.mjs');
  const note = measuredNote([], [{ name: 'centre', clean: true }, { name: 'side', clean: false }]);
  assert.match(note, /stripe "centre": its pieces were measured on the car and run nose to tail, and over the top of the rear wing/);
  assert.match(note, /Only the top of the wing is the stripe: its end plates, supports and underside are not/);
  assert.doesNotMatch(note, /stripe "side"/, 'a stripe with a high finding is not vouched for');
  assert.equal(measuredNote([], [{ name: 'side', clean: false }]), null, 'and with nothing measured there is nothing to say');
  assert.equal(measuredNote(null), null);
});

test('a stripe the check could not measure is not vouched for to the critic', async () => {
  // The note tells the critic there is no bare bodywork between the pieces,
  // so a check that could not look at the coverage or a join cannot say so;
  // one that could not tell which way a piece runs says nothing about that,
  // and the RSS4's diagonal cockpit panels would keep every stripe unvouched.
  const { stripesOf } = await import('../autolivery/loop.mjs');
  const design = { surfaces: { body: { regions: [{ id: 'a', constraints: { stripe: 'centre' } }] } } };
  const f = (kind, severity, extra = {}) => ({ kind, severity, stripe: 'centre', ...extra });
  assert.deepEqual(stripesOf(design, []), [{ name: 'centre', clean: true }]);
  assert.deepEqual(stripesOf(design, [f('stripe-across', 'low', { measured: false })]), [{ name: 'centre', clean: true }]);
  assert.deepEqual(stripesOf(design, [f('stripe-gap', 'low', { measured: false })]), [{ name: 'centre', clean: false }]);
  assert.deepEqual(stripesOf(design, [f('stripe-offset', 'low', { measured: false })]), [{ name: 'centre', clean: false }]);
  assert.deepEqual(stripesOf(design, [f('stripe-offset', 'high')]), [{ name: 'centre', clean: false }]);
});

test('the planner is asked for a ground-effect kit and the wheels, and each can be left out', async () => {
  // A Gulf car's centre stripe runs over the top, where trackside barely sees
  // it; its orange splitter, skirts, diffuser and wheels are what carry it in
  // profile. Each is a paragraph a run can drop (--no-aero, --no-wheels) when
  // it costs the demo more time than it earns.
  assert.match(PLANNER_SYSTEM, /find_space with \{ panel: <any panel of the bodywork>, aero: \{ heightMm: 300 \} \}/);
  assert.match(PLANNER_SYSTEM, /a fill on surfaces\.rims/);
  assert.equal(plannerSystem(), PLANNER_SYSTEM);
  const noAero = plannerSystem({ aero: false }), noWheels = plannerSystem({ wheels: false });
  assert.doesNotMatch(noAero, /aero:|ground-effect/);
  assert.match(noAero, /surfaces\.rims/);
  assert.doesNotMatch(noWheels, /surfaces\.rims/);
  assert.match(noWheels, /aero: \{ heightMm: 300 \}/);
  const tools = await createToolHandler({}).listTools();
  assert.deepEqual(tools.find((t) => t.name === 'find_space').inputSchema.properties.aero?.required, ['heightMm']);
});

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
          // Sent as a JSON string wrapped in { design }, as run 26's planner
          // sent its first draft: taken, and the planner told to send the
          // array itself. Refused, it wrote the same draft out again.
          const sent = await call('draft_design', { design: JSON.stringify({ design: [
            { op: 'set-palette', name: 'ink', value: '#101014' },
            { op: 'add-region', surface: 'surfaces.body', region: region([0.3, 0.45, 0.4, 0.005]) },
          ] }) });
          assert.ok(!sent.isError, sent.content[0].text);
          assert.match(sent.content[0].text, /Accepted 2 operation\(s\), sent as a JSON string rather than an array/);
          // A string that is not operations is still refused, and changes nothing.
          const prose = await call('draft_design', { design: 'a number on the left' });
          assert.ok(prose.isError);
          assert.match(prose.content[0].text, /needs a non-empty "design" array/);
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

test('a pass with advice gets a round to act on it, and is offered itself when that round does not pass', async () => {
  // Run 22 passed in round 1 with a name the critic called thin and a stripe
  // it said broke over the roof, and the run ended there: advice failed nothing.
  const ed = await fixtureEditor();
  try {
    const go = async ({ second = null, notes = [['make the number bolder'], []], polish } = {}) => {
      const pending = (await get(ed.url, 'api/proposal')).proposal;
      if (pending) {
        await fetch(new URL('api/proposal/ack', ed.url).href, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: pending.id, status: 'discarded' }) });
      }
      const feedbacks = [];
      let judged = 0;
      const planner = {
        async round({ n, feedback, call }) {
          feedbacks.push(feedback);
          const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
          if (n > 1) return second(call, panels[0].panel);
          await call('reset_draft');
          await call('draft_design', { design: [
            { op: 'set-palette', name: 'ink', value: '#101014' },
            { op: 'add-region', surface: 'surfaces.body', region: { id: 'number-left', treatment: 'text', text: '85',
              panel: panels[0].panel, at: [0.1, 0.3, 0.8, 0.4], color: 'ink' } },
          ] });
          await call('finish_round', { summary: 'a number' });
        },
      };
      const critic = { async judge() {
        return { reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
          notes: notes[judged++] ?? [] };
      } };
      const out = join(ed.dir, `run-${feedbacks.length}-${Math.random().toString(36).slice(2)}`);
      const result = await run({ brief: 'number 85', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: out }),
        out, rounds: 3, views: ['left'], shot: { width: 200, height: 150 }, ...(polish === undefined ? {} : { polish }) });
      return { result, feedbacks, proposal: (await get(ed.url, 'api/proposal')).proposal };
    };

    // The polish passes, and it is what is offered.
    const bolder = await go({ second: async (call) => {
      await call('draft_design', { design: [{ op: 'set-option', id: 'number-left', key: 'weight', value: 900 }] });
      await call('finish_round', { summary: 'bolder' });
    } });
    assert.equal(bolder.result.passedIn, 2);
    assert.deepEqual(bolder.result.polish, { round: 2, passed: true, from: 1 });
    assert.match(bolder.feedbacks[1].text, /make the number bolder/, 'round 2 heard the advice');
    assert.match(bolder.feedbacks[1].text, /polish/);
    assert.equal(bolder.feedbacks[1].ask, 'Polish it');
    assert.deepEqual(bolder.proposal.design, bolder.result.draft.design);
    assert.ok(bolder.result.draft.design.some((o) => o.op === 'set-option'), 'the polished draft');
    assert.match(bolder.proposal.why, /polished in round 2/);
    assert.equal(bolder.result.history[1].polish, true);

    // The polish breaks the number: round 1's draft is offered, measured as it was.
    const broken = await go({ second: async (call, panel) => {
      await call('draft_design', { design: [{ op: 'set-region', id: 'number-left', region: { id: 'number-left',
        treatment: 'text', text: '85', panel, at: [0.3, 0.45, 0.4, 0.005], color: 'ink' } }] });
      await call('finish_round', { summary: 'smaller' });
    } });
    assert.equal(broken.result.passed, true);
    assert.equal(broken.result.passedIn, 1);
    assert.equal(broken.result.rounds, 2, 'the polish round is in the record');
    assert.deepEqual(broken.result.draft.design, broken.result.history[0].draft.design, 'round 1\'s draft, restored');
    assert.deepEqual(broken.proposal.design, broken.result.history[0].draft.design);
    assert.match(broken.proposal.why, /in round 1, every fitment check/, 'the why is round 1\'s, not the polish\'s');
    assert.match(broken.proposal.why, /round 2, was not offered: it did not pass the gate/);

    // A polish the planner cannot finish, the budget spent, keeps the pass.
    const spent = await go({ second: async () => { throw new Error('stopped before another model call: $1.00 spent'); } });
    assert.equal(spent.result.passedIn, 1);
    assert.equal(spent.result.polish.passed, false);
    assert.match(spent.result.polish.why, /could not be finished/);
    assert.deepEqual(spent.proposal?.design, spent.result.history[0].draft.design, 'and it still reaches the inbox');

    // No advice, no polish; and none when it is switched off.
    const quiet = await go({ notes: [[], []] });
    assert.equal(quiet.result.rounds, 1);
    assert.equal(quiet.result.polish, undefined);
    const off = await go({ polish: 0 });
    assert.equal(off.result.rounds, 1);
  } finally {
    await ed.stop();
  }
});

test('every round lands on the attempts page as it is judged, and the page stops reloading when the run ends', async () => {
  const ed = await fixtureEditor();
  try {
    const out = join(ed.dir, 'run');
    const pages = [];
    const planner = {
      async round({ n, call }) {
        // What the page said while this round was being drafted.
        pages.push(await readFile(join(out, 'index.html'), 'utf8'));
        const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
        const at = n === 1 ? [0.3, 0.45, 0.4, 0.005] : [0.1, 0.3, 0.8, 0.4];
        await call('reset_draft');
        await call('draft_design', { design: [
          { op: 'set-palette', name: 'ink', value: '#101014' },
          { op: 'add-region', surface: 'surfaces.body', region: { id: 'number-left', treatment: 'text', text: '85',
            panel: panels[0].panel, at, color: 'ink' } },
        ] });
        await call('finish_round', { summary: n === 1 ? 'a <thin> number' : 'a number big enough to read' });
      },
    };
    const critic = { async judge() {
      return { reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true, notes: [] };
    } };
    const result = await run({
      brief: 'number 85 & a <name>', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: out }),
      out, rounds: 3, views: ['left'], shot: { width: 200, height: 150 },
    });
    assert.equal(result.passedIn, 2);

    assert.match(pages[0], /round 1 of 3 in progress/, 'the page is there before round 1 is judged');
    assert.match(pages[0], /http-equiv="refresh"/, 'and reloads itself while the run goes on');
    assert.match(pages[1], /Round 1 — <span class="fail">failed/, 'round 1 is on it before round 2 is drafted');
    assert.match(pages[1], /unreadable/, 'with why, in the measurement\'s words');

    const done = await readFile(join(out, 'index.html'), 'utf8');
    assert.doesNotMatch(done, /http-equiv="refresh"/, 'a finished run\'s page stops reloading');
    assert.match(done, /passed in round 2/);
    assert.match(done, /in the editor&#39;s inbox/, 'and says where the design went');
    assert.ok(done.indexOf('Round 2') < done.indexOf('Round 1'), 'newest first');
    assert.match(done, /number 85 &amp; a &lt;name&gt;/, 'the brief is escaped');
    assert.match(done, /a &lt;thin&gt; number/, 'and so is the planner\'s summary');
    for (const [, src] of done.matchAll(/<img src="([^"]+)"/g)) {
      assert.ok(existsSync(join(out, decodeURI(src))), `${src} is a picture the gate saved beside the page`);
    }
    assert.equal(existsSync(join(out, 'index.html.partial')), false);
  } finally {
    await ed.stop();
  }
});

test('a replay judges a recorded polish round even when today\'s critic gives the pass no advice', async () => {
  const { createReplayPlanner } = await import('../autolivery/replay.mjs');
  const ed = await fixtureEditor();
  try {
    const { panels } = JSON.parse((await ed.mcp.callTool('find_panels', { tag: 'left' })).content[0].text);
    const number = (weight) => ({ design: [
      { op: 'set-palette', name: 'ink', value: '#101014' },
      { op: 'add-region', surface: 'surfaces.body', region: { id: 'number-left', treatment: 'text', text: '85',
        panel: panels[0].panel, at: [0.1, 0.3, 0.8, 0.4], color: 'ink', weight } },
    ], fit: [] });
    // A run that passed in round 1 and then polished; today's critic is quiet.
    const recording = { rounds: [{ draft: number(700), summary: 'a number' }, { draft: number(900), summary: 'bolder' }] };
    const critic = { async judge() {
      return { reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true, notes: [] };
    } };
    const replay = async (followRecording) => {
      const out = join(ed.dir, `replay-${followRecording}`);
      return run({ brief: 'number 85', mcp: ed.mcp, planner: createReplayPlanner(recording), critic,
        trace: await createTrace({ dir: out }), out, rounds: 2, polish: 2, followRecording, propose: false,
        views: ['left'], shot: { width: 200, height: 150 } });
    };
    const followed = await replay(true);
    assert.equal(followed.rounds, 2, 'the recorded polish round is judged');
    assert.deepEqual(followed.polish, { round: 2, passed: true, from: 1 });
    assert.equal((await replay(false)).rounds, 1, 'a live run with no advice still stops at the pass');

    // A recorded polish today's editor refuses is the replay failing. It was
    // caught as a polish that could not be finished, round 1's pass was put
    // back, and the replay reported passed without judging the polish at all.
    const refusedOut = join(ed.dir, 'replay-refused');
    await assert.rejects(run({ brief: 'number 85', mcp: ed.mcp, critic,
      planner: createReplayPlanner({ rounds: [{ draft: number(700), summary: 'a number' },
        { draft: { design: [{ op: 'no-such-op' }], fit: [] }, summary: 'from an older editor' }] }),
      trace: await createTrace({ dir: refusedOut }), out: refusedOut, rounds: 2, polish: 2, followRecording: true,
      propose: false, views: ['left'], shot: { width: 200, height: 150 } }),
    /round 2: today's editor refuses the recorded draft_design.*no-such-op/);

    // A replay polishes as its run did, so --polish beside it is refused like
    // --rounds. It used to be accepted and replaced by the recorded rounds.
    const recorded = join(ed.dir, 'recorded');
    await mkdir(recorded);
    await writeFile(join(recorded, 'result.json'), JSON.stringify({ brief: 'b', passed: false, history: [
      { draft: number(700), summary: 'a number' }] }));
    const polished = await cli('bin.mjs', '--replay', recorded, '--polish', '0', '--editor', 'http://127.0.0.1:1/');
    assert.equal(polished.code, 1);
    assert.match(polished.stderr, /--polish does not apply to --replay/);
  } finally {
    await ed.stop();
  }
});

test('the attempts page reloads until the run ends, and a run that dies says so on it', async () => {
  const { attemptsPage } = await import('../autolivery/attempts.mjs');
  // Passed, and not finished: a polish round or the proposal is still coming.
  const between = attemptsPage({ brief: 'b', passed: true, passedIn: 1, finished: false,
    history: [{ round: 1, passed: true, gates: { render: 'pass', fitment: 'pass', critic: 'pass' } }] });
  assert.match(between, /http-equiv="refresh"/, 'still reloading after a pass');
  assert.match(between, /still going/);

  const ed = await fixtureEditor();
  try {
    const out = join(ed.dir, 'dies');
    const planner = { async round() { throw new Error('the planner declined: policy'); } };
    const critic = { async judge() { throw new Error('never asked'); } };
    await assert.rejects(run({ brief: 'number 85', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: out }),
      out, rounds: 2, views: ['left'], shot: { width: 200, height: 150 } }), /declined/);
    const left = await readFile(join(out, 'index.html'), 'utf8');
    assert.doesNotMatch(left, /http-equiv="refresh"/, 'a dead run\'s page stops reloading');
    assert.match(left, /stopped: the run ended: the planner declined: policy/);
  } finally {
    await ed.stop();
  }
});

test('both planners are told to polish, not to fix, in a polish round', async () => {
  // The loop test sees the feedback's ask; this is what reaches each model.
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-polish-ask-'));
  const polishing = { text: '{"passed":"Round 1 passed the gate."}', images: [], ask: 'Polish it' };
  try {
    const trace = await createTrace({ dir });
    const call = async () => ({ content: [{ type: 'text', text: 'ok' }] });
    const usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const sent = [];
    const client = { beta: { messages: { create: async (p) => {
      sent.push(structuredClone(p));
      return { id: 'msg', model: 'claude-opus-5', stop_reason: 'tool_use', usage,
        content: [{ type: 'tool_use', id: 'u1', name: 'finish_round', input: { summary: 'polished' } }] };
    } } } };
    await createPlanner({ client, model: 'claude-opus-5', effort: 'high', trace, fallback: false })
      .round({ n: 2, rounds: 3, brief: 'b', feedback: polishing, tools: [], call });
    const claudeSaw = sent[0].messages.at(-1).content.map((b) => b.text ?? '').join('\n');
    assert.match(claudeSaw, /Round 2 of 3\. Polish it, then finish_round\./);
    assert.doesNotMatch(claudeSaw, /Fix what the gate named/);

    const { fetchImpl, sent: asked } = fakeServer({ vision: true, replies: [calls(['q1', 'finish_round', { summary: 'polished' }])] });
    const endpoint = await local.connectEndpoint({ baseUrl: 'http://fake/v1', fetchImpl });
    await local.createPlanner({ endpoint, model: 'local-model', trace })
      .round({ n: 2, rounds: 3, brief: 'b', feedback: polishing, tools: [], call });
    const localSaw = asked.at(-1).messages.at(-1).content.map((p) => p.text ?? '').join('\n');
    assert.match(localSaw, /Round 2 of 3\. Polish it, then finish_round\./);
    assert.doesNotMatch(localSaw, /Fix what the gate named/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the attempts page says how a run ended, whichever way it ended', async () => {
  const { attemptsPage } = await import('../autolivery/attempts.mjs');
  const pass = { round: 1, passed: true, gates: { render: 'pass', fitment: 'pass', critic: 'pass' } };

  // Passed and still going promises nothing: a polish round follows a pass
  // only when polish is on and the critic gave advice.
  const going = attemptsPage({ brief: 'b', passed: true, passedIn: 1, finished: false, history: [pass] });
  assert.match(going, /the run is still going/);
  assert.doesNotMatch(going, /a polish round/);

  // Died after the pass, in the proposal: stopped comes first, and says the
  // pass never reached the inbox.
  const died = attemptsPage({ brief: 'b', passed: true, passedIn: 1, finished: false, history: [pass],
    stopped: 'the run ended: the liverykit MCP server exited' });
  assert.match(died, /stopped: the run ended: the liverykit MCP server exited \(round 1 had passed; nothing reached the inbox\)/);
  assert.doesNotMatch(died, /http-equiv="refresh"/);

  // A round the second look decided shows the pictures it judged.
  const closer = attemptsPage({ brief: 'b', passed: true, passedIn: 1, finished: true, history: [{
    ...pass, renders: ['/run/round-1-sheet.png'], closer: ['/run/round-1-closer-left.png'],
    critic: { reads_at_distance: false, notes: [] }, secondLook: { reads_at_distance: true, notes: [] } }] });
  const second = closer.slice(closer.indexOf('second look, closer'));
  assert.match(second, /<img src="round-1-closer-left\.png"/, 'beside the verdict given on it');

  // A server that dies at the very first call still leaves a page that ends.
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-first-call-'));
  try {
    const out = join(dir, 'run');
    const mcp = { async listTools() { throw new ServerGone('the liverykit MCP server exited'); } };
    await assert.rejects(run({ brief: 'number 85', mcp, planner: {}, critic: {}, trace: await createTrace({ dir: out }), out }),
      /exited/);
    const left = await readFile(join(out, 'index.html'), 'utf8');
    assert.match(left, /stopped: the run ended: the liverykit MCP server exited/);
    assert.doesNotMatch(left, /http-equiv="refresh"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finish_round needs a summary, and is never refused for the call limit it is the way out of', async () => {
  // Past the limit, every call was refused with "call finish_round now",
  // finish_round included, so the round could never end. And a finish_round
  // with no summary was accepted, and the inbox got the last round's words.
  const ed = await fixtureEditor();
  try {
    const said = [];
    const planner = { async round({ call }) {
      for (let i = 0; i < 3; i++) said.push(await call('describe_car'));
      said.push(await call('finish_round', {}));
      said.push(await call('finish_round', { summary: 'a bare car' }));
      return { summary: 'a bare car' };
    } };
    const critic = { judge: async () => ({ reads_at_distance: true, number_legible: true, palette_ok: true,
      matches_brief: true, requirements: [], cut_off: [], notes: [] }) };
    const out = join(ed.dir, 'run');
    await run({ brief: 'b', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: out }), out,
      rounds: 1, roundCalls: 2, views: ['left'], shot: { width: 200, height: 150 }, propose: false });
    assert.match(said[2].content[0].text, /used its 2 tool calls/);
    assert.ok(said[3].isError);
    assert.match(said[3].content[0].text, /finish_round needs a summary/);
    assert.ok(!said[4].isError, said[4].content[0].text);
  } finally {
    await ed.stop();
  }
});

test('a dead MCP server ends the run at once, and the rounds before it are on disk whole', async () => {
  // `traced` turned every error into a refusal, so once the liverykit --mcp
  // child exited, every call after it was "refused" and the planner kept
  // paying for turns. And result.json was written only at the end, while the
  // trace clipped each draft to 2000 characters: a crash lost the run, and the
  // trace could not stand in for it.
  const ed = await fixtureEditor();
  try {
    const asked = [];
    let afterDeath = 0;
    const palette = Array.from({ length: 60 }, (_, i) => ({ op: 'set-palette', name: `c${i}`, value: '#101014' }));
    const planner = {
      async round({ n, call }) {
        asked.push(n);
        if (n === 1) {
          await call('draft_design', { design: palette });
          await call('finish_round', { summary: 'a palette' });
          return;
        }
        ed.mcp.close();
        await new Promise((ok) => setTimeout(ok, 300));
        afterDeath++;
        await call('check_fitment');
        afterDeath++;
      },
    };
    const critic = { async judge() {
      return { reads_at_distance: false, number_legible: false, palette_ok: true, matches_brief: false, notes: ['nothing yet'] };
    } };
    const out = join(ed.dir, 'run');
    const trace = await createTrace({ dir: out });
    await assert.rejects(run({ brief: 'b', mcp: ed.mcp, planner, critic, trace, out, rounds: 4,
      views: ['left'], shot: { width: 200, height: 150 }, base: 'b1' }), /MCP server exited/);
    assert.deepEqual(asked, [1, 2], 'the planner is not asked again');
    assert.equal(afterDeath, 1, 'and its one call after the server died was its last');

    const saved = JSON.parse(await readFile(join(out, 'result.json'), 'utf8'));
    assert.equal(saved.finished, false);
    assert.equal(saved.rounds, 1);
    assert.equal(saved.draft.design.length, 60, 'the draft round 1 ended with is on disk');
    assert.equal(saved.base, 'b1', 'with the design it was written against');
    assert.equal(existsSync(join(out, 'result.json.partial')), false, 'renamed into place, not written over it');

    const spans = (await readFile(join(out, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const drafted = spans.find((s) => s.name === 'draft_design');
    assert.deepEqual(drafted.attrs['tool.parameters'], { design: palette }, 'and the trace keeps the draft whole');
  } finally {
    await ed.stop();
  }
});

test('an editor that stops answering ends the run at once, like a dead MCP server', async () => {
  // Only the MCP child dying was fatal. With the editor gone and the child
  // alive, every tool answered "No fitting editor is listening" as an
  // ordinary tool error, which reached the planner as a refusal, and the
  // planner went on paying for turns against an editor that was not there.
  const ed = await fixtureEditor();
  try {
    const asked = [];
    let afterDeath = 0;
    const planner = {
      async round({ n, call }) {
        asked.push(n);
        if (n === 1) {
          await call('draft_design', { design: [{ op: 'set-palette', name: 'ink', value: '#101014' }] });
          await call('finish_round', { summary: 'a palette' });
          return;
        }
        await ed.closeEditor();
        afterDeath++;
        await call('check_fitment');
        afterDeath++;
      },
    };
    const critic = { async judge() {
      return { reads_at_distance: false, number_legible: false, palette_ok: true, matches_brief: false, notes: ['nothing yet'] };
    } };
    const out = join(ed.dir, 'run');
    await assert.rejects(run({ brief: 'b', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: out }), out,
      rounds: 4, views: ['left'], shot: { width: 200, height: 150 } }),
    (e) => e instanceof ServerGone && /No fitting editor is listening/.test(e.message));
    assert.deepEqual(asked, [1, 2], 'the planner is not asked again');
    assert.equal(afterDeath, 1, 'and its one call after the editor stopped was its last');
    assert.equal(JSON.parse(await readFile(join(out, 'result.json'), 'utf8')).rounds, 1, 'round 1 is on disk');
  } finally {
    await ed.stop();
  }
});

test('a save that fails partway leaves the last round\'s result.json whole', async () => {
  // Written in place, a write cut short by a crash or a full disk left half a
  // file where the last round's had been, and nothing could replay or propose
  // it. The writer is the injected part, so a save that wrote result.json
  // directly would be cut short here too.
  const ed = await fixtureEditor();
  try {
    let saves = 0;
    const write = async (path, text) => {
      if (++saves === 1) return writeFile(path, text);
      await writeFile(path, text.slice(0, text.length >> 1));
      throw new Error('no space left on device');
    };
    const planner = { async round({ n, call }) {
      await call('draft_design', { design: [{ op: 'set-palette', name: `c${n}`, value: '#101014' }] });
      await call('finish_round', { summary: `round ${n}` });
    } };
    const critic = { async judge() {
      return { reads_at_distance: false, number_legible: false, palette_ok: true, matches_brief: false, notes: ['not yet'] };
    } };
    const out = join(ed.dir, 'run');
    await assert.rejects(run({ brief: 'b', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: out }), out,
      rounds: 3, views: ['left'], shot: { width: 200, height: 150 }, write }), /no space left on device/);
    assert.equal(saves, 2);
    const saved = JSON.parse(await readFile(join(out, 'result.json'), 'utf8'));
    assert.equal(saved.rounds, 1, 'round 1\'s result.json, whole');
  } finally {
    await ed.stop();
  }
});


test('a call after close() is the server gone, not a write to a closed pipe', async () => {
  const ed = await fixtureEditor();
  try {
    ed.mcp.close();
    await assert.rejects(ed.mcp.callTool('describe_car'), (e) => e instanceof ServerGone);
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

test('a stripe that failed cannot be undeclared to pass', async () => {
  // Run 19 painted its Gulf stripe across the roof. Declared, that fails the
  // round; letting go of `stripe` the next round gets out of the check as
  // surely as letting go of groupWith gets out of the group.
  const ed = await fixtureEditor();
  try {
    const planner = {
      async round({ n, call }) {
        if (n === 1) {
          const { panels } = JSON.parse((await call('find_panels', { tag: 'centre' })).content[0].text);
          const roof = panels.find((p) => p.axes?.x === 'across the car' && p.axes?.y === 'along the car').panel;
          await call('draft_design', { design: [
            { op: 'set-palette', name: 'orange', value: '#F0611A' },
            // Across the car: the whole of x, which runs across it, and a
            // fifth of y, which runs along it.
            { op: 'add-region', surface: 'surfaces.body', region: {
              id: 'stripe-roof', treatment: 'stripe', panel: roof, at: [0, 0.4, 1, 0.2], color: 'orange',
              constraints: { stripe: 'centre' } } },
          ] });
        } else {
          await call('draft_design', { design: [{ op: 'set-constraint', id: 'stripe-roof', key: 'stripe', value: null }] });
        }
        await call('finish_round', { summary: `round ${n}` });
      },
    };
    const critic = { judge: async () => ({ reads_at_distance: true, number_legible: true, palette_ok: true,
      matches_brief: true, requirements: [{ asked: 'an orange stripe', present: true, where: 'roof' }],
      cut_off: [], unreadable: [], notes: [] }) };
    const result = await run({
      brief: 'an orange stripe', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: join(ed.dir, 'run') }),
      out: join(ed.dir, 'run'), rounds: 2, views: ['left'], shot: { width: 200, height: 150 }, propose: false,
    });
    assert.ok(result.history[0].failures.some((f) => /high stripe-across: stripe-roof is part of the stripe "centre"/.test(f)),
      JSON.stringify(result.history[0].failures));
    assert.equal(result.history[1].passed, false);
    assert.ok(result.history[1].failures.some((f) => /stripe-roof: stripe removed after it failed round 1/.test(f)),
      JSON.stringify(result.history[1].failures));
  } finally {
    await ed.stop();
  }
});

test('text on a panel the profile cannot measure can pass, and is said to be unmeasured', async () => {
  // RSS4's helmet has no metresPerUv, so a driver name on it was two
  // notChecked entries, and the gate failed any round that had one. Nothing a
  // planner drafts gives a panel a scale, so no round could pass. Here the
  // left panels have no scale, and the round's one real fault is the draft's.
  const ed = await fixtureEditor({ tweak: (p) => {
    for (const panels of Object.values(p.panels ?? {})) {
      for (const pan of Object.values(panels)) if (pan.tags?.includes('left')) delete pan.metresPerUv;
    }
  } });
  try {
    const feedbacks = [];
    const planner = {
      async round({ n, feedback, call }) {
        feedbacks.push(feedback);
        const side = async (tag) => JSON.parse((await call('find_panels', { tag })).content[0].text).panels[0].panel;
        if (n === 1) {
          const [left, right] = [await side('left'), await side('right')];
          await call('draft_design', { design: [
            { op: 'set-palette', name: 'ink', value: '#101014' },
            { op: 'set-identity', key: 'driver', value: 'Ada Vance' },
            { op: 'add-region', surface: 'surfaces.body', region: {
              id: 'driver-left', treatment: 'text', text: '{driver}', panel: left, at: [0.1, 0.3, 0.8, 0.4], color: 'ink' } },
            { op: 'add-region', surface: 'surfaces.body', region: {
              id: 'sponsor-right', treatment: 'text', text: 'ACME', panel: right, at: [0.3, 0.45, 0.4, 0.02], color: 'ink',
              constraints: { minMm: 100 } } },
          ] });
        } else {
          await call('draft_design', { design: [{ op: 'remove-region', id: 'sponsor-right' }] });
        }
        await call('finish_round', { summary: `round ${n}` });
      },
    };
    const critic = { judge: async () => ({ reads_at_distance: true, number_legible: true, palette_ok: true,
      matches_brief: true, requirements: [{ asked: 'driver Ada Vance', present: true, where: 'left door' }],
      cut_off: [], unreadable: [], notes: [] }) };
    const result = await run({
      brief: 'driver Ada Vance', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: join(ed.dir, 'run') }),
      out: join(ed.dir, 'run'), rounds: 2, views: ['left'], shot: { width: 200, height: 150 },
    });

    assert.equal(result.passedIn, 2, JSON.stringify(result.history.map((h) => h.failures), null, 2));
    assert.ok(result.history[0].failures.some((f) => /high unreadable: .*sponsor-right/.test(f)), JSON.stringify(result.history[0].failures));
    assert.ok(!result.history[0].failures.some((f) => /driver-left/.test(f)),
      `round 1 failed for what the draft did, not for what the profile cannot measure: ${JSON.stringify(result.history[0].failures)}`);

    // Said everywhere a person or the planner reads, so passing is not silence.
    for (const h of result.history) {
      assert.deepEqual(h.fitment.unsupported.map((u) => u.check).sort(), ['too-small', 'unreadable'], JSON.stringify(h.fitment));
    }
    assert.match(feedbacks[1].text, /driver-left[^\n]*no measured scale/, 'the planner heard what could not be measured');
    const { proposal } = await get(ed.url, 'api/proposal');
    assert.equal(proposal?.id, result.proposalId);
    assert.match(proposal.why, /not measured, because this car's profile cannot/i);
    assert.match(proposal.why, /driver-left/);
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
    assert.equal(cleared.result.history[0].closer?.length, 2, 'the pictures the second look judged are in the record');
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

    // Nor when the critic is advisory: its verdict gates nothing, and the
    // second look is a paid call that would decide nothing either.
    const idleReferee = judging({ ...flagged, cut_off: [] });
    const advisoryOut = join(ed.dir, 'advisory');
    const advisory = await run({
      brief: 'number 85', mcp: ed.mcp, planner: drafting, critic: judging(flagged), referee: idleReferee,
      trace: await createTrace({ dir: advisoryOut }), out: advisoryOut, rounds: 1, views: ['left'],
      shot: { width: 200, height: 150 }, closeShot: { width: 200, height: 150 }, propose: false, criticGates: false,
    });
    assert.equal(advisory.passed, true, 'fitment alone decides');
    assert.equal(idleReferee.asked.length, 0);
    assert.equal(advisory.history[0].secondLook, undefined);
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

// A draft that measures clean on the fixture car: a big number on the left.
const drafting = (count = { rounds: 0 }, beforeFinish = async () => {}) => ({
  async round({ call }) {
    count.rounds++;
    const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
    await call('draft_design', { design: [
      { op: 'set-palette', name: 'ink', value: '#101014' },
      { op: 'add-region', surface: 'surfaces.body', region: {
        id: 'number-left', treatment: 'text', text: '85', panel: panels[0].panel, at: [0.1, 0.3, 0.8, 0.4], color: 'ink' } },
    ] });
    await beforeFinish(call);
    await call('finish_round', { summary: 'a number' });
  },
});

test('a critic that could not judge ends the run, rather than sending the planner round again with nothing to fix', async () => {
  // A critic that threw failed the round with an empty mustFix, since there
  // is nothing in an error to list, and the planner was paid for another
  // round told to fix what the gate named. A gate given no views at all did
  // the same, with no picture for the critic to be asked about.
  const ed = await fixtureEditor();
  try {
    const broken = { judge: async () => { throw new Error("the critic's verdict was not JSON: I think it looks good"); } };
    const go = async (tag, opts) => {
      const count = { rounds: 0 };
      const lines = [];
      const out = join(ed.dir, tag);
      const result = await run({
        brief: 'number 85', mcp: ed.mcp, planner: drafting(count), critic: broken, trace: await createTrace({ dir: out }),
        out, rounds: 3, views: ['left'], shot: { width: 200, height: 150 }, propose: false, log: (l) => lines.push(l), ...opts,
      });
      return { result, lines, count, out };
    };

    const threw = await go('threw', {});
    assert.equal(threw.count.rounds, 1, 'no second round was asked for');
    assert.equal(threw.result.passed, false);
    assert.match(threw.result.stopped, /the critic could not judge round 1.*not JSON: I think it looks good/);
    assert.equal(threw.result.history[0].gates.critic, 'could not judge');
    assert.ok(threw.lines.some((l) => /stopped: the critic could not judge round 1/.test(l)), threw.lines.join('\n'));
    const saved = JSON.parse(await readFile(join(threw.out, 'result.json'), 'utf8'));
    assert.equal(saved.stopped, threw.result.stopped, 'and result.json says why');

    const blind = await go('blind', { views: [] });
    assert.equal(blind.count.rounds, 1);
    assert.match(blind.result.stopped, /the critic could not judge round 1: it was given no views/);

    // Advisory, it gates nothing, so the round is not failed on it; but it is said.
    const advisory = await go('advisory', { criticGates: false, propose: true });
    assert.equal(advisory.result.passed, true, advisory.lines.join('\n'));
    assert.equal(advisory.result.history[0].gates.critic, 'could not judge (advisory)');
    assert.ok(advisory.lines.some((l) => /critic COULD NOT JUDGE \(advisory\) \(the critic's verdict was not JSON/.test(l)),
      advisory.lines.join('\n'));
    const { proposal } = await get(ed.url, 'api/proposal');
    assert.match(proposal.why, /The critic, which was advisory, could not judge it: the critic's verdict was not JSON/);
  } finally {
    await ed.stop();
  }
});

test('a refused look costs no look, and a gate render that fails is the render failing, not fitment', async () => {
  // A mistyped view was refused and still used up one of the round's looks.
  // And a view the gate could not render was recorded as fitment failing, on
  // a draft that had measured clean.
  const ed = await fixtureEditor();
  try {
    const looked = [];
    const planner = drafting(undefined, async (call) => {
      looked.push(await call('render_car', { view: 'lfet' }));
      for (let i = 0; i < 2; i++) looked.push(await call('render_car', { view: 'left' }));
    });
    const critic = { judge: async () => ({ reads_at_distance: true, number_legible: true, palette_ok: true,
      matches_brief: true, requirements: [{ asked: 'number 85', present: true, where: 'left door' }], cut_off: [],
      unreadable: [], notes: [] }) };
    const lines = [];
    const result = await run({
      brief: 'number 85', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: join(ed.dir, 'run') }),
      out: join(ed.dir, 'run'), rounds: 1, views: ['left', 'lfet'], shot: { width: 200, height: 150 }, looks: 2,
      propose: false, log: (l) => lines.push(l),
    });
    assert.deepEqual(looked.map((r) => Boolean(r.isError)), [true, false, false],
      looked.map((r) => r.content[0].text ?? '[image]').join('\n'));

    const [round] = result.history;
    assert.equal(round.gates.fitment, 'pass', 'the draft measured clean');
    assert.equal(round.gates.render, 'fail');
    assert.equal(round.passed, false, 'a view the gate could not render still fails the round');
    assert.ok(round.failures.some((f) => /the lfet render failed/.test(f)), JSON.stringify(round.failures));
    assert.ok(lines.some((l) => /render FAIL \(the lfet render failed/.test(l) && /fitment PASS/.test(l)), lines.join('\n'));
  } finally {
    await ed.stop();
  }
});

test('an empty list of views is refused before anything starts', async () => {
  // `--views ,` split to nothing: no render, so the critic was never asked,
  // and a gate that needs its verdict could not pass a single round.
  const { spawnSync } = await import('node:child_process');
  const out = await mkdtemp(join(tmpdir(), 'autolivery-views-'));
  try {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.AGENTOPS_API_KEY;
    // A local backend on a port nothing listens on: whatever happens, nothing is paid for.
    const r = spawnSync(process.execPath, [join(ROOT, 'autolivery/bin.mjs'), 'number 85', '--views', ' , ',
      '--backend', 'openai', '--base-url', 'http://127.0.0.1:1/v1', '--out', out], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--views names no view/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('a round that ends without finish_round is not gated, and its prose is never a summary', async () => {
  // A planner that ran out of turns handed back its last prose, and the loop
  // took it as the summary and gated the round: a draft could reach the inbox
  // under "Let me check fitment once more", and the critic judged against it.
  const ed = await fixtureEditor();
  try {
    const feedbacks = [];
    const planner = {
      async round({ n, feedback, call }) {
        feedbacks.push(feedback);
        if (n === 1) {
          const { panels } = JSON.parse((await call('find_panels', { tag: 'left' })).content[0].text);
          await call('draft_design', { design: [
            { op: 'set-palette', name: 'ink', value: '#101014' },
            { op: 'add-region', surface: 'surfaces.body', region: {
              id: 'number-left', treatment: 'text', text: '85', panel: panels[0].panel,
              at: [0.3, 0.45, 0.4, 0.02], color: 'ink', constraints: { minMm: 100 } } },
          ] });
          await call('finish_round', { summary: 'round 1' });
          return { summary: 'round 1' };
        }
        if (n === 2) {
          await call('check_fitment');
          return { said: 'Let me check fitment once more…' };
        }
        await call('draft_design', { design: [{ op: 'set-constraint', id: 'number-left', key: 'minMm', value: 10 }] });
        await call('finish_round', { summary: 'round 3' });
        return { summary: 'round 3' };
      },
    };
    const judged = [];
    const critic = { judge: async ({ summary }) => {
      judged.push(summary);
      return { reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
        requirements: [{ asked: 'number 85', present: true, where: 'left door' }], cut_off: [], unreadable: [], notes: [] };
    } };
    const out = join(ed.dir, 'run');
    const lines = [];
    const result = await run({
      brief: 'number 85', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: out }), out,
      rounds: 3, views: ['left'], shot: { width: 200, height: 150 }, log: (l) => lines.push(l),
    });

    assert.deepEqual(judged, ['round 1', 'round 3'], 'the critic judged only what was submitted, by its own summary');
    const [, skipped, third] = result.history;
    assert.equal(skipped.submitted, false);
    assert.equal(skipped.passed, false);
    assert.equal(skipped.said, 'Let me check fitment once more…', 'what it said is kept, as what it said');
    assert.equal(skipped.critic, undefined);
    assert.ok(lines.some((l) => /round 2 ended without finish_round/.test(l)), lines.join('\n'));
    assert.equal(feedbacks[2].submitted, false);
    assert.match(feedbacks[2].text, /Round 2 ended without finish_round/);
    assert.match(feedbacks[2].design, /number-left/, 'and the draft as it stands comes with it');
    // The constraint that failed round 1 is still held to it after a round the gate never saw.
    assert.ok(third.failures.some((f) => /minMm lowered from 100 to 10 after it failed round 1/.test(f)),
      JSON.stringify(third.failures));
    assert.equal(result.summary, 'round 3');

    const spans = (await readFile(join(out, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(spans.filter((s) => s.kind === 'task' && s.name === 'gate').length, 2);
    const two = spans.find((s) => s.name === 'round-2');
    assert.equal(two.attrs['round.submitted'], false);
    assert.match(two.attrs['round.said'], /Let me check fitment once more/);
  } finally {
    await ed.stop();
  }
});

test('a planner that never calls finish_round hands back what it said, not a summary, and hears so next round', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-unsubmitted-'));
  const notice = { submitted: false, text: 'Round 1 ended without finish_round, so nothing was gated.', images: [],
    design: '{"surfaces":{"body":{"regions":[{"id":"base-fill","treatment":"fill"}]}}}' };
  try {
    const trace = await createTrace({ dir });
    const call = async () => ({ content: [{ type: 'text', text: 'ok' }] });

    const usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const reply = (content, stop_reason) => ({ id: 'msg', model: 'claude-opus-5', content, stop_reason, usage });
    const script = [
      reply([{ type: 'text', text: 'Let me check fitment once more…' }], 'end_turn'),
      reply([{ type: 'text', text: 'Let me check fitment once more…' }], 'end_turn'),
      reply([{ type: 'tool_use', id: 'u1', name: 'finish_round', input: { summary: 'done' } }], 'tool_use'),
    ];
    const sent = [];
    const client = { beta: { messages: { create: async (p) => { sent.push(structuredClone(p)); return script.shift(); } } } };
    const claude = createPlanner({ client, model: 'claude-opus-5', effort: 'high', trace, fallback: false, maxNudges: 1 });
    const one = await claude.round({ n: 1, rounds: 2, brief: 'b', feedback: null, tools: [], call });
    assert.equal(one.summary, null);
    assert.equal(one.said, 'Let me check fitment once more…');
    await claude.round({ n: 2, rounds: 2, brief: 'b', feedback: notice, tools: [], call });
    const opening = sent[2].messages.at(-1).content.map((b) => b.text ?? '').join('\n');
    assert.match(opening, /Round 1 ended without finish_round/);
    assert.doesNotMatch(opening, /verdict on round 1|Fix what the gate named/);

    const { fetchImpl, sent: asked } = fakeServer({ vision: true, replies: [
      words('thinking about it'), words('thinking about it'), calls(['q1', 'finish_round', { summary: 'done' }]),
    ] });
    const endpoint = await local.connectEndpoint({ baseUrl: 'http://fake/v1', fetchImpl });
    const openai = local.createPlanner({ endpoint, model: 'local-model', trace, maxNudges: 1 });
    const first = await openai.round({ n: 1, rounds: 2, brief: 'b', feedback: null, tools: [], call });
    assert.equal(first.summary, null);
    assert.equal(first.said, 'thinking about it');
    await openai.round({ n: 2, rounds: 2, brief: 'b', feedback: notice, tools: [], call });
    const fresh = asked[2].messages.at(-1).content.map((p) => p.text ?? '').join('\n');
    assert.doesNotMatch(fresh, /you said: thinking about it/, 'prose is never passed off as a summary');
    assert.match(fresh, /Round 1 ended without finish_round/);
    assert.match(fresh, /"id":"base-fill"/);
    assert.doesNotMatch(fresh, /verdict on round 1|Fix what the gate named/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a local critic cut off by its token limit says so, and names the limit', async () => {
  // A thinking model spent the critic's 2048 tokens reasoning, and all the
  // run said was that the verdict was not JSON, which sent somebody looking
  // at the prompt rather than at the limit.
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-critic-limit-'));
  try {
    const cut = () => {
      const r = words('{"reads_at_distance": true, "number_');
      r.choices[0].finish_reason = 'length';
      return r;
    };
    const { fetchImpl, sent } = fakeServer({ vision: true, replies: [cut(), cut()] });
    const endpoint = await local.connectEndpoint({ baseUrl: 'http://fake/v1', fetchImpl });
    const trace = await createTrace({ dir });
    const ask = (opts) => local.createCritic({ endpoint, model: 'local-model', trace, ...opts })
      .judge({ brief: 'b', summary: 's', images: [{ view: 'left', data: 'CCCC' }] });
    await assert.rejects(ask({}), /cut off at its 8192-token limit/);
    assert.equal(sent[0].max_tokens, 8192, 'more than the 2048 a thinking model ran out of');
    await assert.rejects(ask({ maxTokens: 20000 }), /cut off at its 20000-token limit.*--critic-max-tokens/);
    assert.equal(sent[1].max_tokens, 20000);

    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [join(ROOT, 'autolivery/bin.mjs'), 'number 85', '--critic-max-tokens', 'lots',
      '--backend', 'openai', '--base-url', 'http://127.0.0.1:1/v1', '--out', dir], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--critic-max-tokens must be a whole number above zero, not lots/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the MCP client says what it could not read, and gives up on a reply that never comes', async () => {
  // A line that did not parse was dropped without a word, and so was a reply
  // to a request nobody made, and a request has no time limit: a garbled
  // answer left its request waiting for ever, and the run hung saying nothing.
  const server = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const m = JSON.parse(line);
      const say = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
      if (m.method === 'initialize') say({ id: m.id, result: {} });
      if (m.method === 'tools/list') {
        process.stdout.write('this is not JSON\\n');
        process.stdout.write('null\\n');
        say({ id: 999, result: {} });
        say({ id: m.id, result: { tools: [] } });
      }
      // tools/call is never answered.
    });`;
  const warned = [];
  const mcp = await connect({ args: ['-e', server], warn: (m) => warned.push(m), timeoutMs: 300 });
  try {
    assert.deepEqual(await mcp.listTools(), []);
    assert.ok(warned.some((w) => /not JSON-RPC.*this is not JSON/.test(w)), warned.join('\n'));
    assert.ok(warned.some((w) => /not JSON-RPC.*null/.test(w)), warned.join('\n'));
    assert.ok(warned.some((w) => /request 999, which nothing is waiting for/.test(w)), warned.join('\n'));
    // Stuck is gone, as an exited server is: handed to the planner as a refusal
    // it kept the run paying, and each call after it waited as long again.
    const stuck = await mcp.callTool('render_car', { view: 'left' }).catch((e) => e);
    assert.ok(stuck instanceof ServerGone, `a server that stops answering ends the run: ${stuck}`);
    assert.match(stuck.message, /MCP tools\/call render_car: no reply after 0\.3 s/);
    const t0 = Date.now();
    await assert.rejects(mcp.callTool('find_panels', {}), (e) => e instanceof ServerGone);
    assert.ok(Date.now() - t0 < 200, 'and the next call fails at once, not after another wait');
  } finally {
    mcp.close();
  }
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

    // And the number group laid out whole, as regions ready to use.
    const lay = await ed.mcp.callTool('find_space', { panel: panels[0].panel, layout: { number: '85', name: 'GULF' } });
    assert.ok(!lay.isError, lay.content[0].text);
    const G = JSON.parse(lay.content[0].text);
    assert.equal(G.layout?.regions.roundel.treatment, 'ring', JSON.stringify(G));
    assert.equal(G.layout.regions.number.text, '85');
    assert.deepEqual(G.layout.regions.name.map((r) => r.text), ['GULF']);
    assert.ok(G.layout.marginMm >= 30, 'at the margin a layout defaults to');
    // Two questions at once is refused, not half answered.
    const mixed = await ed.mcp.callTool('find_space', { panel: panels[0].panel, largest: true, layout: { number: '8', name: 'G' } });
    assert.ok(mixed.isError);
    assert.match(mixed.content[0].text, /without largest, widthMm or heightMm/);
    // A height alone is a size too, and was dropped without a word.
    const tall = await ed.mcp.callTool('find_space', { panel: panels[0].panel, heightMm: 200, layout: { number: '8', name: 'G' } });
    assert.ok(tall.isError, tall.content[0].text);

    // And a stripe along the car, as regions ready to use, which the planner
    // is told to take rather than work out: on this car the roof is the only
    // panel seen from above, across it in x and 1.9 m wide.
    assert.match(PLANNER_SYSTEM, /find_space with \{ panel: <any panel of the bodywork>, stripe: \{ widthMm, offsetMm \} \}/);
    const roof = JSON.parse((await ed.mcp.callTool('find_panels', { tag: 'centre' })).content[0].text).panels
      .find((p) => p.axes?.y === 'along the car').panel;
    const laid = await ed.mcp.callTool('find_space', { panel: roof, stripe: { widthMm: 300 } });
    assert.ok(!laid.isError, laid.content[0].text);
    const S = JSON.parse(laid.content[0].text);
    assert.deepEqual(S.regions.map((r) => [r.panel, r.constraints]), [[roof, { stripe: 'centre' }]], JSON.stringify(S));
    assert.ok(S.regions[0].at.every((v, i) => Math.abs(v - [0.4211, 0, 0.1579, 1][i]) <= 0.01), JSON.stringify(S.regions[0]));
    assert.deepEqual(S.findings, []);
    const both = await ed.mcp.callTool('find_space', { panel: roof, widthMm: 300, stripe: { widthMm: 300 } });
    assert.ok(both.isError);
    assert.match(both.content[0].text, /without layout, largest, widthMm or heightMm/);
    // heightMm alone, which a stripe answered as though it had not been sent.
    const tallStripe = await ed.mcp.callTool('find_space', { panel: roof, heightMm: 300, stripe: { widthMm: 300 } });
    assert.ok(tallStripe.isError, tallStripe.content[0].text);
    assert.match(tallStripe.content[0].text, /without layout, largest, widthMm or heightMm/);
    // A ground-effect kit is its own question too, and one beside a stripe is refused.
    const kit = await ed.mcp.callTool('find_space', { panel: roof, aero: { heightMm: 300 } });
    assert.ok(!kit.isError, kit.content[0].text);
    assert.ok(Array.isArray(JSON.parse(kit.content[0].text).regions));
    const kitAndStripe = await ed.mcp.callTool('find_space', { panel: roof, aero: { heightMm: 300 }, stripe: { widthMm: 300 } });
    assert.ok(kitAndStripe.isError);
    assert.match(kitAndStripe.content[0].text, /without stripe, layout, largest, widthMm or heightMm/);

    const bad = await ed.mcp.callTool('find_space', { panel: 'no_such_panel', widthMm: 300 });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /No panel called "no_such_panel"/);
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
      out: join(ed.dir, tag), rounds, views: ['left'], shot: { width: 200, height: 150 }, propose: false, base: 'b1',
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

    // A run records the working design it started from, and a replay in front
    // of another one replays different operations, so it is refused.
    assert.equal(original.base, 'b1');
    const moved = join(ed.dir, 'moved');
    await mkdir(moved);
    await writeFile(join(moved, 'result.json'), JSON.stringify({ brief: 'b', base: 'not-this-design', passed: false,
      finished: false, history: [{ draft: { design: [], fit: [] }, summary: 's' }] }));
    const wrong = await cli('bin.mjs', '--replay', moved, '--editor', ed.url);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /--replay: the editor's working design is not the one/);
    assert.match(wrong.stdout, /from a run that did not finish/, 'and a mid-run result.json says what it is');

    // A replay judges the drafts against the brief they were drafted for; one
    // typed beside it is refused, not silently judged against instead.
    const briefed = await cli('bin.mjs', '--replay', moved, '--editor', 'http://127.0.0.1:1/', 'a', 'different', 'brief');
    assert.equal(briefed.code, 1);
    assert.match(briefed.stderr, /--replay judges a run against the brief it was given/);
    assert.match(briefed.stderr, /"a different brief"/);

    // And the critic's evaluator refuses a case it does not have, and a cost
    // cap that is not a number, before judging or paying for anything.
    const typo = await cli('eval.mjs', '--only', 'no-such-case');
    assert.equal(typo.code, 1);
    assert.match(typo.stderr, /--only names no case called no-such-case/);
    assert.match((await cli('eval.mjs', '--max-cost', 'nope')).stderr, /--max-cost must be a positive number of dollars, not nope/);

    // A recorded draft today's editor refuses ends the replay, saying so. It
    // used to be one ✗ in the log, then a round judged on an empty draft.
    const refusedDir = join(ed.dir, 'refused');
    await mkdir(refusedDir);
    await writeFile(join(refusedDir, 'result.json'), JSON.stringify({ brief: 'b', passed: false, history: [
      { draft: { design: [{ op: 'no-such-op' }], fit: [] }, summary: 'from an older editor' }] }));
    await assert.rejects(go(createReplayPlanner(await loadRecording(refusedDir)), 'refused-run', 1),
      /round 1: today's editor refuses the recorded draft_design.*no-such-op/);

    // --rounds under --replay was dropped without a word.
    const bin = (...args) => new Promise((ok) => execFile(process.execPath,
      [join(ROOT, 'autolivery/bin.mjs'), ...args], (e, stdout, stderr) => ok({ code: e?.code ?? 0, stdout, stderr })));
    const rounds = await bin('--replay', join(ed.dir, 'original'), '--rounds', '2');
    assert.equal(rounds.code, 1);
    assert.match(rounds.stderr, /--rounds does not apply to --replay, which runs the 1 round\(s\) the run recorded/);

    // A pass whose proposal the inbox refused can be sent again from its
    // result.json, costing nothing. Refused again while one is pending.
    const passedDir = join(ed.dir, 'passed');
    await go(drafting, 'passed', 3);
    // But only onto the design it was measured on. Sent in front of another
    // one, after a proposal was accepted or with another livery open, the same
    // operations went onto a design they were never measured against, under a
    // why saying they had been.
    const elsewhere = await bin('--propose', passedDir, '--editor', ed.url);
    assert.equal(elsewhere.code, 1);
    assert.match(elsewhere.stderr, /--propose: the editor's working design is not the one .* started from.*The editor holds design \w+, fit \w+; .* recorded design b1\./s);
    assert.equal((await get(ed.url, 'api/proposal')).proposal, null, 'and nothing was sent');
    const [, hereDesign, hereFit] = /The editor holds design (\w+), fit (\w+)/.exec(elsewhere.stderr);
    const here = { design: hereDesign, fit: hereFit };
    const passedResult = JSON.parse(await readFile(join(passedDir, 'result.json'), 'utf8'));
    await writeFile(join(passedDir, 'result.json'), JSON.stringify({ ...passedResult, base: here }));
    const sent = await bin('--propose', passedDir, '--editor', ed.url);
    assert.equal(sent.code, 0, sent.stderr);
    const { proposal } = await get(ed.url, 'api/proposal');
    assert.match(sent.stdout, new RegExp(`proposal ${proposal.id} is in the editor's inbox`));
    assert.deepEqual(proposal.design, JSON.parse(await readFile(join(passedDir, 'result.json'), 'utf8')).draft.design);
    assert.match(proposal.why, /every fitment check ran/);
    const again = await bin('--propose', passedDir, '--editor', ed.url);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /the editor refused the proposal: .*already pending/);
    const failed = await bin('--propose', refusedDir, '--editor', ed.url);
    assert.match(failed.stderr, /did not pass its gate/);

    // A run that recorded no design to start from cannot be checked, so it is
    // not sent under a why that says it was measured.
    const { base: _base, ...unbased } = passedResult;
    const unbasedDir = join(ed.dir, 'unbased');
    await mkdir(unbasedDir);
    await writeFile(join(unbasedDir, 'result.json'), JSON.stringify(unbased));
    await fetch(new URL('api/proposal/ack', ed.url).href, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: proposal.id, status: 'discarded' }) });
    const blind = await bin('--propose', unbasedDir, '--editor', ed.url);
    assert.equal(blind.code, 1);
    assert.match(blind.stderr, /did not record the design it started from/);
    assert.equal((await get(ed.url, 'api/proposal')).proposal, null);

    // One recorded before the fit was: its design matches, and nothing can say
    // whether the fit does, so it is refused as one with no record is.
    const designOnlyDir = join(ed.dir, 'design-only');
    await mkdir(designOnlyDir);
    await writeFile(join(designOnlyDir, 'result.json'), JSON.stringify({ ...passedResult, base: here.design }));
    const halfSeen = await bin('--propose', designOnlyDir, '--editor', ed.url);
    assert.equal(halfSeen.code, 1);
    assert.match(halfSeen.stderr, /recorded the design it started from but not the fit/);
    assert.equal((await get(ed.url, 'api/proposal')).proposal, null);

    // One delivered before, and discarded, is sent again, and says so. So is
    // one whose result.json a run left mid-way, between its pass and its proposal.
    const resentDir = join(ed.dir, 'resent');
    await mkdir(resentDir);
    await writeFile(join(resentDir, 'result.json'), JSON.stringify({ ...passedResult, base: here,
      proposalId: 'prop_earlier', finished: false }));
    const resent = await bin('--propose', resentDir, '--editor', ed.url);
    assert.equal(resent.code, 0, resent.stderr);
    assert.match(resent.stdout, /delivered before as proposal prop_earlier/);
    assert.match(resent.stdout, /from a run that did not finish/);
    assert.ok((await get(ed.url, 'api/proposal')).proposal, 'and it is in the inbox');
  } finally {
    await ed.stop();
  }
});

test('a region is whole when every piece of it is, and a high finding on a piece protects the region', async () => {
  // `against` kept a finding's piece id, `band@left_mid`, while the gate's
  // other half goes by the region's, so a high finding on a span piece did not
  // stop `band` from being overruled as whole.
  const { wholeFor } = await import('../autolivery/loop.mjs');
  const measured = [
    { id: 'band@left_mid', whole: true }, { id: 'band@left_rear', whole: true },
    { id: 'name@left_mid', whole: true }, { id: 'name@left_rear', whole: false },
    { id: 'number', whole: true },
  ];
  const clean = wholeFor(measured, []);
  assert.deepEqual([...clean].sort(), ['band', 'band@left_mid', 'band@left_rear', 'name@left_mid', 'number']);
  const flagged = wholeFor(measured, [{ severity: 'high', ids: ['band@left_rear'] }, { severity: 'low', ids: ['number'] }]);
  assert.deepEqual([...flagged].sort(), ['name@left_mid', 'number'], 'a high finding on one piece protects them all');
});

test('a draft the gate cannot read back fails the round, and says the gate broke', async () => {
  // Without read_design's answer no constraint can be held to last round's,
  // and a round could loosen the one that failed with nothing to notice.
  const ed = await fixtureEditor();
  try {
    const mcp = { ...ed.mcp, callTool: (name, args) => (name === 'read_design' && args?.proposal
      ? Promise.resolve({ isError: true, content: [{ type: 'text', text: 'the editor went away' }] })
      : ed.mcp.callTool(name, args)) };
    const planner = { async round({ call }) {
      await call('draft_design', { design: [{ op: 'set-palette', name: 'ink', value: '#101014' }] });
      await call('finish_round', { summary: 'a palette' });
    } };
    const critic = { judge: async () => ({ reads_at_distance: true, number_legible: true, palette_ok: true,
      matches_brief: true, requirements: [], cut_off: [], unreadable: [], notes: [] }) };
    const out = join(ed.dir, 'run');
    const result = await run({ brief: 'b', mcp, planner, critic, trace: await createTrace({ dir: out }), out,
      rounds: 1, views: ['left'], shot: { width: 200, height: 150 }, propose: false });
    assert.equal(result.passed, false);
    assert.ok(result.history[0].failures.some((f) => /read_design could not say .*the editor went away/.test(f)),
      JSON.stringify(result.history[0].failures));
    const spans = (await readFile(join(out, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.match(spans.find((s) => s.name === 'gate').error, /read_design: the editor went away/);

    // An error with no text is still an error.
    const silent = { ...ed.mcp, callTool: (name, args) => (name === 'read_design' && args?.proposal
      ? Promise.resolve({ isError: true, content: [] })
      : ed.mcp.callTool(name, args)) };
    const quietOut = join(ed.dir, 'quiet');
    const quiet = await run({ brief: 'b', mcp: silent, planner, critic, trace: await createTrace({ dir: quietOut }),
      out: quietOut, rounds: 1, views: ['left'], shot: { width: 200, height: 150 }, propose: false });
    assert.ok(quiet.history[0].failures.some((f) => /read_design could not say .*an error, with no message/.test(f)),
      JSON.stringify(quiet.history[0].failures));
  } finally {
    await ed.stop();
  }
});

test('a replay is held to the fit its run began from, and an older record says it cannot check one', async () => {
  // The fingerprint covered the design alone, so an editor opened with another
  // --fit took the recorded draft_fit operations onto a different fit and the
  // replay passed its own check.
  const { designDigest, checkBase } = await import('../autolivery/replay.mjs');
  const ed = await fixtureEditor();
  try {
    const before = await designDigest(ed.mcp);
    assert.match(before.design, /^[0-9a-f]{16}$/);
    assert.match(before.fit, /^[0-9a-f]{16}$/);
    const { fit } = await get(ed.url, '/api/state');
    const saved = await fetch(new URL('/api/fit', ed.url).href, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fit, regions: { ghost: { drop: true } } }) });
    assert.equal(saved.status, 200, await saved.text());
    const after = await designDigest(ed.mcp);
    assert.equal(after.design, before.design, 'the design did not change');
    assert.notEqual(after.fit, before.fit, 'the fit did');

    const recorded = join(ed.dir, 'other-fit');
    await mkdir(recorded);
    await writeFile(join(recorded, 'result.json'), JSON.stringify({ brief: 'b', base: before, passed: false,
      history: [{ draft: { design: [], fit: [] }, summary: 's' }] }));
    const wrong = await cli('bin.mjs', '--replay', recorded, '--editor', ed.url);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /--replay: the editor's working fit is not the one/);

    // A run recorded before the fit was fingerprinted holds the design's alone.
    // It still refuses another design, and says plainly that the fit is unchecked
    // rather than passing it or failing a run that may well be right.
    const dir = 'runs/x';
    assert.deepEqual(checkBase({ dir, base: after }, after), {});
    assert.match(checkBase({ dir, base: before }, after).error, /working fit is not the one runs\/x started from/);
    assert.match(checkBase({ dir, base: { design: 'other', fit: after.fit } }, after).error, /working design is not the one/);
    const legacy = checkBase({ dir, base: after.design }, after);
    assert.equal(legacy.error, undefined);
    assert.match(legacy.note, /recorded the design it started from but not the fit, so the replay cannot check the fit/);
    assert.match(checkBase({ dir, base: 'other' }, after).error, /working design is not the one/);
    assert.match(checkBase({ dir }, after).note, /did not record the design it started from/);
  } finally {
    await ed.stop();
  }
});

test('the critic\'s evaluator fails when it judged nothing, and says why a picture could not be read', async () => {
  // Every case's pictures are under runs/, which is not committed, so on any
  // other machine every case was skipped and eval reported 0 of 0 and exited 0.
  const dir = await mkdtemp(join(tmpdir(), 'autolivery-eval-'));
  try {
    const cases = join(dir, 'cases.json');
    const write = (list) => writeFile(cases, JSON.stringify({ brief: 'b', cases: list }));
    // Port 1: were it to get as far as a critic, it would fail to connect, not
    // judge anything or reach a server someone is running.
    const go = () => cli('eval.mjs', '--cases', cases, '--critic-base-url', 'http://127.0.0.1:1/v1');
    await write([
      { id: 'gone', images: [{ view: 'sheet', path: join(dir, 'missing.png') }], expect: {} },
      { id: 'folder', images: [{ view: 'sheet', path: dir }], expect: {} },
    ]);
    const none = await go();
    assert.equal(none.code, 1);
    assert.match(none.stdout, /gone: skipped, .*missing\.png is not on this machine/);
    // A directory where a render should be is not a render missing from this
    // machine, and a bare catch said it was.
    assert.match(none.stdout, /folder: skipped, .* could not be read: .*EISDIR/);
    assert.doesNotMatch(none.stdout, /folder: .*not on this machine/);
    assert.match(none.stderr, /judged nothing/);

    // A malformed pattern ended the whole run from inside score(), mid-way,
    // naming neither the case nor the pattern.
    await write([{ id: 'bad-pattern', images: [], expect: { notCutOff: ['roundel('] } }]);
    const bad = await go();
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /case bad-pattern: notCutOff pattern "roundel\(" is not a regular expression/);
    const { checkPatterns } = await import('../autolivery/cases.mjs');
    assert.throws(() => checkPatterns([{ id: 'loose', expect: { present: 'stripe' } }]), /case loose: present must be a list of patterns/);
    assert.doesNotThrow(() => checkPatterns([{ id: 'fine', expect: { present: ['stripe|band'], passes: true } }]));
  } finally {
    await rm(dir, { recursive: true, force: true });
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

// The right flank again, as mirrored bodywork: a skin just outside the right
// face that wears the LEFT island's texels, as a car whose doors share one
// patch of texture does, a little smaller so the left view stays home. And a
// panel standing off it over its front half, as SHIELD does on the left.
const MIRRORED = (() => {
  const x = -CAR.width / 2 - 0.02, k = 0.95, n = [-1, 0, 0];
  const [rx, ry, rw, rh] = CAR.faces.left;
  const at = (y, z) => vert(x, y * k + 0.75 * (1 - k), z * k,
    rx + (rw * (z + CAR.length / 2)) / CAR.length, ry + (rh * y) / CAR.height, n);
  return {
    name: 'DOOR_R_MIRRORED',
    verts: [at(0, -1.85), at(0, 1.85), at(CAR.height, 1.85), at(CAR.height, -1.85)],
    indices: [0, 1, 2, 0, 2, 3],
  };
})();
const SHIELD_R = (() => {
  const x = -CAR.width / 2 - 0.1, n = [-1, 0, 0];
  return {
    name: 'MIRROR_R',
    verts: [vert(x, 0.2, 0.3, 0.990, 0.990, n), vert(x, 0.2, 1.85, 0.995, 0.990, n),
      vert(x, 1.3, 1.85, 0.995, 0.995, n), vert(x, 1.3, 0.3, 0.990, 0.995, n)],
    indices: [0, 1, 2, 0, 2, 3],
  };
})();

test('a piece is judged in every view that shows it nearly as large as its home view', async () => {
  // Judged in the largest view alone. Mirrored bodywork shows the same texels
  // on both flanks, so a mirror hiding the right-hand copy was never judged
  // while the left view was a few pixels larger, and a critic that rightly
  // called it cut off on the right door would have been overruled.
  const ed = await fixtureEditor({ kn5: { extraMeshes: [MIRRORED, SHIELD_R] } });
  try {
    const { panels } = JSON.parse((await ed.mcp.callTool('find_panels', { tag: 'left' })).content[0].text);
    const out = JSON.parse((await ed.mcp.callTool('check_fitment', { proposal: { design: [
      { op: 'set-palette', name: 'ink', value: '#101014' },
      plate('plate-mirrored', panels[0].panel, [0.5, 0.3, 0.3, 0.4]),
    ] } })).content[0].text);
    const m = out.inView.find((x) => x.id === 'plate-mirrored');
    assert.equal(m.home, 'left', JSON.stringify(m));
    assert.equal(m.views.left, 1, JSON.stringify(m));
    assert.equal(m.whole, false, JSON.stringify(m));
    assert.equal(m.view, 'right', 'the view that decided is named');
    assert.equal(m.hiddenBy, 'MIRROR_R');
    const found = out.findings.filter((f) => f.kind === 'hidden-in-view');
    assert.deepEqual(found.map((f) => [f.ids[0], f.view, f.severity]), [['plate-mirrored', 'right', 'high']]);
    assert.match(found[0].why, /in the right view/);
  } finally {
    await ed.stop();
  }
});

test('the count is taken at the frame the critic\'s pictures were drawn at', async () => {
  // It was taken at 900x540 whatever the gate rendered, and a piece needed
  // 30 pixels to count at any size: at the critic's 200x150 a small plate
  // had no view at all.
  const ed = await fixtureEditor();
  try {
    const { panels } = JSON.parse((await ed.mcp.callTool('find_panels', { tag: 'left' })).content[0].text);
    const design = [{ op: 'set-palette', name: 'ink', value: '#101014' },
      plate('plate-small', panels[0].panel, [0.48, 0.45, 0.03, 0.05])];
    const at = async (count) => JSON.parse((await ed.mcp.callTool('check_fitment', { proposal: { design }, count })).content[0].text);
    const small = await at({ view: 'left', width: 200, height: 150 });
    assert.deepEqual(small.inViewAt, { width: 200, height: 150 });
    const m = small.inView.find((x) => x.id === 'plate-small');
    assert.equal(m.home, 'left', JSON.stringify(m));
    assert.ok(m.size[0] * 200 * m.size[1] * 150 < 30, `under the old fixed floor: ${JSON.stringify(m)}`);
    // A sheet of six is three across and two down, and each view is a cell.
    assert.deepEqual((await at({ view: 'sheet', width: 2100, height: 960 })).inViewAt, { width: 700, height: 480 });

    const calls = [];
    const mcp = { listTools: () => ed.mcp.listTools(),
      callTool: (name, args) => { calls.push([name, args]); return ed.mcp.callTool(name, args); } };
    const planner = { async round({ call }) {
      await call('draft_design', { design });
      await call('finish_round', { summary: 'a small plate' });
    } };
    const critic = { judge: async () => ({ reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
      requirements: [], cut_off: [], unreadable: [], notes: [] }) };
    const dir = join(ed.dir, 'run');
    await run({ brief: 'a plate', mcp, planner, critic, trace: await createTrace({ dir }), out: dir,
      rounds: 1, views: ['left'], shot: { width: 200, height: 150 }, closer: [], propose: false });
    const gate = calls.filter(([name, args]) => name === 'check_fitment' && args.count);
    assert.deepEqual(gate.map(([, args]) => args.count), [{ view: 'left', width: 200, height: 150 }]);
  } finally {
    await ed.stop();
  }
});

test('a blended surface the design paints stands in front of what is behind it', async () => {
  // The whole-car pass skipped every blended part without a car-owned sheet,
  // and a part the design paints has none, since it wears the design. So a
  // painted plate in front of a name hid nothing, and the name was counted
  // whole while the picture showed it covered.
  const ed = await fixtureEditor({ kn5: { extraMeshes: [{ ...SHIELD, materialId: 1 }],
    materials: [{ name: 'BodyMat' }, { name: 'ShieldMat', shader: 'ksPerPixelAlpha', alphaBlendMode: 1 }] } });
  try {
    const { panels } = JSON.parse((await ed.mcp.callTool('find_panels', { tag: 'left' })).content[0].text);
    const proposal = { design: [
      { op: 'set-palette', name: 'ink', value: '#101014' },
      plate('plate-hidden', panels[0].panel, [0.5, 0.3, 0.3, 0.4]),
    ] };
    const out = JSON.parse((await ed.mcp.callTool('check_fitment', { proposal })).content[0].text);
    const hidden = out.inView.find((m) => m.id === 'plate-hidden');
    assert.equal(hidden.whole, false, JSON.stringify(hidden));
    assert.equal(hidden.hiddenBy, 'MIRROR_L');
  } finally {
    await ed.stop();
  }
});

test('a "cut off" is overruled only by the count of a view the critic was shown', async () => {
  // The count covers the sheet's six views. A critic given the left view
  // alone said a roof plate was cut off, and was overruled on the strength
  // of the top view, which it never saw.
  const ed = await fixtureEditor();
  try {
    const planner = { async round({ call }) {
      await call('draft_design', { design: [
        { op: 'set-palette', name: 'ink', value: '#101014' },
        plate('roof-plate', 'centre_mid', [0.3, 0.3, 0.4, 0.4]),
      ] });
      await call('finish_round', { summary: 'a plate on the roof' });
    } };
    const critic = { judge: async () => ({ reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
      requirements: [{ asked: 'a plate', present: true, where: 'roof' }],
      cut_off: [{ what: 'the roof plate', where: 'left view', id: 'roof-plate' }], unreadable: [], notes: [] }) };
    const out = join(ed.dir, 'run');
    const result = await run({ brief: 'a plate', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir: out }), out,
      rounds: 1, views: ['left'], shot: { width: 200, height: 150 }, closer: [], propose: false });
    const counted = result.history[0].fitment.inView.find((m) => m.id === 'roof-plate');
    assert.equal(counted?.home, 'top', JSON.stringify(result.history[0].fitment.inView));
    assert.equal(counted.whole, true);
    assert.equal(result.history[0].critic.overruled, undefined, 'the critic saw only the left view');
    assert.equal(result.passed, false);
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
    assert.match(found[0].why, /fewer than 30 pixels in every (\d+x\d+ )?view .*minVisible 0\.5 could not be counted/);
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

test('glass covers where its own texture is opaque, as the picture draws its frit', () => {
  // The count skipped every glass surface, while the picture draws a
  // windscreen's frit band at full alpha. A number under the frit counted
  // as whole and was hidden in the picture.
  const quad = (x, n) => [[x, 0, -1.85, 0, 0], [x, 0, 1.85, 1, 0], [x, 1.5, 1.85, 1, 1], [x, 1.5, -1.85, 0, 1]]
    .map(([px, py, pz, u, v]) => ({ p: [px, py, pz], uv: [u, v], n }));
  const verts = [...quad(0.95, [1, 0, 0]), ...quad(1.05, [1, 0, 0])];
  const model = {
    positions: Float32Array.from(verts.flatMap((v) => v.p)),
    uvs: Float32Array.from(verts.flatMap((v) => v.uv)),
    normals: Float32Array.from(verts.flatMap((v) => v.n)),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
    parts: [{ name: 'BODY', start: 0, count: 6 }, { name: 'WINDSCREEN', start: 6, count: 6 }],
  };
  const groups = [
    { role: 'body', file: 'body.dds', lod: null, start: 0, count: 6, blend: false, glass: false, add: false, alphaTest: null },
    { role: null, file: 'glass.dds', lod: null, start: 6, count: 6, blend: true, glass: true, add: false, alphaTest: null },
  ];
  // Clear (alpha 16) in the first two rows of texels, the frit (255) in the last two.
  const data = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data[i * 4 + 3] = i < 8 ? 16 : 255;
  const sheets = new Map([['glass.dds', { w: 4, h: 4, data }]]);
  const piece = (id, v0) => ({ id, role: 'body', box: [0.3, v0, 0.5, v0 + 0.2],
    contains: (u, v) => u >= 0.3 && u <= 0.5 && v >= v0 && v <= v0 + 0.2 });
  const [clear, frit] = piecesInView(model, groups, sheets, [piece('clear', 0.2), piece('frit', 0.6)],
    { view: 'left', width: 300, height: 200 });
  assert.ok(clear.whole > 100 && clear.shown === clear.whole, JSON.stringify(clear));
  assert.ok(frit.whole > 100 && frit.shown === 0, JSON.stringify(frit));
  assert.equal(frit.blockers[0].mesh, 'WINDSCREEN');

  // The whole-car pass is kept per geometry, and must follow the sheets it is
  // handed: the same glass cleared of its frit hides nothing.
  const clearGlass = new Map([['glass.dds', { w: 4, h: 4, data: Buffer.alloc(4 * 4 * 4, 16) }]]);
  const [, after] = piecesInView(model, groups, clearGlass, [piece('clear', 0.2), piece('frit', 0.6)],
    { view: 'left', width: 300, height: 200 });
  assert.equal(after.shown, after.whole, JSON.stringify(after));

  // A kn5 mesh name may hold any byte, NUL included, and what stands in front
  // is reported as the pair it is rather than split back out of one string.
  const odd = { ...model, parts: [model.parts[0], { ...model.parts[1], name: 'WIND\u0000SCREEN' }] };
  const [, named] = piecesInView(odd, groups, sheets, [piece('clear', 0.2), piece('frit', 0.6)],
    { view: 'left', width: 300, height: 200 });
  assert.deepEqual(named.blockers.map(({ mesh, sheet }) => [mesh, sheet]), [['WIND\u0000SCREEN', 'glass.dds']]);
});

// A ring whose stroke is drawn past its own box (radius + width/2 = 0.75), at
// the rear edge of the fixture's left panel, whose rect is its island: the
// stroke runs off the island into texture space no triangle uses.
const offEdge = (id, panel) => ({ op: 'add-region', surface: 'surfaces.body', region: {
  id, treatment: 'ring', panel, at: [0.7, 0.3, 0.3, 0.4], radius: 0.5, width: 0.5, color: 'ink' } });

test('a piece that runs off its island is not whole, and a critic calling it cut off stands', async () => {
  // Only the pixels a triangle draws were counted, so the part of a piece
  // painted where no triangle reaches was never in the count. On the NSX,
  // roundels at panel corners with a third of their area off the mesh came
  // back whole, and a correct "cut off at the panel edge" was overruled.
  const ed = await fixtureEditor();
  try {
    const { panels } = JSON.parse((await ed.mcp.callTool('find_panels', { tag: 'left' })).content[0].text);
    const left = panels[0].panel;
    const out = JSON.parse((await ed.mcp.callTool('check_fitment', { proposal: { design: [
      { op: 'set-palette', name: 'ink', value: '#101014' }, offEdge('ring-off', left)] } })).content[0].text);
    const ring = out.inView.find((m) => m.id === 'ring-off');
    assert.equal(ring.visible, 1, 'every pixel of it a triangle draws is in view');
    assert.ok(ring.onMesh > 0.5 && ring.onMesh < 0.99, JSON.stringify(ring));
    assert.equal(ring.whole, false, JSON.stringify(ring));
    assert.match(ring.why, /texture space no triangle uses/);

    const planner = { async round({ call }) {
      await call('draft_design', { design: [{ op: 'set-palette', name: 'ink', value: '#101014' }, offEdge('ring-off', left)] });
      await call('finish_round', { summary: 'a ring' });
    } };
    const asked = [];
    const critic = { judge: async (a) => { asked.push(a); return { reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
      requirements: [{ asked: 'a ring', present: true, where: 'left door' }],
      cut_off: [{ what: 'the ring', where: 'left view, rear edge', id: 'ring-off' }], unreadable: [], notes: [] }; } };
    const dir = join(ed.dir, 'run');
    const result = await run({ brief: 'a ring', mcp: ed.mcp, planner, critic, trace: await createTrace({ dir }), out: dir,
      rounds: 1, views: ['left'], shot: { width: 200, height: 150 }, closer: [], propose: false });
    const h = result.history[0];
    assert.equal(h.critic.overruled, undefined, JSON.stringify(h.critic));
    assert.deepEqual(h.critic.cut_off.map((c) => c.id), ['ring-off']);
    assert.equal(result.passed, false);
    const told = h.fitment.inView.find((m) => m.id === 'ring-off');
    assert.equal(told.onMesh, ring.onMesh, 'the round record says why it is not whole');
    assert.match(told.why, /texture space no triangle uses/);
    const { measuredNote } = await import('../autolivery/prompts.mjs');
    assert.match(measuredNote(asked[0].measured), /ring-off: .*Not whole: only \d+% of it is on the car/);
  } finally {
    await ed.stop();
  }
});

test('eval overrules a critic only where the gate would', async () => {
  // eval overruled every "cut off" the count called whole, while the gate
  // does not for a piece a high finding names or one counted in a view the
  // critic was not shown, so eval scored a verdict the gate never gives.
  const { overruleCase } = await import('../autolivery/cases.mjs');
  const measured = [
    { id: 'clear', home: 'left', whole: true },
    { id: 'faulted', home: 'left', whole: true },
    { id: 'roof', home: 'top', whole: true },
  ];
  const cut = (ids) => ({ reads_at_distance: true, number_legible: true, palette_ok: true, matches_brief: true,
    requirements: [], unreadable: [], notes: [], cut_off: ids.map((id) => ({ what: id, where: 'left', id })) });
  const findings = [{ kind: 'off-mesh', severity: 'high', ids: ['faulted'] }];
  const left = overruleCase(cut(['clear', 'faulted', 'roof']), { measured, findings, images: [{ view: 'left' }] });
  assert.deepEqual(left.overruled.map((c) => c.id), ['clear']);
  assert.deepEqual(left.cut_off.map((c) => c.id), ['faulted', 'roof']);
  const sheet = overruleCase(cut(['roof']), { measured, images: [{ view: 'sheet' }] });
  assert.deepEqual(sheet.overruled.map((c) => c.id), ['roof']);
  assert.deepEqual(overruleCase(cut(['clear']), { images: [{ view: 'left' }] }).cut_off.map((c) => c.id), ['clear'],
    'a case with no count overrules nothing');
});

