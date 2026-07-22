/**
 * Regression coverage for approval response authorization.
 *
 * Approval cards may be delivered to an admin DM, but the callback payload is
 * still untrusted input. The response handler must not dispatch sensitive
 * approval handlers merely because a response carries a valid questionId.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-response-authz' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-response-authz';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('approval response authorization', () => {
  it('ignores a valid approval id clicked by a non-admin user', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages', handler);

    createPendingApproval({
      approval_id: 'appr-1',
      session_id: 'sess-1',
      request_id: 'appr-1',
      action: 'install_packages',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: 'stranger',
      channelType: 'telegram',
      platformId: 'dm-stranger',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(getPendingApproval('appr-1')).toBeDefined();
  });

  it('allows an owner/admin click to dispatch the registered approval handler', async () => {
    upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages_allowed', handler);

    createPendingApproval({
      approval_id: 'appr-2',
      session_id: 'sess-1',
      request_id: 'appr-2',
      action: 'install_packages_allowed',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-2',
      value: 'approve',
      userId: 'owner',
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ userId: 'telegram:owner' }));
    expect(getPendingApproval('appr-2')).toBeUndefined();
  });

  it('keeps the pending row live DURING the handler, deleting it only after (approved-replay grant re-check)', async () => {
    // Regression: the approve path used to delete the row up-front, before the
    // handler ran. But an approved cli_command replays through the guard, whose
    // grantSatisfies() re-checks the row via getPendingApproval() (guard.ts); with
    // the row already gone every approval-gated command failed with "replay
    // carried an invalid or mismatched grant". The row must stay live for the
    // duration of the handler, then be deleted.
    upsertUser({ id: 'telegram:owner-live', kind: 'telegram', display_name: 'Owner', created_at: now() });
    grantRole({
      user_id: 'telegram:owner-live',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');

    let rowLiveDuringHandler = false;
    const handler = vi.fn().mockImplementation(async () => {
      // What the real cli_command handler's guard replay observes.
      rowLiveDuringHandler = getPendingApproval('appr-live') !== undefined;
    });
    registerApprovalHandler('grant_recheck_action', handler);

    createPendingApproval({
      approval_id: 'appr-live',
      session_id: 'sess-1',
      request_id: 'appr-live',
      action: 'grant_recheck_action',
      payload: JSON.stringify({ frame: { command: 'noop' } }),
      created_at: now(),
      title: 'Grant recheck',
      options_json: JSON.stringify([]),
    });

    await handleApprovalsResponse({
      questionId: 'appr-live',
      value: 'approve',
      userId: 'owner-live',
      channelType: 'telegram',
      platformId: 'dm-owner-live',
      threadId: null,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(rowLiveDuringHandler).toBe(true); // was false when the row was deleted up-front
    expect(getPendingApproval('appr-live')).toBeUndefined(); // released after the handler
  });

  it('allows global admins to resolve approvals without a session-scoped agent group', async () => {
    upsertUser({ id: 'telegram:global-admin', kind: 'telegram', display_name: 'Global Admin', created_at: now() });
    grantRole({
      user_id: 'telegram:global-admin',
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('global_admin_allowed', handler);

    createPendingApproval({
      approval_id: 'appr-3',
      session_id: 'sess-1',
      agent_group_id: null,
      request_id: 'appr-3',
      action: 'global_admin_allowed',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-3',
      value: 'approve',
      userId: 'global-admin',
      channelType: 'telegram',
      platformId: 'dm-global-admin',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getPendingApproval('appr-3')).toBeUndefined();
  });

  it('an approval with approver_user_id is resolvable by that user, not a non-assignee', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('assigned_approver_action', handler);

    createPendingApproval({
      approval_id: 'appr-4',
      session_id: 'sess-1',
      request_id: 'appr-4',
      action: 'assigned_approver_action',
      payload: JSON.stringify({}),
      created_at: now(),
      title: 'Assigned approval',
      options_json: JSON.stringify([]),
      approver_user_id: 'telegram:dana',
    });

    // A non-assignee (no global/owner role) cannot resolve it.
    await handleApprovalsResponse({
      questionId: 'appr-4',
      value: 'approve',
      userId: 'stranger',
      channelType: 'telegram',
      platformId: 'dm-stranger',
      threadId: null,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(getPendingApproval('appr-4')).toBeDefined();

    // The named approver resolves it.
    await handleApprovalsResponse({
      questionId: 'appr-4',
      value: 'approve',
      userId: 'dana',
      channelType: 'telegram',
      platformId: 'dm-dana',
      threadId: null,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getPendingApproval('appr-4')).toBeUndefined();
  });

  it('runs the handler exactly once when the same Approve is delivered twice mid-handler', async () => {
    upsertUser({ id: 'telegram:owner2', kind: 'telegram', display_name: 'Owner', created_at: now() });
    grantRole({ user_id: 'telegram:owner2', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');

    // A slow handler (like buildAgentGroupImage) that stays in flight while a
    // duplicate delivery arrives — the exact window that produced 4 racing
    // rebuilds. The claim must gate the second delivery out.
    let release: () => void = () => {};
    const handler = vi.fn().mockImplementation(() => new Promise<void>((r) => (release = r)));
    registerApprovalHandler('slow_action', handler);

    createPendingApproval({
      approval_id: 'appr-dup',
      session_id: 'sess-1',
      request_id: 'appr-dup',
      action: 'slow_action',
      payload: JSON.stringify({ apt: ['admesh'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const click = {
      questionId: 'appr-dup',
      value: 'approve',
      userId: 'owner2',
      channelType: 'telegram' as const,
      platformId: 'dm-owner2',
      threadId: null,
    };
    // Two deliveries of the same click, concurrently — first claims and enters
    // the (pending) handler; second must find no row and bail.
    const p1 = handleApprovalsResponse(click);
    const p2 = handleApprovalsResponse(click);
    await Promise.resolve(); // let both settle up to their awaits
    release();
    await Promise.all([p1, p2]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(getPendingApproval('appr-dup')).toBeUndefined();
  });
});
