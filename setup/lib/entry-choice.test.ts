import { describe, expect, it } from 'vitest';

import { entryOptions, entryPlan } from './entry-choice.js';
import { initialChannelOptions } from '../channels/initial-setup.js';

describe('entryOptions', () => {
  it('offers the web UI first, then upstream list verbatim', () => {
    const options = entryOptions();
    expect(options[0].value).toBe('web');
    // Guards the sync surface: if this fails, someone edited upstream's
    // initial-setup.ts to add a web entry instead of composing it here.
    expect(options.slice(1)).toEqual(initialChannelOptions());
  });

  it('phrases the web option in the same grammar as every channel label', () => {
    // The prompt is a yes/no-shaped question ("Want to chat … from your browser
    // or your phone?"), and upstream's labels all answer it with "Yes, …".
    const labels = entryOptions().map((o) => o.label);
    const answers = labels.filter((l) => l.startsWith('Yes, '));
    expect(answers).toContain('Yes, open the built-in web UI');
    expect(answers.length).toBeGreaterThan(1);
  });
});

describe('entryPlan', () => {
  it('web alone: the browser does model, access and the first agent', () => {
    expect(entryPlan('web', false)).toEqual({
      web: true,
      presetChannel: null,
      skips: ['cli-agent', 'first-chat', 'channel', 'auth'],
    });
  });

  it('web plus a channel: the channel step returns, and auth with it', () => {
    const plan = entryPlan('web', true);
    expect(plan.web).toBe(true);
    expect(plan.skips).not.toContain('channel');
    // The channel wire hands a /welcome to the agent, which needs a credential
    // to answer. Skipping auth here would connect a channel that never speaks.
    expect(plan.skips).not.toContain('auth');
    // Still no terminal ping-agent: the channel install creates its own.
    expect(plan.skips).toEqual(['cli-agent', 'first-chat']);
  });

  it('a messaging app answers the question — nothing is skipped, and the chooser is seeded', () => {
    expect(entryPlan('telegram', false)).toEqual({ web: false, presetChannel: 'telegram', skips: [] });
  });

  it('"skip for now" is an answer too, not an absence of one', () => {
    expect(entryPlan('skip', false)).toEqual({ web: false, presetChannel: 'skip', skips: [] });
  });

  it('the follow-up is ignored unless the web UI was chosen', () => {
    expect(entryPlan('slack', true)).toEqual(entryPlan('slack', false));
  });
});
