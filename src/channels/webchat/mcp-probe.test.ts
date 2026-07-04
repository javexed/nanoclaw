import { describe, it, expect } from 'vitest';

import { looksAuthGated } from './mcp-probe.js';

describe('looksAuthGated — probe failures that mean "send a token"', () => {
  it('matches the SSE transport 401 shape', () => {
    expect(looksAuthGated('SSE error: Non-200 status code (401)')).toBe(true);
  });
  it('matches the Streamable HTTP body-text shape', () => {
    expect(
      looksAuthGated(
        'Streamable HTTP error: Error POSTing to endpoint: {"error":"Missing or invalid Authorization header. Expected: Bearer <token>"}',
      ),
    ).toBe(true);
  });
  it('matches Unauthorized / unauthorised wording', () => {
    expect(looksAuthGated('HTTP 403: Unauthorized')).toBe(true);
    expect(looksAuthGated('request unauthorised')).toBe(true);
  });
  it('does not fire on ordinary connectivity failures', () => {
    expect(looksAuthGated('Timed out after 8s')).toBe(false);
    expect(looksAuthGated('fetch failed: ECONNREFUSED 100.96.20.118:8000')).toBe(false);
    expect(looksAuthGated('Non-200 status code (404)')).toBe(false);
  });
  it('does not fire on incidental digit runs containing 401', () => {
    expect(looksAuthGated('connect EHOSTUNREACH 10.4.0.14019')).toBe(false);
  });
});
