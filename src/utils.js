import chalk from 'chalk';
import os from 'os';
import path from 'path';

/**
 * process.env with common user bin dirs appended to PATH. When Mantis runs as a
 * service/daemon its PATH is the minimal system one, so user-installed tools
 * (pipx/npm-global/cargo in ~/.local/bin, Homebrew, etc.) aren't found —
 * `flake8: not found` (exit 127) despite being installed. We APPEND (not
 * prepend) the missing dirs so system binaries still win; only gaps are filled.
 * Used by the run_command tool and external-agent spawns.
 */
export function augmentedEnv(extra = {}) {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin')]
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        '/bin',
      ];
  const cur = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set(cur);
  for (const d of candidates) if (!seen.has(d)) { cur.push(d); seen.add(d); }
  return { ...process.env, ...extra, PATH: cur.join(path.delimiter) };
}

export const colors = {
  toolName: chalk.cyan.bold,
  toolParam: chalk.gray,
  toolResult: chalk.dim,
  error: chalk.red.bold,
  warning: chalk.yellow,
  success: chalk.green.bold,
  ai: chalk.white,
  user: chalk.blue.bold,
  dim: chalk.dim,
  header: chalk.magenta.bold,
  plan: chalk.yellow.bold,
  status: chalk.gray,
  compact: chalk.yellow,
};

export function formatToolCall(name, args) {
  const argStr = Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string'
        ? (v.length > 80 ? v.slice(0, 80) + '...' : v)
        : JSON.stringify(v);
      return `${colors.toolParam(k)}=${val}`;
    })
    .join(' ');
  return `${colors.toolName('> ' + name)} ${argStr}`;
}

export function truncate(str, maxLen = 2000) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... (truncated, ${str.length} chars total)`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function contextBar(pct) {
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct > 80 ? chalk.red : pct > 60 ? chalk.yellow : chalk.green;
  return color('[' + '='.repeat(filled) + ' '.repeat(empty) + ']') + ` ${pct}%`;
}
