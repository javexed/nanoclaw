import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { storeUserCredential, ensureGroupEnrollment, revokeUserCredential } from './onboard.js';
import {
  getByokCredential,
  userHasActiveKey,
  userHasActiveOauth,
  userHasConnectedCredential,
  getUserCredential,
  getUserSecretId,
} from './db.js';
import { byokAgentIdentifier } from './identity.js';
import type { OnecliAdmin } from './onecli-admin.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';

/** Make `id` a Codex-provider agent group (parent row required by the FK). */
function makeCodexGroup(id: string): void {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, id, id, new Date().toISOString());
  ensureContainerConfig(id);
  updateContainerConfigScalars(id, { provider: 'codex' });
}

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
      if (!agents.get(identifier))
        agents.set(identifier, { uuid: `uuid-${identifier}`, secretIds: [], mode: 'selective' });
      return agents.get(identifier)!.uuid;
    },
    async createAnthropicSecret(_name, value) {
      const id = `sec-${++n}`;
      // OneCLI auto-detects oauth vs api-key from the value; both are `anthropic`.
      secrets.set(id, { value, type: 'anthropic' });
      return id;
    },
    async createOpenAISecret(_name, value, _credType) {
      const id = `sec-${++n}`;
      secrets.set(id, { value, type: 'openai' });
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

describe('storeUserCredential (connect once → user-level secret, no per-room work)', () => {
  it('creates the vault secret + user-level row, but no per-member agent yet', async () => {
    const { admin, secrets, agents } = fakeAdmin();
    await storeUserCredential(admin, 'webchat:alice', 'claude', 'sk-ant-alice', 'api_key');
    expect(userHasConnectedCredential('webchat:alice', 'claude')).toBe(true);
    const row = getUserCredential('webchat:alice', 'claude')!;
    expect(row.cred_type).toBe('api_key');
    expect(secrets.get(row.secret_id!)!.value).toBe('sk-ant-alice');
    expect(secrets.get(row.secret_id!)!.type).toBe('anthropic');
    expect(agents.size).toBe(0); // nothing enrolled yet — that's lazy
  });

  it('recreates the secret on re-connect when the cred type flips', async () => {
    const { admin, secrets } = fakeAdmin();
    await storeUserCredential(admin, 'webchat:alice', 'claude', 'sk-ant-api-1', 'api_key');
    const old = getUserSecretId('webchat:alice')!;
    await storeUserCredential(admin, 'webchat:alice', 'claude', 'sk-ant-oat-2', 'oauth_token');
    const fresh = getUserSecretId('webchat:alice')!;
    expect(fresh).not.toBe(old); // old secret deleted, new one created
    expect(secrets.has(old)).toBe(false); // torn down
    expect(secrets.get(fresh)!.value).toBe('sk-ant-oat-2'); // new value (OneCLI auto-detects oauth)
    expect(getUserCredential('webchat:alice', 'claude')!.cred_type).toBe('oauth_token');
  });

  it('keeps Claude and Codex credentials as two distinct secrets', async () => {
    const { admin, secrets } = fakeAdmin();
    await storeUserCredential(admin, 'webchat:erin', 'claude', 'sk-ant-erin', 'api_key');
    await storeUserCredential(admin, 'webchat:erin', 'codex', '{"tokens":{}}', 'oauth_token');
    const claudeSecret = getUserSecretId('webchat:erin', 'claude')!;
    const codexSecret = getUserSecretId('webchat:erin', 'codex')!;
    expect(claudeSecret).not.toBe(codexSecret);
    expect(secrets.get(claudeSecret)!.type).toBe('anthropic');
    expect(secrets.get(codexSecret)!.type).toBe('openai');
  });
});

describe('ensureGroupEnrollment (lazy, at first spawn)', () => {
  it('creates the per-member agent (selective) and assigns just the user key when the group has no tools', async () => {
    const { admin, agents } = fakeAdmin();
    await storeUserCredential(admin, 'webchat:alice', 'claude', 'sk-ant-alice', 'api_key');
    await ensureGroupEnrollment(admin, 'webchat:alice', 'ag-1');
    const ident = byokAgentIdentifier('ag-1', 'webchat:alice');
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(true);
    expect(getByokCredential('webchat:alice', 'ag-1')?.onecli_agent_id).toBe(ident);
    const agent = agents.get(ident)!;
    expect(agent.mode).toBe('selective');
    expect(agent.secretIds).toEqual([getUserSecretId('webchat:alice')]); // just the user's key
  });

  it('mirrors the group non-anthropic tool secrets + the user key', async () => {
    const { admin, seedGroupAgent, agents } = fakeAdmin();
    seedGroupAgent('ag-1', [
      { id: 'grp-anthropic', type: 'anthropic' },
      { id: 'grp-gmail', type: 'generic' },
    ]);
    await storeUserCredential(admin, 'webchat:bob', 'claude', 'sk-ant-bob', 'api_key');
    await ensureGroupEnrollment(admin, 'webchat:bob', 'ag-1');
    const ident = byokAgentIdentifier('ag-1', 'webchat:bob');
    const userSecret = getUserSecretId('webchat:bob')!;
    // user's anthropic + the group's gmail; NOT the group's anthropic
    expect(agents.get(ident)!.secretIds.sort()).toEqual([userSecret, 'grp-gmail'].sort());
  });

  it('reuses the one user secret across multiple enrolled groups', async () => {
    const { admin } = fakeAdmin();
    await storeUserCredential(admin, 'webchat:alice', 'claude', 'sk-ant-1', 'api_key');
    await ensureGroupEnrollment(admin, 'webchat:alice', 'ag-1');
    await ensureGroupEnrollment(admin, 'webchat:alice', 'ag-2');
    const sec = getUserSecretId('webchat:alice')!;
    expect(getByokCredential('webchat:alice', 'ag-1')!.secret_id).toBe(sec);
    expect(getByokCredential('webchat:alice', 'ag-2')!.secret_id).toBe(sec);
    expect(userHasActiveKey('webchat:alice', 'ag-2')).toBe(true);
  });

  it('is idempotent — a second enroll is a no-op (no duplicate rows)', async () => {
    const { admin } = fakeAdmin();
    await storeUserCredential(admin, 'webchat:alice', 'claude', 'sk-ant-1', 'api_key');
    await ensureGroupEnrollment(admin, 'webchat:alice', 'ag-1');
    await ensureGroupEnrollment(admin, 'webchat:alice', 'ag-1');
    const n = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM byok_credentials WHERE user_id='webchat:alice'`).get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it('does nothing when the member has not connected a credential for the provider', async () => {
    const { admin, agents } = fakeAdmin();
    await ensureGroupEnrollment(admin, 'webchat:nobody', 'ag-1');
    expect(getByokCredential('webchat:nobody', 'ag-1')).toBeNull();
    expect(agents.size).toBe(0);
  });

  it('marks an OAuth Claude member as oauth so the container gets the sentinel', async () => {
    const { admin } = fakeAdmin();
    await storeUserCredential(admin, 'webchat:alice', 'claude', 'sk-ant-oat-TOKEN', 'oauth_token');
    await ensureGroupEnrollment(admin, 'webchat:alice', 'ag-1');
    const row = getByokCredential('webchat:alice', 'ag-1')!;
    expect(row.cred_type).toBe('oauth_token');
    expect(userHasActiveOauth('webchat:alice', 'ag-1')).toBe(true);
  });
});

describe('Codex provider (per-member ChatGPT/Codex credential)', () => {
  it('OAuth: enrolls an OpenAI secret, excludes the group openai cred, no Claude sentinel', async () => {
    const { admin, seedGroupAgent, agents, secrets } = fakeAdmin();
    makeCodexGroup('ag-cdx');
    seedGroupAgent('ag-cdx', [
      { id: 'grp-openai', type: 'openai' }, // the group's own Codex credential — must NOT be mirrored
      { id: 'grp-gmail', type: 'generic' }, // a real tool — must be mirrored
    ]);
    const authJson = '{"tokens":{"access_token":"xyz"},"OPENAI_API_KEY":null}';
    await storeUserCredential(admin, 'webchat:carol', 'codex', authJson, 'oauth_token');
    await ensureGroupEnrollment(admin, 'webchat:carol', 'ag-cdx');

    const ident = byokAgentIdentifier('ag-cdx', 'webchat:carol');
    const row = getByokCredential('webchat:carol', 'ag-cdx')!;
    expect(row.provider).toBe('codex');
    expect(row.cred_type).toBe('oauth_token');
    expect(secrets.get(row.secret_id!)!.type).toBe('openai'); // openai, not anthropic
    expect(secrets.get(row.secret_id!)!.value).toBe(authJson); // the whole auth.json
    expect(userHasActiveKey('webchat:carol', 'ag-cdx')).toBe(true); // drives per-member session
    expect(userHasActiveOauth('webchat:carol', 'ag-cdx')).toBe(false); // Claude-scoped → no sentinel for Codex
    // Member's openai secret + the group's gmail; NOT the group's openai credential.
    expect(agents.get(ident)!.secretIds.sort()).toEqual([row.secret_id!, 'grp-gmail'].sort());
  });

  it('API key: enrolls the key as an OpenAI secret', async () => {
    const { admin, secrets } = fakeAdmin();
    makeCodexGroup('ag-cdx');
    await storeUserCredential(admin, 'webchat:dave', 'codex', 'sk-openai-dave', 'api_key');
    await ensureGroupEnrollment(admin, 'webchat:dave', 'ag-cdx');
    const row = getByokCredential('webchat:dave', 'ag-cdx')!;
    expect(row.provider).toBe('codex');
    expect(row.cred_type).toBe('api_key');
    expect(secrets.get(row.secret_id!)!.type).toBe('openai');
    expect(secrets.get(row.secret_id!)!.value).toBe('sk-openai-dave');
  });
});

describe('revokeUserCredential (disconnect once → un-enroll everywhere)', () => {
  it('removes the user key from every enrolled per-member agent, deletes the vault secret, marks revoked', async () => {
    const { admin, seedGroupAgent, agents, secrets } = fakeAdmin();
    seedGroupAgent('ag-1', [{ id: 'grp-gmail', type: 'generic' }]);
    seedGroupAgent('ag-2', [{ id: 'grp-slack', type: 'generic' }]);
    await storeUserCredential(admin, 'webchat:alice', 'claude', 'sk-ant-1', 'api_key');
    await ensureGroupEnrollment(admin, 'webchat:alice', 'ag-1');
    await ensureGroupEnrollment(admin, 'webchat:alice', 'ag-2');
    const userSecret = getUserSecretId('webchat:alice')!;
    await revokeUserCredential(admin, 'webchat:alice', 'claude');

    expect(userHasConnectedCredential('webchat:alice', 'claude')).toBe(false);
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(false);
    expect(userHasActiveKey('webchat:alice', 'ag-2')).toBe(false);
    expect(secrets.has(userSecret)).toBe(false); // real credential purged from the vault, not just revoked
    const ident1 = byokAgentIdentifier('ag-1', 'webchat:alice');
    const ident2 = byokAgentIdentifier('ag-2', 'webchat:alice');
    expect(agents.get(ident1)!.secretIds).not.toContain(userSecret); // member secret removed
    expect(agents.get(ident1)!.secretIds).toContain('grp-gmail'); // tools left
    expect(agents.get(ident2)!.secretIds).not.toContain(userSecret);
    expect(agents.get(ident2)!.secretIds).toContain('grp-slack');
  });

  it('purges the vault secret even when the per-member agent had no other secrets', async () => {
    // The empty-set-secrets gap: with nothing left to assign, the secret stays on
    // the agent — deleting it from the vault is what actually neutralizes it.
    const { admin, secrets } = fakeAdmin();
    await storeUserCredential(admin, 'webchat:bob', 'claude', 'sk-ant-bob', 'api_key');
    await ensureGroupEnrollment(admin, 'webchat:bob', 'ag-1'); // no group tools → agent holds only the user key
    const userSecret = getUserSecretId('webchat:bob')!;
    await revokeUserCredential(admin, 'webchat:bob', 'claude');
    expect(secrets.has(userSecret)).toBe(false);
  });

  it('only revokes the named provider, leaving the other connected', async () => {
    const { admin } = fakeAdmin();
    makeCodexGroup('ag-cdx');
    await storeUserCredential(admin, 'webchat:erin', 'claude', 'sk-ant-erin', 'api_key');
    await storeUserCredential(admin, 'webchat:erin', 'codex', '{"tokens":{}}', 'oauth_token');
    await revokeUserCredential(admin, 'webchat:erin', 'claude');
    expect(userHasConnectedCredential('webchat:erin', 'claude')).toBe(false);
    expect(userHasConnectedCredential('webchat:erin', 'codex')).toBe(true);
  });
});
