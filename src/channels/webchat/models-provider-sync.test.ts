/**
 * Provider follows the assigned model's kind — which, post-OpenCode, is
 * always the default Claude provider (openai-compatible endpoints are
 * consumed through LiteLLM's Anthropic-spec /v1/messages surface).
 *
 * The sync's remaining job is REVERSION: a group some earlier install
 * flipped to 'opencode' must come back to null (default) on its next
 * (re)assignment. Guards that wiring end-to-end against the real central
 * DB: delete the syncAgentProviderForAssignedModel call (or its column
 * write) and this goes red.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { assignModelToAgent, createWebchatModel, unassignModelFromAgent, type WebchatModelKind } from './db.js';
import { providerForModelKind, syncAgentProviderForAssignedModel } from './models.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-provider-sync-'));
  initDb(path.join(tmpDir, 'test.db'));
  runMigrations(getDb());
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1','AG','ag-1',NULL,'t')`,
    )
    .run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeModel(kind: WebchatModelKind, id: string): void {
  createWebchatModel({
    id,
    name: id,
    kind,
    endpoint: kind === 'anthropic' ? null : 'http://host.docker.internal:4000/v1',
    model_id: 'gemma4:latest',
    credential_ref: null,
    created_at: Date.now(),
  });
}

describe('providerForModelKind', () => {
  it('maps openai-compatible to opencode and everything else to default', () => {
    // Post-OpenCode: every kind runs the default Claude provider (LiteLLM's
    // Anthropic-spec /v1/messages surface carries openai-compatible models).
    expect(providerForModelKind('openai-compatible')).toBeNull();
    expect(providerForModelKind('anthropic')).toBeNull();
    expect(providerForModelKind('ollama')).toBeNull();
    expect(providerForModelKind(null)).toBeNull();
    expect(providerForModelKind(undefined)).toBeNull();
  });
});

describe('syncAgentProviderForAssignedModel', () => {
  it('keeps the default provider on an openai-compatible assignment (direct path)', () => {
    makeModel('openai-compatible', 'm-oc');
    assignModelToAgent('ag-1', 'm-oc');
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBeNull();
  });

  it('reverts a group a pre-direct install left on opencode', () => {
    makeModel('openai-compatible', 'm-oc');
    assignModelToAgent('ag-1', 'm-oc');
    syncAgentProviderForAssignedModel('ag-1'); // ensures the config row exists
    // Simulate the legacy state: an older install wrote provider='opencode'.
    getDb().prepare(`UPDATE container_configs SET provider = 'opencode' WHERE agent_group_id = 'ag-1'`).run();
    expect(getContainerConfig('ag-1')?.provider).toBe('opencode');

    syncAgentProviderForAssignedModel('ag-1'); // any (re)assignment un-wedges it
    expect(getContainerConfig('ag-1')?.provider).toBeNull();

    unassignModelFromAgent('ag-1');
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBeNull();
  });
});
