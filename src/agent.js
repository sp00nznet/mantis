import { toolDefinitions } from './tool-definitions.js';
import { buildSystemPrompt } from './prompt.js';
import { executeTool, getWorkingDirectory, getPlanMode } from './tools.js';
import { getConfig, PROVIDERS, buildConnection, markProviderCooldown } from './config.js';
import { shouldCompact, compactMessages, countContextTokens, getContextStats } from './context.js';
import { classifyHttpError } from './errors.js';
import { estimateCost } from './pricing.js';
import { initMcp, getMcpTools } from './mcp.js';

// ─── Per-Provider Rate Limiter ──────────────────────────────────────
// Enforces RPM/RPD limits from provider config AND adaptively backs off when
// the provider returns 429s — many free tiers throttle on tokens-per-minute,
// not request count, so a fixed RPM can't catch every case. The adaptive
// penalty self-tunes: it grows on each 429 and decays on each clean success.
// Factory: each call returns an independent limiter instance (used by swarm workers).
export function createRateLimiter() {
  return {
    timestamps: [],     // recent request timestamps (rolling 60s window)
    dailyCount: 0,
    dailyResetAt: 0,    // epoch ms when daily count resets
    lastRequestAt: 0,   // epoch ms of the most recent request
    adaptiveDelayMs: 0, // extra spacing accrued from recent 429s (self-tuning)

    // Called when the provider returns a 429 — slow future requests down.
    penalize() {
      this.adaptiveDelayMs = Math.min((this.adaptiveDelayMs || 0) + 5000, 30000);
    },

    // Called after a clean success — gradually relax the adaptive spacing.
    reward() {
      if (this.adaptiveDelayMs > 0) {
        this.adaptiveDelayMs = Math.max(0, this.adaptiveDelayMs - 2000);
      }
    },

    // Wait `waitMs`, showing a live countdown when a status callback exists.
    async _wait(waitMs, reason, onWait) {
      if (waitMs <= 0) return;
      const waitSec = Math.ceil(waitMs / 1000);
      if (onWait && waitSec >= 2) {
        onWait(`${reason} — waiting ${waitSec}s`);
        let remaining = waitSec;
        const interval = setInterval(() => {
          remaining--;
          if (remaining > 0) process.stdout.write(`\r  ${reason} — ${remaining}s        `);
        }, 1000);
        await new Promise(r => setTimeout(r, waitMs));
        clearInterval(interval);
        process.stdout.write('\r                                                              \r');
      } else {
        await new Promise(r => setTimeout(r, waitMs));
      }
    },

    async throttle(provider, providerKey, onWait) {
      const rl = provider.rateLimit;
      const now = Date.now();
      const windowMs = 60_000;

      // ─ Daily limit (rpd) ─
      if (rl?.rpd) {
        if (now > this.dailyResetAt) {
          this.dailyCount = 0;
          const tomorrow = new Date();
          tomorrow.setHours(24, 0, 0, 0);
          this.dailyResetAt = tomorrow.getTime();
        }
        if (this.dailyCount >= rl.rpd && onWait) {
          onWait(`Daily limit reached (${rl.rpd} requests/day for ${provider.name} free tier). Try again tomorrow or switch providers.`);
        }
      }

      // ─ RPM window-full check — wait for the oldest request to age out ─
      const minInterval = rl?.rpm ? Math.ceil(windowMs / rl.rpm) : 0;
      if (rl?.rpm) {
        this.timestamps = this.timestamps.filter(t => now - t < windowMs);
        if (this.timestamps.length >= rl.rpm) {
          const waitMs = this.timestamps[0] + windowMs - Date.now();
          await this._wait(waitMs, `Throttling to ${rl.rpm} RPM (${provider.name} free tier)`, onWait);
        }
      }

      // ─ Request spacing: the larger of the configured RPM interval and the
      //   adaptive penalty. The penalty is what actually keeps the agent loop
      //   under a provider's real (often undocumented, token-based) limit. ─
      const effectiveInterval = Math.max(minInterval, this.adaptiveDelayMs || 0);
      if (effectiveInterval > 0 && this.lastRequestAt) {
        const elapsed = Date.now() - this.lastRequestAt;
        if (elapsed < effectiveInterval) {
          const backingOff = (this.adaptiveDelayMs || 0) > minInterval;
          const reason = backingOff
            ? `Pacing for ${provider.name} (backed off after rate limit)`
            : `Pacing requests for ${provider.name}`;
          await this._wait(effectiveInterval - elapsed, reason, onWait);
        }
      }

      const stamp = Date.now();
      this.lastRequestAt = stamp;
      if (rl?.rpm) this.timestamps.push(stamp);
      if (rl?.rpd) {
        this.dailyCount++;
        if (this.dailyCount >= rl.rpd - 3 && this.dailyCount < rl.rpd && onWait) {
          onWait(`${rl.rpd - this.dailyCount} requests remaining today (${provider.name} free tier)`);
        }
      }
    }
  };
}

// Default shared rate limiter for the single-provider agent flow
const _rateLimiter = createRateLimiter();

export function createAgent(agentOpts = {}) {
  let messages = [];
  let initialized = false;
  let totalToolCalls = 0;
  let totalTurns = 0;
  let _cancelled = false;
  const _prefs = agentOpts.prefs || null; // per-user provider/model/keys, or null = global config
  const usage = { prompt: 0, completion: 0 }; // cumulative token usage this session
  let cost = 0;            // cumulative estimated USD cost
  let costKnown = true;    // false once a model with no known pricing is used

  function initSystem() {
    if (!initialized) {
      messages.push({
        role: 'system',
        content: buildSystemPrompt(getWorkingDirectory(), getPlanMode() ? 'plan' : 'normal')
      });
      initialized = true;
    }
  }

  function refreshSystemPrompt() {
    const prompt = buildSystemPrompt(getWorkingDirectory(), getPlanMode() ? 'plan' : 'normal');
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0].content = prompt;
    }
  }

  async function chat(userMessage, { onText, onToolCall, onToolResult, onError, onCompact, onThinking, onToken, onConfirmToolCall, signal, maxLoops: loopLimit, images }) {
    initSystem();
    _cancelled = false;
    // With images, the user turn becomes multi-part content (OpenAI vision format).
    let userContent = userMessage;
    if (Array.isArray(images) && images.length) {
      userContent = [
        { type: 'text', text: userMessage || '(see the attached image)' },
        ...images.map(url => ({ type: 'image_url', image_url: { url } })),
      ];
    }
    messages.push({ role: 'user', content: userContent });
    totalTurns++;

    if (shouldCompact(messages)) {
      const before = messages.length;
      messages = compactMessages(messages);
      if (onCompact) onCompact(before, messages.length);
    }

    const config = getConfig();

    // Resolve the LLM connection — from this agent's per-user prefs when given,
    // otherwise from the global config.
    let providerKey = (_prefs && _prefs.provider) || config.provider;
    let conn = buildConnection(providerKey, _prefs && _prefs.model, _prefs);
    if (!conn) {
      onError(`Unknown provider: ${providerKey}`);
      return;
    }
    let { url, headers, provider, model } = conn;

    // Provider failover chain (config.failover). getFallback hands callLLM the
    // next usable provider when the current one keeps erroring; once we fail
    // over we stick to the working provider for the rest of this turn (sticky)
    // rather than restarting on the dead one each loop iteration.
    const { resolveProviderChain, isProviderInCooldown } = await import('./config.js');
    const failoverOn = config.failover?.enabled !== false;
    const makeGetFallback = () => {
      if (!failoverOn) return undefined;
      return (triedKeys) => {
        const chain = resolveProviderChain(_prefs);
        for (const k of chain) {
          if (k === providerKey || triedKeys.has(k)) continue;
          if (isProviderInCooldown(k)) continue;
          const c = buildConnection(k, _prefs && _prefs.model && k === providerKey ? _prefs.model : null, _prefs);
          if (c) return c;
        }
        return null;
      };
    };

    // Connect to MCP servers (cached after the first call) and offer their
    // tools alongside the built-in ones.
    await initMcp();
    const effectiveTools = toolDefinitions.concat(getMcpTools());

    let loopCount = 0;
    const maxLoops = loopLimit || 25;
    let nudgeCount = 0;     // how many auto-continue nudges we've sent
    const maxNudges = 3;    // cap to prevent infinite loops
    let turnToolCalls = 0;  // tool calls made since the user's message

    while (loopCount < maxLoops && !_cancelled) {
      loopCount++;
      const assistantMessage = await callLLM(url, model, messages, headers, provider, { onText, onError, onThinking, onToken, signal, tools: effectiveTools, getFallback: makeGetFallback() }, () => _cancelled);
      if (!assistantMessage || _cancelled) return;

      // Sticky failover: if callLLM ended up on a different provider, adopt it
      // for the rest of this turn so we don't keep retrying the dead one.
      if (assistantMessage._providerKey && assistantMessage._providerKey !== providerKey) {
        providerKey = assistantMessage._providerKey;
        model = assistantMessage._model || model;
        provider = assistantMessage._provider || provider;
        const c2 = buildConnection(providerKey, null, _prefs);
        if (c2) { url = c2.url; headers = c2.headers; }
      }
      const usedKey = assistantMessage._providerKey || providerKey;
      const usedModel = assistantMessage._model || model;
      delete assistantMessage._provider; delete assistantMessage._providerKey; delete assistantMessage._model;

      // Accumulate token usage / cost when the provider reported it.
      if (assistantMessage.usage) {
        const u = assistantMessage.usage;
        usage.prompt += u.prompt_tokens || 0;
        usage.completion += u.completion_tokens || 0;
        const c = estimateCost(usedKey, usedModel, u.prompt_tokens || 0, u.completion_tokens || 0);
        cost += c.cost;
        if (!c.known) costKnown = false;
        delete assistantMessage.usage; // don't carry it back into the history
      }

      // Fallback: if the model wrote tool calls as JSON text instead of using
      // structured tool_calls, parse them from the text and execute anyway.
      if ((!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) && assistantMessage.content) {
        const parsed = parseTextToolCalls(assistantMessage.content);
        if (parsed.length > 0) {
          assistantMessage.tool_calls = parsed;
          // Drop the raw tool-call markup from the content we keep in history.
          const cleaned = stripToolCallMarkup(assistantMessage.content);
          assistantMessage.content = cleaned || undefined;
        }
      }

      messages.push(assistantMessage);

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        // Check if the model stopped prematurely — small models often pause after
        // a few tool calls to summarize instead of continuing the full task.
        // Nudge them to keep going if:
        //   1. The model used tools this turn (was in the middle of work)
        //   2. Response is short (status update, not a real answer)
        //   3. We haven't nudged too many times already
        const responseText = (assistantMessage.content || '').trim();
        if (turnToolCalls > 0 && responseText.length < 200 && nudgeCount < maxNudges) {
          nudgeCount++;
          messages.push({
            role: 'user',
            content: '[Continue with the remaining steps. Do not stop or summarize — complete the full task using your tools.]'
          });
          continue;
        }
        return;
      }

      for (const toolCall of assistantMessage.tool_calls) {
        if (_cancelled) return;
        const fnName = toolCall.function.name;
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          args = {};
        }

        totalToolCalls++;
        turnToolCalls++;

        // Confirm tool call with user if callback provided
        if (onConfirmToolCall) {
          const approved = await onConfirmToolCall(fnName, args);
          if (_cancelled) return;
          if (!approved) {
            onToolResult(fnName, '[Rejected by user]');
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: 'User rejected this tool call. Ask what they want instead, or try a different approach.'
            });
            continue;
          }
        }

        onToolCall(fnName, args);
        const result = await executeTool(fnName, args);
        if (_cancelled) return;
        onToolResult(fnName, result);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });
      }

      if (shouldCompact(messages)) {
        const before = messages.length;
        messages = compactMessages(messages);
        if (onCompact) onCompact(before, messages.length);
      }
    }

    if (loopCount >= maxLoops) {
      onError(`Agent loop hit safety limit (${maxLoops} iterations). Stopping to prevent runaway.`);
    }
  }

  function clearHistory() {
    messages = [];
    initialized = false;
    totalToolCalls = 0;
    totalTurns = 0;
    usage.prompt = 0;
    usage.completion = 0;
    cost = 0;
    costKnown = true;
  }

  function getMessages() { return messages; }

  function setMessages(newMessages) {
    messages = newMessages;
    initialized = messages.length > 0 && messages[0].role === 'system';
  }

  function getStats() {
    const ctx = getContextStats(messages);
    return {
      ...ctx,
      messageCount: messages.length,
      totalToolCalls,
      totalTurns,
      tokens: { ...usage, total: usage.prompt + usage.completion },
      cost,
      costKnown,
    };
  }

  // Cancel the current operation — sets flag, does NOT abort fetch
  function cancel() {
    _cancelled = true;
  }

  return { chat, clearHistory, refreshSystemPrompt, getMessages, setMessages, getStats, cancel };
}

export async function callLLM(url, model, messages, headers, provider, { onText, onError, onThinking, onToken, signal, rateLimiter, tools, getFallback }, isCancelled) {
  const limiter = rateLimiter || _rateLimiter;

  if (isCancelled()) return null;

  if (onThinking) onThinking(true);

  // Mutable connection — provider failover swaps these when a provider keeps
  // erroring. `tried` records every provider key we've burned this call so the
  // fallback resolver doesn't hand the same dead one back.
  let curUrl = url, curModel = model, curHeaders = headers, curProvider = provider;
  let curKey = (provider && provider._key) || null;   // best-effort; getFallback supplies keys
  const tried = new Set();

  const body = {
    messages,
    tools: tools || toolDefinitions,
    stream: true,
    stream_options: { include_usage: true }, // ask for a final token-usage chunk
  };

  let response;
  const maxRetries = 5;

  // Outer loop = provider attempts; inner loop = retries on the current provider.
  providerLoop:
  for (;;) {
    // Throttle for whichever provider is current.
    await limiter.throttle(curProvider, null, (msg) => { if (onError) onError(msg); });
    if (isCancelled()) { if (onThinking) onThinking(false); return null; }

    let switched = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (isCancelled()) { if (onThinking) onThinking(false); return null; }

      try {
        response = await fetch(curUrl, {
          method: 'POST',
          headers: curHeaders,
          body: JSON.stringify({ ...body, model: curModel }),
          signal,
        });
      } catch (err) {
        if (err.name === 'AbortError') { if (onThinking) onThinking(false); return null; }
        // Network-level failure — treat like a terminal provider failure so we
        // can fail over (the provider may simply be unreachable).
        const next = tryFailover(`Can't reach ${curProvider?.name || curUrl}`);
        if (next) { switched = true; break; }
        if (onThinking) onThinking(false);
        onError(`Failed to connect to LLM at ${curUrl}. Is the provider running?\n${err.message}`);
        return null;
      }

      if (!response.ok) {
        let errBody = '';
        try { errBody = await response.text(); } catch {}
        const cls = classifyHttpError(response.status, errBody, response.headers);

        if (cls.retryable && attempt < maxRetries) {
          let waitMs = cls.waitMs;
          if (cls.kind === 'rate_limit') {
            limiter.penalize();
            waitMs = Math.min(cls.waitMs * Math.pow(2, attempt), 60_000);
          }
          const waitSec = Math.max(1, Math.round(waitMs / 1000));
          if (onError) {
            let remaining = waitSec;
            onError(`${cls.message} — waiting ${remaining}s (attempt ${attempt + 1}/${maxRetries})`);
            const countdownInterval = setInterval(() => {
              remaining--;
              if (remaining > 0) {
                process.stdout.write(`\r  ${cls.message} — waiting ${remaining}s (attempt ${attempt + 1}/${maxRetries})  `);
              }
            }, 1000);
            await new Promise(r => setTimeout(r, waitSec * 1000));
            clearInterval(countdownInterval);
            process.stdout.write('\r  Retrying...                                           \n');
          } else {
            await new Promise(r => setTimeout(r, waitMs));
          }
          continue;
        }

        // Terminal for this provider (not retryable, or retries exhausted).
        // Try to fail over to the next provider before giving up.
        const next = tryFailover(`${cls.message} (HTTP ${response.status})`);
        if (next) { switched = true; break; }

        if (onThinking) onThinking(false);
        onError(`${cls.message} (HTTP ${response.status})\n${errBody.slice(0, 600)}`);
        return null;
      }

      break providerLoop; // success — response is set, fall through to streaming
    }

    if (switched) continue providerLoop;  // retry the whole thing on the new provider
    break;
  }

  // Helper hoisted via function declaration: rotate to the next provider if a
  // fallback resolver was supplied and one is available. Returns true if we
  // switched the cur* connection, false otherwise.
  function tryFailover(reason) {
    if (typeof getFallback !== 'function') return false;
    if (curKey) { markProviderCooldown(curKey); tried.add(curKey); }
    const nextConn = getFallback(tried);
    if (!nextConn) return false;
    curUrl = nextConn.url; curModel = nextConn.model;
    curHeaders = nextConn.headers; curProvider = nextConn.provider;
    curKey = nextConn.providerKey || null;
    if (onError) onError(`↪ ${reason} — failing over to ${nextConn.provider?.name || curKey}`);
    return true;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentParts = [];
  let toolCalls = {};
  let firstToken = true;
  let usage = null;        // token-usage chunk, when the provider sends one
  let runaway = false;     // set when repeated-token spam is detected
  let contentLen = 0;      // total streamed content length so far
  let lastRunawayCheck = 0;
  let tail = '';           // rolling window of the most recent content
  const MAX_CONTENT = 500_000;  // hard backstop against unbounded output

  while (true) {
    if (isCancelled()) {
      if (onThinking) onThinking(false);
      return null;
    }

    let readResult;
    try {
      readResult = await reader.read();
    } catch {
      if (onThinking) onThinking(false);
      return null;
    }

    const { done, value } = readResult;
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (isCancelled()) {
        if (onThinking) onThinking(false);
        return null;
      }

      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      // The usage chunk arrives last and carries no choices.
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) {
        if (firstToken && onThinking) {
          onThinking(false);
          firstToken = false;
        }
        contentParts.push(delta.content);
        if (onToken) onToken(Math.max(1, Math.round(delta.content.length / 4)));
        onText(delta.content);

        // Runaway-output guard: a degrading small model can fall into emitting
        // the same token (classically "</function>") thousands of times. Watch
        // a rolling tail and bail the moment a short unit repeats itself into
        // the ground, so a wedged model can't pin the turn or poison the
        // history with megabytes of spam.
        contentLen += delta.content.length;
        tail += delta.content;
        if (tail.length > 4000) tail = tail.slice(-4000);
        if (contentLen - lastRunawayCheck >= 800) {
          lastRunawayCheck = contentLen;
          if (contentLen > 1200 && tailRepetition(tail)) runaway = true;
        }
        if (contentLen > MAX_CONTENT) runaway = true;
        if (runaway) {
          try { await reader.cancel(); } catch {}
          if (onThinking) onThinking(false);
          if (onError) onError('⚠ runaway repetition detected — truncating output');
          break;
        }
      }

      if (delta.tool_calls) {
        if (firstToken && onThinking) {
          onThinking(false);
          firstToken = false;
        }
        for (const tc of delta.tool_calls) {
          let idx = tc.index ?? 0;
          // If this index already has a complete name and we're getting a new name/id,
          // it's a new tool call (some providers reuse index 0 for all calls)
          if (toolCalls[idx] && toolCalls[idx].function.name && (tc.id || tc.function?.name)) {
            // Find next free index
            while (toolCalls[idx]) idx++;
          }
          if (!toolCalls[idx]) {
            toolCalls[idx] = {
              id: tc.id || `call_${idx}_${Date.now()}`,
              type: 'function',
              function: { name: '', arguments: '' }
            };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
          if (tc.function?.arguments) {
            toolCalls[idx].function.arguments += tc.function.arguments;
            if (onToken) onToken(Math.max(1, Math.round(tc.function.arguments.length / 4)));
          }
        }
      }
    }
    if (runaway) break;
  }

  if (onThinking) onThinking(false);

  let fullContent = contentParts.join('');
  if (runaway) fullContent = stripTrailingRepetition(fullContent);
  const toolCallArray = Object.values(toolCalls);

  const assistantMessage = { role: 'assistant' };
  if (fullContent) assistantMessage.content = fullContent;
  if (toolCallArray.length > 0) assistantMessage.tool_calls = toolCallArray;
  // Attach token usage non-enumerably: the agent loop reads it for cost
  // accounting (then deletes it), but it must NOT serialize into the message
  // history. Swarm replay loops push assistantMsg back verbatim, and strict
  // providers (Groq) reject a non-standard `usage` field on an assistant
  // message with HTTP 400. Non-enumerable = invisible to JSON.stringify but
  // still readable/deletable. Same treatment as the provenance fields below.
  if (usage) Object.defineProperty(assistantMessage, 'usage', { value: usage, enumerable: false, configurable: true, writable: true });
  // Report which provider/model actually answered so the caller can attribute
  // cost correctly and stick to the working provider after a failover. These
  // are non-enumerable so they never get serialized into the conversation
  // history that's sent back to the provider on the next turn.
  Object.defineProperty(assistantMessage, '_provider',    { value: curProvider, enumerable: false, configurable: true });
  Object.defineProperty(assistantMessage, '_providerKey', { value: curKey,      enumerable: false, configurable: true });
  Object.defineProperty(assistantMessage, '_model',       { value: curModel,    enumerable: false, configurable: true });

  // Clean success — let the limiter relax any adaptive 429 penalty.
  limiter.reward();

  return assistantMessage;
}

// Parse tool calls from the model's text output.
const _toolNames = new Set(toolDefinitions.map(t => t.function.name));

// A name is callable if it's a known built-in or an MCP-qualified tool
// (mcp__server__tool). MCP tools aren't in _toolNames since they're discovered
// at runtime, but the mcp__ prefix is unambiguous enough to accept.
function _isCallableName(name) {
  return _toolNames.has(name) || (typeof name === 'string' && name.startsWith('mcp__'));
}

// Coerce a raw <parameter> body into a JS value. Qwen3-Coder emits parameter
// values as raw text; try to recover JSON scalars/structures, else keep the
// string verbatim.
function coerceParamValue(raw) {
  const v = raw.trim();
  if (v === '') return v;
  try { return JSON.parse(v); } catch {}
  return v;
}

// Parse XML-style tool calls emitted by Hermes/Qwen-family models. Two shapes:
//   1. Qwen3-Coder:  <function=NAME><parameter=P>VALUE</parameter></function>
//      (optionally wrapped in <tool_call>...</tool_call>)
//   2. Hermes JSON:  <tool_call>{"name":"NAME","arguments":{...}}</tool_call>
// These models are the local/NIM default, so without this branch their tool
// calls vanish and the model degrades into "</function>" tag-spam.
function parseXmlToolCalls(text) {
  const calls = [];

  // Shape 1: <function=NAME> ... </function>
  const fnRegex = /<function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/function>/g;
  let m;
  while ((m = fnRegex.exec(text)) !== null) {
    const name = m[1].trim();
    if (!_isCallableName(name)) continue;
    const args = {};
    const paramRegex = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
    let p;
    while ((p = paramRegex.exec(m[2])) !== null) {
      args[p[1].trim()] = coerceParamValue(p[2]);
    }
    calls.push({
      id: `xml_${calls.length}_${Date.now()}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) }
    });
  }

  // Shape 2: <tool_call>{json}</tool_call>
  if (calls.length === 0) {
    const tcRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    while ((m = tcRegex.exec(text)) !== null) {
      try {
        const obj = JSON.parse(m[1].trim());
        if (obj.name && _isCallableName(obj.name)) {
          calls.push({
            id: `tc_${calls.length}_${Date.now()}`,
            type: 'function',
            function: { name: obj.name, arguments: JSON.stringify(obj.arguments || obj.parameters || {}) }
          });
        }
      } catch {}
    }
  }

  return calls;
}

// Strip recognized tool-call markup from assistant content once it's been
// parsed into structured tool_calls, so the raw tags don't get replayed into
// the model's own history on the next turn.
function stripToolCallMarkup(text) {
  if (!text) return text;
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<function\s*=\s*[^>]*>[\s\S]*?<\/function>/g, '')
    .trim();
}

// Find a short unit repeated into the tail of a string (the signature of
// runaway token-spam). Returns { reps, unit, start } where `start` is the
// index in `s` where the repetition run begins, or null if none qualifies.
function tailRepetition(s) {
  for (let L = 1; L <= 200; L++) {
    if (L > s.length) break;
    const unit = s.slice(s.length - L);
    if (!unit.trim()) continue;   // ignore pure-whitespace units
    let i = s.length - L, reps = 1;
    while (i - L >= 0 && s.slice(i - L, i) === unit) { reps++; i -= L; }
    if (reps >= 8 && reps * L >= 400) return { reps, unit, start: i };
  }
  return null;
}

// Cut a runaway repetition run off the end of a string, keeping whatever real
// content preceded it (which may still contain a recoverable tool call).
function stripTrailingRepetition(s) {
  const r = tailRepetition(s);
  return r ? s.slice(0, r.start).replace(/\s+$/, '') : s;
}

function parseTextToolCalls(text) {
  // Strategy 0: XML/Hermes tool calls (local + NIM models default to this).
  const xml = parseXmlToolCalls(text);
  if (xml.length > 0) return xml;

  const calls = [];

  // Strategy 1: Extract content between ```json ... ``` code fences
  const codeBlockRegex = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const content = match[1].trim();
    try {
      const obj = JSON.parse(content);
      if (obj.name && _toolNames.has(obj.name)) {
        calls.push({
          id: `text_${Date.now()}_${calls.length}`,
          type: 'function',
          function: {
            name: obj.name,
            arguments: JSON.stringify(obj.arguments || {})
          }
        });
      }
    } catch {}
  }

  // Strategy 2: Find bare JSON objects with brace counting
  if (calls.length === 0) {
    const namePattern = /\{\s*"name"\s*:\s*"(\w+)"/g;
    while ((match = namePattern.exec(text)) !== null) {
      const name = match[1];
      if (!_toolNames.has(name)) continue;
      const startIdx = match.index;
      let depth = 0;
      let endIdx = -1;
      for (let i = startIdx; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
      }
      if (endIdx === -1) continue;
      try {
        const obj = JSON.parse(text.slice(startIdx, endIdx));
        if (obj.name && obj.arguments) {
          calls.push({
            id: `text_${Date.now()}_${calls.length}`,
            type: 'function',
            function: {
              name: obj.name,
              arguments: JSON.stringify(obj.arguments)
            }
          });
        }
      } catch {}
    }
  }

  return calls;
}

// Exposed for unit tests only — the agent loop uses these internally.
export const _internals = {
  parseTextToolCalls,
  parseXmlToolCalls,
  stripToolCallMarkup,
  tailRepetition,
  stripTrailingRepetition,
};
