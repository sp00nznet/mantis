/**
 * Full-text search over conversation history.
 *
 * Mantis keeps every conversation as a JSON file (hub sessions, desktop chats)
 * plus the markdown memory store, but until now there was no way to search
 * across them — each session was an island. This module builds a single FTS5
 * index over all of it so the agent (via the `search_memory` tool) and the user
 * (via `/recall`) can pull relevant context back out of past conversations.
 *
 * The index lives in <data-dir>/search.db and is backed by node:sqlite, a Node
 * built-in (>=22.5). Because it's part of the Node binary rather than a native
 * addon, it bundles cleanly into the SEA single-exe build — no new dependency.
 * If the runtime predates node:sqlite, search degrades to a no-op rather than
 * crashing anything.
 */

import fs from 'fs';
import path from 'path';
import { getConfigDir } from './config.js';

let _db = null;
let _disabled = false;
let _initError = null;
let _reindexedThisProcess = false;

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** Lazily open (and create) the index database. Returns null if unavailable. */
function db() {
  if (_disabled) return null;
  if (_db) return _db;
  try {
    // Loaded lazily so a runtime without node:sqlite degrades gracefully
    // instead of failing at module load.
    const { DatabaseSync } = loadSqlite();
    const file = path.join(getConfigDir(), 'search.db');
    const d = new DatabaseSync(file);
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        text,
        title,
        source UNINDEXED,
        session_id UNINDEXED,
        role UNINDEXED,
        ts UNINDEXED,
        tokenize = 'porter unicode61'
      );
    `);
    _db = d;
    return _db;
  } catch (err) {
    _disabled = true;
    _initError = err.message;
    return null;
  }
}

// Resolve the node:sqlite built-in synchronously, keeping it out of the static
// import graph so bundlers (esbuild → SEA) and runtimes older than 22.5 don't
// choke at load time. process.getBuiltinModule exists from Node 22.3; node:sqlite
// from 22.5 — a gap there throws and search disables itself gracefully.
function loadSqlite() {
  if (typeof process.getBuiltinModule !== 'function') {
    throw new Error('node:sqlite unavailable (Node < 22.3)');
  }
  const mod = process.getBuiltinModule('node:sqlite');
  if (!mod || !mod.DatabaseSync) throw new Error('node:sqlite unavailable (Node < 22.5)');
  return mod;
}

/** Is the search index usable on this runtime? */
export function searchAvailable() {
  return !!db();
}

/** Close the index database (releases the file handle). */
export function close() {
  if (_db) { try { _db.close(); } catch {} _db = null; }
}

/** Last initialization error, if search is unavailable. */
export function searchError() {
  return _initError;
}

function truncate(s, n = 8000) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * (Re)index a single session: replaces any existing rows for it, then inserts
 * one document per substantive message. Cheap enough to call on every save.
 *
 * @param {object} o
 * @param {string} o.source      'hub' | 'desktop' | 'memory' | 'summary'
 * @param {string} o.sessionId
 * @param {string} [o.title]
 * @param {Array}  [o.messages]  [{ role, content }]
 * @param {string} [o.transcript] fallback raw text (e.g. hub scrollback) when messages are empty
 * @param {number} [o.ts]
 */
export function indexSession({ source, sessionId, title = '', messages = [], transcript = '', ts = 0 }) {
  const d = db();
  if (!d || !sessionId) return;
  try {
    d.exec('BEGIN');
    d.prepare('DELETE FROM docs WHERE source = ? AND session_id = ?').run(source, String(sessionId));
    const ins = d.prepare(
      'INSERT INTO docs(text, title, source, session_id, role, ts) VALUES(?,?,?,?,?,?)'
    );
    let indexed = 0;
    for (const m of messages || []) {
      if (!m || typeof m.content !== 'string') continue;
      const role = m.role || 'user';
      if (role === 'system') continue;                 // boilerplate, not worth indexing
      const text = m.content.trim();
      if (!text) continue;
      ins.run(truncate(text), String(title || ''), source, String(sessionId), role, Number(ts) || 0);
      indexed++;
    }
    // Swarm/external turns leave no structured messages — fall back to the
    // visible transcript so that content is still recallable.
    if (indexed === 0 && transcript) {
      const clean = stripAnsi(transcript).trim();
      if (clean) {
        ins.run(truncate(clean), String(title || ''), source, String(sessionId), 'transcript', Number(ts) || 0);
      }
    }
    d.exec('COMMIT');
  } catch {
    try { d.exec('ROLLBACK'); } catch {}
  }
}

/** Remove a session from the index (called when a session is deleted). */
export function removeSession(source, sessionId) {
  const d = db();
  if (!d) return;
  try { d.prepare('DELETE FROM docs WHERE source = ? AND session_id = ?').run(source, String(sessionId)); }
  catch {}
}

/** Turn a free-text query into a safe FTS5 MATCH expression (OR of terms). */
function ftsQuery(raw) {
  const tokens = String(raw || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/** Number of indexed documents. */
export function count() {
  const d = db();
  if (!d) return 0;
  try { return d.prepare('SELECT COUNT(*) AS n FROM docs').get().n; }
  catch { return 0; }
}

/**
 * Search the conversation history.
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=10]
 * @param {string} [opts.source]  restrict to one source
 * @returns {Array<{source,sessionId,title,role,ts,snippet,score}>}
 */
export function search(query, { limit = 10, source = null } = {}) {
  ensureIndexed();
  const d = db();
  if (!d) return [];
  const match = ftsQuery(query);
  if (!match) return [];
  try {
    const where = source ? 'docs MATCH ? AND source = ?' : 'docs MATCH ?';
    const params = source ? [match, source] : [match];
    const rows = d.prepare(
      `SELECT source, session_id AS sessionId, title, role, ts,
              snippet(docs, 0, '«', '»', '…', 14) AS snippet,
              bm25(docs) AS score
         FROM docs
        WHERE ${where}
        ORDER BY score
        LIMIT ?`
    ).all(...params, Math.max(1, Math.min(50, limit)));
    return rows;
  } catch {
    return [];
  }
}

// ─── Backfill: index whatever already exists on disk ────────────────────────

function listUserDirs() {
  const base = path.join(getConfigDir(), 'users');
  try { return fs.readdirSync(base).map((u) => path.join(base, u)); }
  catch { return []; }
}

function indexJsonDir(dir, source, pick) {
  let n = 0;
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); }
  catch { return 0; }
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const doc = pick(data);
      if (!doc) continue;
      indexSession({ source, ...doc });
      n++;
    } catch { /* skip corrupt file */ }
  }
  return n;
}

/**
 * Scan every on-disk store and (re)build the index. Idempotent — each session
 * is replaced, not duplicated. Returns a per-source count.
 */
export function reindexAll() {
  const d = db();
  if (!d) return { available: false };
  const cfg = getConfigDir();
  const out = { hub: 0, desktop: 0, memory: 0 };

  const hubDirs = [path.join(cfg, 'hub-sessions'), ...listUserDirs().map((u) => path.join(u, 'hub-sessions'))];
  for (const dir of hubDirs) {
    out.hub += indexJsonDir(dir, 'hub', (data) => {
      if (!data || typeof data.id !== 'string') return null;
      return {
        sessionId: data.id,
        title: data.name || data.id,
        messages: data.messages || [],
        transcript: data.scrollback || '',
        ts: data.createdAt || 0,
      };
    });
  }

  const deskDirs = [path.join(cfg, 'sessions'), ...listUserDirs().map((u) => path.join(u, 'sessions'))];
  for (const dir of deskDirs) {
    out.desktop += indexJsonDir(dir, 'desktop', (data) => {
      if (!data || typeof data.id !== 'string') return null;
      return {
        sessionId: data.id,
        title: data.title || data.id,
        messages: data.messages || [],
        ts: data.updatedAt || data.createdAt || 0,
      };
    });
  }

  // Global memory store.
  try {
    const memFile = path.join(cfg, 'memory', 'MEMORY.md');
    const text = fs.readFileSync(memFile, 'utf-8');
    indexSession({ source: 'memory', sessionId: 'global', title: 'MEMORY.md', messages: [{ role: 'memory', content: text }] });
    out.memory = 1;
  } catch { /* no global memory file */ }

  return out;
}

/**
 * Run a one-time backfill per process so search works over pre-existing history
 * without anyone having to trigger a reindex. Incremental index-on-save keeps it
 * fresh after that.
 */
export function ensureIndexed() {
  if (_reindexedThisProcess) return;
  _reindexedThisProcess = true;
  if (!db()) return;
  try { reindexAll(); } catch {}
}

// ─── Optional LLM summarization of long sessions ────────────────────────────

/**
 * Summarize sessions that are long enough to be worth compressing, and index
 * the summaries as `summary` docs so recall can surface a tight gist alongside
 * raw messages. The LLM call is injected so this module stays provider-agnostic
 * and free of heavy imports; callers pass a `generate(prompt) => string`.
 *
 * @param {function} generate  async (prompt:string) => string
 * @param {object} [opts]
 * @param {number} [opts.minMessages=12]  only summarize sessions at least this long
 * @param {number} [opts.max=20]          cap how many to summarize per run
 * @returns {Promise<{summarized:number, skipped:number}>}
 */
export async function summarizeAndIndex(generate, { minMessages = 12, max = 20 } = {}) {
  const d = db();
  if (!d || typeof generate !== 'function') return { summarized: 0, skipped: 0 };
  const cfg = getConfigDir();
  let summarized = 0, skipped = 0;

  const sources = [
    ...[path.join(cfg, 'hub-sessions'), ...listUserDirs().map((u) => path.join(u, 'hub-sessions'))].map((dir) => ['hub', dir]),
    ...[path.join(cfg, 'sessions'), ...listUserDirs().map((u) => path.join(u, 'sessions'))].map((dir) => ['desktop', dir]),
  ];

  for (const [source, dir] of sources) {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); }
    catch { continue; }
    for (const f of files) {
      if (summarized >= max) return { summarized, skipped };
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
      catch { continue; }
      const messages = data.messages || [];
      if (messages.length < minMessages) { skipped++; continue; }
      // Already summarized? skip.
      const sid = data.id;
      try {
        const have = d.prepare("SELECT 1 FROM docs WHERE source='summary' AND session_id=? LIMIT 1").get(sid);
        if (have) { skipped++; continue; }
      } catch {}
      const convo = messages
        .filter((m) => m && typeof m.content === 'string' && m.role !== 'system')
        .map((m) => `${m.role}: ${truncate(m.content, 1200)}`)
        .join('\n')
        .slice(0, 16000);
      let summary;
      try {
        summary = await generate(
          `Summarize this coding-assistant conversation in 4-8 bullet points capturing the task, key decisions, files touched, and outcome. Be terse and factual.\n\n${convo}`
        );
      } catch { skipped++; continue; }
      if (summary && summary.trim()) {
        indexSession({
          source: 'summary',
          sessionId: sid,
          title: (data.title || data.name || sid) + ' (summary)',
          messages: [{ role: 'summary', content: summary.trim() }],
          ts: data.updatedAt || data.createdAt || 0,
        });
        summarized++;
      } else {
        skipped++;
      }
    }
  }
  return { summarized, skipped };
}
