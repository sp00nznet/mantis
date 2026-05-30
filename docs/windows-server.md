# Windows Server Deployment

Run Mantis as an always-on admin server on Windows (Server 2022/2025 or Windows 11)
that users connect to over the network to chat and build — the same admin UI you
get on Linux, plus a one-command service install.

This is the **all-in-one** path: a single `mantis.exe` (no Node, no npm, no dozens
of dependencies) that you register to start at boot.

## 1. Get the binary

Either grab `mantis.exe` from a release, or build it:

```powershell
npm ci
npm run build:sea        # → dist/release/mantis.exe  (+ admin.html, shared.html, assets/)
```

The single exe bundles Node and all of Mantis. Keep the sidecar files
(`admin.html`, `shared.html`, `assets/`) **next to the exe** — the admin UI is
served from them. Drop the whole `dist/release/` folder somewhere like
`C:\Program Files\Mantis\`.

> No native dependencies are involved, so the exe is fully self-contained.

## 2. Run as a service (starts at boot)

```powershell
# From an ELEVATED (Administrator) prompt:
C:\Program Files\Mantis\mantis.exe service install
C:\Program Files\Mantis\mantis.exe service start
mantis.exe service status
```

`service install` (Windows):
- creates a **Scheduled Task** `MantisAdmin` that runs `mantis admin` at startup
  as `SYSTEM` (via a generated launcher `.cmd` that pins the data dir),
- opens an inbound **firewall** rule for the admin port (default 8788),
- sets a machine-level `MANTIS_HOME` so manual `mantis` runs use the same data.

Options: `--data-dir <path>` (default `C:\ProgramData\Mantis`) and `--port <n>`.

Uninstall with `mantis.exe service uninstall` (leaves your data dir intact).

> **Why a Scheduled Task, not a `services.msc` service?** A plain exe can't do the
> Service Control Manager handshake without a native wrapper, so the dependency-free
> route is a boot Scheduled Task running as SYSTEM. If you specifically want a
> `services.msc` entry, point [NSSM](https://nssm.cc) or WinSW at `mantis.exe admin`
> with `MANTIS_HOME` in its environment.

### Let users connect over the network

By default the admin UI is **localhost-only**. Turn on sign-in so it binds to all
interfaces and requires a login:

```powershell
mantis.exe auth admin <username> <password>
mantis.exe service start          # restart to pick it up
```

Each account gets its own keys, models, history, and sessions. See
[Sign-in & Multi-user](auth.md).

### Data directory & permissions

As a service Mantis runs as `SYSTEM`, whose home is `C:\Windows\System32\config\systemprofile`
— not where you want data. `service install` handles this by setting **`MANTIS_HOME`**
(default `C:\ProgramData\Mantis`). Everything — `config.json`, `hub-sessions/`,
per-user data — lives there. ACL that folder to taste; you can also set
`MANTIS_HOME` yourself before launching for a custom location.

## 3. GPU / local models

### No GPU on this box → use another machine's (e.g. your Linux server)

Mantis's `local` provider just points at an OpenAI/Ollama-compatible URL, so a
GPU-less Windows server can offload local-model inference to your Linux box:

- On the **Linux** box, expose Ollama on the network:
  `OLLAMA_HOST=0.0.0.0 ollama serve` (and open TCP 11434 in its firewall).
- On **Windows**, set the local backend URL to the Linux box in Settings →
  Local backends, or in `config.json`: `"ollamaUrl": "http://<linux-ip>:11434"`.

Now `local` model calls (and the swarm's local worker) run on the Linux GPU.
LM Studio / llama.cpp backends work the same way via `localUrls`.

### This box has a GPU

Install [Ollama for Windows](https://ollama.com/download), pull a model
(`ollama pull qwen3-coder`), and leave `ollamaUrl` at the default
`http://localhost:11434`.

## 4. External agents (Claude Code, Codex)

Mantis can delegate to other agentic CLIs. Install whichever you want on the box
and make sure they're on `PATH`:

```powershell
npm install -g @anthropic-ai/claude-code   # claude
npm install -g @openai/codex               # codex (needs its own auth to run)
```

Both are pre-registered; they'll appear in the per-session agent dropdown once
detected. Codex shows up even without an account — you just can't run it until
it's authed.

### Claude tool approvals on a service

In a server session there's no terminal for Claude to ask permission at. Two modes
(Settings → External Agents, and a per-chat **"approve tools"** toggle):

- **Full autonomy** — Claude runs with `--dangerously-skip-permissions`.
- **Ask** — each tool use pops an **Allow / Deny** prompt in the session UI, brokered
  back to Claude. On a service the approval path is preferred (and it works as the
  single exe — the bridge re-invokes `mantis.exe` itself). See
  [External Agents](multi-agent.md).

## Quick reference

| Command | What it does |
|---|---|
| `mantis service install [--data-dir <p>] [--port <n>]` | Boot Scheduled Task + firewall + data dir |
| `mantis service start \| stop \| status` | Control the running server |
| `mantis service uninstall` | Remove task + firewall rule (keeps data) |
| `mantis auth admin <u> <p>` | Enable sign-in / network access |
| `MANTIS_HOME=<path>` | Override the data directory |
