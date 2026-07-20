/**
 * Workspace master switch for the learning loop (Settings → Features →
 * Auto-learn). Default on; owner flips it; materializeContainerJson forces
 * autoTrigger/autoKeep off for every agent when it's off.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getLearningMasterEnabled, setLearningMasterEnabled } from './master.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

describe('learning master switch', () => {
  it('defaults to enabled', () => {
    expect(getLearningMasterEnabled()).toBe(true);
  });

  it('set/get roundtrips both ways', () => {
    setLearningMasterEnabled(false);
    expect(getLearningMasterEnabled()).toBe(false);
    setLearningMasterEnabled(true);
    expect(getLearningMasterEnabled()).toBe(true);
  });
});
