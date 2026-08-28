// ── Boot ─────────────────────────────────────────────────────────────────────
// The whole wiring, in order. The predecessor needed a 2,275-line composition
// root to sequence 150 modules; at this size the order fits on one screen.
import { ensureAuthenticated } from './features/auth.js';
import { connect, wireVisibilityReconnect, catchUpSince } from './core/ws.js';
import { wireComposer } from './features/composer.js';
import { wireRoomCreate, wireBackButton } from './features/rooms.js';
import { wireTranscriptScroll } from './features/transcript.js';
import { state } from './core/state.js';
async function boot() {
    await ensureAuthenticated();
    wireTranscriptScroll();
    wireComposer();
    wireRoomCreate();
    wireBackButton();
    wireVisibilityReconnect();
    connect();
    // Waking a hidden tab: the socket reconnect repaints via history, but a
    // still-open socket that missed nothing renders nothing — catch up from the
    // last-seen anchor so a phone unlock shows what arrived while asleep.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && state.ws?.readyState === WebSocket.OPEN)
            void catchUpSince();
    });
    // Offline-capable shell (no push — the SW only pre-caches assets).
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {
            /* http:// on a non-localhost host — fine, the app still runs */
        });
    }
}
void boot();
