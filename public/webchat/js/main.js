// ── Boot ─────────────────────────────────────────────────────────────────────
// The whole wiring, in order. An earlier, larger build needed a big composition
// root to sequence many modules; at this size the order fits on one screen.
import { ensureAuthenticated } from './features/auth.js';
import { connect, wireVisibilityReconnect, catchUpSince } from './core/ws.js';
import { wireComposer } from './features/composer.js';
import { wireRoomCreate, wireBackButton, wireRoomDelete, wireRoomRename } from './features/rooms.js';
import { wireTranscriptScroll } from './features/transcript.js';
import { wireAttachments } from './features/files.js';
import { wireManage } from './features/manage.js';
import { maybeOpenWizard } from './features/wizard.js';
import { state } from './core/state.js';
async function boot() {
    await ensureAuthenticated();
    wireTranscriptScroll();
    wireComposer();
    wireRoomCreate();
    wireBackButton();
    wireRoomDelete();
    wireRoomRename();
    wireAttachments();
    wireManage();
    void maybeOpenWizard();
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
        // A deploy activates a new worker (skipWaiting + claim); reload once so the
        // fresh assets appear without the manual hard-refresh dance. The first-ever
        // install also fires controllerchange — skip that one, nothing changed.
        let hadController = Boolean(navigator.serviceWorker.controller);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController) {
                hadController = true;
                return;
            }
            location.reload();
        });
    }
}
void boot();
