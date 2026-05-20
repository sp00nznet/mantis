/**
 * Mantis Desktop — Electron main process.
 *
 * Reuses the existing Mantis engine (config, providers, the streaming LLM
 * client) and exposes it to the renderer over IPC. Phase 1: general chat with
 * persistent, resumable history. Projects (agent mode) and git integration
 * land in later phases.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, getConfig, saveConfig, PROVIDERS } from '../src/config.js';
import * as store from './store.js';
import { runChatTurn, listModels } from './chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
const running = new Map(); // sessionId -> { cancelled }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 940,
    minHeight: 560,
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

  session.messages.push({ role: 'user', content: text });
  // Auto-title from the first user message.
  if (session.messages.filter(m => m.role === 'user').length === 1) {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, 48);
    if (t) session.title = t;
  }
  store.save(session);

  const ctl = { cancelled: false };
  running.set(sessionId, ctl);

  let full = '';
  let errored = false;
  try {
    const assistant = await runChatTurn(session, {
      onText: (t) => { full += t; toRenderer('chat:token', { sessionId, text: t }); },
      onError: (err) => { errored = true; toRenderer('chat:error', { sessionId, error: err }); },
      onThinking: (b) => toRenderer('chat:thinking', { sessionId, thinking: b }),
    }, () => ctl.cancelled);
    if (assistant && assistant.content) full = assistant.content;
  } catch (err) {
    errored = true;
    toRenderer('chat:error', { sessionId, error: err.message });
  }

  running.delete(sessionId);

  if (full && !ctl.cancelled) {
    session.messages.push({ role: 'assistant', content: full });
  }
  store.save(session);

  toRenderer('chat:done', { sessionId, title: session.title, cancelled: ctl.cancelled, errored });
  return { ok: true, cancelled: ctl.cancelled };
});

ipcMain.handle('chat:stop', (_e, sessionId) => {
  const ctl = running.get(sessionId);
  if (ctl) ctl.cancelled = true;
  return { ok: true };
});
