/**
 * Provider follows the assigned model's kind.
 *
 * Assigning an `openai-compatible` webchat model must switch the agent
 * group's container_configs.provider to 'opencode' (the harness that can
 * actually consume the endpoint); unassigning — or switching to an
 * anthropic/ollama-kind model — must revert it to the default (null →
 * claude). Guards the sync wiring end-to-end against the real central DB:
 * delete the syncAgentProviderForAssignedModel call (or its column write)
 * and this goes red.
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
    expect(providerForModelKind('openai-compatible')).toBe('opencode');
    expect(providerForModelKind('anthropic')).toBeNull();
    expect(providerForModelKind('ollama')).toBeNull();
    expect(providerForModelKind(null)).toBeNull();
    expect(providerForModelKind(undefined)).toBeNull();
  });
});

describe('syncAgentProviderForAssignedModel', () => {
  it('flips to opencode on openai-compatible assignment and reverts on unassign', () => {
    makeModel('openai-compatible', 'm-oc');
    assignModelToAgent('ag-1', 'm-oc');
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBe('opencode');

    unassignModelFromAgent('ag-1');
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBeNull();
  });

  it('reverts to default when switching to a non-opencode kind', () => {
    makeModel('openai-compatible', 'm-oc');
    assignModelToAgent('ag-1', 'm-oc');
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBe('opencode');

    makeModel('ollama', 'm-ol');
    assignModelToAgent('ag-1', 'm-ol'); // PK on agent_group_id — replaces
    syncAgentProviderForAssignedModel('ag-1');
    expect(getContainerConfig('ag-1')?.provider).toBeNull();
  });
});
