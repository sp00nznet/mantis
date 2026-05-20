'use strict';

// Mantis Desktop — renderer.
// Phase 1: chat + history.  Phase 2: projects + agent-mode sessions + files.
// All engine access goes through window.mantis (see preload.cjs).

const $ = (id) => document.getElementById(id);
const M = window.mantis;

let SECTION = 'chats';            // chats | projects | git | settings
let SESSIONS = [];
let PROJECTS = [];
let CURRENT = null;               // open session id
let CURRENT_SESSION = null;       // open session object
let CURRENT_PROJECT = null;       // open project id (projects section)
let CONFIG = null;
let sending = false;
let streamEl = null;              // assistant bubble being streamed into
let streamBuf = '';
let thinkingEl = null;
let pickCb = null;                // folder-picker callback
let pickCur = null;               // folder-picker current path
let GIT_CONNS = [];               // git service connections
let CURRENT_CONN = null;          // selected connection id (git section)

// ─── toast ──────────────────────────────────────────────────────────
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);
function toast(msg, err) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (err ? ' err' : '');
  setTimeout(() => { toastEl.className = ''; }, 2600);
}

// ─── markdown-lite ──────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderMarkdown(text) {
  const blocks = [];
  let s = String(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push('<pre class="code"><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
    return '@@CB' + (blocks.length - 1) + '@@';
  });
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, (_m, c) => '<code>' + c + '</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/^(#{1,3})\s+(.+)$/gm, (_m, _h, t) => '<div class="md-h">' + t + '</div>');
  s = s.replace(/\n/g, '<br>');
  s = s.replace(/@@CB(\d+)@@/g, (_m, i) => blocks[+i]);
  return s;
}
function fmtArgs(args) {
  return Object.entries(args || {})
    .map(([k, v]) => {
      let val = typeof v === 'string' ? v : JSON.stringify(v);
      if (val && val.length > 50) val = val.slice(0, 50) + '…';
      return k + '=' + val;
    })
    .join('  ');
}
function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}

// ─── views ──────────────────────────────────────────────────────────
function show(view) {
  ['chatView', 'filesView', 'reposView', 'gitView', 'settingsView', 'placeholderView'].forEach(v => {
    $(v).classList.toggle('hidden', v !== view);
  });
}
function placeholder(emoji, title, body) {
  $('placeholderBody').innerHTML =
    '<div class="big">' + emoji + '</div><h2>' + title + '</h2><p>' + body + '</p>';
  show('placeholderView');
}
function showWelcome() {
  placeholder('🦗', 'Start a conversation',
    'Click <b>+ New</b> to begin a chat, or pick one from your history.');
}
function showPickProject() {
  placeholder('📁', 'Projects',
    'Open a project to run agent sessions with full tools. Click <b>+ New</b> to create or open one.');
}
function showProjectWelcome() {
  const p = PROJECTS.find(x => x.id === CURRENT_PROJECT);
  placeholder('📁', p ? p.name : 'Project',
    'Click <b>+ Chat</b> to start an agent session in this project.');
}

// ─── rail ───────────────────────────────────────────────────────────
document.querySelectorAll('.rail-btn').forEach(b => {
  b.onclick = () => selectSection(b.dataset.section);
});
function selectSection(name) {
  SECTION = name;
  document.querySelectorAll('.rail-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.section === name);
  });
  if (name === 'chats') {
    $('list').classList.remove('hidden');
    renderList();
    if (CURRENT_SESSION && CURRENT_SESSION.mode !== 'agent') openSession(CURRENT);
    else showWelcome();
  } else if (name === 'projects') {
    $('list').classList.remove('hidden');
    renderList();
    if (CURRENT_PROJECT) {
      if (CURRENT_SESSION && CURRENT_SESSION.projectId === CURRENT_PROJECT) openSession(CURRENT);
      else showProjectWelcome();
    } else {
      showPickProject();
    }
  } else if (name === 'settings') {
    $('list').classList.add('hidden');
    show('settingsView');
    renderSettings();
  } else {
    $('list').classList.remove('hidden');
    renderList();
    if (CURRENT_CONN) openConn(CURRENT_CONN);
    else placeholder('⎇', 'Git',
      'Connect a git service to browse and clone your repositories. Click <b>+ Add</b>.');
  }
}

// ─── list (chats / projects) ────────────────────────────────────────
function renderList() {
  const body = $('listBody');
  const title = $('listTitle');
  body.innerHTML = '';

  if (SECTION === 'chats') {
    title.textContent = 'Chats';
    title.style.cursor = 'default';
    $('newBtn').textContent = '+ New';
    const chats = SESSIONS.filter(s => s.mode !== 'agent');
    renderSessionItems(body, chats, 'No conversations yet.');
  } else if (SECTION === 'projects' && CURRENT_PROJECT) {
    const p = PROJECTS.find(x => x.id === CURRENT_PROJECT);
    title.textContent = '‹ ' + (p ? p.name : 'Projects');
    title.style.cursor = 'pointer';
    $('newBtn').textContent = '+ Chat';
    const agents = SESSIONS.filter(s => s.mode === 'agent' && s.projectId === CURRENT_PROJECT);
    renderSessionItems(body, agents, 'No agent chats yet — click + Chat.');
  } else if (SECTION === 'projects') {
    title.textContent = 'Projects';
    title.style.cursor = 'default';
    $('newBtn').textContent = '+ New';
    renderProjectItems(body);
  } else if (SECTION === 'git') {
    title.textContent = 'Connections';
    title.style.cursor = 'default';
    $('newBtn').textContent = '+ Add';
    renderConnItems(body);
  }
}
function renderConnItems(body) {
  if (!GIT_CONNS.length) {
    body.innerHTML = '<div class="list-empty">No services connected — click + Add.</div>';
    return;
  }
  GIT_CONNS.forEach(c => {
    const el = document.createElement('div');
    el.className = 'sess' + (c.id === CURRENT_CONN ? ' sel' : '');
    el.innerHTML =
      '<span class="x" title="disconnect">✕</span>' +
      '<div class="t">' + escapeHtml(c.name) + '</div>' +
      '<div class="p">' + escapeHtml(c.service) + '</div>';
    el.onclick = (ev) => {
      if (ev.target.classList.contains('x')) { removeConn(c.id); return; }
      openConn(c.id);
    };
    body.appendChild(el);
  });
}
function renderSessionItems(body, items, emptyMsg) {
  if (!items.length) {
    body.innerHTML = '<div class="list-empty">' + emptyMsg + '</div>';
    return;
  }
  items.forEach(s => {
    const el = document.createElement('div');
    el.className = 'sess' + (s.id === CURRENT ? ' sel' : '');
    el.innerHTML =
      '<span class="x" title="delete">✕</span>' +
      '<div class="t">' + escapeHtml(s.title) + '</div>' +
      '<div class="m">' + s.messageCount + ' msg · ' + timeAgo(s.updatedAt) + '</div>';
    el.onclick = (ev) => {
      if (ev.target.classList.contains('x')) { delSession(s.id); return; }
      openSession(s.id);
    };
    body.appendChild(el);
  });
}
function renderProjectItems(body) {
  if (!PROJECTS.length) {
    body.innerHTML = '<div class="list-empty">No projects yet — click + New.</div>';
    return;
  }
  PROJECTS.forEach(p => {
    const el = document.createElement('div');
    el.className = 'sess';
    el.innerHTML =
      '<span class="x" title="remove from list">✕</span>' +
      '<div class="t">' + escapeHtml(p.name) + '</div>' +
      '<div class="p">' + escapeHtml(p.path) + '</div>';
    el.onclick = (ev) => {
      if (ev.target.classList.contains('x')) { removeProject(p.id); return; }
      openProject(p.id);
    };
    body.appendChild(el);
  });
}

// ─── sessions ───────────────────────────────────────────────────────
async function loadSessions() {
  SESSIONS = await M.listSessions();
  renderList();
}
async function loadProjects() {
  PROJECTS = await M.listProjects();
}
async function newChat() {
  const s = await M.createSession({ mode: 'chat' });
  await loadSessions();
  await openSession(s.id);
  $('composerInput').focus();
}
async function newAgentChat() {
  if (!CURRENT_PROJECT) return;
  const s = await M.createSession({ mode: 'agent', projectId: CURRENT_PROJECT });
  await loadSessions();
  await openSession(s.id);
  $('composerInput').focus();
}
async function delSession(id) {
  if (!confirm('Delete this conversation?')) return;
  await M.deleteSession(id);
  if (CURRENT === id) { CURRENT = null; CURRENT_SESSION = null; }
  await loadSessions();
  if (!CURRENT) (SECTION === 'projects' ? showProjectWelcome() : showWelcome());
}
async function openSession(id) {
  const s = await M.getSession(id);
  if (!s) { CURRENT = null; CURRENT_SESSION = null; showWelcome(); return; }
  CURRENT = id;
  CURRENT_SESSION = s;
  streamEl = null;
  streamBuf = '';
  removeThinking();
  setSending(false);
  renderList();
  $('chatTitle').textContent = s.title;
  $('chatProvider').textContent = providerLabel();
  $('chatFilesBtn').classList.toggle('hidden', s.mode !== 'agent');
  $('chatGitBtn').classList.toggle('hidden', s.mode !== 'agent');
  renderMessages(s.messages || []);
  show('chatView');
  scrollDown();
}
function renderMessages(messages) {
  const box = $('messages');
  box.innerHTML = '';
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      addMessage('user', m.content || '');
    } else if (m.role === 'assistant') {
      if (m.content) addMessage('assistant', m.content);
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
          addToolCall(tc.function.name, args);
        }
      }
    } else if (m.role === 'tool') {
      addToolResult(m.content || '');
    }
  }
}

// ─── projects ───────────────────────────────────────────────────────
async function openProject(id) {
  CURRENT_PROJECT = id;
  CURRENT = null;
  CURRENT_SESSION = null;
  renderList();
  showProjectWelcome();
}
async function removeProject(id) {
  if (!confirm('Remove this project from the list? (the folder is not deleted)')) return;
  await M.removeProject(id);
  if (CURRENT_PROJECT === id) { CURRENT_PROJECT = null; CURRENT = null; CURRENT_SESSION = null; }
  await loadProjects();
  renderList();
  if (!CURRENT_PROJECT) showPickProject();
}

// ─── chat view ──────────────────────────────────────────────────────
function addMessage(role, content) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'assistant') bubble.innerHTML = content ? renderMarkdown(content) : '';
  else bubble.textContent = content;
  wrap.appendChild(bubble);
  $('messages').appendChild(wrap);
  return bubble;
}
function addToolCall(name, args) {
  const el = document.createElement('div');
  el.className = 'toolcall';
  el.textContent = '⚙ ' + name + (Object.keys(args || {}).length ? '  ' + fmtArgs(args) : '');
  $('messages').appendChild(el);
  return el;
}
function addToolResult(result) {
  const el = document.createElement('div');
  el.className = 'toolresult';
  let txt = String(result).split('\n').slice(0, 6).join('\n');
  if (txt.length > 500) txt = txt.slice(0, 500) + '…';
  el.textContent = txt;
  $('messages').appendChild(el);
  return el;
}
function showThinking() {
  if (thinkingEl) return;
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking';
  thinkingEl.textContent = 'Mantis is working…';
  $('messages').appendChild(thinkingEl);
  scrollDown();
}
function removeThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}
function scrollDown() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}
function providerLabel() {
  if (!CONFIG) return '—';
  const p = CONFIG.providers.find(x => x.key === CONFIG.provider);
  return (p ? p.name : CONFIG.provider) + ' · ' + (CONFIG.model || '');
}
function setSending(on) {
  sending = on;
  const b = $('sendBtn');
  b.textContent = on ? 'Stop' : 'Send';
  b.classList.toggle('stop', on);
}
async function send() {
  const inp = $('composerInput');
  const text = inp.value.trim();
  if (sending || !text) return;

  if (!CURRENT) {
    const s = await M.createSession({ mode: 'chat' });
    CURRENT = s.id;
    CURRENT_SESSION = s;
    $('chatTitle').textContent = s.title;
    $('chatFilesBtn').classList.add('hidden');
    $('messages').innerHTML = '';
    show('chatView');
  }
  inp.value = '';
  autoGrow();
  addMessage('user', text);
  streamEl = null;
  streamBuf = '';
  showThinking();
  setSending(true);

  try {
    await M.sendMessage(CURRENT, text);
  } catch (e) {
    removeThinking();
    toast('Send failed: ' + e.message, true);
    setSending(false);
  }
}
function stop() {
  if (CURRENT) M.stopMessage(CURRENT);
}

// streaming events
function onToken(d) {
  if (d.sessionId !== CURRENT) return;
  removeThinking();
  if (!streamEl) { streamEl = addMessage('assistant', ''); streamBuf = ''; }
  streamBuf += d.text;
  streamEl.innerHTML = renderMarkdown(streamBuf);
  scrollDown();
}
function onTool(d) {
  if (d.sessionId !== CURRENT) return;
  removeThinking();
  streamEl = null;
  streamBuf = '';
  addToolCall(d.name, d.args);
  scrollDown();
}
function onToolResult(d) {
  if (d.sessionId !== CURRENT) return;
  addToolResult(d.result);
  showThinking();
  scrollDown();
}
function onError(d) {
  if (d.sessionId !== CURRENT) return;
  removeThinking();
  if (streamEl && !streamBuf) {
    streamEl.classList.add('err');
    streamEl.textContent = '⚠ ' + d.error;
  } else {
    toast(d.error, true);
  }
}
function onDone(d) {
  if (d.sessionId === CURRENT) {
    removeThinking();
    if (d.title) $('chatTitle').textContent = d.title;
    streamEl = null;
    streamBuf = '';
    setSending(false);
  }
  loadSessions();
}

// ─── files view ─────────────────────────────────────────────────────
function currentProject() {
  const pid = (CURRENT_SESSION && CURRENT_SESSION.projectId) || CURRENT_PROJECT;
  return PROJECTS.find(p => p.id === pid) || null;
}
async function openFiles() {
  const proj = currentProject();
  if (!proj) { toast('No project for this session', true); return; }
  $('filesTitle').textContent = proj.name + '  ·  ' + proj.path;
  $('fileView').innerHTML = '<div class="placeholder"><p>Select a file to preview it.</p></div>';
  const tree = $('fileTree');
  tree.innerHTML = '';
  await renderDir(proj.path, tree, 0);
  show('filesView');
}
async function renderDir(dir, container, depth) {
  const res = await M.projectChildren(dir);
  if (res.error) {
    container.innerHTML = '<div class="file-row skip">' + escapeHtml(res.error) + '</div>';
    return;
  }
  if (!res.items.length && depth === 0) {
    container.innerHTML = '<div class="file-row skip">(empty folder)</div>';
    return;
  }
  res.items.forEach(it => {
    const row = document.createElement('div');
    row.className = 'file-row' + (it.skip ? ' skip' : '');
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    row.innerHTML = '<span class="ic">' + (it.dir ? '▸' : '·') + '</span>' +
      '<span>' + escapeHtml(it.name) + '</span>';
    container.appendChild(row);
    if (it.skip) return;
    if (it.dir) {
      const kids = document.createElement('div');
      kids.className = 'file-children hidden';
      container.appendChild(kids);
      let loaded = false;
      row.onclick = async () => {
        const ic = row.querySelector('.ic');
        if (kids.classList.contains('hidden')) {
          if (!loaded) { await renderDir(it.path, kids, depth + 1); loaded = true; }
          kids.classList.remove('hidden');
          ic.textContent = '▾';
        } else {
          kids.classList.add('hidden');
          ic.textContent = '▸';
        }
      };
    } else {
      row.onclick = () => openFile(it.path, row);
    }
  });
}
async function openFile(file, row) {
  document.querySelectorAll('.file-row.sel').forEach(r => r.classList.remove('sel'));
  if (row) row.classList.add('sel');
  const res = await M.readProjectFile(file);
  const fv = $('fileView');
  if (res.error) {
    fv.innerHTML = '<div class="placeholder"><p>' + escapeHtml(res.error) + '</p></div>';
    return;
  }
  fv.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'fv-head';
  head.textContent = file;
  const pre = document.createElement('pre');
  pre.textContent = res.content;
  fv.appendChild(head);
  fv.appendChild(pre);
}

// ─── settings ───────────────────────────────────────────────────────
async function renderSettings() {
  CONFIG = await M.getConfig();
  const ps = $('setProvider');
  ps.innerHTML = CONFIG.providers
    .map(p => '<option value="' + p.key + '"' + (p.key === CONFIG.provider ? ' selected' : '') +
      '>' + escapeHtml(p.name) + '</option>')
    .join('');
  ps.onchange = () => { fillModels(ps.value, ''); updateKeyLabel(); };
  updateKeyLabel();
  await fillModels(CONFIG.provider, CONFIG.model);
}
function updateKeyLabel() {
  const p = CONFIG.providers.find(x => x.key === $('setProvider').value);
  $('keyLabel').textContent = 'API key for ' + (p ? p.name : '');
  $('setKey').placeholder = p && p.hasKey ? 'set — type to replace' : 'paste API key';
  $('setKey').value = '';
}
async function fillModels(pk, current) {
  const sel = $('setModel');
  sel.innerHTML = '<option>loading…</option>';
  sel.disabled = true;
  const d = await M.listModels(pk);
  const models = (d.models || []).slice();
  if (current && models.indexOf(current) === -1) models.unshift(current);
  sel.innerHTML = models
    .map(m => '<option' + (m === current ? ' selected' : '') + '>' + escapeHtml(m) + '</option>')
    .join('') + '<option value="__custom__">✎ Custom…</option>';
  sel.disabled = false;
  if (d.error) toast(pk + ' models: ' + d.error, true);
}

// ─── folder picker ──────────────────────────────────────────────────
function openPicker(title, startPath, cb) {
  pickCb = cb;
  $('pickTitle').textContent = title;
  $('pickModal').classList.remove('hidden');
  pickNav(startPath);
}
function closePicker() { $('pickModal').classList.add('hidden'); pickCb = null; }
async function pickNav(p) {
  const res = await M.browseDirs(p === null ? undefined : p);
  if (res.error) { toast(res.error, true); if (p !== null) pickNav(null); return; }
  pickCur = res.isDrives ? '' : res.path;
  $('pickPath').textContent = res.isDrives ? 'This PC — choose a drive' : res.path;
  const list = $('pickList');
  list.innerHTML = '';
  if (res.parent !== null && res.parent !== undefined) {
    const up = document.createElement('div');
    up.className = 'pick-row';
    up.textContent = '⬆  ..';
    up.onclick = () => pickNav(res.parent);
    list.appendChild(up);
  }
  (res.dirs || []).forEach(it => {
    const row = document.createElement('div');
    row.className = 'pick-row';
    row.textContent = (res.isDrives ? '💽  ' : '📁  ') + it.name;
    row.onclick = () => pickNav(it.path);
    list.appendChild(row);
  });
  if (!(res.dirs || []).length) {
    list.innerHTML += '<div class="list-empty">(no subfolders)</div>';
  }
}

// ─── new-project modal ──────────────────────────────────────────────
async function openProjectModal() {
  $('projName').value = '';
  $('projLoc').value = '';
  $('projGit').checked = true;
  const ws = await M.workspaceRoot();
  $('projLoc').placeholder = 'default: ' + ws;
  $('projModal').classList.remove('hidden');
  $('projName').focus();
}
function closeProjectModal() { $('projModal').classList.add('hidden'); }

// ─── wiring ─────────────────────────────────────────────────────────
function autoGrow() {
  const inp = $('composerInput');
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 180) + 'px';
}
function onNewBtn() {
  if (SECTION === 'chats') newChat();
  else if (SECTION === 'projects' && CURRENT_PROJECT) newAgentChat();
  else if (SECTION === 'projects') openProjectModal();
  else if (SECTION === 'git') openConnModal();
}

function wire() {
  $('newBtn').onclick = onNewBtn;
  $('sendBtn').onclick = () => (sending ? stop() : send());
  $('chatProvider').onclick = () => selectSection('settings');
  $('chatFilesBtn').onclick = openFiles;
  $('filesBack').onclick = () => show('chatView');
  $('listTitle').onclick = () => {
    if (SECTION === 'projects' && CURRENT_PROJECT) {
      CURRENT_PROJECT = null; CURRENT = null; CURRENT_SESSION = null;
      renderList();
      showPickProject();
    }
  };

  const inp = $('composerInput');
  inp.addEventListener('input', autoGrow);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // settings
  $('setModel').onchange = () => {
    const sel = $('setModel');
    if (sel.value !== '__custom__') return;
    const v = prompt('Model id:');
    if (v && v.trim()) {
      const o = document.createElement('option');
      o.textContent = v.trim();
      o.value = v.trim();
      sel.insertBefore(o, sel.lastChild);
      sel.value = v.trim();
    } else {
      sel.selectedIndex = 0;
    }
  };
  $('refreshModels').onclick = () => fillModels($('setProvider').value, $('setModel').value);
  $('saveProvider').onclick = async () => {
    const model = $('setModel').value;
    if (model === '__custom__' || !model) { toast('Pick a model', true); return; }
    const r = await M.setProvider($('setProvider').value, model);
    if (r && r.ok) {
      CONFIG = await M.getConfig();
      $('chatProvider').textContent = providerLabel();
      toast('Provider saved');
    } else {
      toast((r && r.error) || 'Failed', true);
    }
  };
  $('saveKey').onclick = async () => {
    const r = await M.setKey($('setProvider').value, $('setKey').value);
    if (r && r.ok) { toast('API key saved'); renderSettings(); }
    else toast((r && r.error) || 'Failed', true);
  };

  // new-project modal
  $('projModalX').onclick = closeProjectModal;
  $('projCancel').onclick = closeProjectModal;
  $('projBrowse').onclick = () => {
    openPicker('Choose a location', $('projLoc').value.trim() || null, (dir) => {
      $('projLoc').value = dir;
    });
  };
  $('projCreate').onclick = async () => {
    const r = await M.createProject({
      name: $('projName').value,
      location: $('projLoc').value.trim(),
      gitInit: $('projGit').checked,
    });
    if (r && r.id) {
      closeProjectModal();
      await loadProjects();
      openProject(r.id);
      toast('Project created');
    } else {
      toast((r && r.error) || 'Failed to create project', true);
    }
  };
  $('projOpenExisting').onclick = () => {
    openPicker('Open existing folder', null, async (dir) => {
      const r = await M.openProjectFolder(dir);
      if (r && r.id) {
        closeProjectModal();
        await loadProjects();
        openProject(r.id);
      } else {
        toast((r && r.error) || 'Failed', true);
      }
    });
  };

  // folder picker
  $('pickX').onclick = closePicker;
  $('pickCancel').onclick = closePicker;
  $('pickChoose').onclick = () => {
    if (!pickCur) { toast('Open a drive or folder first', true); return; }
    const cb = pickCb;
    closePicker();
    if (cb) cb(pickCur);
  };

  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  });

  // git rail
  $('reposRefresh').onclick = loadRepos;
  $('reposCreate').onclick = openRepoModal;
  $('connX').onclick = () => $('connModal').classList.add('hidden');
  $('connCancel').onclick = () => $('connModal').classList.add('hidden');
  $('connService').onchange = syncConnModal;
  $('connSave').onclick = saveConnection;
  $('repoX').onclick = () => $('repoModal').classList.add('hidden');
  $('repoCancel').onclick = () => $('repoModal').classList.add('hidden');
  $('repoCreateBtn').onclick = createRepo;

  // project git panel
  $('chatGitBtn').onclick = openGit;
  $('gitBack').onclick = () => show('chatView');
  $('gitRefresh').onclick = refreshGit;
  $('gitCommitBtn').onclick = doCommit;
  $('gitPushBtn').onclick = () => doTransfer('push');
  $('gitPullBtn').onclick = () => doTransfer('pull');

  // streaming
  M.onToken(onToken);
  M.onTool(onTool);
  M.onToolResult(onToolResult);
  M.onError(onError);
  M.onDone(onDone);
  M.onThinking(() => {});
}

// ─── git: connections & remote repos ────────────────────────────────
async function loadConnections() {
  GIT_CONNS = await M.gitConnections();
  if (SECTION === 'git') renderList();
}
async function openConn(id) {
  CURRENT_CONN = id;
  renderList();
  const conn = GIT_CONNS.find(c => c.id === id);
  $('reposTitle').textContent = conn ? conn.name : 'Repositories';
  $('repoList').innerHTML = '<div class="list-empty">Loading repositories…</div>';
  show('reposView');
  loadRepos();
}
async function loadRepos() {
  if (!CURRENT_CONN) return;
  const res = await M.gitRepos(CURRENT_CONN);
  const box = $('repoList');
  if (res.error) { box.innerHTML = '<div class="list-empty">' + escapeHtml(res.error) + '</div>'; return; }
  if (!res.repos.length) { box.innerHTML = '<div class="list-empty">No repositories found.</div>'; return; }
  box.innerHTML = '';
  res.repos.forEach(r => {
    const el = document.createElement('div');
    el.className = 'repo';
    el.innerHTML =
      '<div class="info"><div class="rn">' + escapeHtml(r.name) +
        (r.private ? '<span class="badge">private</span>' : '') + '</div>' +
        (r.description ? '<div class="rd">' + escapeHtml(r.description) + '</div>' : '') +
      '</div>';
    const btn = document.createElement('button');
    btn.textContent = 'Clone';
    btn.onclick = () => cloneRepo(r, btn);
    el.appendChild(btn);
    box.appendChild(el);
  });
}
async function cloneRepo(repo, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Cloning…'; }
  const res = await M.gitClone(CURRENT_CONN, repo);
  if (res && res.id) {
    toast('Cloned ' + repo.name);
    await loadProjects();
    selectSection('projects');
    openProject(res.id);
  } else {
    toast((res && res.error) || 'Clone failed', true);
    if (btn) { btn.disabled = false; btn.textContent = 'Clone'; }
  }
}
async function removeConn(id) {
  if (!confirm('Disconnect this service?')) return;
  await M.gitRemoveConnection(id);
  if (CURRENT_CONN === id) CURRENT_CONN = null;
  await loadConnections();
  if (!CURRENT_CONN) {
    placeholder('⎇', 'Git', 'Connect a git service to browse and clone repos.');
  }
}

const CONN_HOST = { github: 'https://github.com', gitlab: 'https://gitlab.com', gitea: '' };
const CONN_HELP = {
  github: 'Create a token at github.com/settings/tokens with the "repo" scope.',
  gitlab: 'Create a token in GitLab → Settings → Access Tokens with the "api" scope.',
  gitea: 'Create a token in your Gitea instance → Settings → Applications. Set its host URL above.',
};
function openConnModal() {
  $('connService').value = 'github';
  syncConnModal();
  $('connToken').value = '';
  $('connModal').classList.remove('hidden');
}
function syncConnModal() {
  const s = $('connService').value;
  $('connHost').value = CONN_HOST[s];
  $('connHost').placeholder = CONN_HOST[s] || 'https://gitea.example.com';
  $('connHelp').textContent = CONN_HELP[s];
}
async function saveConnection() {
  const btn = $('connSave');
  btn.disabled = true; btn.textContent = 'Connecting…';
  const res = await M.gitAddConnection({
    service: $('connService').value,
    host: $('connHost').value.trim(),
    token: $('connToken').value,
  });
  btn.disabled = false; btn.textContent = 'Connect';
  if (res && res.id) {
    $('connModal').classList.add('hidden');
    await loadConnections();
    toast('Connected — ' + res.name);
    openConn(res.id);
  } else {
    toast((res && res.error) || 'Failed to connect', true);
  }
}
function openRepoModal() {
  if (!CURRENT_CONN) { toast('Select a connection first', true); return; }
  $('repoName').value = '';
  $('repoDesc').value = '';
  $('repoPrivate').checked = true;
  $('repoModal').classList.remove('hidden');
}
async function createRepo() {
  const btn = $('repoCreateBtn');
  btn.disabled = true; btn.textContent = 'Creating…';
  const res = await M.gitCreateRepo({
    connId: CURRENT_CONN,
    name: $('repoName').value.trim(),
    description: $('repoDesc').value.trim(),
    isPrivate: $('repoPrivate').checked,
  });
  if (res && res.repo) {
    btn.textContent = 'Cloning…';
    const cl = await M.gitClone(CURRENT_CONN, res.repo);
    btn.disabled = false; btn.textContent = 'Create & clone';
    if (cl && cl.id) {
      $('repoModal').classList.add('hidden');
      toast('Created ' + res.repo.name);
      await loadProjects();
      selectSection('projects');
      openProject(cl.id);
    } else {
      toast('Repo created, but clone failed: ' + ((cl && cl.error) || ''), true);
      loadRepos();
    }
  } else {
    btn.disabled = false; btn.textContent = 'Create & clone';
    toast((res && res.error) || 'Failed to create repository', true);
  }
}

// ─── git: per-project panel ─────────────────────────────────────────
async function openGit() {
  const proj = currentProject();
  if (!proj) { toast('No project for this session', true); return; }
  $('gitTitle').textContent = proj.name;
  $('gitOutput').textContent = '';
  $('gitMsg').value = '';
  show('gitView');
  refreshGit();
}
async function refreshGit() {
  const proj = currentProject();
  if (!proj) return;
  const st = await M.gitStatus(proj.path);
  if (st.error) {
    $('gitBranch').textContent = st.error;
    $('gitChanges').innerHTML = '';
    return;
  }
  $('gitBranch').innerHTML = 'Branch: <b>' + escapeHtml(st.branch || '(none)') + '</b>';
  const box = $('gitChanges');
  if (!st.files.length) {
    box.innerHTML = '<div class="git-clean">✓ Working tree clean</div>';
  } else {
    box.innerHTML = st.files.map(f =>
      '<div class="git-change"><span class="gx">' + escapeHtml(f.x || '·') + '</span>' +
      escapeHtml(f.path) + '</div>').join('');
  }
}
function gitBusy(on) {
  ['gitCommitBtn', 'gitPushBtn', 'gitPullBtn'].forEach(id => { $(id).disabled = on; });
}
async function doCommit() {
  const proj = currentProject();
  if (!proj) return;
  gitBusy(true);
  const res = await M.gitCommit(proj.path, $('gitMsg').value);
  gitBusy(false);
  if (res.ok) {
    $('gitMsg').value = '';
    $('gitOutput').textContent = res.output || 'Committed.';
    toast('Committed');
    refreshGit();
  } else {
    $('gitOutput').textContent = res.error;
    toast(res.error, true);
  }
}
async function doTransfer(kind) {
  const proj = currentProject();
  if (!proj) return;
  gitBusy(true);
  $('gitOutput').textContent = kind === 'push' ? 'Pushing…' : 'Pulling…';
  const res = await (kind === 'push' ? M.gitPush(proj.path) : M.gitPull(proj.path));
  gitBusy(false);
  $('gitOutput').textContent = res.ok ? (res.output || 'Done.') : res.error;
  toast(res.ok ? (kind + ' complete') : res.error, !res.ok);
  if (res.ok) refreshGit();
}

// ─── init ───────────────────────────────────────────────────────────
async function init() {
  wire();
  CONFIG = await M.getConfig();
  await loadProjects();
  await loadConnections();
  await loadSessions();
  const firstChat = SESSIONS.find(s => s.mode !== 'agent');
  if (firstChat) { CURRENT = firstChat.id; }
  selectSection('chats');
}
init();
