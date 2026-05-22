/**
 * Approximate model pricing for the cost estimate shown in /status and the
 * admin panel. Figures are USD per 1 million tokens { in, out } and are
 * ballpark — providers change prices often. Local providers are free.
 *
 * Matching is by substring on the model id, so 'gpt-4o' covers 'gpt-4o-2024-…'.
 */

const FREE_PROVIDERS = new Set(['local', 'lmstudio', 'llamacpp', 'ollama']);

// Order matters — more specific keys first (gpt-4o-mini before gpt-4o).
const PRICING = [
  ['gpt-4o-mini',      { in: 0.15, out: 0.60 }],
  ['gpt-4.1-mini',     { in: 0.40, out: 1.60 }],
  ['gpt-4.1',          { in: 2.00, out: 8.00 }],
  ['gpt-4o',           { in: 2.50, out: 10.00 }],
  ['o1-mini',          { in: 1.10, out: 4.40 }],
  ['o1',               { in: 15.00, out: 60.00 }],
  ['claude-opus',      { in: 15.00, out: 75.00 }],
  ['claude-sonnet',    { in: 3.00, out: 15.00 }],
  ['claude-haiku',     { in: 0.80, out: 4.00 }],
  ['gemini-2.5-pro',   { in: 1.25, out: 10.00 }],
  ['gemini-2.5-flash', { in: 0.15, out: 0.60 }],
  ['gemini',           { in: 0.15, out: 0.60 }],
  ['deepseek-reasoner',{ in: 0.55, out: 2.19 }],
  ['deepseek',         { in: 0.27, out: 1.10 }],
  ['grok-3',           { in: 3.00, out: 15.00 }],
  ['grok',             { in: 2.00, out: 10.00 }],
  ['codestral',        { in: 0.30, out: 0.90 }],
  ['mistral-large',    { in: 2.00, out: 6.00 }],
  ['sonar-pro',        { in: 3.00, out: 15.00 }],
  ['sonar',            { in: 1.00, out: 1.00 }],
  ['command-a',        { in: 2.50, out: 10.00 }],
  ['kimi',             { in: 0.60, out: 2.50 }],
  ['glm-4.6',          { in: 0.60, out: 2.20 }],
  ['qwen3-coder',      { in: 0.30, out: 1.20 }],
  ['qwen',             { in: 0.20, out: 0.60 }],
  ['llama',            { in: 0.20, out: 0.60 }],
];

/**
 * Estimate the USD cost of a request.
 * @param {string} providerKey - the provider key (local providers are free)
 * @param {string} model - the model id
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {{cost:number, known:boolean}}
 */
export function estimateCost(providerKey, model, promptTokens = 0, completionTokens = 0) {
  if (FREE_PROVIDERS.has(providerKey)) return { cost: 0, known: true };
  const m = (model || '').toLowerCase();
  for (const [key, p] of PRICING) {
    if (m.includes(key)) {
      const cost = (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out;
      return { cost, known: true };
    }
  }
  return { cost: 0, known: false };
}

/** Format a USD amount compactly for display. */
export function formatCost(usd) {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return '$' + usd.toFixed(3);
  return '$' + usd.toFixed(2);
}
