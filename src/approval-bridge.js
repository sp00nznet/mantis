/**
 * Claude ↔ Mantis permission bridge (the engine).
 *
 * A minimal stdio MCP server that Claude Code talks to via
 * `--permission-prompt-tool mcp__mantis__approval_prompt`. Each tool-use request
 * is forwarded to the Mantis admin server (MANTIS_APPROVAL_URL), which asks the
 * human and long-holds the reply; we hand Claude back the canonical
 * { behavior: 'allow'|'deny', … } verdict.
 *
 * Invoked two ways, both of which call runApprovalBridge():
 *   - `mantis approval-bridge`               (works inside the single-exe SEA build)
 *   - `node scripts/claude-approval-mcp.mjs` (dev / explicit-node fallback)
 *
 * Pure Node, no deps — newline-delimited JSON-RPC over stdio. Writes ONLY
 * JSON-RPC to stdout (never logs there); diagnostics go to stderr.
 */

const PROTOCOL_VERSION = '2025-06-18';

const APPROVAL_TOOL = {
  name: 'approval_prompt',
  description: 'Ask the Mantis user to approve or deny a tool use.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'The tool Claude wants to run.' },
      input: { type: 'object', description: 'The tool input.' },
    },
    required: ['tool_name', 'input'],
  },
};

export function runApprovalBridge() {
  const APPROVAL_URL = process.env.MANTIS_APPROVAL_URL;
  const TURN = process.env.MANTIS_TURN;

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

  async function brokerApproval(args) {
    const toolName = (args && args.tool_name) || 'unknown';
    const input = (args && args.input) || {};
    let decision;
    try {
      const r = await fetch(APPROVAL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turn: TURN, toolName, input }),
      });
      decision = await r.json();
    } catch (e) {
      decision = { decision: 'deny', message: 'Could not reach Mantis: ' + e.message };
    }
    const verdict = decision && decision.decision === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: (decision && decision.message) || 'Denied.' };
    return { content: [{ type: 'text', text: JSON.stringify(verdict) }] };
  }

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
          serverInfo: { name: 'mantis-approval', version: '1.0' },
        } });
      } else if (method === 'notifications/initialized') {
        /* notification — no response */
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: [APPROVAL_TOOL] } });
      } else if (method === 'tools/call') {
        const result = await brokerApproval(msg.params && msg.params.arguments);
        send({ jsonrpc: '2.0', id, result });
      } else if (id !== undefined && method) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
}
