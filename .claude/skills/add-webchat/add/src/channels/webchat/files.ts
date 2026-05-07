/**
 * File upload + serve for webchat.
 *
 * Two upload paths:
 *   - Multipart (PUT/POST /api/files/:roomId)        small/medium files
 *   - Chunked   (POST /api/files/:roomId/chunk)     resumable, large files
 *
 * Files land under data/webchat/uploads/<roomId>/<uuid><.ext>. Simplification
 * vs v1: we no longer write into the agent's group folder (mounted at
 * /workspace/group inside the container). v2 supports multi-agent fan-out, so
 * a single room may not have a single canonical "group folder" — the fan-out
 * mount could happen in a follow-up. For now the agent fetches the file via
 * the served URL when it needs the bytes.
 */
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

import Busboy from 'busboy';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import type { InboundMessage } from '../adapter.js';
import { storeWebchatFileMessage, getWebchatRoom, type FileMeta } from './db.js';
import { broadcast } from './state.js';

const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024; // 1GB
const CHUNK_UPLOAD_TIMEOUT = 5 * 60 * 1000; // 5 minutes to complete a chunked upload

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const pendingChunkedUploads = new Map<
  string,
  {
    roomId: string;
    filename: string;
    mime: string;
    totalChunks: number;
    receivedChunks: Set<number>;
    tempDir: string;
    sender: string;
    senderUserId: string;
    timer: ReturnType<typeof setTimeout>;
    cumulativeSize: number;
  }
>();

// Cap concurrent open uploads per user. Without this, a single authenticated
// user can spin up thousands of pending uploads (each holds a temp dir +
// a 5-minute timeout). At 5/user, an attacker would need 5 pending
// uploads' worth of disk to DoS, and each request still has the per-upload
// MAX_UPLOAD_SIZE cap below.
const MAX_OPEN_UPLOADS_PER_USER = 5;
const userActiveUploads = new Map<string, Set<string>>();

// Per-uploadId async lock. Two parallel chunks for the same uploadId would
// otherwise both pass the size check, both write, and exceed the cap. The
// lock serialises chunk handling per upload so the disk-stat-sum check
// inside is authoritative.
const uploadLocks = new Map<string, Promise<unknown>>();
async function withUploadLock<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = uploadLocks.get(uploadId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  uploadLocks.set(uploadId, next);
  try {
    return await next;
  } finally {
    if (uploadLocks.get(uploadId) === next) {
      uploadLocks.delete(uploadId);
    }
  }
}

export interface FileHooks {
  /** Inbound chat from a connected client → router. */
  onInbound: (roomId: string, message: InboundMessage) => void;
}

function uploadsDir(roomId: string): string {
  return path.join(DATA_DIR, 'webchat', 'uploads', sanitizeId(roomId));
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cleanupChunkedUpload(uploadId: string): void {
  const upload = pendingChunkedUploads.get(uploadId);
  if (!upload) return;
  clearTimeout(upload.timer);
  try {
    fs.rmSync(upload.tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  pendingChunkedUploads.delete(uploadId);
  releaseUploadSlot(upload.senderUserId, uploadId);
}

function reserveUploadSlot(senderUserId: string, uploadId: string): boolean {
  let set = userActiveUploads.get(senderUserId);
  if (!set) {
    set = new Set();
    userActiveUploads.set(senderUserId, set);
  }
  if (set.size >= MAX_OPEN_UPLOADS_PER_USER) return false;
  set.add(uploadId);
  return true;
}

function releaseUploadSlot(senderUserId: string, uploadId: string): void {
  const set = userActiveUploads.get(senderUserId);
  if (!set) return;
  set.delete(uploadId);
  if (set.size === 0) userActiveUploads.delete(senderUserId);
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Cap on the JSON envelope for a single chunked-upload request. PWA chunks
// default to 512 KB; base64-encoded plus JSON wrapping ≈ 700 KB, so 2 MB is
// generous headroom while still bounding worst-case memory growth.
const MAX_CHUNK_BODY_BYTES = 2 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
  }
}

function readBody(req: http.IncomingMessage, maxBytes = MAX_CHUNK_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      body += d;
    });
    req.on('end', () => resolve(body));
    req.on('error', (err) => reject(err));
  });
}

function inboundForFile(
  _roomId: string,
  messageId: string,
  fileMeta: FileMeta,
  caption: string,
  senderIdentity: string,
  senderUserId: string,
): InboundMessage {
  const text = caption
    ? `[File: ${fileMeta.filename} (${fileMeta.mime}, ${fileMeta.size} bytes) at ${fileMeta.url}]\n${caption}`
    : `[File: ${fileMeta.filename} (${fileMeta.mime}, ${fileMeta.size} bytes) at ${fileMeta.url}]`;
  return {
    id: messageId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    isGroup: true,
    content: {
      text,
      sender: senderIdentity,
      senderId: senderUserId,
      senderName: senderIdentity,
    },
  };
}

export function handleMultipartUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  roomId: string,
  senderIdentity: string,
  senderUserId: string,
  hooks: FileHooks,
): void {
  if (!getWebchatRoom(roomId)) {
    return json(res, 404, { error: 'Room not found' });
  }

  const dir = uploadsDir(roomId);
  fs.mkdirSync(dir, { recursive: true });

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return json(res, 400, { error: 'Content-Type must be multipart/form-data' });
  }

  const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_SIZE, files: 1 } });
  let fileInfo: { id: string; filename: string; mime: string; size: number; path: string } | null = null;
  let limitHit = false;
  let caption = '';

  busboy.on('field', (name, value) => {
    if (name === 'caption') caption = value.trim();
  });

  busboy.on('file', (_fieldname, stream, info) => {
    const id = randomUUID();
    const ext = path.extname(info.filename) || '';
    const safeFilename = `${id}${ext}`;
    const filePath = path.join(dir, safeFilename);
    let size = 0;

    const ws = fs.createWriteStream(filePath);
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
    });
    stream.pipe(ws);

    stream.on('limit', () => {
      limitHit = true;
      ws.destroy();
      try {
        fs.unlinkSync(filePath);
      } catch {
        // best-effort
      }
    });

    stream.on('end', () => {
      if (!limitHit) {
        fileInfo = {
          id,
          filename: info.filename,
          mime: info.mimeType || 'application/octet-stream',
          size,
          path: `/api/files/${encodeURIComponent(sanitizeId(roomId))}/${safeFilename}`,
        };
      }
    });
  });

  busboy.on('finish', () => {
    if (limitHit) {
      return json(res, 413, {
        error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit`,
      });
    }
    if (!fileInfo) return json(res, 400, { error: 'No file uploaded' });

    const fileMeta: FileMeta = {
      url: fileInfo.path,
      filename: fileInfo.filename,
      mime: fileInfo.mime,
      size: fileInfo.size,
    };
    const stored = storeWebchatFileMessage(roomId, senderIdentity, 'user', caption, fileMeta);
    broadcast(roomId, { type: 'message', ...stored });
    hooks.onInbound(roomId, inboundForFile(roomId, stored.id, fileMeta, caption, senderIdentity, senderUserId));
    json(res, 200, { ...fileInfo, caption });
  });

  busboy.on('error', (err) => {
    log.warn('Webchat upload failed', { err: err instanceof Error ? err.message : err });
    json(res, 500, { error: 'Upload failed' });
  });
  req.pipe(busboy);
}

export async function handleChunkedUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  roomId: string,
  senderIdentity: string,
  senderUserId: string,
  hooks: FileHooks,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return json(res, 413, { error: 'Request body too large' });
    throw err;
  }
  let parsed: {
    uploadId: string;
    chunkIndex: number;
    totalChunks: number;
    filename: string;
    mime: string;
    data: string;
    caption?: string;
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const { uploadId, chunkIndex, totalChunks, filename, mime, data } = parsed;
  // chunkIndex must be a non-negative integer < totalChunks. String values like
  // "../../etc/foo" would otherwise reach `path.join(tempDir, String(chunkIndex))`
  // and escape the per-upload temp directory.
  if (
    !uploadId ||
    !filename ||
    !data ||
    typeof totalChunks !== 'number' ||
    !Number.isInteger(totalChunks) ||
    totalChunks < 1 ||
    typeof chunkIndex !== 'number' ||
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= totalChunks
  ) {
    return json(res, 400, { error: 'Missing or invalid required fields' });
  }

  // Validate uploadId as UUID to prevent path traversal in tempDir.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
    return json(res, 400, { error: 'Invalid uploadId format' });
  }

  if (!getWebchatRoom(roomId)) {
    return json(res, 404, { error: 'Room not found' });
  }

  // Per-uploadId lock — without this, two concurrent chunks for the same
  // uploadId can interleave past the size check and exceed cap on disk.
  // The lock holds for the entire chunk-handling flow including the final
  // reassemble; that's fine because reassemble only happens on the final
  // chunk and the single-chunk path is fast.
  const result = await withUploadLock(
    uploadId,
    async (): Promise<{ status: number; body: unknown } | { kind: 'reassemble' }> => {
      let upload = pendingChunkedUploads.get(uploadId);
      if (!upload) {
        // First chunk for this uploadId — reserve a per-user slot. Without
        // this cap, a single user can hold thousands of pending uploads
        // (each with a temp dir + 5min timeout = real disk + memory pressure).
        if (!reserveUploadSlot(senderUserId, uploadId)) {
          return {
            status: 429,
            body: {
              error: `Too many concurrent uploads (max ${MAX_OPEN_UPLOADS_PER_USER}). Wait for one to complete.`,
            },
          };
        }
        const tempDir = path.join(os.tmpdir(), `nanoclaw-webchat-chunk-${uploadId}`);
        fs.mkdirSync(tempDir, { recursive: true });
        upload = {
          roomId,
          filename,
          mime: mime || 'application/octet-stream',
          totalChunks,
          receivedChunks: new Set(),
          tempDir,
          sender: senderIdentity,
          senderUserId,
          timer: setTimeout(() => cleanupChunkedUpload(uploadId), CHUNK_UPLOAD_TIMEOUT),
          cumulativeSize: 0,
        };
        pendingChunkedUploads.set(uploadId, upload);
      } else if (totalChunks !== upload.totalChunks) {
        return { status: 400, body: { error: 'totalChunks mismatch' } };
      }

      const chunkBuf = Buffer.from(data, 'base64');

      // Authoritative size check: stat-sum the temp dir + the new chunk.
      // The earlier in-memory `cumulativeSize` was racy under concurrent
      // chunks for the same uploadId (two requests both saw the pre-write
      // value). Re-summing from disk + adding the buffer-to-be-written is
      // exact under the per-uploadId lock.
      let onDisk = 0;
      for (const idx of upload.receivedChunks) {
        try {
          onDisk += fs.statSync(path.join(upload.tempDir, String(idx))).size;
        } catch {
          // chunk missing — ignore, treat as 0
        }
      }
      if (onDisk + chunkBuf.length > MAX_UPLOAD_SIZE) {
        cleanupChunkedUpload(uploadId);
        return {
          status: 413,
          body: { error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit` },
        };
      }
      fs.writeFileSync(path.join(upload.tempDir, String(chunkIndex)), chunkBuf);
      upload.receivedChunks.add(chunkIndex);
      upload.cumulativeSize = onDisk + chunkBuf.length; // keep field in sync for any external observers

      if (upload.receivedChunks.size < upload.totalChunks) {
        return {
          status: 200,
          body: { ok: true, received: upload.receivedChunks.size, total: upload.totalChunks },
        };
      }
      return { kind: 'reassemble' };
    },
  );

  if ('status' in result) {
    return json(res, result.status, result.body);
  }

  // All chunks received — reassemble outside the lock so multiple distinct
  // uploads don't queue behind each other.
  const upload = pendingChunkedUploads.get(uploadId);
  if (!upload) {
    return json(res, 410, { error: 'Upload state lost during reassemble' });
  }
  clearTimeout(upload.timer);

  // One last authoritative size check before writing to the final dir —
  // belt-and-braces against an interleave we missed. Cheap (totalChunks
  // stat calls).
  let totalSize = 0;
  for (let i = 0; i < totalChunks; i++) {
    try {
      totalSize += fs.statSync(path.join(upload.tempDir, String(i))).size;
    } catch {
      // missing chunk — ignore
    }
  }
  if (totalSize > MAX_UPLOAD_SIZE) {
    cleanupChunkedUpload(uploadId);
    return json(res, 413, {
      error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit`,
    });
  }

  const dir = uploadsDir(roomId);
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const ext = path.extname(filename) || '';
  const safeFilename = `${id}${ext}`;
  const finalPath = path.join(dir, safeFilename);

  const writeStream = fs.createWriteStream(finalPath);
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(upload.tempDir, String(i));
    writeStream.write(fs.readFileSync(chunkPath));
  }
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', () => resolve());
    writeStream.on('error', reject);
    writeStream.end();
  });

  fs.rmSync(upload.tempDir, { recursive: true, force: true });
  pendingChunkedUploads.delete(uploadId);
  releaseUploadSlot(senderUserId, uploadId);

  const fileMeta: FileMeta = {
    url: `/api/files/${encodeURIComponent(sanitizeId(roomId))}/${safeFilename}`,
    filename,
    mime: upload.mime,
    size: totalSize,
  };
  const caption = parsed.caption || '';
  const stored = storeWebchatFileMessage(roomId, upload.sender, 'user', caption, fileMeta);
  broadcast(roomId, { type: 'message', ...stored });
  hooks.onInbound(roomId, inboundForFile(roomId, stored.id, fileMeta, caption, upload.sender, upload.senderUserId));

  return json(res, 200, { ...fileMeta, caption });
}

export function handleFileServe(res: http.ServerResponse, roomId: string, filename: string): void {
  // Path-traversal guard: the URL roomId is sanitized at write time, so
  // refuse anything that looks unsafe here too. Filenames are uuid+ext we
  // generated; reject suspicious shapes.
  if (filename.includes('..') || filename.includes('/') || roomId.includes('..') || roomId.includes('/')) {
    res.writeHead(403);
    res.end();
    return;
  }
  const filePath = path.join(uploadsDir(roomId), filename);
  const ext = path.extname(filename);
  const mime = MIME[ext] || 'application/octet-stream';
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return json(res, 404, { error: 'File not found' });
  }
  // Strip CR/LF/quote/backslash from the filename before inlining into a
  // header — guards header injection at the response surface.
  const safeName = filename.replace(/[\r\n"\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${safeName}"`,
    'Cache-Control': 'public, max-age=31536000, immutable',
    // Sandbox the response into an opaque origin so HTML/SVG uploads cannot
    // read the PWA's localStorage token. nosniff stops MIME sniffing.
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
}
