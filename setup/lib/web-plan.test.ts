import { describe, expect, it } from 'vitest';

import { chooserOptions } from './web-plan.js';
import { initialChannelOptions } from '../channels/initial-setup.js';

describe('chooserOptions', () => {
  it('offers the web UI first, then upstream list verbatim', () => {
    const options = chooserOptions(initialChannelOptions(), false);
    expect(options[0].value).toBe('web');
    // Guards the sync surface: if this fails, someone edited upstream's
    // initial-setup.ts to add a web entry instead of composing it here.
    expect(options.slice(1)).toEqual(initialChannelOptions());
  });

  it('drops the web UI once it is on, so the loop-back offers only what is left', () => {
    expect(chooserOptions(initialChannelOptions(), true)).toEqual(initialChannelOptions());
  });

  it('phrases the web option in the same grammar as every channel label', () => {
    // The chooser is a yes/no-shaped question and upstream's labels all answer
    // it with "Yes, …". A web entry that broke that would read as a heading.
    const labels = chooserOptions(initialChannelOptions(), false).map((o) => o.label);
    expect(labels[0]).toMatch(/^Yes, /);
    expect(labels.filter((l) => l.startsWith('Yes, ')).length).toBeGreaterThan(1);
  });
});
