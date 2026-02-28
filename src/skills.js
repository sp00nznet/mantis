/**
 * Skill system — reusable prompt templates invoked as /skillname.
 *
 * Skills are like macros: a slash command that expands into a full prompt
 * (optionally with arguments) and gets sent to the agent as if the user
 * typed it. They can include instructions, context, multi-step workflows,
 * and variable substitution.
 *
 * Storage: ~/.mantis/skills/
 * Format:  One JSON file per skill.
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

function loadSkillsFromDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const skills = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        if (data.name && data.prompt) {
          skills.push(data);
        }
      } catch {
        // skip broken files
      }
    }
  } catch {
    // dir unreadable
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

export function saveSkill(skill, scope = 'user') {
  const dir = scope === 'project' ? getProjectSkillsDir() : USER_SKILLS_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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
  const filename = `${sanitizeName(name)}.json`;
  const filepath = path.join(dir, filename);

  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
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

  return prompt.trim();
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
