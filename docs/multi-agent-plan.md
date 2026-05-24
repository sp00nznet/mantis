# Mantis External Agent Delegation — Implementation Plan

> Plan generated 2026-05-24 by the Plan agent. Step 1 (walking skeleton with
> `claude` only) is in progress; later steps tracked in code comments.

## Overview

Add a registry of external agentic CLIs (`claude`, `codex`, `aider`, `gemini`,
`qwen`, `cline`, etc.) that Mantis can route a turn to instead of running its
own `createAgent()` loop. Selection is per-turn through a dropdown next to the
composer's Send button, with a session-level default + per-message override.

The external agent is spawned as a subprocess with the project's cwd, fed the
user message via stdin or argv, and its stdout streamed back into the existing
`onText` callback. Mantis becomes a transparent passthrough: it does **not**
see the external agent's tool calls, just the final text.

## 1. Discovery — `src/external-agents.js`

Hard-coded `AGENT_REGISTRY` (the source of truth) + PATH probe (decides
availability) + `config.externalAgents` overrides.

| id      | bin       | headless flag pattern                          | streams |
|---------|-----------|-----------------------------------------------|---------|
| claude  | `claude`  | `-p <prompt> --output-format stream-json`     | yes (NDJSON) |
| codex   | `codex`   | `exec <prompt>`                               | partial |
| aider   | `aider`   | `--yes-always --no-stream --message <prompt>` | no |
| gemini  | `gemini`  | `--yolo --prompt <prompt>`                    | no |
| qwen    | `qwen`    | `--yolo --prompt <prompt>`                    | no |
| cline   | `cline`   | `--prompt <prompt>` (stdin)                   | experimental |

PATH probe: walk `process.env.PATH` + `PATHEXT` (Windows) — do not shell out.

## 2. Spawning

v1 = text-in / text-out only. One spawn per user turn. No multi-turn within a
spawn. No pseudo-TTYs (avoids the `node-pty` install pain).

Windows `.cmd` shim handling mirrors `src/mcp.js _spawnStdio` — wrap with
`cmd /c <bin> ...`.

Stream parsing pluggable:
- `parseStream: 'plain'` — pipe stdout raw (codex/aider/gemini/qwen/cline)
- `parseStream: 'claude-stream-json'` — NDJSON, extract `message.content[].text`

## 3. Session integration

Add `session.agent = 'native' | 'claude' | …` (default `'native'`) plus
optional `__agentOverride` parameter on `chat:send`. Branch at the top of:

- `desktop/chat.js :: runAgentTurn` and `runChatTurn`
- `src/cli.js :: handleUserInput` (with `/agent <id>` slash command)
- `src/headless.js :: runHeadless` (with `--agent <id>` flag)
- `src/sessions.js :: runWeb`

cwd sourcing per entry:
- desktop agent-mode: `project.path`
- desktop chat-mode: `os.homedir()` + UI warning
- REPL: `getWorkingDirectory()`
- headless: `opts.cwd || process.cwd()`
- web session: `session.cwd`

## 4. UI

### Desktop composer

Small `<select id="agentPicker">` inside the composer, left of `#sendBtn`.
Options populated from `external:list` IPC. Default = `session.agent`. No
per-message override in v1 — keep mental model simple.

### Admin web UI

Dropdown between textarea and send button in the session input row. New routes:
- `GET /api/external-agents`
- `POST /api/sessions/<id>/agent`
- Extend `/input` POST to accept `agent` for per-call override

## 5. Tool surface / persistence

For an external-agent turn, append only:

```js
session.messages.push({ role: 'user', content: text });
session.messages.push({
  role: 'assistant',
  content: streamedText,
  meta: { externalAgent: id, exitCode, durationMs },
});
```

No `tool_calls`. Render a "via Claude Code · 12.4s" footer under the bubble.

## 6. Security

Concrete risk callouts:

| Agent  | Approval behaviour                                  | Risk |
|--------|-----------------------------------------------------|------|
| claude | Auto-approves in `-p` mode; respects `.claude/settings.json` denies | Medium |
| codex  | Auto-approves; sandbox configurable                | Medium |
| aider  | Auto-applies edits, auto-commits to git            | **High** |
| gemini | `--yolo` literal flag, auto-approves all tools     | **High** |
| qwen   | `--yolo` literal flag, auto-approves all tools     | **High** |
| cline  | Headless support shaky                             | Unknown |

Safety layers:
1. Per-agent `disabled` default for high-risk agents until user enables in Settings
2. Cwd guard: refuse to spawn with `cwd === homedir` or `cwd === '/'`

## 7. Implementation order

1. **Step 1 — Walking skeleton (`claude` only)**: `src/external-agents.js`,
   `runExternalAgentTurn` in `desktop/chat.js`, hard-coded `session.agent ===
   'claude'` gate. Manual JSON edit to test.
2. **Step 2 — Registry + multi-agent**: fill `AGENT_REGISTRY` for the rest +
   `config.externalAgents` merge + default-off gate for high-risk agents.
3. **Step 3 — Desktop UI**: IPC, composer dropdown, `desktop/store.js` persist,
   "via X" footer.
4. **Step 4 — Admin web UI**: HTTP routes + input-row dropdown + new-session
   form.
5. **Step 5 — CLI + headless**: `/agent` slash command + `--agent` flag + docs.
6. **Step 6 — Polish**: claude-stream-json parser, cwd-guard modal, Settings
   "External agents" card with availability + enable toggles.

## Gnarly tradeoffs

1. **No conversation continuity.** Each turn is a fresh spawn. Most CLIs
   maintain their own state via local files — Mantis's `session.messages`
   and the external tool's history will drift.
2. **Stream parsing fragility.** Only `claude -p --output-format stream-json`
   is structured; the rest is `print whatever`. Pass through verbatim.
3. **Windows.** All these CLIs ship as `.cmd` shims needing `cmd /c`. PATH
   probing needs `PATHEXT`.
4. **Cancellation.** `proc.kill()` is unreliable on Windows for grandchildren.
   Use `taskkill /pid X /T /F`.
5. **No "I called your tools too" view.** Accept one bubble with streamed text
   + "via X" footer.
6. **Auth.** External CLIs use their own config (`~/.claude.json` etc.).
   Mantis does not forward keys.
7. **Per-message vs session default.** Session-default only in v1. Two clicks
   to switch + switch back; mental model is simpler.

## Critical files

- `src/external-agents.js` (new — registry, PATH probe, `runExternalAgent`)
- `desktop/chat.js` (gate at top of `runAgentTurn`/`runChatTurn`)
- `desktop/main.js` (IPC: `external:list`, `sessions:setAgent`)
- `desktop/renderer/app.js` (composer dropdown wiring + "via X" footer)
- `src/admin.js` (HTTP routes + extend `/input`)
- `src/sessions.js` (add `session.agentId`, branch in `runWeb`)
- `src/cli.js` (`/agent` slash command)
- `src/headless.js` (`--agent` flag)
