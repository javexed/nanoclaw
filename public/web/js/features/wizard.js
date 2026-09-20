// ── First-run wizard ─────────────────────────────────────────────────────────
// Four steps: engine → (local) model → access → first agent. The predecessor's
// wizard was 1,890 lines, most of it for providers this build dropped; this
// one is the walk a fresh install actually needs. Auto-opens when onboarding
// is incomplete AND nothing exists yet; every step is skippable, and Finish
// just records completion.
import { $ } from '../core/dom.js';
import { apiJson } from '../core/api.js';
import { confirmDialog } from '../core/confirm.js';
import { showToast, toastError } from '../core/toast.js';
let step = 0;
let state = null;
/** The engine picked in step 1 — steers whether step 2 (local model) shows. */
let engine = 'claude';
let access = null;
let pullTimer = null;
export async function maybeOpenWizard() {
    try {
        state = (await apiJson('/api/web/onboarding'));
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
        state = (await apiJson('/api/web/onboarding'));
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
    // Deliberately NOT cleared in render(): the harness install outlives a step
    // change (it rebuilds an image — minutes), so moving through the wizard must
    // not stop it reporting. Closing the wizard does.
    if (harnessTimer) {
        clearInterval(harnessTimer);
        harnessTimer = null;
    }
    $('#wizard').hidden = true;
}
async function finish() {
    await apiJson('/api/web/onboarding', { method: 'PUT', body: { complete: true } }).catch(() => { });
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
/** Clipboard write with an execCommand fallback — navigator.clipboard is
 *  undefined outside secure contexts (plain-HTTP LAN access). */
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    }
    catch {
        /* fall through */
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    }
    catch {
        return false;
    }
}
function heading(text) {
    const h = document.createElement('h3');
    h.textContent = text;
    return h;
}
/**
 * Accordion cards for a one-of-few choice: the selected card holds its own
 * setup body, so toggling expands in place instead of shuffling content
 * below the cards. A card without a body just selects.
 */
function choiceCards(current, set, items) {
    const choices = document.createElement('div');
    choices.className = 'wiz-choices';
    for (const it of items) {
        const c = document.createElement('div');
        c.className = 'wiz-choice' + (current === it.id ? ' selected' : '');
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'wiz-choice-head';
        const title = document.createElement('div');
        title.className = 'wiz-choice-title';
        title.textContent = it.title;
        head.append(title);
        if (it.desc) {
            const d = document.createElement('div');
            d.className = 'wiz-choice-desc';
            d.textContent = it.desc;
            head.append(d);
        }
        head.onclick = () => {
            if (current !== it.id) {
                set(it.id);
                render();
            }
        };
        c.appendChild(head);
        if (current === it.id && it.body) {
            const b = it.body();
            b.classList.add('wiz-choice-body');
            c.appendChild(b);
        }
        choices.appendChild(c);
    }
    return choices;
}
// ── Step: engine ────────────────────────────────────────────────────────────
function renderEngine() {
    const box = document.createElement('div');
    box.append(heading('Model'));
    const choices = choiceCards(engine, (id) => (engine = id), [
        { id: 'claude', title: 'Claude', body: renderClaudeAuth },
        { id: 'local', title: 'Local (Ollama)', body: buildLocalModels },
    ]);
    box.append(choices, nav({}));
    return box;
}
// The in-flight sign-in, so a re-render mid-flow keeps the URL + code box.
let claudeSignin = null;
function renderClaudeAuth() {
    const box = document.createElement('div');
    box.className = 'wiz-auth';
    const connected = Boolean(state?.claude.connected);
    // Integrations-row style (as the predecessor web renders credentials):
    // leading status dot + text that carries the state (screen readers and
    // colour-blind users get the words, not just the dot), action right-aligned.
    const rowEl = document.createElement('div');
    rowEl.className = 'wiz-creds-row';
    const status = document.createElement('span');
    status.className = 'wiz-creds-status' + (connected ? ' is-connected' : '');
    status.textContent = connected ? 'Connected' : 'Not connected';
    const action = document.createElement('button');
    action.textContent = connected ? 'Reconnect' : 'Connect';
    if (!connected)
        action.className = 'mprimary';
    action.onclick = async () => {
        action.disabled = true;
        action.textContent = 'Starting…';
        try {
            claudeSignin = (await apiJson('/api/web/claude-auth/start', { method: 'POST', body: {} }));
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
    link.textContent = 'Sign in ↗';
    const codeInput = document.createElement('input');
    codeInput.placeholder = 'Code';
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
            await apiJson('/api/web/claude-auth/code', {
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
            void apiJson('/api/web/claude-auth/cancel', {
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
// ── The harness a local model runs on ───────────────────────────────────────
// A local model needs OpenCode. Without it models.ts writes NO env for a
// non-anthropic kind, so the agent quietly keeps answering from Claude: the
// roster row exists, the default is set, and nothing works differently. This
// row is the only place the install is ever mentioned, so it says what is
// happening rather than sitting silent.
/**
 * Status on the left, the action on the right — the same shape the Claude
 * credentials row uses, because it is the same kind of row: a thing that is
 * either set up or has one button to set it up.
 */
const harnessRow = document.createElement('div');
harnessRow.className = 'wiz-creds-row';
const harnessText = document.createElement('span');
harnessText.className = 'wiz-text';
const harnessBtn = document.createElement('button');
harnessBtn.type = 'button';
harnessRow.append(harnessText, harnessBtn);
let harnessTimer = null;
function renderHarness(h) {
    if (h.installed) {
        harnessText.textContent = '✓ OpenCode installed — local models run on it.';
        harnessBtn.hidden = true;
        return;
    }
    if (h.running) {
        // The last line of the stream, not the whole log: this runs a skill apply,
        // a host build and an image rebuild, and a wizard step is not a terminal.
        const last = h.lines[h.lines.length - 1] ?? 'starting…';
        harnessText.textContent = `Installing the OpenCode harness — ${last}`;
        harnessBtn.hidden = false;
        harnessBtn.disabled = true;
        harnessBtn.textContent = 'Installing…';
        return;
    }
    harnessBtn.hidden = !h.canInstall;
    harnessBtn.disabled = false;
    harnessBtn.textContent = 'Install OpenCode';
    if (h.exitCode !== null && h.exitCode !== 0) {
        harnessText.textContent = `OpenCode install failed: ${h.lines[h.lines.length - 1] ?? `exit ${h.exitCode}`}`;
        // Offered again rather than latched off — most failures here are a missing
        // daemon or a network blip, and the log line above says which.
        harnessBtn.textContent = 'Retry install';
        return;
    }
    // Say what it IS and what its absence costs. "Needs the OpenCode harness"
    // named a missing part without saying what the part does, or that skipping
    // it leaves a local model selected and unused — the silent failure this
    // whole row exists to prevent.
    const what = 'OpenCode is the harness that runs local models — without it your pick is saved but Claude still answers.';
    harnessText.textContent = h.canInstall ? what : `${what} ${h.reason ?? ''}`.trim();
}
/** Read the live state into the row. Cheap: the server caches its docker probe. */
async function refreshHarness() {
    try {
        const h = (await apiJson('/api/web/opencode'));
        renderHarness(h);
        if (h.running)
            pollHarness();
        if (state)
            state.opencode.installed = h.installed;
    }
    catch {
        /* leave the row showing what the wizard was opened with */
    }
}
/**
 * The button. This applies a skill, rebuilds the host, rebuilds the ~2.6GB
 * agent image and restarts the service, so it asks first — with confirmDialog,
 * the same prompt that guards deleting a model or a room.
 *
 * Deliberately NOT the two-click arm the bearer-token button uses. That guard
 * is for an action that is irreversible from the UI and changes who can reach
 * the install (generate flips WEB_HOST to 0.0.0.0 and the endpoint then refuses
 * to run again). This one is disruptive but reversible — the skill ships a
 * REMOVE.md and re-running is idempotent — and a changing button label is a
 * worse way to state a consequence than a sentence with a Cancel next to it.
 */
harnessBtn.onclick = async () => {
    const ok = await confirmDialog('Install OpenCode?\n\nIt is the harness that runs local models — Ollama and other OpenAI-compatible endpoints. ' +
        'Until it is installed, choosing a local model changes nothing: the choice is saved and Claude keeps answering.' +
        '\n\nInstalling rebuilds NanoClaw and its agent image, then restarts the service. It takes a few minutes and the web UI will drop briefly.', 'Install');
    if (!ok)
        return;
    harnessBtn.disabled = true;
    harnessBtn.textContent = 'Installing…';
    try {
        await apiJson('/api/web/opencode/install', { method: 'POST' });
    }
    catch (err) {
        // 409 means it is already running or already installed — both are states
        // the poll below reports correctly, so only a real failure surfaces here.
        toastError(err, 'Could not start the OpenCode install');
    }
    pollHarness();
};
function pollHarness() {
    if (harnessTimer)
        clearInterval(harnessTimer);
    harnessTimer = setInterval(async () => {
        let h;
        try {
            h = (await apiJson('/api/web/opencode'));
        }
        catch {
            return; // the host restarts at the end of the install — a gap is expected
        }
        renderHarness(h);
        if (!h.running) {
            if (harnessTimer)
                clearInterval(harnessTimer);
            harnessTimer = null;
            if (state)
                state.opencode.installed = h.installed;
            if (h.installed)
                showToast('OpenCode harness ready', { kind: 'success' });
        }
    }, 2000);
}
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
    installBtn.textContent = state?.ollama.canInstall ? 'Install Ollama' : 'Not detected';
    installBtn.disabled = !state?.ollama.canInstall;
    installBtn.onclick = async () => {
        installBtn.disabled = true;
        installBtn.textContent = 'Installing…';
        installErr.textContent = '';
        await apiJson('/api/ollama/install', { method: 'POST' }).catch((e) => toastError(e, 'Install failed to start'));
        if (pullTimer)
            clearInterval(pullTimer);
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
                installBtn.textContent = 'Install Ollama';
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
            showToast(`Default: ${modelId}`, { kind: 'success' });
            // Picking the model is only half of it — without the OpenCode harness a
            // local model produces no env at all and the agent keeps answering from
            // Claude, silently. Refresh the row so the button is right there saying
            // so; installing is the operator's click, not a side effect of choosing.
            void refreshHarness();
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
        statusLine.className = 'wiz-text';
        try {
            const r = (await apiJson('/api/models/probe-endpoint', { method: 'POST', body: { endpoint: ep } }));
            const resolved = (r.endpoint ?? ep).replace(/\/$/, '');
            probed = { kind: r.kind, endpoint: resolved };
            urlInput.value = resolved; // reflect what actually answered
            // Mark the current default's radio when it lives on this endpoint.
            const roster = (await apiJson('/api/models').catch(() => null));
            const def = roster?.models.find((m) => m.id === roster.default_model_id);
            const checkedId = def && (def.endpoint ?? '').replace(/\/$/, '') === probed.endpoint ? def.model_id : null;
            renderList(r.models, checkedId);
            const n = r.models.length;
            const kindName = r.kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible server';
            statusLine.className = 'wiz-creds-status is-connected';
            statusLine.textContent = n === 0 ? `${kindName} — no models` : `${kindName} — ${n} model${n === 1 ? '' : 's'}`;
            pullRow.hidden = r.kind !== 'ollama' || !isLocal();
        }
        catch (err) {
            probed = null;
            renderList([], null);
            statusLine.className = 'wiz-text wiz-err';
            statusLine.textContent = err.message;
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
    // Same weight as the list above it: this field holds the same kind of value
    // the radios do — a model name — and it sat a weight lighter than the models
    // it sits under.
    pullInput.className = 'model-input';
    pullInput.placeholder = 'Model';
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
            if (pullTimer)
                clearInterval(pullTimer);
            pullTimer = setInterval(async () => {
                const { pulls } = (await apiJson('/api/ollama/pulls').catch(() => ({ pulls: [] })));
                const p = pulls.find((x) => x.model.includes(model));
                if (!p)
                    return;
                if (p.status === 'success') {
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
                else if (p.status === 'error' || p.status === 'cancelled') {
                    if (pullTimer) {
                        clearInterval(pullTimer);
                        pullTimer = null;
                    }
                    progress.textContent =
                        p.status === 'cancelled' ? 'Pull cancelled.' : `Pull failed: ${p.error ?? 'unknown error'}`;
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
    box.append(urlRow, installRow, statusLine, list, pullRow, progress, harnessRow);
    // Auto-query on step entry when the local daemon is already up.
    if (state?.ollama.reachable)
        void probe();
    else
        pullRow.hidden = true;
    if (state)
        renderHarness({ ...state.opencode, running: false, lines: [], exitCode: null });
    void refreshHarness(); // an install may already be running from an earlier visit
    return box;
}
// ── Step: access ────────────────────────────────────────────────────────────
function renderAccess() {
    const box = document.createElement('div');
    box.append(heading('Access'));
    // First render: the install's current state picks the card.
    if (access === null) {
        access = state?.tailscale.active ? 'tailscale' : state?.bearerConfigured ? 'token' : 'local';
    }
    // Titles only. Each of these had a second line explaining it ("Only this
    // computer. No login.") and the explanation was the same sentence as the
    // title with more words around it. The title now says the whole thing, and
    // the cards that need more — Tailscale, the token — say it in their body,
    // where it is tied to a button instead of floating above one.
    const choices = choiceCards(access, (id) => (access = id), [
        { id: 'local', title: 'Only from this device' },
        { id: 'token', title: 'Only from your network with a token', body: buildBearer },
        { id: 'tailscale', title: 'Tailscale', body: buildTailscale },
    ]);
    box.append(choices, nav({}));
    return box;
}
/** Tailscale card body: state + the one action that fits it. */
function buildTailscale() {
    const ts = document.createElement('div');
    // Integrations-row: dot + state text; an action button ONLY when there is an
    // action. 'Already serving' with a disabled enable-button read as broken.
    const tsRow = document.createElement('div');
    tsRow.className = 'wiz-creds-row';
    const tsStatus = document.createElement('span');
    tsStatus.className = 'wiz-creds-status';
    const tsHint = document.createElement('div');
    tsHint.className = 'mrow-meta';
    const showServing = (url) => {
        tsStatus.classList.add('is-connected');
        tsStatus.textContent = 'Serving';
        tsHint.replaceChildren();
        if (url) {
            const a = document.createElement('a');
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = url;
            tsHint.append(a);
        }
    };
    if (state?.tailscale.active) {
        showServing(state.tailscale.url);
        tsRow.appendChild(tsStatus);
    }
    else if (state?.tailscale.available) {
        tsStatus.textContent = 'Not serving';
        const tsBtn = document.createElement('button');
        tsBtn.className = 'mprimary';
        tsBtn.textContent = 'Enable';
        tsBtn.onclick = async () => {
            tsBtn.disabled = true;
            try {
                const r = (await apiJson('/api/web/tailscale-https', { method: 'POST' }));
                if (r.ok) {
                    if (state) {
                        state.tailscale.active = true;
                        state.tailscale.url = r.url ?? null;
                    }
                    showServing(r.url ?? null);
                    tsBtn.remove();
                    showToast('Tailscale HTTPS enabled', { kind: 'success' });
                }
                else {
                    tsHint.textContent = `${r.error ?? 'Failed'}${r.hint ? ` — ${r.hint}` : ''}`;
                    tsBtn.disabled = false;
                }
            }
            catch (err) {
                toastError(err, 'Could not enable');
                tsBtn.disabled = false;
            }
        };
        tsRow.append(tsStatus, tsBtn);
    }
    else {
        tsStatus.textContent = 'Not detected';
        tsRow.appendChild(tsStatus);
    }
    ts.append(tsRow, tsHint);
    return ts;
}
/** Access-token card body: generate (two-click armed) or the configured state. */
function buildBearer() {
    const bearer = document.createElement('div');
    const bDesc = document.createElement('div');
    bDesc.className = 'mrow-meta';
    if (state?.bearerConfigured) {
        // Same rule as the Tailscale card: no dead button under a done state.
        const row = document.createElement('div');
        row.className = 'wiz-creds-row';
        const st = document.createElement('span');
        st.className = 'wiz-creds-status is-connected';
        st.textContent = 'Configured';
        row.appendChild(st);
        bearer.append(row);
        return bearer;
    }
    // What the button will do, before it is pressed. This is the one action in
    // the wizard that cannot be undone from the wizard.
    bDesc.textContent = 'Generates a token and opens this port to your network. Takes effect on the next restart.';
    const bBtn = document.createElement('button');
    bBtn.textContent = 'Generate token';
    // Two-click arm: generation commits real install state (token + network
    // exposure on the next restart), and stray single clicks kept arming it.
    //
    // The armed state has to SAY what it is arming. "Opens the port — click
    // again" named the effect in four words and left out the parts that matter:
    // which interfaces, and that there is no way back from here. The endpoint
    // refuses a second generate ("Remove WEB_TOKEN from .env to replace it"), so
    // undoing this means editing .env on the box.
    let armed = false;
    let disarm = null;
    bBtn.onclick = async () => {
        if (!armed) {
            armed = true;
            bBtn.textContent = 'Click again to confirm';
            bDesc.textContent =
                'This binds the web UI to all network interfaces (0.0.0.0), not just this machine, and anyone ' +
                    'with the token can sign in. It cannot be undone from here — replacing the token means editing ' +
                    '.env on the host. The token is shown once.';
            disarm = setTimeout(() => {
                armed = false;
                bBtn.textContent = 'Generate token';
                bDesc.textContent = 'Generates a token and opens this port to your network. Takes effect on the next restart.';
            }, 5000);
            return;
        }
        if (disarm)
            clearTimeout(disarm);
        bBtn.disabled = true;
        try {
            const { token } = (await apiJson('/api/web/auth/bearer/generate', { method: 'POST' }));
            const tokenBox = document.createElement('code');
            tokenBox.className = 'wiz-token';
            tokenBox.textContent = token;
            const copyBtn = document.createElement('button');
            copyBtn.className = 'mprimary';
            copyBtn.textContent = 'Copy';
            copyBtn.onclick = async () => {
                const ok = await copyText(token);
                copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
                if (ok) {
                    setTimeout(() => {
                        copyBtn.textContent = 'Copy';
                    }, 1600);
                }
            };
            const row = document.createElement('div');
            row.className = 'wiz-token-row';
            row.append(tokenBox, copyBtn);
            bDesc.textContent = 'Shown once. Port opens on restart.';
            bearer.insertBefore(row, bBtn);
            bBtn.remove(); // spent — the token row replaces it
        }
        catch (err) {
            toastError(err, 'Could not generate');
            bBtn.disabled = false;
        }
    };
    bearer.append(bDesc, bBtn);
    return bearer;
}
// ── Step: first agent ───────────────────────────────────────────────────────
function renderAgent() {
    const box = document.createElement('div');
    const rerun = (state?.agents ?? 0) > 0;
    box.append(heading(rerun ? 'Another agent' : 'First agent'));
    const name = document.createElement('input');
    name.placeholder = 'Name';
    const instructions = document.createElement('textarea');
    instructions.rows = 4;
    instructions.placeholder = 'Instructions';
    const draftBtn = document.createElement('button');
    draftBtn.textContent = '✨ Draft';
    draftBtn.onclick = async () => {
        const prompt = instructions.value.trim() || name.value.trim();
        if (!prompt) {
            showToast('Type an idea first', { kind: 'error' });
            return;
        }
        draftBtn.disabled = true;
        draftBtn.textContent = 'Drafting…';
        try {
            const { draft } = (await apiJson('/api/rooms/draft', { method: 'POST', body: { prompt } }));
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
            draftBtn.textContent = '✨ Draft';
        }
    };
    const row = document.createElement('div');
    row.className = 'mactions';
    row.append(draftBtn);
    box.append(name, instructions, row, nav({
        nextLabel: rerun ? 'Finish' : 'Create',
        next: async () => {
            // Re-run with nothing typed: there is nothing to create — the default
            // 'Assistant' name would collide with the agent the first run made.
            const n = name.value.trim() || (rerun ? '' : 'Assistant');
            if (!n) {
                await finish();
                return;
            }
            // One call: the chat and its agent are created together.
            await apiJson('/api/rooms', {
                method: 'POST',
                body: { name: n, instructions: instructions.value.trim() || undefined },
            });
            await finish();
        },
    }));
    return box;
}
