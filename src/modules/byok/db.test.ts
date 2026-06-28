import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  getByokCredential,
  userHasActiveKey,
  userHasActiveOauth,
  getUserSecretId,
  userHasConnectedCredential,
  agentGroupForByokAgent,
  activeMembersForGroup,
  upsertByokCredential,
  upsertUserCredential,
  setUserCredentialStatus,
  setByokStatus,
} from './db.js';
import {
  getRoomCredentialMode,
  setRoomCredentialMode,
  getRoomOauthAllowed,
  setRoomOauthAllowed,
} from '../../channels/webchat/db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

describe('byok_credentials', () => {
  it('upsert + get round-trips and marks active', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice-aaa', 'sec-1');
    expect(getByokCredential('webchat:alice', 'ag-1')).toMatchObject({
      onecli_agent_id: 'byok-alice-aaa',
      secret_id: 'sec-1',
      status: 'active',
    });
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(true);
    expect(userHasActiveKey('webchat:bob', 'ag-1')).toBe(false);
  });

  it('getUserSecretId is sourced from the user-level credential (one secret, all rooms)', () => {
    expect(getUserSecretId('webchat:alice')).toBeNull(); // not connected yet
    upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(userHasConnectedCredential('webchat:alice', 'claude')).toBe(true);
    expect(getUserSecretId('webchat:alice')).toBe('sec-1');
    // Provider-scoped: a Codex credential is a separate secret.
    upsertUserCredential('webchat:alice', 'codex', 'sec-cdx', 'api_key');
    expect(getUserSecretId('webchat:alice', 'codex')).toBe('sec-cdx');
    expect(getUserSecretId('webchat:alice', 'claude')).toBe('sec-1');
    // Revoking clears it.
    setUserCredentialStatus('webchat:alice', 'claude', 'revoked');
    expect(getUserSecretId('webchat:alice')).toBeNull();
  });

  it('recovers the agent group from a BYOK agent id (approval routing)', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice-aaa', 'sec-1');
    expect(agentGroupForByokAgent('byok-alice-aaa')).toBe('ag-1');
    expect(agentGroupForByokAgent('unknown')).toBeNull();
  });

  it('lists only ACTIVE members for a group (fan-out source)', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-a');
    upsertByokCredential('webchat:bob', 'ag-1', 'byok-bob', 'sec-b');
    upsertByokCredential('webchat:carol', 'ag-2', 'byok-carol', 'sec-c');
    setByokStatus('webchat:bob', 'ag-1', 'revoked');
    expect(activeMembersForGroup('ag-1').sort()).toEqual(['webchat:alice']);
  });

  it('revoke clears active status', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-1');
    setByokStatus('webchat:alice', 'ag-1', 'revoked');
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(false);
    // re-onboard re-activates
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-1');
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(true);
  });
});

describe('byok oauth credentials (vault-only)', () => {
  it('stores an oauth credential with a vault secret_id + oauth cred_type', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice-aaa', 'sec-oat', 'oauth_token');
    const row = getByokCredential('webchat:alice', 'ag-1')!;
    expect(row.cred_type).toBe('oauth_token');
    expect(row.secret_id).toBe('sec-oat'); // lives in the OneCLI vault, like api keys
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(true);
    expect(userHasActiveOauth('webchat:alice', 'ag-1')).toBe(true);
  });

  it('userHasActiveOauth is false for api_key rows and after revoke', () => {
    upsertByokCredential('webchat:bob', 'ag-1', 'byok-bob', 'sec-1'); // default api_key
    expect(userHasActiveOauth('webchat:bob', 'ag-1')).toBe(false);

    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-oat', 'oauth_token');
    setByokStatus('webchat:alice', 'ag-1', 'revoked');
    expect(userHasActiveOauth('webchat:alice', 'ag-1')).toBe(false); // revoked
  });

  it('switching oauth→api_key flips cred_type and updates secret_id', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-oat', 'oauth_token');
    expect(userHasActiveOauth('webchat:alice', 'ag-1')).toBe(true);

    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-key', 'api_key');
    const row = getByokCredential('webchat:alice', 'ag-1')!;
    expect(row.cred_type).toBe('api_key');
    expect(row.secret_id).toBe('sec-key');
    expect(userHasActiveOauth('webchat:alice', 'ag-1')).toBe(false);
  });
});

describe('room oauth_allowed', () => {
  it('defaults to false and round-trips, orthogonal to credential_mode', () => {
    expect(getRoomOauthAllowed('room-z')).toBe(false);
    setRoomCredentialMode('room-z', 'optional');
    setRoomOauthAllowed('room-z', true);
    expect(getRoomOauthAllowed('room-z')).toBe(true);
    expect(getRoomCredentialMode('room-z')).toBe('optional'); // untouched
    setRoomOauthAllowed('room-z', false);
    expect(getRoomOauthAllowed('room-z')).toBe(false);
  });
});

describe('room credential_mode', () => {
  it('defaults to disabled, round-trips, preserves engage_default', () => {
    expect(getRoomCredentialMode('room-x')).toBe('disabled');
    getDb()
      .prepare(
        `INSERT INTO webchat_room_settings (room_id, engage_default, updated_at) VALUES ('room-y','mention-only',1)`,
      )
      .run();
    setRoomCredentialMode('room-y', 'required');
    expect(getRoomCredentialMode('room-y')).toBe('required');
    const row = getDb()
      .prepare(`SELECT engage_default, credential_mode FROM webchat_room_settings WHERE room_id='room-y'`)
      .get() as { engage_default: string; credential_mode: string };
    expect(row).toEqual({ engage_default: 'mention-only', credential_mode: 'required' });
  });
});
