/**
 * Headless mode — run a single task non-interactively, for scripts and CI.
 *
 *   mantis run "<task>" [--json] [--cwd <dir>] [--provider <name>] [--model <name>]
 *
 * All tool calls are auto-approved (like autonomous mode). The streamed answer
 * goes to stdout; tool/error notices go to stderr. With --json, stdout carries
 * a single JSON object instead. Exit code is 0 on success, 1 on error.
 */

import { loadConfig, getConfig, PROVIDERS } from './config.js';
import { setWorkingDirectory } from './tools.js';
import { createAgent } from './agent.js';
import { initMcp, shutdownMcp } from './mcp.js';
import { runSwarm, getSwarmPool } from './swarm.js';

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

  // External agent override (--agent <id>) — short-circuits both native loop
  // and swarm. The Mantis tool loop is never used; we just stream the CLI's
  // stdout and exit with its code.
  if (opts.agent && opts.agent !== 'native') {
    const { runExternalAgent, resolveAgentSpec } = await import('./external-agents.js');
    const spec = resolveAgentSpec(opts.agent);
    if (!spec) {
      process.stderr.write(`  Unknown external agent: ${opts.agent}\n`);
      return false;
    }
    if (!spec.available) {
      process.stderr.write(`  Agent "${opts.agent}" is not installed (looking for: ${spec.bin}).\n`);
      return false;
    }
    let txt = '';
    const tools = [];
    const handle = runExternalAgent(opts.agent, task, {
      cwd: opts.cwd ? opts.cwd : process.cwd(),
      onText: (t) => { txt += t; if (!json) process.stdout.write(t); },
      onError: (e) => process.stderr.write(`  [${spec.name}] ${e}\n`),
    });
    const result = await handle.promise;
    if (json) {
      process.stdout.write(JSON.stringify({
        ok: result.ok, text: txt.trim(), externalAgent: opts.agent,
        agentName: spec.name, exitCode: result.exitCode, durationMs: result.durationMs,
        error: result.error,
      }, null, 2) + '\n');
    } else {
      process.stdout.write('\n');
    }
    return result.ok;
  }

  const agent = createAgent(prefs ? { prefs } : {});
  await initMcp();

  // Swarm routing: --swarm forces, --solo skips, otherwise honour config.swarm.default.
  const cfg = getConfig();
  const swarmDefault = !!cfg.swarm?.default;
  const minPool = cfg.swarm?.minPoolSize ?? 2;
  const wantSwarm = opts.swarm || (!opts.solo && swarmDefault);
  if (wantSwarm && getSwarmPool().length >= minPool) {
    let swarmText = '';
    const tools = [];
    const swarm = runSwarm(task, {
      onStatus: (type, provider, data) => {
        if (type === 'pool') process.stderr.write(`  [swarm] pool: ${data.pool.join(', ')} | lead: ${data.lead}\n`);
        else if (type === 'phase') process.stderr.write(`  [swarm] phase ${data || provider}\n`);
        else if (type === 'error') process.stderr.write(`  [swarm error] ${provider || ''}: ${data}\n`);
      },
      onText: (t) => { swarmText += t; if (!json) process.stdout.write(t); },
      onToolCall: (name) => { tools.push(name); process.stderr.write(`  [tool] ${name}\n`); },
    });
    let result;
    try { result = await swarm.promise; }
    catch (err) { result = { success: false }; process.stderr.write(`  [swarm fatal] ${err.message}\n`); }
    shutdownMcp();
    const ok = !!(result && result.success);
    if (json) {
      process.stdout.write(JSON.stringify({ ok, text: swarmText.trim(), toolCalls: tools.length, tools, swarm: true }, null, 2) + '\n');
    } else {
      process.stdout.write('\n');
    }
    return ok;
  }

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
