/**
 * File upload + serve for webchat.
 *
 * One upload path in v1: multipart PUT/POST /api/files/:roomId (up to 1GB in
 * a single request). The predecessor also carried a chunked/resumable path
 * for flaky links — deferred; multipart covers the common case.
 *
 * Files land under data/webchat/uploads/<roomId>/<uuid><.ext>. The agent
 * receives the bytes through the session inbox: ≤25MB inline as base64
 * `attachments[].data`, larger via `hostPath` (session-manager copies the
 * staged file directly — no base64 blowup, and no URL the container can't
 * resolve).
 */
import http from 'http';
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

export interface FileHooks {
  onInbound: (roomId: string, message: InboundMessage) => void;
}

export function uploadsDir(roomId: string): string {
  return path.join(DATA_DIR, 'webchat', 'uploads', sanitizeId(roomId));
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// Files at or below this size are inlined into the inbound message as a
// base64 `attachments[].data` blob, which session-manager stages to
// `<sessionDir>/inbox/<msgId>/`. Above the threshold we pass a `hostPath`
// attachment instead (no base64 encoding); session-manager copies the file
// directly.
const INLINE_ATTACHMENT_THRESHOLD = 25 * 1024 * 1024;

function inboundForFile(
  messageId: string,
  fileMeta: FileMeta,
  caption: string,
  senderIdentity: string,
  senderUserId: string,
  localFilePath: string,
): InboundMessage {
  const attachmentType = fileMeta.mime.startsWith('image/') ? 'image' : 'file';

  let attachment:
    | { name: string; type: string; data: string; size: number; mime: string }
    | { name: string; type: string; hostPath: string; size: number; mime: string }
    | null = null;

  if (fileMeta.size <= INLINE_ATTACHMENT_THRESHOLD) {
    try {
      const data = fs.readFileSync(localFilePath).toString('base64');
      attachment = { name: fileMeta.filename, type: attachmentType, data, size: fileMeta.size, mime: fileMeta.mime };
    } catch (err) {
      log.warn('Webchat: failed to inline attachment for inbound', {
        localFilePath,
        err: err instanceof Error ? err.message : err,
      });
    }
  } else {
    // Large file: host-side path so session-manager copies without encoding.
    attachment = {
      name: fileMeta.filename,
      type: attachmentType,
      hostPath: localFilePath,
      size: fileMeta.size,
      mime: fileMeta.mime,
    };
  }

  // With an attachment, the formatter renders a `[image: name — saved to
  // /workspace/inbox/<msgId>/name]` line the agent can Read directly, so the
  // caption is enough text. Without one (read error), fall back to the URL
  // hint so the agent at least knows the file exists.
  const text = attachment
    ? caption
    : caption
      ? `[File: ${fileMeta.filename} (${fileMeta.mime}, ${fileMeta.size} bytes) at ${fileMeta.url}]\n${caption}`
      : `[File: ${fileMeta.filename} (${fileMeta.mime}, ${fileMeta.size} bytes) at ${fileMeta.url}]`;

  const content: Record<string, unknown> = {
    text,
    sender: senderIdentity,
    senderId: senderUserId,
    senderName: senderIdentity,
  };
  if (attachment) content.attachments = [attachment];

  return {
    id: messageId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    isGroup: true,
    content,
  };
}

export async function handleMultipartUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  roomId: string,
  senderIdentity: string,
  senderUserId: string,
  hooks: FileHooks,
): Promise<void> {
  if (!(await getWebchatRoom(roomId))) {
    log.warn('Webchat upload rejected: room not found', { roomId });
    return json(res, 404, { error: 'Room not found' });
  }

  const dir = uploadsDir(roomId);
  fs.mkdirSync(dir, { recursive: true });

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    log.warn('Webchat upload rejected: bad content-type', { roomId, contentType });
    return json(res, 400, { error: 'Content-Type must be multipart/form-data' });
  }

  const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_SIZE, files: 1 } });
  let fileInfo: { id: string; filename: string; mime: string; size: number; path: string; localPath: string } | null =
    null;
  let limitHit = false;
  let caption = '';
  // Resolves once the disk write is fully FLUSHED. busboy's finish fires when
  // the read side ends — the WriteStream may still be flushing; reading the
  // file before this resolves returned an empty buffer for small uploads
  // (JSON paste-ins arrived at the agent as 0-byte attachments).
  let writeDone: Promise<void> = Promise.resolve();

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
    writeDone = new Promise<void>((resolve, reject) => {
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    });
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
        /* best-effort */
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
          localPath: filePath,
        };
      }
    });
  });

  busboy.on('finish', () => {
    if (limitHit) {
      log.warn('Webchat upload rejected: file size limit hit', { roomId });
      return json(res, 413, { error: `File exceeds ${(MAX_UPLOAD_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB limit` });
    }
    if (!fileInfo) {
      log.warn('Webchat upload rejected: no file part', { roomId, contentType });
      return json(res, 400, { error: 'No file uploaded' });
    }

    writeDone
      .then(async () => {
        const finishedFileInfo = fileInfo!;
        const fileMeta: FileMeta = {
          url: finishedFileInfo.path,
          filename: finishedFileInfo.filename,
          mime: finishedFileInfo.mime,
          size: finishedFileInfo.size,
        };
        const stored = await storeWebchatFileMessage(roomId, senderIdentity, 'user', caption, fileMeta);
        await broadcast(roomId, { type: 'message', ...stored });
        hooks.onInbound(
          roomId,
          inboundForFile(stored.id, fileMeta, caption, senderIdentity, senderUserId, finishedFileInfo.localPath),
        );
        const { localPath: _localPath, ...publicFileInfo } = finishedFileInfo;
        json(res, 200, { ...publicFileInfo, caption });
      })
      .catch((err) => {
        log.warn('Webchat upload: write stream errored', { roomId, err: err instanceof Error ? err.message : err });
        json(res, 500, { error: 'Upload write failed' });
      });
  });

  busboy.on('error', (err) => {
    log.warn('Webchat upload failed', { err: err instanceof Error ? err.message : err });
    json(res, 500, { error: 'Upload failed' });
  });
  req.pipe(busboy);
}

export function handleFileServe(res: http.ServerResponse, roomId: string, filename: string): void {
  // Path-traversal guard: the URL roomId is sanitized at write time, so
  // refuse anything that looks unsafe here too. Filenames are uuid+ext we
  // generated; reject suspicious shapes.
  if (
    !filename ||
    !roomId ||
    filename === '.' ||
    filename.includes('..') ||
    filename.includes('/') ||
    roomId.includes('..') ||
    roomId.includes('/')
  ) {
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
  // A directory (e.g. filename '.') would make createReadStream throw EISDIR
  // with no listener — an unhandled 'error' event exits the whole process.
  if (!stat.isFile()) {
    return json(res, 404, { error: 'File not found' });
  }
  // Strip CR/LF/quote/backslash from the filename before inlining into a
  // header — guards header injection at the response surface.
  const safeName = filename.replace(/[\r\n"\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${safeName}"`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    // Sandbox the response into an opaque origin so HTML/SVG uploads cannot
    // read the PWA's session token. nosniff stops MIME sniffing.
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
  });
  const stream = fs.createReadStream(filePath);
  // A stat/open race (file deleted mid-request) or any read error must not
  // become an unhandled 'error' event — that reaches the global handler and
  // exits the host process.
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}
