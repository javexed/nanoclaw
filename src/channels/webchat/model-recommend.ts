/**
 * Hardware profiler + local-model recommender for the setup wizard.
 *
 * The chicken-and-egg ("recommend a model before any model exists") dissolves
 * once you see model sizing as a LOOKUP, not a reasoning task: read the host's
 * hardware, match it against a curated manifest of known-good picks. No LLM in
 * the loop, works offline/headless on first boot.
 *
 * Load-bearing lesson from live testing (qwen3:4b thrashed a 14 GB box): size
 * by real HEADROOM, not totals. Two numbers that look right and aren't —
 *   - total RAM (the stack already eats most of it), and
 *   - iGPU "VRAM" (reported but unusable without ROCm/CUDA).
 * So we budget against available RAM minus a margin, and only trust VRAM on a
 * CONFIRMED-usable accelerator (nvidia-smi succeeds, or Apple-Silicon unified
 * memory). Everything else is treated as CPU-only.
 *
 * profileHardware() does the IO; recommendModel() is pure (fixture-testable).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';

export interface GpuInfo {
  vendor: 'nvidia' | 'apple' | 'amd' | 'other';
  /** Usable accelerator memory in GB. 0 when present-but-not-usable for LLMs. */
  vramGB: number;
  /** True only when we can actually offload to it (CUDA / Apple Metal). */
  usable: boolean;
}

export interface HardwareProfile {
  platform: NodeJS.Platform;
  cpuCores: number;
  cpuModel: string;
  hasAvx2: boolean;
  ramTotalGB: number;
  ramAvailGB: number;
  gpu: GpuInfo | null;
  diskFreeGB: number;
}

export interface ModelSpec {
  id: string;
  /** Runtime footprint (weights + KV cache + a working context), NOT file size. */
  footprintGB: number;
  tier: 'tiny' | 'small' | 'mid' | 'large';
  /** Rough single-stream CPU throughput on an AVX2 desktop core, for expectations. */
  cpuTokS: number;
  thinking: boolean;
  tools: boolean;
}

/**
 * Curated candidates — the Qwen3 line, the only widely-available family where
 * BOTH thinking and tool-calling scale from sub-1B up. Ordered small→large.
 * footprintGB is the observed runtime cost, deliberately conservative.
 */
export const MODEL_MANIFEST: ModelSpec[] = [
  { id: 'qwen3:0.6b', footprintGB: 1.5, tier: 'tiny', cpuTokS: 15, thinking: true, tools: true },
  { id: 'qwen3:1.7b', footprintGB: 2.5, tier: 'small', cpuTokS: 8, thinking: true, tools: true },
  { id: 'qwen3:4b', footprintGB: 4, tier: 'mid', cpuTokS: 4, thinking: true, tools: true },
  { id: 'qwen3:8b', footprintGB: 7, tier: 'large', cpuTokS: 2, thinking: true, tools: true },
];

// Headroom above the chosen model. CPU RAM is SHARED and contended — the model
// grows under context AND each agent turn spawns a container, and "available"
// is a snapshot that only shrinks under real use (the qwen3:4b-looked-fine-then-
// thrashed lesson). So the CPU margin is deliberately fat. Dedicated GPU VRAM
// isn't contended that way, so it gets a thin margin.
const CPU_HEADROOM_GB = 2.5;
const GPU_HEADROOM_GB = 1;

export interface Recommendation {
  /** The pick — always present; the smallest model when nothing fits cleanly. */
  model: ModelSpec;
  /** One-line rationale for the UI. */
  reason: string;
  /** true when even the smallest model is a squeeze (shown as a warning). */
  tight: boolean;
  /** How the budget was derived. */
  basis: 'gpu' | 'cpu';
  /** Other manifest entries with a per-option note (fits / faster / too big). */
  alternatives: Array<{ model: ModelSpec; note: string }>;
  /** Human-readable "Detected: …" line for transparency (no silent caps). */
  detected: string;
}

function gb(n: number): string {
  return `${n.toFixed(n < 10 ? 1 : 0)} GB`;
}

/** Pure: map a profile to a recommendation. Fixture-testable, no IO. */
export function recommendModel(profile: HardwareProfile, manifest: ModelSpec[] = MODEL_MANIFEST): Recommendation {
  const ordered = [...manifest].sort((a, b) => a.footprintGB - b.footprintGB);

  // Budget: usable GPU memory if we can actually offload, else available RAM.
  // GPU inference is far faster, so no CPU-speed caveat there.
  const onGpu = !!profile.gpu?.usable && profile.gpu.vramGB > 0;
  const budgetGB = onGpu ? profile.gpu!.vramGB : profile.ramAvailGB;
  const basis: 'gpu' | 'cpu' = onGpu ? 'gpu' : 'cpu';
  const margin = onGpu ? GPU_HEADROOM_GB : CPU_HEADROOM_GB;

  const fits = (m: ModelSpec) => m.footprintGB + margin <= budgetGB;

  // Largest model that fits the budget; fall back to the smallest if none do.
  const affordable = ordered.filter(fits);
  const pick = affordable.length ? affordable[affordable.length - 1] : ordered[0];
  const tight = affordable.length === 0;

  const speed = onGpu ? 'GPU-accelerated' : `~${pick.cpuTokS} tok/s on CPU`;
  const caps = [pick.thinking ? 'thinking' : null, pick.tools ? 'tool-calling' : null].filter(Boolean).join(' + ');
  const reason = tight
    ? `Low free memory (${gb(budgetGB)}) — ${pick.id} is the lightest option and may still be slow. Consider closing other apps or using a remote Ollama.`
    : `Fits your ${onGpu ? `${gb(profile.gpu!.vramGB)} of GPU memory` : `${gb(budgetGB)} of free memory`}, ${speed}, ${caps}.`;

  const alternatives = ordered
    .filter((m) => m.id !== pick.id)
    .map((m) => ({
      model: m,
      note: !fits(m)
        ? `too big for ${gb(budgetGB)} free`
        : m.footprintGB < pick.footprintGB
          ? `faster, less capable (~${m.cpuTokS} tok/s)`
          : 'more capable, more memory',
    }));

  const gpuStr = profile.gpu?.usable
    ? `, ${profile.gpu.vendor} GPU ${gb(profile.gpu.vramGB)}`
    : profile.gpu
      ? `, ${profile.gpu.vendor} GPU (not usable for inference)`
      : ', no usable GPU';
  const detected = `Detected: ${profile.cpuCores} cores${profile.hasAvx2 ? ' AVX2' : ''}, ${gb(
    profile.ramTotalGB,
  )} RAM (${gb(profile.ramAvailGB)} free)${gpuStr}.`;

  return { model: pick, reason, tight, basis, alternatives, detected };
}

// ── Hardware probes (IO) ───────────────────────────────────────────────────

function readMeminfoGB(): { total: number; avail: number } {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (key: string) => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
      return m ? Number(m[1]) : 0;
    };
    const total = kb('MemTotal') / 1024 / 1024;
    // MemAvailable = the kernel's own estimate of allocatable-without-swapping
    // (accounts for reclaimable cache) — exactly the right number.
    const avail = kb('MemAvailable') / 1024 / 1024;
    return { total, avail: avail || total };
  } catch {
    // Non-Linux: fall back to os.* (no reclaimable-cache nuance available).
    return { total: os.totalmem() / 1e9, avail: os.freemem() / 1e9 };
  }
}

function readCpu(): { cores: number; model: string; avx2: boolean } {
  const cpus = os.cpus();
  const cores = cpus.length || 1;
  const model = cpus[0]?.model?.trim() || os.arch();
  let avx2 = false;
  try {
    avx2 = /(^|\s)avx2(\s|$)/.test(fs.readFileSync('/proc/cpuinfo', 'utf8'));
  } catch {
    /* not Linux — leave false; only used as a hint */
  }
  return { cores, model, avx2 };
}

/**
 * GPU detection, deliberately conservative — a false "usable GPU" is worse
 * than missing one (it recommends a model the box can't load). We only mark
 * `usable` for CUDA (nvidia-smi answers) or Apple-Silicon unified memory.
 * AMD/iGPU report VRAM we can't reliably offload to → present but not usable.
 */
function detectGpu(platform: NodeJS.Platform): GpuInfo | null {
  // NVIDIA: nvidia-smi is the clean signal. Its success == a usable CUDA GPU.
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], {
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const mb = Number(out.split('\n')[0]?.trim());
    if (mb > 0) return { vendor: 'nvidia', vramGB: mb / 1024, usable: true };
  } catch {
    /* no NVIDIA driver / tool */
  }
  // Apple Silicon: unified memory, Metal-accelerated. Budget a share of RAM.
  if (platform === 'darwin' && os.arch() === 'arm64') {
    return { vendor: 'apple', vramGB: (os.totalmem() / 1e9) * 0.6, usable: true };
  }
  // AMD / Intel iGPU: report presence but not usability (no reliable ROCm path).
  try {
    const cards = fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n));
    for (const c of cards) {
      const p = `/sys/class/drm/${c}/device/mem_info_vram_total`;
      if (fs.existsSync(p)) {
        const bytes = Number(fs.readFileSync(p, 'utf8').trim());
        if (bytes > 0) return { vendor: 'amd', vramGB: bytes / 1e9, usable: false };
      }
    }
  } catch {
    /* no drm sysfs */
  }
  return null;
}

function diskFreeGB(): number {
  try {
    const st = fs.statfsSync(os.homedir());
    return (st.bavail * st.bsize) / 1e9;
  } catch {
    return 0;
  }
}

/** Read the host hardware into a profile. All probes are best-effort. */
export function profileHardware(): HardwareProfile {
  const platform = process.platform;
  const { total, avail } = readMeminfoGB();
  const cpu = readCpu();
  return {
    platform,
    cpuCores: cpu.cores,
    cpuModel: cpu.model,
    hasAvx2: cpu.avx2,
    ramTotalGB: total,
    ramAvailGB: avail,
    gpu: detectGpu(platform),
    diskFreeGB: diskFreeGB(),
  };
}

/** Convenience for the endpoint: profile + recommend in one call. */
export function recommendForHost(): { profile: HardwareProfile; recommendation: Recommendation } {
  const profile = profileHardware();
  return { profile, recommendation: recommendModel(profile) };
}
