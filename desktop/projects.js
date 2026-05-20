/**
 * Desktop projects — folders the agent works in.
 *
 * A project is a registered directory (created fresh with `git init`, or an
 * existing folder). Agent-mode sessions are bound to a project and run the
 * full Mantis tool loop with that folder as the working directory.
 *
 * The registry lives at ~/.mantis/projects.json. Removing a project only
 * unregisters it — the folder on disk is never deleted.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { getConfigDir, getConfig } from '../src/config.js';

const PROJECTS_FILE = path.join(getConfigDir(), 'projects.json');
const DEFAULT_WORKSPACE = path.join(os.homedir(), 'MantisProjects');
const SKIP = ['node_modules', '.git', '.next', 'dist', '.cache', '.venv', 'venv', '__pycache__'];

function readAll() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8')); }
  catch { return []; }
}
function writeAll(arr) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
}
function genId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}
function git(cmd, cwd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, windowsHide: true }, (err) => resolve(!err));
  });
}

/** The folder new projects and clones go into — configurable in Settings. */
export function workspaceRoot() {
  const d = getConfig().projectsDir;
  return (d && d.trim()) || DEFAULT_WORKSPACE;
}
/** Make sure the workspace folder exists; returns its path. */
export function ensureWorkspace() {
  const w = workspaceRoot();
  try { if (!fs.existsSync(w)) fs.mkdirSync(w, { recursive: true }); } catch { /* ignore */ }
  return w;
}
export function list() { return readAll().sort((a, b) => b.createdAt - a.createdAt); }
export function get(id) { return readAll().find(p => p.id === id) || null; }

function register(dir, name) {
  const all = readAll();
  const found = all.find(p => path.resolve(p.path) === path.resolve(dir));
  if (found) return found;
  const proj = { id: genId(), name, path: dir, createdAt: Date.now() };
  all.push(proj);
  writeAll(all);
  return proj;
}

/** Create a new project folder (optionally `git init`) and register it. */
export async function create({ name, location, gitInit = true }) {
  name = (name || '').trim();
  if (!name) return { error: 'Project name is required' };
  if (/[\\/:*?"<>|]/.test(name)) return { error: 'Name has invalid characters' };

  const parent = (location && location.trim()) || workspaceRoot();
  let dir;
  try {
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    dir = path.join(parent, name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { error: err.message };
  }
  if (gitInit && !fs.existsSync(path.join(dir, '.git'))) {
    await git('git init', dir);
  }
  return register(dir, name);
}

/** Register an existing folder as a project. */
export function openExisting(dir) {
  if (!dir || !fs.existsSync(dir)) return { error: 'Folder not found' };
  try {
    if (!fs.statSync(dir).isDirectory()) return { error: 'That is not a folder' };
  } catch {
    return { error: 'Cannot read that folder' };
  }
  return register(dir, path.basename(dir) || dir);
}

/** Unregister a project (the folder on disk is left untouched). */
export function remove(id) {
  writeAll(readAll().filter(p => p.id !== id));
  return true;
}

/** Immediate children of a directory — the file tree expands lazily. */
export function children(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) { return { error: err.message, items: [] }; }

  const items = entries.map(e => {
    let isDir = false;
    try { isDir = e.isDirectory(); } catch { /* ignore */ }
    return {
      name: e.name,
      path: path.join(dir, e.name),
      dir: isDir,
      skip: isDir && SKIP.includes(e.name),
    };
  }).sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return { items };
}

/** Read a text file for the in-app viewer (size-capped). */
export function readFile(file) {
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) return { error: 'That is a folder' };
    if (st.size > 512 * 1024) return { error: 'File is too large to preview (over 512 KB)' };
    return { content: fs.readFileSync(file, 'utf-8') };
  } catch (err) {
    return { error: err.message };
  }
}

/** Browse directories for the new-project location picker. */
export function browse(rawPath) {
  const isWin = process.platform === 'win32';

  if (rawPath === '') {
    if (isWin) {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        try { if (fs.existsSync(d)) drives.push({ name: d, path: d }); } catch { /* ignore */ }
      }
      return { path: '', isDrives: true, parent: null, dirs: drives };
    }
    rawPath = '/';
  }

  let dir;
  try { dir = path.resolve(rawPath || workspaceRoot()); } catch { dir = workspaceRoot(); }

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) { return { error: err.message }; }

  const dirs = entries
    .filter(e => { try { return e.isDirectory(); } catch { return false; } })
    .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const root = path.parse(dir).root;
  const parent = dir === root ? (isWin ? '' : null) : path.dirname(dir);
  return { path: dir, parent, isDrives: false, dirs };
}
