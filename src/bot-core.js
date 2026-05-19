/**
 * Shared core for the chat-bot wrappers (Telegram, Discord).
 *
 * Each chat / channel gets its own {@link createBotSession} — an agent with
 * its own conversation history. Tool calls are auto-approved (there's no
 * terminal to confirm at), so a bot session behaves like autonomous mode.
 */

import fs from 'fs';
import path from 'path';
import { createAgent } from './agent.js';
import { setWorkingDirectory, getWorkingDirectory } from './tools.js';

/**
 * Create an isolated bot session backed by a Mantis agent.
 */
export function createBotSession() {
  const agent = createAgent();
  let busy = false;

  /**
   * Run a task. Resolves to { text, tools } or { error }.
   * @param {string} task
   * @param {object} [hooks] - { onProgress(line) }
   */
  async function run(task, hooks = {}) {
    if (busy) return { error: 'I am still working on the previous task. Send /stop to cancel it.' };
    busy = true;

    let text = '';
    const tools = [];
    try {
      await agent.chat(task, {
        maxLoops: 50,
        onText: (t) => { text += t; },
        onToolCall: (name) => {
          const line = '🔧 ' + name;
          tools.push(name);
          if (hooks.onProgress) hooks.onProgress(line);
        },
        onToolResult: () => {},
        onError: (err) => { if (hooks.onProgress) hooks.onProgress('⚠️ ' + err); },
        onConfirmToolCall: async () => true, // no terminal — auto-approve
        onThinking: () => {},
        onToken: () => {},
        onCompact: () => {},
      });
    } catch (err) {
      busy = false;
      return { error: err.message };
    }

    busy = false;
    return { text: text.trim(), tools };
  }

  function setCwd(dir) {
    const resolved = path.resolve(getWorkingDirectory(), dir);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      setWorkingDirectory(resolved);
      agent.refreshSystemPrompt();
      return true;
    }
    return false;
  }

  return {
    run,
    cancel: () => agent.cancel(),
    clear: () => agent.clearHistory(),
    isBusy: () => busy,
    stats: () => agent.getStats(),
    setCwd,
  };
}

const HELP = [
  'Mantis bot — send a coding task and I will work on it in the project directory.',
  '',
  'Commands:',
  '/clear — reset the conversation',
  '/stop — cancel the running task',
  '/cwd [path] — show or change the working directory',
  '/status — session stats',
  '/help — this message',
].join('\n');

/**
 * Handle a slash command shared across bot platforms.
 * @returns {Promise<string>} reply text
 */
export async function runBotCommand(text, session) {
  const parts = text.slice(1).split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case 'start':
    case 'help':
      return HELP;
    case 'clear':
      session.clear();
      return 'Conversation cleared.';
    case 'stop':
      if (session.isBusy()) { session.cancel(); return 'Stopping the current task…'; }
      return 'Nothing is running.';
    case 'cwd':
      if (arg) {
        return session.setCwd(arg)
          ? 'Working directory: ' + getWorkingDirectory()
          : 'Directory not found: ' + arg;
      }
      return 'Working directory: ' + getWorkingDirectory();
    case 'status': {
      const s = session.stats();
      return `Messages: ${s.messageCount} · tool calls: ${s.totalToolCalls} · context: ${s.pct}%`;
    }
    default:
      return `Unknown command: /${cmd}. Send /help for the list.`;
  }
}

/** Format an agent result into a reply string. */
export function formatResult(result) {
  if (result.error) return '⚠️ ' + result.error;
  let out = result.text || '(done — no text response)';
  if (result.tools && result.tools.length) {
    out += `\n\n— used ${result.tools.length} tool call${result.tools.length === 1 ? '' : 's'}`;
  }
  return out;
}

/** Split a long message into platform-safe chunks. */
export function chunkMessage(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit; // no good newline — hard split
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
