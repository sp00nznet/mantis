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
