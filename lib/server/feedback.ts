/**
 * Closed-loop technician learning (spec Phase 2).
 *
 *  ro.closed + technician_story  ->  technician_stories row (same transaction as the event, so it is never lost)
 *                                ->  embedding worker (async; vendor embedding API)  ->  vector store
 *  new complaint / photo / noise ->  query embedding -> top-K technician precedents -> model hypothesis for the advisor
 *
 * Why the embedding is not created inside handleEvent: the event pump is synchronous and transactional; a network
 * call inside it would hold the write lock for seconds and turn vendor outages into dead-lettered DMS events. The story
 * is persisted atomically with the RO and embedded moments later; retries are bounded (MAX_EMBED_ATTEMPTS).
 *
 * Closed-loop accuracy: every story that carries an AI prediction (from the payload, or matched to this system's own
 * earlier diagnostic for the VIN) is ground truth. override_occurred=false means the technician confirmed the AI.
 */
import { randomUUID } from 'node:crypto';
import { all, get, run, type Db } from './db.ts';
import { clock, DAY_MS } from './clock.ts';
import { audit } from './audit.ts';
import { diagnose, embedTexts, makeGateway, redactPII, type GatewayDeps, type Precedent } from './ai.ts';
import { vectorStore, type VectorEntry } from './vector.ts';
import type { ModelProvider } from './providers.ts';
import type { Ctx } from './engine.ts';

export const STORY_COLLECTION = 'technician_stories';
export const MAX_EMBED_ATTEMPTS = 5;
const PREDICTION_MATCH_WINDOW_DAYS = 90;

export interface TechnicianStory {
  customer_complaint: string;
  ai_predicted_service?: string;
  technician_diagnosis: string;
  technician_action: string;
  override_occurred: boolean;
  labor_code: string;
}

const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= max;

/** Schema check for the DMS payload. Returns the story or the first problem found. */
export function validateTechnicianStory(x: unknown): TechnicianStory | string {
  if (!x || typeof x !== 'object') return 'technician_story must be an object';
  const s = x as Record<string, unknown>;
  if (!str(s.customer_complaint, 2000)) return 'customer_complaint required (max 2000 chars)';
  if (!str(s.technician_diagnosis, 2000)) return 'technician_diagnosis required (max 2000 chars)';
  if (!str(s.technician_action, 2000)) return 'technician_action required (max 2000 chars)';
  if (typeof s.override_occurred !== 'boolean') return 'override_occurred must be boolean';
  if (!str(s.labor_code, 40)) return 'labor_code required (max 40 chars)';
  if (s.ai_predicted_service !== undefined && s.ai_predicted_service !== null && !str(s.ai_predicted_service, 500)) return 'ai_predicted_service must be a string (max 500 chars)';
  return {
    customer_complaint: s.customer_complaint as string, technician_diagnosis: s.technician_diagnosis as string,
    technician_action: s.technician_action as string, override_occurred: s.override_occurred as boolean, labor_code: s.labor_code as string,
    ai_predicted_service: (s.ai_predicted_service as string | undefined) ?? undefined,
  };
}

/**
 * Called from handleEvent('ro.closed') inside the event transaction. Idempotent on (tenant, ro_id).
 * Free text is PII-redacted before storage: technician notes sometimes quote phone numbers or VINs.
 */
export function recordTechnicianStory(db: Db, p: { tenantId: string; rooftopId: string; roId: string; vin: string; make: string; model: string; closedAt: string }, story: TechnicianStory): string | null {
  let aiPredicted = story.ai_predicted_service ? redactPII(story.ai_predicted_service) : null;
  let source: 'payload' | 'diagnostic' | null = aiPredicted ? 'payload' : null;
  // No prediction in the payload: attribute this system's own most recent open diagnostic for the VIN, if any.
  const since = new Date(new Date(p.closedAt).getTime() - PREDICTION_MATCH_WINDOW_DAYS * DAY_MS).toISOString();
  const diag = get<{ id: string; hypothesis: string }>(db,
    `SELECT id, hypothesis FROM diagnostics WHERE tenant_id = ? AND vin = ? AND resolved_story_id IS NULL AND method <> 'none' AND created_at >= ? AND created_at <= ?
     ORDER BY created_at DESC LIMIT 1`, p.tenantId, p.vin, since, p.closedAt);
  if (!aiPredicted && diag) {
    aiPredicted = diag.hypothesis;
    source = 'diagnostic';
  }
  const id = randomUUID();
  const inserted = run(db, `INSERT OR IGNORE INTO technician_stories (id, tenant_id, rooftop_id, ro_id, vin, make, model, customer_complaint, ai_predicted,
      ai_predicted_source, technician_diagnosis, technician_action, override_occurred, labor_code, closed_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, p.tenantId, p.rooftopId, p.roId, p.vin, p.make, p.model, redactPII(story.customer_complaint), aiPredicted, source,
    redactPII(story.technician_diagnosis), redactPII(story.technician_action), story.override_occurred ? 1 : 0, story.labor_code, p.closedAt, clock.iso());
  if (inserted === 0) return null;
  if (diag) run(db, 'UPDATE diagnostics SET resolved_story_id = ? WHERE id = ?', id, diag.id);
  audit(db, p.tenantId, 'system:closed_loop', 'technician_story.recorded', id, { ro: p.roId, override: story.override_occurred, prediction: source });
  return id;
}

type StoryRow = {
  id: string; tenant_id: string; vin: string; make: string; model: string; customer_complaint: string; ai_predicted: string | null;
  technician_diagnosis: string; technician_action: string; override_occurred: number; labor_code: string; closed_at: string; embed_attempts: number;
};

export const storyText = (s: Pick<StoryRow, 'make' | 'model' | 'customer_complaint' | 'technician_diagnosis' | 'technician_action'>): string =>
  `Vehicle: ${s.make} ${s.model}. Customer complaint: ${s.customer_complaint}. Technician diagnosis: ${s.technician_diagnosis}. Repair: ${s.technician_action}.`;

const storyMeta = (s: StoryRow): VectorEntry['metadata'] => ({
  vinPrefix: s.vin.slice(0, 8), model: s.model, customerComplaint: s.customer_complaint, aiPredicted: s.ai_predicted ?? '',
  technicianDiagnosis: s.technician_diagnosis, technicianAction: s.technician_action, wasOverride: s.override_occurred === 1,
  laborCode: s.labor_code, date: s.closed_at.slice(0, 10),
});

export const embedModelKey = (m: ModelProvider): string => `${m.name}/${m.embedModel}`;

/**
 * Embedding worker: embeds pending stories (and re-embeds stories embedded under a different model after a provider
 * switch) and upserts them into the persistent vector store. Safe to run concurrently with the pump.
 */
export async function embedPendingStories(db: Db, model: ModelProvider | null | undefined, limit = 32): Promise<{ embedded: number; failed: number }> {
  if (!model) return { embedded: 0, failed: 0 };
  const key = embedModelKey(model);
  const rows = all<StoryRow>(db, `SELECT * FROM technician_stories
    WHERE (embed_status = 'pending' AND embed_attempts < ?) OR (embed_status = 'embedded' AND embed_model <> ?)
    ORDER BY created_at ASC LIMIT ?`, MAX_EMBED_ATTEMPTS, key, limit);
  let embedded = 0, failed = 0;
  const byTenant = new Map<string, StoryRow[]>();
  for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);
  for (const [tenantId, stories] of byTenant) {
    const deps = makeGateway(db, model, tenantId);
    const vectors = await embedTexts(deps, stories.map(storyText), 'document');
    if (!vectors) {
      for (const s of stories) {
        const attempts = s.embed_attempts + 1;
        run(db, `UPDATE technician_stories SET embed_attempts = ?, embed_status = ?, embed_error = ? WHERE id = ?`,
          attempts, attempts >= MAX_EMBED_ATTEMPTS ? 'failed' : 'pending', 'embedding call failed', s.id);
        failed++;
      }
      continue;
    }
    const store = vectorStore(db, tenantId, STORY_COLLECTION, key);
    stories.forEach((s, i) => {
      store.upsert({ id: s.id, text: storyText(s), embedding: vectors[i], metadata: storyMeta(s) });
      run(db, `UPDATE technician_stories SET embed_status = 'embedded', embed_model = ?, embed_error = NULL WHERE id = ?`, key, s.id);
      embedded++;
    });
  }
  return { embedded, failed };
}

/* ---------- retrieval ---------- */

const STOP = new Set('a an the and or of to in on at for with is it my car vehicle when i it\'s its this that there from be was are have has had not no but very some'.split(' '));
const tokens = (t: string): Set<string> => new Set(t.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')));

/** Degraded-mode similarity (Jaccard over content words) used only when no embedding model is available. */
function lexicalSimilarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export interface PrecedentResult { precedents: Precedent[]; method: 'vector' | 'lexical' | 'none'; model: string | null }

/**
 * Top-K technician precedents for a complaint. Same-model precedents first (spec filter), widened to the whole tenant
 * when the model has fewer than K. Vector search via the vendor embedding model; lexical only if embeddings are unavailable.
 */
export async function findPrecedents(db: Db, deps: GatewayDeps, tenantId: string, complaint: string, vehicleModel: string | null, topK = 3): Promise<PrecedentResult> {
  const m = deps.model;
  if (m) {
    const store = vectorStore(db, tenantId, STORY_COLLECTION, embedModelKey(m));
    if (store.size > 0) {
      const q = await embedTexts(deps, [complaint], 'query');
      if (q) {
        let hits = vehicleModel ? store.search(q[0], topK, (md) => md.model === vehicleModel) : [];
        if (hits.length < topK) {
          const seen = new Set(hits.map((h) => h.entry.id));
          hits = [...hits, ...store.search(q[0], topK + hits.length).filter((h) => !seen.has(h.entry.id))].slice(0, topK);
        }
        return {
          method: 'vector', model: embedModelKey(m),
          precedents: hits.map((h) => ({
            complaint: h.entry.metadata.customerComplaint, diagnosis: h.entry.metadata.technicianDiagnosis, action: h.entry.metadata.technicianAction,
            laborCode: h.entry.metadata.laborCode, wasOverride: h.entry.metadata.wasOverride, aiPredicted: h.entry.metadata.aiPredicted || null,
            score: Number(h.similarity.toFixed(4)), date: h.entry.metadata.date,
          })),
        };
      }
    }
  }
  const rows = all<StoryRow>(db, 'SELECT * FROM technician_stories WHERE tenant_id = ? ORDER BY closed_at DESC LIMIT 2000', tenantId);
  if (!rows.length) return { precedents: [], method: 'none', model: null };
  const scored = rows
    .map((r) => ({ r, s: lexicalSimilarity(complaint, `${r.customer_complaint} ${r.technician_diagnosis}`) + (vehicleModel && r.model === vehicleModel ? 0.05 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, topK);
  return {
    method: 'lexical', model: null,
    precedents: scored.map(({ r, s }) => ({
      complaint: r.customer_complaint, diagnosis: r.technician_diagnosis, action: r.technician_action, laborCode: r.labor_code,
      wasOverride: r.override_occurred === 1, aiPredicted: r.ai_predicted, score: Number(Math.min(1, s).toFixed(4)), date: r.closed_at.slice(0, 10),
    })),
  };
}

/**
 * Builds an advisor-facing diagnostic hypothesis for a case from technician precedents and stores it. The stored
 * hypothesis is later matched to the RO's technician_story, which is what makes the loop measurable.
 */
export async function diagnoseComplaint(ctx: Ctx, deps: GatewayDeps, input: { tenantId: string; caseId: string; complaint: string; kind: 'text' | 'image' | 'audio' }): Promise<string | null> {
  const db = ctx.db;
  const c = get<{ rooftop_id: string; ownership_id: string | null }>(db, 'SELECT rooftop_id, ownership_id FROM cases WHERE id = ? AND tenant_id = ?', input.caseId, input.tenantId);
  if (!c?.ownership_id) return null;
  const veh = get<{ vin: string; make: string; model: string; year: number }>(db,
    'SELECT v.vin, v.make, v.model, v.year FROM ownerships o JOIN vehicles v ON v.vin = o.vin WHERE o.id = ?', c.ownership_id);
  if (!veh) return null;
  const complaint = redactPII(input.complaint).slice(0, 1000);
  const found = await findPrecedents(db, deps, input.tenantId, `${veh.make} ${veh.model}: ${complaint}`, veh.model);
  const h = await diagnose(complaint, veh, found.precedents, deps);
  const id = randomUUID();
  run(db, `INSERT INTO diagnostics (id, tenant_id, rooftop_id, ownership_id, vin, case_id, source_kind, complaint, hypothesis, labor_code, confidence, method, retrieval, precedents, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, input.tenantId, c.rooftop_id, c.ownership_id, veh.vin, input.caseId, input.kind, complaint,
    h.hypothesis, h.likelyLaborCode, h.confidence, h.source, found.method, JSON.stringify(found.precedents), clock.iso());
  audit(db, input.tenantId, 'system:diagnostic', 'diagnostic.created', id, { case: input.caseId, method: h.source, retrieval: found.method, precedents: found.precedents.length });
  return id;
}

/* ---------- metrics ---------- */

export interface AccuracyReport {
  stories: number;
  withPrediction: number;
  confirmed: number;
  overridden: number;
  /** confirmed / withPrediction, or null when nothing has been predicted yet. */
  accuracy: number | null;
  bySource: Record<'payload' | 'diagnostic', { n: number; confirmed: number }>;
  embedded: number;
  pendingEmbed: number;
  failedEmbed: number;
  recentOverrides: Array<{ date: string; model: string; complaint: string; predicted: string; actual: string; laborCode: string }>;
}

export function closedLoopAccuracy(db: Db, tenantId: string): AccuracyReport {
  const rows = all<{ ai_predicted: string | null; ai_predicted_source: 'payload' | 'diagnostic' | null; override_occurred: number; embed_status: string }>(db,
    'SELECT ai_predicted, ai_predicted_source, override_occurred, embed_status FROM technician_stories WHERE tenant_id = ?', tenantId);
  const predicted = rows.filter((r) => r.ai_predicted);
  const confirmed = predicted.filter((r) => r.override_occurred === 0).length;
  const bySource = { payload: { n: 0, confirmed: 0 }, diagnostic: { n: 0, confirmed: 0 } };
  for (const r of predicted) {
    const k = r.ai_predicted_source ?? 'payload';
    bySource[k].n++;
    if (r.override_occurred === 0) bySource[k].confirmed++;
  }
  const recentOverrides = all<{ closed_at: string; model: string; customer_complaint: string; ai_predicted: string; technician_diagnosis: string; labor_code: string }>(db,
    `SELECT closed_at, model, customer_complaint, ai_predicted, technician_diagnosis, labor_code FROM technician_stories
     WHERE tenant_id = ? AND override_occurred = 1 AND ai_predicted IS NOT NULL ORDER BY closed_at DESC LIMIT 5`, tenantId)
    .map((r) => ({ date: r.closed_at.slice(0, 10), model: r.model, complaint: r.customer_complaint, predicted: r.ai_predicted, actual: r.technician_diagnosis, laborCode: r.labor_code }));
  return {
    stories: rows.length, withPrediction: predicted.length, confirmed, overridden: predicted.length - confirmed,
    accuracy: predicted.length ? Number((confirmed / predicted.length).toFixed(3)) : null, bySource,
    embedded: rows.filter((r) => r.embed_status === 'embedded').length, pendingEmbed: rows.filter((r) => r.embed_status === 'pending').length,
    failedEmbed: rows.filter((r) => r.embed_status === 'failed').length, recentOverrides,
  };
}
