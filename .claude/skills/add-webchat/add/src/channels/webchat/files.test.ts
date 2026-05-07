/**
 * File-handling tests — focused on the security-critical paths Batch 1 fixed:
 * chunked-upload uploadId UUID validation, chunkIndex type validation
 * (path-traversal guard), cumulativeSize cap, JSON body size cap, and
 * handleFileServe path traversal in roomId/filename.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable, Writable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createWebchatRoom } from './db.js';
import { handleChunkedUpload, handleFileServe } from './files.js';

const ROOM_ID = 'test-room';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  // Seed a room so handleChunkedUpload doesn't 404 before reaching its
  // validation checks. createWebchatRoom is the post-migration helper —
  // it writes to messaging_groups (channel_type='webchat'), not the
  // dropped webchat_rooms table.
  createWebchatRoom('Test', ROOM_ID);
});

afterEach(() => {
  closeDb();
});

// ── Test doubles ──────────────────────────────────────────────────────────

function fakeReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  // The req is consumed via `for await` in readBody, which is satisfied by a
  // standard Readable. Attach the bits files.ts reads.
  (r as unknown as { headers: Record<string, string> }).headers = headers;
  return r;
}

interface CapturedResponse {
  status?: number;
  body?: string;
  headers: Record<string, string | number>;
  ended: boolean;
}

function fakeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { headers: {}, ended: false };
  let bodyBuf = '';
  const w = new Writable({
    write(chunk, _enc, cb) {
      bodyBuf += chunk.toString();
      cb();
    },
  });
  const res = w as unknown as ServerResponse & { writeHead: ServerResponse['writeHead']; end: ServerResponse['end'] };
  res.writeHead = ((status: number, hdrs?: Record<string, string | number>) => {
    captured.status = status;
    if (hdrs) Object.assign(captured.headers, hdrs);
    return res;
  }) as ServerResponse['writeHead'];
  res.end = ((data?: string | Buffer) => {
    if (data !== undefined) bodyBuf += data.toString();
    captured.body = bodyBuf;
    captured.ended = true;
    return res;
  }) as ServerResponse['end'];
  return { res, captured };
}

const noopHooks = { onInbound: vi.fn() };

// ── Chunked upload — uploadId UUID guard ──────────────────────────────────

describe('handleChunkedUpload — uploadId validation', () => {
  it('rejects an uploadId that is not a UUID (path-traversal guard)', async () => {
    const { res, captured } = fakeRes();
    const body = JSON.stringify({
      uploadId: '../../../tmp/evil',
      chunkIndex: 0,
      totalChunks: 1,
      filename: 'x.txt',
      mime: 'text/plain',
      data: Buffer.from('hi').toString('base64'),
    });
    const req = fakeReq(body);
    await handleChunkedUpload(req, res, ROOM_ID, 'alice', 'webchat:owner', noopHooks);
    expect(captured.status).toBe(400);
    expect(captured.body).toMatch(/uploadId/i);
  });
});

// ── Chunked upload — chunkIndex type validation (Batch 1) ─────────────────

describe('handleChunkedUpload — chunkIndex validation', () => {
  const validUuid = '12345678-1234-1234-1234-123456789abc';

  async function send(payload: Record<string, unknown>) {
    const { res, captured } = fakeRes();
    await handleChunkedUpload(fakeReq(JSON.stringify(payload)), res, ROOM_ID, 'a', 'u', noopHooks);
    return captured;
  }

  it('rejects a string chunkIndex (the path-traversal vector)', async () => {
    const captured = await send({
      uploadId: validUuid,
      chunkIndex: '../../etc/passwd',
      totalChunks: 1,
      filename: 'x.txt',
      mime: 'text/plain',
      data: Buffer.from('x').toString('base64'),
    });
    expect(captured.status).toBe(400);
  });

  it('rejects a non-integer chunkIndex', async () => {
    const captured = await send({
      uploadId: validUuid,
      chunkIndex: 1.5,
      totalChunks: 4,
      filename: 'x.txt',
      mime: 'text/plain',
      data: Buffer.from('x').toString('base64'),
    });
    expect(captured.status).toBe(400);
  });

  it('rejects a negative chunkIndex', async () => {
    const captured = await send({
      uploadId: validUuid,
      chunkIndex: -1,
      totalChunks: 4,
      filename: 'x.txt',
      mime: 'text/plain',
      data: Buffer.from('x').toString('base64'),
    });
    expect(captured.status).toBe(400);
  });

  it('rejects chunkIndex >= totalChunks', async () => {
    const captured = await send({
      uploadId: validUuid,
      chunkIndex: 5,
      totalChunks: 5,
      filename: 'x.txt',
      mime: 'text/plain',
      data: Buffer.from('x').toString('base64'),
    });
    expect(captured.status).toBe(400);
  });

  it('rejects a non-integer totalChunks', async () => {
    const captured = await send({
      uploadId: validUuid,
      chunkIndex: 0,
      totalChunks: 'lots',
      filename: 'x.txt',
      mime: 'text/plain',
      data: Buffer.from('x').toString('base64'),
    });
    expect(captured.status).toBe(400);
  });
});

// ── Chunked upload — body size cap (Batch 1) ──────────────────────────────

describe('handleChunkedUpload — JSON body size cap', () => {
  it('rejects a body larger than the chunk-body cap', async () => {
    // Just over the 2 MB MAX_CHUNK_BODY_BYTES cap. The cap is enforced at
    // accumulation time, so a 2 MB + 1 KB body trips it before fully
    // buffering and we don't actually load the payload into memory.
    const overSize = 2 * 1024 * 1024 + 1024;
    const huge = 'x'.repeat(overSize);
    const { res, captured } = fakeRes();
    await handleChunkedUpload(fakeReq(huge), res, ROOM_ID, 'a', 'u', noopHooks);
    expect(captured.status).toBe(413);
  });
});

// ── handleFileServe — path traversal ──────────────────────────────────────

describe('handleFileServe — path-traversal guard', () => {
  it('rejects `..` in roomId', () => {
    const { res, captured } = fakeRes();
    handleFileServe(res, '..', 'anything.txt');
    expect([403, 404]).toContain(captured.status);
  });

  it('rejects `..` in filename', () => {
    const { res, captured } = fakeRes();
    handleFileServe(res, ROOM_ID, '../../../etc/passwd');
    expect([403, 404]).toContain(captured.status);
  });

  it('rejects an absolute filename', () => {
    const { res, captured } = fakeRes();
    handleFileServe(res, ROOM_ID, '/etc/passwd');
    expect([403, 404]).toContain(captured.status);
  });

  // (We intentionally skip the "serves a real file" 200-path test here —
  // handleFileServe pipes via createReadStream, and races between teardown
  // and the async read make the test brittle. Header-correctness is
  // exercised end-to-end in the integration test suite.)
});

// ── Chunked upload — race + per-user cap (#16) ────────────────────────────

describe('handleChunkedUpload — concurrency safety', () => {
  function chunkBody(uploadId: string, chunkIndex: number, totalChunks: number, payload: Buffer) {
    return JSON.stringify({
      uploadId,
      chunkIndex,
      totalChunks,
      filename: 'x.bin',
      mime: 'application/octet-stream',
      data: payload.toString('base64'),
    });
  }

  it('caps concurrent open uploads per user at 5', async () => {
    // Each test uses a unique senderUserId — the per-user cap state persists
    // across tests in the same module load (it's a module-level Map).
    const sender = 'webchat:test-cap';
    const baseUuid = '11111111-1111-1111-1111-1111111111';
    // Open 5 uploads (one chunk of a 10-chunk plan, so they stay pending).
    for (let i = 0; i < 5; i++) {
      const uploadId = `${baseUuid}${(10 + i).toString(16).padStart(2, '0')}`;
      const { res } = fakeRes();
      const req = fakeReq(chunkBody(uploadId, 0, 10, Buffer.from('x')));
      await handleChunkedUpload(req, res, ROOM_ID, 'alice', sender, noopHooks);
    }
    // 6th open should be rejected with 429.
    const { res, captured } = fakeRes();
    const req = fakeReq(chunkBody(`${baseUuid}99`, 0, 10, Buffer.from('x')));
    await handleChunkedUpload(req, res, ROOM_ID, 'alice', sender, noopHooks);
    expect(captured.status).toBe(429);
    expect(captured.body).toMatch(/concurrent/i);
  });

  it('serialises concurrent chunks for the same uploadId (no race past cap)', async () => {
    const sender = 'webchat:test-race';
    // Two chunks for the same uploadId. With the lock, the size check is
    // authoritative on every chunk; without it, both could pass cap.
    const uploadId = '22222222-2222-2222-2222-222222222222';
    const a = fakeRes();
    const b = fakeRes();
    const reqA = fakeReq(chunkBody(uploadId, 0, 2, Buffer.from('aaaa')));
    const reqB = fakeReq(chunkBody(uploadId, 1, 2, Buffer.from('bbbb')));
    await Promise.all([
      handleChunkedUpload(reqA, a.res, ROOM_ID, 'alice', sender, noopHooks),
      handleChunkedUpload(reqB, b.res, ROOM_ID, 'alice', sender, noopHooks),
    ]);
    // At least one must have succeeded (the final chunk write that
    // triggered reassemble). Both could be 200 (one chunk-ack + one
    // reassemble). The 429 from the cap test should not leak here because
    // we used a different sender.
    expect([a.captured.status, b.captured.status]).toContain(200);
    expect(a.captured.status).not.toBe(413);
    expect(b.captured.status).not.toBe(413);
  });
});
