/**
 * Desktop chat engine — runs a plain (tool-free) conversation turn.
 *
 * Reuses Mantis's streaming `callLLM` and provider resolution. Agent-mode
 * (tool-using, project-bound) sessions arrive in a later phase and will use
 * `createAgent()` instead.
 */

import { callLLM } from '../src/agent.js';
import { getConfig, PROVIDERS, buildConnection } from '../src/config.js';
import { buildChatPrompt } from '../src/prompt.js';

/**
 * Run one chat turn for a session. `session.messages` holds the prior
 * conversation (no system message). Streams via callbacks.
 * @returns {Promise<{role:string,content:string}|null>}
 */
export async function runChatTurn(session, { onText, onError, onThinking }, isCancelled) {
  const config = getConfig();
  const providerKey = session.provider || config.provider;
  const conn = buildConnection(providerKey, session.model || undefined);

  if (!conn) {
    onError(`Unknown provider: ${providerKey}`);
    return null;
  }
  if (conn.provider.requiresKey && !conn.headers['Authorization']) {
    onError(`No API key set for ${conn.provider.name}. Add one in Settings.`);
    return null;
  }

  const messages = [
    { role: 'system', content: buildChatPrompt() },
    ...session.messages,
  ];

  return callLLM(conn.url, conn.model, messages, conn.headers, conn.provider, {
    onText,
    onError,
    onThinking,
    onToken: () => {},
    tools: [], // plain chat — no tools
  }, isCancelled);
}

/** Fetch the model catalogue a provider exposes via /models. */
export async function listModels(providerKey) {
  const config = getConfig();
  const p = PROVIDERS[providerKey];
  if (!p) return { error: 'Unknown provider', models: [] };

  const base = providerKey === 'local'
    ? `${config.ollamaUrl.replace(/\/+$/, '')}/v1`
    : p.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = config.providerKeys?.[providerKey];
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(12000) });
    if (!r.ok) {
      return { error: r.status === 401 ? 'unauthorized — check the API key' : `HTTP ${r.status}`, models: [] };
    }
    const data = await r.json();
    const models = (Array.isArray(data.data) ? data.data : [])
      .map(m => (typeof m === 'string' ? m : m && m.id))
      .filter(Boolean)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return { models };
  } catch (err) {
    return { error: err.message, models: [] };
  }
}
