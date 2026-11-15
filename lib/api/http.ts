/**
 * Route-handler plumbing for the Next.js API: JSON responses with security headers, capped body reads, rate limits,
 * staff authentication and PII masking. Framework-light on purpose: handlers take a Web Request and return a
 * Response, so they can be unit-tested without Next.js.
 */
import { authenticate, can, canSeeRooftop, type Action, type Principal } from '../server/auth.ts';
import { runtime, RuntimeNotStarted, PEER_HEADER, type Runtime } from '../server/runtime.ts';
import { shared } from '../server/shared.ts';

export type Params = Record<string, string>;
export type Handler = (req: Request, params: Params) => Promise<Response> | Response;

/** Strict headers for every API response. Pages get a nonce-based CSP from proxy.ts instead. */
export const API_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
}

export function text(status: number, body: string, type = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status, headers: { ...API_HEADERS, 'Content-Type': type } });
}

/** Wraps a handler for a Next.js route file: resolves params, maps HttpError, hides internal errors. */
export function route(fn: Handler) {
  return async (req: Request, ctx: { params: Promise<Params> }): Promise<Response> => {
    try {
      return await fn(req, (await ctx?.params) ?? {});
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      if (e instanceof RuntimeNotStarted) return json(503, { error: e.message });
      console.error('[api]', (e as Error).stack ?? e);
      return json(500, { error: 'internal error' });
    }
  };
}

export const rt = (): Runtime => runtime();

/** Reads the body with a hard byte cap (declared length checked first, then the stream is counted). */
export async function readBody(req: Request, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new HttpError(413, 'payload too large');
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'payload too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const JSON_CAP = 1_000_000;

export async function readJson(req: Request): Promise<Record<string, any>> {
  const buf = await readBody(req, JSON_CAP);
  if (buf.length === 0) return {};
  let v: unknown;
  try {
    v = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'expected JSON object');
  return v as Record<string, any>;
}

/** Socket peer address, set by server.ts (client-supplied values are overwritten there). */
export const peer = (req: Request): string => req.headers.get(PEER_HEADER) ?? '';

export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
}

export const limiters = shared('limiters', () => ({
  customer: new RateLimiter(30, 60_000),
  webhook: new RateLimiter(120, 60_000),
}));

/** Node-style lowercase header record, as the auth module expects. */
export function headerRecord(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => { out[k] = v; });
  return out;
}

/** Verified staff principal with the given action, or an HttpError (401 unauthenticated, 403 not permitted). */
export async function staff(req: Request, action?: Action): Promise<Principal> {
  const r = rt();
  const p = await authenticate({ db: r.db, cfg: r.cfg, verifier: r.verifier }, headerRecord(req));
  if (!p) throw new HttpError(401, 'authentication required');
  if (action && !can(p, action)) throw new HttpError(403, `role ${p.role} may not ${action}`);
  return p;
}

export const inScope = (p: Principal, rooftopId: string): boolean => canSeeRooftop(p, rooftopId);

export const ALL_ACTIONS: Action[] = ['read', 'pii_read', 'decide', 'case_ack', 'rules_edit', 'rules_publish', 'audit_read', 'dev'];
export const listActions = (p: Principal): string[] => ALL_ACTIONS.filter((a) => can(p, a));

/** Analysts and other non-PII roles see no names or phone numbers, and message bodies and drafts are hidden. */
export function maskRow(p: Principal, row: Record<string, any>): Record<string, any> {
  if (can(p, 'pii_read')) return row;
  const { full_name: _n, ...rest } = row;
  // Drafts greet the customer by first name, so they are PII-bearing too.
  return { ...rest, full_name: null, draft: row.draft !== undefined ? '[hidden]' : undefined, body: row.body !== undefined ? '[hidden]' : undefined };
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
