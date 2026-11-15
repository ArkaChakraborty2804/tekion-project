/**
 * Quiet hours: approved service and marketing messages are held until 08:00 recipient-local time instead of being
 * blocked from the queue. Safety messages are never held. The clock is pinned, so these tests pass at any hour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localHour, nextSendWindow, quietHoursApply, sendPlan } from '../lib/server/policy.ts';
import { openDb, get } from '../lib/server/db.ts';
import { loadConfig } from '../lib/server/config.ts';
import { RecallService } from '../lib/server/recall.ts';
import { SandboxProvider, dispatchQueued } from '../lib/server/channel.ts';
import { seed, TENANT_ID } from '../lib/server/synth.ts';
import { decide, type Ctx } from '../lib/server/engine.ts';
import { clock } from '../lib/server/clock.ts';

const QH = { startHour: 8, endHour: 21 };
const at = (iso: string) => new Date(iso);
const pinClock = (iso: string) => clock.setOffsetMs(new Date(iso).getTime() - Date.now());

test('nextSendWindow: inside the window sends now; at night it is the next local 08:00', () => {
  const noonLA = at('2026-06-10T19:00:00Z'); // 12:00 PDT
  assert.equal(nextSendWindow(noonLA, 'America/Los_Angeles', QH).getTime(), noonLA.getTime());

  // 01:00 PDT -> 08:00 PDT the same day (15:00Z)
  assert.equal(nextSendWindow(at('2026-06-10T08:00:00Z'), 'America/Los_Angeles', QH).toISOString(), '2026-06-10T15:00:00.000Z');
  // 22:30 CDT -> 08:00 CDT the next day (13:00Z)
  assert.equal(nextSendWindow(at('2026-06-11T03:30:00Z'), 'America/Chicago', QH).toISOString(), '2026-06-11T13:00:00.000Z');
  // Half-hour zone: 02:00 IST -> 08:00 IST (02:30Z)
  assert.equal(nextSendWindow(at('2026-06-09T20:30:00Z'), 'Asia/Kolkata', QH).toISOString(), '2026-06-10T02:30:00.000Z');
  // Across a DST change (US spring forward, 2026-03-08): still lands on local 08:00
  const dst = nextSendWindow(at('2026-03-08T07:00:00Z'), 'America/Chicago', QH);
  assert.equal(localHour(dst, 'America/Chicago'), 8);
});

test('quietHoursApply: service and marketing are held, safety is not', () => {
  assert.equal(quietHoursApply('service', 'P3'), true);
  assert.equal(quietHoursApply('marketing:winback', 'P3'), true);
  assert.equal(quietHoursApply('safety_recall', 'P1'), false);
  assert.equal(quietHoursApply('service', 'P1'), false);
  const plan = sendPlan(at('2026-06-10T08:00:00Z'), 'America/Los_Angeles', QH, 'service', 'P3');
  assert.equal(plan.held, true);
  assert.match(plan.localSendAt, /08:00/);
});

test('approval at night queues normally, schedules the send for local 08:00, and dispatch waits for it', async () => {
  pinClock('2026-06-10T08:00:00Z'); // 01:00 in Los Angeles, 03:00 in Chicago: every seeded customer is in quiet hours
  try {
    const cfg = loadConfig({ HMAC_SECRET: 't', TEKION_WEBHOOK_SECRET: 't', CHANNEL_WEBHOOK_SECRET: 't', DATA_DIR: ':memory:' });
    const db = openDb(':memory:');
    const recall = new RecallService(db, 'mock');
    const provider = new SandboxProvider();
    await seed(db, cfg, recall, provider, 30);
    const ctx: Ctx = { db, cfg, recall, provider };

    const opp = get<{ id: string }>(db, `SELECT id FROM opportunities WHERE tenant_id = ? AND status = 'pending_approval' AND purpose = 'service' LIMIT 1`, TENANT_ID);
    assert.ok(opp, 'night time must not empty the approval queue');

    const r = decide(ctx, opp.id, 'approve', { id: 'u-approver', role: 'approver', tenantId: TENANT_ID }, {});
    assert.ok(r.ok && r.status === 'scheduled', JSON.stringify(r));
    assert.match(r.ok ? r.localSendAt ?? '' : '', /08:00/);

    const msg = get<{ id: string; status: string; send_after: string }>(db, `SELECT id, status, send_after FROM messages WHERE opportunity_id = ?`, opp.id)!;
    assert.equal(msg.status, 'queued');
    dispatchQueued(db, provider);
    assert.equal(get<{ status: string }>(db, 'SELECT status FROM messages WHERE id = ?', msg.id)!.status, 'queued', 'held until the window opens');

    pinClock(new Date(new Date(msg.send_after).getTime() + 60_000).toISOString());
    dispatchQueued(db, provider);
    assert.equal(get<{ status: string }>(db, 'SELECT status FROM messages WHERE id = ?', msg.id)!.status, 'sent');
    db.close();
  } finally {
    clock.setOffsetMs(0);
  }
});
