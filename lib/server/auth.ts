/**
 * Staff authentication (builder-security: never invent auth).
 * - Production: OIDC access-token verification (RS256 via JWKS from the configured issuer, e.g. Keycloak).
 *   Fails closed: no issuer configured means every staff request is rejected (401/503).
 * - Dev: only when AUTH_TEST_BYPASS=1 (purpose-named opt-in). Identity is an X-Dev-User header naming a seeded user.
 * Authorization (role and rooftop scope) is enforced here and in the service layer, not only in the UI.
 */
import { createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import { get, all, type Db } from './db.ts';
import { clock } from './clock.ts';

export type Role = 'group_admin' | 'rooftop_manager' | 'service_advisor' | 'approver' | 'analyst' | 'support';

export interface Principal {
  id: string;
  name: string;
  tenantId: string;
  role: Role;
  rooftopIds: string[]; // ['*'] = all rooftops in the group
}

export type Action = 'read' | 'pii_read' | 'decide' | 'case_ack' | 'rules_edit' | 'rules_publish' | 'audit_read' | 'dev';

const MATRIX: Record<Role, Set<Action>> = {
  // 'dev' is inert unless DEV_TOOLS=1 (which requires AUTH_TEST_BYPASS=1 on loopback); see lib/api/dev.ts.
  group_admin: new Set<Action>(['read', 'pii_read', 'decide', 'case_ack', 'rules_edit', 'rules_publish', 'audit_read', 'dev']),
  rooftop_manager: new Set<Action>(['read', 'pii_read', 'decide', 'case_ack', 'rules_edit']),
  service_advisor: new Set<Action>(['read', 'pii_read', 'decide', 'case_ack']),
  approver: new Set<Action>(['read', 'pii_read', 'decide']),
  analyst: new Set<Action>(['read']),
  support: new Set<Action>(['read', 'audit_read']),
};

export function can(p: Principal, action: Action): boolean {
  return MATRIX[p.role].has(action);
}

export function canSeeRooftop(p: Principal, rooftopId: string): boolean {
  return p.rooftopIds.includes('*') || p.rooftopIds.includes(rooftopId);
}

interface Jwk { kid?: string; kty: string; n: string; e: string; alg?: string }

export class OidcVerifier {
  private keys = new Map<string, { key: ReturnType<typeof createPublicKey>; fetched: number }>();
  private lastFetch = 0;

  private readonly cfg: Config['oidc'];
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: Config['oidc'], fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  async verify(token: string): Promise<{ sub: string; name?: string } | null> {
    if (!this.cfg.issuer || !this.cfg.jwksUrl) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let header: { alg?: string; kid?: string };
    let payload: { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; sub?: string; name?: string };
    try {
      header = JSON.parse(b64url(parts[0]).toString('utf8'));
      payload = JSON.parse(b64url(parts[1]).toString('utf8'));
    } catch {
      return null;
    }
    if (header.alg !== 'RS256') return null; // no alg=none, no HS256 confusion
    const key = await this.keyFor(header.kid ?? '');
    if (!key) return null;
    const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(key, b64url(parts[2]));
    if (!ok) return null;
    const now = Math.floor(clock.now().getTime() / 1000);
    if (payload.iss !== this.cfg.issuer) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud ?? ''];
    if (this.cfg.audience && !aud.includes(this.cfg.audience)) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return null;
    if (!payload.sub) return null;
    return { sub: payload.sub, name: payload.name };
  }

  private async keyFor(kid: string): Promise<ReturnType<typeof createPublicKey> | null> {
    const cached = this.keys.get(kid);
    if (cached && Date.now() - cached.fetched < 10 * 60_000) return cached.key;
    if (Date.now() - this.lastFetch < 30_000 && !cached) return null; // rate-limit refetch on unknown kid
    this.lastFetch = Date.now();
    const res = await this.fetchImpl(this.cfg.jwksUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const jwks = (await res.json()) as { keys?: Jwk[] };
    for (const j of jwks.keys ?? []) {
      if (j.kty !== 'RSA') continue;
      this.keys.set(j.kid ?? '', { key: createPublicKey({ key: j, format: 'jwk' }), fetched: Date.now() });
    }
    return this.keys.get(kid)?.key ?? null;
  }
}

function b64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export interface AuthDeps { db: Db; cfg: Config; verifier: OidcVerifier }

/** Resolves the caller from request headers. Returns null when unauthenticated or not provisioned. */
export async function authenticate(deps: AuthDeps, headers: Record<string, string | string[] | undefined>): Promise<Principal | null> {
  let sub: string | null = null;
  if (deps.cfg.authTestBypass) {
    const dev = headers['x-dev-user'];
    if (typeof dev === 'string' && dev) sub = dev;
  } else {
    const auth = headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const claims = await deps.verifier.verify(auth.slice(7));
      sub = claims?.sub ?? null;
    }
  }
  if (!sub) return null;
  const row = get<{ id: string; name: string; tenant_id: string; role: Role; rooftop_ids: string }>(deps.db,
    'SELECT id, name, tenant_id, role, rooftop_ids FROM users WHERE sub = ?', sub);
  if (!row) return null; // authenticated but not provisioned: deny
  return { id: row.id, name: row.name, tenantId: row.tenant_id, role: row.role, rooftopIds: JSON.parse(row.rooftop_ids) };
}

export function listDevUsers(db: Db): Array<{ sub: string; name: string; role: Role }> {
  return all<{ sub: string; name: string; role: Role }>(db, 'SELECT sub, name, role FROM users ORDER BY name');
}

/** Constant-time comparison for shared secrets (webhook signatures, capability tokens). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
