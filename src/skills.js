/**
 * Skill system — reusable prompt templates invoked as /skillname.
 *
 * Skills are like macros: a slash command that expands into a full prompt
 * (optionally with arguments) and gets sent to the agent as if the user
 * typed it. They can include instructions, context, multi-step workflows,
 * and variable substitution.
 *
 * Storage: ~/.mantis/skills/
 * Two on-disk formats are supported, side by side:
 *   1. JSON      — one <name>.json file (Mantis-native).
 *   2. SKILL.md  — a <name>/ folder containing SKILL.md with YAML frontmatter
 *                  (name, description, argument-hint) plus a markdown body. This
 *                  is the agentskills.io / Claude Code standard, so skills can be
 *                  shared with — or borrowed from — that ecosystem. The folder
 *                  may bundle resource files the skill body references.
 *
 * Built-in skills ship with Mantis. User skills override built-ins
 * if they share the same name.
 *
 * Project skills can also live in .mantis/skills/ at the project root
 * and take highest priority (project > user > built-in).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getWorkingDirectory } from './tools.js';

const USER_SKILLS_DIR = path.join(os.homedir(), '.mantis', 'skills');
const PROJECT_SKILLS_DIRNAME = '.mantis/skills';

// ─── Built-in skills ────────────────────────────────────────────────

const BUILTIN_SKILLS = [
  {
    name: 'commit',
    description: 'Stage and commit changes with an AI-generated message',
    args: '[message]',
    prompt: `Look at the current git status and diff. Then create a git commit:
1. Run "git status" to see what's changed.
2. Run "git diff" (and "git diff --cached" if there are staged files) to see the actual changes.
3. Run "git log --oneline -5" to see recent commit message style.
4. Stage the relevant changed files with "git add" (be specific — don't use "git add .").
5. Write a concise commit message that describes the WHY not the WHAT. Follow the style of recent commits.
{{#if args}}Use this as guidance for the commit message: {{args}}{{/if}}
6. Create the commit.
7. Show the result with "git log --oneline -1".`,
  },
  {
    name: 'review',
    description: 'Review code changes in the current branch',
    args: '[branch]',
    prompt: `Review the code changes {{#if args}}between the current branch and {{args}}{{else}}that are uncommitted or staged{{/if}}:
1. Run "git status" to see the state.
2. Run "git diff {{#if args}}{{args}}...HEAD{{else}}HEAD{{/if}}" to see all changes.
3. For each changed file, analyze:
   - Is the logic correct?
   - Are there potential bugs, edge cases, or security issues?
   - Is the code clean and following project conventions?
   - Are there missing error handlers or input validation?
4. Summarize your findings with specific line references.
5. Rate the changes: looks good / minor issues / needs work.`,
  },
  {
    name: 'test',
    description: 'Run tests and fix any failures',
    args: '[test command]',
    prompt: `Run the project's tests and handle any failures:
1. {{#if args}}Run: {{args}}{{else}}Look for a test script in package.json, Makefile, or common patterns (npm test, pytest, cargo test, go test ./...). Run it.{{/if}}
2. If all tests pass, report success.
3. If any tests fail:
   a. Read the failing test file to understand what's expected.
   b. Read the source file being tested.
   c. Identify the bug and fix it.
   d. Re-run the tests to confirm the fix.
   e. Repeat if needed.`,
  },
  {
    name: 'explain',
    description: 'Explain how a file or function works',
    args: '<file or function>',
    prompt: `Explain how {{args}} works:
1. Find and read the relevant file(s).
2. If it's a function name, search for its definition.
3. Trace through the logic step by step.
4. Explain:
   - What it does (high level)
   - How it works (key logic)
   - What it depends on (imports, other functions)
   - Any non-obvious behavior or gotchas
Keep it concise — focus on what a developer needs to know to work with this code.`,
  },
  {
    name: 'fix',
    description: 'Diagnose and fix a bug or error',
    args: '<error or description>',
    prompt: `Diagnose and fix this issue: {{args}}

1. Search the codebase for relevant code related to the error.
2. Read the files involved.
3. Identify the root cause.
4. Implement a fix.
5. If there are tests, run them to verify the fix.
6. Explain what went wrong and what you changed.`,
  },
  {
    name: 'refactor',
    description: 'Refactor a file or function',
    args: '<file or function>',
    prompt: `Refactor {{args}}:
1. Read the file/function.
2. Identify improvements:
   - Clarity and readability
   - Removing duplication
   - Better naming
   - Simplifying logic
   - Splitting overly long functions
3. Make the changes.
4. If tests exist, run them to make sure nothing broke.
5. Summarize what you changed and why.
Do NOT change behavior — this is a pure refactor.`,
  },
  {
    name: 'deps',
    description: 'Analyze project dependencies',
    args: '',
    prompt: `Analyze the project's dependencies:
1. Find and read the dependency file (package.json, requirements.txt, Cargo.toml, go.mod, etc.).
2. List all dependencies with a one-line description of what each does.
3. Flag any concerns:
   - Outdated packages (check if there's a lock file with versions)
   - Duplicate functionality
   - Known problematic packages
   - Unused dependencies (search for their imports in the codebase)
4. Suggest any improvements.`,
  },
  {
    name: 'init',
    description: 'Explore and summarize the current project',
    args: '',
    prompt: `Explore and summarize this project:
1. List the top-level files and directories.
2. Read key files: README, package.json (or equivalent), main entry point, config files.
3. Provide a summary:
   - What this project is
   - Tech stack and key dependencies
   - Project structure overview
   - How to build/run/test it
   - Any notable patterns or conventions
This is my first time looking at this codebase, so give me the lay of the land.`,
  },
  {
    name: 'research',
    description: 'Research a topic on the web and write a cited summary',
    args: '<topic or question>',
    prompt: `Research this topic and produce a well-sourced summary: {{args}}

1. Use web_search to find relevant, current sources — run several searches from different angles.
2. Use web_fetch to read the most promising results in full.
3. Cross-check facts across at least three independent sources; note where they disagree.
4. Write a clear, structured summary:
   - A direct answer / overview up front
   - Key findings with the specifics that matter
   - Caveats, open questions, or conflicting information
5. End with a Sources list — the URLs you actually used.
Be accurate over comprehensive. If something can't be verified, say so plainly.`,
  },
  {
    name: 'design',
    description: 'Design and build a website or UI',
    args: '<what to build>',
    prompt: `Design and build this UI: {{args}}

1. If I attached an image (a mockup or screenshot), study it closely and match the layout,
   spacing, colours, and typography. If not, propose a clean, modern design yourself.
2. Choose the stack — default to a single self-contained HTML file with embedded CSS (and
   minimal JS). If the project already uses a framework, follow it instead.
3. Build it:
   - Semantic, accessible HTML
   - A cohesive colour palette and a consistent spacing scale
   - A responsive, mobile-friendly layout
   - Tasteful detail — hover states, transitions — without overdoing it
4. Write the file(s), then say how to open/run the result and flag anything to review.
Aim for something that looks intentional and polished, not a generic template.`,
  },
  {
    name: 'clone',
    description: 'Clone a website or app — pass a URL or a local path and get a working rebuild',
    args: '<url or local path>',
    prompt: `Clone this and rebuild it as a working project: {{args}}

## First, identify the target
- If it starts with http(s):// it is a live WEBSITE to clone.
- Otherwise treat it as a local PATH — an existing app/codebase to clone. Run list_files on it to confirm.

## Cloning a WEBSITE
1. Fetch the page source with web_fetch using raw=true to get the actual HTML. Also fetch every
   linked stylesheet (<link rel="stylesheet">), and note any inline <style> blocks.
2. If a browser-automation MCP server is connected (check for mcp__ tools that navigate, screenshot,
   or evaluate JS), use it — it gives far higher fidelity: real screenshots, computed styles via
   getComputedStyle(), and the page's scroll/hover/click behaviour. If none is connected, work from
   the raw HTML/CSS and mention that a browser MCP server (e.g. Playwright MCP) would improve accuracy.
3. Extract the real material — never approximate:
   - Design tokens: colours, fonts (including Google Font links), spacing, radii, shadows.
   - Structure: every distinct section of the page, top to bottom.
   - Content: the actual text and labels, verbatim.
   - Assets: image / SVG / video URLs — download them into an assets/ folder (web_fetch or curl).
   - Behaviour: sticky/var headers, hover states, scroll animations, tabs, carousels.
4. Rebuild it:
   - Default to a clean, self-contained site (semantic HTML + one CSS file + minimal JS). Match a
     framework instead only if I ask for one or the project already uses it.
   - Recreate it section by section. For a large page, use run_subagent to build independent
     sections — give each sub-agent the exact tokens, content, and asset paths for its section.
   - Wire up the downloaded assets and the interactive behaviour.
5. QA: serve/open the result and compare it to the original section by section; fix the gaps.

## Cloning an APP (local path)
1. Explore the codebase — list_files, read the entry point, config, and key modules. Work out the
   stack, structure, and what the app actually does.
2. Summarise it back to me: purpose, stack, main features, architecture.
3. Rebuild it — a faithful reimplementation, a port to another stack, or a clean rewrite. If I
   didn't say which, do a faithful reimplementation and note that I can ask for a port instead.
4. Recreate features incrementally, verifying the build/tests as you go.

## Always
- A clone uses the original's real content and assets — not lorem ipsum or placeholders.
- Only clone what you can legitimately access: for anything behind a login, clone the public pages.
- When done, report what you built, how to run it, and anything you could not reproduce
  (server-rendered data, auth, real-time features).`,
  },
];

// ─── Skill management ───────────────────────────────────────────────

function ensureSkillsDir() {
  if (!fs.existsSync(USER_SKILLS_DIR)) {
    fs.mkdirSync(USER_SKILLS_DIR, { recursive: true });
  }
}

function getProjectSkillsDir() {
  const cwd = getWorkingDirectory();
  return path.join(cwd, PROJECT_SKILLS_DIRNAME);
}

/**
 * Parse YAML frontmatter from a SKILL.md file. Handles the simple `key: value`
 * subset agentskills.io uses (quoted values stripped); the rest is the body.
 */
function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[kv[1].toLowerCase()] = val;
  }
  return { meta, body: (m[2] || '').trim() };
}

function loadSkillsFromDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const skills = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // dir unreadable
  }
  for (const ent of entries) {
    try {
      if (ent.isDirectory()) {
        // agentskills.io: <dir>/<name>/SKILL.md
        const skillDir = path.join(dir, ent.name);
        const skillFile = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const { meta, body } = parseFrontmatter(fs.readFileSync(skillFile, 'utf-8'));
        if (!body) continue;
        skills.push({
          name: (meta.name || ent.name).toLowerCase(),
          description: meta.description || '',
          args: meta['argument-hint'] || meta.args || '',
          prompt: body,
          dir: skillDir,
          format: 'md',
        });
      } else if (ent.name.endsWith('.json')) {
        const data = JSON.parse(fs.readFileSync(path.join(dir, ent.name), 'utf-8'));
        if (data.name && data.prompt) {
          skills.push({ ...data, format: 'json' });
        }
      }
    } catch {
      // skip broken files / folders
    }
  }
  return skills;
}

/**
 * Get all available skills. Priority: project > user > built-in.
 * Later entries override earlier ones by name.
 */
export function getAllSkills() {
  const byName = new Map();

  // Built-ins first (lowest priority)
  for (const skill of BUILTIN_SKILLS) {
    byName.set(skill.name, { ...skill, source: 'built-in' });
  }

  // User skills
  for (const skill of loadSkillsFromDir(USER_SKILLS_DIR)) {
    byName.set(skill.name, { ...skill, source: 'user' });
  }

  // Project skills (highest priority)
  for (const skill of loadSkillsFromDir(getProjectSkillsDir())) {
    byName.set(skill.name, { ...skill, source: 'project' });
  }

  return Array.from(byName.values());
}

export function getSkill(name) {
  const all = getAllSkills();
  return all.find(s => s.name === name) || null;
}

/**
 * Persist a skill. format 'json' (default) keeps the Mantis-native file;
 * format 'md' writes an agentskills.io folder (<name>/SKILL.md) so the skill is
 * portable to Claude Code and the wider ecosystem.
 */
export function saveSkill(skill, scope = 'user', { format = 'json' } = {}) {
  const dir = scope === 'project' ? getProjectSkillsDir() : USER_SKILLS_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (format === 'md') {
    const skillDir = path.join(dir, sanitizeName(skill.name));
    fs.mkdirSync(skillDir, { recursive: true });
    const desc = (skill.description || '').replace(/\r?\n/g, ' ').trim();
    const lines = ['---', `name: ${skill.name}`, `description: ${desc}`];
    if (skill.args) lines.push(`argument-hint: ${skill.args}`);
    lines.push('---', '', skill.prompt.trim(), '');
    const filepath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(filepath, lines.join('\n'), 'utf-8');
    return filepath;
  }

  const filename = `${sanitizeName(skill.name)}.json`;
  const filepath = path.join(dir, filename);

  const data = {
    name: skill.name,
    description: skill.description || '',
    args: skill.args || '',
    prompt: skill.prompt,
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  return filepath;
}

export function deleteSkill(name, scope = 'user') {
  const dir = scope === 'project' ? getProjectSkillsDir() : USER_SKILLS_DIR;
  const base = sanitizeName(name);

  const jsonPath = path.join(dir, `${base}.json`);
  if (fs.existsSync(jsonPath)) {
    fs.unlinkSync(jsonPath);
    return true;
  }
  // agentskills.io folder form
  const folderPath = path.join(dir, base);
  if (fs.existsSync(path.join(folderPath, 'SKILL.md'))) {
    fs.rmSync(folderPath, { recursive: true, force: true });
    return true;
  }
  return false;
}

/**
 * Expand a skill's prompt template with arguments.
 * Supports simple {{args}} substitution and {{#if args}}...{{/if}} conditionals.
 */
export function expandSkillPrompt(skill, argsStr) {
  let prompt = skill.prompt;

  // Handle if/else FIRST (more specific pattern matches before simpler one)
  // {{#if args}}...{{else}}...{{/if}}
  prompt = prompt.replace(/\{\{#if args\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, ifContent, elseContent) => {
    return argsStr ? ifContent : elseContent;
  });

  // Handle simple conditionals: {{#if args}}...{{/if}} (no else)
  prompt = prompt.replace(/\{\{#if args\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, content) => {
    return argsStr ? content : '';
  });

  // Substitute {{args}}
  prompt = prompt.replace(/\{\{args\}\}/g, argsStr || '');

  prompt = prompt.trim();

  // For folder (SKILL.md) skills that bundle resource files, point the agent at
  // them so the body can reference scripts/templates/etc. by name.
  if (skill.dir) {
    try {
      const extras = fs.readdirSync(skill.dir).filter(f => f !== 'SKILL.md');
      if (extras.length) {
        prompt += `\n\n---\nThis skill bundles resource files in ${skill.dir}:\n` +
          extras.map(f => `  - ${f}`).join('\n') +
          `\nRead them with read_file when the steps above refer to them.`;
      }
    } catch { /* dir vanished — ignore */ }
  }

  return prompt;
}

/**
 * Check if a slash command matches a skill name.
 * Returns { skill, args } or null.
 */
export function matchSkillCommand(input) {
  if (!input.startsWith('/')) return null;

  const parts = input.slice(1).split(/\s+/);
  const name = parts[0].toLowerCase();
  const argsStr = parts.slice(1).join(' ');

  const skill = getSkill(name);
  if (!skill) return null;

  return { skill, args: argsStr };
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
}

export { USER_SKILLS_DIR, BUILTIN_SKILLS };
