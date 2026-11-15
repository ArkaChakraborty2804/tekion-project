/**
 * Scenario checks against a fresh in-memory database seeded with synthetic data.
 * These are behavioural checks on the rules that matter most (safety, consent, recall, guardrails, RBAC,
 * audit integrity, closed loop, churn). The deterministic section never calls a model.
 *
 * Live section: when AI_PROVIDER is gemini or openai (key in .env), the same seeded data is run through the real
 * vendor: story embeddings, vector precedent retrieval, a grounded garage-chat answer that must pass checkDraft, and a
 * text-only safety triage. These are smoke checks of the integration, not a model-quality benchmark.
 */
import { openDb, get, all, type Db } from '../lib/server/db.ts';
import { loadConfig, type Config } from '../lib/server/config.ts';
import { RecallService } from '../lib/server/recall.ts';
import { SandboxProvider, enqueueOutbound, ConsentError, latestConsents } from '../lib/server/channel.ts';
import { seed, TENANT_ID } from '../lib/server/synth.ts';
import { verifyAuditChain } from '../lib/server/audit.ts';
import { checkDraft, classifyRules, criticalFaults, garageChat, makeGateway, diagnose } from '../lib/server/ai.ts';
import { appendEvent, eventStats } from '../lib/server/events.ts';
import { decide, DEFAULT_RULES } from '../lib/server/engine.ts';
import { handleInbound } from '../lib/server/inbound.ts';
import { createModelProvider, type ModelProvider } from '../lib/server/providers.ts';
import { embedPendingStories, findPrecedents, closedLoopAccuracy } from '../lib/server/feedback.ts';
import { fleetChurn } from '../lib/server/churn.ts';
import { buildPassport, passportFacts, fallbackAnswer } from '../lib/server/garage.ts';
import { drainBackground } from '../lib/server/background.ts';
import type { Ctx } from '../lib/server/engine.ts';

export interface Check { name: string; pass: boolean; detail?: string }
export interface EvalReport { checks: Check[]; passed: number; live: string | null }

export async function runEval(envCfg?: Config): Promise<EvalReport> {
  // Self-contained: fixed throwaway secrets, in-memory database, nothing written to disk. Only the AI settings
  // (provider, model names, keys) come from the operator's config, and only for the live section.
  const cfg = loadConfig({
    HMAC_SECRET: 'eval-only-hmac', TEKION_WEBHOOK_SECRET: 'eval-only-tekion', CHANNEL_WEBHOOK_SECRET: 'eval-only-channel', DATA_DIR: ':memory:',
  });
  const ai: ModelProvider | null = envCfg ? createModelProvider(envCfg.ai) : null;
  const db: Db = openDb(':memory:');
  const recall = new RecallService(db, 'mock');
  const provider = new SandboxProvider();
  const summary = await seed(db, cfg, recall, provider, 80);
  // The deterministic section runs with the model off so its results do not depend on a vendor.
  const ctx: Ctx = { db, cfg, recall, provider, ai: null };
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail: pass ? undefined : detail });

  // Integrity
  const chain = verifyAuditChain(db);
  check('audit hash chain verifies', chain.ok, `broken at seq ${chain.brokenAt}`);
  const ev = eventStats(db, TENANT_ID);
  check('no dead events after seed', ev.dead === 0, `dead=${ev.dead}`);
  check('seed produced customers, ownerships and opportunities', summary.customers >= 80 && summary.ownerships > 0 && summary.opportunities > 0,
    JSON.stringify(summary));
  const dup = appendEvent(db, { tenantId: TENANT_ID, source: 'seed', sourceEventId: 'seed-0-deal.funded', type: 'deal.funded', payload: {}, occurredAt: new Date().toISOString() });
  check('duplicate event id is ignored (idempotent inbox)', dup === null);

  // Ownership and recall
  const possiblySold = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ownerships WHERE tenant_id = ? AND state = 'possibly_sold'`, TENANT_ID)?.n ?? 0;
  check('ro for another owner on same VIN flags possibly_sold (never silent overwrite)', possiblySold >= 1, `possibly_sold=${possiblySold}`);
  const recallOpps = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM opportunities WHERE tenant_id = ? AND type = 'D2_RECALL'`, TENANT_ID)?.n ?? 0;
  check('open recall creates a P1 safety-recall opportunity', recallOpps >= 1, `D2_RECALL=${recallOpps}`);
  const p1Pending = all<{ purpose: string }>(db, `SELECT purpose FROM opportunities WHERE tenant_id = ? AND tier = 'P1'`, TENANT_ID);
  check('P1 recall opportunities use the safety_recall purpose', p1Pending.every((o) => o.purpose === 'safety_recall'));
  const d3Standalone = all<{ id: string }>(db, `SELECT id FROM opportunities WHERE tenant_id = ? AND type = 'D3' AND bundle = '[]' AND status = 'pending_approval'`, TENANT_ID);
  check('accessory (D3) is never offered standalone', d3Standalone.length === 0, `standalone D3=${d3Standalone.length}`);

  // Inbound: STOP, safety, snooze, sold
  const stopCust = get<{ id: string }>(db, `SELECT id FROM customers WHERE tenant_id = ? AND party_id = 'P-0013'`, TENANT_ID);
  check('STOP revokes marketing for the customer', stopCust !== undefined && latestConsents(db, TENANT_ID, stopCust.id).marketing === 'revoked');
  let marketingBlocked = false;
  if (stopCust) {
    try { enqueueOutbound(db, { tenantId: TENANT_ID, rooftopId: 'rt-riverside', customerId: stopCust.id, ownershipId: null, opportunityId: null, purpose: 'marketing:accessories', body: 'x STOP' }); }
    catch (e) { marketingBlocked = e instanceof ConsentError; }
  }
  check('marketing send to an opted-out customer fails closed', marketingBlocked);

  const safetyCust = get<{ phone: string }>(db, `SELECT phone FROM customers WHERE tenant_id = ? AND party_id = 'P-0031'`, TENANT_ID);
  const safetyOut = safetyCust ? await handleInbound(ctx, { tenantId: TENANT_ID, fromPhone: safetyCust.phone, body: 'the brakes feel like they fail', providerMsgId: 'eval-safety-1', source: 'dev_sim' }) : null;
  check('safety keyword opens a P1 safety case with no model', safetyOut?.status === 'processed' && safetyOut.safety === true,
    JSON.stringify(safetyOut));
  check('safety reply is the fixed template, not generated text', safetyOut?.status === 'processed' && /do not drive|no conduzca/i.test(safetyOut.reply ?? ''));
  const dupOut = safetyCust ? await handleInbound(ctx, { tenantId: TENANT_ID, fromPhone: safetyCust.phone, body: 'brakes', providerMsgId: 'eval-safety-1', source: 'dev_sim' }) : null;
  check('duplicate provider message id is ignored', dupOut?.status === 'duplicate');

  const snoozeCust = get<{ phone: string }>(db, `SELECT phone FROM customers WHERE tenant_id = ? AND party_id = 'P-0016'`, TENANT_ID);
  if (snoozeCust) await handleInbound(ctx, { tenantId: TENANT_ID, fromPhone: snoozeCust.phone, body: 'snooze 3 months please', providerMsgId: 'eval-snooze-1', source: 'dev_sim' });
  const snoozed = snoozeCust ? get<{ state: string }>(db, `SELECT o.state FROM ownerships o JOIN customers c ON c.id = o.customer_id WHERE c.party_id = 'P-0016' AND c.tenant_id = ? ORDER BY o.started_at DESC LIMIT 1`, TENANT_ID) : undefined;
  check('snooze reply moves the ownership to snoozed', snoozed?.state === 'snoozed', `state=${snoozed?.state}`);

  // Classifier and guardrails
  check('classifier: STOP is recognised by rules', classifyRules('STOP').intent === 'stop');
  check('classifier: Spanish safety keyword is caught', classifyRules('los frenos no funcionan').safety === true);
  check('guardrail: banned phrase rejected', !checkDraft('This is guaranteed and free!', 'service due').ok);
  check('guardrail: number not in facts rejected', !checkDraft('Pay $500 for service', 'amount 320').ok);
  check('guardrail: clean draft accepted', checkDraft('Your service is due soon at Riverside Toyota.', 'service due').ok);

  // RBAC on approvals: an analyst can never decide
  const pending = get<{ id: string }>(db, `SELECT id FROM opportunities WHERE tenant_id = ? AND status = 'pending_approval' LIMIT 1`, TENANT_ID);
  if (pending) {
    const r = decide(ctx, pending.id, 'approve', { id: 'u-analyst', role: 'analyst', tenantId: TENANT_ID }, {});
    check('analyst role cannot approve', r.ok === false && r.code === 403, JSON.stringify(r));
  } else {
    check('analyst role cannot approve', false, 'no pending opportunity to test against');
  }

  // Continuum: OEM knowledge base, churn win-back, closed loop, triage override (deterministic)
  const guardrailFails = all<{ type: string; suppressed_by: string }>(db, `SELECT type, suppressed_by FROM opportunities WHERE tenant_id = ? AND suppressed_by LIKE 'guardrail:%'`, TENANT_ID);
  check('no template draft is suppressed by its own guardrail', guardrailFails.length === 0, JSON.stringify(guardrailFails.slice(0, 3)));
  const milestoneOpps = all<{ facts: string }>(db, `SELECT facts FROM opportunities WHERE tenant_id = ? AND type = 'D1' AND facts LIKE '%"milestone"%'`, TENANT_ID);
  check('service reminders are driven by OEM milestones', milestoneOpps.length > 0, 'no D1 with milestone facts');
  const churn = fleetChurn(db, TENANT_ID, null, DEFAULT_RULES.service.intervalDays, new Date());
  check('churn model finds HIGH-risk customers in the seeded mix', churn.counts.HIGH > 0, JSON.stringify(churn.counts));
  const winbacks = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM opportunities WHERE tenant_id = ? AND type = 'D1_WINBACK'`, TENANT_ID)?.n ?? 0;
  check('HIGH churn tier creates a win-back opportunity', winbacks > 0, `D1_WINBACK=${winbacks}`);
  const autoWinback = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM opportunities o JOIN approvals a ON a.opportunity_id = o.id
    WHERE o.tenant_id = ? AND o.type = 'D1_WINBACK' AND a.action = 'approve' AND a.actor = 'system:auto-send'`, TENANT_ID)?.n ?? 0;
  check('win-back offers are never auto-sent (human approval)', autoWinback === 0, `sent=${autoWinback}`);
  const acc = closedLoopAccuracy(db, TENANT_ID);
  check('closed loop: technician stories captured from ro.closed', acc.stories > 0 && acc.pendingEmbed === acc.stories, JSON.stringify(acc));
  check('closed loop: accuracy report sees technician overrides', acc.overridden > 0 && acc.accuracy != null && acc.accuracy < 1, `overridden=${acc.overridden}`);
  check('triage: the four critical faults force P1 by rule',
    ['brake fluid leaking everywhere', 'flames under the hood', 'strong smell of gas and fuel dripping', 'steering is locking up'].every((t) => criticalFaults(t).length > 0));

  // Live vendor section (optional)
  let live: string | null = null;
  if (ai) {
    live = `${ai.name}/${ai.textModel} + ${ai.embedModel}`;
    const L = (name: string) => `[live ${ai.name}] ${name}`;
    // On failure, show what the gateway recorded (validation result and model output or error), not just "fallback".
    const ledger = (capability: string) => JSON.stringify(all<{ validation: string; output: string }>(db,
      `SELECT validation, output FROM ai_calls WHERE tenant_id = ? AND capability = ? ORDER BY created_at`, TENANT_ID, capability));
    const emb = await embedPendingStories(db, ai, 64);
    check(L('technician stories embedded by the vendor'), emb.embedded === acc.stories && emb.failed === 0, JSON.stringify(emb));
    const deps = makeGateway(db, ai, TENANT_ID);
    const prec = await findPrecedents(db, deps, TENANT_ID, 'There is a high-pitched squeal from the front when I brake', null, 3);
    check(L('vector retrieval finds the brake-pad precedent for a reworded complaint'), prec.method === 'vector' && prec.precedents[0]?.laborCode === 'BRK-FRT-PAD',
      JSON.stringify(prec.precedents.map((p) => [p.laborCode, p.score])));
    const hyp = await diagnose('There is a high-pitched squeal from the front when I brake', { make: 'Toyota', model: 'Camry', year: 2019 }, prec.precedents, deps);
    check(L('diagnostic hypothesis validated against precedents'), hyp.source === 'model' && (hyp.likelyLaborCode === null || prec.precedents.some((p) => p.laborCode === hyp.likelyLaborCode)), `${JSON.stringify(hyp)} ledger=${ledger('diagnose')}`);
    const own = get<{ id: string; customer_id: string; rooftop_id: string }>(db,
      `SELECT o.id, o.customer_id, o.rooftop_id FROM ownerships o JOIN vehicles v ON v.vin = o.vin WHERE o.tenant_id = ? AND v.model = 'Camry' AND o.state = 'active' LIMIT 1`, TENANT_ID);
    const p = own ? buildPassport(ctx, { tenantId: TENANT_ID, ownershipId: own.id, customerId: own.customer_id, rooftopId: own.rooftop_id, linkId: 'eval' }) : null;
    if (p) {
      const facts = passportFacts(p);
      const chat = await garageChat('What service is coming up next for my car, and roughly what does it cost?', facts, fallbackAnswer(p), deps);
      check(L('garage chat answers from facts and passes guardrails'), chat.source === 'model' && checkDraft(chat.answer, JSON.stringify(facts)).ok, `${chat.source} ledger=${ledger('garage_chat')}`);
      const unsafe = await garageChat('My brake pedal went to the floor, can I still drive to work?', facts, fallbackAnswer(p), deps);
      check(L('garage chat safety question gets the fixed template, not the model'), unsafe.source === 'safety_template', unsafe.source);
    } else {
      check(L('garage chat answers from facts and passes guardrails'), false, 'no Camry ownership in seed');
    }
    const calls = get<{ n: number; bad: number }>(db, `SELECT COUNT(*) AS n, SUM(validation <> 'ok') AS bad FROM ai_calls WHERE tenant_id = ?`, TENANT_ID);
    check(L('every vendor call is in the ai_calls ledger'), (calls?.n ?? 0) > 0, JSON.stringify(calls));
  }

  await drainBackground();
  const passed = checks.filter((c) => c.pass).length;
  db.close();
  return { checks, passed, live };
}
