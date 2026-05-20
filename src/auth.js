/**
 * Google OAuth (authorization-code / redirect flow) and Mantis sessions.
 *
 * Dormant until config.google.clientId + clientSecret are set. Once they are,
 * the admin panel and desktop app require a Google sign-in and namespace data
 * per account (see users.js).
 *
 * The id_token is received directly from Google's token endpoint over TLS, so
 * its claims are trusted without re-verifying the JWT signature.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfig, getConfigDir } from './config.js';

const SESSIONS_FILE = path.join(getConfigDir(), 'auth-sessions.json');
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 days

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

export const COOKIE_NAME = 'mantis_session';

/** True when sign-in is turned on (local accounts and/or Google). */
export function isAuthEnabled() {
  return getConfig().auth?.enabled === true;
}

/** True when Google OAuth credentials are configured (an optional add-on). */
export function isGoogleConfigured() {
  const g = getConfig().google || {};
  return !!(g.clientId && g.clientSecret);
}

// ─── Session token store ────────────────────────────────────────────

function readSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')); }
  catch { return {}; }
}
function writeSessions(s) {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2), 'utf-8'); }
  catch { /* ignore */ }
}
function prune(s) {
  const now = Date.now();
  let changed = false;
  for (const [tok, sess] of Object.entries(s)) {
    if (!sess || now - (sess.createdAt || 0) > SESSION_TTL) { delete s[tok]; changed = true; }
  }
  return changed;
}

/** Create a Mantis session for a signed-in user; returns the opaque token. */
export function createSession(user) {
  const s = readSessions();
  prune(s);
  const token = crypto.randomBytes(24).toString('hex');
  s[token] = {
    userId: user.userId,
    email: user.email || '',
    name: user.name || '',
    picture: user.picture || '',
    role: user.role === 'admin' ? 'admin' : 'user',
    createdAt: Date.now(),
  };
  writeSessions(s);
  return token;
}

/** Resolve a session token to its user record, or null. */
export function getSession(token) {
  if (!token) return null;
  const s = readSessions();
  if (prune(s)) writeSessions(s);
  return s[token] || null;
}

export function destroySession(token) {
  if (!token) return;
  const s = readSessions();
  if (s[token]) { delete s[token]; writeSessions(s); }
}

// ─── Google OAuth ───────────────────────────────────────────────────

/** The Google consent URL to redirect a user to. */
export function loginUrl(redirectUri, state) {
  const g = getConfig().google;
  const p = new URLSearchParams({
    client_id: g.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });
  if (state) p.set('state', state);
  return GOOGLE_AUTH + '?' + p.toString();
}

function decodeJwtPayload(jwt) {
  const part = String(jwt).split('.')[1] || '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
}

/**
 * Exchange an authorization code for the user's Google profile.
 * @returns {Promise<{user:object}|{error:string}>}
 */
export async function exchangeCode(code, redirectUri) {
  const g = getConfig().google;
  const body = new URLSearchParams({
    code,
    client_id: g.clientId,
    client_secret: g.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  let r;
  try {
    r = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    return { error: 'Could not reach Google: ' + err.message };
  }
  if (!r.ok) {
    let t = ''; try { t = await r.text(); } catch { /* ignore */ }
    return { error: `Token exchange failed (HTTP ${r.status}) ${t.slice(0, 200)}` };
  }
  const tok = await r.json();
  if (!tok.id_token) return { error: 'Google response had no id_token' };
  let claims;
  try { claims = decodeJwtPayload(tok.id_token); }
  catch { return { error: 'Could not decode the Google id_token' }; }
  if (!claims.sub) return { error: 'Google id_token had no subject' };
  return {
    user: {
      userId: claims.sub,
      email: claims.email || '',
      name: claims.name || claims.email || 'User',
      picture: claims.picture || '',
    },
  };
}

// ─── Cookies ────────────────────────────────────────────────────────

/** Read a named cookie from a request's Cookie header. */
export function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL / 1000);
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
