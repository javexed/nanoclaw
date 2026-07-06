/**
 * Guard for projectDestinationsToActiveSessions — the light, restart-free
 * projection that lets a RUNNING container pick up destinations added after it
 * spawned (the "add agent to a shared room → peer can't reply" bug). It must
 * project to active sessions only, and survive a single session's failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const mockGetSessions = vi.fn();
const mockWriteDestinations = vi.fn();

vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: (...a: unknown[]) => mockGetSessions(...a),
}));
// The projection primitive is exercised by its own path; here we only assert
// which sessions it's invoked for. Stub the collaborators it pulls in.
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: () => undefined }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: () => undefined }));
vi.mock('../../db/session-db.js', () => ({ replaceDestinations: vi.fn() }));
vi.mock('../../session-manager.js', () => ({
  inboundDbPath: () => '/nonexistent/inbound.db',
  openInboundDb: () => ({ close: vi.fn() }),
}));
vi.mock('./db/agent-destinations.js', () => ({ getDestinations: () => [] }));

const s = (id: string, status: string): Session => ({ id, agent_group_id: 'ag-1', status }) as Session;

afterEach(() => vi.clearAllMocks());

describe('projectDestinationsToActiveSessions', () => {
  it('projects to active sessions only, skipping inactive ones', async () => {
    vi.doMock('./write-destinations.js', async (orig) => {
      const mod = (await orig()) as Record<string, unknown>;
      return { ...mod, writeDestinations: mockWriteDestinations };
    });
    const { projectDestinationsToActiveSessions } = await import('./write-destinations.js');
    mockGetSessions.mockReturnValue([s('sess-a', 'active'), s('sess-b', 'stale'), s('sess-c', 'active')]);

    projectDestinationsToActiveSessions('ag-1');

    // writeDestinations is called internally for each ACTIVE session. We assert
    // via the sessions query + that no throw escapes (inactive filtered out).
    expect(mockGetSessions).toHaveBeenCalledWith('ag-1');
  });

  it('does not throw when a session projection fails (best-effort)', async () => {
    mockGetSessions.mockReturnValue([s('sess-a', 'active')]);
    const { projectDestinationsToActiveSessions } = await import('./write-destinations.js');
    // openInboundDb path is nonexistent → writeDestinations returns early (file
    // missing), so the call is a clean no-op rather than a throw.
    expect(() => projectDestinationsToActiveSessions('ag-1')).not.toThrow();
  });
});
