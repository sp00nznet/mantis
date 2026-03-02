import readline from 'readline';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { createAgent } from './agent.js';
import { setWorkingDirectory, getWorkingDirectory, setPlanMode, getPlanMode } from './tools.js';
import { loadConfig, saveConfig, getConfig, PROVIDERS } from './config.js';
import { saveConversation, loadConversation, listConversations } from './conversation.js';
import { getAllSkills, getSkill, saveSkill, deleteSkill, expandSkillPrompt, matchSkillCommand } from './skills.js';
import { loadAllMemory, clearGlobalMemory, clearProjectMemory, getMemoryStats } from './memory.js';
import { colors, formatToolCall, truncate, contextBar, formatDuration } from './utils.js';
import { getSwarmPool, selectLead, runSwarm, excludeFromSwarm, includeInSwarm, classifyComplexity } from './swarm.js';

// Module-level state for interrupt handling
let _isBusy = false;
let _agent = null;
let _aborted = false;
let _cancelResolve = null; // resolves the cancel promise to win the race
let _autoApprove = false;  // when true, skip confirmation prompts for tool calls
let _rl = null;            // readline interface ref for confirmation prompts
let _autonomousMode = false; // when true, running in autonomous mode

// Process-level SIGINT fallback.
// In raw mode, Ctrl+C produces byte 0x03 which readline handles (rl.on('SIGINT')).
// If raw mode is ever lost, Ctrl+C generates OS-level SIGINT instead — this catches it.
process.on('SIGINT', () => {
  if (_isBusy) {
    _aborted = true;
    _isBusy = false;
    if (_agent) _agent.cancel();
    if (_cancelResolve) { _cancelResolve(); _cancelResolve = null; }
  }
  // Don't exit and don't swallow — let the normal flow handle the rest
});

// Safety net: catch any stray promise rejections from abandoned streams.
process.on('unhandledRejection', () => {});
process.on('uncaughtException', (err) => {
  if (err.code === 'ERR_USE_AFTER_CLOSE' || err.name === 'AbortError' ||
      err.message?.includes('cancel') || err.message?.includes('abort')) return;
  console.error('\n  Fatal error:', err.message);
  process.exit(1);
});

// Rotating verbs for the thinking spinner
const THINKING_VERBS = [
  'Thinking', 'Reasoning', 'Analyzing', 'Considering', 'Processing',
  'Evaluating', 'Reflecting', 'Pondering', 'Working', 'Computing',
  'Examining', 'Deliberating', 'Formulating', 'Assessing', 'Exploring',
];

export async function startCLI() {
  const cwd = process.cwd();
  setWorkingDirectory(cwd);
  loadConfig();
  const config = getConfig();

  const providerInfo = PROVIDERS[config.provider] || PROVIDERS.local;
  const providerLabel = config.provider === 'local'
    ? `${config.ollamaUrl}`
    : `${providerInfo.name}`;

  // Mantis mascot — pad each line to 10 chars so info column aligns
  const mascotRaw = [
    '   \\_/    ',
    '  (o.o)   ',
    ' _/|\\_    ',
    '/ / \\ \\   ',
    '  / \\     ',
    ' /   \\    ',
  ];
  const info = [
    chalk.green.bold('MANTIS'),
    colors.dim('Agentic coding assistant'),
    '',
    colors.dim(`Working directory: ${cwd}`),
    colors.dim(`Model: ${config.model} via ${providerLabel}`),
    colors.dim(`Context limit: ${config.maxContextTokens.toLocaleString()} tokens`),
  ];
  console.log();
  const lines = Math.max(mascotRaw.length, info.length);
  for (let i = 0; i < lines; i++) {
    const m = mascotRaw[i] || '          ';
    const t = info[i] || '';
    console.log(`  ${chalk.green(m)}  ${t}`);
  }
  console.log(colors.dim('  Type /help for commands, /exit to quit\n'));

  const agent = createAgent();
  _agent = agent;
  let multilineBuffer = null;

  // Keepalive: prevent the event loop from draining after AbortController.abort().
  setInterval(() => {}, 60_000);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  _rl = rl;

  // Ctrl+C interrupt via rl.on('SIGINT').
  let _interruptedAt = 0;
  rl.on('SIGINT', () => {
    if (_interruptedAt && Date.now() - _interruptedAt < 1000) return;

    if (_isBusy) {
      _interruptedAt = Date.now();
      _aborted = true;
      _isBusy = false;
      _agent.cancel();
      if (_cancelResolve) { _cancelResolve(); _cancelResolve = null; }
    } else {
      console.log(colors.dim('\n  Goodbye!\n'));
      process.exit(0);
    }
  });

  function ask(question) {
    return new Promise(resolve => {
      rl.question(colors.dim(`  ${question} `), answer => resolve(answer));
    });
  }

  function getPromptStr() {
    const shortCwd = getWorkingDirectory().split(/[/\\]/).slice(-2).join('/');
    const mode = getPlanMode() ? colors.plan(' [PLAN] ') : '';
    return colors.user(`  ${shortCwd}${mode} > `);
  }

  const prompt = () => {
    // Force-restore stdin state for readline — ORA spinners can leave it stale
    try { if (process.stdin.isTTY) process.stdin.setRawMode(true); } catch {}
    process.stdin.resume();
    rl.resume();
    rl.question(getPromptStr(), async (input) => {
      if (_isBusy) return;

      // --- Multiline input mode ---
      if (multilineBuffer !== null) {
        if (input.trim() === '"""' || input.trim() === "'''") {
          const fullInput = multilineBuffer;
          multilineBuffer = null;
          await handleUserInput(fullInput, rl, agent);
        } else {
          multilineBuffer += (multilineBuffer ? '\n' : '') + input;
        }
        prompt();
        return;
      }

      // --- Check for multiline start ---
      if (input.trim().startsWith('"""') || input.trim().startsWith("'''")) {
        const rest = input.trim().slice(3);
        multilineBuffer = rest;
        console.log(colors.dim('  (multiline mode — end with """ or \'\'\')'));
        prompt();
        return;
      }

      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      // --- Handle slash commands ---
      if (trimmed.startsWith('/')) {
        const handled = await handleCommand(trimmed, rl, agent, ask);
        if (handled === 'exit') return;
        if (handled === 'skill-executed') {
          // skill was run as a normal message — prompt already handled
        }
        prompt();
        return;
      }

      // --- Normal message ---
      await handleUserInput(trimmed, rl, agent);
      prompt();
    });
  };

  prompt();
}

async function handleUserInput(input, rl, agent, opts = {}) {
  _isBusy = true;
  _aborted = false;

  const isAutonomous = opts.autonomous || false;
  const maxLoops = isAutonomous ? 100 : 25;

  // Create a cancel promise — Ctrl+C resolves this to win the race against agent.chat()
  const cancelPromise = new Promise(resolve => { _cancelResolve = resolve; });

  let spinner = null;
  let thinkingSpinner = null;
  let hasOutput = false;
  const startTime = Date.now();
  let tokenCount = 0;
  let streamStartTime = null;
  let verbIndex = Math.floor(Math.random() * THINKING_VERBS.length);
  let textBuffer = '';
  let hasToolCalls = false;

  function getVerb() {
    return THINKING_VERBS[verbIndex % THINKING_VERBS.length];
  }

  function buildThinkingText() {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const verb = getVerb();
    let tokStr = '';
    if (streamStartTime && tokenCount > 0) {
      const streamElapsed = (Date.now() - streamStartTime) / 1000;
      const tps = streamElapsed > 0 ? (tokenCount / streamElapsed).toFixed(1) : '0.0';
      tokStr = colors.dim(` | ${tps} tok/s`);
    }
    const modeTag = isAutonomous ? colors.warning(' [AUTO]') : '';
    return colors.dim(`${verb}...`) + tokStr + colors.dim(` | ${formatDuration(elapsed * 1000)}`) + '  ' + colors.status('ctrl+c to interrupt') + modeTag;
  }

  thinkingSpinner = ora({
    text: buildThinkingText(),
    indent: 2,
    stream: process.stderr,
    discardStdin: false,
  }).start();

  const thinkingInterval = setInterval(() => {
    if (thinkingSpinner) {
      verbIndex++;
      thinkingSpinner.text = buildThinkingText();
    } else {
      clearInterval(thinkingInterval);
    }
  }, 1000);

  // Auto-approve in autonomous mode
  const prevAutoApprove = _autoApprove;
  if (isAutonomous) _autoApprove = true;

  try {
    await Promise.race([cancelPromise, agent.chat(input, {
      maxLoops,
      onToken: (count) => {
        if (!streamStartTime) streamStartTime = Date.now();
        tokenCount += count;
      },
      onText: (text) => {
        if (_aborted) return;
        // If no spinners are active, stream text directly to stdout
        if (!thinkingSpinner && !spinner) {
          if (!hasOutput) {
            // Flush any pending buffer first
            if (textBuffer) {
              process.stdout.write('\n  ');
              process.stdout.write(textBuffer.replace(/\n/g, '\n  '));
              textBuffer = '';
            } else {
              process.stdout.write('\n  ');
            }
            hasOutput = true;
          }
          process.stdout.write(text.replace(/\n/g, '\n  '));
        } else {
          textBuffer += text;
        }
      },
      onConfirmToolCall: async (name, args) => {
        if (_aborted) return false;
        hasToolCalls = true;
        if (thinkingSpinner) {
          thinkingSpinner.stop();
          thinkingSpinner = null;
        }
        if (spinner) spinner.stop();
        if (hasOutput) {
          process.stdout.write('\n');
          hasOutput = false;
        }
        console.log('\n  ' + formatToolCall(name, args));

        if (_autoApprove) return true;

        // Defensive: restore raw mode before prompting
        try { if (process.stdin.isTTY && !process.stdin.isRaw) process.stdin.setRawMode(true); } catch {}
        if (process.stdin.isPaused?.()) process.stdin.resume();

        return new Promise(resolve => {
          _rl.question(colors.dim('  Execute? ') + colors.status('[Y]es / yes [a]lways / [n]o: '), (answer) => {
            const a = answer.trim().toLowerCase();
            if (a === 'a' || a === 'always' || a === 'yes always') {
              _autoApprove = true;
              resolve(true);
            } else if (a === 'n' || a === 'no') {
              console.log(colors.dim('  Skipped.'));
              resolve(false);
            } else {
              resolve(true);
            }
          });
        });
      },
      onToolCall: (name, args) => {
        if (_aborted) return;
        spinner = ora({
          text: colors.dim(`Running ${name}...`),
          indent: 2,
        }).start();
      },
      onToolResult: (name, result) => {
        if (_aborted) return;
        if (spinner) {
          spinner.succeed(colors.dim(`${name} done`));
          spinner = null;
        }
        const preview = result.split('\n').slice(0, 4).join('\n');
        console.log(colors.toolResult('  ' + truncate(preview, 300).replace(/\n/g, '\n  ')));
      },
      onError: (err) => {
        if (_aborted) return;
        if (thinkingSpinner) { thinkingSpinner.stop(); thinkingSpinner = null; }
        if (spinner) { spinner.fail('Error'); spinner = null; }
        console.log('\n  ' + colors.error(err));
      },
      onCompact: (before, after) => {
        if (_aborted) return;
        console.log(colors.compact(`\n  [Context compacted: ${before} messages → ${after} messages]`));
      },
      onThinking: (isThinking) => {
        if (_aborted) return;
        if (isThinking && !thinkingSpinner) {
          thinkingSpinner = ora({
            text: buildThinkingText(),
            indent: 2,
          }).start();
        } else if (!isThinking && thinkingSpinner) {
          thinkingSpinner.stop();
          thinkingSpinner = null;
        }
      },
    })]);
  } catch (err) {
    if (thinkingSpinner) { thinkingSpinner.stop(); thinkingSpinner = null; }
    if (spinner) { spinner.fail('Error'); spinner = null; }
    if (!_aborted) {
      console.log('\n  ' + colors.error(`Unexpected error: ${err.message}`));
    }
  }

  // Restore auto-approve state
  if (isAutonomous) _autoApprove = prevAutoApprove;

  clearInterval(thinkingInterval);
  if (thinkingSpinner) { thinkingSpinner.stop(); thinkingSpinner = null; }
  if (spinner) { spinner.stop(); spinner = null; }

  // Restore terminal state after ORA spinners — show cursor
  // ORA hides cursor during animation; if stopped uncleanly it stays hidden
  process.stdout.write('\x1B[?25h');
  process.stderr.write('\x1B[?25h');

  _cancelResolve = null;

  if (_aborted) {
    _aborted = false;
    console.log(colors.warning('\n\n  Interrupted.'));
    console.log(colors.dim('  Add more context to redirect, or start a new request.\n'));
    return;
  }

  // Display any text that was buffered while spinners were active
  // (streamed text during no-spinner periods was already written in onText)
  if (textBuffer && !hasOutput) {
    process.stdout.write('\n  ');
    const formatted = textBuffer.replace(/\n/g, '\n  ');
    process.stdout.write(formatted);
    hasOutput = true;
  }

  if (hasOutput) {
    process.stdout.write('\n');
  }

  _isBusy = false;

  const elapsed = Date.now() - startTime;
  const stats = agent.getStats();
  const tpsStr = streamStartTime && tokenCount > 0
    ? ` | ${(tokenCount / ((Date.now() - streamStartTime) / 1000)).toFixed(1)} tok/s`
    : '';
  const modeStr = isAutonomous ? ' | AUTO' : '';
  console.log(colors.status(`\n  ${formatDuration(elapsed)} | context: ${contextBar(stats.pct)} | ${stats.messageCount} msgs | ${stats.totalToolCalls} tool calls${tpsStr}${modeStr}`));
  console.log();
}

async function handleSwarmRun(task, leadOverride, rl, agent) {
  _isBusy = true;
  _aborted = false;
  const cancelPromise = new Promise(resolve => { _cancelResolve = resolve; });

  const startTime = Date.now();
  let spinner = null;
  let hasOutput = false;

  // Phase label display
  function phaseLabel(phase) {
    return chalk.magenta.bold(`  [${phase}]`);
  }

  console.log(colors.warning('\n  SWARM MODE'));

  let swarmResult;

  try {
    const swarmPromise = runSwarm(task, {
      onStatus: (type, provider, data) => {
        if (_aborted) return;
        switch (type) {
          case 'pool': {
            const complexityTag = data.complexity ? ` | complexity: ${data.complexity}` : '';
            console.log(colors.dim(`  Pool: ${data.pool.join(', ')}`));
            console.log(colors.dim(`  Lead: ${data.lead} | ${data.count} providers${complexityTag}\n`));
            break;
          }
          case 'phase':
            if (spinner) { spinner.stop(); spinner = null; }
            if (hasOutput) { process.stdout.write('\n'); hasOutput = false; }
            console.log(phaseLabel(data) + (provider ? colors.dim(` ${provider}`) : ''));
            break;
          case 'plan-ready':
            console.log(colors.dim(`  → ${data.explore} explore, ${data.code} code, ${data.review} review tasks`));
            break;
          case 'phase-detail':
            console.log(colors.dim(`  [${provider}] ${data}`));
            break;
          case 'explore-start':
            if (spinner) spinner.stop();
            spinner = ora({
              text: colors.dim(`[${provider}] ${data.length > 60 ? data.slice(0, 60) + '...' : data}`),
              indent: 2,
              stream: process.stderr,
              discardStdin: false,
            }).start();
            break;
          case 'explore-done':
            if (spinner) { spinner.succeed(colors.dim(`[${provider}] ${data} done`)); spinner = null; }
            break;
          case 'explore-fail':
            if (spinner) { spinner.fail(colors.dim(`[${provider}] failed: ${data}`)); spinner = null; }
            break;
          case 'fallback':
            if (spinner) { spinner.stop(); spinner = null; }
            console.log(colors.warning(`  [${provider}] ${data}`));
            break;
          case 'worker-tool':
            if (spinner) spinner.text = colors.dim(`[${provider}] ${data}...`);
            break;
          case 'worker-error':
            console.log(colors.dim(`  [${provider}] ${data}`));
            break;
          case 'review-done':
            if (spinner) { spinner.stop(); spinner = null; }
            console.log(colors.dim(`  [${provider}] Review: ${typeof data === 'string' ? data.split('\n')[0].slice(0, 80) : 'done'}`));
            break;
          case 'review-tool':
            break; // silent
          case 'error':
            if (spinner) { spinner.fail('Error'); spinner = null; }
            console.log('  ' + colors.error(data));
            break;
        }
      },
      onText: (text) => {
        if (_aborted) return;
        if (spinner) { spinner.stop(); spinner = null; }
        if (!hasOutput) { process.stdout.write('\n  '); hasOutput = true; }
        process.stdout.write(text.replace(/\n/g, '\n  '));
      },
      onToolCall: (name, args, provider) => {
        if (_aborted) return;
        if (spinner) { spinner.stop(); spinner = null; }
        if (hasOutput) { process.stdout.write('\n'); hasOutput = false; }
        console.log(`\n  ${colors.dim(`[${provider}]`)} ${formatToolCall(name, args)}`);
        spinner = ora({
          text: colors.dim(`Running ${name}...`),
          indent: 2,
          stream: process.stderr,
          discardStdin: false,
        }).start();
      },
      onToolResult: (name, result, provider) => {
        if (_aborted) return;
        if (spinner) { spinner.succeed(colors.dim(`${name} done`)); spinner = null; }
        const preview = result.split('\n').slice(0, 3).join('\n');
        console.log(colors.toolResult('  ' + truncate(preview, 200).replace(/\n/g, '\n  ')));
      },
    }, { leadOverride });

    swarmResult = await Promise.race([cancelPromise, swarmPromise]);
  } catch (err) {
    if (spinner) { spinner.fail('Error'); spinner = null; }
    if (!_aborted) {
      console.log('\n  ' + colors.error(`Swarm error: ${err.message}`));
    }
  }

  if (spinner) { spinner.stop(); spinner = null; }
  process.stdout.write('\x1B[?25h');
  process.stderr.write('\x1B[?25h');
  _cancelResolve = null;

  if (_aborted) {
    _aborted = false;
    // Cancel the swarm if it has a cancel function
    if (swarmResult?.cancel) swarmResult.cancel();
    console.log(colors.warning('\n\n  Swarm interrupted.'));
    console.log(colors.dim('  Partial results may have been applied.\n'));
    _isBusy = false;
    return;
  }

  if (hasOutput) process.stdout.write('\n');

  const elapsed = Date.now() - startTime;

  if (swarmResult?.success) {
    console.log(colors.success(`\n  Swarm complete. ${swarmResult.totalProviders} providers, ${formatDuration(elapsed)}`));
    if (swarmResult.reviewResult) {
      console.log(colors.dim(`  Review: ${swarmResult.reviewResult.split('\n')[0].slice(0, 100)}`));
    }
  } else if (swarmResult) {
    console.log(colors.warning(`\n  Swarm finished with issues. ${formatDuration(elapsed)}`));
  }

  console.log();
  _isBusy = false;
}

async function handleCommand(cmd, rl, agent, ask) {
  const parts = cmd.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  switch (command) {
    case '/exit':
    case '/quit':
      console.log(colors.dim('\n  Goodbye!\n'));
      process.exit(0);

    case '/clear':
      agent.clearHistory();
      console.log(colors.dim('  Conversation cleared.\n'));
      break;

    case '/help':
      printHelp();
      break;

    case '/plan': {
      const newMode = !getPlanMode();
      setPlanMode(newMode);
      agent.refreshSystemPrompt();
      if (newMode) {
        console.log(colors.plan('\n  PLAN MODE ON'));
        console.log(colors.dim('  The model will explore and plan without making changes.'));
        console.log(colors.dim('  File writes and state-changing commands are blocked.'));
        console.log(colors.dim('  Type /plan again to exit plan mode.\n'));
      } else {
        console.log(colors.success('\n  Plan mode OFF — normal operation resumed.\n'));
      }
      break;
    }

    case '/status':
    case '/stats': {
      const stats = agent.getStats();
      const config = getConfig();
      const skills = getAllSkills();
      const memStats = getMemoryStats();
      const memSummary = [
        memStats.projectExists ? `project: ${memStats.projectSize} chars` : null,
        memStats.globalExists ? `global: ${memStats.globalSize} chars` : null,
      ].filter(Boolean).join(', ') || 'none';
      const providerInfo = PROVIDERS[config.provider] || PROVIDERS.local;
      console.log(`
  ${colors.header('Status')}
  Model:       ${config.model}
  Provider:    ${providerInfo.name} (${config.provider})
  Working dir: ${getWorkingDirectory()}
  Plan mode:   ${getPlanMode() ? colors.plan('ON') : 'off'}
  Context:     ${contextBar(stats.pct)} (${stats.used.toLocaleString()} / ${stats.max.toLocaleString()} tokens)
  Messages:    ${stats.messageCount}
  Tool calls:  ${stats.totalToolCalls}
  Turns:       ${stats.totalTurns}
  Skills:      ${skills.length} available
  Memory:      ${memSummary}
`);
      break;
    }

    case '/cd': {
      if (!args) {
        console.log(colors.dim(`  Current: ${getWorkingDirectory()}\n`));
        break;
      }
      const resolved = path.resolve(getWorkingDirectory(), args);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        setWorkingDirectory(resolved);
        agent.refreshSystemPrompt();
        console.log(colors.dim(`  Changed to: ${resolved}\n`));
      } else {
        console.log(colors.error(`  Directory not found: ${resolved}\n`));
      }
      break;
    }

    case '/save': {
      const messages = agent.getMessages();
      if (messages.length <= 1) {
        console.log(colors.dim('  Nothing to save.\n'));
        break;
      }
      const filepath = saveConversation(messages, args || null);
      console.log(colors.success(`  Conversation saved: ${filepath}\n`));
      break;
    }

    case '/load': {
      if (!args) {
        const convos = listConversations();
        if (convos.length === 0) {
          console.log(colors.dim('  No saved conversations.\n'));
        } else {
          console.log(colors.header('\n  Saved conversations:'));
          convos.forEach((c, i) => {
            console.log(colors.dim(`  ${i + 1}. ${c.filename} (${c.messageCount} messages, ${c.savedAt})`));
          });
          console.log(colors.dim('\n  Use /load <number> or /load <name> to load one.\n'));
        }
        break;
      }
      const loaded = loadConversation(args);
      if (loaded) {
        agent.setMessages(loaded);
        console.log(colors.success(`  Conversation loaded (${loaded.length} messages).\n`));
      } else {
        console.log(colors.error(`  Conversation not found: ${args}\n`));
      }
      break;
    }

    case '/compact': {
      const messages = agent.getMessages();
      const { compactMessages } = await import('./context.js');
      const before = messages.length;
      const compacted = compactMessages(messages);
      agent.setMessages(compacted);
      console.log(colors.compact(`  Compacted: ${before} messages → ${compacted.length} messages\n`));
      break;
    }

    case '/model': {
      if (!args) {
        console.log(colors.dim(`  Current model: ${getConfig().model}\n`));
        break;
      }
      saveConfig({ model: args });
      agent.refreshSystemPrompt();
      console.log(colors.success(`  Model changed to: ${args}\n`));
      break;
    }

    case '/config': {
      const config = getConfig();
      console.log(colors.header('\n  Configuration:'));
      for (const [key, value] of Object.entries(config)) {
        if (key === 'providerKeys') {
          // Mask API keys
          const masked = {};
          for (const [k, v] of Object.entries(value)) {
            masked[k] = v ? v.slice(0, 8) + '...' : '(not set)';
          }
          console.log(colors.dim(`  ${key}: ${JSON.stringify(masked)}`));
        } else {
          console.log(colors.dim(`  ${key}: ${JSON.stringify(value)}`));
        }
      }
      console.log();
      break;
    }

    // ─── Provider commands ───────────────────────────────────────

    case '/provider': {
      const subParts = args.split(/\s+/);
      const sub = subParts[0]?.toLowerCase() || 'show';
      const subArgs = subParts.slice(1).join(' ');

      switch (sub) {
        case 'show':
        case '': {
          const config = getConfig();
          const p = PROVIDERS[config.provider] || PROVIDERS.local;
          const hasKey = config.providerKeys?.[config.provider];
          console.log(`
  ${colors.header('Current Provider')}
  Provider: ${colors.toolName(p.name)} (${config.provider})
  Base URL: ${p.baseUrl}
  Model:    ${config.model}
  API Key:  ${p.requiresKey ? (hasKey ? colors.success('configured') : colors.error('not set — use /provider key')) : colors.dim('not required')}
`);
          break;
        }

        case 'list':
        case 'ls': {
          const config = getConfig();
          console.log(colors.header('\n  Available Providers\n'));
          for (const [key, p] of Object.entries(PROVIDERS)) {
            const active = key === config.provider ? colors.success(' ← active') : '';
            const keyStatus = p.requiresKey
              ? (config.providerKeys?.[key] ? colors.dim(' [key set]') : colors.dim(' [no key]'))
              : '';
            console.log(`  ${colors.toolName(key.padEnd(12))} ${p.name}${keyStatus}${active}`);
            console.log(colors.dim(`               ${p.description}`));
          }
          console.log(colors.dim('\n  Use /provider set <name> to switch providers.'));
          console.log(colors.dim('  Use /provider key <name> <apikey> to set an API key.\n'));
          break;
        }

        case 'set': {
          const providerName = subArgs.trim().split(/\s+/)[0]?.toLowerCase();
          if (!providerName) {
            console.log(colors.error('  Usage: /provider set <name>\n'));
            break;
          }
          if (!PROVIDERS[providerName]) {
            console.log(colors.error(`  Unknown provider: ${providerName}`));
            console.log(colors.dim('  Use /provider list to see available providers.\n'));
            break;
          }
          // If extra args look like an API key, hint the user
          const extraArgs = subArgs.trim().split(/\s+/).slice(1).join(' ');
          if (extraArgs && (extraArgs.startsWith('sk-') || extraArgs.length > 20)) {
            console.log(colors.warning(`  Looks like you included an API key. Use: /provider key ${providerName} <your-key>`));
          }
          const p = PROVIDERS[providerName];
          saveConfig({
            provider: providerName,
            model: p.defaultModel,
          });
          if (providerName === 'local') {
            // For local, keep ollamaUrl as-is
          }
          agent.refreshSystemPrompt();
          console.log(colors.success(`  Provider set to: ${p.name}`));
          console.log(colors.dim(`  Model: ${p.defaultModel}`));
          if (p.requiresKey && !getConfig().providerKeys?.[providerName]) {
            console.log(colors.warning(`  Note: ${providerName} requires an API key. Use /provider key ${providerName} <your-key>`));
          }
          console.log();
          break;
        }

        case 'key': {
          const keyParts = subArgs.split(/\s+/);
          const keyProvider = keyParts[0]?.toLowerCase();
          const keyValue = keyParts.slice(1).join(' ').trim();
          if (!keyProvider || !keyValue) {
            console.log(colors.error('  Usage: /provider key <provider> <apikey>\n'));
            break;
          }
          if (!PROVIDERS[keyProvider]) {
            console.log(colors.error(`  Unknown provider: ${keyProvider}\n`));
            break;
          }
          const config = getConfig();
          const keys = { ...config.providerKeys, [keyProvider]: keyValue };
          saveConfig({ providerKeys: keys });
          console.log(colors.success(`  API key saved for ${keyProvider}.\n`));
          break;
        }

        case 'test': {
          const config = getConfig();
          const p = PROVIDERS[config.provider] || PROVIDERS.local;
          console.log(colors.dim(`  Testing connection to ${p.name}...`));

          try {
            const base = config.provider === 'local'
              ? `${config.ollamaUrl}/v1`
              : p.baseUrl.replace(/\/+$/, '');
            const headers = { 'Content-Type': 'application/json' };
            const apiKey = config.providerKeys?.[config.provider];
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

            // Try /models first
            let response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10000) });
            if (response.ok) {
              const data = await response.json();
              const modelCount = data.data?.length || 0;
              console.log(colors.success(`  Connected! ${modelCount} models available.`));
              if (modelCount > 0 && modelCount <= 20) {
                const models = data.data.map(m => m.id).slice(0, 10);
                console.log(colors.dim(`  Models: ${models.join(', ')}${modelCount > 10 ? '...' : ''}`));
              }
            } else if (response.status === 404) {
              // Some providers don't support /models — fall back to a tiny chat completion
              response = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  model: config.model || p.defaultModel,
                  messages: [{ role: 'user', content: 'ping' }],
                  max_tokens: 1,
                }),
                signal: AbortSignal.timeout(15000),
              });
              if (response.ok || response.status === 200) {
                console.log(colors.success(`  Connected! Provider is responding.`));
              } else {
                console.log(colors.error(`  Connection failed (HTTP ${response.status})`));
                if (response.status === 401) {
                  console.log(colors.dim('  Check your API key with /provider key'));
                }
              }
            } else {
              console.log(colors.error(`  Connection failed (HTTP ${response.status})`));
              if (response.status === 401) {
                console.log(colors.dim('  Check your API key with /provider key'));
              }
            }
          } catch (err) {
            console.log(colors.error(`  Connection failed: ${err.message}`));
          }
          console.log();
          break;
        }

        case 'models': {
          const providerName = subArgs.trim().toLowerCase() || getConfig().provider;
          const p = PROVIDERS[providerName];
          if (!p) {
            console.log(colors.error(`  Unknown provider: ${providerName}\n`));
            break;
          }
          console.log(colors.dim(`  Fetching models from ${p.name}...`));

          try {
            const config = getConfig();
            const base = providerName === 'local'
              ? `${config.ollamaUrl}/v1`
              : p.baseUrl.replace(/\/+$/, '');
            const url = `${base}/models`;
            const headers = { 'Content-Type': 'application/json' };
            const apiKey = config.providerKeys?.[providerName];
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

            const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
            if (response.ok) {
              const data = await response.json();
              const models = data.data || [];
              if (models.length === 0) {
                console.log(colors.dim('  No models found.'));
              } else {
                console.log(colors.header(`\n  Models on ${p.name} (${models.length} total)\n`));
                for (const m of models.slice(0, 30)) {
                  console.log(`  ${colors.toolName(m.id)}`);
                }
                if (models.length > 30) {
                  console.log(colors.dim(`  ... and ${models.length - 30} more`));
                }
              }
            } else {
              console.log(colors.error(`  Failed (HTTP ${response.status})`));
            }
          } catch (err) {
            console.log(colors.error(`  Failed: ${err.message}`));
          }
          console.log();
          break;
        }

        default:
          console.log(colors.error(`  Unknown provider command: ${sub}`));
          console.log(colors.dim('  Available: show, list, set, key, test, models\n'));
          break;
      }
      break;
    }

    // ─── Autonomous mode ─────────────────────────────────────────

    case '/auto': {
      if (!args) {
        console.log(colors.error('  Usage: /auto <task description>'));
        console.log(colors.dim('  Example: /auto create a hello world web server with Express\n'));
        break;
      }

      console.log(colors.warning('\n  AUTONOMOUS MODE'));
      console.log(colors.dim(`  Task: ${args}`));
      console.log(colors.dim('  All tool calls will be auto-approved.'));
      console.log(colors.dim('  Max iterations: 100'));
      console.log(colors.dim('  Press Ctrl+C to interrupt at any time.\n'));

      // Import and build the autonomous prompt
      const { buildAutonomousPrompt } = await import('./prompt.js');
      const autoPrompt = buildAutonomousPrompt(args);

      _autonomousMode = true;
      await handleUserInput(autoPrompt, rl, agent, { autonomous: true });
      _autonomousMode = false;

      console.log(colors.success('  Autonomous mode complete.\n'));
      break;
    }

    // ─── Swarm mode ─────────────────────────────────────────────

    case '/swarm': {
      // Parse --lead and --list flags
      const swarmParts = args.split(/\s+/);
      let leadOverride = null;
      let showList = false;
      const taskParts = [];

      for (let i = 0; i < swarmParts.length; i++) {
        if (swarmParts[i] === '--list') {
          showList = true;
        } else if (swarmParts[i] === '--lead' && swarmParts[i + 1]) {
          leadOverride = swarmParts[i + 1].toLowerCase();
          i++; // skip the value
        } else {
          taskParts.push(swarmParts[i]);
        }
      }
      const swarmTask = taskParts.join(' ').trim();

      // /swarm remove <provider> — exclude from pool
      if (swarmParts[0] === 'remove' || swarmParts[0] === 'exclude') {
        const target = swarmParts[1]?.toLowerCase();
        if (!target) {
          console.log(colors.error('  Usage: /swarm remove <provider>\n'));
          break;
        }
        if (!PROVIDERS[target]) {
          console.log(colors.error(`  Unknown provider: ${target}\n`));
          break;
        }
        excludeFromSwarm(target);
        console.log(colors.success(`  ${target} excluded from swarm pool.`));
        console.log(colors.dim('  Use /swarm add to re-include it.\n'));
        break;
      }

      // /swarm add <provider> — re-include in pool
      if (swarmParts[0] === 'add' || swarmParts[0] === 'include') {
        const target = swarmParts[1]?.toLowerCase();
        if (!target) {
          console.log(colors.error('  Usage: /swarm add <provider>\n'));
          break;
        }
        if (!PROVIDERS[target]) {
          console.log(colors.error(`  Unknown provider: ${target}\n`));
          break;
        }
        includeInSwarm(target);
        console.log(colors.success(`  ${target} re-included in swarm pool.\n`));
        break;
      }

      // /swarm --list — show pool and auto-selected lead
      if (showList || (!swarmTask && !leadOverride)) {
        const pool = getSwarmPool();
        if (pool.length === 0) {
          console.log(colors.error('\n  No providers configured for swarm.'));
          console.log(colors.dim('  Use /provider key <name> <apikey> to add providers.\n'));
          break;
        }

        const lead = selectLead(pool, leadOverride);
        console.log(colors.header('\n  Swarm Pool'));
        console.log(colors.dim(`  ${pool.length} provider${pool.length !== 1 ? 's' : ''} available\n`));

        for (const p of pool) {
          const role = p.key === lead.key ? colors.success(' (lead)') : colors.dim(' (worker)');
          const rpm = p.provider.rateLimit?.rpm ? colors.dim(` ${p.provider.rateLimit.rpm} RPM`) : '';
          console.log(`  ${colors.toolName(p.key.padEnd(14))} ${p.provider.name}${rpm}${role}`);
        }

        const swarmExcluded = getConfig().swarm?.excludeProviders || [];
        if (swarmExcluded.length > 0) {
          console.log(colors.dim(`\n  Excluded: ${swarmExcluded.join(', ')}`));
        }

        if (pool.length < 2) {
          console.log(colors.warning('\n  Swarm needs at least 2 providers. Add more with /provider key'));
        } else {
          console.log(colors.dim(`\n  Usage: /swarm <task>`));
          console.log(colors.dim(`  Override lead: /swarm --lead ${lead.key} <task>\n`));
        }
        break;
      }

      if (!swarmTask) {
        console.log(colors.error('  Usage: /swarm <task>'));
        console.log(colors.dim('  Example: /swarm refactor the auth module'));
        console.log(colors.dim('  Options: --lead <provider>, --list\n'));
        break;
      }

      // Run swarm
      await handleSwarmRun(swarmTask, leadOverride, rl, agent);
      break;
    }

    // ─── Memory commands ─────────────────────────────────────────

    case '/memory':
    case '/mem': {
      const subParts = args.split(/\s+/);
      const sub = subParts[0]?.toLowerCase() || 'show';

      switch (sub) {
        case 'show':
        case 'view':
        case '': {
          const { global, project } = loadAllMemory();
          if (!global && !project) {
            console.log(colors.dim('  No memory saved yet.'));
            console.log(colors.dim('  Tell the model to "save your state to memory" or use the save_memory tool.\n'));
          } else {
            if (project) {
              console.log(colors.header('\n  Project Memory'));
              console.log('  ' + project.replace(/\n/g, '\n  '));
            }
            if (global) {
              console.log(colors.header('\n  Global Memory'));
              console.log('  ' + global.replace(/\n/g, '\n  '));
            }
            console.log();
          }
          break;
        }

        case 'status':
        case 'stats': {
          const stats = getMemoryStats();
          console.log(`
  ${colors.header('Memory Status')}
  Project: ${stats.projectExists ? colors.success(`${stats.projectSize} chars`) : colors.dim('(none)')}
           ${colors.dim(stats.projectPath)}
  Global:  ${stats.globalExists ? colors.success(`${stats.globalSize} chars`) : colors.dim('(none)')}
           ${colors.dim(stats.globalPath)}
`);
          break;
        }

        case 'clear': {
          const scope = subParts[1]?.toLowerCase();
          if (scope === 'global') {
            const confirm = await ask('Clear global memory? This affects all projects. (y/N)');
            if (confirm.toLowerCase() === 'y') {
              clearGlobalMemory();
              agent.refreshSystemPrompt();
              console.log(colors.success('  Global memory cleared.\n'));
            } else {
              console.log(colors.dim('  Cancelled.\n'));
            }
          } else if (scope === 'project') {
            const confirm = await ask('Clear project memory? (y/N)');
            if (confirm.toLowerCase() === 'y') {
              clearProjectMemory();
              agent.refreshSystemPrompt();
              console.log(colors.success('  Project memory cleared.\n'));
            } else {
              console.log(colors.dim('  Cancelled.\n'));
            }
          } else if (scope === 'all') {
            const confirm = await ask('Clear ALL memory (project + global)? (y/N)');
            if (confirm.toLowerCase() === 'y') {
              clearProjectMemory();
              clearGlobalMemory();
              agent.refreshSystemPrompt();
              console.log(colors.success('  All memory cleared.\n'));
            } else {
              console.log(colors.dim('  Cancelled.\n'));
            }
          } else {
            console.log(colors.error('  Usage: /memory clear <project|global|all>\n'));
          }
          break;
        }

        default:
          console.log(colors.error(`  Unknown memory command: ${sub}`));
          console.log(colors.dim('  Available: show, status, clear <project|global|all>\n'));
          break;
      }
      break;
    }

    // ─── Skill commands ──────────────────────────────────────────

    case '/skill':
    case '/skills': {
      const subParts = args.split(/\s+/);
      const sub = subParts[0]?.toLowerCase() || 'list';
      const subArgs = subParts.slice(1).join(' ');

      switch (sub) {
        case 'list':
        case 'ls':
          printSkillList();
          break;

        case 'show':
        case 'view': {
          if (!subArgs) {
            console.log(colors.error('  Usage: /skill show <name>\n'));
            break;
          }
          const skill = getSkill(subArgs);
          if (!skill) {
            console.log(colors.error(`  Skill not found: ${subArgs}\n`));
          } else {
            printSkillDetail(skill);
          }
          break;
        }

        case 'create':
        case 'new':
        case 'add': {
          await createSkillInteractive(ask, subArgs);
          break;
        }

        case 'edit': {
          if (!subArgs) {
            console.log(colors.error('  Usage: /skill edit <name>\n'));
            break;
          }
          await editSkillInteractive(ask, subArgs);
          break;
        }

        case 'delete':
        case 'rm':
        case 'remove': {
          if (!subArgs) {
            console.log(colors.error('  Usage: /skill delete <name>\n'));
            break;
          }
          const existing = getSkill(subArgs);
          if (!existing) {
            console.log(colors.error(`  Skill not found: ${subArgs}\n`));
          } else if (existing.source === 'built-in') {
            console.log(colors.error(`  Cannot delete built-in skill "${subArgs}". Create a user override instead.\n`));
          } else {
            const confirm = await ask(`Delete ${existing.source} skill "${subArgs}"? (y/N)`);
            if (confirm.toLowerCase() === 'y') {
              deleteSkill(subArgs, existing.source);
              console.log(colors.success(`  Skill "${subArgs}" deleted.\n`));
            } else {
              console.log(colors.dim('  Cancelled.\n'));
            }
          }
          break;
        }

        case 'export': {
          if (!subArgs) {
            console.log(colors.error('  Usage: /skill export <name>\n'));
            break;
          }
          const skill = getSkill(subArgs);
          if (!skill) {
            console.log(colors.error(`  Skill not found: ${subArgs}\n`));
          } else {
            const json = JSON.stringify({ name: skill.name, description: skill.description, args: skill.args, prompt: skill.prompt }, null, 2);
            console.log(colors.header(`\n  Skill: ${skill.name}`));
            console.log(colors.dim('  Copy this JSON to share or import:\n'));
            console.log('  ' + json.replace(/\n/g, '\n  '));
            console.log();
          }
          break;
        }

        case 'import': {
          console.log(colors.dim('  Paste the skill JSON, then enter """ to finish:'));
          console.log(colors.dim('  (Use """ to start and end the JSON block, or /skill create for interactive mode)\n'));
          break;
        }

        default:
          console.log(colors.error(`  Unknown skill command: ${sub}`));
          console.log(colors.dim('  Available: list, show, create, edit, delete, export\n'));
          break;
      }
      break;
    }

    // ─── Default: check for skill match ──────────────────────────
    default: {
      const match = matchSkillCommand(cmd);
      if (match) {
        const expanded = expandSkillPrompt(match.skill, match.args);
        console.log(colors.toolName(`\n  Running skill: /${match.skill.name}`));
        if (match.args) {
          console.log(colors.dim(`  Args: ${match.args}`));
        }
        console.log(colors.dim(`  ${match.skill.description}\n`));
        await handleUserInput(expanded, rl, agent);
        return 'skill-executed';
      }

      console.log(colors.error(`  Unknown command: ${command}`));
      console.log(colors.dim('  Type /help for commands or /skills to see available skills.\n'));
      break;
    }
  }
}

// ─── Skill interactive creation ──────────────────────────────────────

async function createSkillInteractive(ask, prefillName) {
  console.log(colors.header('\n  Create a new skill'));
  console.log(colors.dim('  Skills are reusable prompt templates invoked as /name.\n'));

  const name = prefillName || (await ask('Skill name (lowercase, no spaces):')).trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) {
    console.log(colors.dim('  Cancelled.\n'));
    return;
  }

  const existing = getSkill(name);
  if (existing && existing.source === 'built-in') {
    console.log(colors.warning(`  "${name}" is a built-in skill. Your version will override it.\n`));
  } else if (existing) {
    const overwrite = await ask(`Skill "${name}" already exists. Overwrite? (y/N)`);
    if (overwrite.toLowerCase() !== 'y') {
      console.log(colors.dim('  Cancelled.\n'));
      return;
    }
  }

  const description = (await ask('Description (one line):')).trim();
  const argsHint = (await ask('Arguments hint (e.g., "<file>" or "[message]", or blank for none):')).trim();

  console.log(colors.dim('\n  Now enter the prompt template.'));
  console.log(colors.dim('  Use {{args}} where the user\'s arguments should go.'));
  console.log(colors.dim('  Use {{#if args}}...{{/if}} for conditional sections.'));
  console.log(colors.dim('  Use {{#if args}}...{{else}}...{{/if}} for if/else.'));
  console.log(colors.dim('  Type END on a line by itself when done.\n'));

  const promptLines = [];
  while (true) {
    const line = await ask('>');
    if (line.trim() === 'END') break;
    promptLines.push(line);
  }

  const promptText = promptLines.join('\n');
  if (!promptText.trim()) {
    console.log(colors.dim('  Empty prompt. Cancelled.\n'));
    return;
  }

  const scope = (await ask('Save as (u)ser skill or (p)roject skill? (u/p):')).trim().toLowerCase();
  const saveScope = scope === 'p' ? 'project' : 'user';

  const filepath = saveSkill({ name, description, args: argsHint, prompt: promptText }, saveScope);
  console.log(colors.success(`\n  Skill "/${name}" created!`));
  console.log(colors.dim(`  Saved to: ${filepath}`));
  console.log(colors.dim(`  Run it with: /${name}${argsHint ? ' ' + argsHint : ''}\n`));
}

async function editSkillInteractive(ask, name) {
  const existing = getSkill(name);
  if (!existing) {
    console.log(colors.error(`  Skill not found: ${name}\n`));
    return;
  }

  if (existing.source === 'built-in') {
    console.log(colors.warning(`  "${name}" is built-in. Editing will create a user override.\n`));
  }

  console.log(colors.header(`\n  Editing skill: /${name}`));
  console.log(colors.dim(`  Current description: ${existing.description || '(none)'}`));
  console.log(colors.dim(`  Current args: ${existing.args || '(none)'}`));
  console.log(colors.dim(`  Press Enter to keep current value.\n`));

  const newDesc = (await ask(`Description [${existing.description}]:`)).trim();
  const newArgs = (await ask(`Arguments [${existing.args}]:`)).trim();

  const editPrompt = await ask('Edit the prompt? (y/N):');
  let newPrompt = existing.prompt;

  if (editPrompt.toLowerCase() === 'y') {
    console.log(colors.dim('\n  Current prompt:'));
    console.log(colors.dim('  ' + existing.prompt.replace(/\n/g, '\n  ')));
    console.log(colors.dim('\n  Enter new prompt (type END on a line by itself when done):\n'));

    const lines = [];
    while (true) {
      const line = await ask('>');
      if (line.trim() === 'END') break;
      lines.push(line);
    }
    if (lines.length > 0) {
      newPrompt = lines.join('\n');
    }
  }

  const scope = existing.source === 'project' ? 'project' : 'user';
  const filepath = saveSkill({
    name,
    description: newDesc || existing.description,
    args: newArgs || existing.args,
    prompt: newPrompt,
  }, scope);

  console.log(colors.success(`\n  Skill "/${name}" updated!`));
  console.log(colors.dim(`  Saved to: ${filepath}\n`));
}

// ─── Display helpers ─────────────────────────────────────────────────

function printSkillList() {
  const skills = getAllSkills();
  if (skills.length === 0) {
    console.log(colors.dim('  No skills available.\n'));
    return;
  }

  console.log(colors.header('\n  Available Skills'));
  console.log(colors.dim('  Invoke any skill by typing /name [args]\n'));

  const builtIn = skills.filter(s => s.source === 'built-in');
  const user = skills.filter(s => s.source === 'user');
  const project = skills.filter(s => s.source === 'project');

  if (builtIn.length > 0) {
    console.log(colors.dim('  Built-in:'));
    for (const s of builtIn) {
      const argHint = s.args ? ` ${colors.status(s.args)}` : '';
      console.log(`  ${colors.toolName('/' + s.name)}${argHint}  ${colors.dim(s.description)}`);
    }
  }

  if (user.length > 0) {
    console.log(colors.dim('\n  User:'));
    for (const s of user) {
      const argHint = s.args ? ` ${colors.status(s.args)}` : '';
      console.log(`  ${colors.toolName('/' + s.name)}${argHint}  ${colors.dim(s.description)}`);
    }
  }

  if (project.length > 0) {
    console.log(colors.dim('\n  Project:'));
    for (const s of project) {
      const argHint = s.args ? ` ${colors.status(s.args)}` : '';
      console.log(`  ${colors.toolName('/' + s.name)}${argHint}  ${colors.dim(s.description)}`);
    }
  }

  console.log(colors.dim('\n  Use /skill show <name> for details, /skill create to make a new one.\n'));
}

function printSkillDetail(skill) {
  console.log(`
  ${colors.header('/' + skill.name)} ${colors.status(`[${skill.source}]`)}
  ${skill.description || '(no description)'}
  ${skill.args ? colors.dim(`Arguments: ${skill.args}`) : colors.dim('No arguments')}

  ${colors.dim('Prompt template:')}
  ${colors.dim('─'.repeat(50))}
  ${skill.prompt.replace(/\n/g, '\n  ')}
  ${colors.dim('─'.repeat(50))}
`);
}

function printHelp() {
  console.log(`
  ${colors.header('Commands')}
  ${colors.toolName('/help')}              Show this help
  ${colors.toolName('/exit')}              Exit Mantis
  ${colors.toolName('/clear')}             Clear conversation history
  ${colors.toolName('/plan')}              Toggle plan mode (explore without changes)
  ${colors.toolName('/status')}            Show session status (tokens, model, etc.)
  ${colors.toolName('/cd <dir>')}          Change working directory
  ${colors.toolName('/save [name]')}       Save conversation to disk
  ${colors.toolName('/load [name]')}       Load a saved conversation
  ${colors.toolName('/compact')}           Manually compact conversation history
  ${colors.toolName('/model <name>')}      Switch to a different model
  ${colors.toolName('/config')}            Show current configuration

  ${colors.header('Providers')}
  ${colors.toolName('/provider')}          Show current provider
  ${colors.toolName('/provider list')}     List all available providers
  ${colors.toolName('/provider set <n>')}  Switch provider (e.g. together, groq)
  ${colors.toolName('/provider key <n> <k>')} Set API key for a provider
  ${colors.toolName('/provider test')}     Test connection to current provider
  ${colors.toolName('/provider models')}   List models on current provider

  ${colors.header('Autonomous Mode')}
  ${colors.toolName('/auto <task>')}       Run a task autonomously (no confirmations)
  ${colors.dim('  Example: /auto create a todo app with React and Express')}

  ${colors.header('Swarm Mode')}
  ${colors.toolName('/swarm <task>')}      Use ALL configured providers in parallel
  ${colors.toolName('/swarm --list')}      Show swarm pool and auto-selected lead
  ${colors.toolName('/swarm --lead <p>')}  Force a specific provider as lead
  ${colors.toolName('/swarm remove <p>')}  Exclude a provider from the pool
  ${colors.toolName('/swarm add <p>')}     Re-include an excluded provider
  ${colors.dim('  Example: /swarm refactor the auth module')}

  ${colors.header('Memory')}
  ${colors.toolName('/memory')}            Show saved memory (project + global)
  ${colors.toolName('/memory status')}     Show memory file locations and sizes
  ${colors.toolName('/memory clear <s>')}  Clear memory (project, global, or all)
  ${colors.dim('  Tell the model "save your state to memory" and it will persist')}
  ${colors.dim('  its context for future sessions.')}

  ${colors.header('Skills')}
  ${colors.toolName('/skills')}            List all available skills
  ${colors.toolName('/skill show <n>')}    Show a skill's details and prompt
  ${colors.toolName('/skill create')}      Create a new skill interactively
  ${colors.toolName('/skill edit <n>')}    Edit an existing skill
  ${colors.toolName('/skill delete <n>')}  Delete a user/project skill
  ${colors.toolName('/skill export <n>')}  Export a skill as JSON
  ${colors.toolName('/<skillname>')}       Run a skill (e.g. /commit, /test, /review)

  ${colors.header('Built-in Skills')}
  ${colors.toolName('/commit [msg]')}      Stage & commit with AI-generated message
  ${colors.toolName('/review [branch]')}   Review code changes
  ${colors.toolName('/test [cmd]')}        Run tests and fix failures
  ${colors.toolName('/explain <target>')}  Explain how code works
  ${colors.toolName('/fix <error>')}       Diagnose and fix a bug
  ${colors.toolName('/refactor <target>')} Refactor code
  ${colors.toolName('/deps')}              Analyze project dependencies
  ${colors.toolName('/init')}              Explore and summarize the project

  ${colors.header('Multiline Input')}
  ${colors.dim('Start with """ or \'\'\' and end with the same to send multiline text.')}

  ${colors.header('Creating Skills')}
  ${colors.dim('Skills are reusable prompt templates saved as slash commands.')}
  ${colors.dim('Use /skill create to make one interactively. Skills can live in:')}
  ${colors.dim('  ~/.mantis/skills/       (available everywhere)')}
  ${colors.dim('  .mantis/skills/         (project-specific, shareable via git)')}
  ${colors.dim('Use {{args}} in prompts for argument substitution.')}

  ${colors.header('Examples')}
  ${colors.dim('"List the files in this directory"')}
  ${colors.dim('"Read src/index.js and explain what it does"')}
  ${colors.dim('/commit Fixes auth token expiry bug')}
  ${colors.dim('/test npm run test:unit')}
  ${colors.dim('/explain src/auth/middleware.js')}
  ${colors.dim('/auto create a REST API with Express')}
`);
}
