import { describe, it, expect } from 'vitest';

import { userSlug, byokAgentIdentifier, isByokAgentIdentifier } from './identity.js';

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

describe('byokAgentIdentifier', () => {
  it('is a valid OneCLI identifier', () => {
    expect(byokAgentIdentifier('ag-123', 'webchat:tailscale:alice@x.com')).toMatch(VALID_ONECLI_ID);
  });
  it('is deterministic and idempotent', () => {
    const a = byokAgentIdentifier('ag-123', 'webchat:alice');
    expect(byokAgentIdentifier('ag-123', 'webchat:alice')).toBe(a);
  });
  it('differs by user and by group (collision resistance)', () => {
    const a = byokAgentIdentifier('ag-1', 'webchat:alice');
    const b = byokAgentIdentifier('ag-1', 'webchat:bob');
    const c = byokAgentIdentifier('ag-2', 'webchat:alice');
    expect(new Set([a, b, c]).size).toBe(3);
  });
  it('distinguishes users whose slugs collide (hash suffix)', () => {
    // Two raw ids that slug to the same prefix still get distinct identifiers.
    const a = byokAgentIdentifier('ag-1', 'webchat:alice@a.com');
    const b = byokAgentIdentifier('ag-1', 'webchat:alice@b.com');
    expect(a).not.toBe(b);
  });
  it('is recognized by isByokAgentIdentifier', () => {
    expect(isByokAgentIdentifier(byokAgentIdentifier('ag-1', 'u'))).toBe(true);
    expect(isByokAgentIdentifier('ag-1778-xyz')).toBe(false);
    expect(isByokAgentIdentifier(null)).toBe(false);
  });
});
