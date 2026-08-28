// ── First-run wizard ─────────────────────────────────────────────────────────
// Four steps: engine → (local) model → access → first agent. The predecessor's
// wizard was 1,890 lines, most of it for providers this build dropped; this
// one is the walk a fresh install actually needs. Auto-opens when onboarding
// is incomplete AND nothing exists yet; every step is skippable, and Finish
// just records completion.
import { $ } from '../core/dom.js';
import { apiJson } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';

interface OnboardingState {
  complete: boolean;
  agents: number;
  rooms: number;
  bearerConfigured: boolean;
  ollama: { reachable: boolean; canInstall: boolean };
  tailscale: { available: boolean; active: boolean; url: string | null };
}

let step = 0;
let state: OnboardingState | null = null;
/** The engine picked in step 1 — steers whether step 2 (local model) shows. */
let engine: 'claude' | 'local' = 'claude';
let pullTimer: ReturnType<typeof setInterval> | null = null;

export async function maybeOpenWizard(): Promise<void> {
  try {
    state = (await apiJson('/api/webchat/onboarding')) as OnboardingState;
  } catch {
    return;
  }
  if (state.complete || state.agents > 0 || state.rooms > 0) return;
  openWizard();
}

export function openWizard(): void {
  step = 0;
  $('#wizard')!.hidden = false;
  render();
}

function closeWizard(): void {
  if (pullTimer) {
    clearInterval(pullTimer);
    pullTimer = null;
  }
  $('#wizard')!.hidden = true;
}

async function finish(): Promise<void> {
  await apiJson('/api/webchat/onboarding', { method: 'PUT', body: { complete: true } }).catch(() => {});
  closeWizard();
  location.reload(); // pick up rooms/agents made during the walk
}

function render(): void {
  const box = $('#wizard-body')!;
  if (pullTimer) {
    clearInterval(pullTimer);
    pullTimer = null;
  }
  const steps = [renderEngine, ...(engine === 'local' ? [renderModel] : []), renderAccess, renderAgent];
  $('#wizard-step')!.textContent = `Step ${step + 1} of ${steps.length}`;
  box.replaceChildren(steps[Math.min(step, steps.length - 1)]());
  $('#wizard-skip')!.onclick = () => void finish();
}

function nav(opts: { next?: () => void | Promise<void>; nextLabel?: string; canBack?: boolean }): HTMLElement {
  const row = document.createElement('div');
  row.className = 'wiz-nav';
  if (opts.canBack !== false && step > 0) {
    const back = document.createElement('button');
    back.textContent = 'Back';
    back.onclick = () => {
      step -= 1;
      render();
    };
    row.appendChild(back);
  }
  const next = document.createElement('button');
  next.className = 'mprimary';
  next.textContent = opts.nextLabel ?? 'Next';
  next.onclick = async () => {
    next.disabled = true;
    try {
      await opts.next?.();
      step += 1;
      render();
    } catch (err) {
      toastError(err, 'That step failed');
    } finally {
      next.disabled = false;
    }
  };
  row.appendChild(next);
  return row;
}

function para(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'wiz-text';
  p.textContent = text;
  return p;
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

// ── Step: engine ────────────────────────────────────────────────────────────

function renderEngine(): HTMLElement {
  const box = document.createElement('div');
  box.append(
    heading('Which model powers your agents?'),
    para('You can mix both later — this just sets up the first one.'),
  );
  const choices = document.createElement('div');
  choices.className = 'wiz-choices';
  const mk = (id: 'claude' | 'local', title: string, desc: string): HTMLElement => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'wiz-choice' + (engine === id ? ' selected' : '');
    const t = document.createElement('div');
    t.className = 'wiz-choice-title';
    t.textContent = title;
    const d = document.createElement('div');
    d.className = 'wiz-choice-desc';
    d.textContent = desc;
    c.append(t, d);
    c.onclick = () => {
      engine = id;
      render();
    };
    return c;
  };
  choices.append(
    mk(
      'claude',
      'Claude (Anthropic)',
      'Uses the credential in your OneCLI vault. Most capable; needs the vault set up (setup does this).',
    ),
    mk(
      'local',
      'Local model (Ollama)',
      state?.ollama.reachable
        ? 'Ollama is running on this machine — pull a model and chat privately, no cloud.'
        : 'Runs models on this machine. Ollama is not detected yet; the next step can install it.',
    ),
  );
  box.append(choices, nav({}));
  return box;
}

// ── Step: local model (engine = local only) ─────────────────────────────────

function renderModel(): HTMLElement {
  const box = document.createElement('div');
  box.append(heading('Pull a local model'), para('Downloaded once, runs offline afterwards.'));

  const status = document.createElement('div');
  status.className = 'wiz-text';
  const input = document.createElement('input');
  input.placeholder = 'Model (e.g. qwen3:8b)';
  const host = 'http://127.0.0.1:11434';

  void apiJson('/api/ollama/recommend')
    .then((r: { model?: string; note?: string }) => {
      if (r.model) input.value ||= r.model;
      if (r.note) status.textContent = r.note;
    })
    .catch(() => {});

  const installRow = document.createElement('div');
  if (!state?.ollama.reachable) {
    const installBtn = document.createElement('button');
    installBtn.textContent = state?.ollama.canInstall ? 'Install Ollama on this machine' : 'Ollama not detected';
    installBtn.disabled = !state?.ollama.canInstall;
    installBtn.onclick = async () => {
      installBtn.disabled = true;
      installBtn.textContent = 'Installing…';
      await apiJson('/api/ollama/install', { method: 'POST' }).catch((e) => toastError(e, 'Install failed to start'));
      pullTimer = setInterval(async () => {
        const st = (await apiJson('/api/ollama/local').catch(() => null)) as { reachable?: boolean } | null;
        if (st?.reachable) {
          if (state) state.ollama.reachable = true;
          showToast('Ollama is up', { kind: 'success' });
          render();
        }
      }, 3000);
    };
    installRow.appendChild(installBtn);
  }

  const progress = document.createElement('div');
  progress.className = 'wiz-text';
  const pullBtn = document.createElement('button');
  pullBtn.className = 'mprimary';
  pullBtn.textContent = 'Pull model';
  pullBtn.onclick = async () => {
    const model = input.value.trim();
    if (!model) return;
    pullBtn.disabled = true;
    try {
      await apiJson('/api/ollama/pull', { method: 'POST', body: { host, model } });
      pullTimer = setInterval(async () => {
        const { pulls } = (await apiJson('/api/ollama/pulls').catch(() => ({ pulls: [] }))) as {
          pulls: Array<{ model: string; status: string; completed?: number; total?: number; error?: string | null }>;
        };
        const p = pulls.find((x) => x.model.includes(model));
        if (!p) return;
        if (p.status === 'done') {
          clearInterval(pullTimer!);
          pullTimer = null;
          progress.textContent = 'Downloaded. Registering the model…';
          // Register in the roster + make it the install default.
          const { model: created } = (await apiJson('/api/models', {
            method: 'POST',
            body: { name: model, kind: 'ollama', endpoint: host, model_id: model },
          })) as { model: { id: string } };
          await apiJson('/api/models/default', { method: 'PUT', body: { model_id: created.id } });
          progress.textContent = `${model} is ready and set as the default model.`;
          showToast('Local model ready', { kind: 'success' });
        } else if (p.status === 'error') {
          clearInterval(pullTimer!);
          pullTimer = null;
          progress.textContent = `Pull failed: ${p.error ?? 'unknown error'}`;
          pullBtn.disabled = false;
        } else {
          const pct = p.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : 0;
          progress.textContent = `Downloading… ${pct}%`;
        }
      }, 1200);
    } catch (err) {
      toastError(err, 'Pull failed to start');
      pullBtn.disabled = false;
    }
  };

  const rowEl = document.createElement('div');
  rowEl.className = 'mactions';
  rowEl.append(input, pullBtn);
  box.append(status, installRow, rowEl, progress, nav({}));
  return box;
}

// ── Step: access ────────────────────────────────────────────────────────────

function renderAccess(): HTMLElement {
  const box = document.createElement('div');
  box.append(
    heading('Reach it from other devices?'),
    para('Right now the chat answers on this machine only. Both options below are optional — Skip is fine.'),
  );

  const ts = document.createElement('div');
  ts.className = 'mrow';
  const tsTitle = document.createElement('div');
  tsTitle.className = 'mrow-name';
  tsTitle.textContent = 'Tailscale HTTPS';
  const tsDesc = document.createElement('div');
  tsDesc.className = 'mrow-meta';
  tsDesc.textContent = state?.tailscale.available
    ? state.tailscale.active
      ? `Already serving at ${state.tailscale.url ?? 'your tailnet name'}.`
      : 'Tailscale is up — one click puts the chat on your tailnet with a real HTTPS cert (installable as an app on your phone).'
    : 'Tailscale is not running on this machine. Install it (tailscale.com) and sign in, then re-run this from the wizard or Settings.';
  const tsBtn = document.createElement('button');
  tsBtn.textContent = 'Enable HTTPS on my tailnet';
  tsBtn.disabled = !state?.tailscale.available || state?.tailscale.active === true;
  tsBtn.onclick = async () => {
    tsBtn.disabled = true;
    try {
      const r = (await apiJson('/api/webchat/tailscale-https', { method: 'POST' })) as {
        ok: boolean;
        url?: string;
        error?: string;
        hint?: string;
      };
      if (r.ok) {
        tsDesc.textContent = `Serving at ${r.url}. Open that URL on any tailnet device.`;
        showToast('Tailscale HTTPS enabled', { kind: 'success' });
      } else {
        tsDesc.textContent = `${r.error ?? 'Failed'}${r.hint ? ` — ${r.hint}` : ''}`;
        tsBtn.disabled = false;
      }
    } catch (err) {
      toastError(err, 'Could not enable');
      tsBtn.disabled = false;
    }
  };
  ts.append(tsTitle, tsDesc, tsBtn);

  const bearer = document.createElement('div');
  bearer.className = 'mrow';
  const bTitle = document.createElement('div');
  bTitle.className = 'mrow-name';
  bTitle.textContent = 'Access token (any network)';
  const bDesc = document.createElement('div');
  bDesc.className = 'mrow-meta';
  bDesc.textContent = state?.bearerConfigured
    ? 'A token is already configured.'
    : 'Generates a token and opens the port to your network. You log in with the token; keep it safe. Requires a restart.';
  const bBtn = document.createElement('button');
  bBtn.textContent = 'Generate token';
  bBtn.disabled = state?.bearerConfigured === true;
  bBtn.onclick = async () => {
    bBtn.disabled = true;
    try {
      const { token } = (await apiJson('/api/webchat/auth/bearer/generate', { method: 'POST' })) as { token: string };
      const tokenBox = document.createElement('code');
      tokenBox.className = 'wiz-token';
      tokenBox.textContent = token;
      bDesc.textContent =
        'Save this token now — it is shown once. It becomes active after the restart at the end of the wizard.';
      bearer.insertBefore(tokenBox, bBtn);
    } catch (err) {
      toastError(err, 'Could not generate');
      bBtn.disabled = false;
    }
  };
  bearer.append(bTitle, bDesc, bBtn);

  box.append(ts, bearer, nav({}));
  return box;
}

// ── Step: first agent ───────────────────────────────────────────────────────

function renderAgent(): HTMLElement {
  const box = document.createElement('div');
  box.append(
    heading('Create your first agent'),
    para('A name and, optionally, what it should be. ✨ drafts both from a one-line idea.'),
  );

  const name = document.createElement('input');
  name.placeholder = 'Name (e.g. Assistant)';
  const instructions = document.createElement('textarea');
  instructions.rows = 4;
  instructions.placeholder = 'Instructions (optional)';

  const draftBtn = document.createElement('button');
  draftBtn.textContent = '✨ Draft from an idea';
  draftBtn.onclick = async () => {
    const prompt = instructions.value.trim() || name.value.trim();
    if (!prompt) {
      showToast('Type an idea first — a sentence is enough', { kind: 'error' });
      return;
    }
    draftBtn.disabled = true;
    draftBtn.textContent = 'Drafting…';
    try {
      const { draft } = (await apiJson('/api/agents/draft', { method: 'POST', body: { prompt } })) as {
        draft: { name?: string; instructions?: string };
      };
      if (draft.name) name.value = draft.name;
      if (draft.instructions) instructions.value = draft.instructions;
    } catch (err) {
      toastError(err, 'Drafting failed (is a model credential set up?)');
    } finally {
      draftBtn.disabled = false;
      draftBtn.textContent = '✨ Draft from an idea';
    }
  };

  const row = document.createElement('div');
  row.className = 'mactions';
  row.append(draftBtn);

  box.append(
    name,
    instructions,
    row,
    nav({
      nextLabel: 'Create & finish',
      next: async () => {
        const n = name.value.trim() || 'Assistant';
        const { agent } = (await apiJson('/api/agents', {
          method: 'POST',
          body: { name: n, instructions: instructions.value.trim() || undefined },
        })) as { agent: { id: string; name: string } };
        await apiJson('/api/rooms', {
          method: 'POST',
          body: { name: agent.name, agent_group_id: agent.id },
        });
        await finish();
      },
    }),
  );
  return box;
}
