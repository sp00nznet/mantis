# Context Management

AI models have a limited "memory" — called the context window. Mantis manages this automatically so you don't have to think about it.

---

## The Problem

Every message you send, every file the model reads, every tool result — it all goes into the context window. The Qwen3-Coder model has a 32,768 token context window (roughly 25,000 words). In a busy coding session with lots of file reads and edits, you can fill that up fast.

Without management, the model would simply crash with an error when the context overflows. That's a terrible experience. Mantis does something better.

---

## How It Works

### Token Tracking

Mantis estimates token usage for every message in the conversation. After each turn, you see the current usage in the status line:

```
  2.1s | context: [============        ] 58% | 24 msgs | 7 tool calls
```

That bar shows how full your context window is. Green means plenty of room. Yellow means getting full. Red means compaction is imminent.

### Auto-Compaction

When the context reaches **75%** of the limit (configurable), Mantis automatically compacts the conversation:

1. **Keeps** the system prompt (always needed)
2. **Summarizes** older messages into a condensed format
3. **Preserves** the most recent ~30% of messages in full detail
4. **Inserts** the summary as context for the model

You see it happen:
```
  [Context compacted: 47 messages → 18 messages]
```

The model seamlessly continues with the summarized context. It knows what you discussed before — just not every detail of every tool result from 30 messages ago.

### What Gets Summarized

The summary captures the *shape* of earlier conversation:

```
Previous conversation summary (29 messages compressed):
- User asked: Can you look at the auth module and add rate limiting?
- Assistant used tools: list_files, read_file, read_file
- Assistant responded: I see the auth flow. Here's what I'll do...
- User asked: Also add logging for failed login attempts
- Assistant used tools: edit_file, edit_file, run_command
- Assistant responded: Done! Added rate limiting and failure logging...
```

Tool results (which are usually very long) are dropped from the summary. The model keeps the thread of what happened without the bulk.

---

## Manual Control

### `/status` — Check context usage

```
  myproject > /status

  Status
  Model:       qwen3-coder-cpu
  Ollama:      http://localhost:11434
  Working dir: D:\myproject
  Plan mode:   off
  Context:     [========            ] 42% (13,762 / 32,768 tokens)
  Messages:    18
  Tool calls:  6
  Turns:       4
```

### `/compact` — Force compaction now

Don't want to wait for auto-compaction? Do it manually:

```
  myproject > /compact
  Compacted: 34 messages → 14 messages
```

Useful when you know you're about to do something that generates a lot of context (like reading several large files).

### `/clear` — Nuclear option

Wipe everything and start fresh:

```
  myproject > /clear
  Conversation cleared.
```

This is a full reset — no history, no summary, nothing. Use this when you're switching to a completely different task.

---

## Configuration

In `~/.mantis/config.json`:

```json
{
  "maxContextTokens": 32768,
  "compactThreshold": 0.75
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `maxContextTokens` | 32768 | Total context window size in tokens |
| `compactThreshold` | 0.75 | Compact when this fraction of the window is used |

### Tuning tips

- **Lower `compactThreshold`** (e.g., 0.5) if you want more aggressive compaction — keeps context smaller but loses detail sooner
- **Raise `compactThreshold`** (e.g., 0.9) if you want to use more context before compacting — more detail but risks running close to the limit
- **Adjust `maxContextTokens`** if you're using a model with a different context size

---

## Token Estimation

Mantis estimates tokens using the rule of thumb: **~4 characters per token** for English text and code. This isn't perfectly accurate (different tokenizers vary), but it's close enough for context management. The goal is to compact *before* hitting the actual limit, not to count tokens precisely.

---

## Tips for Long Sessions

1. **Save periodically.** Use `/save` to checkpoint your conversation. If you `/clear` and need to go back, you can `/load` it.

2. **Let it compact.** Don't fight the compaction — it's designed to keep the model functional. The most recent context (where you're actively working) is always preserved in full.

3. **Use plan mode wisely.** Planning sessions generate lots of read-heavy context (reading many files). Consider `/compact` after a big exploration before switching to implementation.

4. **Break up mega-tasks.** If you're doing 10 different things in one session, consider `/clear` between unrelated tasks. A focused context is better than a cluttered one.
