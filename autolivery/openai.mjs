import { clip, llmAttributes } from './trace.mjs';
import { PLANNER_SYSTEM, CRITIC_SYSTEM, VERDICT, verdictOf, cutOff, NO_CALL, recheckOf, measuredNote } from './prompts.mjs';

/**
 * The planner and critic again, over any OpenAI-compatible chat endpoint:
 * llama.cpp's llama-server, Ollama, vLLM, a workstation over a VPN.
 *
 * Plain fetch rather than an SDK. The wire format is small, and every server
 * implements a slightly different subset of it, so a client written against
 * the whole OpenAI surface would break in places this one never goes.
 *
 * Two differences from the Messages API are absorbed here, not in the loop.
 * A tool result is text only in this format, so a render a tool returns
 * travels in a user message straight after the tool results. And a model may
 * take no images at all: then it is told a picture was taken that it cannot
 * see, rather than sent one the server would reject — and rather than left to
 * believe render_car returned nothing.
 */

export async function connectEndpoint({ baseUrl, apiKey = null, fetchImpl = fetch }) {
  const url = baseUrl.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const get = async (at) => {
    const res = await fetchImpl(at, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  let models;
  try {
    models = ((await get(`${url}/models`)).data ?? []).map((m) => m.id);
  } catch (e) {
    throw new Error(`nothing answered at ${url}/models (${e.message}). Is the model server ` +
      'running, and is --base-url its /v1 address?');
  }

  // llama-server says how much context each request gets and whether the
  // model takes images. Other servers do not say, and then nothing is
  // assumed: null means unknown, not no.
  let props = null;
  try {
    props = await get(new URL('../props', `${url}/`).href);
  } catch { /* not llama.cpp */ }

  return {
    url,
    models,
    context: props?.default_generation_settings?.n_ctx ?? null,
    vision: props?.modalities ? Boolean(props.modalities.vision) : null,
    async chat(body) {
      const res = await fetchImpl(`${url}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new Error(`${url}/chat/completions: HTTP ${res.status}: ${clip(text, 400)}`);
      return JSON.parse(text);
    },
  };
}

const said = (m) => (typeof m?.content === 'string'
  ? m.content
  : (m?.content ?? []).map((p) => p.text ?? `[${p.type}]`).join('\n'));

async function ask(endpoint, body, { trace, parent, name }) {
  const span = trace.start('llm', name, {
    parent,
    attrs: {
      'gen_ai.system': 'openai-compatible',
      'gen_ai.request.model': body.model,
      'server.address': endpoint.url,
      'gen_ai.prompt.0.role': body.messages.at(-1)?.role,
      'gen_ai.prompt.0.content': clip(said(body.messages.at(-1))),
    },
  });
  let res;
  try {
    res = await endpoint.chat(body);
  } catch (e) {
    await span.end({ ok: false, error: e.message });
    throw e;
  }
  const choice = res.choices?.[0];
  const msg = choice?.message ?? {};
  const u = res.usage ?? {};
  // No cost: a self-hosted model has no price list to read, and a number made
  // up here would be summed into the total as if it had been measured. The
  // summary counts these calls as not priced, and says so.
  await span.end({
    ok: Boolean(choice),
    error: choice ? null : `no choices in the reply: ${clip(res, 300)}`,
    attrs: llmAttributes({
      model: res.model ?? body.model,
      id: res.id,
      prompt: u.prompt_tokens,
      completion: u.completion_tokens,
      cacheRead: u.prompt_tokens_details?.cached_tokens,
      finish: choice?.finish_reason,
      text: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments })),
    }),
  });
  if (!choice) throw new Error(`${endpoint.url} replied with no choices: ${clip(res, 300)}`);
  return choice;
}

const picture = (data, mime = 'image/png') => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
const textOf = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

/**
 * A conversation per round by default — see FRESH below — or one across all
 * of them with `fresh: false` (`--full-history`), as the Claude planner keeps.
 * Within a round, every tool call is answered by its own `tool` message, in
 * order, immediately after the assistant turn that made it — the format has
 * no other place to put an answer — and any pictures follow in one user
 * message after all of them.
 */
export function createPlanner({ endpoint, model, trace, sampling = {}, maxTurns = 30, maxTokens = 4096, maxNudges = 3, fresh = true }) {
  const sees = endpoint.vision !== false;
  let messages = [{ role: 'system', content: PLANNER_SYSTEM }];
  let owedPictures = [];
  let lastSummary = '';
  const done = (summary) => {
    lastSummary = summary;
    return { summary };
  };
  // Out of turns or nudges without finish_round: not submitted, so its last
  // prose goes back as what it said and never as a summary. Kept as one, a
  // fresh round began "At the end of round 2 you said: Let me check fitment
  // once more", and the loop put the same sentence in front of the critic.
  const unfinished = (said) => {
    lastSummary = '';
    return { summary: null, said };
  };
  const functions = (tools) => tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  return {
    async round({ n, rounds, brief, feedback, tools, call, parent, facts = null }) {
      // FRESH: each round after the first begins with the brief, what the
      // planner last said, the design its draft makes, and the verdict — not
      // the transcript. The transcript was the problem on a 64k model: every
      // round's findings and every re-sent region stayed in it, run 8 died in
      // round 6 at 72k tokens, and a small model in a long history kept
      // writing a tag the gate had rejected four rounds running.
      if (fresh && feedback) {
        messages = [{ role: 'system', content: PLANNER_SYSTEM }];
        owedPictures = [];
      }
      const parts = [];
      if (owedPictures.length) {
        parts.push({ type: 'text', text: 'Pictures the tools returned:' }, ...owedPictures);
        owedPictures = [];
      }
      if (!feedback) {
        // Round 1 only: later rounds start fresh on purpose, small, and are
        // shown the design by its ids.
        parts.push({ type: 'text', text: `Brief: ${brief}\n\nYou have ${rounds} round(s). Round ${n} starts now.` +
          (facts ? `\n\nThe car, as the harness asked before you started. These answers are current; do not ask for them again.\n\n${facts}` : '') });
      } else {
        if (fresh) {
          parts.push({ type: 'text', text: `Brief: ${brief}\n\nThis is round ${n} of ${rounds}. Earlier rounds ` +
            'are not repeated here; this is where things stand.' +
            (lastSummary ? `\n\nAt the end of round ${n - 1} you said: ${lastSummary}` : '') +
            (feedback.design ? '\n\nThe design your draft makes now, with every draft operation applied. ' +
              `Change it by the ids it already has:\n${feedback.design}` : '') });
        }
        // A round that was never submitted has no verdict, only that notice.
        const unsubmitted = feedback.submitted === false;
        parts.push({ type: 'text', text: unsubmitted ? feedback.text : `The gate's verdict on round ${n - 1}:\n${feedback.text}` });
        if (sees) {
          for (const im of feedback.images) {
            parts.push({ type: 'text', text: `The ${im.view} render the critic judged:` }, picture(im.data));
          }
        } else if (feedback.images.length) {
          parts.push({ type: 'text', text: 'The critic judged renders you cannot see, because this model ' +
            'takes no images. Its notes above say what it saw.' });
        }
        parts.push({ type: 'text', text: `Round ${n} of ${rounds}. ` +
          `${unsubmitted ? 'Finish the draft' : 'Fix what the gate named'}, then finish_round.` });
      }
      messages.push({ role: 'user', content: parts });

      let last = '';
      let nudges = 0;
      for (let turn = 0; turn < maxTurns; turn++) {
        const choice = await ask(endpoint, {
          ...sampling, model, messages, tools: functions(tools), tool_choice: 'auto', max_tokens: maxTokens,
        }, { trace, parent, name: `planner-round-${n}` });
        const msg = choice.message ?? {};
        // Some servers leave ids off, and a tool message has to name the call
        // it answers.
        const calls = (msg.tool_calls ?? []).map((c, i) => ({ ...c, id: c.id || `call_${n}_${turn}_${i}` }));
        // Cut off by the output limit: nothing in it is trustworthy, least of
        // all a tool call whose arguments may stop mid-object. It stays in the
        // conversation as text, so the model can see what it did, and is
        // answered with the reason instead of being run.
        if (choice.finish_reason === 'length') {
          // Only its start, and against the same budget as a turn of prose.
          // A reply that runs into the limit is usually a model repeating
          // itself: kept whole, eleven of them in a row grew the prompt by
          // 4161 tokens a turn until the server refused it and the run died
          // mid-round — and the repetition, sitting in the transcript, was
          // the model's best guess at what to write next.
          const text = msg.content ?? '';
          messages.push({ role: 'assistant', content: text.length > 300 ? `${text.slice(0, 300)} […cut off]` : text });
          if (++nudges > maxNudges) return unfinished(last);
          messages.push({ role: 'user', content: cutOff(maxTokens, calls.length > 0) });
          continue;
        }
        messages.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
        last = msg.content || last;
        // Silence is not finish_round. Sent back to act, a bounded number of
        // times, so a model that never acts still ends the round.
        if (!calls.length) {
          if (++nudges > maxNudges) return unfinished(last);
          messages.push({ role: 'user', content: NO_CALL });
          continue;
        }

        const pictures = [];
        let finished = null;
        for (const c of calls) {
          let args = null;
          try {
            args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
          } catch { /* answered below */ }
          const r = args === null
            ? { content: [{ type: 'text', text: `The arguments were not valid JSON: ${clip(c.function?.arguments, 200)}` }], isError: true }
            : await call(c.function?.name, args);
          const images = (r.content ?? []).filter((x) => x.type === 'image');
          let text = textOf(r) || (r.isError ? 'failed' : 'done');
          if (images.length) {
            text += sees
              ? '\n[The picture follows, after the tool results.]'
              : '\n[A picture was taken, but this model cannot see images.]';
            if (sees) pictures.push(...images.map((x) => picture(x.data, x.mimeType)));
          }
          messages.push({ role: 'tool', tool_call_id: c.id, content: r.isError ? `Error: ${text}` : text });
          if (c.function?.name === 'finish_round' && !r.isError) finished = String(args.summary ?? '');
        }
        if (finished !== null) {
          owedPictures = pictures;
          return done(finished);
        }
        if (pictures.length) {
          messages.push({ role: 'user', content: [{ type: 'text', text: 'Pictures the tools returned:' }, ...pictures] });
        }
      }
      return unfinished(last);
    },
  };
}

export function createCritic({ endpoint, model, trace, sampling = {}, maxTokens = 8192 }) {
  return {
    async judge({ brief, summary, images, parent, recheck = null, name = 'critic', measured = null }) {
      const parts = [];
      for (const im of images) parts.push({ type: 'text', text: `${im.view} view:` }, picture(im.data));
      parts.push({ type: 'text', text: `The brief:\n${brief}\n\nWhat the designer says it is:\n${summary || '(nothing)'}` });
      const note = measuredNote(measured);
      if (note) parts.push({ type: 'text', text: note });
      if (recheck) parts.push({ type: 'text', text: recheckOf(recheck) });
      // The caller's sampling, but a judge's temperature: a verdict that
      // changes when asked twice is not one.
      const choice = await ask(endpoint, {
        ...sampling,
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [{ role: 'system', content: CRITIC_SYSTEM }, { role: 'user', content: parts }],
        response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: VERDICT } },
      }, { trace, parent, name });
      // Said as the limit, not as a verdict that was not JSON. A thinking
      // model spent the 2048 tokens this once allowed on its reasoning, and
      // the run said only that the verdict did not parse, which sent somebody
      // to the prompt rather than to the limit.
      if (choice.finish_reason === 'length') {
        throw new Error(`the critic's reply was cut off at its ${maxTokens}-token limit before the verdict was ` +
          'complete; a model that thinks first can spend all of it reasoning. Raise it with --critic-max-tokens.');
      }
      return verdictOf(choice.message?.content ?? '');
    },
  };
}
