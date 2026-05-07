#!/usr/bin/env node
/**
 * Reverse of patch-destinations.mjs. Strips the webchat sentinel block
 * from container/agent-runner/src/destinations.ts and removes the call
 * sites we injected into both branches of buildDestinationsSection.
 *
 * Idempotent — no-op if the file is already unpatched (no sentinel).
 *
 * Run from the project root:
 *   node .claude/skills/add-webchat/install/unpatch-destinations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = resolve(process.cwd(), 'container/agent-runner/src/destinations.ts');
const SENTINEL_START = '// webchat:send-file-hint START — installed by /add-webchat';
const SENTINEL_END = '// webchat:send-file-hint END';

// These have to match patch-destinations.mjs exactly.
const SINGLE_ANCHOR =
  "      'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool.',\n      ...(webchatHasChannel(all) ? ['', sendFileHint()] : []),\n    ].join('\\n');";

const SINGLE_RESTORE =
  "      'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool.',\n    ].join('\\n');";

const MULTI_ANCHOR =
  "  lines.push(\n    'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool with the `to` parameter set to a destination name.',\n  );\n  if (webchatHasChannel(all)) {\n    lines.push('', sendFileHint());\n  }\n  return lines.join('\\n');";

const MULTI_RESTORE =
  "  lines.push(\n    'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool with the `to` parameter set to a destination name.',\n  );\n  return lines.join('\\n');";

function die(msg) {
  console.error(`unpatch-destinations.mjs: ${msg}`);
  process.exit(1);
}

let src;
try {
  src = readFileSync(TARGET, 'utf8');
} catch (err) {
  die(`could not read ${TARGET}: ${err.message}`);
}

if (!src.includes(SENTINEL_START)) {
  console.log(`Not patched (no webchat sentinel found in ${TARGET}). Nothing to do.`);
  process.exit(0);
}

// Strip the sentinel block. We use a non-greedy match between the START
// and END markers, allowing for any leading newline preceding START.
const SENTINEL_BLOCK_RE = new RegExp(`\\n?${escapeForRegex(SENTINEL_START)}[\\s\\S]*?${escapeForRegex(SENTINEL_END)}\\n?`, 'g');

let restored = src.replace(SENTINEL_BLOCK_RE, '');

// Reverse the call-site injections. If either anchor is missing (e.g. the
// file was hand-edited after install), warn but don't abort — leaving a
// stray hint call won't compile, so the operator will see it on rebuild.
if (restored.includes(SINGLE_ANCHOR)) {
  restored = restored.replace(SINGLE_ANCHOR, SINGLE_RESTORE);
} else {
  console.warn('  WARN: single-destination call site not found — file may have been hand-edited');
}
if (restored.includes(MULTI_ANCHOR)) {
  restored = restored.replace(MULTI_ANCHOR, MULTI_RESTORE);
} else {
  console.warn('  WARN: multi-destination call site not found — file may have been hand-edited');
}

writeFileSync(TARGET, restored);
console.log(`Unpatched ${TARGET}.`);
console.log('Rebuild the container image to pick this up: ./container/build.sh');

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
