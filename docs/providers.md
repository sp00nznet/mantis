# Providers

Mantis works with any OpenAI-compatible chat-completions API. **23 providers** are
built in — switch between them with `/provider set <name>`.

---

## Managing providers

```
> /provider               # show the current provider
> /provider list          # list all 23 providers
> /provider set gemini    # switch to Google Gemini
> /provider key gemini KEY  # set the API key for a provider
> /provider test          # verify the current provider responds
> /provider models        # list models the current provider exposes
```

API keys are stored in `providerKeys` in `~/.mantis/config.json`, keyed by
provider name. You can also set them in the [admin UI](proxy.md#admin-ui).

Each provider has a default model; override it any time with `/model <name>`.

---

## Local

No API key required — these run on your own machine.

| Key | Provider | Base URL | Default Model |
|-----|----------|----------|---------------|
| `local` | Ollama | `http://localhost:11434/v1` | `qwen3-coder` |
| `lmstudio` | LM Studio | `http://localhost:1234/v1` | `local-model` |
| `llamacpp` | llama.cpp (`llama-server`) | `http://localhost:8080/v1` | `local-model` |

For **LM Studio**, load a model in the app, start its server, then set the loaded
model name with `/model`. **llama.cpp** ignores the model field — start
`llama-server` with your GGUF and Mantis will use it as-is.

---

## Cloud — open-model hosts

These serve open-weight models (Qwen, DeepSeek, Llama, GLM…) on fast hardware.

| Key | Provider | Base URL | Default Model | Free Tier |
|-----|----------|----------|---------------|-----------|
| `together` | Together AI | `https://api.together.xyz/v1` | `deepseek-ai/DeepSeek-V3.1` | Limited |
| `fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/qwen3-coder-480b-a35b-instruct` | Limited |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `qwen/qwen3-32b` | Generous |
| `deepinfra` | DeepInfra | `https://api.deepinfra.com/v1/openai` | `Qwen/Qwen3-Coder-480B-A35B-Instruct` | Limited |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | `llama3.1-8b` | Yes |
| `sambanova` | SambaNova | `https://api.sambanova.ai/v1` | `Qwen3-32B` | Yes |
| `chutes` | Chutes AI | `https://llm.chutes.ai/v1` | `Qwen/Qwen3-Coder-480B-A35B-Instruct` | No ($3/mo+) |
| `novita` | Novita AI | `https://api.novita.ai/v3/openai` | `qwen/qwen3-coder-480b-a35b-instruct` | Yes |
| `nvidia` | NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `qwen/qwen3-coder-480b-a35b-instruct` | **Free key** |

**NVIDIA NIM** is a standout for a free option — get an API key at
[build.nvidia.com](https://build.nvidia.com) and you get GPU-accelerated access to
Qwen3-Coder, GLM, Kimi, and many more.

---

## Cloud — frontier / proprietary models

| Key | Provider | Base URL | Default Model | Free Tier |
|-----|----------|----------|---------------|-----------|
| `openai` | OpenAI | `https://api.openai.com/v1` | `gpt-4o` | No |
| `anthropic` | Anthropic (Claude) | `https://api.anthropic.com/v1` | `claude-sonnet-4-6` | No |
| `gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | **1M tokens/day** |
| `xai` | xAI (Grok) | `https://api.x.ai/v1` | `grok-3` | $25 credits |
| `mistral` | Mistral AI | `https://api.mistral.ai/v1` | `codestral-latest` | 1B tokens/month |
| `kimi` | Kimi (Moonshot) | `https://api.moonshot.ai/v1` | `kimi-k2.6` | No |
| `zai` | Z.ai (GLM) | `https://api.z.ai/api/paas/v4` | `glm-4.6` | No |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | No |

---

## Cloud — aggregators & specialty

| Key | Provider | Base URL | Default Model | Free Tier |
|-----|----------|----------|---------------|-----------|
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `qwen/qwen3-coder-480b-a35b-instruct` | Some free models |
| `perplexity` | Perplexity | `https://api.perplexity.ai` | `sonar-pro` | No |
| `cohere` | Cohere | `https://api.cohere.ai/compatibility/v1` | `command-a-03-2025` | Trial key |

---

## Where to get a key

| Provider | Sign up |
|----------|---------|
| Google Gemini | [aistudio.google.com](https://aistudio.google.com) — best free tier |
| Groq | [console.groq.com](https://console.groq.com) |
| Cerebras | [cloud.cerebras.ai](https://cloud.cerebras.ai) — fastest inference |
| NVIDIA NIM | [build.nvidia.com](https://build.nvidia.com) — free GPU endpoints |
| Mistral | [console.mistral.ai](https://console.mistral.ai) |
| xAI (Grok) | [console.x.ai](https://console.x.ai) — $25 free credits |
| Kimi (Moonshot) | [platform.moonshot.ai](https://platform.moonshot.ai) |
| Z.ai | [z.ai/model-api](https://z.ai/model-api) |

---

## Notes on specific providers

- **NVIDIA NIM** — Free API key, GPU-accelerated. Hosts open models with
  prefixed IDs like `qwen/qwen3-coder-480b-a35b-instruct`. Run `/provider models
  nvidia` to browse the catalogue.
- **Kimi (Moonshot)** — The default `kimi-k2.6` is the current agentic-coding
  model. The older `kimi-k2-*-preview` series is being retired — if you pin an
  older ID, check it's still served with `/provider models kimi`.
- **Z.ai** — GLM-4.6 has a 200K context window and performs well in agentic
  coding harnesses. OpenAI-compatible `/chat/completions` endpoint.
- **Anthropic (Claude)** — Uses Anthropic's OpenAI compatibility layer. Chat and
  tool calling work; Claude-specific features (prompt caching, extended thinking)
  are not exposed through this endpoint.
- **Google Gemini** — The most generous free tier: ~1M tokens/day, no card
  required.
- **Perplexity** — Search-augmented; responses include live web knowledge.
- **OpenRouter** — An aggregator that routes to dozens of providers behind one
  key.

> Default model IDs for `nvidia`, `kimi`, and `zai` were verified in May 2026.
> Providers rename and retire models often — if a request 404s, run
> `/provider models <name>` and pick a current ID with `/model`.

---

## Rate limits

Some providers have free-tier rate limits baked into Mantis so it throttles
itself instead of getting rejected:

| Provider | Limit |
|----------|-------|
| `groq` | 30 requests/min, 14,400/day |
| `gemini` | 5 requests/min, 20/day |
| `mistral` | 2 requests/min |
| `together` | 600 requests/min |

When a limit is hit, Mantis waits with a countdown and retries. Genuine quota
exhaustion (billing) fails fast instead of retrying — see
[Architecture](architecture.md) for how errors are classified.

---

## Provider failover

When a provider keeps erroring — 5xx server errors, sustained 429s, or quota —
Mantis can **automatically roll over to the next provider** instead of giving
up. It cascades down an ordered chain and wraps back to the top; a provider
that just failed is parked in a short cooldown so it isn't immediately re-hit.

This is what keeps a session alive when, say, NVIDIA NIM's free tier starts
returning `503 ResourceExhausted` mid-task: the turn quietly continues on Groq
or Cerebras. Once Mantis fails over, it **sticks** to the working provider for
the rest of that turn rather than restarting on the dead one each step.

It applies everywhere the agent runs — REPL, headless, desktop, and the swarm
writer (architect/editor) + explorers.

```bash
/provider fallback                 # show status + the effective chain
/provider fallback off             # disable (single-provider, old behaviour)
/provider fallback on              # re-enable
/provider fallback auto            # auto chain: active provider, then every keyed one
/provider fallback groq cerebras nvidia together   # explicit ordered chain
```

**Auto chain** = the active provider first, then every *other* provider that
has an API key, in registry order. Keyless local backends (Ollama/LM Studio/
llama.cpp) are skipped in auto mode — list them explicitly if you want them in
the rotation. Providers you've excluded from swarm (`swarm.excludeProviders`)
are also kept out of the failover chain.

Config (`~/.mantis/config.json`):

```json
{
  "failover": {
    "enabled": true,
    "order": ["groq", "cerebras", "nvidia", "together"],
    "cooldownMs": 60000
  }
}
```

`order: []` means auto. `cooldownMs` is how long a failed provider is skipped
before it's eligible again.

---

## Using providers in other modes

- **Swarm mode** pulls from *every* provider that has a key — see [swarm.md](swarm.md).
- **Proxy mode** routes Claude model tiers to providers you choose — see [proxy.md](proxy.md).
