/**
 * File checkpoints — a snapshot of a file is taken just before the agent
 * writes or edits it, so a bad change can be reverted with `/undo`.
 *
 * The stack is in-memory and session-scoped: undo history lives as long as the
 * process does. Each write_file / edit_file records one entry.
 */

import fs from 'fs';

const MAX = 200;                 // cap the stack so long autonomous runs don't grow it forever
const MAX_SNAPSHOT = 2 * 1024 * 1024; // don't snapshot files larger than 2 MB

let stack = []; // [{ path, before, existed, at }]

/** Snapshot a file's current state before it is modified. */
export function recordChange(filePath) {
  let before = null;
  let existed = false;
  try {
    if (fs.existsSync(filePath)) {
      const st = fs.statSync(filePath);
      if (st.isFile()) {
        existed = true;
        if (st.size <= MAX_SNAPSHOT) before = fs.readFileSync(filePath, 'utf-8');
      }
    }
  } catch { /* treat as a new/unreadable file */ }
  stack.push({ path: filePath, before, existed, at: Date.now() });
  if (stack.length > MAX) stack.shift();
}

/** How many changes can currently be undone. */
export function checkpointCount() {
  return stack.length;
}

/**
 * Revert the most recent recorded change.
 * @returns {{ok:true, path:string, action:string}|{error:string}}
 */
export function undoLast() {
  const c = stack.pop();
  if (!c) return { error: 'Nothing to undo — no file changes recorded this session.' };
  try {
    if (!c.existed) {
      if (fs.existsSync(c.path)) fs.unlinkSync(c.path);
      return { ok: true, path: c.path, action: 'deleted (it was newly created)' };
    }
    if (c.before === null) {
      return { error: `Cannot undo ${c.path} — it was too large to snapshot.` };
    }
    fs.writeFileSync(c.path, c.before, 'utf-8');
    return { ok: true, path: c.path, action: 'restored to its previous contents' };
  } catch (err) {
    return { error: `Undo failed for ${c.path}: ${err.message}` };
  }
}

export function clearCheckpoints() {
  stack = [];
}
