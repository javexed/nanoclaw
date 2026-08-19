/**
 * Opt-in registration for automatic Slack app provisioning.
 *
 * This shim is the only piece of the feature on the default wizard path.
 * It checks the NANOCLAW_SLACK_AGENTS env flag ("1" enables it — set the
 * var directly or pass `--slack-agents` to nanoclaw.sh) and returns without
 * registering anything when the flag is off, leaving the wizard identical
 * to a build without the feature. The flow itself (slack-auto.ts plus the
 * provisioning core it bootstraps from the channels branch — the module's
 * permanent home is the add-slack channel payload, at
 * src/provisioning/slack-app.ts on an installed tree) loads via dynamic
 * import only after the flag check passes AND the wizard actually invokes
 * the Slack pre-step. No fetch, no import, nothing runs while the flag is
 * off.
 *
 * The register function is injected by the caller (companions.ts passes
 * `registerChannelPreStep`) so this module has zero runtime imports — no
 * import cycle with the registry, nothing evaluated beyond the env check.
 */
import type { ChannelPreStep } from './companions.js';

export const SLACK_AGENTS_FLAG = 'NANOCLAW_SLACK_AGENTS';

export function registerSlackAutoProvision(
  register: (channel: string, step: ChannelPreStep) => void,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env[SLACK_AGENTS_FLAG] !== '1') return;
  register('slack', async (agentName) => {
    const { maybeAutoProvisionSlack } = await import('./slack-auto.js');
    return maybeAutoProvisionSlack(agentName);
  });
}
