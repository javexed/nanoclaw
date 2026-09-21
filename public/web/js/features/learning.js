// ── Learning: skill-draft cards ─────────────────────────────────────────────
// The agent's /learn (or a busy turn) stages a SKILL.md draft; the server
// stores a `skill_draft` message in the room and transcript.ts renders it
// here as an actionable card. Keep runs the overlap check server-side and
// answers 409 with the overlaps; the card asks "keep anyway?" and re-posts
// with force. The `skill_draft_resolved` broadcast flips the card live.
import { apiJson } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';
import { onAsync } from '../core/dom.js';
import { confirmDialog } from '../core/confirm.js';
/** Pull the overlap list out of a failed Keep, whatever shape the error took. */
function overlapsFromError(err) {
    const e = err;
    for (const cand of [e?.body?.overlaps, e?.data?.overlaps]) {
        if (Array.isArray(cand))
            return cand;
    }
    try {
        const m = /\{[\s\S]*\}/.exec(String(e?.message ?? ''));
        if (m) {
            const j = JSON.parse(m[0]);
            if (Array.isArray(j.overlaps))
                return j.overlaps;
        }
    }
    catch {
        /* not JSON */
    }
    return null;
}
function outcomeNote(outcome, resolvedBy) {
    if (resolvedBy === 'superseded')
        return 'Superseded';
    const who = resolvedBy ? String(resolvedBy).split(':').pop() : null;
    if (outcome === 'kept')
        return who ? `✅ Kept by ${who}` : '✅ Kept';
    if (outcome === 'discarded')
        return who ? `🗑 Discarded by ${who}` : '🗑 Discarded';
    return 'Resolved';
}
function flip(card, outcome, resolvedBy) {
    card.classList.add('appr-resolved');
    card.querySelector('.appr-actions')?.remove();
    card.querySelector('.draft-body')?.remove();
    let note = card.querySelector('.appr-note');
    if (!note) {
        note = document.createElement('div');
        note.className = 'appr-note';
        card.appendChild(note);
    }
    note.textContent = outcomeNote(outcome, resolvedBy);
}
async function keep(draftId, force) {
    await apiJson(`/api/skill-drafts/${encodeURIComponent(draftId)}/keep`, {
        method: 'POST',
        body: force ? { force: true } : {},
    });
}
function actionRow(card, data) {
    const row = document.createElement('div');
    row.className = 'appr-actions';
    const draftId = data.draftId ?? '';
    const setBusy = (busy) => row.querySelectorAll('button').forEach((b) => (b.disabled = busy));
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'appr-btn';
    view.textContent = 'View';
    onAsync(view, 'click', async (e) => {
        e.stopPropagation();
        const open = card.querySelector('.draft-body');
        if (open) {
            open.remove();
            view.textContent = 'View';
            return;
        }
        try {
            const d = (await apiJson(`/api/skill-drafts/${encodeURIComponent(draftId)}`));
            const pre = document.createElement('pre');
            pre.className = 'draft-body';
            pre.textContent = d.body ?? '';
            card.insertBefore(pre, row);
            view.textContent = 'Hide';
        }
        catch (err) {
            toastError(err, 'Could not load the draft');
        }
    });
    const keepBtn = document.createElement('button');
    keepBtn.type = 'button';
    keepBtn.className = 'appr-btn appr-approve';
    keepBtn.textContent = 'Keep';
    onAsync(keepBtn, 'click', async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
            await keep(draftId, false);
            flip(card, 'kept');
            showToast('Kept', { kind: 'success' });
        }
        catch (err) {
            const overlaps = overlapsFromError(err);
            if (!overlaps) {
                setBusy(false);
                toastError(err, 'Keep failed');
                return;
            }
            const list = overlaps.map((o) => `${o.name}${o.reason ? ` — ${o.reason}` : ''}`).join('\n');
            const go = await confirmDialog(`Overlaps:\n${list}\n\nKeep?`);
            if (!go) {
                setBusy(false);
                return;
            }
            try {
                await keep(draftId, true);
                flip(card, 'kept');
                showToast('Kept', { kind: 'success' });
            }
            catch (err2) {
                setBusy(false);
                toastError(err2, 'Keep failed');
            }
        }
    });
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'appr-btn';
    discard.textContent = 'Discard';
    onAsync(discard, 'click', async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
            await apiJson(`/api/skill-drafts/${encodeURIComponent(draftId)}/discard`, { method: 'POST', body: {} });
            flip(card, 'discarded');
        }
        catch (err) {
            setBusy(false);
            toastError(err, 'Discard failed');
        }
    });
    row.append(view, keepBtn, discard);
    return row;
}
/** Render one in-room skill-draft card (called from transcript.ts). */
export function buildSkillDraftCard(msg) {
    let data = {};
    try {
        data = JSON.parse(msg.content ?? '{}');
    }
    catch {
        /* render as unparsed */
    }
    const resolved = msg.message_type === 'skill_draft_resolved' || !!data.outcome;
    const card = document.createElement('div');
    card.className = 'appr-card' + (resolved ? ' appr-resolved' : '');
    card.dataset.draftId = data.draftId ?? '';
    const title = document.createElement('div');
    title.className = 'appr-title';
    const verb = data.kind === 'patch' ? `Revise “${data.targetSkill ?? data.skillName ?? ''}”` : (data.skillName ?? '');
    title.textContent = `📘 ${verb}`;
    card.appendChild(title);
    if (data.description) {
        const q = document.createElement('div');
        q.className = 'appr-question';
        q.textContent = data.description;
        card.appendChild(q);
    }
    const note = document.createElement('div');
    note.className = 'appr-note';
    note.textContent = resolved ? outcomeNote(data.outcome, data.resolvedBy) : `${data.agentName ?? 'agent'} · draft`;
    card.appendChild(note);
    if (!resolved && data.draftId)
        card.appendChild(actionRow(card, data));
    return card;
}
/** Flip an in-room card when another tab (or the server) resolved it. */
export function handleSkillDraftResolved(msg) {
    if (!msg.draftId)
        return;
    const card = document.querySelector(`.appr-card[data-draft-id="${CSS.escape(msg.draftId)}"]`);
    if (!card)
        return;
    flip(card, msg.outcome === 'kept' ? 'kept' : 'discarded', msg.resolvedBy);
}
