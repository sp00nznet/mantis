# Configuration

Mantis stores its configuration and data at `~/.mantis/` (that's your home directory).

---

## Directory Layout

```
~/.mantis/
├── config.json           # Settings
├── conversations/        # Saved conversation histories
│   ├── auth-refactor.json
│   └── conversation-2026-02-28T...json
└── memory/               # Global persistent memory (MEMORY.md)
```

---

## config.json

Here's the full config with defaults:

```json
{
  "ollamaUrl": "http://localhost:11434",
  "model": "qwen3-coder-cpu",
  "maxContextTokens": 32768,
  "compactThreshold": 0.75,
  "commandTimeout": 60000,
  "maxToolResultSize": 8000,
  "confirmDestructive": true,
  "provider": "local",
  "providerKeys": {},
  "swarm": {
    "leadProvider": null,
    "maxParallelWorkers": 4,
    "excludeProviders": [],
    "bestOfN": 0,
    "providerModels": {}
  },
  "proxy": {
    "port": 8787,
    "host": "127.0.0.1",
    "answerProbes": true,
    "routes": {
      "opus":    { "provider": null, "model": null },
      "sonnet":  { "provider": null, "model": null },
      "haiku":   { "provider": null, "model": null },
      "default": { "provider": null, "model": null }
    }
  },
  "bots": {
    "telegram": { "token": "", "allowedUsers": [] },
    "discord":  { "token": "", "allowedUsers": [] }
  },
  "admin": {
    "port": 8788,
    "host": "127.0.0.1"
  }
}
```

### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ollamaUrl` | string | `http://localhost:11434` | Where Ollama is running. Change if you're running it on another machine or port. |
| `model` | string | `qwen3-coder-cpu` | Which model to use. Can also be changed with `/model` at runtime. |
| `maxContextTokens` | integer | `32768` | Context window size. Should match your model's actual limit. |
| `compactThreshold` | float | `0.75` | Auto-compact when context usage reaches this fraction (0.0–1.0). |
| `commandTimeout` | integer | `60000` | Max time (in ms) for `run_command` before killing the process. Default is 60 seconds. |
| `maxToolResultSize` | integer | `8000` | Max characters returned from any tool. Longer results are truncated. |
| `confirmDestructive` | boolean | `true` | Reserved for future use — will prompt before destructive operations. |
| `provider` | string | `local` | Active provider key. See [Providers](#providers) below. |
| `providerKeys` | object | `{}` | API keys for cloud providers, keyed by provider name. |
| `swarm` | object | — | Swarm-mode settings — see [Swarm Mode](swarm.md#swarm-configuration). |
| `proxy` | object | — | Anthropic-compatible proxy settings — see [Proxy](proxy.md#tier-routing). |
| `bots` | object | — | Telegram / Discord bot tokens — see [Chat Bots](bots.md). |
| `transcription` | object | — | Voice-note transcription — see [Chat Bots](bots.md#voice-notes). |
| `hooks` | object | `{ afterEdit: [] }` | Shell commands run after the agent writes/edits a file. `{file}` is replaced with the path. e.g. `["npx prettier --write {file}"]`. |
| `mcpServers` | object | `{}` | MCP servers whose tools are added to the agent — see [MCP Servers](mcp.md). |
| `imageGen` | object | `{ provider, model }` | Provider/model for the `generate_image` tool. Default OpenAI `gpt-image-1`. |
| `speech` | object | `{ provider, model, voice }` | Provider/model/voice for the `generate_speech` tool. Default OpenAI `gpt-4o-mini-tts`. |
| `admin` | object | — | Admin web UI port and host — see [Proxy & Admin UI](proxy.md#admin-ui). |
| `auth` | object | — | Sign-in / multi-user settings — see [Sign-in & Multi-user](auth.md). |

Nested objects are deep-merged with defaults on load, so an older `config.json`
that predates `proxy`, `hooks`, `mcpServers`, or `auth` still picks up their
default values.

---

## Changing Settings

### Option 1: Edit the file directly

```bash
# Open in your editor
code ~/.mantis/config.json
nano ~/.mantis/config.json
notepad %USERPROFILE%\.mantis\config.json
```

Changes take effect on next Mantis startup.

### Option 2: Use commands inside Mantis

```
> /model deepseek-coder-v2     # change model (takes effect immediately)
> /config                       # view current settings
```

### Option 3: Installer sets initial config

The installer creates `config.json` with the model you chose (CPU/GPU) and sensible defaults.

---

## Providers

Mantis supports 23 providers out of the box. All use the OpenAI-compatible chat completions API, so switching between them is seamless.

### Switching providers

```
> /provider list               # see all 23 providers
> /provider set gemini         # switch to Google Gemini
> /provider key gemini KEY     # set your API key
> /provider test               # verify it works
> /provider show               # show current provider + model
```

### Available providers

The full list of all 23 providers — base URLs, default models, free-tier notes,
and where to get keys — lives in **[Providers](providers.md)**.

### API keys in config

Keys are stored in `providerKeys` in your config file:

```json
{
  "provider": "gemini",
  "providerKeys": {
    "gemini": "AIza...",
    "groq": "gsk_...",
    "openai": "sk-..."
  }
}
```

You can set keys via the CLI (`/provider key <name> <key>`) or by editing the config file directly.

### Using a custom model

Each provider has a default model, but you can override it:

```
> /provider set openai
> /model gpt-4o-mini           # use a cheaper OpenAI model
> /provider set groq
> /model llama-3.3-70b-versatile  # use Llama on Groq
```

Per-provider notes (free tiers, quirks, where to sign up) are in
[Providers](providers.md#notes-on-specific-providers).

---

## Remote Ollama

If you're running Ollama on another machine (like a GPU server on your network):

```json
{
  "ollamaUrl": "http://192.168.1.100:11434"
}
```

This is great if you have a beefy GPU machine but want to run Mantis on your laptop. The model runs on the GPU machine, Mantis runs wherever you're coding.

Make sure Ollama is bound to `0.0.0.0` on the remote machine:
```bash
OLLAMA_HOST=0.0.0.0 ollama serve
```

---

## Model-Specific Tuning

Different models have different context windows. If you switch models, update `maxContextTokens` to match:

| Model | Context Window | Suggested `maxContextTokens` |
|-------|---------------|------------------------------|
| qwen3-coder-cpu | 32K | 32768 |
| qwen3-coder | 32K | 32768 |
| deepseek-coder-v2 | 128K | 131072 |
| codellama:34b | 16K | 16384 |
| llama3.1:8b | 128K | 131072 |

---

## Saved Conversations

Conversations are stored as JSON files in `~/.mantis/conversations/`. Each file contains:

```json
{
  "savedAt": "2026-02-28T15:30:00.000Z",
  "messageCount": 24,
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." },
    ...
  ]
}
```

These are plain JSON — you can back them up, share them, or inspect them with any JSON viewer.

### Managing conversations

```
> /save my-feature          # save with a name
> /save                     # save with auto-generated timestamp name
> /load                     # list all saved conversations
> /load 1                   # load by number
> /load my-feature          # load by name (partial match)
```

---

## Environment

Mantis respects the working directory you launch it from. That's the directory the model sees and where relative paths resolve to.

```bash
cd ~/my-project
mantis                      # Working directory: ~/my-project

# Or change it while running:
> /cd src/backend            # Working directory: ~/my-project/src/backend
> /cd                        # Shows current directory
```
