# Skills

Skills are reusable prompt templates that you invoke as slash commands. Think of them as macros — a short command that expands into a detailed, multi-step prompt and gets sent to the model.

Instead of typing out "look at the git diff, write a commit message, stage the files, and commit" every time, you just type `/commit`.

---

## Using Skills

Type `/` followed by the skill name:

```
  myproject > /commit
  Running skill: /commit
  Stage & commit with AI-generated message
```

Pass arguments after the name:

```
  myproject > /commit Fixes the auth token expiry bug
  myproject > /explain src/auth/middleware.js
  myproject > /test npm run test:unit
  myproject > /fix TypeError: Cannot read properties of undefined
```

---

## Built-in Skills

Mantis ships with 8 skills out of the box:

| Skill | Args | What it does |
|-------|------|-------------|
| `/commit [msg]` | Optional commit message hint | Runs git status + diff, stages files, writes a commit message, commits |
| `/review [branch]` | Optional base branch | Reviews code changes, checks for bugs and style issues, rates the changes |
| `/test [cmd]` | Optional test command | Finds and runs tests. If they fail, reads the code, fixes the bug, re-runs |
| `/explain <target>` | File or function name | Finds the code, traces through the logic, explains how it works |
| `/fix <error>` | Error message or description | Searches for relevant code, diagnoses the root cause, implements a fix |
| `/refactor <target>` | File or function name | Reads the code, identifies improvements, refactors without changing behavior |
| `/deps` | None | Reads dependency files, explains each package, flags issues |
| `/init` | None | Explores the project structure, reads key files, gives you the lay of the land |

### Example: `/commit`

```
  myproject > /commit

  > run_command command=git status
  ✔ run_command done

  > run_command command=git diff
  ✔ run_command done

  > run_command command=git log --oneline -5
  ✔ run_command done

  > run_command command=git add src/auth/middleware.js src/auth/login.js
  ✔ run_command done

  > run_command command=git commit -m "Add rate limiting to login endpoint"
  ✔ run_command done

  Committed: Add rate limiting to login endpoint
  2 files changed, 34 insertions(+), 2 deletions(-)
```

### Example: `/test`

```
  myproject > /test

  > run_command command=npm test
  ✔ run_command done

  2 tests failed. Let me look at the failures...

  > read_file path=src/utils/format.js
  ✔ read_file done

  > read_file path=test/utils/format.test.js
  ✔ read_file done

  Found the issue. The formatDate function doesn't handle null input.

  > edit_file path=src/utils/format.js old_string=... new_string=...
  ✔ edit_file done

  > run_command command=npm test
  ✔ run_command done

  All 47 tests pass now. The fix was adding a null check
  at the top of formatDate().
```

---

## Creating Your Own Skills

### Interactive creation

```
  myproject > /skill create

  Create a new skill
  Skills are reusable prompt templates invoked as /name.

  Skill name (lowercase, no spaces): deploy
  Description (one line): Deploy the current branch to staging
  Arguments hint (e.g., "<file>" or "[message]", or blank for none): [environment]

  Now enter the prompt template.
  Use {{args}} where the user's arguments should go.
  Use {{#if args}}...{{/if}} for conditional sections.
  Type END on a line by itself when done.

  > Deploy to {{#if args}}{{args}}{{else}}staging{{/if}}:
  > 1. Run the tests first — don't deploy broken code.
  > 2. Run "git push origin HEAD"
  > 3. Run "npm run deploy:{{#if args}}{{args}}{{else}}staging{{/if}}"
  > 4. Report the result.
  > END

  Save as (u)ser skill or (p)roject skill? (u/p): p

  Skill "/deploy" created!
  Saved to: D:\myproject\.mantis\skills\deploy.json
  Run it with: /deploy [environment]
```

Now you can use it:

```
  myproject > /deploy production
```

### The prompt template language

Templates support three things:

**1. Argument substitution: `{{args}}`**

Whatever the user types after the skill name gets inserted here.

```
Explain how {{args}} works in this codebase.
```

`/explain the auth flow` → `Explain how the auth flow works in this codebase.`

**2. Conditional sections: `{{#if args}}...{{/if}}`**

Only included if the user provided arguments.

```
Fix the issue. {{#if args}}The error is: {{args}}{{/if}}
```

`/fix` → `Fix the issue.`
`/fix TypeError` → `Fix the issue. The error is: TypeError`

**3. If/else: `{{#if args}}...{{else}}...{{/if}}`**

```
Deploy to {{#if args}}{{args}}{{else}}staging{{/if}}.
```

`/deploy` → `Deploy to staging.`
`/deploy production` → `Deploy to production.`

---

## Skill Scopes

Skills can live in three places, with increasing priority:

| Scope | Location | Shared? | Priority |
|-------|----------|---------|----------|
| **Built-in** | Bundled with Mantis | N/A | Lowest |
| **User** | `~/.mantis/skills/` | No — your machine only | Medium |
| **Project** | `.mantis/skills/` in the project root | Yes — commit to git! | Highest |

**Priority matters:** If a project has a skill named `commit` and there's also a built-in `commit`, the project version wins. This lets teams customize behavior per-project.

### User skills

Available in every project you work on. Good for personal preferences.

```
  > /skill create
  ...
  Save as (u)ser skill or (p)roject skill? (u/p): u
```

Saved to `~/.mantis/skills/skillname.json`.

### Project skills

Live in the project directory and can be committed to git. Good for team-shared workflows.

```
  > /skill create
  ...
  Save as (u)ser skill or (p)roject skill? (u/p): p
```

Saved to `.mantis/skills/skillname.json` in the current project.

Team members who use Mantis will automatically get the project's skills when they work in that repo.

---

## Managing Skills

```
  /skills                     List all available skills
  /skill show <name>          View a skill's prompt template
  /skill create [name]        Create a new skill interactively
  /skill edit <name>          Edit an existing skill
  /skill delete <name>        Delete a user or project skill
  /skill export <name>        Export a skill as JSON (for sharing)
```

### Editing a skill

```
  myproject > /skill edit deploy

  Editing skill: /deploy
  Current description: Deploy the current branch to staging
  Current args: [environment]
  Press Enter to keep current value.

  Description [Deploy the current branch to staging]:
  Arguments [[environment]]:
  Edit the prompt? (y/N): y

  Current prompt:
  Deploy to {{#if args}}{{args}}{{else}}staging{{/if}}:
  ...

  Enter new prompt (type END on a line by itself when done):
  > ...
  > END

  Skill "/deploy" updated!
```

### Exporting and sharing

```
  myproject > /skill export deploy

  Skill: deploy
  Copy this JSON to share or import:

  {
    "name": "deploy",
    "description": "Deploy the current branch to staging",
    "args": "[environment]",
    "prompt": "Deploy to {{#if args}}..."
  }
```

Copy the JSON, send it to someone, and they save it as `~/.mantis/skills/deploy.json`.

---

## Skill File Format

Each skill is a single JSON file:

```json
{
  "name": "deploy",
  "description": "Deploy the current branch to staging",
  "args": "[environment]",
  "prompt": "Deploy to {{#if args}}{{args}}{{else}}staging{{/if}}:\n1. Run the tests first.\n2. Run \"git push origin HEAD\"\n3. Run \"npm run deploy:{{#if args}}{{args}}{{else}}staging{{/if}}\"\n4. Report the result."
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase name, used as the slash command |
| `description` | No | One-line description shown in `/skills` list |
| `args` | No | Hint string shown in help (e.g., `<file>`, `[message]`) |
| `prompt` | Yes | The prompt template with optional `{{args}}` substitution |

You can create skills by hand — just drop a `.json` file in the right directory.

---

## Ideas for Custom Skills

Here are some skills you might want to create:

**`/pr`** — Create a pull request with AI-generated title and description
**`/changelog`** — Generate a changelog from recent commits
**`/migrate`** — Create a database migration
**`/component <name>`** — Scaffold a new React/Vue/Svelte component
**`/api <endpoint>`** — Scaffold a new API endpoint with tests
**`/docker`** — Generate or update a Dockerfile
**`/ci`** — Set up or update CI/CD configuration
**`/security`** — Audit the project for security issues
**`/perf`** — Profile and optimize a slow function
**`/docs <file>`** — Generate documentation for a module

The only limit is your imagination (and the model's context window).
