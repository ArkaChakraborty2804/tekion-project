/**
 * Durable event log = inbox + outbox for the MVP (HLD 03 §3 "transactional outbox").
 * Events are written in the same transaction as the state they describe, then drained by pump().
 * At-least-once with idempotent consumers: duplicate (source, source_event_id) inserts are ignored.
 */
import { randomUUID } from 'node:crypto';
import { all, get, run, tx, type Db } from './db.ts';
import { clock } from './clock.ts';

export interface NewEvent {
  tenantId: string;
  source: string;
  sourceEventId: string;
  type: string;
  vin?: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface EventRow {
  id: string;
  tenant_id: string;
  source: string;
  source_event_id: string;
  type: string;
  vin: string | null;
  payload: string;
  occurred_at: string;
  attempts: number;
}

/** DMS ro.closed payload (docs/CONTRACT.md). technician_story is optional; it feeds the closed-loop learning index. */
export interface RoClosedPayload {
  ro_id?: string;
  rooftop_id?: string;
  vin: string;
  make?: string;
  model?: string;
  year?: number;
  odometer?: number;
  closed_at: string;
  csat?: number | null;
  customer_party_id: string;
  customer?: { name: string; phone?: string; email?: string; language?: string; tz?: string };
  declined?: Array<{ item: string }>;
  technician_story?: {
    customer_complaint: string;
    ai_predicted_service?: string;
    technician_diagnosis: string;
    technician_action: string;
    override_occurred: boolean;
    labor_code: string;
  } | null;
}

export const MAX_ATTEMPTS = 3;

/** Returns the new event id, or null when the event was already seen (idempotent). */
export function appendEvent(db: Db, ev: NewEvent): string | null {
  const id = randomUUID();
  const changes = run(
    db,
    `INSERT OR IGNORE INTO events (id, tenant_id, source, source_event_id, type, vin, payload, occurred_at, received_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, ev.tenantId, ev.source, ev.sourceEventId, ev.type, ev.vin ?? null, JSON.stringify(ev.payload), ev.occurredAt, clock.iso(),
  );
  return changes === 1 ? id : null;
}

/**
 * Drains pending events in occurred_at order. Each event is handled in its own transaction,
 * so a failure rolls back that event only. After MAX_ATTEMPTS the event is marked dead (dead-letter).
 */
export function pump(db: Db, handle: (ev: EventRow) => void, limit = 200): { processed: number; dead: number } {
  const rows = all<EventRow>(db, `SELECT * FROM events WHERE status = 'pending' ORDER BY occurred_at ASC, received_at ASC LIMIT ?`, limit);
  let processed = 0;
  let dead = 0;
  for (const row of rows) {
    try {
      tx(db, () => {
        handle(row);
        run(db, `UPDATE events SET status = 'done', processed_at = ?, attempts = attempts + 1 WHERE id = ?`, clock.iso(), row.id);
      });
      processed++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const status = attempts >= MAX_ATTEMPTS ? 'dead' : 'pending';
      run(db, `UPDATE events SET status = ?, attempts = ?, last_error = ? WHERE id = ?`, status, attempts, String((err as Error).message ?? err).slice(0, 500), row.id);
      if (status === 'dead') dead++;
    }
  }
  return { processed, dead };
}

export function eventStats(db: Db, tenantId: string): { pending: number; dead: number; done: number } {
  const rows = all<{ status: string; n: number }>(db, 'SELECT status, COUNT(*) AS n FROM events WHERE tenant_id = ? GROUP BY status', tenantId);
  const out = { pending: 0, dead: 0, done: 0 };
  for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = Number(r.n);
  return out;
}

export function retryDead(db: Db, tenantId: string): number {
  return run(db, `UPDATE events SET status = 'pending', attempts = 0 WHERE tenant_id = ? AND status = 'dead'`, tenantId);
}

export const eventExists = (db: Db, source: string, sourceEventId: string): boolean =>
  Boolean(get(db, 'SELECT 1 FROM events WHERE source = ? AND source_event_id = ?', source, sourceEventId));
