/**
 * The built-in web UI as an entry in the channel chooser.
 *
 * The web UI is a place you talk to your assistant exactly like Slack or
 * Telegram is, so it belongs in the same list — asked once, in the place
 * upstream asks it, rather than as a separate yes/no earlier in the run.
 *
 * The list is composed HERE and not in setup/channels/initial-setup.ts because
 * that file is byte-identical to upstream main and stays that way: the web UI
 * is carried on this branch alone, so every line of it inside a shared file is
 * a line that can conflict on the next sync. The test asserts the pass-through,
 * so an attempt to "just add a case upstream" fails loudly.
 *
 * Upstream's list arrives as an ARGUMENT rather than an import, so auto.ts goes
 * on importing initialChannelOptions exactly as upstream does — six lines of
 * import reflow is six more lines of conflict surface for nothing.
 */
import type { ChannelChoice } from '../channels/initial-setup.js';

type Option<T> = { value: T; label: string; hint?: string };

/** What the chooser can return once the web UI is one of its options. */
export type ChooserChoice = ChannelChoice | 'web';

/**
 * Upstream's options with the web UI in front.
 *
 * Dropped once the web UI is already on, which is what makes the "connect a
 * messaging app as well?" loop-back work: the second pass through the chooser
 * offers only what is still available.
 */
export function chooserOptions(upstream: Option<ChannelChoice>[], webEnabled: boolean): Option<ChooserChoice>[] {
  if (webEnabled) return upstream;
  return [
    {
      value: 'web',
      label: 'Yes, set up the built-in web UI',
      hint: 'chat in a browser — no phone or account needed',
    },
    ...upstream,
  ];
}
