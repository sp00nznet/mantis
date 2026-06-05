# Conversation Search

Mantis indexes everything you've talked about — every REPL/hub session, desktop
chat, bot thread, and the memory store — into a full-text index, so you (and the
agent) can pull relevant context back out of past work instead of starting from
scratch or repeating yourself.

The index is built on **SQLite FTS5** via `node:sqlite`, a Node built-in. There's
no new dependency and nothing to install — and because it's part of the Node
binary, it ships inside the single-exe (SEA) build too.

> **Requires Node 22.5+.** On anything older, search simply self-disables — every
> other part of Mantis keeps working, and `/recall` reports that search is
> unavailable.

---

## `/recall` — search from the REPL

```
> /recall rate limiting on the proxy
```

```
  Recall — 3 match(es) for "rate limiting on the proxy"
  1. session · Proxy work
     add «rate» «limiting» to the anthropic «proxy»
  2. session · Proxy work
     done, added a token bucket per provider
  3. memory · MEMORY.md
     proxy applies a per-provider «rate» limiter (rpm/rpd)
```

Each hit shows where it came from (`session`, `chat`, `bot chat`, `memory`, or
`summary`), the conversation title, and a highlighted snippet.

### Summarizing old sessions

```
> /recall summarize        # summarize up to 20 long sessions
> /recall summarize 50     # ...up to 50
```

This asks the active model to compress long conversations into a tight gist and
indexes those summaries as `summary` documents, so recall can surface a one-glance
overview alongside the raw messages. Already-summarized sessions are skipped, so
it's safe to re-run.

---

## `search_memory` — the agent's recall tool

The agent has a `search_memory` tool and is prompted to reach for it before asking
you to repeat earlier decisions, file names, or how a problem was solved before.
It's also available to swarm workers (read-only). You don't invoke it directly —
the model calls it when it's relevant, e.g.:

> *"How did we end up handling the websocket disconnects last week?"* →
> the agent runs `search_memory("websocket disconnect heartbeat")` and answers
> from what it finds.

---

## What gets indexed, and when

| Source | Indexed when | Label |
|--------|--------------|-------|
| Hub / admin sessions | Each turn (on persist) | `session` |
| Desktop chats | Each save | `chat` |
| Bot conversations (Telegram/Discord) | Each turn | `bot chat` |
| Global memory (`MEMORY.md`) | On backfill | `memory` |
| LLM session summaries | `/recall summarize` | `summary` |

The first time search is used in a process, Mantis runs a one-time **backfill**
that scans the on-disk stores, so recall works over history that predates the
feature without any manual reindex. After that, new turns are indexed
incrementally as they're saved. Deleting a session or chat removes it from the
index.

The index lives at `<data-dir>/search.db` (e.g. `~/.mantis/search.db`). It's a
derived cache — safe to delete; it rebuilds on next use.

---

## Notes

- Queries are tokenized and matched with OR + bm25 ranking, so natural-language
  questions work fine — you don't need exact phrases or special syntax.
- System prompts aren't indexed; swarm/external turns that leave no structured
  messages fall back to their (ANSI-stripped) transcript so they're still
  recallable.
- Re-indexing a conversation replaces its rows rather than duplicating them.
