/**
 * Admin web UI.
 *
 * Manages provider keys, the active provider, proxy routing, bot tokens, and
 * the Sessions tab. Page markup lives in admin.html.
 *
 * Access control:
 *  - Sign-in OFF → loopback-only, single shared config (legacy behaviour).
 *  - Sign-in ON  → network-reachable, each request needs a session cookie;
 *    provider keys / model / theme / sessions are per-account. Admins also
 *    manage user accounts and server-global settings.
 *
 * Accounts are local username/password by default (see accounts.js); Google
 * sign-in is an optional add-on.
 *
 * Also mounted on the proxy server, so `mantis serve` exposes it at /admin.
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
import * as auth from './auth.js';
import * as users from './users.js';
import * as accounts from './accounts.js';

const ADMIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(ADMIN_DIR, 'admin.html');
const ASSETS_DIR = path.join(ADMIN_DIR, 'assets');

// ─── Access helpers ─────────────────────────────────────────────────

function isLoopback(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
}

/**
 * Whether the request may manage users and server-global settings. With
 * sign-in off, the loopback owner is implicitly the admin; with it on, the
 * signed-in account must have the admin role.
 */
function isAdmin(req) {
  if (!auth.isAuthEnabled()) return isLoopback(req);
  return !!(req._user && req._user.role === 'admin');
}

/** The active context's preferences — per-user when signed in, else global. */
function ctxPrefs(req) {
  if (req._user) return users.getUserPrefs(req._user.userId);
  const c = getConfig();
  return {
    provider: c.provider, model: c.model, providerKeys: c.providerKeys || {},
    theme: c.adminTheme || 'mantis', ollamaUrl: c.ollamaUrl,
  };
}

/** Save preference updates — to the user's prefs when signed in, else global. */
function ctxSavePrefs(req, updates) {
  if (req._user) { users.saveUserPrefs(req._user.userId, updates); return; }
  const map = {};
  if ('provider' in updates) map.provider = updates.provider;
  if ('model' in updates) map.model = updates.model;
  if ('providerKeys' in updates) map.providerKeys = updates.providerKeys;
  if ('theme' in updates) map.adminTheme = updates.theme;
  saveConfig(map);
}

// ─── State snapshot ─────────────────────────────────────────────────

function buildState(req) {
  const config = getConfig();
  const prefs = ctxPrefs(req);
  const keys = prefs.providerKeys || {};
  const providers = Object.entries(PROVIDERS).map(([key, p]) => ({
    key, name: p.name, requiresKey: p.requiresKey, hasKey: !!keys[key], defaultModel: p.defaultModel,
  }));
  return {
    authEnabled: auth.isAuthEnabled(),
    googleConfigured: auth.isGoogleConfigured(),
    // The loopback owner acts as an admin when sign-in is off.
    role: req._user ? req._user.role : 'admin',
    user: req._user
      ? { email: req._user.email, name: req._user.name, picture: req._user.picture, role: req._user.role }
      : null,
    authConfig: {
      allowGoogleSignup: !!config.auth?.allowGoogleSignup,
      googleDomains: config.auth?.googleDomains || [],
    },
    activeProvider: prefs.provider,
    activeModel: prefs.model,
    theme: prefs.theme || 'mantis',
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

// ─── Provider connection test / model listing (per-user keys) ───────

async function testProvider(providerKey, prefs) {
  const config = getConfig();
  const p = PROVIDERS[providerKey];
  if (!p) return { ok: false, message: `Unknown provider: ${providerKey}` };

  const base = providerKey === 'local'
    ? `${(prefs.ollamaUrl || config.ollamaUrl).replace(/\/+$/, '')}/v1`
    : p.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = (prefs.providerKeys || {})[providerKey];
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
        body: JSON.stringify({ model: p.defaultModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
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

async function listModels(providerKey, prefs) {
  const config = getConfig();
  const p = PROVIDERS[providerKey];
  if (!p) return { error: 'Unknown provider', models: [] };

  const base = providerKey === 'local'
    ? `${(prefs.ollamaUrl || config.ollamaUrl).replace(/\/+$/, '')}/v1`
    : p.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = (prefs.providerKeys || {})[providerKey];
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

// ─── Sign-in routes ─────────────────────────────────────────────────

function authErrorPage(res, message) {
  const msg = String(message).replace(/</g, '&lt;');
  res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;padding:40px">` +
    `<h2>Sign-in failed</h2><p>${msg}</p><p><a style="color:#58a6ff" href="/admin">Back</a></p></body>`);
}

async function handleAuth(req, res, url) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || '127.0.0.1';
  const redirectUri = `${proto}://${host}/auth/callback`;

  // Local username/password login (the login page POSTs JSON here).
  if (url === '/auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    const r = accounts.verifyLogin(body.username, body.password);
    if (r.error) return sendJson(res, 401, { error: r.error });
    const token = auth.createSession({
      userId: r.account.id, email: r.account.email,
      name: r.account.displayName, role: r.account.role,
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': auth.sessionCookie(token) });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Start the Google OAuth flow.
  if (url === '/auth/google') {
    if (!auth.isGoogleConfigured()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Google sign-in is not configured');
      return;
    }
    res.writeHead(302, { Location: auth.loginUrl(redirectUri) });
    res.end();
    return;
  }

  // Google OAuth redirect target.
  if (url === '/auth/callback') {
    const code = new URL(req.url, 'http://x').searchParams.get('code');
    if (!code) return authErrorPage(res, 'No authorization code was returned');
    const result = await auth.exchangeCode(code, redirectUri);
    if (result.error) return authErrorPage(res, result.error);
    const resolved = accounts.resolveGoogleAccount(result.user);
    if (resolved.error) return authErrorPage(res, resolved.error);
    const acct = resolved.account;
    const token = auth.createSession({
      userId: acct.id, email: acct.email, name: acct.displayName,
      picture: result.user.picture, role: acct.role,
    });
    res.writeHead(302, { 'Set-Cookie': auth.sessionCookie(token), Location: '/admin' });
    res.end();
    return;
  }

  if (url === '/auth/logout') {
    auth.destroySession(auth.readCookie(req, auth.COOKIE_NAME));
    res.writeHead(302, { 'Set-Cookie': auth.clearCookie(), Location: '/admin' });
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
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
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    session.unsubscribe(res);
  });
}

async function handleSessionApi(req, res, parts) {
  const id = parts[2];
  const action = parts[3];
  const uid = req._user ? req._user.userId : null;

  if (!id) {
    if (req.method === 'GET') return sendJson(res, 200, listSessions(uid));
    if (req.method === 'POST') {
      const body = await readJson(req);
      const session = createWebSession({
        name: (body.name || '').trim(),
        cwd: (body.cwd || '').trim(),
        userId: uid,
        prefs: req._user ? users.getUserPrefs(uid) : null,
      });
      return sendJson(res, 200, session.toJSON());
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const session = getSession(id);
  if (!session) return sendJson(res, 404, { error: 'No such session' });
  // When signed in, a user may only touch their own sessions.
  if (uid && session.userId && session.userId !== uid) {
    return sendJson(res, 403, { error: 'Not your session' });
  }

  if (action === 'stream' && req.method === 'GET') return streamSession(req, res, session);
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

// ─── User management API (admin only) ──────────────────────────────

async function handleUsersApi(req, res, parts) {
  if (!isAdmin(req)) return sendJson(res, 403, { error: 'Administrators only' });
  const id = parts[2];
  const action = parts[3];

  if (!id) {
    if (req.method === 'GET') return sendJson(res, 200, { users: accounts.listAccounts() });
    if (req.method === 'POST') {
      const body = await readJson(req);
      const r = accounts.createAccount({
        username: body.username, password: body.password, email: body.email,
        displayName: body.displayName, role: body.role === 'admin' ? 'admin' : 'user',
      });
      return sendJson(res, r.error ? 400 : 200, r);
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (action === 'password' && req.method === 'POST') {
    const body = await readJson(req);
    const r = accounts.setPassword(id, body.password);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  if (action === 'role' && req.method === 'POST') {
    const body = await readJson(req);
    const r = accounts.setRole(id, body.role);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  if (action === 'delete' && req.method === 'POST') {
    if (req._user && req._user.userId === id) {
      return sendJson(res, 400, { error: 'You cannot delete your own account' });
    }
    const r = accounts.deleteAccount(id);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  return sendJson(res, 404, { error: 'No such users route' });
}

// ─── Filesystem browser ─────────────────────────────────────────────

function listDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(d)) drives.push(d); } catch { /* ignore */ }
  }
  return drives;
}

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
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) { return sendJson(res, 400, { error: `Cannot open ${dir}: ${err.code || err.message}` }); }

  const dirs = entries
    .filter(e => { try { return e.isDirectory(); } catch { return false; } })
    .map(e => e.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .slice(0, 1000)
    .map(name => ({ name, path: path.join(dir, name) }));

  const root = path.parse(dir).root;
  const parent = dir === root ? (isWin ? '' : null) : path.dirname(dir);
  sendJson(res, 200, { path: dir, parent, isDrives: false, home: os.homedir(), dirs });
}

async function handleFsMkdir(req, res) {
  const body = await readJson(req);
  const base = body.path;
  const name = (body.name || '').trim();
  if (!base || !name) return sendJson(res, 400, { error: 'path and name are required' });
  if (/[\\/:*?"<>|]/.test(name)) return sendJson(res, 400, { error: 'Folder name has invalid characters' });
  const target = path.join(base, name);
  try {
    fs.mkdirSync(target);
    return sendJson(res, 200, { ok: true, path: target });
  } catch (err) {
    return sendJson(res, 400, { error: err.code === 'EEXIST' ? 'That folder already exists' : err.message });
  }
}

// ─── API router ─────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  const config = getConfig();
  const parts = url.split('/').filter(Boolean);

  if (parts[1] === 'sessions') return handleSessionApi(req, res, parts);
  if (parts[1] === 'users') return handleUsersApi(req, res, parts);

  // ── Sign-in setup ──

  if (url === '/api/auth/enable' && req.method === 'POST') {
    if (auth.isAuthEnabled()) return sendJson(res, 400, { error: 'Sign-in is already enabled' });
    if (!isLoopback(req)) return sendJson(res, 403, { error: 'Run this from the local machine' });
    const body = await readJson(req);
    const r = accounts.createAccount({
      username: body.username, password: body.password,
      displayName: body.displayName, role: 'admin',
    });
    if (r.error) return sendJson(res, 400, r);
    saveConfig({ auth: { ...config.auth, enabled: true } });
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/auth/disable' && req.method === 'POST') {
    if (!isAdmin(req)) return sendJson(res, 403, { error: 'Administrators only' });
    saveConfig({ auth: { ...config.auth, enabled: false } });
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/auth/google' && req.method === 'POST') {
    if (!isAdmin(req)) return sendJson(res, 403, { error: 'Administrators only' });
    const body = await readJson(req);
    const a = { ...config.auth };
    if (typeof body.allowGoogleSignup === 'boolean') a.allowGoogleSignup = body.allowGoogleSignup;
    if (Array.isArray(body.googleDomains)) {
      a.googleDomains = body.googleDomains.map(d => String(d).trim().toLowerCase()).filter(Boolean);
    }
    saveConfig({ auth: a });
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === 'fs') {
    if (parts[2] === 'list' && req.method === 'GET') {
      return handleFsList(res, new URL(req.url, 'http://x').searchParams.get('path'));
    }
    if (parts[2] === 'mkdir' && req.method === 'POST') return handleFsMkdir(req, res);
    return sendJson(res, 404, { error: 'No such fs route' });
  }

  if (url === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, buildState(req));
  }

  if (url === '/api/theme' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.id) ctxSavePrefs(req, { theme: String(body.id) });
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/provider/key' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.provider || !PROVIDERS[body.provider]) {
      return sendJson(res, 400, { error: 'Unknown provider' });
    }
    const keys = { ...(ctxPrefs(req).providerKeys || {}) };
    if (body.key) keys[body.provider] = body.key.trim();
    else delete keys[body.provider];
    ctxSavePrefs(req, { providerKeys: keys });
    return sendJson(res, 200, { ok: true });
  }

  if (url === '/api/provider/active' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.provider || !PROVIDERS[body.provider]) {
      return sendJson(res, 400, { error: 'Unknown provider' });
    }
    const model = (body.model || '').trim() || PROVIDERS[body.provider].defaultModel;
    ctxSavePrefs(req, { provider: body.provider, model });
    return sendJson(res, 200, { ok: true });
  }

  if (url.startsWith('/api/provider/models') && req.method === 'GET') {
    const provider = new URL(req.url, 'http://x').searchParams.get('provider');
    return sendJson(res, 200, await listModels(provider, ctxPrefs(req)));
  }

  if (url.startsWith('/api/provider/test') && req.method === 'GET') {
    const provider = new URL(req.url, 'http://x').searchParams.get('provider');
    return sendJson(res, 200, await testProvider(provider, ctxPrefs(req)));
  }

  // ── Server-global settings (admin only) ──

  if ((url === '/api/proxy' || url === '/api/bots' || url === '/api/settings') &&
      req.method === 'POST' && !isAdmin(req)) {
    return sendJson(res, 403, { error: 'Administrators only' });
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
    if (typeof body.ollamaUrl === 'string' && body.ollamaUrl.trim()) updates.ollamaUrl = body.ollamaUrl.trim();
    if (Number.isFinite(body.maxContextTokens)) updates.maxContextTokens = Math.max(1024, Math.round(body.maxContextTokens));
    if (Number.isFinite(body.compactThreshold)) updates.compactThreshold = Math.min(0.95, Math.max(0.1, body.compactThreshold));
    if (Number.isFinite(body.commandTimeout)) updates.commandTimeout = Math.max(1000, Math.round(body.commandTimeout));
    if (Number.isFinite(body.maxToolResultSize)) updates.maxToolResultSize = Math.max(1000, Math.round(body.maxToolResultSize));
    if (typeof body.confirmDestructive === 'boolean') updates.confirmDestructive = body.confirmDestructive;
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

  return sendJson(res, 404, { error: 'No such API route' });
}

// ─── Request entrypoint ─────────────────────────────────────────────

function serveStatic(res, url) {
  const name = url === '/favicon.ico' ? 'favicon.ico' : path.basename(url);
  const file = path.join(ASSETS_DIR, name);
  if (!file.startsWith(ASSETS_DIR)) { res.writeHead(403); res.end(); return; }
  let data;
  try { data = fs.readFileSync(file); }
  catch { res.writeHead(404); res.end('Not found\n'); return; }
  const ct = name.endsWith('.ico') ? 'image/x-icon'
    : name.endsWith('.png') ? 'image/png' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'max-age=86400' });
  res.end(data);
}

function servePage(res) {
  let html;
  try { html = fs.readFileSync(HTML_PATH, 'utf-8'); }
  catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('admin.html not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

export async function handleAdminRequest(req, res) {
  const url = (req.url || '/').split('?')[0];
  const authOn = auth.isAuthEnabled();

  try {
    // Auth + static assets are always reachable.
    if (authOn && url.startsWith('/auth/')) return await handleAuth(req, res, url);
    if (url === '/favicon.ico' || url.startsWith('/assets/')) return serveStatic(res, url);

    if (authOn) {
      // Network access allowed; require a valid session.
      const session = auth.getSession(auth.readCookie(req, auth.COOKIE_NAME));
      if (!session) {
        if (url.startsWith('/api/')) {
          return sendJson(res, 401, { error: 'auth-required', googleConfigured: auth.isGoogleConfigured() });
        }
        return servePage(res); // admin.html shows the sign-in screen on a 401
      }
      req._user = session;
    } else {
      // Sign-in not enabled — keep the loopback-only restriction.
      if (!isLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Admin UI is restricted to localhost. Enable sign-in to allow network access.\n');
        return;
      }
      req._user = null;
    }

    if (url.startsWith('/api/')) return await handleApi(req, res, url);
    if (url === '/admin' || url === '/admin/' || url === '/') return servePage(res);

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found\n');
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
}

/**
 * Start a standalone admin server.
 * @returns {Promise<import('http').Server>}
 */
export function startAdmin({ port, host } = {}) {
  const config = getConfig();
  const wantPort = port || config.admin?.port || 8788;
  // With sign-in on, bind to all interfaces so other devices can reach it.
  const listenHost = host || (auth.isAuthEnabled() ? '0.0.0.0' : (config.admin?.host || '127.0.0.1'));
  return new Promise((resolve, reject) => {
    let p = wantPort;
    const attempt = () => {
      const server = http.createServer((req, res) => {
        handleAdminRequest(req, res).catch(() => {
          try { res.writeHead(500); res.end(); } catch { /* ignore */ }
        });
      });
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && p < wantPort + 12) {
          p += 1;
          attempt();
        } else {
          reject(err);
        }
      });
      server.listen(p, listenHost, () => {
        if (p !== wantPort) console.log(`  [admin] port ${wantPort} was in use — using ${p}`);
        console.log(`  [admin] control panel at http://${listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost}:${p}/admin`);
        if (listenHost === '0.0.0.0') console.log('  [admin] reachable on your network — sign-in required');
        resolve(server);
      });
    };
    attempt();
  });
}
