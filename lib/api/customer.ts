/**
 * Customer-facing API: the reply page and the Digital Garage. Both are gated by the same capability link (reply.ts),
 * which is a demo stand-in for reviewed customer authentication. They are served only on a loopback bind and are
 * rate limited per peer. Gate order: loopback → rate limit → link (a link resolve counts as a use, so it runs last).
 */
import { randomUUID } from 'node:crypto';
import { get } from '../server/db.ts';
import { audit } from '../server/audit.ts';
import { change } from '../server/bus.ts';
import { handleInbound } from '../server/inbound.ts';
import { resolveCapabilityLink, acceptUpload } from '../server/reply.ts';
import { makeGateway, garageChat } from '../server/ai.ts';
import { triageDescription, triageUpload, type TriageOutcome } from '../server/triage.ts';
import { buildPassport, fallbackAnswer, passportFacts, requestBooking } from '../server/garage.ts';
import { HttpError, json, limiters, peer, readBody, readJson, rt, type Handler } from './http.ts';

type Link = NonNullable<ReturnType<typeof resolveCapabilityLink>>;

function customerLink(req: Request, token: string): Link {
  const r = rt();
  if (!r.customerPagesEnabled) throw new HttpError(503, 'disabled: server is not loopback-bound');
  if (!limiters.customer.allow(peer(req))) throw new HttpError(429, 'slow down');
  const link = resolveCapabilityLink(r.db, token);
  if (!link) throw new HttpError(404, 'link invalid or expired');
  return link;
}

const triageView = (t: TriageOutcome) => ({
  urgency: t.urgency, symbol: t.symbol, system: t.system, sound: t.sound, safety: t.safety,
  message: t.customerMessage, source: t.source, smsSent: t.smsSent,
});

/* ---------- reply page ---------- */

export const replyInfo: Handler = (req, { token }) => {
  const r = rt();
  const link = customerLink(req, token);
  const row = get<{ full_name: string; language: string; rooftop_name: string; year: number; make: string; model: string }>(r.db,
    `SELECT c.full_name, c.language, r.name AS rooftop_name, v.year, v.make, v.model
     FROM ownerships o JOIN customers c ON c.id = o.customer_id JOIN rooftops r ON r.id = o.rooftop_id JOIN vehicles v ON v.vin = o.vin
     WHERE o.id = ?`, link.ownershipId);
  if (!row) return json(404, { error: 'not found' });
  return json(200, {
    firstName: row.full_name.split(' ')[0],
    language: row.language === 'es' ? 'es' : 'en',
    rooftop: row.rooftop_name,
    vehicle: `${row.year} ${row.make} ${row.model}`,
    maxUploadMb: { image: Math.round(r.cfg.limits.imageBytes / 1048576), audio: Math.round(r.cfg.limits.audioBytes / 1048576) },
  });
};

export const replyMessage: Handler = async (req, { token }) => {
  const r = rt();
  const link = customerLink(req, token);
  const body = await readJson(req);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 1000) return json(422, { error: 'text required (max 1000 chars)' });
  const cust = get<{ phone: string | null }>(r.db, 'SELECT phone FROM customers WHERE id = ?', link.customerId);
  if (!cust?.phone) return json(422, { error: 'no phone on file' });
  const out = await handleInbound(r.ctx, { tenantId: link.tenantId, fromPhone: cust.phone, body: text, providerMsgId: `page:${link.linkId}:${randomUUID()}`, source: 'reply_page' });
  change(link.tenantId, 'inbound');
  return json(200, out.status === 'processed' ? { ok: true, reply: out.reply, safety: out.safety } : { ok: false });
};

/** Shared by the reply page and the garage: store the upload, then run AI triage on it. */
export const mediaUpload: Handler = async (req, { token }) => {
  const r = rt();
  const link = customerLink(req, token);
  const buf = await readBody(req, Math.max(r.cfg.limits.imageBytes, r.cfg.limits.audioBytes) + 1);
  const up = acceptUpload(r.ctx, r.media, link, buf, r.cfg.limits);
  if (!up.ok) return json(422, { error: up.error });
  change(link.tenantId, 'media');
  const note = (new URL(req.url).searchParams.get('note') ?? '').slice(0, 500) || undefined;
  const t = await triageUpload(r.ctx, link, { mediaId: up.mediaId, caseId: up.caseId, accepted: up.accepted }, note, undefined);
  if (t.smsSent || t.urgency === 'P1') change(link.tenantId, 'queue');
  return json(201, { ok: true, kind: up.kind, strippedBytes: up.strippedBytes, triage: triageView(t) });
};

/* ---------- Digital Garage ---------- */

export const garagePassport: Handler = (req, { token }) => {
  const link = customerLink(req, token);
  const p = buildPassport(rt().ctx, link);
  return p ? json(200, p) : json(404, { error: 'not found' });
};

export const garageChatRoute: Handler = async (req, { token }) => {
  const r = rt();
  const link = customerLink(req, token);
  const body = await readJson(req);
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > 500) return json(422, { error: 'question required (max 500 chars)' });
  const p = buildPassport(r.ctx, link);
  if (!p) return json(404, { error: 'not found' });
  const a = await garageChat(question, passportFacts(p), fallbackAnswer(p), makeGateway(r.db, r.ai, link.tenantId), p.customer.language);
  audit(r.db, link.tenantId, 'customer:garage', 'garage.chat', link.linkId, { source: a.source, promptId: a.promptId, escalate: a.escalate, issues: a.issues });
  if (a.escalate) change(link.tenantId, 'queue');
  return json(200, { answer: a.answer, escalate: a.escalate, safety: a.safety, source: a.source });
};

/** Problem described in words only. Same code-owned P1 escalation as media. */
export const garageDescribe: Handler = async (req, { token }) => {
  const link = customerLink(req, token);
  const body = await readJson(req);
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length < 3 || note.length > 500) return json(422, { error: 'Describe the problem in 3 to 500 characters.' });
  const t = await triageDescription(rt().ctx, link, note);
  change(link.tenantId, 'case');
  if (t.smsSent || t.urgency === 'P1') change(link.tenantId, 'queue');
  return json(201, { ok: true, kind: 'text', triage: triageView(t) });
};

export const garageBook: Handler = async (req, { token }) => {
  const link = customerLink(req, token);
  const body = await readJson(req);
  const mileage = typeof body.mileage === 'number' && Number.isFinite(body.mileage) ? Math.trunc(body.mileage) : null;
  const b = requestBooking(rt().ctx, link, mileage);
  change(link.tenantId, 'case');
  return json(201, { ok: true, caseId: b.caseId, title: b.title });
};
