/**
 * Recommender logic — pure, driven by fixture profiles (no hardware needed).
 */
import { describe, it, expect } from 'vitest';

import { recommendModel, type HardwareProfile } from './model-recommend.js';

function profile(over: Partial<HardwareProfile>): HardwareProfile {
  return {
    platform: 'linux',
    cpuCores: 8,
    cpuModel: 'Test CPU',
    hasAvx2: true,
    ramTotalGB: 16,
    ramAvailGB: 12,
    gpu: null,
    diskFreeGB: 100,
    ...over,
  };
}

describe('recommendModel', () => {
  it('sizes by AVAILABLE ram, not total (the thrash lesson)', () => {
    // 14 GB box with only 2.3 GB free (stack running) → tiny, not mid.
    const r = recommendModel(profile({ ramTotalGB: 14, ramAvailGB: 2.3 }));
    expect(r.model.id).toBe('qwen3:0.6b');
    expect(r.basis).toBe('cpu');
    expect(r.detected).toContain('2.3 GB free');
  });

  it('picks the largest model that fits a roomy CPU box', () => {
    const r = recommendModel(profile({ ramTotalGB: 32, ramAvailGB: 24 }));
    expect(r.model.id).toBe('qwen3:8b'); // 7 + 2.5 cpu margin <= 24
    expect(r.tight).toBe(false);
  });

  it('steps down as headroom shrinks (fat CPU margin)', () => {
    expect(recommendModel(profile({ ramAvailGB: 9.5 })).model.id).toBe('qwen3:8b'); // 7+2.5<=9.5
    expect(recommendModel(profile({ ramAvailGB: 6.5 })).model.id).toBe('qwen3:4b'); // 4+2.5<=6.5
    expect(recommendModel(profile({ ramAvailGB: 5.0 })).model.id).toBe('qwen3:1.7b'); // 2.5+2.5<=5
    expect(recommendModel(profile({ ramAvailGB: 4.0 })).model.id).toBe('qwen3:0.6b'); // 1.5+2.5<=4
  });

  it('flags tight when even the smallest model does not fit', () => {
    const r = recommendModel(profile({ ramTotalGB: 4, ramAvailGB: 1.2 }));
    expect(r.model.id).toBe('qwen3:0.6b'); // always a pick
    expect(r.tight).toBe(true);
    expect(r.reason).toMatch(/low free memory/i);
  });

  it('budgets on GPU VRAM when a usable accelerator is present', () => {
    const r = recommendModel(
      profile({
        ramAvailGB: 3, // small RAM…
        gpu: { vendor: 'nvidia', vramGB: 10, usable: true }, // …but a real GPU
      }),
    );
    expect(r.basis).toBe('gpu');
    expect(r.model.id).toBe('qwen3:8b'); // 7+1 <= 10
    expect(r.reason).toContain('GPU memory');
  });

  it('IGNORES a present-but-unusable iGPU and falls back to CPU/RAM', () => {
    const r = recommendModel(
      profile({
        ramTotalGB: 14,
        ramAvailGB: 2.3,
        gpu: { vendor: 'amd', vramGB: 1, usable: false }, // the fake-1GB iGPU case
      }),
    );
    expect(r.basis).toBe('cpu'); // not tricked into GPU sizing
    expect(r.model.id).toBe('qwen3:0.6b');
    expect(r.detected).toContain('not usable');
  });

  it('always returns thinking + tool-capable picks with alternatives', () => {
    const r = recommendModel(profile({ ramAvailGB: 6 }));
    expect(r.model.thinking && r.model.tools).toBe(true);
    expect(r.alternatives.length).toBe(3);
    // Smaller options read as faster; bigger ones as too big / more capable.
    const tiny = r.alternatives.find((a) => a.model.id === 'qwen3:0.6b');
    expect(tiny?.note).toMatch(/faster/);
  });
});
