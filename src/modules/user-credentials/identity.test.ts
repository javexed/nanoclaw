import { describe, it, expect } from 'vitest';

import { userSlug, userCredsAgentIdentifier, isUserCredsAgentIdentifier } from './identity.js';

const VALID_ONECLI_ID = /^[a-z0-9-]+$/;

describe('userSlug', () => {
  it('produces a valid lowercase [a-z0-9-] slug', () => {
    const s = userSlug('webchat:tailscale:Alice@Example.com');
    expect(s).toMatch(VALID_ONECLI_ID);
    expect(s).not.toMatch(/[:@.]/);
  });
  it('is deterministic', () => {
    expect(userSlug('webchat:bob')).toBe(userSlug('webchat:bob'));
  });
  it('never returns empty', () => {
    expect(userSlug('::@@')).toBe('user');
    expect(userSlug('')).toBe('user');
  });
  it('has no leading/trailing hyphen and is bounded', () => {
    const s = userSlug('@@@a-very-long-handle-that-keeps-going-and-going@@@');
    expect(s).not.toMatch(/^-|-$/);
    expect(s.length).toBeLessThanOrEqual(24);
  });
});

describe('userCredsAgentIdentifier', () => {
  it('is a valid OneCLI identifier', () => {
    expect(userCredsAgentIdentifier('ag-123', 'webchat:tailscale:alice@x.com')).toMatch(VALID_ONECLI_ID);
  });
  it('is deterministic and idempotent', () => {
    const a = userCredsAgentIdentifier('ag-123', 'webchat:alice');
    expect(userCredsAgentIdentifier('ag-123', 'webchat:alice')).toBe(a);
  });
  it('differs by user and by group (collision resistance)', () => {
    const a = userCredsAgentIdentifier('ag-1', 'webchat:alice');
    const b = userCredsAgentIdentifier('ag-1', 'webchat:bob');
    const c = userCredsAgentIdentifier('ag-2', 'webchat:alice');
    expect(new Set([a, b, c]).size).toBe(3);
  });
  it('distinguishes users whose slugs collide (hash suffix)', () => {
    // Two raw ids that slug to the same prefix still get distinct identifiers.
    const a = userCredsAgentIdentifier('ag-1', 'webchat:alice@a.com');
    const b = userCredsAgentIdentifier('ag-1', 'webchat:alice@b.com');
    expect(a).not.toBe(b);
  });
  it('is recognized by isUserCredsAgentIdentifier', () => {
    expect(isUserCredsAgentIdentifier(userCredsAgentIdentifier('ag-1', 'u'))).toBe(true);
    expect(isUserCredsAgentIdentifier('ag-1778-xyz')).toBe(false);
    expect(isUserCredsAgentIdentifier(null)).toBe(false);
  });
});
