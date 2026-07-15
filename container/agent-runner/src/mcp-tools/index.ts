/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append it to TOOL_MODULES below.
 *
 * Modules load with per-module isolation: one tool module throwing at import
 * costs only its own tools, never the server. Before this, a single bad
 * module killed the whole barrel — every nanoclaw MCP tool gone for every
 * agent, masked because <message> envelopes bypass MCP entirely.
 */
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const TOOL_MODULES = ['./core.js', './interactive.js', './agents.js', './self-mod.js', './draft-skill.js'];
for (const mod of TOOL_MODULES) {
  try {
    await import(mod);
  } catch (err) {
    log(`ERROR: tool module ${mod} failed to load — its tools are unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
