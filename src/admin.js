/**
 * Admin web UI — a loopback-only control panel for Mantis.
 *
 * Manages provider keys, the active provider, proxy tier routing, and bot
 * tokens, and hosts the Sessions tab: live xterm.js terminals backed by the
 * session hub (see sessions.js). The page markup lives in admin.html.
 *
 * `handleAdminRequest` is also mounted on the proxy server, so `mantis serve`
 * exposes the panel at http://127.0.0.1:8787/admin.
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig, saveConfig, PROVIDERS } from './config.js';
import { getWorkingDirectory } from './tools.js';
import {
  listSessions, getSession, createWebSession, removeSession, sendInput, stopSession,
} from './sessions.js';

const HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin.html');

// ─── Loopback guard ─────────────────────────────────────────────────

function isLoopback(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
}

// ─── State snapshot ─────────────────────────────────────────────────

function buildState() {
  const config = getConfig();
  const keys = config.providerKeys || {};
  const providers = Object.entries(PROVIDERS).map(([key, p]) => ({
    key,
    name: p.name,
    requiresKey: p.requiresKey,
    hasKey: !!keys[key],
    defaultModel: p.defaultModel,
  }));
  return {
    activeProvider: config.provider,
    activeModel: config.model,
    cwd: getWorkingDirectory(),
    providers,
    proxy: {
      port: config.proxy?.port ?? 8787,
      host: config.proxy?.host ?? '127.0.0.1',
      answerProbes: config.proxy?.answerProbes !== false,
      routes: config.proxy?.routes || {},
    },
    bots: {
      telegram: { hasToken: !!config.bots?.telegram?.token },
      discord: { hasToken: !!config.bots?.discord?.token },
    },
    general: {
      ollamaUrl: config.ollamaUrl,
      maxContextTokens: config.maxContextTokens,
      compactThreshold: config.compactThreshold,
      commandTimeout: config.commandTimeout,
      maxToolResultSize: config.maxToolResultSize,
      confirmDestructive: config.confirmDestructive,
    },
    swarm: {
      maxParallelWorkers: config.swarm?.maxParallelWorkers ?? 4,
      bestOfN: config.swarm?.bestOfN ?? 0,
      leadProvider: config.swarm?.leadProvider ?? null,
      excludeProviders: config.swarm?.excludeProviders ?? [],
    },
    admin: {
      port: config.admin?.port ?? 8788,
      host: config.admin?.host ?? '127.0.0.1',
    },
  };
}

// ─── Provider connection test ───────────────────────────────────────

async function testProvider(providerKey) {
  const config = getConfig();
  const p = PROVIDERS[providerKey];
  if (!p) return { ok: false, message: `Unknown provider: ${providerKey}` };

  const base = providerKey === 'local'
    ? `${config.ollamaUrl.replace(/\/+$/, '')}/v1`
    : p.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = config.providerKeys?.[providerKey];
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    let response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const data = await response.json();
      return { ok: true, message: `Connected — ${data.data?.length || 0} models available` };
    }
    if (response.status === 404) {
      response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.swarm?.providerModels?.[providerKey] || p.defaultModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) return { ok: true, message: 'Connected — provider is responding' };
    }
    if (response.status === 401) return { ok: false, message: 'Unauthorized — check the API key' };
    return { ok: false, message: `Failed — HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, message: `Failed — ${err.message}` };
  }
}

/** Fetch the model catalogue a provider exposes via /models. */
async function listModels(providerKey) {
  const config = getConfig();
  const p = PROVIDERS[providerKey];
  if (!p) return { error: 'Unknown provider', models: [] };

  const base = providerKey === 'local'
    ? `${config.ollamaUrl.replace(/\/+$/, '')}/v1`
    : p.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = config.providerKeys?.[providerKey];
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(12000) });
    if (!r.ok) {
      return { error: r.status === 401 ? 'unauthorized — check the API key' : `HTTP ${r.status}`, models: [] };
    }
    const data = await r.json();
    const models = (Array.isArray(data.data) ? data.data : [])
      .map(m => (typeof m === 'string' ? m : m && m.id))
      .filter(Boolean)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return { models };
  } catch (err) {
    return { error: err.message, models: [] };
  }
}

// ─── HTTP helpers ───────────────────────────────────────────────────

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ─── Session API ────────────────────────────────────────────────────

function streamSession(req, res, session) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  session.subscribe(res);
  // Heartbeat so idle connections aren't dropped.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    session.unsubscribe(res);
  });
}

async function handleSessionApi(req, res, parts) {
  // parts = ['api','sessions', id?, action?]
  const id = parts[2];
  const action = parts[3];

  if (!id) {
    if (req.method === 'GET') return sendJson(res, 200, listSessions());
    if (req.method === 'POST') {
      const body = await readJson(req);
      const session = createWebSession({ name: (body.name || '').trim(), cwd: (body.cwd || '').trim() });
      return sendJson(res, 200, session.toJSON());
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const session = getSession(id);
  if (!session) return sendJson(res, 404, { error: 'No such session' });

  if (action === 'stream' && req.method === 'GET') {
    return streamSession(req, res, session);
  }
  if (action === 'input' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.text) return sendJson(res, 400, { error: 'text is required' });
    sendInput(id, String(body.text));
    return sendJson(res, 200, { ok: true });
  }
  if (action === 'stop' && req.method === 'POST') {
    stopSession(id);
    return sendJson(res, 200, { ok: true });
  }
  if (action === 'delete' && req.method === 'POST') {
    removeSession(id);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'No such session route' });
}

// ─── Filesystem browser (directory picker) ──────────────────────────

function listDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) { // A..Z
    const d = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(d)) drives.push(d); } catch { /* ignore */ }
  }
  return drives;
}

/**
 * List subdirectories of a path.
 * rawPath: null → default to the working dir · '' → Windows drive list / root.
 */
function handleFsList(res, rawPath) {
  const isWin = process.platform === 'win32';

  if (rawPath === '') {
    if (isWin) {
      return sendJson(res, 200, {
        path: '', isDrives: true, parent: null, home: os.homedir(),
        dirs: listDrives().map(d => ({ name: d, path: d })),
      });
    }
    rawPath = '/';
  }

  let dir;
  try { dir = path.resolve(rawPath || getWorkingDirectory()); }
  catch { dir = getWorkingDirectory(); }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return sendJson(res, 400, { error: `Cannot open ${dir}: ${err.code || err.message}` });
  }

  const dirs = entries
    .filter(e => { try { return e.isDirectory(); } catch { return false; } })
    .map(e => e.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .slice(0, 1000)
    .map(name => ({ name, path: path.join(dir, name) }));

  // '' as a parent means "go up to the Windows drive list".
  const root = path.parse(dir).root;
  const parent = dir === root ? (isWin ? '' : null) : path.dirname(dir);

  sendJson(res, 200, { path: dir, parent, isDrives: false, home: os.homedir(), dirs });
}

async function handleFsMkdir(req, res) {
  const body = await readJson(req);
  const base = body.path;
  const name = (body.name || '').trim();
  if (!base || !name) return sendJson(res, 400, { error: 'path and name are required' });
  if (/[\\/:*?"<>|]/.test(name)) {
    return sendJson(res, 400, { error: 'Folder name has invalid characters' });
  }
  const target = path.join(base, name);
  try {
    fs.mkdirSync(target);
    return sendJson(res, 200, { ok: true, path: target });
  } catch (err) {
    return sendJson(res, 400, {
      error: err.code === 'EEXIST' ? 'That folder already exists' : err.message,
    });
  }
}

// ─── Config API ─────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  const config = getConfig();
  const parts = url.split('/').filter(Boolean); // ['api', ...]

  if (parts[1] === 'sessions') {
    return handleSessionApi(req, res, parts);
  }

  if (parts[1] === 'fs') {
    if (parts[2] === 'list' && req.method === 'GET') {
      return handleFsList(res, new URL(req.url, 'http://x').searchParams.get('path'));
    }
    if (parts[2] === 'mkdir' && req.method === 'POST') {
      return handleFsMkdir(req, res);
    }
    return sendJson(res, 404, { error: 'No such fs route' });
  }

  if (url === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, buildState());
  }

  if (url === '/api/provider/key' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.provider || !PROVIDERS[body.provider]) {
      return sendJson(res, 400, { error: 'Unknown provider' });
    }
    const keys = { ...(config.providerKeys || {}) };
    if (body.key) keys[body.provider] = body.key.trim();
    else delete keys[body.provider];
    saveConfig({ providerKeys: keys });
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/provider/active' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.provider || !PROVIDERS[body.provider]) {
      return sendJson(res, 400, { error: 'Unknown provider' });
    }
    const model = (body.model || '').trim() || PROVIDERS[body.provider].defaultModel;
    saveConfig({ provider: body.provider, model });
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/proxy' && req.method === 'POST') {
    const body = await readJson(req);
    const proxy = { ...config.proxy };
    if (body.routes && typeof body.routes === 'object') {
      proxy.routes = { ...proxy.routes };
      for (const tier of ['opus', 'sonnet', 'haiku', 'default']) {
        if (body.routes[tier]) {
          proxy.routes[tier] = {
            provider: body.routes[tier].provider || null,
            model: body.routes[tier].model || null,
          };
        }
      }
    }
    if (typeof body.answerProbes === 'boolean') proxy.answerProbes = body.answerProbes;
    if (Number.isInteger(body.port)) proxy.port = body.port;
    if (typeof body.host === 'string' && body.host) proxy.host = body.host;
    saveConfig({ proxy });
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/bots' && req.method === 'POST') {
    const body = await readJson(req);
    const bots = {
      telegram: { ...config.bots.telegram },
      discord: { ...config.bots.discord },
    };
    if (typeof body.telegramToken === 'string') bots.telegram.token = body.telegramToken.trim();
    if (typeof body.discordToken === 'string') bots.discord.token = body.discordToken.trim();
    saveConfig({ bots });
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/settings' && req.method === 'POST') {
    const body = await readJson(req);
    const updates = {};
    if (typeof body.ollamaUrl === 'string' && body.ollamaUrl.trim()) {
      updates.ollamaUrl = body.ollamaUrl.trim();
    }
    if (Number.isFinite(body.maxContextTokens)) {
      updates.maxContextTokens = Math.max(1024, Math.round(body.maxContextTokens));
    }
    if (Number.isFinite(body.compactThreshold)) {
      updates.compactThreshold = Math.min(0.95, Math.max(0.1, body.compactThreshold));
    }
    if (Number.isFinite(body.commandTimeout)) {
      updates.commandTimeout = Math.max(1000, Math.round(body.commandTimeout));
    }
    if (Number.isFinite(body.maxToolResultSize)) {
      updates.maxToolResultSize = Math.max(1000, Math.round(body.maxToolResultSize));
    }
    if (typeof body.confirmDestructive === 'boolean') {
      updates.confirmDestructive = body.confirmDestructive;
    }
    if (body.swarm && typeof body.swarm === 'object') {
      const swarm = { ...config.swarm };
      if (Number.isFinite(body.swarm.maxParallelWorkers)) {
        swarm.maxParallelWorkers = Math.min(12, Math.max(1, Math.round(body.swarm.maxParallelWorkers)));
      }
      if (Number.isFinite(body.swarm.bestOfN)) {
        const n = Math.round(body.swarm.bestOfN);
        swarm.bestOfN = [0, 2, 3].includes(n) ? n : 0;
      }
      if ('leadProvider' in body.swarm) {
        swarm.leadProvider = body.swarm.leadProvider && PROVIDERS[body.swarm.leadProvider]
          ? body.swarm.leadProvider : null;
      }
      if (Array.isArray(body.swarm.excludeProviders)) {
        swarm.excludeProviders = body.swarm.excludeProviders.filter(k => PROVIDERS[k]);
      }
      updates.swarm = swarm;
    }
    saveConfig(updates);
    return sendJson(res, 200, { ok: true });
  }

  if (url.startsWith('/api/provider/models') && req.method === 'GET') {
    const provider = new URL(req.url, 'http://x').searchParams.get('provider');
    return sendJson(res, 200, await listModels(provider));
  }

  if (url.startsWith('/api/provider/test') && req.method === 'GET') {
    const provider = new URL(req.url, 'http://x').searchParams.get('provider');
    return sendJson(res, 200, await testProvider(provider));
  }

  return sendJson(res, 404, { error: 'No such API route' });
}

// ─── Request entrypoint ─────────────────────────────────────────────

export async function handleAdminRequest(req, res) {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Admin UI is restricted to localhost.\n');
    return;
  }

  const url = (req.url || '/').split('?')[0];

  try {
    if (url.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    if (url === '/admin' || url === '/admin/' || url === '/') {
      let html;
      try {
        html = fs.readFileSync(HTML_PATH, 'utf-8');
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('admin.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found\n');
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
}

/**
 * Start a standalone admin server (not behind the proxy).
 * @returns {Promise<import('http').Server>}
 */
export function startAdmin({ port, host } = {}) {
  const config = getConfig();
  const listenPort = port || config.admin?.port || 8788;
  const listenHost = host || config.admin?.host || '127.0.0.1';
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleAdminRequest(req, res).catch(() => {
        try { res.writeHead(500); res.end(); } catch { /* ignore */ }
      });
    });
    server.on('error', reject);
    server.listen(listenPort, listenHost, () => {
      console.log(`  [admin] control panel at http://${listenHost}:${listenPort}/admin`);
      resolve(server);
    });
  });
}
