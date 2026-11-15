/**
 * Structured OEM maintenance knowledge base (spec Phase 1.1).
 *
 * DATA NOTE: these tables are representative, assembled for the prototype from the general shape of each OEM's
 * published schedule (normal driving conditions). Intervals, services and especially estCost (dealer menu price in
 * USD, parts + labour) MUST be verified against the owner's manual / OEM service portal and the dealer's own menu
 * pricing before production use. Every customer-facing surface labels them "OEM schedule; verify with your advisor".
 */

export interface OemMilestone {
  make: string;
  model: string;
  mileage: number;
  intervalMonths: number;
  title: string;
  requiredServices: string[];
  parts: string[];
  estCost: number;
  criticality: 'routine' | 'recommended' | 'critical';
}

type Row = Omit<OemMilestone, 'make' | 'model'>;
const expand = (make: string, models: string[], rows: Row[]): OemMilestone[] => models.flatMap((model) => rows.map((r) => ({ make, model, ...r })));

/* Toyota (ToyotaCare-style 5k/6-month cadence; synthetic 0W-20 at 10k). Camry rows match the spec exactly. */
const TOYOTA_CAMRY: Row[] = [
  { mileage: 5000, intervalMonths: 6, title: '5,000-Mile Inspection', requiredServices: ['Tire Rotation', 'Multi-Point Inspection', 'Fluid Level Check'], parts: [], estCost: 49, criticality: 'routine' },
  { mileage: 10000, intervalMonths: 12, title: '10,000-Mile Factory Inspection', requiredServices: ['Synthetic Oil & Filter Change', 'Tire Rotation', 'Multi-Point Inspection'], parts: ['0W-20 Full Synthetic Oil', 'Oil Filter Cartridge'], estCost: 119, criticality: 'routine' },
  { mileage: 20000, intervalMonths: 24, title: '20,000-Mile Factory Service', requiredServices: ['Synthetic Oil & Filter Change', 'Tire Rotation', 'Brake Inspection', 'Cabin Air Filter Inspection'], parts: ['0W-20 Full Synthetic Oil', 'Oil Filter Cartridge'], estCost: 149, criticality: 'recommended' },
  { mileage: 30000, intervalMonths: 36, title: '30,000-Mile Major Factory Milestone', requiredServices: ['Brake Fluid Exchange', 'Engine Air Filter', 'Cabin Air Filter', 'Tire Rotation'], parts: ['DOT 3 Brake Fluid', 'OEM Engine Air Filter', 'Carbon Cabin Filter'], estCost: 410, criticality: 'critical' },
  { mileage: 60000, intervalMonths: 72, title: '60,000-Mile Major Factory Milestone', requiredServices: ['Synthetic Oil & Filter Change', 'Engine Air Filter', 'Cabin Air Filter', 'Brake Fluid Exchange', 'Drive Belt Inspection', 'Spark Plug Inspection'], parts: ['0W-20 Full Synthetic Oil', 'Oil Filter Cartridge', 'OEM Engine Air Filter', 'Carbon Cabin Filter', 'DOT 3 Brake Fluid'], estCost: 689, criticality: 'critical' },
];
const TOYOTA_SUV: Row[] = [
  { mileage: 5000, intervalMonths: 6, title: '5,000-Mile Inspection', requiredServices: ['Tire Rotation', 'Multi-Point Inspection', 'Fluid Level Check'], parts: [], estCost: 49, criticality: 'routine' },
  { mileage: 10000, intervalMonths: 12, title: '10,000-Mile Factory Inspection', requiredServices: ['Synthetic Oil & Filter Change', 'Tire Rotation', 'Multi-Point Inspection'], parts: ['0W-16 Full Synthetic Oil', 'Oil Filter Cartridge'], estCost: 129, criticality: 'routine' },
  { mileage: 20000, intervalMonths: 24, title: '20,000-Mile Factory Service', requiredServices: ['Synthetic Oil & Filter Change', 'Tire Rotation', 'Brake Inspection', 'Cabin Air Filter Inspection'], parts: ['0W-16 Full Synthetic Oil', 'Oil Filter Cartridge'], estCost: 159, criticality: 'recommended' },
  { mileage: 30000, intervalMonths: 36, title: '30,000-Mile Major Factory Milestone', requiredServices: ['Brake Fluid Exchange', 'Engine Air Filter', 'Cabin Air Filter', 'Tire Rotation', 'Transfer Case Fluid Inspection'], parts: ['DOT 3 Brake Fluid', 'OEM Engine Air Filter', 'Carbon Cabin Filter'], estCost: 445, criticality: 'critical' },
  { mileage: 60000, intervalMonths: 72, title: '60,000-Mile Major Factory Milestone', requiredServices: ['Synthetic Oil & Filter Change', 'Engine Air Filter', 'Cabin Air Filter', 'Brake Fluid Exchange', 'Rear Differential Fluid Replacement', 'Drive Belt Inspection'], parts: ['0W-16 Full Synthetic Oil', 'OEM Engine Air Filter', 'Carbon Cabin Filter', 'DOT 3 Brake Fluid', 'Toyota Differential Gear Oil'], estCost: 749, criticality: 'critical' },
];

/* Honda (Maintenance Minder codes mapped to typical mileages). CR-V 30k matches the spec exactly. */
const HONDA_CAR: Row[] = [
  { mileage: 7500, intervalMonths: 12, title: 'Maintenance Minder A1 Service', requiredServices: ['Engine Oil Change', 'Tire Rotation', 'Multi-Point Inspection'], parts: ['0W-20 Oil', 'Filter'], estCost: 99, criticality: 'routine' },
  { mileage: 15000, intervalMonths: 24, title: 'Maintenance Minder B12 Service', requiredServices: ['Engine Oil & Filter Change', 'Tire Rotation', 'Brake Inspection', 'Engine Air Filter', 'Cabin Air Filter'], parts: ['0W-20 Oil', 'Filter', 'Engine Air Filter', 'Cabin Air Filter'], estCost: 289, criticality: 'recommended' },
  { mileage: 30000, intervalMonths: 36, title: 'Maintenance Minder 30k Service', requiredServices: ['Engine Oil Change', 'Brake Fluid Flush', 'Tire Rotation', 'CVT Fluid Inspection'], parts: ['0W-20 Oil', 'Filter', 'Honda DOT 3 Brake Fluid'], estCost: 349, criticality: 'critical' },
  { mileage: 60000, intervalMonths: 72, title: 'Maintenance Minder 60k Service', requiredServices: ['Engine Oil & Filter Change', 'CVT Fluid Replacement', 'Spark Plugs', 'Brake Fluid Flush', 'Valve Clearance Inspection'], parts: ['0W-20 Oil', 'Filter', 'Honda HCF-2 CVT Fluid', 'Iridium Spark Plugs'], estCost: 719, criticality: 'critical' },
];
const HONDA_CRV: Row[] = [
  { mileage: 7500, intervalMonths: 12, title: 'Maintenance Minder A1 Service', requiredServices: ['Engine Oil Change', 'Tire Rotation', 'Multi-Point Inspection'], parts: ['0W-20 Oil', 'Filter'], estCost: 99, criticality: 'routine' },
  { mileage: 15000, intervalMonths: 24, title: 'Maintenance Minder B12 Service', requiredServices: ['Engine Oil & Filter Change', 'Tire Rotation', 'Brake Inspection', 'Engine Air Filter', 'Cabin Air Filter'], parts: ['0W-20 Oil', 'Filter', 'Engine Air Filter', 'Cabin Air Filter'], estCost: 299, criticality: 'recommended' },
  { mileage: 30000, intervalMonths: 36, title: 'Maintenance Minder 30k Service', requiredServices: ['Rear Differential Fluid Flush', 'Engine Oil Change', 'Brake Fluid Flush'], parts: ['Dual Pump Fluid II', '0W-20 Oil', 'Filter'], estCost: 385, criticality: 'critical' },
  { mileage: 60000, intervalMonths: 72, title: 'Maintenance Minder 60k Service', requiredServices: ['Engine Oil & Filter Change', 'CVT Fluid Replacement', 'Rear Differential Fluid Flush', 'Spark Plugs', 'Brake Fluid Flush'], parts: ['0W-20 Oil', 'Filter', 'Honda HCF-2 CVT Fluid', 'Dual Pump Fluid II', 'Iridium Spark Plugs'], estCost: 799, criticality: 'critical' },
];

/* Ford (Intelligent Oil-Life Monitor, ~10k max oil interval). */
const FORD_TRUCK: Row[] = [
  { mileage: 10000, intervalMonths: 12, title: '10,000-Mile Oil-Life Service', requiredServices: ['Synthetic Blend Oil & Filter Change', 'Tire Rotation', 'Multi-Point Inspection'], parts: ['Motorcraft 5W-30 Oil', 'Motorcraft Oil Filter'], estCost: 129, criticality: 'routine' },
  { mileage: 20000, intervalMonths: 24, title: '20,000-Mile Scheduled Service', requiredServices: ['Oil & Filter Change', 'Tire Rotation', 'Cabin Air Filter', 'Brake Inspection'], parts: ['Motorcraft 5W-30 Oil', 'Motorcraft Oil Filter', 'Motorcraft Cabin Filter'], estCost: 219, criticality: 'recommended' },
  { mileage: 30000, intervalMonths: 36, title: '30,000-Mile Major Service', requiredServices: ['Oil & Filter Change', 'Engine Air Filter', 'Cabin Air Filter', 'Tire Rotation', 'Brake Fluid Inspection'], parts: ['Motorcraft 5W-30 Oil', 'Motorcraft Oil Filter', 'Motorcraft Air Filter', 'Motorcraft Cabin Filter'], estCost: 395, criticality: 'critical' },
  { mileage: 60000, intervalMonths: 72, title: '60,000-Mile Major Service', requiredServices: ['Oil & Filter Change', 'Engine Air Filter', 'Spark Plugs', 'Rear Axle Fluid Inspection', 'Brake Fluid Exchange'], parts: ['Motorcraft 5W-30 Oil', 'Motorcraft Air Filter', 'Motorcraft Spark Plugs', 'Motorcraft DOT 4 Brake Fluid'], estCost: 759, criticality: 'critical' },
];
const FORD_SUV: Row[] = [
  { mileage: 10000, intervalMonths: 12, title: '10,000-Mile Oil-Life Service', requiredServices: ['Synthetic Blend Oil & Filter Change', 'Tire Rotation', 'Multi-Point Inspection'], parts: ['Motorcraft 5W-20 Oil', 'Motorcraft Oil Filter'], estCost: 109, criticality: 'routine' },
  { mileage: 20000, intervalMonths: 24, title: '20,000-Mile Scheduled Service', requiredServices: ['Oil & Filter Change', 'Tire Rotation', 'Cabin Air Filter', 'Brake Inspection'], parts: ['Motorcraft 5W-20 Oil', 'Motorcraft Oil Filter', 'Motorcraft Cabin Filter'], estCost: 199, criticality: 'recommended' },
  { mileage: 30000, intervalMonths: 36, title: '30,000-Mile Major Service', requiredServices: ['Oil & Filter Change', 'Engine Air Filter', 'Cabin Air Filter', 'Tire Rotation', 'Brake Fluid Inspection'], parts: ['Motorcraft 5W-20 Oil', 'Motorcraft Oil Filter', 'Motorcraft Air Filter', 'Motorcraft Cabin Filter'], estCost: 365, criticality: 'critical' },
  { mileage: 60000, intervalMonths: 72, title: '60,000-Mile Major Service', requiredServices: ['Oil & Filter Change', 'Engine Air Filter', 'Spark Plugs', 'Coolant Inspection', 'Brake Fluid Exchange'], parts: ['Motorcraft 5W-20 Oil', 'Motorcraft Air Filter', 'Motorcraft Spark Plugs', 'Motorcraft DOT 4 Brake Fluid'], estCost: 689, criticality: 'critical' },
];

/* Tesla (no oil; time- and mileage-based items from the published maintenance list). */
const TESLA: Row[] = [
  { mileage: 6250, intervalMonths: 6, title: '6,250-Mile Tire Rotation', requiredServices: ['Tire Rotation', 'Tire Tread Depth Check', 'Multi-Point Inspection'], parts: [], estCost: 79, criticality: 'routine' },
  { mileage: 12500, intervalMonths: 12, title: '12,500-Mile Service', requiredServices: ['Tire Rotation', 'Brake Caliper Cleaning & Lubrication (winter regions)', 'Wiper Blade Inspection'], parts: [], estCost: 149, criticality: 'routine' },
  { mileage: 25000, intervalMonths: 24, title: '2-Year Cabin Air Service', requiredServices: ['Cabin Air Filter Replacement', 'Tire Rotation', 'Brake Inspection'], parts: ['Tesla Cabin Air Filter'], estCost: 189, criticality: 'recommended' },
  { mileage: 50000, intervalMonths: 48, title: '4-Year Brake Fluid Health Check', requiredServices: ['Brake Fluid Contamination Test', 'Brake Fluid Replacement if Required', 'Cabin Air Filter Replacement', 'Tire Rotation'], parts: ['DOT 3 Brake Fluid', 'Tesla Cabin Air Filter'], estCost: 329, criticality: 'critical' },
];

/* Generic fallback for makes/models not in the table: conservative 5k/10k/30k/60k cadence. */
const GENERIC: Row[] = [
  { mileage: 5000, intervalMonths: 6, title: '5,000-Mile Inspection', requiredServices: ['Oil & Filter Change', 'Tire Rotation', 'Multi-Point Inspection'], parts: ['Manufacturer-Specified Oil', 'Oil Filter'], estCost: 89, criticality: 'routine' },
  { mileage: 15000, intervalMonths: 18, title: '15,000-Mile Service', requiredServices: ['Oil & Filter Change', 'Tire Rotation', 'Cabin Air Filter', 'Brake Inspection'], parts: ['Manufacturer-Specified Oil', 'Oil Filter', 'Cabin Air Filter'], estCost: 219, criticality: 'recommended' },
  { mileage: 30000, intervalMonths: 36, title: '30,000-Mile Major Service', requiredServices: ['Oil & Filter Change', 'Engine Air Filter', 'Cabin Air Filter', 'Brake Fluid Exchange', 'Tire Rotation'], parts: ['Manufacturer-Specified Oil', 'Oil Filter', 'Engine Air Filter', 'Cabin Air Filter', 'Brake Fluid'], estCost: 399, criticality: 'critical' },
  { mileage: 60000, intervalMonths: 72, title: '60,000-Mile Major Service', requiredServices: ['Oil & Filter Change', 'Spark Plugs', 'Coolant Service', 'Brake Fluid Exchange', 'Drive Belt Inspection'], parts: ['Manufacturer-Specified Oil', 'Spark Plugs', 'Coolant', 'Brake Fluid'], estCost: 699, criticality: 'critical' },
];

export const OEM_SCHEDULES: OemMilestone[] = [
  ...expand('Toyota', ['Camry', 'Corolla'], TOYOTA_CAMRY),
  ...expand('Toyota', ['RAV4', 'Highlander'], TOYOTA_SUV),
  ...expand('Honda', ['Accord', 'Civic'], HONDA_CAR),
  ...expand('Honda', ['CR-V', 'Pilot'], HONDA_CRV),
  ...expand('Ford', ['F-150'], FORD_TRUCK),
  ...expand('Ford', ['Escape', 'Explorer'], FORD_SUV),
  ...expand('Tesla', ['Model 3', 'Model Y'], TESLA),
];

export const SCHEDULE_SOURCE_NOTE = 'OEM schedule (representative); verify intervals and pricing with your service advisor.';

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');

/** Milestones for a make/model, ascending by mileage. Unknown models fall back to the generic schedule. */
export function scheduleFor(make: string, model: string): { milestones: OemMilestone[]; source: 'oem' | 'generic' } {
  const exact = OEM_SCHEDULES.filter((m) => norm(m.make) === norm(make) && norm(m.model) === norm(model));
  if (exact.length) return { milestones: [...exact].sort((a, b) => a.mileage - b.mileage), source: 'oem' };
  return { milestones: GENERIC.map((r) => ({ make, model, ...r })), source: 'generic' };
}

export type MilestoneStatus = 'completed' | 'due' | 'overdue' | 'upcoming';

export interface RoadmapItem {
  milestone: OemMilestone;
  status: MilestoneStatus;
  /** Positive = miles remaining; negative = miles past the milestone. Null when mileage is unknown. */
  dueInMiles: number | null;
  /** Calendar due date (delivery + intervalMonths). */
  dueBy: string;
}

export interface RoadmapInput {
  make: string; model: string;
  deliveredAt: string;
  estimatedMiles: number | null;
  /** Odometer at the most recent RO. A milestone counts as done when the last service was at or past it (minus tolerance). */
  lastServiceOdometer: number | null;
  lastServiceAt: string | null;
  now: Date;
}

/** Miles before a milestone at which it becomes "due" (and after which it is "overdue"). */
export const DUE_WINDOW_MILES = 1000;
const COMPLETION_TOLERANCE_MILES = 1500;

const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const monthsBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / (30.44 * 86_400_000);

/**
 * Lifecycle roadmap. A milestone is due when the estimated odometer is within DUE_WINDOW_MILES of it OR its calendar
 * interval since delivery has arrived (whichever first, as OEM schedules specify). Completion is inferred from the
 * last RO's odometer/date because the DMS contract does not yet carry per-op-code history (see docs/SHORTCUTS.md).
 */
export function vehicleRoadmap(v: RoadmapInput): { items: RoadmapItem[]; next: RoadmapItem | null; source: 'oem' | 'generic' } {
  const { milestones, source } = scheduleFor(v.make, v.model);
  const delivered = new Date(v.deliveredAt);
  const ageMonths = monthsBetween(delivered, v.now);
  const lastSvcDate = v.lastServiceAt ? new Date(v.lastServiceAt) : null;
  const items: RoadmapItem[] = milestones.map((m) => {
    const dueBy = addMonths(delivered, m.intervalMonths);
    const dueInMiles = v.estimatedMiles == null ? null : m.mileage - v.estimatedMiles;
    const doneByMiles = v.lastServiceOdometer != null && v.lastServiceOdometer >= m.mileage - COMPLETION_TOLERANCE_MILES;
    const doneByDate = lastSvcDate != null && monthsBetween(delivered, lastSvcDate) >= m.intervalMonths - 1 && (v.lastServiceOdometer == null || v.lastServiceOdometer >= m.mileage * 0.6);
    let status: MilestoneStatus;
    if (doneByMiles || doneByDate) status = 'completed';
    else if ((dueInMiles != null && dueInMiles < -DUE_WINDOW_MILES) || ageMonths > m.intervalMonths + 1) status = 'overdue';
    else if ((dueInMiles != null && dueInMiles <= DUE_WINDOW_MILES) || ageMonths >= m.intervalMonths - 0.5) status = 'due';
    else status = 'upcoming';
    return { milestone: m, status, dueInMiles, dueBy: dueBy.toISOString().slice(0, 10) };
  });
  // A later completed milestone implies earlier ones were serviced (or superseded).
  for (let i = items.length - 1, seenDone = false; i >= 0; i--) {
    if (items[i].status === 'completed') seenDone = true;
    else if (seenDone) items[i].status = 'completed';
  }
  // Only the most advanced outstanding milestone is actionable; older missed ones roll into it.
  const outstanding = items.filter((i) => i.status === 'due' || i.status === 'overdue');
  const next = outstanding.length ? outstanding[outstanding.length - 1] : items.find((i) => i.status === 'upcoming') ?? null;
  for (const i of outstanding) if (i !== next) i.status = 'completed';
  return { items, next, source };
}

/**
 * Trade-in equity peak forecast: the month (since delivery) before the basic factory warranty lapses at
 * 36 months / 36,000 miles, whichever comes first at the vehicle's mileage rate. Heuristic, labelled as such in the UI.
 */
export function equityPeak(deliveredAt: string, annualMiles: number, warrantyEndDate: string | null, now: Date = new Date()):
  { month: number; date: string; basis: string; passed: boolean } {
  const byMiles = annualMiles > 0 ? Math.floor((36000 / annualMiles) * 12) : 36;
  const delivered = new Date(deliveredAt);
  const byWarranty = warrantyEndDate ? Math.floor(monthsBetween(delivered, new Date(warrantyEndDate))) : 36;
  const month = Math.max(1, Math.min(36, byMiles, byWarranty) - 1);
  const peak = addMonths(delivered, month);
  // Once the peak is behind us the best trade-in window is now: value only declines from here.
  if (peak < now) {
    return { month: Math.max(0, Math.floor(monthsBetween(delivered, now))), date: now.toISOString().slice(0, 10), passed: true,
      basis: 'the basic warranty has lapsed (36 months / 36,000 miles), so trade-in value declines from here' };
  }
  return { month, date: peak.toISOString().slice(0, 10), passed: false, basis: 'month before 36-month / 36,000-mile basic warranty lapse at your driving rate' };
}

export const fmtMiles = (n: number): string => n.toLocaleString('en-US');

/**
 * Odometer estimate = last reading + annual mileage x elapsed time. A formula, not a model (HLD 01 §3). Confidence drops
 * once the reading is older than 90 days. The single implementation used by the engine, churn and the garage.
 */
export function estimateMiles(odometer: number | null, odometerAt: string | null, annualMiles: number, now: Date): { miles: number | null; confidence: number } {
  if (odometer == null || !odometerAt) return { miles: null, confidence: 0 };
  const days = Math.max(0, (now.getTime() - new Date(odometerAt).getTime()) / 86_400_000);
  return { miles: Math.round(odometer + (annualMiles * days) / 365), confidence: days <= 90 ? 0.9 : 0.6 };
}
