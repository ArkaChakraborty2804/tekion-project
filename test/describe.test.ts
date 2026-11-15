/**
 * Text-only garage triage: the customer describes the problem with no photo or recording.
 * Same fail-closed rules as media triage (critical faults force P1; model can raise, never lower).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, get, all, type Db } from '../lib/server/db.ts';
import { loadConfig } from '../lib/server/config.ts';
import { RecallService } from '../lib/server/recall.ts';
import { SandboxProvider } from '../lib/server/channel.ts';
import { seed, TENANT_ID } from '../lib/server/synth.ts';
import { triageText, P1_TRIAGE_TEMPLATE } from '../lib/server/ai.ts';
import { triageDescription } from '../lib/server/triage.ts';
import { createCapabilityLink, resolveCapabilityLink } from '../lib/server/reply.ts';
import { drainBackground } from '../lib/server/background.ts';
import type { Ctx } from '../lib/server/engine.ts';
import { ScriptedModel } from './fakes.ts';

const VEH = { make: 'Toyota', model: 'Camry', year: 2019, lang: 'en' as const };

test('triage text: a critical fault forces P1 and the fixed template even when the model says P3', async () => {
  const model = new ScriptedModel([{ symbol: 'Brake warning light', system: 'brakes', urgency: 'P3', sound: 'none', description: 'Brake indicator is lit.', safety: false, confidence: 0.8 }]);
  const r = await triageText({ ...VEH, note: 'The red brake warning light came on and the pedal goes to the floor' }, { model });
  assert.equal(r.kind, 'text');
  assert.equal(r.urgency, 'P1');
  assert.equal(r.safety, true);
  assert.equal(r.overridden, true);
  assert.equal(r.customerMessage, P1_TRIAGE_TEMPLATE.en);
  assert.equal(model.calls[0].images, undefined, 'text triage sends no image');
});

test('triage text: tyre noise follows the model (P2) and is not escalated to P1 without a critical fault', async () => {
  const model = new ScriptedModel([{ symbol: 'Tire or wheel noise', system: 'tires', urgency: 'P2', sound: 'other', description: 'A tyre or wheel noise is reported.', safety: false, confidence: 0.6 }]);
  const r = await triageText({ ...VEH, note: 'I think the tyres are making noises' }, { model });
  assert.equal(r.urgency, 'P2');
  assert.equal(r.safety, false);
  assert.equal(r.overridden, false);
  assert.notEqual(r.customerMessage, P1_TRIAGE_TEMPLATE.en);
});

test('triage text: with the model off the fallback is P2 (never routine), and a critical phrase still forces P1', async () => {
  const off = await triageText({ ...VEH, note: 'I think the tyres are making noises' }, {});
  assert.equal(off.urgency, 'P2');
  assert.equal(off.source, 'fallback');
  const fault = await triageText({ ...VEH, note: 'smoke coming from under the hood' }, {});
  assert.equal(fault.urgency, 'P1');
  assert.equal(fault.safety, true);
});

/* ---------- closed loop: triageDescription writes a text triage row on the open problem case ---------- */

let db: Db;
let ctx: Ctx;
let token: string;
let ownershipId: string;

before(async () => {
  const cfg = loadConfig({ HMAC_SECRET: 't', TEKION_WEBHOOK_SECRET: 't', CHANNEL_WEBHOOK_SECRET: 't', DATA_DIR: ':memory:' });
  db = openDb(':memory:');
  const recall = new RecallService(db, 'mock');
  await seed(db, cfg, recall, new SandboxProvider(), 20);
  ctx = { db, cfg, recall, provider: new SandboxProvider(), ai: new ScriptedModel() };
  ownershipId = get<{ id: string }>(db, `SELECT id FROM ownerships WHERE tenant_id = ? AND state = 'active' LIMIT 1`, TENANT_ID)!.id;
  token = createCapabilityLink(db, TENANT_ID, ownershipId).token;
});
after(() => db.close());

test('garage describe: opens a problem case and stores a kind=text triage row', async () => {
  const link = resolveCapabilityLink(db, token)!;
  const model = new ScriptedModel([{ symbol: 'Tire or wheel noise', system: 'tires', urgency: 'P2', sound: 'other', description: 'A tyre or wheel noise is reported.', safety: false, confidence: 0.6 }]);
  const out = await triageDescription(ctx, link, 'I think the tyres are making noises', { model });
  assert.equal(out.urgency, 'P2');
  assert.equal(out.smsSent, false);
  const row = get<{ kind: string; case_id: string; urgency: string; media_id: string | null }>(db,
    'SELECT kind, case_id, urgency, media_id FROM triage_results WHERE id = ?', out.id);
  assert.ok(row);
  assert.equal(row.kind, 'text');
  assert.equal(row.urgency, 'P2');
  assert.equal(row.media_id, null);
  const c = get<{ kind: string; priority: string }>(db, 'SELECT kind, priority FROM cases WHERE id = ?', row.case_id)!;
  assert.equal(c.kind, 'problem');
  assert.equal(c.priority, 'P2');
  await drainBackground();
});

test('garage describe: a second check reuses the open problem case', async () => {
  const link = resolveCapabilityLink(db, token)!;
  const model = new ScriptedModel([{ symbol: 'Brake squeal', system: 'brakes', urgency: 'P2', sound: 'squeal', description: 'Brake squeal reported.', safety: false, confidence: 0.6 }]);
  const first = get<{ case_id: string }>(db, `SELECT case_id FROM triage_results WHERE kind = 'text' ORDER BY created_at LIMIT 1`)!;
  const out = await triageDescription(ctx, link, 'brakes squeal when I stop', { model });
  const row = get<{ case_id: string }>(db, 'SELECT case_id FROM triage_results WHERE id = ?', out.id)!;
  assert.equal(row.case_id, first.case_id);
  const n = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM cases WHERE ownership_id = ? AND kind = 'problem' AND status = 'open'`, ownershipId)!.n;
  assert.equal(n, 1);
  await drainBackground();
});

test('garage describe: a critical fault escalates the case to safety P1 and writes the triage audit', async () => {
  const link = resolveCapabilityLink(db, token)!;
  const model = new ScriptedModel([{ symbol: 'Brake warning', system: 'brakes', urgency: 'P3', sound: 'none', description: 'Brake indicator lit.', safety: false, confidence: 0.7 }]);
  const out = await triageDescription(ctx, link, 'the brake pedal goes to the floor', { model });
  assert.equal(out.urgency, 'P1');
  assert.equal(out.safety, true);
  const row = get<{ case_id: string }>(db, 'SELECT case_id FROM triage_results WHERE id = ?', out.id)!;
  const c = get<{ kind: string; priority: string }>(db, 'SELECT kind, priority FROM cases WHERE id = ?', row.case_id)!;
  assert.equal(c.kind, 'safety');
  assert.equal(c.priority, 'P1');
  assert.ok(get(db, `SELECT 1 FROM audit_log WHERE action = 'triage.p1' AND subject = ?`, row.case_id));
  assert.ok(all(db, `SELECT id FROM triage_results WHERE kind = 'text'`).length >= 3);
  await drainBackground();
});
