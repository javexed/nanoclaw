// ── HTTP + request-body helpers, shared by every route module ────────────────
// json() alone is called 870 times across server.ts, readJsonBody 83.
//
// Extracting these FIRST is what makes the route-module split possible: a
// routes-*.ts importing them from server.ts would form a cycle, because
// server.ts imports the handlers back. Both sides importing this file keeps the
// graph acyclic — the same reason core/dom came out first in the UI split.
import type { IncomingMessage, ServerResponse } from 'http';

export function json(res: ServerResponse, status: number, data: unknown): void {
  // A Promise handed here serializes as {} — json()'s `unknown` parameter means
  // tsc never flags a missing await, and the async-DB migration proved the
  // failure is invisible until a client chokes on the shape (/api/agents took
  // the room UI down exactly this way). Resolve it instead of guessing: send
  // the awaited value, and surface a rejection as the 500 it is.
  if (data && typeof (data as { then?: unknown }).then === 'function') {
    (data as Promise<unknown>).then(
      (v) => {
        // The continuation runs OUTSIDE the request's catch chain — a throw
        // here (headers already sent, unserializable value) would otherwise
        // become an unhandled rejection and a response that hangs to timeout.
        try {
          json(res, status, v);
        } catch (err) {
          console.error('[webchat] json(): serialization failed after resolve', err);
          if (!res.headersSent) json(res, 500, { error: 'Internal error' });
          else res.end();
        }
      },
      (err) => {
        console.error('[webchat] json(): promise argument rejected', err);
        if (!res.headersSent) json(res, 500, { error: 'Internal error' });
        else res.end();
      },
    );
    return;
  }
  // no-store: API responses must never be heuristically cached by a browser
  // or proxy — a cached /api/auth/check can fake a working session offline.
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Cap JSON request bodies at 1 MB. Larger payloads use the chunked upload
// endpoint, which has its own (higher) cap in files.ts.
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
  }
}

export function readBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<string> {
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

export async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  try {
    return await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: 'Request body too large' });
      return null;
    }
    throw err;
  }
}
