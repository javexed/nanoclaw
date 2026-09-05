/**
 * Host sweep — the periodic resync over all session mailboxes.
 *
 * The per-session body lives in src/reconcile-session.ts (`reconcileSession`,
 * the ReconcileFn shape from src/reconcile.ts); execution runs through the
 * keyed workqueue (src/reconcile-queue.ts). This module owns the resync
 * floor: every 60s it enqueues the singleton duties and every active
 * session, then re-arms once the tick's work has drained — so queue loss
 * costs latency, never correctness, and an explicit enqueue between ticks
 * can never be lost to a concurrent sweep. The re-exports below keep the
 * long-standing import surface of this module stable.
 */
import { INSTALL_SLUG } from './config.js';
import { ensureEgressNetwork } from './egress-lockdown.js';
import { getActiveSessions } from './db/sessions.js';
import { peekSessionDriver } from './drivers/index.js';
import type { SessionWatch } from './drivers/types.js';
import { log } from './log.js';
import { registerReconcileEnqueue } from './reconcile-feeds.js';
import { createReconcileQueue, type InProcessReconcileQueue } from './reconcile-queue.js';
import { reconcileSession } from './reconcile-session.js';
import { sessionKey } from './reconcile.js';

export {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  _resetStuckProcessingRowsForTesting,
  decideStuckAction,
  shouldCloseTaskSession,
  type StuckDecision,
} from './reconcile-session.js';

const SWEEP_INTERVAL_MS = 60_000;

let running = false;
let queue: InProcessReconcileQueue | null = null;
let runtimeWatch: SessionWatch | null = null;

/** Coalesced enqueue for the event feeds; drops harmlessly once stopped. */
function feedEnqueue(sessionId: string): void {
  const feedQueue = queue;
  if (running && feedQueue) feedQueue.add(sessionKey(sessionId));
}

/**
 * Reconcile promptly when the runtime reports a session ended: due mail on a
 * dead session waits one queue turn instead of the next resync tick. Arms
 * only against a driver that already exists — the sweep never instantiates
 * one, so suites (and hosts) that never selected a runtime are untouched.
 * Events are hints (they may drop, duplicate, or reference foreign keys);
 * the enqueue re-reads truth, so all of that is safe by construction.
 */
function armRuntimeWatch(): void {
  const driver = peekSessionDriver();
  // Raw test fakes may lack watchSessions; never crash on them.
  if (!driver || typeof driver.watchSessions !== 'function') return;
  /* eslint-disable no-catch-all/no-catch-all -- a watch backend that cannot subscribe costs latency (the resync floor covers it), never the boot */
  try {
    runtimeWatch = driver.watchSessions(INSTALL_SLUG, (event) => {
      if (event.kind !== 'terminal' || !event.key.sessionId) return;
      feedEnqueue(event.key.sessionId);
    });
  } catch (err) {
    log.warn('Runtime watch feed unavailable — the resync floor covers it', { err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/**
 * Module-contributed sweep tasks — the registry form of the MODULE-HOOK
 * fences in sweep(): an installed module contributes work on the sweep
 * cadence (TTL expiries, periodic curation, …) without this file importing
 * it. Tasks run at the END of every tick (after core duties — they can never
 * delay ack sync / stale detection / due wakes); each is isolated so a failure never
 * blocks the rest of the sweep. Inert when nothing registers.
 */
type SweepTask = { name: string; fn: () => Promise<void> };
const sweepTasks: SweepTask[] = [];
export function registerSweepTask(name: string, fn: () => Promise<void>): void {
  sweepTasks.push({ name, fn });
}

export function startHostSweep(): void {
  if (running) return;
  running = true;
  queue = createReconcileQueue({
    reconcile: reconcileSession,
    singletons: {
      // Re-heal the egress network so already-running agents keep their
      // gateway hop if it was detached out-of-band. Best-effort: a heal
      // failure isn't a leak (agents stay on the internal net), so log and
      // continue — never surface a throw into queue backoff. No-op when
      // lockdown is disabled.
      'singleton:egress-reheal': async () => {
        try {
          ensureEgressNetwork();
        } catch (err) {
          log.error('Egress lockdown re-heal failed', { err });
        }
      },
      // Finalize any "Reject with reason…" holds whose reply window elapsed
      // (admin ghosted, or the host restarted mid-capture). Central-DB scan,
      // once per tick — not per session.
      // MODULE-HOOK:approvals-reason-sweep:start
      'singleton:approvals-scan': async () => {
        try {
          const { sweepAwaitingReasonRejects } = await import('./modules/approvals/index.js');
          await sweepAwaitingReasonRejects();
        } catch (err) {
          log.error('Reject-with-reason sweep failed', { err });
        }
      },
      // MODULE-HOOK:approvals-reason-sweep:end
    },
  });
  // Event feeds — additive over the resync floor: mail writes and runtime
  // terminal events land as coalesced enqueues, so behavior only gets
  // faster, never different, and a lost event costs at most one tick.
  registerReconcileEnqueue(feedEnqueue);
  armRuntimeWatch();
  void sweep();
}

export function stopHostSweep(): void {
  running = false;
  registerReconcileEnqueue(null);
  const stoppingWatch = runtimeWatch;
  runtimeWatch = null;
  if (stoppingWatch) {
    /* eslint-disable no-catch-all/no-catch-all -- a watch backend that is already gone must not block shutdown */
    try {
      stoppingWatch.stop();
    } catch (err) {
      log.warn('Runtime watch feed stop failed', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  const stopping = queue;
  queue = null;
  if (stopping) void stopping.shutdown();
}

async function sweep(): Promise<void> {
  // Upstream absorbed the seam's egress re-heal AND the approvals scan as
  // queued singleton tasks — same logic, same log lines, MODULE-HOOK marker
  // intact. The seam's inline copies are dropped here rather than kept:
  // keeping both would run each one twice per tick.
  // Capture the queue for the whole tick: stopHostSweep nulls the module
  // reference mid-flight, and a stopping queue drops adds harmlessly.
  const tickQueue = queue;
  if (!running || !tickQueue) return;

  // Tick order matches the loop this replaces: egress re-heal, then every
  // active session, then the approvals scan — serial through the queue.
  tickQueue.add('singleton:egress-reheal');
  try {
    const sessions = await getActiveSessions();
    for (const session of sessions) {
      tickQueue.add(sessionKey(session.id));
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }
  tickQueue.add('singleton:approvals-scan');

  // The tick ends — and the next one is armed — only after everything this
  // tick enqueued has run. Delayed backoff retries don't hold the tick open.
  await tickQueue.idle();
  if (!running) return;

  // Module-contributed sweep tasks (see registerSweepTask above) run AFTER the
  // core duties and after the queue drains: a slow module task must never delay
  // ack sync, stale detection, or due-message wake — module housekeeping rides
  // the tail of the tick, core owns the head. registerSweepTask is seam-only;
  // upstream has no equivalent, so this block must survive every carry.
  for (const { name, fn } of sweepTasks) {
    try {
      await fn();
    } catch (err) {
      log.warn('Sweep task failed', { task: name, err: String(err) });
    }
  }

  // `() => void sweep()` is upstream's form since the async-DB refactor: sweep
  // returns a promise now, and the bare reference made setTimeout swallow it.
  setTimeout(() => void sweep(), SWEEP_INTERVAL_MS);
}
