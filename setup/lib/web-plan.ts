/**
 * What enabling the built-in web UI costs the terminal setup flow.
 *
 * A mapping from one answer to a set of skipped steps is exactly the kind of
 * thing that should be executable and asserted, and setup/auto.ts is 2,000
 * lines whose only test harness is importing it and driving it to exit. It
 * also keeps the rule in a file upstream does not have: the web UI is carried
 * on this branch alone, so every line of it inside a shared file is a line
 * that can conflict on the next sync.
 */

/** Steps the browser — or a channel install — handles instead of the terminal. */
export type SkippableStep = 'cli-agent' | 'first-chat' | 'channel' | 'auth';

/**
 * `alsoChannel` is the follow-up asked of someone who enabled the web UI:
 * do they also want a messaging app? It matters beyond the channel step.
 *
 * Installing a channel ends by handing a `/welcome` to the agent over the CLI
 * socket, and the agent needs a credential to answer it. Deferring the sign-in
 * to the browser would place it after that welcome had already failed, leaving
 * a connected channel that never says hello — so a channel takes the auth skip
 * back. Web alone still skips it, which is the whole point of that path: the
 * in-app wizard's first step IS the model question, with a full Claude sign-in
 * behind it.
 *
 * cli-agent and first-chat stay skipped either way. A channel install creates
 * and wires its own agent (scripts/init-first-agent.ts), so running the
 * ping-agent step as well would leave the install with two.
 */
export function webSkips(alsoChannel: boolean): SkippableStep[] {
  const skips: SkippableStep[] = ['cli-agent', 'first-chat'];
  if (!alsoChannel) skips.push('channel', 'auth');
  return skips;
}
