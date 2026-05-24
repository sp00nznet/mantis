/**
 * Preload bridge — the only channel between the sandboxed renderer and the
 * Mantis engine in the main process. Exposes a small, explicit `window.mantis`.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mantis', {
  // sign-in
  authStatus: () => ipcRenderer.invoke('auth:status'),
  signInLocal: (username, password) => ipcRenderer.invoke('auth:signInLocal', { username, password }),
  signInGoogle: () => ipcRenderer.invoke('auth:signInGoogle'),
  signOut: () => ipcRenderer.invoke('auth:signOut'),

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

  // git
  gitConnections: () => ipcRenderer.invoke('git:connections'),
  gitAddConnection: (opts) => ipcRenderer.invoke('git:addConnection', opts),
  gitRemoveConnection: (id) => ipcRenderer.invoke('git:removeConnection', id),
  gitRepos: (connId) => ipcRenderer.invoke('git:repos', connId),
  gitCreateRepo: (opts) => ipcRenderer.invoke('git:createRepo', opts),
  gitClone: (connId, repo) => ipcRenderer.invoke('git:clone', { connId, repo }),
  gitStatus: (projectPath) => ipcRenderer.invoke('git:status', projectPath),
  gitCommit: (projectPath, message) => ipcRenderer.invoke('git:commit', { projectPath, message }),
  gitPush: (projectPath) => ipcRenderer.invoke('git:push', projectPath),
  gitPull: (projectPath) => ipcRenderer.invoke('git:pull', projectPath),

  // config / providers
  getConfig: () => ipcRenderer.invoke('config:get'),
  setProvider: (provider, model) => ipcRenderer.invoke('config:setProvider', { provider, model }),
  setKey: (provider, key) => ipcRenderer.invoke('config:setKey', { provider, key }),
  setProjectsDir: (dir) => ipcRenderer.invoke('config:setProjectsDir', dir),
  setTheme: (id) => ipcRenderer.invoke('config:setTheme', id),
  listModels: (provider) => ipcRenderer.invoke('config:models', provider),
  getLocalUrls: () => ipcRenderer.invoke('config:getLocalUrls'),
  setLocalUrl: (provider, url) => ipcRenderer.invoke('config:setLocalUrl', { provider, url }),
  setSwarmDefault: (on) => ipcRenderer.invoke('config:setSwarmDefault', on),
  swarmInfo: () => ipcRenderer.invoke('config:swarmInfo'),

  // external agents (claude/codex/aider/…)
  listExternalAgents: () => ipcRenderer.invoke('external:list'),
  refreshExternalAgents: () => ipcRenderer.invoke('external:refresh'),
  setExternalAgentEnabled: (agentId, enabled) => ipcRenderer.invoke('external:setEnabled', { agentId, enabled }),
  setSessionAgent: (sessionId, agentId) => ipcRenderer.invoke('sessions:setAgent', { sessionId, agentId }),

  // chat
  sendMessage: (sessionId, text, images) => ipcRenderer.invoke('chat:send', { sessionId, text, images }),
  stopMessage: (sessionId) => ipcRenderer.invoke('chat:stop', sessionId),
  pickAttachments: () => ipcRenderer.invoke('attach:pick'),

  // streaming events
  onToken: (cb) => ipcRenderer.on('chat:token', (_e, d) => cb(d)),
  onTool: (cb) => ipcRenderer.on('chat:tool', (_e, d) => cb(d)),
  onToolResult: (cb) => ipcRenderer.on('chat:toolresult', (_e, d) => cb(d)),
  onThinking: (cb) => ipcRenderer.on('chat:thinking', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('chat:error', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('chat:done', (_e, d) => cb(d)),
});
