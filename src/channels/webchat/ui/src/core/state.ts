// ── Client state ─────────────────────────────────────────────────────────────
// One plain mutable object. The predecessor UI needed a reactive ref() layer
// because 150 feature files watched slices of this; at this size every mutation
// site knows which render function to call, so plain data + explicit renders
// keeps the whole flow greppable.

export interface Room {
  id: string;
  name: string;
  last_activity: number;
}

/** An optimistic (not yet server-echoed) outgoing message row. */
export interface PendingRow {
  clientId: string;
  roomId: string;
  el: HTMLElement;
  id: string | null;
}

export const state = {
  ws: null as WebSocket | null,
  reconnectDelay: 1000,
  myIdentity: '',
  currentRoom: null as string | null,
  currentRoomName: '',
  lastRoomsList: [] as Room[],
  unreadRooms: new Set<string>(),
  roomActivity: new Map<string, number>(),
  /** client_id → optimistic row awaiting its server echo. */
  pendingMessages: new Map<string, PendingRow>(),
  lastSeenMessageId: null as string | null,
  /** Scroll-back pagination anchors for the open room. */
  oldestMessageId: null as string | null,
  noMoreOlder: false,
  loadingOlder: false,
  /** True while the user has deliberately scrolled up to read history. */
  userScrolledAway: false,
  lastProbeAt: 0,
  lastDiagnosis: null as { text: string } | null,
  notifications: localStorage.getItem('notify') === '1',
};

export function setLastSeenMessageId(id: string | null): void {
  state.lastSeenMessageId = id;
}
