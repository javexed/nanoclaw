// ── Management drawer: Models / Ollama ──────────────────────────────────────
// The install-wide admin surface in one slide-over panel. Rendering is
// repaint-on-action (each mutation re-fetches) — at this scale the simplicity
// beats diffing. Everything else administrative lives in ncl.
//
// Per-chat settings (model, instructions, auto-learn) are NOT here: they
// belong to the chat and are edited in it (rooms.ts, wireRoomSettings). This
// drawer holds only what is shared across every chat — the model roster.
import { $, onAsync } from '../core/dom.js';
import { apiJson } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';
import { launchWizard } from './wizard.js';
import { confirmDialog } from '../core/confirm.js';
let open = false;
let pullTimer = null;
export function wireManage() {
    $('#manage-btn').addEventListener('click', () => (open ? closeDrawer() : openDrawer()));
    $('#manage-close').addEventListener('click', closeDrawer);
    $('#wizard-btn').addEventListener('click', () => {
        closeDrawer();
        void launchWizard();
    });
}
function openDrawer() {
    open = true;
    document.body.classList.add('drawer-open');
    $('#manage').classList.add('open');
    void renderModels();
}
function closeDrawer() {
    open = false;
    document.body.classList.remove('drawer-open');
    $('#manage').classList.remove('open');
    if (pullTimer) {
        clearInterval(pullTimer);
        pullTimer = null;
    }
}
// ── Model roster ────────────────────────────────────────────────────────────
function msection(label) {
    const el = document.createElement('div');
    el.className = 'msection';
    el.textContent = label;
    return el;
}
async function renderModels() {
    const pane = $('#mpane-models');
    try {
        const data = (await apiJson('/api/models'));
        const rosterKeys = new Set(data.models.map((m) => `${(m.endpoint ?? '').replace(/\/$/, '')}|${m.model_id}`));
        const ollamaBox = document.createElement('div');
        // Claude is ALWAYS a row, not only when the roster is empty. It used to
        // appear just as an explainer for an empty list, which meant adding any
        // model made it vanish — and with it the only way back: "Make default"
        // exists per roster row, Claude has no roster row, and nothing in the UI
        // ever sent `model_id: null`. Setting a local model as the install default
        // was therefore a one-way door, with the server perfectly able to undo it.
        const rows = [
            buildBuiltinClaudeRow(data.default_model_id),
            ...data.models.map((m) => buildModelRow(m, data.default_model_id)),
        ];
        pane.replaceChildren(msection('Your models'), ...rows, msection('On this machine'), ollamaBox, msection('Add custom endpoint'), buildCustomEndpoint(rosterKeys));
        void renderOllamaInto(ollamaBox, rosterKeys);
        void probeRosterDots(pane, data.models);
    }
    catch (err) {
        toastError(err, 'Could not load models');
    }
}
/**
 * The built-in Claude provider as a roster row. It has no `web_models` record —
 * it is what an agent falls back to when no default is set — so "make it the
 * default" means CLEARING the default (`model_id: null`), which is exactly what
 * the server has always accepted.
 */
function buildBuiltinClaudeRow(defaultId) {
    const row = document.createElement('div');
    row.className = 'mrow';
    const head = document.createElement('div');
    head.className = 'mrow-head';
    const dot = document.createElement('span');
    dot.className = 'mdot ok';
    dot.title = 'Cloud (Anthropic)';
    const nm = document.createElement('span');
    nm.className = 'mrow-name';
    nm.textContent = 'Claude';
    head.append(dot, nm);
    const meta = document.createElement('div');
    meta.className = 'mrow-meta';
    meta.textContent = 'built-in · cloud (Anthropic)';
    const actions = document.createElement('div');
    actions.className = 'mactions';
    const def = document.createElement('button');
    const isDefault = defaultId === null;
    def.textContent = isDefault ? '★ Default' : 'Make default';
    def.disabled = isDefault;
    onAsync(def, 'click', async () => {
        try {
            await apiJson('/api/models/default', { method: 'PUT', body: { model_id: null } });
            showToast('Default set', { kind: 'success' });
            void renderModels();
        }
        catch (err) {
            toastError(err, 'Could not set default');
        }
    });
    actions.appendChild(def);
    row.append(head, meta, actions);
    return row;
}
function buildModelRow(m, defaultId) {
    const row = document.createElement('div');
    row.className = 'mrow';
    const head = document.createElement('div');
    head.className = 'mrow-head';
    const dot = document.createElement('span');
    dot.className = 'mdot';
    if (m.endpoint) {
        dot.dataset.ep = m.endpoint.replace(/\/$/, '');
        dot.title = 'Probing…';
    }
    else {
        dot.classList.add('ok');
        dot.title = 'Cloud (Anthropic)';
    }
    // Hover-only tooltips don't exist on touch — tap surfaces the verdict.
    dot.addEventListener('click', () => showToast(dot.title || 'Still probing…', { kind: dot.classList.contains('bad') ? 'error' : 'info' }));
    const name = document.createElement('span');
    name.className = 'mrow-name';
    name.textContent = m.name;
    const del = document.createElement('button');
    del.className = 'mrow-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Delete ${m.name}`);
    del.title = 'Remove from roster';
    onAsync(del, 'click', async () => {
        try {
            await apiJson(`/api/models/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
            void renderModels();
        }
        catch (err) {
            const body = err.body;
            if (body?.agents?.length) {
                if (await confirmDialog(`In use by ${body.agents.join(', ')}. Remove?`)) {
                    await apiJson(`/api/models/${encodeURIComponent(m.id)}?force=1`, { method: 'DELETE' }).catch((e) => toastError(e, 'Delete failed'));
                    void renderModels();
                }
            }
            else
                toastError(err, 'Delete failed');
        }
    });
    head.append(dot, name, del);
    const meta = document.createElement('div');
    meta.className = 'mrow-meta';
    meta.textContent = `${m.kind} · ${m.model_id}${m.endpoint ? ` · ${m.endpoint}` : ''}`;
    const actions = document.createElement('div');
    actions.className = 'mactions';
    const def = document.createElement('button');
    def.textContent = m.id === defaultId ? '★ Default' : 'Make default';
    def.disabled = m.id === defaultId;
    onAsync(def, 'click', async () => {
        try {
            await apiJson('/api/models/default', { method: 'PUT', body: { model_id: m.id } });
            showToast('Default set', { kind: 'success' });
            void renderModels();
        }
        catch (err) {
            toastError(err, 'Could not set default');
        }
    });
    actions.appendChild(def);
    row.append(head, meta, actions);
    return row;
}
/** One reachability probe per unique endpoint; every row's dot gets the verdict. */
async function probeRosterDots(pane, models) {
    const endpoints = [...new Set(models.filter((m) => m.endpoint).map((m) => m.endpoint.replace(/\/$/, '')))];
    await Promise.all(endpoints.map(async (ep) => {
        let verdict = 'bad';
        let detail = '';
        try {
            const r = (await apiJson('/api/models/reachability', { method: 'POST', body: { endpoint: ep } }));
            verdict = r.verdict === 'ok' ? 'ok' : r.verdict === 'skipped' ? 'skipped' : 'bad';
            detail = [r.detail || r.error, r.fix].filter(Boolean).join(' — ');
        }
        catch (err) {
            detail = err.message;
        }
        for (const el of pane.querySelectorAll(`.mdot[data-ep="${CSS.escape(ep)}"]`)) {
            if (verdict === 'skipped') {
                el.title = detail || 'Probe skipped';
                continue; // stays grey
            }
            el.classList.add(verdict);
            el.title = verdict === 'ok' ? 'Reachable' : `Unreachable${detail ? `: ${detail}` : ''}`;
        }
    }));
}
function buildCustomEndpoint(rosterKeys) {
    const box = document.createElement('div');
    box.className = 'mrow mcreate';
    const endpoint = document.createElement('input');
    endpoint.placeholder = 'http://host:port';
    endpoint.value = 'http://127.0.0.1:11434';
    const probe = document.createElement('button');
    probe.className = 'mprimary';
    probe.textContent = 'Probe';
    const results = document.createElement('div');
    results.className = 'mprobe-results';
    onAsync(probe, 'click', async () => {
        const ep = endpoint.value.trim().replace(/\/$/, '');
        if (!ep)
            return;
        probe.disabled = true;
        probe.textContent = 'Probing…';
        results.replaceChildren();
        try {
            // Pass 1 detects what is serving (ollama vs openai-compatible);
            // pass 2 is the model list that came back with it.
            const r = (await apiJson('/api/models/probe-endpoint', { method: 'POST', body: { endpoint: ep } }));
            const resolved = (r.endpoint ?? ep).replace(/\/$/, '');
            endpoint.value = resolved;
            const kindLine = document.createElement('div');
            kindLine.className = 'mrow-meta';
            kindLine.textContent = r.kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible';
            results.appendChild(kindLine);
            if (r.models.length === 0) {
                const none = document.createElement('div');
                none.className = 'mrow-meta';
                none.textContent = 'No models';
                results.appendChild(none);
            }
            for (const modelId of r.models) {
                const row = document.createElement('div');
                row.className = 'mrow-head';
                const nm = document.createElement('span');
                nm.className = 'mrow-name';
                nm.textContent = modelId;
                const inRoster = rosterKeys.has(`${resolved}|${modelId}`);
                if (inRoster) {
                    const mark = document.createElement('span');
                    mark.className = 'min-roster';
                    mark.textContent = '✓ in roster';
                    row.append(nm, mark);
                    results.appendChild(row);
                    continue;
                }
                const add = document.createElement('button');
                add.textContent = 'Add';
                onAsync(add, 'click', async () => {
                    add.disabled = true;
                    try {
                        await apiJson('/api/models', {
                            method: 'POST',
                            body: { name: modelId, kind: r.kind, endpoint: resolved, model_id: modelId },
                        });
                        showToast('Added', { kind: 'success' });
                        void renderModels();
                    }
                    catch (err) {
                        add.disabled = false;
                        toastError(err, 'Add failed');
                    }
                });
                row.append(nm, add);
                results.appendChild(row);
            }
        }
        catch (err) {
            toastError(err, 'Probe failed');
        }
        finally {
            probe.disabled = false;
            probe.textContent = 'Probe';
        }
    });
    const actions = document.createElement('div');
    actions.className = 'mactions';
    actions.append(endpoint, probe);
    box.append(actions, results);
    return box;
}
// ── Ollama section (lives inside the Models tab) ──────────────────────────────────────────────────────────────
async function renderOllamaInto(pane, rosterKeys) {
    pane.replaceChildren();
    try {
        const { hosts } = (await apiJson('/api/ollama/hosts'));
        const hostSel = document.createElement('select');
        for (const h of hosts) {
            const o = document.createElement('option');
            o.value = h;
            o.textContent = h;
            hostSel.appendChild(o);
        }
        hostSel.hidden = hosts.length < 2; // localhost-only: nothing to choose
        const list = document.createElement('div');
        list.className = 'mollama-list';
        const pullsBox = document.createElement('div');
        pullsBox.className = 'mollama-pulls';
        const refreshModels = async () => {
            try {
                const { models } = (await apiJson(`/api/ollama/models?host=${encodeURIComponent(hostSel.value)}`));
                list.replaceChildren(...models.map((mm) => {
                    const row = document.createElement('div');
                    row.className = 'mrow';
                    const head = document.createElement('div');
                    head.className = 'mrow-head';
                    const nm = document.createElement('span');
                    nm.className = 'mrow-name';
                    nm.textContent = `${mm.name}${mm.loaded ? ' · loaded' : ''}`;
                    const del = document.createElement('button');
                    del.className = 'mrow-del';
                    del.textContent = 'Delete';
                    onAsync(del, 'click', async () => {
                        if (!(await confirmDialog(`Delete ${mm.name} from ${hostSel.value}?`, 'Delete')))
                            return;
                        try {
                            await apiJson('/api/ollama/delete', {
                                method: 'POST',
                                body: { host: hostSel.value, model: mm.name },
                            });
                            void refreshModels();
                        }
                        catch (err) {
                            toastError(err, 'Delete failed');
                        }
                    });
                    const inRoster = rosterKeys.has(`${hostSel.value.replace(/\/$/, '')}|${mm.name}`);
                    if (inRoster) {
                        const mark = document.createElement('span');
                        mark.className = 'min-roster';
                        mark.textContent = '✓ in roster';
                        head.append(nm, mark, del);
                        const meta0 = document.createElement('div');
                        meta0.className = 'mrow-meta';
                        meta0.textContent = `${(mm.size / 1e9).toFixed(1)} GB`;
                        row.append(head, meta0);
                        return row;
                    }
                    const add = document.createElement('button');
                    add.textContent = 'Add';
                    onAsync(add, 'click', async () => {
                        add.disabled = true;
                        try {
                            await apiJson('/api/models', {
                                method: 'POST',
                                body: { name: mm.name, kind: 'ollama', endpoint: hostSel.value, model_id: mm.name },
                            });
                            showToast('Added', { kind: 'success' });
                            void renderModels();
                        }
                        catch (err) {
                            add.disabled = false;
                            toastError(err, 'Add failed');
                        }
                    });
                    head.append(nm, add, del);
                    const meta = document.createElement('div');
                    meta.className = 'mrow-meta';
                    meta.textContent = `${(mm.size / 1e9).toFixed(1)} GB`;
                    row.append(head, meta);
                    return row;
                }));
                if (models.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'mrow-meta';
                    empty.textContent = 'No models';
                    list.appendChild(empty);
                }
            }
            catch (err) {
                list.replaceChildren();
                const bad = document.createElement('div');
                bad.className = 'mrow-meta';
                const local = /127\.0\.0\.1|localhost/.test(hostSel.value);
                bad.textContent = local ? 'Not running' : `Host unreachable: ${err.message}`;
                list.appendChild(bad);
                if (local)
                    void offerLocalInstall(list, refreshModels);
            }
        };
        hostSel.addEventListener('change', () => void refreshModels());
        // Pull form, prefilled from the hardware recommendation.
        const pullInput = document.createElement('input');
        // Model names in this pane are .mrow-name at weight 600; the field you type
        // one into was the exception.
        pullInput.className = 'model-input';
        pullInput.placeholder = 'Model';
        void apiJson('/api/ollama/recommend')
            .then((r) => {
            if (r.model && !pullInput.value)
                pullInput.placeholder = r.model;
        })
            .catch(() => { });
        const pullBtn = document.createElement('button');
        pullBtn.className = 'mprimary';
        pullBtn.textContent = 'Pull';
        onAsync(pullBtn, 'click', async () => {
            const model = pullInput.value.trim() || pullInput.placeholder.match(/recommended: (.+)\)/)?.[1] || '';
            if (!model)
                return;
            try {
                await apiJson('/api/ollama/pull', { method: 'POST', body: { host: hostSel.value, model } });
                pullInput.value = '';
            }
            catch (err) {
                toastError(err, 'Pull failed to start');
            }
        });
        const refreshedFor = new Set(); // pulls whose success already triggered one refresh
        const refreshPulls = async () => {
            try {
                const { pulls } = (await apiJson('/api/ollama/pulls'));
                pullsBox.replaceChildren(...pulls.map((p) => {
                    const row = document.createElement('div');
                    row.className = 'mpull';
                    const pct = p.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : null;
                    row.textContent =
                        p.status === 'error'
                            ? `✗ ${p.model} — ${p.error ?? 'failed'}`
                            : p.status === 'success'
                                ? `✓ ${p.model} pulled`
                                : p.status === 'cancelled'
                                    ? `— ${p.model} cancelled`
                                    : `↓ ${p.model} ${pct !== null ? `${pct}%` : p.status}`;
                    if (p.status === 'pulling') {
                        const cancel = document.createElement('button');
                        cancel.textContent = 'Cancel';
                        onAsync(cancel, 'click', async () => {
                            await apiJson('/api/ollama/pull/cancel', {
                                method: 'POST',
                                body: { host: p.host, model: p.model },
                            }).catch(() => { });
                        });
                        row.appendChild(cancel);
                    }
                    return row;
                }));
                // Edge-trigger: refresh once when a pull first reaches success, not on
                // every tick while it sits in the server's 10-minute finished list.
                const fresh = pulls.filter((p) => p.status === 'success' && !refreshedFor.has(`${p.host}|${p.model}`));
                if (fresh.length > 0) {
                    for (const p of fresh)
                        refreshedFor.add(`${p.host}|${p.model}`);
                    void refreshModels();
                }
            }
            catch {
                /* transient */
            }
        };
        if (pullTimer)
            clearInterval(pullTimer);
        pullTimer = setInterval(() => void refreshPulls(), 1500);
        const pullForm = document.createElement('div');
        pullForm.className = 'mactions';
        pullForm.append(pullInput, pullBtn);
        pane.append(hostSel, list, pullForm, pullsBox);
        void refreshModels();
        void refreshPulls();
    }
    catch (err) {
        toastError(err, 'Could not load Ollama hosts');
    }
}
/** Local Ollama is down: if the host can install it, offer a one-click install. */
async function offerLocalInstall(list, onReady) {
    try {
        const state = (await apiJson('/api/ollama/local'));
        if (state.reachable || !state.canInstall)
            return;
        const btn = document.createElement('button');
        btn.className = 'mprimary';
        btn.textContent = 'Install Ollama';
        onAsync(btn, 'click', async () => {
            btn.disabled = true;
            btn.textContent = 'Installing…';
            try {
                await apiJson('/api/ollama/install', { method: 'POST', body: {} });
            }
            catch (err) {
                btn.disabled = false;
                btn.textContent = 'Install Ollama';
                toastError(err, 'Install failed to start');
                return;
            }
            // Poll until the local daemon answers — or the installer exits nonzero,
            // in which case surface why instead of spinning out the full window.
            for (let i = 0; i < 200; i++) {
                await new Promise((r) => setTimeout(r, 3000));
                try {
                    const st = (await apiJson('/api/ollama/local'));
                    if (st.reachable) {
                        showToast('Ollama is running', { kind: 'success' });
                        btn.remove();
                        void onReady();
                        return;
                    }
                    if (!st.running && st.exitCode !== null && st.exitCode !== undefined && st.exitCode !== 0) {
                        const lastLine = (st.lines ?? []).filter((l) => l.trim()).pop() ?? '';
                        btn.disabled = false;
                        btn.textContent = 'Install Ollama';
                        showToast(`Install failed (exit ${st.exitCode})${lastLine ? `: ${lastLine}` : ''}`, { kind: 'error' });
                        return;
                    }
                }
                catch {
                    /* transient */
                }
            }
            btn.disabled = false;
            btn.textContent = 'Install Ollama';
            showToast('Install timed out', { kind: 'error' });
        });
        list.appendChild(btn);
    }
    catch {
        /* state endpoint unavailable — leave the plain unreachable note */
    }
}
