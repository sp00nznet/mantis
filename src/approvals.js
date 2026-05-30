/**
 * Tool-approval broker for Claude Code (and any future external agent that
 * supports a permission-prompt tool).
 *
 * When a session runs Claude with approvals ON (not --dangerously-skip-
 * permissions), Claude is launched with `--permission-prompt-tool` pointed at a
 * tiny stdio MCP bridge (scripts/claude-approval-mcp.mjs). Each time Claude
 * wants to use a tool, the bridge POSTs to the admin server, which calls
 * requestApproval() here. We auto-allow tools the user has already blessed
 * (per-session or globally), otherwise we push an `approval` frame to the
 * session's viewers and park a promise until the user clicks a button — which
 * lands in resolveApproval(). No terminal, no 180s stall.
 */

import crypto from 'crypto';
import { getConfig, saveConfig } from './config.js';

const _turns = new Map();    // turn token   -> session (one live claude turn)
const _pending = new Map();  // approvalId   -> { resolve, session, toolName }

// How long to wait for a human before auto-denying, so a walked-away user can't
// wedge Claude forever. Generous — approvals are deliberate.
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** The globally-blessed tool names ("Allow always" choices), from config. */
function globalAllowlist() {
  const a = getConfig().externalAgents?.claude?.allowedTools;
  return Array.isArray(a) ? a : [];
}

/** Bind a claude turn token to its session for the life of that turn. */
export function registerTurn(turn, session) {
  if (turn && session) _turns.set(turn, session);
}

/** Drop a turn and deny anything still pending for it (the turn is over). */
export function unregisterTurn(turn) {
  const session = _turns.get(turn);
  _turns.delete(turn);
  if (!session) return;
  for (const [id, entry] of _pending) {
    if (entry.session === session) {
      _pending.delete(id);
      entry.resolve({ decision: 'deny', message: 'Session turn ended.' });
    }
  }
}

/**
 * Called (via the admin bridge) when Claude asks to use a tool. Resolves to
 * { decision: 'allow'|'deny', message? }. Auto-allows blessed tools; otherwise
 * prompts the session's viewers and waits.
 */
export async function requestApproval(turn, toolName, input) {
  const session = _turns.get(turn);
  if (!session) return { decision: 'deny', message: 'No active session for this approval.' };

  // Already blessed — for this session, or globally.
  if ((session.approveAllow && session.approveAllow.has(toolName)) || globalAllowlist().includes(toolName)) {
    return { decision: 'allow' };
  }

  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    _pending.set(id, { resolve, session, toolName });
    try {
      session.emitApproval({ type: 'approval', id, tool: toolName, input });
    } catch { /* no viewers / dead socket — the timeout still protects us */ }

    setTimeout(() => {
      if (!_pending.has(id)) return;
      _pending.delete(id);
      try { session.emitApproval({ type: 'approval-resolved', id, decision: 'deny', reason: 'timeout' }); } catch { /* ignore */ }
      resolve({ decision: 'deny', message: 'Approval timed out.' });
    }, APPROVAL_TIMEOUT_MS);
  });
}

/**
 * Called when the user clicks a button. scope: 'once' | 'session' | 'always'.
 * Returns true if the approval was live. Ownership-checked against sessionId.
 */
export function resolveApproval(sessionId, approvalId, decision, scope) {
  const entry = _pending.get(approvalId);
  if (!entry) return false;
  if (entry.session.id !== sessionId) return false;
  _pending.delete(approvalId);

  const allow = decision === 'allow';
  if (allow && scope === 'session') {
    entry.session.approveAllow = entry.session.approveAllow || new Set();
    entry.session.approveAllow.add(entry.toolName);
  }
  if (allow && scope === 'always') {
    const list = new Set(globalAllowlist());
    list.add(entry.toolName);
    const ea = { ...getConfig().externalAgents };
    ea.claude = { ...(ea.claude || {}), allowedTools: [...list] };
    saveConfig({ externalAgents: ea });
  }

  try { entry.session.emitApproval({ type: 'approval-resolved', id: approvalId, decision, scope }); } catch { /* ignore */ }
  entry.resolve(allow ? { decision: 'allow' } : { decision: 'deny', message: 'Denied by user.' });
  return true;
}

export function pendingCount() { return _pending.size; }
