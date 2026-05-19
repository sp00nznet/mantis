/**
 * Trivial-probe short-circuit.
 *
 * Claude Code (and the VS Code / JetBrains clients) fire a number of tiny
 * "probe" requests that don't need a real model round-trip — connection
 * checks, quota pings, and 1-token warm-ups. Answering these locally saves
 * latency and, more importantly, saves quota on metered providers.
 *
 * Idea borrowed from Alishahryar1/free-claude-code, which "answers trivial
 * Claude Code probes locally to save latency and quota."
 *
 * detectProbe() is deliberately conservative: it only short-circuits requests
 * whose answer genuinely cannot matter (≤1 output token) or whose intent is
 * unambiguous (a bare `quota` / `ping` / `test` message). Anything that could
 * carry real meaning is forwarded to a provider.
 */

/** Flatten an Anthropic content field (string | block[]) to plain text. */
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
}

/** True when the message list is a single user turn with no tool traffic. */
function isSingleUserTurn(messages) {
  if (!Array.isArray(messages) || messages.length !== 1) return false;
  const m = messages[0];
  if (!m || m.role !== 'user') return false;
  // Reject anything carrying tool_result blocks — that's real work.
  if (Array.isArray(m.content)) {
    return !m.content.some(b => b && b.type === 'tool_result');
  }
  return true;
}

/**
 * Inspect an Anthropic Messages request body.
 * @returns {{reason: string, text: string} | null}
 *   non-null  → answer locally with `text`, skip the provider
 *   null      → forward to a provider as normal
 */
export function detectProbe(body) {
  if (!body || typeof body !== 'object') return null;

  // 1. Sub-token requests: the response content cannot carry information.
  //    Claude Code's startup connectivity/quota check sends max_tokens: 1.
  if (typeof body.max_tokens === 'number' && body.max_tokens <= 1) {
    return { reason: 'max_tokens<=1 connectivity probe', text: 'ok' };
  }

  // 2. Bare single-word probes in a lone user turn.
  if (isSingleUserTurn(body.messages)) {
    const text = extractText(body.messages[0].content).trim().toLowerCase();
    if (text === 'quota') {
      return { reason: 'quota probe', text: 'ok' };
    }
    if (text === 'ping') {
      return { reason: 'ping probe', text: 'pong' };
    }
    if (text === 'test' && (body.max_tokens ?? 0) <= 16) {
      return { reason: 'test probe', text: 'ok' };
    }
    if (text === '') {
      return { reason: 'empty probe', text: 'ok' };
    }
  }

  return null;
}
