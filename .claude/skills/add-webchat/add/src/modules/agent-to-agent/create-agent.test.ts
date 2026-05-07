import { describe, expect, it } from 'vitest';

import { decideCreateAgentAuthorization, type CreateAgentAuthChecks } from './create-agent.js';

const denyAll: CreateAgentAuthChecks = {
  isOwner: () => false,
  isAdminOf: () => false,
};

describe('decideCreateAgentAuthorization', () => {
  const groupId = 'ag-test';

  it('denies when there is no identifiable trigger', () => {
    expect(decideCreateAgentAuthorization(null, groupId, denyAll)).toEqual({
      allowed: false,
      reason: 'no_trigger',
    });
  });

  it('allows any cli: sender (Unix socket already gates access)', () => {
    expect(decideCreateAgentAuthorization('cli:local', groupId, denyAll)).toEqual({
      allowed: true,
      reason: 'cli',
    });
  });

  it('allows the global owner', () => {
    const checks: CreateAgentAuthChecks = {
      isOwner: (id) => id === 'webchat:tailscale:owner@example.com',
      isAdminOf: () => false,
    };
    expect(decideCreateAgentAuthorization('webchat:tailscale:owner@example.com', groupId, checks)).toEqual({
      allowed: true,
      reason: 'owner',
    });
  });

  it('allows an admin scoped to this agent group', () => {
    const checks: CreateAgentAuthChecks = {
      isOwner: () => false,
      isAdminOf: (id, gid) => id === 'webchat:tailscale:admin@example.com' && gid === groupId,
    };
    expect(decideCreateAgentAuthorization('webchat:tailscale:admin@example.com', groupId, checks)).toEqual({
      allowed: true,
      reason: 'admin_of_group',
    });
  });

  it('denies a non-admin tailnet sender', () => {
    expect(decideCreateAgentAuthorization('webchat:tailscale:carl@example.com', groupId, denyAll)).toEqual({
      allowed: false,
      reason: 'unauthorized',
    });
  });

  it('does not leak admin-of one group to another', () => {
    const checks: CreateAgentAuthChecks = {
      isOwner: () => false,
      isAdminOf: (id, gid) => id === 'webchat:tailscale:scoped@example.com' && gid === 'ag-other',
    };
    expect(decideCreateAgentAuthorization('webchat:tailscale:scoped@example.com', groupId, checks)).toEqual({
      allowed: false,
      reason: 'unauthorized',
    });
  });
});
