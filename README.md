# Mantis

```
     \_/
    (o.o)    MANTIS
   _/|\_    Agentic coding assistant
  / / \ \
    / \
   /   \
```

![Mantis in action](images/mantis.png)

**Your own AI coding assistant. Local or cloud. No limits.**

Mantis is an agentic coding CLI — like having a senior dev pair-programming with you in your terminal. It reads your files, writes code, runs commands, searches your codebase, and plans out complex tasks. Powered by any OpenAI-compatible LLM — run locally through [Ollama](https://ollama.com) or connect to 17 cloud providers including OpenAI, Claude, Gemini, Groq, Cerebras, and more.

---

## Quick Start

### One-line install

**Windows** (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

**Linux/macOS**:
```bash
chmod +x scripts/install.sh && ./scripts/install.sh
```

The installer handles everything — Ollama, Node.js, GPU detection, model selection, PATH setup.

### Manual install

```bash
cd mantis
npm install
npm link

# Pull a model (pick one based on your GPU)
ollama pull qwen3-coder       # GPU — needs NVIDIA + CUDA
ollama pull qwen2.5-coder:14b # 12-16GB VRAM (RTX 5070/4080)
ollama pull qwen2.5-coder:32b # 24GB VRAM (RTX 4090/5090)
```

### Run it

```bash
cd ~/my-project
mantis
```

---

## Features

**10 built-in tools** — reads files, writes code, runs commands, searches your codebase, does surgical edits. It reads before it writes and chains tools together to accomplish complex tasks.

**17 providers** — Run locally with Ollama or connect to OpenAI, Claude, Gemini, Groq, Cerebras, Mistral, and 10 more cloud providers. Switch with `/provider set`.

**Autonomous mode** — `/auto "build a REST API"` and Mantis plans, writes, builds, tests, and delivers with no hand-holding. 100-iteration limit, all tool calls auto-approved.

**Swarm mode** — `/swarm "refactor the auth module"` uses ALL your configured providers in parallel. One provider leads (plans + writes code), the rest explore your codebase simultaneously as read-only workers. More API keys = more parallelism = faster results.

**GPU-tiered install** — The installer detects your GPU and pulls the right model size automatically. From 7B on CPU to 32B on RTX 4090/5090.

**Plan mode** — Toggle with `/plan` to explore your codebase and design a plan without touching anything. Toggle off to execute.

**Context management** — Long conversations don't crash. Token usage is tracked and older messages are automatically compacted when the context window fills up.

**Persistent memory** — Tell the model to "save state to memory" and it persists notes for future sessions. Project-scoped (`.mantis/MEMORY.md`) or global (`~/.mantis/memory/MEMORY.md`).

**Skills** — 8 built-in slash commands (`/commit`, `/review`, `/test`, `/explain`, `/fix`, `/refactor`, `/deps`, `/init`) plus create your own with `/skill create`.

**Save/load conversations** — `/save` and `/load` to pick up where you left off.

**Model hot-swap** — `/model deepseek-coder-v2` to switch models without restarting.

---

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/exit` | Quit |
| `/clear` | Wipe conversation history |
| `/plan` | Toggle plan mode (read-only exploration) |
| `/status` | Show token usage, model info, stats |
| `/cd <dir>` | Change working directory |
| `/save [name]` | Save conversation |
| `/load [name]` | List or load saved conversations |
| `/compact` | Manually compress history |
| `/model <name>` | Switch model |
| `/config` | Show configuration |
| `/provider` | Show/switch providers, set API keys |
| `/auto <task>` | Run a task autonomously |
| `/swarm <task>` | Use all configured providers in parallel |
| `/swarm --list` | Show swarm pool and auto-selected lead |
| `/swarm --lead <p> <task>` | Force a specific provider as lead |
| `/swarm remove <p>` | Exclude a provider from the swarm pool |
| `/swarm add <p>` | Re-include a previously excluded provider |
| `/memory` | Show saved memory |
| `/skills` | List all skills |
| `/<skillname>` | Run a skill (e.g. `/commit`, `/test`) |

---

## Providers

Mantis works with any OpenAI-compatible API. 17 providers are built in — switch with `/provider set <name>`.

### Local

| Provider | Key | Free Tier | Default Model |
|----------|-----|-----------|---------------|
| **Ollama** | `local` | Unlimited (your hardware) | `qwen3-coder` |

### Cloud — Open-Source Model Hosts

| Provider | Key | Free Tier | Default Model | Highlight |
|----------|-----|-----------|---------------|-----------|
| **Together AI** | `together` | Yes (limited) | `Qwen/Qwen2.5-Coder-32B-Instruct` | 100+ models |
| **Fireworks AI** | `fireworks` | Yes (limited) | `qwen2p5-coder-32b-instruct` | Fast inference |
| **Groq** | `groq` | Yes (generous) | `qwen/qwen3-32b` | Ultra-fast LPU hardware |
| **DeepInfra** | `deepinfra` | Yes (limited) | `Qwen/Qwen2.5-Coder-32B-Instruct` | Affordable |
| **Cerebras** | `cerebras` | Yes | `qwen-3-coder-480b` | 2000+ tok/s, fastest available |
| **SambaNova** | `sambanova` | Yes | `Qwen3-32B` | Fast RDU inference |
| **Chutes AI** | `chutes` | No ($3/mo+) | `Qwen/Qwen2.5-Coder-32B-Instruct` | Decentralized serverless |
| **Novita AI** | `novita` | Yes | `qwen/qwen3-coder-480b-a35b-instruct` | 200+ models, cheap |

### Cloud — Frontier / Proprietary Models

| Provider | Key | Free Tier | Default Model | Highlight |
|----------|-----|-----------|---------------|-----------|
| **OpenAI** | `openai` | No (pay-per-token) | `gpt-4o` | GPT-4o, o3 — the original |
| **Anthropic (Claude)** | `anthropic` | No (pay-per-token) | `claude-sonnet-4-6` | Via OpenAI compat layer |
| **Google Gemini** | `gemini` | Yes (1M tokens/day!) | `gemini-2.5-flash` | Best free tier anywhere |
| **xAI (Grok)** | `xai` | $25 free credits | `grok-3` | Grok-3 |
| **Mistral AI** | `mistral` | Yes (1B tokens/mo) | `codestral-latest` | Codestral for coding |

### Cloud — Aggregators & Specialty

| Provider | Key | Free Tier | Default Model | Highlight |
|----------|-----|-----------|---------------|-----------|
| **OpenRouter** | `openrouter` | Some free models | `qwen/qwen-2.5-coder-32b-instruct` | Routes to dozens of providers |
| **Perplexity** | `perplexity` | No | `sonar-pro` | Search-augmented, live web |
| **Cohere** | `cohere` | Trial key | `command-a-03-2025` | Enterprise-grade |

### Setup

```bash
# Set a provider
/provider set gemini

# Add your API key
/provider key gemini YOUR_API_KEY

# Test the connection
/provider test

# List all providers
/provider list
```

---

## Swarm Mode

Swarm mode uses **all your configured providers at once**. One provider leads (decomposes the task, writes code), the rest work as parallel read-only explorers. Adding a new API key instantly adds that provider to the swarm pool.

```bash
# See what's in your swarm pool
/swarm --list

# Run a swarm task (auto-picks the best lead)
/swarm refactor the auth module

# Force a specific provider as lead
/swarm --lead claude refactor the auth module

# Exclude/re-include providers from the pool
/swarm remove local
/swarm add local
```

### How it works

```
User: /swarm refactor the auth module

  SWARM POOL: anthropic (lead), gemini, groq, together, cerebras
  5 providers | complexity: hard

  [PLAN] anthropic decomposing task...
  → 3 explore, 1 code, 1 review

  [EXPLORE] 3 parallel workers
  [gemini]    searching for auth files...       done
  [together]  reading auth flow...              done
  [cerebras]  finding auth tests...             done

  [CODE]
  [anthropic] Architect reasoning...
  [groq]      Editor implementing...
  > edit_file src/auth.js
  > write_file src/auth.test.js

  [REVIEW] gemini checking changes...           done

  Swarm complete. 5 providers, 18.4s
```

### 5 phases

1. **PLAN** — Lead decomposes the task into explore/code/review subtasks
2. **EXPLORE** — Workers run in parallel with 30s timeout. If a worker fails, its task retries on another provider automatically
3. **ARCHITECT** — Lead reasons about the solution in natural language (no tools)
4. **EDITOR** — A fast worker takes the architect's solution and makes the actual code edits
5. **REVIEW** — Optional quality check by a different provider

### Architect/Editor split

Inspired by [Aider's research](https://aider.chat/2024/09/26/architect.html) showing that separating reasoning from editing improves code quality. The lead provider reasons about *what* to change and *why* (pure text, no tools). A separate fast provider then mechanically implements the edits. This means you can use an expensive reasoning model (Claude, GPT-4o) as the architect and a fast cheap model (Groq, Cerebras) as the editor.

### Best-of-N mode

When enabled, multiple providers generate competing solutions in parallel. A judge (fast cheap provider) picks the winner, and the editor implements only the best one. Research shows ensembles outperform any single model.

```bash
# Enable best-of-3 in config
# Set swarm.bestOfN to 2 or 3 in ~/.mantis/config.json
```

### Complexity-based routing

The lead is automatically selected based on task complexity:

| Complexity | Keywords | Preferred Lead |
|-----------|----------|---------------|
| **Simple** | rename, typo, fix import, format | Fast: Groq, Cerebras, SambaNova |
| **Medium** | add feature, update, implement | Fast or mid-tier |
| **Hard** | refactor, architect, security, migrate | Premium: Claude, OpenAI, Gemini, Grok |

User override (`--lead`) always wins regardless of complexity.

### Worker fallback

If a worker hits a rate limit, times out, or errors during exploration, its subtask automatically retries on a different available provider. No manual intervention needed.

### Safety

- Workers only get **read-only tools** (read_file, list_files, search_files, find_files, read_memory) — they physically cannot write, edit, or run commands
- One provider writes at a time (the editor) — no file conflicts
- Each worker has its own rate limiter — no shared mutable state
- Individual worker failures retry on another provider, then isolate if all fail
- 30s per-worker timeout — stalled workers get skipped
- Ctrl+C cancels all workers

### Managing the pool

Every provider with an API key is automatically in the swarm pool:

```bash
/provider key groq gsk_xxx        # Groq joins the pool
/provider key gemini AIza_xxx     # Gemini joins the pool
/provider key together xxx        # Together joins the pool
/swarm --list                     # All three show up

# Exclude a provider you don't want in swarm
/swarm remove local               # Local Ollama removed from pool
/swarm add local                  # Re-include it later
```

Local Ollama is in the pool by default (no key needed). Excluded providers persist across sessions.

---

## Configuration

Settings live at `~/.mantis/config.json`:

```json
{
  "model": "qwen3-coder",
  "ollamaUrl": "http://localhost:11434",
  "provider": "local",
  "providerKeys": {},
  "maxContextTokens": 32768,
  "compactThreshold": 0.75,
  "commandTimeout": 60000,
  "maxToolResultSize": 8000,
  "confirmDestructive": true,
  "swarm": {
    "leadProvider": null,
    "maxParallelWorkers": 4,
    "excludeProviders": [],
    "bestOfN": 0
  }
}
```

| Swarm Option | Default | Description |
|-------------|---------|-------------|
| `leadProvider` | `null` | Force a specific lead (or `null` for auto) |
| `maxParallelWorkers` | `4` | Max concurrent exploration workers |
| `excludeProviders` | `[]` | Providers excluded from the swarm pool |
| `bestOfN` | `0` | `0` = off, `2`-`3` = parallel competing solutions with judge |

---

## Requirements

- **Node.js** v18+
- **Ollama** — [ollama.com](https://ollama.com) (for local mode)
- **RAM** — 8GB minimum, 16GB recommended
- **Disk** — ~5GB for a local model

---

## License

MIT
