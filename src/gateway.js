/**
 * Chat-platform gateway.
 *
 * A single router that owns every bot conversation, keyed by (platform, chatId),
 * so the platform adapters (Telegram, Discord, …) stay thin: they decode their
 * wire format, hand the gateway a chat id, and get back a persistent session.
 *
 * Unlike the old per-adapter `Map` of ephemeral sessions, the gateway:
 *   - persists each conversation's agent history to disk, and
 *   - lazily rehydrates it the next time that chat sends a message,
 * so a bot restart (or redeploy) no longer wipes every conversation mid-thread.
 * Rehydrate-on-message also means an idle conversation costs nothing in memory
 * until it's used again.
 *
 * Sessions live in <data-dir>/gateway-sessions/<platform>/<chatId>.json, a
 * directory distinct from the hub (`hub-sessions/`) and desktop (`sessions/`)
 * stores so the three never collide.
 */

import fs from 'fs';
import path from 'path';
import { getConfigDir, getConfig } from './config.js';
import { createBotSession } from './bot-core.js';
import { indexSession } from './search.js';

const registry = new Map(); // `${platform}:${chatId}` -> wrapped session
const lastUsed = new Map(); // key -> ms timestamp of last activity
let sweepTimer = null;

function baseDir(platform) {
  return path.join(getConfigDir(), 'gateway-sessions', sanitize(platform));
}
function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || '_';
}
function sessionFile(platform, chatId) {
  return path.join(baseDir(platform), sanitize(chatId) + '.json');
}

function readPersisted(platform, chatId) {
  try { return JSON.parse(fs.readFileSync(sessionFile(platform, chatId), 'utf-8')); }
  catch { return null; }
}

function persist(platform, chatId, session) {
  try {
    const dir = baseDir(platform);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const messages = session.getMessages();
    fs.writeFileSync(
      sessionFile(platform, chatId),
      JSON.stringify({ platform, chatId: String(chatId), updatedAt: Date.now(), messages }),
      'utf-8'
    );
    // Keep bot conversations searchable alongside the rest (best-effort).
    indexSession({
      source: 'bot', sessionId: `${platform}:${chatId}`,
      title: `${platform} chat ${chatId}`, messages, ts: Date.now(),
    });
  } catch { /* best-effort — a failed checkpoint must never break a reply */ }
}

/**
 * Get the persistent session for a chat, creating + rehydrating it on first use.
 * Returns the same interface as createBotSession(); run/clear additionally
 * checkpoint to disk.
 */
export function gatewaySession(platform, chatId) {
  const key = `${platform}:${chatId}`;
  ensureSweep();
  lastUsed.set(key, Date.now());
  const existing = registry.get(key);
  if (existing) return existing;

  const session = createBotSession();
  const saved = readPersisted(platform, chatId);
  if (saved && Array.isArray(saved.messages) && saved.messages.length) {
    session.setMessages(saved.messages);
  }

  // Wrap the mutating operations so every turn is checkpointed.
  const origRun = session.run;
  session.run = async (task, hooks) => {
    lastUsed.set(key, Date.now());
    const res = await origRun(task, hooks);
    lastUsed.set(key, Date.now()); // mark fresh again at completion
    persist(platform, chatId, session);
    return res;
  };
  const origClear = session.clear;
  session.clear = () => { origClear(); persist(platform, chatId, session); };

  registry.set(key, session);
  return session;
}

/** Evict an idle in-memory session (its history stays on disk). For hibernation. */
export function evictGatewaySession(platform, chatId) {
  const key = `${platform}:${chatId}`;
  lastUsed.delete(key);
  return registry.delete(key);
}

/** How many gateway sessions are live in memory. */
export function gatewaySessionCount() {
  return registry.size;
}

// ─── Hibernation ────────────────────────────────────────────────────────────
// A long-running bot accumulates one agent per chat. Each conversation's history
// is already on disk (persisted after every turn), so an idle one can be dropped
// from memory and rebuilt from disk the next time that chat speaks — keeping the
// process footprint flat no matter how many chats it has seen.

function hibernateIdleMs() {
  const v = getConfig().gateway?.hibernateIdleMs;
  return v === 0 ? 0 : (Number(v) || 1800000);
}

/** Evict every session idle longer than idleMs (never one mid-turn). */
export function sweepIdleSessions(idleMs = hibernateIdleMs()) {
  if (!idleMs) return 0;
  const now = Date.now();
  let evicted = 0;
  for (const [key, ts] of [...lastUsed]) {
    const session = registry.get(key);
    if (!session) { lastUsed.delete(key); continue; }
    if (session.isBusy && session.isBusy()) continue; // never evict a running turn
    if (now - ts >= idleMs) {
      registry.delete(key);
      lastUsed.delete(key);
      evicted++;
    }
  }
  return evicted;
}

/** Start the periodic hibernation sweep (idempotent; auto-started on first use). */
export function ensureSweep() {
  if (sweepTimer) return;
  const idleMs = hibernateIdleMs();
  if (!idleMs) return; // hibernation disabled
  const interval = Number(getConfig().gateway?.sweepIntervalMs) || 300000;
  sweepTimer = setInterval(() => { try { sweepIdleSessions(idleMs); } catch {} }, interval);
  if (sweepTimer.unref) sweepTimer.unref(); // don't keep the process alive on its own
}

/** Snapshot for diagnostics: live sessions and the hibernation policy. */
export function gatewayInfo() {
  return {
    live: registry.size,
    hibernateIdleMs: hibernateIdleMs(),
    sweeping: !!sweepTimer,
  };
}
