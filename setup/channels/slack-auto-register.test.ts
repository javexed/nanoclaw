/**
 * The NANOCLAW_SLACK_AGENTS opt-in gate.
 *
 * Flag off (the default) must leave the wizard exactly as shipped: no
 * pre-step registered for slack, no companion skills declared, and the
 * provisioning flow never evaluated. Flag on registers the pre-step (which
 * lazy-loads the flow only when the wizard actually invokes it) and declares
 * the Slack agents companion skills, in prerequisite order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSlackAutoProvision, SLACK_AGENTS_COMPANION_SKILLS } from './slack-auto-register.js';

afterEach(() => {
  delete process.env.NANOCLAW_SLACK_AGENTS;
  vi.doUnmock('./slack-auto.js');
  vi.resetModules();
});

describe('registerSlackAutoProvision', () => {
  it('flag unset: registers nothing', () => {
    const register = vi.fn();
    const registerCompanions = vi.fn();
    registerSlackAutoProvision(register, registerCompanions, {});
    expect(register).not.toHaveBeenCalled();
    expect(registerCompanions).not.toHaveBeenCalled();
  });

  it('only "1" enables — other values register nothing', () => {
    const register = vi.fn();
    const registerCompanions = vi.fn();
    for (const value of ['', '0', 'false', 'yes', 'true']) {
      registerSlackAutoProvision(register, registerCompanions, { NANOCLAW_SLACK_AGENTS: value });
    }
    expect(register).not.toHaveBeenCalled();
    expect(registerCompanions).not.toHaveBeenCalled();
  });

  it('flag "1": registers a slack pre-step that lazy-loads and delegates to the flow', async () => {
    const register = vi.fn();
    registerSlackAutoProvision(register, vi.fn(), { NANOCLAW_SLACK_AGENTS: '1' });

    expect(register).toHaveBeenCalledTimes(1);
    const [channel, step] = register.mock.calls[0];
    expect(channel).toBe('slack');

    // The flow module is only reached through the pre-step's dynamic import.
    const maybeAutoProvisionSlack = vi.fn(async (name: string) => ({ bot_token: `xoxb-for-${name}` }));
    vi.doMock('./slack-auto.js', () => ({ maybeAutoProvisionSlack }));
    await expect(step('Nano')).resolves.toEqual({ bot_token: 'xoxb-for-Nano' });
    expect(maybeAutoProvisionSlack).toHaveBeenCalledExactlyOnceWith('Nano');
  });

  it('flag "1": declares the agents companion skills in prerequisite order', () => {
    const registerCompanions = vi.fn();
    registerSlackAutoProvision(vi.fn(), registerCompanions, { NANOCLAW_SLACK_AGENTS: '1' });

    expect(registerCompanions).toHaveBeenCalledExactlyOnceWith('slack', SLACK_AGENTS_COMPANION_SKILLS);
    // The room admission policy is the flow's prerequisite — order is the API.
    expect(SLACK_AGENTS_COMPANION_SKILLS).toEqual(['slack-a2a-rooms', 'slack-agent-flow']);
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

  it('flag "1": a fresh companions module carries the slack pre-step and companion list', async () => {
    process.env.NANOCLAW_SLACK_AGENTS = '1';
    vi.resetModules();
    const companions = await import('./companions.js');
    expect(companions.getChannelPreStep('slack')).toBeTypeOf('function');
    // Declared at wizard boot — a registration appended to the registry file
    // mid-run would be invisible to the already-imported module, so the whole
    // agents install rides on this boot-time declaration.
    expect(companions.getCompanionSkills('slack')).toEqual(['slack-a2a-rooms', 'slack-agent-flow']);
  });
});
