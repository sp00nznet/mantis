// Phase 6 test: gateway hibernation (idle eviction + rehydrate-on-message).
import os from 'os'; import path from 'path'; import fs from 'fs';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const home = path.join(os.tmpdir(), 'mantis-hib-' + Date.now().toString(36));
fs.mkdirSync(home, { recursive: true });
process.env.MANTIS_HOME = home;

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || '_';
function writePersisted(plat, id, messages) {
  const f = path.join(home, 'gateway-sessions', sanitize(plat), sanitize(id) + '.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ platform: plat, chatId: String(id), updatedAt: 1, messages }));
}

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const { loadConfig } = await import('../src/config.js');
loadConfig();
const gw = await import('../src/gateway.js');

const hist = [{ role: 'user', content: 'remember this thread' }, { role: 'assistant', content: 'noted' }];

// --- 1. A fresh session is not evicted immediately ---
gw.gatewaySession('telegram', 1);
check('no eviction when just used', gw.sweepIdleSessions(100000) === 0);
check('still live', gw.gatewaySessionCount() === 1);

// --- 2. An idle session IS evicted ---
await sleep(10);
const evicted = gw.sweepIdleSessions(1); // idle threshold 1ms
check('idle session evicted', evicted === 1);
check('registry emptied', gw.gatewaySessionCount() === 0);

// --- 3. A busy session is never evicted ---
const busy = gw.gatewaySession('telegram', 2);
busy.isBusy = () => true; // simulate a turn in flight
await sleep(10);
check('busy session survives sweep', gw.sweepIdleSessions(1) === 0);
check('busy session still live', gw.gatewaySessionCount() === 1);

// --- 4. Rehydrate-on-message after eviction ---
writePersisted('discord', 7, hist);
const a = gw.gatewaySession('discord', 7);
check('restored before eviction', eq(a.getMessages(), hist));
await sleep(10);
gw.sweepIdleSessions(1);
// discord/7 should now be gone from memory (busy telegram/2 may remain)
const reborn = gw.gatewaySession('discord', 7);
check('post-sweep is a fresh object', reborn !== a);
check('post-sweep rehydrates from disk', eq(reborn.getMessages(), hist));

// --- 5. Disabled hibernation (idleMs = 0) evicts nothing ---
check('disabled sweep is a no-op', gw.sweepIdleSessions(0) === 0);

// --- 6. gatewayInfo reports policy ---
const info = gw.gatewayInfo();
check('gatewayInfo has live count + policy', typeof info.live === 'number' && 'hibernateIdleMs' in info);

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
