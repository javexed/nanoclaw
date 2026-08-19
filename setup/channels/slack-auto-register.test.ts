/**
 * The NANOCLAW_SLACK_AGENTS opt-in gate.
 *
 * Flag off (the default) must leave the wizard exactly as shipped: no
 * pre-step registered for slack, no companion skills declared, and the
 * provisioning flow never evaluated. Flag on registers the pre-step, which
 * lazy-loads the flow only when the wizard actually invokes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSlackAutoProvision } from './slack-auto-register.js';

afterEach(() => {
  delete process.env.NANOCLAW_SLACK_AGENTS;
  vi.doUnmock('./slack-auto.js');
  vi.resetModules();
});

describe('registerSlackAutoProvision', () => {
  it('flag unset: registers nothing', () => {
    const register = vi.fn();
    registerSlackAutoProvision(register, {});
    expect(register).not.toHaveBeenCalled();
  });

  it('only "1" enables — other values register nothing', () => {
    const register = vi.fn();
    for (const value of ['', '0', 'false', 'yes', 'true']) {
      registerSlackAutoProvision(register, { NANOCLAW_SLACK_AGENTS: value });
    }
    expect(register).not.toHaveBeenCalled();
  });

  it('flag "1": registers a slack pre-step that lazy-loads and delegates to the flow', async () => {
    const register = vi.fn();
    registerSlackAutoProvision(register, { NANOCLAW_SLACK_AGENTS: '1' });

    expect(register).toHaveBeenCalledTimes(1);
    const [channel, step] = register.mock.calls[0];
    expect(channel).toBe('slack');

    // The flow module is only reached through the pre-step's dynamic import.
    const maybeAutoProvisionSlack = vi.fn(async (name: string) => ({ bot_token: `xoxb-for-${name}` }));
    vi.doMock('./slack-auto.js', () => ({ maybeAutoProvisionSlack }));
    await expect(step('Nano')).resolves.toEqual({ bot_token: 'xoxb-for-Nano' });
    expect(maybeAutoProvisionSlack).toHaveBeenCalledExactlyOnceWith('Nano');
  });
});

describe('companions registry wiring', () => {
  it('flag unset: a fresh companions module has no slack hooks at all', async () => {
    delete process.env.NANOCLAW_SLACK_AGENTS;
    vi.resetModules();
    const companions = await import('./companions.js');
    expect(companions.getChannelPreStep('slack')).toBeUndefined();
    expect(companions.getCompanionSkills('slack')).toEqual([]);
  });

  it('flag "1": a fresh companions module carries the slack pre-step', async () => {
    process.env.NANOCLAW_SLACK_AGENTS = '1';
    vi.resetModules();
    const companions = await import('./companions.js');
    expect(companions.getChannelPreStep('slack')).toBeTypeOf('function');
    // Companion skills stay undeclared either way — the add-slack skill
    // payload owns those; an absent declaration just means none run.
    expect(companions.getCompanionSkills('slack')).toEqual([]);
  });
});
