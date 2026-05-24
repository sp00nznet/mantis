# External Agents

Mantis can route any chat or task to an **installed external agentic CLI**
instead of running its own loop. Pick the agent per-session (Desktop, Admin
UI) or per-command (REPL, headless). This is useful when you want a specific
tool's behaviour for one turn — e.g. Claude Code's project memory, Aider's
auto-commits — without leaving Mantis.

## Supported agents

Mantis discovers these by probing `PATH` (+ `PATHEXT` on Windows):

| Agent           | id      | install link                                          | risk |
|-----------------|---------|-------------------------------------------------------|------|
| Mantis (native) | `native`| (built-in)                                            | n/a  |
| Claude Code     | `claude`| https://docs.anthropic.com/en/docs/claude-code        | med  |
| OpenAI Codex CLI| `codex` | https://github.com/openai/codex                       | med  |
| Aider           | `aider` | https://aider.chat                                    | **high** |
| Gemini CLI      | `gemini`| https://github.com/google-gemini/gemini-cli           | **high** |
| Qwen Code       | `qwen`  | https://github.com/QwenLM/qwen-code                   | **high** |
| Cline CLI       | `cline` | https://github.com/cline/cline                        | unknown |

**Risk levels** describe how the CLI behaves when Mantis spawns it headlessly:

- **medium** — auto-approves tools, but respects the CLI's own deny lists
  (`.claude/settings.json`, codex sandbox).
- **high** — auto-applies edits + auto-commits to git (`aider --yes-always`)
  or uses an explicit "no confirmation" flag (`gemini --yolo`, `qwen --yolo`).
  These default to **disabled** until you flip
  `config.externalAgents.<id>.enabled = true`.

## Picking an agent

### Desktop app

In any chat, the composer has a small dropdown left of the **Send** button.
Pick the agent — it's persisted on the session so reopening it keeps the
choice. Native is always there; only installed external CLIs appear.

When an external agent answers, the assistant bubble shows a small footer:

```
via Claude Code · 12.4s
```

### Admin web UI

Each session card in the sessions tab has an `agent` dropdown in the input
row, mirroring the desktop. Changing it persists the session default; the
value is also sent with every `/input` POST so a one-off override works.

### REPL

```
mantis> /agent list                      # see what's installed
mantis> /agent claude                    # switch active agent
mantis> fix the auth bug                 # → routed to Claude Code
mantis> /agent native                    # back to Mantis's loop
mantis> /agent refresh                   # rescan PATH after installing a CLI
```

### Headless

```bash
mantis run "review this PR" --agent claude
mantis run "add a /health endpoint" --agent codex --json
```

`--agent <id>` bypasses both the native agent and the swarm. JSON mode
returns `{ ok, text, externalAgent, agentName, exitCode, durationMs, error }`.

## What gets persisted

When the external agent answers a turn, the session records only:

```js
{ role: 'user', content: '<your message>' },
{ role: 'assistant', content: '<the streamed reply>',
  meta: { externalAgent: 'claude', agentName: 'Claude Code',
          exitCode: 0, durationMs: 12_345 } }
```

No tool-call breadcrumbs. Mantis is a transparent passthrough; the external
CLI's tool-call history lives in that CLI's own conversation log.

## Working directory

External agents always need a real project folder — they edit files on disk.

- **Desktop agent-mode session** → uses the project folder you opened.
- **Desktop chat-mode session** → currently falls back to `$HOME`, which the
  cwd-guard rejects (you'll see an error). Pick a project first.
- **REPL** → uses the REPL's working directory (`/cd <path>` to change).
- **Headless** → uses `--cwd <path>` or `process.cwd()`.

Mantis refuses to spawn external agents at `$HOME` or `/` — too easy to nuke
the wrong files by accident.

## Auth

Each external CLI uses its own auth config (`~/.claude.json`,
`~/.codex/auth.json`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.). Mantis
does **not** forward its own provider keys. The CLI must already be signed
in / configured — which is the design intent: keep keys siloed.

## Enabling a high-risk agent

In `~/.mantis/config.json`:

```json
{
  "externalAgents": {
    "aider":  { "enabled": true, "extraArgs": ["--model", "sonnet"] },
    "gemini": { "disabled": true }
  }
}
```

You can also pin an explicit absolute path to the binary
(`bin: "C:\\Users\\me\\AppData\\Local\\…\\claude.cmd"`) or set per-agent
env vars (`env: { ANTHROPIC_API_KEY: "…" }`). The merge order is the
built-in registry first, then your override.

## Known limitations

- **No conversation continuity inside Mantis** — each turn is a fresh
  spawn. Most CLIs keep their own history files (Claude's project memory,
  Aider's `.aider.chat.history.md`), so the *external* tool sees a coherent
  conversation; Mantis's `session.messages` and the CLI's view will drift.
- **No tool-call rendering** — only Claude Code (`--output-format
  stream-json`) emits structured events Mantis could parse. The rest stream
  plain text and we pass it through verbatim, banner gunk and all.
- **Cancellation on Windows** — `taskkill /T /F` is used to nuke
  grandchild processes spawned via npx, but a truly stuck CLI may need
  manual cleanup.
