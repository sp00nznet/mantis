/**
 * Desktop session store — persistent, resumable conversation history.
 *
 * Every chat/agent session is one JSON file under ~/.mantis/sessions/. Closing
 * the app and reopening it leaves the full history intact; opening a session
 * loads its messages straight back into a fresh agent.
 */

import fs from 'fs';
import path from 'path';
import { getConfigDir } from '../src/config.js';

const SESSIONS_DIR = path.join(getConfigDir(), 'sessions');

function ensureDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function genId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fileFor(id) {
  return path.join(SESSIONS_DIR, id + '.json');
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
  ensureDir();
  const out = [];
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
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
  try { fs.unlinkSync(fileFor(id)); return true; }
  catch { return false; }
}

export function rename(id, title) {
  const s = get(id);
  if (!s) return false;
  s.title = (title || '').trim() || s.title;
  save(s);
  return true;
}
