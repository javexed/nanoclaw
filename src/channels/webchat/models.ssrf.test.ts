/**
 * SSRF defense tests for the models probe/discover/validate gate.
 *
 * These tests don't hit real endpoints — they confirm assertSafeOutboundUrl
 * rejects the URL classes we care about before fetch() is ever called.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertSafeOutboundUrl } from './models.js';

describe('assertSafeOutboundUrl', () => {
  const originalEnv = process.env.WEBCHAT_BLOCK_PRIVATE_IPS;
  beforeEach(() => {
    delete process.env.WEBCHAT_BLOCK_PRIVATE_IPS;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WEBCHAT_BLOCK_PRIVATE_IPS;
    else process.env.WEBCHAT_BLOCK_PRIVATE_IPS = originalEnv;
  });

  describe('always-blocked', () => {
    it('rejects link-local IP literal (cloud metadata)', async () => {
      await expect(assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/169\.254/);
    });

    it('rejects 0.0.0.0', async () => {
      await expect(assertSafeOutboundUrl('http://0.0.0.0:8080/')).rejects.toThrow(/0\.0\.0\.0\/8/);
    });

    it('rejects multicast IPs', async () => {
      await expect(assertSafeOutboundUrl('http://224.0.0.1/')).rejects.toThrow(/224\.0\.0\.0\/4/);
      await expect(assertSafeOutboundUrl('http://239.255.255.250/')).rejects.toThrow(/224\.0\.0\.0\/4/);
    });

    it('rejects metadata.google.internal even before DNS', async () => {
      await expect(assertSafeOutboundUrl('http://metadata.google.internal/computeMetadata/v1/')).rejects.toThrow(
        /metadata\.google\.internal/,
      );
    });

    it('rejects sub.metadata.google.internal', async () => {
      await expect(assertSafeOutboundUrl('http://sub.metadata.google.internal/')).rejects.toThrow(
        /metadata\.google\.internal/,
      );
    });
  });

  describe('schemes', () => {
    it('rejects file://', async () => {
      await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toThrow(/Only http\/https/);
    });

    it('rejects gopher://', async () => {
      await expect(assertSafeOutboundUrl('gopher://example.com/')).rejects.toThrow(/Only http\/https/);
    });

    it('rejects garbled URL', async () => {
      await expect(assertSafeOutboundUrl('not a url')).rejects.toThrow(/Invalid URL/);
    });
  });

  describe('private IPs (default = allowed)', () => {
    it('accepts loopback by default (Ollama on localhost is the primary use case)', async () => {
      await expect(assertSafeOutboundUrl('http://127.0.0.1:11434/api/tags')).resolves.toBeUndefined();
    });

    it('accepts RFC1918 by default (Ollama on home LAN)', async () => {
      await expect(assertSafeOutboundUrl('http://192.168.1.50:11434/')).resolves.toBeUndefined();
      await expect(assertSafeOutboundUrl('http://10.0.0.5:11434/')).resolves.toBeUndefined();
      await expect(assertSafeOutboundUrl('http://172.17.0.1:11434/')).resolves.toBeUndefined();
    });

    it('accepts CGNAT (Tailscale) by default', async () => {
      await expect(assertSafeOutboundUrl('http://100.96.42.10:11434/')).resolves.toBeUndefined();
    });
  });

  describe('private IPs (WEBCHAT_BLOCK_PRIVATE_IPS=true)', () => {
    beforeEach(() => {
      process.env.WEBCHAT_BLOCK_PRIVATE_IPS = 'true';
    });

    it('rejects loopback when hardened', async () => {
      await expect(assertSafeOutboundUrl('http://127.0.0.1:11434/')).rejects.toThrow(/127\.0\.0\.0\/8/);
    });

    it('rejects RFC1918 when hardened', async () => {
      await expect(assertSafeOutboundUrl('http://192.168.1.50/')).rejects.toThrow(/192\.168/);
      await expect(assertSafeOutboundUrl('http://10.0.0.5/')).rejects.toThrow(/10\.0\.0\.0\/8/);
      await expect(assertSafeOutboundUrl('http://172.17.0.1/')).rejects.toThrow(/172\.16/);
    });

    it('rejects CGNAT when hardened', async () => {
      await expect(assertSafeOutboundUrl('http://100.96.42.10/')).rejects.toThrow(/100\.64/);
    });

    it('still accepts public IPs when hardened', async () => {
      // Use an IP literal so the test doesn't depend on real DNS.
      await expect(assertSafeOutboundUrl('http://8.8.8.8/')).resolves.toBeUndefined();
    });
  });

  it('does not throw on unresolvable hostnames (lets fetch fail naturally)', async () => {
    await expect(assertSafeOutboundUrl('http://this-host-does-not-exist.invalid.example/')).resolves.toBeUndefined();
  });
});
