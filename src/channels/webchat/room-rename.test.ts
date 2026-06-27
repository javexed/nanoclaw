/**
 * Room rename — the name sanitizer + the persistence helper that back
 * PUT /api/rooms/:id/name. The endpoint's owner/CSRF/404 gating mirrors the
 * (tested) engage-mode handler; these tests pin the logic that's unique to
 * rename: input cleaning and that the new name round-trips through the room.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createWebchatRoom, getWebchatRoom, sanitizeRoomName, updateWebchatRoomName } from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => {
  closeDb();
});

describe('sanitizeRoomName', () => {
  it('trims and collapses internal whitespace, keeps single spaces', () => {
    expect(sanitizeRoomName('  Team   standup  ')).toBe('Team standup');
    expect(sanitizeRoomName('keep the spaces')).toBe('keep the spaces');
  });
  it('strips control characters (incl. tabs/newlines)', () => {
    expect(sanitizeRoomName('two\tword\nname')).toBe('twowordname');
    expect(sanitizeRoomName('null\u0000and\u007fdel')).toBe('nullanddel');
  });
  it('rejects empty / whitespace-only / non-string', () => {
    expect(sanitizeRoomName('')).toBeNull();
    expect(sanitizeRoomName('   ')).toBeNull();
    expect(sanitizeRoomName(undefined)).toBeNull();
    expect(sanitizeRoomName(42)).toBeNull();
  });
  it('rejects names longer than 80 chars (after cleaning)', () => {
    expect(sanitizeRoomName('a'.repeat(80))).toBe('a'.repeat(80));
    expect(sanitizeRoomName('a'.repeat(81))).toBeNull();
  });
});

describe('updateWebchatRoomName', () => {
  it('renames a room and the new name round-trips', () => {
    createWebchatRoom('Old name', 'room-1');
    expect(getWebchatRoom('room-1')?.name).toBe('Old name');

    updateWebchatRoomName('room-1', 'New name');
    expect(getWebchatRoom('room-1')?.name).toBe('New name');
  });

  it('is a no-op for an unknown room id', () => {
    expect(() => updateWebchatRoomName('does-not-exist', 'whatever')).not.toThrow();
    expect(getWebchatRoom('does-not-exist')).toBeUndefined();
  });
});
