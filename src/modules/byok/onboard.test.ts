import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { onboardByokCredential, onboardByokOauth, revokeByokCredential } from './onboard.js';
import { getByokCredential, userHasActiveKey, userHasActiveOauth, getUserSecretId } from './db.js';
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
    const n = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM byok_credentials WHERE user_id='webchat:alice'`).get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });
});

describe('onboardByokOauth (vault-only — token stored in OneCLI, swapped on the wire)', () => {
  it('stores the oauth token as the member vault secret + mirrors tools, oauth cred_type', async () => {
    const { admin, seedGroupAgent, agents, secrets } = fakeAdmin();
    seedGroupAgent('ag-1', [
      { id: 'grp-anthropic', type: 'anthropic' },
      { id: 'grp-gmail', type: 'generic' },
    ]);
    await onboardByokOauth(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-oat-TOKEN');
    const ident = byokAgentIdentifier('ag-1', 'webchat:alice');
    const row = getByokCredential('webchat:alice', 'ag-1')!;
    expect(row.cred_type).toBe('oauth_token');
    expect(row.secret_id).not.toBeNull(); // lives in the OneCLI vault, like api keys
    expect(userHasActiveOauth('webchat:alice', 'ag-1')).toBe(true);
    // The oauth token is now a vault secret (OneCLI swaps it on the wire).
    expect(secrets.get(row.secret_id!)!.value).toBe('sk-ant-oat-TOKEN');
    // Per-member agent carries the member's oauth secret + the group's gmail; NOT the group's anthropic.
    expect(agents.get(ident)!.secretIds.sort()).toEqual([row.secret_id!, 'grp-gmail'].sort());
  });

  it('reuses the user secret across api_key↔oauth (updates value, flips cred_type)', async () => {
    const { admin, secrets } = fakeAdmin();
    await onboardByokCredential(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-api-1');
    const sec = getUserSecretId('webchat:alice')!;
    await onboardByokOauth(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-oat-2');
    expect(getUserSecretId('webchat:alice')).toBe(sec); // same secret reused
    expect(secrets.get(sec)!.value).toBe('sk-ant-oat-2'); // value updated to the oauth token
    expect(userHasActiveOauth('webchat:alice', 'ag-1')).toBe(true);
  });

  it('revoke removes the member secret from the agent and marks revoked', async () => {
    const { admin, seedGroupAgent, agents } = fakeAdmin();
    seedGroupAgent('ag-1', [{ id: 'grp-gmail', type: 'generic' }]);
    await onboardByokOauth(admin, 'webchat:alice', 'ag-1', 'Alice', 'sk-ant-oat-X');
    const ident = byokAgentIdentifier('ag-1', 'webchat:alice');
    const userSecret = getByokCredential('webchat:alice', 'ag-1')!.secret_id!;
    await revokeByokCredential(admin, 'webchat:alice', 'ag-1');
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(false);
    expect(agents.get(ident)!.secretIds).not.toContain(userSecret); // member secret removed
    expect(agents.get(ident)!.secretIds).toContain('grp-gmail'); // tools left
  });
});

describe('Codex provider (per-member ChatGPT/Codex credential)', () => {
  it('OAuth: stores the auth.json as an OpenAI secret, excludes the group openai cred, no Claude sentinel', async () => {
    const { admin, seedGroupAgent, agents, secrets } = fakeAdmin();
    makeCodexGroup('ag-cdx');
    seedGroupAgent('ag-cdx', [
      { id: 'grp-openai', type: 'openai' }, // the group's own Codex credential — must NOT be mirrored
      { id: 'grp-gmail', type: 'generic' }, // a real tool — must be mirrored
    ]);
    const authJson = '{"tokens":{"access_token":"xyz"},"OPENAI_API_KEY":null}';
    await onboardByokOauth(admin, 'webchat:carol', 'ag-cdx', 'Carol', authJson);

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

  it('API key: stores the key as an OpenAI secret', async () => {
    const { admin, secrets } = fakeAdmin();
    makeCodexGroup('ag-cdx');
    await onboardByokCredential(admin, 'webchat:dave', 'ag-cdx', 'Dave', 'sk-openai-dave');
    const row = getByokCredential('webchat:dave', 'ag-cdx')!;
    expect(row.provider).toBe('codex');
    expect(row.cred_type).toBe('api_key');
    expect(secrets.get(row.secret_id!)!.type).toBe('openai');
    expect(secrets.get(row.secret_id!)!.value).toBe('sk-openai-dave');
  });

  it('a member in both a Claude room and a Codex room keeps two distinct secrets', async () => {
    const { admin, secrets } = fakeAdmin();
    makeCodexGroup('ag-cdx');
    // 'ag-claude' has no container_config row → defaults to claude.
    await onboardByokCredential(admin, 'webchat:erin', 'ag-claude', 'Erin', 'sk-ant-erin');
    await onboardByokOauth(admin, 'webchat:erin', 'ag-cdx', 'Erin', '{"tokens":{}}');
    const claudeSecret = getByokCredential('webchat:erin', 'ag-claude')!.secret_id!;
    const codexSecret = getByokCredential('webchat:erin', 'ag-cdx')!.secret_id!;
    expect(claudeSecret).not.toBe(codexSecret); // not collapsed into one secret
    expect(secrets.get(claudeSecret)!.type).toBe('anthropic');
    expect(secrets.get(codexSecret)!.type).toBe('openai');
    // Provider-scoped reuse picks the right one.
    expect(getUserSecretId('webchat:erin', 'claude')).toBe(claudeSecret);
    expect(getUserSecretId('webchat:erin', 'codex')).toBe(codexSecret);
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
