// ── Management drawer: Agents / Models / Ollama ──────────────────────────────
// The whole admin surface in one slide-over panel. Rendering is repaint-on-
// action (each mutation re-fetches its tab) — at this scale the simplicity
// beats diffing. Everything else administrative lives in ncl.
import { $ } from '../core/dom.js';
import { apiJson } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';
let open = false;
let pullTimer = null;
export function wireManage() {
    $('#manage-btn').addEventListener('click', () => (open ? closeDrawer() : openDrawer()));
    $('#manage-close').addEventListener('click', closeDrawer);
    for (const tab of ['agents', 'models', 'ollama']) {
        $(`#mtab-${tab}`).addEventListener('click', () => showTab(tab));
    }
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
    for (const t of ['agents', 'models', 'ollama']) {
        $(`#mtab-${t}`).classList.toggle('active', t === tab);
        $(`#mpane-${t}`).hidden = t !== tab;
    }
    if (pullTimer) {
        clearInterval(pullTimer);
        pullTimer = null;
    }
    if (tab === 'agents')
        void renderAgents();
    else if (tab === 'models')
        void renderModels();
    else
        void renderOllama();
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
    row.append(head, modelSel, rooms);
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
async function renderModels() {
    const pane = $('#mpane-models');
    try {
        const data = (await apiJson('/api/models'));
        pane.replaceChildren(buildModelCreate(data.known_anthropic), ...data.models.map((m) => buildModelRow(m, data.default_model_id)));
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
    const name = document.createElement('span');
    name.className = 'mrow-name';
    name.textContent = m.name;
    const del = document.createElement('button');
    del.className = 'mrow-del';
    del.textContent = 'Delete';
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
    head.append(name, del);
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
    if (m.endpoint) {
        const reach = document.createElement('button');
        reach.textContent = 'Check reachability';
        reach.addEventListener('click', async () => {
            reach.disabled = true;
            reach.textContent = 'Checking…';
            try {
                const r = (await apiJson('/api/models/reachability', {
                    method: 'POST',
                    body: { endpoint: m.endpoint },
                }));
                const good = r.ok ?? r.reachable;
                showToast(good ? 'Reachable from agent containers' : `Unreachable: ${r.detail || r.error || 'no route'}`, {
                    kind: good ? 'success' : 'error',
                });
            }
            catch (err) {
                toastError(err, 'Probe failed');
            }
            finally {
                reach.disabled = false;
                reach.textContent = 'Check reachability';
            }
        });
        actions.appendChild(reach);
    }
    row.append(head, meta, actions);
    return row;
}
function buildModelCreate(knownAnthropic) {
    const box = document.createElement('div');
    box.className = 'mrow mcreate';
    const title = document.createElement('div');
    title.className = 'mrow-name';
    title.textContent = 'Add model';
    const name = document.createElement('input');
    name.placeholder = 'Display name';
    const kind = document.createElement('select');
    for (const k of ['anthropic', 'ollama', 'openai-compatible']) {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = k;
        kind.appendChild(o);
    }
    const endpoint = document.createElement('input');
    endpoint.placeholder = 'Endpoint (http://host:11434) — not needed for anthropic';
    const modelId = document.createElement('input');
    modelId.placeholder = 'Model id (e.g. qwen3:8b)';
    modelId.setAttribute('list', 'known-anthropic');
    const datalist = document.createElement('datalist');
    datalist.id = 'known-anthropic';
    for (const k of knownAnthropic) {
        const o = document.createElement('option');
        o.value = k;
        datalist.appendChild(o);
    }
    const discover = document.createElement('button');
    discover.textContent = 'Discover models';
    discover.addEventListener('click', async () => {
        const ep = endpoint.value.trim();
        if (!ep) {
            showToast('Enter the endpoint first', { kind: 'error' });
            return;
        }
        discover.disabled = true;
        try {
            const { models } = (await apiJson('/api/models/discover', { method: 'POST', body: { endpoint: ep } }));
            datalist.replaceChildren(...models.map((mm) => {
                const o = document.createElement('option');
                o.value = mm;
                return o;
            }));
            showToast(models.length ? `${models.length} models on that host — pick in the model-id box` : 'Host has no models', {
                kind: 'info',
            });
        }
        catch (err) {
            toastError(err, 'Discovery failed');
        }
        finally {
            discover.disabled = false;
        }
    });
    const add = document.createElement('button');
    add.className = 'mprimary';
    add.textContent = 'Add model';
    add.addEventListener('click', async () => {
        add.disabled = true;
        try {
            await apiJson('/api/models', {
                method: 'POST',
                body: {
                    name: name.value.trim() || modelId.value.trim(),
                    kind: kind.value,
                    endpoint: endpoint.value.trim() || undefined,
                    model_id: modelId.value.trim(),
                },
            });
            showToast('Model added', { kind: 'success' });
            name.value = '';
            modelId.value = '';
            void renderModels();
        }
        catch (err) {
            toastError(err, 'Add failed');
        }
        finally {
            add.disabled = false;
        }
    });
    const actions = document.createElement('div');
    actions.className = 'mactions';
    actions.append(discover, add);
    box.append(title, name, kind, endpoint, modelId, datalist, actions);
    return box;
}
// ── Ollama tab ──────────────────────────────────────────────────────────────
async function renderOllama() {
    const pane = $('#mpane-ollama');
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
                    head.append(nm, del);
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
                bad.textContent = `Host unreachable: ${err.message}`;
                list.appendChild(bad);
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
                            : p.status === 'done'
                                ? `✓ ${p.model} pulled`
                                : `↓ ${p.model} ${pct !== null ? `${pct}%` : p.status}`;
                    if (p.status !== 'done' && p.status !== 'error') {
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
                if (pulls.some((p) => p.status === 'done'))
                    void refreshModels();
            }
            catch {
                /* transient */
            }
        };
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
