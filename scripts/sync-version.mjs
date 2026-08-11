#!/usr/bin/env node
/**
 * Copy the root package.json version into desktop/package.json.
 *
 * electron-builder stamps desktop/package.json's version into every desktop
 * artifact name (`Mantis-Desktop-${version}-...`). Without this the desktop
 * assets ship under a different number than the CLI assets in the same
 * release, which is exactly the sort of thing nobody notices until a user
 * asks which one they're running.
 *
 * Run:  node scripts/sync-version.mjs   (CI does this before `npm run dist:*`)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
const target = path.join(ROOT, 'desktop', 'package.json');
const desktop = JSON.parse(fs.readFileSync(target, 'utf-8'));

if (desktop.version !== version) {
  const was = desktop.version;
  desktop.version = version;
  fs.writeFileSync(target, JSON.stringify(desktop, null, 2) + '\n');
  console.log(`desktop/package.json ${was} → ${version}`);
} else {
  console.log(`desktop/package.json already at ${version}`);
}
