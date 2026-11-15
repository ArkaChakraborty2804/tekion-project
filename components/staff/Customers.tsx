'use client';
/** Customer search and Customer 360 (Digital Garage hero, ownership metrics, journey records, customer links). */
import { ExternalLink, Link2, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useStaff } from './context';
import { Card, DataTable, OPP_LABEL, PageTitle, Pill, Segmented, TIER_TONE, VehicleImage, btn, fmtDate, fmtDateTime, input, type Tone } from '../ui/kit';

type Row = Record<string, any>;
type Tab = 'journey' | 'messages' | 'consents' | 'cases';

const STATE_TONE: Record<string, Tone> = { active: 'emerald', snoozed: 'amber', dormant: 'slate', possibly_sold: 'rose', sold: 'slate', closed: 'slate' };
const STATUS_TONE: Record<string, Tone> = { sent: 'emerald', pending_approval: 'blue', candidate: 'slate', rejected: 'rose', expired: 'slate' };

function Customer360({ id }: { id: string }) {
  const { api, toast } = useStaff();
  const [d, setD] = useState<Row | null>(null);
  const [tab, setTab] = useState<Tab>('journey');
  const [links, setLinks] = useState<{ url: string; garageUrl: string; expiresAt: string } | null>(null);
  const load = useCallback(() => api(`/api/customers/${id}`).then(setD).catch((e: Error) => toast(e.message, true)), [api, id, toast]);
  useEffect(() => { setLinks(null); void load(); }, [load]);
  if (!d) return <Card className="p-6 animate-pulse h-64" />;

  const own = d.ownerships[0];
  const createLink = async () => {
    try {
      setLinks(await api(`/api/customers/${id}/reply-link`, { method: 'POST' }));
      toast('Customer link created. It expires in 72 hours and is shown once.');
    } catch (e) { toast((e as Error).message, true); }
  };
  const setState = async (action: 'confirm_sold' | 'still_owned') => {
    const o = d.ownerships.find((x: Row) => x.state === 'possibly_sold');
    if (!o) return;
    try { await api(`/api/ownerships/${o.id}/state`, { method: 'POST', body: { action } }); toast(action === 'confirm_sold' ? 'Marked sold' : 'Ownership confirmed'); void load(); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-12 items-stretch">
          <div className="lg:col-span-5 relative min-h-[220px] bg-[#0B0F17]">
            {own ? <VehicleImage make={own.make} model={own.model} className="absolute inset-0 w-full h-full object-cover" /> : null}
            {own ? (
              <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/85 via-black/40 to-transparent text-white flex items-center justify-between">
                <span className="font-mono-tabular text-xs text-slate-200">VIN {own.vin}</span>
                <Pill tone={STATE_TONE[own.state] ?? 'slate'}>{own.state.replace('_', ' ')}</Pill>
              </div>
            ) : null}
          </div>
          <div className="lg:col-span-7 p-5 sm:p-6 flex flex-col justify-between gap-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400">{d.customer.party_id} · {d.customer.language === 'es' ? 'Spanish' : 'English'} · {d.customer.tz}</p>
                <h2 className="text-2xl font-semibold font-display text-slate-900 dark:text-white mt-1">{d.customer.full_name ?? 'Customer (masked)'}</h2>
                {own ? <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{own.year} {own.make} {own.model}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {d.ownerships.some((x: Row) => x.state === 'possibly_sold') ? (
                  <>
                    <button type="button" className={btn.secondary} onClick={() => setState('still_owned')}>Still owned</button>
                    <button type="button" className={btn.danger} onClick={() => setState('confirm_sold')}>Confirm sold</button>
                  </>
                ) : null}
                <button type="button" className={btn.primary} onClick={createLink}><Link2 className="w-3.5 h-3.5" />Create customer link</button>
              </div>
            </div>
            {links ? (
              <div className="rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 p-3 flex flex-wrap items-center gap-3 text-xs">
                <a href={links.garageUrl} target="_blank" rel="noreferrer" className={btn.primary}><ExternalLink className="w-3.5 h-3.5" />Open Digital Garage</a>
                <a href={links.url} target="_blank" rel="noreferrer" className={btn.secondary}><ExternalLink className="w-3.5 h-3.5" />Open reply page</a>
                <span className="text-slate-500">Capability link · expires {fmtDateTime(links.expiresAt)}</span>
              </div>
            ) : null}
            {own ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-slate-200 dark:border-white/10">
                {[
                  ['Odometer (last reading)', own.odometer != null ? `${Number(own.odometer).toLocaleString()} mi` : '—'],
                  ['Owner since', fmtDate(own.started_at)],
                  ['Last service', fmtDate(own.last_service_at)],
                  ['Unanswered messages', String(own.unanswered_count)],
                  ['Warranty ends', fmtDate(own.warranty_end_date)],
                  ['Loan matures', fmtDate(own.loan_end_date)],
                  ['Insurance renews', fmtDate(own.insurance_renewal_date)],
                  ['Last CSAT', own.last_ro_csat != null ? `${own.last_ro_csat} / 5` : '—'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{k}</span>
                    <span className="mt-1 block text-sm font-semibold font-mono-tabular text-slate-900 dark:text-white">{v}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="px-5 sm:px-6 border-t border-slate-200 dark:border-white/10 flex items-center gap-6 overflow-x-auto">
          {([['journey', `Journey (${d.opportunities.length})`], ['messages', `Messages (${d.messages.length})`], ['consents', `Consents (${d.consents.length})`], ['cases', `Cases (${d.cases.length})`]] as Array<[Tab, string]>).map(([t, label]) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`py-3.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer ${tab === t ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}`}>
              {label}
            </button>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden">
        {tab === 'journey' ? (
          <DataTable head={['When', 'Journey step', 'Tier', 'Status', 'Reason']}
            rows={d.opportunities.map((o: Row) => [fmtDate(o.created_at), <span key="t" className="font-semibold text-slate-900 dark:text-white">{OPP_LABEL[o.type] ?? o.type}</span>,
              <Pill key="p" tone={TIER_TONE[o.tier]}>{o.tier}</Pill>, <Pill key="s" tone={STATUS_TONE[o.status] ?? 'slate'}>{o.status.replace('_', ' ')}</Pill>, o.reason])} empty="No journey steps yet." />
        ) : tab === 'messages' ? (
          <DataTable head={['When', 'Direction', 'Purpose', 'Status', 'Body']}
            rows={d.messages.map((m: Row) => [fmtDateTime(m.created_at), m.direction === 'out' ? 'Outbound' : 'Inbound', m.purpose,
              <Pill key="s" tone={m.status === 'sent' ? 'emerald' : m.status === 'queued' ? 'amber' : 'slate'}>{m.status === 'queued' && m.send_after ? `scheduled ${fmtDateTime(m.send_after)}` : m.status}</Pill>,
              <span key="b" className="block max-w-xl">{m.body}</span>])} empty="No messages." />
        ) : tab === 'consents' ? (
          <DataTable head={['Purpose', 'Type', 'Source', 'Captured']}
            rows={d.consents.map((c: Row) => [c.purpose, <Pill key="c" tone={c.consent_type === 'granted' ? 'emerald' : 'rose'}>{c.consent_type}</Pill>, c.source, fmtDateTime(c.captured_at)])} empty="No consent records (sends fail closed)." />
        ) : (
          <DataTable head={['Opened', 'Kind', 'Priority', 'Status', 'Summary']}
            rows={d.cases.map((c: Row) => [fmtDateTime(c.created_at), c.kind, <Pill key="p" tone={TIER_TONE[c.priority] ?? 'slate'}>{c.priority}</Pill>, c.status, c.summary])} empty="No cases." />
        )}
      </Card>
    </div>
  );
}

export default function Customers() {
  const { api, toast, focusCustomerId } = useStaff();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(focusCustomerId);
  const [scope, setScope] = useState<'all' | 'es'>('all');
  const go = useCallback(async (term: string) => {
    try {
      const list = (await api<{ items: Row[] }>(`/api/customers?q=${encodeURIComponent(term)}`)).items;
      setItems(list);
      setSelected((cur) => cur ?? list[0]?.id ?? null);
    }
    catch (e) { toast((e as Error).message, true); }
  }, [api, toast]);
  useEffect(() => { void go(''); }, [go]);
  useEffect(() => { if (focusCustomerId) setSelected(focusCustomerId); }, [focusCustomerId]);
  const shown = items.filter((c) => scope === 'all' || c.language === 'es');

  return (
    <div className="space-y-6">
      <PageTitle title="Customer 360" subtitle="One ownership journey per vehicle and owner. Analysts see masked names, phones and message bodies." />
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <Card className="xl:col-span-4 overflow-hidden">
          <div className="p-4 border-b border-slate-100 dark:border-white/5 space-y-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(q); }}
                placeholder="Search name or party id (P-0003)…" aria-label="Search customers" className={`${input} w-full pl-8`} />
            </div>
            <Segmented label="Language" value={scope} onChange={setScope} options={[{ id: 'all', label: `All ${items.length}` }, { id: 'es', label: 'Spanish' }]} />
          </div>
          <ul className="max-h-[640px] overflow-y-auto divide-y divide-slate-100 dark:divide-white/5">
            {shown.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setSelected(c.id)} aria-current={selected === c.id ? 'true' : undefined}
                  className={`w-full text-left px-4 py-3 text-xs transition-colors cursor-pointer ${selected === c.id ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'}`}>
                  <span className="block font-semibold text-slate-900 dark:text-white">{c.full_name ?? 'Customer (masked)'}</span>
                  <span className="block text-[11px] font-mono-tabular text-slate-500">{c.party_id} · {c.language}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <div className="xl:col-span-8">
          {selected ? <Customer360 id={selected} /> : <Card className="p-10 text-center text-xs text-slate-500">Select a customer to open their 360.</Card>}
        </div>
      </div>
    </div>
  );
}
