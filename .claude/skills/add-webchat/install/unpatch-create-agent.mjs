#!/usr/bin/env node
/**
 * Reverse of patch-create-agent.mjs. Strips both sentinel-bounded blocks.
 * Idempotent — no-op if no sentinel is found.
 *
 * Run from the project root:
 *   node .claude/skills/add-webchat/install/unpatch-create-agent.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = resolve(process.cwd(), 'src/modules/agent-to-agent/create-agent.ts');
const SENTINEL_START = '// webchat:create-agent-gating START — installed by /add-webchat';
const SENTINEL_END = '// webchat:create-agent-gating END';
const CALL_SENTINEL_START = '// webchat:create-agent-gating-call START — installed by /add-webchat';
const CALL_SENTINEL_END = '// webchat:create-agent-gating-call END';

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function die(msg) {
  console.error(`unpatch-create-agent.mjs: ${msg}`);
  process.exit(1);
}

let src;
try {
  src = readFileSync(TARGET, 'utf8');
} catch (err) {
  die(`could not read ${TARGET}: ${err.message}`);
}

if (!src.includes(SENTINEL_START) && !src.includes(CALL_SENTINEL_START)) {
  console.log(`Not patched (no webchat sentinel found in ${TARGET}). Nothing to do.`);
  process.exit(0);
}

// Strip both sentinel blocks with byte-exact reversal of the patch:
//   - IMPORTS block: patch added `\n\n${block}` after the imports anchor;
//     unpatch removes exactly that.
//   - CALL block: patch added `${block}\n\n` before the call anchor;
//     unpatch removes exactly that.
const importsRe = new RegExp(
  `\\n\\n${escapeForRegex(SENTINEL_START)}[\\s\\S]*?${escapeForRegex(SENTINEL_END)}`,
  'g',
);
const callRe = new RegExp(
  `${escapeForRegex(CALL_SENTINEL_START)}[\\s\\S]*?${escapeForRegex(CALL_SENTINEL_END)}\\n\\n`,
  'g',
);

let restored = src.replace(importsRe, '');
restored = restored.replace(callRe, '');

writeFileSync(TARGET, restored);
console.log(`Unpatched ${TARGET}.`);
console.log('Build the host to pick up the change: pnpm run build');
