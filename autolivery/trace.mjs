import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Every call the loop makes, as spans: on disk always, in AgentOps when asked.
 *
 * On disk first, and unconditionally. A trace that exists only in somebody
 * else's dashboard is one a network hiccup on stage can take away, and the
 * local file is also what the summary at the end is counted from — so the
 * numbers printed and the numbers exported cannot disagree.
 *
 * AgentOps is spoken to as plain OTLP/HTTP JSON rather than through its SDK.
 * The JS SDK instruments only the OpenAI Agents SDK and would not see a
 * hand-rolled call at all, and it brings the whole OpenTelemetry Node stack
 * with it — well over a hundred packages to send a few dozen spans.
 */

// List prices per million tokens, [input, output]. Cache writes are charged at
// 1.25x input and cache reads at 0.1x. An estimate from the published rates,
// not a bill — and a model missing from here is reported as UNPRICED rather
// than counted as free, which would make the total look cheaper than it was.
const PRICES = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
};

export function costOf(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const [inRate, outRate] = p.map((x) => x / 1e6);
  const input = (usage.input_tokens ?? 0) * inRate
    + (usage.cache_creation_input_tokens ?? 0) * inRate * 1.25
    + (usage.cache_read_input_tokens ?? 0) * inRate * 0.1;
  const output = (usage.output_tokens ?? 0) * outRate;
  return { input, output, total: input + output };
}

const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));

/** Long values are clipped for the export; the local file keeps what it is given. */
export const clip = (v, n = 2000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s;
};

/**
 * One model call as span attributes, in the names AgentOps reads — the older
 * `prompt_tokens`/`completion_tokens` rather than the newer OTel names, which
 * its queries do not count. Every backend reports through this, so a Claude
 * run and a local run land in the dashboard in the same shape.
 */
export function llmAttributes({ model, id, prompt = 0, completion = 0, cacheRead = 0, finish, text = '', toolCalls = [], cost = null }) {
  const attrs = {
    'gen_ai.response.model': model,
    'gen_ai.response.id': id,
    'gen_ai.usage.prompt_tokens': prompt ?? 0,
    'gen_ai.usage.completion_tokens': completion ?? 0,
    'gen_ai.usage.total_tokens': (prompt ?? 0) + (completion ?? 0),
    'gen_ai.usage.cache_read_input_tokens': cacheRead ?? 0,
    'gen_ai.completion.0.role': 'assistant',
    'gen_ai.completion.0.finish_reason': finish,
    'gen_ai.completion.0.content': clip(text),
  };
  if (cost) {
    attrs['gen_ai.usage.prompt_cost'] = cost.input;
    attrs['gen_ai.usage.completion_cost'] = cost.output;
    attrs['gen_ai.usage.total_cost'] = cost.total;
  }
  toolCalls.forEach((c, j) => {
    attrs[`gen_ai.completion.0.tool_calls.${j}.id`] = c.id;
    attrs[`gen_ai.completion.0.tool_calls.${j}.name`] = c.name;
    attrs[`gen_ai.completion.0.tool_calls.${j}.arguments`] = clip(c.arguments);
  });
  return attrs;
}

export async function createTrace({ dir, name = 'autolivery', tags = [], log = () => {}, agentopsKey = null, fetchImpl = fetch }) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'trace.jsonl');
  const traceId = randomBytes(16).toString('hex');
  const finished = [];
  let unsent = [];
  let undelivered = 0;
  const exporter = agentopsKey ? await agentOps(agentopsKey, { log, fetchImpl }) : null;

  const start = (kind, spanName, { parent = null, attrs = {} } = {}) => {
    const span = {
      traceId,
      spanId: randomBytes(8).toString('hex'),
      parentSpanId: parent?.spanId ?? null,
      kind,
      name: spanName,
      startNs: nowNs(),
      attrs: { ...attrs },
      async end({ ok = true, error = null, attrs: more = {} } = {}) {
        span.endNs = nowNs();
        span.ok = ok;
        span.error = error;
        Object.assign(span.attrs, more);
        span.ms = Number(span.endNs - span.startNs) / 1e6;
        finished.push(span);
        unsent.push(span);
        await appendFile(file, JSON.stringify({
          traceId, spanId: span.spanId, parent: span.parentSpanId, kind, name: spanName,
          ms: Math.round(span.ms), ok, error, attrs: span.attrs,
        }) + '\n');
      },
    };
    return span;
  };

  const root = start('session', name, { attrs: { 'agentops.tags': tags } });

  // Sent in batches — after every round and at the end — because a round is
  // the unit somebody watching the dashboard is waiting on. A failed send is
  // SAID, and counted, and the spans stay in the local file either way.
  const flush = async () => {
    if (!exporter || !unsent.length) { unsent = []; return; }
    const batch = unsent;
    unsent = [];
    try {
      await exporter.send(batch);
    } catch (e) {
      undelivered += batch.length;
      log(`  ! AgentOps: ${batch.length} span(s) not delivered (${e.message}); they are in ${file}`);
    }
  };

  const summary = () => {
    const llm = finished.filter((s) => s.kind === 'llm');
    const tools = finished.filter((s) => s.kind === 'tool');
    const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);
    const byTool = {};
    for (const t of tools) {
      const b = (byTool[t.name] ??= { calls: 0, failed: 0, ms: 0 });
      b.calls++;
      if (!t.ok) b.failed++;
      b.ms += t.ms;
    }
    return {
      traceId,
      file,
      ms: root.endNs ? root.ms : Number(nowNs() - root.startNs) / 1e6,
      llmCalls: llm.length,
      tokensIn: sum(llm, (s) => s.attrs['gen_ai.usage.prompt_tokens']),
      tokensOut: sum(llm, (s) => s.attrs['gen_ai.usage.completion_tokens']),
      cost: sum(llm, (s) => s.attrs['gen_ai.usage.total_cost']),
      unpriced: llm.filter((s) => s.attrs['gen_ai.usage.total_cost'] === undefined).length,
      toolCalls: tools.length,
      toolFailures: tools.filter((t) => !t.ok).length,
      byTool,
      exported: Boolean(exporter),
      undelivered,
      link: exporter ? `https://app.agentops.ai/sessions?trace_id=${traceId}` : null,
    };
  };

  return {
    root,
    start: (kind, spanName, opts = {}) => start(kind, spanName, { parent: root, ...opts }),
    flush,
    summary,
    async finish({ ok, attrs = {} }) {
      await root.end({ ok, attrs: { 'agentops.session.end_state': ok ? 'Success' : 'Fail', ...attrs } });
      await flush();
      return summary();
    },
  };
}

// --- AgentOps, as OTLP/HTTP JSON ------------------------------------------------

async function agentOps(apiKey, { log, fetchImpl }) {
  let token;
  try {
    const res = await fetchImpl('https://api.agentops.ai/v3/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new Error(body.error ?? `HTTP ${res.status}`);
    token = body.token;
  } catch (e) {
    // Not fatal: the loop is the point and the dashboard is a view of it. But
    // said, so a trace that never arrived is not waited for.
    log(`  ! AgentOps: could not authenticate (${e.message}); tracing to disk only`);
    return null;
  }
  return {
    async send(spans) {
      const res = await fetchImpl('https://otlp.agentops.ai/v1/traces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(otlp(spans)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

const value = (v) => {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  return { stringValue: clip(v) };
};

export function otlp(spans) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'autolivery' } }] },
      scopeSpans: [{
        scope: { name: 'autolivery' },
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          // AgentOps names spans "<operation>.<kind>" and reads the kind from
          // this attribute, not from the OTLP span kind.
          name: `${s.name}.${s.kind}`,
          kind: s.kind === 'session' ? 1 : 3,
          startTimeUnixNano: String(s.startNs),
          endTimeUnixNano: String(s.endNs),
          attributes: Object.entries({
            'agentops.span.kind': s.kind,
            'operation.name': s.name,
            ...s.attrs,
          }).filter(([, v]) => v !== undefined && v !== null)
            .map(([key, v]) => ({ key, value: value(typeof v === 'string' ? clip(v) : v) })),
          status: s.ok ? { code: 1 } : { code: 2, message: clip(s.error ?? 'failed', 500) },
        })),
      }],
    }],
  };
}
