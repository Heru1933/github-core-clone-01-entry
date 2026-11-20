// Shared HTTP plumbing for the forge: request shape, JSON envelope, request ids.
//
// Envelope rules (enforced here so no handler can forget them):
// - every response carries a non-empty X-GitHub-Request-Id header;
// - JSON responses are application/json and never HTML;
// - error bodies are {"message": "<non-empty string>"}.

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Req {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  rawBody: Buffer;
  /** Parsed JSON body, or undefined when the body is empty. */
  json: unknown;
  /** True when a body was present but did not parse as JSON. */
  jsonError: boolean;
  /** Authorization: Bearer <token> matches the store token. */
  authOk: boolean;
  /** Host header value, for building same-origin Link URLs. */
  host: string;
}

let requestCounter = 0;

/** Counter-based request id: unique per response, deterministic per run. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  // A message body exists only with Content-Length > 0 or chunked
  // transfer-encoding (HTTP/1.1). When neither is present there is nothing to
  // wait for: resolve at once instead of listening for the stream's end event,
  // which is what every GET and every body-less request pays for.
  const len = req.headers['content-length'];
  if ((len === undefined || len === '0') && req.headers['transfer-encoding'] === undefined) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

export function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

export function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
