'use client';
/** Executive overview: KPI strip, journey activity, next best action spotlight, contact-policy holds, churn snapshot. */
import { ArrowUpRight, Inbox, LifeBuoy, MessageSquare, ShieldCheck, TrendingDown } from 'lucide-react';
import { useState } from 'react';
import { useLoad, useStaff } from './context';
import { Card, CardHeader, DataTable, Kpi, Loading, OPP_LABEL, Pill, Segmented, TIER_TONE, VehicleImage, btn, cx, money } from '../ui/kit';

const HOLD_LABEL: Record<string, string> = {
  frequency_cap: 'Frequency cap (2 per 30 days)', non_responder: 'Cadence / non-responder decay', consent: 'No valid consent',
  ownership: 'Ownership unresolved or snoozed', declined_memory: 'Declined in last 12 months', guardrail: 'Draft failed guardrail',
};

function ActivityChart({ daily }: { daily: Array<{ day: string; safety: number; service: number; marketing: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10);
    return daily.find((x) => x.day === d) ?? { day: d, safety: 0, service: 0, marketing: 0 };
  });
  const max = Math.max(1, ...days.map((d) => d.safety + d.service + d.marketing));
  const total = days.reduce((a, d) => a + d.safety + d.service + d.marketing, 0);
  const active = days[hover ?? days.length - 1];
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-semibold tracking-tight font-display tabular-nums text-slate-900 dark:text-white">{total}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">customer messages in 14 days · {(total / 14).toFixed(1)}/day</span>
        </div>
        <span className="text-[11px] font-mono-tabular text-slate-500 dark:text-slate-400">
          {active.day}: {active.service} service · {active.marketing} offers · {active.safety} safety
        </span>
      </div>
      <div className="h-44 flex items-end gap-1.5" onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => {
          const sum = d.safety + d.service + d.marketing;
          return (
            <button key={d.day} type="button" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)}
              aria-label={`${d.day}: ${sum} messages`} className="flex-1 h-full flex flex-col justify-end group cursor-default">
              <div className={cx('w-full rounded-t-md overflow-hidden flex flex-col-reverse transition-opacity', hover != null && hover !== i && 'opacity-50')}
                style={{ height: `${Math.max(sum ? 6 : 2, (sum / max) * 100)}%` }}>
                <span className="block bg-blue-500" style={{ flexGrow: d.service || (sum ? 0 : 1) }} />
                <span className="block bg-violet-500" style={{ flexGrow: d.marketing }} />
                <span className="block bg-rose-500" style={{ flexGrow: d.safety }} />
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-4 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-blue-500" />Service</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-violet-500" />Offers (consented)</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-rose-500" />Safety / recall</span>
      </div>
    </div>
  );
}

export default function Overview() {
  const { api, navigate } = useStaff();
  const [mix, setMix] = useState<'tier' | 'type'>('type');
  const { data, error } = useLoad(() => Promise.all([api('/api/dashboard'), api('/api/analytics/churn'), api('/api/queue?status=pending_approval')]));
  if (!data) return <Loading error={error} />;
  const [d, churn, q] = data;
  const pending = q.items as Array<Record<string, any>>;
  const p1 = d.cases.filter((c: any) => c.priority === 'P1').reduce((a: number, c: any) => a + c.n, 0);
  const heldTotal = d.held.reduce((a: number, h: any) => a + h.n, 0);
  const top = pending.find((x) => x.tier !== 'P1') ?? pending[0];
  const groups = Object.entries(pending.reduce((acc: Record<string, number>, x) => {
    const k = mix === 'type' ? (OPP_LABEL[x.type] ?? x.type) : x.tier;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Kpi label="Awaiting approval" value={pending.length} icon={Inbox} badgeTone="blue" badge="human in the loop"
          note="Every non-templated message is approved by staff" onClick={() => navigate('queue')} />
        <Kpi label="Open P1 safety cases" value={p1} icon={LifeBuoy} badgeTone={p1 ? 'rose' : 'emerald'} badge={p1 ? 'advisor call' : 'clear'}
          note={`${d.recallOpen} open recall findings`} onClick={() => navigate('cases')} />
        <Kpi label="Messages sent · 7 days" value={d.sent7d} icon={MessageSquare} badgeTone="emerald" badge={`${d.inbound7d} replies`}
          note={`${d.optedOut} customers opted out of marketing`} />
        <Kpi label="Service revenue at risk" value={money(churn.revenueAtRisk)} icon={TrendingDown} badgeTone="rose" badge={`${churn.counts.HIGH} high risk`}
          note={`Win-backs: ${churn.winbackPipeline.pending} pending · ${churn.winbackPipeline.sent} sent`} onClick={() => navigate('insights')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <Card className="lg:col-span-7 p-5 sm:p-6">
          <CardHeader title="Journey activity" subtitle="Outbound messages per day, after bundling, consent and frequency rules" className="mb-4"
            right={<span className="text-xs font-mono-tabular text-blue-600 dark:text-blue-400 font-semibold">Live DMS feed</span>} />
          <ActivityChart daily={d.daily} />
        </Card>

        {top ? (
          <Card className="lg:col-span-5 p-5 sm:p-6 flex flex-col justify-between">
            <CardHeader title="Next best action" subtitle={`${top.rooftop_name} · ${OPP_LABEL[top.type] ?? top.type}`}
              right={<button type="button" onClick={() => navigate('queue')} className={btn.primary}><span>Review</span><ArrowUpRight className="w-3.5 h-3.5" /></button>} />
            <div className="relative mt-4 rounded-xl overflow-hidden aspect-[16/9] bg-slate-50 dark:bg-[#080C14] border border-slate-100 dark:border-white/5">
              <VehicleImage make={top.make} model={top.model} className="w-full h-full object-cover" />
              <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 via-black/40 to-transparent text-white flex items-end justify-between gap-2">
                <span className="text-sm font-semibold font-display">{top.year} {top.make} {top.model}</span>
                <Pill tone={TIER_TONE[top.tier]}>{top.tier}</Pill>
              </div>
            </div>
            <p className="mt-3 text-xs text-slate-600 dark:text-slate-300 line-clamp-2">{top.reason}</p>
            <div className="mt-3 pt-3 border-t border-slate-100 dark:border-white/5 flex items-center justify-between text-xs">
              <span className="text-slate-500 dark:text-slate-400">{top.full_name ?? 'Customer (masked)'}</span>
              <button type="button" className={btn.ghost} onClick={() => navigate('customers', { customerId: top.customer_id })}>Open Customer 360 →</button>
            </div>
          </Card>
        ) : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <Card className="lg:col-span-5 p-5 sm:p-6">
          <CardHeader title="Customer is boss" subtitle="Messages the contact policy is holding back right now" className="mb-4"
            right={<ShieldCheck className="w-4 h-4 text-emerald-500" aria-hidden="true" />} />
          <div className="flex items-baseline gap-2 mb-4">
            <span className="text-3xl font-semibold font-display tabular-nums text-slate-900 dark:text-white">{heldTotal}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">messages not sent, each with a recorded reason</span>
          </div>
          <ul className="space-y-2.5">
            {d.held.length ? d.held.map((h: { check: string; n: number }) => (
              <li key={h.check}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-slate-700 dark:text-slate-300">{HOLD_LABEL[h.check] ?? h.check}</span>
                  <span className="font-mono-tabular font-semibold text-slate-900 dark:text-white">{h.n}</span>
                </div>
                <div className="h-1.5 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: `${(h.n / Math.max(1, heldTotal)) * 100}%` }} />
                </div>
              </li>
            )) : <li className="text-xs text-slate-500">Nothing held right now.</li>}
          </ul>
        </Card>

        <Card className="lg:col-span-7 overflow-hidden">
          <div className="p-5 border-b border-slate-100 dark:border-white/5">
            <CardHeader title="Approval queue mix" subtitle="What the engine wants to say next, and why"
              right={<Segmented label="Group by" value={mix} onChange={setMix} options={[{ id: 'type', label: 'By journey step' }, { id: 'tier', label: 'By priority' }]} />} />
          </div>
          <DataTable head={[mix === 'type' ? 'Journey step' : 'Priority', 'Pending', 'Share']} align={['left', 'right', 'left']}
            rows={groups.map(([k, n]) => [
              <span key="k" className="font-semibold text-slate-900 dark:text-white">{k}</span>,
              <span key="n" className="font-mono-tabular font-semibold">{n}</span>,
              <div key="b" className="h-1.5 w-40 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden"><div className="h-full bg-blue-500" style={{ width: `${(n / Math.max(1, pending.length)) * 100}%` }} /></div>,
            ])}
            empty="Nothing waiting for approval." />
        </Card>
      </div>
    </div>
  );
}
