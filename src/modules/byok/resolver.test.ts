/**
 * Phase 1: the session-key resolver. In a BYOK room a member who has CONNECTED a
 * credential (user-level, applies to every same-provider room) gets a per-member
 * session keyed by userId; everyone else / every other room is unchanged
 * (null → shared session). Enrollment in a given room is then lazy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { resolveSessionKeyOverride } from '../../session-manager.js';
import { resolveAgentIdentity } from '../../container-runtime.js';
import { setRoomModeOverride, setCredentialsConfig, setRoomOauthAllowed } from '../../channels/webchat/db.js';
import { upsertUserCredential, setUserCredentialStatus } from './db.js';
import { byokAgentIdentifier } from './identity.js';
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

describe('byok session-key resolver', () => {
  it('connected member in a BYOK room → per-member session keyed by userId', () => {
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

  it('OAuth-only room (mode disabled, oauth_allowed) + connected member → per-member session', () => {
    // The load-bearing case: oauth must route even though credential_mode is 'disabled'.
    // Requires BOTH gates: workspace accepts OAuth AND the room opted in.
    setCredentialsConfig({ allowClaudeOauth: true }); // workspace accepts OAuth; room mode stays 'disabled'
    setRoomOauthAllowed('room-1', true); // per-room gate 1
    upsertUserCredential('webchat:alice', 'claude', 'sec-oat', 'oauth_token');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:alice',
    });
    // A different member who hasn't connected, in an OAuth-only room → shared (no block).
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:bob')).toBeNull();
  });

  it('workspace allows OAuth but the room did NOT opt in (oauth_allowed=0) → no override', () => {
    // The per-room gate: a disabled room that never enabled OAuth must not route a
    // connected member, even though the workspace accepts Claude subscriptions.
    setCredentialsConfig({ allowClaudeOauth: true }); // workspace-wide ON
    // room-1 has no oauth_allowed row → defaults to 0 (not opted in)
    upsertUserCredential('webchat:alice', 'claude', 'sec-oat', 'oauth_token');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toBeNull();
    // Opting the room in flips it on.
    setRoomOauthAllowed('room-1', true);
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
    setRoomOauthAllowed('room-1', true); // room opted in
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

describe('byok agent-identity resolver (spawn)', () => {
  it('per-member session of a connected member → the member BYOK identity', () => {
    upsertUserCredential('webchat:alice', 'claude', 'sec-1', 'api_key');
    expect(resolveAgentIdentity('ag-1', 'webchat:alice')).toBe(byokAgentIdentifier('ag-1', 'webchat:alice'));
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
