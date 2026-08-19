/**
 * Automatic Slack app provisioning — the wizard's Slack channel pre-step.
 *
 * The add-slack SKILL.md owns the channel procedure (adapter install,
 * credential prompts, auth.test, DM resolution, wire). This module runs
 * BEFORE it and, when the operator opts in, provisions the agent's Slack app
 * programmatically — through the managed-Slack broker (slack.nanoclaw.dev,
 * authenticated with the registry install token; sign-in offered on demand)
 * or directly with a SLACK_MANAGER_TOKEN. The provisioned tokens are handed
 * to the skill as pre-bound `inputs`, so its nc:prompt directives skip and
 * the rest of the flow (build, auth.test, wire, welcome) runs unchanged.
 *
 * This module is the wizard UX only — prompts, flow control, spinner copy.
 * The provisioning core (manifest, scope sets, broker + direct-Slack
 * transports) is NOT part of this tree: it ships in the add-slack channel
 * payload and lives at src/provisioning/slack-app.ts on an installed tree.
 * Before offering provisioning, this pre-step ensures the module is present —
 * already installed means a plain dynamic import; otherwise it bootstraps that
 * one file from the channels branch the same way the skill engine fetches
 * payloads (git fetch + git show, remote resolution included). Setup runs
 * under tsx, so importing the fetched .ts file directly works.
 *
 * Loaded ONLY behind the NANOCLAW_SLACK_AGENTS opt-in: slack-auto-register.ts
 * dynamic-imports this module when the flag is set, so the default wizard
 * never evaluates this file or its strings.
 *
 * Returns undefined to mean "walk the manual path" — never throws for
 * expected declines (not signed in, provisioning refused, cancel) or for
 * expected bootstrap failures (offline, branch missing, file missing).
 */
import * as p from '@clack/prompts';
import k from 'kleur';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import * as setupLog from '../logs.js';
import { brightSelect } from '../lib/bright-select.js';
import { confirmThenOpen } from '../lib/browser.js';
import { runInheritScript } from '../lib/inherit-script.js';
import {
  REGISTRY_LOGIN_SCRIPT,
  imageSourceDecided,
  loginScriptAvailable,
  readImageSource,
  readRegistryAccount,
  writeImageSource,
} from '../lib/registry-state.js';
import { ensureAnswer } from '../lib/runner.js';
import { wrapForGutter } from '../lib/theme.js';

const OAUTH_POLL_INTERVAL_MS = 5_000;
const OAUTH_POLL_TIMEOUT_MS = 5 * 60_000;

/** The provisioning core's home in an installed tree (the add-slack payload ships it). */
export const PROVISIONING_MODULE = 'src/provisioning/slack-app.ts';
const CHANNELS_BRANCH = 'channels';

// Structural mirrors of the provisioning core's exported types. Deliberately
// local: the module is not part of this tree, so nothing here may import its
// types statically — the build must pass without src/provisioning present.
export interface BrokerWorkspace {
  team_id: string;
  team_name: string;
  status: string;
  connected_as?: string;
  connected_at?: string;
}

export interface ProvisionedApp {
  appId: string;
  /** xapp-… app-level token for Socket Mode. */
  appToken: string;
  /** xoxb-… bot token — absent when auto-install was refused. */
  botToken?: string;
  /** Manual install URL — the fallback when auto-install was refused. */
  installUrl: string;
  teamDomain?: string;
  installError?: string;
}

/** The slice of src/provisioning/slack-app.ts this flow calls. */
export interface ProvisioningCore {
  BrokerHttpError: new (status: number, path: string, detail?: string) => Error & { status: number; path: string };
  brokerListWorkspaces(token: string): Promise<BrokerWorkspace[]>;
  brokerOauthUrl(token: string): Promise<{ url: string }>;
  brokerProvision(token: string, spec: { team_id: string; name: string }): Promise<ProvisionedApp>;
  provisionManagedApp(managerToken: string, spec: { name: string }): Promise<ProvisionedApp>;
  readInstallToken(): string | undefined;
  readManagerToken(): string | undefined;
}

/** Injection seam for tests — the bootstrap never touches git or the loader in a unit test. */
export interface BootstrapDeps {
  root?: string;
  /** Run a shell command at root; returns stdout, throws on failure. */
  exec?: (command: string) => string;
  importModule?: (fileUrl: string) => Promise<ProvisioningCore>;
}

/**
 * Mirror of the skill engine's remote resolution (defaultResolveRemote in
 * scripts/skill-apply.ts): NANOCLAW_CHANNELS_REMOTE override first, else the
 * first remote (origin preferred) that has the channels branch, else origin.
 */
function resolveChannelsRemote(exec: (command: string) => string): string {
  const override = process.env.NANOCLAW_CHANNELS_REMOTE;
  if (override) return override;
  const cap = (command: string): string => {
    try {
      return exec(command);
    } catch {
      return '';
    }
  };
  const remotes = cap('git remote')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const ordered = remotes.includes('origin') ? ['origin', ...remotes.filter((r) => r !== 'origin')] : remotes;
  for (const r of ordered) if (cap(`git ls-remote --heads ${r} ${CHANNELS_BRANCH}`).trim()) return r;
  return 'origin';
}

/**
 * Ensure the provisioning core is present in the tree, then import it.
 * Already installed (the add-slack payload carries it) → plain import, no
 * fetch. Absent → materialize that one file from the channels branch exactly
 * the way the skill engine copies payloads. Any failure resolves undefined —
 * the caller logs one line and walks the manual path.
 */
export async function loadProvisioningCore(deps: BootstrapDeps = {}): Promise<ProvisioningCore | undefined> {
  const root = deps.root ?? process.cwd();
  const exec =
    deps.exec ?? ((command: string) => execSync(command, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  const importModule = deps.importModule ?? ((fileUrl: string) => import(fileUrl) as Promise<ProvisioningCore>);
  const modulePath = path.join(root, PROVISIONING_MODULE);
  const start = Date.now();
  try {
    if (!fs.existsSync(modulePath)) {
      const remote = resolveChannelsRemote(exec);
      exec(`git fetch ${remote} ${CHANNELS_BRANCH}`);
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      exec(`git show ${remote}/${CHANNELS_BRANCH}:${PROVISIONING_MODULE} > ${PROVISIONING_MODULE}`);
      setupLog.step('slack-provision-bootstrap', 'success', Date.now() - start, { REMOTE: remote });
    }
    return await importModule(pathToFileURL(modulePath).href);
  } catch (err) {
    setupLog.step('slack-provision-bootstrap', 'failed', Date.now() - start, {
      ERROR: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Offer to create the agent's Slack app programmatically. Resolves to the
 * skill `inputs` to pre-bind (tokens + connection mode), or undefined for
 * the manual walkthrough. `agentName` doubles as the Slack app name.
 */
export async function maybeAutoProvisionSlack(
  agentName: string,
  deps: BootstrapDeps = {},
): Promise<Record<string, string> | undefined> {
  const core = await loadProvisioningCore(deps);
  if (!core) {
    p.log.warn("Couldn't load the Slack provisioning module — walking through manual app creation instead.");
    return undefined;
  }
  const managerToken = core.readManagerToken();
  const installToken = managerToken ? undefined : core.readInstallToken();
  // Offered even when not enrolled yet — signing in is a step of the flow,
  // not a precondition for seeing it. Hidden only when this copy has no way
  // to auto-provision at all.
  if (!managerToken && !installToken && !loginScriptAvailable()) return undefined;

  const needsSignIn = !managerToken && !installToken;
  // Automatic provisioning leads as the default; supplying your own bot
  // token stays available as the explicit, advanced alternative.
  const mode = ensureAnswer(
    await brightSelect<'auto' | 'manual'>({
      message: 'How do you want to create the Slack app?',
      initialValue: 'auto',
      options: [
        {
          value: 'auto',
          label: 'Create it for me',
          hint: needsSignIn
            ? 'sign in with your NanoClaw account, then app + install in one step'
            : 'app + install in one step, no token pasting',
        },
        {
          value: 'manual',
          label: 'I will supply my own bot token',
          hint: 'advanced — walk through api.slack.com/apps by hand',
        },
      ],
    }),
  );
  setupLog.userInput('slack_provision_mode', mode);
  if (mode === 'manual') return undefined;

  if (managerToken) return provisionDirect(core, managerToken, agentName);

  // The login driver is idempotent: it validates a matching saved credential
  // without opening a browser, and re-authenticates when its issuer or token
  // is stale. Always pass through it rather than treating "a token exists" as
  // proof that the token belongs to this setup's registry environment.
  const validatedToken = await signInForBroker(core);
  if (!validatedToken) {
    p.log.warn('Not signed in — walking through manual app creation instead.');
    return undefined;
  }
  return provisionViaBroker(core, validatedToken, agentName);
}

/**
 * Sign in with the NanoClaw account so the broker can act for this install.
 * Reuses the registry login driver (device flow / enrollment code) — one
 * account, one sign-in, shared by the image pull and the Slack broker.
 *
 * The login driver flips the install's image source to 'hardened' as a side
 * effect (it exists to enable the pull). Signing in for Slack must not
 * override a deliberate local-build choice, so a decided source is restored.
 */
async function signInForBroker(core: ProvisioningCore): Promise<string | undefined> {
  const savedAccount = readRegistryAccount();
  const savedService = displayServiceOrigin(savedAccount?.api);
  p.note(
    wrapForGutter(
      savedAccount
        ? [
            'Found saved NanoClaw credentials.',
            `Service: ${savedService ?? 'unknown'}`,
            'Checking whether they are valid for this setup…',
          ].join('\n')
        : [
            'Creating the app for you runs through your NanoClaw account.',
            'A code appears below — finish the sign-in in your browser,',
            'then come back here.',
          ].join('\n'),
      6,
    ),
    'NanoClaw sign-in',
  );
  const priorSource = imageSourceDecided() ? readImageSource() : undefined;
  const start = Date.now();
  const code = await runInheritScript('bash', [REGISTRY_LOGIN_SCRIPT]);
  if (priorSource === 'local') writeImageSource('local');
  const token = code === 0 ? core.readInstallToken() : undefined;
  setupLog.step('slack-broker-login', token ? 'success' : code === 2 ? 'skipped' : 'failed', Date.now() - start, {
    EXIT_CODE: String(code),
  });
  return token;
}

/** Display credential provenance without echoing paths, query strings, or userinfo. */
function displayServiceOrigin(api: string | undefined): string | undefined {
  if (!api) return undefined;
  try {
    const url = new URL(api);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

async function provisionDirect(
  core: ProvisioningCore,
  managerToken: string,
  name: string,
): Promise<Record<string, string> | undefined> {
  const s = p.spinner();
  const start = Date.now();
  s.start(`Creating ${name} in Slack… (~30s — generating its avatar first)`);
  try {
    const app = await core.provisionManagedApp(managerToken, { name });
    return finishProvisioned(app, name, s, start, 'slack-provision');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop("Couldn't create the Slack app.", 1);
    setupLog.step('slack-provision', 'failed', Date.now() - start, { ERROR: message });
    p.log.warn(`Slack said: ${message}. Walking through manual app creation instead.`);
    return undefined;
  }
}

async function provisionViaBroker(
  core: ProvisioningCore,
  installToken: string,
  name: string,
): Promise<Record<string, string> | undefined> {
  let workspaces: BrokerWorkspace[];
  const s = p.spinner();
  let start = Date.now();
  s.start('Checking your connected Slack workspaces…');
  try {
    workspaces = (await core.brokerListWorkspaces(installToken)).filter((w) => w.status === 'active');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop("Couldn't reach the Slack service.", 1);
    setupLog.step('slack-broker-workspaces', 'failed', Date.now() - start, { ERROR: message });
    p.log.warn(`The service said: ${message}. Walking through manual app creation instead.`);
    return undefined;
  }
  if (workspaces.length > 0) {
    s.stop(
      workspaces.length === 1
        ? `Found your workspace: ${workspaces[0].team_name}.`
        : `Found ${workspaces.length} connected workspaces.`,
    );
  } else {
    s.stop('No Slack workspace is connected yet.');
    workspaces = await connectWorkspace(core, installToken);
    if (workspaces.length === 0) return undefined;
  }

  const workspace = await pickWorkspace(workspaces);
  const s2 = p.spinner();
  start = Date.now();
  s2.start(`Creating ${name} in ${workspace.team_name}… (~30s — generating its avatar first)`);
  try {
    const app = await core.brokerProvision(installToken, { team_id: workspace.team_id, name });
    const inputs = finishProvisioned(app, name, s2, start, 'slack-broker-provision');
    // The broker knows who connected the workspace — pre-fill the member-ID
    // prompt too (only when it matches the skill's validator; Enterprise Grid
    // W-ids fall back to the prompt like before).
    if (workspace.connected_as && /^U[A-Z0-9]{8,}$/.test(workspace.connected_as)) {
      inputs.owner_handle = workspace.connected_as;
    }
    return inputs;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s2.stop("Couldn't create the Slack app.", 1);
    setupLog.step('slack-broker-provision', 'failed', Date.now() - start, { ERROR: message });
    p.log.warn(`The service said: ${message}. Walking through manual app creation instead.`);
    return undefined;
  }
}

/**
 * Map a provisioned app onto the skill's inputs. A refused auto-install
 * (admin-approval policy) still returns the app token and lets the skill's
 * own bot_token prompt collect the xoxb after the manual install.
 */
function finishProvisioned(
  app: ProvisionedApp,
  name: string,
  s: ReturnType<typeof p.spinner>,
  start: number,
  step: string,
): Record<string, string> {
  if (app.botToken) {
    s.stop(`Created and installed ${name}. ${k.dim(`(${Math.round((Date.now() - start) / 1000)}s)`)}`);
    setupLog.step(step, 'success', Date.now() - start, { APP_ID: app.appId, AUTO_INSTALL: 'true' });
    return { connection: 'provisioned', bot_token: app.botToken, app_token: app.appToken };
  }
  s.stop(`Created ${name}, but Slack wouldn't auto-install it (${app.installError}).`, 1);
  setupLog.step(step, 'success', Date.now() - start, {
    APP_ID: app.appId,
    AUTO_INSTALL: 'false',
    INSTALL_ERROR: app.installError ?? '',
  });
  p.note(
    wrapForGutter(
      [
        'Your workspace requires a manual install (usually an admin-approval',
        'policy). Install the app in the browser, then paste the "Bot User',
        'OAuth Token" (xoxb-…) from its OAuth & Permissions page at the next',
        'prompt.',
        '',
        k.dim(app.installUrl || 'https://api.slack.com/apps'),
      ].join('\n'),
      6,
    ),
    'Finish installing in Slack',
  );
  return { connection: 'provisioned', app_token: app.appToken };
}

async function connectWorkspace(core: ProvisioningCore, installToken: string): Promise<BrokerWorkspace[]> {
  let url: string;
  try {
    ({ url } = await core.brokerOauthUrl(installToken));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('slack-broker-oauth', 'failed', 0, { ERROR: message });
    p.log.warn(`Couldn't start the workspace connection (${message}).`);
    return [];
  }
  p.note(
    wrapForGutter(
      [
        "You'll connect your Slack workspace so NanoClaw can create the",
        "agent's app in it. Slack will ask you to pick a workspace and",
        'approve the connection — then come back here.',
      ].join('\n'),
      6,
    ),
    'Connect your Slack workspace',
  );
  await confirmThenOpen(url, 'Press Enter to open Slack and connect your workspace');

  const s = p.spinner();
  const start = Date.now();
  s.start('Waiting for Slack to confirm the connection…');
  const deadline = start + OAUTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(OAUTH_POLL_INTERVAL_MS);
    let found: BrokerWorkspace[];
    try {
      found = (await core.brokerListWorkspaces(installToken)).filter((w) => w.status === 'active');
    } catch (err) {
      // An auth failure is not transient — the install token is dead and no
      // amount of polling fixes it. Everything else: keep polling.
      if (err instanceof core.BrokerHttpError && (err.status === 401 || err.status === 403)) {
        s.stop("The Slack service rejected this install's credentials.", 1);
        setupLog.step('slack-broker-oauth', 'failed', Date.now() - start, { ERROR: err.message });
        p.log.warn(`${err.message}. Re-run nanoclaw login, then retry.`);
        return [];
      }
      continue;
    }
    if (found.length > 0) {
      const elapsedS = Math.round((Date.now() - start) / 1000);
      s.stop(`Connected to ${found[0].team_name}. ${k.dim(`(${elapsedS}s)`)}`);
      setupLog.step('slack-broker-oauth', 'success', Date.now() - start, {
        TEAM_ID: found[0].team_id,
        TEAM_NAME: found[0].team_name,
      });
      return found;
    }
  }
  s.stop("Slack didn't confirm the connection in time.", 1);
  setupLog.step('slack-broker-oauth', 'failed', Date.now() - start, { ERROR: 'timeout' });
  p.log.warn('Finish approving the connection in the browser, then retry.');
  return [];
}

async function pickWorkspace(workspaces: BrokerWorkspace[]): Promise<BrokerWorkspace> {
  if (workspaces.length === 1) {
    setupLog.userInput('slack_broker_workspace', workspaces[0].team_id);
    return workspaces[0];
  }
  const choice = ensureAnswer(
    await brightSelect<BrokerWorkspace>({
      message: 'Which workspace should the agent live in?',
      options: workspaces.map((w) => ({
        value: w,
        label: w.team_name,
        hint: w.connected_as ? `connected as ${w.connected_as}` : w.team_id,
      })),
    }),
  );
  setupLog.userInput('slack_broker_workspace', choice.team_id);
  return choice;
}
