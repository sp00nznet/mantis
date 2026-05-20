/**
 * Mantis Desktop — Electron main process.
 *
 * Reuses the existing Mantis engine and exposes it to the renderer over IPC.
 * Phase 1: general chat with persistent history.
 * Phase 2: projects — agent-mode sessions bound to a folder, with a file tree.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, getConfig, saveConfig, PROVIDERS } from '../src/config.js';
import * as store from './store.js';
import * as projects from './projects.js';
import { runChatTurn, runAgentTurn, listModels } from './chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
const running = new Map(); // sessionId -> { cancelled, agent }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 580,
    backgroundColor: '#0d1117',
    title: 'Mantis',
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

// ─── Config IPC ─────────────────────────────────────────────────────

ipcMain.handle('config:get', () => {
  const c = getConfig();
  return {
    provider: c.provider,
    model: c.model,
    providers: Object.entries(PROVIDERS).map(([key, p]) => ({
      key, name: p.name, requiresKey: p.requiresKey,
      hasKey: !!c.providerKeys?.[key], defaultModel: p.defaultModel,
    })),
  };
});

ipcMain.handle('config:setProvider', (_e, { provider, model }) => {
  if (!PROVIDERS[provider]) return { error: 'Unknown provider' };
  saveConfig({ provider, model: (model || '').trim() || PROVIDERS[provider].defaultModel });
  return { ok: true };
});

ipcMain.handle('config:setKey', (_e, { provider, key }) => {
  if (!PROVIDERS[provider]) return { error: 'Unknown provider' };
  const c = getConfig();
  const keys = { ...(c.providerKeys || {}) };
  if (key && key.trim()) keys[provider] = key.trim();
  else delete keys[provider];
  saveConfig({ providerKeys: keys });
  return { ok: true };
});

ipcMain.handle('config:models', (_e, provider) => listModels(provider));

// ─── Chat IPC ───────────────────────────────────────────────────────

ipcMain.handle('chat:send', async (_e, { sessionId, text }) => {
  const session = store.get(sessionId);
  if (!session) return { error: 'No such session' };

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
        await runAgentTurn(session, project, text, cb, ctl);
      }
    } else {
      session.messages.push({ role: 'user', content: text });
      let full = '';
      const assistant = await runChatTurn(session, {
        onText: (t) => { full += t; cb.onText(t); },
        onError: (e) => { errored = true; cb.onError(e); },
        onThinking: cb.onThinking,
      }, () => ctl.cancelled);
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
