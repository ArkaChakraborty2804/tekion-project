/**
 * Staff API. Every handler requires a verified principal (OIDC, or dev identities on loopback with AUTH_TEST_BYPASS=1)
 * and an action from the role matrix (auth.ts), plus rooftop scope on every row. Non-PII roles get masked data.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { all, get, run, tx, type Db } from '../server/db.ts';
import { clock, DAY_MS } from '../server/clock.ts';
import { audit, verifyAuditChain } from '../server/audit.ts';
import { can } from '../server/auth.ts';
import { bus, change, type ChangeEvent } from '../server/bus.ts';
import { createCapabilityLink } from '../server/reply.ts';
import { loadRules, validateRules, decide, generateCandidates, setOwnershipState, APPROVER_ROLES, REJECT_CODES, type Rules } from '../server/engine.ts';
import { eventStats } from '../server/events.ts';
import { makeGateway } from '../server/ai.ts';
import { fleetChurn } from '../server/churn.ts';
import { closedLoopAccuracy, findPrecedents } from '../server/feedback.ts';
import { runPump } from '../server/runtime.ts';
import { sendPlan, type Tier } from '../server/policy.ts';
import { API_HEADERS, headerRecord, inScope, json, listActions, maskRow, readJson, rt, staff, text, type Handler } from './http.ts';
import { authenticate } from '../server/auth.ts';

/* ---------- identity, config, dashboard, live stream ---------- */

export const health: Handler = () => json(200, { ok: true, time: clock.iso(), offsetMs: clock.offsetMs() });

export const me: Handler = async (req) => {
  const p = await staff(req);
  return json(200, { id: p.id, name: p.name, role: p.role, rooftopIds: p.rooftopIds, can: listActions(p) });
};

export const config: Handler = async (req) => {
  const p = await staff(req);
  const r = rt();
  const rooftops = all<{ id: string; name: string; tz: string }>(r.db, 'SELECT id, name, tz FROM rooftops WHERE tenant_id = ? ORDER BY name', p.tenantId)
    .filter((x) => inScope(p, x.id));
  return json(200, {
    rooftops, roles: APPROVER_ROLES, rejectCodes: REJECT_CODES,
    provider: r.provider.name,
    ai: { configured: r.cfg.ai.provider, active: r.ai?.name ?? null, textModel: r.ai?.textModel ?? null, embedModel: r.ai?.embedModel ?? null },
    recallMode: r.cfg.recallMode, devTools: r.cfg.devTools, authTestBypass: r.cfg.authTestBypass,
    clockOffsetMs: clock.offsetMs(), replyEnabled: r.customerPagesEnabled,
  });
};

export const dashboard: Handler = async (req) => {
  const p = await staff(req, 'read');
  const { db } = rt();
  const t = p.tenantId;
  const since7 = new Date(clock.now().getTime() - 7 * DAY_MS).toISOString();
  return json(200, {
    queue: all<{ status: string; n: number }>(db, `SELECT status, COUNT(*) AS n FROM opportunities WHERE tenant_id = ? GROUP BY status`, t),
    cases: all<{ priority: string; status: string; n: number }>(db, `SELECT priority, status, COUNT(*) AS n FROM cases WHERE tenant_id = ? AND status <> 'resolved' GROUP BY priority, status`, t),
    sent7d: get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'out' AND status = 'sent' AND created_at >= ?`, t, since7)?.n ?? 0,
    optedOut: get<{ n: number }>(db, `SELECT COUNT(DISTINCT customer_id) AS n FROM (SELECT customer_id, purpose, consent_type, MAX(captured_at) FROM consents WHERE tenant_id = ? AND purpose = 'marketing' GROUP BY customer_id) WHERE consent_type = 'revoked'`, t)?.n ?? 0,
    ownerships: all<{ state: string; n: number }>(db, `SELECT state, COUNT(*) AS n FROM ownerships WHERE tenant_id = ? GROUP BY state`, t),
    events: eventStats(db, t),
    recallOpen: get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM recall_findings WHERE tenant_id = ? AND status = 'open'`, t)?.n ?? 0,
    inbound7d: get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND direction = 'in' AND created_at >= ?`, t, since7)?.n ?? 0,
    // Outbound messages per day (last 14 days) by purpose family, for the activity chart.
    daily: all<{ day: string; safety: number; service: number; marketing: number }>(db,
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(purpose = 'safety_recall') AS safety, SUM(purpose = 'service') AS service, SUM(purpose LIKE 'marketing%') AS marketing
       FROM messages WHERE tenant_id = ? AND direction = 'out' AND created_at >= ? GROUP BY day ORDER BY day`,
      t, new Date(clock.now().getTime() - 14 * DAY_MS).toISOString()),
    // Why candidates are being held back right now (contact policy doing its job).
    held: all<{ check: string; n: number }>(db,
      `SELECT substr(suppressed_by, 1, instr(suppressed_by, ':') - 1) AS "check", COUNT(*) AS n FROM opportunities
       WHERE tenant_id = ? AND status = 'candidate' AND suppressed_by IS NOT NULL GROUP BY 1 ORDER BY n DESC`, t),
  });
};

/** Server-sent change notifications for the caller's tenant. Fetched with the same auth header as other calls. */
export const stream: Handler = async (req) => {
  const r = rt();
  const p = await authenticate({ db: r.db, cfg: r.cfg, verifier: r.verifier }, headerRecord(req));
  if (!p) return json(401, { error: 'authentication required' });
  const enc = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (s: string) => { try { ctrl.enqueue(enc.encode(s)); } catch { cleanup(); } };
      send(': connected\n\n');
      const onChange = (ev: ChangeEvent) => {
        if (ev.tenantId === p.tenantId) send(`event: change\ndata: ${JSON.stringify({ kind: ev.kind, at: ev.at })}\n\n`);
      };
      bus.on('change', onChange);
      const hb = setInterval(() => send(': hb\n\n'), 25_000);
      cleanup = () => { clearInterval(hb); bus.off('change', onChange); };
      req.signal.addEventListener('abort', () => { cleanup(); try { ctrl.close(); } catch { /* already closed */ } });
    },
    cancel() { cleanup(); },
  });
  return new Response(body, {
    headers: { ...API_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  });
};

export const metrics: Handler = async (req) => {
  const p = await staff(req, 'audit_read');
  const { db } = rt();
  const ev = eventStats(db, p.tenantId);
  const lines = [
    `# TYPE loyalty_events gauge`,
    `loyalty_events{status="pending"} ${ev.pending}`,
    `loyalty_events{status="dead"} ${ev.dead}`,
    `loyalty_events{status="done"} ${ev.done}`,
    `# TYPE loyalty_opportunities gauge`,
    ...all<{ status: string; n: number }>(db, `SELECT status, COUNT(*) AS n FROM opportunities WHERE tenant_id = ? GROUP BY status`, p.tenantId)
      .map((x) => `loyalty_opportunities{status="${x.status}"} ${x.n}`),
  ];
  return text(200, lines.join('\n') + '\n');
};

/* ---------- approval queue ---------- */

export const queue: Handler = async (req) => {
  const p = await staff(req, 'read');
  const status = new URL(req.url).searchParams.get('status') ?? 'pending_approval';
  const rows = all<Record<string, any>>(rt().db,
    `SELECT o.id, o.type, o.need, o.tier, o.score, o.status, o.purpose, o.reason, o.facts, o.draft, o.bundle, o.due_at, o.expires_at,
            o.created_at, o.rooftop_id, o.ownership_id, c.id AS customer_id, c.full_name, c.language, c.tz AS customer_tz, v.year, v.make, v.model, r.name AS rooftop_name
     FROM opportunities o
     JOIN ownerships ow ON ow.id = o.ownership_id JOIN customers c ON c.id = ow.customer_id
     JOIN vehicles v ON v.vin = ow.vin JOIN rooftops r ON r.id = o.rooftop_id
     WHERE o.tenant_id = ? AND o.status = ? ORDER BY o.tier ASC, o.score DESC LIMIT 200`, p.tenantId, status);
  const now = clock.now();
  const qh = rt().cfg.quietHours;
  const items = rows.filter((x) => inScope(p, x.rooftop_id)).map((x) => {
    const plan = sendPlan(now, x.customer_tz ?? 'UTC', qh, x.purpose, x.tier as Tier);
    return { ...maskRow(p, x), sendPlan: { held: plan.held, localNow: plan.localNow, localSendAt: plan.localSendAt } };
  });
  return json(200, { items });
};

export const decideOpp: Handler = async (req, { id }) => {
  const p = await staff(req, 'decide');
  const r = rt();
  const opp = get<{ rooftop_id: string }>(r.db, 'SELECT rooftop_id FROM opportunities WHERE id = ? AND tenant_id = ?', id, p.tenantId);
  if (!opp || !inScope(p, opp.rooftop_id)) return json(404, { error: 'not found' });
  const body = await readJson(req);
  const action = body.action;
  if (!['approve', 'edit', 'reject', 'snooze'].includes(action)) return json(422, { error: 'action must be approve|edit|reject|snooze' });
  const out = decide(r.ctx, id, action, { id: p.id, role: p.role, tenantId: p.tenantId }, {
    text: typeof body.text === 'string' ? body.text : undefined,
    reasonCode: typeof body.reasonCode === 'string' ? body.reasonCode : undefined,
    months: typeof body.months === 'number' ? body.months : undefined,
  });
  if (!out.ok) return json(out.code, { error: out.error });
  change(p.tenantId, 'queue');
  return json(200, out);
};

export const precedents: Handler = async (req, { id }) => {
  const p = await staff(req, 'read');
  const r = rt();
  const o = get<{ rooftop_id: string; reason: string | null; type: string; make: string; model: string }>(r.db,
    `SELECT o.rooftop_id, o.reason, o.type, v.make, v.model FROM opportunities o
     JOIN ownerships ow ON ow.id = o.ownership_id JOIN vehicles v ON v.vin = ow.vin
     WHERE o.id = ? AND o.tenant_id = ?`, id, p.tenantId);
  if (!o || !inScope(p, o.rooftop_id)) return json(404, { error: 'not found' });
  const complaint = o.reason ?? `scheduled ${o.type} service`;
  return json(200, await findPrecedents(r.db, makeGateway(r.db, r.ai, p.tenantId), p.tenantId, complaint, o.model));
};

/* ---------- customers and Customer 360 ---------- */

export const customers: Handler = async (req) => {
  const p = await staff(req, 'read');
  const q = `%${(new URL(req.url).searchParams.get('q') ?? '').slice(0, 60)}%`;
  const rows = all<{ id: string; full_name: string; rooftop_id: string; language: string; party_id: string | null }>(rt().db,
    `SELECT id, full_name, rooftop_id, language, party_id FROM customers WHERE tenant_id = ? AND (full_name LIKE ? OR party_id LIKE ?) ORDER BY full_name LIMIT 50`,
    p.tenantId, q, q);
  return json(200, { items: rows.filter((x) => inScope(p, x.rooftop_id)).map((x) => (can(p, 'pii_read') ? x : { ...x, full_name: null })) });
};

export const customer360: Handler = async (req, { id }) => {
  const p = await staff(req, 'read');
  const { db } = rt();
  const c = get<Record<string, any>>(db, 'SELECT * FROM customers WHERE id = ? AND tenant_id = ?', id, p.tenantId);
  if (!c || !inScope(p, c.rooftop_id)) return json(404, { error: 'not found' });
  const pii = can(p, 'pii_read');
  const { phone_hash: _ph, email_hash: _eh, ...safe } = c;
  return json(200, {
    customer: pii ? safe : { ...safe, full_name: null, phone: null, email: null },
    ownerships: all(db, `SELECT o.id, o.vin, o.state, o.started_at, o.snooze_until, o.unanswered_count, o.last_service_at, o.last_service_odometer, o.last_ro_csat, v.year, v.make, v.model, v.odometer, v.warranty_end_date, v.loan_end_date, v.insurance_renewal_date
                         FROM ownerships o JOIN vehicles v ON v.vin = o.vin WHERE o.customer_id = ? ORDER BY o.started_at DESC`, c.id),
    consents: all(db, `SELECT purpose, consent_type, source, captured_at FROM consents WHERE tenant_id = ? AND customer_id = ? ORDER BY captured_at DESC LIMIT 50`, p.tenantId, c.id),
    opportunities: all(db, `SELECT id, type, tier, status, purpose, reason, created_at FROM opportunities WHERE tenant_id = ? AND ownership_id IN (SELECT id FROM ownerships WHERE customer_id = ?) ORDER BY created_at DESC LIMIT 50`, p.tenantId, c.id),
    messages: all<Record<string, any>>(db, `SELECT id, direction, purpose, status, body, created_at, send_after FROM messages WHERE tenant_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 100`, p.tenantId, c.id)
      .map((m) => (pii ? m : { ...m, body: '[hidden]' })),
    cases: all(db, `SELECT id, kind, priority, status, summary, created_at FROM cases WHERE tenant_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 50`, p.tenantId, c.id),
  });
};

export const ownershipState: Handler = async (req, { id }) => {
  const p = await staff(req, 'decide');
  const r = rt();
  const own = get<{ rooftop_id: string }>(r.db, 'SELECT rooftop_id FROM ownerships WHERE id = ? AND tenant_id = ?', id, p.tenantId);
  if (!own || !inScope(p, own.rooftop_id)) return json(404, { error: 'not found' });
  const body = await readJson(req);
  if (body.action !== 'confirm_sold' && body.action !== 'still_owned') return json(422, { error: 'action must be confirm_sold|still_owned' });
  const ok = setOwnershipState(r.ctx, id, body.action, p.id);
  change(p.tenantId, 'ownership');
  return json(ok ? 200 : 404, { ok });
};

/** One capability link gates both customer pages (reply page and Digital Garage). Loopback binds only. */
export const replyLink: Handler = async (req, { id }) => {
  const p = await staff(req, 'decide');
  const r = rt();
  const c = get<{ rooftop_id: string }>(r.db, 'SELECT rooftop_id FROM customers WHERE id = ? AND tenant_id = ?', id, p.tenantId);
  if (!c || !inScope(p, c.rooftop_id)) return json(404, { error: 'not found' });
  const own = get<{ id: string }>(r.db, `SELECT id FROM ownerships WHERE customer_id = ? AND state IN ('active','snoozed','possibly_sold','dormant') ORDER BY started_at DESC LIMIT 1`, id);
  if (!own) return json(409, { error: 'no open ownership' });
  if (!r.customerPagesEnabled) return json(409, { error: 'reply links are disabled: server is not loopback-bound (security review pending)' });
  const link = createCapabilityLink(r.db, p.tenantId, own.id);
  const base = r.cfg.publicBaseUrl.replace(/\/$/, '');
  return json(201, { url: `${base}/reply/${link.token}`, garageUrl: `${base}/garage/${link.token}`, expiresAt: link.expiresAt });
};

/* ---------- cases and media ---------- */

export const cases: Handler = async (req) => {
  const p = await staff(req, 'read');
  const { db } = rt();
  const status = new URL(req.url).searchParams.get('status') ?? 'open';
  const rows = all<Record<string, any>>(db,
    `SELECT k.id, k.kind, k.priority, k.status, k.summary, k.body, k.created_at, k.acked_by, k.acked_at, k.rooftop_id, k.customer_id, c.full_name
     FROM cases k JOIN customers c ON c.id = k.customer_id
     WHERE k.tenant_id = ? AND k.status = ? ORDER BY k.priority ASC, k.created_at ASC LIMIT 200`, p.tenantId, status);
  const items = rows.filter((x) => inScope(p, x.rooftop_id)).map((x) => ({
    ...maskRow(p, x),
    media: all<{ id: string; kind: string; mime: string; bytes: number }>(db, `SELECT id, kind, mime, bytes FROM media WHERE case_id = ? AND deleted_at IS NULL`, x.id),
  }));
  return json(200, { items });
};

export const caseDetail: Handler = async (req, { id }) => {
  const p = await staff(req, 'read');
  const { db } = rt();
  const k = get<Record<string, any>>(db,
    `SELECT k.id, k.kind, k.priority, k.status, k.summary, k.body, k.created_at, k.acked_by, k.acked_at, k.resolution, k.rooftop_id, k.customer_id, k.ownership_id, c.full_name
     FROM cases k JOIN customers c ON c.id = k.customer_id WHERE k.id = ? AND k.tenant_id = ?`, id, p.tenantId);
  if (!k || !inScope(p, k.rooftop_id)) return json(404, { error: 'not found' });
  const triage = all(db,
    `SELECT id, media_id, kind, symbol, sound, system, urgency, description, transcript, safety, safety_reasons, overridden, confidence, source, customer_message, created_at
     FROM triage_results WHERE case_id = ? AND tenant_id = ? ORDER BY created_at DESC`, k.id, p.tenantId);
  const diagnostics = all(db,
    `SELECT id, source_kind, complaint, hypothesis, labor_code, confidence, method, retrieval, precedents, resolved_story_id, created_at
     FROM diagnostics WHERE case_id = ? AND tenant_id = ? ORDER BY created_at DESC`, k.id, p.tenantId);
  const media = all(db, `SELECT id, kind, mime, bytes FROM media WHERE case_id = ? AND deleted_at IS NULL`, k.id);
  return json(200, { ...maskRow(p, k), media, triage, diagnostics });
};

function caseInScope(db: Db, p: Awaited<ReturnType<typeof staff>>, id: string): boolean {
  const k = get<{ rooftop_id: string }>(db, 'SELECT rooftop_id FROM cases WHERE id = ? AND tenant_id = ?', id, p.tenantId);
  return !!k && inScope(p, k.rooftop_id);
}

export const ackCase: Handler = async (req, { id }) => {
  const p = await staff(req, 'case_ack');
  const { db } = rt();
  if (!caseInScope(db, p, id)) return json(404, { error: 'not found' });
  const n = run(db, `UPDATE cases SET status = 'acknowledged', acked_by = ?, acked_at = ? WHERE id = ? AND status = 'open'`, p.id, clock.iso(), id);
  if (n) audit(db, p.tenantId, p.id, 'case.acked', id, {});
  change(p.tenantId, 'case');
  return json(n ? 200 : 409, { ok: n === 1 });
};

export const resolveCase: Handler = async (req, { id }) => {
  const p = await staff(req, 'case_ack');
  const { db } = rt();
  if (!caseInScope(db, p, id)) return json(404, { error: 'not found' });
  const body = await readJson(req);
  const resolution = typeof body.resolution === 'string' ? body.resolution.slice(0, 500) : '';
  if (!resolution) return json(422, { error: 'resolution required' });
  const n = run(db, `UPDATE cases SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ? AND status <> 'resolved'`, clock.iso(), resolution, id);
  if (n) audit(db, p.tenantId, p.id, 'case.resolved', id, { resolution });
  change(p.tenantId, 'case');
  return json(n ? 200 : 409, { ok: n === 1 });
};

/** Customer media for staff with PII access. Served sandboxed so an upload can never run as a page. */
export const mediaFile: Handler = async (req, { id }) => {
  const p = await staff(req, 'pii_read');
  const { db } = rt();
  const m = get<{ path: string; mime: string; rooftop_id: string; deleted_at: string | null }>(db,
    `SELECT m.path, m.mime, m.deleted_at, k.rooftop_id FROM media m JOIN cases k ON k.id = m.case_id WHERE m.id = ? AND m.tenant_id = ?`, id, p.tenantId);
  if (!m || !inScope(p, m.rooftop_id)) return json(404, { error: 'not found' });
  if (m.deleted_at) return json(410, { error: 'deleted by retention policy' });
  const buf = await readFile(m.path);
  return new Response(new Uint8Array(buf), {
    headers: {
      ...API_HEADERS, 'Content-Type': m.mime, 'Content-Length': String(buf.length), 'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
};

/* ---------- rules (guardrailed, versioned) ---------- */

function mergeRules(db: Db, tenantId: string, incoming: unknown): Rules {
  const base = loadRules(db, tenantId).rules;
  if (!incoming || typeof incoming !== 'object') return base;
  const patch = incoming as Partial<Rules>;
  const merged: Rules = { ...base };
  for (const k of Object.keys(base) as Array<keyof Rules>) {
    const v = patch[k];
    if (v === undefined) continue;
    (merged as any)[k] = typeof base[k] === 'object' && !Array.isArray(base[k]) ? { ...(base[k] as object), ...(v as object) } : v;
  }
  return merged;
}

export const rules: Handler = async (req) => {
  const p = await staff(req, 'read');
  const { db } = rt();
  const versions = all(db, `SELECT id, version, status, created_by, created_at, published_at FROM rule_versions WHERE tenant_id = ? ORDER BY version DESC LIMIT 20`, p.tenantId);
  return json(200, { published: loadRules(db, p.tenantId), defaults: loadRules(db, 'none').rules, versions });
};

/** Dry run: candidate counts per type under the proposed rules, nothing persisted. */
export const previewRules: Handler = async (req) => {
  const p = await staff(req, 'rules_edit');
  const { db } = rt();
  const merged = mergeRules(db, p.tenantId, (await readJson(req)).rules);
  const errors = validateRules(merged);
  if (errors.length) return json(422, { errors });
  const now = clock.now();
  const rows = all<Record<string, any>>(db,
    `SELECT o.*, v.make, v.model, v.year, v.odometer, v.odometer_at, v.warranty_end_date, v.warranty_end_miles, v.loan_end_date, v.insurance_renewal_date, v.annual_miles, r.name AS rooftop_name
     FROM ownerships o JOIN vehicles v ON v.vin = o.vin JOIN rooftops r ON r.id = o.rooftop_id
     WHERE o.tenant_id = ? AND o.state IN ('active','snoozed','dormant')`, p.tenantId);
  const counts: Record<string, number> = {};
  for (const o of rows) {
    if (!inScope(p, o.rooftop_id)) continue;
    for (const c of generateCandidates(o as any, o as any, merged, now, [], o.rooftop_name)) counts[c.type] = (counts[c.type] ?? 0) + 1;
  }
  return json(200, { valid: true, counts, ownershipsEvaluated: rows.length });
};

export const saveRules: Handler = async (req) => {
  const p = await staff(req, 'rules_edit');
  const { db } = rt();
  const merged = mergeRules(db, p.tenantId, (await readJson(req)).rules);
  const errors = validateRules(merged);
  if (errors.length) return json(422, { errors });
  const id = randomUUID();
  tx(db, () => {
    const v = get<{ v: number }>(db, 'SELECT COALESCE(MAX(version), 0) AS v FROM rule_versions WHERE tenant_id = ?', p.tenantId)?.v ?? 0;
    run(db, `INSERT INTO rule_versions (id, tenant_id, version, body, status, created_by, created_at) VALUES (?,?,?,?,'draft',?,?)`,
      id, p.tenantId, v + 1, JSON.stringify(merged), p.id, clock.iso());
    audit(db, p.tenantId, p.id, 'rules.draft', id, { version: v + 1 });
  });
  return json(201, { id });
};

export const publishRules: Handler = async (req, { id }) => {
  const p = await staff(req, 'rules_publish');
  const { db } = rt();
  const row = get<{ body: string; version: number }>(db, `SELECT body, version FROM rule_versions WHERE id = ? AND tenant_id = ? AND status = 'draft'`, id, p.tenantId);
  if (!row) return json(404, { error: 'draft not found' });
  const errors = validateRules(JSON.parse(row.body));
  if (errors.length) return json(422, { errors });
  tx(db, () => {
    run(db, `UPDATE rule_versions SET status = 'retired' WHERE tenant_id = ? AND status = 'published'`, p.tenantId);
    run(db, `UPDATE rule_versions SET status = 'published', published_at = ? WHERE id = ?`, clock.iso(), id);
    audit(db, p.tenantId, p.id, 'rules.published', id, { version: row.version });
  });
  return json(200, { ok: true, version: row.version });
};

/* ---------- analytics, audit, ops ---------- */

export const churnAnalytics: Handler = async (req) => {
  const p = await staff(req, 'read');
  const { db } = rt();
  const scope = p.rooftopIds.includes('*') ? null : p.rooftopIds;
  const f = fleetChurn(db, p.tenantId, scope, loadRules(db, p.tenantId).rules.service.intervalDays, clock.now());
  const mask = (x: (typeof f.all)[number]) => (can(p, 'pii_read') ? x : { ...x, customer: null });
  return json(200, { ...f, top: f.top.map(mask), all: f.all.map(mask) });
};

export const accuracyAnalytics: Handler = async (req) => {
  const p = await staff(req, 'read');
  return json(200, closedLoopAccuracy(rt().db, p.tenantId));
};

export const auditLog: Handler = async (req) => {
  const p = await staff(req, 'audit_read');
  const limit = Math.min(200, Number(new URL(req.url).searchParams.get('limit') ?? 100) || 100);
  return json(200, { items: all(rt().db, `SELECT seq, actor, action, subject, detail, created_at FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?`, p.tenantId, limit) });
};

export const auditVerify: Handler = async (req) => {
  await staff(req, 'audit_read');
  return json(200, verifyAuditChain(rt().db));
};

export const pumpEvents: Handler = async (req) => {
  const p = await staff(req, 'rules_publish');
  const out = runPump();
  change(p.tenantId, 'event');
  return json(200, out);
};
