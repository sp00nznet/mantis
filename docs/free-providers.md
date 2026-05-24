# Free Providers

Quick-start reference for every Mantis provider with a real free tier or
free API key. Order is roughly best-bang-for-no-buck first. All of these
work out of the box — just `/provider key <name> <KEY>` then
`/provider set <name>`.

Local backends (Ollama, LM Studio, llama.cpp) are at the bottom — no signup
needed, runs on your own machine.

---

## Summary

| Provider | Free-tier highlight | Sign up |
|----------|--------------------|---------|
| **NVIDIA NIM** | Free key, GPU-hosted Qwen3-Coder 480B / Kimi / GLM / Llama / many more | [build.nvidia.com](https://build.nvidia.com) |
| **Groq** | Generous free tier, 30 RPM / 14,400 RPD, blazing fast | [console.groq.com](https://console.groq.com) |
| **Google Gemini** | ~1M free tokens/day on Gemini 2.5 Flash, no card | [aistudio.google.com](https://aistudio.google.com) |
| **Cerebras** | Free `llama3.1-8b` (and other small models) — fastest tok/s on the market | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| **Mistral AI** | 1B tokens/month free, Codestral included | [console.mistral.ai](https://console.mistral.ai) |
| **xAI (Grok)** | $25 in free credits on signup (if you opt into data sharing) | [console.x.ai](https://console.x.ai) |
| **OpenRouter** | A handful of `:free` models (DeepSeek, Llama, etc.) usable with any key | [openrouter.ai](https://openrouter.ai) |
| **SambaNova** | Free tier on RDU-hosted Qwen3 / Llama models | [cloud.sambanova.ai](https://cloud.sambanova.ai) |
| **Together AI** | $1 free credit on signup, then pay-as-you-go | [api.together.xyz](https://api.together.xyz) |
| **Fireworks AI** | $1 free credit on signup | [fireworks.ai](https://fireworks.ai) |
| **DeepInfra** | $1.80 free credit on signup | [deepinfra.com](https://deepinfra.com) |
| **Novita AI** | Small free credit on signup, very cheap thereafter | [novita.ai](https://novita.ai) |
| **Cohere** | Free trial key with rate-limited access to Command models | [dashboard.cohere.com](https://dashboard.cohere.com) |

Local (no signup): **Ollama**, **LM Studio**, **llama.cpp**. See [Local](#local).

Skipped (no real free tier): **OpenAI**, **Anthropic**, **Perplexity**,
**Chutes** ($3/mo minimum), **Kimi** (paid), **Z.ai** (paid), **DeepSeek** (paid).

---

## NVIDIA NIM

- **Provider name**: NVIDIA NIM (`nvidia`)
- **Sign up**: [build.nvidia.com](https://build.nvidia.com) — click any model card,
  then "Get API Key" in the right-hand panel
- **Needs**: email (NVIDIA developer account) — no credit card, no phone
- **Free tier**: 1,000 free credits on personal email, larger allotment on a
  business email. ~15 RPM on heavy models (480B class) — Mantis paces itself
  to stay under it. All catalogued models are accessible, including
  `qwen/qwen3-coder-480b-a35b-instruct`, `moonshotai/kimi-k2-instruct`,
  `zai-org/glm-4.6`, `meta/llama-3.3-70b-instruct`, plus vision and embedding
  models.
- **API key location**: build.nvidia.com → top-right account menu → "API Keys"
  (or the "Get API Key" button on any model card)
- **Mantis support**: yes, provider key `nvidia` is built in. Default model
  is already set to the Qwen3-Coder 480B endpoint.
- **Caveat**: NVIDIA's free shared tier returns sporadic 503s under load,
  especially on the 480B model. If you see bursts of "Provider server error",
  switch to Groq or Cerebras temporarily — this is upstream behaviour, not
  a Mantis bug.

## Groq

- **Provider name**: Groq (`groq`)
- **Sign up**: [console.groq.com](https://console.groq.com) — sign in with
  Google or GitHub
- **Needs**: email + Google/GitHub OAuth — no credit card
- **Free tier**: 30 requests/min, 14,400 requests/day on most open models
  (Llama 3.x, Qwen3-32B, GPT-OSS, etc.). Mantis enforces these limits
  client-side via the `rateLimit` field in `PROVIDERS.groq`.
- **API key location**: console.groq.com → "API Keys" in the left sidebar
  → "Create API Key"
- **Mantis support**: yes, provider key `groq`. Default model `qwen/qwen3-32b`.

## Google Gemini

- **Provider name**: Google Gemini (`gemini`)
- **Sign up**: [aistudio.google.com](https://aistudio.google.com) — sign in
  with any Google account
- **Needs**: just a Google account
- **Free tier**: ~1M tokens/day on `gemini-2.5-flash`, lower limits on
  `gemini-2.5-pro`. 5 RPM / 20 RPD on the free tier — Mantis paces itself.
  No card required.
- **API key location**: aistudio.google.com → "Get API key" button (top-left)
  → "Create API key"
- **Mantis support**: yes, provider key `gemini`. Uses Google's
  OpenAI-compatible endpoint.

## Cerebras

- **Provider name**: Cerebras (`cerebras`)
- **Sign up**: [cloud.cerebras.ai](https://cloud.cerebras.ai) — Google or
  GitHub sign-in
- **Needs**: email + OAuth — no credit card
- **Free tier**: free access to `llama3.1-8b` and a rotating set of small/mid
  models. Speed is the headline — 1,000+ tok/s wafer-scale inference.
- **API key location**: cloud.cerebras.ai → "API Keys" in the left sidebar
- **Mantis support**: yes, provider key `cerebras`. Default model `llama3.1-8b`.

## Mistral AI

- **Provider name**: Mistral AI (`mistral`)
- **Sign up**: [console.mistral.ai](https://console.mistral.ai)
- **Needs**: email + phone number verification (SMS)
- **Free tier**: "La Plateforme" experimental tier — 1B tokens/month free
  across all open models including `codestral-latest`, `mistral-large-latest`.
  2 RPM hard cap on the free tier (Mantis enforces this).
- **API key location**: console.mistral.ai → "API Keys" → "Create new key"
- **Mantis support**: yes, provider key `mistral`. Default model
  `codestral-latest`.

## xAI (Grok)

- **Provider name**: xAI (Grok) (`xai`)
- **Sign up**: [console.x.ai](https://console.x.ai)
- **Needs**: email + credit card (no charge unless you exceed free credit)
- **Free tier**: $25 in free credits per month, but only if you opt in to
  share API data for model training in account settings. Otherwise it's
  pay-as-you-go.
- **API key location**: console.x.ai → "API Keys"
- **Mantis support**: yes, provider key `xai`. Default model `grok-3`.

## OpenRouter

- **Provider name**: OpenRouter (`openrouter`)
- **Sign up**: [openrouter.ai](https://openrouter.ai) — Google/GitHub OAuth
- **Needs**: email — no card required to start
- **Free tier**: a handful of models with a `:free` suffix (e.g.
  `deepseek/deepseek-chat:free`, `meta-llama/llama-3.3-70b-instruct:free`).
  Rate-limited to ~20 RPM / 200 RPD without payment.
- **API key location**: openrouter.ai → top-right avatar → "Keys" → "Create Key"
- **Mantis support**: yes, provider key `openrouter`. To use a free model,
  run `/model qwen/qwen3-coder:free` (or whichever `:free` model you want).
- **Note**: the default model in `PROVIDERS.openrouter` is the paid
  Qwen3-Coder 480B — switch with `/model` after setting your key.

## SambaNova

- **Provider name**: SambaNova (`sambanova`)
- **Sign up**: [cloud.sambanova.ai](https://cloud.sambanova.ai) — go to
  the homepage and click "Get an API Key"
- **Needs**: email + work-style email preferred (personal Gmail works)
- **Free tier**: free access to Qwen3-32B, Llama 3.x, DeepSeek-R1 distill
  models on SambaNova's RDU hardware. Rate-limited but no monthly cap on
  the free tier.
- **API key location**: cloud.sambanova.ai → "APIs" tab → "Generate New API Key"
- **Mantis support**: yes, provider key `sambanova`. Default model `Qwen3-32B`.

## Together AI

- **Provider name**: Together AI (`together`)
- **Sign up**: [api.together.xyz](https://api.together.xyz) — Google, GitHub,
  or SSO
- **Needs**: email — credit card needed to keep using after free credit
- **Free tier**: $1 in free credits on signup. Enough to test, not enough
  for sustained use. After that, pay-as-you-go (very cheap on open models).
  600 RPM on the free tier.
- **API key location**: api.together.xyz → "Settings" → "API Keys"
- **Mantis support**: yes, provider key `together`. Default model
  `deepseek-ai/DeepSeek-V3.1`.

## Fireworks AI

- **Provider name**: Fireworks AI (`fireworks`)
- **Sign up**: [fireworks.ai](https://fireworks.ai) — click "Sign in" or
  "Get API Key" in the top-right
- **Needs**: email
- **Free tier**: $1 in free credits on signup. Cheap inference on Qwen,
  DeepSeek, Llama after that.
- **API key location**: fireworks.ai → "API Keys" in the left sidebar after
  signing in
- **Mantis support**: yes, provider key `fireworks`. Default model
  `accounts/fireworks/models/qwen3-coder-480b-a35b-instruct`.

## DeepInfra

- **Provider name**: DeepInfra (`deepinfra`)
- **Sign up**: [deepinfra.com](https://deepinfra.com) — GitHub or Google
  sign-in
- **Needs**: email
- **Free tier**: $1.80 in free credits on signup. Hosts most open models at
  competitive prices.
- **API key location**: deepinfra.com → "Dashboard" → "API Keys"
- **Mantis support**: yes, provider key `deepinfra`. Default model
  `Qwen/Qwen3-Coder-480B-A35B-Instruct`.

## Novita AI

- **Provider name**: Novita AI (`novita`)
- **Sign up**: [novita.ai](https://novita.ai) — homepage, "Get Started"
- **Needs**: email
- **Free tier**: small free credit on signup ($0.50 last we checked). Very
  cheap pay-as-you-go on 200+ models afterwards.
- **API key location**: novita.ai → "Settings" → "Key Management"
- **Mantis support**: yes, provider key `novita`. Default model
  `qwen/qwen3-coder-480b-a35b-instruct`.

## Cohere

- **Provider name**: Cohere (`cohere`)
- **Sign up**: [dashboard.cohere.com](https://dashboard.cohere.com)
- **Needs**: email
- **Free tier**: "Trial" key — rate-limited (~20 RPM) access to Command A
  and embedding models. Not for production but fine for casual coding tasks.
- **API key location**: dashboard.cohere.com → "API Keys" → the default
  "Trial Key" is created automatically
- **Mantis support**: yes, provider key `cohere`. Default model
  `command-a-03-2025`. Uses Cohere's OpenAI compatibility endpoint.

---

## Local

No signup, no API key — runs entirely on your own machine.

### Ollama (`local`)

- **Install**: [ollama.com/download](https://ollama.com/download)
- **Pull a model**: `ollama pull qwen3-coder` (or any model from the
  [Ollama library](https://ollama.com/library))
- **Mantis support**: default provider. Set `ollamaUrl` in
  `~/.mantis/config.json` if Ollama runs on a non-default host.

### LM Studio (`lmstudio`)

- **Install**: [lmstudio.ai](https://lmstudio.ai)
- **Use**: load a GGUF in the app, start its local server (default
  `http://localhost:1234/v1`), then `/provider set lmstudio` and
  `/model <loaded-model-id>`.

### llama.cpp (`llamacpp`)

- **Install**: build from [github.com/ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp)
  or grab a release binary
- **Use**: `llama-server -m model.gguf` (default port 8080), then
  `/provider set llamacpp`. The model name is whatever the server reports
  — Mantis just passes through.

---

## Tips

- **Stack the free tiers**: in [Swarm Mode](swarm.md), add keys for every
  free provider — Mantis runs them in parallel and uses the fastest
  response. Free tiers compose into a surprisingly capable agent.
- **Avoid rate-limit surprises**: Groq, Gemini, and Mistral have
  client-side rate limits baked into `PROVIDERS` so Mantis throttles
  itself rather than hammering the API.
- **Verify default models**: providers rename and retire models often. If
  you get a 404, run `/provider models <name>` and pick a current ID with
  `/model`.
