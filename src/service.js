/**
 * `mantis service <install|uninstall|start|stop|status>` — run the admin server
 * unattended at boot so a deployer can "set it and forget it".
 *
 * Windows: a Scheduled Task ("MantisAdmin") that runs at startup as SYSTEM via a
 * generated launcher .cmd (which pins MANTIS_HOME so data doesn't land in the
 * systemprofile), plus an inbound firewall rule for the admin port. We use a
 * Scheduled Task rather than a true SCM service because a plain Node/SEA exe
 * can't do the Service Control Manager handshake without a native wrapper — the
 * task route is dependency-free and works with the single exe. (For a true
 * services.msc entry, point nssm/WinSW at `mantis admin` instead.)
 *
 * Linux: a systemd unit (mantis-admin.service), enabled at boot.
 *
 * All mutating actions need elevation (Administrator / root).
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getConfig } from './config.js';
import { selfSpawn } from './utils.js';

const WIN_TASK = 'MantisAdmin';
const WIN_FW_RULE = 'Mantis Admin';
const LINUX_UNIT = 'mantis-admin.service';

function parseOpts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') o.dataDir = argv[++i];
    else if (argv[i] === '--port') o.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--user') o.user = argv[++i];
  }
  return o;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

// ─── Entry ──────────────────────────────────────────────────────────

export async function runServiceCommand(argv) {
  const action = (argv[0] || '').toLowerCase();
  const opts = parseOpts(argv.slice(1));
  if (!['install', 'uninstall', 'start', 'stop', 'status'].includes(action)) {
    console.log('  Usage: mantis service <install|uninstall|start|stop|status> [--data-dir <path>] [--port <n>]');
    return;
  }
  if (process.platform === 'win32') return windows(action, opts);
  if (process.platform === 'linux') return linux(action, opts);
  console.error('  `mantis service` is supported on Windows and Linux only.');
  process.exit(1);
}

// ─── Windows (Scheduled Task) ───────────────────────────────────────

function winElevated() {
  // `net session` succeeds only when elevated.
  return run('net', ['session']).code === 0;
}

function windows(action, opts) {
  const port = opts.port || getConfig().admin?.port || 8788;

  if (action === 'status') {
    const t = run('schtasks', ['/Query', '/TN', WIN_TASK, '/V', '/FO', 'LIST']);
    if (t.code !== 0) { console.log('  MantisAdmin service: NOT INSTALLED'); return; }
    const status = (t.out.match(/Status:\s*(.+)/) || [])[1] || 'unknown';
    const next = (t.out.match(/Next Run Time:\s*(.+)/) || [])[1] || '';
    console.log(`  MantisAdmin service: INSTALLED (status: ${status.trim()})`);
    if (next.trim()) console.log(`  Next run: ${next.trim()}`);
    console.log(`  Admin port: ${port}`);
    return;
  }

  if (!winElevated()) {
    console.error('  This needs an elevated prompt. Re-run from an Administrator PowerShell/cmd.');
    process.exit(1);
  }

  if (action === 'install') {
    const dataDir = path.resolve(opts.dataDir || path.join(process.env.ProgramData || 'C:\\ProgramData', 'Mantis'));
    fs.mkdirSync(dataDir, { recursive: true });

    // Launcher .cmd: pins MANTIS_HOME, then starts the admin server. Using a
    // file sidesteps all schtasks /TR quoting pitfalls.
    const { command, args } = selfSpawn('admin');
    const cmdLine = [command, ...args].map(q).join(' ');
    const launcher = path.join(dataDir, 'mantis-admin.cmd');
    fs.writeFileSync(launcher,
      '@echo off\r\n' +
      `set "MANTIS_HOME=${dataDir}"\r\n` +
      `${cmdLine}\r\n`, 'utf8');

    const create = run('schtasks', [
      '/Create', '/TN', WIN_TASK, '/TR', launcher,
      '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F',
    ]);
    if (create.code !== 0) { console.error('  Failed to create scheduled task:\n' + create.out); process.exit(1); }

    // Inbound firewall rule for the admin port (idempotent: delete then add).
    run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${WIN_FW_RULE}`]);
    run('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${WIN_FW_RULE}`,
      'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`]);

    // Make manual `mantis` runs on this box use the same data dir.
    run('setx', ['/M', 'MANTIS_HOME', dataDir]);

    console.log('  ✓ Installed MantisAdmin (starts at boot, runs as SYSTEM).');
    console.log(`  ✓ Data dir:     ${dataDir}`);
    console.log(`  ✓ Firewall:     TCP ${port} allowed inbound (rule "${WIN_FW_RULE}").`);
    console.log('  Start now:      mantis service start');
    console.log('  Note: enable sign-in (mantis auth admin <user> <pass>) so it binds to the network.');
    return;
  }

  if (action === 'uninstall') {
    run('schtasks', ['/End', '/TN', WIN_TASK]);
    const del = run('schtasks', ['/Delete', '/TN', WIN_TASK, '/F']);
    run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${WIN_FW_RULE}`]);
    console.log(del.code === 0 ? '  ✓ Removed MantisAdmin service + firewall rule.' : '  MantisAdmin was not installed.');
    console.log('  (Data dir left intact — delete it manually if you want it gone.)');
    return;
  }

  if (action === 'start') {
    const r = run('schtasks', ['/Run', '/TN', WIN_TASK]);
    console.log(r.code === 0 ? '  ✓ MantisAdmin started.' : '  Could not start (is it installed?):\n' + r.out);
    return;
  }
  if (action === 'stop') {
    const r = run('schtasks', ['/End', '/TN', WIN_TASK]);
    console.log(r.code === 0 ? '  ✓ MantisAdmin stopped.' : '  Could not stop:\n' + r.out);
    return;
  }
}

function q(s) { return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s; }

// ─── Linux (systemd) ────────────────────────────────────────────────

function linux(action, opts) {
  const unitPath = `/etc/systemd/system/${LINUX_UNIT}`;
  const port = opts.port || getConfig().admin?.port || 8788;

  if (action === 'status') {
    const r = run('systemctl', ['is-active', LINUX_UNIT]);
    const installed = fs.existsSync(unitPath);
    console.log(`  mantis-admin: ${installed ? 'INSTALLED' : 'NOT INSTALLED'} (${r.out.trim() || 'inactive'})`);
    console.log(`  Admin port: ${port}`);
    return;
  }

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!isRoot) { console.error('  This needs root. Re-run with sudo.'); process.exit(1); }

  if (action === 'install') {
    const dataDir = path.resolve(opts.dataDir || '/var/lib/mantis');
    fs.mkdirSync(dataDir, { recursive: true });
    const { command, args } = selfSpawn('admin');
    const execStart = [command, ...args].map(q).join(' ');
    const user = opts.user || 'root';
    const unit = [
      '[Unit]',
      'Description=Mantis admin server',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `User=${user}`,
      `Environment=MANTIS_HOME=${dataDir}`,
      `ExecStart=${execStart}`,
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');
    fs.writeFileSync(unitPath, unit, 'utf8');
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['enable', LINUX_UNIT]);
    console.log(`  ✓ Installed ${LINUX_UNIT} (enabled at boot).`);
    console.log(`  ✓ Data dir: ${dataDir}`);
    console.log('  Start now:  sudo mantis service start');
    console.log(`  Open the firewall for TCP ${port} yourself (ufw/firewalld) if remote access is needed.`);
    return;
  }
  if (action === 'uninstall') {
    run('systemctl', ['disable', '--now', LINUX_UNIT]);
    try { fs.unlinkSync(unitPath); } catch { /* already gone */ }
    run('systemctl', ['daemon-reload']);
    console.log('  ✓ Removed mantis-admin (data dir left intact).');
    return;
  }
  if (action === 'start') { run('systemctl', ['start', LINUX_UNIT]); console.log('  ✓ started.'); return; }
  if (action === 'stop')  { run('systemctl', ['stop', LINUX_UNIT]);  console.log('  ✓ stopped.'); return; }
}
