/**
 * Persistent memory system.
 *
 * Two layers:
 *  - Global memory:  ~/.mantis/memory/MEMORY.md   (available in all projects)
 *  - Project memory: .mantis/MEMORY.md             (per-project, committable to git)
 *
 * Memory is loaded into the system prompt on every session so the model
 * always has context from previous interactions. The model writes to memory
 * via the save_memory / delete_memory tools when the user asks it to
 * "remember" or "save state."
 *
 * Memory is free-form markdown — the model decides what to write.
 * It can store: task state, user preferences, project notes, key decisions,
 * architecture understanding, in-progress work, etc.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getWorkingDirectory } from './tools.js';

const GLOBAL_MEMORY_DIR = path.join(os.homedir(), '.mantis', 'memory');
const GLOBAL_MEMORY_FILE = path.join(GLOBAL_MEMORY_DIR, 'MEMORY.md');
const PROJECT_MEMORY_DIRNAME = '.mantis';
const PROJECT_MEMORY_FILENAME = 'MEMORY.md';
const HANDOFF_FILENAME = 'HANDOFF.md';

// ─── Read ────────────────────────────────────────────────────────────

export function loadGlobalMemory() {
  ensureGlobalDir();
  if (fs.existsSync(GLOBAL_MEMORY_FILE)) {
    try {
      return fs.readFileSync(GLOBAL_MEMORY_FILE, 'utf-8');
    } catch {
      return '';
    }
  }
  return '';
}

export function loadProjectMemory() {
  const filepath = getProjectMemoryPath();
  if (fs.existsSync(filepath)) {
    try {
      return fs.readFileSync(filepath, 'utf-8');
    } catch {
      return '';
    }
  }
  return '';
}

export function loadAllMemory() {
  const global = loadGlobalMemory();
  const project = loadProjectMemory();
  return { global, project };
}

/**
 * Build a memory block for injection into the system prompt.
 * Returns empty string if no memory exists.
 */
export function buildMemoryBlock() {
  const { global, project } = loadAllMemory();
  const handoff = loadHandoff();
  if (!global && !project && !handoff) return '';

  const parts = [];

  // Handoff block — highest priority, injected first
  if (handoff) {
    parts.push('\n\n## Handoff Tasks (from Claude Code)');
    parts.push(handoff.trim());
    parts.push('### Handoff Instructions');
    parts.push('- Work through each unchecked `- [ ]` task in order.');
    parts.push('- After completing a task, update the handoff file: change `- [ ]` to `- [x]` for that task using edit_file.');
    parts.push('- Read the file before editing. Follow any notes at the bottom of the handoff.');
    parts.push('- When all tasks are checked off, tell the user the handoff is complete.');
  }

  parts.push('\n\n## Persistent Memory (from previous sessions)');

  if (project) {
    parts.push('### Project Memory (.mantis/MEMORY.md)');
    parts.push(project.trim());
  }

  if (global) {
    parts.push('### Global Memory (~/.mantis/memory/MEMORY.md)');
    parts.push(global.trim());
  }

  parts.push('### Memory Instructions');
  parts.push('- The above memory was saved by you in previous sessions.');
  parts.push('- Use it to resume work, recall decisions, and maintain context.');
  parts.push('- When the user asks you to "save state", "remember this", or "save to memory", use the save_memory tool.');
  parts.push('- Keep memory concise and organized. Update or replace stale entries rather than appending endlessly.');

  return parts.join('\n');
}

// ─── Write ───────────────────────────────────────────────────────────

export function saveGlobalMemory(content) {
  ensureGlobalDir();
  fs.writeFileSync(GLOBAL_MEMORY_FILE, content, 'utf-8');
  return GLOBAL_MEMORY_FILE;
}

export function saveProjectMemory(content) {
  const dir = path.join(getWorkingDirectory(), PROJECT_MEMORY_DIRNAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filepath = path.join(dir, PROJECT_MEMORY_FILENAME);
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Append to memory (adds to the end, with a timestamp separator).
 */
export function appendGlobalMemory(content) {
  const existing = loadGlobalMemory();
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const updated = existing
    ? `${existing.trimEnd()}\n\n---\n_Saved: ${timestamp}_\n\n${content}`
    : `_Saved: ${timestamp}_\n\n${content}`;
  return saveGlobalMemory(updated);
}

export function appendProjectMemory(content) {
  const existing = loadProjectMemory();
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const updated = existing
    ? `${existing.trimEnd()}\n\n---\n_Saved: ${timestamp}_\n\n${content}`
    : `_Saved: ${timestamp}_\n\n${content}`;
  return saveProjectMemory(updated);
}

// ─── Delete / Clear ──────────────────────────────────────────────────

export function clearGlobalMemory() {
  if (fs.existsSync(GLOBAL_MEMORY_FILE)) {
    fs.unlinkSync(GLOBAL_MEMORY_FILE);
    return true;
  }
  return false;
}

export function clearProjectMemory() {
  const filepath = getProjectMemoryPath();
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    return true;
  }
  return false;
}

// ─── Handoff ─────────────────────────────────────────────────────

export function getHandoffPath() {
  return path.join(getWorkingDirectory(), PROJECT_MEMORY_DIRNAME, HANDOFF_FILENAME);
}

export function loadHandoff() {
  const filepath = getHandoffPath();
  if (fs.existsSync(filepath)) {
    try {
      return fs.readFileSync(filepath, 'utf-8');
    } catch {
      return '';
    }
  }
  return '';
}

export function saveHandoff(content) {
  const dir = path.join(getWorkingDirectory(), PROJECT_MEMORY_DIRNAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filepath = path.join(dir, HANDOFF_FILENAME);
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

export function clearHandoff() {
  const filepath = getHandoffPath();
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    return true;
  }
  return false;
}

/**
 * Parse handoff markdown and return array of { checked, text } task objects.
 */
export function parseHandoffTasks(content) {
  if (!content) return [];
  const tasks = [];
  for (const line of content.split('\n')) {
    const unchecked = line.match(/^- \[ \] (.+)$/);
    if (unchecked) {
      tasks.push({ checked: false, text: unchecked[1] });
      continue;
    }
    const checked = line.match(/^- \[x\] (.+)$/i);
    if (checked) {
      tasks.push({ checked: true, text: checked[1] });
    }
  }
  return tasks;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getProjectMemoryPath() {
  return path.join(getWorkingDirectory(), PROJECT_MEMORY_DIRNAME, PROJECT_MEMORY_FILENAME);
}

function ensureGlobalDir() {
  if (!fs.existsSync(GLOBAL_MEMORY_DIR)) {
    fs.mkdirSync(GLOBAL_MEMORY_DIR, { recursive: true });
  }
}

export function getMemoryPaths() {
  return {
    global: GLOBAL_MEMORY_FILE,
    project: getProjectMemoryPath(),
  };
}

export function getMemoryStats() {
  const globalContent = loadGlobalMemory();
  const projectContent = loadProjectMemory();
  return {
    globalExists: !!globalContent,
    projectExists: !!projectContent,
    globalSize: globalContent.length,
    projectSize: projectContent.length,
    globalPath: GLOBAL_MEMORY_FILE,
    projectPath: getProjectMemoryPath(),
  };
}
