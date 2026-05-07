#!/usr/bin/env node
/**
 * Patch src/modules/agent-to-agent/create-agent.ts to gate `create_agent`
 * on owner/admin trigger.
 *
 * Why this lives in the skill:
 *   The webchat threat model exposes the gap. Without this gate, any
 *   authenticated user who can drive an agent (via webchat or any other
 *   channel) can cause that agent to spawn arbitrary new agents — full
 *   privilege escalation. The gate reads the trusted senderId from
 *   inbound.db (host-owned) and rejects unless the requesting user is
 *   owner, admin-of-this-group, or a CLI client (Unix socket carve-out).
 *
 * Properties:
 *   - Idempotent. Re-running detected via START sentinel.
 *   - Reversible. unpatch-create-agent.mjs strips both blocks cleanly.
 *   - Fail-loud on anchor mismatch (better than silent skip).
 *
 * Run from the project root:
 *   node .claude/skills/add-webchat/install/patch-create-agent.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = resolve(process.cwd(), 'src/modules/agent-to-agent/create-agent.ts');
const SENTINEL_START = '// webchat:create-agent-gating START — installed by /add-webchat';
const SENTINEL_END = '// webchat:create-agent-gating END';
const CALL_SENTINEL_START = '// webchat:create-agent-gating-call START — installed by /add-webchat';
const CALL_SENTINEL_END = '// webchat:create-agent-gating-call END';

// ── Anchors ───────────────────────────────────────────────────────────────
//
// Imports go right after the existing import block. Anchor: the last
// existing import line, exact text.
const IMPORTS_ANCHOR = "import { writeDestinations } from './write-destinations.js';";
const IMPORTS_REPLACE = `${IMPORTS_ANCHOR}

${SENTINEL_START}
// Restored by unpatch-create-agent.mjs when /remove-webchat runs.
import Database from 'better-sqlite3';
import { inboundDbPath } from '../../session-manager.js';
import { hasAdminPrivilege, isOwner } from '../permissions/db/user-roles.js';

export interface CreateAgentAuthChecks {
  isOwner(userId: string): boolean;
  isAdminOf(userId: string, agentGroupId: string): boolean;
}

export type CreateAgentAuthDecision =
  | { allowed: true; reason: 'cli' | 'owner' | 'admin_of_group' }
  | { allowed: false; reason: 'no_trigger' | 'unauthorized' };

/**
 * Pure authorization decision so it can be unit-tested without DB setup.
 *
 * The \`cli:\` carve-out exists because the CLI channel reaches us through
 * a local Unix socket — filesystem permissions already gate access, so
 * anyone who can write to the socket has a shell on this host.
 */
export function decideCreateAgentAuthorization(
  senderId: string | null,
  agentGroupId: string,
  checks: CreateAgentAuthChecks,
): CreateAgentAuthDecision {
  if (!senderId) return { allowed: false, reason: 'no_trigger' };
  if (senderId.startsWith('cli:')) return { allowed: true, reason: 'cli' };
  if (checks.isOwner(senderId)) return { allowed: true, reason: 'owner' };
  if (checks.isAdminOf(senderId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
  return { allowed: false, reason: 'unauthorized' };
}

/**
 * Read the senderId of the most recent chat-kind inbound message for this
 * session from the host-owned inbound.db. The container can write whatever
 * it wants to outbound.db, so we cannot trust a triggeredBy claim coming
 * back through the action payload — we re-derive it from trusted state.
 */
function findTriggerSenderId(session: import('../../types.js').Session): string | null {
  const dbPath = inboundDbPath(session.agent_group_id, session.id);
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        \`SELECT content FROM messages_in
         WHERE kind = 'chat'
         ORDER BY seq DESC
         LIMIT 1\`,
      )
      .get() as { content: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.content) as { senderId?: unknown };
      return typeof parsed.senderId === 'string' ? parsed.senderId : null;
    } catch {
      return null;
    }
  } finally {
    db.close();
  }
}
${SENTINEL_END}`;

// Gate-call goes inside handleCreateAgent, just before the localName line.
// Sentinels are at column 0 so the unpatch regex doesn't need to know the
// surrounding indent. The body of the gate keeps its 2-space indent.
const CALL_ANCHOR = '  const localName = normalizeName(name);';
const CALL_REPLACE = `${CALL_SENTINEL_START}
  const _triggerSender = findTriggerSenderId(session);
  const _decision = decideCreateAgentAuthorization(_triggerSender, sourceGroup.id, {
    isOwner,
    isAdminOf: hasAdminPrivilege,
  });
  if (!_decision.allowed) {
    const _reason =
      _decision.reason === 'no_trigger'
        ? 'no identifiable user trigger for this turn'
        : 'requesting user lacks owner/admin privilege';
    notifyAgent(session, \`create_agent denied: \${_reason}.\`);
    log.warn('create_agent denied', {
      reason: _decision.reason,
      sender: _triggerSender,
      source: sourceGroup.id,
      name,
    });
    return;
  }
${CALL_SENTINEL_END}

${CALL_ANCHOR}`;

function die(msg) {
  console.error(`patch-create-agent.mjs: ${msg}`);
  process.exit(1);
}

let src;
try {
  src = readFileSync(TARGET, 'utf8');
} catch (err) {
  die(`could not read ${TARGET}: ${err.message}\n  run from the project root (where src/ lives)`);
}

// Both sentinel blocks must be either both present (already patched) or both
// absent (clean state). A half-patched file means the operator hand-edited
// or a merge ate one block — re-running would double-inject the surviving
// half and break the build with TS2451 duplicate-declaration errors.
const hasImports = src.includes(SENTINEL_START);
const hasCall = src.includes(CALL_SENTINEL_START);
if (hasImports !== hasCall) {
  die(
    `partial-patch state detected in ${TARGET}.\n` +
      `  imports sentinel: ${hasImports ? 'present' : 'missing'}\n` +
      `  call sentinel:    ${hasCall ? 'present' : 'missing'}\n` +
      `  run unpatch-create-agent.mjs first to restore a clean baseline,\n` +
      `  then re-run this script.`,
  );
}
if (hasImports) {
  console.log(`Already patched — ${TARGET} contains both webchat sentinels. Skipping.`);
  process.exit(0);
}

if (!src.includes(IMPORTS_ANCHOR)) {
  die(
    `imports anchor not found in ${TARGET}.\n` +
      `  trunk's create-agent.ts may have been reformatted upstream.\n` +
      `  expected to find:\n    ${IMPORTS_ANCHOR}`,
  );
}
if (!src.includes(CALL_ANCHOR)) {
  die(
    `call-site anchor not found in ${TARGET}.\n` +
      `  expected to find:\n    ${CALL_ANCHOR}`,
  );
}

const patched = src.replace(IMPORTS_ANCHOR, IMPORTS_REPLACE).replace(CALL_ANCHOR, CALL_REPLACE);

writeFileSync(TARGET, patched);
console.log(`Patched ${TARGET}.`);
console.log('  + imports: better-sqlite3, inboundDbPath, hasAdminPrivilege, isOwner');
console.log('  + helpers: decideCreateAgentAuthorization, findTriggerSenderId');
console.log('  + gate at the top of handleCreateAgent');
console.log('Build the host to pick up the patch: pnpm run build');
