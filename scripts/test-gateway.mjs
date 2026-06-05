// Phase 5 test: gateway session persistence, restore, and rehydrate-on-evict.
import os from 'os'; import path from 'path'; import fs from 'fs';

const home = path.join(os.tmpdir(), 'mantis-gw-' + Date.now().toString(36));
fs.mkdirSync(home, { recursive: true });
process.env.MANTIS_HOME = home;

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || '_';
const file = (plat, id) => path.join(home, 'gateway-sessions', sanitize(plat), sanitize(id) + '.json');
function writePersisted(plat, id, messages) {
  const f = file(plat, id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ platform: plat, chatId: String(id), updatedAt: 1, messages }));
}

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const { loadConfig } = await import('../src/config.js');
loadConfig();
const gw = await import('../src/gateway.js');

// --- 1. Restore history on first access ---
const hist = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'fix the build' },
  { role: 'assistant', content: 'fixed it' },
];
writePersisted('telegram', 555, hist);
const s = gw.gatewaySession('telegram', 555);
check('restores persisted history', eq(s.getMessages(), hist));

// --- 2. Same key returns the same live object ---
check('same key -> same session', gw.gatewaySession('telegram', 555) === s);

// --- 3. clear() persists (empties on disk) ---
s.clear();
const afterClear = JSON.parse(fs.readFileSync(file('telegram', 555), 'utf-8'));
check('clear persisted to disk', Array.isArray(afterClear.messages) && afterClear.messages.length === 0);
check('clear emptied in memory', s.getMessages().length === 0);

// --- 4. Rehydrate after eviction (the hibernation path) ---
writePersisted('discord', 999, hist);
const a = gw.gatewaySession('discord', 999);
check('discord session restored', eq(a.getMessages(), hist));
check('eviction returns true', gw.evictGatewaySession('discord', 999) === true);
const b = gw.gatewaySession('discord', 999);
check('post-evict is a fresh object', a !== b);
check('post-evict rehydrates from disk', eq(b.getMessages(), hist));

// --- 5. Negative telegram group id is filename-safe ---
const neg = gw.gatewaySession('telegram', -1001234567);
neg.clear(); // force a persist
check('negative id persisted without throwing', fs.existsSync(file('telegram', -1001234567)));

// --- 6. Distinct chats are isolated ---
check('distinct chats -> distinct sessions',
  gw.gatewaySession('telegram', 1) !== gw.gatewaySession('telegram', 2));

// --- 7. count reflects live registry ---
check('session count > 0', gw.gatewaySessionCount() > 0);

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
