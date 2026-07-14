import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getOnboardingComplete, setOnboardingComplete, getCredentialsConfig, setCredentialsConfig } from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

describe('onboarding_complete (first-run wizard state)', () => {
  it('adds the column and defaults to not-complete on a fresh install', () => {
    const cols = (getDb().prepare("PRAGMA table_info('webchat_settings')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('onboarding_complete');
    expect(getOnboardingComplete()).toBe(false);
  });

  it('persists the flag (finish / reset) even when the settings row does not exist yet', () => {
    setOnboardingComplete(true);
    expect(getOnboardingComplete()).toBe(true);
    setOnboardingComplete(false);
    expect(getOnboardingComplete()).toBe(false);
  });

  it('does not clobber the credentials policy on the same singleton row', () => {
    setCredentialsConfig({ defaultMode: 'optional', allowClaudeOauth: true });
    setOnboardingComplete(true);
    const cfg = getCredentialsConfig();
    expect(cfg.defaultMode).toBe('optional');
    expect(cfg.allowClaudeOauth).toBe(true);
    expect(getOnboardingComplete()).toBe(true);
  });
});
