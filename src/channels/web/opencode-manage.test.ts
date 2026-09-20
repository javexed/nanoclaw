import { describe, expect, it } from 'vitest';

import { opencodeInstallability, opencodeInstallSteps, OPENCODE_SKILL_DIR } from './opencode-manage.js';

describe('opencodeInstallability', () => {
  it('already installed is the finished state, not an error to report', () => {
    // canInstall is false because there is nothing left to install. A reason
    // here would put a failure message on a card that is working.
    expect(
      opencodeInstallability({ installed: true, skillPresent: true, dockerAvailable: true, pnpmFound: true }),
    ).toEqual({
      canInstall: false,
      reason: null,
    });
  });

  it('installs when the skill is present and docker answers', () => {
    expect(
      opencodeInstallability({ installed: false, skillPresent: true, dockerAvailable: true, pnpmFound: true }),
    ).toEqual({
      canInstall: true,
      reason: null,
    });
  });

  it('names the missing skill rather than failing mid-chain', () => {
    const r = opencodeInstallability({ installed: false, skillPresent: false, dockerAvailable: true, pnpmFound: true });
    expect(r.canInstall).toBe(false);
    expect(r.reason).toContain(OPENCODE_SKILL_DIR);
  });

  it('refuses without docker — the agent image is what carries the harness', () => {
    const r = opencodeInstallability({ installed: false, skillPresent: true, dockerAvailable: false, pnpmFound: true });
    expect(r.canInstall).toBe(false);
    expect(r.reason).toMatch(/Docker/);
  });

  it('refuses when pnpm cannot be found — before anything is applied', () => {
    // Three of the five steps shell out to pnpm and the skill apply is the
    // first. Discovering it mid-chain would leave a half-applied provider.
    const r = opencodeInstallability({ installed: false, skillPresent: true, dockerAvailable: true, pnpmFound: false });
    expect(r.canInstall).toBe(false);
    expect(r.reason).toMatch(/pnpm/);
  });
});

describe('opencodeInstallSteps', () => {
  const labels = (root: string): string[] => opencodeInstallSteps(root).map((s) => s.label ?? '(unlabelled)');

  it('gives every step a human label — the UI shows "3 of 5: <label>"', () => {
    expect(opencodeInstallSteps('/srv/nanoclaw').every((st) => Boolean(st.label))).toBe(true);
  });

  it('applies, rebuilds both halves, stamps, then restarts — in that order', () => {
    expect(labels('/srv/nanoclaw')).toEqual([
      'Applying the OpenCode skill',
      'Rebuilding NanoClaw',
      'Rebuilding the agent image',
      'Stamping the upgrade marker',
      'Restarting',
    ]);
  });

  it('stamps the upgrade marker BEFORE restarting', () => {
    // Applying a skill dirties the tree, and enforceUpgradeTripwire refuses to
    // start a host whose code identity does not match the marker. Restarting
    // first is a crash loop the operator cannot diagnose from the wizard.
    const l = labels('/srv/nanoclaw');
    expect(l.indexOf('Stamping the upgrade marker')).toBeLessThan(l.indexOf('Restarting'));
  });

  it('rebuilds the host before the image, and both before the restart', () => {
    // The host runs from dist/; the skill edited src/. Restarting without the
    // build brings back the process that has never seen the new provider.
    const l = labels('/srv/nanoclaw');
    expect(l.indexOf('Rebuilding NanoClaw')).toBeLessThan(l.indexOf('Rebuilding the agent image'));
    expect(l.indexOf('Rebuilding the agent image')).toBeLessThan(l.indexOf('Restarting'));
  });
});
