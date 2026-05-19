# Chat Bots

Mantis can run as a **Telegram** or **Discord** bot — send it a coding task from
your phone or a team channel and it works in the project directory, just like the
REPL.

Each chat (Telegram) or channel (Discord) gets its own agent session with its own
conversation history. Tool calls are **auto-approved** — there's no terminal to
confirm at, so a bot session behaves like autonomous mode.

---

## Telegram

### 1. Create a bot

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and
follow the prompts. It gives you a token like `123456:ABC-DEF…`.

### 2. Add the token

In the [admin UI](proxy.md#admin-ui) (`mantis admin`), paste it into the
**Telegram bot token** field — or set it directly in `~/.mantis/config.json`:

```json
{
  "bots": {
    "telegram": { "token": "123456:ABC-DEF...", "allowedUsers": [] }
  }
}
```

### 3. Run it

```bash
mantis bot telegram
```

Now message your bot. It replies in the same chat.

---

## Discord

### 1. Create a bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and create an application.
2. Under **Bot**, copy the token.
3. Under **Bot → Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT**.
   The bot cannot read messages without it.
4. Under **OAuth2 → URL Generator**, select the `bot` scope and the **Send
   Messages** / **Read Message History** permissions, then use the generated URL
   to invite the bot to your server.

### 2. Add the token

Set it in the admin UI, or in `~/.mantis/config.json`:

```json
{
  "bots": {
    "discord": { "token": "YOUR_BOT_TOKEN", "allowedUsers": [] }
  }
}
```

### 3. Run it

```bash
mantis bot discord
```

The Discord bot needs **Node.js 22+** (it uses the built-in `WebSocket`).

### Talking to it

- In a server channel: **@-mention the bot**, e.g. `@mantis fix the failing test`
- In a DM: just send the message directly

---

## In-chat commands

These work in both Telegram and Discord:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Reset the conversation for this chat |
| `/stop` | Cancel the running task |
| `/cwd [path]` | Show or change the working directory |
| `/status` | Session stats — messages, tool calls, context usage |

Any other message is treated as a coding task.

---

## Restricting access

By default **anyone** who can message the bot can use it — and the bot runs real
commands on your machine. Lock it down with `allowedUsers`:

```json
{
  "bots": {
    "telegram": { "token": "...", "allowedUsers": [11111111, 22222222] },
    "discord":  { "token": "...", "allowedUsers": ["33333333"] }
  }
}
```

- **Telegram** — numeric user IDs or chat IDs. An empty list allows everyone.
- **Discord** — user ID strings. An empty list allows everyone.

A request from anyone not on a non-empty list is refused.

> The working directory is shared across all of a bot's sessions and with the
> process it runs in. Run a bot from the project directory you want it to work
> in, and only give the token to people you trust.

---

## Running alongside the REPL

`/bot telegram` and `/bot discord` start a bot from inside the interactive REPL.
Its logs print inline, mixed with the prompt — fine for a quick test, but for a
long-running bot prefer a dedicated terminal:

```bash
mantis bot telegram
```

Exit Mantis (or Ctrl+C) to stop a bot.
