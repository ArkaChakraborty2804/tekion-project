/** Database-level checks: migrations, idempotent inbox, audit tamper detection, tenant scoping, webhook ingest, four-eyes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, get, run, all } from '../lib/server/db.ts';
import { audit, verifyAuditChain } from '../lib/server/audit.ts';
import { appendEvent } from '../lib/server/events.ts';
import { ingestWebhook, signBody } from '../lib/server/tekion.ts';
import { loadConfig } from '../lib/server/config.ts';
import { RecallService } from '../lib/server/recall.ts';
import { SandboxProvider } from '../lib/server/channel.ts';
import { seed, TENANT_ID } from '../lib/server/synth.ts';
import { decide, type Ctx } from '../lib/server/engine.ts';
import { clock } from '../lib/server/clock.ts';

test('migrations are applied once and are idempotent on reopen', () => {
  const db = openDb(':memory:');
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.ok(v >= 1);
  assert.ok(get(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='opportunities'`));
  db.close();
});

test('event inbox ignores duplicate (source, source_event_id)', () => {
  const db = openDb(':memory:');
  run(db, `INSERT INTO tenants (id, name) VALUES ('t1','T')`);
  const ev = { tenantId: 't1', source: 'tekion', sourceEventId: 'e-1', type: 'ro.closed', payload: {}, occurredAt: new Date().toISOString() };
  assert.ok(appendEvent(db, ev));
  assert.equal(appendEvent(db, ev), null);
  db.close();
});

test('audit log: hash chain detects tampering; triggers block UPDATE and DELETE', () => {
  const db = openDb(':memory:');
  run(db, `INSERT INTO tenants (id, name) VALUES ('t1','T')`);
  for (let i = 0; i < 5; i++) audit(db, 't1', 'u', 'x.did', `s${i}`, { i });
  assert.equal(verifyAuditChain(db).ok, true);
  assert.throws(() => run(db, `UPDATE audit_log SET actor = 'evil' WHERE seq = 2`));
  assert.throws(() => run(db, `DELETE FROM audit_log WHERE seq = 2`));
  // Bypass triggers to simulate an out-of-band edit; the chain must catch it.
  db.exec('DROP TRIGGER IF EXISTS audit_no_update');
  for (const t of all<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_log'`)) db.exec(`DROP TRIGGER ${t.name}`);
  run(db, `UPDATE audit_log SET actor = 'evil' WHERE seq = 3`);
  const r = verifyAuditChain(db);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 3);
  db.close();
});

test('tekion webhook: bad signature 401, stale timestamp 401, good signature 202 then duplicate', () => {
  const db = openDb(':memory:');
  run(db, `INSERT INTO tenants (id, name) VALUES ('tenant-x','T')`);
  const body = JSON.stringify({ tenant_id: 'tenant-x', event_id: 'ev-9', type: 'vehicle.updated', occurred_at: new Date().toISOString(), data: { vin: 'SYNTEST0000000001' } });
  const ts = String(Math.floor(clock.now().getTime() / 1000));
  assert.equal(ingestWebhook(db, 'k', body, { timestamp: ts, signature: 'deadbeef' }).status, 401);
  const old = String(Number(ts) - 3600);
  assert.equal(ingestWebhook(db, 'k', body, { timestamp: old, signature: signBody('k', old, body) }).status, 401);
  const ok = ingestWebhook(db, 'k', body, { timestamp: ts, signature: signBody('k', ts, body) });
  assert.equal(ok.status, 202);
  const dup = ingestWebhook(db, 'k', body, { timestamp: ts, signature: signBody('k', ts, body) });
  assert.equal(dup.status === 202 && dup.duplicate, true);
  db.close();
});

test('seeded engine: tenant scoping, four-eyes on edit, analyst blocked', async () => {
  const cfg = loadConfig({ HMAC_SECRET: 't', TEKION_WEBHOOK_SECRET: 't', CHANNEL_WEBHOOK_SECRET: 't', DATA_DIR: ':memory:' });
  const db = openDb(':memory:');
  const recall = new RecallService(db, 'mock');
  const provider = new SandboxProvider();
  await seed(db, cfg, recall, provider, 30);
  const ctx: Ctx = { db, cfg, recall, provider };
  const opp = get<{ id: string; facts: string }>(db, `SELECT id, facts FROM opportunities WHERE tenant_id = ? AND status = 'pending_approval' AND purpose = 'service' LIMIT 1`, TENANT_ID);
  assert.ok(opp, 'expected a pending service opportunity');

  // Another tenant cannot see or act on it.
  assert.equal(decide(ctx, opp.id, 'approve', { id: 'x', role: 'group_admin', tenantId: 'other-tenant' }, {}).ok, false);
  assert.equal(decide(ctx, opp.id, 'approve', { id: 'u-analyst', role: 'analyst', tenantId: TENANT_ID }, {}).ok, false);

  const edited = decide(ctx, opp.id, 'edit', { id: 'u-approver', role: 'approver', tenantId: TENANT_ID }, { text: 'Hi, your service is due. Reply to book.' });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const self = decide(ctx, opp.id, 'approve', { id: 'u-approver', role: 'approver', tenantId: TENANT_ID }, {});
  assert.equal(!self.ok && self.code, 403);
  db.close();
});
