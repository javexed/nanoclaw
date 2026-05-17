/**
 * Tests for the per-room `engage_default` setting (mention-only mode).
 *
 * Verifies that recomputeEngagePatterns honors the setting when no prime
 * is configured. With a prime set, the prime branch takes over and
 * engage_default is ignored — that's tested separately by the existing
 * prime behavior; we only assert it here as a guardrail.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import {
  clearPrimeAgentForWebchatRoom,
  getRoomEngageDefault,
  setPrimeAgentForWebchatRoom,
  setRoomEngageDefault,
} from './db.js';
import { recomputeEngagePatterns } from './server.js';

const now = () => new Date().toISOString();

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());

  // Three agents wired to one room — minimal viable multi-agent setup.
  createAgentGroup({ id: 'ag-a', name: 'Alice', folder: 'alice', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-b', name: 'Bob', folder: 'bob', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-c', name: 'Carol', folder: 'carol', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-room',
    channel_type: 'webchat',
    platform_id: 'room-1',
    name: 'room-1',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  for (const ag of ['ag-a', 'ag-b', 'ag-c']) {
    createMessagingGroupAgent({
      id: randomUUID(),
      messaging_group_id: 'mg-room',
      agent_group_id: ag,
      engage_mode: 'pattern',
      engage_pattern: '.', // initial; recompute overwrites
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  }
});

afterEach(() => {
  closeDb();
});

function patternsForRoom(roomId: string): Record<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT ag.folder, mga.engage_pattern
       FROM messaging_group_agents mga
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
       WHERE mg.platform_id = ?`,
    )
    .all(roomId) as { folder: string; engage_pattern: string }[];
  return Object.fromEntries(rows.map((r) => [r.folder, r.engage_pattern]));
}

describe('engage_default setting', () => {
  it('defaults to broadcast for rooms without a settings row', () => {
    expect(getRoomEngageDefault('room-1')).toBe('broadcast');
  });

  it('broadcast + no prime → every wiring gets "." (legacy behavior preserved)', () => {
    recomputeEngagePatterns('room-1');
    const p = patternsForRoom('room-1');
    expect(p.alice).toBe('.');
    expect(p.bob).toBe('.');
    expect(p.carol).toBe('.');
  });

  it('mention-only + no prime → every wiring gets \\B@<folder>\\b', () => {
    setRoomEngageDefault('room-1', 'mention-only');
    recomputeEngagePatterns('room-1');
    const p = patternsForRoom('room-1');
    expect(p.alice).toBe('\\B@[aA][lL][iI][cC][eE]\\b');
    expect(p.bob).toBe('\\B@[bB][oO][bB]\\b');
    expect(p.carol).toBe('\\B@[cC][aA][rR][oO][lL]\\b');
  });

  it('mention-only is persisted and readable', () => {
    setRoomEngageDefault('room-1', 'mention-only');
    expect(getRoomEngageDefault('room-1')).toBe('mention-only');
    setRoomEngageDefault('room-1', 'broadcast');
    expect(getRoomEngageDefault('room-1')).toBe('broadcast');
  });

  it('mention-only is ignored when a prime is configured (prime branch wins)', () => {
    // With a prime set, the existing prime logic produces:
    //   prime  → negative-lookahead pattern excluding other folders
    //   others → \B@<folder>\b
    // The engage_default setting must NOT change this — it only controls
    // the no-prime fallback.
    setRoomEngageDefault('room-1', 'mention-only');
    setPrimeAgentForWebchatRoom('room-1', 'ag-a');
    recomputeEngagePatterns('room-1');
    const p = patternsForRoom('room-1');
    expect(p.alice).toMatch(/^\^\(\?!/); // negative-lookahead = prime
    expect(p.bob).toBe('\\B@[bB][oO][bB]\\b');
    expect(p.carol).toBe('\\B@[cC][aA][rR][oO][lL]\\b');
  });

  it('toggling from prime → no prime + mention-only flips alice from catch-all to mention-only', () => {
    setPrimeAgentForWebchatRoom('room-1', 'ag-a');
    setRoomEngageDefault('room-1', 'mention-only');
    recomputeEngagePatterns('room-1');
    expect(patternsForRoom('room-1').alice).toMatch(/^\^\(\?!/);

    clearPrimeAgentForWebchatRoom('room-1');
    recomputeEngagePatterns('room-1');
    const p = patternsForRoom('room-1');
    expect(p.alice).toBe('\\B@[aA][lL][iI][cC][eE]\\b');
    expect(p.bob).toBe('\\B@[bB][oO][bB]\\b');
    expect(p.carol).toBe('\\B@[cC][aA][rR][oO][lL]\\b');
  });
});
