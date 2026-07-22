# Webchat E2E — Playwright browser tier

Browser-level coverage for the webchat PWA. Two tiers, one `e2e/` directory,
one config (`playwright.config.ts` at repo root):

- **`e2e` project** — the original specs (happy path, connection banner, font
  scaling). Loopback-trusted boot, no token.
- **`smoke` project** — `e2e/webchat.smoke.spec.ts`, six independent flows run
  by the pre-publish gate (`verify-webchat-publish.sh` §4b):
  1. bearer login → lobby renders the room list
  2. create a thread through the UI → land in it, thread state updates
  3. send a message inside a topic thread → renders + stored under that `thread_id`
  4. upload in a non-main thread → the POST carries `?thread_id=<that thread>`
     (regression: uploads used to always land in main)
  5. failing API call → error toast with `role="alert"` (regression: error
     toasts once rendered as polite status, invisible to screen readers)
  6. Escape closes the top layer (settings overlay)

## Design

Every spec boots the **real server in-process** from built `dist/`: in-memory
DB (`initTestDb` + the migration runner), seeded agent group + rooms, and no-op
`onInbound`/`onAction` hooks — so client + HTTP + WebSocket are exercised with
no router, Docker, or LLM. A message-send therefore asserts the client render
and the server-side store, not an agent reply.

Three boot quirks the smoke spec depends on (all commented in the spec):

- **Own worker process.** `auth.ts` reads `WEBCHAT_TOKEN` at module load, so
  the bearer-configured boot must import `dist/` fresh. Playwright workers
  never span projects — the `smoke` project split guarantees it.
- **`smoke.localhost` origin.** The client's `checkAuth()` short-circuits "no
  auth needed" for the literal hostnames `localhost`/`127.0.0.1`; Chromium
  resolves any `*.localhost` to loopback, so `smoke.localhost` reaches the
  server while still rendering the real login form.
- **Service worker blocked** (`test.use({ serviceWorkers: 'block' })`). The
  SW's first activation auto-reloads an idle login screen, racing the form
  fill. The SW cache contract is covered by `sw-cache.test.ts` instead.

## Running

```bash
pnpm run test:e2e          # build + full suite (alias: pnpm run e2e)
pnpm exec playwright test --project smoke   # smoke tier only, no rebuild
```

Requires the dev-only toolchain — deliberately **not** installed by
`install-webchat.sh` and not per-PR CI (the runner host is disk-constrained):

```bash
pnpm add -D @playwright/test    # already in package.json on this branch
pnpm exec playwright install chromium
```

The pre-publish gate auto-detects: with `@playwright/test` + chromium present
it runs `pnpm run test:e2e` and fails the gate on failure; otherwise it prints
a SKIP line and the gate proceeds.
