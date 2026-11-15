/**
 * Customer reply page support: capability links and media intake.
 *
 * SECURITY (builder-security): anonymous customers are a restricted audience that needs an AmSec-approved
 * authentication mechanism. That mechanism is NOT implemented here. The token below is a dev/loopback
 * capability link only. The HTTP layer serves reply routes only when the server is bound to loopback
 * (see lib/api/customer.ts), and this must go through security review before any exposure.
 *
 * Tokens: 256-bit random, shown once, stored as SHA-256 hash, 72 h expiry, journey (ownership) scoped,
 * revocable, capped uses.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { get, run, tx, type Db } from './db.ts';
import { clock, DAY_MS } from './clock.ts';
import { audit } from './audit.ts';
import { caseFor, type Ctx } from './engine.ts';
import { validateUpload, MediaStore, type Accepted } from './media.ts';

export const LINK_TTL_HOURS = 72;
export const LINK_MAX_USES = 50;
export const RETENTION_DAYS = { image: 90, audio: 30 } as const;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function createCapabilityLink(db: Db, tenantId: string, ownershipId: string): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(clock.now().getTime() + LINK_TTL_HOURS * 3600_000).toISOString();
  tx(db, () => {
    run(db, `INSERT INTO capability_links (id, tenant_id, ownership_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)`,
      randomUUID(), tenantId, ownershipId, sha(token), expiresAt, clock.iso());
    audit(db, tenantId, 'system:links', 'link.issued', ownershipId, { expiresAt });
  });
  return { token, expiresAt };
}

export interface LinkContext { tenantId: string; ownershipId: string; customerId: string; rooftopId: string; linkId: string }

/** Resolves a token to its journey. Counts a use. Returns null for unknown, expired, revoked or exhausted links. */
export function resolveCapabilityLink(db: Db, token: string): LinkContext | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = get<{ id: string; tenant_id: string; ownership_id: string; expires_at: string; revoked_at: string | null; uses: number }>(db,
    'SELECT id, tenant_id, ownership_id, expires_at, revoked_at, uses FROM capability_links WHERE token_hash = ?', sha(token));
  if (!row || row.revoked_at || row.uses >= LINK_MAX_USES) return null;
  if (new Date(row.expires_at).getTime() <= clock.now().getTime()) return null;
  const own = get<{ customer_id: string; rooftop_id: string }>(db, 'SELECT customer_id, rooftop_id FROM ownerships WHERE id = ?', row.ownership_id);
  if (!own) return null;
  run(db, 'UPDATE capability_links SET uses = uses + 1 WHERE id = ?', row.id);
  return { tenantId: row.tenant_id, ownershipId: row.ownership_id, customerId: own.customer_id, rooftopId: own.rooftop_id, linkId: row.id };
}

export function revokeCapabilityLink(db: Db, tenantId: string, linkId: string, actor: string): void {
  run(db, 'UPDATE capability_links SET revoked_at = ? WHERE id = ? AND tenant_id = ?', clock.iso(), linkId, tenantId);
  audit(db, tenantId, actor, 'link.revoked', linkId, {});
}

/** Stores an uploaded photo or audio note against the customer's open case (or a new problem case). */
export function acceptUpload(ctx: Ctx, store: MediaStore, link: LinkContext, buf: Buffer, caps: { imageBytes: number; audioBytes: number }):
  { ok: true; mediaId: string; caseId: string; kind: 'image' | 'audio'; strippedBytes: number; accepted: Accepted } | { ok: false; error: string } {
  const acc = validateUpload(buf, caps);
  if ('error' in acc) return { ok: false, error: acc.error };
  const { caseId, saved } = tx(ctx.db, () => {
    const caseId = openOrNewProblemCase(ctx, link);
    const days = acc.kind === 'image' ? RETENTION_DAYS.image : RETENTION_DAYS.audio;
    const retainUntil = new Date(clock.now().getTime() + days * DAY_MS);
    const saved = store.save(link.tenantId, caseId, acc, retainUntil);
    audit(ctx.db, link.tenantId, 'customer:reply_page', 'media.uploaded', saved.id, { kind: acc.kind, bytes: acc.bytes.length, stripped: acc.strippedBytes });
    return { caseId, saved };
  });
  return { ok: true, mediaId: saved.id, caseId, kind: acc.kind, strippedBytes: acc.strippedBytes, accepted: acc };
}

export function openOrNewProblemCase(ctx: Ctx, link: LinkContext): string {
  const existing = get<{ id: string }>(ctx.db,
    `SELECT id FROM cases WHERE tenant_id = ? AND ownership_id = ? AND kind = 'problem' AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
    link.tenantId, link.ownershipId);
  if (existing) return existing.id;
  return caseFor(ctx, link.tenantId, link.rooftopId, link.ownershipId, link.customerId, 'problem', 'P2',
    'Customer sent photo or audio', 'Media uploaded from the reply page. Review in the case.');
}
