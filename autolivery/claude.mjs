import { clip, costOf, llmAttributes } from './trace.mjs';
import { PLANNER_SYSTEM, CRITIC_SYSTEM, VERDICT, verdictOf, cutOff, NO_CALL, recheckOf } from './prompts.mjs';

/**
 * The two model-shaped parts of the loop, played by Claude: a planner that
 * writes the draft and a critic that looks at it. Kept apart from `loop.mjs`
 * so the loop can be run and tested with neither. The SDK is imported only
 * when a client is made, so the planner's conversation handling can be tested
 * with a stand-in client on a machine that never installed it — CI installs
 * liverykit, not this.
 *
 * The critic is a separate call with its own prompt and no view of the
 * planner's reasoning. A planner that marked its own work would be the "looks
 * fine" this loop is built to avoid; the critic sees what a spectator would —
 * the pictures and the brief — plus the planner's one-line account of what
 * the design is meant to be.
 */

// When the API declines a request on policy grounds, retry it on another
// model inside the same call rather than ending the run on a refusal nobody
// on stage can do anything about. `--no-fallback` turns it off.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

/** MCP content blocks, as the Messages API takes them in a tool result. */
function toBlocks(r) {
  const blocks = (r.content ?? []).map((c) => (c.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } }
    : { type: 'text', text: c.text ?? '' }));
  return blocks.length ? blocks : [{ type: 'text', text: '(no output)' }];
}

export async function createClient() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic();
}

/**
 * One Messages API call, as one `llm` span with tokens and cost on it — and,
 * given a budget, refused once the run has spent it.
 *
 * Checked BEFORE each call, from the list price of the ones already made, so
 * a run can overshoot by at most one call. A local planner once made 155
 * calls going in circles; on credits with no top-up, that is the difference
 * between a failed run and an emptied account. A model the price table does
 * not know cannot be held to a budget at all, and says so instead of
 * pretending to be.
 */
async function ask(client, params, { trace, parent, name, fallback, budget = null }) {
  if (budget && budget.spent >= budget.max) {
    throw new Error(`stopped before another model call: $${budget.spent.toFixed(2)} spent, ` +
      `and the budget is $${budget.max.toFixed(2)} (--max-cost)`);
  }
  const body = fallback ? { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' } : params;
  const lastUser = params.messages.at(-1);
  const span = trace.start('llm', name, {
    parent,
    attrs: {
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': params.model,
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.prompt.0.content': clip((lastUser?.content ?? [])
        .map((b) => b.text ?? (b.type === 'tool_result' ? `[result of ${b.tool_use_id}]` : `[${b.type}]`)).join('\n')),
    },
  });
  let res;
  try {
    res = await client.beta.messages.create(body);
  } catch (e) {
    await span.end({ ok: false, error: e.message });
    throw e;
  }
  const u = res.usage ?? {};
  const refused = res.stop_reason === 'refusal';
  const cost = costOf(res.model, u);
  if (budget) {
    if (!cost) throw new Error(`${res.model} has no known price, so a --max-cost budget cannot be enforced`);
    budget.spent += cost.total;
  }
  await span.end({
    ok: !refused,
    error: refused ? `declined: ${res.stop_details?.explanation ?? 'no reason given'}` : null,
    attrs: llmAttributes({
      model: res.model,
      id: res.id,
      prompt: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      completion: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      finish: res.stop_reason,
      text: textOf(res),
      toolCalls: res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: b.input })),
      cost,
    }),
  });
  return res;
}

/**
 * The planner keeps ONE conversation across rounds, so round three knows what
 * round one tried. The tool results owed to a round's finish_round are held
 * back and open the next round's message, ahead of the gate's verdict — the
 * API requires every tool call to be answered, and this way the answer and
 * the verdict arrive together.
 */
export function createPlanner({ client, model, effort, trace, fallback = true, budget = null, maxTurns = 30, maxNudges = 3 }) {
  const messages = [];
  let owed = [];
  return {
    async round({ n, rounds, brief, feedback, tools, call, parent, facts = null }) {
      const content = [...owed];
      owed = [];
      if (!feedback) {
        content.push({ type: 'text', text: `Brief: ${brief}\n\nYou have ${rounds} round(s). Round ${n} starts now.` +
          (facts ? `\n\nThe car, as the harness asked before you started. These answers are current; do not ask for them again.\n\n${facts}` : '') });
      } else {
        content.push({ type: 'text', text: `The gate's verdict on round ${n - 1}:\n${feedback.text}` });
        for (const im of feedback.images) {
          content.push({ type: 'text', text: `The ${im.view} render the critic judged:` });
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: im.data } });
        }
        content.push({ type: 'text', text: `Round ${n} of ${rounds}. Fix what the gate named, then finish_round.` });
      }
      messages.push({ role: 'user', content });

      let said = '';
      let nudges = 0;
      for (let turn = 0; turn < maxTurns; turn++) {
        const res = await ask(client, {
          model,
          max_tokens: 16000,
          system: [{ type: 'text', text: PLANNER_SYSTEM }],
          tools,
          messages,
          output_config: { effort },
          cache_control: { type: 'ephemeral' },
        }, { trace, parent, name: `planner-round-${n}`, fallback, budget });
        messages.push({ role: 'assistant', content: res.content });
        if (res.stop_reason === 'refusal') {
          throw new Error(`the planner declined: ${res.stop_details?.explanation ?? 'no reason given'}`);
        }
        if (res.stop_reason === 'pause_turn') continue;
        // Out of output with no call to answer: told why, not taken as done.
        // (A cut-off reply that does hold calls goes on below — each must be
        // answered, and a truncated one fails as a call rather than silently.)
        if (res.stop_reason === 'max_tokens' && !res.content.some((b) => b.type === 'tool_use')) {
          // Against the same budget as a turn of prose, so a model repeating
          // itself into the limit ends the round rather than the run.
          if (++nudges > maxNudges) return { summary: said };
          messages.push({ role: 'user', content: [{ type: 'text', text: cutOff(16000, false) }] });
          continue;
        }
        said = textOf(res) || said;

        const uses = res.content.filter((b) => b.type === 'tool_use');
        // Silence is not finish_round; see NO_CALL.
        if (!uses.length) {
          if (++nudges > maxNudges) return { summary: said };
          messages.push({ role: 'user', content: [{ type: 'text', text: NO_CALL }] });
          continue;
        }
        // One at a time and in order: draft operations build on each other.
        const results = [];
        let finished = null;
        for (const u of uses) {
          const r = await call(u.name, u.input ?? {});
          results.push({ type: 'tool_result', tool_use_id: u.id, content: toBlocks(r), is_error: Boolean(r.isError) });
          if (u.name === 'finish_round' && !r.isError) finished = String(u.input?.summary ?? '');
        }
        if (finished !== null) {
          owed = results;
          return { summary: finished };
        }
        messages.push({ role: 'user', content: results });
      }
      return { summary: said };
    },
  };
}

export function createCritic({ client, model, effort, trace, fallback = true, budget = null }) {
  return {
    async judge({ brief, summary, images, parent, recheck = null, name = 'critic' }) {
      const content = [];
      for (const im of images) {
        content.push({ type: 'text', text: `${im.view} view:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: im.data } });
      }
      content.push({ type: 'text', text: `The brief:\n${brief}\n\nWhat the designer says it is:\n${summary || '(nothing)'}` });
      if (recheck) content.push({ type: 'text', text: recheckOf(recheck) });
      const res = await ask(client, {
        model,
        max_tokens: 16000,
        system: CRITIC_SYSTEM,
        messages: [{ role: 'user', content }],
        output_config: { effort, format: { type: 'json_schema', schema: VERDICT } },
      }, { trace, parent, name, fallback, budget });
      if (res.stop_reason === 'refusal') throw new Error('the critic declined to judge');
      return verdictOf(textOf(res));
    },
  };
}
