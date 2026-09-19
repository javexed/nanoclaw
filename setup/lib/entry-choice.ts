/**
 * The setup wizard's FIRST question — "where will you talk to your assistant?"
 * — and what its answer means for the rest of the run.
 *
 * Extracted for two reasons.
 *
 * Testability: the decision used to be inline in setup/auto.ts, a 2,000-line
 * module whose only test harness is importing it and driving it to exit. A
 * mapping from answer to consequences is exactly the kind of thing that should
 * be executable and asserted — the same argument setup/channels/initial-setup.ts
 * makes for the channel mapping it owns.
 *
 * Sync surface: the web UI is carried on this branch and not on upstream main,
 * so every line of it in a shared file is a line that can conflict on the next
 * sync. setup/channels/initial-setup.ts is byte-identical to upstream and stays
 * that way — the web option is composed onto its list HERE, in a file upstream
 * does not have.
 */
import { initialChannelOptions, type ChannelChoice } from '../channels/initial-setup.js';

/** Answering the entry question: the web UI, or any channel the chooser offers. */
export type EntryChoice = 'web' | ChannelChoice;

/** Steps this decision can take off the table. Names match setup/auto.ts's skip set. */
export type SkippableStep = 'cli-agent' | 'first-chat' | 'channel' | 'auth';

export interface EntryPlan {
  /** Enable the built-in web UI. */
  web: boolean;
  /** A channel already chosen up front — the chooser below uses it instead of asking again. */
  presetChannel: ChannelChoice | null;
  /** Steps the browser (or the channel install) handles instead of the terminal. */
  skips: SkippableStep[];
}

/**
 * The one question's options: the web UI, then upstream's list verbatim.
 *
 * The question keeps upstream's "Want to chat…" shape on purpose. Every label
 * in initialChannelOptions() reads "Yes, connect X", so a reworded prompt would
 * have meant rewriting upstream copy here just to make the grammar agree —
 * divergence bought with nothing.
 */
export function entryOptions(): { value: EntryChoice; label: string; hint?: string }[] {
  return [
    {
      value: 'web',
      label: 'Yes, open the built-in web UI',
      hint: 'set up your assistant in the browser — opens when setup finishes',
    },
    ...initialChannelOptions(),
  ];
}

/**
 * What the answer costs the terminal.
 *
 * `alsoChannel` is the follow-up asked only of someone who picked the web UI.
 * It matters beyond the channel step itself: installing a channel ends by
 * handing a `/welcome` to the agent over the CLI socket, and the agent needs a
 * credential to answer it. Deferring the sign-in to the browser would put it
 * after that welcome had already failed, leaving a connected channel that never
 * says hello — so a channel takes the auth skip back.
 *
 * cli-agent and first-chat stay skipped either way: a channel install creates
 * and wires its own agent (scripts/init-first-agent.ts), so running the
 * ping-agent step as well would leave the install with two.
 */
export function entryPlan(entry: EntryChoice, alsoChannel: boolean): EntryPlan {
  if (entry !== 'web') return { web: false, presetChannel: entry, skips: [] };
  const skips: SkippableStep[] = ['cli-agent', 'first-chat'];
  if (!alsoChannel) skips.push('channel', 'auth');
  return { web: true, presetChannel: null, skips };
}
