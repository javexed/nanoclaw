// ── Per-user action rate limit ───────────────────────────────────────────────
// One debounce shared by every user-credential action: OAuth connect, token
// mint, tool secrets, deploy keys — and the user/permission routes now in
// server/routes-users.ts.
//
// The three move together because the Map is the limiter's state. Splitting the
// function from its store would give each importer its own window and silently
// stop limiting anything; keeping the Map module-private here is what makes
// that impossible. Nothing outside this file touches it.

// Cheap in-process guard against UserCreds abuse: a per-identity min-interval on
// credential connects + mint starts (prevents rapid reconnect / spawn churn).
// The host is single-process, so a Map suffices; paired with a global cap on
// concurrent mint containers (MAX_ACTIVE_MINTS) enforced at the start endpoints.
export const userCredsActionAt = new Map<string, number>();

export const USER_CREDS_MIN_INTERVAL_MS = 3000;

export function userCredsRateLimited(userId: string, action: string): boolean {
  const key = `${userId}:${action}`;
  const now = Date.now();
  if (now - (userCredsActionAt.get(key) ?? 0) < USER_CREDS_MIN_INTERVAL_MS) return true;
  userCredsActionAt.set(key, now);
  return false;
}
