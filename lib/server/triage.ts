/**
 * Multimodal triage of customer media (spec Phase 4): dashboard / fault photos via the vendor vision model, noise
 * recordings via the vendor audio model. Runs after the upload is stored and the case exists.
 *
 * Safety is fail-closed and owned by code, not the model (ai.ts finishTriage):
 *  - critical faults (brake hydraulic, fire, fuel leak, steering bind) in the note, model output or transcript force P1;
 *  - a model can raise urgency or add a safety flag, never lower a rules floor;
 *  - P1 sends the fixed non-LLM template on the safety purpose and escalates the case to safety/P1 for an advisor.
 * The model's free-text description is shown to the customer only for P2/P3 and only if it passes checkDraft.
 */
import { randomUUID } from 'node:crypto';
import { get, run, tx } from './db.ts';
import { clock } from './clock.ts';
import { audit } from './audit.ts';
import { analyzeAudio, makeGateway, P1_TRIAGE_TEMPLATE, redactPII, triageImage, triageText, type GatewayDeps, type TriageResult } from './ai.ts';
import { openOrNewProblemCase } from './reply.ts';
import { dispatchQueued, enqueueOutbound } from './channel.ts';
import { background } from './background.ts';
import { diagnoseComplaint } from './feedback.ts';
import type { Ctx } from './engine.ts';
import type { Accepted } from './media.ts';
import type { LinkContext } from './reply.ts';

export interface TriageOutcome {
  id: string;
  urgency: TriageResult['urgency'];
  symbol: string;
  system: string;
  sound: string | null;
  safety: boolean;
  customerMessage: string;
  source: TriageResult['source'];
  /** True when the P1 template was queued to the customer's phone as well as shown on screen. */
  smsSent: boolean;
}

function triageContext(ctx: Ctx, link: LinkContext, note?: string) {
  const veh = get<{ make: string; model: string; year: number }>(ctx.db,
    'SELECT v.make, v.model, v.year FROM ownerships o JOIN vehicles v ON v.vin = o.vin WHERE o.id = ? AND o.tenant_id = ?', link.ownershipId, link.tenantId);
  const cust = get<{ language: string }>(ctx.db, 'SELECT language FROM customers WHERE id = ?', link.customerId);
  const lang: 'en' | 'es' = cust?.language === 'es' ? 'es' : 'en';
  return { make: veh?.make ?? 'Unknown', model: veh?.model ?? 'Unknown', year: veh?.year ?? 0, note: note?.slice(0, 500), lang };
}

export async function triageUpload(ctx: Ctx, link: LinkContext, up: { mediaId: string; caseId: string; accepted: Accepted }, note?: string, gatewayIn?: GatewayDeps): Promise<TriageOutcome> {
  const gateway = gatewayIn ?? makeGateway(ctx.db, ctx.ai, link.tenantId);
  const tctx = triageContext(ctx, link, note);
  const part = { mime: up.accepted.mime, data: up.accepted.bytes };
  // Model call happens outside any transaction.
  const r = up.accepted.kind === 'image' ? await triageImage(part, tctx, gateway) : await analyzeAudio(part, tctx, gateway);
  return recordTriage(ctx, link, up.caseId, up.mediaId, r, note, gateway);
}

/** Customer describes the problem in words only (no photo or recording). Opens or reuses the open problem case. */
export async function triageDescription(ctx: Ctx, link: LinkContext, note: string, gatewayIn?: GatewayDeps): Promise<TriageOutcome> {
  const gateway = gatewayIn ?? makeGateway(ctx.db, ctx.ai, link.tenantId);
  const tctx = triageContext(ctx, link, note);
  const r = await triageText({ ...tctx, note: tctx.note ?? '' }, gateway);
  const caseId = tx(ctx.db, () => {
    const id = openOrNewProblemCase(ctx, link);
    audit(ctx.db, link.tenantId, 'customer:garage', 'problem.described', id, { chars: note.length });
    return id;
  });
  return recordTriage(ctx, link, caseId, null, r, tctx.note, gateway);
}

const KIND_LABEL: Record<TriageResult['kind'], string> = { image: 'Photo', audio: 'Noise', text: 'Description' };

/** Stores the result and applies the code-owned escalation (P1 case, fixed template SMS), then the advisor hypothesis. */
function recordTriage(ctx: Ctx, link: LinkContext, caseId: string, mediaId: string | null, r: TriageResult, note: string | undefined, gateway: GatewayDeps): TriageOutcome {
  const db = ctx.db;
  const lang = triageContext(ctx, link).lang;
  const up = { caseId };
  const id = randomUUID();
  const smsSent = tx(db, () => {
    run(db, `INSERT INTO triage_results (id, tenant_id, case_id, media_id, kind, symbol, sound, system, urgency, description, transcript, safety,
        safety_reasons, overridden, confidence, source, prompt_id, customer_message, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, link.tenantId, caseId, mediaId, r.kind, r.symbol, r.sound, r.system, r.urgency, r.description, r.transcript, r.safety ? 1 : 0,
      JSON.stringify(r.safetyReasons), r.overridden ? 1 : 0, r.confidence, r.source, r.promptId, r.customerMessage, clock.iso());
    const label = `${KIND_LABEL[r.kind]} triage ${r.urgency}: ${r.symbol} (${r.system})`;
    let sent = false;
    if (r.urgency === 'P1') {
      run(db, `UPDATE cases SET kind = 'safety', priority = 'P1', summary = ?, status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END WHERE id = ? AND tenant_id = ?`,
        `${label}. Safety: ${r.safetyReasons.join(', ') || 'urgent'}. Call the customer now.`, up.caseId, link.tenantId);
      try {
        enqueueOutbound(db, { tenantId: link.tenantId, rooftopId: link.rooftopId, customerId: link.customerId, ownershipId: link.ownershipId, opportunityId: null,
          purpose: 'safety_recall', body: P1_TRIAGE_TEMPLATE[lang] });
        sent = true;
      } catch {
        // No consent on file for any purpose: the on-screen template and the P1 advisor case still apply.
      }
      audit(db, link.tenantId, 'system:triage', 'triage.p1', up.caseId, { reasons: r.safetyReasons, overridden: r.overridden, source: r.source });
    } else {
      run(db, `UPDATE cases SET priority = CASE WHEN priority = 'P1' THEN 'P1' ELSE ? END, summary = ? WHERE id = ? AND tenant_id = ? AND kind <> 'safety'`,
        r.urgency, label, up.caseId, link.tenantId);
      audit(db, link.tenantId, 'system:triage', 'triage.completed', up.caseId, { urgency: r.urgency, system: r.system, source: r.source });
    }
    return sent;
  });
  if (smsSent) dispatchQueued(db, ctx.provider);

  // Advisor-facing hypothesis from technician precedents (never shown to the customer).
  const complaint = [note, r.description ?? r.symbol, r.transcript ? `Customer said: ${r.transcript}` : ''].filter(Boolean).join('. ');
  background(`diagnose_${r.kind}`, () => diagnoseComplaint(ctx, gateway, { tenantId: link.tenantId, caseId: up.caseId, complaint: redactPII(complaint), kind: r.kind }));

  return { id, urgency: r.urgency, symbol: r.symbol, system: r.system, sound: r.sound, safety: r.safety, customerMessage: r.customerMessage, source: r.source, smsSent };
}
