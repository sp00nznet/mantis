# Proxy & Admin UI

Mantis can run as an **Anthropic-compatible proxy server**. It speaks the
Anthropic Messages API, translates each request to the OpenAI chat-completions
format, and routes it to one of your configured providers.

That means the real **Claude Code CLI**, the **VS Code extension**, and
**JetBrains** can all run on Mantis's 22-provider pool — including free and local
models.

---

## Quick start

```bash
mantis serve
```

```
  [proxy 12:00:00] listening on http://127.0.0.1:8787
  [proxy 12:00:00] point a client at it:  ANTHROPIC_BASE_URL=http://127.0.0.1:8787
  [proxy 12:00:00] admin UI: http://127.0.0.1:8787/admin
```

Then point any Anthropic client at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

For VS Code / JetBrains, set the `ANTHROPIC_BASE_URL` environment variable (and,
if the client insists on one, any non-empty `ANTHROPIC_API_KEY` — the proxy
ignores it and uses your Mantis provider keys).

You can also start it from inside the REPL with `/proxy`, and stop it with
`/proxy stop`.

---

## Tier routing

Anthropic clients ask for models by name — `claude-opus-4-…`,
`claude-sonnet-4-…`, `claude-3-5-haiku-…`. Mantis maps each to a **tier** and
routes that tier independently:

| Requested model contains | Tier | Routes to |
|--------------------------|------|-----------|
| `opus` | `opus` | `proxy.routes.opus` |
| `sonnet` | `sonnet` | `proxy.routes.sonnet` |
| `haiku` | `haiku` | `proxy.routes.haiku` |
| anything else | `default` | `proxy.routes.default` |

Each route is `{ provider, model }`:

- `provider: null` → use the **active provider** (`config.provider`).
- `model: null` → use that provider's default model.

So you can send Opus traffic to Claude, Sonnet to Groq, and Haiku to a local
model — or point everything at one cheap provider.

Configure routes in the [admin UI](#admin-ui) or directly in
`~/.mantis/config.json`:

```json
{
  "proxy": {
    "port": 8787,
    "host": "127.0.0.1",
    "answerProbes": true,
    "routes": {
      "opus":    { "provider": "anthropic", "model": null },
      "sonnet":  { "provider": "groq",      "model": "qwen/qwen3-32b" },
      "haiku":   { "provider": "local",     "model": null },
      "default": { "provider": null,        "model": null }
    }
  }
}
```

> Port/host changes take effect the next time the proxy starts.

---

## Probe short-circuit

Claude Code fires small "probe" requests — connectivity checks, quota pings,
1-token warm-ups — that don't need a real model. With `proxy.answerProbes` on
(the default), Mantis answers these locally and never forwards them, saving
latency and provider quota.

Only unambiguously trivial requests are short-circuited:

- requests with `max_tokens ≤ 1`
- a lone user turn whose entire content is `quota`, `ping`, or `test`

Anything that could carry real meaning is always forwarded. Set
`proxy.answerProbes` to `false` to disable it entirely.

---

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/messages` | Anthropic Messages API — streaming and non-streaming |
| `POST /v1/messages/count_tokens` | Token estimate |
| `GET /v1/models` | Model catalogue for client model pickers |
| `GET /admin` | Admin UI (loopback only) |
| `GET /health` | Liveness check |

The proxy translates both directions: system prompts, multi-turn history, tool
definitions, `tool_use` / `tool_result` blocks, images, and streaming SSE
(`message_start` → `content_block_delta` → `message_stop`).

---

## Admin UI

A loopback-only web panel for managing Mantis without editing `config.json` or
memorising slash commands.

```bash
mantis admin            # standalone, default http://127.0.0.1:8788/admin
```

It's also mounted on the proxy — when `mantis serve` is running, open
`http://127.0.0.1:8787/admin`. From the REPL, `/admin` starts the standalone
server.

The panel has a left-nav layout and opens on **Sessions**:

- **Sessions** — live agent terminals (see below)
- **Providers** — set the active provider/model; add, **test**, or **delete**
  API keys for any provider
- **Proxy** — tier routing and the probe toggle
- **Bots** — Telegram / Discord tokens
- **Settings** — general config (Ollama URL, context window, compaction
  threshold, timeouts) and swarm settings (lead provider, parallel workers,
  best-of-N, and the provider pool)

By default access is restricted to `localhost` — requests from any other
address get a `403`. To reach the panel from another device (including a
phone), enable **sign-in**, which makes network access safe and gives every
account its own isolated workspace. See [Sign-in & Multi-user](auth.md).

### Sessions tab

The Sessions tab runs Mantis agents **inside the browser**, rendered in real
xterm.js terminals:

- **+ New** spawns a fresh agent session in a directory you choose. Type a
  message, press Enter, and it works the task with all tools enabled
  (auto-approved, like autonomous mode).
- **Grid view** shows every session's terminal at once — handy for watching
  several agents in parallel.
- Each session has its own conversation; delete one with the ✕ on its chip.

### Sharing a REPL session — `/remote`

Run `/remote` inside an interactive Mantis session to expose it to the admin
panel. It starts the admin server (if needed) and registers the live REPL as a
session — the browser can **watch its output stream and send it input**. Stop
sharing with `/remote stop`.

> Sessions share one process and one working directory. Running sessions in
> different directories at the same time can race on the cwd — keep concurrent
> sessions in the same project, or run them one at a time.

---

## What's not supported

The proxy targets the parts of the Anthropic API that coding clients actually
use. It does **not** implement:

- Anthropic-native prompt caching or extended thinking (the underlying providers
  are OpenAI-compatible and don't expose these)
- the Batches or Files APIs
- server-side tools (web search, code execution) — client-defined tools work
  fine

Tool calling, streaming, images, and multi-turn conversations all work.

---

## Security

The proxy and admin server bind to `127.0.0.1` by default. If you change
`proxy.host` to expose it on a network, anyone who can reach it can spend your
provider quota — put it behind a firewall or reverse proxy with auth.

The admin UI refuses non-loopback requests **unless sign-in is enabled** — see
[Sign-in & Multi-user](auth.md). With sign-in on, it binds to the network and
requires a valid session (local account or Google) per request.
