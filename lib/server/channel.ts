/**
 * Channel service (HLD 03 §4). Outbound is an outbox: enqueue writes a `queued` row inside the caller's
 * transaction, dispatch sends it. Consent is checked again here (defense in depth, fail closed).
 * The MVP provider is a sandbox; real SMS/email adapters implement the same Provider interface.
 */
import { randomUUID } from 'node:crypto';
import { all, get, run, type Db } from './db.ts';
import { clock } from './clock.ts';
import { audit } from './audit.ts';

export interface Provider {
  readonly name: string;
  capabilities(): { sms: boolean; mms: boolean; maxChars: number };
  send(to: string, body: string): string; // returns provider message id
}

export class SandboxProvider implements Provider {
  readonly name = 'sandbox';
  capabilities() {
    return { sms: true, mms: false, maxChars: 480 };
  }
  send(_to: string, _body: string): string {
    return `sbx_${randomUUID()}`;
  }
}

export type ConsentPurpose = 'service' | 'safety_recall' | 'marketing';
export type ConsentState = Partial<Record<ConsentPurpose, 'granted' | 'revoked'>>;

export function latestConsents(db: Db, tenantId: string, customerId: string): ConsentState {
  const rows = all<{ purpose: ConsentPurpose; consent_type: 'granted' | 'revoked' }>(db,
    `SELECT c.purpose, c.consent_type FROM consents c
     JOIN (SELECT purpose, MAX(captured_at || '|' || rowid) AS k FROM consents WHERE tenant_id = ? AND customer_id = ? GROUP BY purpose) m
       ON m.purpose = c.purpose AND (c.captured_at || '|' || c.rowid) = m.k
     WHERE c.tenant_id = ? AND c.customer_id = ?`, tenantId, customerId, tenantId, customerId);
  const out: ConsentState = {};
  for (const r of rows) out[r.purpose] = r.consent_type;
  return out;
}

export function recordConsent(db: Db, tenantId: string, customerId: string, purpose: ConsentPurpose, type: 'granted' | 'revoked', source: string, disclosureVersion = 'v1'): void {
  run(db, `INSERT INTO consents (id, tenant_id, customer_id, purpose, consent_type, source, disclosure_version, captured_at) VALUES (?,?,?,?,?,?,?,?)`,
    randomUUID(), tenantId, customerId, purpose, type, source, disclosureVersion, clock.iso());
  audit(db, tenantId, `consent:${source}`, 'consent.change', customerId, { purpose, type });
}

/** Keyword STOP is platform-wide for the tenant: marketing and service are both suspended. Safety is not. */
export function applyStop(db: Db, tenantId: string, customerId: string): void {
  recordConsent(db, tenantId, customerId, 'marketing', 'revoked', 'keyword_stop');
  recordConsent(db, tenantId, customerId, 'service', 'revoked', 'keyword_stop');
}

export interface EnqueueInput {
  tenantId: string;
  rooftopId: string;
  customerId: string;
  ownershipId: string | null;
  opportunityId: string | null;
  purpose: string; // service | safety_recall | marketing:<cat>
  body: string;
  /** Hold until this instant (quiet hours). Omitted or null: send on the next dispatch. */
  sendAfter?: Date | null;
}

export class ConsentError extends Error {}

/** Fail-closed consent check per purpose (HLD 04 §1 design rule). */
export function assertConsent(consents: ConsentState, purpose: string): void {
  const ok =
    purpose === 'safety_recall' ? consents.safety_recall === 'granted' || consents.service === 'granted'
      : purpose === 'service' ? consents.service === 'granted'
        : purpose.startsWith('marketing:') ? consents.marketing === 'granted'
          : false;
  if (!ok) throw new ConsentError(`no valid consent for purpose ${purpose}`);
}

export function enqueueOutbound(db: Db, input: EnqueueInput): string {
  assertConsent(latestConsents(db, input.tenantId, input.customerId), input.purpose);
  const id = randomUUID();
  run(db, `INSERT INTO messages (id, tenant_id, rooftop_id, customer_id, ownership_id, opportunity_id, direction, purpose, body, status, created_at, send_after)
    VALUES (?,?,?,?,?,?,'out',?,?,'queued',?,?)`,
    id, input.tenantId, input.rooftopId, input.customerId, input.ownershipId, input.opportunityId, input.purpose, input.body, clock.iso(),
    input.sendAfter ? input.sendAfter.toISOString() : null);
  return id;
}

/**
 * Sends queued outbound rows whose hold (send_after, set for quiet hours) has passed. Returns counts.
 * Safe to re-run: only status='queued' rows are sent.
 */
export function dispatchQueued(db: Db, provider: Provider, limit = 500): { sent: number; failed: number } {
  const rows = all<{ id: string; tenant_id: string; customer_id: string; body: string; purpose: string; ownership_id: string | null }>(db,
    `SELECT m.id, m.tenant_id, m.customer_id, m.body, m.purpose, m.ownership_id FROM messages m
     WHERE m.status = 'queued' AND m.direction = 'out' AND (m.send_after IS NULL OR m.send_after <= ?)
     ORDER BY m.created_at LIMIT ?`, clock.iso(), limit);
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const cust = get<{ phone: string | null }>(db, 'SELECT phone FROM customers WHERE id = ?', r.customer_id);
    if (!cust?.phone) {
      run(db, `UPDATE messages SET status = 'failed' WHERE id = ?`, r.id);
      failed++;
      continue;
    }
    try {
      const providerId = provider.send(cust.phone, r.body);
      run(db, `UPDATE messages SET status = 'sent', provider_msg_id = ? WHERE id = ?`, providerId, r.id);
      if (r.purpose !== 'safety_recall' && r.ownership_id) {
        run(db, `UPDATE ownerships SET unanswered_count = unanswered_count + 1, last_outbound_at = ? WHERE id = ?`, clock.iso(), r.ownership_id);
      }
      audit(db, r.tenant_id, 'system:dispatch', 'message.sent', r.id, { purpose: r.purpose, provider: provider.name });
      sent++;
    } catch {
      run(db, `UPDATE messages SET status = 'failed' WHERE id = ?`, r.id);
      failed++;
    }
  }
  return { sent, failed };
}

/** Non-safety sends to this customer in the last 30 days across the whole tenant (frequency cap scope). */
export function nonSafetySends(db: Db, tenantId: string, customerId: string, now: Date): { count: number; last: Date | null } {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const row = get<{ n: number; last: string | null }>(db,
    `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages
     WHERE tenant_id = ? AND customer_id = ? AND direction = 'out' AND purpose <> 'safety_recall'
       AND status IN ('queued','sent') AND created_at >= ?`, tenantId, customerId, since);
  const last = get<{ last: string | null }>(db,
    `SELECT MAX(created_at) AS last FROM messages WHERE tenant_id = ? AND customer_id = ? AND direction = 'out'
     AND purpose <> 'safety_recall' AND status IN ('queued','sent')`, tenantId, customerId);
  return { count: Number(row?.n ?? 0), last: last?.last ? new Date(last.last) : null };
}
