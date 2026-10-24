// Smoke test for src/usage.js: the proxy's per-provider counts behind GET /usage.
import os from 'os'; import path from 'path'; import fs from 'fs';

const home = path.join(os.tmpdir(), 'mantis-usage-' + Date.now().toString(36));
fs.mkdirSync(home, { recursive: true });
process.env.MANTIS_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const { getConfigDir } = await import('../src/config.js');
const { recordUsage, usageSummary } = await import('../src/usage.js');
fs.mkdirSync(path.join(getConfigDir(), 'users', 'u1'), { recursive: true });
fs.writeFileSync(path.join(getConfigDir(), 'users', 'u1', 'prefs.json'), JSON.stringify({ providerKeys: { gemini: 'secret-key' } }));

recordUsage('groq', 'm', 'haiku', { prompt_tokens: 10, completion_tokens: 5 }, new Map([['x-ratelimit-remaining-requests', '14399']]));
recordUsage('groq', 'm', 'haiku', null, new Map(), false);
const s = usageSummary();
check('groq counts today', s.providers.groq.today.requests === 2 && s.providers.groq.today.errors === 1);
check('groq tokens', s.providers.groq.today.in === 10 && s.providers.groq.today.out === 5);
check('groq rate-limit headers kept', s.providers.groq.limits['remaining-requests'] === '14399');
check('account key listed by name', s.providers.gemini?.keys.includes('account'));
check('no key values in the summary', !JSON.stringify(s).includes('secret-key'));

fs.rmSync(home, { recursive: true, force: true });
console.log(`\nusage: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
