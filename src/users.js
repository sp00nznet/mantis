/**
 * Per-user data store.
 *
 * When Google auth is enabled, each account's data is namespaced under
 * ~/.mantis/users/<id>/ — preferences (provider, model, API keys, theme),
 * conversation history, projects, and git connections.
 *
 * When auth is OFF there is no signed-in user: data stays at the legacy
 * ~/.mantis/ paths and everything behaves single-user, exactly as before.
 */

import fs from 'fs';
import path from 'path';
import { getConfigDir, getConfig } from './config.js';

const USERS_ROOT = path.join(getConfigDir(), 'users');

// The active user for single-user-process contexts (the desktop app). The
// admin server is multi-user and instead passes a userId explicitly.
let _active = null;

/** A filesystem-safe folder name for a user id. */
function safeId(userId) {
  return String(userId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function setActiveUser(id) { _active = id || null; }
export function activeUser() { return _active; }

/** The per-user directory (created on demand). */
export function userDir(userId) {
  const d = path.join(USERS_ROOT, safeId(userId));
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Base directory for the active context's data — the legacy ~/.mantis when
 * nobody is signed in, ~/.mantis/users/<id> when a user is active. This keeps
 * existing single-user installs untouched until auth is turned on.
 */
export function activeDataDir() {
  return _active ? userDir(_active) : getConfigDir();
}

export function userSessionsDir(userId) {
  const d = path.join(userId ? userDir(userId) : getConfigDir(), 'sessions');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

const prefsFile = (userId) => path.join(userDir(userId), 'prefs.json');

/**
 * A user's preferences: provider, model, API keys, theme. New accounts start
 * with the local provider and no API keys — each account brings its own.
 */
export function getUserPrefs(userId) {
  try {
    const p = JSON.parse(fs.readFileSync(prefsFile(userId), 'utf-8'));
    return {
      provider: p.provider || 'local',
      model: p.model || '',
      providerKeys: p.providerKeys || {},
      theme: p.theme || 'mantis',
      ollamaUrl: p.ollamaUrl || getConfig().ollamaUrl,
    };
  } catch {
    return {
      provider: 'local',
      model: '',
      providerKeys: {},
      theme: getConfig().adminTheme || 'mantis',
      ollamaUrl: getConfig().ollamaUrl,
    };
  }
}

export function saveUserPrefs(userId, updates) {
  const next = { ...getUserPrefs(userId), ...updates };
  fs.writeFileSync(prefsFile(userId), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

/** List known users (those with a directory). */
export function listUsers() {
  try {
    return fs.readdirSync(USERS_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}
