// Integration test for Phase 2: on-disk backfill + search_memory tool path.
import os from 'os'; import path from 'path'; import fs from 'fs';
const tmp = path.join(os.tmpdir(), 'mantis-int-' + Date.now().toString(36));
fs.mkdirSync(path.join(tmp, 'hub-sessions'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'memory'), { recursive: true });
process.env.MANTIS_HOME = tmp;

fs.writeFileSync(path.join(tmp, 'hub-sessions', 's1.json'), JSON.stringify({
  id: 's1', name: 'Proxy work', scrollback: '', createdAt: 1,
  messages: [
    { role: 'user', content: 'add rate limiting to the anthropic proxy' },
    { role: 'assistant', content: 'done, added a token bucket' },
  ],
}));
fs.writeFileSync(path.join(tmp, 'sessions', 'c1.json'), JSON.stringify({
  id: 'c1', title: 'Electron build', updatedAt: 2,
  messages: [
    { role: 'user', content: 'the dmg is not ULFO compressed' },
    { role: 'assistant', content: 'set compression to ULFO in electron-builder' },
  ],
}));
fs.writeFileSync(path.join(tmp, 'memory', 'MEMORY.md'), '# Memory\nThe swarm pool is fireworks, groq, cerebras.');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const search = await import('../src/search.js');
const r = search.reindexAll();
check('reindex hub=1 desktop=1 memory=1', r.hub === 1 && r.desktop === 1 && r.memory === 1);
check('count = 5 docs', search.count() === 5);

const { executeTool } = await import('../src/tools.js');
const out1 = await executeTool('search_memory', { query: 'anthropic proxy rate limit' });
check('tool finds proxy session', /Proxy work/.test(out1) && /token bucket|rate limit/i.test(out1));
const out2 = await executeTool('search_memory', { query: 'ULFO compression dmg' });
check('tool finds electron chat', /Electron build/.test(out2));
const out3 = await executeTool('search_memory', { query: 'swarm pool providers fireworks' });
check('tool finds memory doc', /MEMORY\.md/.test(out3));
const out4 = await executeTool('search_memory', { query: 'nonexistent quux zzz' });
check('tool reports no matches', /No matches/.test(out4));

console.log('\nsample output:\n' + out1);
console.log(`\n${pass} passed, ${fail} failed`);
search.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
