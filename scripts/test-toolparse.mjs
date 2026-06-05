// Smoke test for Phase 1: Hermes/Qwen XML tool-call parsing + runaway guard.
// Run: node scripts/test-toolparse.mjs
import { _internals } from '../src/agent.js';
const { parseTextToolCalls, stripToolCallMarkup, tailRepetition, stripTrailingRepetition } = _internals;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name); }
}

// --- 1. Qwen3-Coder XML format (the active NIM model's real output) ---
const qwen = `I'll read the file.
<tool_call>
<function=read_file>
<parameter=path>
src/agent.js
</parameter>
<parameter=limit>
50
</parameter>
</function>
</tool_call>`;
const a = parseTextToolCalls(qwen);
check('qwen: one call parsed', a.length === 1);
check('qwen: name = read_file', a[0]?.function.name === 'read_file');
const aArgs = JSON.parse(a[0].function.arguments);
check('qwen: path arg', aArgs.path === 'src/agent.js');
check('qwen: limit coerced to number', aArgs.limit === 50);

// --- 2. Bare <function=> without <tool_call> wrapper ---
const bare = `<function=run_command><parameter=command>ls -la</parameter></function>`;
const b = parseTextToolCalls(bare);
check('bare: parsed', b.length === 1 && b[0].function.name === 'run_command');
check('bare: arg', JSON.parse(b[0].function.arguments).command === 'ls -la');

// --- 3. Hermes JSON-in-tags ---
const hermes = `<tool_call>{"name": "read_file", "arguments": {"path": "x.txt"}}</tool_call>`;
const c = parseTextToolCalls(hermes);
check('hermes: parsed', c.length === 1 && JSON.parse(c[0].function.arguments).path === 'x.txt');

// --- 4. Unknown tool name is ignored ---
const unknown = `<function=totally_made_up><parameter=x>1</parameter></function>`;
check('unknown tool ignored', parseTextToolCalls(unknown).length === 0);

// --- 5. MCP-qualified name accepted ---
const mcp = `<function=mcp__brave__search><parameter=q>hi</parameter></function>`;
const e = parseTextToolCalls(mcp);
check('mcp name accepted', e.length === 1 && e[0].function.name === 'mcp__brave__search');

// --- 6. Existing JSON fence fallback still works ---
const fence = 'Sure:\n```json\n{"name":"read_file","arguments":{"path":"y"}}\n```';
check('json fence still works', parseTextToolCalls(fence).length === 1);

// --- 7. Markup stripping ---
check('strip removes function tags', stripToolCallMarkup('hi ' + bare).trim() === 'hi');
check('strip removes tool_call tags', stripToolCallMarkup('done ' + hermes).trim() === 'done');

// --- 8. Runaway detection: </function> spam ---
const spam = 'Working on it.' + '</function>'.repeat(300);
check('runaway detected', !!tailRepetition(spam));
const stripped = stripTrailingRepetition(spam);
check('runaway stripped to real content', stripped === 'Working on it.');

// --- 9. Newline-terminated unit spam ---
const spam2 = 'text\n' + '</function>\n'.repeat(100);
check('runaway w/ newline detected', !!tailRepetition(spam2));

// --- 10. Normal prose NOT flagged ---
const normal = 'The quick brown fox jumps over the lazy dog. '.repeat(3) + 'Final answer: 42.';
check('normal prose not flagged', tailRepetition(normal) === null);

// --- 11. Short repetition under threshold not flagged ---
check('few reps not flagged', tailRepetition('ok' + 'ab'.repeat(3)) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
