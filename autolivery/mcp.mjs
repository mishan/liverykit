import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EDITOR_META } from '../src/mcp/client.mjs';

/**
 * An MCP client over stdio: the other half of `liverykit --mcp`.
 *
 * Spawned rather than imported, although importing the tool handler would be
 * shorter. The agent is meant to be one more MCP client, with nothing the
 * server does not offer every other client — so the tools it uses are the
 * published ones, refusals included, and a capability it needed that was not
 * there had to be added to the server rather than reached around.
 *
 * Only what the loop needs: initialize, tools/list, tools/call. Requests are
 * answered by id, so nothing depends on the server replying in order.
 */

/**
 * The server is gone, and every call from here on fails the same way. Its own
 * class so the loop can tell it from a refusal: fed to the planner as one, a
 * dead server read as a tool saying no, and the planner kept paying for turns.
 */
export class ServerGone extends Error {}

/**
 * The editor behind the server stopped answering, which the server marks in
 * the tool result. A ServerGone, because for a run it is the same end: every
 * tool reaches the editor, and with the child still alive each call came back
 * an ordinary tool error that the planner took for a refusal and kept paying
 * to turn on.
 */
export class EditorGone extends ServerGone {}

export async function connect({
  command = process.execPath, args = [], cwd, env,
  timeoutMs = 5 * 60_000, warn = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

  // Kept, because the server explains itself on stderr — "no fitting editor is
  // listening" arrives there and nowhere else, and an agent that died saying
  // only "exited with code 1" would send somebody reading source to find out.
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

  const pending = new Map();
  let nextId = 1;
  let gone = null;
  const failAll = (why) => {
    for (const { reject } of pending.values()) reject(new ServerGone(why));
    pending.clear();
  };
  child.on('exit', (code, signal) => {
    gone = `the liverykit MCP server exited (${signal ?? `code ${code}`})` +
      (stderr.trim() ? `: ${stderr.trim()}` : '');
    failAll(gone);
  });
  child.on('error', (e) => {
    gone = `could not start the liverykit MCP server: ${e.message}`;
    failAll(gone);
  });

  // Said, not dropped. A line that did not parse, and a reply to no request
  // anybody was waiting on, both vanished here without a word; a garbled
  // answer left its request waiting for ever, and the run hung saying nothing.
  const late = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg = null;
    try { msg = JSON.parse(line); } catch { /* said below */ }
    if (!msg || typeof msg !== 'object') {
      warn(`autolivery: the MCP server wrote a line that is not JSON-RPC, and it was ignored: ${line.slice(0, 200)}`);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) {
      warn(msg.method
        ? `autolivery: the MCP server sent ${msg.method}, which this client does not handle; ignored`
        : `autolivery: the MCP server answered request ${msg.id}, ` +
          (late.has(msg.id) ? `${late.get(msg.id)}, after it had timed out` : 'which nothing is waiting for') +
          '; the reply was ignored');
      return;
    }
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`MCP ${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  });

  // The pipe can fail before the exit event arrives — a write after close()
  // did — and that is the server gone too, not a stream error nobody catches.
  child.stdin.on('error', (e) => {
    gone ??= `the liverykit MCP server's input closed (${e.message})`;
    failAll(gone);
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    if (!gone && !child.stdin.writable) gone = 'the liverykit MCP server\'s input is closed';
    if (gone) return reject(new ServerGone(gone));
    const id = nextId++;
    const what = method === 'tools/call' ? `${method} ${params?.name}` : method;
    // A limit on every request, generous because a render or a fitment check
    // on a big car is slow, so that a reply that never comes ends in an error
    // naming the call instead of a run that waits for ever.
    const timer = setTimeout(() => {
      pending.delete(id);
      late.set(id, what);
      reject(new Error(`MCP ${what}: no reply after ${timeoutMs / 1000} s. The server is stuck, or its ` +
        'reply was lost; one that arrives now is reported and ignored.'));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      method: what,
    });
    send({ jsonrpc: '2.0', id, method, params });
  });

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'autolivery', version: '0.1.0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    listTools: async () => (await request('tools/list', {})).tools,
    callTool: async (name, args = {}) => {
      const r = await request('tools/call', { name, arguments: args });
      if (r?._meta?.[EDITOR_META] === 'unreachable') {
        const said = (r.content ?? []).map((c) => c.text).filter(Boolean).join(' ');
        throw new EditorGone(`the editor stopped answering: ${said || 'no reason given'}`);
      }
      return r;
    },
    // Gone from this moment, not from whenever the exit event gets round to
    // it: a call in between wrote to a stream that had already ended.
    close: () => {
      gone ??= 'the liverykit MCP server was closed by this client';
      failAll(gone);
      child.stdin.end();
      child.kill();
    },
  };
}
