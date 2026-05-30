/**
 * Mantis Desktop — Electron main process.
 *
 * Reuses the existing Mantis engine and exposes it to the renderer over IPC.
 * Phase 1: general chat with persistent history.
 * Phase 2: projects — agent-mode sessions bound to a folder, with a file tree.
 */

import { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } from 'electron';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, getConfig, saveConfig, getConfigDir, PROVIDERS } from '../src/config.js';
import * as auth from '../src/auth.js';
import * as users from '../src/users.js';
import * as accounts from '../src/accounts.js';
import * as store from './store.js';
import * as projects from './projects.js';
import * as git from './git.js';
import { runChatTurn, runAgentTurn, listModels } from './chat.js';
import { listExternalAgents, refreshAvailability, resolveAgentSpec } from '../src/external-agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Loopback port the desktop OAuth redirect comes back to. Register
// http://localhost:8790 as an authorized redirect URI in the Google client.
const OAUTH_PORT = 8790;
const DESKTOP_AUTH_FILE = path.join(getConfigDir(), 'desktop-auth.json');

let mainWindow = null;
let currentUser = null;            // signed-in Google user, or null
const running = new Map(); // sessionId -> { cancelled, agent }

// ─── Auth state ─────────────────────────────────────────────────────

/** Bind the process to a user (or none) so per-user data dirs resolve. */
function applyUser(user) {
  currentUser = user || null;
  users.setActiveUser(user ? user.userId : null);
}

/** The signed-in user's preferences, or null when running single-user. */
function currentPrefs() {
  return currentUser ? users.getUserPrefs(currentUser.userId) : null;
}

function readDesktopToken() {
  try { return JSON.parse(fs.readFileSync(DESKTOP_AUTH_FILE, 'utf-8')).token || ''; }
  catch { return ''; }
}
function writeDesktopToken(token) {
  try { fs.writeFileSync(DESKTOP_AUTH_FILE, JSON.stringify({ token }), 'utf-8'); }
  catch { /* ignore */ }
}
function clearDesktopToken() {
  try { fs.unlinkSync(DESKTOP_AUTH_FILE); } catch { /* ignore */ }
}

/**
 * Run the Google authorization-code flow: open the consent screen in a child
 * window and catch the redirect on a one-shot loopback server.
 * @returns {Promise<{user:object}|{error:string}>}
 */
function runOAuth() {
  return new Promise((resolve) => {
    let settled = false;
    let gotCode = false;
    let authWin = null;
    const redirectUri = `http://localhost:${OAUTH_PORT}`;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* ignore */ }
      resolve(v);
    };

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, redirectUri);
      const code = u.searchParams.get('code');
      const oerr = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;' +
        'text-align:center;padding:64px"><h2 style="color:#3fb950">Mantis</h2><p>' +
        (code ? 'Signed in — you can close this window and return to Mantis.'
              : 'Sign-in was cancelled.') + '</p></body>');
      gotCode = true;
      if (authWin && !authWin.isDestroyed()) authWin.close();
      if (oerr || !code) { finish({ error: oerr || 'No authorization code was returned' }); return; }
      finish(await auth.exchangeCode(code, redirectUri));
    });

    server.once('error', (e) => {
      finish({ error: e.code === 'EADDRINUSE'
        ? `Port ${OAUTH_PORT} is in use — close whatever is using it and try again`
        : 'Could not start the sign-in listener: ' + e.message });
    });

    server.listen(OAUTH_PORT, '127.0.0.1', () => {
      authWin = new BrowserWindow({
        width: 520, height: 660, title: 'Sign in with Google',
        autoHideMenuBar: true, parent: mainWindow || undefined, modal: !!mainWindow,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      authWin.on('closed', () => {
        if (!gotCode) finish({ error: 'The sign-in window was closed' });
      });
      authWin.loadURL(auth.loginUrl(redirectUri));
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 580,
    backgroundColor: '#0d1117',
    title: 'Mantis',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links in the OS browser, never navigate the app frame.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  loadConfig();
  git.setSafeStorage(safeStorage);

  // Restore a previous Google sign-in. When auth is not configured the app
  // runs single-user against the legacy ~/.mantis paths, exactly as before.
  if (auth.isAuthEnabled()) {
    const session = auth.getSession(readDesktopToken());
    if (session) applyUser(session);
  } else {
    applyUser(null);
  }

  projects.ensureWorkspace();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function toRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ─── Session IPC ────────────────────────────────────────────────────

ipcMain.handle('sessions:list', () => store.list());
ipcMain.handle('sessions:get', (_e, id) => store.get(id));
ipcMain.handle('sessions:create', (_e, opts) => store.createSession(opts || {}));
ipcMain.handle('sessions:delete', (_e, id) => store.remove(id));
ipcMain.handle('sessions:rename', (_e, { id, title }) => store.rename(id, title));

// ─── Project IPC ────────────────────────────────────────────────────

ipcMain.handle('projects:list', () => projects.list());
ipcMain.handle('projects:get', (_e, id) => projects.get(id));
ipcMain.handle('projects:create', (_e, opts) => projects.create(opts || {}));
ipcMain.handle('projects:openExisting', (_e, dir) => projects.openExisting(dir));
ipcMain.handle('projects:remove', (_e, id) => projects.remove(id));
ipcMain.handle('projects:children', (_e, dir) => projects.children(dir));
ipcMain.handle('projects:readFile', (_e, file) => projects.readFile(file));
ipcMain.handle('projects:browse', (_e, p) => projects.browse(p));
ipcMain.handle('projects:workspace', () => projects.workspaceRoot());

// ─── Git IPC ────────────────────────────────────────────────────────

ipcMain.handle('git:connections', () => git.listConnections());
ipcMain.handle('git:addConnection', (_e, opts) => git.addConnection(opts || {}));
ipcMain.handle('git:removeConnection', (_e, id) => git.removeConnection(id));
ipcMain.handle('git:repos', (_e, connId) => git.repos(connId));
ipcMain.handle('git:createRepo', (_e, { connId, ...opts }) => git.createRepo(connId, opts));
ipcMain.handle('git:clone', async (_e, { connId, repo }) => {
  const res = await git.clone(connId, repo);
  if (res.error) return res;
  const proj = projects.openExisting(res.path);
  return proj && proj.id ? proj : { error: 'Cloned, but failed to register as a project' };
});
ipcMain.handle('git:status', (_e, projectPath) => git.status(projectPath));
ipcMain.handle('git:commit', (_e, { projectPath, message }) => git.commit(projectPath, message));
ipcMain.handle('git:push', (_e, projectPath) => git.push(projectPath));
ipcMain.handle('git:pull', (_e, projectPath) => git.pull(projectPath));

// ─── Auth IPC ───────────────────────────────────────────────────────

ipcMain.handle('auth:status', () => ({
  authEnabled: auth.isAuthEnabled(),
  googleConfigured: auth.isGoogleConfigured(),
  user: currentUser ? { email: currentUser.email, name: currentUser.name } : null,
}));

ipcMain.handle('auth:signInLocal', (_e, { username, password }) => {
  if (!auth.isAuthEnabled()) return { error: 'Sign-in is not enabled' };
  const r = accounts.verifyLogin(username, password);
  if (r.error) return { error: r.error };
  const token = auth.createSession({
    userId: r.account.id, email: r.account.email,
    name: r.account.displayName, role: r.account.role,
  });
  writeDesktopToken(token);
  applyUser(auth.getSession(token));
  return { user: { email: r.account.email, name: r.account.displayName } };
});

ipcMain.handle('auth:signInGoogle', async () => {
  if (!auth.isAuthEnabled()) return { error: 'Sign-in is not enabled' };
  if (!auth.isGoogleConfigured()) return { error: 'Google sign-in is not configured' };
  const result = await runOAuth();
  if (result.error) return { error: result.error };
  const resolved = accounts.resolveGoogleAccount(result.user);
  if (resolved.error) return { error: resolved.error };
  const acct = resolved.account;
  const token = auth.createSession({
    userId: acct.id, email: acct.email, name: acct.displayName,
    picture: result.user.picture, role: acct.role,
  });
  writeDesktopToken(token);
  applyUser(auth.getSession(token));
  return { user: { email: acct.email, name: acct.displayName } };
});

ipcMain.handle('auth:signOut', () => {
  const token = readDesktopToken();
  if (token) auth.destroySession(token);
  clearDesktopToken();
  applyUser(null);
  return { ok: true };
});

// ─── Config IPC ─────────────────────────────────────────────────────

ipcMain.handle('config:get', () => {
  const c = getConfig();
  const prefs = currentPrefs();
  const keys = prefs ? (prefs.providerKeys || {}) : (c.providerKeys || {});
  return {
    provider: prefs ? prefs.provider : c.provider,
    model: prefs ? prefs.model : c.model,
    theme: prefs ? (prefs.theme || 'mantis') : (c.adminTheme || 'mantis'),
    projectsDir: projects.workspaceRoot(),
    authEnabled: auth.isAuthEnabled(),
    user: currentUser ? { email: currentUser.email, name: currentUser.name } : null,
    providers: Object.entries(PROVIDERS).map(([key, p]) => ({
      key, name: p.name, requiresKey: p.requiresKey,
      hasKey: !!keys[key], defaultModel: p.defaultModel,
    })),
  };
});

ipcMain.handle('config:setProjectsDir', (_e, dir) => {
  saveConfig({ projectsDir: (dir || '').trim() });
  projects.ensureWorkspace();
  return { ok: true };
});

ipcMain.handle('config:setTheme', (_e, id) => {
  const theme = String(id || 'mantis');
  if (currentUser) users.saveUserPrefs(currentUser.userId, { theme });
  else saveConfig({ adminTheme: theme });
  return { ok: true };
});

ipcMain.handle('config:setProvider', (_e, { provider, model }) => {
  if (!PROVIDERS[provider]) return { error: 'Unknown provider' };
  const m = (model || '').trim() || PROVIDERS[provider].defaultModel;
  if (currentUser) users.saveUserPrefs(currentUser.userId, { provider, model: m });
  else saveConfig({ provider, model: m });
  return { ok: true };
});

ipcMain.handle('config:setKey', (_e, { provider, key }) => {
  if (!PROVIDERS[provider]) return { error: 'Unknown provider' };
  if (currentUser) {
    const keys = { ...(users.getUserPrefs(currentUser.userId).providerKeys || {}) };
    if (key && key.trim()) keys[provider] = key.trim();
    else delete keys[provider];
    users.saveUserPrefs(currentUser.userId, { providerKeys: keys });
  } else {
    const keys = { ...(getConfig().providerKeys || {}) };
    if (key && key.trim()) keys[provider] = key.trim();
    else delete keys[provider];
    saveConfig({ providerKeys: keys });
  }
  return { ok: true };
});

ipcMain.handle('config:models', (_e, provider) => listModels(provider, currentPrefs()));

ipcMain.handle('config:setSwarmDefault', (_e, on) => {
  const c = getConfig();
  saveConfig({ swarm: { ...(c.swarm || {}), default: !!on } });
  return { ok: true };
});

// ─── External agents (claude/codex/aider/…) ─────────────────────────
ipcMain.handle('external:list', () => listExternalAgents());
ipcMain.handle('external:refresh', () => refreshAvailability());

// Toggle a high-risk agent's enabled flag (aider/gemini/qwen/cline default to
// disabled because of their auto-everything modes). Writes through to
// config.externalAgents.<id>.enabled and drops the availability cache so the
// next listExternalAgents() reflects the change.
ipcMain.handle('external:setEnabled', (_e, { agentId, enabled }) => {
  const c = getConfig();
  const ext = { ...(c.externalAgents || {}) };
  ext[agentId] = { ...(ext[agentId] || {}), enabled: !!enabled };
  saveConfig({ externalAgents: ext });
  refreshAvailability();
  return { ok: true };
});

ipcMain.handle('sessions:setAgent', (_e, { sessionId, agentId }) => {
  if (!agentId) return { error: 'agentId required' };
  if (agentId !== 'native' && !resolveAgentSpec(agentId)?.available) {
    return { error: `Agent "${agentId}" is not installed.` };
  }
  const s = store.get(sessionId);
  if (!s) return { error: 'unknown session' };
  s.agent = agentId;
  store.save(s);
  return { ok: true };
});

ipcMain.handle('config:swarmInfo', async () => {
  const { getSwarmPool } = await import('../src/swarm.js');
  const cfg = getConfig();
  const pool = getSwarmPool(currentPrefs());
  return {
    default: !!cfg.swarm?.default,
    minPoolSize: cfg.swarm?.minPoolSize ?? 2,
    pool: pool.map(p => p.key),
  };
});

// ─── Local backend URL overrides (Ollama / LM Studio / llama.cpp) ───
ipcMain.handle('config:getLocalUrls', () => {
  const c = getConfig();
  const prefs = currentPrefs();
  return {
    ollamaUrl: (prefs && prefs.ollamaUrl) || c.ollamaUrl || '',
    localUrls: { ...(c.localUrls || {}), ...((prefs && prefs.localUrls) || {}) },
  };
});

ipcMain.handle('config:setLocalUrl', (_e, { provider, url }) => {
  const u = (url || '').trim();
  if (provider === 'local') {
    if (currentUser) users.saveUserPrefs(currentUser.userId, { ollamaUrl: u || 'http://localhost:11434' });
    else saveConfig({ ollamaUrl: u || 'http://localhost:11434' });
    return { ok: true };
  }
  if (!PROVIDERS[provider]) return { error: 'Unknown provider' };
  if (currentUser) {
    const cur = { ...(users.getUserPrefs(currentUser.userId).localUrls || {}) };
    if (u) cur[provider] = u; else delete cur[provider];
    users.saveUserPrefs(currentUser.userId, { localUrls: cur });
  } else {
    const cur = { ...(getConfig().localUrls || {}) };
    if (u) cur[provider] = u; else delete cur[provider];
    saveConfig({ localUrls: cur });
  }
  return { ok: true };
});

// ─── Attachments IPC ────────────────────────────────────────────────

ipcMain.handle('attach:pick', async () => {
  if (!mainWindow) return { files: [] };
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach images or files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images & text files', extensions: [
        'png', 'jpg', 'jpeg', 'gif', 'webp',
        'txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'css', 'html', 'csv', 'log', 'yml', 'yaml',
      ] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled) return { files: [] };

  const imageMime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const files = [];
  for (const fp of res.filePaths) {
    const name = path.basename(fp);
    try {
      if (fs.statSync(fp).size > 8 * 1024 * 1024) {
        files.push({ name, error: 'too large (8 MB max)' });
        continue;
      }
      const ext = path.extname(fp).toLowerCase().slice(1);
      if (imageMime[ext]) {
        const b64 = fs.readFileSync(fp).toString('base64');
        files.push({ name, kind: 'image', dataUrl: `data:${imageMime[ext]};base64,${b64}` });
      } else {
        files.push({ name, kind: 'text', content: fs.readFileSync(fp, 'utf-8') });
      }
    } catch (err) {
      files.push({ name, error: err.message });
    }
  }
  return { files };
});

// ─── Chat IPC ───────────────────────────────────────────────────────

ipcMain.handle('chat:send', async (_e, { sessionId, text, images }) => {
  if (auth.isAuthEnabled() && !currentUser) return { error: 'Please sign in first' };
  const session = store.get(sessionId);
  if (!session) return { error: 'No such session' };

  const prefs = currentPrefs();
  const imgs = Array.isArray(images) && images.length ? images : null;
  const isFirstUserMsg = !session.messages.some(m => m.role === 'user');
  const ctl = { cancelled: false, agent: null };
  running.set(sessionId, ctl);

  const cb = {
    onText: (t) => toRenderer('chat:token', { sessionId, text: t }),
    onToolCall: (name, args) => toRenderer('chat:tool', { sessionId, name, args }),
    onToolResult: (name, result) =>
      toRenderer('chat:toolresult', { sessionId, name, result: String(result).slice(0, 700) }),
    onError: (err) => toRenderer('chat:error', { sessionId, error: err }),
    onThinking: (b) => toRenderer('chat:thinking', { sessionId, thinking: b }),
  };

  let errored = false;
  try {
    if (session.mode === 'agent') {
      const project = session.projectId ? projects.get(session.projectId) : null;
      if (!project) {
        errored = true;
        cb.onError('The project for this session no longer exists.');
      } else {
        await runAgentTurn(session, project, text, cb, ctl, prefs, imgs);
      }
    } else {
      // With images, the user turn becomes multi-part content (vision format).
      let userContent = text;
      if (imgs) {
        userContent = [
          { type: 'text', text: text || '(see the attached image)' },
          ...imgs.map(url => ({ type: 'image_url', image_url: { url } })),
        ];
      }
      session.messages.push({ role: 'user', content: userContent });
      let full = '';
      const assistant = await runChatTurn(session, {
        onText: (t) => { full += t; cb.onText(t); },
        onError: (e) => { errored = true; cb.onError(e); },
        onThinking: cb.onThinking,
      }, () => ctl.cancelled, prefs);
      if (assistant && assistant.content) full = assistant.content;
      if (full && !ctl.cancelled) session.messages.push({ role: 'assistant', content: full });
    }
  } catch (err) {
    errored = true;
    cb.onError(err.message);
  }

  running.delete(sessionId);

  if (isFirstUserMsg) {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, 48);
    if (t) session.title = t;
  }
  store.save(session);

  toRenderer('chat:done', { sessionId, title: session.title, cancelled: ctl.cancelled, errored });
  return { ok: true, cancelled: ctl.cancelled };
});

ipcMain.handle('chat:stop', (_e, sessionId) => {
  const ctl = running.get(sessionId);
  if (ctl) {
    ctl.cancelled = true;
    if (ctl.agent) ctl.agent.cancel();
  }
  return { ok: true };
});
