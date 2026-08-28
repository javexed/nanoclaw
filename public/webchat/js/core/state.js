// ── Client state ─────────────────────────────────────────────────────────────
// One plain mutable object. The predecessor UI needed a reactive ref() layer
// because 150 feature files watched slices of this; at this size every mutation
// site knows which render function to call, so plain data + explicit renders
// keeps the whole flow greppable.
export const state = {
    ws: null,
    reconnectDelay: 1000,
    myIdentity: '',
    currentRoom: null,
    currentRoomName: '',
    lastRoomsList: [],
    unreadRooms: new Set(),
    roomActivity: new Map(),
    /** client_id → optimistic row awaiting its server echo. */
    pendingMessages: new Map(),
    lastSeenMessageId: null,
    /** Scroll-back pagination anchors for the open room. */
    oldestMessageId: null,
    noMoreOlder: false,
    loadingOlder: false,
    /** True while the user has deliberately scrolled up to read history. */
    userScrolledAway: false,
    lastProbeAt: 0,
    lastDiagnosis: null,
    notifications: localStorage.getItem('notify') === '1',
};
export function setLastSeenMessageId(id) {
    state.lastSeenMessageId = id;
    if (id)
        sessionStorage.setItem('lastSeenMessageId', id);
}
