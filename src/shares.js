/**
 * Session share links.
 *
 * A share is an unguessable token that grants a guest access to one live
 * session — either `watch` (read-only) or `join` (can also send input). The
 * token is the credential: the guest needs no Mantis account.
 *
 * In-memory and session-scoped, with a 24-hour TTL.
 */

import crypto from 'crypto';

const SHARE_TTL = 24 * 3600 * 1000;

let _shares = new Map(); // token -> { sessionId, mode, createdAt }

/** Mint a share token for a session. mode = 'watch' | 'join'. */
export function createShare(sessionId, mode) {
  const token = crypto.randomBytes(9).toString('hex');
  _shares.set(token, {
    sessionId,
    mode: mode === 'join' ? 'join' : 'watch',
    createdAt: Date.now(),
  });
  return token;
}

/** Resolve a token to its share record, or null if invalid/expired. */
export function getShare(token) {
  const s = _shares.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SHARE_TTL) {
    _shares.delete(token);
    return null;
  }
  return s;
}

export function revokeShare(token) {
  return _shares.delete(token);
}

/** Revoke every share pointing at a given session. */
export function revokeSessionShares(sessionId) {
  let n = 0;
  for (const [token, s] of _shares) {
    if (s.sessionId === sessionId) { _shares.delete(token); n++; }
  }
  return n;
}

/** Active (non-expired) shares, optionally filtered to one session. */
export function listShares(sessionId) {
  const out = [];
  for (const [token, s] of _shares) {
    if (Date.now() - s.createdAt > SHARE_TTL) { _shares.delete(token); continue; }
    if (sessionId && s.sessionId !== sessionId) continue;
    out.push({ token, sessionId: s.sessionId, mode: s.mode, createdAt: s.createdAt });
  }
  return out;
}
