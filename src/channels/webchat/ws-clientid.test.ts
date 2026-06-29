/**
 * Inbound-message idempotency (claimClientId): a duplicate delivery of the same
 * client_id within the window is dropped so it can't spawn a second agent turn.
 */
import { describe, it, expect } from 'vitest';

import { claimClientId } from './ws.js';

describe('claimClientId — inbound message idempotency', () => {
  it('first claim is fresh; an immediate repeat is a duplicate', () => {
    const id = 'local-1-1000';
    expect(claimClientId(id, 1000)).toBe(true); // fresh → process
    expect(claimClientId(id, 1001)).toBe(false); // resend 1ms later → drop
    expect(claimClientId(id, 9999)).toBe(false); // still inside the 10s window → drop
  });

  it('the same id is claimable again once the window has elapsed', () => {
    const id = 'local-2-2000';
    expect(claimClientId(id, 2000)).toBe(true);
    expect(claimClientId(id, 2000 + 10_000)).toBe(true); // window expired → fresh again
  });

  it('distinct ids never collide', () => {
    expect(claimClientId('local-3-3000', 3000)).toBe(true);
    expect(claimClientId('local-4-3000', 3000)).toBe(true);
  });
});
