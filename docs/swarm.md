# Swarm Mode

Swarm mode uses **all your configured providers at once**. One provider leads
(decomposes the task, writes code), the rest work as parallel read-only
explorers. Adding a new API key instantly adds that provider to the swarm pool.

> **As of v3.6, swarm is the default** for plain prompts (REPL, `mantis run`,
> desktop chat-mode and agent-mode). With fewer than `swarm.minPoolSize`
> configured providers (default 2), Mantis silently falls back to a single
> agent so single-key users still work. To opt out:
>
> - **Desktop Settings → Swarm** → uncheck "Use swarm by default"
> - **CLI**: `mantis run "task" --solo` (or `--no-swarm`); `--swarm` to force
> - **REPL**: `/solo on` (per-session); `/solo off` to re-enable; `/solo status`
> - **Config**: set `swarm.default: false` in `~/.mantis/config.json`

```bash
# See what's in your swarm pool
/swarm --list

# Run a swarm task (auto-picks the best lead)
/swarm refactor the auth module

# Force a specific provider as lead
/swarm --lead anthropic refactor the auth module

# Exclude / re-include providers from the pool
/swarm remove local
/swarm add local
```

---

## How it works

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

---

## The 5 phases

1. **PLAN** — the lead decomposes the task into explore/code/review subtasks.
2. **EXPLORE** — workers run in parallel with a 30s timeout. If a worker fails,
   its task retries on another provider automatically.
3. **ARCHITECT** — the lead reasons about the solution in natural language (no
   tools).
4. **EDITOR** — a fast worker takes the architect's solution and makes the actual
   code edits.
5. **REVIEW** — optional quality check by a different provider.

---

## Architect / Editor split

Inspired by [Aider's research](https://aider.chat/2024/09/26/architect.html)
showing that separating reasoning from editing improves code quality. The lead
provider reasons about *what* to change and *why* (pure text, no tools). A
separate fast provider then mechanically implements the edits.

This means you can use an expensive reasoning model (Claude, GPT-4o) as the
architect and a fast cheap model (Groq, Cerebras) as the editor.

---

## Best-of-N mode

When enabled, multiple providers generate competing solutions in parallel. A
judge (fast cheap provider) picks the winner, and the editor implements only the
best one.

Set `swarm.bestOfN` to `2` or `3` in `~/.mantis/config.json` (or via the
[admin UI](proxy.md#admin-ui)). `0` disables it.

---

## Complexity-based routing

The lead is automatically selected based on task complexity:

| Complexity | Keywords | Preferred Lead |
|-----------|----------|---------------|
| **Simple** | rename, typo, fix import, format | Fast: Groq, Cerebras, SambaNova |
| **Medium** | add feature, update, implement | Fast or mid-tier |
| **Hard** | refactor, architect, security, migrate | Premium: Claude, OpenAI, Gemini, Grok |

A user override (`--lead`) always wins regardless of complexity.

---

## Worker fallback

If a worker hits a rate limit, times out, or errors during exploration, its
subtask automatically retries on a different available provider. No manual
intervention needed.

---

## Safety

- Workers only get **read-only tools** (`read_file`, `list_files`,
  `search_files`, `find_files`, `read_memory`) — they physically cannot write,
  edit, or run commands.
- One provider writes at a time (the editor) — no file conflicts.
- Each worker has its own rate limiter — no shared mutable state.
- Individual worker failures retry on another provider, then isolate if all fail.
- 30s per-worker timeout — stalled workers get skipped.
- Ctrl+C cancels all workers.

---

## Managing the pool

Every provider with an API key is automatically in the swarm pool:

```bash
/provider key groq gsk_xxx        # Groq joins the pool
/provider key gemini AIza_xxx     # Gemini joins the pool
/provider key together xxx        # Together joins the pool
/swarm --list                     # all three show up

# Exclude a provider you don't want in swarm
/swarm remove local               # local Ollama removed from pool
/swarm add local                  # re-include it later
```

Local Ollama is in the pool by default (no key needed). Excluded providers
persist across sessions.

Swarm needs **at least 2 providers** in the pool to run.

---

## Swarm configuration

In `~/.mantis/config.json`, under `swarm`:

| Option | Default | Description |
|--------|---------|-------------|
| `leadProvider` | `null` | Force a specific lead (or `null` for auto) |
| `maxParallelWorkers` | `4` | Max concurrent exploration workers |
| `excludeProviders` | `[]` | Providers excluded from the swarm pool |
| `bestOfN` | `0` | `0` = off, `2`–`3` = parallel competing solutions with judge |
| `providerModels` | `{}` | Per-provider model overrides, e.g. `{ "groq": "llama-3.3-70b" }` |
