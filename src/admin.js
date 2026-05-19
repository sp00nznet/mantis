/**
 * Admin web UI — a loopback-only control panel for Mantis.
 *
 * Lets you manage provider API keys, the active provider/model, proxy tier
 * routing, and bot tokens from a browser instead of editing config.json or
 * remembering slash commands. Inspired by free-claude-code's /admin panel.
 *
 * `handleAdminRequest` is also mounted on the proxy server, so when you run
 * `mantis serve` the panel is reachable at http://127.0.0.1:8787/admin.
 */

import http from 'http';
import { getConfig, saveConfig, PROVIDERS } from './config.js';

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
    description: p.description,
  }));
  return {
    activeProvider: config.provider,
    activeModel: config.model,
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
      // Provider has no /models — try a 1-token completion instead.
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

// ─── JSON helpers ───────────────────────────────────────────────────

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

// ─── API routes ─────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  const config = getConfig();

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

  if (url.startsWith('/api/provider/test') && req.method === 'GET') {
    const provider = new URL(req.url, 'http://x').searchParams.get('provider');
    const result = await testProvider(provider);
    return sendJson(res, 200, result);
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found\n');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
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

// ─── The page ───────────────────────────────────────────────────────
// Single self-contained HTML document. Client JS avoids template literals so
// this whole file stays one clean backtick string.

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mantis Admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         background: #0d1117; color: #c9d1d9; font-size: 14px; }
  header { padding: 20px 28px; border-bottom: 1px solid #21262d; }
  h1 { margin: 0; font-size: 18px; color: #3fb950; }
  h1 span { color: #6e7681; font-weight: normal; font-size: 13px; }
  main { max-width: 880px; margin: 0 auto; padding: 24px 28px 60px; }
  section { background: #161b22; border: 1px solid #21262d; border-radius: 8px;
            padding: 18px 20px; margin-bottom: 20px; }
  h2 { margin: 0 0 14px; font-size: 14px; color: #58a6ff; }
  label { display: block; color: #8b949e; margin: 10px 0 4px; font-size: 12px; }
  input, select { width: 100%; padding: 7px 9px; background: #0d1117;
                  border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9;
                  font-family: inherit; font-size: 13px; }
  input:focus, select:focus { outline: none; border-color: #58a6ff; }
  button { padding: 7px 14px; background: #238636; border: 1px solid #2ea043;
           border-radius: 6px; color: #fff; font-family: inherit; font-size: 13px;
           cursor: pointer; }
  button:hover { background: #2ea043; }
  button.alt { background: #21262d; border-color: #30363d; }
  button.alt:hover { background: #30363d; }
  .row { display: flex; gap: 10px; align-items: flex-end; }
  .row > * { flex: 1; }
  .row > button { flex: 0 0 auto; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 7px 6px; border-bottom: 1px solid #21262d; vertical-align: middle; }
  td:first-child { color: #c9d1d9; white-space: nowrap; }
  .tag { font-size: 11px; padding: 1px 7px; border-radius: 10px; }
  .tag.on { background: #238636; color: #fff; }
  .tag.off { background: #30363d; color: #8b949e; }
  .grid { display: grid; grid-template-columns: 70px 1fr 1fr; gap: 8px 10px; align-items: center; }
  .grid label { margin: 0; }
  .hint { color: #6e7681; font-size: 11px; margin-top: 8px; }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .check input { width: auto; }
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
           background: #238636; color: #fff; padding: 9px 18px; border-radius: 6px;
           opacity: 0; transition: opacity .2s; pointer-events: none; }
  #toast.show { opacity: 1; }
  #toast.err { background: #da3633; }
</style>
</head>
<body>
<header>
  <h1>Mantis Admin <span>provider &amp; proxy control panel</span></h1>
</header>
<main>
  <section>
    <h2>Active provider</h2>
    <div class="row">
      <div><label>Provider</label><select id="activeProvider"></select></div>
      <div><label>Model</label><input id="activeModel" placeholder="model id"></div>
      <button onclick="saveActive()">Save</button>
    </div>
  </section>

  <section>
    <h2>API keys</h2>
    <table id="keyTable"></table>
    <div class="hint">Keys are stored in ~/.mantis/config.json. Leave a field blank and save to clear it.</div>
  </section>

  <section>
    <h2>Proxy routing</h2>
    <div class="hint" style="margin-bottom:12px">Each Claude tier routes independently. Leave provider blank to use the active provider; leave model blank for that provider's default.</div>
    <div class="grid" id="routeGrid"></div>
    <div class="check">
      <input type="checkbox" id="answerProbes">
      <label for="answerProbes" style="margin:0">Answer trivial Claude Code probes locally (saves quota)</label>
    </div>
    <div class="row" style="margin-top:14px">
      <div><label>Proxy port</label><input id="proxyPort" type="number"></div>
      <div><label>Proxy host</label><input id="proxyHost"></div>
      <button onclick="saveProxy()">Save</button>
    </div>
    <div class="hint">Port/host changes apply next time the proxy starts.</div>
  </section>

  <section>
    <h2>Chat bots</h2>
    <label>Telegram bot token</label>
    <input id="telegramToken" type="password" placeholder="(not set)">
    <label>Discord bot token</label>
    <input id="discordToken" type="password" placeholder="(not set)">
    <div class="row" style="margin-top:14px">
      <div></div><button onclick="saveBots()">Save</button>
    </div>
    <div class="hint">Start a bot with: mantis bot telegram &nbsp;/&nbsp; mantis bot discord</div>
  </section>
</main>
<div id="toast"></div>
<script>
var STATE = null;
var TIERS = ['opus','sonnet','haiku','default'];

function toast(msg, isErr) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  setTimeout(function(){ t.className = ''; }, 2200);
}

function api(method, path, body) {
  var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(path, opts).then(function(r){ return r.json(); });
}

function providerOptions(selected, includeBlank) {
  var html = includeBlank ? '<option value="">(active provider)</option>' : '';
  STATE.providers.forEach(function(p){
    var sel = p.key === selected ? ' selected' : '';
    html += '<option value="' + p.key + '"' + sel + '>' + p.name + '</option>';
  });
  return html;
}

function render() {
  document.getElementById('activeProvider').innerHTML = providerOptions(STATE.activeProvider, false);
  document.getElementById('activeModel').value = STATE.activeModel || '';

  var rows = '';
  STATE.providers.forEach(function(p){
    if (!p.requiresKey) return;
    var tag = p.hasKey ? '<span class="tag on">key set</span>' : '<span class="tag off">no key</span>';
    rows += '<tr>' +
      '<td>' + p.name + '</td>' +
      '<td>' + tag + '</td>' +
      '<td><input type="password" id="key_' + p.key + '" placeholder="' + (p.hasKey ? 'set — type to replace' : 'paste API key') + '"></td>' +
      '<td style="text-align:right;white-space:nowrap">' +
        '<button class="alt" onclick="testProvider(\\'' + p.key + '\\')">Test</button> ' +
        '<button onclick="saveKey(\\'' + p.key + '\\')">Save</button>' +
      '</td></tr>';
  });
  document.getElementById('keyTable').innerHTML = rows;

  var grid = '<label></label><label style="color:#8b949e">Provider</label><label style="color:#8b949e">Model</label>';
  TIERS.forEach(function(tier){
    var r = STATE.proxy.routes[tier] || {};
    grid += '<label style="text-transform:capitalize">' + tier + '</label>' +
      '<select id="route_' + tier + '_provider">' + providerOptions(r.provider, true) + '</select>' +
      '<input id="route_' + tier + '_model" placeholder="(provider default)" value="' + (r.model || '') + '">';
  });
  document.getElementById('routeGrid').innerHTML = grid;

  document.getElementById('answerProbes').checked = STATE.proxy.answerProbes;
  document.getElementById('proxyPort').value = STATE.proxy.port;
  document.getElementById('proxyHost').value = STATE.proxy.host;
  document.getElementById('telegramToken').placeholder = STATE.bots.telegram.hasToken ? 'set — type to replace' : '(not set)';
  document.getElementById('discordToken').placeholder = STATE.bots.discord.hasToken ? 'set — type to replace' : '(not set)';
}

function load() {
  api('GET', '/api/state').then(function(s){ STATE = s; render(); });
}

function saveActive() {
  api('POST', '/api/provider/active', {
    provider: document.getElementById('activeProvider').value,
    model: document.getElementById('activeModel').value
  }).then(function(r){
    if (r.ok) { toast('Active provider saved'); load(); }
    else toast(r.error || 'Failed', true);
  });
}

function saveKey(key) {
  var val = document.getElementById('key_' + key).value;
  api('POST', '/api/provider/key', { provider: key, key: val }).then(function(r){
    if (r.ok) { toast('Key saved for ' + key); load(); }
    else toast(r.error || 'Failed', true);
  });
}

function testProvider(key) {
  toast('Testing ' + key + '...');
  api('GET', '/api/provider/test?provider=' + encodeURIComponent(key)).then(function(r){
    toast(r.message, !r.ok);
  });
}

function saveProxy() {
  var routes = {};
  TIERS.forEach(function(tier){
    routes[tier] = {
      provider: document.getElementById('route_' + tier + '_provider').value,
      model: document.getElementById('route_' + tier + '_model').value
    };
  });
  api('POST', '/api/proxy', {
    routes: routes,
    answerProbes: document.getElementById('answerProbes').checked,
    port: parseInt(document.getElementById('proxyPort').value, 10),
    host: document.getElementById('proxyHost').value
  }).then(function(r){
    if (r.ok) { toast('Proxy settings saved'); load(); }
    else toast(r.error || 'Failed', true);
  });
}

function saveBots() {
  var payload = {};
  var tg = document.getElementById('telegramToken').value;
  var dc = document.getElementById('discordToken').value;
  if (tg) payload.telegramToken = tg;
  if (dc) payload.discordToken = dc;
  api('POST', '/api/bots', payload).then(function(r){
    if (r.ok) { toast('Bot tokens saved'); load(); }
    else toast(r.error || 'Failed', true);
  });
}

load();
</script>
</body>
</html>`;
