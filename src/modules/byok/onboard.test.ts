import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { onboardByokCredential, onboardByokOauth, revokeByokCredential } from './onboard.js';
import { getByokCredential, userHasActiveKey, getUserSecretId, getOauthToken } from './db.js';
import { _resetKeyCacheForTests } from './crypto.js';
import { byokAgentIdentifier } from './identity.js';
import type { OnecliAdmin } from './onecli-admin.js';

/** In-memory fake OneCLI vault: tracks secrets (id→type), agents, assignments. */
function fakeAdmin() {
  const secrets = new Map<string, { value: string; type: string }>();
  const agents = new Map<string, { uuid: string; secretIds: string[]; mode: string }>(); // identifier → state
  let n = 0;
  const byUuid = (uuid: string) => [...agents.values()].find((a) => a.uuid === uuid);
  const admin: OnecliAdmin = {
    async findAgentId(identifier) {
      return agents.get(identifier)?.uuid ?? null;
    },
    async ensureAgent(_name, identifier) {
      if (!agents.get(identifier)) agents.set(identifier, { uuid: `uuid-${identifier}`, secretIds: [], mode: 'selective' });
      return agents.get(identifier)!.uuid;
    },
    async createAnthropicSecret(_name, value) {
      const id = `sec-${++n}`;
      secrets.set(id, { value, type: 'anthropic' });
      return id;
    },
    async updateSecretValue(secretId, value) {
      secrets.set(secretId, { value, type: secrets.get(secretId)?.type ?? 'anthropic' });
    },
    async deleteSecret(secretId) {
      secrets.delete(secretId);
    },
    async setSecretMode(uuid, mode) {
      const a = byUuid(uuid);
      if (a) a.mode = mode;
    },
    async listAgentSecretIds(uuid) {
      return byUuid(uuid)?.secretIds ? [...byUuid(uuid)!.secretIds] : [];
    },
    async listAllSecrets() {
      return [...secrets].map(([id, v]) => ({ id, type: v.type }));
    },
    async setSecrets(uuid, ids) {
      const a = byUuid(uuid);
      if (a) a.secretIds = [...ids];
    },
  };
  /** Seed a group agent with pre-assigned secrets (id→type) for mirror tests. */
  function seedGroupAgent(identifier: string, secs: { id: string; type: string }[]) {
    agents.set(identifier, { uuid: `uuid-${identifier}`, secretIds: secs.map((s) => s.id), mode: 'all' });
    for (const s of secs) secrets.set(s.id, { value: 'x', type: s.type });
  }
  return { admin, secrets, agents, seedGroupAgent };
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

describe('onboardByokCredential', () => {
  it('creates the secret + per-member agent (selective) and persists the mapping', async () => {
    const { admin, agents } = fakeAdmin();
    await onboardByokCredential(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-alice');
    const ident = byokAgentIdentifier('ag-1', 'webchat:alice');
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(true);
    expect(getByokCredential('webchat:alice', 'ag-1')?.onecli_agent_id).toBe(ident);
    const agent = agents.get(ident)!;
    expect(agent.mode).toBe('selective');
    expect(agent.secretIds).toEqual([getByokCredential('webchat:alice', 'ag-1')!.secret_id]); // just the user's key (no group tools)
  });

  it('mirrors the group non-anthropic tool secrets + the user key', async () => {
    const { admin, seedGroupAgent, agents } = fakeAdmin();
    // group ag-1's OneCLI agent has a shared anthropic + a gmail tool secret
    seedGroupAgent('ag-1', [
      { id: 'grp-anthropic', type: 'anthropic' },
      { id: 'grp-gmail', type: 'generic' },
    ]);
    await onboardByokCredential(admin, 'webchat:bob', 'ag-1', 'Bob', 'sk-ant-bob');
    const ident = byokAgentIdentifier('ag-1', 'webchat:bob');
    const userSecret = getByokCredential('webchat:bob', 'ag-1')!.secret_id!;
    // user's anthropic + the group's gmail; NOT the group's anthropic
    expect(agents.get(ident)!.secretIds.sort()).toEqual([userSecret, 'grp-gmail'].sort());
  });

  it('reuses the user secret across groups (updates value on re-onboard)', async () => {
    const { admin, secrets } = fakeAdmin();
    await onboardByokCredential(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-1');
    const sec = getUserSecretId('webchat:alice')!;
    await onboardByokCredential(admin, 'webchat:alice', 'ag-2', 'Alice', 'sk-ant-2');
    expect(getUserSecretId('webchat:alice')).toBe(sec); // same secret reused
    expect(secrets.get(sec)!.value).toBe('sk-ant-2'); // value updated
    expect(userHasActiveKey('webchat:alice', 'ag-2')).toBe(true);
  });

  it('is idempotent (re-onboard does not duplicate)', async () => {
    const { admin } = fakeAdmin();
    await onboardByokCredential(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-1');
    await onboardByokCredential(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-1');
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM byok_credentials WHERE user_id='webchat:alice'`).get() as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe('onboardByokOauth', () => {
  beforeEach(() => _resetKeyCacheForTests());

  it('stores the encrypted token, no anthropic secret, mirrors tools only', async () => {
    const { admin, seedGroupAgent, agents, secrets } = fakeAdmin();
    seedGroupAgent('ag-1', [
      { id: 'grp-anthropic', type: 'anthropic' },
      { id: 'grp-gmail', type: 'generic' },
    ]);
    await onboardByokOauth(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-oat-TOKEN');
    const ident = byokAgentIdentifier('ag-1', 'webchat:alice');
    const row = getByokCredential('webchat:alice', 'ag-1')!;
    expect(row.cred_type).toBe('oauth_token');
    expect(row.secret_id).toBeNull();
    expect(getOauthToken('webchat:alice', 'ag-1')).toBe('sk-ant-oat-TOKEN');
    // No new anthropic secret was created for the member.
    expect([...secrets.values()].some((s) => s.value === 'sk-ant-oat-TOKEN')).toBe(false);
    // Per-member agent carries only the group's non-anthropic tool secret.
    expect(agents.get(ident)!.secretIds).toEqual(['grp-gmail']);
  });

  it('succeeds when the group has no tool secrets (no empty set-secrets call)', async () => {
    // Regression: greensight-style group whose agent has only an Anthropic
    // secret → toolSecretIds=[] → must NOT call set-secrets (OneCLI rejects
    // an empty list). Onboard should still store the token and succeed.
    const { admin, seedGroupAgent, agents } = fakeAdmin();
    seedGroupAgent('ag-1', [{ id: 'grp-anthropic', type: 'anthropic' }]); // anthropic only
    let setSecretsCalls = 0;
    const orig = admin.setSecrets;
    admin.setSecrets = async (uuid, ids) => {
      setSecretsCalls++;
      return orig(uuid, ids);
    };
    await onboardByokOauth(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-oat-X');
    expect(setSecretsCalls).toBe(0); // never called with an empty list
    expect(getOauthToken('webchat:alice', 'ag-1')).toBe('sk-ant-oat-X');
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(true);
    const ident = byokAgentIdentifier('ag-1', 'webchat:alice');
    expect(agents.get(ident)!.secretIds).toEqual([]); // tools-only, none
  });

  it('revoke wipes the encrypted token and marks revoked', async () => {
    const { admin } = fakeAdmin();
    await onboardByokOauth(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-oat-X');
    await revokeByokCredential(admin, 'webchat:alice', 'ag-1');
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(false);
    expect(getOauthToken('webchat:alice', 'ag-1')).toBeNull();
    expect(getByokCredential('webchat:alice', 'ag-1')!.oauth_token_enc).toBeNull();
  });
});

describe('revokeByokCredential', () => {
  it('removes the user key from the per-member agent and marks revoked', async () => {
    const { admin, seedGroupAgent, agents } = fakeAdmin();
    seedGroupAgent('ag-1', [{ id: 'grp-gmail', type: 'generic' }]);
    await onboardByokCredential(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-1');
    const ident = byokAgentIdentifier('ag-1', 'webchat:alice');
    const userSecret = getByokCredential('webchat:alice', 'ag-1')!.secret_id!;
    await revokeByokCredential(admin, 'webchat:alice', 'ag-1');
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(false);
    expect(agents.get(ident)!.secretIds).not.toContain(userSecret); // user key removed
    expect(agents.get(ident)!.secretIds).toContain('grp-gmail'); // tools left
  });
});
