'use client';
/** Demo controls (only when the server exposes them): time travel, simulated inbound texts, engine run, outbox. */
import { Clock, MessageSquare, RefreshCw, Send } from 'lucide-react';
import { useState } from 'react';
import { useStaff } from './context';
import { Card, CardHeader, PageTitle, btn, input } from '../ui/kit';

const PRESETS: Array<[string, number]> = [['Now', 0], ['+12 hours', 0.5], ['+30 days', 30], ['+90 days', 90], ['+6 months', 180], ['+1 year', 365]];
const REPLIES = ['STOP', 'snooze 3 months', 'I sold the car', 'my brakes failed', 'Can I book Tuesday morning?'];

export default function Dev() {
  const { api, me, config, toast, refresh } = useStaff();
  const [days, setDays] = useState(String(Math.round(((config?.clockOffsetMs as number) ?? 0) / 86_400_000)));
  const [phone, setPhone] = useState('');
  const [text, setText] = useState('');
  const [out, setOut] = useState('');
  if (!config?.devTools) return <Card className="p-6 text-xs text-slate-500">Demo controls are off. Start with DEV_TOOLS=1 and AUTH_TEST_BYPASS=1 on loopback.</Card>;
  if (!me.can.includes('dev')) return <Card className="p-6 text-xs text-slate-500">Switch to Demo Group Admin to use demo controls.</Card>;
  const call = (path: string, body: unknown, msg: string) => api(path, { method: 'POST', body })
    .then((x) => { setOut(JSON.stringify(x, null, 2)); toast(msg); refresh(); })
    .catch((e: Error) => toast(e.message, true));
  const setClock = (d: number) => { setDays(String(d)); return call('/api/dev/clock', { offsetDays: d }, `Clock set to ${d === 0 ? 'now' : `${d} days ahead`}`); };

  return (
    <div className="space-y-6">
      <PageTitle title="Demo controls" subtitle="Synthetic data only. Move time forward to watch journeys come due, simulate customer texts, and run the engine." />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-5 sm:p-6 space-y-4">
          <CardHeader title="Time travel" subtitle="Offsets the server clock for every rule, quiet hour and due date" right={<Clock className="w-4 h-4 text-slate-400" />} />
          <div className="flex flex-wrap gap-2">
            {PRESETS.map(([label, d]) => <button key={label} type="button" className={btn.secondary} onClick={() => setClock(d)}>{label}</button>)}
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="dev-days" className="text-xs text-slate-500">Custom offset (days)</label>
            <input id="dev-days" type="number" min={-730} max={730} value={days} onChange={(e) => setDays(e.target.value)} className={`${input} w-28`} />
            <button type="button" className={btn.primary} onClick={() => setClock(Number(days))}>Set clock</button>
          </div>
        </Card>
        <Card className="p-5 sm:p-6 space-y-4">
          <CardHeader title="Engine" subtitle="Drain Tekion events, re-evaluate every journey, dispatch the outbox" right={<RefreshCw className="w-4 h-4 text-slate-400" />} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn.primary} onClick={() => call('/api/dev/scan', {}, 'Engine run complete')}><RefreshCw className="w-3.5 h-3.5" />Run pump &amp; evaluate all</button>
            <button type="button" className={btn.secondary} onClick={() => call('/api/dev/dispatch', {}, 'Outbox dispatched')}><Send className="w-3.5 h-3.5" />Dispatch outbox</button>
          </div>
        </Card>
        <Card className="lg:col-span-2 p-5 sm:p-6 space-y-4">
          <CardHeader title="Simulate a customer text" subtitle="Goes through the same inbound path as SMS: STOP and safety keywords are handled by rules first" right={<MessageSquare className="w-4 h-4 text-slate-400" />} />
          <div className="flex flex-wrap items-center gap-2">
            <input type="text" placeholder="+1555010012" aria-label="Customer phone" value={phone} onChange={(e) => setPhone(e.target.value)} className={`${input} w-44`} />
            <input type="text" placeholder="Reply text" aria-label="Reply text" value={text} onChange={(e) => setText(e.target.value)} className={`${input} flex-1 min-w-[220px]`} />
            <button type="button" className={btn.primary} onClick={() => call('/api/dev/inbound', { phone, text }, 'Inbound message processed')}>Send inbound</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {REPLIES.map((r) => <button key={r} type="button" className={btn.secondary} onClick={() => setText(r)}>{r}</button>)}
          </div>
          <p className="text-[11px] text-slate-500">Seeded phones are the rooftop number followed by (customer index + 10), e.g. customer 30 → +1555010140. Find a customer's phone in Customer 360 (needs PII access).</p>
        </Card>
      </div>
      {out ? <Card className="p-5"><CardHeader title="Last result" className="mb-3" /><pre className="text-[11px] font-mono-tabular text-slate-600 dark:text-slate-300 whitespace-pre-wrap max-h-80 overflow-auto">{out}</pre></Card> : null}
    </div>
  );
}
