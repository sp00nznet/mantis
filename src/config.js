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
    defaultModel: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    description: 'Cloud GPU inference — free tier available',
  },
  fireworks: {
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    requiresKey: true,
    defaultModel: 'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
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
    defaultModel: 'qwen/qwen-2.5-coder-32b-instruct',
    description: 'Routes to many providers — pay per token',
  },
  deepinfra: {
    name: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    requiresKey: true,
    defaultModel: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    description: 'Affordable cloud inference — free tier available',
  },
  chutes: {
    name: 'Chutes AI',
    baseUrl: 'https://llm.chutes.ai/v1',
    requiresKey: true,
    defaultModel: 'Qwen/Qwen2.5-Coder-32B-Instruct',
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
  swarm: {
    leadProvider: null,       // null = auto-select, or 'groq', 'claude', etc.
    maxParallelWorkers: 4,    // cap parallel exploration workers
    excludeProviders: [],     // providers excluded from swarm pool
    bestOfN: 0,               // 0 = off, 2-3 = send code tasks to N providers, pick best
    providerModels: {},       // override default models per provider: { groq: 'llama-3.3-70b', local: 'qwen2.5-coder:14b' }
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
