'use client';
/** Approval queue: every non-templated message waits here for approve / edit / snooze / reject (four-eyes on edits). */
import { Clock, Lightbulb, MessageSquare, Send, Users, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useLoad, useStaff } from './context';
import { Card, Empty, KeyValues, Loading, OPP_LABEL, PageTitle, Pill, Segmented, TIER_TONE, VehicleImage, btn, cx, textarea } from '../ui/kit';

type Item = Record<string, any>;
type Filter = 'all' | 'service' | 'winback' | 'followup' | 'offers' | 'review';
const FILTER_TYPES: Record<Exclude<Filter, 'all'>, string[]> = {
  service: ['D1'], winback: ['D1_WINBACK'], followup: ['D2_FOLLOWUP'], offers: ['D4', 'D5', 'D6'], review: ['D7'],
};

function factsOf(it: Item): Record<string, any> {
  try { return JSON.parse(it.facts || '{}') ?? {}; } catch { return {}; }
}
function bundleOf(it: Item): string[] {
  try { return JSON.parse(it.bundle || '[]') ?? []; } catch { return []; }
}

function Facts({ f }: { f: Record<string, any> }) {
  if (f.voucher) {
    return <KeyValues items={[
      ['Incentive', f.voucher], ['Churn score', String(f.churnScore ?? '')],
      ['Next milestone', f.milestone ? `${f.milestone} · ${f.milestoneStatus ?? ''}` : '—'], ['Est. ticket', f.estCost ?? '—'],
    ]} />;
  }
  if (!f.milestone) return null;
  return <KeyValues items={[
    ['OEM milestone', `${f.milestone}`], ['Services', [].concat(f.services ?? []).join(', ')],
    ['Parts', [].concat(f.parts ?? []).join(', ') || 'none'], ['Estimated cost', f.estCost ?? ''],
    ['Criticality', f.criticality ?? ''], ['Status', f.milestoneStatus ?? ''], ['Due by', f.dueBy ?? ''], ['Schedule', f.scheduleSource ?? ''],
  ]} />;
}

/** Technician precedents are fetched on demand (one embedding call each), not on every card render. */
function Precedents({ id }: { id: string }) {
  const { api } = useStaff();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ msg?: string; r?: any } | null>(null);
  const load = async () => {
    setBusy(true);
    setOut({ msg: 'Looking up technician precedents…' });
    try {
      const r = await api(`/api/opps/${id}/precedents`);
      setOut(r.precedents.length ? { r } : { msg: 'No precedents yet for this vehicle model.' });
    } catch (e) { setOut({ msg: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <div>
      <button type="button" className={btn.ghost} disabled={busy} onClick={load}><Wrench className="w-3.5 h-3.5" />Technician precedents</button>
      {out?.msg ? <p className="mt-2 text-xs text-slate-500">{out.msg}</p> : null}
      {out?.r ? (
        <ul className="mt-2 space-y-2">
          <li className="text-[11px] text-slate-400">Retrieval: {out.r.method}{out.r.model ? ` · ${out.r.model}` : ''}</li>
          {out.r.precedents.map((p: any, i: number) => (
            <li key={i} className="rounded-lg border border-slate-200 dark:border-white/10 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-900 dark:text-white">{p.diagnosis}</span>
                <span className="font-mono-tabular text-blue-600 dark:text-blue-400">{Math.round(p.score * 100)}% match</span>
              </div>
              <p className="text-slate-500 mt-1">“{p.complaint}” → {p.action} <span className="font-mono-tabular">({p.laborCode})</span>{p.wasOverride ? ' · technician overrode the AI' : ''}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function QueueCard({ it }: { it: Item }) {
  const { api, me, config, toast, refresh, navigate } = useStaff();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(it.draft ?? '');
  const [reason, setReason] = useState<string>(config?.rejectCodes?.[0] ?? '');
  const [busy, setBusy] = useState(false);
  const f = factsOf(it);
  const bundle = bundleOf(it);
  const can = me.can.includes('decide');
  const act = (action: string, extra: Record<string, unknown> = {}) => async () => {
    setBusy(true);
    try {
      const r = await api(`/api/opps/${it.id}/decide`, { method: 'POST', body: { action, ...extra } });
      toast(r.status === 'scheduled' ? `Approved · held for the customer's quiet hours, sends ${r.localSendAt}`
        : action === 'approve' ? 'Approved and sent' : action === 'edit' ? 'Draft saved. A second approver must approve it.' : `Opportunity ${action}ed`);
      if (action === 'edit') setEditing(false);
      refresh();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <Card as="article" className="overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-12">
        <div className="md:col-span-3 relative min-h-[150px] bg-[#0B0F17]">
          <VehicleImage make={it.make} model={it.model} className="absolute inset-0 w-full h-full object-cover" />
          <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 via-black/40 to-transparent text-white">
            <p className="text-sm font-semibold font-display">{it.year} {it.make} {it.model}</p>
            <p className="text-[11px] text-slate-300">{it.rooftop_name}</p>
          </div>
        </div>

        <div className="md:col-span-9 p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={TIER_TONE[it.tier]}>{it.tier}</Pill>
            <span className="text-sm font-semibold font-display text-slate-900 dark:text-white">{OPP_LABEL[it.type] ?? it.type}</span>
            {bundle.map((b) => <Pill key={b} tone="violet">+ {OPP_LABEL[b] ?? b}</Pill>)}
            <span className="text-xs text-slate-500 dark:text-slate-400">{it.full_name ?? 'Customer (masked)'}</span>
            <span className="ml-auto text-[11px] font-mono-tabular text-slate-400">score {Math.round(it.score)}</span>
          </div>

          <p className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
            <Lightbulb className="w-3.5 h-3.5 mt-0.5 text-amber-500 shrink-0" aria-hidden="true" /><span><strong className="font-semibold">Why now:</strong> {it.reason}</span>
          </p>
          <Facts f={f} />

          <div className="rounded-xl bg-slate-50 dark:bg-[#0A0F19] border border-slate-100 dark:border-white/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400"><MessageSquare className="w-3.5 h-3.5" />SMS the customer would receive</span>
              {it.sendPlan ? (
                <Pill tone={it.sendPlan.held ? 'amber' : 'emerald'} title="Quiet hours 08:00-21:00 customer-local hold the send; they never block approval.">
                  <Clock className="w-3 h-3" />{it.sendPlan.held ? `Customer time ${it.sendPlan.localNow} · sends ${it.sendPlan.localSendAt}` : `Customer time ${it.sendPlan.localNow} · sends now`}
                </Pill>
              ) : null}
            </div>
            {editing ? (
              <textarea aria-label="Edit draft" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} className={textarea} />
            ) : (
              <p className="max-w-xl rounded-2xl rounded-tl-sm bg-blue-600 text-white text-xs leading-relaxed px-4 py-3 whitespace-pre-wrap">{it.draft ?? '(no draft)'}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {can ? (
              editing ? (
                <>
                  <button type="button" disabled={busy} className={btn.primary} onClick={act('edit', { text: draft })}>Save draft</button>
                  <button type="button" className={btn.secondary} onClick={() => { setEditing(false); setDraft(it.draft ?? ''); }}>Cancel</button>
                  <span className="text-[11px] text-slate-500">Edits are re-checked by the guardrail and need a second approver.</span>
                </>
              ) : (
                <>
                  <button type="button" disabled={busy} className={btn.success} onClick={act('approve')}><Send className="w-3.5 h-3.5" />Approve &amp; send</button>
                  <button type="button" className={btn.secondary} onClick={() => setEditing(true)}>Edit</button>
                  <button type="button" disabled={busy} className={btn.secondary} onClick={act('snooze', { months: 3 })}>Snooze 3 mo</button>
                  <select aria-label="Reject reason" value={reason} onChange={(e) => setReason(e.target.value)}
                    className="h-8 px-2 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-[#141B29] text-xs">
                    {(config?.rejectCodes ?? []).map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
                  </select>
                  <button type="button" disabled={busy} className={btn.danger} onClick={act('reject', { reasonCode: reason })}>Reject</button>
                </>
              )
            ) : <span className="text-xs text-slate-500">Read-only role: approvals need an approver, advisor, manager or admin.</span>}
            <span className="ml-auto flex items-center gap-4">
              {it.type === 'D1' || it.type === 'D1_WINBACK' || f.milestone ? <Precedents id={it.id} /> : null}
              <button type="button" className={btn.ghost} onClick={() => navigate('customers', { customerId: it.customer_id })}><Users className="w-3.5 h-3.5" />Customer 360</button>
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function Queue() {
  const { api } = useStaff();
  const [filter, setFilter] = useState<Filter>('all');
  const { data, error } = useLoad(() => api<{ items: Item[] }>('/api/queue?status=pending_approval'));
  if (!data) return <Loading error={error} />;
  const count = (types: string[]) => data.items.filter((x) => types.includes(x.type)).length;
  const items = filter === 'all' ? data.items : data.items.filter((x) => FILTER_TYPES[filter].includes(x.type));
  return (
    <div className="space-y-5">
      <PageTitle title={`Approval queue · ${data.items.length} pending`}
        subtitle="One well-timed, consented message per customer. Each card shows the rule that fired, the facts behind it, and exactly what the customer would receive."
        right={<Segmented label="Filter by journey step" value={filter} onChange={setFilter} options={[
          { id: 'all', label: `All ${data.items.length}` },
          { id: 'service', label: `Service ${count(FILTER_TYPES.service)}` },
          { id: 'winback', label: `Win-back ${count(FILTER_TYPES.winback)}` },
          { id: 'followup', label: `Follow-up ${count(FILTER_TYPES.followup)}` },
          { id: 'offers', label: `Offers ${count(FILTER_TYPES.offers)}` },
          { id: 'review', label: `Review ${count(FILTER_TYPES.review)}` },
        ]} />} />
      {!items.length ? <Empty title="Nothing waiting for approval" note="New items appear as Tekion events arrive and journeys come due." /> : null}
      <div className={cx('space-y-4')}>{items.map((it) => <QueueCard key={it.id} it={it} />)}</div>
    </div>
  );
}
