// HTTP server: routing + central auth + envelope. One Store per process.
//
// Routing order:
//   GET /healthz            -> 200 {"ok": true} (no auth; the env's boot probe)
//   git smart HTTP          -> handleGit
//   /api/v3/*               -> handleRest
//   /api/graphql            -> handleGraphql
//   /mcp                    -> handleMcp
//   anything else           -> 404 {"message": "Not Found"}
//
// Auth (DESIGN.md): every route except GET /healthz requires
// `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` (exact match against
// store.token). Missing/wrong -> 401 {"message": "Requires authentication"}.
// Handlers also enforce auth internally; the central check runs first so a
// 401 is returned even for a repo that does not exist. When store.token is
// empty (local dev only) every request is accepted.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { errJson, readBody, sendJson, type Req } from './httputil.ts';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/**
 * The path + query of a request URL, or '/' when it does not parse. Split by
 * hand instead of `new URL`: the suite only sends origin-form paths, and the
 * URL constructor's normalization costs more than the rest of the parse.
 * Paths with dot segments or doubled slashes take the old `new URL` route,
 * so their normalization behaviour is unchanged.
 */
function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  if (!raw.startsWith('/') || raw.includes('/./') || raw.includes('/../') || raw.includes('//')) {
    try {
      const url = new URL(raw, 'http://entry');
      return { pathname: url.pathname, query: url.searchParams };
    } catch {
      return { pathname: '/', query: new URLSearchParams() };
    }
  }
  const q = raw.indexOf('?');
  if (q === -1) return { pathname: raw, query: new URLSearchParams() };
  return { pathname: raw.slice(0, q), query: new URLSearchParams(raw.slice(q + 1)) };
}

/**
 * Parse the request body as JSON for JSON routes. Git routes carry binary
 * pack data and are never parsed. Returns the parsed value (undefined for an
 * empty body) and whether a present body failed to parse.
 */
function parseJsonBody(
  pathname: string,
  contentType: string,
  rawBody: Buffer,
): { json: unknown; jsonError: boolean } {
  const isJsonRoute =
    pathname === '/api/graphql' || pathname === '/mcp' || pathname.startsWith('/api/v3');
  if (rawBody.length === 0) return { json: undefined, jsonError: false };
  const looksJson =
    contentType.includes('application/json') ||
    (isJsonRoute && (rawBody[0] === 0x7b || rawBody[0] === 0x5b)); // '{' or '['
  if (!looksJson) return { json: undefined, jsonError: false };
  try {
    return { json: JSON.parse(rawBody.toString('utf8')) as unknown, jsonError: false };
  } catch {
    return { json: undefined, jsonError: true };
  }
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { pathname, query } = parseUrl(req);
        const method = req.method ?? 'GET';
        const rawBody = await readBody(req);

        // The env's boot check calls this twice: 200 {"ok": true}. No auth.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const header = req.headers.authorization;
        const authOk =
          store.token === '' ? true : header === `Bearer ${store.token}`;
        const { json, jsonError } = parseJsonBody(
          pathname,
          String(req.headers['content-type'] ?? ''),
          rawBody,
        );
        const request: Req = {
          method,
          pathname,
          query,
          headers: req.headers,
          rawBody,
          json,
          jsonError,
          authOk,
          host: req.headers.host ?? 'localhost',
        };

        if (!authOk) {
          errJson(res, 401, 'Requires authentication');
          return;
        }

        if (await handleGit(request, res, store)) return;
        if (await handleRest(request, res, store)) return;
        if (await handleGraphql(request, res, store)) return;
        if (await handleMcp(request, res, store)) return;
        errJson(res, 404, 'Not Found');
      } catch (err) {
        // Never let a handler throw leak a hung socket: answer 500 JSON.
        if (!res.headersSent) {
          errJson(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } else {
          res.end();
        }
      }
    })();
  });
}
