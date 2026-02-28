# Tools Reference

Mantis gives the AI model 10 tools to interact with your system. The model decides which tools to use and when — you just describe what you want done.

---

## How Tools Work

When you ask the model to do something, it doesn't just generate text. It can make **tool calls** — structured requests to read files, run commands, etc. Mantis executes those calls and feeds the results back to the model, which then decides what to do next.

A single prompt might trigger a chain of tools:

```
You: "Fix the failing test in auth.test.js"

Model thinks → run_command("npm test")         → sees which test fails
Model thinks → read_file("src/auth.js")         → reads the source
Model thinks → read_file("test/auth.test.js")   → reads the test
Model thinks → edit_file("src/auth.js", ...)     → fixes the bug
Model thinks → run_command("npm test")           → confirms fix works
Model responds: "Fixed! The issue was..."
```

This agentic loop runs automatically. The model keeps calling tools until it has a text answer for you.

---

## read_file

Reads the contents of a file and returns it with line numbers.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | yes | File path (relative or absolute) |
| `start_line` | integer | no | Start reading from this line (1-indexed) |
| `end_line` | integer | no | Stop reading at this line (inclusive) |

**Behavior:**
- Returns content with line numbers (e.g., `    1  const x = 5`)
- Files over 1MB are rejected — use `start_line`/`end_line` for large files
- Directories return an error (use `list_files` instead)
- Binary files won't display correctly — stick to text files

**Example output:**
```
E:\project\src\index.js (42 lines):
    1  import express from 'express';
    2  import { router } from './routes.js';
    3
    4  const app = express();
   ...
```

---

## write_file

Creates a new file or completely replaces an existing file's contents.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | yes | File path (relative or absolute) |
| `content` | string | yes | The full file content to write |

**Behavior:**
- Creates parent directories automatically if they don't exist
- Overwrites existing files entirely (use `edit_file` for partial changes)
- Returns confirmation with line count and byte size

**When to use vs edit_file:**
- `write_file` — new files, or when you're rewriting most of a file
- `edit_file` — changing a few lines in an existing file

---

## edit_file

Makes a surgical edit by replacing one exact string with another.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | yes | File path (relative or absolute) |
| `old_string` | string | yes | The exact text to find (must be unique in the file) |
| `new_string` | string | yes | The replacement text |

**Behavior:**
- The `old_string` must match **exactly** — including whitespace, indentation, and newlines
- The `old_string` must appear **exactly once** in the file (prevents ambiguous edits)
- If not found: returns an error with what was searched for
- If found multiple times: returns an error asking for more context

**Why "must be unique"?**

This prevents the model from accidentally changing the wrong occurrence. If a string appears 3 times and the model wants to change the second one, it needs to include enough surrounding context to make the match unique. This is a safety feature.

---

## run_command

Executes a shell command and returns stdout and stderr.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `command` | string | yes | The shell command to run |
| `cwd` | string | no | Working directory (defaults to current) |

**Behavior:**
- Runs in your system shell (bash on Linux, cmd on Windows)
- 60-second timeout by default (configurable in `config.json`)
- 2MB output buffer — very long outputs get truncated
- Returns exit code on failure along with any stdout/stderr
- **Plan mode:** Only read-only commands are allowed (git status, npm list, ls, etc.)

**What's blocked in plan mode:**

Commands that modify state are blocked — things like `git commit`, `npm install`, `rm`, `mkdir`, etc. Read-only commands like `git status`, `git log`, `git diff`, `npm list`, and `ls` work fine.

---

## list_files

Lists files and directories, like `ls` but smarter.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | no | Directory to list (defaults to working directory) |
| `recursive` | boolean | no | List recursively (default: false, max 200 entries) |

**Behavior:**
- Sorts directories first, then files alphabetically
- **Automatically skips noise:** `node_modules`, `.git`, `__pycache__`, `.next`, `dist`, `.cache`, `coverage`, `venv`, `.venv`
- Recursive mode caps at 200 entries and 10 levels deep
- Skipped directories still appear in the list (marked as "skipped")

---

## search_files

Searches file contents using regex patterns — like `grep` but integrated into the agent.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | string | yes | Regex pattern to search for |
| `path` | string | no | Directory or file to search in |
| `file_pattern` | string | no | Filter files by extension (e.g., `*.js`) |

**Behavior:**
- Case-insensitive search
- Returns file path, line number, and matching line content
- Max 50 results
- Skips binary files (images, fonts, archives, executables)
- Skips files larger than 512KB
- Skips the same noise directories as `list_files`

**Example output:**
```
Found 3 match(es):
src/auth/login.js:14: // TODO: add rate limiting
src/auth/signup.js:8: // TODO: validate email format
src/utils/logger.js:22: // TODO: add log rotation
```

---

## find_files

Finds files by name pattern — like `find` or glob matching.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | string | yes | Glob pattern (e.g., `**/*.ts`, `*.json`, `src/**/*.test.js`) |
| `path` | string | no | Base directory to search from |

**Behavior:**
- Supports `*` (any characters except path separator), `**` (any path depth), `?` (single character)
- Max 100 results
- Skips the same noise directories as `list_files`

**Example patterns:**
- `*.json` — all JSON files in the base directory
- `**/*.test.js` — all test files anywhere in the tree
- `src/**/*.ts` — all TypeScript files under src/
- `docker-compose*.yml` — docker compose files with any suffix

---

## save_memory

Saves persistent notes to memory that survive across sessions. The model uses this when you ask it to "save state," "remember this," or "save to memory."

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `content` | string | yes | Markdown content to save |
| `scope` | string | no | `"project"` (default) or `"global"` |
| `mode` | string | no | `"replace"` (default) overwrites, `"append"` adds to the end |

**Behavior:**
- Project memory saves to `.mantis/MEMORY.md` in the project root (committable to git)
- Global memory saves to `~/.mantis/memory/MEMORY.md` (personal, all projects)
- Append mode adds a timestamped separator before the new content
- The model typically reads existing memory first, then replaces with an updated version

**When the model uses it:**

The model is instructed to write well-organized markdown covering: current task and status, key files, decisions made, next steps, and user preferences. It reads existing memory first to avoid losing previous notes.

---

## read_memory

Reads previously saved persistent memory.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `scope` | string | no | `"all"` (default), `"project"`, or `"global"` |

**Behavior:**
- Returns the contents of the memory file(s) with their file paths
- Returns "(none)" for scopes with no saved memory
- The model typically calls this before save_memory to check what already exists

---

## delete_memory

Clears persistent memory.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `scope` | string | yes | `"project"` or `"global"` |

**Behavior:**
- Deletes the memory file for the specified scope
- Cannot be undone — the file is removed from disk
- The model uses this when asked to "forget everything" or "clear memory"
