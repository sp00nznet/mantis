// Smoke test for Phase 2: FTS session search.
// Uses a throwaway MANTIS_HOME so it never touches real data.
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmp = path.join(os.tmpdir(), 'mantis-search-test-' + Date.now().toString(36));
fs.mkdirSync(tmp, { recursive: true });
process.env.MANTIS_HOME = tmp;

const { searchAvailable, searchError, indexSession, search, count, removeSession, reindexAll, close } =
  await import('../src/search.js');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name); }
};

check('search available (node:sqlite present)', searchAvailable());
if (!searchAvailable()) {
  console.log('  search unavailable:', searchError());
  process.exit(1);
}

// Index two sessions.
indexSession({
  source: 'hub', sessionId: 's1', title: 'Auth refactor',
  messages: [
    { role: 'user', content: 'Refactor the OAuth login flow to support PKCE' },
    { role: 'assistant', content: 'I updated the token exchange to use a code verifier.' },
  ],
  ts: 1000,
});
indexSession({
  source: 'desktop', sessionId: 'c9', title: 'Bug hunt',
  messages: [
    { role: 'user', content: 'The websocket keeps disconnecting after 30 seconds' },
    { role: 'assistant', content: 'Added a heartbeat ping to keep the gateway connection alive.' },
  ],
  ts: 2000,
});

check('count reflects inserts', count() === 4);

const r1 = search('PKCE oauth');
check('finds oauth session', r1.length > 0 && r1[0].sessionId === 's1');
check('result carries snippet', typeof r1[0].snippet === 'string' && r1[0].snippet.includes('PKCE'));

const r2 = search('websocket heartbeat');
check('finds websocket session', r2.some((r) => r.sessionId === 'c9'));

const r3 = search('websocket', { source: 'hub' });
check('source filter excludes desktop', !r3.some((r) => r.sessionId === 'c9'));

// Re-indexing the same session replaces, not duplicates.
indexSession({
  source: 'hub', sessionId: 's1', title: 'Auth refactor',
  messages: [{ role: 'user', content: 'Refactor the OAuth login flow to support PKCE' }],
  ts: 1000,
});
check('re-index replaces (no dupes)', count() === 3);

// Transcript fallback when no structured messages.
indexSession({
  source: 'hub', sessionId: 's2', title: 'Swarm run',
  messages: [],
  transcript: '\x1b[32m⚡ pool ready\x1b[0m\nworker explored the migration scripts',
  ts: 3000,
});
const r4 = search('migration scripts');
check('transcript fallback indexed + ansi stripped', r4.some((r) => r.sessionId === 's2' && !r.snippet.includes('\x1b')));

// Removal.
removeSession('hub', 's1');
check('removeSession drops rows', search('PKCE').length === 0);

// Empty / junk queries are safe.
check('empty query returns nothing', search('   ').length === 0);
check('punctuation-only query safe', search('!!! "" *').length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
