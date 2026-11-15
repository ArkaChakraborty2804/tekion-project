/** Dev tools. Return 404 unless DEV_TOOLS=1, which loadConfig only honours together with AUTH_TEST_BYPASS=1 (loopback only). */
import { randomUUID } from 'node:crypto';
import { clock, DAY_MS } from '../server/clock.ts';
import { audit } from '../server/audit.ts';
import { listDevUsers } from '../server/auth.ts';
import { change } from '../server/bus.ts';
import { handleInbound } from '../server/inbound.ts';
import { ingestWebhook, signBody } from '../server/tekion.ts';
import { dispatchQueued } from '../server/channel.ts';
import { evaluateAll } from '../server/engine.ts';
import { runPump } from '../server/runtime.ts';
import { HttpError, json, readJson, rt, staff, type Handler } from './http.ts';

const devOnly = (fn: Handler): Handler => (req, params) => {
  if (!rt().cfg.devTools) throw new HttpError(404, 'not found');
  return fn(req, params);
};

/** Pre-sign-in picker for seeded demo identities: subs and roles only, no customer data. */
export const devUsers = devOnly(() => json(200, { users: listDevUsers(rt().db) }));

export const devClock = devOnly(async (req) => {
  const p = await staff(req, 'dev');
  const days = Number((await readJson(req)).offsetDays);
  if (!Number.isFinite(days) || Math.abs(days) > 730) return json(422, { error: 'offsetDays must be within ±730' });
  clock.setOffsetMs(days * DAY_MS);
  audit(rt().db, p.tenantId, p.id, 'dev.clock', 'clock', { offsetDays: days });
  return json(200, { offsetMs: clock.offsetMs() });
});

export const devInbound = devOnly(async (req) => {
  const p = await staff(req, 'dev');
  const body = await readJson(req);
  if (typeof body.phone !== 'string' || typeof body.text !== 'string') return json(422, { error: 'phone and text required' });
  const out = await handleInbound(rt().ctx, { tenantId: p.tenantId, fromPhone: body.phone, body: body.text.slice(0, 1000), providerMsgId: `dev:${randomUUID()}`, source: 'dev_sim' });
  change(p.tenantId, 'inbound');
  return json(200, out);
});

/** Signs a synthetic Tekion event with the real secret and ingests it through the same path as the webhook. */
export const devTekion = devOnly(async (req) => {
  const p = await staff(req, 'dev');
  const r = rt();
  const raw = JSON.stringify(await readJson(req));
  const ts = String(Math.floor(clock.now().getTime() / 1000));
  const out = ingestWebhook(r.db, r.cfg.tekionWebhookSecret, raw, { timestamp: ts, signature: signBody(r.cfg.tekionWebhookSecret, ts, raw) });
  change(p.tenantId, 'event');
  return json(out.status, out.status === 202 ? { accepted: true, duplicate: out.duplicate } : { error: out.error });
});

export const devScan = devOnly(async (req) => {
  const p = await staff(req, 'dev');
  const pumped = runPump();
  const evaluated = evaluateAll(rt().ctx, p.tenantId);
  change(p.tenantId, 'queue');
  return json(200, { pumped, evaluated });
});

export const devDispatch = devOnly(async (req) => {
  await staff(req, 'dev');
  const r = rt();
  return json(200, dispatchQueued(r.db, r.provider));
});
