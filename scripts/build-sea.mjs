#!/usr/bin/env node
/**
 * Build a single-executable Mantis CLI using Node 22 SEA.
 *
 * Steps (in order):
 *   1. esbuild  →  dist/mantis.bundle.cjs   (CJS, all deps inlined)
 *   2. node --experimental-sea-config  →  dist/sea-prep.blob
 *   3. copy host node binary →  dist/release/mantis(.exe)
 *   4. postject the blob into the binary
 *   5. copy admin.html / shared.html / src/assets/ next to the binary
 *
 * Output layout (the thing CI ships):
 *   dist/release/
 *     mantis(.exe)
 *     admin.html
 *     shared.html
 *     assets/...
 *
 * Run:  node scripts/build-sea.mjs
 * Needs: esbuild + postject (added as devDeps in package.json).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(DIST, 'release');
const PLATFORM = process.platform;          // 'win32' | 'darwin' | 'linux'
const EXE = PLATFORM === 'win32' ? '.exe' : '';
const BIN_NAME = `mantis${EXE}`;
const BIN_OUT = path.join(RELEASE, BIN_NAME);

function step(msg) { console.log(`\n▶ ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function die(msg, code = 1) { console.error(`\n✗ ${msg}\n`); process.exit(code); }

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  // shell:true breaks on Windows when the command path contains spaces (e.g.
  // C:\Program Files\nodejs\node.exe). Use shell only for `npx`, which is a
  // .cmd shim on Windows and needs the shell to be resolvable.
  const needsShell = PLATFORM === 'win32' && cmd === 'npx';
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: needsShell, ...opts });
  if (r.status !== 0) die(`${cmd} exited with code ${r.status}`);
}

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) fs.cpSync(src, dest, { recursive: true });
  else fs.copyFileSync(src, dest);
  return true;
}

// ─── 0. Clean ───────────────────────────────────────────────────────
step('Cleaning dist/');
rmrf(DIST);
ensureDir(RELEASE);

// ─── 1. esbuild bundle ──────────────────────────────────────────────
step('Bundling bin/mantis.js → dist/mantis.bundle.cjs (esbuild)');
// External all node:* and the optional native deps that Mantis may load via
// dynamic require. The bundler should NOT try to resolve electron — it's only
// used by the desktop app.
const externals = [
  // Node built-ins are auto-external via --platform=node, but list a few
  // optional/native deps that may appear in transitive trees.
  'electron',
];
const esbuildArgs = [
  'esbuild',
  path.join(ROOT, 'bin/mantis.js'),
  '--bundle',
  '--platform=node',
  '--target=node22',
  '--format=cjs',
  '--legal-comments=none',
  '--outfile=' + path.join(DIST, 'mantis.bundle.cjs'),
  ...externals.map(e => '--external:' + e),
];
run('npx', ['--no-install', ...esbuildArgs]);
ok('bundle written');

// ─── 2. SEA blob ────────────────────────────────────────────────────
step('Generating SEA blob');
run(process.execPath, ['--experimental-sea-config', path.join(ROOT, 'sea-config.json')]);
ok('blob written to dist/sea-prep.blob');

// ─── 3. Copy host node binary ───────────────────────────────────────
step(`Copying host node binary → ${BIN_OUT}`);
fs.copyFileSync(process.execPath, BIN_OUT);
if (PLATFORM !== 'win32') fs.chmodSync(BIN_OUT, 0o755);
ok('binary copied');

// macOS only: strip the existing signature before postject, re-sign after.
if (PLATFORM === 'darwin') {
  step('Stripping macOS code signature (will re-sign ad-hoc after postject)');
  run('codesign', ['--remove-signature', BIN_OUT]);
}

// Windows only: optionally strip signature with signtool if present. We skip
// that — postject overwrites the section and Windows tolerates the now-broken
// signature for unsigned distribution. SmartScreen will still warn.

// ─── 4. postject ────────────────────────────────────────────────────
step('Injecting SEA blob into the binary (postject)');
const blob = path.join(DIST, 'sea-prep.blob');
const postjectArgs = [
  'postject',
  BIN_OUT,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (PLATFORM === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run('npx', ['--no-install', ...postjectArgs]);
ok('blob injected');

if (PLATFORM === 'darwin') {
  step('Re-signing macOS binary ad-hoc');
  run('codesign', ['--sign', '-', BIN_OUT]);
}

// ─── 5. Copy sidecar assets ─────────────────────────────────────────
step('Copying admin.html, shared.html, assets/ next to the binary');
copyIfExists(path.join(ROOT, 'src/admin.html'),  path.join(RELEASE, 'admin.html'));
copyIfExists(path.join(ROOT, 'src/shared.html'), path.join(RELEASE, 'shared.html'));
copyIfExists(path.join(ROOT, 'src/assets'),      path.join(RELEASE, 'assets'));
ok('sidecar files copied');

// ─── done ───────────────────────────────────────────────────────────
const size = (fs.statSync(BIN_OUT).size / 1024 / 1024).toFixed(1);
console.log(`\nDONE → ${BIN_OUT} (${size} MB)`);
console.log(`Release folder: ${RELEASE}\n`);
