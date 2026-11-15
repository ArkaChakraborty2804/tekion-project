'use client';
/** Open cases, safety first: acknowledge, resolve, and view customer media (fetched with auth, shown from a blob URL). */
import { Camera, CheckCircle2, LifeBuoy, Mic, OctagonAlert, PhoneCall, Users } from 'lucide-react';
import { useState } from 'react';
import { rawApi, useLoad, useStaff } from './context';
import { Card, Empty, Loading, PageTitle, Pill, Segmented, TIER_TONE, btn, fmtDateTime, input } from '../ui/kit';

type Row = Record<string, any>;
type Filter = 'all' | 'safety' | 'customer';

function MediaButton({ m }: { m: Row }) {
  const { identity, toast } = useStaff();
  const [url, setUrl] = useState<string | null>(null);
  const open = async () => {
    const res = await rawApi(identity, `/api/media/${m.id}`).catch(() => null);
    if (!res || !res.ok) return toast('Media unavailable (needs PII access)', true);
    setUrl(URL.createObjectURL(await res.blob()));
  };
  const Icon = m.kind === 'image' ? Camera : Mic;
  return (
    <div className="space-y-2">
      <button type="button" className={btn.secondary} onClick={open}><Icon className="w-3.5 h-3.5" />Open {m.kind} · {Math.round(m.bytes / 1024)} KB</button>
      {url ? (m.kind === 'image'
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={url} alt="Customer upload" className="max-w-xs rounded-lg border border-slate-200 dark:border-white/10" />
        : <audio src={url} controls className="max-w-xs" />) : null}
    </div>
  );
}

function CaseCard({ c }: { c: Row }) {
  const { api, me, toast, refresh, navigate } = useStaff();
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const can = me.can.includes('case_ack');
  const safety = c.kind === 'safety' || c.priority === 'P1';
  const ack = () => api(`/api/cases/${c.id}/ack`, { method: 'POST' }).then(() => { toast('Acknowledged'); refresh(); }).catch((e: Error) => toast(e.message, true));
  const resolve = () => api(`/api/cases/${c.id}/resolve`, { method: 'POST', body: { resolution: note } })
    .then(() => { toast('Resolved'); refresh(); }).catch((e: Error) => toast(e.message, true));
  return (
    <Card as="article" className={safety ? 'p-5 border-rose-300 dark:border-rose-900/70' : 'p-5'}>
      <div className="flex flex-wrap items-start gap-3">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${safety ? 'bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400' : 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'}`}>
          {safety ? <OctagonAlert className="w-4 h-4" /> : <PhoneCall className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={TIER_TONE[c.priority] ?? 'slate'}>{c.priority}</Pill>
            <span className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-white">{c.kind}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">{c.full_name ?? 'Customer (masked)'}</span>
            <span className="ml-auto text-[11px] font-mono-tabular text-slate-400">{fmtDateTime(c.created_at)}</span>
          </div>
          <p className="mt-1.5 text-sm font-medium text-slate-900 dark:text-white">{c.summary}</p>
          {c.body ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap">{c.body}</p> : null}
          {c.media?.length ? <div className="mt-3 flex flex-wrap gap-3">{c.media.map((m: Row) => <MediaButton key={m.id} m={m} />)}</div> : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {can ? (
              resolving ? (
                <>
                  <input className={`${input} w-72`} placeholder="Resolution note (required)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Resolution note" />
                  <button type="button" className={btn.primary} disabled={!note.trim()} onClick={resolve}><CheckCircle2 className="w-3.5 h-3.5" />Resolve</button>
                  <button type="button" className={btn.secondary} onClick={() => setResolving(false)}>Cancel</button>
                </>
              ) : (
                <>
                  <button type="button" className={btn.secondary} onClick={ack}>Acknowledge</button>
                  <button type="button" className={btn.secondary} onClick={() => setResolving(true)}>Resolve…</button>
                </>
              )
            ) : null}
            <button type="button" className={`${btn.ghost} ml-auto`} onClick={() => navigate('customers', { customerId: c.customer_id })}><Users className="w-3.5 h-3.5" />Customer 360</button>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function Cases() {
  const { api } = useStaff();
  const [filter, setFilter] = useState<Filter>('all');
  const { data, error } = useLoad(() => api<{ items: Row[] }>('/api/cases?status=open'));
  if (!data) return <Loading error={error} />;
  const isSafety = (c: Row) => c.kind === 'safety' || c.priority === 'P1';
  const items = data.items.filter((c) => filter === 'all' || (filter === 'safety' ? isSafety(c) : !isSafety(c)));
  return (
    <div className="space-y-5">
      <PageTitle title={`Cases · ${data.items.length} open`}
        subtitle="Safety replies, recall notices and customer requests that need an advisor. A safety case always gets the fixed 'do not drive' template first; the AI can raise urgency, never lower it."
        right={<Segmented label="Filter cases" value={filter} onChange={setFilter} options={[
          { id: 'all', label: `All ${data.items.length}` },
          { id: 'safety', label: `Safety ${data.items.filter(isSafety).length}` },
          { id: 'customer', label: `Customer requests ${data.items.filter((c) => !isSafety(c)).length}` },
        ]} />} />
      {!items.length ? <Empty icon={LifeBuoy} title="No open cases" /> : items.map((c) => <CaseCard key={c.id} c={c} />)}
    </div>
  );
}
