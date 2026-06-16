import { defineConfig } from '@playwright/test';

// Single happy-path E2E for the webchat PWA (the ~6k-line frontend has no other
// automated coverage). The spec boots the real webchat server in-process with
// no-op hooks (see e2e/), so it exercises client + server + WebSocket without a
// router/Docker/LLM. Run with `pnpm run e2e` (builds dist first).
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { headless: true },
});
