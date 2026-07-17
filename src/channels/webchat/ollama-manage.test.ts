import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./models.js', () => ({
  safeFetch: vi.fn(),
}));

import { safeFetch } from './models.js';
import {
  _resetPullsForTest,
  getPullsSnapshot,
  getCodexInstallProgress,
  providerRestartCommand,
  getLitellmInstallState,
  getRosterRefreshState,
  listHostModels,
  parseConfiguredHosts,
  removeRouteFromConfig,
  startCodexInstall,
  codexInstallSteps,
  startLitellmInstall,
  startPull,
  getTailscaleInstallState,
  startTailscaleInstall,
} from './ollama-manage.js';

const mockFetch = vi.mocked(safeFetch);

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function ndjsonStream(lines: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l + '\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  _resetPullsForTest();
});

describe('listHostModels', () => {
  it('merges /api/tags with /api/ps loaded state', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonRes({
          models: [
            { name: 'gemma4:latest', size: 9_600_000_000 },
            { name: 'qwen3.5:4b', size: 3_400_000_000 },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonRes({ models: [{ name: 'gemma4:latest', size_vram: 2_500_000_000 }] }));
    const models = await listHostModels('http://192.168.1.90:11434/');
    expect(models).toHaveLength(2);
    const gemma = models.find((m) => m.name === 'gemma4:latest')!;
    expect(gemma.loaded).toBe(true);
    expect(gemma.size_vram).toBe(2_500_000_000);
    expect(models.find((m) => m.name === 'qwen3.5:4b')!.loaded).toBe(false);
    // trailing slash stripped before path append
    expect(mockFetch.mock.calls[0][0]).toBe('http://192.168.1.90:11434/api/tags');
  });

  it('tolerates a host without /api/ps', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ models: [{ name: 'a', size: 1 }] }))
      .mockRejectedValueOnce(new Error('404'));
    const models = await listHostModels('http://h:11434');
    expect(models[0].loaded).toBe(false);
  });
});

describe('startPull', () => {
  it('tracks progress from the NDJSON stream and finishes on success', async () => {
    mockFetch.mockResolvedValueOnce(
      ndjsonStream([
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ status: 'pulling 4f0…', completed: 50, total: 100 }),
        JSON.stringify({ status: 'pulling 4f0…', completed: 100, total: 100 }),
        JSON.stringify({ status: 'success' }),
      ]),
    );
    const job = await startPull('http://h:11434', 'ornith');
    await vi.waitFor(() => expect(job.status).toBe('success'));
    expect(job.total).toBe(100);
    expect(job.completed).toBe(100);
    expect(job.finishedAt).not.toBeNull();
  });

  it('marks the job failed on an Ollama error line', async () => {
    mockFetch.mockResolvedValueOnce(
      ndjsonStream([JSON.stringify({ error: 'pull model manifest: file does not exist' })]),
    );
    const job = await startPull('http://h:11434', 'no-such-model');
    await vi.waitFor(() => expect(job.status).toBe('error'));
    expect(job.error).toMatch(/does not exist/);
  });

  it('fails when the stream ends without a success status (dropped connection)', async () => {
    mockFetch.mockResolvedValueOnce(
      ndjsonStream([JSON.stringify({ status: 'pulling 4f0…', completed: 1, total: 100 })]),
    );
    const job = await startPull('http://h:11434', 'ornith');
    await vi.waitFor(() => expect(job.status).toBe('error'));
    expect(job.error).toMatch(/ended early/);
  });

  it('dedupes a second click while the same pull is running', async () => {
    // A stream that never closes keeps the first job in 'pulling'.
    const hanging = new ReadableStream<Uint8Array>({ start() {} });
    mockFetch.mockResolvedValue({ ok: true, status: 200, body: hanging } as unknown as Response);
    const a = await startPull('http://h:11434', 'ornith');
    const b = await startPull('http://h:11434', 'ornith');
    expect(b).toBe(a);
    expect(getPullsSnapshot()).toHaveLength(1);
  });

  it('propagates an SSRF-gate rejection synchronously', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Blocked hostname: metadata.google.internal'));
    await expect(startPull('http://metadata.google.internal', 'x')).rejects.toThrow(/Blocked hostname/);
    expect(getPullsSnapshot()[0].status).toBe('error');
  });
});

describe('parseConfiguredHosts', () => {
  it('reads the gen-config header comment', () => {
    expect(parseConfiguredHosts('# Generated…\n# hosts: http://a:11434, http://b:11434\nmodel_list:\n')).toBe(
      'http://a:11434,http://b:11434',
    );
  });
  it('returns null when absent', () => {
    expect(parseConfiguredHosts('model_list: []\n')).toBeNull();
  });
});

describe('getRosterRefreshState', () => {
  it('reports unavailable when the litellm skill is not installed', () => {
    expect(getRosterRefreshState('/nonexistent-root').available).toBe(false);
  });
});

describe('LiteLLM install (routing prerequisite)', () => {
  it('getLitellmInstallState: no installer + no config under a bogus root', () => {
    const st = getLitellmInstallState('/nonexistent-root');
    expect(st.installerPresent).toBe(false);
    expect(st.installed).toBe(false);
    expect(st.running).toBe(false);
  });

  it('getLitellmInstallState: installer present, no config → gated; config present → installed', () => {
    // Hermetic root — never depends on whether LiteLLM happens to be installed
    // on the dev machine (data/litellm/config.yaml is runtime state).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-state-'));
    try {
      const resources = path.join(root, '.claude/skills/add-litellm/resources');
      fs.mkdirSync(resources, { recursive: true });
      fs.writeFileSync(path.join(resources, 'install-litellm.sh'), '#!/usr/bin/env bash\n');

      // Installer present, no config yet — the exact state that gates the UI button.
      let st = getLitellmInstallState(root);
      expect(st.installerPresent).toBe(true);
      expect(st.installed).toBe(false);

      // A written config flips it to installed.
      fs.mkdirSync(path.join(root, 'data/litellm'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data/litellm/config.yaml'), 'model_list: []\n');
      st = getLitellmInstallState(root);
      expect(st.installed).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('startLitellmInstall: refuses (no spawn) when the skill is absent', () => {
    expect(startLitellmInstall('/nonexistent-root')).toEqual({
      started: false,
      error: 'installer-missing',
    });
  });
});

describe('Codex provider install', () => {
  it('getCodexInstallProgress reports an idle state before any install', () => {
    const st = getCodexInstallProgress();
    expect(st.running).toBe(false);
    expect(Array.isArray(st.lines)).toBe(true);
  });

  it('codexInstallSteps omits the container typecheck on a gitless/deployed host (no bun-types)', () => {
    // Regression guard: #247 added this skip and a branch rebuild silently dropped
    // it, so Codex install died with "Cannot find type definition file for 'bun'".
    // A deployed tarball has no container/agent-runner/node_modules/bun-types.
    const cmds = codexInstallSteps('/nonexistent-root')
      .filter((s): s is { run: [string, string[]] } => 'run' in s)
      .map((s) => s.run[1].join(' '));
    expect(cmds.some((c) => c.includes('container/agent-runner/tsconfig.json'))).toBe(false);
    // …but the real work is still there.
    expect(cmds.some((c) => c.includes('provider-install codex'))).toBe(true);
    expect(cmds.some((c) => c.includes('container/build.sh'))).toBe(true);
  });

  it('codexInstallSteps includes the container typecheck on a dev checkout (bun-types present)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-steps-'));
    try {
      fs.mkdirSync(path.join(root, 'container/agent-runner/node_modules/bun-types'), { recursive: true });
      const cmds = codexInstallSteps(root)
        .filter((s): s is { run: [string, string[]] } => 'run' in s)
        .map((s) => s.run[1].join(' '));
      expect(cmds.some((c) => c.includes('container/agent-runner/tsconfig.json'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('startCodexInstall: refuses (no spawn / no build) when the add-codex skill is absent', () => {
    // A bogus root has no .claude/skills/add-codex/SKILL.md — so it must bail
    // out BEFORE spawning the source-mutating, image-rebuilding chain.
    expect(startCodexInstall('/nonexistent-root')).toEqual({
      started: false,
      error: 'skill-missing',
    });
  });

  it('tailscale install: state reports tun/root/canInstall; install gated on canInstall', () => {
    const st = getTailscaleInstallState();
    expect(typeof st.tunPresent).toBe('boolean');
    expect(typeof st.isRoot).toBe('boolean');
    expect(st.canInstall).toBe(st.tunPresent && st.isRoot); // both prereqs, or no install offer
    // The test runner isn't root, so the guard must refuse before spawning the
    // curl|sh installer + `tailscale up` (the one path that mutates the host).
    if (!st.canInstall) {
      expect(startTailscaleInstall()).toEqual({ started: false, error: 'prereq-missing' });
    }
  });

  it('providerRestartCommand picks the right restarter per context', () => {
    const base = { unit: 'nanoclaw-v2-abc', label: 'com.nanoclaw-v2-abc' };
    // macOS → launchd kickstart.
    expect(providerRestartCommand({ ...base, platform: 'darwin', hasUserSession: true })).toBe(
      'launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-abc',
    );
    // Linux rootless dev host (a user session exists) → --user, with a system fallback.
    expect(providerRestartCommand({ ...base, platform: 'linux', hasUserSession: true })).toBe(
      'systemctl --user restart nanoclaw-v2-abc 2>/dev/null || systemctl restart nanoclaw-v2-abc',
    );
    // Linux system service / LXC (no user session) → plain system restart.
    expect(providerRestartCommand({ ...base, platform: 'linux', hasUserSession: false })).toBe(
      'systemctl restart nanoclaw-v2-abc',
    );
  });
});

describe('computeRouterMetrics', () => {
  const NOW = 1_783_200_000_000;
  const line = (o: object) => JSON.stringify(o);
  it('counts per served model, splits live/shadow, excludes escalations from model counts', async () => {
    const { computeRouterMetrics } = await import('./ollama-manage.js');
    const text = [
      line({ ts: NOW, mode: 'live', route: 'code', final_model: 'ornith:latest' }),
      line({ ts: NOW, mode: 'live', route: 'escalate', final_model: '__escalate__' }),
      line({ ts: NOW, mode: 'shadow', route: 'general', requested_model: 'gemma4:latest' }),
      line({ ts: NOW, route: 'general', requested_model: 'gemma4:latest' }), // legacy, no mode
      line({ ts: NOW, mode: 'live', route: '__error__', final_model: 'gemma4:latest', error: 'ReadTimeout' }),
      line({ ts: NOW - 10 * 86_400_000, mode: 'live', route: 'code', final_model: 'old:1b' }), // outside window
      '{torn',
    ].join('\n');
    const m = computeRouterMetrics(text, 7, NOW + 1000);
    expect(m.total).toBe(5);
    expect(m.live).toBe(3);
    expect(m.errors).toBe(1);
    expect(m.escalations).toBe(1);
    expect(m.byModel.find((x) => x.model === 'gemma4:latest')!.count).toBe(3);
    expect(m.byModel.find((x) => x.model === 'ornith:latest')!.count).toBe(1);
    expect(m.byModel.some((x) => x.model === '__escalate__')).toBe(false);
    expect(m.byRoute[0].count).toBeGreaterThan(0);
  });
});

describe('mergeRoutesUpdate / parseClassifierRoute', () => {
  it('validates and merges an editor submission, preserving the classifier section', async () => {
    const { mergeRoutesUpdate } = await import('./ollama-manage.js');
    const existing = {
      classifier: { url: 'http://c', model: 'arch' },
      default_route: 'general',
      live: { enabled: true, model_name: 'auto', timeout_ms: 8000 },
      routes: [{ name: 'general', description: 'everyday chit chat', model: 'gemma4:latest' }],
    };
    const merged = mergeRoutesUpdate(existing, {
      routes: [
        {
          name: 'general',
          description: 'everyday conversation and quick questions',
          model: 'gemma4:latest',
          pinned: true,
        },
        { name: 'escalate', description: 'too hard for local models here', escalate: true },
      ],
      default_route: 'general',
      live: { enabled: false },
    });
    expect((merged.classifier as { url: string }).url).toBe('http://c');
    expect((merged.live as { enabled: boolean; timeout_ms: number }).enabled).toBe(false);
    expect((merged.live as { timeout_ms: number }).timeout_ms).toBe(8000); // preserved
    expect((merged.routes as Array<{ pinned?: boolean }>)[0].pinned).toBe(true);
  });

  it('rejects bad submissions with readable messages', async () => {
    const { mergeRoutesUpdate } = await import('./ollama-manage.js');
    const existing = { routes: [] };
    expect(() => mergeRoutesUpdate(existing, { routes: [] })).toThrow(/at least one route/);
    expect(() =>
      mergeRoutesUpdate(existing, { routes: [{ name: 'x y', description: 'long enough desc', model: 'm' }] }),
    ).toThrow(/route name/);
    expect(() => mergeRoutesUpdate(existing, { routes: [{ name: 'a', description: 'short', model: 'm' }] })).toThrow(
      /description/,
    );
    expect(() =>
      mergeRoutesUpdate(existing, {
        routes: [{ name: 'a', description: 'long enough desc', escalate: true, model: 'm' }],
      }),
    ).toThrow(/must not have a model/);
    expect(() =>
      mergeRoutesUpdate(existing, {
        routes: [{ name: 'a', description: 'long enough desc', model: 'm' }],
        live: { enabled: true, timeout_ms: 100 },
      }),
    ).toThrow(/timeout_ms/);
  });

  it('parses tolerant classifier replies', async () => {
    const { parseClassifierRoute } = await import('./ollama-manage.js');
    expect(parseClassifierRoute('{"route": "code"}')).toBe('code');
    expect(parseClassifierRoute("Sure! {'route': 'vision'} ")).toBe('vision');
    expect(() => parseClassifierRoute('nope')).toThrow(/no JSON/);
  });
});

describe('computeRouteSuggestions', () => {
  const CAT: {
    max_comfortable_b: number;
    size_penalty_per_b: number;
    entries: { pattern: string; quality: Record<string, number> }[];
  } = {
    max_comfortable_b: 14,
    size_penalty_per_b: 4,
    entries: [
      { pattern: 'llava', quality: { vision: 85 } },
      { pattern: 'qwen3-coder', quality: { code: 92 } },
      { pattern: 'ornith', quality: { code: 88 } },
      { pattern: 'gemma', quality: { general: 75, reasoning: 72 } },
    ],
  };

  it('suggests an uncovered capability, best-scoring model, default description', async () => {
    const { computeRouteSuggestions } = await import('./ollama-manage.js');
    const routes = [{ name: 'code' }, { name: 'general' }]; // vision + reasoning uncovered
    const roster = ['LLaVA:latest', 'gemma4:latest', 'ornith:latest'];
    const out = computeRouteSuggestions(routes, roster, CAT);
    const vision = out.find((s) => s.capability === 'vision');
    const reasoning = out.find((s) => s.capability === 'reasoning');
    expect(vision).toBeTruthy();
    expect(vision!.model).toBe('LLaVA:latest');
    expect(vision!.description).toMatch(/images/);
    expect(reasoning!.model).toBe('gemma4:latest');
    // code + general are covered → not suggested
    expect(out.some((s) => s.capability === 'code')).toBe(false);
    expect(out.some((s) => s.capability === 'general')).toBe(false);
  });

  it('returns nothing when every capability already has a route', async () => {
    const { computeRouteSuggestions } = await import('./ollama-manage.js');
    const routes = [{ name: 'code' }, { name: 'general' }, { name: 'reasoning' }, { name: 'vision' }];
    const out = computeRouteSuggestions(routes, ['LLaVA:latest', 'gemma4:latest'], CAT);
    expect(out).toEqual([]);
  });

  it('picks the higher-scoring model when several cover a capability (size penalty applies)', async () => {
    const { computeRouteSuggestions } = await import('./ollama-manage.js');
    // qwen3-coder:30b → 92 − (30−14)*4 = 28; ornith:latest → 88. Ornith wins.
    const out = computeRouteSuggestions([], ['qwen3-coder:30b', 'ornith:latest'], CAT);
    const code = out.find((s) => s.capability === 'code');
    expect(code!.model).toBe('ornith:latest');
    expect(code!.models).toEqual(['ornith:latest', 'qwen3-coder:30b']);
  });

  it('ignores roster models unknown to the catalog', async () => {
    const { computeRouteSuggestions } = await import('./ollama-manage.js');
    expect(computeRouteSuggestions([], ['mystery-model:7b'], CAT)).toEqual([]);
  });
});

describe('primaryRouter / multi-router compat', () => {
  it('primaryRouter reads the primary (auto) router from a multi-router config', async () => {
    const { primaryRouter, primaryRouterName } = await import('./ollama-manage.js');
    const cfg = {
      routers: {
        'auto-vision': { routes: [{ name: 'v' }], default_route: 'v' },
        auto: { routes: [{ name: 'code', model: 'x' }], default_route: 'code' },
      },
    };
    expect(primaryRouterName(cfg)).toBe('auto'); // auto preferred over first key
    expect(primaryRouter(cfg).routes).toEqual([{ name: 'code', model: 'x' }]);
    expect(primaryRouter(cfg).default_route).toBe('code');
  });

  it('primaryRouter falls back to top-level routes for the old single-router format', async () => {
    const { primaryRouter } = await import('./ollama-manage.js');
    const cfg = { default_route: 'general', routes: [{ name: 'general', model: 'g' }] };
    expect(primaryRouter(cfg).routes).toEqual([{ name: 'general', model: 'g' }]);
    expect(primaryRouter(cfg).default_route).toBe('general');
  });

  it('mergeRoutesUpdate writes edits into the primary router when multi-router', async () => {
    const { mergeRoutesUpdate } = await import('./ollama-manage.js');
    const existing = {
      routers: { auto: { routes: [], default_route: 'code' }, 'auto-vision': { routes: [{ name: 'v' }] } },
    };
    const merged = mergeRoutesUpdate(existing, {
      routes: [{ name: 'code', description: 'writing code stuff', model: 'ornith' }],
      default_route: 'code',
    }) as any;
    expect(merged.routers.auto.routes[0]).toMatchObject({ name: 'code', model: 'ornith' });
    expect(merged.routers['auto-vision'].routes).toEqual([{ name: 'v' }]); // sibling untouched
    expect(merged.routes).toBeUndefined(); // no top-level routes leaked
  });
});

describe('router management (picker)', () => {
  it('listRouters orders auto first; routerView returns the named router', async () => {
    const { listRouters, routerView } = await import('./ollama-manage.js');
    const cfg = {
      routers: {
        'auto-vision': { routes: [{ name: 'v' }], default_route: 'v' },
        auto: { routes: [{ name: 'code', model: 'x' }], default_route: 'code' },
      },
    };
    expect(listRouters(cfg)).toEqual(['auto', 'auto-vision']);
    expect(routerView(cfg, 'auto-vision').routes).toEqual([{ name: 'v' }]);
    expect(routerView(cfg, 'nope').name).toBe('auto'); // unknown → primary
  });

  it('addRouter clones the primary and converts single-router configs', async () => {
    const { addRouter } = await import('./ollama-manage.js');
    const single = {
      classifier: {},
      default_route: 'general',
      live: { enabled: true },
      routes: [{ name: 'general', model: 'g' }],
    };
    const next = addRouter(single, 'auto-cheap') as any;
    expect(Object.keys(next.routers).sort()).toEqual(['auto', 'auto-cheap']);
    expect(next.routers['auto-cheap'].routes).toEqual([{ name: 'general', model: 'g' }]); // cloned
    expect(next.routes).toBeUndefined(); // converted away from single-router
    expect(() => addRouter(next, 'auto')).toThrow(/already exists/);
    expect(() => addRouter(next, 'bad name!')).toThrow(/1-32/);
  });

  it('deleteRouter refuses the last router', async () => {
    const { deleteRouter } = await import('./ollama-manage.js');
    const cfg = { routers: { auto: { routes: [] }, 'auto-cheap': { routes: [] } } };
    expect(Object.keys((deleteRouter(cfg, 'auto-cheap') as any).routers)).toEqual(['auto']);
    const one = { routers: { auto: { routes: [] } } };
    expect(() => deleteRouter(one, 'auto')).toThrow(/last router/);
  });

  it('mergeRoutesUpdate targets a named router, leaving siblings untouched', async () => {
    const { mergeRoutesUpdate } = await import('./ollama-manage.js');
    const existing = { routers: { auto: { routes: [{ name: 'a' }] }, 'auto-cheap': { routes: [{ name: 'old' }] } } };
    const merged = mergeRoutesUpdate(
      existing,
      { routes: [{ name: 'code', description: 'writing code stuff', model: 'qwen' }] },
      'auto-cheap',
    ) as any;
    expect(merged.routers['auto-cheap'].routes[0]).toMatchObject({ name: 'code', model: 'qwen' });
    expect(merged.routers.auto.routes).toEqual([{ name: 'a' }]); // untouched
    expect(() =>
      mergeRoutesUpdate(existing, { routes: [{ name: 'x', description: 'valid enough', model: 'm' }] }, 'ghost'),
    ).toThrow(/no router named/);
  });
});

describe('removeRouteFromConfig', () => {
  const base = () => ({
    routers: {
      auto: {
        default_route: 'general',
        routes: [
          { name: 'general', description: 'g', model: 'gemma4:latest' },
          { name: 'vision', description: 'v', model: 'LLaVA:latest' },
        ],
      },
    },
  });

  it('removes a non-default route (the model-delete cascade)', () => {
    const cfg = base() as unknown as Record<string, unknown>;
    removeRouteFromConfig(cfg, 'auto', 'vision');
    const routes = (cfg.routers as Record<string, { routes: { name: string }[] }>).auto.routes;
    expect(routes.map((r) => r.name)).toEqual(['general']);
  });

  it("refuses the router's default route", () => {
    const cfg = base() as unknown as Record<string, unknown>;
    expect(() => removeRouteFromConfig(cfg, 'auto', 'general')).toThrow(/default/);
  });

  it('throws on an unknown router', () => {
    expect(() => removeRouteFromConfig(base() as unknown as Record<string, unknown>, 'nope', 'vision')).toThrow(
      /no router/,
    );
  });
});
