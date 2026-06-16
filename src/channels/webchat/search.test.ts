/**
 * Full-text message search (FTS5). The virtual table + triggers come from the
 * webchat-message-fts migration; storeWebchatMessage inserts fire the AFTER
 * INSERT trigger that populates the index. Access scoping is enforced by the
 * caller passing only the rooms the user can see (the /api/search route does
 * this via filterRoomsForUser) — searchWebchatMessages itself filters by roomIds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { storeWebchatMessage, searchWebchatMessages } from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  storeWebchatMessage('room-1', 'agent', 'agent', 'The ACR auth issue was a stale token from last month');
  storeWebchatMessage('room-1', 'mark', 'user', 'thanks, the authentication works now');
  storeWebchatMessage('room-2', 'agent', 'agent', 'ACR auth notes for a different project');
  storeWebchatMessage('room-1', 'mark', 'user', 'unrelated chatter about lunch');
});
afterEach(() => closeDb());

describe('searchWebchatMessages', () => {
  it('finds messages by content, relevance-ranked', () => {
    const hits = searchWebchatMessages(['room-1', 'room-2'], 'ACR auth');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.some((h) => h.snippet.includes('«') || h.snippet.toLowerCase().includes('acr'))).toBe(true);
  });

  it('is scoped to the given rooms — never leaks other rooms', () => {
    const hits = searchWebchatMessages(['room-1'], 'ACR auth');
    expect(hits.every((h) => h.room_id === 'room-1')).toBe(true);
    expect(hits.some((h) => h.room_id === 'room-2')).toBe(false);
  });

  it('prefix-matches partial words', () => {
    const hits = searchWebchatMessages(['room-1'], 'auth');
    // matches "auth" and "authentication"
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('returns [] for empty/whitespace/no-room queries (no FTS syntax error)', () => {
    expect(searchWebchatMessages(['room-1'], '')).toEqual([]);
    expect(searchWebchatMessages(['room-1'], '   ')).toEqual([]);
    expect(searchWebchatMessages([], 'auth')).toEqual([]);
  });

  it('sanitizes FTS operators/quotes in user input (no throw)', () => {
    // Raw input that would be a syntax error if passed to MATCH directly.
    expect(() => searchWebchatMessages(['room-1'], '"AND auth OR (')).not.toThrow();
    const hits = searchWebchatMessages(['room-1'], 'auth"');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes approval cards from results', () => {
    getDb()
      .prepare(
        `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
         VALUES ('appr1', 'room-1', 'sys', 'system', 'auth approval please', 'approval', NULL, ?)`,
      )
      .run(Date.now());
    const hits = searchWebchatMessages(['room-1'], 'auth');
    expect(hits.some((h) => h.id === 'appr1')).toBe(false);
  });
});
