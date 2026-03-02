import { callLLM, createRateLimiter } from './agent.js';
import { getConfig, saveConfig, PROVIDERS } from './config.js';
import { readOnlyToolDefinitions } from './tool-definitions.js';
import { toolDefinitions } from './tool-definitions.js';
import { buildSwarmPlanPrompt, buildSwarmWorkerPrompt, buildSystemPrompt, buildArchitectPrompt, buildEditorPrompt } from './prompt.js';
import { executeTool, getWorkingDirectory } from './tools.js';

// ─── Swarm Pool Discovery ───────────────────────────────────────────

/**
 * Returns all providers that have API keys configured.
 * Local Ollama is included if the provider exists (no key needed).
 */
export function getSwarmPool() {
  const config = getConfig();
  const excluded = config.swarm?.excludeProviders || [];
  const pool = [];

  for (const [key, provider] of Object.entries(PROVIDERS)) {
    if (excluded.includes(key)) continue;
    if (key === 'local') {
      pool.push({ key, provider, hasKey: true });
    } else if (config.providerKeys?.[key]) {
      pool.push({ key, provider, hasKey: true });
    }
  }

  return pool;
}

/**
 * Exclude a provider from the swarm pool.
 */
export function excludeFromSwarm(providerKey) {
  const config = getConfig();
  const excluded = config.swarm?.excludeProviders || [];
  if (!excluded.includes(providerKey)) {
    excluded.push(providerKey);
    saveConfig({ swarm: { ...config.swarm, excludeProviders: excluded } });
  }
}

/**
 * Re-include a previously excluded provider in the swarm pool.
 */
export function includeInSwarm(providerKey) {
  const config = getConfig();
  const excluded = (config.swarm?.excludeProviders || []).filter(k => k !== providerKey);
  saveConfig({ swarm: { ...config.swarm, excludeProviders: excluded } });
}

// ─── Complexity Classification ──────────────────────────────────────

// Keywords that signal task complexity
const HARD_KEYWORDS = [
  'refactor', 'architect', 'redesign', 'migrate', 'security', 'auth',
  'database', 'schema', 'performance', 'optimize', 'concurrency',
  'distributed', 'microservice', 'api design', 'from scratch',
];
const SIMPLE_KEYWORDS = [
  'rename', 'typo', 'fix import', 'add comment', 'update version',
  'change color', 'swap', 'move', 'delete', 'remove unused',
  'log', 'print', 'format', 'lint',
];

/**
 * Classify task complexity as 'simple', 'medium', or 'hard'.
 * Uses keyword heuristics — fast, zero-cost.
 */
export function classifyComplexity(task) {
  const lower = task.toLowerCase();
  const wordCount = task.split(/\s+/).length;

  // Short tasks with simple keywords → simple
  if (wordCount <= 8 && SIMPLE_KEYWORDS.some(k => lower.includes(k))) return 'simple';

  // Hard keywords → hard
  if (HARD_KEYWORDS.some(k => lower.includes(k))) return 'hard';

  // Long detailed tasks → likely hard
  if (wordCount > 30) return 'hard';

  return 'medium';
}

// ─── Lead Selection ─────────────────────────────────────────────────

// Provider tiers for complexity-based routing
const TIER_PREMIUM = ['anthropic', 'openai', 'xai', 'gemini'];
const TIER_FAST = ['groq', 'cerebras', 'sambanova', 'fireworks'];
const TIER_MID = ['together', 'deepinfra', 'novita', 'openrouter', 'mistral', 'chutes', 'cohere', 'perplexity'];

// Fallback for when no complexity match
const FALLBACK_PRIORITY = ['local', 'openai', 'anthropic', 'openrouter', 'xai', 'perplexity'];

/**
 * Select the best lead provider from the pool.
 * Priority: user override > complexity-based tier > highest RPM > fallback.
 */
export function selectLead(pool, override, task) {
  if (override) {
    const match = pool.find(p => p.key === override);
    if (match) return match;
  }

  // Complexity-based routing when a task is provided
  if (task) {
    const complexity = classifyComplexity(task);
    let preferredTier;

    if (complexity === 'hard') {
      preferredTier = TIER_PREMIUM;
    } else if (complexity === 'simple') {
      preferredTier = TIER_FAST;
    } else {
      preferredTier = [...TIER_FAST, ...TIER_MID]; // medium: fast or mid-tier
    }

    // Find the first available provider in the preferred tier
    for (const key of preferredTier) {
      const match = pool.find(p => p.key === key);
      if (match) return match;
    }
  }

  // Fallback: sort by RPM (highest first)
  const withRpm = pool.filter(p => p.provider.rateLimit?.rpm);
  const withoutRpm = pool.filter(p => !p.provider.rateLimit?.rpm);

  if (withRpm.length > 0) {
    withRpm.sort((a, b) => (b.provider.rateLimit.rpm || 0) - (a.provider.rateLimit.rpm || 0));
    return withRpm[0];
  }

  for (const key of FALLBACK_PRIORITY) {
    const match = withoutRpm.find(p => p.key === key);
    if (match) return match;
  }

  return pool[0];
}

// ─── Provider URL/Headers Builder ───────────────────────────────────

function buildProviderConnection(providerKey) {
  const config = getConfig();
  const provider = PROVIDERS[providerKey];
  if (!provider) return null;

  let url;
  let headers = { 'Content-Type': 'application/json' };

  if (providerKey === 'local') {
    url = `${config.ollamaUrl}/v1/chat/completions`;
  } else {
    url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const apiKey = config.providerKeys?.[providerKey];
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  const model = providerKey === config.provider ? config.model : provider.defaultModel;

  return { url, headers, model, provider };
}

// ─── Task Decomposition ─────────────────────────────────────────────

/**
 * Ask the lead to decompose a task into explore/code/review subtasks.
 * Returns parsed plan object or null on failure.
 */
async function decomposeTask(lead, task, onStatus, isCancelled) {
  const conn = buildProviderConnection(lead.key);
  if (!conn) return null;

  const rateLimiter = createRateLimiter();
  const messages = [
    { role: 'system', content: buildSwarmPlanPrompt(task) },
    { role: 'user', content: task },
  ];

  let responseText = '';

  const assistantMsg = await callLLM(conn.url, conn.model, messages, conn.headers, conn.provider, {
    onText: (text) => { responseText += text; },
    onError: (err) => { if (onStatus) onStatus('error', lead.key, err); },
    onThinking: () => {},
    onToken: () => {},
    rateLimiter,
    tools: [], // No tools for planning — just text response
  }, isCancelled);

  if (!assistantMsg || !responseText) return null;

  // Parse the JSON plan from response
  try {
    // Try to extract JSON from the response (might have markdown fences)
    let json = responseText.trim();
    const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) json = fenceMatch[1].trim();

    // Find the outermost { ... }
    const start = json.indexOf('{');
    const end = json.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      json = json.slice(start, end + 1);
    }

    return JSON.parse(json);
  } catch {
    if (onStatus) onStatus('error', lead.key, 'Failed to parse task plan — falling back to single provider');
    return null;
  }
}

// ─── Worker Execution ───────────────────────────────────────────────

/**
 * Run a single worker's exploration subtask.
 * Workers get read-only tools and their own rate limiter.
 */
async function runWorker(workerEntry, subtask, onStatus, isCancelled) {
  const conn = buildProviderConnection(workerEntry.key);
  if (!conn) return { id: subtask.id, provider: workerEntry.key, result: null, error: 'No connection' };

  const rateLimiter = createRateLimiter();
  const cwd = getWorkingDirectory();
  const messages = [
    { role: 'system', content: buildSwarmWorkerPrompt(subtask.description, cwd) },
    { role: 'user', content: subtask.description },
  ];

  let fullResponse = '';
  let loopCount = 0;
  const maxLoops = 5; // Workers get fewer loops — they're read-only

  while (loopCount < maxLoops) {
    if (isCancelled()) return { id: subtask.id, provider: workerEntry.key, result: null, error: 'Cancelled' };
    loopCount++;

    const assistantMsg = await callLLM(conn.url, conn.model, messages, conn.headers, conn.provider, {
      onText: (text) => { fullResponse += text; },
      onError: (err) => { if (onStatus) onStatus('worker-error', workerEntry.key, err); },
      onThinking: () => {},
      onToken: () => {},
      rateLimiter,
      tools: readOnlyToolDefinitions,
    }, isCancelled);

    if (!assistantMsg || isCancelled()) break;
    messages.push(assistantMsg);

    // If no tool calls, worker is done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) break;

    // Execute read-only tool calls
    for (const toolCall of assistantMsg.tool_calls) {
      if (isCancelled()) break;
      const fnName = toolCall.function.name;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch {}

      if (onStatus) onStatus('worker-tool', workerEntry.key, `${fnName}`);
      const result = await executeTool(fnName, args);
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
    }
  }

  return {
    id: subtask.id,
    provider: workerEntry.key,
    result: fullResponse || '(no response)',
    error: null,
  };
}

/**
 * Run a single worker with 30s timeout. On failure, retry on a fallback worker.
 */
async function runWorkerWithFallback(worker, subtask, allWorkers, onStatus, isCancelled) {
  // Try primary worker
  try {
    if (onStatus) onStatus('explore-start', worker.key, subtask.description);
    const result = await Promise.race([
      runWorker(worker, subtask, onStatus, isCancelled),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Worker timeout (30s)')), 30_000)),
    ]);
    if (result.error && !isCancelled()) {
      // Primary failed — try fallback
      const fallback = allWorkers.find(w => w.key !== worker.key);
      if (fallback) {
        if (onStatus) onStatus('fallback', fallback.key, `retrying ${subtask.id} (was ${worker.key})`);
        return await Promise.race([
          runWorker(fallback, subtask, onStatus, isCancelled),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Fallback timeout (30s)')), 30_000)),
        ]);
      }
    }
    return result;
  } catch (err) {
    if (isCancelled()) return { id: subtask.id, provider: worker.key, result: null, error: 'Cancelled' };
    // Primary timed out or errored — try fallback
    const fallback = allWorkers.find(w => w.key !== worker.key);
    if (fallback) {
      if (onStatus) onStatus('fallback', fallback.key, `retrying ${subtask.id} (${worker.key} failed: ${err.message})`);
      try {
        return await Promise.race([
          runWorker(fallback, subtask, onStatus, isCancelled),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Fallback timeout (30s)')), 30_000)),
        ]);
      } catch (err2) {
        return { id: subtask.id, provider: fallback.key, result: null, error: err2.message };
      }
    }
    return { id: subtask.id, provider: worker.key, result: null, error: err.message };
  }
}

/**
 * Run explore subtasks in parallel across workers.
 * Assigns tasks round-robin. Failed workers auto-fallback to another provider.
 */
async function runParallelExplorers(subtasks, workers, onStatus, isCancelled) {
  if (subtasks.length === 0) return [];

  const config = getConfig();
  const maxWorkers = config.swarm?.maxParallelWorkers || 4;
  const activeWorkers = workers.slice(0, maxWorkers);

  // Round-robin assignment
  const assignments = subtasks.map((task, i) => ({
    worker: activeWorkers[i % activeWorkers.length],
    subtask: task,
  }));

  const results = await Promise.allSettled(
    assignments.map(({ worker, subtask }) =>
      runWorkerWithFallback(worker, subtask, activeWorkers, onStatus, isCancelled)
    )
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') {
      if (onStatus) onStatus('explore-done', r.value.provider, r.value.id);
      return r.value;
    }
    if (onStatus) onStatus('explore-fail', assignments[i].worker.key, r.reason?.message || 'Unknown error');
    return { id: assignments[i].subtask.id, provider: assignments[i].worker.key, result: null, error: r.reason?.message };
  });
}

// ─── Result Merging ─────────────────────────────────────────────────

function mergeExplorationResults(results) {
  const parts = [];
  for (const r of results) {
    if (r.result) {
      parts.push(`[${r.provider} — ${r.id}]\n${r.result}`);
    } else if (r.error) {
      parts.push(`[${r.provider} — ${r.id}] ERROR: ${r.error}`);
    }
  }
  // Cap the merged context to prevent blowing up the lead's context
  const merged = parts.join('\n\n---\n\n');
  if (merged.length > 12000) {
    return merged.slice(0, 12000) + '\n\n... (exploration results truncated)';
  }
  return merged;
}

// ─── Code Phase (Architect/Editor Split) ────────────────────────────

/**
 * Architect phase: lead reasons about the solution (no tools, pure text).
 * Returns the architect's solution text.
 */
async function runArchitectPhase(lead, plan, context, originalTask, onStatus, onText, isCancelled) {
  const conn = buildProviderConnection(lead.key);
  if (!conn) return null;

  const rateLimiter = createRateLimiter();
  const codeDescriptions = plan.code.map(c => `- ${c.description}`).join('\n');
  const messages = [
    { role: 'system', content: buildArchitectPrompt(originalTask, context, codeDescriptions) },
    { role: 'user', content: originalTask },
  ];

  let solution = '';
  await callLLM(conn.url, conn.model, messages, conn.headers, conn.provider, {
    onText: (text) => {
      solution += text;
      if (onText) onText(text);
    },
    onError: (err) => { if (onStatus) onStatus('error', lead.key, err); },
    onThinking: () => {},
    onToken: () => {},
    rateLimiter,
    tools: [], // No tools — pure reasoning
  }, isCancelled);

  return solution || null;
}

/**
 * Editor phase: a worker (or the lead) takes the architect's solution and makes edits.
 * Gets full tool access.
 */
async function runEditorPhase(editor, architectSolution, onStatus, onText, onToolCall, onToolResult, isCancelled) {
  const conn = buildProviderConnection(editor.key);
  if (!conn) return;

  const rateLimiter = createRateLimiter();
  const cwd = getWorkingDirectory();
  const messages = [
    { role: 'system', content: buildSystemPrompt(cwd, 'normal') },
    { role: 'user', content: buildEditorPrompt(architectSolution) },
  ];

  let loopCount = 0;
  const maxLoops = 15;

  while (loopCount < maxLoops) {
    if (isCancelled()) return;
    loopCount++;

    let responseText = '';
    const assistantMsg = await callLLM(conn.url, conn.model, messages, conn.headers, conn.provider, {
      onText: (text) => {
        responseText += text;
        if (onText) onText(text);
      },
      onError: (err) => { if (onStatus) onStatus('error', editor.key, err); },
      onThinking: () => {},
      onToken: () => {},
      rateLimiter,
      tools: toolDefinitions,
    }, isCancelled);

    if (!assistantMsg || isCancelled()) return;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) return;

    for (const toolCall of assistantMsg.tool_calls) {
      if (isCancelled()) return;
      const fnName = toolCall.function.name;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch {}

      if (onToolCall) onToolCall(fnName, args, editor.key);
      const result = await executeTool(fnName, args);
      if (onToolResult) onToolResult(fnName, result, editor.key);

      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
    }
  }
}

/**
 * Code phase: uses Architect/Editor split when a separate editor worker is available.
 * Falls back to single-provider (lead does both) when no workers are free.
 */
async function runCodePhase(lead, workers, plan, context, originalTask, onStatus, onText, onToolCall, onToolResult, isCancelled) {
  // Pick the fastest available worker as the editor (prefer high RPM providers)
  const editorCandidate = workers.length > 0
    ? workers.reduce((best, w) => {
        const bestRpm = best.provider.rateLimit?.rpm || 0;
        const wRpm = w.provider.rateLimit?.rpm || 0;
        return wRpm > bestRpm ? w : best;
      }, workers[0])
    : null;

  const config = getConfig();
  const bestOfN = config.swarm?.bestOfN || 0;

  // Best-of-N mode: get multiple architect solutions, judge picks best
  if (bestOfN >= 2 && workers.length >= 1) {
    // Collect N providers for parallel architect solutions (lead + workers)
    const architects = [lead, ...workers].slice(0, bestOfN);

    if (onStatus) onStatus('phase-detail', null, `Best-of-${architects.length}: ${architects.map(a => a.key).join(', ')} competing...`);

    const solutionResults = await Promise.allSettled(
      architects.map(a => Promise.race([
        getArchitectSolution(a, plan, context, originalTask, isCancelled),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Architect timeout')), 45_000)),
      ]))
    );

    const solutions = solutionResults
      .filter(r => r.status === 'fulfilled' && r.value.solution)
      .map(r => r.value);

    if (solutions.length === 0) {
      if (onStatus) onStatus('error', lead.key, 'All architect solutions failed');
      return;
    }

    let winningSolution;
    if (solutions.length === 1) {
      winningSolution = solutions[0].solution;
      if (onStatus) onStatus('phase-detail', solutions[0].provider, 'Only 1 solution received, using it');
    } else {
      // Use the fastest provider as judge
      const judge = workers.reduce((best, w) => {
        const bestRpm = best.provider.rateLimit?.rpm || 0;
        const wRpm = w.provider.rateLimit?.rpm || 0;
        return wRpm > bestRpm ? w : best;
      }, workers[0]);

      if (onStatus) onStatus('phase-detail', judge.key, `Judging ${solutions.length} solutions...`);
      const bestIdx = await judgeSolutions(judge, solutions, originalTask, isCancelled);
      winningSolution = solutions[bestIdx].solution;
      if (onStatus) onStatus('phase-detail', solutions[bestIdx].provider, `Winner: solution ${bestIdx + 1} from ${solutions[bestIdx].provider}`);
    }

    if (isCancelled()) return;
    if (onStatus) onStatus('phase-detail', editorCandidate.key, 'Editor implementing winning solution...');
    await runEditorPhase(editorCandidate, winningSolution, onStatus, null, onToolCall, onToolResult, isCancelled);
  }
  // Architect/Editor split: lead reasons, editor implements
  else if (editorCandidate) {
    if (onStatus) onStatus('phase-detail', lead.key, 'Architect reasoning...');
    const solution = await runArchitectPhase(lead, plan, context, originalTask, onStatus, onText, isCancelled);
    if (!solution || isCancelled()) return;

    if (onStatus) onStatus('phase-detail', editorCandidate.key, 'Editor implementing...');
    await runEditorPhase(editorCandidate, solution, onStatus, null, onToolCall, onToolResult, isCancelled);
  } else {
    // Fallback: lead does both (original single-provider behavior)
    const conn = buildProviderConnection(lead.key);
    if (!conn) return;

    const rateLimiter = createRateLimiter();
    const cwd = getWorkingDirectory();
    const codeDescriptions = plan.code.map(c => `- ${c.description}`).join('\n');
    const messages = [
      { role: 'system', content: buildSystemPrompt(cwd, 'normal') },
      { role: 'user', content: `Workers explored the codebase. Here are their findings:\n\n---EXPLORATION RESULTS---\n${context}\n---END RESULTS---\n\nTask: ${originalTask}\n\nCode tasks:\n${codeDescriptions}\n\nImplement the changes. Use your tools to write/edit files.` },
    ];

    let loopCount = 0;
    const maxLoops = 15;
    while (loopCount < maxLoops) {
      if (isCancelled()) return;
      loopCount++;
      let responseText = '';
      const assistantMsg = await callLLM(conn.url, conn.model, messages, conn.headers, conn.provider, {
        onText: (text) => { responseText += text; if (onText) onText(text); },
        onError: (err) => { if (onStatus) onStatus('error', lead.key, err); },
        onThinking: () => {}, onToken: () => {},
        rateLimiter, tools: toolDefinitions,
      }, isCancelled);
      if (!assistantMsg || isCancelled()) return;
      messages.push(assistantMsg);
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) return;
      for (const toolCall of assistantMsg.tool_calls) {
        if (isCancelled()) return;
        const fnName = toolCall.function.name;
        let args = {};
        try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch {}
        if (onToolCall) onToolCall(fnName, args, lead.key);
        const result = await executeTool(fnName, args);
        if (onToolResult) onToolResult(fnName, result, lead.key);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
    }
  }
}

// ─── Best-of-N: Parallel Architect Solutions + Judge ─────────────────

/**
 * Get a single architect solution from a provider (no tools).
 */
async function getArchitectSolution(providerEntry, plan, context, task, isCancelled) {
  const conn = buildProviderConnection(providerEntry.key);
  if (!conn) return { provider: providerEntry.key, solution: null };

  const rateLimiter = createRateLimiter();
  const codeDescriptions = plan.code.map(c => `- ${c.description}`).join('\n');
  const messages = [
    { role: 'system', content: buildArchitectPrompt(task, context, codeDescriptions) },
    { role: 'user', content: task },
  ];

  let solution = '';
  await callLLM(conn.url, conn.model, messages, conn.headers, conn.provider, {
    onText: (text) => { solution += text; },
    onError: () => {},
    onThinking: () => {},
    onToken: () => {},
    rateLimiter,
    tools: [],
  }, isCancelled);

  return { provider: providerEntry.key, solution: solution || null };
}

/**
 * Ask a judge (fast cheap provider) to pick the best solution from N candidates.
 * Returns the index of the best solution (0-based).
 */
async function judgeSolutions(judgeEntry, solutions, task, isCancelled) {
  const conn = buildProviderConnection(judgeEntry.key);
  if (!conn) return 0;

  const rateLimiter = createRateLimiter();
  const candidateText = solutions.map((s, i) =>
    `--- SOLUTION ${i + 1} (${s.provider}) ---\n${(s.solution || '(empty)').slice(0, 3000)}\n--- END SOLUTION ${i + 1} ---`
  ).join('\n\n');

  const messages = [
    { role: 'system', content: `You are a code quality judge. Compare multiple proposed solutions for a coding task and pick the best one. Respond with ONLY a JSON object: {"best": <number>, "reason": "<brief reason>"}` },
    { role: 'user', content: `Task: ${task}\n\n${candidateText}\n\nWhich solution is best? Respond with {"best": <1-based number>, "reason": "..."}` },
  ];

  let judgeText = '';
  await callLLM(conn.url, conn.model, messages, conn.headers, conn.provider, {
    onText: (text) => { judgeText += text; },
    onError: () => {},
    onThinking: () => {},
    onToken: () => {},
    rateLimiter,
    tools: [],
  }, isCancelled);

  try {
    let json = judgeText.trim();
    const start = json.indexOf('{');
    const end = json.lastIndexOf('}');
    if (start !== -1 && end !== -1) json = json.slice(start, end + 1);
    const parsed = JSON.parse(json);
    const idx = (parsed.best || 1) - 1; // convert 1-based to 0-based
    return Math.max(0, Math.min(idx, solutions.length - 1));
  } catch {
    return 0; // default to first solution
  }
}

// ─── Review Phase ───────────────────────────────────────────────────

async function runReviewPhase(reviewer, reviewDescription, explorationContext, onStatus, isCancelled) {
  if (!reviewDescription) return null;

  const conn = buildProviderConnection(reviewer.key);
  if (!conn) return null;

  const rateLimiter = createRateLimiter();
  const messages = [
    { role: 'system', content: 'You are a code reviewer. Check the changes described below for correctness, style, and potential issues. Be concise.' },
    { role: 'user', content: `Review task: ${reviewDescription}\n\nContext from exploration:\n${explorationContext.slice(0, 4000)}` },
  ];

  let reviewText = '';
  const assistantMsg = await callLLM(conn.url, conn.model, messages, conn.headers, conn.provider, {
    onText: (text) => { reviewText += text; },
    onError: () => {},
    onThinking: () => {},
    onToken: () => {},
    rateLimiter,
    tools: readOnlyToolDefinitions,
  }, isCancelled);

  // Let the reviewer use read-only tools (one loop)
  if (assistantMsg?.tool_calls?.length > 0) {
    messages.push(assistantMsg);
    for (const toolCall of assistantMsg.tool_calls) {
      if (isCancelled()) break;
      const fnName = toolCall.function.name;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch {}
      if (onStatus) onStatus('review-tool', reviewer.key, fnName);
      const result = await executeTool(fnName, args);
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
    }
    // Get final review text
    let finalText = '';
    await callLLM(conn.url, conn.model, messages, conn.headers, conn.provider, {
      onText: (text) => { finalText += text; },
      onError: () => {},
      onThinking: () => {},
      onToken: () => {},
      rateLimiter,
      tools: [],
    }, isCancelled);
    if (finalText) reviewText = finalText;
  }

  return reviewText || null;
}

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Run a swarm across all configured providers.
 *
 * @param {string} task - The user's task description
 * @param {object} callbacks - { onStatus, onText, onToolCall, onToolResult }
 * @param {object} options - { leadOverride, signal }
 * @returns {object} { success, totalCalls, totalProviders, elapsed }
 */
export async function runSwarm(task, callbacks = {}, options = {}) {
  const { onStatus, onText, onToolCall, onToolResult } = callbacks;
  const { leadOverride } = options;

  let _cancelled = false;
  const isCancelled = () => _cancelled;

  // Allow external cancellation
  const cancel = () => { _cancelled = true; };

  const startTime = Date.now();
  const pool = getSwarmPool();

  if (pool.length < 2) {
    if (onStatus) onStatus('error', null, 'Swarm needs at least 2 configured providers. Use /provider key <name> <key> to add more.');
    return { success: false, cancel };
  }

  const complexity = classifyComplexity(task);
  const lead = selectLead(pool, leadOverride, task);
  const workers = pool.filter(p => p.key !== lead.key);

  if (onStatus) onStatus('pool', lead.key, { pool: pool.map(p => p.key), lead: lead.key, count: pool.length, complexity });

  // Phase 1: Planning
  if (onStatus) onStatus('phase', lead.key, 'PLAN');
  const plan = await decomposeTask(lead, task, onStatus, isCancelled);

  if (_cancelled) return { success: false, cancel };

  if (!plan || !plan.explore || !plan.code) {
    if (onStatus) onStatus('error', lead.key, 'Could not decompose task — plan was empty or invalid');
    return { success: false, cancel };
  }

  if (onStatus) onStatus('plan-ready', lead.key, {
    explore: plan.explore.length,
    code: plan.code.length,
    review: plan.review ? 1 : 0,
  });

  // Phase 2: Parallel Exploration
  let mergedContext;
  if (plan.explore.length > 0) {
    if (onStatus) onStatus('phase', null, 'EXPLORE');
    const exploreResults = await runParallelExplorers(plan.explore, workers, onStatus, isCancelled);
    if (_cancelled) return { success: false, cancel };

    mergedContext = mergeExplorationResults(exploreResults);
  } else {
    mergedContext = '(no exploration needed)';
  }

  // Phase 3: Code Writing (architect/editor split)
  if (onStatus) onStatus('phase', lead.key, 'CODE');
  await runCodePhase(lead, workers, plan, mergedContext, task, onStatus, onText, onToolCall, onToolResult, isCancelled);
  if (_cancelled) return { success: false, cancel };

  // Phase 4: Review (optional, uses a different worker)
  let reviewResult = null;
  if (plan.review?.description && workers.length > 0) {
    // Pick a reviewer — prefer one that wasn't heavily used in explore
    const reviewer = workers[workers.length - 1]; // last worker = likely least loaded
    if (onStatus) onStatus('phase', reviewer.key, 'REVIEW');
    reviewResult = await runReviewPhase(reviewer, plan.review.description, mergedContext, onStatus, isCancelled);
    if (reviewResult && onStatus) onStatus('review-done', reviewer.key, reviewResult);
  }

  const elapsed = Date.now() - startTime;
  return {
    success: !_cancelled,
    totalProviders: pool.length,
    elapsed,
    cancel,
    reviewResult,
  };
}
