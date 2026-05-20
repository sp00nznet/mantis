# Mantis Desktop

A Claude-style desktop app for Mantis — chat, projects, and git in one window.
It's an **Electron** app that reuses Mantis's existing engine (providers, the
streaming LLM client, config) and shares `~/.mantis/config.json` with the CLI.

> **Status: Phase 3** — chat, projects with agent mode, and git: connect
> services, clone and create repos, and commit/push/pull inside a project.

---

## Running it

The desktop app lives in `desktop/` with its own dependencies (Electron is a
build dependency of the app only — it never touches the CLI install).

```bash
cd desktop
npm install      # downloads Electron (~150 MB, first time only)
npm start
```

It opens sharing your existing providers and API keys — anything configured via
the CLI or the admin panel works immediately. If you haven't set a provider yet,
open **Settings** in the app.

---

## Layout

A three-pane layout with an icon rail:

```
┌──┬────────────┬───────────────────────────┐
│🦗│ Chats      │ conversation              │
│💬│  ...        │                          │
│📁│            │  messages stream here     │
│⎇ │            │                          │
│⚙ │            │  [ Message…          ▸ ] │
└──┴────────────┴───────────────────────────┘
```

- **Icon rail** — Chats, Projects, Git, Settings.
- **List** — your conversation history (newest first).
- **Main** — the chat, with a streaming response and a composer.

## Chat (Phase 1)

- **General chat** — a Claude-style conversation with any configured provider.
  No filesystem tools; it's a plain assistant.
- **Persistent history** — every conversation is saved to
  `~/.mantis/sessions/<id>.json`. Close the app and reopen — your history is
  intact, and clicking a conversation resumes it exactly where you left off.
- **Auto-titled** — conversations are named from your first message.
- **Settings** — pick the active provider and model (the model list is polled
  live from the provider) and set API keys.

## Projects (Phase 2)

The **Projects** tab turns a folder into an agent workspace.

- **New project** — names a folder, creates it (under `~/MantisProjects/` by
  default, or any location you browse to), and runs `git init`. You can also
  **open an existing folder** as a project. The registry is
  `~/.mantis/projects.json`; removing a project never deletes the folder.
- **Agent-mode sessions** — chats started inside a project run the **full
  Mantis tool loop** (read / write / edit / run commands / search) with the
  project folder as the working directory. Tool calls show inline in the
  transcript, and the conversation is persisted and resumable just like a chat.
- **File tree** — the **Files** tab shows the project's contents; expand
  folders and click a file to preview it.

> Agent-mode tool calls are **auto-approved** — Mantis can write files and run
> commands in the project folder without prompting, like the CLI's `/auto`
> mode. Only open projects you trust it to work in.

## Git (Phase 3)

The **Git** tab connects the app to your git hosting.

- **Connect a service** — add a **GitHub**, **GitLab**, or **Gitea** connection
  with a Personal Access Token (self-hosted instances work — just give the host
  URL). Tokens are encrypted with the OS keystore (Electron `safeStorage`) when
  available. The registry is `~/.mantis/git.json`.
- **Browse & clone** — list your repositories and clone any of them into the
  workspace with one click; the clone is registered as a project. The token is
  used for the clone but kept out of the repo's `.git/config`.
- **Create a repo** — make a new repository on the service (with a README),
  which is then cloned as a project.
- **Project git panel** — inside a project, the **⎇ Git** button shows the
  current branch and changed files, with **commit**, **push**, and **pull**.
  Push/pull authenticate with the matching connection's token.

> Git operations shell out to the `git` command — it must be installed and on
> your PATH.

## Roadmap

- **Phase 4** — packaged Windows installer (`.exe`) and polish.

## How it's built

- `desktop/main.js` — Electron main process; imports the Mantis engine from
  `../src/` and exposes it over IPC.
- `desktop/preload.cjs` — the secure `window.mantis` bridge (context-isolated,
  sandboxed renderer).
- `desktop/store.js` — session persistence.
- `desktop/projects.js` — project registry, file tree, directory browsing.
- `desktop/git.js` — git connections, service APIs, clone, and project git ops.
- `desktop/chat.js` — the chat runner and the agent-mode runner.
- `desktop/renderer/` — the UI (HTML/CSS/JS).
