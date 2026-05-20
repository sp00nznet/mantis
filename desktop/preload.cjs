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

  // projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (id) => ipcRenderer.invoke('projects:get', id),
  createProject: (opts) => ipcRenderer.invoke('projects:create', opts),
  openProjectFolder: (dir) => ipcRenderer.invoke('projects:openExisting', dir),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),
  projectChildren: (dir) => ipcRenderer.invoke('projects:children', dir),
  readProjectFile: (file) => ipcRenderer.invoke('projects:readFile', file),
  browseDirs: (p) => ipcRenderer.invoke('projects:browse', p),
  workspaceRoot: () => ipcRenderer.invoke('projects:workspace'),

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
  onTool: (cb) => ipcRenderer.on('chat:tool', (_e, d) => cb(d)),
  onToolResult: (cb) => ipcRenderer.on('chat:toolresult', (_e, d) => cb(d)),
  onThinking: (cb) => ipcRenderer.on('chat:thinking', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('chat:error', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('chat:done', (_e, d) => cb(d)),
});
