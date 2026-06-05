# MCP

Mantis speaks **MCP (Model Context Protocol)** in both directions:

- **As a client** — connect to MCP servers and add their tools (and resources and
  prompts) to the agent loop alongside the built-in ones. This plugs Mantis into
  the whole MCP ecosystem (filesystem, GitHub, Postgres, Playwright, Slack, and
  many more) with no per-integration code.
- **As a server** — `mantis mcp-server` exposes Mantis's own tools to *other*
  agents (Claude Code, Cursor, anything that speaks MCP). See
  [Mantis as an MCP server](#mantis-as-an-mcp-server) below.

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
  github (stdio) — connected · 26 tools · 3 resources
  remote (http) — not connected (HTTP 502)
```

The same status is shown in the admin UI under **Settings → MCP servers**.

The model calls MCP tools on its own when they're relevant, just like the
built-in tools.

### Resources and prompts

Beyond tools, MCP servers can expose **resources** (files, docs, or data the
server makes available) and **prompts** (server-provided prompt templates). Mantis
discovers both on connect. When any connected server exposes resources, the agent
gets a `read_mcp_resource` tool — it can list what's available or read a specific
resource by uri. Servers that don't implement resources/prompts are handled
gracefully; nothing breaks.

---

## Mantis as an MCP server

Run Mantis as an MCP server and its built-in tools — `read_file`, `edit_file`,
`run_command`, `search_files`, `search_memory`, the memory tools, and the rest —
become available to any other MCP client:

```bash
mantis mcp-server              # expose all tools
mantis mcp-server --read-only  # expose only the non-mutating subset
```

It speaks JSON-RPC over stdio, so another agent wires it up like any stdio server.
For example, in Claude Code's MCP config:

```json
{
  "mcpServers": {
    "mantis": { "command": "mantis", "args": ["mcp-server"] }
  }
}
```

- Tools run in the **process working directory** — launch it from the project root
  you want it to operate on.
- `--read-only` (or `MANTIS_MCP_READONLY=1`) restricts it to read/search tools, so
  another agent can explore your project through Mantis without write or run
  access.
- It works inside the single-exe (SEA) build too — `mantis mcp-server` is a
  first-class subcommand.

---

## Notes

- MCP tools are available in the REPL, autonomous mode, headless runs
  (`mantis run`), and the desktop app — anywhere the agent runs.
- In **plan mode** MCP tools are disabled, since they can have side effects.
- stdio servers are spawned with your environment; on Windows they run via
  `cmd /c` so `npx`/`npm` shims resolve. Subprocesses are killed when Mantis
  exits.
- If a server fails to start, `/mcp` shows the error and the rest keep working.
