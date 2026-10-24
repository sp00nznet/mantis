/**
 * Per-provider usage for the proxy: one line per upstream request in ~/.mantis/usage.jsonl, and a
 * summary at GET /usage so a dashboard can show how much of each free tier is gone.
 *
 * Free tiers don't offer a usage API, so counting our own requests is the only number every provider
 * has. Where a provider sends `x-ratelimit-*` headers (Groq does), the latest ones are kept too: those
 * are the provider's own "remaining" figures. They live in memory, so they reappear on the next request
 * after a restart. The summary names providers and where their keys are, never the keys.
 */
import fs from 'fs';
import path from 'path';
import { getConfig, getConfigDir } from './config.js';

const file = () => path.join(getConfigDir(), 'usage.jsonl');
const limits = {};  // provider -> { at, ...latest x-ratelimit-* headers }

export function recordUsage(provider, model, tier, usage, headers, ok = true) {
  const lim = {};
  headers?.forEach?.((v, k) => { if (k.startsWith('x-ratelimit-')) lim[k.slice('x-ratelimit-'.length)] = v; });
  if (Object.keys(lim).length) limits[provider] = { at: new Date().toISOString(), ...lim };
  const row = { t: Date.now(), p: provider, m: model, tier, in: usage?.prompt_tokens ?? 0, out: usage?.completion_tokens ?? 0, ok };
  try { fs.appendFileSync(file(), JSON.stringify(row) + '\n'); } catch { /* usage is best-effort */ }
}

/** Providers with a key (server-wide or in an account) or with traffic this week, and their counts. */
export function usageSummary() {
  const cfg = getConfig();
  const week = Date.now() - 7 * 864e5;
  const midnight = new Date().setHours(0, 0, 0, 0);
  let rows = [];
  try {
    rows = fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.t >= week);
  } catch { /* no traffic yet */ }

  const keys = {};  // provider -> ['server', 'account']
  const add = (obj, where) => { for (const [k, v] of Object.entries(obj || {})) if (v) (keys[k] ||= new Set()).add(where); };
  add(cfg.providerKeys, 'server');
  const users = path.join(getConfigDir(), 'users');
  try {
    for (const u of fs.readdirSync(users)) {
      try { add(JSON.parse(fs.readFileSync(path.join(users, u, 'prefs.json'), 'utf8')).providerKeys, 'account'); } catch { /* no prefs */ }
    }
  } catch { /* sign-in off */ }

  const routes = cfg.proxy?.routes || {};
  const sum = xs => ({ requests: xs.length, errors: xs.filter(r => !r.ok).length,
                       in: xs.reduce((a, r) => a + r.in, 0), out: xs.reduce((a, r) => a + r.out, 0) });
  const providers = {};
  for (const k of new Set([...Object.keys(keys), ...rows.map(r => r.p)])) {
    const mine = rows.filter(r => r.p === k);
    providers[k] = {
      keys: [...(keys[k] || [])],
      routes: Object.entries(routes).filter(([, r]) => (r.provider || cfg.provider) === k).map(([t]) => t),
      today: sum(mine.filter(r => r.t >= midnight)),
      week: sum(mine),
      limits: limits[k] || null,
    };
  }
  return { at: new Date().toISOString(), routes, providers };
}
