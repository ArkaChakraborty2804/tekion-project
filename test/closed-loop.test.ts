/**
 * Closed-loop learning and Continuum features against a seeded in-memory database:
 * ro.closed technician_story -> technician_stories -> embedding worker -> vector store -> precedent retrieval,
 * accuracy report, fleet churn, garage passport, booking. The model is a scripted fake (no network).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, get, all, type Db } from '../lib/server/db.ts';
import { loadConfig } from '../lib/server/config.ts';
import { RecallService } from '../lib/server/recall.ts';
import { SandboxProvider } from '../lib/server/channel.ts';
import { seed, TENANT_ID } from '../lib/server/synth.ts';
import { handleEvent, type Ctx } from '../lib/server/engine.ts';
import { appendEvent, pump } from '../lib/server/events.ts';
import { embedPendingStories, findPrecedents, closedLoopAccuracy, STORY_COLLECTION } from '../lib/server/feedback.ts';
import { makeGateway, checkDraft } from '../lib/server/ai.ts';
import { vectorStore } from '../lib/server/vector.ts';
import { fleetChurn } from '../lib/server/churn.ts';
import { buildPassport, passportFacts, fallbackAnswer, requestBooking } from '../lib/server/garage.ts';
import { verifyAuditChain } from '../lib/server/audit.ts';
import { ScriptedModel } from './fakes.ts';

let db: Db;
let ctx: Ctx;
const model = new ScriptedModel();

before(async () => {
  const cfg = loadConfig({ HMAC_SECRET: 't', TEKION_WEBHOOK_SECRET: 't', CHANNEL_WEBHOOK_SECRET: 't', DATA_DIR: ':memory:' });
  db = openDb(':memory:');
  const recall = new RecallService(db, 'mock');
  await seed(db, cfg, recall, new SandboxProvider(), 40);
  ctx = { db, cfg, recall, provider: new SandboxProvider(), ai: model };
});
after(() => db.close());

test('closed loop: ro.closed technician stories are stored with the RO, pending embedding, no network in the pump', () => {
  const n = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM technician_stories WHERE tenant_id = ?', TENANT_ID)!.n;
  // Seed: customers with i % 10 < 4 get a story (indexes 0-3, 10-13, 20-23, 30-33 of 40).
  assert.equal(n, 16);
  assert.equal(get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM technician_stories WHERE embed_status <> 'pending'`)!.n, 0);
  assert.equal(model.embedCalls.length, 0, 'the event pump never calls the vendor');
});

test('closed loop: invalid technician_story is rejected and audited; the RO itself is still processed', () => {
  const o = get<{ vin: string; party_id: string }>(db, `SELECT o.vin, c.party_id FROM ownerships o JOIN customers c ON c.id = o.customer_id WHERE o.tenant_id = ? AND o.state = 'active' LIMIT 1`, TENANT_ID)!;
  const closedAt = new Date().toISOString();
  appendEvent(db, { tenantId: TENANT_ID, source: 'test', sourceEventId: 'bad-story-1', type: 'ro.closed', vin: o.vin, occurredAt: closedAt, payload: {
    vin: o.vin, customer_party_id: o.party_id, rooftop_id: 'rt-riverside', ro_id: 'RO-BAD-1', odometer: 41000, closed_at: closedAt, csat: 4, declined: [],
    technician_story: { customer_complaint: 'noise', technician_diagnosis: '', technician_action: 'x', override_occurred: 'no', labor_code: 'X' },
  } });
  const r = pump(db, (ev) => handleEvent(ctx, ev), 10);
  assert.equal(r.dead, 0);
  assert.ok(get(db, `SELECT 1 FROM audit_log WHERE action = 'technician_story.rejected' AND subject = 'RO-BAD-1'`));
  assert.ok(get(db, `SELECT 1 FROM ro_history WHERE ro_id = 'RO-BAD-1'`), 'RO recorded even though the story was invalid');
  assert.equal(get(db, `SELECT 1 FROM technician_stories WHERE ro_id = 'RO-BAD-1'`), undefined);
});

test('closed loop: valid story with PII is redacted, idempotent on ro_id', () => {
  const o = get<{ vin: string; party_id: string }>(db, `SELECT o.vin, c.party_id FROM ownerships o JOIN customers c ON c.id = o.customer_id WHERE o.tenant_id = ? AND o.state = 'active' LIMIT 1 OFFSET 1`, TENANT_ID)!;
  const closedAt = new Date().toISOString();
  const story = { customer_complaint: 'Grinding when braking, call me at 555-010-4477', technician_diagnosis: 'Rear rotors scored', technician_action: 'Replaced rear pads and rotors', override_occurred: false, labor_code: 'BRK-RR-ROT', ai_predicted_service: 'Brake pads' };
  for (const id of ['good-story-1', 'good-story-1-redelivered']) {
    appendEvent(db, { tenantId: TENANT_ID, source: 'test', sourceEventId: id, type: 'ro.closed', vin: o.vin, occurredAt: closedAt, payload: {
      vin: o.vin, customer_party_id: o.party_id, rooftop_id: 'rt-riverside', ro_id: 'RO-GOOD-1', odometer: 42000, closed_at: closedAt, csat: 5, declined: [], technician_story: story,
    } });
  }
  pump(db, (ev) => handleEvent(ctx, ev), 10);
  const rows = all<{ customer_complaint: string }>(db, `SELECT customer_complaint FROM technician_stories WHERE ro_id = 'RO-GOOD-1'`);
  assert.equal(rows.length, 1, 'same ro_id twice -> one story');
  assert.doesNotMatch(rows[0].customer_complaint, /555/);
});

test('closed loop: embedding worker embeds pending stories once, into the per-model vector store', async () => {
  const out = await embedPendingStories(db, model);
  assert.equal(out.failed, 0);
  assert.equal(out.embedded, 17);
  assert.equal(model.embedCalls[0].kind, 'document');
  assert.equal((await embedPendingStories(db, model)).embedded, 0, 'nothing left to embed');
  assert.equal(vectorStore(db, TENANT_ID, STORY_COLLECTION, 'gemini/fake-embed').size, 17);
  const ledger = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ai_calls WHERE capability = 'embed_document' AND validation = 'ok'`)!.n;
  assert.ok(ledger >= 1, 'embedding calls are written to the ai_calls ledger');
});

test('closed loop: switching embedding model re-embeds everything into a separate store', async () => {
  const other = new ScriptedModel([], { name: 'openai', embedModel: 'other-embed', dim: 32 });
  assert.equal((await embedPendingStories(db, other)).embedded, 17);
  assert.equal(vectorStore(db, TENANT_ID, STORY_COLLECTION, 'openai/other-embed').size, 17);
  await embedPendingStories(db, model); // switch back for the remaining tests
});

test('closed loop: a new complaint retrieves the matching technician precedent by vector search', async () => {
  const deps = makeGateway(db, model, TENANT_ID);
  const r = await findPrecedents(db, deps, TENANT_ID, 'My brakes squeal every time I stop', null, 3);
  assert.equal(r.method, 'vector');
  assert.equal(r.model, 'gemini/fake-embed');
  assert.equal(r.precedents.length, 3);
  assert.equal(r.precedents[0].laborCode, 'BRK-FRT-PAD');
  assert.ok(r.precedents[0].score >= r.precedents[1].score);
  const grind = await findPrecedents(db, deps, TENANT_ID, 'grinding noise on a cold start', null, 1);
  assert.equal(grind.precedents[0].laborCode, 'ENG-BLT-TNS');
  assert.equal(grind.precedents[0].wasOverride, true, 'override precedents carry what the AI got wrong');
  assert.equal(grind.precedents[0].aiPredicted, 'Engine oil change');
  assert.equal(model.embedCalls.at(-1)!.kind, 'query');
});

test('closed loop: same-model precedents are preferred, widened to the tenant when too few', async () => {
  const deps = makeGateway(db, model, TENANT_ID);
  const models = all<{ model: string; n: number }>(db, 'SELECT model, COUNT(*) AS n FROM technician_stories GROUP BY model ORDER BY n ASC');
  const rare = models[0];
  const r = await findPrecedents(db, deps, TENANT_ID, 'steering pulls left', rare.model, 3);
  assert.equal(r.precedents.length, 3, 'filled from the wider tenant');
});

test('closed loop: with the model off retrieval degrades to lexical, never errors', async () => {
  const r = await findPrecedents(db, {}, TENANT_ID, 'check engine light rough idle', null, 2);
  assert.equal(r.method, 'lexical');
  assert.equal(r.precedents[0].laborCode, 'ENG-COIL-PLG');
});

test('closed loop: accuracy report counts technician confirmations and overrides of AI predictions', () => {
  const a = closedLoopAccuracy(db, TENANT_ID);
  assert.equal(a.stories, 17);
  assert.equal(a.withPrediction, 17);
  // The seed cycles 5 stories over 16 ROs; stories 3 and 4 are overrides (6 of 16), plus the confirmed test story.
  assert.equal(a.overridden, 6);
  assert.equal(a.confirmed, 11);
  assert.equal(a.accuracy, Number((11 / 17).toFixed(3)));
  assert.equal(a.embedded, 17);
  assert.ok(a.recentOverrides.length > 0 && a.recentOverrides.every((o) => o.predicted && o.actual));
});

test('churn fleet: HIGH-risk customers exist, revenue at risk is the sum of score x annual value, scoped by rooftop', () => {
  const now = new Date();
  const all_ = fleetChurn(db, TENANT_ID, null, 180, now);
  assert.ok(all_.counts.HIGH > 0, JSON.stringify(all_.counts));
  const total = all_.counts.HIGH + all_.counts.MEDIUM + all_.counts.LOW;
  assert.equal(total, all_.all.length);
  const sum = all_.all.reduce((s, r) => s + r.valueAtRisk, 0);
  assert.ok(Math.abs(sum - all_.revenueAtRisk) <= all_.all.length, 'rounded per row');
  for (const r of all_.all) assert.ok(r.score >= 0 && r.score <= 1);
  const scoped = fleetChurn(db, TENANT_ID, ['rt-lakeside'], 180, now);
  assert.ok(scoped.all.length > 0 && scoped.all.every((r) => r.rooftopId === 'rt-lakeside'));
  const top = all_.top[0];
  assert.ok(top.drivers.length > 0, 'every HIGH score has named drivers');
});

test('churn: no stored draft ever failed the guardrail; stored win-back drafts quote the voucher', () => {
  const bad = all<{ type: string; suppressed_by: string }>(db, `SELECT type, suppressed_by FROM opportunities WHERE suppressed_by LIKE 'guardrail:%'`);
  assert.deepEqual(bad, []);
  for (const o of all<{ draft: string; facts: string }>(db, `SELECT draft, facts FROM opportunities WHERE type = 'D1_WINBACK' AND draft IS NOT NULL`)) {
    assert.match(o.draft, /\$40 Loyalty Service Voucher/);
    assert.ok(checkDraft(o.draft, o.facts).ok);
  }
});

test('garage: passport is built from records; facts let checkDraft verify the fallback answer', () => {
  const o = get<{ id: string; customer_id: string; rooftop_id: string }>(db,
    `SELECT o.id, o.customer_id, o.rooftop_id FROM ownerships o JOIN vehicles v ON v.vin = o.vin WHERE o.tenant_id = ? AND v.model = 'Camry' AND v.year = 2019 AND o.state = 'active' LIMIT 1`, TENANT_ID)!;
  const link = { tenantId: TENANT_ID, ownershipId: o.id, customerId: o.customer_id, rooftopId: o.rooftop_id, linkId: 'test-link' };
  const p = buildPassport(ctx, link)!;
  assert.equal(p.vehicle.model, 'Camry');
  assert.equal(p.roadmap.source, 'oem');
  assert.ok(p.roadmap.milestones.filter((m) => m.actionable).length <= 1);
  assert.ok(['Bronze', 'Silver', 'Gold', 'Platinum'].includes(p.loyalty.tier));
  assert.ok(p.recalls.length >= 1, 'the 2019 Camry carries the synthetic fixture recall');
  assert.equal(p.maxUploadMb.image, 15);
  const facts = JSON.stringify(passportFacts(p));
  assert.doesNotMatch(facts, /\+1555|@example/, 'no contact details in the model facts');
  const fb = fallbackAnswer(p);
  assert.ok(checkDraft(fb, facts).ok, `fallback must pass its own guardrail: ${checkDraft(fb, facts).issues.join('; ')} :: ${fb}`);
  assert.equal(buildPassport(ctx, { ...link, tenantId: 'other-tenant' }), null, 'tenant-scoped');

  const b = requestBooking(ctx, link, p.roadmap.next?.mileage ?? null);
  assert.ok(get(db, `SELECT 1 FROM cases WHERE id = ? AND kind = 'callback'`, b.caseId));
  assert.ok(get(db, `SELECT 1 FROM audit_log WHERE action = 'garage.book' AND subject = ?`, b.caseId));
  assert.equal(verifyAuditChain(db).ok, true);
});
