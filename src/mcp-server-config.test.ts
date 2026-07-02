import { describe, it, expect } from 'vitest';

import { buildMcpServerConfig, validateMcpServerName } from './mcp-server-config.js';

describe('validateMcpServerName', () => {
  it('accepts letters, numbers, dash, underscore', () => {
    expect(validateMcpServerName('windows-mcp_1')).toBe('windows-mcp_1');
  });
  it('trims surrounding whitespace', () => {
    expect(validateMcpServerName('  x ')).toBe('x');
  });
  it('rejects empty / non-string', () => {
    expect(() => validateMcpServerName('')).toThrow(/required/);
    expect(() => validateMcpServerName(undefined)).toThrow(/required/);
  });
  it('rejects spaces and special characters', () => {
    expect(() => validateMcpServerName('bad name!')).toThrow(/letters/);
  });
});

describe('buildMcpServerConfig', () => {
  it('builds a stdio server, defaulting args/env', () => {
    expect(buildMcpServerConfig({ command: 'x' })).toEqual({ command: 'x', args: [], env: {} });
    expect(buildMcpServerConfig({ command: 'mcp-thing', args: ['--x'], env: { A: '1' } })).toEqual({
      command: 'mcp-thing',
      args: ['--x'],
      env: { A: '1' },
    });
  });
  it('builds a remote server, defaulting type to sse', () => {
    expect(buildMcpServerConfig({ url: 'http://h:8000/sse' })).toEqual({
      type: 'sse',
      url: 'http://h:8000/sse',
      headers: {},
    });
  });
  it('honours type http + headers', () => {
    expect(
      buildMcpServerConfig({ url: 'https://h/mcp', type: 'http', headers: { Authorization: 'Bearer t' } }),
    ).toEqual({ type: 'http', url: 'https://h/mcp', headers: { Authorization: 'Bearer t' } });
  });
  it('carries instructions on either transport', () => {
    expect(buildMcpServerConfig({ command: 'x', instructions: 'hi' }).instructions).toBe('hi');
    expect(buildMcpServerConfig({ url: 'http://h', instructions: 'hi' }).instructions).toBe('hi');
  });
  it('rejects both url and command', () => {
    expect(() => buildMcpServerConfig({ url: 'http://h', command: 'x' })).toThrow(/not both/);
  });
  it('rejects neither url nor command', () => {
    expect(() => buildMcpServerConfig({})).toThrow(/required/);
  });
  it('rejects an invalid remote type', () => {
    expect(() => buildMcpServerConfig({ url: 'http://h', type: 'ws' })).toThrow(/sse or http/);
  });
});
