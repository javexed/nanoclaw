import { describe, expect, it } from 'vitest';

import { webSkips } from './web-plan.js';

describe('webSkips', () => {
  it('web alone: the browser does model, access and the first agent', () => {
    expect(webSkips(false)).toEqual(['cli-agent', 'first-chat', 'channel', 'auth']);
  });

  it('web plus a messaging app: the channel step returns, and auth with it', () => {
    const skips = webSkips(true);
    // Upstream's chooser runs in upstream's place, untouched.
    expect(skips).not.toContain('channel');
    // The channel wire hands a /welcome to the agent, which needs a credential
    // to answer. Skipping auth here would connect a channel that never speaks.
    expect(skips).not.toContain('auth');
    // Still no terminal ping-agent: the channel install creates its own.
    expect(skips).toEqual(['cli-agent', 'first-chat']);
  });
});
