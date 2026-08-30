// ── First-run wizard ─────────────────────────────────────────────────────────
// Four steps: engine → (local) model → access → first agent. The predecessor's
// wizard was 1,890 lines, most of it for providers this build dropped; this
// one is the walk a fresh install actually needs. Auto-opens when onboarding
// is incomplete AND nothing exists yet; every step is skippable, and Finish
// just records completion.
import { $ } from '../core/dom.js';
import { apiJson } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';
let step = 0;
let state = null;
/** The engine picked in step 1 — steers whether step 2 (local model) shows. */
let engine = 'claude';
let pullTimer = null;
export async function maybeOpenWizard() {
    try {
        state = (await apiJson('/api/webchat/onboarding'));
    }
    catch {
        return;
    }
    if (state.complete || state.agents > 0 || state.rooms > 0)
        return;
    openWizard();
}
/** Manual trigger (manage drawer): refresh state, then open at step one. */
export async function launchWizard() {
    try {
        state = (await apiJson('/api/webchat/onboarding'));
    }
    catch (err) {
        toastError(err, 'Could not load setup state');
        return;
    }
    openWizard();
}
export function openWizard() {
    step = 0;
    $('#wizard').hidden = false;
    render();
}
function closeWizard() {
    if (pullTimer) {
        clearInterval(pullTimer);
        pullTimer = null;
    }
    $('#wizard').hidden = true;
}
async function finish() {
    await apiJson('/api/webchat/onboarding', { method: 'PUT', body: { complete: true } }).catch(() => { });
    closeWizard();
    location.reload(); // pick up rooms/agents made during the walk
}
function render() {
    const box = $('#wizard-body');
    if (pullTimer) {
        clearInterval(pullTimer);
        pullTimer = null;
    }
    const steps = [renderEngine, renderAccess, renderAgent];
    $('#wizard-step').textContent = `Step ${step + 1} of ${steps.length}`;
    box.replaceChildren(steps[Math.min(step, steps.length - 1)]());
    $('#wizard-skip').onclick = () => void finish();
}
function nav(opts) {
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
        }
        catch (err) {
            toastError(err, 'That step failed');
        }
        finally {
            next.disabled = false;
        }
    };
    row.appendChild(next);
    return row;
}
function para(text) {
    const p = document.createElement('p');
    p.className = 'wiz-text';
    p.textContent = text;
    return p;
}
function heading(text) {
    const h = document.createElement('h3');
    h.textContent = text;
    return h;
}
// ── Step: engine ────────────────────────────────────────────────────────────
function renderEngine() {
    const box = document.createElement('div');
    box.append(heading('Which model powers your agents?'));
    const choices = document.createElement('div');
    choices.className = 'wiz-choices';
    const mk = (id, title, desc) => {
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
    choices.append(mk('claude', 'Claude (Anthropic)', 'Most capable — sign in with your Claude account.'), mk('local', 'Local model (Ollama)', state?.ollama.reachable
        ? 'Private, no cloud — pull a model and chat.'
        : 'Private, no cloud. Not detected yet; the next step can install it.'));
    box.append(choices);
    box.appendChild(engine === 'claude' ? renderClaudeAuth() : buildLocalModels());
    box.append(nav({}));
    return box;
}
// The in-flight sign-in, so a re-render mid-flow keeps the URL + code box.
let claudeSignin = null;
function renderClaudeAuth() {
    const box = document.createElement('div');
    box.className = 'wiz-auth';
    const connected = Boolean(state?.claude.connected);
    // Integrations-row style (as the predecessor webchat renders credentials):
    // leading status dot + text that carries the state (screen readers and
    // colour-blind users get the words, not just the dot), action right-aligned.
    const rowEl = document.createElement('div');
    rowEl.className = 'wiz-creds-row';
    const status = document.createElement('span');
    status.className = 'wiz-creds-status' + (connected ? ' is-connected' : '');
    status.textContent = `Claude account — ${connected ? 'connected' : 'not connected'}`;
    const action = document.createElement('button');
    action.textContent = connected ? 'Reconnect' : 'Connect';
    if (!connected)
        action.className = 'mprimary';
    action.onclick = async () => {
        action.disabled = true;
        action.textContent = 'Starting…';
        try {
            claudeSignin = (await apiJson('/api/webchat/claude-auth/start', { method: 'POST', body: {} }));
            render();
        }
        catch (err) {
            action.disabled = false;
            action.textContent = connected ? 'Reconnect' : 'Connect';
            toastError(err, 'Could not start sign-in');
        }
    };
    rowEl.append(status, action);
    box.appendChild(rowEl);
    if (!claudeSignin) {
        if (connected)
            action.classList.add('wiz-quiet');
        return box;
    }
    action.hidden = true; // the flow below replaces the action while in flight
    const link = document.createElement('a');
    link.href = claudeSignin.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Open the sign-in page ↗';
    const codeInput = document.createElement('input');
    codeInput.placeholder = 'Paste the code from that page';
    const connect = document.createElement('button');
    connect.className = 'mprimary';
    connect.textContent = 'Connect';
    connect.onclick = async () => {
        const code = codeInput.value.trim();
        if (!code || !claudeSignin)
            return;
        connect.disabled = true;
        connect.textContent = 'Connecting…';
        try {
            await apiJson('/api/webchat/claude-auth/code', {
                method: 'POST',
                body: { sessionId: claudeSignin.sessionId, code },
            });
            claudeSignin = null;
            if (state)
                state.claude.connected = true;
            showToast('Claude connected', { kind: 'success' });
            render();
        }
        catch (err) {
            connect.disabled = false;
            connect.textContent = 'Connect';
            toastError(err, 'Sign-in failed');
        }
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => {
        if (claudeSignin) {
            void apiJson('/api/webchat/claude-auth/cancel', {
                method: 'POST',
                body: { sessionId: claudeSignin.sessionId },
            }).catch(() => { });
        }
        claudeSignin = null;
        render();
    };
    const row = document.createElement('div');
    row.className = 'wiz-actions';
    row.append(codeInput, connect, cancel);
    box.append(link, row);
    return box;
}
// ── Ollama accordion body (engine screen, engine = local) ───────────────────
/** The Ollama accordion body on the engine screen: probe → pick → pull. */
function buildLocalModels() {
    const box = document.createElement('div');
    box.className = 'wiz-auth';
    const urlInput = document.createElement('input');
    urlInput.value = 'http://127.0.0.1:11434';
    const probeBtn = document.createElement('button');
    probeBtn.className = 'mprimary';
    probeBtn.textContent = 'Probe';
    const urlRow = document.createElement('div');
    urlRow.className = 'mactions';
    urlRow.append(urlInput, probeBtn);
    const statusLine = document.createElement('div');
    statusLine.className = 'wiz-text';
    const list = document.createElement('ul');
    list.className = 'wiz-model-list';
    const isLocal = () => /127\.0\.0\.1|localhost/.test(urlInput.value);
    // ── Install (localhost only, when the daemon is down) ─────────────────────
    const installRow = document.createElement('div');
    const installErr = document.createElement('div');
    installErr.className = 'wiz-text wiz-err';
    const installBtn = document.createElement('button');
    installBtn.textContent = state?.ollama.canInstall ? 'Install Ollama on this machine' : 'Ollama not detected';
    installBtn.disabled = !state?.ollama.canInstall;
    installBtn.onclick = async () => {
        installBtn.disabled = true;
        installBtn.textContent = 'Installing…';
        installErr.textContent = '';
        await apiJson('/api/ollama/install', { method: 'POST' }).catch((e) => toastError(e, 'Install failed to start'));
        pullTimer = setInterval(async () => {
            const st = (await apiJson('/api/ollama/local').catch(() => null));
            if (!st)
                return;
            if (st.reachable) {
                if (pullTimer) {
                    clearInterval(pullTimer);
                    pullTimer = null;
                }
                if (state)
                    state.ollama.reachable = true;
                showToast('Ollama is up', { kind: 'success' });
                installRow.hidden = true;
                void probe();
                return;
            }
            // Installer finished without a daemon: surface why instead of spinning.
            if (!st.running && st.exitCode !== null && st.exitCode !== undefined && st.exitCode !== 0) {
                if (pullTimer) {
                    clearInterval(pullTimer);
                    pullTimer = null;
                }
                const lastLine = (st.lines ?? []).filter((l) => l.trim()).pop() ?? '';
                installErr.textContent = `Install failed (exit ${st.exitCode})${lastLine ? `: ${lastLine}` : ''}`;
                installBtn.disabled = false;
                installBtn.textContent = 'Install Ollama on this machine';
            }
        }, 3000);
    };
    installRow.append(installBtn, installErr);
    installRow.hidden = Boolean(state?.ollama.reachable);
    // ── Probe → radio list; selecting a model IS the action ───────────────────
    let probed = null;
    const selectModel = async (modelId) => {
        if (!probed)
            return;
        try {
            // Reuse an existing roster row for the same endpoint+model — repeated
            // selection must never spawn duplicates (no uniqueness constraint).
            const { models } = (await apiJson('/api/models'));
            const ep = probed.endpoint;
            let row = models.find((m) => m.model_id === modelId && (m.endpoint ?? '').replace(/\/$/, '') === ep);
            if (!row) {
                const created = (await apiJson('/api/models', {
                    method: 'POST',
                    body: { name: modelId, kind: probed.kind, endpoint: ep, model_id: modelId },
                }));
                row = created.model;
            }
            await apiJson('/api/models/default', { method: 'PUT', body: { model_id: row.id } });
            showToast(`${modelId} is the default model`, { kind: 'success' });
        }
        catch (err) {
            toastError(err, 'Could not select that model');
        }
    };
    const renderList = (models, checkedId) => {
        list.replaceChildren(...models.map((m) => {
            const li = document.createElement('li');
            const label = document.createElement('label');
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'wizard-ollama-model';
            radio.value = m;
            radio.checked = m === checkedId;
            radio.addEventListener('change', () => void selectModel(m));
            const span = document.createElement('span');
            span.textContent = m;
            label.append(radio, span);
            li.appendChild(label);
            return li;
        }));
    };
    const probe = async () => {
        const ep = urlInput.value.trim().replace(/\/$/, '');
        if (!ep)
            return;
        probeBtn.disabled = true;
        probeBtn.textContent = 'Probing…';
        statusLine.textContent = '';
        statusLine.classList.remove('wiz-err', 'wiz-ok');
        try {
            const r = (await apiJson('/api/models/probe-endpoint', { method: 'POST', body: { endpoint: ep } }));
            probed = { kind: r.kind, endpoint: ep };
            // Mark the current default's radio when it lives on this endpoint.
            const roster = (await apiJson('/api/models').catch(() => null));
            const def = roster?.models.find((m) => m.id === roster.default_model_id);
            const checkedId = def && (def.endpoint ?? '').replace(/\/$/, '') === ep ? def.model_id : null;
            renderList(r.models, checkedId);
            const n = r.models.length;
            statusLine.textContent =
                n === 0
                    ? `Nothing installed at ${ep} yet — pull a model below.`
                    : `Found ${n} model${n === 1 ? '' : 's'} at ${ep} — pick one to make it the default.`;
            statusLine.classList.add('wiz-ok');
            pullRow.hidden = r.kind !== 'ollama' || !isLocal();
        }
        catch (err) {
            probed = null;
            renderList([], null);
            statusLine.textContent = err.message;
            statusLine.classList.add('wiz-err');
            installRow.hidden = !isLocal() || Boolean(state?.ollama.canInstall) === false;
            pullRow.hidden = !isLocal();
        }
        finally {
            probeBtn.disabled = false;
            probeBtn.textContent = 'Probe';
        }
    };
    probeBtn.onclick = () => void probe();
    // ── Pull (local Ollama only) ──────────────────────────────────────────────
    const progress = document.createElement('div');
    progress.className = 'wiz-text';
    const pullInput = document.createElement('input');
    pullInput.placeholder = 'Model to pull (e.g. qwen3:8b)';
    void apiJson('/api/ollama/recommend')
        .then((r) => {
        if (r.model)
            pullInput.value ||= r.model;
    })
        .catch(() => { });
    const pullBtn = document.createElement('button');
    pullBtn.className = 'mprimary';
    pullBtn.textContent = 'Pull';
    pullBtn.onclick = async () => {
        const model = pullInput.value.trim();
        if (!model)
            return;
        pullBtn.disabled = true;
        try {
            await apiJson('/api/ollama/pull', { method: 'POST', body: { host: 'http://127.0.0.1:11434', model } });
            pullTimer = setInterval(async () => {
                const { pulls } = (await apiJson('/api/ollama/pulls').catch(() => ({ pulls: [] })));
                const p = pulls.find((x) => x.model.includes(model));
                if (!p)
                    return;
                if (p.status === 'done') {
                    if (pullTimer) {
                        clearInterval(pullTimer);
                        pullTimer = null;
                    }
                    progress.textContent = '';
                    pullBtn.disabled = false;
                    await probe(); // fresh list includes the new model
                    await selectModel(model); // …and it becomes the default
                    const radio = list.querySelector(`input[value="${CSS.escape(model)}"]`);
                    if (radio)
                        radio.checked = true;
                }
                else if (p.status === 'error') {
                    if (pullTimer) {
                        clearInterval(pullTimer);
                        pullTimer = null;
                    }
                    progress.textContent = `Pull failed: ${p.error ?? 'unknown error'}`;
                    pullBtn.disabled = false;
                }
                else {
                    const pct = p.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : 0;
                    progress.textContent = `Downloading… ${pct}%`;
                }
            }, 1200);
        }
        catch (err) {
            toastError(err, 'Pull failed to start');
            pullBtn.disabled = false;
        }
    };
    const pullRow = document.createElement('div');
    pullRow.className = 'mactions';
    pullRow.append(pullInput, pullBtn);
    box.append(urlRow, installRow, statusLine, list, pullRow, progress);
    // Auto-query on step entry when the local daemon is already up.
    if (state?.ollama.reachable)
        void probe();
    else
        pullRow.hidden = true;
    return box;
}
// ── Step: access ────────────────────────────────────────────────────────────
function renderAccess() {
    const box = document.createElement('div');
    box.append(heading('Reach it from other devices?'), para('Right now the chat answers on this machine only. Both options below are optional — Skip is fine.'));
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
            const r = (await apiJson('/api/webchat/tailscale-https', { method: 'POST' }));
            if (r.ok) {
                tsDesc.textContent = `Serving at ${r.url}. Open that URL on any tailnet device.`;
                showToast('Tailscale HTTPS enabled', { kind: 'success' });
            }
            else {
                tsDesc.textContent = `${r.error ?? 'Failed'}${r.hint ? ` — ${r.hint}` : ''}`;
                tsBtn.disabled = false;
            }
        }
        catch (err) {
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
            const { token } = (await apiJson('/api/webchat/auth/bearer/generate', { method: 'POST' }));
            const tokenBox = document.createElement('code');
            tokenBox.className = 'wiz-token';
            tokenBox.textContent = token;
            bDesc.textContent =
                'Save this token now — it is shown once. It becomes active after the restart at the end of the wizard.';
            bearer.insertBefore(tokenBox, bBtn);
        }
        catch (err) {
            toastError(err, 'Could not generate');
            bBtn.disabled = false;
        }
    };
    bearer.append(bTitle, bDesc, bBtn);
    box.append(ts, bearer, nav({}));
    return box;
}
// ── Step: first agent ───────────────────────────────────────────────────────
function renderAgent() {
    const box = document.createElement('div');
    box.append(heading('Create your first agent'), para('A name and, optionally, what it should be. ✨ drafts both from a one-line idea.'));
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
            const { draft } = (await apiJson('/api/agents/draft', { method: 'POST', body: { prompt } }));
            if (draft.name)
                name.value = draft.name;
            if (draft.instructions)
                instructions.value = draft.instructions;
        }
        catch (err) {
            toastError(err, 'Drafting failed (is a model credential set up?)');
        }
        finally {
            draftBtn.disabled = false;
            draftBtn.textContent = '✨ Draft from an idea';
        }
    };
    const row = document.createElement('div');
    row.className = 'mactions';
    row.append(draftBtn);
    box.append(name, instructions, row, nav({
        nextLabel: 'Create & finish',
        next: async () => {
            const n = name.value.trim() || 'Assistant';
            const { agent } = (await apiJson('/api/agents', {
                method: 'POST',
                body: { name: n, instructions: instructions.value.trim() || undefined },
            }));
            await apiJson('/api/rooms', {
                method: 'POST',
                body: { name: agent.name, agent_group_id: agent.id },
            });
            await finish();
        },
    }));
    return box;
}
