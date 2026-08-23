import { createInterface } from 'node:readline';

/**
 * Hand-rolled JSON-RPC 2.0 stdio transport handler for MCP.
 *
 * Implements the minimal subset required for MCP tools:
 * - initialize
 * - notifications/initialized
 * - tools/list
 * - tools/call
 */
export function createProtocolServer({ toolHandler, serverInfo = { name: 'liverykit', version: '0.1.0' } }) {
  const responses = [];

  const send = (msg) => {
    responses.push(msg);
    if (typeof process !== 'undefined' && process.stdout?.write) {
      process.stdout.write(JSON.stringify(msg) + '\n');
    }
  };

  const handleRequest = async (req) => {
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0') return null;

    // Notifications (no id)
    if (req.id === undefined || req.id === null) {
      if (req.method === 'notifications/initialized') {
        // Notification acknowledged, no response needed.
      }
      return null;
    }

    const { id, method, params } = req;

    try {
      if (method === 'initialize') {
        const res = {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo,
          },
        };
        send(res);
        return res;
      }

      if (method === 'tools/list') {
        const tools = await toolHandler.listTools();
        const res = {
          jsonrpc: '2.0',
          id,
          result: { tools },
        };
        send(res);
        return res;
      }

      if (method === 'tools/call') {
        const { name, arguments: args } = params ?? {};
        const result = await toolHandler.callTool(name, args ?? {});
        const res = {
          jsonrpc: '2.0',
          id,
          result,
        };
        send(res);
        return res;
      }

      const res = {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
      send(res);
      return res;
    } catch (err) {
      const res = {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        },
      };
      send(res);
      return res;
    }
  };

  const listen = (input = process.stdin) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const req = JSON.parse(trimmed);
        await handleRequest(req);
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${err.message}` },
        });
      }
    });
    return rl;
  };

  return { handleRequest, listen, send, responses };
}
