# Mantis Documentation

Guides for using and understanding Mantis. New here? Start with
[Getting Started](getting-started.md). The project overview is in the
[top-level README](../README.md).

## Setup & usage

- [Getting Started](getting-started.md) — install, first session, troubleshooting
- [Providers](providers.md) — all 23 providers, base URLs, default models, keys
- [Free Providers](free-providers.md) — every provider with a free tier, signup links, what you need
- [Configuration](configuration.md) — `~/.mantis/config.json` reference

## Modes & features

- [Swarm Mode](swarm.md) — run every provider in parallel
- [Proxy & Admin UI](proxy.md) — use Mantis as a Claude Code backend
- [MCP](mcp.md) — connect MCP servers, or run Mantis as one
- [Conversation Search](search.md) — full-text recall across past sessions
- [Session Sharing](sharing.md) — watch/join links for a live session
- [Sign-in & Multi-user](auth.md) — local accounts, roles, per-account workspaces
- [Windows Server Deployment](windows-server.md) — single-exe, run-as-service, remote GPU
- [Chat Bots](bots.md) — drive Mantis from Telegram or Discord
- [Plan Mode](plan-mode.md) — read-only exploration
- [Skills](skills.md) — built-in and custom slash commands
- [External Agents](multi-agent.md) — delegate to Claude Code / Codex / Aider / …
- [Memory](memory.md) — persistent cross-session memory
- [Context Management](context-management.md) — how long sessions survive

## Internals

- [Tools](tools.md) — the 17 built-in tools the model can call
- [Architecture](architecture.md) — how Mantis works under the hood
- [CI/CD](cicd.md) — GitHub Actions, cutting a release, single-exe CLI, desktop installers
