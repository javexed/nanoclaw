import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { moduleWebOneToOne } from './migration.js';

/**
 * The v4 migration runs against a live install, so what matters is what it
 * does to an agent that already holds more than one room — a state the old
 * schema allowed and the new invariant forbids. Driven directly on a raw
 * better-sqlite3 handle: `up` takes one, and the surrounding runner adds
 * nothing this needs.
 */
function seed(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT, platform_id TEXT, name TEXT, created_at TEXT
    );
    CREATE TABLE messaging_group_agents (
      id TEXT PRIMARY KEY, messaging_group_id TEXT, agent_group_id TEXT
    );
    CREATE TABLE web_messages (id TEXT PRIMARY KEY, room_id TEXT, created_at INTEGER);
    CREATE TABLE web_room_primes (room_id TEXT PRIMARY KEY, agent_group_id TEXT, created_at INTEGER);
  `);
  return db;
}

function addRoom(db: Database.Database, roomId: string, bornAt: string): void {
  db.prepare(`INSERT INTO messaging_groups VALUES (?, 'web', ?, ?, ?)`).run(`mg-${roomId}`, roomId, roomId, bornAt);
}

function wire(db: Database.Database, roomId: string, agentId: string): void {
  db.prepare(`INSERT INTO messaging_group_agents VALUES (?, ?, ?)`).run(`w-${roomId}`, `mg-${roomId}`, agentId);
}

function wiredRooms(db: Database.Database, agentId: string): string[] {
  return (
    db
      .prepare(
        `SELECT mg.platform_id AS id FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mga.agent_group_id = ? ORDER BY mg.platform_id`,
      )
      .all(agentId) as { id: string }[]
  ).map((r) => r.id);
}

describe('module:web:room-agent-1to1', () => {
  it('keeps the most recently active room and unwires the rest', () => {
    const db = seed();
    addRoom(db, 'quiet', '2026-01-01T00:00:00Z');
    addRoom(db, 'busy', '2026-01-02T00:00:00Z');
    wire(db, 'quiet', 'a1');
    wire(db, 'busy', 'a1');
    db.prepare(`INSERT INTO web_messages VALUES ('m1', 'quiet', 100)`).run();
    db.prepare(`INSERT INTO web_messages VALUES ('m2', 'busy', 200)`).run();

    moduleWebOneToOne.up(db);

    expect(wiredRooms(db, 'a1')).toEqual(['busy']);
  });

  it('falls back to the oldest room when no room has messages', () => {
    const db = seed();
    addRoom(db, 'first', '2026-01-01T00:00:00Z');
    addRoom(db, 'second', '2026-01-02T00:00:00Z');
    wire(db, 'first', 'a1');
    wire(db, 'second', 'a1');

    moduleWebOneToOne.up(db);

    expect(wiredRooms(db, 'a1')).toEqual(['first']);
  });

  it('leaves an approval inbox out of the count, so a one-room agent is untouched', () => {
    const db = seed();
    addRoom(db, 'chat', '2026-01-01T00:00:00Z');
    addRoom(db, 'approvals:owner', '2026-01-01T00:00:00Z');
    wire(db, 'chat', 'a1');
    wire(db, 'approvals:owner', 'a1');

    moduleWebOneToOne.up(db);

    expect(wiredRooms(db, 'a1')).toEqual(['approvals:owner', 'chat']);
  });

  it('does not disturb agents that already hold exactly one room', () => {
    const db = seed();
    addRoom(db, 'r1', '2026-01-01T00:00:00Z');
    addRoom(db, 'r2', '2026-01-01T00:00:00Z');
    wire(db, 'r1', 'a1');
    wire(db, 'r2', 'a2');

    moduleWebOneToOne.up(db);

    expect(wiredRooms(db, 'a1')).toEqual(['r1']);
    expect(wiredRooms(db, 'a2')).toEqual(['r2']);
  });

  it('drops web_room_primes', () => {
    const db = seed();
    moduleWebOneToOne.up(db);
    const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='web_room_primes'`).get();
    expect(t).toBeUndefined();
  });
});
