/**
 * Synthetic demo data only. No real customers, VINs, phone numbers or campaigns.
 * Phones use the 555-01xx range reserved for fiction. VINs are fabricated and do not carry valid check digits.
 * Data is generated through the same event path as production (appendEvent -> pump -> handleEvent),
 * so the seed also exercises the real engine.
 */
import { randomUUID } from 'node:crypto';
import { all, get, run, tx, type Db } from './db.ts';
import type { Config } from './config.ts';
import { clock, DAY_MS } from './clock.ts';
import { audit } from './audit.ts';
import { appendEvent, pump } from './events.ts';
import { decide, handleEvent, evaluateAll, DEFAULT_RULES, type Ctx } from './engine.ts';
import { handleInbound } from './inbound.ts';
import type { RecallService } from './recall.ts';
import type { Provider } from './channel.ts';
import { dispatchQueued, recordConsent } from './channel.ts';

export const TENANT_ID = 'tenant-demo';

export const ROOFTOPS = [
  { id: 'rt-riverside', name: 'Riverside Toyota (demo)', tz: 'America/Los_Angeles', phone: '+15550100' },
  { id: 'rt-lakeside', name: 'Lakeside Honda (demo)', tz: 'America/Chicago', phone: '+15550101' },
] as const;

export const USERS = [
  { id: 'u-admin', sub: 'dev-admin', name: 'Demo Group Admin', role: 'group_admin', rooftops: ['*'] },
  { id: 'u-manager', sub: 'dev-manager', name: 'Demo Rooftop Manager', role: 'rooftop_manager', rooftops: ['rt-riverside'] },
  { id: 'u-advisor', sub: 'dev-advisor', name: 'Demo Service Advisor', role: 'service_advisor', rooftops: ['rt-riverside', 'rt-lakeside'] },
  { id: 'u-approver', sub: 'dev-approver', name: 'Demo Approver', role: 'approver', rooftops: ['rt-riverside', 'rt-lakeside'] },
  { id: 'u-analyst', sub: 'dev-analyst', name: 'Demo Analyst', role: 'analyst', rooftops: ['*'] },
  { id: 'u-support', sub: 'dev-support', name: 'Demo Support', role: 'support', rooftops: ['*'] },
] as const;

/**
 * Recall fixtures are keyed by model year (recall.ts), so customers 0 and 1 are pre-owned sales of these exact
 * vehicles. Every other customer gets a model year derived from the vehicle's in-service date.
 */
const RECALL_VEHICLES = [
  { make: 'Toyota', model: 'Camry', year: 2019 },
  { make: 'Honda', model: 'Accord', year: 2018 },
] as const;
const MODELS = [
  { make: 'Toyota', model: 'Camry' }, { make: 'Toyota', model: 'RAV4' }, { make: 'Toyota', model: 'Corolla' },
  { make: 'Honda', model: 'Civic' }, { make: 'Honda', model: 'CR-V' }, { make: 'Honda', model: 'Accord' },
  { make: 'Ford', model: 'Escape' },
  { make: 'Tesla', model: 'Model 3' }, // EV: generic schedule, no oil milestones
] as const;

/** Visit habits drive the service history: who services here on schedule, who drifted away, who never came back. */
type Habit = 'regular' | 'lapsed' | 'none';

/**
 * Closed-ROs with technician stories (spec: closed-loop learning). Some are AI-prediction overrides, so the
 * accuracy report and precedent retrieval have real disagreements to show.
 */
const STORIES = [
  { customer_complaint: 'Brakes squeal when I stop', technician_diagnosis: 'Front pads worn below 3 mm', technician_action: 'Replaced front pads, resurfaced rotors', labor_code: 'BRK-FRT-PAD', ai_predicted_service: 'Brake pads', override_occurred: false },
  { customer_complaint: 'Steering wheel pulls to the left', technician_diagnosis: 'Front left tie rod end loose', technician_action: 'Replaced tie rod end, four-wheel alignment', labor_code: 'STR-TRE-ALN', ai_predicted_service: 'Wheel alignment', override_occurred: false },
  { customer_complaint: 'Car shakes at highway speed', technician_diagnosis: 'Rear tire out of balance, cupping', technician_action: 'Rotated and balanced all four tires', labor_code: 'TIR-ROT-BAL', ai_predicted_service: 'Suspension inspection', override_occurred: true },
  { customer_complaint: 'Grinding noise on cold start', technician_diagnosis: 'Serpentine belt tensioner bearing worn', technician_action: 'Replaced tensioner and belt', labor_code: 'ENG-BLT-TNS', ai_predicted_service: 'Engine oil change', override_occurred: true },
  { customer_complaint: 'Check engine light on, rough idle', technician_diagnosis: 'Ignition coil on cylinder 3 failed (P0303)', technician_action: 'Replaced coil and spark plug', labor_code: 'ENG-COIL-PLG', ai_predicted_service: 'Ignition coil', override_occurred: false },
] as const;

const FIRST = ['Alex', 'Jordan', 'Sam', 'Priya', 'Mateo', 'Lucia', 'Chen', 'Aisha', 'Ravi', 'Emma', 'Diego', 'Noor', 'Ken', 'Olivia', 'Yusuf', 'Sofia'];
const LAST = ['Rivera', 'Patel', 'Nakamura', 'Okafor', 'Silva', 'Garcia', 'Kim', 'Haddad', 'Brown', 'Singh', 'Lopez', 'Novak'];
const ALPHA = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

/** mulberry32: deterministic PRNG so the demo is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedSummary { tenantId: string; customers: number; ownerships: number; opportunities: number; scenarios: Record<string, string> }

export async function seed(db: Db, cfg: Config, recall: RecallService, provider: Provider, count = 80): Promise<SeedSummary> {
  const existing = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM tenants')?.n ?? 0;
  if (existing > 0) throw new Error('database already seeded. Use a fresh DATA_DIR (delete data/ yourself) to reseed.');
  const ctx: Ctx = { db, cfg, recall, provider };
  const rnd = prng(20260511);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  tx(db, () => {
    run(db, 'INSERT INTO tenants (id, name) VALUES (?,?)', TENANT_ID, 'Demo Dealer Group (synthetic)');
    for (const r of ROOFTOPS) run(db, 'INSERT INTO rooftops (id, tenant_id, name, tz, phone) VALUES (?,?,?,?,?)', r.id, TENANT_ID, r.name, r.tz, r.phone);
    for (const u of USERS) {
      run(db, 'INSERT INTO users (id, tenant_id, sub, name, role, rooftop_ids) VALUES (?,?,?,?,?,?)', u.id, TENANT_ID, u.sub, u.name, u.role, JSON.stringify(u.rooftops));
    }
    run(db, `INSERT INTO rule_versions (id, tenant_id, version, body, status, created_by, created_at, published_at)
      VALUES (?,?,?,?,'published','u-admin',?,?)`, randomUUID(), TENANT_ID, 1, JSON.stringify(DEFAULT_RULES), clock.iso(), clock.iso());
    audit(db, TENANT_ID, 'system:seed', 'seed.complete', TENANT_ID, { customers: count });
  });

  const scenarios: Record<string, string> = {};
  const now = clock.now();
  const events: Array<{ type: string; data: Record<string, any>; at: Date; rooftop: string }> = [];
  const iso = (d: Date) => d.toISOString();
  const daysFrom = (n: number) => new Date(now.getTime() + n * DAY_MS);
  let storyCount = 0; // cycles through every STORIES entry

  const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
  const dateOnly = (d: Date) => iso(d).slice(0, 10);

  for (let i = 0; i < count; i++) {
    const rooftop = i % 3 === 0 ? ROOFTOPS[1] : ROOFTOPS[0];
    const vin = `SYN${String(i).padStart(4, '0')}${Array.from({ length: 10 }, () => ALPHA[Math.floor(rnd() * ALPHA.length)]).join('')}`;
    const party = `P-${String(i + 1).padStart(4, '0')}`;
    const phone = `${rooftop.phone}${String(i + 10).padStart(2, '0')}`; // +1555010 0 nn -> fictional
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const language = i % 9 === 4 ? 'es' : 'en';
    const annualMiles = 10_500 + Math.floor(rnd() * 3000); // the engine estimates with 12,000/yr; real drivers vary
    const lapsedWarranty = i % 8 === 3;   // basic warranty ended a month ago (churn cliff)
    const warrantyEnding = !lapsedWarranty && i % 10 === 0; // ends in 40 days (D4 window)
    const unhappy = i % 8 === 5;          // CSAT 1 and several declines on the last visit
    // Unhappy customers drift away: they are the lapsed, high-churn cohort the win-back targets.
    const habit: Habit = unhappy ? 'lapsed' : i % 10 < 7 ? 'regular' : i % 10 < 9 ? 'lapsed' : 'none';

    // Vehicle and its timeline: in service (new) -> sold to this customer (new or pre-owned) -> visits -> today.
    const fixture = i < RECALL_VEHICLES.length ? RECALL_VEHICLES[i] : null;
    const model = fixture ?? pick(MODELS);
    let inService: Date;
    if (fixture) inService = new Date(Date.UTC(fixture.year - 1, 9, 1) + Math.floor(rnd() * 200) * DAY_MS);
    else if (lapsedWarranty) inService = addMonths(daysFrom(-30), -36);
    else if (warrantyEnding) inService = addMonths(daysFrom(40), -36);
    else inService = daysFrom(-(150 + Math.floor(rnd() * 1400)));
    const year = fixture?.year ?? inService.getUTCFullYear() + (inService.getUTCMonth() >= 8 ? 1 : 0);
    // Older than ~4 years: this dealer sold it pre-owned in the last 1-3 years. Otherwise sold new.
    const preOwned = now.getTime() - inService.getTime() > 4 * 365 * DAY_MS;
    const soldAt = preOwned ? daysFrom(-(400 + Math.floor(rnd() * 700))) : inService;
    const milesAt = (d: Date) => Math.round(((d.getTime() - inService.getTime()) / (365 * DAY_MS)) * annualMiles) + 12;
    const warrantyEnd = addMonths(inService, 36);
    // Financing: 60-month loans from the sale date; every 7th customer's loan matures in 80 days (D6 window).
    const financed = rnd() < 0.7;
    const loanEnd = i % 7 === 0 && soldAt < addMonths(now, -24) ? daysFrom(80) : financed ? addMonths(soldAt, 60) : null;
    // Insurance data exists only where the dealer arranged the policy (every 3rd customer, HLD 01 open question 2).
    // It renews on the sale anniversary; every 12th customer renews in 35 days (D5 window).
    let insuranceRenewal: Date | null = null;
    if (i % 3 === 0) {
      insuranceRenewal = new Date(soldAt);
      while (insuranceRenewal <= now) insuranceRenewal = addMonths(insuranceRenewal, 12);
      if (i % 12 === 0) insuranceRenewal = daysFrom(35);
    }

    const customer = { name, phone, language, tz: rooftop.tz, email: `demo${i + 1}@example.test` };
    const base = { vin, make: model.make, model: model.model, year, customer_party_id: party, customer, rooftop_id: rooftop.id };
    events.push({ type: 'deal.funded', rooftop: rooftop.id, at: soldAt, data: {
      ...base, odometer: milesAt(soldAt), sold_at: iso(soldAt), warranty_end_date: dateOnly(warrantyEnd), warranty_end_miles: 36000,
      loan_end_date: loanEnd ? dateOnly(loanEnd) : null, insurance_renewal_date: insuranceRenewal ? dateOnly(insuranceRenewal) : null,
    } });

    // Service visits after the sale: roughly every 5-7 months, as owners do for oil and inspections. OEM milestones are
    // completed when a visit's odometer reaches them (knowledge.ts). Lapsed owners stopped 12-20 months ago; "none"
    // never serviced here.
    const stopAfter = habit === 'regular' ? daysFrom(-3) : habit === 'lapsed' ? daysFrom(-(365 + Math.floor(rnd() * 240))) : soldAt;
    const visits: Date[] = [];
    for (let d = new Date(soldAt.getTime() + (150 + Math.floor(rnd() * 60)) * DAY_MS); d <= stopAfter;
      d = new Date(d.getTime() + (150 + Math.floor(rnd() * 60)) * DAY_MS)) visits.push(d);
    // Customers who carry a technician story (closed-loop demo) had at least one visit.
    if (i % 10 < 4 && visits.length === 0) visits.push(new Date(Math.min(soldAt.getTime() + 60 * DAY_MS, now.getTime() - 10 * DAY_MS)));
    visits.forEach((closedAt, n) => {
      const last = n === visits.length - 1;
      const story = last && i % 10 < 4 ? STORIES[storyCount++ % STORIES.length] : undefined;
      events.push({ type: 'ro.closed', rooftop: rooftop.id, at: closedAt, data: {
        ...base, ro_id: `RO-${party}-${n + 1}`, odometer: milesAt(closedAt), closed_at: iso(closedAt),
        csat: last && unhappy ? 1 : 3 + Math.floor(rnd() * 3),
        declined: !last ? [] : unhappy ? [{ item: 'brake pads' }, { item: 'cabin air filter' }, { item: 'tire rotation' }] : i % 8 === 0 ? [{ item: 'brake pads' }] : [],
        technician_story: story ? { ...story } : undefined,
      } });
    });

    // Scenario: possibly sold. A different customer's repair order on the same VIN.
    if (i === 20) {
      const other = `P-9${String(i).padStart(3, '0')}`;
      events.push({ type: 'ro.closed', rooftop: rooftop.id, at: now, data: { vin, make: model.make, model: model.model, year, customer_party_id: other, customer: { name: 'Other Owner (synthetic)', phone: `${rooftop.phone}99`, language: 'en' }, rooftop_id: rooftop.id, ro_id: `RO-${other}-1`, odometer: milesAt(now), closed_at: iso(now), csat: 4, declined: [] } });
      scenarios.possibly_sold = `VIN ${vin}`;
    }
    // Scenario: new owner. A later deal funded to a new customer on the VIN of customer 21 (a trade-in resold).
    if (i === 21) {
      events.push({ type: 'deal.funded', rooftop: rooftop.id, at: now, data: { ...base, customer_party_id: `P-NEW-${i}`, customer: { name: 'New Owner (synthetic)', phone: `${rooftop.phone}98`, language: 'en' }, odometer: milesAt(now), sold_at: iso(now), warranty_end_date: dateOnly(warrantyEnd), warranty_end_miles: 36000, loan_end_date: null, insurance_renewal_date: null } });
      scenarios.new_owner = 'customer 21 VIN re-funded';
    }
  }

  // Ingest through the real event path (idempotent by event_id) in time order, then drain and evaluate.
  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  events.forEach((e, idx) => {
    appendEvent(db, {
      tenantId: TENANT_ID, source: 'seed', sourceEventId: `seed-${idx}-${e.type}`, type: e.type,
      vin: e.data.vin ?? null, payload: { ...e.data, rooftop_id: e.data.rooftop_id ?? e.rooftop }, occurredAt: iso(e.at),
    });
  });
  pump(db, (ev) => handleEvent(ctx, ev), 10_000);

  // Demo consent: every synthetic customer has service, safety and marketing granted (disclosure v1), so
  // scenarios can be exercised. Real onboarding captures consent through the dealer's own flows.
  for (const c of all<{ id: string }>(db, 'SELECT id FROM customers WHERE tenant_id = ?', TENANT_ID)) {
    for (const purpose of ['service', 'safety_recall', 'marketing'] as const) recordConsent(db, TENANT_ID, c.id, purpose, 'granted', 'demo_seed');
  }

  // Recall fixtures (synthetic) for the Camry and Accord cohorts.
  const owns = all<{ vin: string; make: string; model: string; year: number }>(db,
    `SELECT o.vin, v.make, v.model, v.year FROM ownerships o JOIN vehicles v ON v.vin = o.vin WHERE o.tenant_id = ?`, TENANT_ID);
  for (const o of owns) await recall.lookup(TENANT_ID, o.vin, o.make, o.model, o.year, true);
  scenarios.recall = 'customers P-0001 (2019 Camry, SYN-24V-001) and P-0002 (2018 Accord, SYN-25V-014) have fixture recalls';

  evaluateAll(ctx, TENANT_ID);

  // A month of operation: about 60% of the initial backlog was approved and sent 5-28 days ago (no replies yet).
  // Today's queue is then realistic in size, and the cap and cadence rules have recent sends to hold new items back.
  const backlog = all<{ id: string }>(db, `SELECT id FROM opportunities WHERE tenant_id = ? AND status = 'pending_approval' AND tier <> 'P1' ORDER BY id`, TENANT_ID);
  for (const o of backlog) {
    if (rnd() >= 0.6) continue;
    const r = decide(ctx, o.id, 'approve', { id: 'u-approver', role: 'approver', tenantId: TENANT_ID }, {});
    if (!r.ok) continue;
    const sentAt = iso(daysFrom(-(5 + Math.floor(rnd() * 24))));
    run(db, `UPDATE messages SET created_at = ?, send_after = NULL WHERE opportunity_id = ?`, sentAt, o.id);
    run(db, `UPDATE approvals SET created_at = ? WHERE opportunity_id = ?`, sentAt, o.id);
    run(db, `UPDATE opportunities SET updated_at = ? WHERE id = ?`, sentAt, o.id);
  }
  dispatchQueued(db, provider);
  run(db, `UPDATE ownerships SET last_outbound_at = (SELECT MAX(created_at) FROM messages m WHERE m.ownership_id = ownerships.id AND m.direction = 'out')
    WHERE tenant_id = ? AND last_outbound_at IS NOT NULL`, TENANT_ID);
  evaluateAll(ctx, TENANT_ID);

  // Customer-side scenarios driven through the inbound path (same code as SMS).
  const phoneOf = (i: number) => `${ROOFTOPS[i % 3 === 0 ? 1 : 0].phone}${String(i + 10).padStart(2, '0')}`;
  const inbound = (i: number, text: string, purpose: string) => handleInbound(ctx, { tenantId: TENANT_ID, fromPhone: phoneOf(i), body: text, providerMsgId: `seed:${purpose}:${i}`, source: 'dev_sim' });
  await inbound(12, 'STOP', 'stop');
  scenarios.opted_out = 'customer 12 replied STOP (marketing and service revoked)';
  await inbound(15, 'Please snooze for 3 months', 'snooze');
  scenarios.snooze = 'customer 15 snoozed (3 months)';
  await inbound(30, 'My brakes feel like they fail when I stop', 'safety');
  scenarios.safety = 'customer 30 safety reply: P1 case + fixed template';
  await inbound(40, 'I sold my car last week', 'sold');
  scenarios.sold_reply = 'customer 40 says sold: possibly_sold + callback case';
  run(db, `UPDATE ownerships SET unanswered_count = 6 WHERE customer_id = (SELECT id FROM customers WHERE tenant_id = ? AND party_id = 'P-0051')`, TENANT_ID);
  scenarios.non_responder = 'customer P-0051 has 6 unanswered (decay rules apply)';
  scenarios.spanish = `customers with language=es (every 9th starting at index 4)`;

  const counts = get<{ c: number; o: number; p: number }>(db,
    `SELECT (SELECT COUNT(*) FROM customers WHERE tenant_id = ?) AS c, (SELECT COUNT(*) FROM ownerships WHERE tenant_id = ?) AS o, (SELECT COUNT(*) FROM opportunities WHERE tenant_id = ?) AS p`,
    TENANT_ID, TENANT_ID, TENANT_ID)!;
  return { tenantId: TENANT_ID, customers: counts.c, ownerships: counts.o, opportunities: counts.p, scenarios };
}
