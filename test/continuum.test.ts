/**
 * Unit and behavioural checks for the Continuum features: vector retrieval, churn scoring, OEM knowledge base,
 * triage safety override, provider adapters, gateway retry/fallback, draft guardrails, loyalty, garage chat.
 * No network: providers get a fake fetch and the gateway gets a scripted model (test/fakes.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, LocalVectorStore, PersistentVectorStore, type VectorEntry } from '../lib/server/vector.ts';
import { calculateChurnRisk, churnFeatures, annualServiceValue, WINBACK_VOUCHER, type ChurnFeatures } from '../lib/server/churn.ts';
import { scheduleFor, vehicleRoadmap, equityPeak, OEM_SCHEDULES } from '../lib/server/knowledge.ts';
import { analyzeAudio, triageImage, criticalFaults, garageChat, checkDraft, classifyReply, P1_TRIAGE_TEMPLATE, type AiRecord } from '../lib/server/ai.ts';
import { GeminiProvider, OpenAiProvider, createModelProvider, ProviderError } from '../lib/server/providers.ts';
import { generateCandidates, draft, DEFAULT_RULES } from '../lib/server/engine.ts';
import { loyaltyFor } from '../lib/server/garage.ts';
import { openDb, run } from '../lib/server/db.ts';
import { ScriptedModel, fakeFetch } from './fakes.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-06-10T18:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/* ---------- vector store ---------- */

const meta = (model: string, code: string): VectorEntry['metadata'] => ({
  vinPrefix: 'SYN00000', model, customerComplaint: code, aiPredicted: '', technicianDiagnosis: code, technicianAction: code,
  wasOverride: false, laborCode: code, date: '2026-01-01',
});

test('vector: cosine similarity basics and mismatched dimensions score 0', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 1], [-1, -1]) + 1) < 1e-12);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, 'zero vector never divides by zero');
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0]), 0, 'vectors from different models are incomparable');
});

test('vector: search ranks by similarity, honours topK and the metadata filter, upsert replaces', () => {
  const s = new LocalVectorStore();
  s.upsert({ id: 'a', text: 'a', embedding: [1, 0, 0], metadata: meta('Camry', 'A') });
  s.upsert({ id: 'b', text: 'b', embedding: [0.9, 0.1, 0], metadata: meta('Accord', 'B') });
  s.upsert({ id: 'c', text: 'c', embedding: [0, 0, 1], metadata: meta('Camry', 'C') });
  const top = s.search([1, 0, 0], 2);
  assert.deepEqual(top.map((h) => h.entry.id), ['a', 'b']);
  assert.ok(top[0].similarity >= top[1].similarity);
  assert.deepEqual(s.search([1, 0, 0], 3, (m) => m.model === 'Camry').map((h) => h.entry.id), ['a', 'c']);
  s.upsert({ id: 'a', text: 'a2', embedding: [0, 0, 1], metadata: meta('Camry', 'A') });
  assert.equal(s.size, 3);
  assert.deepEqual(s.search([0, 0, 1], 2).map((h) => h.entry.id).sort(), ['a', 'c']);
  assert.equal(s.search([1, 0, 0], 1)[0].entry.id, 'b', 'replaced entry no longer matches its old vector');
});

test('vector: persistent store survives reload, rejects a different dimension, scopes by tenant and model', () => {
  const db = openDb(':memory:');
  run(db, `INSERT INTO tenants (id, name) VALUES ('t1','T'), ('t2','T2')`);
  const s = PersistentVectorStore.load(db, 't1', 'stories', 'gemini/emb');
  s.upsert({ id: 'x', text: 'x', embedding: [0.25, 0.5, 0.75], metadata: meta('Camry', 'X') });
  assert.throws(() => s.upsert({ id: 'y', text: 'y', embedding: [1, 0], metadata: meta('Camry', 'Y') }), /dimension/);
  const again = PersistentVectorStore.load(db, 't1', 'stories', 'gemini/emb');
  assert.equal(again.size, 1);
  const hit = again.search([0.25, 0.5, 0.75], 1)[0];
  assert.equal(hit.entry.metadata.laborCode, 'X');
  assert.ok(Math.abs(hit.similarity - 1) < 1e-6, 'Float32 round trip keeps the vector');
  assert.deepEqual(again.search([1, 0], 1), [], 'query of the wrong dimension returns nothing');
  assert.equal(PersistentVectorStore.load(db, 't2', 'stories', 'gemini/emb').size, 0, 'other tenant sees nothing');
  assert.equal(PersistentVectorStore.load(db, 't1', 'stories', 'openai/emb').size, 0, 'other embedding model sees nothing');
  db.close();
});

/* ---------- churn (spec Phase 3 algorithm) ---------- */

const f = (o: Partial<ChurnFeatures> = {}): ChurnFeatures => ({
  daysSinceLastService: 100, expectedIntervalDays: 180, declinedServicesCount: 0, lastCsat: 5, ownershipAgeMonths: 24, warrantyExpired: false, ...o,
});

test('churn: healthy customer is LOW with no drivers', () => {
  assert.deepEqual(calculateChurnRisk(f()), { score: 0, tier: 'LOW', drivers: [] });
});

test('churn: every factor at its maximum caps at 1.0 HIGH with four named drivers', () => {
  const r = calculateChurnRisk(f({ daysSinceLastService: 300, declinedServicesCount: 3, lastCsat: 1, warrantyExpired: true }));
  assert.equal(r.score, 1);
  assert.equal(r.tier, 'HIGH');
  assert.equal(r.drivers.length, 4);
  assert.match(r.drivers[0], /^Overdue for service by 67%$/);
  assert.equal(r.drivers[1], '3 previously declined repair(s)');
});

test('churn: recency bands are >1.1 and >1.5 of the expected interval (strict)', () => {
  assert.equal(calculateChurnRisk(f({ daysSinceLastService: 198 })).score, 0, 'ratio 1.1 exactly adds nothing');
  assert.equal(calculateChurnRisk(f({ daysSinceLastService: 199 })).score, 0.15);
  assert.equal(calculateChurnRisk(f({ daysSinceLastService: 270 })).score, 0.15, 'ratio 1.5 exactly is still the lower band');
  assert.equal(calculateChurnRisk(f({ daysSinceLastService: 271 })).score, 0.35);
  assert.equal(calculateChurnRisk(f({ daysSinceLastService: 10, expectedIntervalDays: 0 })).score, 0.35, 'zero interval is clamped to 1 day');
});

test('churn: declined work is 0.15 each, capped at 0.30; CSAT 3 neutral, <=2 severe, null ignored', () => {
  assert.equal(calculateChurnRisk(f({ declinedServicesCount: 1 })).score, 0.15);
  assert.equal(calculateChurnRisk(f({ declinedServicesCount: 5 })).score, 0.3);
  assert.equal(calculateChurnRisk(f({ lastCsat: 3 })).score, 0.15);
  assert.equal(calculateChurnRisk(f({ lastCsat: 2 })).score, 0.35);
  assert.equal(calculateChurnRisk(f({ lastCsat: null })).score, 0);
});

test('churn: tier thresholds are HIGH >= 0.70 and MEDIUM >= 0.40', () => {
  const high = calculateChurnRisk(f({ daysSinceLastService: 300, lastCsat: 1 })); // 0.35 + 0.35
  assert.equal(high.score, 0.7);
  assert.equal(high.tier, 'HIGH');
  const med = calculateChurnRisk(f({ declinedServicesCount: 1, lastCsat: 3, daysSinceLastService: 199 })); // 0.15 x 3
  assert.equal(med.score, 0.45);
  assert.equal(med.tier, 'MEDIUM');
  const low = calculateChurnRisk(f({ warrantyExpired: true, lastCsat: 3 })); // 0.35
  assert.equal(low.tier, 'LOW');
});

test('churn: features from DB rows (warranty by date or miles, bad declined JSON tolerated)', () => {
  const base = { started_at: ago(900), last_service_at: ago(250), last_declined: '[{"item":"pads"},{"item":"filter"}]', last_ro_csat: 4,
    warranty_end_date: ago(-30).slice(0, 10), warranty_end_miles: 36000, estimated_miles: 20000 };
  const x = churnFeatures(base, 180, NOW);
  assert.equal(x.daysSinceLastService, 250);
  assert.equal(x.declinedServicesCount, 2);
  assert.equal(x.warrantyExpired, false);
  assert.equal(x.ownershipAgeMonths, 29);
  assert.equal(churnFeatures({ ...base, estimated_miles: 36001 }, 180, NOW).warrantyExpired, true, 'expired by miles');
  assert.equal(churnFeatures({ ...base, warranty_end_date: ago(1).slice(0, 10) }, 180, NOW).warrantyExpired, true, 'expired by date');
  assert.equal(churnFeatures({ ...base, last_declined: 'not json' }, 180, NOW).declinedServicesCount, 0);
  assert.equal(churnFeatures({ ...base, last_service_at: null }, 180, NOW).daysSinceLastService, 900, 'no RO yet: measured from purchase');
});

test('churn: annual service value comes from the OEM milestones in the next 12 months of driving', () => {
  // Camry at 25,000 driving 12,000/yr reaches the 30k milestone ($410) within the year.
  assert.equal(annualServiceValue('Toyota', 'Camry', 25000, 12000), 410);
  assert.ok(annualServiceValue('Toyota', 'Camry', 900000, 12000) > 0, 'past the table: mean milestone cost');
});

/* ---------- OEM knowledge base ---------- */

test('oem: Camry schedule matches the spec rows; unknown vehicles get the generic schedule', () => {
  const c = scheduleFor('toyota', 'CAMRY');
  assert.equal(c.source, 'oem');
  const m30 = c.milestones.find((m) => m.mileage === 30000)!;
  assert.equal(m30.estCost, 410);
  assert.equal(m30.criticality, 'critical');
  assert.ok(m30.requiredServices.includes('Brake Fluid Exchange'));
  assert.deepEqual(c.milestones.map((m) => m.mileage), [...c.milestones.map((m) => m.mileage)].sort((a, b) => a - b));
  const g = scheduleFor('Ford', 'Model T');
  assert.equal(g.source, 'generic');
  assert.ok(g.milestones.length > 0);
  for (const m of OEM_SCHEDULES) assert.ok(m.estCost > 0 && m.mileage > 0 && m.requiredServices.length > 0, `${m.make} ${m.model} ${m.mileage}`);
});

test('oem: roadmap marks completed, due and upcoming milestones and picks the actionable one', () => {
  const r = vehicleRoadmap({ make: 'Toyota', model: 'Camry', deliveredAt: ago(30 * 30.44), estimatedMiles: 29400,
    lastServiceOdometer: 20100, lastServiceAt: ago(200), now: NOW });
  const by = (mi: number) => r.items.find((i) => i.milestone.mileage === mi)!;
  assert.equal(by(20000).status, 'completed');
  assert.equal(by(10000).status, 'completed', 'earlier milestones implied by a later completed one');
  assert.equal(by(30000).status, 'due');
  assert.equal(by(30000).dueInMiles, 600);
  assert.equal(r.next?.milestone.mileage, 30000);
  const later = r.items.filter((i) => i.milestone.mileage > 30000);
  assert.ok(later.length > 0 && later.every((i) => i.status === 'upcoming'));
});

test('oem: overdue milestone is the actionable one; older missed ones roll into it', () => {
  const r = vehicleRoadmap({ make: 'Toyota', model: 'Camry', deliveredAt: ago(40 * 30.44), estimatedMiles: 33000,
    lastServiceOdometer: 9000, lastServiceAt: ago(900), now: NOW });
  assert.equal(r.next?.milestone.mileage, 30000);
  assert.equal(r.next?.status, 'overdue');
  assert.equal(r.items.filter((i) => i.status === 'due' || i.status === 'overdue').length, 1);
});

test('oem: equity peak is the month before the 36-month / 36,000-mile warranty at the driving rate', () => {
  const early = new Date('2024-02-01');
  assert.equal(equityPeak('2024-01-01', 12000, null, early).month, 35);
  assert.equal(equityPeak('2024-01-01', 18000, null, early).month, 23, 'high-mileage driver reaches 36k at month 24');
  assert.equal(equityPeak('2024-01-01', 1000, null, early).month, 35, 'capped at the 36-month term');
});

test('oem: once the equity peak has passed, the trade-in window is now, never a past date', () => {
  const now = new Date('2026-11-14T00:00:00Z');
  const p = equityPeak('2022-01-01', 12000, '2025-01-01', now);
  assert.equal(p.passed, true);
  assert.equal(p.date, '2026-11-14');
  assert.equal(equityPeak('2025-06-01', 12000, '2028-06-01', now).passed, false);
});

/* ---------- triage: fail-closed safety override ---------- */

const IMG = { mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
const WAV = { mime: 'audio/wav', data: Buffer.from('RIFF0000WAVE') };
const VEH = { make: 'Toyota', model: 'Camry', year: 2019 };

test('triage: the four critical faults are recognised in free text', () => {
  assert.deepEqual(criticalFaults('Red brake warning light came on and the pedal goes to the floor'), ['brake_hydraulic']);
  assert.deepEqual(criticalFaults('smoke coming from under the hood'), ['fire']);
  assert.deepEqual(criticalFaults('I smell gas and there is fuel dripping under the car'), ['fuel_leak']);
  assert.deepEqual(criticalFaults('the steering wheel locked up on the freeway'), ['steering_bind']);
  assert.deepEqual(criticalFaults('squeaky door hinge', 'tire rotation due'), []);
});

for (const [label, modelOut] of [
  ['brake hydraulic', { symbol: 'Red brake warning symbol', system: 'brakes', urgency: 'P3', description: 'Brake system indicator is lit.', safety: false, confidence: 0.8 }],
  ['fire', { symbol: 'Engine bay', system: 'engine', urgency: 'P3', description: 'Smoke is visible coming from the engine bay.', safety: false, confidence: 0.7 }],
  ['fuel leak', { symbol: 'Puddle under car', system: 'fuel', urgency: 'P2', description: 'A fuel leak is visible under the rear of the car.', safety: false, confidence: 0.6 }],
] as const) {
  test(`triage: ${label} forces P1 and the fixed template even when the model says otherwise`, async () => {
    const model = new ScriptedModel([modelOut]);
    const r = await triageImage(IMG, VEH, { model });
    assert.equal(r.urgency, 'P1');
    assert.equal(r.safety, true);
    assert.equal(r.overridden, true);
    assert.equal(r.source, 'model');
    assert.equal(r.customerMessage, P1_TRIAGE_TEMPLATE.en);
    assert.equal(model.calls[0].images?.length, 1, 'the photo itself is sent to the model');
  });
}

test('triage: steering bind in the audio transcript forces P1', async () => {
  const model = new ScriptedModel([{ sound: 'click', transcript: 'the steering wheel locked up on the freeway', system: 'steering', urgency: 'P3', description: 'Clicking sound.', safety: false, confidence: 0.5 }]);
  const r = await analyzeAudio(WAV, { ...VEH, lang: 'es' }, { model });
  assert.equal(r.urgency, 'P1');
  assert.ok(r.safetyReasons.includes('steering_bind'));
  assert.equal(r.customerMessage, P1_TRIAGE_TEMPLATE.es);
  assert.equal(model.calls[0].audio?.[0].mime, 'audio/wav', 'the model hears the recording itself');
});

test('triage: customer note alone forces P1 with the model off (fallback path)', async () => {
  const r = await triageImage(IMG, { ...VEH, note: 'There is fuel leaking from under the car' }, {});
  assert.equal(r.source, 'fallback');
  assert.equal(r.urgency, 'P1');
  assert.ok(r.safetyReasons.includes('fuel_leak'));
});

test('triage: unreadable media with the model off is never routine (P2)', async () => {
  const r = await triageImage(IMG, VEH, {});
  assert.equal(r.urgency, 'P2');
  assert.equal(r.safety, false);
});

test('triage: acoustic floor raises a "routine" grinding noise to P2; model can raise but not lower', async () => {
  const grind = await analyzeAudio(WAV, VEH, { model: new ScriptedModel([{ sound: 'grinding', transcript: '', system: 'brakes', urgency: 'P3', description: 'Metallic grinding from the front wheels during braking.', safety: false, confidence: 0.8 }]) });
  assert.equal(grind.urgency, 'P2');
  assert.equal(grind.overridden, true);
  assert.match(grind.customerMessage, /Metallic grinding/);
  const symbol = await triageImage(IMG, VEH, { model: new ScriptedModel([{ symbol: 'Oil pressure warning', system: 'engine', urgency: 'P3', description: 'Oil can symbol lit.', safety: false, confidence: 0.9 }]) });
  assert.equal(symbol.urgency, 'P1', 'oil pressure symbol floor');
  const modelP1 = await triageImage(IMG, VEH, { model: new ScriptedModel([{ symbol: 'Tire pressure', system: 'tires', urgency: 'P1', description: 'Tire looks flat.', safety: true, confidence: 0.9 }]) });
  assert.equal(modelP1.urgency, 'P1', 'model may raise urgency');
});

test('triage: model description that breaks guardrails is not shown to the customer', async () => {
  const r = await triageImage(IMG, VEH, { model: new ScriptedModel([{ symbol: 'Tire pressure', system: 'tires', urgency: 'P2', description: 'Probably fine, it is safe to drive for 500 miles.', safety: false, confidence: 0.6 }]) });
  assert.equal(r.urgency, 'P2');
  assert.doesNotMatch(r.customerMessage, /safe to drive|500/);
});

/* ---------- gateway: schema validation, one retry, deterministic fallback, ledger ---------- */

const goodTriage = { symbol: 'Check engine', system: 'engine', urgency: 'P2', description: 'Check engine light is on.', safety: false, confidence: 0.7 };

test('gateway: schema failure is retried once with the reason, then the valid answer is used', async () => {
  const rec: AiRecord[] = [];
  const model = new ScriptedModel([{ symbol: 'x', system: 'warp drive', urgency: 'P2', description: 'd', safety: false }, goodTriage]);
  const r = await triageImage(IMG, VEH, { model, record: (x) => rec.push(x) });
  assert.equal(r.source, 'model');
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].system, /previous answer was rejected: system must be one of/);
  assert.deepEqual(rec.map((x) => x.validation), ['schema_fail', 'ok']);
  assert.equal(rec[0].fallback, false);
  assert.match(rec[0].model, /^gemini\/fake-text$/);
});

test('gateway: two schema failures fall back deterministically and are recorded as fallback', async () => {
  const rec: AiRecord[] = [];
  const model = new ScriptedModel(['not an object']);
  const r = await triageImage(IMG, VEH, { model, record: (x) => rec.push(x) });
  assert.equal(r.source, 'fallback');
  assert.equal(r.urgency, 'P2');
  assert.equal(model.calls.length, 2);
  assert.deepEqual(rec.map((x) => [x.validation, x.fallback]), [['schema_fail', false], ['schema_fail', true]]);
});

test('gateway: auth errors are not retried; transient errors are retried once', async () => {
  const rec: AiRecord[] = [];
  const auth = new ScriptedModel([new ProviderError('provider http 401', 401)]);
  await triageImage(IMG, VEH, { model: auth, record: (x) => rec.push(x) });
  assert.equal(auth.calls.length, 1);
  assert.equal(rec[0].validation, 'call_fail');
  assert.equal(rec[0].fallback, true);
  const flaky = new ScriptedModel([new ProviderError('provider http 503', 503), goodTriage]);
  const r = await triageImage(IMG, VEH, { model: flaky });
  assert.equal(flaky.calls.length, 2);
  assert.equal(r.source, 'model');
});

test('gateway: classifier rules win; the model can add safety but never remove it', async () => {
  const lowered = await classifyReply('my brakes failed on the highway', { model: new ScriptedModel([{ intent: 'other', safety: false, confidence: 0.99 }]) });
  assert.equal(lowered.safety, true);
  const stop = await classifyReply('STOP', { model: new ScriptedModel([{ intent: 'booking', safety: false, confidence: 0.99 }]) });
  assert.equal(stop.intent, 'stop');
});

test('gateway: customer text is PII-redacted before it reaches the model', async () => {
  const model = new ScriptedModel([goodTriage]);
  await triageImage(IMG, { ...VEH, note: 'call me at +1 (555) 010-1234 or jo@example.test' }, { model });
  assert.doesNotMatch(model.calls[0].user, /555|jo@example/);
});

/* ---------- provider adapters (fake fetch, no network) ---------- */

const GEM = { apiKey: 'gem-secret-key', model: 'gemini-test', embedModel: 'gem-embed', baseUrl: 'https://vendor.test/v1beta' };
const OAI = { apiKey: 'oai-secret-key', model: 'gpt-test', audioModel: 'gpt-audio-test', embedModel: 'oai-embed', baseUrl: 'https://vendor.test/v1' };

test('gemini: JSON-mode request shape, key in header only, fenced JSON parsed', async () => {
  const { fn, seen } = fakeFetch([{ json: { candidates: [{ content: { parts: [{ text: '```json\n{"ok":true}\n```' }] } }] } }]);
  const p = new GeminiProvider(GEM, 1000, fn);
  assert.deepEqual(await p.generateJson({ system: 'sys', user: 'hello', images: [IMG] }), { ok: true });
  const s = seen[0];
  assert.equal(s.url, 'https://vendor.test/v1beta/models/gemini-test:generateContent');
  assert.doesNotMatch(s.url, /secret/);
  assert.equal(s.headers['x-goog-api-key'], 'gem-secret-key');
  assert.equal(s.body.systemInstruction.parts[0].text, 'sys');
  assert.equal(s.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(s.body.contents[0].parts[0].inline_data.mime_type, 'image/jpeg');
  assert.equal(s.body.contents[0].parts.at(-1).text, 'hello');
});

test('gemini: batch embeddings use retrieval task types and keep order', async () => {
  const { fn, seen } = fakeFetch([{ json: { embeddings: [{ values: [1, 2] }, { values: [3, 4] }] } }]);
  const p = new GeminiProvider(GEM, 1000, fn);
  assert.deepEqual(await p.embed(['a', 'b'], 'query'), [[1, 2], [3, 4]]);
  assert.equal(seen[0].url, 'https://vendor.test/v1beta/models/gem-embed:batchEmbedContents');
  assert.equal(seen[0].body.requests[0].taskType, 'RETRIEVAL_QUERY');
  assert.equal(seen[0].body.requests[1].model, 'models/gem-embed');
  const short = fakeFetch([{ json: { embeddings: [{ values: [1] }] } }]);
  await assert.rejects(new GeminiProvider(GEM, 1000, short.fn).embed(['a', 'b'], 'document'), /mismatch/);
});

test('gemini: webm audio is rejected locally; HTTP errors carry status only, never the key or body', async () => {
  const { fn, seen } = fakeFetch([{ status: 500, json: { error: 'echo gem-secret-key' } }]);
  const p = new GeminiProvider(GEM, 1000, fn);
  await assert.rejects(p.generateJson({ system: 's', user: 'u', audio: [{ mime: 'audio/webm', data: Buffer.from('x') }] }), /not supported/);
  assert.equal(seen.length, 0);
  const err = await p.generateJson({ system: 's', user: 'u' }).catch((e) => e);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.status, 500);
  assert.doesNotMatch(err.message, /secret|echo/);
});

test('openai: text uses JSON mode; audio uses the audio model with wav input_audio and no JSON mode', async () => {
  const reply = { json: { choices: [{ message: { content: '{"a":1}' } }] } };
  const { fn, seen } = fakeFetch([reply]);
  const p = new OpenAiProvider(OAI, 1000, fn);
  assert.deepEqual(await p.generateJson({ system: 's', user: 'u' }), { a: 1 });
  assert.equal(seen[0].url, 'https://vendor.test/v1/chat/completions');
  assert.equal(seen[0].headers.authorization, 'Bearer oai-secret-key');
  assert.equal(seen[0].body.model, 'gpt-test');
  assert.deepEqual(seen[0].body.response_format, { type: 'json_object' });
  assert.equal(seen[0].body.messages[1].content, 'u');
  await p.generateJson({ system: 's', user: 'u', audio: [WAV] });
  assert.equal(seen[1].body.model, 'gpt-audio-test');
  assert.deepEqual(seen[1].body.modalities, ['text']);
  assert.equal(seen[1].body.response_format, undefined);
  assert.equal(seen[1].body.messages[1].content[1].input_audio.format, 'wav');
  await p.generateJson({ system: 's', user: 'u', images: [IMG] });
  assert.match(seen[2].body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  await assert.rejects(p.generateJson({ system: 's', user: 'u', audio: [{ mime: 'audio/webm', data: Buffer.from('x') }] }), /not supported/);
});

test('openai: embeddings are re-ordered by index; non-JSON content is a ProviderError', async () => {
  const { fn } = fakeFetch([{ json: { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] } }]);
  assert.deepEqual(await new OpenAiProvider(OAI, 1000, fn).embed(['a', 'b'], 'document'), [[1], [2]]);
  const bad = fakeFetch([{ json: { choices: [{ message: { content: 'Sure! Here is your answer.' } }] } }]);
  await assert.rejects(new OpenAiProvider(OAI, 1000, bad.fn).generateJson({ system: 's', user: 'u' }), /non-JSON/);
});

test('providers: timeout aborts the request; factory honours AI_PROVIDER', async () => {
  const hang = (_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
  await assert.rejects(new OpenAiProvider(OAI, 20, hang).generateJson({ system: 's', user: 'u' }), /provider timeout/);
  const cfg = { timeoutMs: 1000, gemini: GEM, openai: OAI };
  assert.equal(createModelProvider({ ...cfg, provider: 'off' }), null);
  assert.equal(createModelProvider({ ...cfg, provider: 'gemini' })?.name, 'gemini');
  assert.equal(createModelProvider({ ...cfg, provider: 'openai' })?.textModel, 'gpt-test');
});

/* ---------- drafts: milestone and win-back pass checkDraft ---------- */

test('drafts: OEM milestone and churn win-back drafts quote only facts and pass guardrails (en and es)', () => {
  const own = { id: 'o1', tenant_id: 't', rooftop_id: 'r', vin: 'SYN0001', customer_id: 'c', state: 'active', started_at: ago(34 * 30.44),
    snooze_until: null, unanswered_count: 0, last_service_at: ago(300), last_service_odometer: 20100, last_ro_csat: 1,
    last_declined: '[{"item":"brake pads"},{"item":"cabin air filter"}]' };
  for (const veh of [
    { vin: 'SYN0001', make: 'Toyota', model: 'Camry', year: 2019 },
    { vin: 'SYN0001', make: 'Tesla', model: 'Model 3', year: 2022 },
  ]) {
    const v = { ...veh, odometer: 29000, odometer_at: ago(10), warranty_end_date: ago(20).slice(0, 10), warranty_end_miles: 36000, loan_end_date: null, insurance_renewal_date: null, annual_miles: 12000 };
    const cands = generateCandidates(own, v, DEFAULT_RULES, NOW, [], 'Riverside Toyota (demo)');
    const d1 = cands.find((c) => c.type === 'D1');
    const wb = cands.find((c) => c.type === 'D1_WINBACK');
    assert.ok(d1, `${veh.model}: service candidate`);
    assert.ok(wb, `${veh.model}: HIGH churn produces a win-back`);
    assert.equal(wb.facts.voucher, WINBACK_VOUCHER.label);
    assert.equal(wb.purpose, 'marketing:winback');
    for (const c of [d1, wb]) {
      for (const lang of ['en', 'es']) {
        const text = draft(c, [], lang, 'Alex', '+15550100');
        const res = checkDraft(text, JSON.stringify(c.facts));
        assert.ok(res.ok, `${veh.model} ${c.type} ${lang}: ${res.issues.join('; ')} :: ${text}`);
      }
    }
    if (veh.make === 'Toyota') {
      assert.equal(d1.facts.estCost, '$410');
      assert.match(draft(d1, [], 'en', 'Alex', ''), /30,000-Mile Major Factory Milestone.*\$410/);
      assert.match(draft(wb, [], 'en', 'Alex', ''), /\$40 Loyalty Service Voucher/);
    }
  }
});

test('drafts: guardrail rejects invented numbers, banned claims, links and phone numbers', () => {
  const facts = JSON.stringify({ milestone: '30,000-Mile Major Factory Milestone', estCost: '$410' });
  assert.equal(checkDraft('Your 30,000-Mile Major Factory Milestone is est. $410 today', facts).ok, true);
  assert.equal(checkDraft('Your service is $350', facts).ok, false);
  assert.equal(checkDraft('Brake check is free', facts).ok, false);
  assert.equal(checkDraft('It is safe to drive', facts).ok, false);
  assert.equal(checkDraft('Book at https://evil.test/x', facts).ok, false);
  assert.equal(checkDraft('Call 555 010 1234 now', facts).ok, false);
});

/* ---------- loyalty and garage chat ---------- */

test('loyalty: points per RO and tenure month map to tiers', () => {
  assert.deepEqual([loyaltyFor(0, 0).tier, loyaltyFor(0, 0).pointsToNext], ['Bronze', 300]);
  assert.equal(loyaltyFor(3, 0).tier, 'Silver');
  assert.equal(loyaltyFor(5, 30).points, 800);
  assert.equal(loyaltyFor(5, 30).tier, 'Gold');
  const top = loyaltyFor(10, 60);
  assert.equal(top.tier, 'Platinum');
  assert.equal(top.nextTier, null);
  assert.equal(loyaltyFor(1, -5).points, 100, 'negative tenure is clamped');
});

const FACTS = { vehicle: '2019 Toyota Camry', milestones: [{ title: '30,000-Mile Major Factory Milestone', mileage: '30,000', estimatedCost: '$410', status: 'due' }] };

test('garage chat: grounded model answer is accepted', async () => {
  const model = new ScriptedModel([{ answer: 'Your 30,000-Mile Major Factory Milestone is due, est. $410 at the dealer', escalate: false }]);
  const r = await garageChat('What is due next?', FACTS, 'fallback', { model });
  assert.equal(r.source, 'model');
  assert.match(r.answer, /\$410/);
  assert.match(model.calls[0].user, /FACTS: .*30,000/);
});

test('garage chat: hallucinated numbers fail the guardrail twice and the deterministic fallback is used', async () => {
  const model = new ScriptedModel([{ answer: 'That service costs $129 and is guaranteed.', escalate: false }]);
  const r = await garageChat('How much is my next service?', FACTS, 'FALLBACK', { model });
  assert.equal(model.calls.length, 2);
  assert.equal(r.source, 'fallback');
  assert.equal(r.answer, 'FALLBACK');
  assert.equal(r.escalate, true);
});

test('garage chat: safety wording returns the fixed template without calling the model', async () => {
  const model = new ScriptedModel([{ answer: 'x', escalate: false }]);
  const r = await garageChat('There is smoke coming out of the dashboard', FACTS, 'fb', { model });
  assert.equal(r.source, 'safety_template');
  assert.equal(r.safety, true);
  assert.equal(model.calls.length, 0);
});
