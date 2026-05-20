/**
 * Preload bridge — the only channel between the sandboxed renderer and the
 * Mantis engine in the main process. Exposes a small, explicit `window.mantis`.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mantis', {
  // sessions / history
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (id) => ipcRenderer.invoke('sessions:get', id),
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', { id, title }),

  // config / providers
  getConfig: () => ipcRenderer.invoke('config:get'),
  setProvider: (provider, model) => ipcRenderer.invoke('config:setProvider', { provider, model }),
  setKey: (provider, key) => ipcRenderer.invoke('config:setKey', { provider, key }),
  listModels: (provider) => ipcRenderer.invoke('config:models', provider),

  // chat
  sendMessage: (sessionId, text) => ipcRenderer.invoke('chat:send', { sessionId, text }),
  stopMessage: (sessionId) => ipcRenderer.invoke('chat:stop', sessionId),

  // streaming events
  onToken: (cb) => ipcRenderer.on('chat:token', (_e, d) => cb(d)),
  onThinking: (cb) => ipcRenderer.on('chat:thinking', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('chat:error', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('chat:done', (_e, d) => cb(d)),
});
