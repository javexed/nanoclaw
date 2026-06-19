/**
 * classifyGatewayProbe — maps a OneCLI gateway probe to a startup log verdict.
 * Pins the diagnostics for the failure modes that have actually bitten this
 * project: unset URL, unreachable gateway, and an old gateway (no /v1 API).
 */
import { describe, it, expect } from 'vitest';

import { classifyGatewayProbe } from './onecli-preflight.js';

describe('classifyGatewayProbe', () => {
  it('ONECLI_URL unset → warn with set-it guidance', () => {
    const v = classifyGatewayProbe('unset');
    expect(v.level).toBe('warn');
    expect(v.message).toMatch(/ONECLI_URL is not set/);
  });

  it('unreachable (null) → error mentioning binding / docker port', () => {
    const v = classifyGatewayProbe(null, 'http://172.17.0.1:10254');
    expect(v.level).toBe('error');
    expect(v.message).toMatch(/UNREACHABLE/);
    expect(v.message).toMatch(/ONECLI_BIND_HOST|docker port/);
  });

  it('404 → error: gateway too old (version-coupling), with upgrade command', () => {
    const v = classifyGatewayProbe(404, 'http://172.17.0.1:10254');
    expect(v.level).toBe('error');
    expect(v.message).toMatch(/too OLD|no \/v1/i);
    expect(v.message).toMatch(/docker compose pull/);
  });

  it('200 → info: credential path OK', () => {
    const v = classifyGatewayProbe(200, 'http://172.17.0.1:10254');
    expect(v.level).toBe('info');
    expect(v.message).toMatch(/reachable.*OK/);
  });

  it('401/403/405 (endpoint exists, just auth/method) → treated as OK, not 404', () => {
    for (const s of [401, 403, 405]) {
      expect(classifyGatewayProbe(s, 'http://x').level).toBe('info');
    }
  });
});
