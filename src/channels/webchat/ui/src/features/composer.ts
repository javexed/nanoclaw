// ── Composer ─────────────────────────────────────────────────────────────────
// Textarea + send + the slash menu. Slash commands are ordinary messages the
// agent-runner interprets; the menu is autocomplete, not execution.
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { appendOptimistic } from './transcript.js';

const SLASH_COMMANDS: Array<{ cmd: string; hint: string }> = [
  { cmd: '/clear', hint: 'Start a fresh conversation (context is cleared)' },
  { cmd: '/compact', hint: 'Compress the conversation context' },
  { cmd: '/context', hint: 'Show how full the context window is' },
  { cmd: '/cost', hint: 'Show token usage for this session' },
  { cmd: '/files', hint: 'List files in the agent workspace' },
];

let seq = 0;

export function sendMessage(text: string): void {
  const content = text.trim();
  if (!content || !state.currentRoom) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  // Unique per send — the server dedups on it (flaky-socket resend) and the
  // echo upgrades the optimistic row it keys.
  const clientId = `local-${++seq}-${Date.now()}`;
  appendOptimistic(clientId, state.currentRoom, content);
  state.userScrolledAway = false;
  $('#transcript')!.scrollTop = $('#transcript')!.scrollHeight;
  state.ws.send(JSON.stringify({ type: 'message', content, client_id: clientId }));
}

export function wireComposer(): void {
  // 390px wraps the full placeholder and clips the second line.
  if (matchMedia('(max-width: 480px)').matches) {
    ($('#composer-input') as HTMLTextAreaElement).placeholder = 'Message…';
  }
  const input = $('#composer-input') as HTMLTextAreaElement;
  const form = $('#composer') as HTMLFormElement;
  const menu = $('#slash-menu')!;
  let menuIndex = 0;

  const menuItems = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>('.slash-item')];

  const closeMenu = (): void => {
    menu.hidden = true;
  };

  const openMenu = (filter: string): void => {
    const matches = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(filter));
    if (matches.length === 0) {
      closeMenu();
      return;
    }
    menuIndex = 0;
    menu.replaceChildren(
      ...matches.map((c, i) => {
        const item = document.createElement('div');
        item.className = 'slash-item' + (i === 0 ? ' selected' : '');
        const cmd = document.createElement('span');
        cmd.className = 'slash-cmd';
        cmd.textContent = c.cmd;
        const hint = document.createElement('span');
        hint.className = 'slash-hint';
        hint.textContent = c.hint;
        item.append(cmd, hint);
        item.addEventListener('mousedown', (e) => {
          e.preventDefault(); // keep focus in the textarea
          input.value = c.cmd + ' ';
          closeMenu();
          input.focus();
        });
        return item;
      }),
    );
    menu.hidden = false;
  };

  const moveSelection = (delta: number): void => {
    const items = menuItems();
    if (items.length === 0) return;
    items[menuIndex]?.classList.remove('selected');
    menuIndex = (menuIndex + delta + items.length) % items.length;
    items[menuIndex].classList.add('selected');
  };

  input.addEventListener('input', () => {
    autoGrow(input);
    const v = input.value;
    if (v.startsWith('/') && !v.includes(' ') && v.length <= 12) openMenu(v);
    else closeMenu();
  });

  input.addEventListener('keydown', (e) => {
    if (!menu.hidden) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(-1);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        const selected = menuItems()[menuIndex]?.querySelector('.slash-cmd')?.textContent;
        if (selected) {
          e.preventDefault();
          input.value = selected + ' ';
          closeMenu();
          return;
        }
      }
      if (e.key === 'Escape') {
        closeMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  input.addEventListener('blur', () => setTimeout(closeMenu, 150));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(input.value);
    input.value = '';
    autoGrow(input);
    closeMenu();
  });

  $('#stop-btn')!.addEventListener('click', () => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'interrupt' }));
    }
  });
}

function autoGrow(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}
