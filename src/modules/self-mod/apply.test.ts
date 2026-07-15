/**
 * Guard for the multi-session self-mod fix: a package/MCP change applies to the
 * whole agent group, so EVERY active session's container must be respawned —
 * not just the one that requested it. Otherwise an agent wired to multiple
 * rooms keeps a stale container in the other rooms and re-requests forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const killContainer = vi.fn();
const wakeContainer = vi.fn();
const buildAgentGroupImage = vi.fn().mockResolvedValue(undefined);
const writeSessionMessage = vi.fn();

vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: (...a: unknown[]) => buildAgentGroupImage(...a),
  killContainer: (...a: unknown[]) => killContainer(...a),
  wakeContainer: (...a: unknown[]) => wakeContainer(...a),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: 'CAD', folder: 'cad', agent_provider: null, created_at: '' }),
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: () => ({ packages_apt: '[]', packages_npm: '[]', mcp_servers: '{}' }),
  updateContainerConfigJson: vi.fn(),
}));

const SESSIONS = [
  { id: 'sess-req', agent_group_id: 'ag-1', status: 'active' },
  { id: 'sess-sibling', agent_group_id: 'ag-1', status: 'active' },
  { id: 'sess-ended', agent_group_id: 'ag-1', status: 'ended' },
] as unknown as Session[];

vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => SESSIONS.find((s) => s.id === id),
  getSessionsByAgentGroup: () => SESSIONS,
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => writeSessionMessage(...a),
}));

import { applyAddMcpServer, applyInstallPackages } from './apply.js';

beforeEach(() => vi.clearAllMocks());

function killedIds() {
  return killContainer.mock.calls.map((c) => c[0]);
}

describe('applyInstallPackages', () => {
  it('respawns the requester (with wake) and active siblings (without), skipping ended sessions', async () => {
    await applyInstallPackages({ apt: ['admesh'] }, SESSIONS[0]);

    expect(killedIds()).toContain('sess-req');
    expect(killedIds()).toContain('sess-sibling');
    expect(killedIds()).not.toContain('sess-ended');

    // Requester's kill carries a wake callback (it has an on_wake note to pick
    // up); the sibling's does not — it just respawns on its next message.
    const req = killContainer.mock.calls.find((c) => c[0] === 'sess-req')!;
    const sib = killContainer.mock.calls.find((c) => c[0] === 'sess-sibling')!;
    expect(typeof req[2]).toBe('function');
    expect(sib[2]).toBeUndefined();
    // Only the requester gets the verify-packages on_wake message.
    expect(writeSessionMessage).toHaveBeenCalledTimes(1);
  });
});

describe('applyAddMcpServer', () => {
  it('also respawns active siblings so they see the new MCP server', async () => {
    await applyAddMcpServer({ name: 'windows', command: 'x', args: [], env: {} }, SESSIONS[0]);
    expect(killedIds()).toEqual(expect.arrayContaining(['sess-req', 'sess-sibling']));
    expect(killedIds()).not.toContain('sess-ended');
  });
});
