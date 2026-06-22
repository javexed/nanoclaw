/**
 * Phase 1: the session-key resolver. In a BYOK room a member WITH a key gets a
 * per-member session (keyed by userId); everyone else / every other room is
 * unchanged (null → shared session).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { resolveSessionKeyOverride } from '../../session-manager.js';
import { resolveAgentIdentity } from '../../container-runtime.js';
import { setRoomCredentialMode, setRoomOauthAllowed } from '../../channels/webchat/db.js';
import { upsertByokCredential, setByokStatus } from './db.js';
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
  it('member with a key in a BYOK room → per-member session keyed by userId', () => {
    setRoomCredentialMode('room-1', 'required');
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-1');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:alice',
    });
  });

  it('optional + no key → no override (falls back to the shared session)', () => {
    setRoomCredentialMode('room-1', 'optional');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:bob')).toBeNull();
  });

  it('required + no key → BLOCK with guidance (never bills the shared key)', () => {
    setRoomCredentialMode('room-1', 'required');
    const r = resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:bob');
    expect(r && 'block' in r).toBe(true);
    expect((r as { block: string }).block).toMatch(/your own Anthropic key/i);
  });

  it('disabled room (no API-key mode, no OAuth) → no override', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-1');
    expect(resolveSessionKeyOverride(webchatMg('room-x'), 'ag-1', 'webchat:alice')).toBeNull(); // room-x has no row → disabled
  });

  it('OAuth-only room (mode disabled, oauth_allowed) + member with OAuth key → per-member session', () => {
    // The load-bearing case: oauth_allowed must route even though credential_mode is 'disabled'.
    setRoomOauthAllowed('room-1', true); // credential_mode stays 'disabled'
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-oat', 'oauth_token');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:alice',
    });
    // A different member without a key in an OAuth-only room → shared (no block).
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:bob')).toBeNull();
  });

  it('revoked key → no override', () => {
    setRoomCredentialMode('room-1', 'optional');
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-1');
    setByokStatus('webchat:alice', 'ag-1', 'revoked');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', 'webchat:alice')).toBeNull();
  });

  it('non-webchat channel → no override', () => {
    setRoomCredentialMode('room-1', 'required');
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-1');
    const telegramMg = { id: 'mg-2', channel_type: 'telegram', platform_id: 'room-1', is_group: 1 };
    expect(resolveSessionKeyOverride(telegramMg, 'ag-1', 'webchat:alice')).toBeNull();
  });

  it('null userId → no override', () => {
    setRoomCredentialMode('room-1', 'required');
    expect(resolveSessionKeyOverride(webchatMg('room-1'), 'ag-1', null)).toBeNull();
  });
});

describe('byok agent-identity resolver (spawn)', () => {
  it('per-member session with a key → the member BYOK identity', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-1');
    expect(resolveAgentIdentity('ag-1', 'webchat:alice')).toBe(byokAgentIdentifier('ag-1', 'webchat:alice'));
  });
  it('no key / no thread → null (default agent-group identity)', () => {
    expect(resolveAgentIdentity('ag-1', 'webchat:bob')).toBeNull();
    expect(resolveAgentIdentity('ag-1', null)).toBeNull();
  });
  it('revoked key → null', () => {
    upsertByokCredential('webchat:alice', 'ag-1', 'byok-alice', 'sec-1');
    setByokStatus('webchat:alice', 'ag-1', 'revoked');
    expect(resolveAgentIdentity('ag-1', 'webchat:alice')).toBeNull();
  });
});
