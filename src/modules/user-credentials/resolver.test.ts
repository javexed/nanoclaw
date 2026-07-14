/**
 * Phase 1: the session-key resolver. In a UserCreds room a member who has CONNECTED a
 * credential (user-level, applies to every same-provider room) gets a per-member
 * session keyed by userId; everyone else / every other room is unchanged
 * (null → shared session). Enrollment in a given room is then lazy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { resolveSessionKeyOverride } from '../../session-manager.js';
import { resolveAgentIdentity, resolveContainerEnv } from '../../container-runtime.js';
import { setRoomModeOverride, setCredentialsConfig } from '../../channels/webchat/db.js';
import { upsertUserCredential, setUserCredentialStatus } from './db.js';
import { userCredsAgentIdentifier, WORKSPACE_DEFAULT_USER_ID } from './identity.js';
import './index.js'; // registers the resolvers

const webchatMg = (platformId: string) => ({
  id: 'mg-1',
  channel_type: 'webchat',
  platform_id: platformId,
  is_group: 0,
});

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

describe('userCreds session-key resolver', () => {
  it('connected member in a UserCreds room → per-member session keyed by userId', () => {
    setRoomModeOverride('room-1', 'required');
    upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:alice',
    });
  });

  it('optional + not connected → no override (falls back to the shared session)', () => {
    setRoomModeOverride('room-1', 'optional');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:bob')).toBeNull();
  });

  it('required + not connected → BLOCK with guidance (never bills the shared key)', () => {
    setRoomModeOverride('room-1', 'required');
    const r = resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:bob');
    expect(r && 'block' in r).toBe(true);
    expect((r as { block: string }).block).toMatch(/your own Anthropic key/i);
  });

  it('disabled room (no API-key mode, no OAuth) → no override', () => {
    upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(resolveSessionKeyOverride(webchatMg('room-x'), 'ag-1', 'webchat:alice')).toBeNull(); // room-x has no row → disabled
  });

  it('disabled room does NOT route OAuth either — mode is the master gate over both methods', () => {
    // User credentials Off = no UserCreds at all, even with workspace OAuth accepted
    // AND a connected subscription. (The mode gates OAuth, not just API keys.)
    setCredentialsConfig({ allowClaudeOauth: true });
    setRoomModeOverride('room-1', 'disabled');
    upsertUserCredential('webchat:alice', 'claude', 'sec-oat', 'oauth_token');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toBeNull();
    // Turn the room on → the same connected OAuth member now routes per-member.
    setRoomModeOverride('room-1', 'optional');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:alice',
    });
  });

  it('revoked credential → no override', () => {
    setRoomModeOverride('room-1', 'optional');
    upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    setUserCredentialStatus('webchat:alice', 'claude', 'revoked');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toBeNull();
  });

  it('connected OAuth member stops routing when the workspace disables OAuth', () => {
    setRoomModeOverride('room-1', 'optional');
    upsertUserCredential('webchat:alice', 'claude', 'sec-oat', 'oauth_token');
    setCredentialsConfig({ allowClaudeOauth: true });
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:alice',
    });
    // Admin flips OAuth off → the already-connected member must fall back to shared.
    setCredentialsConfig({ allowClaudeOauth: false });
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toBeNull();
  });

  it('non-webchat channel → no override', () => {
    setRoomModeOverride('room-1', 'required');
    upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    const telegramMg = { id: 'mg-2', channel_type: 'telegram', platform_id: 'room-1', is_group: 1 };
    expect(resolveSessionKeyOverride(telegramMg, 'ag-1', 'webchat:alice')).toBeNull();
  });

  it('null userId → no override', () => {
    setRoomModeOverride('room-1', 'required');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', null)).toBeNull();
  });
});

describe('container-env resolver (OAuth sentinel at spawn)', () => {
  const OAUTH_ENV = { CLAUDE_CODE_OAUTH_TOKEN: 'placeholder', ANTHROPIC_API_KEY: '' };

  it('per-member OAuth session → sentinel env', () => {
    upsertUserCredential('webchat:alice', 'claude', 'sec-oat', 'oauth_token');
    expect(resolveContainerEnv('ag-1', 'webchat:alice')).toEqual(OAUTH_ENV);
  });

  it('per-member API-key session → no env (rides x-api-key)', () => {
    upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(resolveContainerEnv('ag-1', 'webchat:alice')).toEqual({});
  });

  it('base session + OAuth workspace default → sentinel env', () => {
    upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-ws-oat', 'oauth_token');
    expect(resolveContainerEnv('ag-1', null)).toEqual(OAUTH_ENV);
  });

  it('base session + API-key workspace default → no env', () => {
    upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-ws-key', 'api_key');
    expect(resolveContainerEnv('ag-1', null)).toEqual({});
  });

  it('base session + no workspace default → no env', () => {
    expect(resolveContainerEnv('ag-1', null)).toEqual({});
  });

  it('member API key wins over an OAuth workspace default for that member session', () => {
    upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-ws-oat', 'oauth_token');
    upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(resolveContainerEnv('ag-1', 'webchat:alice')).toEqual({}); // member key mode
    expect(resolveContainerEnv('ag-1', null)).toEqual(OAUTH_ENV); // base still OAuth
  });

  it('topic-thread ids (not a credentialed member) fall through to the workspace default', () => {
    upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-ws-oat', 'oauth_token');
    expect(resolveContainerEnv('ag-1', 'main')).toEqual(OAUTH_ENV); // webchat topic thread
  });

  it('revoked workspace default → no sentinel (fail back to key mode)', () => {
    upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-ws-oat', 'oauth_token');
    setUserCredentialStatus(WORKSPACE_DEFAULT_USER_ID, 'claude', 'revoked');
    expect(resolveContainerEnv('ag-1', null)).toEqual({});
  });
});

describe('userCreds agent-identity resolver (spawn)', () => {
  it('per-member session of a connected member → the member UserCreds identity', () => {
    upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(resolveAgentIdentity('ag-1', 'webchat:alice')).toBe(userCredsAgentIdentifier('ag-1', 'webchat:alice'));
  });
  it('not connected / no thread → null (default agent-group identity)', () => {
    expect(resolveAgentIdentity('ag-1', 'webchat:bob')).toBeNull();
    expect(resolveAgentIdentity('ag-1', null)).toBeNull();
  });
  it('revoked credential → null', () => {
    upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    setUserCredentialStatus('webchat:alice', 'claude', 'revoked');
    expect(resolveAgentIdentity('ag-1', 'webchat:alice')).toBeNull();
  });
});
