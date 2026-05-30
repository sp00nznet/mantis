import fs from 'fs';
import path from 'path';
import { exec, execSync } from 'child_process';
import { truncate, augmentedEnv } from './utils.js';
import { getConfig } from './config.js';
import { recordChange } from './checkpoints.js';
import { webFetch, webSearch } from './web.js';
import { generateImage, generateSpeech } from './generate.js';
import {
  loadGlobalMemory, loadProjectMemory, loadAllMemory,
  saveGlobalMemory, saveProjectMemory,
  appendGlobalMemory, appendProjectMemory,
  clearGlobalMemory, clearProjectMemory,
  clearHandoff,
  getMemoryPaths,
} from './memory.js';

let workingDirectory = process.cwd();
let planMode = false;
let _subagentDepth = 0; // guards against sub-agents spawning sub-agents

export function setWorkingDirectory(dir) {
  workingDirectory = dir;
}

export function getWorkingDirectory() {
  return workingDirectory;
}

export function setPlanMode(enabled) {
  planMode = enabled;
}

export function getPlanMode() {
  return planMode;
}

function resolvePath(p) {
  if (!p) return workingDirectory;
  if (path.isAbsolute(p)) return p;
  return path.resolve(workingDirectory, p);
}

// Commands that are considered read-only (allowed in plan mode)
const READ_ONLY_PREFIXES = [
  'ls', 'dir', 'cat', 'head', 'tail', 'type', 'find', 'grep', 'rg',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote',
  'git stash list', 'git tag', 'git blame',
  'npm list', 'npm ls', 'npm view', 'npm info', 'npm outdated',
  'node -v', 'npm -v', 'python --version', 'which', 'where',
  'echo', 'pwd', 'whoami', 'date', 'wc',
];

function isReadOnlyCommand(cmd) {
  const trimmed = cmd.trim().toLowerCase();
  return READ_ONLY_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

export async function executeTool(name, args) {
  // Plan mode guard: block write operations
  if (planMode) {
    const writeTools = ['write_file', 'edit_file', 'generate_image', 'generate_speech'];
    if (writeTools.includes(name)) {
      return `BLOCKED: Plan mode is active. File modifications are not allowed. Use /plan to exit plan mode first.`;
    }
    if (name === 'run_command' && !isReadOnlyCommand(args.command || '')) {
      return `BLOCKED: Plan mode is active. Only read-only commands are allowed. Command "${args.command}" appears to modify state. Use /plan to exit plan mode first.`;
    }
    if (name.startsWith('mcp__')) {
      return `BLOCKED: Plan mode is active. MCP tools may modify state and are disabled. Use /plan to exit plan mode first.`;
    }
  }

  try {
    switch (name) {
      case 'read_file': return readFile(args);
      case 'write_file': return writeFile(args);
      case 'edit_file': return editFile(args);
      case 'run_command': return await runCommand(args);
      case 'list_files': return listFiles(args);
      case 'search_files': return searchFiles(args);
      case 'find_files': return findFiles(args);
      case 'save_memory': return saveMemoryTool(args);
      case 'read_memory': return readMemoryTool(args);
      case 'delete_memory': return deleteMemoryTool(args);
      case 'web_fetch': return await webFetch(args.url, args.raw);
      case 'web_search': return await webSearch(args.query);
      case 'run_subagent': return await runSubagent(args);
      case 'generate_image':
        return await generateImage(args.prompt, args.path || 'generated-image.png', args.size, workingDirectory);
      case 'generate_speech':
        return await generateSpeech(args.text, args.path || 'generated-speech.mp3', args.voice, workingDirectory);
      default:
        // MCP tools are namespaced mcp__<server>__<tool>.
        if (name.startsWith('mcp__')) {
          const { callMcpTool } = await import('./mcp.js');
          return await callMcpTool(name, args);
        }
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ─── Sub-agent ───────────────────────────────────────────────────────

async function runSubagent({ task }) {
  if (!task || !task.trim()) return 'Error: run_subagent needs a task description.';
  if (_subagentDepth >= 1) {
    return 'Error: a sub-agent cannot spawn another sub-agent. Complete this subtask directly.';
  }
  // Dynamic import avoids a static tools.js <-> agent.js import cycle.
  const { createAgent } = await import('./agent.js');
  _subagentDepth++;
  const sub = createAgent();
  let text = '';
  const toolsUsed = [];
  try {
    await sub.chat(task, {
      maxLoops: 30,
      onText: (t) => { text += t; },
      onToolCall: (name) => { toolsUsed.push(name); },
      onToolResult: () => {},
      onError: (e) => { text += `\n[sub-agent error: ${e}]`; },
      onConfirmToolCall: async () => true, // sub-agents auto-approve
      onThinking: () => {},
      onToken: () => {},
      onCompact: () => {},
    });
  } catch (err) {
    return `Sub-agent failed: ${err.message}`;
  } finally {
    _subagentDepth--;
  }
  const report = text.trim() || '(the sub-agent finished without a written summary)';
  const n = toolsUsed.length;
  return `Sub-agent completed the task (${n} tool call${n === 1 ? '' : 's'}).\n\n${report}`;
}

function readFile({ path: filePath, start_line, end_line }) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${resolved}`;
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return `Error: ${resolved} is a directory, not a file. Use list_files instead.`;
  }
  // Skip very large files
  if (stat.size > 1024 * 1024) {
    return `Error: File is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Use start_line/end_line to read a portion.`;
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  const lines = content.split('\n');

  const maxResult = getConfig().maxToolResultSize || 8000;

  if (start_line || end_line) {
    const start = Math.max(1, start_line || 1);
    const end = Math.min(lines.length, end_line || lines.length);
    const numbered = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(5)}  ${line}`)
      .join('\n');
    return `${resolved} (lines ${start}-${end} of ${lines.length}):\n${truncate(numbered, maxResult)}`;
  }

  const numbered = lines
    .map((line, i) => `${String(i + 1).padStart(5)}  ${line}`)
    .join('\n');
  return `${resolved} (${lines.length} lines):\n${truncate(numbered, maxResult)}`;
}

// Run the configured post-edit hooks for a file; returns text to append to
// the tool result so the model sees lint/format/test output.
function runEditHooks(filePath) {
  const hooks = getConfig().hooks?.afterEdit || [];
  if (!Array.isArray(hooks) || hooks.length === 0) return '';
  const out = [];
  for (const raw of hooks) {
    if (!raw || typeof raw !== 'string') continue;
    const cmd = raw.replace(/\{file\}/g, filePath);
    try {
      const r = execSync(cmd, {
        cwd: workingDirectory, encoding: 'utf-8', timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      out.push(`$ ${cmd}\n${(r || '').trim() || '(ok)'}`);
    } catch (err) {
      const o = ((err.stdout || '') + '\n' + (err.stderr || '')).trim();
      out.push(`$ ${cmd}\n[exit ${err.status ?? '?'}] ${o || err.message}`);
    }
  }
  return out.length ? '\n\n— post-edit hooks —\n' + truncate(out.join('\n'), 2500) : '';
}

function writeFile({ path: filePath, content }) {
  const resolved = resolvePath(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  recordChange(resolved);
  fs.writeFileSync(resolved, content, 'utf-8');
  const lineCount = content.split('\n').length;
  return `File written: ${resolved} (${lineCount} lines, ${content.length} bytes)` + runEditHooks(resolved);
}

function editFile({ path: filePath, old_string, new_string, replace_all }) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${resolved}`;
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  const occurrences = content.split(old_string).length - 1;

  if (occurrences === 0) {
    // Provide helpful context for debugging
    const preview = old_string.slice(0, 100);
    return `Error: old_string not found in ${resolved}.\nSearched for: "${preview}${old_string.length > 100 ? '...' : ''}"\nMake sure it matches exactly (including whitespace and indentation). Try reading the file first.`;
  }

  if (replace_all) {
    // Replace ALL occurrences — useful for renaming variables/classes across a file
    const newContent = content.replaceAll(old_string, new_string);
    recordChange(resolved);
    fs.writeFileSync(resolved, newContent, 'utf-8');
    return `File edited: ${resolved} (replaced ${occurrences} occurrence${occurrences > 1 ? 's' : ''}, ${newContent.split('\n').length} lines total)` + runEditHooks(resolved);
  }

  if (occurrences > 1) {
    return `Error: old_string found ${occurrences} times in ${resolved}. It must be unique. Add more surrounding context to make it unique, or use replace_all=true to replace all occurrences.`;
  }

  const newContent = content.replace(old_string, new_string);
  recordChange(resolved);
  fs.writeFileSync(resolved, newContent, 'utf-8');
  return `File edited: ${resolved} (replaced 1 occurrence, ${newContent.split('\n').length} lines total)` + runEditHooks(resolved);
}

function runCommand({ command, cwd }) {
  const execCwd = cwd ? resolvePath(cwd) : workingDirectory;
  const timeout = getConfig().commandTimeout || 60000;

  return new Promise((resolve) => {
    const child = exec(command, {
      cwd: execCwd,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      shell: true,
      windowsHide: true,
      env: augmentedEnv(), // include ~/.local/bin etc. so service-launched mantis finds user tools
    }, (err, stdout, stderr) => {
      const maxResult = getConfig().maxToolResultSize || 8000;
      if (err) {
        const exitCode = err.code ?? 'unknown';
        resolve(truncate(`Exit code: ${exitCode}\n${stdout || ''}\n${stderr || ''}`.trim(), maxResult));
      } else {
        const output = (stdout || '') + (stderr ? `\n(stderr): ${stderr}` : '');
        resolve(truncate(output || '(no output)', maxResult));
      }
    });
  });
}

function listFiles({ path: dirPath, recursive }) {
  const resolved = resolvePath(dirPath);
  if (!fs.existsSync(resolved)) {
    return `Error: Directory not found: ${resolved}`;
  }

  const entries = [];
  const maxEntries = 200;
  const skipDirs = ['node_modules', '.git', '__pycache__', '.next', 'dist', '.cache', 'coverage', '.tox', 'venv', '.venv'];

  function walk(dir, prefix = '', depth = 0) {
    if (entries.length >= maxEntries) return;
    if (depth > 10) return; // prevent infinite recursion
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const item of items) {
      if (entries.length >= maxEntries) break;
      if (item.isDirectory() && skipDirs.includes(item.name)) {
        entries.push(`${prefix}${item.name}/  (skipped)`);
        continue;
      }
      if (item.isDirectory()) {
        entries.push(`${prefix}${item.name}/`);
        if (recursive) {
          walk(path.join(dir, item.name), prefix + '  ', depth + 1);
        }
      } else {
        entries.push(`${prefix}${item.name}`);
      }
    }
  }

  walk(resolved);
  const label = recursive ? ' (recursive)' : '';
  return `${resolved}${label}:\n${entries.join('\n')}${entries.length >= maxEntries ? '\n... (truncated at 200 entries)' : ''}`;
}

function searchFiles({ pattern, path: searchPath, file_pattern }) {
  const resolved = resolvePath(searchPath);
  let regex;
  try {
    regex = new RegExp(pattern, 'i');
  } catch (err) {
    return `Error: Invalid regex pattern: ${err.message}`;
  }
  const results = [];
  const maxResults = 50;
  const skipDirs = ['node_modules', '.git', '__pycache__', '.next', 'dist', '.cache', 'coverage'];
  const binaryExts = /\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|bz2|xz|exe|dll|so|dylib|bin|obj|o|a|lib|class|jar|war|pyc|pyo|wasm)$/i;

  function search(dir, depth = 0) {
    if (results.length >= maxResults || depth > 10) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (results.length >= maxResults) break;
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (skipDirs.includes(item.name)) continue;
        search(fullPath, depth + 1);
      } else {
        if (file_pattern) {
          const ext = file_pattern.replace('*', '');
          if (!item.name.endsWith(ext)) continue;
        }
        if (binaryExts.test(item.name)) continue;

        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 512 * 1024) continue; // skip files > 512KB
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break;
            if (regex.test(lines[i])) {
              const relPath = path.relative(workingDirectory, fullPath);
              results.push(`${relPath}:${i + 1}: ${lines[i].trimEnd()}`);
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  search(resolved);
  return results.length > 0
    ? `Found ${results.length} match(es):\n${results.join('\n')}${results.length >= maxResults ? '\n... (truncated at 50 results)' : ''}`
    : `No matches found for pattern: ${pattern}`;
}

function findFiles({ pattern, path: searchPath }) {
  const resolved = resolvePath(searchPath);
  const results = [];
  const maxResults = 100;
  const skipDirs = ['node_modules', '.git', '__pycache__', '.next', 'dist', '.cache'];

  let globRegex;
  try {
    globRegex = new RegExp(
      '^' + pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '___GLOBSTAR___')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/___GLOBSTAR___/g, '.*')
        .replace(/\?/g, '.') + '$'
    );
  } catch (err) {
    return `Error: Invalid glob pattern: ${err.message}`;
  }

  function walk(dir, depth = 0) {
    if (results.length >= maxResults || depth > 10) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (results.length >= maxResults) break;
      const fullPath = path.join(dir, item.name);
      const relPath = path.relative(resolved, fullPath).replace(/\\/g, '/');

      if (item.isDirectory()) {
        if (skipDirs.includes(item.name)) continue;
        walk(fullPath, depth + 1);
      } else {
        if (globRegex.test(relPath) || globRegex.test(item.name)) {
          results.push(path.relative(workingDirectory, fullPath));
        }
      }
    }
  }

  walk(resolved);
  return results.length > 0
    ? `Found ${results.length} file(s):\n${results.join('\n')}${results.length >= maxResults ? '\n... (truncated at 100 results)' : ''}`
    : `No files found matching pattern: ${pattern}`;
}

// ─── Memory tools ────────────────────────────────────────────────────

function saveMemoryTool({ content, scope, mode }) {
  const target = scope || 'project';
  const writeMode = mode || 'replace';

  if (!content || !content.trim()) {
    return 'Error: content is required. Write what you want to remember.';
  }

  let filepath;
  if (writeMode === 'append') {
    filepath = target === 'global'
      ? appendGlobalMemory(content)
      : appendProjectMemory(content);
  } else {
    filepath = target === 'global'
      ? saveGlobalMemory(content)
      : saveProjectMemory(content);
  }

  return `Memory saved (${target}, ${writeMode}): ${filepath}\nContent length: ${content.length} characters`;
}

function readMemoryTool({ scope }) {
  const target = scope || 'all';
  const paths = getMemoryPaths();

  if (target === 'global') {
    const content = loadGlobalMemory();
    return content
      ? `Global memory (${paths.global}):\n\n${content}`
      : `No global memory found at ${paths.global}`;
  }

  if (target === 'project') {
    const content = loadProjectMemory();
    return content
      ? `Project memory (${paths.project}):\n\n${content}`
      : `No project memory found at ${paths.project}`;
  }

  // all
  const { global, project } = loadAllMemory();
  const parts = [];

  if (project) {
    parts.push(`=== Project Memory (${paths.project}) ===\n\n${project}`);
  } else {
    parts.push(`=== Project Memory ===\n(none)`);
  }

  if (global) {
    parts.push(`=== Global Memory (${paths.global}) ===\n\n${global}`);
  } else {
    parts.push(`=== Global Memory ===\n(none)`);
  }

  return parts.join('\n\n');
}

function deleteMemoryTool({ scope }) {
  if (scope === 'global') {
    const cleared = clearGlobalMemory();
    return cleared ? 'Global memory cleared.' : 'No global memory to clear.';
  }
  if (scope === 'project') {
    const cleared = clearProjectMemory();
    return cleared ? 'Project memory cleared.' : 'No project memory to clear.';
  }
  if (scope === 'handoff') {
    const cleared = clearHandoff();
    return cleared ? 'Handoff file cleared.' : 'No handoff file to clear.';
  }
  return 'Error: scope must be "project", "global", or "handoff".';
}
