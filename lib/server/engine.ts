/**
 * Journey & decision engine (HLD 01). Deterministic rules + weighted scoring. No ML training.
 * Flow: event -> ownership state -> candidate opportunities (rules) -> bundle -> policy gate
 *       -> draft + guardrails -> approval queue (or P1 immediate send with advisor case).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { all, get, run, tx, type Db } from './db.ts';
import { clock, daysBetween } from './clock.ts';
import { audit } from './audit.ts';
import { evaluatePolicy, sendPlan, type PolicyInput, type Tier } from './policy.ts';
import { checkDraft } from './ai.ts';
import { vehicleRoadmap, estimateMiles, fmtMiles, SCHEDULE_SOURCE_NOTE } from './knowledge.ts';
import { calculateChurnRisk, churnFeatures, WINBACK_VOUCHER } from './churn.ts';
import { recordTechnicianStory, validateTechnicianStory } from './feedback.ts';
import type { ModelProvider } from './providers.ts';
import { dispatchQueued, enqueueOutbound, latestConsents, nonSafetySends, type Provider } from './channel.ts';
import type { RecallService } from './recall.ts';
import type { Config } from './config.ts';
import type { EventRow, RoClosedPayload } from './events.ts';

export interface Rules {
  service: { intervalDays: number; intervalMiles: number; dueWindowDays: number; avgTicket: number };
  warranty: { windowDays: number; avgTicket: number };
  insurance: { windowDays: number; avgTicket: number };
  loan: { windowDays: number; avgTicket: number };
  review: { minDays: number; maxDays: number; minCsat: number; avgTicket: number };
  accessory: { avgTicket: number };
  autoSendTypes: string[];
  autoSendMinManual: number;
}

export const DEFAULT_RULES: Rules = {
  service: { intervalDays: 180, intervalMiles: 6000, dueWindowDays: 14, avgTicket: 320 },
  warranty: { windowDays: 60, avgTicket: 1800 },
  insurance: { windowDays: 60, avgTicket: 900 },
  loan: { windowDays: 90, avgTicket: 2500 },
  review: { minDays: 3, maxDays: 21, minCsat: 4, avgTicket: 0 },
  accessory: { avgTicket: 150 },
  autoSendTypes: [],
  autoSendMinManual: 20,
};

/** Guardrails on dealer tuning (HLD 01 §4): bounded ranges; cap, P1 and consent are not configurable. */
export function validateRules(r: Rules): string[] {
  const errs: string[] = [];
  const range = (name: string, v: number, min: number, max: number) => {
    if (!(v >= min && v <= max)) errs.push(`${name} must be between ${min} and ${max}`);
  };
  range('service.intervalDays', r.service.intervalDays, 60, 365);
  range('service.intervalMiles', r.service.intervalMiles, 1000, 15000);
  range('service.dueWindowDays', r.service.dueWindowDays, 1, 30);
  range('review.minCsat', r.review.minCsat, 1, 5);
  if (r.autoSendTypes.some((t) => !['D1', 'D3', 'D4', 'D5', 'D6', 'D7'].includes(t))) errs.push('autoSendTypes may only contain D1,D3-D7 (recall and problem messages are never automated)');
  return errs;
}

export function loadRules(db: Db, tenantId: string): { id: string; version: number; rules: Rules } {
  const row = get<{ id: string; version: number; body: string }>(db,
    `SELECT id, version, body FROM rule_versions WHERE tenant_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1`, tenantId);
  if (!row) return { id: 'defaults', version: 0, rules: DEFAULT_RULES };
  return { id: row.id, version: row.version, rules: { ...DEFAULT_RULES, ...JSON.parse(row.body) } };
}

/** ai: vendor model provider (Gemini/OpenAI), or null when AI_PROVIDER=off. Never called inside handleEvent (sync tx). */
export interface Ctx { db: Db; cfg: Config; recall: RecallService; provider: Provider; ai?: ModelProvider | null }

type OwnRow = {
  id: string; tenant_id: string; rooftop_id: string; vin: string; customer_id: string; state: string; started_at: string;
  snooze_until: string | null; unanswered_count: number; last_service_at: string | null; last_service_odometer: number | null;
  last_ro_csat: number | null; last_declined: string;
};
type VehRow = { vin: string; make: string; model: string; year: number; odometer: number | null; odometer_at: string | null;
  warranty_end_date: string | null; warranty_end_miles: number | null; loan_end_date: string | null; insurance_renewal_date: string | null; annual_miles: number };
type CustRow = { id: string; full_name: string; language: string; tz: string; phone: string | null };
type RoofRow = { id: string; name: string; tz: string; phone: string };

interface Candidate {
  type: string; need: string; tier: Tier; score: number; purpose: string; dedupeKey: string;
  dueAt: Date | null; expiresAt: Date | null; reason: string; facts: Record<string, string | number>; ruleId: string;
}

const hmac = (cfg: Config, s: string) => createHmac('sha256', cfg.hmacSecret).update(s).digest('hex');
export const phoneHash = (cfg: Config, phone: string) => hmac(cfg, normPhone(phone));
export const normPhone = (p: string) => '+' + p.replace(/\D/g, '');
const iso = (d: Date) => d.toISOString();
const dateOnly = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/* ---------- entity upserts ---------- */

export function upsertCustomer(ctx: Ctx, tenantId: string, rooftopId: string, partyId: string, c: { name: string; phone?: string; email?: string; language?: string; tz?: string }): string {
  const existing = get<{ id: string }>(ctx.db, 'SELECT id FROM customers WHERE tenant_id = ? AND party_id = ?', tenantId, partyId);
  const phone = c.phone ? normPhone(c.phone) : null;
  if (existing) {
    run(ctx.db, `UPDATE customers SET full_name = ?, phone = COALESCE(?, phone), phone_hash = COALESCE(?, phone_hash), email = COALESCE(?, email), language = COALESCE(?, language), tz = COALESCE(?, tz) WHERE id = ?`,
      c.name, phone, phone ? phoneHash(ctx.cfg, phone) : null, c.email ?? null, c.language ?? null, c.tz ?? null, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  const rooftop = get<RoofRow>(ctx.db, 'SELECT * FROM rooftops WHERE id = ?', rooftopId);
  run(ctx.db, `INSERT INTO customers (id, tenant_id, rooftop_id, party_id, full_name, phone, email, language, tz, phone_hash, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, tenantId, rooftopId, partyId, c.name, phone, c.email ?? null, c.language ?? 'en',
    c.tz ?? rooftop?.tz ?? 'UTC', phone ? phoneHash(ctx.cfg, phone) : null, clock.iso());
  return id;
}

export function upsertVehicle(ctx: Ctx, tenantId: string, v: Partial<VehRow> & { vin: string }): void {
  const cur = get<VehRow>(ctx.db, 'SELECT * FROM vehicles WHERE vin = ?', v.vin);
  if (cur) {
    run(ctx.db, `UPDATE vehicles SET odometer = COALESCE(?, odometer), odometer_at = COALESCE(?, odometer_at),
      warranty_end_date = COALESCE(?, warranty_end_date), warranty_end_miles = COALESCE(?, warranty_end_miles),
      loan_end_date = COALESCE(?, loan_end_date), insurance_renewal_date = COALESCE(?, insurance_renewal_date) WHERE vin = ?`,
      v.odometer ?? null, v.odometer_at ?? null, v.warranty_end_date ?? null, v.warranty_end_miles ?? null,
      v.loan_end_date ?? null, v.insurance_renewal_date ?? null, v.vin);
    return;
  }
  run(ctx.db, `INSERT INTO vehicles (vin, tenant_id, make, model, year, odometer, odometer_at, warranty_end_date, warranty_end_miles, loan_end_date, insurance_renewal_date, annual_miles)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, v.vin, tenantId, v.make ?? 'Unknown', v.model ?? 'Unknown', v.year ?? 0,
    v.odometer ?? null, v.odometer_at ?? null, v.warranty_end_date ?? null, v.warranty_end_miles ?? null,
    v.loan_end_date ?? null, v.insurance_renewal_date ?? null, 12000);
}

/** One open ownership per VIN. A different customer on the same VIN flags the old record, never silently overwrites. */
export function ensureOwnership(ctx: Ctx, tenantId: string, rooftopId: string, vin: string, customerId: string, startedAt: string, mode: 'deal' | 'ro'): string {
  const open = get<OwnRow>(ctx.db, `SELECT * FROM ownerships WHERE vin = ? AND state IN ('active','snoozed','dormant','possibly_sold')`, vin);
  if (open && open.customer_id === customerId) return open.id;
  let state: 'active' | 'possibly_sold' = 'active';
  if (open) {
    if (mode === 'deal') {
      run(ctx.db, `UPDATE ownerships SET state = 'sold', ended_at = ?, end_reason = 'deal_funded_new_owner', updated_at = ?, version = version + 1 WHERE id = ?`, clock.iso(), clock.iso(), open.id);
      audit(ctx.db, tenantId, 'system:engine', 'ownership.sold', open.id, { reason: 'deal_funded_new_owner' });
    } else {
      run(ctx.db, `UPDATE ownerships SET state = 'possibly_sold', updated_at = ?, version = version + 1 WHERE id = ?`, clock.iso(), open.id);
      state = 'possibly_sold';
      caseFor(ctx, tenantId, rooftopId, open.id, customerId, 'callback', 'P2', `VIN ${vin} seen on a repair order for a different customer. Confirm the sale before contacting.`);
    }
  }
  const id = randomUUID();
  run(ctx.db, `INSERT INTO ownerships (id, tenant_id, rooftop_id, vin, customer_id, state, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    id, tenantId, rooftopId, vin, customerId, state, startedAt, clock.iso());
  return id;
}

export function caseFor(ctx: Ctx, tenantId: string, rooftopId: string, ownershipId: string | null, customerId: string, kind: 'safety' | 'problem' | 'callback' | 'question', priority: string, summary: string, body = ''): string {
  const id = randomUUID();
  run(ctx.db, `INSERT INTO cases (id, tenant_id, rooftop_id, ownership_id, customer_id, kind, priority, status, summary, body, created_at)
    VALUES (?,?,?,?,?,?,?, 'open', ?, ?, ?)`, id, tenantId, rooftopId, ownershipId, customerId, kind, priority, summary, body, clock.iso());
  audit(ctx.db, tenantId, 'system:engine', 'case.opened', id, { kind, priority });
  return id;
}

/* ---------- event handling (called from the pump, one transaction per event) ---------- */

export function handleEvent(ctx: Ctx, ev: EventRow): void {
  const p = JSON.parse(ev.payload) as Record<string, any>;
  const tenantId = ev.tenant_id;
  const rooftopId = (p.rooftop_id as string) ?? (get<{ id: string }>(ctx.db, 'SELECT id FROM rooftops WHERE tenant_id = ? ORDER BY id LIMIT 1', tenantId)?.id as string);
  if (!rooftopId) throw new Error('no rooftop for tenant');
  switch (ev.type) {
    case 'deal.funded': {
      upsertVehicle(ctx, tenantId, { vin: p.vin, make: p.make, model: p.model, year: p.year, odometer: p.odometer, odometer_at: p.sold_at, warranty_end_date: p.warranty_end_date, warranty_end_miles: p.warranty_end_miles, loan_end_date: p.loan_end_date, insurance_renewal_date: p.insurance_renewal_date });
      const customerId = upsertCustomer(ctx, tenantId, rooftopId, p.customer_party_id, p.customer);
      const ownId = ensureOwnership(ctx, tenantId, rooftopId, p.vin, customerId, p.sold_at, 'deal');
      run(ctx.db, `UPDATE ownerships SET state = 'active', updated_at = ? WHERE id = ? AND state = 'possibly_sold'`, clock.iso(), ownId);
      evaluateOwnership(ctx, ownId);
      return;
    }
    case 'ro.closed': {
      const ro = p as RoClosedPayload;
      const customerId = upsertCustomer(ctx, tenantId, rooftopId, ro.customer_party_id, ro.customer ?? { name: 'Customer' });
      upsertVehicle(ctx, tenantId, { vin: ro.vin, make: ro.make, model: ro.model, year: ro.year, odometer: ro.odometer, odometer_at: ro.closed_at });
      const ownId = ensureOwnership(ctx, tenantId, rooftopId, ro.vin, customerId, ro.closed_at, 'ro');
      const declined = JSON.stringify((ro.declined ?? []).map((d) => d.item).slice(0, 5));
      run(ctx.db, `UPDATE ownerships SET last_service_at = ?, last_service_odometer = ?, last_ro_csat = ?, last_declined = ?,
        updated_at = ?, version = version + 1 WHERE id = ?`,
        ro.closed_at, ro.odometer ?? null, ro.csat ?? null, declined, clock.iso(), ownId);
      const roId = String(ro.ro_id ?? ev.source_event_id);
      run(ctx.db, `INSERT OR IGNORE INTO ro_history (id, tenant_id, rooftop_id, ownership_id, vin, ro_id, closed_at, odometer, csat, declined, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(), tenantId, rooftopId, ownId, ro.vin, roId, ro.closed_at, ro.odometer ?? null, ro.csat ?? null, declined, clock.iso());
      // Closed loop (spec Phase 2): persist the technician story atomically with the RO; embedding happens async.
      if (ro.technician_story !== undefined && ro.technician_story !== null) {
        const story = validateTechnicianStory(ro.technician_story);
        if (typeof story === 'string') {
          // A malformed story must not dead-letter the RO itself: record the rejection and continue.
          audit(ctx.db, tenantId, 'system:closed_loop', 'technician_story.rejected', roId, { error: story });
        } else {
          const veh = get<{ make: string; model: string }>(ctx.db, 'SELECT make, model FROM vehicles WHERE vin = ?', ro.vin);
          recordTechnicianStory(ctx.db, { tenantId, rooftopId, roId, vin: ro.vin, make: veh?.make ?? ro.make ?? 'Unknown', model: veh?.model ?? ro.model ?? 'Unknown', closedAt: ro.closed_at }, story);
        }
      }
      evaluateOwnership(ctx, ownId);
      return;
    }
    case 'vehicle.updated': {
      upsertVehicle(ctx, tenantId, { vin: p.vin, odometer: p.odometer, odometer_at: p.odometer_at, warranty_end_date: p.warranty_end_date, warranty_end_miles: p.warranty_end_miles, loan_end_date: p.loan_end_date, insurance_renewal_date: p.insurance_renewal_date });
      for (const o of all<{ id: string }>(ctx.db, `SELECT id FROM ownerships WHERE vin = ? AND state IN ('active','snoozed','dormant')`, p.vin)) evaluateOwnership(ctx, o.id);
      return;
    }
    case 'ownership.ended': {
      run(ctx.db, `UPDATE ownerships SET state = 'closed', ended_at = ?, end_reason = ?, updated_at = ?, version = version + 1 WHERE vin = ? AND state IN ('active','snoozed','dormant','possibly_sold')`,
        clock.iso(), String(p.reason ?? 'unknown'), clock.iso(), p.vin);
      return;
    }
    default:
      throw new Error(`unknown event type ${ev.type}`);
  }
}

/* ---------- candidate generation (rules) ---------- */

export function estimateOdometer(v: VehRow, now: Date): { miles: number | null; confidence: number } {
  return estimateMiles(v.odometer, v.odometer_at, v.annual_miles, now);
}

export function generateCandidates(own: OwnRow, veh: VehRow, rules: Rules, now: Date, recall: Array<{ campaign: string; component: string; summary: string }>, rooftopName: string): Candidate[] {
  const out: Candidate[] = [];
  const base = { ruleId: 'rules@1' };
  const est = estimateOdometer(veh, now);
  const facts = (extra: Record<string, string | number>) => ({ vehicle: `${veh.year} ${veh.make} ${veh.model}`, dealer: rooftopName, ...extra });

  // Recall: P1, safety purpose, never bundled.
  for (const r of recall) {
    out.push({ ...base, type: 'D2_RECALL', need: 'C_SAFETY_RECALL', tier: 'P1', score: 1e6, purpose: 'safety_recall',
      dedupeKey: `recall:${r.campaign}`, dueAt: now, expiresAt: null, reason: `Open recall ${r.campaign} on this VIN (${r.component}).`,
      facts: facts({ campaign: r.campaign, component: r.component }) });
  }

  // Service due. Primary: the vehicle's OEM maintenance milestone (knowledge.ts). Fallback: dealer time/mileage interval.
  const lastSvc = own.last_service_at ? new Date(own.last_service_at) : new Date(own.started_at);
  const roadmap = vehicleRoadmap({ make: veh.make, model: veh.model, deliveredAt: own.started_at, estimatedMiles: est.miles,
    lastServiceOdometer: own.last_service_odometer, lastServiceAt: own.last_service_at, now });
  const ms = roadmap.next && (roadmap.next.status === 'due' || roadmap.next.status === 'overdue') ? roadmap.next : null;
  let svcKey: string | null = null;
  let svcConf = 0.9;
  let milestoneFacts: Record<string, string | number> = {};
  if (ms) {
    const m = ms.milestone;
    svcConf = est.miles != null ? Math.max(0.6, est.confidence) : 0.6;
    svcKey = `D1:${m.mileage}`;
    milestoneFacts = {
      milestone: m.title, mileage: fmtMiles(m.mileage), services: m.requiredServices.join(', '), parts: m.parts.join(', '),
      estCost: `$${m.estCost}`, criticality: m.criticality, dueBy: ms.dueBy, milestoneStatus: ms.status, scheduleSource: roadmap.source,
    };
    const when = ms.dueInMiles == null ? `calendar interval (${m.intervalMonths} months) reached`
      : ms.dueInMiles >= 0 ? `estimated ${fmtMiles(ms.dueInMiles)} miles before the milestone` : `estimated ${fmtMiles(-ms.dueInMiles)} miles past the milestone`;
    out.push({ ...base, type: 'D1', need: 'C1_SERVICE_DUE', tier: 'P3', score: m.estCost * svcConf, purpose: 'service',
      dedupeKey: svcKey, dueAt: now, expiresAt: addDays(now, 21),
      reason: `${roadmap.source === 'oem' ? 'OEM' : 'Generic'} ${m.title} ${ms.status}: ${when}. ${SCHEDULE_SOURCE_NOTE}`,
      facts: facts(milestoneFacts) });
  } else {
    const dueByTime = addDays(lastSvc, rules.service.intervalDays);
    const lastOdo = own.last_service_odometer ?? veh.odometer;
    const dueByMiles = lastOdo != null ? lastOdo + rules.service.intervalMiles : null;
    const timeDue = daysBetween(now, dueByTime) <= rules.service.dueWindowDays;
    const milesDue = dueByMiles != null && est.miles != null && est.miles >= dueByMiles - 500;
    if (timeDue || milesDue) {
      svcConf = milesDue && !timeDue ? est.confidence : 0.9;
      svcKey = `D1:${dateOnly(dueByTime).slice(0, 7)}`;
      out.push({ ...base, type: 'D1', need: 'C1_SERVICE_DUE', tier: 'P3', score: rules.service.avgTicket * svcConf, purpose: 'service',
        dedupeKey: svcKey, dueAt: dueByTime < now ? now : dueByTime, expiresAt: addDays(now, 14),
        reason: timeDue ? `Last service ${dateOnly(lastSvc)}; ${rules.service.intervalDays}-day interval reached.` : `Estimated mileage ${est.miles} (confidence ${est.confidence}) passed the service interval.`,
        facts: facts({ dueDate: dateOnly(dueByTime), lastService: dateOnly(lastSvc) }) });
    }
  }
  if (svcKey) {
    // Accessories (D3) exist only as a secondary attached to this service item (see bundle()).
    out.push({ ...base, type: 'D3', need: 'C3_ACCESSORY', tier: 'P4', score: rules.accessory.avgTicket * svcConf, purpose: 'marketing:accessories',
      dedupeKey: `D3:${svcKey}`, dueAt: null, expiresAt: addDays(now, 14), reason: 'Accessory option for the scheduled service.', facts: facts({}) });
  }

  // Churn win-back (spec Phase 3): HIGH churn tier -> incentive offer. Marketing purpose, so the full TCPA gate
  // (marketing consent, quiet hours, frequency cap) applies. Never auto-sent (validateRules rejects it).
  const risk = calculateChurnRisk(churnFeatures({ ...own, ...veh, estimated_miles: est.miles }, rules.service.intervalDays, now));
  if (risk.tier === 'HIGH') {
    out.push({ ...base, type: 'D1_WINBACK', need: 'C1_SERVICE_WINBACK', tier: 'P3', score: risk.score * (rules.service.avgTicket + (ms ? ms.milestone.estCost : 0)),
      purpose: 'marketing:winback', dedupeKey: `WB:${dateOnly(lastSvc)}`, dueAt: now, expiresAt: addDays(now, 30),
      reason: `Churn risk ${risk.score} (HIGH): ${risk.drivers.join('; ')}.`,
      facts: facts({ voucher: WINBACK_VOUCHER.label, churnScore: risk.score, drivers: risk.drivers.join('; '), ...milestoneFacts }) });
  }

  // Declined repair follow-up from the last RO (P3).
  const declined = JSON.parse(own.last_declined || '[]') as string[];
  if (declined.length) {
    out.push({ ...base, type: 'D2_FOLLOWUP', need: 'C2_REPAIR', tier: 'P3', score: 200, purpose: 'service',
      dedupeKey: `D2F:${own.last_service_at ?? ''}`, dueAt: now, expiresAt: addDays(now, 60), reason: `Declined on last visit: ${declined.join(', ')}.`,
      facts: facts({ items: declined.join(', ') }) });
  }

  // Warranty, insurance, loan maturity windows (P4, marketing).
  const window = (d: string | null, days: number) => d != null && daysBetween(now, new Date(d)) >= 0 && daysBetween(now, new Date(d)) <= days;
  if (window(veh.warranty_end_date, rules.warranty.windowDays)) {
    out.push({ ...base, type: 'D4', need: 'C4_WARRANTY_ENDING', tier: 'P4', score: rules.warranty.avgTicket * 0.3, purpose: 'marketing:warranty',
      dedupeKey: `D4:${dateOnly(veh.warranty_end_date!)}`, dueAt: new Date(veh.warranty_end_date!), expiresAt: null,
      reason: `Factory warranty ends ${dateOnly(veh.warranty_end_date!)}.`, facts: facts({ warrantyEnd: dateOnly(veh.warranty_end_date!) }) });
  }
  if (window(veh.insurance_renewal_date, rules.insurance.windowDays)) {
    out.push({ ...base, type: 'D5', need: 'C5_INSURANCE_RENEWAL', tier: 'P4', score: rules.insurance.avgTicket * 0.2, purpose: 'marketing:insurance',
      dedupeKey: `D5:${dateOnly(veh.insurance_renewal_date!)}`, dueAt: new Date(veh.insurance_renewal_date!), expiresAt: null,
      reason: `Insurance renewal ${dateOnly(veh.insurance_renewal_date!)}.`, facts: facts({ insuranceDate: dateOnly(veh.insurance_renewal_date!) }) });
  }
  if (window(veh.loan_end_date, rules.loan.windowDays)) {
    out.push({ ...base, type: 'D6', need: 'C6_LOAN_ENDING', tier: 'P4', score: rules.loan.avgTicket * 0.1, purpose: 'marketing:trade_in',
      dedupeKey: `D6:${dateOnly(veh.loan_end_date!)}`, dueAt: new Date(veh.loan_end_date!), expiresAt: null,
      reason: `Loan matures ${dateOnly(veh.loan_end_date!)}.`, facts: facts({ loanEnd: dateOnly(veh.loan_end_date!) }) });
  }

  // Review request: only after a good-experience signal (P5).
  if (own.last_ro_csat != null && own.last_ro_csat >= rules.review.minCsat && own.last_service_at) {
    const d = daysBetween(new Date(own.last_service_at), now);
    if (d >= rules.review.minDays && d <= rules.review.maxDays) {
      out.push({ ...base, type: 'D7', need: 'C7_REVIEW', tier: 'P5', score: 1, purpose: 'marketing:review', dedupeKey: `D7:${own.last_service_at.slice(0, 10)}`,
        dueAt: null, expiresAt: addDays(now, 21), reason: `Positive RO feedback (CSAT ${own.last_ro_csat}).`, facts: facts({}) });
    }
  }
  return out;
}

const SECONDARY_ALLOWED = new Set(['D3', 'D4', 'D5']);
const sortKey = (c: Candidate) => [Number(c.tier.slice(1)), c.dueAt ? c.dueAt.getTime() : Infinity, -c.score] as const;

/**
 * Bundle rule (HLD 01 §3): one primary + up to two secondaries, service-led only.
 * D3 accessories never stand alone. Recall and problem messages are never bundled.
 */
export function bundle(cands: Candidate[], now: Date): Array<{ primary: Candidate; secondaries: Candidate[] }> {
  const groups: Array<{ primary: Candidate; secondaries: Candidate[] }> = cands.filter((c) => c.tier === 'P1').map((c) => ({ primary: c, secondaries: [] }));
  const used = new Set<Candidate>();
  const service = cands.filter((c) => c.type === 'D1' || c.type === 'D2_FOLLOWUP').sort((a, b) => cmp(sortKey(a), sortKey(b)));
  for (const s of service) {
    const sec: Candidate[] = [];
    if (s.type === 'D1') {
      for (const t of ['D4', 'D5', 'D3']) {
        const c = cands.find((x) => x.type === t && !used.has(x));
        if (!c || sec.length >= 2 || !SECONDARY_ALLOWED.has(t)) continue;
        if ((t === 'D4' || t === 'D5') && daysBetween(now, c.dueAt ?? now) > 60) continue;
        sec.push(c);
        used.add(c);
      }
    }
    used.add(s);
    groups.push({ primary: s, secondaries: sec });
  }
  // Remaining candidates stand alone, one message each. D3 never stands alone.
  for (const c of cands) {
    if (c.tier === 'P1' || used.has(c) || c.type === 'D3') continue;
    groups.push({ primary: c, secondaries: [] });
  }
  return groups.sort((a, b) => cmp(sortKey(a.primary), sortKey(b.primary)));
}

function cmp(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/* ---------- drafting (templates with facts; numbers only from facts) ---------- */

const OPT_OUT = { en: 'Reply STOP to opt out.', es: 'Responda STOP para cancelar.' } as const;
const SAFETY_TEMPLATE = (f: Record<string, string | number>) =>
  `Safety notice from ${f.dealer}: a recall (${f.campaign}, ${f.component}) may apply to your ${f.vehicle}. Please call ${f.phone} to book the repair. The dealer will repair this at no charge. If you notice stalling, warning lights, or any unusual behavior, do not drive; call us.`;

export function draft(c: Candidate, secondaries: Candidate[], lang: 'en' | 'es' | string, first: string, rooftopPhone: string): string {
  const es = lang === 'es';
  if (c.purpose === 'safety_recall') return SAFETY_TEMPLATE({ ...c.facts, phone: rooftopPhone });
  const lines: string[] = [];
  // Milestone and win-back drafts quote only facts (title, services, "$410", voucher label), so checkDraft can verify every number.
  if (c.type === 'D1' && c.facts.milestone) lines.push(es
    ? `Hola ${first}, su ${c.facts.vehicle} esta listo para su ${c.facts.milestone}: ${c.facts.services} (est. ${c.facts.estCost}). Responda BOOK para agendar o SNOOZE para recordarle despues.`
    : `Hi ${first}, your ${c.facts.vehicle} is due for its ${c.facts.milestone}: ${c.facts.services} (est. ${c.facts.estCost}). Reply BOOK to schedule or SNOOZE to be reminded later.`);
  else if (c.type === 'D1_WINBACK') {
    const due = c.facts.milestone ? (es ? ` Ya le corresponde su ${c.facts.milestone}.` : ` Your ${c.facts.milestone} is coming due.`) : '';
    lines.push(es
      ? `Hola ${first}, lo extranamos en ${c.facts.dealer}. Como agradecimiento, tiene un ${c.facts.voucher} para su ${c.facts.vehicle} en su proxima visita.${due} Responda BOOK para agendar.`
      : `Hi ${first}, we miss seeing you at ${c.facts.dealer}. As a thank-you, here is a ${c.facts.voucher} for your ${c.facts.vehicle} at your next visit.${due} Reply BOOK to schedule.`);
  }
  else if (c.type === 'D1') lines.push(es ? `Hola ${first}, su ${c.facts.vehicle} necesita servicio (${c.facts.dueDate}). Responda BOOK para agendar o SNOOZE para recordarle despues.` : `Hi ${first}, your ${c.facts.vehicle} is due for service (${c.facts.dueDate}). Reply BOOK to schedule or SNOOZE to be reminded later.`);
  else if (c.type === 'D2_FOLLOWUP') lines.push(es ? `Hola ${first}, en su ultima visita quedo pendiente: ${c.facts.items}. Responda BOOK para revisarlo.` : `Hi ${first}, at your last visit we noted this still needs attention: ${c.facts.items}. Reply BOOK to review it.`);
  else if (c.type === 'D4') lines.push(`Hi ${first}, your factory warranty on the ${c.facts.vehicle} ends ${c.facts.warrantyEnd}. We can talk through extended coverage options.`);
  else if (c.type === 'D5') lines.push(`Hi ${first}, your insurance on the ${c.facts.vehicle} renews ${c.facts.insuranceDate}. We can help you compare renewal options.`);
  else if (c.type === 'D6') lines.push(`Hi ${first}, your loan on the ${c.facts.vehicle} matures ${c.facts.loanEnd}. We can talk about trade-in options whenever you are ready.`);
  else if (c.type === 'D7') lines.push(`Hi ${first}, thank you for visiting ${c.facts.dealer}. Would you share a quick review of your experience?`);
  for (const s of secondaries) {
    if (s.type === 'D3') lines.push('We can also look at accessories for your car.');
    if (s.type === 'D4') lines.push(`Your factory warranty ends ${s.facts.warrantyEnd}; ask us about extended coverage.`);
    if (s.type === 'D5') lines.push(`Your insurance renews ${s.facts.insuranceDate}; we can help compare options.`);
  }
  const body = lines.join(' ') + ' ' + (c.purpose.startsWith('marketing') || secondaries.length ? (es ? OPT_OUT.es : OPT_OUT.en) : '');
  return body.trim();
}

/* ---------- evaluation: candidates -> bundle -> policy -> queue ---------- */

/** Opportunity types this customer declined within the 12-month memory window (policy check 5). */
function declinedTypes(db: Db, tenantId: string, customerId: string, now: Date): Set<string> {
  return new Set(all<{ type: string }>(db,
    `SELECT DISTINCT o.type FROM approvals a JOIN opportunities o ON o.id = a.opportunity_id
     WHERE a.tenant_id = ? AND a.reason_code = 'customer_declined' AND a.created_at >= ?
       AND o.ownership_id IN (SELECT id FROM ownerships WHERE customer_id = ?)`,
    tenantId, iso(addDays(now, -365)), customerId).map((r) => r.type));
}

export function evaluateOwnership(ctx: Ctx, ownershipId: string): void {
  const db = ctx.db;
  const own = get<OwnRow>(db, 'SELECT * FROM ownerships WHERE id = ?', ownershipId);
  if (!own || own.state === 'sold' || own.state === 'closed') return;
  const now = clock.now();
  if (own.state === 'snoozed' && own.snooze_until && now >= new Date(own.snooze_until)) {
    run(db, `UPDATE ownerships SET state = 'active', snooze_until = NULL WHERE id = ?`, own.id);
    own.state = 'active';
  }
  const veh = get<VehRow>(db, 'SELECT * FROM vehicles WHERE vin = ?', own.vin);
  const cust = get<CustRow>(db, 'SELECT id, full_name, language, tz, phone FROM customers WHERE id = ?', own.customer_id);
  const roof = get<RoofRow>(db, 'SELECT id, name, tz, phone FROM rooftops WHERE id = ?', own.rooftop_id);
  if (!veh || !cust || !roof) return;
  const { rules, id: ruleId } = loadRules(db, own.tenant_id);
  const recall = ctx.recall.openFindings(own.tenant_id, own.vin);
  let cands = generateCandidates(own, veh, rules, now, recall, roof.name).map((c) => ({ ...c, ruleId }));
  const consents = latestConsents(db, own.tenant_id, own.customer_id);
  // A deliverable win-back already carries the due milestone, so it replaces the plain service reminder (one message,
  // not two). Without marketing consent the win-back is suppressed by the gate and the service reminder goes instead.
  const wb = cands.find((c) => c.type === 'D1_WINBACK');
  if (wb && consents.marketing === 'granted'
    && !get(db, `SELECT 1 FROM opportunities WHERE ownership_id = ? AND dedupe_key = ? AND status IN ('sent','rejected')`, own.id, wb.dedupeKey)) {
    cands = cands.filter((c) => c.type !== 'D1' && c.type !== 'D3');
  }
  const sends = nonSafetySends(db, own.tenant_id, own.customer_id, now);
  const declined = declinedTypes(db, own.tenant_id, own.customer_id, now);
  const first = cust.full_name.split(' ')[0] || 'there';
  const lang = cust.language || 'en';

  // Retire open candidates that no longer apply (expired or rule no longer fires).
  const liveKeys = new Set(cands.map((c) => c.dedupeKey));
  for (const row of all<{ id: string; dedupe_key: string; expires_at: string | null }>(db,
    `SELECT id, dedupe_key, expires_at FROM opportunities WHERE ownership_id = ? AND status = 'candidate'`, own.id)) {
    if (!liveKeys.has(row.dedupe_key) || (row.expires_at && now > new Date(row.expires_at))) {
      run(db, `UPDATE opportunities SET status = 'expired', updated_at = ? WHERE id = ?`, clock.iso(), row.id);
    }
  }

  for (const group of bundle(cands, now)) {
    const primary = group.primary;
    let secondaries = group.secondaries;
    // Marketing secondaries need marketing consent; without it, send the service part only.
    if (consents.marketing !== 'granted') secondaries = secondaries.filter((s) => !s.purpose.startsWith('marketing'));
    const purpose = secondaries.some((s) => s.purpose.startsWith('marketing')) && primary.purpose === 'service' ? 'marketing:bundle' : primary.purpose;
    // Already handled for this dedupe key (sent, rejected): do not re-propose the same item.
    if (get(db, `SELECT 1 FROM opportunities WHERE ownership_id = ? AND dedupe_key = ? AND status IN ('sent','rejected')`, own.id, primary.dedupeKey)) continue;
    const oppId = upsertOpportunity(db, own, roof, { ...primary, purpose }, secondaries);

    if (primary.tier === 'P1') {
      // P1 bypasses contact checks 4-6 but still needs consent, and sends immediately with a fixed template.
      const body = draft(primary, [], lang, first, roof.phone);
      try {
        enqueueOutbound(db, { tenantId: own.tenant_id, rooftopId: own.rooftop_id, customerId: own.customer_id, ownershipId: own.id, opportunityId: oppId, purpose: 'safety_recall', body });
        dispatchQueued(db, ctx.provider);
        run(db, `UPDATE opportunities SET status = 'sent', updated_at = ? WHERE id = ?`, clock.iso(), oppId);
        caseFor(ctx, own.tenant_id, own.rooftop_id, own.id, own.customer_id, 'safety', 'P1', `Recall ${primary.facts.campaign} notice sent. Advisor to call customer.`, primary.reason);
      } catch (err) {
        run(db, `UPDATE opportunities SET suppressed_by = ?, updated_at = ? WHERE id = ?`, `consent: ${(err as Error).message}`, clock.iso(), oppId);
      }
      continue;
    }

    const input: PolicyInput = {
      purpose: purpose as PolicyInput['purpose'], tier: primary.tier, oppType: primary.type, now,
      consent: consents, ownershipState: own.state as PolicyInput['ownershipState'],
      snoozeUntil: own.snooze_until ? new Date(own.snooze_until) : null,
      nonSafetySends30d: sends.count, lastNonSafetySendAt: sends.last, unansweredCount: own.unanswered_count, declinedTypes: declined,
    };
    const verdict = evaluatePolicy(input);
    if (!verdict.allowed) {
      run(db, `UPDATE opportunities SET status = 'candidate', suppressed_by = ?, updated_at = ? WHERE id = ?`, `${verdict.check}: ${verdict.reason}`, clock.iso(), oppId);
      continue;
    }
    const text = draft(primary, secondaries, lang, first, roof.phone);
    const factText = JSON.stringify({ ...primary.facts, ...Object.assign({}, ...secondaries.map((s) => s.facts)) });
    const check = checkDraft(text, factText);
    if (!check.ok) {
      run(db, `UPDATE opportunities SET status = 'candidate', suppressed_by = ?, updated_at = ? WHERE id = ?`, `guardrail: ${check.issues.join('; ')}`, clock.iso(), oppId);
      continue;
    }
    run(db, `UPDATE opportunities SET status = 'pending_approval', draft = ?, suppressed_by = NULL, updated_at = ? WHERE id = ? AND status <> 'sent'`, text, clock.iso(), oppId);
    if (rules.autoSendTypes.includes(primary.type)) maybeAutoSend(ctx, own.tenant_id, oppId, primary.type, rules);
  }
}

/** Auto-send is opt-in per type and only after the warm-up count of staff-approved sends of that type. */
function maybeAutoSend(ctx: Ctx, tenantId: string, oppId: string, type: string, rules: Rules): void {
  const manual = get<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM approvals a JOIN opportunities o ON o.id = a.opportunity_id
    WHERE o.type = ? AND o.tenant_id = ? AND a.action = 'approve'`, type, tenantId);
  if (Number(manual?.n ?? 0) < rules.autoSendMinManual) return;
  decide(ctx, oppId, 'approve', { id: 'system:auto-send', role: 'system', tenantId }, {});
}

/** Persists a candidate as an opportunity; updates in place while still open under the same dedupe key. */
function upsertOpportunity(db: Db, own: OwnRow, roof: RoofRow, c: Candidate, secondaries: Candidate[]): string {
  const existing = get<{ id: string }>(db,
    `SELECT id FROM opportunities WHERE ownership_id = ? AND dedupe_key = ? AND status IN ('candidate','pending_approval')`, own.id, c.dedupeKey);
  const bundleIds = secondaries.map((s) => s.type);
  if (existing) {
    run(db, `UPDATE opportunities SET score = ?, reason = ?, facts = ?, bundle = ?, purpose = ?, updated_at = ? WHERE id = ?`,
      c.score, c.reason, JSON.stringify(c.facts), JSON.stringify(bundleIds), c.purpose, clock.iso(), existing.id);
    return existing.id;
  }
  const id = randomUUID();
  const evidence = JSON.stringify([`rule:${c.ruleId}`, `dedupe:${c.dedupeKey}`]);
  run(db, `INSERT INTO opportunities (id, tenant_id, rooftop_id, ownership_id, type, need, tier, score, dedupe_key, status, rule_id, evidence, bundle, purpose, reason, facts, due_at, expires_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'candidate',?,?,?,?,?,?,?,?,?,?)`,
    id, own.tenant_id, own.rooftop_id, own.id, c.type, c.need, c.tier, c.score, c.dedupeKey, c.ruleId, evidence,
    JSON.stringify(bundleIds), c.purpose, c.reason, JSON.stringify(c.facts),
    c.dueAt ? iso(c.dueAt) : null, c.expiresAt ? iso(c.expiresAt) : null, clock.iso(), clock.iso());
  return id;
}

/* ---------- human decisions (approve / edit / reject / snooze) ---------- */

export type Decision = 'approve' | 'edit' | 'reject' | 'snooze';
export const REJECT_CODES = ['not_due', 'customer_declined', 'not_relevant', 'wrong_customer', 'other'] as const;
export const APPROVER_ROLES = ['approver', 'service_advisor', 'rooftop_manager', 'group_admin'];

export function decide(ctx: Ctx, oppId: string, action: Decision, actor: { id: string; role: string; tenantId: string }, input: { text?: string; reasonCode?: string; months?: number }):
  { ok: true; status: string; sendAt?: string; localSendAt?: string } | { ok: false; code: number; error: string } {
  const db = ctx.db;
  if (actor.role !== 'system' && !APPROVER_ROLES.includes(actor.role)) return { ok: false, code: 403, error: 'role cannot act on approvals' };
  const opp = get<{ id: string; tenant_id: string; ownership_id: string; status: string; draft: string | null; draft_by: string | null; purpose: string; facts: string; type: string; tier: Tier; rooftop_id: string }>(db,
    'SELECT * FROM opportunities WHERE id = ? AND tenant_id = ?', oppId, actor.tenantId);
  if (!opp) return { ok: false, code: 404, error: 'opportunity not found' };
  const now = clock.iso();
  const approval = (a: string, code: string | null, detail: unknown = {}) =>
    run(db, `INSERT INTO approvals (id, tenant_id, opportunity_id, actor, action, reason_code, detail, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      randomUUID(), opp.tenant_id, oppId, actor.id, a, code, JSON.stringify(detail), now);

  if (action === 'snooze') {
    const months = Math.min(12, Math.max(1, input.months ?? 3));
    const until = new Date(clock.now().getTime() + months * 30 * 86_400_000);
    tx(db, () => {
      run(db, `UPDATE ownerships SET state = 'snoozed', snooze_until = ?, updated_at = ?, version = version + 1 WHERE id = ?`, iso(until), now, opp.ownership_id);
      run(db, `UPDATE opportunities SET status = 'candidate', updated_at = ? WHERE id = ?`, now, oppId);
      approval('snooze', 'customer_request', { until: iso(until) });
      audit(db, opp.tenant_id, actor.id, 'opportunity.snooze', oppId, { until: iso(until) });
    });
    return { ok: true, status: 'snoozed' };
  }

  if (opp.status !== 'pending_approval') return { ok: false, code: 409, error: `opportunity is ${opp.status}` };

  if (action === 'reject') {
    const code = input.reasonCode ?? '';
    if (!(REJECT_CODES as readonly string[]).includes(code)) return { ok: false, code: 422, error: 'reason_code required' };
    tx(db, () => {
      run(db, `UPDATE opportunities SET status = 'rejected', updated_at = ? WHERE id = ?`, now, oppId);
      approval('reject', code);
      audit(db, opp.tenant_id, actor.id, 'opportunity.reject', oppId, { code });
    });
    return { ok: true, status: 'rejected' };
  }

  if (action === 'edit') {
    const text = (input.text ?? '').trim();
    if (!text) return { ok: false, code: 422, error: 'text required' };
    const check = checkDraft(text, opp.facts);
    if (!check.ok) return { ok: false, code: 422, error: `guardrails: ${check.issues.join('; ')}` };
    if (opp.purpose.startsWith('marketing') && !/STOP/i.test(text)) return { ok: false, code: 422, error: 'marketing text must include opt-out (STOP)' };
    tx(db, () => {
      run(db, `UPDATE opportunities SET draft = ?, draft_by = ?, updated_at = ? WHERE id = ?`, text, actor.id, now, oppId);
      approval('edit', null, { length: text.length });
      audit(db, opp.tenant_id, actor.id, 'opportunity.edit', oppId, {});
    });
    return { ok: true, status: 'pending_approval' };
  }

  // approve
  if (opp.draft_by && opp.draft_by === actor.id) return { ok: false, code: 403, error: 'approver cannot approve their own edit (four-eyes)' };
  const own = get<{ customer_id: string; rooftop_id: string; state: string }>(db, 'SELECT customer_id, rooftop_id, state FROM ownerships WHERE id = ?', opp.ownership_id);
  if (!own) return { ok: false, code: 404, error: 'ownership missing' };
  const gate = recheck(ctx, opp.ownership_id, opp.type, opp.tier, opp.purpose);
  if (!gate.allowed) {
    run(db, `UPDATE opportunities SET status = 'candidate', suppressed_by = ?, updated_at = ? WHERE id = ?`, `${gate.check}: ${gate.reason}`, now, oppId);
    return { ok: false, code: 409, error: `blocked by policy: ${gate.reason}` };
  }
  // Quiet hours: approved outside the recipient's 08:00-21:00 window, the message is held until the window opens.
  const tz = get<{ tz: string }>(db, 'SELECT tz FROM customers WHERE id = ?', own.customer_id)?.tz ?? 'UTC';
  const plan = sendPlan(clock.now(), tz, ctx.cfg.quietHours, opp.purpose, opp.tier);
  tx(db, () => {
    enqueueOutbound(db, { tenantId: opp.tenant_id, rooftopId: own.rooftop_id, customerId: own.customer_id, ownershipId: opp.ownership_id, opportunityId: oppId, purpose: opp.purpose, body: opp.draft ?? '', sendAfter: plan.held ? plan.sendAt : null });
    run(db, `UPDATE opportunities SET status = 'sent', updated_at = ? WHERE id = ?`, now, oppId);
    approval('approve', null, plan.held ? { scheduledFor: iso(plan.sendAt) } : {});
    audit(db, opp.tenant_id, actor.id, 'opportunity.approve', oppId, { purpose: opp.purpose, ...(plan.held ? { scheduledFor: iso(plan.sendAt) } : {}) });
  });
  dispatchQueued(db, ctx.provider);
  return plan.held
    ? { ok: true, status: 'scheduled', sendAt: iso(plan.sendAt), localSendAt: plan.localSendAt }
    : { ok: true, status: 'sent' };
}

/** Approval-time re-run of the contact policy with the opportunity's real tier and the customer's decline memory. */
function recheck(ctx: Ctx, ownershipId: string, oppType: string, tier: Tier, purpose: string) {
  const own = get<OwnRow>(ctx.db, 'SELECT * FROM ownerships WHERE id = ?', ownershipId)!;
  const now = clock.now();
  const sends = nonSafetySends(ctx.db, own.tenant_id, own.customer_id, now);
  return evaluatePolicy({
    purpose: purpose as PolicyInput['purpose'], tier, oppType, now,
    consent: latestConsents(ctx.db, own.tenant_id, own.customer_id), ownershipState: own.state as PolicyInput['ownershipState'],
    snoozeUntil: own.snooze_until ? new Date(own.snooze_until) : null, nonSafetySends30d: sends.count, lastNonSafetySendAt: sends.last,
    unansweredCount: own.unanswered_count, declinedTypes: declinedTypes(ctx.db, own.tenant_id, own.customer_id, now),
  });
}

/** Sets ownership state after staff or customer confirmation (possibly-sold resolution). */
export function setOwnershipState(ctx: Ctx, ownershipId: string, action: 'confirm_sold' | 'still_owned', actorId: string): boolean {
  const own = get<{ tenant_id: string; vin: string; state: string }>(ctx.db, 'SELECT tenant_id, vin, state FROM ownerships WHERE id = ?', ownershipId);
  if (!own) return false;
  if (action === 'confirm_sold') {
    run(ctx.db, `UPDATE ownerships SET state = 'sold', ended_at = ?, end_reason = 'confirmed_sold', updated_at = ?, version = version + 1 WHERE id = ?`, clock.iso(), clock.iso(), ownershipId);
  } else {
    run(ctx.db, `UPDATE ownerships SET state = 'active', updated_at = ?, version = version + 1 WHERE id = ? AND state = 'possibly_sold'`, clock.iso(), ownershipId);
  }
  audit(ctx.db, own.tenant_id, actorId, `ownership.${action}`, ownershipId, {});
  evaluateOwnership(ctx, ownershipId);
  return true;
}

/** Re-evaluates every live ownership in the tenant (all tenants when omitted). Used by the scheduler, dev scan and seed. */
export function evaluateAll(ctx: Ctx, tenantId: string | undefined): number {
  const rows = tenantId
    ? all<{ id: string }>(ctx.db, `SELECT id FROM ownerships WHERE tenant_id = ? AND state IN ('active','snoozed','dormant','possibly_sold')`, tenantId)
    : all<{ id: string }>(ctx.db, `SELECT id FROM ownerships WHERE state IN ('active','snoozed','dormant','possibly_sold')`);
  for (const r of rows) evaluateOwnership(ctx, r.id);
  return rows.length;
}
