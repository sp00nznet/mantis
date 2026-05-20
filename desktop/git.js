/**
 * Desktop git integration.
 *
 * - Connections: per-service Personal Access Tokens (GitHub / GitLab / Gitea,
 *   self-hosted too), stored in ~/.mantis/git.json. Tokens are encrypted with
 *   Electron's safeStorage when available, base64 otherwise.
 * - Remote repos: list and create repos via each service's REST API.
 * - Clone: `git clone` into the workspace (token kept out of .git/config).
 * - Project git: status / commit / push / pull, shelling out to `git`.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { activeDataDir } from '../src/users.js';
import { workspaceRoot } from './projects.js';

// Per-user git connections — each signed-in account brings its own tokens.
function gitFile() {
  return path.join(activeDataDir(), 'git.json');
}

const SERVICES = {
  github: { label: 'GitHub', defaultHost: 'https://github.com' },
  gitlab: { label: 'GitLab', defaultHost: 'https://gitlab.com' },
  gitea: { label: 'Gitea', defaultHost: '' },
};

// safeStorage is injected by the Electron main process (see setSafeStorage).
let _safeStorage = null;
export function setSafeStorage(ss) { _safeStorage = ss || null; }

// ─── Token storage ──────────────────────────────────────────────────

function encToken(token) {
  try {
    if (_safeStorage && _safeStorage.isEncryptionAvailable()) {
      return { enc: true, v: _safeStorage.encryptString(token).toString('base64') };
    }
  } catch { /* fall through */ }
  return { enc: false, v: Buffer.from(token, 'utf-8').toString('base64') };
}
function decToken(stored) {
  if (!stored || !stored.v) return '';
  try {
    if (stored.enc && _safeStorage) {
      return _safeStorage.decryptString(Buffer.from(stored.v, 'base64'));
    }
  } catch { return ''; }
  return Buffer.from(stored.v, 'base64').toString('utf-8');
}

function readConns() {
  try { return JSON.parse(fs.readFileSync(gitFile(), 'utf-8')).connections || []; }
  catch { return []; }
}
function writeConns(conns) {
  fs.writeFileSync(gitFile(), JSON.stringify({ connections: conns }, null, 2), 'utf-8');
}
function getConn(id) { return readConns().find(c => c.id === id) || null; }

// ─── Service REST API ───────────────────────────────────────────────

function apiBase(service, host) {
  host = (host || '').replace(/\/+$/, '');
  if (service === 'github') {
    return /(^|\/\/)(api\.)?github\.com/.test(host) ? 'https://api.github.com' : host + '/api/v3';
  }
  if (service === 'gitlab') return host + '/api/v4';
  return host + '/api/v1'; // gitea
}
function authHeaders(service, token) {
  if (service === 'github') {
    return { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'Mantis-Desktop' };
  }
  if (service === 'gitlab') return { 'PRIVATE-TOKEN': token };
  return { Authorization: 'token ' + token }; // gitea
}
function hostLabel(host) {
  try { return new URL(host).host; } catch { return host; }
}
function normalizeRepo(service, x) {
  if (service === 'gitlab') {
    return {
      name: x.name, fullName: x.path_with_namespace, cloneUrl: x.http_url_to_repo,
      private: x.visibility !== 'public', description: x.description || '', updated: x.last_activity_at,
    };
  }
  return { // github + gitea share these field names
    name: x.name, fullName: x.full_name, cloneUrl: x.clone_url,
    private: !!x.private, description: x.description || '', updated: x.updated_at,
  };
}

async function whoami(service, host, token) {
  try {
    const r = await fetch(apiBase(service, host) + '/user', {
      headers: authHeaders(service, token), signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return { error: 'HTTP ' + r.status + (r.status === 401 ? ' — invalid token' : '') };
    const u = await r.json();
    return { username: u.login || u.username || '' };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Connections ────────────────────────────────────────────────────

export function listConnections() {
  return readConns().map(c => ({
    id: c.id, service: c.service, host: c.host, name: c.name, username: c.username || '',
  }));
}

export async function addConnection({ service, host, token }) {
  if (!SERVICES[service]) return { error: 'Unknown service' };
  host = (host || '').trim() || SERVICES[service].defaultHost;
  if (!host) return { error: `A host URL is required for ${service}` };
  if (!/^https?:\/\//i.test(host)) host = 'https://' + host;
  host = host.replace(/\/+$/, '');
  token = (token || '').trim();
  if (!token) return { error: 'A token is required' };

  const who = await whoami(service, host, token);
  if (who.error) return { error: 'Token check failed — ' + who.error };

  const conns = readConns();
  const conn = {
    id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    service, host,
    name: (who.username ? who.username + ' @ ' : '') + hostLabel(host),
    username: who.username,
    token: encToken(token),
  };
  conns.push(conn);
  writeConns(conns);
  return { id: conn.id, service, host, name: conn.name, username: conn.username };
}

export function removeConnection(id) {
  writeConns(readConns().filter(c => c.id !== id));
  return { ok: true };
}

// ─── Remote repos ───────────────────────────────────────────────────

export async function repos(connId) {
  const c = getConn(connId);
  if (!c) return { error: 'Connection not found' };
  const token = decToken(c.token);
  const headers = authHeaders(c.service, token);
  const base = apiBase(c.service, c.host);
  const pageSize = c.service === 'gitea' ? 50 : 100;
  const all = [];

  try {
    // Page through the API so users with hundreds of repos see them all.
    for (let page = 1; page <= 12; page++) {
      let url;
      if (c.service === 'github') {
        url = base + `/user/repos?per_page=100&sort=updated&page=${page}`;
      } else if (c.service === 'gitlab') {
        url = base + `/projects?membership=true&per_page=100&order_by=last_activity_at&page=${page}`;
      } else {
        url = base + `/user/repos?limit=50&page=${page}`;
      }
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!r.ok) {
        if (page === 1) return { error: 'HTTP ' + r.status };
        break;
      }
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) break;
      for (const x of arr) all.push(normalizeRepo(c.service, x));
      if (arr.length < pageSize) break;
    }
  } catch (err) {
    if (!all.length) return { error: err.message };
  }

  // Flag repos already cloned into the workspace so the UI can offer "Open".
  const ws = workspaceRoot();
  for (const repo of all) {
    repo.localPath = path.join(ws, repo.name);
    repo.cloned = fs.existsSync(repo.localPath);
  }
  return { repos: all };
}

export async function createRepo(connId, { name, description, isPrivate }) {
  const c = getConn(connId);
  if (!c) return { error: 'Connection not found' };
  if (!name || !name.trim()) return { error: 'Repository name is required' };
  const token = decToken(c.token);
  const base = apiBase(c.service, c.host);

  let url, body;
  if (c.service === 'gitlab') {
    url = base + '/projects';
    body = { name: name.trim(), description: description || '', visibility: isPrivate ? 'private' : 'public', initialize_with_readme: true };
  } else { // github + gitea
    url = base + '/user/repos';
    body = { name: name.trim(), description: description || '', private: !!isPrivate, auto_init: true };
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(c.service, token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let t = ''; try { t = await r.text(); } catch { /* ignore */ }
      return { error: 'HTTP ' + r.status + ' — ' + t.slice(0, 180) };
    }
    return { repo: normalizeRepo(c.service, await r.json()) };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── git CLI ────────────────────────────────────────────────────────

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let se = stderr || '';
      if (err && err.code === 'ENOENT') se = 'git is not installed or not on PATH';
      resolve({ ok: !err, stdout: stdout || '', stderr: se });
    });
  });
}
function gitErr(r) {
  const e = (r.stderr || r.stdout || '').trim();
  if (/not a git repository/i.test(e)) return 'This folder is not a git repository';
  return e || 'git command failed';
}
function scrub(text, token) {
  if (!token) return text;
  return String(text).split(token).join('***').split(encodeURIComponent(token)).join('***');
}
function authUrl(service, token, cloneUrl) {
  const t = encodeURIComponent(token);
  const cred = service === 'github' ? 'x-access-token:' + t
    : service === 'gitlab' ? 'oauth2:' + t
    : t; // gitea: token as the username
  return cloneUrl.replace(/^https:\/\//i, 'https://' + cred + '@');
}
function connForRemote(remoteUrl) {
  let host = '';
  try { host = new URL(remoteUrl).host; } catch { return null; }
  return readConns().find(c => { try { return new URL(c.host).host === host; } catch { return false; } });
}

// ─── Clone ──────────────────────────────────────────────────────────

/** Clone a repo into the workspace. Returns { path, name } or { error }. */
export async function clone(connId, repo) {
  const c = getConn(connId);
  if (!c) return { error: 'Connection not found' };
  if (!repo || !repo.cloneUrl) return { error: 'Repo has no clone URL' };

  const token = decToken(c.token);
  const dir = path.join(workspaceRoot(), repo.name);
  if (fs.existsSync(dir)) {
    return { error: `"${repo.name}" already exists in the workspace` };
  }
  if (!fs.existsSync(workspaceRoot())) fs.mkdirSync(workspaceRoot(), { recursive: true });

  const r = await git(['clone', authUrl(c.service, token, repo.cloneUrl), dir]);
  if (!r.ok) return { error: scrub(gitErr(r), token) };
  // strip the token back out of .git/config
  await git(['remote', 'set-url', 'origin', repo.cloneUrl], dir);
  return { path: dir, name: repo.name };
}

// ─── Project git ops ────────────────────────────────────────────────

export async function status(projectPath) {
  const r = await git(['status', '--porcelain', '--branch'], projectPath);
  if (!r.ok) return { error: gitErr(r) };
  let branch = '';
  const files = [];
  for (const ln of r.stdout.split('\n')) {
    if (!ln) continue;
    if (ln.startsWith('##')) {
      branch = ln.slice(2).trim().split('...')[0].split(/\s/)[0];
    } else {
      files.push({ x: ln.slice(0, 2).trim(), path: ln.slice(3) });
    }
  }
  return { branch, files };
}

export async function commit(projectPath, message) {
  if (!message || !message.trim()) return { error: 'A commit message is required' };
  let r = await git(['add', '-A'], projectPath);
  if (!r.ok) return { error: gitErr(r) };

  r = await git(['commit', '-m', message], projectPath);
  if (!r.ok && /identity|user\.(email|name)|please tell me who you are/i.test(r.stderr + r.stdout)) {
    await git(['config', 'user.name', 'Mantis User'], projectPath);
    await git(['config', 'user.email', 'mantis@localhost'], projectPath);
    r = await git(['commit', '-m', message], projectPath);
  }
  if (!r.ok) {
    if (/nothing to commit/i.test(r.stdout + r.stderr)) return { error: 'Nothing to commit' };
    return { error: gitErr(r) };
  }
  return { ok: true, output: r.stdout.trim() };
}

async function transfer(op, projectPath) {
  const remote = await git(['remote', 'get-url', 'origin'], projectPath);
  if (!remote.ok) return { error: 'No "origin" remote is configured' };
  const originUrl = remote.stdout.trim();
  const conn = connForRemote(originUrl);

  let args, token = '';
  if (conn) {
    token = decToken(conn.token);
    const url = authUrl(conn.service, token, originUrl);
    if (op === 'push') {
      const st = await status(projectPath);
      args = ['push', url, st.branch || 'HEAD'];
    } else {
      args = ['pull', url];
    }
  } else {
    args = op === 'push' ? ['push'] : ['pull']; // rely on a system credential helper
  }

  const r = await git(args, projectPath);
  const out = scrub((r.stdout + '\n' + r.stderr).trim(), token);
  if (!r.ok) return { error: out || `${op} failed` };
  return { ok: true, output: out || `${op} complete` };
}

export function push(projectPath) { return transfer('push', projectPath); }
export function pull(projectPath) { return transfer('pull', projectPath); }
