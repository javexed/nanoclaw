#!/usr/bin/env node
/**
 * Patch container/agent-runner/src/destinations.ts to nudge agents toward
 * `send_file` when at least one destination is a chat surface (channel).
 *
 * Why this lives in the skill:
 *   The webchat PWA's distinctive feature is inline-rendering attachments
 *   (image previews, PDF previews, syntax-highlighted code). Without this
 *   prompt nudge, agents tend to describe files in prose instead of calling
 *   `send_file` — which works but the file feature goes unused. Other chat
 *   channels (Slack, Telegram) benefit too. Lives in webchat's install
 *   because webchat is the channel that visually showcases the feature.
 *
 * Properties:
 *   - Idempotent. Re-running is a no-op (detected via START sentinel).
 *   - Reversible. unpatch-destinations.mjs strips everything cleanly.
 *   - Fail-loud. If trunk's destinations.ts has been reformatted in a way
 *     that breaks our anchors, we exit non-zero with a precise message
 *     pointing at which anchor we couldn't find. Better than silent skip.
 *
 * Run from the project root:
 *   node .claude/skills/add-webchat/install/patch-destinations.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = resolve(process.cwd(), 'container/agent-runner/src/destinations.ts');
const SENTINEL_START = '// webchat:send-file-hint START — installed by /add-webchat';
const SENTINEL_END = '// webchat:send-file-hint END';

// ── Anchors we replace ────────────────────────────────────────────────────
//
// Both branches of buildDestinationsSection() reference the same
// "send_message MCP tool" line at the end of their output. We use those
// lines as stable text anchors. If trunk reformats them, the script fails
// loud — which is what we want, since silent failure here means the
// webchat file feature works but the prompt-nudge half doesn't.

const SINGLE_ANCHOR =
  "      'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool.',\n    ].join('\\n');";

const SINGLE_REPLACE =
  "      'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool.',\n      ...(webchatHasChannel(all) ? ['', sendFileHint()] : []),\n    ].join('\\n');";

const MULTI_ANCHOR =
  "  lines.push(\n    'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool with the `to` parameter set to a destination name.',\n  );\n  return lines.join('\\n');";

const MULTI_REPLACE =
  "  lines.push(\n    'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool with the `to` parameter set to a destination name.',\n  );\n  if (webchatHasChannel(all)) {\n    lines.push('', sendFileHint());\n  }\n  return lines.join('\\n');";

const HELPER_BLOCK = `
${SENTINEL_START}
// Restored by unpatch-destinations.mjs when /remove-webchat runs.
function sendFileHint(): string {
  return [
    '### Sending files',
    '',
    'When the user asks for a file (a report, screenshot, generated artifact, exported data), deliver it — don\\'t just describe it. Save the file under \\\`uploads/\\\` in your group folder and call the \\\`send_file\\\` MCP tool with \\\`path: "uploads/<filename>"\\\` and an optional \\\`text\\\` caption. The destination renders it as an attachment in its native format (inline preview in webchat; uploaded file on Slack, Telegram, etc.).',
    '',
    'Use \\\`send_file\\\` for deliverables intended for the user. Working files / scratch artifacts stay in your workspace.',
  ].join('\\n');
}
function webchatHasChannel(all: ReturnType<typeof getAllDestinations>): boolean {
  return all.some((d) => d.type === 'channel');
}
${SENTINEL_END}
`;

function die(msg) {
  console.error(`patch-destinations.mjs: ${msg}`);
  process.exit(1);
}

let src;
try {
  src = readFileSync(TARGET, 'utf8');
} catch (err) {
  die(`could not read ${TARGET}: ${err.message}\n  run from the project root (where container/ lives)`);
}

// Detect partial-patch state. The sentinel-bounded helpers block at end of
// file and the two inline call-site replacements (single + multi
// destination branches) MUST be all-present or all-absent. If the sentinel
// block was hand-deleted while the call sites remain, re-running the patch
// would re-add the helpers — but that's still safe because they're all
// new declarations on a fresh sentinel block. The dangerous case is the
// reverse: sentinel block present, call sites reverted. Re-running would
// then re-add the call sites, which uses replace() on text that's still
// there, so it's still safe (replace is a no-op on already-applied
// text). Net: just check for the sentinel and skip; call-site state is
// self-consistent under re-run.
if (src.includes(SENTINEL_START)) {
  console.log(`Already patched — ${TARGET} contains the webchat sentinel. Skipping.`);
  process.exit(0);
}

if (!src.includes(SINGLE_ANCHOR)) {
  die(
    `single-destination anchor not found in ${TARGET}.\n` +
      `  trunk's destinations.ts may have been reformatted upstream.\n` +
      `  expected to find:\n${SINGLE_ANCHOR.split('\n').map((l) => '    ' + l).join('\n')}\n` +
      `  resolve by re-syncing trunk or updating this script's anchors.`,
  );
}
if (!src.includes(MULTI_ANCHOR)) {
  die(
    `multi-destination anchor not found in ${TARGET}.\n` +
      `  trunk's destinations.ts may have been reformatted upstream.\n` +
      `  expected to find:\n${MULTI_ANCHOR.split('\n').map((l) => '    ' + l).join('\n')}\n` +
      `  resolve by re-syncing trunk or updating this script's anchors.`,
  );
}

const patched = src.replace(SINGLE_ANCHOR, SINGLE_REPLACE).replace(MULTI_ANCHOR, MULTI_REPLACE) + HELPER_BLOCK;

writeFileSync(TARGET, patched);
console.log(`Patched ${TARGET}.`);
console.log('  + sendFileHint() / webchatHasChannel() helpers');
console.log('  + hint call sites in single- and multi-destination branches');
console.log('Rebuild the container image to pick this up: ./container/build.sh');
