/**
 * Inbound customer replies (HLD 03 §4, 04 §2). Order of operations:
 *  1. Match customer by keyed phone hash (never by raw phone).
 *  2. Dedupe on provider message id (messages UNIQUE(provider_msg_id, direction)).
 *  3. STOP is applied synchronously with no model call.
 *  4. Safety keywords open a P1 safety case and send the fixed "don't drive" template. No model can clear them.
 *  5. Other intents are classified (rules first, then the configured Gemini/OpenAI model) and turned into state changes
 *     plus a case or reply. Problem and safety reports also get a background diagnostic hypothesis from technician
 *     precedents (feedback.ts) for the advisor; the customer never sees it.
 */
import { randomUUID } from 'node:crypto';
import { get, all, run, tx } from './db.ts';
import { clock, DAY_MS } from './clock.ts';
import { audit } from './audit.ts';
import { classifyReply, makeGateway, redactPII, type Classification, type GatewayDeps } from './ai.ts';
import { background } from './background.ts';
import { diagnoseComplaint } from './feedback.ts';
import { applyStop, dispatchQueued, enqueueOutbound } from './channel.ts';
import { caseFor, phoneHash, type Ctx } from './engine.ts';

export type InboundOutcome =
  | { status: 'duplicate' }
  | { status: 'unmatched' }
  | { status: 'processed'; intent: Classification['intent']; safety: boolean; caseId: string | null; reply: string | null };

export interface InboundInput {
  tenantId: string;
  fromPhone: string;
  body: string;
  providerMsgId: string;
  source: 'sms' | 'reply_page' | 'dev_sim';
}

const SAFETY_TEMPLATE: Record<'en' | 'es', (phone: string) => string> = {
  en: (p) => `Please do not drive the vehicle until you have spoken with us. Call ${p || 'your dealership'} now. If this is an emergency, call 911.`,
  es: (p) => `Por favor no conduzca el vehículo hasta hablar con nosotros. Llame ahora a ${p || 'su concesionario'}. Si es una emergencia, llame al 911.`,
};

const ACK: Record<'en' | 'es', Record<string, string>> = {
  en: {
    snooze: 'Got it, we will pause messages for now. Reply STOP to opt out.',
    sold: 'Thanks for letting us know. Our team will confirm with you shortly.',
    problem: 'Thanks. A service advisor will call you about this.',
    booking: 'Thanks. We will call you to find a time that works.',
    review: 'Thank you for your feedback!',
    question: 'Thanks. A team member will reply shortly.',
    help: 'Reply STOP to opt out. Msg&data rates may apply.',
  },
  es: {
    snooze: 'Entendido, pausaremos los mensajes por ahora. Responda STOP para cancelar.',
    sold: 'Gracias por avisarnos. Nuestro equipo se comunicará con usted pronto.',
    problem: 'Gracias. Un asesor de servicio le llamará.',
    booking: 'Gracias. Le llamaremos para encontrar un horario.',
    review: '¡Gracias por sus comentarios!',
    question: 'Gracias. Un miembro del equipo le responderá pronto.',
    help: 'Responda STOP para cancelar. Pueden aplicar tarifas de mensajes y datos.',
  },
};

const langOf = (l: string): 'en' | 'es' => (l === 'es' ? 'es' : 'en');

export async function handleInbound(ctx: Ctx, input: InboundInput, gatewayIn?: GatewayDeps): Promise<InboundOutcome> {
  const { db, cfg } = ctx;
  const gateway = gatewayIn ?? makeGateway(db, ctx.ai, input.tenantId);
  const hash = phoneHash(cfg, input.fromPhone);
  const cust = get<{ id: string; rooftop_id: string; language: string; phone: string | null }>(db,
    `SELECT id, rooftop_id, language, phone FROM customers WHERE tenant_id = ? AND phone_hash = ? LIMIT 1`, input.tenantId, hash);
  if (!cust) {
    audit(db, input.tenantId, 'system:inbound', 'inbound.unmatched', input.providerMsgId, { source: input.source });
    return { status: 'unmatched' };
  }

  // Classification may call a model, so it runs outside the write transaction.
  const cls = await classifyReply(input.body, gateway);
  const stored = redactPII(input.body).slice(0, 2000);

  const outcome = tx(db, () => {
    const inserted = run(db, `INSERT OR IGNORE INTO messages (id, tenant_id, rooftop_id, customer_id, ownership_id, opportunity_id, direction, purpose, body, status, provider_msg_id, channel, created_at)
      VALUES (?,?,?,?,NULL,NULL,'in','inbound',?,'received',?,?,?)`,
      randomUUID(), input.tenantId, cust.rooftop_id, cust.id, stored, input.providerMsgId, input.source === 'sms' ? 'sms' : 'web', clock.iso());
    if (inserted === 0) return { status: 'duplicate' as const };

    const own = get<{ id: string; state: string; rooftop_id: string }>(db,
      `SELECT id, state, rooftop_id FROM ownerships WHERE customer_id = ? AND state IN ('active','snoozed','possibly_sold','dormant')
       ORDER BY started_at DESC LIMIT 1`, cust.id);
    const lang = langOf(cust.language);
    const rooftop = get<{ phone: string; name: string }>(db, 'SELECT phone, name FROM rooftops WHERE id = ?', cust.rooftop_id);
    const rooftopPhone = rooftop?.phone ?? '';
    const ownId = own?.id ?? null;

    // A reply from the customer resets the non-responder counter (HLD 01 §3).
    if (ownId) run(db, `UPDATE ownerships SET unanswered_count = 0, updated_at = ? WHERE id = ?`, clock.iso(), ownId);

    const reply = (text: string, purpose: string) => {
      try {
        return enqueueOutbound(db, {
          tenantId: input.tenantId, rooftopId: cust.rooftop_id, customerId: cust.id, ownershipId: ownId, opportunityId: null, purpose, body: text,
        });
      } catch {
        return null; // no valid consent for this purpose: the case below still reaches staff
      }
    };

    // 1. STOP: no model, no reply to marketing; applied first.
    if (cls.intent === 'stop') {
      applyStop(db, input.tenantId, cust.id);
      audit(db, input.tenantId, 'system:inbound', 'consent.stop', cust.id, { source: input.source });
      return { status: 'processed' as const, intent: 'stop' as const, safety: false, caseId: null, reply: null };
    }

    // 2. Safety: P1 case, fixed template, advisor alert. Not gated by the model.
    if (cls.safety) {
      const caseId = caseFor(ctx, input.tenantId, cust.rooftop_id, ownId, cust.id, 'safety', 'P1',
        'Possible safety concern in customer reply', `Customer said: "${stored}"`);
      const msg = reply(SAFETY_TEMPLATE[lang](rooftopPhone), 'safety_recall');
      audit(db, input.tenantId, 'system:inbound', 'safety.flagged', caseId, { reasons: cls.safetyReasons });
      return { status: 'processed' as const, intent: cls.intent, safety: true, caseId, reply: msg ? SAFETY_TEMPLATE[lang](rooftopPhone) : null };
    }

    const replyText = ACK[lang][cls.intent] ?? ACK[lang].question;
    let caseId: string | null = null;

    switch (cls.intent) {
      case 'help':
        reply(ACK[lang].help, 'service');
        break;
      case 'snooze': {
        const months = cls.entities.snoozeMonths ?? 3;
        if (ownId) {
          const until = new Date(clock.now().getTime() + months * 30 * DAY_MS).toISOString();
          run(db, `UPDATE ownerships SET state = 'snoozed', snooze_until = ?, updated_at = ?, version = version + 1 WHERE id = ? AND state IN ('active','dormant')`,
            until, clock.iso(), ownId);
        }
        reply(replyText, 'service');
        break;
      }
      case 'sold': {
        if (ownId) {
          run(db, `UPDATE ownerships SET state = 'possibly_sold', updated_at = ?, version = version + 1 WHERE id = ? AND state IN ('active','snoozed','dormant')`, clock.iso(), ownId);
        }
        caseId = caseFor(ctx, input.tenantId, cust.rooftop_id, ownId, cust.id, 'callback', 'P2',
          'Customer says they sold or no longer own the vehicle', 'Confirm ownership before any further outreach.');
        reply(replyText, 'service');
        break;
      }
      case 'problem':
        caseId = caseFor(ctx, input.tenantId, cust.rooftop_id, ownId, cust.id, 'problem', 'P2', 'Customer reported a vehicle problem', `Customer said: "${stored}"`);
        reply(replyText, 'service');
        break;
      case 'booking':
        caseId = caseFor(ctx, input.tenantId, cust.rooftop_id, ownId, cust.id, 'callback', 'P2', 'Customer wants to book', `Customer said: "${stored}"`);
        reply(replyText, 'service');
        break;
      case 'review': {
        const csat = /\b([1-5])\b/.exec(input.body);
        if (csat && ownId) run(db, `UPDATE ownerships SET last_ro_csat = ? WHERE id = ?`, Number(csat[1]), ownId);
        reply(replyText, 'service');
        break;
      }
      default:
        caseId = caseFor(ctx, input.tenantId, cust.rooftop_id, ownId, cust.id, 'question', 'P3', 'Customer message needs a reply', `Customer said: "${stored}"`);
        reply(replyText, 'service');
    }
    audit(db, input.tenantId, 'system:inbound', 'inbound.processed', cust.id, { intent: cls.intent, source: cls.source, fallback: cls.fallbackUsed });
    return { status: 'processed' as const, intent: cls.intent, safety: false, caseId, reply: replyText };
  });
  // Outbound replies are queued in the transaction above and sent after commit.
  if (outcome.status === 'processed') {
    dispatchQueued(db, ctx.provider);
    if (outcome.caseId && (outcome.safety || outcome.intent === 'problem')) {
      const caseId = outcome.caseId;
      background('diagnose_inbound', () => diagnoseComplaint(ctx, gateway, { tenantId: input.tenantId, caseId, complaint: input.body, kind: 'text' }));
    }
  }
  return outcome;
}

/** Thin helper for the reply page and tests: staff-visible thread for a customer. */
export function threadFor(ctxDb: Ctx['db'], tenantId: string, customerId: string) {
  return all<{ id: string; direction: string; purpose: string; body: string; status: string; created_at: string }>(ctxDb,
    `SELECT id, direction, purpose, body, status, created_at FROM messages WHERE tenant_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 100`,
    tenantId, customerId);
}
