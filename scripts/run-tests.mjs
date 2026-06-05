// Runs every scripts/test-*.mjs smoke test in its own process and aggregates
// the results. Wired to `npm test`.
import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .sort();

let failed = 0;
for (const f of files) {
  process.stdout.write(`\n=== ${f} ===\n`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

process.stdout.write(`\n${files.length - failed}/${files.length} test files passed.\n`);
process.exit(failed ? 1 : 0);
