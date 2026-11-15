/**
 * Service churn & win-back predictor (spec Phase 3). Deterministic RFM-D scoring: no training, fully explainable,
 * every point of score has a named driver shown to staff.
 *
 * calculateChurnRisk is the spec's algorithm verbatim. The rest maps DB rows to its features and aggregates the fleet
 * for the dealer dashboard. "Revenue at risk" = sum(score x 12-month expected service value), where the value comes
 * from the vehicle's OEM schedule (knowledge.ts), so it moves with the real milestones rather than a flat ticket.
 */
import { all, type Db } from './db.ts';
import { daysBetween } from './clock.ts';
import { estimateMiles, scheduleFor } from './knowledge.ts';

export interface ChurnFeatures {
  daysSinceLastService: number;
  expectedIntervalDays: number;
  declinedServicesCount: number;
  lastCsat: number | null;
  ownershipAgeMonths: number;
  warrantyExpired: boolean;
}

export type ChurnTier = 'LOW' | 'MEDIUM' | 'HIGH';

export function calculateChurnRisk(f: ChurnFeatures): { score: number; tier: ChurnTier; drivers: string[] } {
  let score = 0;
  const drivers: string[] = [];

  // 1. Recency penalty (relative to expected interval)
  const intervalRatio = f.daysSinceLastService / Math.max(1, f.expectedIntervalDays);
  if (intervalRatio > 1.5) {
    score += 0.35;
    drivers.push(`Overdue for service by ${Math.round(intervalRatio * 100 - 100)}%`);
  } else if (intervalRatio > 1.1) {
    score += 0.15;
    drivers.push('Approaching service defection window');
  }

  // 2. Unresolved friction (declined work on last RO)
  if (f.declinedServicesCount > 0) {
    score += Math.min(0.30, f.declinedServicesCount * 0.15);
    drivers.push(`${f.declinedServicesCount} previously declined repair(s)`);
  }

  // 3. Customer Satisfaction / Sentiment
  if (f.lastCsat != null) {
    if (f.lastCsat <= 2) {
      score += 0.35;
      drivers.push('Severe customer dissatisfaction (CSAT ≤ 2)');
    } else if (f.lastCsat === 3) {
      score += 0.15;
      drivers.push('Neutral CSAT rating (CSAT = 3)');
    }
  }

  // 4. Warranty Expiration milestone (highest churn defection cliff)
  if (f.warrantyExpired) {
    score += 0.20;
    drivers.push('Factory warranty expired (high third-party defection risk)');
  }

  const finalScore = Math.min(1.0, Math.round(score * 100) / 100);
  const tier: ChurnTier = finalScore >= 0.70 ? 'HIGH' : finalScore >= 0.40 ? 'MEDIUM' : 'LOW';
  return { score: finalScore, tier, drivers };
}

/** Win-back incentive attached to D1_WINBACK (spec 3.2). Amount is a dealer setting; the label is customer-facing. */
export const WINBACK_VOUCHER = { amount: 40, label: '$40 Loyalty Service Voucher' } as const;

export interface ChurnInputRow {
  started_at: string; last_service_at: string | null; last_declined: string; last_ro_csat: number | null;
  warranty_end_date: string | null; warranty_end_miles: number | null; estimated_miles: number | null;
}

export function churnFeatures(r: ChurnInputRow, expectedIntervalDays: number, now: Date): ChurnFeatures {
  const lastSvc = new Date(r.last_service_at ?? r.started_at);
  let declined = 0;
  try { declined = (JSON.parse(r.last_declined || '[]') as unknown[]).length; } catch { declined = 0; }
  const expiredByDate = r.warranty_end_date != null && new Date(r.warranty_end_date) < now;
  const expiredByMiles = r.warranty_end_miles != null && r.estimated_miles != null && r.estimated_miles > r.warranty_end_miles;
  return {
    daysSinceLastService: Math.max(0, Math.floor(daysBetween(lastSvc, now))),
    expectedIntervalDays,
    declinedServicesCount: declined,
    lastCsat: r.last_ro_csat,
    ownershipAgeMonths: Math.max(0, Math.floor(daysBetween(new Date(r.started_at), now) / 30.44)),
    warrantyExpired: expiredByDate || expiredByMiles,
  };
}

/** Expected 12-month service revenue for a vehicle: OEM milestones that fall within the next 12 months of driving. */
export function annualServiceValue(make: string, model: string, estimatedMiles: number | null, annualMiles: number): number {
  const { milestones } = scheduleFor(make, model);
  const from = estimatedMiles ?? 0;
  const to = from + Math.max(1000, annualMiles);
  const inWindow = milestones.filter((m) => m.mileage > from && m.mileage <= to);
  if (inWindow.length) return inWindow.reduce((s, m) => s + m.estCost, 0);
  // Past the last tabulated milestone: the schedule repeats; use the mean milestone cost per interval.
  const mean = milestones.reduce((s, m) => s + m.estCost, 0) / Math.max(1, milestones.length);
  return Math.round(mean);
}

export interface FleetRow {
  ownershipId: string; customerId: string; rooftopId: string; customer: string; vehicle: string; vin: string;
  score: number; tier: ChurnTier; drivers: string[]; annualValue: number; valueAtRisk: number; winback: string | null;
}

export interface FleetChurn {
  counts: Record<ChurnTier, number>;
  revenueAtRisk: number;
  winbackPipeline: { pending: number; sent: number; value: number };
  top: FleetRow[];
  all: FleetRow[];
}

/** Scores every open ownership in the given rooftops. Pure reads; safe to call per dashboard refresh. */
export function fleetChurn(db: Db, tenantId: string, rooftopIds: string[] | null, expectedIntervalDays: number, now: Date): FleetChurn {
  const rows = all<ChurnInputRow & {
    id: string; customer_id: string; rooftop_id: string; full_name: string; vin: string; make: string; model: string; year: number;
    odometer: number | null; odometer_at: string | null; annual_miles: number;
  }>(db, `SELECT o.id, o.customer_id, o.rooftop_id, o.started_at, o.last_service_at, o.last_declined, o.last_ro_csat,
      v.vin, v.make, v.model, v.year, v.odometer, v.odometer_at, v.annual_miles, v.warranty_end_date, v.warranty_end_miles, c.full_name,
      NULL AS estimated_miles
    FROM ownerships o JOIN vehicles v ON v.vin = o.vin JOIN customers c ON c.id = o.customer_id
    WHERE o.tenant_id = ? AND o.state IN ('active','snoozed','dormant')`, tenantId);
  const winbacks = new Map(all<{ ownership_id: string; status: string }>(db,
    `SELECT ownership_id, status FROM opportunities WHERE tenant_id = ? AND type = 'D1_WINBACK' AND status IN ('candidate','pending_approval','sent')`, tenantId)
    .map((r) => [r.ownership_id, r.status]));
  const out: FleetRow[] = [];
  for (const r of rows) {
    if (rooftopIds && !rooftopIds.includes(r.rooftop_id)) continue;
    const est = estimateMiles(r.odometer, r.odometer_at, r.annual_miles, now).miles;
    const risk = calculateChurnRisk(churnFeatures({ ...r, estimated_miles: est }, expectedIntervalDays, now));
    const annualValue = annualServiceValue(r.make, r.model, est, r.annual_miles);
    out.push({
      ownershipId: r.id, customerId: r.customer_id, rooftopId: r.rooftop_id, customer: r.full_name, vehicle: `${r.year} ${r.make} ${r.model}`, vin: r.vin,
      score: risk.score, tier: risk.tier, drivers: risk.drivers, annualValue, valueAtRisk: Math.round(risk.score * annualValue), winback: winbacks.get(r.id) ?? null,
    });
  }
  out.sort((a, b) => b.score - a.score || b.valueAtRisk - a.valueAtRisk);
  const counts: Record<ChurnTier, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  for (const r of out) counts[r.tier]++;
  const wb = out.filter((r) => r.winback);
  return {
    counts,
    revenueAtRisk: out.reduce((s, r) => s + r.valueAtRisk, 0),
    winbackPipeline: {
      pending: wb.filter((r) => r.winback !== 'sent').length,
      sent: wb.filter((r) => r.winback === 'sent').length,
      value: wb.reduce((s, r) => s + r.annualValue, 0),
    },
    top: out.slice(0, 10),
    all: out,
  };
}
