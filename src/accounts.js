/**
 * Local account database.
 *
 * Built-in username/password users plus linked Google accounts, stored at
 * ~/.mantis/accounts.json. Passwords are salted scrypt hashes — no plaintext
 * is ever written. Each account's `id` is also its per-user data-dir name
 * (see users.js), so history/projects/keys follow the account.
 *
 * This is independent of Google: an admin can run the whole multi-user setup
 * with local accounts alone, and add Google sign-in later.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfig, getConfigDir } from './config.js';

const ACCOUNTS_FILE = path.join(getConfigDir(), 'accounts.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8')).accounts || []; }
  catch { return []; }
}
function writeAll(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts }, null, 2), 'utf-8');
}

function genId() { return 'u' + crypto.randomBytes(7).toString('hex'); }

// ─── Passwords (scrypt, no dependencies) ────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  let computed;
  try { computed = crypto.scryptSync(String(password), salt, 64).toString('hex'); }
  catch { return false; }
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A safe, password-free view of an account. */
function publicView(a) {
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName || a.username,
    role: a.role === 'admin' ? 'admin' : 'user',
    email: a.email || '',
    hasPassword: !!a.passwordHash,
    google: !!a.googleSub,
    createdAt: a.createdAt || 0,
    lastLogin: a.lastLogin || 0,
  };
}

// ─── Queries ────────────────────────────────────────────────────────

export function listAccounts() { return readAll().map(publicView); }
export function accountCount() { return readAll().length; }
export function hasAdmin() { return readAll().some(a => a.role === 'admin'); }

export function getAccount(id) {
  const a = readAll().find(x => x.id === id);
  return a ? publicView(a) : null;
}

export function findByUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  return readAll().find(a => (a.username || '').toLowerCase() === u) || null;
}

export function findByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  return readAll().find(a => (a.email || '').toLowerCase() === e) || null;
}

// ─── Mutations ──────────────────────────────────────────────────────

/**
 * Create an account. A password makes it a local login; an email (without a
 * password) makes it a Google-only login the user activates by signing in.
 */
export function createAccount({ username, password, role = 'user', displayName = '', email = '' } = {}) {
  username = String(username || '').trim();
  email = String(email || '').trim();
  const hasPw = password != null && String(password).length > 0;

  if (!username && email) username = email;          // default username to the email
  if (!username) return { error: 'A username or email is required' };
  if (!/^[a-zA-Z0-9._@+-]{2,64}$/.test(username)) {
    return { error: 'Username must be 2–64 chars (letters, numbers, . _ @ + -)' };
  }
  if (findByUsername(username)) return { error: 'That username is already taken' };
  if (email && findByEmail(email)) return { error: 'An account with that email already exists' };
  if (hasPw && String(password).length < 6) return { error: 'Password must be at least 6 characters' };
  if (!hasPw && !email) return { error: 'Set a password, or an email for Google sign-in' };

  const accounts = readAll();
  const pw = hasPw ? hashPassword(password) : { salt: '', hash: '' };
  const acct = {
    id: genId(),
    username,
    displayName: displayName || username,
    role: role === 'admin' ? 'admin' : 'user',
    email,
    passwordSalt: pw.salt,
    passwordHash: pw.hash,
    googleSub: '',
    createdAt: Date.now(),
    lastLogin: 0,
  };
  accounts.push(acct);
  writeAll(accounts);
  return { account: publicView(acct) };
}

/** Verify a username/password login. Returns { account } or { error }. */
export function verifyLogin(username, password) {
  const a = findByUsername(username);
  if (!a || !a.passwordHash || !verifyPassword(password, a.passwordSalt, a.passwordHash)) {
    return { error: 'Invalid username or password' };
  }
  touchLogin(a.id);
  return { account: publicView(a) };
}

export function setPassword(id, password) {
  if (!password || String(password).length < 6) {
    return { error: 'Password must be at least 6 characters' };
  }
  const accounts = readAll();
  const a = accounts.find(x => x.id === id);
  if (!a) return { error: 'No such account' };
  const pw = hashPassword(password);
  a.passwordSalt = pw.salt;
  a.passwordHash = pw.hash;
  writeAll(accounts);
  return { ok: true };
}

export function setRole(id, role) {
  const next = role === 'admin' ? 'admin' : 'user';
  const accounts = readAll();
  const a = accounts.find(x => x.id === id);
  if (!a) return { error: 'No such account' };
  if (a.role === 'admin' && next !== 'admin' &&
      accounts.filter(x => x.role === 'admin').length <= 1) {
    return { error: 'Cannot demote the last administrator' };
  }
  a.role = next;
  writeAll(accounts);
  return { ok: true };
}

export function deleteAccount(id) {
  const accounts = readAll();
  const a = accounts.find(x => x.id === id);
  if (!a) return { error: 'No such account' };
  if (a.role === 'admin' && accounts.filter(x => x.role === 'admin').length <= 1) {
    return { error: 'Cannot delete the last administrator' };
  }
  writeAll(accounts.filter(x => x.id !== id));
  return { ok: true };
}

export function touchLogin(id) {
  const accounts = readAll();
  const a = accounts.find(x => x.id === id);
  if (a) { a.lastLogin = Date.now(); writeAll(accounts); }
}

/**
 * Resolve a Google profile (from auth.exchangeCode) to a local account:
 * link it to an existing account by Google id or email, or auto-provision a
 * new one when config.auth permits (domain allowlist or open signup).
 * @returns {{account:object}|{error:string}}
 */
export function resolveGoogleAccount(profile) {
  const accounts = readAll();
  let a = profile.userId && accounts.find(x => x.googleSub === profile.userId);
  if (!a && profile.email) {
    a = accounts.find(x => (x.email || '').toLowerCase() === profile.email.toLowerCase());
  }
  if (a) {
    a.googleSub = profile.userId;
    if (!a.email) a.email = profile.email || '';
    a.lastLogin = Date.now();
    writeAll(accounts);
    return { account: publicView(a) };
  }

  // No matching account — auto-provision only if the config allows it.
  const cfg = getConfig().auth || {};
  const domain = (profile.email || '').split('@')[1] || '';
  const domains = (cfg.googleDomains || []).map(d => String(d).toLowerCase());
  const allowed = cfg.allowGoogleSignup || (domain && domains.includes(domain.toLowerCase()));
  if (!allowed) {
    return { error: 'This Google account is not authorized. Ask an administrator to add you.' };
  }

  const acct = {
    id: profile.userId || genId(),
    username: profile.email || ('google-' + String(profile.userId).slice(0, 8)),
    displayName: profile.name || profile.email || 'Google user',
    role: 'user',
    email: profile.email || '',
    passwordSalt: '',
    passwordHash: '',
    googleSub: profile.userId || '',
    createdAt: Date.now(),
    lastLogin: Date.now(),
  };
  accounts.push(acct);
  writeAll(accounts);
  return { account: publicView(acct) };
}
