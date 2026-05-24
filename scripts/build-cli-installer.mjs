#!/usr/bin/env node
/**
 * Build a native CLI installer for the host OS. Expects build-sea.mjs to
 * have already produced dist/release/{mantis(.exe), admin.html, shared.html,
 * assets/}.
 *
 *   Windows  →  dist/Mantis-CLI-Setup-<version>.exe        (NSIS, PATH entry)
 *   macOS    →  dist/Mantis-CLI-<version>.pkg              (pkgbuild + /usr/local/bin symlink)
 *   Linux    →  dist/mantis-cli_<version>_amd64.deb        (dpkg-deb + /usr/local/bin symlink)
 *
 * Runner deps:
 *   Windows : NSIS 3.x — `winget install NSIS.NSIS` or `choco install nsis`
 *   macOS   : pkgbuild + productbuild (built in)
 *   Linux   : dpkg-deb + fakeroot — `sudo apt install -y dpkg fakeroot`
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(DIST, 'release');
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const VERSION = PKG_JSON.version || '0.0.0';
const PLATFORM = process.platform;

function step(msg)   { console.log(`\n▶ ${msg}`); }
function ok(msg)     { console.log(`  ✓ ${msg}`); }
function die(msg)    { console.error(`\n✗ ${msg}\n`); process.exit(1); }

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) die(`${cmd} exited with code ${r.status}`);
}

function which(cmd) {
  const r = spawnSync(PLATFORM === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

if (!fs.existsSync(path.join(RELEASE, PLATFORM === 'win32' ? 'mantis.exe' : 'mantis'))) {
  die(`No SEA build found in ${RELEASE}. Run \`npm run build:sea\` first.`);
}

// ─── Windows: NSIS ──────────────────────────────────────────────────
if (PLATFORM === 'win32') {
  let makensis = which('makensis');

  // Fallback chain when makensis isn't on PATH (typical CI runner):
  //   1. electron-builder's cache  (gets populated when desktop is built)
  //   2. download portable NSIS into dist/.nsis-portable/
  if (!makensis) {
    step('makensis not on PATH — looking for a fallback');
    const ebCache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache/nsis');
    if (fs.existsSync(ebCache)) {
      const dirs = fs.readdirSync(ebCache).filter(d => d.toLowerCase().startsWith('nsis-'));
      for (const d of dirs) {
        const candidate = path.join(ebCache, d, 'Bin', 'makensis.exe');
        if (fs.existsSync(candidate)) { makensis = candidate; break; }
      }
      if (makensis) ok(`found electron-builder NSIS: ${makensis}`);
    }
  }

  if (!makensis) {
    step('Downloading portable NSIS');
    const portableDir = path.join(DIST, '.nsis-portable');
    fs.mkdirSync(portableDir, { recursive: true });
    const zip = path.join(portableDir, 'nsis.zip');
    // NSIS 3.10 portable build hosted by electron-builder's binaries repo.
    const url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.3/nsis-3.0.4.3.7z';
    // 7z is a pain to extract without 7z installed. Use the prebuilt NSIS
    // .exe portable from Sourceforge instead — but that requires unzip…
    // Simplest cross-shell option: use PowerShell + .NET to download and
    // expand a .zip. Use NSIS Portable v3.10 from a clean zip mirror.
    const zipUrl = 'https://github.com/idleberg/NSIS-Portable/releases/download/v3.10/NSIS-Portable.zip';
    run('powershell', ['-NoProfile', '-Command',
      `Invoke-WebRequest -Uri '${zipUrl}' -OutFile '${zip}'; Expand-Archive -Path '${zip}' -DestinationPath '${portableDir}' -Force`,
    ]);
    // The portable zip extracts to portableDir/NSIS-Portable/App/NSIS/makensis.exe
    const candidates = [
      path.join(portableDir, 'NSIS-Portable', 'App', 'NSIS', 'makensis.exe'),
      path.join(portableDir, 'App', 'NSIS', 'makensis.exe'),
      path.join(portableDir, 'NSIS', 'makensis.exe'),
      path.join(portableDir, 'makensis.exe'),
    ];
    makensis = candidates.find(p => fs.existsSync(p));
    if (!makensis) {
      // Last resort: walk to find it.
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { const f = walk(p); if (f) return f; }
          else if (e.name.toLowerCase() === 'makensis.exe') return p;
        }
        return null;
      };
      makensis = walk(portableDir);
    }
    if (!makensis) die('Could not locate makensis.exe after extracting portable NSIS.');
    ok(`portable NSIS extracted at ${makensis}`);
  }

  const outFile = path.join(DIST, `Mantis-CLI-Setup-${VERSION}.exe`);
  const nsi = path.join(ROOT, 'scripts/installer/mantis.nsi');
  step(`Building NSIS installer → ${outFile}`);
  run(makensis, [
    `/DVERSION=${VERSION}`,
    `/DSRC_DIR=${RELEASE}`,
    `/DOUT_FILE=${outFile}`,
    nsi,
  ]);
  if (!fs.existsSync(outFile)) die('makensis exited 0 but no installer produced.');
  const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`\nDONE → ${outFile} (${mb} MB)\n`);
  process.exit(0);
}

// ─── macOS: pkgbuild + productbuild ─────────────────────────────────
if (PLATFORM === 'darwin') {
  if (!which('pkgbuild')) die('pkgbuild not found. macOS CLT must be installed: `xcode-select --install`.');
  const stage = path.join(DIST, 'pkg-root');
  const scripts = path.join(DIST, 'pkg-scripts');
  const installLocation = '/usr/local/share/mantis';
  fs.rmSync(stage,   { recursive: true, force: true });
  fs.rmSync(scripts, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, installLocation.slice(1)), { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });

  step('Staging files');
  fs.cpSync(RELEASE, path.join(stage, installLocation.slice(1)), { recursive: true });
  ok('staged at ' + path.join(stage, installLocation.slice(1)));

  // Postinstall: create symlink in /usr/local/bin so `mantis` is on PATH.
  fs.writeFileSync(path.join(scripts, 'postinstall'),
    [
      '#!/bin/sh',
      'set -e',
      'mkdir -p /usr/local/bin',
      `ln -sf ${installLocation}/mantis /usr/local/bin/mantis`,
      `chmod 0755 ${installLocation}/mantis`,
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 });

  const componentPkg = path.join(DIST, 'mantis-cli-component.pkg');
  const finalPkg = path.join(DIST, `Mantis-CLI-${VERSION}.pkg`);
  step(`Running pkgbuild → ${componentPkg}`);
  run('pkgbuild', [
    '--root', stage,
    '--scripts', scripts,
    '--identifier', 'com.mantis.cli',
    '--version', VERSION,
    '--install-location', '/',
    componentPkg,
  ]);
  ok('component pkg built');

  step(`Wrapping with productbuild → ${finalPkg}`);
  run('productbuild', [
    '--package', componentPkg,
    '--identifier', 'com.mantis.cli',
    '--version', VERSION,
    finalPkg,
  ]);
  const mb = (fs.statSync(finalPkg).size / 1024 / 1024).toFixed(1);
  console.log(`\nDONE → ${finalPkg} (${mb} MB)\n`);
  process.exit(0);
}

// ─── Linux: dpkg-deb ────────────────────────────────────────────────
if (PLATFORM === 'linux') {
  if (!which('dpkg-deb')) die('dpkg-deb not found. Install with: `sudo apt install -y dpkg`.');
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const debRoot = path.join(DIST, `mantis-cli_${VERSION}_${arch}`);
  fs.rmSync(debRoot, { recursive: true, force: true });

  const shareDir = path.join(debRoot, 'usr/local/share/mantis');
  const binDir = path.join(debRoot, 'usr/local/bin');
  const debianDir = path.join(debRoot, 'DEBIAN');
  fs.mkdirSync(shareDir,  { recursive: true });
  fs.mkdirSync(binDir,    { recursive: true });
  fs.mkdirSync(debianDir, { recursive: true });

  step('Staging files');
  fs.cpSync(RELEASE, shareDir, { recursive: true });
  fs.chmodSync(path.join(shareDir, 'mantis'), 0o755);
  // dpkg can't ship dangling symlinks easily; create as a relative link.
  fs.symlinkSync('../share/mantis/mantis', path.join(binDir, 'mantis'));
  ok('staged');

  // Compute Installed-Size in kB (debian field).
  const du = spawnSync('du', ['-sk', debRoot], { encoding: 'utf-8' });
  const installedKb = du.status === 0 ? parseInt(du.stdout.trim().split(/\s+/)[0], 10) : 0;

  fs.writeFileSync(path.join(debianDir, 'control'),
    [
      'Package: mantis-cli',
      `Version: ${VERSION}`,
      `Architecture: ${arch}`,
      'Maintainer: Mantis <noreply@mantis.local>',
      `Installed-Size: ${installedKb}`,
      'Section: devel',
      'Priority: optional',
      'Homepage: https://github.com/sp00nznet/mantis',
      'Description: Mantis — agentic coding CLI',
      ' Local or cloud LLMs, autonomous and swarm modes, Anthropic-compatible',
      ' proxy, chat bots. Single self-contained binary, no Node runtime required.',
    ].join('\n') + '\n');

  const debFile = path.join(DIST, `mantis-cli_${VERSION}_${arch}.deb`);
  step(`Running dpkg-deb → ${debFile}`);
  // -Zxz keeps it small; --root-owner-group avoids fakeroot dependency.
  run('dpkg-deb', ['--build', '--root-owner-group', '-Zxz', debRoot, debFile]);
  const mb = (fs.statSync(debFile).size / 1024 / 1024).toFixed(1);
  console.log(`\nDONE → ${debFile} (${mb} MB)\n`);
  process.exit(0);
}

die(`Unsupported platform: ${PLATFORM}`);
