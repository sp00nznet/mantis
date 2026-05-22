import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.mantis');
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
    leadProvider: null,       // null = auto-select, or 'groq', 'claude', etc.
    maxParallelWorkers: 4,    // cap parallel exploration workers
    excludeProviders: [],     // providers excluded from swarm pool
    bestOfN: 0,               // 0 = off, 2-3 = send code tasks to N providers, pick best
    providerModels: {},       // override default models per provider: { groq: 'llama-3.3-70b', local: 'qwen2.5-coder:14b' }
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
      for (const k of ['swarm', 'proxy', 'bots', 'transcription', 'hooks', 'imageGen', 'speech', 'admin', 'auth', 'google']) {
        config[k] = { ...DEFAULTS[k], ...(saved[k] || {}) };
      }
      config.proxy.routes = { ...DEFAULTS.proxy.routes, ...(saved.proxy?.routes || {}) };
      config.bots.telegram = { ...DEFAULTS.bots.telegram, ...(saved.bots?.telegram || {}) };
      config.bots.discord = { ...DEFAULTS.bots.discord, ...(saved.bots?.discord || {}) };
    } catch {
      // Corrupted config, use defaults
    }
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

  const headers = { 'Content-Type': 'application/json' };
  let url;
  if (providerKey === 'local') {
    url = `${ollamaUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  } else {
    url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    if (keys[providerKey]) headers['Authorization'] = `Bearer ${keys[providerKey]}`;
  }

  const model = modelOverride
    || (providerKey === config.provider ? config.model : null)
    || provider.defaultModel;

  return { url, headers, model, provider };
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
