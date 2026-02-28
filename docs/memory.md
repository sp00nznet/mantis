# Memory & State Persistence

Mantis can remember things across sessions. When you tell it to "save your state to memory," it writes persistent notes that get loaded automatically the next time you start a session.

This is the key difference between memory and conversation save/load:
- **Conversations** (`/save`, `/load`) store the raw message history — exact replay of what happened.
- **Memory** stores the model's *understanding* — what it was doing, what it learned, what matters. It's a curated summary, not a transcript.

---

## Quick Start

Just tell the model what you want it to remember:

```
  myproject > Save your state to memory.

  > read_memory scope=all
  ✔ read_memory done

  > save_memory scope=project mode=replace content=...
  ✔ save_memory done

  Saved! I've stored the following to project memory:
  - Current task: Adding rate limiting to the auth module
  - Files modified: src/auth/middleware.js, src/auth/login.js
  - Status: Rate limiter implemented, tests passing
  - Next steps: Add configuration for rate limit thresholds
  - Your preferences: You prefer concise commit messages
```

Next session:

```
  myproject > What were we working on?

  Based on my memory, we were adding rate limiting to the auth module.
  The implementation is done and tests pass. The next step is adding
  configuration for the rate limit thresholds. Want me to continue?
```

The model automatically sees its memory in the system prompt — no need to explicitly load anything.

---

## How It Works

### Two Memory Scopes

| Scope | File | Shared? | Use for |
|-------|------|---------|---------|
| **Project** | `.mantis/MEMORY.md` in the project root | Yes (commit to git) | Project-specific: task state, architecture decisions, file notes |
| **Global** | `~/.mantis/memory/MEMORY.md` | No (your machine only) | Universal: coding preferences, style choices, workflow habits |

### The Memory Lifecycle

1. **Session starts** → memory files are loaded and injected into the system prompt
2. **During the session** → the model can read/write memory via tools
3. **User says "save state"** → the model reads existing memory, writes an updated version
4. **Session ends** → memory persists on disk
5. **Next session starts** → memory is loaded again, model picks up where it left off

### Three Memory Tools

The model uses these tools to interact with memory:

| Tool | Description |
|------|-------------|
| `save_memory` | Write to memory. Parameters: `content` (markdown), `scope` (project/global), `mode` (replace/append) |
| `read_memory` | Read current memory. Parameter: `scope` (project/global/all) |
| `delete_memory` | Clear memory. Parameter: `scope` (project/global) |

These are real tools — the model calls them just like `read_file` or `run_command`. You don't need to manage memory manually (though you can with `/memory` commands).

---

## What Gets Saved

When you ask the model to save state, it decides what's important. A typical memory entry looks like:

```markdown
# Project: my-app

## Current Task
Adding WebSocket support for real-time notifications.
Status: In progress — server-side done, client pending.

## Key Files
- src/websocket.js — new WebSocket server (created)
- src/server.js — modified to attach WS server
- src/services/notification-service.js — needs broadcast function added
- client/src/hooks/useSocket.js — needs to be created

## Decisions
- Using `ws` library (not Socket.IO) — lighter, no fallback needed
- Auth via JWT in query params during handshake
- One channel per resource type (users, orders, notifications)

## Next Steps
1. Add broadcast function to notification-service.js
2. Create client-side useSocket hook
3. Add reconnection logic
4. Write tests

## Notes
- The batch-import script holds connections for 30+ seconds — need separate pool config
- User prefers functional components over class components
```

---

## CLI Commands

```
  /memory              Show all saved memory (project + global)
  /memory status       Show memory file paths and sizes
  /memory clear project    Clear project memory
  /memory clear global     Clear global memory
  /memory clear all        Clear everything
```

### Viewing memory

```
  myproject > /memory

  Project Memory
  # Project: my-app
  ## Current Task
  Adding WebSocket support...

  Global Memory
  ## Preferences
  - Prefers TypeScript over JavaScript
  - Uses 2-space indentation
  - Likes concise commit messages
```

### Memory status

```
  myproject > /memory status

  Memory Status
  Project: 847 chars
           D:\myproject\.mantis\MEMORY.md
  Global:  234 chars
           C:\Users\you\.mantis\memory\MEMORY.md
```

The status also shows in `/status`:

```
  myproject > /status
  ...
  Memory:      project: 847 chars, global: 234 chars
```

---

## Natural Language Triggers

You don't need to use commands. Just talk to the model:

| What you say | What happens |
|-------------|-------------|
| "Save your state to memory" | Model writes comprehensive state to project memory |
| "Remember that I prefer tabs" | Model saves preference to global memory |
| "What do you remember?" | Model reads and summarizes its memory |
| "Forget everything" | Model clears memory |
| "Save what we discussed to global memory" | Model writes to global scope specifically |
| "Update your memory with what we just did" | Model reads existing memory, appends/replaces |

The model is instructed to:
1. Read existing memory first (so it doesn't clobber useful context)
2. Write well-organized markdown
3. Use `project` scope for project stuff, `global` for preferences
4. Use `replace` to rewrite cleanly, `append` to add incrementally

---

## Project Memory & Git

Project memory lives in `.mantis/MEMORY.md` at the project root. This means you can:

- **Commit it to git** so team members benefit from the model's understanding
- **Include it in .gitignore** if you want personal-only memory

A team might commit memory like:

```markdown
# Architecture Notes

## API Design
- REST endpoints in src/routes/
- Middleware chain: auth → rate-limit → validate → handler
- All responses wrapped in { data, error, meta }

## Testing
- Unit tests in __tests__/ next to source files
- Integration tests in test/integration/
- Run with: npm test (unit) or npm run test:integration

## Conventions
- Functional components only (no classes)
- Named exports (no default exports)
- Error handling: throw AppError, caught by global handler
```

Every team member who uses Mantis in this repo automatically gets this context.

---

## Tips

1. **Save state before quitting.** Make it a habit — "save your state and I'll come back later." The model will write everything it needs to resume.

2. **Use global memory for preferences.** Things like "I prefer TypeScript" or "always use arrow functions" — save these once and they apply to every project.

3. **Let the model manage memory.** You don't need to write memory files by hand. The model is good at deciding what to save and how to organize it. Just tell it to save and let it do its thing.

4. **Combine with /save.** For big tasks, save both memory *and* the conversation. Memory gives the model high-level context; the loaded conversation gives it the exact details.

5. **Review memory occasionally.** Use `/memory` to see what's stored. If it's getting stale or wrong, tell the model to "update your memory" or clear it with `/memory clear project`.
