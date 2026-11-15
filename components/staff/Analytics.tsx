'use client';
/** Churn & win-back (RFM-D risk, revenue at risk) and closed-loop AI accuracy against technician outcomes. */
import { Brain, DollarSign, Gift, TrendingDown, Users, Wrench } from 'lucide-react';
import { useLoad, useStaff } from './context';
import { Card, CardHeader, DataTable, Kpi, Loading, PageTitle, Pill, money, pct, type Tone } from '../ui/kit';

const TIER: Record<string, { tone: Tone; bar: string }> = {
  HIGH: { tone: 'rose', bar: 'bg-rose-500' }, MEDIUM: { tone: 'amber', bar: 'bg-amber-500' }, LOW: { tone: 'emerald', bar: 'bg-emerald-500' },
};

export default function Analytics() {
  const { api, navigate } = useStaff();
  const { data, error } = useLoad(() => Promise.all([api('/api/analytics/churn'), api('/api/analytics/accuracy')]));
  if (!data) return <Loading error={error} />;
  const [c, a] = data;
  const total = c.counts.LOW + c.counts.MEDIUM + c.counts.HIGH || 1;

  return (
    <div className="space-y-6">
      <PageTitle title="Churn & closed loop"
        subtitle="Which owners are drifting to independent garages, what that costs, and how often the AI's diagnostic guess matched what the technician actually found." />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Kpi label="Service revenue at risk (12 mo)" value={money(c.revenueAtRisk)} icon={DollarSign} badgeTone="rose" badge="score × OEM value" note="Expected service spend weighted by churn risk" />
        <Kpi label="High-risk owners" value={c.counts.HIGH} icon={TrendingDown} badgeTone="rose" badge={`${Math.round((c.counts.HIGH / total) * 100)}% of fleet`} note={`${c.counts.MEDIUM} medium · ${c.counts.LOW} low`} />
        <Kpi label="Win-back pipeline" value={c.winbackPipeline.pending + c.winbackPipeline.sent} icon={Gift} badgeTone="violet" badge={`${c.winbackPipeline.sent} sent`}
          note={`${c.winbackPipeline.pending} awaiting approval · $40 voucher, never auto-sent`} onClick={() => navigate('queue')} />
        <Kpi label="AI diagnostic accuracy" value={pct(a.accuracy)} icon={Brain} badgeTone={a.accuracy != null && a.accuracy >= 0.8 ? 'emerald' : 'amber'} badge={`${a.overridden} overrides learned`}
          note={`${a.withPrediction} predictions scored against closed ROs`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <Card className="lg:col-span-4 p-5 sm:p-6">
          <CardHeader title="Risk distribution" subtitle="RFM-D score: recency, declined work, CSAT, warranty cliff" className="mb-5" />
          <div className="space-y-4">
            {(['HIGH', 'MEDIUM', 'LOW'] as const).map((t) => (
              <div key={t}>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <Pill tone={TIER[t].tone}>{t}</Pill>
                  <span className="font-mono-tabular font-semibold text-slate-900 dark:text-white">{c.counts[t]} owners</span>
                </div>
                <div className="h-2 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden" role="img" aria-label={`${t}: ${c.counts[t]} of ${total}`}>
                  <div className={`h-full ${TIER[t].bar}`} style={{ width: `${(c.counts[t] / total) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-5 text-[11px] text-slate-500 dark:text-slate-400">Every point of score has a named driver shown to staff. Weights are hand-set, not trained; HIGH owners get a win-back draft for approval.</p>
        </Card>

        <Card className="lg:col-span-8 overflow-hidden">
          <div className="p-5 border-b border-slate-100 dark:border-white/5">
            <CardHeader title="Highest-risk owners" subtitle="Ranked by score, then by service value at risk" right={<Users className="w-4 h-4 text-slate-400" />} />
          </div>
          <DataTable head={['Owner', 'Vehicle', 'Risk', 'Value at risk', 'Why']} align={['left', 'left', 'left', 'right', 'left']}
            onRowClick={(i) => navigate('customers', { customerId: c.top[i].customerId })}
            rows={c.top.map((r: any) => [
              <span key="n" className="font-semibold text-slate-900 dark:text-white">{r.customer ?? 'Masked'}</span>,
              r.vehicle,
              <Pill key="t" tone={TIER[r.tier].tone} mono>{r.tier} {r.score.toFixed(2)}</Pill>,
              <span key="v" className="font-mono-tabular font-semibold">{money(r.valueAtRisk)}</span>,
              <span key="d" className="block max-w-sm text-slate-500 dark:text-slate-400">{r.drivers.join(' · ')}</span>,
            ])} />
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <Card className="lg:col-span-4 p-5 sm:p-6">
          <CardHeader title="Closed-loop learning" subtitle="Technician stories from closed repair orders" className="mb-4" right={<Wrench className="w-4 h-4 text-slate-400" />} />
          <dl className="grid grid-cols-2 gap-4 text-xs">
            {[['Technician stories', a.stories], ['Predictions scored', a.withPrediction], ['Confirmed', a.confirmed], ['Overridden', a.overridden],
              ['Embeddings pending', a.pendingEmbed], ['Embeddings failed', a.failedEmbed]].map(([k, v]) => (
              <div key={k as string}><dt className="text-slate-500 dark:text-slate-400">{k}</dt><dd className="mt-1 text-lg font-semibold font-display tabular-nums text-slate-900 dark:text-white">{v}</dd></div>
            ))}
          </dl>
          <div className="mt-5 space-y-2">
            {Object.entries(a.bySource as Record<string, { n: number; confirmed: number }>).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-xs">
                <span className="text-slate-600 dark:text-slate-300">Source: {k}</span>
                <span className="font-mono-tabular">{v.confirmed}/{v.n} · {pct(v.n ? v.confirmed / v.n : null)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="lg:col-span-8 overflow-hidden">
          <div className="p-5 border-b border-slate-100 dark:border-white/5">
            <CardHeader title="Recent technician overrides" subtitle="Where the AI guessed wrong. These become precedents for the next similar complaint." />
          </div>
          <DataTable head={['Date', 'Model', 'Complaint', 'AI predicted', 'Technician found', 'Labor']}
            rows={a.recentOverrides.map((o: any) => [o.date, o.model, o.complaint, <span key="p" className="text-rose-600 dark:text-rose-400">{o.predicted}</span>,
              <span key="a" className="text-emerald-600 dark:text-emerald-400 font-semibold">{o.actual}</span>, <span key="l" className="font-mono-tabular">{o.laborCode}</span>])}
            empty="No overrides yet." />
        </Card>
      </div>
    </div>
  );
}
