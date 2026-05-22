# MCP Servers

Mantis is an **MCP (Model Context Protocol) client** — it can connect to MCP
servers and add their tools to the agent loop alongside the built-in ones. That
plugs Mantis into the whole MCP ecosystem (filesystem, GitHub, Postgres,
Playwright, Slack, and many more) with no per-integration code.

Each MCP tool shows up to the model as a normal tool named
`mcp__<server>__<tool>`.

---

## Configuring servers

Add an `mcpServers` block to `~/.mantis/config.json`. Two transports are
supported:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

- **stdio** — `{ command, args, env }`. Mantis spawns the server as a
  subprocess and speaks JSON-RPC over its stdin/stdout. This is the common case.
- **http** — `{ url, headers }`. Mantis talks to a remote server over
  Streamable HTTP.

`env` and `headers` are optional.

---

## Using it

Connections open automatically — when Mantis starts it connects to every
configured server in the background, and the agent picks up their tools on its
next turn.

Check status anytime in the REPL:

```
/mcp
```

```
  MCP servers
  filesystem (stdio) — connected · 11 tools
  github (stdio) — connected · 26 tools
  remote (http) — not connected (HTTP 502)
```

The model calls MCP tools on its own when they're relevant, just like the
built-in tools.

---

## Notes

- MCP tools are available in the REPL, autonomous mode, headless runs
  (`mantis run`), and the desktop app — anywhere the agent runs.
- In **plan mode** MCP tools are disabled, since they can have side effects.
- stdio servers are spawned with your environment; on Windows they run via
  `cmd /c` so `npx`/`npm` shims resolve. Subprocesses are killed when Mantis
  exits.
- If a server fails to start, `/mcp` shows the error and the rest keep working.
