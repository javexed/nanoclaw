import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { waitForWeb } from './web-open.js';

let server: http.Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  return new Promise((r) =>
    server!.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server!.address() as { port: number }).port}/health`)),
  );
}

describe('waitForWeb', () => {
  it('returns true once the server answers 2xx, tolerating early failures', async () => {
    let calls = 0;
    const url = await listen((_req, res) => {
      calls++;
      res.statusCode = calls < 3 ? 503 : 200;
      res.end();
    });
    expect(await waitForWeb(url, 5_000, 50)).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });
  it('gives up at the deadline when nothing is listening', async () => {
    expect(await waitForWeb('http://127.0.0.1:1/health', 300, 50)).toBe(false);
  });
});
