/**
 * Session hub — a per-process registry of live Mantis agent sessions.
 *
 * A "session" is an agent plus a terminal scrollback and a set of SSE
 * subscribers. The admin UI's Sessions tab creates and drives web sessions;
 * the REPL's `/remote` command attaches its own live session here so it can
 * be watched and driven from the browser.
 *
 * Output is emitted as xterm-friendly text (newlines normalised to CRLF, with
 * ANSI colour intact) so the browser can render it in a real terminal.
 */

import fs from 'fs';
import path from 'path';
import { createAgent } from './agent.js';
import { runExternalAgent, resolveAgentSpec } from './external-agents.js';
import { runSwarm, getSwarmPool } from './swarm.js';
import { getConfig } from './config.js';
import { getUserPrefs, listUsers, userHubSessionsDir } from './users.js';
import { setWorkingDirectory, getWorkingDirectory } from './tools.js';
import { truncate } from './utils.js';

const MAX_SCROLLBACK = 120_000; // chars of terminal history kept per session

let _seq = 0;
const _sessions = new Map();

// xterm needs CRLF, not bare LF.
const nl = (s) => String(s).replace(/\r?\n/g, '\r\n');

// ANSI palette — xterm renders these directly.
const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', grey: '\x1b[90m',
};

function fmtArgs(args) {
  return Object.entries(args || {})
    .map(([k, v]) => {
      let val = typeof v === 'string' ? v : JSON.stringify(v);
      if (val && val.length > 60) val = val.slice(0, 60) + '…';
      return `${k}=${val}`;
    })
    .join(' ');
}

// ─── Session ────────────────────────────────────────────────────────

class Session {
  constructor({ name, cwd, origin, agent, userId }) {
    this.id = 's' + (++_seq);
    this.name = name || `session-${this.id}`;
    this.cwd = cwd || getWorkingDirectory();
    this.origin = origin || 'web';   // 'web' = hub-driven · 'cli' = a /remote REPL
    this.userId = userId || null;    // owning user when Google auth is on
    this.createdAt = Date.now();
    this.status = 'idle';            // 'idle' | 'running'
    this.scrollback = '';            // terminal history (replayed to new viewers)
    this.subscribers = new Set();    // SSE response objects
    this.agent = agent || null;      // the built-in Mantis engine (createAgent)
    this.agentId = null;             // selected external CLI id ('claude'…) or null = native.
                                     // MUST stay separate from `this.agent`: clobbering the
                                     // engine object with an id string broke runWeb's
                                     // `session.agent.chat(...)` ("…chat is not a function").
    this.prefs = null;               // owning user's prefs (provider/keys) for swarm + engine
    this.solo = false;               // when true, skip swarm even if it's the default
    this._turnCancel = null;         // cancel fn for the in-flight turn (swarm or external agent)
    this.driver = null;              // { input(text, images, agentId), stop() }
  }

  /** Append terminal output and push it to every connected viewer. */
  write(text) {
    const t = nl(text);
    this.scrollback += t;
    if (this.scrollback.length > MAX_SCROLLBACK) {
      this.scrollback = this.scrollback.slice(-MAX_SCROLLBACK);
    }
    this._push({ type: 'write', text: t });
  }

  setStatus(status) {
    this.status = status;
    this._push({ type: 'status', status });
  }

  _push(frame) {
    const line = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of this.subscribers) {
      try { res.write(line); } catch { /* dead socket */ }
    }
  }

  /** Attach an SSE viewer — replays scrollback, then streams live. */
  subscribe(res) {
    try {
      res.write(`data: ${JSON.stringify({ type: 'status', status: this.status })}\n\n`);
      if (this.scrollback) {
        res.write(`data: ${JSON.stringify({ type: 'write', text: this.scrollback })}\n\n`);
      }
    } catch { /* ignore */ }
    this.subscribers.add(res);
  }

  unsubscribe(res) { this.subscribers.delete(res); }

  toJSON() {
    const stats = this.agent ? this.agent.getStats() : null;
    return {
      id: this.id, name: this.name, cwd: this.cwd, origin: this.origin,
      status: this.status, createdAt: this.createdAt,
      agent: this.agentId || 'native',   // which agent answers (drives the UI dropdown)
      messages: stats ? stats.messageCount : 0,
      toolCalls: stats ? stats.totalToolCalls : 0,
      contextPct: stats ? stats.pct : 0,
      tokens: stats ? stats.tokens.total : 0,
      cost: stats ? stats.cost : 0,
    };
  }
}

// ─── Web-session runner ─────────────────────────────────────────────

async function runWeb(session, text, images, agentId) {
  if (session.status === 'running') {
    session.write(`${A.yellow}[busy — wait for the current task to finish]${A.reset}\r\n`);
    return;
  }
  // Tools resolve against a single global cwd — point it at this session's
  // directory before each run. Concurrent runs in different dirs can race.
  setWorkingDirectory(session.cwd);
  session.setStatus('running');
  const imgNote = images && images.length ? ` ${A.grey}[+${images.length} image]${A.reset}` : '';
  session.write(`${A.blue}${A.bold}❯ ${text}${A.reset}${imgNote}\r\n`);

  // Which agent answers this turn: per-turn override (UI dropdown on /input)
  // wins, else the session default, else the built-in Mantis engine. Anything
  // other than 'native' is an external CLI (claude/codex/…) spawned per turn.
  const turnAgent = (agentId && agentId !== 'native') ? agentId
                  : (session.agentId && session.agentId !== 'native') ? session.agentId
                  : null;

  try {
    if (turnAgent) {
      await runWebExternal(session, turnAgent, text);
    } else if (shouldSwarmHub(session)) {
      await runSwarmInSession(session, text);
    } else {
      await session.agent.chat(text, {
        maxLoops: 50,
        images,
        onText: (t) => session.write(t),
        onToolCall: (name, args) =>
          session.write(`${A.cyan}⚙ ${name}${A.reset} ${A.grey}${fmtArgs(args)}${A.reset}\r\n`),
        onToolResult: (name, result) =>
          session.write(`${A.dim}${truncate(String(result), 500)}${A.reset}\r\n`),
        onError: (e) => session.write(`\r\n${A.red}${e}${A.reset}\r\n`),
        onConfirmToolCall: async () => true, // no terminal to confirm at — auto-approve
        onThinking: () => {},
        onToken: () => {},
        onCompact: (b, a) => session.write(`${A.yellow}[context compacted ${b}→${a}]${A.reset}\r\n`),
      });
    }
  } catch (e) {
    session.write(`\r\n${A.red}Error: ${e.message}${A.reset}\r\n`);
  }

  session.setStatus('idle');
  session.write('\r\n');
  persist(session); // checkpoint scrollback + engine history after every turn
}

/** Should this turn fan out across the provider swarm? */
function shouldSwarmHub(session) {
  if (session.solo) return false;
  const cfg = getConfig();
  if (!cfg.swarm?.default) return false;
  const minPool = cfg.swarm?.minPoolSize ?? 2;
  // Pass the session's prefs so per-user keys count toward the pool.
  return getSwarmPool(session.prefs).length >= minPool;
}

/** Render a swarm status event as a colored xterm line so the run is VISIBLE. */
function fmtSwarmStatus(type, provider, data) {
  switch (type) {
    case 'pool':
      return `${A.magenta}${A.bold}⚡ swarm${A.reset} ${A.grey}${data.count} providers${A.reset} `
           + `[${data.pool.join(', ')}] ${A.grey}· lead=${A.reset}${A.cyan}${data.lead}${A.reset} `
           + `${A.grey}· ${data.complexity}${A.reset}\r\n`;
    case 'phase':
      return `${A.magenta}${A.bold}▸ ${data}${A.reset}${provider ? ` ${A.grey}(${provider})${A.reset}` : ''}\r\n`;
    case 'plan-ready':
      return `${A.grey}  plan: ${data.explore} explore · ${data.code} code · ${data.review ? 1 : 0} review${A.reset}\r\n`;
    case 'explore-start':
      return `${A.grey}  ↳ ${provider} exploring…${A.reset}\r\n`;
    case 'explore-done':
      return `${A.green}  ✓ ${provider}${A.reset} ${A.grey}${data || ''}${A.reset}\r\n`;
    case 'explore-fail':
      return `${A.red}  ✗ ${provider}: ${data}${A.reset}\r\n`;
    case 'fallback':
      return `${A.yellow}  ⤳ ${provider}: ${data}${A.reset}\r\n`;
    case 'worker-tool':
    case 'review-tool':
      return `${A.grey}  ⚙ ${provider} ${data}${A.reset}\r\n`;
    case 'worker-error':
      return `${A.red}  ✗ ${provider}: ${data}${A.reset}\r\n`;
    case 'phase-detail':
      return `${A.grey}  ${data}${provider ? ` (${provider})` : ''}${A.reset}\r\n`;
    case 'review-done':
      return `${A.cyan}  review ${provider ? `(${provider})` : ''}: ${truncate(String(data), 300)}${A.reset}\r\n`;
    case 'error':
      return `${A.red}swarm error${provider ? ` (${provider})` : ''}: ${data}${A.reset}\r\n`;
    default:
      return '';
  }
}

/**
 * Run one turn through the provider swarm, streaming pool/phase/worker status
 * into the session terminal so the user can see it's actually delegating to
 * providers (not just running fast on one box).
 */
async function runSwarmInSession(session, text) {
  const swarm = runSwarm(text, {
    onText: (t) => session.write(t),
    onToolCall: (name, args, who) =>
      session.write(`${A.cyan}⚙ ${name}${A.reset}${who ? ` ${A.grey}@${who}${A.reset}` : ''} ${A.grey}${fmtArgs(args)}${A.reset}\r\n`),
    onToolResult: (name, result) =>
      session.write(`${A.dim}${truncate(String(result), 500)}${A.reset}\r\n`),
    onStatus: (type, provider, data) => {
      const line = fmtSwarmStatus(type, provider, data);
      if (line) session.write(line);
    },
  }, { prefs: session.prefs });
  session._turnCancel = swarm.cancel;
  try {
    await swarm.promise;
  } finally {
    session._turnCancel = null;
  }
}

/**
 * Spawn an external agentic CLI (claude/codex/…) for one hub-session turn and
 * stream its stdout into the session's terminal. External agents are stateless
 * passthroughs — they don't touch the built-in engine's history; the scrollback
 * is the record of the turn.
 */
async function runWebExternal(session, agentId, text) {
  const spec = resolveAgentSpec(agentId);
  if (!spec || !spec.available) {
    session.write(`${A.red}External agent "${agentId}" is not available — install it or enable it in Settings → External Agents.${A.reset}\r\n`);
    return;
  }
  session.write(`${A.grey}[via ${spec.name}]${A.reset}\r\n`);

  const handle = runExternalAgent(agentId, text, {
    cwd: session.cwd,
    onText: (t) => session.write(t),
    onError: (e) => session.write(`\r\n${A.red}${e}${A.reset}\r\n`),
  });
  // Let stopSession()/driver.stop() kill the subprocess mid-run.
  session._turnCancel = handle.cancel;
  try {
    const result = await handle.promise;
    if (!result.ok && result.error && result.error !== 'cancelled') {
      session.write(`\r\n${A.red}${spec.name} failed: ${result.error}${A.reset}\r\n`);
    }
  } finally {
    session._turnCancel = null;
  }
}

// ─── Hub API ────────────────────────────────────────────────────────

/** List sessions, optionally filtered to one owner (when auth is on). */
export function listSessions(userId) {
  return [..._sessions.values()]
    .filter(s => !userId || s.userId === userId)
    .map(s => s.toJSON());
}

export function getSession(id) {
  return _sessions.get(id);
}

export function sessionCount() {
  return _sessions.size;
}

/** Wire the hub driver onto a web session (shared by create + restore). */
function wireWebDriver(session) {
  session.driver = {
    input: (text, images, agentId) => runWeb(session, text, images, agentId),
    stop: () => {
      // Cancel whichever is running: a swarm, an external-agent subprocess, or
      // the native engine.
      try { session._turnCancel?.(); } catch { /* ignore */ }
      try { session.agent?.cancel?.(); } catch { /* ignore */ }
    },
  };
}

/** Create a fresh web session with its own agent (optionally per-user). */
export function createWebSession({ name, cwd, userId, prefs } = {}) {
  const agent = createAgent({ prefs });
  const session = new Session({ name, cwd, origin: 'web', agent, userId });
  session.prefs = prefs || null;
  wireWebDriver(session);
  _sessions.set(session.id, session);
  session.write(`${A.green}${A.bold}● Mantis session "${session.name}"${A.reset}\r\n`);
  session.write(`${A.dim}  cwd: ${session.cwd}${A.reset}\r\n`);
  session.write(`${A.dim}  Type a message below and press Enter — all tools are enabled.${A.reset}\r\n\r\n`);
  persist(session);
  return session;
}

// ─── Persistence ────────────────────────────────────────────────────
// Hub sessions are written to <user>/hub-sessions/<id>.json so a redeploy/
// restart doesn't lose the user's open chats. We save the scrollback (what the
// terminal shows) plus the native engine's message history; on boot
// restoreSessions() rehydrates them. /remote (origin 'cli') sessions are NOT
// persisted — they're just live views of a REPL agent that won't exist after
// restart. The dir is deliberately distinct from `sessions/` (desktop chat
// history, a different file shape).

function sessionFile(session) {
  return path.join(userHubSessionsDir(session.userId), `${session.id}.json`);
}

// A persisted hub session has a numeric 's<N>' id and a scrollback string.
// Guards restore against ever adopting a foreign JSON file in the dir.
function looksLikeHubSession(data) {
  return data && typeof data.id === 'string' && /^s\d+$/.test(data.id)
      && typeof data.scrollback === 'string';
}

function persist(session) {
  if (!session || session.origin !== 'web') return;
  try {
    const data = {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      userId: session.userId,
      agentId: session.agentId,
      solo: session.solo,
      createdAt: session.createdAt,
      scrollback: session.scrollback,
      // Native engine history. Swarm/external turns don't populate this, but the
      // scrollback still carries their visible output.
      messages: session.agent?.getMessages ? session.agent.getMessages() : [],
    };
    fs.writeFileSync(sessionFile(session), JSON.stringify(data), 'utf-8');
  } catch { /* best-effort — a failed checkpoint must never break a turn */ }
}

function bumpSeq(id) {
  const n = parseInt(String(id).replace(/^s/, ''), 10);
  if (Number.isFinite(n) && n > _seq) _seq = n;
}

/**
 * Rehydrate persisted hub sessions on server boot. Scans the anonymous sessions
 * dir plus every known user's, recreates each session's agent (with that user's
 * current prefs) and message history, and replays scrollback to new viewers.
 * Returns the count restored.
 */
export function restoreSessions() {
  let restored = 0;
  const owners = [null];
  try { for (const u of listUsers()) owners.push(u); } catch { /* no users dir */ }

  for (const userId of owners) {
    let dir, files;
    try {
      dir = userHubSessionsDir(userId);
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch { continue; }

    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (!looksLikeHubSession(data)) continue; // skip foreign files
        if (_sessions.has(data.id)) continue; // already live
        const prefs = userId ? getUserPrefs(userId) : null;
        const agent = createAgent({ prefs });
        if (Array.isArray(data.messages) && data.messages.length && agent.setMessages) {
          agent.setMessages(data.messages);
        }
        const session = new Session({ name: data.name, cwd: data.cwd, origin: 'web', agent, userId });
        session.id = data.id || session.id;
        session.createdAt = data.createdAt || session.createdAt;
        session.agentId = data.agentId || null;
        session.solo = !!data.solo;
        session.prefs = prefs;
        session.scrollback = data.scrollback || '';
        wireWebDriver(session);
        _sessions.set(session.id, session);
        bumpSeq(session.id);
        restored++;
      } catch { /* skip a corrupt session file */ }
    }
  }
  if (restored) console.log(`  [sessions] restored ${restored} session(s) from disk`);
  return restored;
}

/** Set a session's default agent (external CLI id or 'native') and persist. */
export function setSessionAgent(id, agentId) {
  const session = _sessions.get(id);
  if (!session) return false;
  session.agentId = agentId === 'native' ? null : agentId;
  persist(session);
  return true;
}

/** Register an externally-driven session (used by the REPL's /remote). */
export function attachSession({ name, cwd, agent, driver, origin = 'cli' }) {
  const session = new Session({ name, cwd, origin, agent });
  session.driver = driver || null;
  _sessions.set(session.id, session);
  return session;
}

export function removeSession(id) {
  const session = _sessions.get(id);
  if (!session) return false;
  // Only cancel work for hub-owned sessions — deleting a /remote view must
  // not kill the REPL's agent.
  if (session.origin === 'web') {
    try { session.driver?.stop?.(); } catch { /* ignore */ }
  }
  for (const res of session.subscribers) {
    try { res.end(); } catch { /* ignore */ }
  }
  // Drop the on-disk checkpoint so a deleted session doesn't resurrect on boot.
  if (session.origin === 'web') {
    try { fs.unlinkSync(sessionFile(session)); } catch { /* already gone */ }
  }
  _sessions.delete(id);
  return true;
}

export function sendInput(id, text, images, agentId) {
  const session = _sessions.get(id);
  if (!session || !session.driver?.input) return false;
  // agentId is a per-turn override (admin web UI dropdown). The driver
  // decides whether to honour it; web sessions thread it into runWeb so the
  // external-agents path picks it up.
  session.driver.input(text, images, agentId);
  return true;
}

export function stopSession(id) {
  const session = _sessions.get(id);
  if (!session) return false;
  try { session.driver?.stop?.(); } catch { /* ignore */ }
  session.write(`\r\n${A.yellow}[stop requested]${A.reset}\r\n`);
  return true;
}
