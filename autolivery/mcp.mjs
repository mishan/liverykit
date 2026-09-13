import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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

export async function connect({ command = process.execPath, args = [], cwd, env } = {}) {
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

  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`MCP ${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  });

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    if (gone) return reject(new ServerGone(gone));
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
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
    callTool: (name, args = {}) => request('tools/call', { name, arguments: args }),
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}
