/**
 * Topology assembler — room → agent → model graph for the explore view.
 * Scoped to the rooms passed in (already access-filtered by the route), so it
 * never surfaces agents/models outside the caller's visible rooms.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroupAgent, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { createWebchatRoom, createWebchatModel, assignModelToAgent, getWebchatTopology } from './db.js';

function seedAgent(id: string, name: string) {
  createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: 't' } as Parameters<
    typeof createAgentGroup
  >[0]);
}
function wire(roomPlatformId: string, agentId: string) {
  const mg = getMessagingGroupByPlatform('webchat', roomPlatformId)!;
  createMessagingGroupAgent({
    id: `mga-${roomPlatformId}-${agentId}`,
    messaging_group_id: mg.id,
    agent_group_id: agentId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: 't',
  } as Parameters<typeof createMessagingGroupAgent>[0]);
}
const ROOMS = [
  { id: 'room-a', name: 'Room A' },
  { id: 'room-b', name: 'Room B' },
  { id: 'room-c', name: 'Room C' }, // orphan room: no agents
];
// The caller's accessible agents (what the route passes). Includes ag-unused
// (wired to no room) but NOT ag-elsewhere (simulating an agent the user can't
// manage / belongs to another scope).
const AGENTS = [
  { id: 'ag-research', name: 'Researcher' },
  { id: 'ag-code', name: 'Coder' },
  { id: 'ag-unused', name: 'Unused' },
];

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  seedAgent('ag-research', 'Researcher');
  seedAgent('ag-code', 'Coder');
  seedAgent('ag-unused', 'Unused'); // accessible but wired to no room → orphan column
  seedAgent('ag-elsewhere', 'Elsewhere'); // wired to an out-of-scope room AND not accessible
  createWebchatRoom('Room A', 'room-a');
  createWebchatRoom('Room B', 'room-b');
  createWebchatRoom('Room C', 'room-c');
  createWebchatRoom('Other', 'room-other');
  createWebchatModel({
    id: 'm-sonnet',
    name: 'Sonnet',
    kind: 'anthropic',
    endpoint: null,
    model_id: 'claude-sonnet',
    credential_ref: null,
    created_at: 0,
  } as Parameters<typeof createWebchatModel>[0]);
  assignModelToAgent('ag-research', 'm-sonnet');
  assignModelToAgent('ag-code', 'm-sonnet'); // shared model → must dedupe
  wire('room-a', 'ag-research');
  wire('room-a', 'ag-code');
  wire('room-b', 'ag-research'); // research is the overloaded one (2 rooms)
  wire('room-other', 'ag-elsewhere');
});
afterEach(() => closeDb());

describe('getWebchatTopology', () => {
  it('includes ALL accessible agents (incl. unwired) + room↔agent edges among scope', () => {
    const t = getWebchatTopology(ROOMS, AGENTS);
    expect(t.rooms.map((r) => r.id).sort()).toEqual(['room-a', 'room-b', 'room-c']);
    // Every accessible agent is a node, even ag-unused (wired to nothing).
    expect(t.agents.map((a) => a.id).sort()).toEqual(['ag-code', 'ag-research', 'ag-unused']);
    expect(t.edges).toEqual(
      expect.arrayContaining([
        { room: 'room-a', agent: 'ag-research' },
        { room: 'room-a', agent: 'ag-code' },
        { room: 'room-b', agent: 'ag-research' },
      ]),
    );
    expect(t.edges).toHaveLength(3);
    // ag-unused is a node with no edges → orphan column / unused agent.
    expect(t.edges.some((e) => e.agent === 'ag-unused')).toBe(false);
  });

  it('carries each agent’s model, dedupes the shared one, null for unassigned', () => {
    const t = getWebchatTopology(ROOMS, AGENTS);
    expect(t.models).toEqual([{ id: 'm-sonnet', name: 'Sonnet' }]);
    expect(t.agents.find((a) => a.id === 'ag-research')).toMatchObject({ modelId: 'm-sonnet', modelName: 'Sonnet' });
    expect(t.agents.find((a) => a.id === 'ag-unused')).toMatchObject({ modelId: null, modelName: null });
  });

  it('keeps orphan rooms and excludes agents not in the accessible list', () => {
    const t = getWebchatTopology(ROOMS, AGENTS);
    // Room C present with no edges → orphan row in the matrix.
    expect(t.rooms.some((r) => r.id === 'room-c')).toBe(true);
    expect(t.edges.some((e) => e.room === 'room-c')).toBe(false);
    // ag-elsewhere isn't in AGENTS → absent, and its out-of-scope wiring never leaks.
    expect(t.agents.some((a) => a.id === 'ag-elsewhere')).toBe(false);
    expect(t.edges.some((e) => e.agent === 'ag-elsewhere')).toBe(false);
  });
});
