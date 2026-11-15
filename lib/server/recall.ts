/**
 * Recall service (HLD 03 §1). Mode `mock` (default, offline) or `live` (NHTSA public API).
 * Results are cached in SQLite (24h TTL) and every finding carries an "as of" timestamp.
 */
import { all, get, run, type Db } from './db.ts';
import { clock } from './clock.ts';
import { TtlCache } from './cache.ts';
import { shared } from './shared.ts';

export interface RecallItem { campaign: string; component: string; summary: string; remedy: string }
export interface RecallResult { vin: string; asOf: string; source: 'live' | 'mock' | 'cache'; items: RecallItem[] }

/** Offline fixtures keyed by "make|model|year". Synthetic campaign numbers only. */
export const MOCK_RECALLS: Record<string, RecallItem[]> = {
  'Toyota|Camry|2019': [{ campaign: 'SYN-24V-001', component: 'FUEL SYSTEM', summary: 'Synthetic fixture: fuel pump may fail, engine can stall.', remedy: 'Dealer will replace fuel pump at no charge.' }],
  'Honda|Accord|2018': [{ campaign: 'SYN-25V-014', component: 'AIR BAGS', summary: 'Synthetic fixture: inflator may rupture in a crash.', remedy: 'Dealer will replace the inflator at no charge.' }],
};

const TTL_MS = 24 * 3600_000;
const memo = shared('recallMemo', () => new TtlCache<RecallResult>(2000, 5 * 60_000));

export class RecallService {
  private readonly db: Db;
  private readonly mode: 'live' | 'mock';
  private readonly fetchImpl: typeof fetch;

  constructor(db: Db, mode: 'live' | 'mock', fetchImpl: typeof fetch = fetch) {
    this.db = db;
    this.mode = mode;
    this.fetchImpl = fetchImpl;
  }

  async lookup(tenantId: string, vin: string, make: string, model: string, year: number, force = false): Promise<RecallResult> {
    const key = `${vin}`;
    if (!force) {
      const hit = memo.get(key);
      if (hit) return { ...hit, source: 'cache' };
      const row = get<{ body: string; fetched_at: string; source: string }>(this.db, 'SELECT * FROM recall_cache WHERE vin = ?', vin);
      if (row && clock.now().getTime() - new Date(row.fetched_at).getTime() < TTL_MS) {
        const cached: RecallResult = { vin, asOf: row.fetched_at, source: 'cache', items: JSON.parse(row.body) };
        memo.set(key, cached);
        return cached;
      }
    }
    let items: RecallItem[];
    let source: 'live' | 'mock' = this.mode;
    try {
      items = this.mode === 'live' ? await this.fetchLive(make, model, year) : (MOCK_RECALLS[`${make}|${model}|${year}`] ?? []);
    } catch {
      // Live failure: serve last known good data with its as-of date; never invent results.
      const last = get<{ body: string; fetched_at: string }>(this.db, 'SELECT * FROM recall_cache WHERE vin = ?', vin);
      if (last) return { vin, asOf: last.fetched_at, source: 'cache', items: JSON.parse(last.body) };
      return { vin, asOf: clock.iso(), source: 'live', items: [] };
    }
    const asOf = clock.iso();
    run(this.db, `INSERT INTO recall_cache (vin, body, fetched_at, source) VALUES (?,?,?,?)
      ON CONFLICT(vin) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at, source = excluded.source`,
      vin, JSON.stringify(items), asOf, source);
    for (const it of items) {
      run(this.db, `INSERT OR IGNORE INTO recall_findings (id, tenant_id, vin, campaign, component, summary, remedy, as_of, source)
        VALUES (?,?,?,?,?,?,?,?,?)`, `${vin}:${it.campaign}`, tenantId, vin, it.campaign, it.component, it.summary, it.remedy, asOf, source);
    }
    const result: RecallResult = { vin, asOf, source, items };
    memo.set(key, result);
    return result;
  }

  openFindings(tenantId: string, vin: string): Array<RecallItem & { as_of: string }> {
    return all<RecallItem & { as_of: string }>(this.db,
      `SELECT campaign, component, summary, remedy, as_of FROM recall_findings WHERE tenant_id = ? AND vin = ? AND status = 'open'`, tenantId, vin);
  }

  private async fetchLive(make: string, model: string, year: number): Promise<RecallItem[]> {
    const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`nhtsa ${res.status}`);
      const json = (await res.json()) as { results?: Array<Record<string, string>> };
      return (json.results ?? []).map((r) => ({
        campaign: String(r.NHTSACampaignNumber ?? ''),
        component: String(r.Component ?? ''),
        summary: String(r.Summary ?? ''),
        remedy: String(r.Remedy ?? ''),
      }));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function clearRecallMemo(): void {
  memo.invalidate('');
}
