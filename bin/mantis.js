#!/usr/bin/env node

import { loadConfig } from '../src/config.js';

function printUsage() {
  console.log(`
  Mantis — agentic coding CLI

  Usage:
    mantis                   Start the interactive REPL
    mantis run "<task>"      Run one task headlessly (for scripts / CI)
    mantis serve             Start the Anthropic-compatible proxy server
    mantis admin             Start the admin web UI
    mantis service <cmd>     Install/run the admin server at boot (Windows/Linux)
                             cmd: install | uninstall | start | stop | status
    mantis bot telegram      Run the Telegram bot
    mantis bot discord       Run the Discord bot
    mantis auth admin <u> <p>  Create/reset the admin account and enable sign-in
    mantis auth disable      Turn sign-in off (back to single-user)
    mantis auth list         List accounts
    mantis help              Show this message

  The proxy lets the real Claude Code CLI, VS Code, and JetBrains run on
  Mantis's provider pool — point them at it with ANTHROPIC_BASE_URL.
`);
}

async function main() {
  const sub = (process.argv[2] || '').toLowerCase();

  switch (sub) {
    case 'serve':
    case 'proxy': {
      loadConfig();
      const { startProxy } = await import('../src/proxy.js');
      try {
        await startProxy();
      } catch (err) {
        console.error(`  Could not start the proxy: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'admin': {
      loadConfig();
      const { startAdmin } = await import('../src/admin.js');
      try {
        await startAdmin();
      } catch (err) {
        console.error(`  Could not start the admin panel: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'bot': {
      loadConfig();
      const which = (process.argv[3] || '').toLowerCase();
      try {
        if (which === 'telegram') {
          const { startTelegramBot } = await import('../src/bots/telegram.js');
          await startTelegramBot();
        } else if (which === 'discord') {
          const { startDiscordBot } = await import('../src/bots/discord.js');
          await startDiscordBot();
        } else {
          console.error('  Usage: mantis bot <telegram|discord>');
          process.exit(1);
        }
      } catch {
        // startup error — the bot module already printed a friendly reason
        process.exit(1);
      }
      break;
    }

    case 'run': {
      const rest = process.argv.slice(3);
      const opts = { json: false };
      const positional = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--json') opts.json = true;
        else if (a === '--cwd') opts.cwd = rest[++i];
        else if (a === '--provider') opts.provider = rest[++i];
        else if (a === '--model') opts.model = rest[++i];
        else if (a === '--solo' || a === '--no-swarm') opts.solo = true;
        else if (a === '--swarm') opts.swarm = true;
        else if (a === '--agent') opts.agent = rest[++i];
        else positional.push(a);
      }
      const task = positional.join(' ').trim();
      if (!task) {
        console.error('  Usage: mantis run "<task>" [--json] [--cwd <dir>] [--provider <name>] [--model <name>] [--solo|--no-swarm|--swarm] [--agent <id>]');
        process.exit(1);
      }
      const { runHeadless } = await import('../src/headless.js');
      let ok = false;
      try {
        ok = await runHeadless(task, opts);
      } catch (err) {
        console.error(`  Headless run failed: ${err.message}`);
        process.exit(1);
      }
      process.exit(ok ? 0 : 1);
      break;
    }

    case 'auth': {
      loadConfig();
      const accounts = await import('../src/accounts.js');
      const { getConfig, saveConfig } = await import('../src/config.js');
      const action = (process.argv[3] || '').toLowerCase();

      if (action === 'admin') {
        const username = process.argv[4];
        const password = process.argv[5];
        if (!username || !password) {
          console.error('  Usage: mantis auth admin <username> <password>');
          process.exit(1);
        }
        const existing = accounts.findByUsername(username);
        if (existing) {
          const pr = accounts.setPassword(existing.id, password);
          if (pr.error) { console.error('  ' + pr.error); process.exit(1); }
          accounts.setRole(existing.id, 'admin');
          console.log(`  Reset password and granted admin to "${username}".`);
        } else {
          const r = accounts.createAccount({ username, password, role: 'admin' });
          if (r.error) { console.error('  ' + r.error); process.exit(1); }
          console.log(`  Created admin account "${username}".`);
        }
        saveConfig({ auth: { ...getConfig().auth, enabled: true } });
        console.log('  Sign-in is enabled. Restart the admin panel / desktop app.');
      } else if (action === 'disable') {
        saveConfig({ auth: { ...getConfig().auth, enabled: false } });
        console.log('  Sign-in disabled — back to single-user, localhost-only.');
      } else if (action === 'list') {
        const list = accounts.listAccounts();
        if (!list.length) console.log('  No accounts yet.');
        for (const u of list) {
          const tag = u.role === 'admin' ? '[admin]' : '[user] ';
          console.log(`  ${tag} ${u.username}${u.email ? '  <' + u.email + '>' : ''}`);
        }
      } else {
        const on = getConfig().auth?.enabled;
        console.log(`  Sign-in is ${on ? 'ENABLED' : 'disabled'} — ${accounts.accountCount()} account(s).`);
        console.log('  Usage: mantis auth <admin <user> <pass> | disable | list>');
      }
      break;
    }

    case 'approval-bridge': {
      // Internal: the Claude tool-approval MCP bridge. Launched by Mantis itself
      // (see external-agents.selfSpawn) with MANTIS_APPROVAL_URL / MANTIS_TURN in
      // env. Speaks JSON-RPC over stdio — must NOT write anything else to stdout.
      const { runApprovalBridge } = await import('../src/approval-bridge.js');
      runApprovalBridge();
      break;
    }

    case 'service': {
      const { runServiceCommand } = await import('../src/service.js');
      await runServiceCommand(process.argv.slice(3));
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      printUsage();
      break;

    case '': {
      // No subcommand — start the interactive REPL.
      const { startCLI } = await import('../src/cli.js');
      startCLI();
      break;
    }

    default:
      console.error(`  Unknown command: ${sub}`);
      printUsage();
      process.exit(1);
  }
}

main();
