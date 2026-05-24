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
choice. Native is always there; only installed (and enabled) external CLIs
appear.

When an external agent answers, the assistant bubble shows a small footer:

```
via Claude Code · 12.4s
```

If you pick a non-native agent in a chat-mode session (no project bound),
a confirm dialog warns you that the cwd-guard will reject the spawn —
switch to a project session first, or click through to proceed knowing
the next message will error out.

#### Settings → External Agents

`Settings → External Agents` lists every registered agent with:

- **Status tag** — `available` (on PATH, enabled), `disabled` (high-risk and
  not yet enabled), `not installed` (binary not on PATH).
- **Risk tag** — `medium`, `high`, or `unknown`.
- **Binary path** — the absolute path the PATH probe resolved, or
  `(not found)`. Useful for diagnosing PATH issues.
- **Enable** checkbox — only shown for installed high-risk agents.
  Toggling on pops a confirm dialog spelling out what the CLI does
  (auto-approves all tool calls, modifies files, commits to git, etc.).

A **⟳ Re-scan PATH** button picks up newly-installed CLIs without
restarting the app.

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
- **Desktop chat-mode session** → no project; selecting a non-native agent
  triggers a cwd-guard warning (see above). If you click through, the next
  send returns an error from the engine.
- **REPL** → uses the REPL's working directory (`/cd <path>` to change).
- **Headless** → uses `--cwd <path>` or `process.cwd()`.

Mantis refuses to spawn external agents at `$HOME` or `/` — the cwd-guard
in `runExternalAgent()` returns `Refusing to spawn <id> at <cwd> — pick a
project folder first` before any subprocess starts.

## Auth

Each external CLI uses its own auth config (`~/.claude.json`,
`~/.codex/auth.json`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.). Mantis
does **not** forward its own provider keys. The CLI must already be signed
in / configured — which is the design intent: keep keys siloed.

## Enabling a high-risk agent

**Easiest:** Desktop → Settings → External Agents → toggle the checkbox.

**By hand** in `~/.mantis/config.json`:

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

The Settings card only writes the `enabled` field; if you want to set
`bin`, `extraArgs`, or `env`, edit `config.json` directly.

## Verifying it works

Easiest smoke test — assuming `claude` is on your PATH:

```bash
$ mantis run "in one short sentence, what is 2+2?" --agent claude --json
{
  "ok": true,
  "text": "4",
  "externalAgent": "claude",
  "agentName": "Claude Code",
  "exitCode": 0,
  "durationMs": 4103
}
```

If it errors `Agent "claude" is not installed`, the CLI isn't on the
gitlab-runner / shell's PATH. Resolve with `bin:` in config or by adding
the dir to PATH.

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
