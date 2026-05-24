# Mantis Documentation

Guides for using and understanding Mantis. New here? Start with
[Getting Started](getting-started.md). The project overview is in the
[top-level README](../README.md).

## Setup & usage

- [Getting Started](getting-started.md) — install, first session, troubleshooting
- [Providers](providers.md) — all 23 providers, base URLs, default models, keys
- [Configuration](configuration.md) — `~/.mantis/config.json` reference

## Modes & features

- [Swarm Mode](swarm.md) — run every provider in parallel
- [Proxy & Admin UI](proxy.md) — use Mantis as a Claude Code backend
- [MCP Servers](mcp.md) — connect MCP servers to add tools to the agent
- [Session Sharing](sharing.md) — watch/join links for a live session
- [Sign-in & Multi-user](auth.md) — local accounts, roles, per-account workspaces
- [Chat Bots](bots.md) — drive Mantis from Telegram or Discord
- [Plan Mode](plan-mode.md) — read-only exploration
- [Skills](skills.md) — built-in and custom slash commands
- [Memory](memory.md) — persistent cross-session memory
- [Context Management](context-management.md) — how long sessions survive

## Internals

- [Tools](tools.md) — the 15 built-in tools the model can call
- [Architecture](architecture.md) — how Mantis works under the hood
- [CI/CD](cicd.md) — GitLab pipeline, single-exe CLI, desktop installers
