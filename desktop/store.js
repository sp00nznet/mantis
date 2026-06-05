/**
 * Desktop session store — persistent, resumable conversation history.
 *
 * Every chat/agent session is one JSON file under ~/.mantis/sessions/. Closing
 * the app and reopening it leaves the full history intact; opening a session
 * loads its messages straight back into a fresh agent.
 */

import fs from 'fs';
import path from 'path';
import { activeDataDir } from '../src/users.js';
import { indexSession, removeSession as dropFromIndex } from '../src/search.js';

/**
 * The sessions folder for the active context — ~/.mantis/sessions when nobody
 * is signed in, ~/.mantis/users/<id>/sessions when a Google user is. Created
 * on demand so each account's history stays isolated.
 */
function sessionsDir() {
  const d = path.join(activeDataDir(), 'sessions');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function ensureDir() { sessionsDir(); }

function genId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fileFor(id) {
  return path.join(sessionsDir(), id + '.json');
}

/** Create and persist a new empty session. */
export function createSession({ mode = 'chat', title = 'New chat', provider = null, model = null, projectId = null } = {}) {
  ensureDir();
  const now = Date.now();
  const session = {
    id: genId(),
    title: title || 'New chat',
    mode,                // 'chat' | 'agent'
    provider, model, projectId,
    createdAt: now,
    updatedAt: now,
    messages: [],        // { role, content }
  };
  save(session);
  return session;
}

/** Write a session to disk, bumping updatedAt. */
export function save(session) {
  ensureDir();
  session.updatedAt = Date.now();
  fs.writeFileSync(fileFor(session.id), JSON.stringify(session, null, 2), 'utf-8');
  // Keep the chat searchable (best-effort; no-op without node:sqlite).
  try {
    indexSession({
      source: 'desktop', sessionId: session.id, title: session.title || session.id,
      messages: session.messages || [], ts: session.updatedAt,
    });
  } catch { /* search optional */ }
  return session;
}

/** Load a full session (with messages), or null. */
export function get(id) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(id), 'utf-8'));
  } catch {
    return null;
  }
}

/** List session metadata (no message bodies), newest first. */
export function list() {
  const dir = sessionsDir();
  const out = [];
  let files;
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      out.push({
        id: s.id, title: s.title, mode: s.mode,
        provider: s.provider, model: s.model, projectId: s.projectId,
        createdAt: s.createdAt, updatedAt: s.updatedAt,
        messageCount: (s.messages || []).length,
      });
    } catch { /* skip corrupt file */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function remove(id) {
  try { fs.unlinkSync(fileFor(id)); }
  catch { return false; }
  try { dropFromIndex('desktop', id); } catch { /* search optional */ }
  return true;
}

export function rename(id, title) {
  const s = get(id);
  if (!s) return false;
  s.title = (title || '').trim() || s.title;
  save(s);
  return true;
}
