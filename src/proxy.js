/**
 * Anthropic-compatible proxy server.
 *
 * Exposes /v1/messages (and friends) speaking the Anthropic Messages API, then
 * translates to/from the OpenAI chat-completions format and routes to Mantis's
 * provider pool. This lets the *real* Claude Code CLI, the VS Code extension,
 * and JetBrains ACP run on any of Mantis's 22 providers.
 *
 * Point a client at it with:  ANTHROPIC_BASE_URL=http://127.0.0.1:8787
 *
 * Model tiers (opus / sonnet / haiku) route independently — configure them in
 * config.proxy.routes or via the admin UI. Inspired by Alishahryar1/free-claude-code.
 */

import http from 'http';
import { getConfig, PROVIDERS, buildConnection } from './config.js';
import { detectProbe, extractText } from './probes.js';
import { handleAdminRequest } from './admin.js';
import { classifyHttpError, anthropicErrorType, anthropicHttpStatus } from './errors.js';

// ─── ID helpers ─────────────────────────────────────────────────────

const rand = () => Math.random().toString(36).slice(2, 14);
const msgId = () => 'msg_' + rand();
const toolId = () => 'toolu_' + rand();

function log(...args) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`  [proxy ${t}]`, ...args);
}

// ─── Tier routing ───────────────────────────────────────────────────

/** Map a requested Claude model name to a routing tier. */
export function tierFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  return 'default';
}

/** Resolve a Claude model name to an upstream connection. */
function resolveRoute(anthropicModel) {
  const config = getConfig();
  const tier = tierFor(anthropicModel);
  const routes = config.proxy?.routes || {};
  const route = routes[tier] || routes.default || {};
  const providerKey = route.provider || config.provider;
  const conn = buildConnection(providerKey, route.model || undefined);
  return { tier, providerKey, conn };
}

// ─── Request translation: Anthropic → OpenAI ────────────────────────

/** Flatten an Anthropic tool_result content payload to a plain string. */
function stringifyToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(b => b && b.type === 'text')
      .map(b => b.text)
      .join('\n');
    if (text) return text;
    // tool result with only images / other blocks — note it so the model knows
    if (content.some(b => b && b.type === 'image')) return '[image tool result]';
  }
  return '';
}

/** Translate an Anthropic Messages request body into an OpenAI chat request. */
export function anthropicToOpenAI(body, model) {
  const messages = [];

  // System prompt — string or array of text blocks.
  if (body.system) {
    const sys = typeof body.system === 'string' ? body.system : extractText(body.system);
    if (sys) messages.push({ role: 'system', content: sys });
  }

  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === 'assistant') {
      // Assistant turns carry text and/or tool_use blocks.
      let text = '';
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      const out = { role: 'assistant' };
      out.content = text || null;
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
    } else {
      // User turns carry text, images, and/or tool_result blocks.
      // Each tool_result becomes its own OpenAI `tool` message.
      let text = '';
      const images = [];
      const toolResults = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_result') {
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: stringifyToolResult(block.content) || '(no output)',
          });
        } else if (block.type === 'image' && block.source?.type === 'base64') {
          images.push({
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        }
      }
      // Tool results first — OpenAI requires them right after the tool_calls turn.
      for (const tr of toolResults) messages.push(tr);
      if (text || images.length) {
        if (images.length) {
          const content = [];
          if (text) content.push({ type: 'text', text });
          content.push(...images);
          messages.push({ role: 'user', content });
        } else {
          messages.push({ role: 'user', content: text });
        }
      }
    }
  }

  const req = { model, messages, stream: true };
  if (typeof body.max_tokens === 'number') req.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    req.stop = body.stop_sequences;
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    const fns = body.tools
      .filter(t => t && t.name && t.input_schema) // skip server-side tool stubs
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema,
        },
      }));
    if (fns.length) req.tools = fns;
  }
  if (body.tool_choice && req.tools) {
    const tc = body.tool_choice;
    if (tc.type === 'auto') req.tool_choice = 'auto';
    else if (tc.type === 'any') req.tool_choice = 'required';
    else if (tc.type === 'tool' && tc.name) {
      req.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }
  return req;
}

const estimateTokens = (str) => Math.max(1, Math.round((str || '').length / 4));

// ─── OpenAI finish_reason → Anthropic stop_reason ───────────────────

function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop':
    case 'content_filter':
    default: return 'end_turn';
  }
}

// ─── Response sinks ─────────────────────────────────────────────────
// A "sink" receives translated events. The streaming sink writes Anthropic
// SSE as it goes; the buffer sink accumulates a single JSON response.

function makeStreamSink(res, model, inputTokens) {
  let blockIndex = -1;
  let openType = null; // 'text' | 'tool' | null
  let outChars = 0;

  const sse = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const closeBlock = () => {
    if (openType !== null) {
      sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      openType = null;
    }
  };

  const id = msgId();
  sse('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  sse('ping', { type: 'ping' });

  return {
    streaming: true,
    onText(text) {
      if (!text) return;
      if (openType !== 'text') {
        closeBlock();
        blockIndex++;
        openType = 'text';
        sse('content_block_start', {
          type: 'content_block_start', index: blockIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      outChars += text.length;
      sse('content_block_delta', {
        type: 'content_block_delta', index: blockIndex,
        delta: { type: 'text_delta', text },
      });
    },
    onToolCall(id, name) {
      closeBlock();
      blockIndex++;
      openType = 'tool';
      sse('content_block_start', {
        type: 'content_block_start', index: blockIndex,
        content_block: { type: 'tool_use', id, name, input: {} },
      });
    },
    onToolArgs(partial) {
      if (openType !== 'tool' || !partial) return;
      outChars += partial.length;
      sse('content_block_delta', {
        type: 'content_block_delta', index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: partial },
      });
    },
    finish(stopReason, usage) {
      closeBlock();
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: usage?.completion_tokens ?? Math.max(1, Math.round(outChars / 4)) },
      });
      sse('message_stop', { type: 'message_stop' });
      res.end();
    },
    error(type, message) {
      sse('error', { type: 'error', error: { type, message } });
      res.end();
    },
  };
}

function makeBufferSink() {
  let text = '';
  const tools = [];
  let current = null;
  return {
    streaming: false,
    onText(t) { text += t; },
    onToolCall(id, name) { current = { id, name, args: '' }; tools.push(current); },
    onToolArgs(p) { if (current) current.args += p; },
    build(model, stopReason, inputTokens, usage) {
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const t of tools) {
        let input = {};
        try { input = t.args ? JSON.parse(t.args) : {}; } catch { input = {}; }
        content.push({ type: 'tool_use', id: t.id, name: t.name, input });
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });
      return {
        id: msgId(), type: 'message', role: 'assistant', model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: usage?.prompt_tokens ?? inputTokens,
          output_tokens: usage?.completion_tokens ?? estimateTokens(text + tools.map(t => t.args).join('')),
        },
      };
    },
  };
}

// ─── Upstream consumption ───────────────────────────────────────────

/**
 * Read the upstream OpenAI SSE stream and drive `sink` with translated events.
 * Returns { stopReason, usage }.
 */
async function consumeUpstream(upstream, sink) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopReason = 'end_turn';
  let usage = null;

  // OpenAI tool-call index → { id, name, opened, pendingArgs }
  const tools = new Map();

  const flushUnopened = () => {
    for (const slot of tools.values()) {
      if (!slot.opened) {
        sink.onToolCall(slot.id || toolId(), slot.name || 'tool');
        slot.opened = true;
        if (slot.pendingArgs) sink.onToolArgs(slot.pendingArgs);
      }
    }
  };

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      break; // client/upstream dropped
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;

      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      if (parsed.usage) usage = parsed.usage;

      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason);

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) sink.onText(delta.content);

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let slot = tools.get(idx);
          if (!slot) {
            slot = { id: null, name: '', opened: false, pendingArgs: '' };
            tools.set(idx, slot);
          }
          if (tc.id && !slot.opened) slot.id = tc.id;
          if (tc.function?.name && !slot.opened) slot.name += tc.function.name;
          // Open the Anthropic tool block as soon as we have a name.
          if (!slot.opened && slot.name) {
            sink.onToolCall(slot.id || toolId(), slot.name);
            slot.opened = true;
            if (slot.pendingArgs) { sink.onToolArgs(slot.pendingArgs); slot.pendingArgs = ''; }
          }
          if (tc.function?.arguments) {
            if (slot.opened) sink.onToolArgs(tc.function.arguments);
            else slot.pendingArgs += tc.function.arguments;
          }
        }
      }
    }
  }

  flushUnopened();
  if (tools.size > 0 && stopReason === 'end_turn') stopReason = 'tool_use';
  return { stopReason, usage };
}

// ─── Error helpers ──────────────────────────────────────────────────

function sendError(res, status, type, message) {
  if (res.headersSent) {
    // Mid-stream — emit an SSE error event instead.
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`);
      res.end();
    } catch { /* socket already gone */ }
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

// ─── Canned probe responses ─────────────────────────────────────────

function respondCanned(res, wantStream, model, text) {
  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const sink = makeStreamSink(res, model, 1);
    sink.onText(text);
    sink.finish('end_turn');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: msgId(), type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  }
}

// ─── /v1/messages handler ───────────────────────────────────────────

async function handleMessages(req, res, bodyStr) {
  let body;
  try { body = JSON.parse(bodyStr); } catch {
    return sendError(res, 400, 'invalid_request_error', 'Request body is not valid JSON');
  }

  const wantStream = body.stream === true;
  const anthropicModel = body.model || 'claude-sonnet-4';
  const config = getConfig();

  // Short-circuit trivial probes — saves a provider round-trip and quota.
  if (config.proxy?.answerProbes) {
    const probe = detectProbe(body);
    if (probe) {
      log(`probe: ${probe.reason} — answered locally`);
      return respondCanned(res, wantStream, anthropicModel, probe.text);
    }
  }

  const { tier, providerKey, conn } = resolveRoute(anthropicModel);
  if (!conn) {
    return sendError(res, 500, 'api_error', `Proxy route points at unknown provider: ${providerKey}`);
  }
  if (conn.provider.requiresKey && !conn.headers['Authorization']) {
    return sendError(res, 401, 'authentication_error',
      `No API key configured for provider "${providerKey}". Set one with /provider key or the admin UI.`);
  }

  const oaiReq = anthropicToOpenAI(body, conn.model);
  const inputTokens = estimateTokens(JSON.stringify(oaiReq.messages));
  log(`${req.method} /v1/messages → ${tier} · ${providerKey} · ${conn.model} · ${wantStream ? 'stream' : 'json'}`);

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  let upstream;
  try {
    upstream = await fetch(conn.url, {
      method: 'POST',
      headers: conn.headers,
      body: JSON.stringify(oaiReq),
      signal: ac.signal,
    });
  } catch (err) {
    if (ac.signal.aborted) return;
    return sendError(res, 502, 'api_error', `Could not reach ${providerKey}: ${err.message}`);
  }

  if (!upstream.ok) {
    let errText = '';
    try { errText = await upstream.text(); } catch { /* ignore */ }
    const cls = classifyHttpError(upstream.status, errText, upstream.headers);
    log(`upstream ${upstream.status} (${cls.kind}): ${errText.slice(0, 160)}`);
    return sendError(
      res,
      anthropicHttpStatus(cls.kind),
      anthropicErrorType(cls.kind),
      `${providerKey} returned ${upstream.status}: ${cls.message} — ${errText.slice(0, 500)}`,
    );
  }

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const sink = makeStreamSink(res, anthropicModel, inputTokens);
    try {
      const { stopReason, usage } = await consumeUpstream(upstream, sink);
      sink.finish(stopReason, usage);
    } catch (err) {
      sink.error('api_error', `Stream failed: ${err.message}`);
    }
  } else {
    const sink = makeBufferSink();
    try {
      const { stopReason, usage } = await consumeUpstream(upstream, sink);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sink.build(anthropicModel, stopReason, inputTokens, usage)));
    } catch (err) {
      sendError(res, 502, 'api_error', `Stream failed: ${err.message}`);
    }
  }
}

// ─── Other endpoints ────────────────────────────────────────────────

function handleModels(res) {
  // A small Anthropic-style catalogue so client model pickers have entries.
  const now = new Date().toISOString();
  const ids = [
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
    'claude-3-5-haiku-20241022',
  ];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    data: ids.map(id => ({ type: 'model', id, display_name: id, created_at: now })),
    has_more: false,
    first_id: ids[0],
    last_id: ids[ids.length - 1],
  }));
}

function handleCountTokens(res, bodyStr) {
  let body;
  try { body = JSON.parse(bodyStr); } catch { body = {}; }
  const text = JSON.stringify(body.messages || []) + (typeof body.system === 'string' ? body.system : '');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: estimateTokens(text) }));
}

// ─── HTTP server ────────────────────────────────────────────────────

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const url = (req.url || '/').split('?')[0];

  // CORS preflight — harmless for a loopback tool, helps browser-based clients.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  // Admin UI is mounted alongside the proxy — including its API, Google auth
  // routes, and static assets.
  if (url === '/admin' || url.startsWith('/admin/') || url.startsWith('/api/') ||
      url.startsWith('/auth/') || url.startsWith('/assets/') || url === '/favicon.ico') {
    return handleAdminRequest(req, res);
  }

  if (url === '/' || url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Mantis proxy is running. POST /v1/messages — admin UI at /admin\n');
    return;
  }

  if (url === '/v1/models' && req.method === 'GET') {
    return handleModels(res);
  }

  if (url === '/v1/messages/count_tokens' && req.method === 'POST') {
    try { return handleCountTokens(res, await readBody(req)); }
    catch (err) { return sendError(res, 400, 'invalid_request_error', err.message); }
  }

  if (url === '/v1/messages' && req.method === 'POST') {
    try {
      const bodyStr = await readBody(req);
      return await handleMessages(req, res, bodyStr);
    } catch (err) {
      return sendError(res, 400, 'invalid_request_error', err.message);
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `No route for ${req.method} ${url}` } }));
}

/**
 * Start the proxy server.
 * @returns {Promise<import('http').Server>}
 */
export function startProxy({ port, host } = {}) {
  const config = getConfig();
  const P = config.proxy || {};
  const wantPort = port || P.port || 8787;
  const listenHost = host || P.host || '127.0.0.1';

  return new Promise((resolve, reject) => {
    let p = wantPort;
    const attempt = () => {
      const server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          try { sendError(res, 500, 'api_error', err.message); } catch { /* ignore */ }
        });
      });
      // If the port is busy, fall back to the next one.
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && p < wantPort + 12) {
          p += 1;
          attempt();
        } else {
          reject(err);
        }
      });
      server.listen(p, listenHost, () => {
        const base = `http://${listenHost}:${p}`;
        if (p !== wantPort) log(`port ${wantPort} was in use — using ${p}`);
        log(`listening on ${base}`);
        log(`point a client at it:  ANTHROPIC_BASE_URL=${base}`);
        log(`admin UI: ${base}/admin`);
        resolve(server);
      });
    };
    attempt();
  });
}
