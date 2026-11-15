/** Signed machine callers (HMAC-SHA256 over "timestamp.body", 300 s tolerance, idempotent, rate limited). See docs/CONTRACT.md. */
import { clock } from '../server/clock.ts';
import { safeEqual } from '../server/auth.ts';
import { change } from '../server/bus.ts';
import { handleInbound } from '../server/inbound.ts';
import { ingestWebhook, signBody } from '../server/tekion.ts';
import { JSON_CAP, json, limiters, peer, readBody, rt, type Handler } from './http.ts';

export const tekionWebhook: Handler = async (req) => {
  const r = rt();
  if (!limiters.webhook.allow(peer(req))) return json(429, { error: 'slow down' });
  const raw = (await readBody(req, JSON_CAP)).toString('utf8');
  const res = ingestWebhook(r.db, r.cfg.tekionWebhookSecret, raw, {
    timestamp: req.headers.get('x-tekion-timestamp') ?? '', signature: req.headers.get('x-tekion-signature') ?? '',
  });
  if (res.status === 202) {
    change(JSON.parse(raw).tenant_id, 'event');
    return json(202, { accepted: true, duplicate: res.duplicate });
  }
  return json(res.status, { error: res.error });
};

export const channelWebhook: Handler = async (req) => {
  const r = rt();
  if (!limiters.webhook.allow(peer(req))) return json(429, { error: 'slow down' });
  const raw = (await readBody(req, 100_000)).toString('utf8');
  const ts = req.headers.get('x-channel-timestamp') ?? '';
  if (!/^\d{10}$/.test(ts) || Math.abs(clock.now().getTime() / 1000 - Number(ts)) > 300) return json(401, { error: 'stale or missing timestamp' });
  if (!safeEqual(signBody(r.cfg.channelWebhookSecret, ts, raw), req.headers.get('x-channel-signature') ?? '')) return json(401, { error: 'bad signature' });
  let b: Record<string, any>;
  try { b = JSON.parse(raw); } catch { return json(400, { error: 'invalid json' }); }
  if (typeof b.tenant_id !== 'string' || typeof b.from !== 'string' || typeof b.body !== 'string' || typeof b.message_id !== 'string') {
    return json(400, { error: 'tenant_id, from, body, message_id required' });
  }
  const out = await handleInbound(r.ctx, { tenantId: b.tenant_id, fromPhone: b.from, body: b.body.slice(0, 1000), providerMsgId: b.message_id, source: 'sms' });
  change(b.tenant_id, 'inbound');
  return json(202, { status: out.status });
};
