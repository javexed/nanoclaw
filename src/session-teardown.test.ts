/**
 * Tests for session teardown primitives.
 *
 * Locks in the contract that motivated extracting these helpers: every
 * parent-delete path that holds an FK to `sessions` must use them, or the
 * SQLite FK check rejects the parent delete with "FOREIGN KEY constraint
 * failed". Regressions here would resurface as cryptic "Internal error"
 * responses in channel skills.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createAgentGroup, deleteAgentGroup } from './db/agent-groups.js';
import {
  createMessagingGroup,
  deleteMessagingGroup,
} from './db/messaging-groups.js';
import { createPendingApproval, createPendingQuestion, createSession, getSession } from './db/sessions.js';
import {
  deleteSessionDbState,
  findSessionsByAgentGroup,
  findSessionsByMessagingGroup,
} from './session-teardown.js';

const now = () => new Date().toISOString();

function seed(opts: { sessionsPerRoom?: number } = {}): { agentGroupId: string; messagingGroupId: string } {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'webchat',
    platform_id: 'room-1',
    name: 'Test Room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const count = opts.sessionsPerRoom ?? 1;
  for (let i = 1; i <= count; i++) {
    createSession({
      id: `sess-${i}`,
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: i === 1 ? null : `thread-${i}`,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now(),
      created_at: now(),
    });
  }
  return { agentGroupId: 'ag-1', messagingGroupId: 'mg-1' };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('findSessionsByMessagingGroup / findSessionsByAgentGroup', () => {
  it('returns every session linked to the messaging group', () => {
    seed({ sessionsPerRoom: 3 });
    const targets = findSessionsByMessagingGroup('mg-1');
    expect(targets).toHaveLength(3);
    expect(targets.every((t) => t.agentGroupId === 'ag-1')).toBe(true);
    expect(new Set(targets.map((t) => t.sessionId))).toEqual(new Set(['sess-1', 'sess-2', 'sess-3']));
  });

  it('returns every session linked to the agent group across rooms', () => {
    seed({ sessionsPerRoom: 1 });
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'webchat',
      platform_id: 'room-2',
      name: 'Other Room',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createSession({
      id: 'sess-other-room',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-2',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now(),
      created_at: now(),
    });
    expect(findSessionsByAgentGroup('ag-1')).toHaveLength(2);
    expect(findSessionsByMessagingGroup('mg-2')).toHaveLength(1);
  });

  it('returns empty for unknown ids', () => {
    expect(findSessionsByMessagingGroup('nope')).toEqual([]);
    expect(findSessionsByAgentGroup('nope')).toEqual([]);
  });
});

describe('deleteSessionDbState', () => {
  it('drops the session row', () => {
    seed();
    deleteSessionDbState('sess-1');
    expect(getSession('sess-1')).toBeUndefined();
  });

  it('drops pending_questions and pending_approvals that FK to the session', () => {
    seed();
    createPendingQuestion({
      question_id: 'q-1',
      session_id: 'sess-1',
      message_out_id: 'msg-out-1',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      title: 'Ask?',
      options: [],
      created_at: now(),
    });
    createPendingApproval({
      approval_id: 'a-1',
      session_id: 'sess-1',
      request_id: 'req-1',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'Install?',
      options_json: '[]',
    });
    deleteSessionDbState('sess-1');
    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) as n FROM pending_questions WHERE session_id = ?').get('sess-1')).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) as n FROM pending_approvals WHERE session_id = ?').get('sess-1')).toEqual({ n: 0 });
  });
});

describe('FK behavior — the bug this primitive prevents', () => {
  it('deleting a messaging_group with an active session throws FOREIGN KEY', () => {
    seed();
    // Without teardown, SQLite rejects the parent delete. This is the
    // exact scenario that surfaced as "Failed to delete room: Internal
    // error" in the webchat UI.
    expect(() => deleteMessagingGroup('mg-1')).toThrow(/FOREIGN KEY/);
  });

  it('deleting an agent_group with an active session throws FOREIGN KEY', () => {
    seed();
    expect(() => deleteAgentGroup('ag-1')).toThrow(/FOREIGN KEY/);
  });

  it('the teardown + parent-delete sequence inside a transaction succeeds', () => {
    const { messagingGroupId } = seed({ sessionsPerRoom: 2 });
    const targets = findSessionsByMessagingGroup(messagingGroupId);
    expect(targets).toHaveLength(2);

    getDb().transaction(() => {
      for (const t of targets) deleteSessionDbState(t.sessionId);
      deleteMessagingGroup(messagingGroupId);
    })();

    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) as n FROM messaging_groups WHERE id = ?').get(messagingGroupId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) as n FROM sessions WHERE messaging_group_id = ?').get(messagingGroupId)).toEqual({ n: 0 });
  });

  it('a failing parent-delete inside a transaction rolls back the session teardown', () => {
    seed();
    // Simulate a multi-step delete where the final step fails AFTER the
    // session was torn down. The transaction must roll back both, leaving
    // the session intact for a retry — no half-gutted state.
    expect(() => {
      getDb().transaction(() => {
        deleteSessionDbState('sess-1');
        // Force a failure inside the transaction.
        throw new Error('simulated handler failure');
      })();
    }).toThrow(/simulated/);
    expect(getSession('sess-1')).toBeDefined();
  });
});
