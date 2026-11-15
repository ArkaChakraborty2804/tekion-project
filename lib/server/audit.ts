import { createHash, randomUUID } from 'node:crypto';
import { all, get, run, type Db } from './db.ts';
import { clock } from './clock.ts';

/** Hash-chained, append-only audit log (triggers in db.ts block UPDATE/DELETE). */
export function audit(db: Db, tenantId: string, actor: string, action: string, subject: string, detail: unknown = {}): void {
  const prev = get<{ hash: string }>(db, 'SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1')?.hash ?? 'GENESIS';
  const id = randomUUID();
  const createdAt = clock.iso();
  const body = JSON.stringify(detail);
  const hash = digest([prev, id, tenantId, actor, action, subject, body, createdAt].join('|'));
  run(db, 'INSERT INTO audit_log (id, tenant_id, actor, action, subject, detail, prev_hash, hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, tenantId, actor, action, subject, body, prev, hash, createdAt);
}

export function verifyAuditChain(db: Db): { ok: boolean; checked: number; brokenAt?: number } {
  const rows = all<{ seq: number; id: string; tenant_id: string; actor: string; action: string; subject: string; detail: string; prev_hash: string; hash: string; created_at: string }>(
    db, 'SELECT * FROM audit_log ORDER BY seq ASC');
  let prev = 'GENESIS';
  for (const r of rows) {
    const expected = digest([prev, r.id, r.tenant_id, r.actor, r.action, r.subject, r.detail, r.created_at].join('|'));
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, checked: rows.length, brokenAt: r.seq };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}

export function digest(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
