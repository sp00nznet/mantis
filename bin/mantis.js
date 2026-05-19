#!/usr/bin/env node

import { loadConfig } from '../src/config.js';

function printUsage() {
  console.log(`
  Mantis — agentic coding CLI

  Usage:
    mantis                   Start the interactive REPL
    mantis serve             Start the Anthropic-compatible proxy server
    mantis admin             Start the admin web UI
    mantis bot telegram      Run the Telegram bot
    mantis bot discord       Run the Discord bot
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
      await startProxy();
      break;
    }

    case 'admin': {
      loadConfig();
      const { startAdmin } = await import('../src/admin.js');
      await startAdmin();
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
