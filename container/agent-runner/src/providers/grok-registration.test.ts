/**
 * Registration guard. The barrel import is one line and is exactly the kind of
 * thing a merge drops silently — the provider then vanishes at runtime with
 * "Unknown provider: grok" and nothing at build time says why.
 */
import { describe, it, expect } from 'bun:test';

import './index.js';
import { createProvider } from './factory.js';
import { listProviderNames } from './provider-registry.js';
import { GrokProvider } from './grok.js';

describe('grok registration', () => {
  it('the barrel registers grok', () => {
    expect(listProviderNames()).toContain('grok');
  });

  it('createProvider("grok") builds a GrokProvider', () => {
    expect(createProvider('grok')).toBeInstanceOf(GrokProvider);
  });

  it('registering does not disturb the default provider', () => {
    expect(listProviderNames()).toContain('claude');
  });
});
