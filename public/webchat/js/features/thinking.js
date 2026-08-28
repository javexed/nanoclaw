// ── Thinking bubble ──────────────────────────────────────────────────────────
// One live bubble per working agent: the current activity line (tool verb +
// target), a fading feed of recent reasoning lines, an elapsed timer, and a
// per-agent Stop button. Driven by WS `status` frames (the runner's
// status_events feed, forwarded by the host's agent-status module). `start`
// opens, `tool`/`reasoning`/`progress` refine, `done`/`stalled` close.
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { appendSystem, hideAgentTyping } from './transcript.js';
const TOOL_LABELS = {
    Bash: 'Running command',
    Read: 'Reading file',
    Write: 'Writing file',
    Edit: 'Editing file',
    Glob: 'Searching files',
    Grep: 'Searching code',
    WebSearch: 'Searching the web',
    WebFetch: 'Fetching page',
    Task: 'Delegating work',
    NotebookEdit: 'Editing notebook',
    read: 'Reading file',
    write: 'Writing file',
    edit: 'Editing file',
    bash: 'Running command',
};
const MAX_REASONING_LINES = 3;
const turns = new Map(); // agentName → open turn
function container() {
    return $('#thinking');
}
function openTurn(agentName) {
    const existing = turns.get(agentName);
    if (existing)
        return existing;
    hideAgentTyping(); // the bubble supersedes the plain typing line
    const el = document.createElement('div');
    el.className = 'think';
    const head = document.createElement('div');
    head.className = 'think-head';
    const name = document.createElement('span');
    name.className = 'think-name';
    name.textContent = agentName || 'Agent';
    const timerEl = document.createElement('span');
    timerEl.className = 'think-timer';
    timerEl.textContent = '0s';
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'think-stop';
    stop.title = 'Stop this agent';
    stop.textContent = '■';
    stop.addEventListener('click', () => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'interrupt', agent_name: agentName || undefined }));
        }
    });
    head.append(name, timerEl, stop);
    const activity = document.createElement('div');
    activity.className = 'think-activity';
    activity.textContent = 'Thinking…';
    const reasoning = document.createElement('div');
    reasoning.className = 'think-reasoning';
    el.append(head, activity, reasoning);
    container().appendChild(el);
    const startedAt = Date.now();
    const timer = setInterval(() => {
        const s = Math.round((Date.now() - startedAt) / 1000);
        timerEl.textContent = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    }, 1000);
    const turn = { agentName, el, activity, reasoning, timerEl, startedAt, timer };
    turns.set(agentName, turn);
    scrollFollow();
    return turn;
}
function closeTurn(agentName) {
    // Frames may arrive with a different (or empty) name than the one that
    // opened the turn — a lone open turn closes on any done/stalled.
    const turn = turns.get(agentName) ?? (turns.size === 1 ? [...turns.values()][0] : undefined);
    if (!turn)
        return;
    clearInterval(turn.timer);
    turn.el.remove();
    turns.delete(turn.agentName);
}
function scrollFollow() {
    if (state.userScrolledAway)
        return;
    const t = $('#transcript');
    t.scrollTop = t.scrollHeight;
}
/** Close the bubble for one agent (transcript's agent-reply belt). */
export function closeTurnFor(agentName) {
    closeTurn(agentName);
}
export function clearAllTurns() {
    for (const name of [...turns.keys()])
        closeTurn(name);
}
export function handleStatusEvent(msg) {
    if (msg.room_id !== state.currentRoom)
        return;
    const agentName = msg.agent_name ?? '';
    switch (msg.event) {
        case 'start':
            openTurn(agentName);
            break;
        case 'tool': {
            const turn = openTurn(agentName); // a tool frame mid-turn (re)opens after reconnects
            const label = (msg.text && TOOL_LABELS[msg.text]) || msg.text || 'Working';
            turn.activity.textContent = msg.detail ? `${label} — ${truncate(msg.detail, 80)}` : `${label}…`;
            scrollFollow();
            break;
        }
        case 'progress': {
            const turn = openTurn(agentName);
            if (msg.text)
                turn.activity.textContent = truncate(msg.text, 100);
            break;
        }
        case 'reasoning': {
            const turn = openTurn(agentName);
            if (!msg.text)
                break;
            const line = document.createElement('div');
            line.className = 'think-line';
            line.textContent = truncate(msg.text, 160);
            turn.reasoning.appendChild(line);
            while (turn.reasoning.children.length > MAX_REASONING_LINES) {
                turn.reasoning.firstElementChild?.remove();
            }
            scrollFollow();
            break;
        }
        case 'done':
            closeTurn(agentName);
            break;
        case 'stalled':
            closeTurn(agentName);
            if (msg.text)
                appendSystem(`⚠ ${agentName || 'Agent'}: ${msg.text}`);
            break;
    }
}
function truncate(s, max) {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
