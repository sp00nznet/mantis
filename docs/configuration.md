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
└── memory/               # Reserved for future use
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
  "providerKeys": {}
}
```

### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ollamaUrl` | string | `http://localhost:11434` | Where Ollama is running. Change if you're running it on another machine or port. |
| `model` | string | `qwen3-coder-cpu` | Which Ollama model to use. Can also be changed with `/model` at runtime. |
| `maxContextTokens` | integer | `32768` | Context window size. Should match your model's actual limit. |
| `compactThreshold` | float | `0.75` | Auto-compact when context usage reaches this fraction (0.0–1.0). |
| `commandTimeout` | integer | `60000` | Max time (in ms) for `run_command` before killing the process. Default is 60 seconds. |
| `maxToolResultSize` | integer | `8000` | Max characters returned from any tool. Longer results are truncated. |
| `confirmDestructive` | boolean | `true` | Reserved for future use — will prompt before destructive operations. |
| `provider` | string | `local` | Active provider key. See [Providers](#providers) below. |
| `providerKeys` | object | `{}` | API keys for cloud providers, keyed by provider name. |

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

Mantis supports 17 providers out of the box. All use the OpenAI-compatible chat completions API, so switching between them is seamless.

### Switching providers

```
> /provider list               # see all 17 providers
> /provider set gemini         # switch to Google Gemini
> /provider key gemini KEY     # set your API key
> /provider test               # verify it works
> /provider show               # show current provider + model
```

### Available providers

| Key | Provider | Base URL | Requires Key | Default Model |
|-----|----------|----------|:------------:|---------------|
| `local` | Ollama | `http://localhost:11434/v1` | No | `qwen3-coder` |
| `together` | Together AI | `https://api.together.xyz/v1` | Yes | `Qwen/Qwen2.5-Coder-32B-Instruct` |
| `fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1` | Yes | `qwen2p5-coder-32b-instruct` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | Yes | `qwen/qwen3-32b` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | Yes | `qwen/qwen-2.5-coder-32b-instruct` |
| `deepinfra` | DeepInfra | `https://api.deepinfra.com/v1/openai` | Yes | `Qwen/Qwen2.5-Coder-32B-Instruct` |
| `chutes` | Chutes AI | `https://llm.chutes.ai/v1` | Yes | `Qwen/Qwen2.5-Coder-32B-Instruct` |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | Yes | `qwen-3-coder-480b` |
| `novita` | Novita AI | `https://api.novita.ai/v3/openai` | Yes | `qwen/qwen3-coder-480b-a35b-instruct` |
| `mistral` | Mistral AI | `https://api.mistral.ai/v1` | Yes | `codestral-latest` |
| `openai` | OpenAI | `https://api.openai.com/v1` | Yes | `gpt-4o` |
| `anthropic` | Anthropic (Claude) | `https://api.anthropic.com/v1` | Yes | `claude-sonnet-4-6` |
| `gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Yes | `gemini-2.5-flash` |
| `xai` | xAI (Grok) | `https://api.x.ai/v1` | Yes | `grok-3` |
| `perplexity` | Perplexity | `https://api.perplexity.ai` | Yes | `sonar-pro` |
| `sambanova` | SambaNova | `https://api.sambanova.ai/v1` | Yes | `Qwen3-32B` |
| `cohere` | Cohere | `https://api.cohere.ai/compatibility/v1` | Yes | `command-a-03-2025` |

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

### Notes on specific providers

- **Anthropic (Claude)** — Uses Anthropic's OpenAI compatibility layer. Works for chat + tool calling, but some Claude-specific features (prompt caching, extended thinking) aren't available through this endpoint.
- **Google Gemini** — Has the most generous free tier: 1 million tokens/day with no credit card required. Get your key at [aistudio.google.com](https://aistudio.google.com).
- **Perplexity** — Unique because it's search-augmented. Responses include live web knowledge, useful for questions about recent APIs or libraries.
- **OpenRouter** — An aggregator that routes to many providers. Useful if you want access to many models through a single API key.

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
