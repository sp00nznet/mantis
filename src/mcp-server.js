/**
 * Mantis as an MCP server (the mirror image of src/mcp.js).
 *
 * Exposes Mantis's built-in tools — read_file, edit_file, run_command,
 * search_files, search_memory, the memory tools, etc. — over stdio JSON-RPC so
 * OTHER agents (Claude Code, Cursor, any MCP client) can drive Mantis's
 * toolset. Wire it up from the other agent with:
 *
 *   { "command": "mantis", "args": ["mcp-server"] }
 *
 * Tools execute in the process working directory, so launch it from the project
 * root. Pass --read-only (or set MANTIS_MCP_READONLY=1) to expose only the
 * non-mutating subset (no write/edit/run).
 *
 * Pure stdio JSON-RPC, no deps. Writes ONLY protocol frames to stdout;
 * diagnostics go to stderr so they never corrupt the channel.
 */

import { toolDefinitions, readOnlyToolDefinitions } from './tool-definitions.js';
import { executeTool, setWorkingDirectory } from './tools.js';

const PROTOCOL_VERSION = '2025-06-18';

export function runMcpServer(argv = []) {
  const readOnly = argv.includes('--read-only') || process.env.MANTIS_MCP_READONLY === '1';
  setWorkingDirectory(process.cwd());

  // Convert Mantis's OpenAI-format tool defs into MCP tool descriptors.
  const defs = readOnly ? readOnlyToolDefinitions : toolDefinitions;
  const tools = defs.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    inputSchema: d.function.parameters || { type: 'object', properties: {} },
  }));
  const toolNames = new Set(tools.map((t) => t.name));

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

  let buf = '';
  process.stdin.on('data', async (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;

      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const { id, method } = msg;

      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'mantis', version: '1.0' },
        } });
      } else if (method === 'notifications/initialized') {
        /* notification — no response */
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools } });
      } else if (method === 'resources/list') {
        send({ jsonrpc: '2.0', id, result: { resources: [] } });
      } else if (method === 'prompts/list') {
        send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/call') {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        try {
          if (!toolNames.has(name)) {
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown or disabled tool: ${name}` }], isError: true } });
          } else {
            const out = await executeTool(name, args);
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(out) }] } });
          }
        } catch (err) {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } });
        }
      } else if (id !== undefined && method) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
  process.stderr.write(`[mantis mcp-server] ready — ${tools.length} tools${readOnly ? ' (read-only)' : ''}, cwd=${process.cwd()}\n`);
}
