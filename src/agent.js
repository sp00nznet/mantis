import { toolDefinitions } from './tool-definitions.js';
import { buildSystemPrompt } from './prompt.js';
import { executeTool, getWorkingDirectory, getPlanMode } from './tools.js';
import { getConfig, PROVIDERS } from './config.js';
import { shouldCompact, compactMessages, countContextTokens, getContextStats } from './context.js';

// ─── Per-Provider Rate Limiter ──────────────────────────────────────
// Tracks request timestamps to enforce RPM/RPD limits from provider config.
// Factory: each call returns an independent limiter instance (used by swarm workers).
export function createRateLimiter() {
  return {
    timestamps: [],  // recent request timestamps
    dailyCount: 0,
    dailyResetAt: 0, // epoch ms when daily count resets

    async throttle(provider, providerKey, onWait) {
      const rl = provider.rateLimit;
      if (!rl) return; // no rate limit configured

      const now = Date.now();

      // Reset daily counter at midnight
      if (now > this.dailyResetAt) {
        this.dailyCount = 0;
        const tomorrow = new Date();
        tomorrow.setHours(24, 0, 0, 0);
        this.dailyResetAt = tomorrow.getTime();
      }

      // Check daily limit
      if (rl.rpd && this.dailyCount >= rl.rpd) {
        if (onWait) onWait(`Daily limit reached (${rl.rpd} requests/day for ${provider.name} free tier). Try again tomorrow or switch providers.`);
        // Don't block forever — just warn and let the API reject
      }

      // Enforce RPM — wait if we've sent too many requests in the last 60s
      if (rl.rpm) {
        const windowMs = 60_000;
        const minInterval = Math.ceil(windowMs / rl.rpm); // e.g. 5 RPM = 12000ms between requests
        this.timestamps = this.timestamps.filter(t => now - t < windowMs);

        if (this.timestamps.length >= rl.rpm) {
          // Window is full — wait until the oldest request falls out
          const waitUntil = this.timestamps[0] + windowMs;
          const waitMs = waitUntil - now;
          if (waitMs > 0) {
            const waitSec = Math.ceil(waitMs / 1000);
            if (onWait) onWait(`Throttling to ${rl.rpm} RPM (${provider.name} free tier). Waiting ${waitSec}s...`);
            // Countdown
            let remaining = waitSec;
            const interval = setInterval(() => {
              remaining--;
              if (remaining > 0) {
                process.stdout.write(`\r  Throttling: ${remaining}s...           `);
              }
            }, 1000);
            await new Promise(r => setTimeout(r, waitMs));
            clearInterval(interval);
            process.stdout.write('\r                                    \r');
          }
        } else if (this.timestamps.length > 0) {
          // Enforce minimum spacing between requests
          const lastReq = this.timestamps[this.timestamps.length - 1];
          const elapsed = now - lastReq;
          if (elapsed < minInterval) {
            const waitMs = minInterval - elapsed;
            await new Promise(r => setTimeout(r, waitMs));
          }
        }
      }

      this.timestamps.push(Date.now());
      this.dailyCount++;

      // Warn when approaching daily limit
      if (rl.rpd && this.dailyCount >= rl.rpd - 3 && this.dailyCount < rl.rpd) {
        if (onWait) onWait(`${rl.rpd - this.dailyCount} requests remaining today (${provider.name} free tier)`);
      }
    }
  };
}

// Default shared rate limiter for the single-provider agent flow
const _rateLimiter = createRateLimiter();

export function createAgent() {
  let messages = [];
  let initialized = false;
  let totalToolCalls = 0;
  let totalTurns = 0;
  let _cancelled = false;

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

  async function chat(userMessage, { onText, onToolCall, onToolResult, onError, onCompact, onThinking, onToken, onConfirmToolCall, signal, maxLoops: loopLimit }) {
    initSystem();
    _cancelled = false;
    messages.push({ role: 'user', content: userMessage });
    totalTurns++;

    if (shouldCompact(messages)) {
      const before = messages.length;
      messages = compactMessages(messages);
      if (onCompact) onCompact(before, messages.length);
    }

    const config = getConfig();

    // Build URL and headers based on active provider
    const provider = PROVIDERS[config.provider] || PROVIDERS.local;
    let url;
    let headers = { 'Content-Type': 'application/json' };

    if (config.provider === 'local') {
      url = `${config.ollamaUrl}/v1/chat/completions`;
    } else {
      url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const apiKey = config.providerKeys?.[config.provider];
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
    }

    const model = config.model;

    let loopCount = 0;
    const maxLoops = loopLimit || 25;
    let nudgeCount = 0;     // how many auto-continue nudges we've sent
    const maxNudges = 3;    // cap to prevent infinite loops
    let turnToolCalls = 0;  // tool calls made since the user's message

    while (loopCount < maxLoops && !_cancelled) {
      loopCount++;
      const assistantMessage = await callLLM(url, model, messages, headers, provider, { onText, onError, onThinking, onToken, signal }, () => _cancelled);
      if (!assistantMessage || _cancelled) return;

      // Fallback: if the model wrote tool calls as JSON text instead of using
      // structured tool_calls, parse them from the text and execute anyway.
      if ((!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) && assistantMessage.content) {
        const parsed = parseTextToolCalls(assistantMessage.content);
        if (parsed.length > 0) {
          assistantMessage.tool_calls = parsed;
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
    };
  }

  // Cancel the current operation — sets flag, does NOT abort fetch
  function cancel() {
    _cancelled = true;
  }

  return { chat, clearHistory, refreshSystemPrompt, getMessages, setMessages, getStats, cancel };
}

export async function callLLM(url, model, messages, headers, provider, { onText, onError, onThinking, onToken, signal, rateLimiter, tools }, isCancelled) {
  // Throttle to respect provider rate limits before sending
  const limiter = rateLimiter || _rateLimiter;
  await limiter.throttle(provider, null, (msg) => {
    if (onError) onError(msg);
  });

  if (isCancelled()) return null;

  const body = {
    model,
    messages,
    tools: tools || toolDefinitions,
    stream: true,
  };

  if (onThinking) onThinking(true);

  let response;
  const maxRetries = 5;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (isCancelled()) { if (onThinking) onThinking(false); return null; }

    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (onThinking) onThinking(false);
      if (err.name === 'AbortError') return null;
      onError(`Failed to connect to LLM at ${url}. Is the provider running?\n${err.message}`);
      return null;
    }

    // Handle 429 — distinguish quota exhaustion from temporary rate limits
    if (response.status === 429 && attempt < maxRetries) {
      let errBody = '';
      try { errBody = await response.text(); } catch {}

      // Quota exhaustion is NOT retryable — don't waste time waiting.
      // Be precise: "billing" appears in URLs of retryable errors too (e.g. Groq's
      // TPM rate limit includes console.groq.com/settings/billing in the message).
      // Only match actual quota/billing error codes, not URLs containing "billing".
      const isQuotaError = errBody.includes('"insufficient_quota"') ||
        errBody.includes('"exceeded your current quota"') ||
        errBody.includes('"plan_limit"') ||
        errBody.includes('"budget_exceeded"');
      if (isQuotaError) {
        if (onThinking) onThinking(false);
        onError(`Quota exceeded for this provider. Check your plan and billing.\n${errBody}`);
        return null;
      }

      let waitSec = 5;
      // Check Retry-After header first (standard HTTP)
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
        waitSec = parseInt(retryAfter.trim(), 10);
      } else {
        // Match: "retryDelay": "40s", "retry in 40.2s", "try again in 3s"
        const match = errBody.match(/(?:retry(?:Delay|[-_ ]?after)?["' :]*(in\s*)?|try again in\s*)([\d.]+)\s*s?/i);
        if (match) waitSec = Math.ceil(parseFloat(match[2]));
      }
      waitSec = Math.max(waitSec, 1);  // at least 1s
      waitSec = Math.min(waitSec, 120); // cap at 2 min
      // Countdown timer so user knows how long to wait
      if (onError) {
        let remaining = waitSec;
        onError(`Rate limited. Waiting ${remaining}s... (attempt ${attempt + 1}/${maxRetries})`);
        const countdownInterval = setInterval(() => {
          remaining--;
          if (remaining > 0) {
            // Overwrite previous line with updated countdown
            process.stdout.write(`\r  Rate limited. Waiting ${remaining}s... (attempt ${attempt + 1}/${maxRetries})  `);
          }
        }, 1000);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        clearInterval(countdownInterval);
        process.stdout.write('\r  Retrying...                                           \n');
      } else {
        await new Promise(r => setTimeout(r, waitSec * 1000));
      }
      continue;
    }

    // Handle 402 — Together AI uses this for spending rate caps (not actual billing failure)
    if (response.status === 402 && attempt < maxRetries) {
      let errBody = '';
      try { errBody = await response.text(); } catch {}
      // If user still has credits, this is a per-minute spend cap — retryable
      if (errBody.includes('"credit_limit"') || errBody.includes('Credit limit exceeded')) {
        const waitSec = 30;
        if (onError) {
          let remaining = waitSec;
          onError(`Spending rate cap hit. Waiting ${remaining}s... (attempt ${attempt + 1}/${maxRetries})`);
          const countdownInterval = setInterval(() => {
            remaining--;
            if (remaining > 0) {
              process.stdout.write(`\r  Spending rate cap hit. Waiting ${remaining}s... (attempt ${attempt + 1}/${maxRetries})  `);
            }
          }, 1000);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          clearInterval(countdownInterval);
          process.stdout.write('\r  Retrying...                                           \n');
        } else {
          await new Promise(r => setTimeout(r, waitSec * 1000));
        }
        continue;
      }
    }

    if (!response.ok) {
      if (onThinking) onThinking(false);
      let text = '';
      try { text = await response.text(); } catch {}
      onError(`LLM API error (${response.status}): ${text}`);
      return null;
    }

    break; // success
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentParts = [];
  let toolCalls = {};
  let firstToken = true;

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
  }

  if (onThinking) onThinking(false);

  const fullContent = contentParts.join('');
  const toolCallArray = Object.values(toolCalls);

  const assistantMessage = { role: 'assistant' };
  if (fullContent) assistantMessage.content = fullContent;
  if (toolCallArray.length > 0) assistantMessage.tool_calls = toolCallArray;

  return assistantMessage;
}

// Parse tool calls from the model's text output.
const _toolNames = new Set(toolDefinitions.map(t => t.function.name));

function parseTextToolCalls(text) {
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
