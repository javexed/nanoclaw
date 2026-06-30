/**
 * Tests for the per-thread engaged-agents set (webchat_thread_engaged).
 * The 'main' thread (regular chat) can never engage — it stays mention-only.
 * See docs/design/thread-engaged-agents.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { engageAgent, disengageAgent, getEngagedAgents, isAgentEngaged, deleteWebchatThread } from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

describe('thread engaged agents', () => {
  it('engage / getEngaged / disengage round-trips', () => {
    engageAgent('room-1', 't1', 'ag-a');
    engageAgent('room-1', 't1', 'ag-b');
    expect(getEngagedAgents('room-1', 't1').sort()).toEqual(['ag-a', 'ag-b']);
    expect(isAgentEngaged('room-1', 't1', 'ag-a')).toBe(true);
    disengageAgent('room-1', 't1', 'ag-a');
    expect(getEngagedAgents('room-1', 't1')).toEqual(['ag-b']);
    expect(isAgentEngaged('room-1', 't1', 'ag-a')).toBe(false);
  });

  it('engage is idempotent', () => {
    engageAgent('room-1', 't1', 'ag-a', 100);
    engageAgent('room-1', 't1', 'ag-a', 200);
    expect(getEngagedAgents('room-1', 't1')).toEqual(['ag-a']);
  });

  it('never engages the main thread (regular chat stays mention-only)', () => {
    engageAgent('room-1', 'main', 'ag-a');
    expect(getEngagedAgents('room-1', 'main')).toEqual([]);
    expect(isAgentEngaged('room-1', 'main', 'ag-a')).toBe(false);
  });

  it('engaged set is scoped per thread', () => {
    engageAgent('room-1', 't1', 'ag-a');
    engageAgent('room-1', 't2', 'ag-b');
    expect(getEngagedAgents('room-1', 't1')).toEqual(['ag-a']);
    expect(getEngagedAgents('room-1', 't2')).toEqual(['ag-b']);
  });

  it('returns agents in engage order (engaged_at)', () => {
    engageAgent('room-1', 't1', 'ag-b', 200);
    engageAgent('room-1', 't1', 'ag-a', 100);
    expect(getEngagedAgents('room-1', 't1')).toEqual(['ag-a', 'ag-b']);
  });

  it('deleteWebchatThread clears the thread engaged set', () => {
    engageAgent('room-1', 't1', 'ag-a');
    deleteWebchatThread('room-1', 't1');
    expect(getEngagedAgents('room-1', 't1')).toEqual([]);
  });
});
