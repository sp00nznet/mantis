'use strict';

// Mantis Desktop — renderer (Phase 1: chat + history + settings).
// All engine access goes through window.mantis (see preload.cjs).

const $ = (id) => document.getElementById(id);
const M = window.mantis;

let SECTION = 'chats';
let SESSIONS = [];
let CURRENT = null;     // open session id
let CONFIG = null;
let sending = false;
let streamEl = null;    // assistant bubble being streamed into
let streamBuf = '';

// ─── toast ──────────────────────────────────────────────────────────
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);
function toast(msg, err) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (err ? ' err' : '');
  setTimeout(() => { toastEl.className = ''; }, 2400);
}

// ─── markdown-lite ──────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderMarkdown(text) {
  const blocks = [];
  // pull fenced code blocks out behind a sentinel so inline rules skip them
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

// ─── views ──────────────────────────────────────────────────────────
function show(view) {
  ['chatView', 'settingsView', 'placeholderView'].forEach(v => {
    $(v).classList.toggle('hidden', v !== view);
  });
}
function showWelcome() {
  $('placeholderBody').innerHTML =
    '<div class="big">🦗</div><h2>Start a conversation</h2>' +
    '<p>Click <b>+ New</b> to begin a chat, or pick one from your history.</p>';
  show('placeholderView');
}
function showPlaceholder(section) {
  const info = {
    projects: ['📁', 'Projects', 'Folder-bound agent sessions with full tools — coming in Phase 2.'],
    git: ['⎇', 'Git', 'Connect GitHub, GitLab, and Gitea, then clone repos — coming in Phase 3.'],
  }[section] || ['', '', ''];
  $('placeholderBody').innerHTML =
    '<div class="big">' + info[0] + '</div><h2>' + info[1] + '</h2><p>' + info[2] + '</p>';
  show('placeholderView');
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
    renderSessionList();
    if (CURRENT) openSession(CURRENT);
    else showWelcome();
  } else if (name === 'settings') {
    $('list').classList.add('hidden');
    show('settingsView');
    renderSettings();
  } else {
    $('list').classList.add('hidden');
    showPlaceholder(name);
  }
}

// ─── sessions / history ─────────────────────────────────────────────
function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}
async function loadSessions() {
  SESSIONS = await M.listSessions();
  if (SECTION === 'chats') renderSessionList();
}
function renderSessionList() {
  const body = $('listBody');
  if (!SESSIONS.length) {
    body.innerHTML = '<div class="list-empty">No conversations yet.</div>';
    return;
  }
  body.innerHTML = '';
  SESSIONS.forEach(s => {
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
async function newChat() {
  const s = await M.createSession({ mode: 'chat' });
  CURRENT = s.id;
  await loadSessions();
  await openSession(s.id);
  $('composerInput').focus();
}
async function delSession(id) {
  if (!confirm('Delete this conversation?')) return;
  await M.deleteSession(id);
  if (CURRENT === id) CURRENT = null;
  await loadSessions();
  if (CURRENT) openSession(CURRENT); else showWelcome();
}
async function openSession(id) {
  const s = await M.getSession(id);
  if (!s) { CURRENT = null; showWelcome(); return; }
  CURRENT = id;
  streamEl = null;
  setSending(false);
  renderSessionList();
  $('chatTitle').textContent = s.title;
  $('chatProvider').textContent = providerLabel();
  const msgs = $('messages');
  msgs.innerHTML = '';
  s.messages.forEach(m => addMessage(m.role, m.content));
  show('chatView');
  scrollDown();
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
    $('chatTitle').textContent = s.title;
    $('messages').innerHTML = '';
    show('chatView');
  }
  inp.value = '';
  autoGrow();
  addMessage('user', text);
  streamBuf = '';
  streamEl = addMessage('assistant', '');
  streamEl.innerHTML = '<span style="opacity:.45">▋</span>';
  scrollDown();
  setSending(true);

  try {
    await M.sendMessage(CURRENT, text);
  } catch (e) {
    toast('Send failed: ' + e.message, true);
    setSending(false);
    streamEl = null;
  }
}
function stop() {
  if (CURRENT) M.stopMessage(CURRENT);
}

// streaming events
function onToken(d) {
  if (d.sessionId !== CURRENT || !streamEl) return;
  streamBuf += d.text;
  streamEl.innerHTML = renderMarkdown(streamBuf);
  scrollDown();
}
function onError(d) {
  if (d.sessionId !== CURRENT) return;
  if (streamEl && !streamBuf) {
    streamEl.classList.add('err');
    streamEl.textContent = '⚠ ' + d.error;
  } else {
    toast(d.error, true);
  }
}
function onDone(d) {
  if (d.sessionId === CURRENT) {
    if (d.title) $('chatTitle').textContent = d.title;
    if (streamEl && !streamBuf && !d.errored) {
      streamEl.textContent = '(no response)';
    }
    streamEl = null;
    streamBuf = '';
    setSending(false);
  }
  loadSessions();
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

// ─── wiring ─────────────────────────────────────────────────────────
function autoGrow() {
  const inp = $('composerInput');
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 180) + 'px';
}

function wire() {
  $('newBtn').onclick = newChat;
  $('sendBtn').onclick = () => (sending ? stop() : send());
  $('chatProvider').onclick = () => selectSection('settings');

  const inp = $('composerInput');
  inp.addEventListener('input', autoGrow);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

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

  M.onToken(onToken);
  M.onError(onError);
  M.onDone(onDone);
  M.onThinking(() => {});
}

// ─── init ───────────────────────────────────────────────────────────
async function init() {
  wire();
  CONFIG = await M.getConfig();
  await loadSessions();
  CURRENT = SESSIONS.length ? SESSIONS[0].id : null;
  selectSection('chats');
}
init();
