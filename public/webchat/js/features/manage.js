// ── Management drawer: Agents / Models / Ollama ──────────────────────────────
// The whole admin surface in one slide-over panel. Rendering is repaint-on-
// action (each mutation re-fetches its tab) — at this scale the simplicity
// beats diffing. Everything else administrative lives in ncl.
import { $ } from '../core/dom.js';
import { apiJson } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';
import { launchWizard } from './wizard.js';
let open = false;
let pullTimer = null;
export function wireManage() {
    $('#manage-btn').addEventListener('click', () => (open ? closeDrawer() : openDrawer()));
    $('#manage-close').addEventListener('click', closeDrawer);
    for (const tab of ['agents', 'models']) {
        $(`#mtab-${tab}`).addEventListener('click', () => showTab(tab));
    }
    $('#wizard-btn').addEventListener('click', () => {
        closeDrawer();
        void launchWizard();
    });
}
function openDrawer() {
    open = true;
    $('#manage').classList.add('open');
    showTab('agents');
}
function closeDrawer() {
    open = false;
    $('#manage').classList.remove('open');
    if (pullTimer) {
        clearInterval(pullTimer);
        pullTimer = null;
    }
}
function showTab(tab) {
    for (const t of ['agents', 'models']) {
        $(`#mtab-${t}`).classList.toggle('active', t === tab);
        $(`#mpane-${t}`).hidden = t !== tab;
    }
    if (pullTimer) {
        clearInterval(pullTimer);
        pullTimer = null;
    }
    if (tab === 'agents')
        void renderAgents();
    else
        void renderModels();
}
// ── Agents tab ──────────────────────────────────────────────────────────────
async function renderAgents() {
    const pane = $('#mpane-agents');
    try {
        const [detail, modelsRes] = await Promise.all([
            apiJson('/api/agents/detail'),
            apiJson('/api/models'),
        ]);
        pane.replaceChildren(buildAgentCreate(), ...detail.agents.map((a) => buildAgentRow(a, modelsRes.models)));
    }
    catch (err) {
        toastError(err, 'Could not load agents');
    }
}
function buildAgentRow(a, models) {
    const row = document.createElement('div');
    row.className = 'mrow';
    const head = document.createElement('div');
    head.className = 'mrow-head';
    const name = document.createElement('span');
    name.className = 'mrow-name';
    name.textContent = a.name;
    const del = document.createElement('button');
    del.className = 'mrow-del';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
        if (!confirm(`Delete agent "${a.name}"? Its rooms stay but stop routing to it.`))
            return;
        try {
            await apiJson(`/api/agents/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
            showToast(`Deleted ${a.name}`, { kind: 'success' });
            void renderAgents();
        }
        catch (err) {
            toastError(err, 'Delete failed');
        }
    });
    head.append(name, del);
    const modelSel = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Default model';
    modelSel.appendChild(none);
    for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name} (${m.kind})`;
        if (m.id === a.model_id)
            opt.selected = true;
        modelSel.appendChild(opt);
    }
    modelSel.addEventListener('change', async () => {
        try {
            await apiJson(`/api/agents/${encodeURIComponent(a.id)}/model`, {
                method: 'PUT',
                body: { model_id: modelSel.value || null },
            });
            showToast('Model updated — takes effect on the next turn', { kind: 'success' });
        }
        catch (err) {
            toastError(err, 'Model change failed');
            void renderAgents();
        }
    });
    const rooms = document.createElement('div');
    rooms.className = 'mrow-meta';
    rooms.textContent = a.rooms.length ? `Rooms: ${a.rooms.map((r) => r.name).join(', ')}` : 'Not wired to any room';
    // Standing instructions (instructions.prepend.md), collapsed behind a toggle.
    const instrBox = document.createElement('div');
    instrBox.hidden = true;
    const instrBtn = document.createElement('button');
    instrBtn.textContent = 'Instructions';
    instrBtn.addEventListener('click', async () => {
        if (!instrBox.hidden) {
            instrBox.hidden = true;
            return;
        }
        instrBtn.disabled = true;
        try {
            const { instructions } = (await apiJson(`/api/agents/${encodeURIComponent(a.id)}/instructions`));
            const ta = document.createElement('textarea');
            ta.rows = 6;
            ta.value = instructions;
            ta.placeholder = 'Standing instructions for this agent (markdown)';
            const save = document.createElement('button');
            save.className = 'mprimary';
            save.textContent = 'Save';
            save.addEventListener('click', async () => {
                save.disabled = true;
                try {
                    await apiJson(`/api/agents/${encodeURIComponent(a.id)}/instructions`, {
                        method: 'PUT',
                        body: { instructions: ta.value },
                    });
                    showToast('Saved — applies on the agent\u2019s next session', { kind: 'success' });
                    instrBox.hidden = true;
                }
                catch (err) {
                    toastError(err, 'Save failed');
                }
                finally {
                    save.disabled = false;
                }
            });
            const actions = document.createElement('div');
            actions.className = 'mactions';
            actions.appendChild(save);
            instrBox.replaceChildren(ta, actions);
            instrBox.hidden = false;
        }
        catch (err) {
            toastError(err, 'Could not load instructions');
        }
        finally {
            instrBtn.disabled = false;
        }
    });
    const instrRow = document.createElement('div');
    instrRow.className = 'mactions';
    instrRow.appendChild(instrBtn);
    row.append(head, modelSel, instrRow, instrBox, rooms);
    return row;
}
function buildAgentCreate() {
    const box = document.createElement('div');
    box.className = 'mrow mcreate';
    const title = document.createElement('div');
    title.className = 'mrow-name';
    title.textContent = 'New agent';
    const name = document.createElement('input');
    name.placeholder = 'Name';
    name.maxLength = 60;
    const instructions = document.createElement('textarea');
    instructions.placeholder = 'Instructions (optional — what should this agent be?)';
    instructions.rows = 3;
    const draftBtn = document.createElement('button');
    draftBtn.textContent = '✨ Suggest from prompt';
    draftBtn.addEventListener('click', async () => {
        const prompt = instructions.value.trim() || name.value.trim();
        if (!prompt) {
            showToast('Describe the agent first — a name or a sentence in the instructions box', { kind: 'error' });
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
            toastError(err, 'Drafting failed');
        }
        finally {
            draftBtn.disabled = false;
            draftBtn.textContent = '✨ Suggest from prompt';
        }
    });
    const create = document.createElement('button');
    create.className = 'mprimary';
    create.textContent = 'Create agent';
    create.addEventListener('click', async () => {
        const n = name.value.trim();
        if (!n)
            return;
        create.disabled = true;
        try {
            await apiJson('/api/agents', {
                method: 'POST',
                body: { name: n, instructions: instructions.value.trim() || undefined },
            });
            showToast(`Created ${n} — wire it to a room to start chatting`, { kind: 'success' });
            name.value = '';
            instructions.value = '';
            void renderAgents();
        }
        catch (err) {
            toastError(err, 'Create failed');
        }
        finally {
            create.disabled = false;
        }
    });
    const actions = document.createElement('div');
    actions.className = 'mactions';
    actions.append(draftBtn, create);
    box.append(title, name, instructions, actions);
    return box;
}
// ── Models tab ──────────────────────────────────────────────────────────────
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
        const rows = data.models.map((m) => buildModelRow(m, data.default_model_id));
        if (rows.length === 0) {
            // Empty roster is not "no model": agents fall through to the provider's
            // built-in Claude default. Say so instead of implying nothing works.
            const builtin = document.createElement('div');
            builtin.className = 'mrow';
            const head = document.createElement('div');
            head.className = 'mrow-head';
            const dot = document.createElement('span');
            dot.className = 'mdot ok';
            dot.title = 'Cloud (Anthropic)';
            const nm = document.createElement('span');
            nm.className = 'mrow-name';
            nm.textContent = 'Claude — built-in default';
            head.append(dot, nm);
            builtin.append(head);
            rows.push(builtin);
        }
        pane.replaceChildren(msection('Your models'), ...rows, msection('On this machine'), ollamaBox, msection('Add custom endpoint'), buildCustomEndpoint(rosterKeys));
        void renderOllamaInto(ollamaBox, rosterKeys);
        void probeRosterDots(pane, data.models);
    }
    catch (err) {
        toastError(err, 'Could not load models');
    }
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
    const name = document.createElement('span');
    name.className = 'mrow-name';
    name.textContent = m.name;
    const del = document.createElement('button');
    del.className = 'mrow-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Delete ${m.name}`);
    del.title = 'Remove from roster';
    del.addEventListener('click', async () => {
        try {
            await apiJson(`/api/models/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
            void renderModels();
        }
        catch (err) {
            const body = err.body;
            if (body?.agents?.length) {
                if (confirm(`Assigned to: ${body.agents.join(', ')}. Delete anyway (they fall back to the default)?`)) {
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
    def.addEventListener('click', async () => {
        try {
            await apiJson('/api/models/default', { method: 'PUT', body: { model_id: m.id } });
            showToast('Default model updated', { kind: 'success' });
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
            el.title =
                verdict === 'ok' ? 'Reachable from agent containers' : `Unreachable${detail ? `: ${detail}` : ''}`;
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
    probe.addEventListener('click', async () => {
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
            kindLine.textContent =
                r.kind === 'ollama' ? 'Detected: Ollama' : 'Detected: OpenAI-compatible (LiteLLM, vLLM, …)';
            results.appendChild(kindLine);
            if (r.models.length === 0) {
                const none = document.createElement('div');
                none.className = 'mrow-meta';
                none.textContent = 'The server answered but lists no models.';
                results.appendChild(none);
            }
            for (const modelId of r.models) {
                const row = document.createElement('div');
                row.className = 'mrow-head';
                const nm = document.createElement('span');
                nm.className = 'mrow-name';
                nm.textContent = modelId;
                const inRoster = rosterKeys.has(`${resolved}|${modelId}`);
                const add = document.createElement('button');
                add.textContent = inRoster ? 'In roster' : 'Add';
                add.disabled = inRoster;
                add.addEventListener('click', async () => {
                    add.disabled = true;
                    try {
                        await apiJson('/api/models', {
                            method: 'POST',
                            body: { name: modelId, kind: r.kind, endpoint: resolved, model_id: modelId },
                        });
                        showToast('Added to roster', { kind: 'success' });
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
                    del.addEventListener('click', async () => {
                        if (!confirm(`Remove ${mm.name} from ${hostSel.value}?`))
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
                    const add = document.createElement('button');
                    add.textContent = inRoster ? 'In roster' : 'Add to roster';
                    add.disabled = inRoster;
                    add.addEventListener('click', async () => {
                        add.disabled = true;
                        try {
                            await apiJson('/api/models', {
                                method: 'POST',
                                body: { name: mm.name, kind: 'ollama', endpoint: hostSel.value, model_id: mm.name },
                            });
                            showToast('Added to roster', { kind: 'success' });
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
                    empty.textContent = 'No models on this host yet — pull one below.';
                    list.appendChild(empty);
                }
            }
            catch (err) {
                list.replaceChildren();
                const bad = document.createElement('div');
                bad.className = 'mrow-meta';
                const local = /127\.0\.0\.1|localhost/.test(hostSel.value);
                bad.textContent = local
                    ? 'Ollama is not running on this machine.'
                    : `Host unreachable: ${err.message}`;
                list.appendChild(bad);
                if (local)
                    void offerLocalInstall(list, refreshModels);
            }
        };
        hostSel.addEventListener('change', () => void refreshModels());
        // Pull form, prefilled from the hardware recommendation.
        const pullInput = document.createElement('input');
        pullInput.placeholder = 'Model to pull (e.g. qwen3:8b)';
        void apiJson('/api/ollama/recommend')
            .then((r) => {
            if (r.model && !pullInput.value)
                pullInput.placeholder = `Model to pull (recommended: ${r.model})`;
        })
            .catch(() => { });
        const pullBtn = document.createElement('button');
        pullBtn.className = 'mprimary';
        pullBtn.textContent = 'Pull';
        pullBtn.addEventListener('click', async () => {
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
                        cancel.addEventListener('click', async () => {
                            await apiJson('/api/ollama/pull/cancel', {
                                method: 'POST',
                                body: { host: p.host, model: p.model },
                            }).catch(() => { });
                        });
                        row.appendChild(cancel);
                    }
                    return row;
                }));
                if (pulls.some((p) => p.status === 'success'))
                    void refreshModels();
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
        btn.textContent = 'Install Ollama on this machine';
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Installing… (a few minutes)';
            try {
                await apiJson('/api/ollama/install', { method: 'POST', body: {} });
            }
            catch (err) {
                btn.disabled = false;
                btn.textContent = 'Install Ollama on this machine';
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
                        btn.textContent = 'Install Ollama on this machine';
                        showToast(`Install failed (exit ${st.exitCode})${lastLine ? `: ${lastLine}` : ''}`, { kind: 'error' });
                        return;
                    }
                }
                catch {
                    /* transient */
                }
            }
            btn.disabled = false;
            btn.textContent = 'Install Ollama on this machine';
            showToast('Install is taking unusually long — check the host logs', { kind: 'error' });
        });
        list.appendChild(btn);
    }
    catch {
        /* state endpoint unavailable — leave the plain unreachable note */
    }
}
