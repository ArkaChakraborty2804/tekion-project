/**
 * Tekion APC adapter (anti-corruption layer). Partner docs are not public [U], so this module defines a
 * canonical webhook contract (docs/CONTRACT.md) and a signing scheme that is documented as an assumption.
 * Signature: HMAC-SHA256 over `${timestamp}.${rawBody}`, headers X-Tekion-Timestamp and X-Tekion-Signature (hex).
 * Tolerance 300 s. Idempotency on event_id via the events table.
 */
import { createHmac } from 'node:crypto';
import { get, type Db } from './db.ts';
import { appendEvent } from './events.ts';
import { safeEqual } from './auth.ts';
import { clock } from './clock.ts';

export const TOLERANCE_SECONDS = 300;
export const EVENT_TYPES = ['deal.funded', 'ro.closed', 'vehicle.updated', 'ownership.ended'] as const;

export function signBody(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export type IngestResult =
  | { status: 202; eventId: string | null; duplicate: boolean }
  | { status: 400 | 401 | 404; error: string };

export function ingestWebhook(db: Db, secret: string, rawBody: string, headers: { timestamp?: string; signature?: string }): IngestResult {
  const ts = headers.timestamp ?? '';
  const sig = headers.signature ?? '';
  if (!/^\d{10}$/.test(ts)) return { status: 401, error: 'bad timestamp' };
  const age = Math.abs(clock.now().getTime() / 1000 - Number(ts));
  if (age > TOLERANCE_SECONDS) return { status: 401, error: 'stale timestamp' };
  if (!safeEqual(signBody(secret, ts, rawBody), sig)) return { status: 401, error: 'bad signature' };

  let body: Record<string, any>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, error: 'invalid json' };
  }
  if (typeof body.event_id !== 'string' || !body.event_id) return { status: 400, error: 'event_id required' };
  if (!(EVENT_TYPES as readonly string[]).includes(body.type)) return { status: 400, error: 'unsupported event type' };
  const tenant = get<{ id: string }>(db, 'SELECT id FROM tenants WHERE id = ?', String(body.tenant_id ?? ''));
  if (!tenant) return { status: 404, error: 'unknown tenant' };
  const id = appendEvent(db, {
    tenantId: tenant.id,
    source: 'tekion',
    sourceEventId: body.event_id,
    type: body.type,
    vin: typeof body.data?.vin === 'string' ? body.data.vin : null,
    payload: { ...(body.data ?? {}), rooftop_id: body.data?.rooftop_id ?? undefined },
    occurredAt: typeof body.occurred_at === 'string' ? body.occurred_at : clock.iso(),
  });
  return { status: 202, eventId: id, duplicate: id === null };
}
