import { mkdir, writeFile, rename, open } from 'node:fs/promises';
import { join } from 'node:path';
import { clip } from './trace.mjs';
import { ServerGone } from './mcp.mjs';
import { attemptsPage } from './attempts.mjs';

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
 * Each stripe a design declares, and whether the check found it whole: no
 * high stripe-across, stripe-offset or stripe-gap. Told to the critic, as a
 * piece measured whole is (see `measuredNote`). Nor a low one that could not
 * measure the band's coverage or a join: the note says there is no bare
 * bodywork, and a check that could not look cannot say so. One that could not
 * tell which way a piece runs says nothing about that, and the RSS4's
 * diagonal cockpit panels would otherwise keep every stripe on it unvouched.
 */
export function stripesOf(design, findings, unrun = []) {
  // A stripe check that did not run found nothing, and nothing is not clean.
  const unmeasured = unrun.includes('stripe-offset') || unrun.includes('stripe-gap');
  const names = new Set();
  for (const group of ['surfaces', 'paint']) {
    for (const spec of Object.values(design?.[group] ?? {})) {
      for (const r of spec.regions ?? []) if (typeof r?.constraints?.stripe === 'string') names.add(r.constraints.stripe);
    }
  }
  return [...names].map((name) => ({ name,
    clean: !unmeasured && !findings.some((f) => f.stripe === name && f.kind?.startsWith('stripe-')
      && (f.severity !== 'low' || (f.measured === false && f.kind !== 'stripe-across'))) }));
}

/**
 * What got looser between two sets of constraints. Every constraint in the
 * vocabulary is a floor (a number the placement must reach), a requirement
 * (true), or a name (a region to sit with, a stripe to be part of), so going
 * down, no longer being true and naming something else are the ways to loosen
 * one. A constraint that is none of these would have to say so here.
 */
function loosened(was, is) {
  const out = [];
  for (const [k, v] of Object.entries(was)) {
    const now = is[k];
    if (typeof v === 'number' && !(typeof now === 'number' && now >= v)) out.push(`${k} lowered from ${v} to ${now ?? 'nothing'}`);
    if (v === true && now !== true) out.push(`${k} removed`);
    // A region to sit with, or a stripe to be part of: letting go of it, or
    // naming another, gets out of the group or the stripe the round failed on
    // just as surely as lowering a floor.
    if (typeof v === 'string' && now !== v) out.push(now === undefined ? `${k} removed` : `${k} changed from ${v} to ${now}`);
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
export const passes = (v) => Boolean(v && !v.error && v.reads_at_distance && v.number_legible && v.palette_ok
  && v.matches_brief && !(v.requirements ?? []).some((r) => !r.present) && !(v.cut_off ?? []).length
  && !(v.unreadable ?? []).length);

/**
 * A verdict with every "cut off" the renderer's count contradicts taken out,
 * and kept beside it as `overruled` so the record shows both.
 *
 * `whole` is the ids of pieces measured whole in the view that shows them best
 * and with no high or fatal fitment finding against them. The critic's worst
 * mistake was calling exactly those cut off — a whole roundel, in four of the
 * six eval cases that had one — and the planner, believing it, shrank the
 * roundel round after round. Matched by the id the critic was shown, and by
 * nothing looser: "the roundel behind 85" could mean a piece the count never
 * saw, and a guess that clears a real fault is worse than a false alarm.
 */
export function overrule(v, whole) {
  if (!v || v.error || !whole?.size) return v;
  const gone = (v.cut_off ?? []).filter((c) => whole.has(c.id));
  if (!gone.length) return v;
  return { ...v, cut_off: v.cut_off.filter((c) => !whole.has(c.id)), overruled: gone };
}

/**
 * The ids `overrule` may hold a critic to: measured whole, named by no high or
 * fatal finding, and counted in a view the critic was shown. The count covers
 * the sheet's six views, and a critic given `left` alone was otherwise
 * overruled on the strength of a view it never saw. Shared with eval, which
 * overruled on `whole` alone and so scored verdicts the gate never gives.
 *
 * By piece id, and by the region's own id, which is what `lastGate.failed`
 * goes by. A high finding on `band@left_mid` protected nothing called `band`,
 * because this kept the piece's id and that the region's. A region is whole
 * when every piece of it is, and none of it with a high or fatal finding counts.
 */
export function wholeFor(measured, findings, views = ['sheet']) {
  const base = (id) => String(id).split('@')[0];
  const against = new Set((findings ?? []).filter((f) => f.severity === 'fatal' || f.severity === 'high')
    .flatMap((f) => f.ids ?? []).map(base));
  const seen = (m) => m.whole && (views.includes('sheet') || views.includes(m.home));
  const pieces = (measured ?? []).filter((m) => !against.has(base(m.id)));
  const whole = new Set(pieces.filter(seen).map((m) => m.id));
  for (const id of new Set(pieces.map((m) => base(m.id)))) {
    if (pieces.filter((m) => base(m.id) === id).every(seen)) whole.add(id);
  }
  return whole;
}

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

/**
 * A run, and if it throws on the way, its attempts page told so before the
 * error goes on. A server gone or a model that declined ended the run and
 * left the page reloading for good, as though it were still running.
 */
export async function run(opts) {
  const hooks = {};
  try {
    return await runRounds({ ...opts, hooks });
  } catch (e) {
    await hooks.stopped?.(e);
    throw e;
  }
}

async function runRounds({
  brief: theBrief, mcp, planner, critic, trace, out,
  rounds = 6, views = ['sheet'], shot = { width: 900, height: 540 }, sheetShot = { width: 2100, height: 960 },
  criticGates = true, propose = true, roundCalls = 40, looks = 2, log = () => {}, polish = 1, followRecording = false,
  referee = null, closer = ['left', 'right'], closeShot = { width: 1600, height: 960 }, seed = true, base = null,
  // How a save puts its bytes on disk. A test hands in one that fails
  // partway, which the dead-server test could not: its check that no
  // .partial was left passed just as well with no rename at all.
  write = writeSynced, hooks = {},
}) {
  await mkdir(out, { recursive: true });
  const draft = { design: [], fit: [] };
  const sizeFor = (view) => (view === 'sheet' ? sheetShot : shot);
  // What the last gate saw, for the one check that compares two rounds.
  let lastGate = null;
  const history = [];
  let feedback = null;
  let summary = '';
  let passedIn = null;
  let stopped = null;
  // A pass held while the planner polishes it, and what came of the polish.
  //
  // A pass ended the run, and the critic's advice with it: run 22 passed in
  // one round with a name the critic called thin and a stripe it said broke
  // over the roof, and neither could fail anything. So a pass that came with
  // advice gets one more round to act on it. The pass is kept whole, and it
  // is what a person is offered unless the polished draft passes the same
  // gate: a polish that breaks something costs a round and nothing else.
  let kept = null;
  let polishLeft = polish;
  let polished = null;
  // What the proposal came back with, for a page written after it: the save
  // that follows can still fail, and the design is in the inbox by then.
  let sent = null;
  const restore = (n, why) => {
    draft.design = [...kept.design];
    draft.fit = [...kept.fit];
    summary = kept.summary;
    passedIn = kept.round;
    polished = { round: n, passed: false, from: kept.round, why };
    log(`  round ${n}, the polish, is not offered: ${why}. Round ${kept.round}'s draft is.`);
  };
  // `base` identifies the working design and fit the run started from, which
  // its operations were written against: a replay onto another is not one.
  const snapshot = () => ({ brief: theBrief, ...(base ? { base } : {}), passed: passedIn !== null, passedIn,
    rounds: history.length, summary, draft, history, ...(stopped ? { stopped } : {}),
    ...(polished ? { polish: polished } : {}) });
  // Whole or not at all. Written in place, a crash mid-write left half a file
  // where the last round's had been, and nothing could replay or propose it.
  const save = async (result) => {
    const partial = join(out, 'result.json.partial');
    await write(partial, JSON.stringify(result, null, 2) + '\n');
    await rename(partial, join(out, 'result.json'));
    await syncDir(out);
    await page(result);
  };
  // The attempts page, from the same record, beside it. One that could not be
  // written is said and the run goes on: the page is for watching, and a paid
  // run lost to a display would be the wrong way round.
  const page = async (result) => {
    try {
      const partial = join(out, 'index.html.partial');
      await writeFile(partial, attemptsPage(result, { rounds }));
      await rename(partial, join(out, 'index.html'));
    } catch (e) {
      log(`  ! the attempts page was not written: ${e.message}`);
    }
  };
  // Before round 1, so the page can be opened as the run starts.
  // And the hook with it, before the first MCP call. It was set after
  // listTools, so a server that died answering that left a page with no
  // terminal state, reloading for a run that was over. Nothing the page is
  // written from depends on the tools.
  await page({ ...snapshot(), finished: false });
  hooks.stopped = (e) => page({ ...snapshot(), ...sent, finished: false, stopped: `the run ended: ${e.message}` });
  const tools = plannerTools(await mcp.listTools());

  // One door for every tool call, planner's and gate's alike, so each is
  // traced the same way and none can skip the trace by coming in sideways.
  const traced = async (parent, name, args, fn) => {
    // The arguments whole. They were clipped to 2000 characters here, so the
    // local trace lost every full draft, while the export clips on its own
    // way out (trace.mjs) and the local file keeps what it is given.
    const span = trace.start('tool', name, {
      parent,
      attrs: { 'tool.name': name, 'tool.parameters': args, 'agentops.entity.input': args },
    });
    let r;
    try {
      r = await fn();
    } catch (e) {
      // A dead server is the end of the run, not a refusal. Handed to the
      // planner as one, every call after it was refused too, and the planner
      // kept turning, up to thirty paid turns a round for six rounds. The
      // editor behind it stopping is the same end, and an EditorGone is one.
      if (e instanceof ServerGone) {
        await span.end({ ok: false, error: e.message });
        throw e;
      }
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
          let ops = args?.[key];
          // The operations sent as a JSON string, as run 26's planner sent its
          // whole first draft, wrapped in { "design": [...] }. Refused, it
          // wrote the same 3,000 tokens again, a 27 s turn. Taken when the
          // string is exactly that and nothing else; anything else is refused.
          let parsed = false;
          if (typeof ops === 'string') {
            try {
              const v = JSON.parse(ops);
              const list = Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : null;
              if (list) {
                ops = list;
                parsed = true;
              }
            } catch { /* refused below */ }
          }
          if (!Array.isArray(ops) || !ops.length) {
            return refuse(`${name} needs a non-empty "${key}" array of operations.`);
          }
          const candidate = { ...draft, [key]: [...draft[key], ...ops] };
          const r = await mcp.callTool('check_fitment', { proposal: candidate });
          if (r.isError) return refuse(`Refused, and the draft is unchanged: ${textOf(r)}`);
          draft[key] = candidate[key];
          return ok(`Accepted ${ops.length} operation(s)` +
            (parsed ? `, sent as a JSON string rather than an array; send "${key}" as the array itself next time` : '') +
            `. The draft holds ${draft.design.length} design ` +
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
          // Only a picture is a look. Counted before the answer came back, a
          // mistyped view was refused and still spent one of the round's two.
          if (!r.isError) await saveImages(r, `round-${n}-look-${++renders}-${view}`);
          return r;
        }
        case 'check_fitment':
          return mcp.callTool('check_fitment', { proposal: draft });
        case 'finish_round':
          // Kept by the harness from the call itself, not left to whichever
          // planner remembers to hand it back: a replay reads it from here.
          // And required: it is what a person reads in the inbox, and a round
          // submitted without one went out under the last round's words. Not
          // every server enforces a tool's schema.
          if (typeof args?.summary !== 'string' || !args.summary.trim()) {
            return refuse('finish_round needs a summary: what the draft is, in a sentence or two. ' +
              'It is what a person reads when the design reaches the inbox.');
          }
          summary = args.summary;
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
      // finish_round is never counted: the refusal below tells the planner to
      // call it, and counted, it was refused too and the round could not end.
      if (name !== 'finish_round' && ++calls > roundCalls) {
        return refuse(`This round has used its ${roundCalls} tool calls. Call finish_round now.`);
      }
      const { r, ms } = await traced(round, name, args, () => dispatch(name, args));
      if (name === 'finish_round' && !r.isError) sealed = true;
      const note = r.isError ? ` — ${clip(textOf(r), 160)}` : '';
      log(`  ${r.isError ? '✗' : '✓'} ${name} ${Math.round(ms)} ms${note}`);
      return r;
    };

    let said;
    try {
      said = await planner.round({ n, rounds, brief: theBrief, feedback, tools, call, parent: round, facts });
    } catch (e) {
      // A polish round that cannot finish — the budget spent, the planner
      // declining — costs the pass nothing. A dead server is still the end,
      // and so is any error in a replay: there the planner is the recording,
      // and its throwing is the replay failing, as when today's editor refuses
      // a recorded draft. Caught here, a replay put the earlier pass back and
      // reported passed without ever judging the polish it was asked to.
      if (!kept || followRecording || e instanceof ServerGone) throw e;
      history.push({ round: n, passed: false, polish: true, gates: { render: 'not run', fitment: 'not run', critic: 'not run' },
        failures: [`round ${n} could not be finished: ${e.message}`] });
      restore(n, `it could not be finished (${clip(e.message, 200)})`);
      await round.end({ ok: false, error: clip(e.message, 300), attrs: { 'round.passed': false, 'round.polish': true } });
      await save({ ...snapshot(), finished: false });
      break;
    }

    // A round that did not call finish_round was not submitted, whatever the
    // planner last wrote. Its last prose used to become the summary and the
    // round was gated anyway, so a draft could reach the inbox described as
    // "Let me check fitment once more", and the critic judged the renders
    // against that sentence. It is not gated; what it said is kept as what it
    // said, and the next round begins by hearing that it was not submitted.
    if (!sealed) {
      const words = said?.said ?? '';
      const { r: rd } = await traced(round, 'read_design', { proposal: '(the draft)' }, () =>
        mcp.callTool('read_design', { proposal: draft }));
      let design = null;
      try {
        const e = JSON.parse(textOf(rd));
        design = JSON.stringify({ palette: e.palette, identity: e.identity, surfaces: e.surfaces, paint: e.paint });
      } catch { /* said in the notice below */ }
      history.push({ round: n, passed: false, submitted: false, said: words, ...(kept ? { polish: true } : {}),
        gates: { render: 'not run', fitment: 'not run', critic: 'not run' },
        failures: [`round ${n} ended without finish_round, so it was not gated`] });
      log(`  round ${n} ended without finish_round, so it was not gated` +
        (words ? ` (it last said: ${clip(words, 140)})` : ''));
      await round.end({ ok: false, error: `round ${n} ended without finish_round`,
        attrs: { 'round.passed': false, 'round.submitted': false, 'round.said': clip(words) } });
      await trace.flush();
      if (kept) {
        restore(n, 'it ended without finish_round');
        await save({ ...snapshot(), finished: false });
        break;
      }
      feedback = {
        submitted: false,
        text: `Round ${n} ended without finish_round, so it was not submitted: the gate did not judge it, ` +
          'nothing was offered to anyone, and nothing you wrote in it was taken as a summary. The draft ' +
          `stands as you left it${design ? '' : ` (it could not be read back to show you: ${clip(textOf(rd), 200)})`}. ` +
          `${rounds - n} round(s) left.`,
        images: [],
        design,
      };
      // Saved like any other round, so the rounds a crash leaves behind include
      // one that was not submitted.
      await save({ ...snapshot(), finished: false });
      continue;
    }

    const gate = await judge({ n, round });
    history.push(gate.record);
    await round.end({
      ok: !gate.broke,
      error: gate.broke ? clip(gate.broke, 300) : null,
      attrs: { 'round.passed': gate.passed, 'round.fitment': gate.record.gates.fitment, 'round.critic': gate.record.gates.critic },
    });
    await trace.flush();
    if (kept) gate.record.polish = true;
    // A polish that did not pass, or broke the gate, hands back the pass it
    // was polishing: nothing about it makes the kept draft any less measured.
    if (kept && (!gate.passed || gate.stop)) {
      restore(n, gate.stop ? `the gate broke (${clip(gate.stop, 200)})` : 'it did not pass the gate');
      await save({ ...snapshot(), finished: false });
      break;
    }
    if (gate.passed) passedIn = n;
    if (kept) polished = { round: n, passed: true, from: kept.round };
    if (gate.stop) {
      stopped = gate.stop;
      log(`  stopped: ${stopped}`);
    }
    // Written every round, not once at the end. The workstation lost power
    // several times on 2026-09-12, and run 15's round-2 draft went with it.
    // A run that dies leaves the rounds it finished, and says it did not.
    await save({ ...snapshot(), finished: false });
    if (gate.stop) break;
    if (gate.passed) {
      // A replay plays the rounds a run recorded, whatever today's critic says
      // about the pass before them: a recorded polish round went unjudged when
      // today's verdict happened to come without advice.
      if (!(polishLeft > 0 && n < rounds && (gate.advice.length || followRecording))) break;
      polishLeft--;
      kept = { round: n, design: [...draft.design], fit: [...draft.fit], summary };
      log(`  round ${n} passed, with advice: one more round to act on it, keeping round ${n}'s draft unless that passes too`);
      feedback = {
        ...gate.feedback,
        text: JSON.stringify({
          passed: `Round ${n} passed the gate. Its draft is kept, and it is what a person is offered unless this ` +
            'round\'s draft passes the gate too.',
          polish: 'This round is for polish: act on the advice below where it makes the design better, and change ' +
            'nothing it does not name. Keep every element the brief asks for, every constraint as it stands, and ' +
            'the number group as it is unless the advice names it. A draft that does not pass costs only this ' +
            'round, since the kept one is offered instead.',
          advice: gate.advice,
          roundsLeft: rounds - n,
        }, null, 2),
        ask: 'Polish it',
      };
      continue;
    }
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
    // Kept apart from the fitment reasons. A view that did not render says
    // nothing about how the draft fits, and it was recorded as fitment
    // failing on a draft that had measured clean.
    const unrendered = [];
    for (const view of views) {
      const { r } = await traced(span, 'render_car', { view }, () =>
        mcp.callTool('render_car', { view, ...sizeFor(view), proposal: draft }));
      if (r.isError) {
        unrendered.push(`the ${view} render failed: ${textOf(r)}`);
        continue;
      }
      for (const s of await saveImages(r, `round-${n}-${view}`)) images.push({ view, ...s });
    }

    // Counted at the frame the critic's pictures were drawn at: a sheet's
    // cell, or the size of the single views. It was counted at 900x540
    // whatever the critic saw. A referee's closer views are not recounted:
    // they share the single views' aspect, and a fraction of a piece in view
    // barely moves with the size of the frame it is counted in.
    const count = views.includes('sheet') ? { view: 'sheet', ...sheetShot } : { view: views[0], ...shot };
    const { r: fr } = await traced(span, 'check_fitment', {}, () =>
      mcp.callTool('check_fitment', { proposal: draft, count }));
    let fitment = null;
    if (fr.isError) {
      reasons.push(`check_fitment refused the draft: ${textOf(fr)}`);
    } else {
      fitment = JSON.parse(textOf(fr));
      const blocking = fitment.findings.filter((f) => f.severity === 'fatal' || f.severity === 'high');
      for (const f of blocking) reasons.push(`${f.severity} ${f.kind}: ${f.why}`);
      // Except a check the car's profile cannot support. RSS4's helmet has no
      // scale, so a driver name on it could not be measured in any round, and
      // failing the round on that failed every round whatever the planner
      // did. It is still in the record and the proposal, just not a reason.
      const excused = new Set((fitment.unsupported ?? []).map((u) => u.notChecked));
      const skipped = fitment.notChecked.filter((c) => !excused.has(c));
      if (skipped.length) reasons.push(`checks that did not run: ${skipped.join(', ')}`);
      if (fitment.notPlaced.length) reasons.push(`not placed: ${clip(fitment.notPlaced, 400)}`);
    }

    // Where the design stands, as a design rather than a list of operations:
    // for a planner that begins each round without the ones before it, and
    // for the check below, which compares this round with the last.
    let standing = null;
    let effective = null;
    let unread = null;
    const { r: rd } = await traced(span, 'read_design', { proposal: '(the draft)' }, () =>
      mcp.callTool('read_design', { proposal: draft }));
    if (rd.isError) unread = textOf(rd) || 'an error, with no message';
    else {
      try {
        effective = JSON.parse(textOf(rd));
        standing = JSON.stringify({ palette: effective.palette, identity: effective.identity,
          surfaces: effective.surfaces, paint: effective.paint });
      } catch (e) {
        unread = `its answer was not JSON (${e.message})`;
      }
    }
    // The gate breaking, not a pass. Without the design the draft amounts to,
    // no constraint can be held to what it was last round, and the next round
    // could loosen the one that failed with nothing to notice.
    if (unread) {
      reasons.push(`read_design could not say what the draft amounts to, so no constraint could be held to ` +
        `last round's: ${clip(unread, 300)}`);
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
          reasons.push(`${id}: ${change} after it failed round ${lastGate.round}. A constraint is a requirement, ` +
            `not a setting to tune until the gate passes: move or resize ${id} instead.`);
        }
      }
    }
    const fitmentPass = !reasons.length;

    // What the renderer counted of each piece meant to be seen whole, told to
    // the critic and held against what it says: see `overrule`.
    const measured = fitment?.inView ?? null;
    const whole = wholeFor(measured, fitment?.findings ?? [], views);
    // Only from a measurement: a draft check_fitment refused has no findings,
    // and no findings would read as a clean stripe.
    // And only from checks that ran: without the model, stripe-offset and
    // stripe-gap are listed as not checked and find nothing. A check the
    // car's profile cannot support is excused, as it is from the gate.
    const stripes = fitment ? stripesOf(effective, fitment.findings ?? [], (fitment.notChecked ?? [])
      .filter((c) => !(fitment.unsupported ?? []).some((u) => u.notChecked === c))) : [];

    // Asked even when fitment has failed, so a round that fails both says so
    // at once instead of fixing one and discovering the other a round later.
    let verdict = null;
    let criticPass = false;
    if (images.length) {
      try {
        verdict = overrule(await critic.judge({ brief: theBrief, summary, images, parent: span, measured, stripes }), whole);
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
    // be revised anyway, so it costs no second look — and nor does one whose
    // critic is advisory, since its verdict gates nothing and the look is paid.
    let second = null;
    const closeImages = [];
    if (criticGates && fitmentPass && !criticPass && verdict && !verdict.error && closer.length) {
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
          second = overrule(await (referee ?? critic).judge({
            brief: theBrief, summary, images: [...images, ...closeImages], parent: span, recheck: verdict, name: 'referee',
            measured, stripes,
          }), whole);
          criticPass = passes(second);
        } catch (e) {
          second = { error: e.message };
        }
      }
    }
    // A critic that could not judge is the gate broken, not the round
    // failed. Fed back as a failed round, it named nothing to fix, since an
    // error lists nothing, and the planner was paid for another round told to
    // fix what the gate named. Where the critic gates, the run ends here and
    // says why; where it only advises, the round goes on without it, said.
    const unjudged = !images.length
      ? (views.length ? 'no render came back for it to judge' : 'it was given no views to render')
      : verdict?.error ?? null;
    const stop = criticGates && unjudged ? `the critic could not judge round ${n}: ${unjudged}` : null;
    const passed = fitmentPass && !unrendered.length && (criticPass || !criticGates);

    const record = {
      round: n,
      passed,
      gates: {
        render: unrendered.length ? 'fail' : 'pass',
        fitment: fitmentPass ? 'pass' : 'fail',
        critic: criticPass ? 'pass' : `${unjudged ? 'could not judge' : 'fail'}${criticGates ? '' : ' (advisory)'}`,
      },
      fitment: fitment && {
        verdict: fitment.verdict,
        blocking: fitment.findings.filter((f) => f.severity !== 'low').map(brief),
        minor: fitment.findings.filter((f) => f.severity === 'low').map(brief),
        notChecked: fitment.notChecked,
        unsupported: fitment.unsupported ?? [],
        notPlaced: fitment.notPlaced,
        // One line a piece rather than every view: whether it is whole where
        // it shows best, and if not, what is in front of it.
        ...(measured ? { inView: measured.map(({ id, home, view, visible, whole: w, hiddenBy, onMesh, why }) =>
          ({ id, home, ...(view && view !== home ? { view } : {}), visible, whole: w, ...(hiddenBy && !w ? { hiddenBy } : {}),
            ...(why ? { onMesh, why } : {}) })) } : {}),
      },
      failures: [...unrendered, ...reasons],
      critic: verdict,
      ...(second ? { secondLook: second } : {}),
      renders: images.map((i) => i.path),
      // The second look's pictures, kept apart from the first: the attempts
      // page showed only `renders`, beside a verdict given on these.
      ...(closeImages.length ? { closer: closeImages.map((i) => i.path) } : {}),
      // What the planner said it made and what it drafted, as they stood: a
      // replay puts the same design in front of new code without paying a
      // model to draw it again. The final draft alone could replay only the
      // last round.
      summary,
      draft: { design: [...draft.design], fit: [...draft.fit] },
    };
    // A rejected round is the gate working, not an error. AgentOps drew the
    // two rounds a run needed before it passed as failures, in red, beside
    // the one that passed. ERROR is kept for the gate itself breaking: a
    // render, the fitment check, or a verdict that did not come back.
    const broke = fr.isError ? `check_fitment refused the draft: ${textOf(fr)}`
      : unread ? `read_design: ${unread}`
      : views.length && !images.length ? 'no render came back'
        : verdict?.error ? `the critic: ${verdict.error}`
          : second?.error ? `the second look: ${second.error}` : stop;
    await span.end({
      ok: !broke,
      error: broke ? clip(broke, 300) : null,
      attrs: { 'gate.passed': passed, 'gate.fitment': record.gates.fitment, 'gate.critic': record.gates.critic },
    });

    log('  gate: ' +
      (unrendered.length ? `render FAIL (${clip(unrendered[0], 140)}` +
        `${unrendered.length > 1 ? ` +${unrendered.length - 1} more` : ''}) · ` : '') +
      `fitment ${fitmentPass ? 'PASS' : 'FAIL'}` +
      (fitmentPass ? '' : ` (${clip(reasons[0], 140)}${reasons.length > 1 ? ` +${reasons.length - 1} more` : ''})`) +
      ` · critic ${unjudged ? 'COULD NOT JUDGE' : passes(verdict) ? 'PASS' : 'FAIL'}${criticGates ? '' : ' (advisory)'}` +
      (!passes(verdict) ? criticWhy(verdict) : '') +
      (unjudged ? ` (${clip(unjudged, 140)})` : '') +
      (verdict?.overruled?.length
        ? ` · measured whole, so not cut off: ${verdict.overruled.map((c) => c.id).join(', ')}` : '') +
      (second
        ? ` → closer look ${criticPass ? 'PASS' : 'FAIL'}` +
          (second.error ? ` (${clip(second.error, 140)})` : (!criticPass ? criticWhy(second) : ''))
        : ''));

    // Which round, since a round that was never submitted has no gate.
    lastGate = {
      round: n,
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
    const mustFix = [...unrendered, ...reasons, ...(criticPass || !criticGates ? [] : blockingOf(deciding))];
    const advice = deciding?.error ? [] : (deciding?.notes ?? []);
    // The draft and summary are the planner's own words back; resent every
    // round they would only be paid for again.
    const { renders, closer: _closer, draft: _draft, summary: _summary, ...forPlanner } = record;
    return {
      passed,
      broke,
      stop,
      record,
      advice,
      feedback: {
        text: JSON.stringify({ mustFix, advice, roundsLeft: rounds - n, ...forPlanner }, null, 2),
        images: images.map(({ view, data }) => ({ view, data })),
        design: standing,
      },
    };
  }

  const result = { ...snapshot(), finished: true };
  const { passed } = result;

  if (passed && propose) {
    sent = await proposeDesign(result, async (args) => (await traced(trace.root, 'propose_design',
      { design: args.design.length, fit: args.fit.length }, () => mcp.callTool('propose_design', args))).r);
    Object.assign(result, sent);
    if (result.proposalError) log(`  ✗ propose_design — ${result.proposalError}`);
  }

  await save(result);
  return result;
}

/**
 * A file written and flushed to the disk before this returns. The rename a
 * save ends with puts in place only what the disk already holds: without the
 * flush, a filesystem that commits the rename before the data could still
 * greet the power loss that motivated renaming with an empty result.json.
 */
async function writeSynced(path, text) {
  const fh = await open(path, 'w');
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * The directory flushed too, so the rename itself is on the disk. Only where
 * the platform allows it: Windows will not open a directory to flush (EISDIR)
 * or will not flush the handle (EPERM), and some filesystems refuse fsync on a
 * directory (EINVAL). There the rename is as durable as the platform makes
 * it, and failing a round that saved would lose more than it kept. Any other
 * failure is thrown.
 */
async function syncDir(dir) {
  let fh = null;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch (e) {
    if (!['EISDIR', 'EPERM', 'EINVAL'].includes(e.code)) throw e;
  } finally {
    await fh?.close();
  }
}

/**
 * Offer a passed run's draft to the editor's inbox, saying how it was measured.
 *
 * Apart from `run` because a run is not its only caller. An editor holds one
 * proposal at a time, so a pass whose proposal was refused — a leftover from
 * the last demo is how — existed only in result.json, and the one way back
 * into the inbox was paying for another run. `--propose <run dir>` sends it
 * from there. `send` makes the call, so each caller traces it its own way.
 */
export async function proposeDesign(result, send) {
  // The round whose draft this is. Not the last: a polish round after it that
  // did not pass is last, and its verdict described a draft nobody is offered.
  const last = result.history.find((h) => h.round === result.passedIn) ?? result.history.at(-1);
  const p = result.polish;
  const unmeasured = last.fitment?.unsupported ?? [];
  const why = `${result.summary}\n\nMeasured before it was offered: in round ${result.passedIn}, every fitment ` +
    `check ${unmeasured.length ? 'this car\'s profile supports ' : ''}ran with no high or fatal finding` +
    (last.gates.critic === 'pass'
      ? (last.secondLook
        ? ', and a closer second look passed the renders against the brief after the critic had not.'
        : ', and the critic passed the renders against the brief.')
      : last.critic && !last.critic.error
        ? `. The critic did not pass it, and was advisory: ${(last.critic.notes ?? []).join('; ')}`
        : `. The critic, which was advisory, could not judge it: ${last.critic?.error ?? 'it was given no views to render'}`) +
    (unmeasured.length
      ? `\n\nNot measured, because this car's profile cannot: ` +
        `${unmeasured.map((u) => `${u.check} for ${u.ids.join(', ')} (${u.why})`).join('; ')}.`
      : '') +
    (p ? (p.passed
      ? `\n\nIt is round ${p.from}'s passing draft, polished in round ${p.round} on the critic's advice, and measured again.`
      : `\n\nA polish round after it, round ${p.round}, was not offered: ${p.why}.`) : '');
  const r = await send({ why, design: result.draft.design, fit: result.draft.fit });
  return r.isError ? { proposalError: textOf(r) } : { proposalId: JSON.parse(textOf(r)).proposalId };
}
