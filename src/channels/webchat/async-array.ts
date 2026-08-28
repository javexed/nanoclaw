/**
 * Array predicates that can await.
 *
 * WHY THIS FILE EXISTS. `Array.prototype.filter`/`some`/`every` take a
 * SYNCHRONOUS predicate. Hand one an async function and it returns a Promise —
 * which is truthy — so:
 *
 *     rooms.filter((r) => canAccessRoom(userId, r.id))   // keeps EVERY room
 *     agents.some((a) => hasAdminPrivilege(userId, a.id)) // always true
 *
 * Nothing fails. No exception, no type error: `Promise<boolean>` is a perfectly
 * good truthy value as far as `filter`'s signature is concerned, so tsc says
 * nothing. When upstream's database went async, every one of these predicates
 * became a promise and every authorization filter in the webchat UI silently
 * stopped filtering.
 *
 * These helpers are sequential ON PURPOSE. The predicates here hit the same
 * small set of rows (roles, memberships) and a Promise.all fan-out would
 * multiply the queries for no wall-clock gain on lists this size; sequential
 * also keeps the DB access pattern predictable under the driver's connection
 * scoping. Reach for Promise.all when the predicate is genuinely independent
 * and slow, not by default.
 */

/** `filter`, awaiting each predicate. */
export async function filterAsync<T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean | Promise<boolean>,
): Promise<T[]> {
  const out: T[] = [];
  let i = 0;
  for (const item of items) {
    if (await predicate(item, i++)) out.push(item);
  }
  return out;
}

/** `some`, awaiting each predicate. Short-circuits on the first true. */
export async function someAsync<T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean | Promise<boolean>,
): Promise<boolean> {
  let i = 0;
  for (const item of items) {
    if (await predicate(item, i++)) return true;
  }
  return false;
}

/** `every`, awaiting each predicate. Short-circuits on the first false. */
export async function everyAsync<T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean | Promise<boolean>,
): Promise<boolean> {
  let i = 0;
  for (const item of items) {
    if (!(await predicate(item, i++))) return false;
  }
  return true;
}
