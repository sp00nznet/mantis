/**
 * Desktop chat engine — runs a plain (tool-free) conversation turn.
 *
 * Reuses Mantis's streaming `callLLM` and provider resolution. Agent-mode
 * (tool-using, project-bound) sessions arrive in a later phase and will use
 * `createAgent()` instead.
 */

import { callLLM, createAgent } from '../src/agent.js';
import { getConfig, PROVIDERS, buildConnection } from '../src/config.js';
import { setWorkingDirectory } from '../src/tools.js';
import { buildChatPrompt } from '../src/prompt.js';

/**
 * Run one chat turn for a session. `session.messages` holds the prior
 * conversation (no system message). Streams via callbacks. `prefs` carries the
 * signed-in user's provider/model/keys; null falls back to the global config.
 * @returns {Promise<{role:string,content:string}|null>}
 */
export async function runChatTurn(session, { onText, onError, onThinking }, isCancelled, prefs) {
  const config = getConfig();
  const providerKey = session.provider || (prefs && prefs.provider) || config.provider;
  const model = session.model || (prefs && prefs.model) || undefined;
  const conn = buildConnection(providerKey, model, prefs);

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

/**
 * Run one agent turn for a project-bound session. Uses the full Mantis tool
 * loop with the project folder as the working directory. Tool calls are
 * auto-approved (there's no terminal to confirm at). Mutates session.messages.
 * @param {object} ctl - { cancelled:boolean, agent } — agent is set so it can be cancelled
 */
export async function runAgentTurn(session, project, text, cb, ctl, prefs, images) {
  setWorkingDirectory(project.path);
  const agent = createAgent({ prefs });
  if (Array.isArray(session.messages) && session.messages.length) {
    agent.setMessages(session.messages);
  }
  ctl.agent = agent;

  await agent.chat(text, {
    maxLoops: 40,
    images,
    onText: cb.onText,
    onToolCall: cb.onToolCall,
    onToolResult: cb.onToolResult,
    onError: cb.onError,
    onThinking: cb.onThinking,
    onToken: () => {},
    onCompact: () => {},
    onConfirmToolCall: async () => !ctl.cancelled, // auto-approve unless stopped
  });

  session.messages = agent.getMessages();
}

/** Fetch the model catalogue a provider exposes via /models. */
export async function listModels(providerKey, prefs) {
  const config = getConfig();
  const p = PROVIDERS[providerKey];
  if (!p) return { error: 'Unknown provider', models: [] };

  const ollamaUrl = (prefs && prefs.ollamaUrl) || config.ollamaUrl;
  const base = providerKey === 'local'
    ? `${ollamaUrl.replace(/\/+$/, '')}/v1`
    : p.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  const keys = (prefs && prefs.providerKeys) || config.providerKeys || {};
  const apiKey = keys[providerKey];
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
