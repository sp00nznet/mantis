#!/usr/bin/env node
/**
 * Mantis ↔ Claude Code permission bridge — a minimal stdio MCP server.
 *
 * Claude Code is launched with:
 *   --permission-prompt-tool mcp__mantis__approval_prompt
 *   --mcp-config '{"mcpServers":{"mantis":{"command":node,"args":[thisfile],
 *                  "env":{MANTIS_APPROVAL_URL,MANTIS_TURN}}}}'
 *
 * Whenever Claude wants to use a tool that needs permission, it calls
 * `approval_prompt({tool_name, input})`. We POST that to the Mantis admin
 * server, which asks the human in the session UI and long-holds the response,
 * then we hand Claude back the canonical { behavior: 'allow'|'deny', … } shape.
 *
 * Pure Node, no deps — newline-delimited JSON-RPC over stdio.
 */

const APPROVAL_URL = process.env.MANTIS_APPROVAL_URL;
const TURN = process.env.MANTIS_TURN;
const PROTOCOL_VERSION = '2025-06-18';

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

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
  // Claude expects the result text to be a JSON-stringified permission verdict.
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
