// Phase 4 test: Mantis MCP client <-> Mantis MCP server round-trip.
// Spawns `mantis mcp-server --read-only` and connects the client to it.
import os from 'os'; import path from 'path'; import fs from 'fs';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.join(here, '..', 'bin', 'mantis.js');

const home = path.join(os.tmpdir(), 'mantis-mcp-' + Date.now().toString(36));
fs.mkdirSync(home, { recursive: true });
process.env.MANTIS_HOME = home;
// Configure the client to launch our own server as an MCP server.
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  mcpServers: {
    selfTest: { command: process.execPath, args: [binPath, 'mcp-server', '--read-only'] },
  },
}));

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const { loadConfig } = await import('../src/config.js');
loadConfig();
const mcp = await import('../src/mcp.js');

await mcp.initMcp();

const status = mcp.mcpStatus();
check('server connected', status.length === 1 && status[0].connected);
check('server advertised tools', status[0].tools > 0);
check('read-only: no resources/prompts', status[0].resources === 0 && status[0].prompts === 0);

const tools = mcp.getMcpTools();
const names = tools.map(t => t.function.name);
check('client discovered list_files tool', names.includes('mcp__selfTest__list_files'));
check('read-only excludes write_file', !names.includes('mcp__selfTest__write_file'));

// Call a tool across the bridge: list the temp home directory.
const out = await mcp.callMcpTool('mcp__selfTest__list_files', { path: home });
check('tool call returns content', typeof out === 'string' && out.includes('config.json'));

// Resources/prompts probes degraded gracefully (server returns empty arrays).
check('getMcpResources empty (no crash)', Array.isArray(mcp.getMcpResources()) && mcp.getMcpResources().length === 0);
check('getMcpPrompts empty (no crash)', Array.isArray(mcp.getMcpPrompts()) && mcp.getMcpPrompts().length === 0);

// Unknown tool is handled.
const bad = await mcp.callMcpTool('mcp__selfTest__does_not_exist', {});
check('unknown tool reported, not thrown', typeof bad === 'string');

console.log(`\n${pass} passed, ${fail} failed`);
mcp.shutdownMcp();
try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
setTimeout(() => process.exit(fail ? 1 : 0), 200);
