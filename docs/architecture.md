# Architecture

Mantis is intentionally simple — about 800 lines of JavaScript, no frameworks, easy to understand and hack on. Here's how it all fits together.

---

## The Big Picture

```
┌─────────────────────────────────────────────────────┐
│                     User Terminal                     │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │                   cli.js                         │  │
│  │  - REPL loop (readline)                         │  │
│  │  - Slash commands (/plan, /save, /status, ...)  │  │
│  │  - Streaming display + spinners                 │  │
│  │  - Multiline input                              │  │
│  └──────────────────────┬──────────────────────────┘  │
│                         │                              │
│  ┌──────────────────────▼──────────────────────────┐  │
│  │                  agent.js                        │  │
│  │  - Manages conversation messages[]               │  │
│  │  - Agentic loop (send → tools → send → ...)     │  │
│  │  - Streams SSE from Ollama                      │  │
│  │  - Triggers auto-compaction                     │  │
│  └────────┬─────────────────────────┬──────────────┘  │
│           │                         │                  │
│  ┌────────▼────────┐   ┌───────────▼──────────────┐  │
│  │    tools.js      │   │      context.js          │  │
│  │  - read_file     │   │  - Token estimation      │  │
│  │  - write_file    │   │  - shouldCompact()       │  │
│  │  - edit_file     │   │  - compactMessages()     │  │
│  │  - run_command   │   │  - getContextStats()     │  │
│  │  - list_files    │   └──────────────────────────┘  │
│  │  - search_files  │                                  │
│  │  - find_files    │   ┌──────────────────────────┐  │
│  │  - Plan mode     │   │    conversation.js       │  │
│  │    guard          │   │  - save/load to disk     │  │
│  └──────────────────┘   └──────────────────────────┘  │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │                 skills.js                        │ │
│  │  - Built-in skills (commit, test, review, ...)  │ │
│  │  - User skills (~/.mantis/skills/)          │ │
│  │  - Project skills (.mantis/skills/)         │ │
│  │  - Template expansion ({{args}}, conditionals)  │ │
│  └──────────────────────────────────────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │  config.js │ prompt.js │ tool-definitions.js    │  │
│  │  utils.js  │                                    │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────┬─────────────────────────┘
                            │ HTTP (SSE streaming)
                            │ OpenAI-compatible API
                            ▼
          ┌──────────────────────────────────┐
          │      Any OpenAI-Compatible       │
          │           Endpoint               │
          │                                  │
          │  Local:    Ollama (localhost)     │
          │  Cloud:    OpenAI, Claude,        │
          │            Gemini, Groq,          │
          │            Cerebras, Mistral,     │
          │            + 10 more providers    │
          └──────────────────────────────────┘
```

---

## File-by-File

### `bin/mantis.js`
**3 lines.** Just the entry point with a shebang for Unix compatibility.

### `src/cli.js` — The Interface
The interactive REPL. Handles:
- **Readline loop** — prompt, read input, dispatch
- **Slash commands** — `/plan`, `/save`, `/load`, `/status`, `/compact`, `/model`, `/config`, `/cd`, `/clear`, `/help`
- **Multiline input** — detects `"""` delimiters, buffers lines
- **Streaming display** — renders text character-by-character as it arrives from the model
- **Spinners** — thinking spinner while waiting, tool spinners during execution
- **Status line** — elapsed time, context bar, message count, tool calls after each turn

### `src/agent.js` — The Brain
The agent loop. This is the core of the whole system:

```javascript
while (loopCount < maxLoops) {
    // Send messages to Ollama
    const response = await callOllama(messages);

    // If model returned text only → done, show to user
    if (!response.tool_calls) return;

    // If model returned tool calls → execute each one
    for (const toolCall of response.tool_calls) {
        const result = await executeTool(toolCall.name, toolCall.args);
        messages.push({ role: 'tool', content: result });
    }

    // Loop back — model will see the results and decide what to do next
}
```

It also:
- Initializes the system prompt with the current working directory and mode
- Parses SSE (Server-Sent Events) streaming from Ollama's API
- Assembles tool call deltas from the stream (they arrive in fragments)
- Tracks statistics (turns, tool calls)
- Triggers context compaction when needed
- Caps at 25 iterations per turn as a safety measure

### `src/tools.js` — The Hands
Seven tool implementations that actually interact with the filesystem:

Each tool follows the same pattern:
1. Resolve the path (relative to working directory)
2. Validate inputs
3. Do the work (fs operations, child_process, etc.)
4. Return a string result (the model reads this)

The plan mode guard lives here too — a check at the top of `executeTool()` that blocks write operations when plan mode is active.

### `src/tool-definitions.js` — The Menu
JSON schemas that tell the model what tools are available. These are sent with every API request in the `tools` field. The model uses these schemas to know:
- What tools exist
- What parameters each tool takes
- Which parameters are required
- What each parameter means

### `src/prompt.js` — The Instructions
Builds the system prompt that tells the model who it is and how to behave. Two variants:
- **Normal mode** — full access, standard rules
- **Plan mode** — extra instructions emphasizing read-only exploration

### `src/context.js` — The Memory Manager
Handles the context window:
- **Token estimation** — ~4 chars per token heuristic
- **Compaction** — summarizes older messages, keeps recent ones
- **Stats** — usage percentage, token counts

### `src/conversation.js` — The Notebook
Saves and loads conversation histories to JSON files on disk.

### `src/skills.js` — The Playbook
The skill system. Three layers of skills with priority resolution:
- **Built-in** — 8 skills hardcoded in the module (commit, review, test, etc.)
- **User** — JSON files in `~/.mantis/skills/`, available globally
- **Project** — JSON files in `.mantis/skills/` at the project root, highest priority

Key functions:
- `getAllSkills()` — merges all three sources, later overrides earlier by name
- `expandSkillPrompt(skill, args)` — processes the template language (`{{args}}`, `{{#if args}}...{{/if}}`)
- `matchSkillCommand(input)` — checks if a slash command matches any skill
- `saveSkill()` / `deleteSkill()` — CRUD for user and project skills

The CLI calls `matchSkillCommand()` in its default case — so any `/unknown` command is checked against skills before showing an error.

### `src/config.js` — The Settings
Manages `~/.mantis/config.json` with defaults, load, and save. Also contains the `PROVIDERS` registry — a constant object mapping 17 provider keys to their base URLs, default models, and auth requirements. Adding a new provider is as simple as adding an entry to this object.

### `src/utils.js` — The Paintbrush
Chalk color definitions, tool call formatting, text truncation, duration formatting, context bar rendering.

---

## The API Layer

Mantis talks to any OpenAI-compatible `POST /v1/chat/completions` endpoint. The provider registry in `config.js` defines 17 providers, each with a base URL, default model, and auth requirements.

### How provider switching works

```
config.js: PROVIDERS = {
  local:    { baseUrl: 'http://localhost:11434/v1', ... },
  openai:   { baseUrl: 'https://api.openai.com/v1', ... },
  gemini:   { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', ... },
  groq:     { baseUrl: 'https://api.groq.com/openai/v1', ... },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', ... },
  ...17 total
}
```

The `callLLM()` function in `agent.js` reads the active provider from config, builds the request URL from the base URL, and adds an `Authorization: Bearer <key>` header for cloud providers. The rest — SSE streaming, tool call parsing, message assembly — is identical regardless of provider.

### Request format

```
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}    ← only for cloud providers

{
  "model": "qwen3-coder-cpu",
  "messages": [ ... ],
  "tools": [ ... ],
  "stream": true
}
```

### Response format

Server-Sent Events (SSE) stream where each event is a JSON chunk:
```
data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{\"pa"}}]},"index":0}]}
data: [DONE]
```

The streaming parser in `agent.js` reassembles these fragments into complete messages. This format is the same across all 17 providers — that's the power of the OpenAI-compatible standard.

---

## Adding a New Tool

Want to add a tool? It's three steps:

### 1. Add the schema (`src/tool-definitions.js`)

```javascript
{
  type: "function",
  function: {
    name: "my_new_tool",
    description: "What this tool does — the model reads this to decide when to use it",
    parameters: {
      type: "object",
      properties: {
        param1: { type: "string", description: "What this param is for" }
      },
      required: ["param1"]
    }
  }
}
```

### 2. Implement it (`src/tools.js`)

Add a case in the `executeTool` switch and write the function:

```javascript
case 'my_new_tool': return myNewTool(args);

// ...

function myNewTool({ param1 }) {
  // Do something
  return "Result string that the model will see";
}
```

### 3. Update the system prompt (`src/prompt.js`)

Add a line to the tool usage guidelines so the model knows when to use it:

```
- Use my_new_tool to do X when Y
```

That's it. The model will start using your tool in the next session.

---

## Adding a New Skill

Even simpler — no code changes needed. Two options:

### Option A: Interactive (from inside Mantis)
```
/skill create
```
Follow the prompts. Done.

### Option B: Drop a JSON file

Create `~/.mantis/skills/my-skill.json`:

```json
{
  "name": "my-skill",
  "description": "What this skill does",
  "args": "<required-arg> [optional-arg]",
  "prompt": "Do the thing with {{args}}.\n1. First step\n2. Second step"
}
```

Now `/my-skill` works immediately — no restart needed.

### Skill vs Tool — When to use which

- **Tool** = a capability the model can call programmatically (read files, run commands). Tools are for *mechanics*.
- **Skill** = a prompt template the user invokes as a shortcut. Skills are for *workflows*.

A skill like `/commit` uses multiple tools (run_command, read_file) behind the scenes. You teach the model *what* to do (skill), and it uses *how* to do it (tools).

---

## Design Decisions

**Why Node.js?** It's available everywhere, has great async/streaming support, and the filesystem APIs are solid. Python would work too, but Node was already available and working on the user's machine.

**Why not TypeScript?** Simplicity. Zero build step. You can edit any file and immediately run it. For ~1200 lines, types aren't worth the overhead.

**Why no frameworks?** Every dependency is a liability. `chalk` and `ora` are the only external packages — both are tiny, stable, and do one thing well. Everything else uses Node.js built-ins.

**Why exec instead of spawn for commands?** `exec` buffers output and returns it as a string, which is exactly what we need to send back to the model. For an agentic coding tool, we don't need real-time command output streaming — we need the final result.

**Why estimate tokens instead of counting them?** Real tokenization requires loading the model's vocabulary, which is heavy and model-specific. The 4-chars-per-token estimate is close enough for context management — the important thing is to compact *before* hitting the limit, not to know the exact count.
