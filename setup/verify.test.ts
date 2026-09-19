import { describe, expect, it } from 'vitest';

import { determineVerifyStatus } from './verify.js';

const healthyBase = {
  service: 'running' as const,
  credentials: 'configured',
  registeredGroups: 1,
};

describe('determineVerifyStatus', () => {
  it('accepts a healthy install with at least one wired agent group', () => {
    expect(determineVerifyStatus(healthyBase)).toBe('success');
  });

  it('passes with NO credential when the web wizard will sign in', () => {
    // setup/auto.ts skips the terminal auth step on the web path — the wizard's
    // first screen signs in. Failing here would exit(1) before the hand-off
    // that opens the browser, so the operator could never supply the
    // credential this check is demanding.
    expect(
      determineVerifyStatus({
        ...healthyBase,
        credentials: 'missing',
        registeredGroups: 0,
        webPending: true,
      }),
    ).toBe('success');
  });

  it('still fails on a missing credential when the web wizard is NOT pending', () => {
    // The allowance above is scoped to the pre-wizard window. A non-web install
    // (or a web install past its wizard) with no credential is still broken,
    // and saying so is the whole point of the check.
    expect(
      determineVerifyStatus({
        ...healthyBase,
        credentials: 'missing',
        registeredGroups: 2,
      }),
    ).toBe('failed');
  });

  it('passes with zero groups when the web wizard will create the first agent', () => {
    // The web path skips cli-agent/channel/first-chat in setup/auto.ts — the
    // browser wizard creates the first agent. Failing here strands the
    // operator before the hand-off that opens the browser.
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        webPending: true,
      }),
    ).toBe('success');
  });

  it('still fails with zero groups when the web UI is not enabled', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        webPending: false,
      }),
    ).toBe('failed');
  });

  it('fails when no agent groups are registered', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
      }),
    ).toBe('failed');
  });

  // Deferred wire (Teams): configured but zero groups is pending operator
  // action (first DM), not a broken install — success, not failed.
  it('accepts zero groups when wiring is pending a first DM', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        wiringPending: true,
      }),
    ).toBe('success');
  });

  it('pending wiring never rescues a stopped service or missing credentials', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        wiringPending: true,
        service: 'stopped',
      }),
    ).toBe('failed');
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        wiringPending: true,
        credentials: 'missing',
      }),
    ).toBe('failed');
  });

  it('fails when the service is not running', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        service: 'stopped',
      }),
    ).toBe('failed');
  });

  it('fails when credentials are missing', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        credentials: 'missing',
      }),
    ).toBe('failed');
  });
});
