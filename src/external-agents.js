/**
 * External agent delegation — spawn other agentic CLIs (claude, codex, aider,
 * gemini, qwen, cline, …) and stream their stdout back through Mantis's UI.
 *
 * The user picks an agent per session (or per message in the web UI); Mantis
 * becomes a passthrough — it doesn't see the external agent's tool calls,
 * just the streamed text reply. Each turn is a fresh subprocess; conversation
 * continuity is the external agent's responsibility (claude's project memory,
 * aider's .aider.chat.history.md, etc.).
 *
 * See docs/multi-agent-plan.md for the full design.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfig } from './config.js';
import { augmentedEnv } from './utils.js';

// ─── Registry ───────────────────────────────────────────────────────
// `spawn(prompt, cwd)` returns { args, stdinMode }. stdinMode = 'none' means
// the prompt is on argv; 'pipe' means write it to stdin and close.
const AGENT_REGISTRY = {
  native: {
    name: 'Mantis (native)',
    kind: 'builtin',
  },
  claude: {
    name: 'Claude Code',
    bin: 'claude',
    // --dangerously-skip-permissions: there is no terminal to approve tool use
    // at in a Mantis session, so without it Claude hangs forever waiting for
    // permission. On by default (matches Mantis's auto-approving web sessions
    // and the other CLIs' yolo flags); toggle via
    // config.externalAgents.claude.skipPermissions (Settings → External Agents).
    // Safe here: the box runs as a non-root user; Claude refuses the flag as root.
    spawn: (prompt) => {
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
      if (getConfig().externalAgents?.claude?.skipPermissions !== false) {
        args.push('--dangerously-skip-permissions');
      }
      return { args, stdinMode: 'none' };
    },
    parseStream: 'claude-stream-json',
    risk: 'medium',                       // respects .claude/settings.json denies
    streams: true,
  },
  codex: {
    name: 'OpenAI Codex CLI',
    bin: 'codex',
    spawn: (prompt) => ({ args: ['exec', prompt], stdinMode: 'none' }),
    parseStream: 'plain',
    risk: 'medium',
    streams: false,
  },
  aider: {
    name: 'Aider',
    bin: 'aider',
    spawn: (prompt) => ({
      args: ['--yes-always', '--no-stream', '--message', prompt],
      stdinMode: 'none',
    }),
    parseStream: 'plain',
    risk: 'high',                         // auto-commits to git
    streams: false,
    defaultDisabled: true,
  },
  gemini: {
    name: 'Gemini CLI',
    bin: 'gemini',
    spawn: (prompt) => ({ args: ['--yolo', '--prompt', prompt], stdinMode: 'none' }),
    parseStream: 'plain',
    risk: 'high',                         // --yolo literally bypasses confirmation
    streams: false,
    defaultDisabled: true,
  },
  qwen: {
    name: 'Qwen Code',
    bin: 'qwen',
    spawn: (prompt) => ({ args: ['--yolo', '--prompt', prompt], stdinMode: 'none' }),
    parseStream: 'plain',
    risk: 'high',
    streams: false,
    defaultDisabled: true,
  },
  cline: {
    name: 'Cline CLI',
    bin: 'cline',
    spawn: (prompt) => ({ args: [], stdinMode: 'pipe' }),
    parseStream: 'plain',
    risk: 'unknown',
    streams: false,
    defaultDisabled: true,
  },
};

// ─── PATH probe ─────────────────────────────────────────────────────
let _availabilityCache = null;

function pathDirs() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean);
}

function pathExtensions() {
  if (process.platform !== 'win32') return [''];
  return (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(s => s.toLowerCase());
}

/** Resolve `bin` against PATH+PATHEXT. Returns full path or null. */
function whichBin(bin) {
  for (const dir of pathDirs()) {
    for (const ext of pathExtensions()) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/** Build the effective spec for an agent — merges registry + config override. */
export function resolveAgentSpec(id) {
  const base = AGENT_REGISTRY[id];
  if (!base) return null;
  if (base.kind === 'builtin') return { id, ...base, available: true };

  const cfg = getConfig();
  const override = (cfg.externalAgents && cfg.externalAgents[id]) || {};
  const bin = override.bin || base.bin;
  const resolvedBin = path.isAbsolute(bin) && fs.existsSync(bin) ? bin : whichBin(bin);
  return {
    id,
    ...base,
    bin: resolvedBin || bin,
    available: !!resolvedBin && !override.disabled,
    disabled: !!override.disabled || (base.defaultDisabled && override.enabled !== true),
    extraArgs: override.extraArgs || [],
    env: override.env || {},
  };
}

/** List every registered agent with its current availability. */
export function listExternalAgents() {
  if (_availabilityCache) return _availabilityCache;
  const result = [];
  for (const id of Object.keys(AGENT_REGISTRY)) {
    const spec = resolveAgentSpec(id);
    if (!spec) continue;
    result.push({
      id,
      name: spec.name,
      available: !!spec.available,
      disabled: !!spec.disabled,
      streams: !!spec.streams,
      risk: spec.risk || null,
      bin: spec.bin || null,
    });
  }
  _availabilityCache = result;
  return result;
}

/** Drop the cache so a config change (enable/disable) is picked up. */
export function refreshAvailability() {
  _availabilityCache = null;
  return listExternalAgents();
}

// ─── Spawning ───────────────────────────────────────────────────────

/**
 * Spawn an external agent for one turn. Returns { promise, cancel }.
 * `onText` is called with raw stdout chunks (post-NDJSON parsing for claude).
 * `onError` receives stderr lines (debounced).
 *
 * @param {string} id           registry key
 * @param {string} prompt       the user message
 * @param {object} opts
 * @param {string} opts.cwd     working directory (REQUIRED)
 * @param {Function} opts.onText
 * @param {Function} [opts.onError]
 * @param {AbortSignal} [opts.signal]
 */
export function runExternalAgent(id, prompt, opts = {}) {
  const spec = resolveAgentSpec(id);
  if (!spec) return rejected(`Unknown external agent: ${id}`);
  if (spec.kind === 'builtin') return rejected(`Cannot run builtin agent ${id} through this path`);
  if (!spec.available) return rejected(`Agent "${id}" is not installed (binary "${spec.bin}" not on PATH).`);
  if (spec.disabled) return rejected(`Agent "${id}" is disabled. Enable it in Settings → External Agents.`);
  if (!opts.cwd) return rejected('cwd is required for external-agent runs.');

  // Cwd-guard: refuse to spawn at $HOME or "/" — those are forgot-to-pick-a-project footguns.
  const home = os.homedir();
  if (opts.cwd === home || opts.cwd === '/' || opts.cwd === path.parse(opts.cwd).root) {
    return rejected(`Refusing to spawn ${id} at ${opts.cwd} — pick a project folder first.`);
  }

  const { args, stdinMode } = spec.spawn(prompt, opts.cwd);
  let command = spec.bin;
  let finalArgs = [...(spec.extraArgs || []), ...args];

  // Windows .cmd shim handling — same pattern as src/mcp.js _spawnStdio.
  if (process.platform === 'win32') {
    finalArgs = ['/c', command, ...finalArgs];
    command = 'cmd';
  }

  const startTime = Date.now();
  const proc = spawn(command, finalArgs, {
    cwd: opts.cwd,
    env: { ...augmentedEnv(), ...(spec.env || {}) }, // user bin dirs on PATH for the agent's own shell-outs
    stdio: [stdinMode === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let cancelled = false;
  let timedOut = false;
  let stderrBuf = '';

  // Inactivity watchdog: if the agent emits no stdout/stderr for this long it's
  // assumed wedged (e.g. blocked on a prompt) and killed — otherwise a hung
  // subprocess pins the session on 'running' forever and bricks it. Any output
  // resets the timer, so long-but-active builds are never cut off. 0 disables.
  const inactivityMs = opts.inactivityMs
    ?? getConfig().externalAgents?.inactivityTimeoutMs
    ?? 180_000;
  let idleTimer = null;
  const bumpIdle = () => {
    if (!inactivityMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = true; killProc(proc); }, inactivityMs);
  };
  bumpIdle();

  if (stdinMode === 'pipe') {
    proc.stdin.write(prompt);
    proc.stdin.end();
  }

  // ── stdout parsing ──
  const onText = opts.onText || (() => {});
  if (spec.parseStream === 'claude-stream-json') {
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      bumpIdle();
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          // Claude stream-json shape: {type:'assistant', message:{content:[{type:'text', text:'…'}, …]}}
          if (evt.type === 'assistant' && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === 'text' && block.text) onText(block.text);
            }
          }
          // ignore tool_use/tool_result events — Mantis treats this as opaque
        } catch { /* not JSON, ignore */ }
      }
    });
  } else {
    proc.stdout.on('data', (chunk) => { bumpIdle(); onText(chunk.toString('utf8')); });
  }

  // ── stderr ──
  proc.stderr.on('data', (chunk) => {
    bumpIdle();
    stderrBuf += chunk.toString('utf8');
    // Don't surface raw stderr unless the agent exits non-zero.
  });

  // ── cancellation ──
  function cancel() {
    if (cancelled) return;
    cancelled = true;
    killProc(proc);
  }
  if (opts.signal) {
    if (opts.signal.aborted) cancel();
    else opts.signal.addEventListener('abort', cancel, { once: true });
  }

  // ── exit ──
  const promise = new Promise((resolve) => {
    proc.on('exit', (code, signal) => {
      if (idleTimer) clearTimeout(idleTimer);
      const durationMs = Date.now() - startTime;
      if (timedOut) {
        const secs = Math.round(inactivityMs / 1000);
        const err = `no output for ${secs}s — killed (likely blocked on a prompt; agent runs non-interactively)`;
        if (opts.onError) opts.onError(err);
        resolve({ ok: false, exitCode: code, signal, durationMs, error: err });
        return;
      }
      if (cancelled) {
        resolve({ ok: false, exitCode: code, signal, durationMs, error: 'cancelled' });
        return;
      }
      if (code === 0) {
        resolve({ ok: true, exitCode: 0, durationMs });
      } else {
        if (opts.onError && stderrBuf.trim()) opts.onError(stderrBuf.trim());
        resolve({
          ok: false,
          exitCode: code,
          signal,
          durationMs,
          error: stderrBuf.trim() || `exit ${code}${signal ? ` (signal ${signal})` : ''}`,
        });
      }
    });
    proc.on('error', (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ ok: false, exitCode: null, durationMs: Date.now() - startTime, error: err.message });
    });
  });

  return { promise, cancel, proc };
}

function rejected(message) {
  return {
    promise: Promise.resolve({ ok: false, exitCode: null, durationMs: 0, error: message }),
    cancel: () => {},
    proc: null,
  };
}

/** Kill a subprocess. On Windows uses taskkill /T /F to nuke grandchildren too. */
function killProc(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } catch { /* fall through to proc.kill */ }
  }
  try { proc.kill(); } catch { /* ignore */ }
}
