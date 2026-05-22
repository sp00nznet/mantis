/**
 * Headless mode — run a single task non-interactively, for scripts and CI.
 *
 *   mantis run "<task>" [--json] [--cwd <dir>] [--provider <name>] [--model <name>]
 *
 * All tool calls are auto-approved (like autonomous mode). The streamed answer
 * goes to stdout; tool/error notices go to stderr. With --json, stdout carries
 * a single JSON object instead. Exit code is 0 on success, 1 on error.
 */

import { loadConfig, PROVIDERS } from './config.js';
import { setWorkingDirectory } from './tools.js';
import { createAgent } from './agent.js';
import { initMcp, shutdownMcp } from './mcp.js';

/**
 * @param {string} task
 * @param {{json?:boolean, cwd?:string, provider?:string, model?:string, maxLoops?:number}} opts
 * @returns {Promise<boolean>} true on success
 */
export async function runHeadless(task, opts = {}) {
  loadConfig();
  setWorkingDirectory(opts.cwd ? opts.cwd : process.cwd());

  const json = !!opts.json;
  let prefs = null;
  if (opts.provider) {
    if (!PROVIDERS[opts.provider]) {
      process.stderr.write(`  Unknown provider: ${opts.provider}\n`);
      return false;
    }
    prefs = { provider: opts.provider, model: opts.model || '' };
  }

  const agent = createAgent(prefs ? { prefs } : {});
  await initMcp();

  let text = '';
  const toolsUsed = [];
  let errored = false;

  try {
    await agent.chat(task, {
      maxLoops: opts.maxLoops || 50,
      onText: (t) => { text += t; if (!json) process.stdout.write(t); },
      onToolCall: (name) => { toolsUsed.push(name); process.stderr.write(`  [tool] ${name}\n`); },
      onToolResult: () => {},
      onError: (e) => { errored = true; process.stderr.write(`  [error] ${e}\n`); },
      onConfirmToolCall: async () => true, // CI: auto-approve everything
      onThinking: () => {},
      onToken: () => {},
      onCompact: () => {},
    });
  } catch (err) {
    errored = true;
    process.stderr.write(`  [fatal] ${err.message}\n`);
  }

  const stats = agent.getStats();
  shutdownMcp();

  if (json) {
    process.stdout.write(JSON.stringify({
      ok: !errored,
      text: text.trim(),
      toolCalls: toolsUsed.length,
      tools: toolsUsed,
      tokens: stats.tokens,
      cost: stats.cost,
    }, null, 2) + '\n');
  } else {
    process.stdout.write('\n');
  }

  return !errored;
}
