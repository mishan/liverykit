import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clip } from './trace.mjs';

/**
 * A brief in; a design out that has passed a check it cannot argue with.
 *
 * Each round the planner writes a DRAFT — a list of the same operations a
 * proposal carries — and the harness, not the planner, then measures it: the
 * fitment check in millimetres against the model, and a critic that looks at
 * renders and has not seen the planner's reasoning. The planner hears both
 * verdicts as structured data and revises. Only a draft that passes is offered
 * to the editor, and it arrives there as an ordinary proposal: a person still
 * accepts it or throws it away.
 *
 * The draft is why this can run with nobody at the editor. A proposal only
 * reaches the working design once accepted, so a loop that proposed and then
 * measured would measure the design without its own change. The alternative
 * — letting the agent accept its own proposals between rounds — would have
 * been a flag that turns off the one guarantee the inbox exists to give.
 * Measuring a draft needed nothing but the editor learning to answer about
 * one, which every MCP client now gets.
 *
 * Nothing in this file knows what a car is. The words are in the prompts.
 */

/** Read-only tools passed straight through, with the server's own descriptions. */
const KNOWING = ['describe_car', 'find_panels', 'find_space', 'list_constraints', 'list_treatments', 'read_design', 'read_fit'];

const DESIGN_OPS =
  'set-palette {name, value}; set-identity {key, value}; add-region {surface, region}; ' +
  'set-region {id, region} (replaces the whole region); set-option {id, key, value} (null removes); ' +
  'remove-region {id}; reorder-region {surface, id, toIndex}; set-constraint {id, key, value}.';
const FIT_OPS =
  'set-override {id, panel, at, rotate}; drop-override {id}; add-copy {id, of, panel, at, rotate}.';

export function plannerTools(served) {
  const byName = new Map(served.map((t) => [t.name, t]));
  const knowing = KNOWING.filter((n) => byName.has(n)).map((n) => ({
    name: n,
    description: n === 'read_design' || n === 'read_fit'
      ? `${byName.get(n).description} This is the editor's state WITHOUT your draft; show_draft has that.`
      : byName.get(n).description,
    input_schema: byName.get(n).inputSchema ?? { type: 'object', properties: {} },
  }));
  const views = /Views: ([^.]+)\./.exec(byName.get('render_car')?.description ?? '')?.[1] ?? 'left, right, front, rear';
  return [
    ...knowing,
    {
      name: 'draft_design',
      description:
        'Append design operations to this run\'s DRAFT, applied in order on top of the ' +
        `editor's working design. Operations: ${DESIGN_OPS} The draft is checked as it is ` +
        'written: operations the editor would refuse are refused here, all of them, and the ' +
        'draft stays as it was. Nothing reaches the editor or the car until the run ends and a ' +
        'person accepts it.',
      input_schema: {
        type: 'object',
        properties: { design: { type: 'array', items: { type: 'object' }, description: 'Operations, each { op, ... }' } },
        required: ['design'],
      },
    },
    {
      name: 'draft_fit',
      description:
        'Append fit operations — per-car placement overrides — to the DRAFT. ' +
        `Operations: ${FIT_OPS} Usually a design operation that places the region is simpler; ` +
        'use this when the design should stay portable and only this car needs the move.',
      input_schema: {
        type: 'object',
        properties: { fit: { type: 'array', items: { type: 'object' }, description: 'Operations, each { op, ... }' } },
        required: ['fit'],
      },
    },
    {
      name: 'reset_draft',
      description: 'Throw the whole draft away and start again from the editor\'s working design.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'show_draft',
      description: 'The draft\'s operations as they stand.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'render_car',
      description:
        `Render the DRAFT on the car and return the picture. Views: ${views}. A software ` +
        'rasteriser with one fixed light rig, no environment reflections and no normal maps: it ' +
        'answers "does the artwork land where I said", not "is this exactly the game".',
      input_schema: {
        type: 'object',
        properties: { view: { type: 'string', description: `One of: ${views}` } },
      },
    },
    {
      name: 'check_fitment',
      description:
        'Measure what is wrong with the DRAFT on this car: text on text, artwork the bodywork ' +
        'hides, text too small in millimetres, artwork painted where no triangle is, broken ' +
        'mirroring. This is the same check the gate runs; the round fails on any fatal or high ' +
        'finding, or if any check did not run.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'finish_round',
      description:
        'Submit the draft to this round\'s gate. The harness renders it, runs check_fitment ' +
        'itself, and has an independent critic judge the renders against the brief; both ' +
        'verdicts come back to you. A draft that passes both is offered to a person in the editor.',
      input_schema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'What the design is, and what changed since the last round and why. ' +
              'The person deciding whether to accept it reads this.',
          },
        },
        required: ['summary'],
      },
    },
  ];
}

const textOf = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const ok = (text) => ({ content: [{ type: 'text', text }] });
const refuse = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** Every region's constraints, by id, in a design as it stands. */
function constraintsById(design) {
  const out = new Map();
  for (const group of ['surfaces', 'paint']) {
    for (const spec of Object.values(design?.[group] ?? {})) {
      for (const r of spec.regions ?? []) if (r?.id) out.set(r.id, { ...(r.constraints ?? {}) });
    }
  }
  return out;
}

/**
 * What got looser between two sets of constraints. Every constraint in the
 * vocabulary is a floor (a number the placement must reach) or a requirement
 * (true), so going down and no longer being true are the two ways to loosen
 * one. A constraint that is neither would have to say so here.
 */
function loosened(was, is) {
  const out = [];
  for (const [k, v] of Object.entries(was)) {
    const now = is[k];
    if (typeof v === 'number' && !(typeof now === 'number' && now >= v)) out.push(`${k} lowered from ${v} to ${now ?? 'nothing'}`);
    if (v === true && now !== true) out.push(`${k} removed`);
  }
  return out;
}

/** Why the critic failed a round, in a few words: the first thing missing, else its first note. */
const criticWhy = (v) => {
  const gone = (v?.requirements ?? []).find((r) => !r.present);
  if (gone) return ` (missing: ${clip(gone.asked, 120)})`;
  const cut = (v?.cut_off ?? [])[0];
  if (cut) return ` (cut off: ${clip(cut.what, 70)}, ${clip(cut.where, 70)})`;
  const faint = (v?.unreadable ?? [])[0];
  if (faint) return ` (will not read: ${clip(faint.what, 70)}, ${clip(faint.why, 70)})`;
  return v?.notes?.length ? ` (${clip(v.notes[0], 140)})` : '';
};

/**
 * What every first round began by asking, asked once by the harness and put in
 * the planner's first message. A turn re-reads the whole conversation, and a
 * planner spent its first turns fetching these four before it did anything.
 */
const FACTS = [
  ['describe_car', {}],
  ['list_treatments', {}],
  ['list_constraints', {}],
  ['find_panels', { minVisibility: 0.45, minArea: 0.004 }],
];

/**
 * Whether a verdict passes: every field true, every requirement present and
 * nothing cut off. Notes are prose, and the gate reads none of them.
 */
const passes = (v) => Boolean(v && !v.error && v.reads_at_distance && v.number_legible && v.palette_ok
  && v.matches_brief && !(v.requirements ?? []).some((r) => !r.present) && !(v.cut_off ?? []).length
  && !(v.unreadable ?? []).length);

/** What in a failing verdict failed it, one line each. */
const blockingOf = (v) => (!v || v.error ? [] : [
  ...(v.requirements ?? []).filter((r) => !r.present).map((r) => `missing: ${r.asked} (${r.where})`),
  ...(v.cut_off ?? []).map((c) => `cut off: ${c.what} (${c.where})`),
  ...(v.unreadable ?? []).map((u) => `will not read: ${u.what} (${u.where}; ${u.why})`),
  ...['reads_at_distance', 'number_legible', 'palette_ok', 'matches_brief']
    .filter((k) => v[k] === false).map((k) => `the critic answered ${k}: false`),
]);

/** The fields of a finding worth a planner's attention, without the noise. */
const brief = (f) => Object.fromEntries(
  ['kind', 'severity', 'surface', 'panel', 'ids', 'why', 'mm', 'visible', 'coverage']
    .filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));

export async function run({
  brief: theBrief, mcp, planner, critic, trace, out,
  rounds = 6, views = ['sheet'], shot = { width: 900, height: 540 }, sheetShot = { width: 2100, height: 960 },
  criticGates = true, propose = true, roundCalls = 40, looks = 2, log = () => {},
  referee = null, closer = ['left', 'right'], closeShot = { width: 1600, height: 960 }, seed = true,
}) {
  await mkdir(out, { recursive: true });
  const tools = plannerTools(await mcp.listTools());
  const draft = { design: [], fit: [] };
  const sizeFor = (view) => (view === 'sheet' ? sheetShot : shot);
  // What the last gate saw, for the one check that compares two rounds.
  let lastGate = null;
  const history = [];
  let feedback = null;
  let summary = '';
  let passedIn = null;

  // One door for every tool call, planner's and gate's alike, so each is
  // traced the same way and none can skip the trace by coming in sideways.
  const traced = async (parent, name, args, fn) => {
    const span = trace.start('tool', name, {
      parent,
      attrs: { 'tool.name': name, 'tool.parameters': clip(args), 'agentops.entity.input': clip(args) },
    });
    let r;
    try {
      r = await fn();
    } catch (e) {
      r = refuse(e.message);
    }
    await span.end({
      ok: !r.isError,
      error: r.isError ? textOf(r) : null,
      attrs: { 'tool.status': r.isError ? 'failed' : 'succeeded', 'tool.result': clip(textOf(r) || '[image]') },
    });
    return { r, ms: span.ms };
  };

  const saveImages = async (r, stem) => {
    const saved = [];
    for (const [i, c] of (r.content ?? []).entries()) {
      if (c.type !== 'image') continue;
      const path = join(out, `${stem}${i ? `-${i}` : ''}.png`);
      await writeFile(path, Buffer.from(c.data, 'base64'));
      saved.push({ path, data: c.data });
    }
    return saved;
  };

  let facts = null;
  if (seed) {
    const span = trace.start('task', 'car-facts', {});
    const parts = [];
    for (const [name, args] of FACTS) {
      const { r } = await traced(span, name, args, () => mcp.callTool(name, args));
      if (!r.isError) parts.push(`${name} ${JSON.stringify(args)}:\n${textOf(r)}`);
    }
    await span.end({ ok: true });
    facts = parts.join('\n\n') || null;
  }

  for (let n = 1; n <= rounds; n++) {
    const round = trace.start('workflow', `round-${n}`, { attrs: { round: n } });
    log(`round ${n} of ${rounds}`);
    let calls = 0;
    let renders = 0;

    const dispatch = async (name, args) => {
      switch (name) {
        case 'draft_design':
        case 'draft_fit': {
          const key = name === 'draft_design' ? 'design' : 'fit';
          const ops = args?.[key];
          if (!Array.isArray(ops) || !ops.length) {
            return refuse(`${name} needs a non-empty "${key}" array of operations.`);
          }
          const candidate = { ...draft, [key]: [...draft[key], ...ops] };
          const r = await mcp.callTool('check_fitment', { proposal: candidate });
          if (r.isError) return refuse(`Refused, and the draft is unchanged: ${textOf(r)}`);
          draft[key] = candidate[key];
          return ok(`Accepted ${ops.length} operation(s). The draft holds ${draft.design.length} design ` +
            `and ${draft.fit.length} fit operation(s). check_fitment on it now: ${JSON.parse(textOf(r)).verdict}`);
        }
        case 'reset_draft':
          draft.design = [];
          draft.fit = [];
          return ok('The draft is empty; the design is the editor\'s working design again.');
        case 'show_draft': {
          // What the operations amount to, not only the operations: a draft
          // that re-sends whole regions grows long long before the design does.
          const r = await mcp.callTool('read_design', { proposal: draft });
          return ok(`${draft.design.length} design and ${draft.fit.length} fit operation(s). ` +
            `The design they make:\n${textOf(r)}`);
        }
        case 'render_car': {
          // Soft, and said: a look is a turn, and a turn re-reads the whole
          // conversation — a planner that looked eighteen times in one round
          // spent more on the looking than on the pictures. The gate renders
          // the draft itself whatever this says.
          if (renders >= looks) {
            return refuse(`This round's ${looks} looks are spent. Use check_fitment to measure, ` +
              'or finish_round: the gate renders the draft itself.');
          }
          const view = args?.view ?? 'left';
          const r = await mcp.callTool('render_car', { view, ...sizeFor(view), proposal: draft });
          await saveImages(r, `round-${n}-look-${++renders}-${view}`);
          return r;
        }
        case 'check_fitment':
          return mcp.callTool('check_fitment', { proposal: draft });
        case 'finish_round':
          return ok('Submitted. The gate\'s verdicts come back in the next message.');
        default:
          if (KNOWING.includes(name)) return mcp.callTool(name, args ?? {});
          return refuse(`There is no tool called ${JSON.stringify(name)}.`);
      }
    };

    // Submitting seals the round. Both planners run every call in a turn, so
    // a turn holding finish_round and then another draft_design changed the
    // draft after the summary describing it was written, and the gate judged
    // a design nobody had described.
    let sealed = false;
    const call = async (name, args = {}) => {
      if (sealed) {
        return refuse('This round was already submitted with finish_round, so this call was not run. ' +
          'Make the change next round if the gate asks for one.');
      }
      if (++calls > roundCalls) {
        return refuse(`This round has used its ${roundCalls} tool calls. Call finish_round now.`);
      }
      const { r, ms } = await traced(round, name, args, () => dispatch(name, args));
      if (name === 'finish_round' && !r.isError) sealed = true;
      const note = r.isError ? ` — ${clip(textOf(r), 160)}` : '';
      log(`  ${r.isError ? '✗' : '✓'} ${name} ${Math.round(ms)} ms${note}`);
      return r;
    };

    const said = await planner.round({ n, rounds, brief: theBrief, feedback, tools, call, parent: round, facts });
    if (said?.summary) summary = said.summary;

    const gate = await judge({ n, round });
    history.push(gate.record);
    await round.end({
      ok: !gate.broke,
      error: gate.broke ? clip(gate.broke, 300) : null,
      attrs: { 'round.passed': gate.passed, 'round.fitment': gate.record.gates.fitment, 'round.critic': gate.record.gates.critic },
    });
    await trace.flush();
    if (gate.passed) { passedIn = n; break; }
    feedback = gate.feedback;
  }

  /**
   * The gate, run by the harness on the draft as it actually stands — never on
   * the planner's account of it.
   */
  async function judge({ n, round }) {
    const span = trace.start('task', 'gate', { parent: round, attrs: { round: n } });
    const reasons = [];
    if (!draft.design.length && !draft.fit.length) {
      // An empty draft measures clean, because there is nothing on the car to
      // be wrong. That is not a design passing; it is no design.
      reasons.push('the draft is empty: nothing has been designed yet');
    }

    const images = [];
    for (const view of views) {
      const { r } = await traced(span, 'render_car', { view }, () =>
        mcp.callTool('render_car', { view, ...sizeFor(view), proposal: draft }));
      if (r.isError) {
        reasons.push(`the ${view} render failed: ${textOf(r)}`);
        continue;
      }
      for (const s of await saveImages(r, `round-${n}-${view}`)) images.push({ view, ...s });
    }

    const { r: fr } = await traced(span, 'check_fitment', {}, () =>
      mcp.callTool('check_fitment', { proposal: draft }));
    let fitment = null;
    if (fr.isError) {
      reasons.push(`check_fitment refused the draft: ${textOf(fr)}`);
    } else {
      fitment = JSON.parse(textOf(fr));
      const blocking = fitment.findings.filter((f) => f.severity === 'fatal' || f.severity === 'high');
      for (const f of blocking) reasons.push(`${f.severity} ${f.kind}: ${f.why}`);
      if (fitment.notChecked.length) reasons.push(`checks that did not run: ${fitment.notChecked.join(', ')}`);
      if (fitment.notPlaced.length) reasons.push(`not placed: ${clip(fitment.notPlaced, 400)}`);
    }

    // Where the design stands, as a design rather than a list of operations:
    // for a planner that begins each round without the ones before it, and
    // for the check below, which compares this round with the last.
    let standing = null;
    let effective = null;
    const { r: rd } = await traced(span, 'read_design', { proposal: '(the draft)' }, () =>
      mcp.callTool('read_design', { proposal: draft }));
    if (!rd.isError) {
      try {
        effective = JSON.parse(textOf(rd));
        standing = JSON.stringify({ palette: effective.palette, identity: effective.identity,
          surfaces: effective.surfaces, paint: effective.paint });
      } catch { /* left out rather than guessed */ }
    }

    // A constraint that failed, lowered the next round, is the planner
    // talking its way past the gate. It happened: a door number's own
    // minOnCar failed at 93% on the car, the planner lowered it from 0.95 to
    // 0.90, the round passed, and the roundel went onto the car cut in half by
    // the shut line the measurement had found. Lowering a constraint nothing
    // has failed is a design change like any other; lowering the one that
    // just failed is not.
    const constraints = constraintsById(effective);
    if (lastGate) {
      for (const [id, was] of lastGate.constraints) {
        if (!lastGate.failed.has(id) || !constraints.has(id)) continue;
        for (const change of loosened(was, constraints.get(id))) {
          reasons.push(`${id}: ${change} after it failed round ${n - 1}. A constraint is a requirement, ` +
            `not a setting to tune until the gate passes: move or resize ${id} instead.`);
        }
      }
    }
    const fitmentPass = !reasons.length;

    // Asked even when fitment has failed, so a round that fails both says so
    // at once instead of fixing one and discovering the other a round later.
    let verdict = null;
    let criticPass = false;
    if (images.length) {
      try {
        verdict = await critic.judge({ brief: theBrief, summary, images, parent: span });
        // Every requirement, not only the summary: a critic answered
        // matches_brief: true while its own notes said the team name was
        // nowhere on the car. And every cut-off piece, listed as data for the
        // same reason — "cut off at the door gap" once sat in the notes of a
        // pass. `passes` reads the lists.
        criticPass = passes(verdict);
      } catch (e) {
        verdict = { error: e.message };
      }
    }

    // A second, closer look, when the critic alone stands between a draft
    // that measured clean and the person it would be offered to. A local
    // critic failed three rounds of one run on a roundel that was whole in
    // every render and a name that was on the car but small in a sheet of
    // four, and the planner, believing it, made the design worse each time.
    // Asked of the referee when there is one (Claude, beside a local critic),
    // told what the first look flagged, and shown full-size side views. Its
    // verdict decides and both are kept. A round that failed fitment has to
    // be revised anyway, so it costs no second look.
    let second = null;
    if (fitmentPass && !criticPass && verdict && !verdict.error && closer.length) {
      const closeImages = [];
      const missed = [];
      for (const view of closer) {
        const { r } = await traced(span, 'render_car', { view }, () =>
          mcp.callTool('render_car', { view, ...closeShot, proposal: draft }));
        const saved = r.isError ? [] : await saveImages(r, `round-${n}-closer-${view}`);
        if (!saved.length) missed.push(`${view}: ${r.isError ? textOf(r) : 'no image came back'}`);
        for (const s of saved) closeImages.push({ view, ...s });
      }
      // Without its closer views a second look has only the picture the first
      // one failed, and clearing a verdict on that evidence is not a second
      // look. The critic's verdict stands.
      if (missed.length) {
        second = { error: `the closer views did not render (${clip(missed.join('; '), 200)}), so the critic's verdict stands` };
      } else {
        try {
          second = await (referee ?? critic).judge({
            brief: theBrief, summary, images: [...images, ...closeImages], parent: span, recheck: verdict, name: 'referee',
          });
          criticPass = passes(second);
        } catch (e) {
          second = { error: e.message };
        }
      }
    }
    const passed = fitmentPass && (criticPass || !criticGates);

    const record = {
      round: n,
      passed,
      gates: {
        fitment: fitmentPass ? 'pass' : 'fail',
        critic: criticPass ? 'pass' : (criticGates ? 'fail' : 'fail (advisory)'),
      },
      fitment: fitment && {
        verdict: fitment.verdict,
        blocking: fitment.findings.filter((f) => f.severity !== 'low').map(brief),
        minor: fitment.findings.filter((f) => f.severity === 'low').map(brief),
        notChecked: fitment.notChecked,
        notPlaced: fitment.notPlaced,
      },
      failures: reasons,
      critic: verdict,
      ...(second ? { secondLook: second } : {}),
      renders: images.map((i) => i.path),
    };
    // A rejected round is the gate working, not an error. AgentOps drew the
    // two rounds a run needed before it passed as failures, in red, beside
    // the one that passed. ERROR is kept for the gate itself breaking: a
    // render, the fitment check, or a verdict that did not come back.
    const broke = fr.isError ? `check_fitment refused the draft: ${textOf(fr)}`
      : views.length && !images.length ? 'no render came back'
        : verdict?.error ? `the critic: ${verdict.error}`
          : second?.error ? `the second look: ${second.error}` : null;
    await span.end({
      ok: !broke,
      error: broke ? clip(broke, 300) : null,
      attrs: { 'gate.passed': passed, 'gate.fitment': record.gates.fitment, 'gate.critic': record.gates.critic },
    });

    log(`  gate: fitment ${fitmentPass ? 'PASS' : 'FAIL'}` +
      (fitmentPass ? '' : ` (${clip(reasons[0], 140)}${reasons.length > 1 ? ` +${reasons.length - 1} more` : ''})`) +
      ` · critic ${passes(verdict) ? 'PASS' : 'FAIL'}${criticGates ? '' : ' (advisory)'}` +
      (!passes(verdict) ? criticWhy(verdict) : '') +
      (verdict?.error ? ` (${clip(verdict.error, 140)})` : '') +
      (second
        ? ` → closer look ${criticPass ? 'PASS' : 'FAIL'}` +
          (second.error ? ` (${clip(second.error, 140)})` : (!criticPass ? criticWhy(second) : ''))
        : ''));

    lastGate = {
      constraints,
      failed: new Set((fitment?.findings ?? [])
        .filter((f) => f.severity === 'fatal' || f.severity === 'high')
        .flatMap((f) => f.ids ?? []).map((id) => String(id).split('@')[0])),
    };

    // What failed the round, apart from what was merely said about it. A
    // planner told everything at once acted on all of it: a note that the
    // Gulf centre stripe was "broken where it crosses the roof" failed
    // nothing, and the planner shortened the stripe twice and then deleted
    // it, taking the livery's best-known element with it.
    const deciding = second && !second.error ? second : verdict;
    const mustFix = [...reasons, ...(criticPass || !criticGates ? [] : blockingOf(deciding))];
    const advice = deciding?.error ? [] : (deciding?.notes ?? []);
    const { renders, ...forPlanner } = record;
    return {
      passed,
      broke,
      record,
      feedback: {
        text: JSON.stringify({ mustFix, advice, roundsLeft: rounds - n, ...forPlanner }, null, 2),
        images: images.map(({ view, data }) => ({ view, data })),
        design: standing,
      },
    };
  }

  const passed = passedIn !== null;
  const result = { brief: theBrief, passed, passedIn, rounds: history.length, summary, draft, history };

  if (passed && propose) {
    const last = history.at(-1);
    const why = `${summary}\n\nMeasured before it was offered: in round ${passedIn}, every fitment ` +
      'check ran with no high or fatal finding' +
      (last.gates.critic === 'pass'
        ? (last.secondLook
          ? ', and a closer second look passed the renders against the brief after the critic had not.'
          : ', and the critic passed the renders against the brief.')
        : `. The critic did not pass it, and was advisory: ${(last.critic?.notes ?? []).join('; ')}`);
    const { r } = await traced(trace.root, 'propose_design', { design: draft.design.length, fit: draft.fit.length }, () =>
      mcp.callTool('propose_design', { why, design: draft.design, fit: draft.fit }));
    if (r.isError) {
      result.proposalError = textOf(r);
      log(`  ✗ propose_design — ${textOf(r)}`);
    } else {
      result.proposalId = JSON.parse(textOf(r)).proposalId;
    }
  }

  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
