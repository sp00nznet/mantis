import fs from 'fs';
import path from 'path';
import os from 'os';

// Data directory. Defaults to ~/.mantis, but MANTIS_HOME (or MANTIS_DATA_DIR)
// relocates it. Essential for running as a Windows service: under LocalSystem,
// os.homedir() resolves to C:\Windows\System32\config\systemprofile — set
// MANTIS_HOME to a real path (e.g. C:\ProgramData\Mantis) so config, sessions,
// and per-user data land somewhere sane and ACL-able.
const DATA_DIR_OVERRIDE = (process.env.MANTIS_HOME || process.env.MANTIS_DATA_DIR || '').trim();
const CONFIG_DIR = DATA_DIR_OVERRIDE
  ? path.resolve(DATA_DIR_OVERRIDE)
  : path.join(os.homedir(), '.mantis');
const OLD_CONFIG_DIR = path.join(os.homedir(), '.qwen-local');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CONVERSATIONS_DIR = path.join(CONFIG_DIR, 'conversations');
const MEMORY_DIR = path.join(CONFIG_DIR, 'memory');

// ─── Cloud Provider Registry ────────────────────────────────────────

export const PROVIDERS = {
  local: {
    name: 'Local (Ollama)',
    baseUrl: 'http://localhost:11434/v1',
    requiresKey: false,
    defaultModel: 'qwen3-coder',
    description: 'Local Ollama instance — no API key needed',
  },
  together: {
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    requiresKey: true,
    defaultModel: 'deepseek-ai/DeepSeek-V3.1',
    description: 'Cloud GPU inference — free tier available',
    rateLimit: { rpm: 600 },
  },
  fireworks: {
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    requiresKey: true,
    defaultModel: 'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct',
    description: 'Fast cloud inference — free tier available',
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    defaultModel: 'qwen/qwen3-32b',
    description: 'Ultra-fast inference — generous free tier',
    rateLimit: { rpm: 30, rpd: 14400 },
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    defaultModel: 'qwen/qwen3-coder-480b-a35b-instruct',
    description: 'Routes to many providers — pay per token',
  },
  deepinfra: {
    name: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    requiresKey: true,
    defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    description: 'Affordable cloud inference — free tier available',
  },
  chutes: {
    name: 'Chutes AI',
    baseUrl: 'https://llm.chutes.ai/v1',
    requiresKey: true,
    defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    description: 'Decentralized serverless inference — open-source models',
  },
  cerebras: {
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    requiresKey: true,
    defaultModel: 'llama3.1-8b',
    description: 'Ultra-fast wafer-scale inference — free tier: llama3.1-8b',
  },
  novita: {
    name: 'Novita AI',
    baseUrl: 'https://api.novita.ai/v3/openai',
    requiresKey: true,
    defaultModel: 'qwen/qwen3-coder-480b-a35b-instruct',
    description: '200+ models — cheap serverless inference',
  },
  mistral: {
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    requiresKey: true,
    defaultModel: 'codestral-latest',
    description: 'Codestral for coding — free tier with 1B tokens/mo',
    rateLimit: { rpm: 2 },
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    defaultModel: 'gpt-4o',
    description: 'GPT-4o, o3 and more — the original LLM API',
  },
  anthropic: {
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true,
    defaultModel: 'claude-sonnet-4-6',
    description: 'Claude Sonnet/Opus — OpenAI compat layer',
  },
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true,
    defaultModel: 'gemini-2.5-flash',
    description: 'Gemini 2.5 — free tier (5 RPM, 20 RPD)',
    rateLimit: { rpm: 5, rpd: 20 },
  },
  xai: {
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    requiresKey: true,
    defaultModel: 'grok-3',
    description: 'Grok-3 — $25 free credits to start',
  },
  perplexity: {
    name: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    requiresKey: true,
    defaultModel: 'sonar-pro',
    description: 'Search-augmented LLM — live web knowledge',
  },
  sambanova: {
    name: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    requiresKey: true,
    defaultModel: 'Qwen3-32B',
    description: 'Fast RDU inference — free tier available',
  },
  cohere: {
    name: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    requiresKey: true,
    defaultModel: 'command-a-03-2025',
    description: 'Command A — enterprise-grade with free trial',
  },
  nvidia: {
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    requiresKey: true,
    defaultModel: 'qwen/qwen3-coder-480b-a35b-instruct',
    description: 'NVIDIA-hosted models — FREE API key from build.nvidia.com',
    // Free tier is ~40 RPM per model, but heavy models (480B) throttle well
    // before that. Pace conservatively (~one request / 4s) so the agent loop
    // rarely trips a 429 — proactive spacing beats reactive retry backoff.
    rateLimit: { rpm: 15 },
  },
  kimi: {
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    requiresKey: true,
    defaultModel: 'kimi-k2.6',
    description: 'Moonshot Kimi K2.6 — strong agentic coding model',
  },
  zai: {
    name: 'Z.ai (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    requiresKey: true,
    defaultModel: 'glm-4.6',
    description: 'GLM-4.6 — OpenAI-compatible, cheap coding plan',
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    requiresKey: true,
    defaultModel: 'deepseek-chat',
    description: 'DeepSeek V3 — strong coding model at very low cost',
  },
  lmstudio: {
    name: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    requiresKey: false,
    defaultModel: 'local-model',
    description: 'Local LM Studio server — set the loaded model with /model',
  },
  llamacpp: {
    name: 'llama.cpp (local)',
    baseUrl: 'http://localhost:8080/v1',
    requiresKey: false,
    defaultModel: 'local-model',
    description: 'Local llama.cpp server (llama-server) — no API key needed',
  },
};

const DEFAULTS = {
  ollamaUrl: 'http://localhost:11434',
  // Per-provider base URL overrides for local backends (LM Studio, llama.cpp,
  // or any self-hosted OpenAI-compat shim). Empty string = use the provider's
  // registry default. Ollama keeps using `ollamaUrl` above for back-compat.
  localUrls: {
    lmstudio: '',
    llamacpp: '',
  },
  model: 'qwen3-coder-cpu',
  maxContextTokens: 32768,
  compactThreshold: 0.75,  // compact when context is 75% full
  commandTimeout: 60000,
  maxToolResultSize: 8000,
  confirmDestructive: true,
  theme: 'default',
  provider: 'local',        // active provider key
  providerKeys: {},          // { together: 'key...', groq: 'key...' }
  projectsDir: '',           // desktop app: where new projects & clones go ('' = ~/MantisProjects)
  adminTheme: 'mantis',      // admin panel colour theme id
  swarm: {
    default: true,            // when true, plain prompts run via swarm (set false for solo by default)
    leadProvider: null,       // null = auto-select, or 'groq', 'claude', etc.
    maxParallelWorkers: 4,    // cap parallel exploration workers
    excludeProviders: [],     // providers excluded from swarm pool
    bestOfN: 0,               // 0 = off, 2-3 = send code tasks to N providers, pick best
    providerModels: {},       // override default models per provider: { groq: 'llama-3.3-70b', local: 'qwen2.5-coder:14b' }
    minPoolSize: 2,           // if fewer than this many providers have keys, fall back to solo silently
  },
  // Delegation to external agentic CLIs (claude/codex/…). Per-agent overrides
  // live under their id (bin, enabled, disabled, extraArgs, env). See
  // src/external-agents.js.
  externalAgents: {
    inactivityTimeoutMs: 180000, // kill an external agent that emits no output for this long (0 = never)
    claude: {
      // Launch Claude Code with --dangerously-skip-permissions so it runs
      // autonomously (no terminal to approve tool use at in a session). Turn
      // this off (globally, or per chat) to broker each tool use through the
      // in-session Allow/Deny prompt instead.
      skipPermissions: true,
      // Tool names blessed via "Allow always" in the approval prompt — these are
      // auto-approved across all sessions. Grows as the user clicks.
      allowedTools: [],
    },
  },
  // Provider failover — when a provider keeps erroring (5xx/429/quota), rotate
  // to the next one in the chain instead of giving up. Cascades down the list
  // and wraps back to the top. A provider that just failed is skipped for
  // `cooldownMs` before it's eligible again, so we don't immediately re-hit a
  // dead one. `order: []` = auto chain (active provider first, then every other
  // provider that has a key / is local).
  failover: {
    enabled: true,
    order: [],                // e.g. ['groq','cerebras','nvidia','together'] — [] = auto
    cooldownMs: 60000,        // skip a provider this long after it fails terminally
  },
  // Anthropic-compatible proxy — lets real Claude Code / VS Code / JetBrains
  // route through Mantis's provider pool. See `mantis serve`.
  proxy: {
    port: 8787,
    host: '127.0.0.1',
    answerProbes: true,       // short-circuit trivial Claude Code probes locally
    // Claude model tier → { provider, model }. null = fall back to active provider.
    routes: {
      opus:    { provider: null, model: null },
      sonnet:  { provider: null, model: null },
      haiku:   { provider: null, model: null },
      default: { provider: null, model: null },
    },
  },
  // Remote coding via chat bots. See `mantis bot telegram` / `mantis bot discord`.
  bots: {
    telegram: { token: '', allowedUsers: [] },  // allowedUsers: numeric chat IDs ([] = allow all)
    discord:  { token: '', allowedUsers: [] },  // allowedUsers: user IDs ([] = allow all)
  },
  // Voice-note transcription for the chat bots. Uses an OpenAI-compatible
  // /audio/transcriptions endpoint (Groq or OpenAI). The provider's API key
  // comes from providerKeys; model '' = a sensible per-provider default.
  transcription: {
    enabled: true,
    provider: 'groq',
    model: '',
  },
  // Shell commands run after the agent writes or edits a file. The token
  // {file} is replaced with the changed file's path. Output is fed back to
  // the model. Empty by default — e.g. ["npx prettier --write {file}"].
  hooks: {
    afterEdit: [],
  },
  // MCP (Model Context Protocol) servers — their tools are added to the agent.
  // stdio: { command, args, env }   ·   http: { url, headers }
  mcpServers: {},
  // Chat-bot gateway. Idle bot conversations are evicted from memory after
  // hibernateIdleMs and rehydrated from disk on their next message — keeps a
  // long-running bot/server's footprint flat regardless of how many chats it
  // has seen. Set to 0 to disable hibernation (keep every session resident).
  gateway: {
    hibernateIdleMs: 1800000, // 30 minutes
    sweepIntervalMs: 300000,  // check every 5 minutes
  },
  // Media generation tools. Provider keys come from providerKeys.
  imageGen: { provider: 'openai', model: 'gpt-image-1' },
  speech: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' },
  // Local admin web UI. See `mantis admin`.
  admin: {
    port: 8788,
    host: '127.0.0.1',
  },
  // Sign-in — when auth.enabled is true the admin panel and desktop app
  // require a login (local username/password, and optionally Google) and
  // namespace data per account. Off by default → single-user, loopback-only.
  auth: {
    enabled: false,
    allowGoogleSignup: false,  // let any Google account sign in and self-provision
    googleDomains: [],         // email domains auto-provisioned on Google sign-in
  },
  // Google OAuth — optional. When clientId+clientSecret are set, "Sign in with
  // Google" is offered alongside local login (see auth.enabled above).
  google: {
    clientId: '',
    clientSecret: '',
  },
};

let config = { ...DEFAULTS };

export function loadConfig() {
  ensureDirs();
  migrateOldConfig();
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      config = { ...DEFAULTS, ...saved };
      // Deep-merge nested config objects so new default keys survive an old
      // config.json that predates them (shallow spread would drop them).
      for (const k of ['swarm', 'proxy', 'bots', 'transcription', 'hooks', 'imageGen', 'speech', 'admin', 'auth', 'google', 'localUrls', 'failover', 'externalAgents', 'gateway']) {
        config[k] = { ...DEFAULTS[k], ...(saved[k] || {}) };
      }
      config.proxy.routes = { ...DEFAULTS.proxy.routes, ...(saved.proxy?.routes || {}) };
      config.bots.telegram = { ...DEFAULTS.bots.telegram, ...(saved.bots?.telegram || {}) };
      config.bots.discord = { ...DEFAULTS.bots.discord, ...(saved.bots?.discord || {}) };
    } catch {
      // Corrupted config, use defaults
    }
  }
  // Auto-pick provider: if the active provider has no key (or is unset), fall
  // back to the first provider that DOES have a saved key. So a fresh deploy
  // with only an NVIDIA key set will launch on NVIDIA instead of dead-ending
  // on default 'local' (Ollama may not be installed). 'local' never needs a key.
  const active = PROVIDERS[config.provider];
  const activeKey = (config.providerKeys || {})[config.provider];
  const activeWorks = active && (!active.requiresKey || activeKey);
  if (!activeWorks) {
    const keyed = Object.entries(config.providerKeys || {})
      .find(([k, v]) => v && PROVIDERS[k]);
    if (keyed) config.provider = keyed[0];
  }
  return config;
}

export function saveConfig(updates) {
  config = { ...config, ...updates };
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function getConfig() {
  return config;
}

export function getConfigDir() {
  return CONFIG_DIR;
}

/**
 * Build request connection details for a provider — shared by the proxy,
 * bots, and admin UI. Returns { url, headers, model, provider } or null.
 * @param {string} providerKey - key into PROVIDERS
 * @param {string} [modelOverride] - explicit model; falls back to active/default
 */
export function buildConnection(providerKey, modelOverride, prefs) {
  const provider = PROVIDERS[providerKey];
  if (!provider) return null;

  // prefs (a per-user prefs object) override the global config when given.
  const keys = (prefs && prefs.providerKeys) || config.providerKeys || {};
  const ollamaUrl = (prefs && prefs.ollamaUrl) || config.ollamaUrl;
  const localUrls = (prefs && prefs.localUrls) || config.localUrls || {};

  const headers = { 'Content-Type': 'application/json' };
  let url;
  if (providerKey === 'local') {
    url = `${ollamaUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  } else {
    // Per-user override for local OpenAI-compat backends (LM Studio, llama.cpp).
    const baseOverride = (localUrls[providerKey] || '').trim();
    const base = baseOverride || provider.baseUrl;
    url = `${base.replace(/\/+$/, '')}/chat/completions`;
    if (keys[providerKey]) headers['Authorization'] = `Bearer ${keys[providerKey]}`;
  }

  const model = modelOverride
    || (providerKey === config.provider ? config.model : null)
    || provider.defaultModel;

  return { url, headers, model, provider, providerKey };
}

// ─── Provider failover ──────────────────────────────────────────────
// A provider that fails terminally is parked here with the timestamp until
// which it should be skipped. In-memory only — resets each process.
const _providerCooldowns = new Map();   // providerKey → epoch ms when eligible again

/** Mark a provider as failed; it'll be skipped until cooldownMs elapses. */
export function markProviderCooldown(providerKey, cooldownMs) {
  if (!providerKey) return;
  const ms = cooldownMs ?? config.failover?.cooldownMs ?? 60000;
  _providerCooldowns.set(providerKey, Date.now() + ms);
}

/** Is this provider currently in cooldown (recently failed)? */
export function isProviderInCooldown(providerKey) {
  const until = _providerCooldowns.get(providerKey);
  if (!until) return false;
  if (Date.now() >= until) { _providerCooldowns.delete(providerKey); return false; }
  return true;
}

/**
 * Ordered list of provider keys to try, best first. Explicit `failover.order`
 * wins (filtered to providers that are usable — local, or have a key). Otherwise
 * an auto chain: the active provider first, then every other usable provider.
 * Excludes the swarm-excluded set so we don't fail over onto a provider the
 * user deliberately benched.
 * @param {object} [prefs] per-user prefs (provider/providerKeys override config)
 * @returns {string[]} provider keys
 */
export function resolveProviderChain(prefs) {
  const keys = (prefs && prefs.providerKeys) || config.providerKeys || {};
  const active = (prefs && prefs.provider) || config.provider;
  const excluded = new Set(config.swarm?.excludeProviders || []);

  const usable = (k) => {
    const p = PROVIDERS[k];
    if (!p) return false;
    if (excluded.has(k)) return false;
    return !p.requiresKey || !!keys[k];   // local providers need no key
  };

  const explicit = (config.failover?.order || []).filter(usable);
  if (explicit.length) {
    // Explicit order is taken as-is (locals allowed — user opted in). Make sure
    // the active provider is tried even if the user left it out.
    return explicit.includes(active) ? explicit : [active, ...explicit].filter(usable);
  }

  // Auto: active first, then every OTHER provider that has an API key. Keyless
  // local providers (lmstudio/llamacpp/local) are skipped in auto mode unless
  // they're the active provider — we can't know they're running, and failing
  // over onto a dead localhost wastes a hop. List them in failover.order to
  // include them deliberately.
  const rest = Object.keys(PROVIDERS).filter(k =>
    k !== active && usable(k) && PROVIDERS[k].requiresKey && !!keys[k]);
  return [active, ...rest].filter(usable);
}

export function getConversationsDir() {
  ensureDirs();
  return CONVERSATIONS_DIR;
}

export function getMemoryDir() {
  ensureDirs();
  return MEMORY_DIR;
}

function ensureDirs() {
  for (const dir of [CONFIG_DIR, CONVERSATIONS_DIR, MEMORY_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Migrate from old ~/.qwen-local/ config dir to ~/.mantis/
 * Copies config, conversations, memory, and skills if old dir exists.
 */
function migrateOldConfig() {
  // An explicit data dir (service deployments) is opt-in and self-contained —
  // don't drag the legacy ~/.qwen-local into it.
  if (DATA_DIR_OVERRIDE) return;
  if (!fs.existsSync(OLD_CONFIG_DIR)) return;
  if (fs.existsSync(CONFIG_FILE)) return; // already migrated

  try {
    copyDirRecursive(OLD_CONFIG_DIR, CONFIG_DIR);
  } catch {
    // Migration failed — not critical, user keeps old config
  }
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
