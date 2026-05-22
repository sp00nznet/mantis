/**
 * MCP (Model Context Protocol) client.
 *
 * Connects to MCP servers configured in config.mcpServers and exposes their
 * tools to the agent loop. Each MCP tool is surfaced as a normal function tool
 * named `mcp__<server>__<tool>`.
 *
 * Transports:
 *   stdio — { command, args, env }   (a local subprocess; the common case)
 *   http  — { url, headers }         (Streamable HTTP)
 *
 * No dependencies — JSON-RPC over newline-delimited stdio, or POST for HTTP.
 */

import { spawn } from 'child_process';
import { getConfig } from './config.js';

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT = 30000;

// ─── One MCP server connection ──────────────────────────────────────

class McpServer {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec || {};
    this.tools = [];
    this.connected = false;
    this.error = null;
    this._proc = null;
    this._sessionId = null;     // http session id, if any
    this._nextId = 1;
    this._pending = new Map();  // id -> { resolve, reject }
    this._buf = '';             // stdout line buffer (stdio)
  }

  get isHttp() { return !!this.spec.url; }

  async connect() {
    if (this.isHttp) {
      /* nothing to spawn — HTTP is request-per-call */
    } else if (this.spec.command) {
      this._spawnStdio();
    } else {
      throw new Error('server needs a "command" (stdio) or "url" (http)');
    }

    await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mantis', version: '1.0' },
    });
    this._notify('notifications/initialized', {});

    const res = await this._request('tools/list', {});
    this.tools = Array.isArray(res?.tools) ? res.tools : [];
    this.connected = true;
  }

  _spawnStdio() {
    const env = { ...process.env, ...(this.spec.env || {}) };
    let command = this.spec.command;
    let args = this.spec.args || [];
    // Route through `cmd /c` on Windows so `.cmd` shims (npx, npm) resolve on
    // PATH — without shell:true, which escapes args poorly (DEP0190).
    if (process.platform === 'win32') {
      args = ['/c', command, ...args];
      command = 'cmd';
    }
    const proc = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._proc = proc;
    proc.stdout.on('data', (d) => this._onStdout(d));
    proc.stderr.on('data', () => { /* MCP servers log to stderr — ignore */ });
    proc.on('error', (err) => { this.error = err.message; this._failAll(err); });
    proc.on('exit', (code) => {
      this.connected = false;
      this._failAll(new Error(`server process exited (code ${code})`));
    });
  }

  _onStdout(chunk) {
    this._buf += chunk.toString('utf-8');
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this._pending.has(msg.id)) {
        const p = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
        else p.resolve(msg.result);
      }
      // server-initiated notifications (no id) are ignored
    }
  }

  _failAll(err) {
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
  }

  _request(method, params) {
    if (this.isHttp) return this._httpRequest(method, params);
    return new Promise((resolve, reject) => {
      if (!this._proc || this._proc.exitCode !== null) {
        reject(new Error('server is not running'));
        return;
      }
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      try {
        this._proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        this._pending.delete(id);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('request timed out'));
        }
      }, REQUEST_TIMEOUT);
    });
  }

  _notify(method, params) {
    if (this.isHttp) { this._httpNotify(method, params); return; }
    try {
      this._proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch { /* ignore */ }
  }

  _httpHeaders() {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(this.spec.headers || {}),
    };
    if (this._sessionId) h['Mcp-Session-Id'] = this._sessionId;
    return h;
  }

  async _httpRequest(method, params) {
    const id = this._nextId++;
    const r = await fetch(this.spec.url, {
      method: 'POST',
      headers: this._httpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this._sessionId = sid;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const ct = r.headers.get('content-type') || '';
    let msg;
    if (ct.includes('text/event-stream')) {
      msg = parseSse(await r.text(), id);
    } else {
      msg = await r.json();
    }
    if (!msg) throw new Error('empty response');
    if (msg.error) throw new Error(msg.error.message || 'MCP error');
    return msg.result;
  }

  _httpNotify(method, params) {
    fetch(this.spec.url, {
      method: 'POST',
      headers: this._httpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    }).catch(() => { /* fire and forget */ });
  }

  async callTool(toolName, args) {
    const res = await this._request('tools/call', { name: toolName, arguments: args || {} });
    const parts = (res?.content || []).map(c => {
      if (c.type === 'text') return c.text;
      if (c.type === 'image') return '[image omitted]';
      if (c.type === 'resource') return c.resource?.text || '[resource]';
      return JSON.stringify(c);
    });
    let out = parts.join('\n') || '(the tool returned no output)';
    if (res?.isError) out = 'Tool reported an error:\n' + out;
    return out;
  }

  kill() {
    try { this._proc?.kill(); } catch { /* ignore */ }
  }
}

/** Pull the JSON-RPC response with a given id out of an SSE body. */
function parseSse(text, id) {
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try {
      const j = JSON.parse(t.slice(5).trim());
      if (j.id === id) return j;
    } catch { /* ignore */ }
  }
  return null;
}

// ─── Registry ───────────────────────────────────────────────────────

let _servers = [];
let _toolMap = new Map();   // mcp__server__tool -> { server, toolName }
let _toolDefs = [];         // OpenAI-format tool definitions
let _initPromise = null;

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Connect to every configured MCP server and collect their tools.
 * Idempotent — the result is cached after the first call.
 * @returns {Promise<Array>} OpenAI-format tool definitions
 */
export function initMcp() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const servers = getConfig().mcpServers || {};
    for (const [name, spec] of Object.entries(servers)) {
      const srv = new McpServer(name, spec);
      _servers.push(srv);
      try {
        await srv.connect();
        for (const t of srv.tools) {
          const fq = `mcp__${sanitize(name)}__${sanitize(t.name)}`;
          _toolMap.set(fq, { server: srv, toolName: t.name });
          _toolDefs.push({
            type: 'function',
            function: {
              name: fq,
              description: `[MCP:${name}] ${t.description || t.name}`,
              parameters: (t.inputSchema && typeof t.inputSchema === 'object')
                ? t.inputSchema
                : { type: 'object', properties: {} },
            },
          });
        }
      } catch (err) {
        srv.error = err.message;
      }
    }
    return _toolDefs;
  })();
  return _initPromise;
}

/** Cached MCP tool definitions (empty until initMcp resolves). */
export function getMcpTools() {
  return _toolDefs;
}

/** Call an MCP tool by its namespaced name. Always resolves to a string. */
export async function callMcpTool(fqName, args) {
  const entry = _toolMap.get(fqName);
  if (!entry) return `Error: unknown MCP tool "${fqName}".`;
  if (!entry.server.connected) return `Error: MCP server "${entry.server.name}" is not connected.`;
  try {
    return await entry.server.callTool(entry.toolName, args);
  } catch (err) {
    return `MCP tool error (${fqName}): ${err.message}`;
  }
}

/** Connection status for each configured server — for /mcp and the admin UI. */
export function mcpStatus() {
  return _servers.map(s => ({
    name: s.name,
    transport: s.isHttp ? 'http' : 'stdio',
    connected: s.connected,
    tools: s.connected ? s.tools.length : 0,
    error: s.error,
  }));
}

/** Kill all stdio MCP subprocesses. */
export function shutdownMcp() {
  for (const s of _servers) s.kill();
}

// Make sure child processes don't outlive Mantis.
process.on('exit', shutdownMcp);
