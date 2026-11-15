'use client';
/** Hash-chained, append-only audit log with chain verification. */
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useLoad, useStaff } from './context';
import { Card, CardHeader, DataTable, Loading, PageTitle, fmtDateTime } from '../ui/kit';

export default function Audit() {
  const { api } = useStaff();
  const { data, error } = useLoad(() => Promise.all([
    api<{ items: any[] }>('/api/audit?limit=100'),
    api('/api/audit/verify').catch(() => null),
  ]));
  if (!data) return <Loading error={error} />;
  const [{ items }, v] = data;
  const ok = v?.ok;
  return (
    <div className="space-y-6">
      <PageTitle title="Audit & governance" subtitle="Every approval, send, consent change, model call and dev action is recorded append-only and hash-chained. Tampering with any row breaks the chain." />
      <Card className={`p-5 flex items-center gap-4 ${ok === false ? 'border-rose-300 dark:border-rose-900' : ''}`}>
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${ok === false ? 'bg-rose-100 dark:bg-rose-500/20 text-rose-600' : 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'}`}>
          {ok === false ? <ShieldAlert className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-white">
            {v ? (ok ? `Hash chain verified over ${v.checked} rows` : `Chain broken at seq ${v.brokenAt}`) : 'Chain check needs audit access'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">SHA-256 over each row plus the previous hash. Also available offline: npm run audit.</p>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <div className="p-5 border-b border-slate-100 dark:border-white/5"><CardHeader title="Latest 100 events" /></div>
        <DataTable head={['Seq', 'Actor', 'Action', 'Subject', 'When']}
          rows={items.map((a) => [<span key="s" className="font-mono-tabular text-slate-500">{a.seq}</span>, <span key="a" className="font-mono-tabular">{a.actor}</span>,
            <span key="c" className="font-semibold text-slate-900 dark:text-white">{a.action}</span>, <span key="x" className="font-mono-tabular text-[11px] text-slate-500 break-all">{a.subject}</span>, fmtDateTime(a.created_at)])} />
      </Card>
    </div>
  );
}
