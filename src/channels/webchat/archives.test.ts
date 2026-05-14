/**
 * Tests for per-user room archive helpers.
 *
 * The archive table is sidebar-presentation state; routing/access are not
 * affected. These tests cover round-trips (archive/unarchive), idempotency,
 * per-user isolation, and cleanup on room delete.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { archiveRoomForUser, clearArchivesForRoom, getArchivedRoomIdsForUser, unarchiveRoomForUser } from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

describe('per-user room archive', () => {
  it('archive then read back returns the room id', () => {
    archiveRoomForUser('webchat:alice', 'room-1');
    expect(getArchivedRoomIdsForUser('webchat:alice').has('room-1')).toBe(true);
  });

  it('unarchive removes the row', () => {
    archiveRoomForUser('webchat:alice', 'room-1');
    unarchiveRoomForUser('webchat:alice', 'room-1');
    expect(getArchivedRoomIdsForUser('webchat:alice').has('room-1')).toBe(false);
  });

  it('archive is idempotent (no PK conflict on re-archive)', () => {
    archiveRoomForUser('webchat:alice', 'room-1');
    expect(() => archiveRoomForUser('webchat:alice', 'room-1')).not.toThrow();
    expect(getArchivedRoomIdsForUser('webchat:alice').size).toBe(1);
  });

  it('unarchive is idempotent (no error if not archived)', () => {
    expect(() => unarchiveRoomForUser('webchat:alice', 'room-1')).not.toThrow();
  });

  it('archive is per-user — alice archiving does not affect bob', () => {
    archiveRoomForUser('webchat:alice', 'room-1');
    expect(getArchivedRoomIdsForUser('webchat:alice').has('room-1')).toBe(true);
    expect(getArchivedRoomIdsForUser('webchat:bob').has('room-1')).toBe(false);
  });

  it('clearArchivesForRoom drops every user’s archive of that room', () => {
    archiveRoomForUser('webchat:alice', 'room-1');
    archiveRoomForUser('webchat:bob', 'room-1');
    archiveRoomForUser('webchat:alice', 'room-2');
    clearArchivesForRoom('room-1');
    expect(getArchivedRoomIdsForUser('webchat:alice').has('room-1')).toBe(false);
    expect(getArchivedRoomIdsForUser('webchat:bob').has('room-1')).toBe(false);
    // Unrelated archives survive
    expect(getArchivedRoomIdsForUser('webchat:alice').has('room-2')).toBe(true);
  });
});
