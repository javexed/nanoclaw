import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  getByokCredential,
  userHasActiveKey,
  getUserSecretId,
  agentGroupForByokAgent,
  activeMembersForGroup,
  upsertByokCredential,
  upsertByokOauthCredential,
  getOauthToken,
  clearOauthToken,
  setByokStatus,
} from './db.js';
import { _resetKeyCacheForTests } from './crypto.js';
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

  it('reuses a user secret id across agent groups', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice-aaa', 'sec-1');
    expect(getUserSecretId('webchat:alice')).toBe('sec-1');
    upsertByokCredential('webchat:alice', 'ag-2', 'byok-alice-bbb', 'sec-1');
    expect(getUserSecretId('webchat:alice')).toBe('sec-1');
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

describe('byok oauth credentials', () => {
  beforeEach(() => _resetKeyCacheForTests());

  it('stores an encrypted oauth token and decrypts it back (no secret_id)', () => {
    upsertByokOauthCredential('webchat:alice', 'ag-1', 'byok-alice-aaa', 'sk-ant-oat-SECRET');
    const row = getByokCredential('webchat:alice', 'ag-1')!;
    expect(row.cred_type).toBe('oauth_token');
    expect(row.secret_id).toBeNull();
    expect(row.oauth_token_enc).toBeInstanceOf(Buffer);
    // Ciphertext must not contain the plaintext.
    expect(row.oauth_token_enc!.toString('utf8')).not.toContain('SECRET');
    expect(getOauthToken('webchat:alice', 'ag-1')).toBe('sk-ant-oat-SECRET');
    expect(userHasActiveKey('webchat:alice', 'ag-1')).toBe(true);
  });

  it('getOauthToken is null for api_key rows and after revoke', () => {
    upsertByokCredential('webchat:bob', 'ag-1', 'byok-bob', 'sec-1');
    expect(getOauthToken('webchat:bob', 'ag-1')).toBeNull(); // api_key row

    upsertByokOauthCredential('webchat:alice', 'ag-1', 'byok-alice', 'sk-ant-oat-X');
    setByokStatus('webchat:alice', 'ag-1', 'revoked');
    expect(getOauthToken('webchat:alice', 'ag-1')).toBeNull(); // revoked
  });

  it('clearOauthToken wipes the blob', () => {
    upsertByokOauthCredential('webchat:alice', 'ag-1', 'byok-alice', 'sk-ant-oat-X');
    clearOauthToken('webchat:alice', 'ag-1');
    const row = getByokCredential('webchat:alice', 'ag-1')!;
    expect(row.oauth_token_enc).toBeNull();
    expect(row.oauth_token_nonce).toBeNull();
  });

  it('switching api_key→oauth and back clears the stale side', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-1');
    upsertByokOauthCredential('webchat:alice', 'ag-1', 'byok-alice', 'sk-ant-oat-X');
    let row = getByokCredential('webchat:alice', 'ag-1')!;
    expect(row.secret_id).toBeNull();
    expect(row.cred_type).toBe('oauth_token');

    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-2');
    row = getByokCredential('webchat:alice', 'ag-1')!;
    expect(row.cred_type).toBe('api_key');
    expect(row.secret_id).toBe('sec-2');
    expect(row.oauth_token_enc).toBeNull();
    expect(getOauthToken('webchat:alice', 'ag-1')).toBeNull();
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
      .prepare(`INSERT INTO webchat_room_settings (room_id, engage_default, updated_at) VALUES ('room-y','mention-only',1)`)
      .run();
    setRoomCredentialMode('room-y', 'required');
    expect(getRoomCredentialMode('room-y')).toBe('required');
    const row = getDb()
      .prepare(`SELECT engage_default, credential_mode FROM webchat_room_settings WHERE room_id='room-y'`)
      .get() as { engage_default: string; credential_mode: string };
    expect(row).toEqual({ engage_default: 'mention-only', credential_mode: 'required' });
  });
});
