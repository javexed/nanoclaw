import { afterEach, describe, expect, it } from 'vitest';

import { maxOutputTokensFor } from './container-runner.js';

const ENV = 'NANOCLAW_MAX_OUTPUT_TOKENS';

afterEach(() => {
  delete process.env[ENV];
});

describe('maxOutputTokensFor', () => {
  it('gives current models their real ceiling', () => {
    expect(maxOutputTokensFor('claude-opus-5')).toBe(128_000);
    expect(maxOutputTokensFor('claude-sonnet-5')).toBe(128_000);
    expect(maxOutputTokensFor('claude-fable-5')).toBe(128_000);
    expect(maxOutputTokensFor('claude-haiku-4-5-20251001')).toBe(64_000);
  });

  // The whole point of version-anchored matching. A substring match on "opus"
  // hands Claude 3 Opus 128000 against a real ceiling of 4096 — a 400, i.e. the
  // killed turn this code exists to prevent.
  it('does NOT claim a ceiling for older models that merely share a family name', () => {
    expect(maxOutputTokensFor('claude-3-opus-20240229')).toBeNull();
    expect(maxOutputTokensFor('claude-opus-4-1')).toBeNull();
    expect(maxOutputTokensFor('claude-sonnet-4-5')).toBeNull();
    expect(maxOutputTokensFor('claude-2.1')).toBeNull();
  });

  it('returns null for non-Claude and unknown strings so the var stays unset', () => {
    expect(maxOutputTokensFor('llama3.2')).toBeNull();
    expect(maxOutputTokensFor('qwen3.5')).toBeNull();
    expect(maxOutputTokensFor('something-invented')).toBeNull();
  });

  it('treats an unconfigured model as the provider default (Opus-class)', () => {
    expect(maxOutputTokensFor(null)).toBe(128_000);
    expect(maxOutputTokensFor(undefined)).toBe(128_000);
    expect(maxOutputTokensFor('   ')).toBe(128_000);
  });

  it('lets the env override win over everything, including unknown models', () => {
    process.env[ENV] = '250000';
    expect(maxOutputTokensFor('claude-haiku-4-5')).toBe(250_000);
    expect(maxOutputTokensFor('something-invented')).toBe(250_000);
  });

  it('ignores a junk or non-positive override', () => {
    for (const bad of ['nonsense', '0', '-5', '']) {
      process.env[ENV] = bad;
      expect(maxOutputTokensFor('claude-opus-5')).toBe(128_000);
    }
  });
});
