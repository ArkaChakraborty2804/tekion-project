'use client';
/**
 * Digital Garage (customer, TekOrbit owner hub). Capability link token in the path. Vehicle hero, OEM maintenance
 * timeline ruler, loyalty, trade-in window, recalls, problem check (describe / photo / noise) and grounded chat.
 * Every number on this page comes from records; the chat may only quote these facts.
 */
import {
  Award, Bot, Calendar, Camera, CheckCircle2, CircleDollarSign, Mic, OctagonAlert, Send, ShieldAlert, Sparkles, Square, Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { encodeWav } from './wav';
import { Card, CardHeader, Pill, StatusText, VehicleImage, btn, cx, input, textarea, type Severity, type Tone } from '../ui/kit';

const URGENCY: Record<string, { label: string; tone: Tone }> = {
  P1: { label: 'Urgent: stop and call your dealer now', tone: 'rose' },
  P2: { label: 'Book a check soon', tone: 'amber' },
  P3: { label: 'Routine: watch and monitor', tone: 'emerald' },
};
const SAFETY_TEXT = 'Do not drive this vehicle. Call your dealer now. If you are in danger, call 911.';
const MAX_SECONDS = 20;
const fmt = (n: number) => Number(n).toLocaleString('en-US');

type Passport = Record<string, any>;
type Milestone = { mileage: number; title: string; services: string[]; parts: string[]; estCost: number; criticality: string; status: string; dueInMiles: number | null; dueBy: string; actionable: boolean };
interface Triage { urgency: string; symbol: string; system?: string; sound?: string; safety: boolean; message?: string; smsSent?: boolean }
interface Bubble { who: 'you' | 'bot' | 'note' | 'alert'; text: string }

const MS_STYLE: Record<string, { label: string; text: string; dot: string }> = {
  completed: { label: 'Done', text: 'text-slate-900 dark:text-slate-200', dot: 'bg-emerald-500' },
  due: { label: 'Due', text: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  overdue: { label: 'Overdue', text: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-500' },
  upcoming: { label: 'Upcoming', text: 'text-slate-400 dark:text-slate-500', dot: 'bg-slate-400' },
};

function dueText(m: Milestone): string {
  if (m.status === 'completed') return 'Completed';
  if (m.dueInMiles == null) return `Due by ${m.dueBy}`;
  if (m.dueInMiles >= 0) return `Due in ${fmt(m.dueInMiles)} miles or by ${m.dueBy}`;
  return `${fmt(-m.dueInMiles)} miles overdue`;
}

/** Genesis-style ruler: milestones as ticks, a pin at the (estimated) odometer, details for the selected tick. */
function TimelineRuler({ p, onBook, booked }: { p: Passport; onBook: (m: Milestone) => void; booked: boolean }) {
  const ms: Milestone[] = p.roadmap.milestones;
  const odo: number = p.vehicle.odometer ?? 0;
  const next: Milestone | null = p.roadmap.next ?? ms.find((m) => m.status === 'upcoming') ?? null;
  const [sel, setSel] = useState<number>((next ?? ms[ms.length - 1])?.mileage ?? 0);
  if (!ms.length) return null;
  const max = Math.max(ms[ms.length - 1].mileage, odo) * 1.04;
  const pos = (mi: number) => `${Math.min(100, (mi / max) * 100)}%`;
  const selected = ms.find((m) => m.mileage === sel) ?? ms[0];
  const severity: Severity = next?.status === 'overdue' ? 'critical' : next?.status === 'due' ? 'warning' : 'nominal';

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-white/5">
        <div className="flex items-start gap-3">
          <div className={cx('mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0',
            severity === 'critical' ? 'bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400'
              : severity === 'warning' ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                : 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400')}>
            {severity === 'nominal' ? <CheckCircle2 className="w-4 h-4" /> : <OctagonAlert className="w-4 h-4" />}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-white">
                {severity === 'critical' ? 'Service overdue' : severity === 'warning' ? 'Maintenance due' : 'No action required'}
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                {p.roadmap.source === 'oem' ? `${p.vehicle.make} OEM schedule` : 'Generic schedule'}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {next ? <>Next: <strong className="text-slate-900 dark:text-slate-100">{next.title}</strong> · {dueText(next)}</> : 'All tabulated milestones completed.'}
            </p>
          </div>
        </div>
        {next?.actionable ? (
          <button type="button" disabled={booked} onClick={() => onBook(next)}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold tracking-wide uppercase transition-colors shrink-0 cursor-pointer shadow-sm disabled:opacity-50">
            <Calendar className="w-3.5 h-3.5" /><span>{booked ? 'Request sent' : 'Schedule service'}</span>
          </button>
        ) : null}
      </div>

      <div className="pt-6 pb-2">
        <div className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Recommended maintenance timeline</div>
        <div className="relative pt-8">
          <div className="absolute top-0 -translate-x-1/2 flex flex-col items-center pointer-events-none z-10" style={{ left: pos(odo) }}>
            <span className="font-mono-tabular text-[11px] font-bold text-slate-900 dark:text-white bg-white dark:bg-slate-800 px-2 py-0.5 rounded shadow-sm border border-slate-300 dark:border-slate-600 whitespace-nowrap">
              {fmt(odo)} mi{p.vehicle.odometerEstimated ? ' est.' : ''}
            </span>
            <span className="w-0.5 h-3.5 bg-red-700 dark:bg-red-500" />
          </div>
          <div className="relative h-2 rounded bg-slate-200 dark:bg-slate-800">
            <div className="absolute inset-y-0 left-0 rounded-l bg-[#8B263E] dark:bg-[#A8324E]" style={{ width: pos(odo) }} />
            {ms.map((m) => (
              <span key={m.mileage} className={cx('absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full ring-2 ring-white dark:ring-[#0E1422]', MS_STYLE[m.status]?.dot)} style={{ left: pos(m.mileage) }} />
            ))}
          </div>
          <div className="relative h-12 mt-2">
            {ms.map((m) => (
              <button key={m.mileage} type="button" onClick={() => setSel(m.mileage)} aria-pressed={sel === m.mileage}
                className={cx('absolute -translate-x-1/2 text-center px-1.5 py-1 rounded-md cursor-pointer transition-colors', sel === m.mileage && 'bg-slate-100 dark:bg-white/5')}
                style={{ left: pos(m.mileage) }}>
                <span className={cx('block font-mono-tabular text-[11px] font-semibold whitespace-nowrap', MS_STYLE[m.status]?.text)}>{fmt(m.mileage / 1000)}k</span>
                <span className={cx('block text-[10px] uppercase tracking-wider', sel === m.mileage ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-slate-400 dark:text-slate-600')}>{MS_STYLE[m.status]?.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-2 pt-4 border-t border-slate-100 dark:border-white/5 grid grid-cols-1 sm:grid-cols-12 gap-4 text-xs">
        <div className="sm:col-span-8">
          <p className="font-semibold text-slate-900 dark:text-white">{selected.title} <span className="font-mono-tabular font-normal text-slate-500">· {fmt(selected.mileage)} mi</span></p>
          <p className="mt-1 text-slate-600 dark:text-slate-300">{selected.services.join(' · ')}</p>
          {selected.parts.length ? <p className="mt-1 text-slate-500">Parts: {selected.parts.join(', ')}</p> : null}
          <p className={cx('mt-1 font-medium', MS_STYLE[selected.status]?.text)}>{dueText(selected)}</p>
        </div>
        <div className="sm:col-span-4 sm:text-right">
          <span className="block text-slate-500">Estimated cost</span>
          <span className="block text-lg font-semibold font-display tabular-nums text-slate-900 dark:text-white">${fmt(selected.estCost)}</span>
          {selected.actionable ? <button type="button" disabled={booked} className={cx(btn.primary, 'mt-2')} onClick={() => onBook(selected)}>{booked ? 'Request sent' : 'Book this service'}</button> : null}
        </div>
      </div>
      <p className="mt-3 text-[11px] text-slate-400">{p.roadmap.note}</p>
    </Card>
  );
}

export default function Garage({ token }: { token: string }) {
  const base = `/api/garage/${encodeURIComponent(token)}`;
  const [p, setP] = useState<Passport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bookState, setBookState] = useState('');
  const [booked, setBooked] = useState(false);
  const [note, setNote] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkState, setCheckState] = useState<{ msg: string; bad: boolean }>({ msg: '', bad: false });
  const [result, setResult] = useState<Triage | null>(null);
  const [recState, setRecState] = useState('');
  const [recording, setRecording] = useState(false);
  const [photoName, setPhotoName] = useState('');
  const [chat, setChat] = useState<Bubble[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const recorded = useRef<Blob | null>(null);
  const recorder = useRef<{ stop: () => void } | null>(null);

  const call = useCallback(async (path: string, opts: RequestInit = {}) => {
    const isBlob = opts.body instanceof Blob;
    const res = await fetch(`${base}${path}`, { ...opts, headers: opts.body && !isBlob ? { 'Content-Type': 'application/json' } : undefined }).catch(() => null);
    if (!res) throw new Error('Network error. Please try again.');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }, [base]);

  const loadPassport = useCallback(() => call('').then((x) => { setP(x); setLoadError(null); }), [call]);
  useEffect(() => { loadPassport().catch((e: Error) => setLoadError(e.message)); }, [loadPassport]);
  useEffect(() => { if (p) document.title = `My Digital Garage · ${p.vehicle.year} ${p.vehicle.make} ${p.vehicle.model}`; }, [p]);
  useEffect(() => { if (result?.urgency === 'P1') resultRef.current?.scrollIntoView({ block: 'center' }); }, [result]);

  const book = async (m: Milestone) => {
    setBookState('Sending your request…');
    try {
      await call('/book', { method: 'POST', body: JSON.stringify({ mileage: m.mileage }) });
      setBookState(`Request sent for the ${m.title}. An advisor will call you to schedule.`);
      setBooked(true);
    } catch (e) { setBookState((e as Error).message); }
  };

  const runCheck = async (send: () => Promise<{ triage: Triage }>): Promise<boolean> => {
    setChecking(true);
    setCheckState({ msg: 'Checking…', bad: false });
    try {
      const out = await send();
      setCheckState({ msg: '', bad: false });
      setResult(out.triage);
      await loadPassport().catch(() => undefined);
      return true;
    } catch (e) {
      setCheckState({ msg: (e as Error).message, bad: true });
      return false;
    } finally { setChecking(false); }
  };

  const uploadBlob = async (blob: Blob) => {
    const n = note.trim().slice(0, 500);
    const ok = await runCheck(() => call(`/media${n ? `?note=${encodeURIComponent(n)}` : ''}`, { method: 'POST', body: blob }));
    // A sent photo or recording must not be re-sent with the next check.
    if (ok) {
      if (photoRef.current) photoRef.current.value = '';
      setPhotoName('');
      recorded.current = null;
      setRecState('');
    }
  };

  const onCheck = () => {
    const f = photoRef.current?.files?.[0];
    if (f) return uploadBlob(f);
    if (recorded.current) return uploadBlob(recorded.current);
    const n = note.trim();
    if (n.length >= 3) return runCheck(() => call('/describe', { method: 'POST', body: JSON.stringify({ note: n.slice(0, 500) }) }));
    setCheckState({ msg: 'Describe the problem (at least 3 characters), or add a photo or a recording.', bad: true });
  };

  // 16-bit mono WAV encoded in the browser (OpenAI accepts wav/mp3; Gemini does not take webm).
  const onRecord = async () => {
    if (recorder.current) return recorder.current.stop();
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setRecState('Microphone permission is needed to record.'); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new AC();
    const src = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    let samples = 0;
    const cap = ac.sampleRate * MAX_SECONDS;
    proc.onaudioprocess = (e) => {
      if (samples >= cap) return;
      const d = e.inputBuffer.getChannelData(0).slice();
      chunks.push(d);
      samples += d.length;
    };
    src.connect(proc);
    proc.connect(ac.destination);
    const stop = () => {
      proc.disconnect(); src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ac.close();
      recorded.current = encodeWav(chunks, ac.sampleRate);
      recorder.current = null;
      setRecording(false);
      setRecState(`Recorded ${Math.round(samples / ac.sampleRate)} s. Tap “Check it” to send.`);
    };
    recorder.current = { stop };
    setRecording(true);
    setRecState('Recording…');
    setTimeout(() => recorder.current?.stop(), MAX_SECONDS * 1000 + 200);
  };

  const onAsk = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    setChat((c) => [...c, { who: 'you', text: q }]);
    setQuestion('');
    setAsking(true);
    try {
      const out = await call('/chat', { method: 'POST', body: JSON.stringify({ question: q }) });
      setChat((c) => [...c, { who: 'bot', text: out.answer },
        ...(out.safety ? [{ who: 'alert' as const, text: SAFETY_TEXT }] : out.escalate ? [{ who: 'note' as const, text: 'Your dealer has been notified so an advisor can follow up.' }] : [])]);
    } catch (err) {
      setChat((c) => [...c, { who: 'note', text: (err as Error).message }]);
    } finally { setAsking(false); }
  };

  if (!p) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <Card className="p-8 max-w-md text-center">
          {loadError ? <StatusText severity="critical" label={loadError} /> : <p className="text-sm text-slate-500 animate-pulse">Opening your Digital Garage…</p>}
        </Card>
      </main>
    );
  }
  const L = p.loyalty;
  const tierProgress = L.nextTier ? L.points / (L.points + L.pointsToNext) : 1;
  const next: Milestone | null = p.roadmap.next;
  const health: Severity = p.recalls.length || next?.status === 'overdue' ? 'critical' : next?.status === 'due' ? 'warning' : 'nominal';

  return (
    <div className="min-h-screen">
      <header className="h-16 px-4 sm:px-6 border-b border-slate-200 dark:border-white/10 bg-white/85 dark:bg-[#0B0F17]/90 backdrop-blur-md sticky top-0 z-30 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-display font-bold text-sm shadow-sm">T</span>
          <span className="flex flex-col min-w-0">
            <span className="text-sm font-bold tracking-tight font-display text-slate-900 dark:text-white leading-tight">My Digital Garage</span>
            <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider truncate">{p.dealer.name}</span>
          </span>
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">Hi {p.customer.firstName}</span>
      </header>

      <main id="main" className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
        <Card className="overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-12 items-stretch">
            <div className="md:col-span-5 relative min-h-[220px] bg-[#0B0F17]">
              <VehicleImage make={p.vehicle.make} model={p.vehicle.model} className="absolute inset-0 w-full h-full object-cover" />
              <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/85 via-black/40 to-transparent text-white">
                <span className="font-mono-tabular text-xs text-slate-200">VIN {p.vehicle.vin}</span>
              </div>
            </div>
            <div className="md:col-span-7 p-5 sm:p-6 flex flex-col justify-between gap-5">
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400">Owned since {p.vehicle.deliveredAt}</p>
                <h1 className="text-2xl font-semibold font-display text-slate-900 dark:text-white mt-1">{p.vehicle.year} {p.vehicle.make} {p.vehicle.model}</h1>
                <div className="mt-2">
                  <StatusText severity={health} label={p.recalls.length ? `${p.recalls.length} open recall · please book` : next?.status === 'overdue' ? 'Service overdue' : next?.status === 'due' ? 'Service due' : 'Healthy · no action required'} />
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-slate-200 dark:border-white/10">
                {[
                  ['Odometer', p.vehicle.odometer != null ? `${fmt(p.vehicle.odometer)} mi` : '—', p.vehicle.odometerEstimated ? 'estimated' : ''],
                  ['Loyalty', `${L.tier}`, `${fmt(L.points)} pts`],
                  ['Next service', next ? `${fmt(next.mileage / 1000)}k` : '—', next ? `est. $${fmt(next.estCost)}` : ''],
                  ['Warranty', p.vehicle.warrantyEnd ?? '—', p.vehicle.warrantyEnd && p.vehicle.warrantyEnd < new Date().toISOString().slice(0, 10) ? 'ended' : 'basic'],
                ].map(([k, v, sub]) => (
                  <div key={k}>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{k}</span>
                    <span className="mt-1 block text-base font-semibold font-mono-tabular text-slate-900 dark:text-white">{v}</span>
                    {sub ? <span className="block text-[11px] text-slate-400">{sub}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {p.recalls.length ? (
          <Card className="p-5 border-rose-300 dark:border-rose-900/70">
            <CardHeader title="Open safety recall" subtitle="The dealer repairs recalls at no charge" right={<ShieldAlert className="w-4 h-4 text-rose-500" />} className="mb-3" />
            <ul className="space-y-3">
              {p.recalls.map((r: any) => (
                <li key={r.campaign} className="text-xs">
                  <p className="font-semibold text-slate-900 dark:text-white">{r.campaign} · {r.component}</p>
                  <p className="text-slate-600 dark:text-slate-300 mt-0.5">{r.summary}</p>
                  <p className="text-slate-500 mt-0.5">Remedy: {r.remedy} <span className="text-slate-400">· as of {r.asOf?.slice(0, 10)}</span></p>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <TimelineRuler p={p} onBook={book} booked={booked} />
        {bookState ? <p role="status" className="text-xs font-medium text-emerald-600 dark:text-emerald-400 -mt-3">{bookState}</p> : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="p-5 sm:p-6">
            <CardHeader title="Loyalty" subtitle="Points for every visit and every month you own your car" right={<Award className="w-4 h-4 text-amber-500" />} className="mb-4" />
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-bold font-display text-slate-900 dark:text-white">{L.tier}</span>
              <span className="font-mono-tabular text-sm text-slate-500">{fmt(L.points)} pts</span>
            </div>
            <div className="mt-3 h-2 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden"><div className="h-full bg-amber-500" style={{ width: `${tierProgress * 100}%` }} /></div>
            <p className="mt-1.5 text-[11px] text-slate-500">{L.nextTier ? `${fmt(L.pointsToNext)} points to ${L.nextTier}` : 'Top tier reached'} · {L.visits} visits · {L.tenureMonths} months</p>
            <ul className="mt-4 space-y-1.5">
              {L.perks.map((x: string) => <li key={x} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />{x}</li>)}
            </ul>
          </Card>
          <Card className="p-5 sm:p-6">
            <CardHeader title="Trade-in window" subtitle="When your car is worth the most to trade" right={<CircleDollarSign className="w-4 h-4 text-emerald-500" />} className="mb-4" />
            <p className="text-2xl font-bold font-display text-slate-900 dark:text-white">{p.equityPeak.passed ? 'Now' : p.equityPeak.date}</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{p.equityPeak.passed ? 'Your best trade-in window is open: ' : `Month ${p.equityPeak.month} of ownership: `}{p.equityPeak.basis}.</p>
            <p className="mt-4 text-[11px] text-slate-400">An estimate from warranty terms and your driving rate, not a price quote.</p>
          </Card>
        </div>

        <Card className="p-5 sm:p-6">
          <CardHeader title="Something wrong?" subtitle={`Describe it, add a photo of a warning light, or record a noise. Photos up to ${p.maxUploadMb.image} MB; photos are kept 90 days and recordings 30 days.`}
            right={<Sparkles className="w-4 h-4 text-blue-500" />} className="mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            <div className="md:col-span-7 space-y-3">
              <label htmlFor="note" className="block text-xs font-medium text-slate-600 dark:text-slate-300">What are you noticing?</label>
              <textarea id="note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. grinding noise when I brake" className={textarea} />
              <div className="flex flex-wrap items-center gap-2">
                <label className={cx(btn.secondary, 'relative')}>
                  <Camera className="w-3.5 h-3.5" />{photoName || 'Add a photo'}
                  <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => setPhotoName(e.target.files?.[0]?.name ?? '')} />
                </label>
                <button type="button" className={btn.secondary} onClick={onRecord}>
                  {recording ? <Square className="w-3.5 h-3.5 text-rose-500" /> : <Mic className="w-3.5 h-3.5" />}{recording ? 'Stop recording' : `Record a noise (${MAX_SECONDS} s)`}
                </button>
                <button type="button" disabled={checking} onClick={onCheck} className={btn.primary}><Wrench className="w-3.5 h-3.5" />{checking ? 'Checking…' : 'Check it'}</button>
              </div>
              <p className={cx('text-xs', checkState.bad ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500')} aria-live="polite">{checkState.msg || recState}</p>
            </div>
            <div ref={resultRef} className="md:col-span-5" aria-live="polite">
              {result ? (
                <div className={cx('h-full rounded-xl border p-4 space-y-2', result.urgency === 'P1' ? 'border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30' : 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-[#0A0F19]')}>
                  <Pill tone={URGENCY[result.urgency]?.tone ?? 'slate'}>{result.urgency} · {URGENCY[result.urgency]?.label}</Pill>
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">{result.symbol}{result.system ? ` · ${result.system}` : ''}{result.sound && result.sound !== 'none' ? ` · sound: ${result.sound}` : ''}</p>
                  {result.safety ? <p role="alert" className="rounded-lg bg-rose-600 text-white text-xs font-bold px-3 py-2">{SAFETY_TEXT}</p> : null}
                  <p className="text-xs text-slate-600 dark:text-slate-300">{result.message}</p>
                  {result.smsSent ? <p className="text-[11px] text-slate-500">We also texted you these steps.</p> : null}
                </div>
              ) : (
                <div className="h-full rounded-xl border border-dashed border-slate-200 dark:border-white/10 p-4 flex flex-col justify-center text-xs text-slate-500">
                  <p className="font-semibold text-slate-700 dark:text-slate-300">How this works</p>
                  <p className="mt-1">A safety rule checks first. Brake, steering, fuel or fire problems always get an urgent alert and an advisor call; the AI can raise urgency, never lower it.</p>
                </div>
              )}
            </div>
          </div>
          {p.triage.length ? (
            <div className="mt-5 pt-4 border-t border-slate-100 dark:border-white/5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">Recent checks</p>
              <ul className="space-y-2">
                {p.triage.map((t: any, i: number) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
                    <Pill tone={URGENCY[t.urgency]?.tone ?? 'slate'}>{t.urgency}</Pill>
                    <span className="font-semibold text-slate-900 dark:text-white">{t.symbol}</span>
                    <span className="text-slate-500">({t.system}) · {t.at?.slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card className="p-5 sm:p-6">
          <CardHeader title="Ask about your vehicle" subtitle="Answers come only from your vehicle's records and schedule" right={<Bot className="w-4 h-4 text-blue-500" />} className="mb-4" />
          <div className="space-y-2 mb-4 max-h-80 overflow-y-auto" aria-live="polite">
            {chat.length === 0 ? (
              <div className="flex flex-wrap gap-2">
                {['When is my next service?', 'What does it cost?', 'Am I still under warranty?', 'When should I trade in?'].map((s) => (
                  <button key={s} type="button" className={btn.secondary} onClick={() => setQuestion(s)}>{s}</button>
                ))}
              </div>
            ) : chat.map((b, i) => (
              b.who === 'alert' ? <p key={i} role="alert" className="rounded-lg bg-rose-600 text-white text-xs font-bold px-3 py-2">{b.text}</p>
                : b.who === 'note' ? <p key={i} className="text-[11px] text-slate-500">{b.text}</p>
                  : <div key={i} className={cx('flex', b.who === 'you' ? 'justify-end' : 'justify-start')}>
                      <p className={cx('max-w-[85%] text-xs leading-relaxed px-4 py-2.5 rounded-2xl', b.who === 'you' ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-slate-100 dark:bg-[#161D2B] text-slate-800 dark:text-slate-100 rounded-bl-sm')}>{b.text}</p>
                    </div>
            ))}
          </div>
          <form className="flex items-center gap-2" onSubmit={onAsk}>
            <label htmlFor="question" className="sr-only">Your question</label>
            <input id="question" type="text" maxLength={500} placeholder="When is my next service?" autoComplete="off" value={question} onChange={(e) => setQuestion(e.target.value)} className={cx(input, 'flex-1 h-10')} />
            <button type="submit" disabled={asking} className={btn.primary}><Send className="w-3.5 h-3.5" />Ask</button>
          </form>
        </Card>

        <p className="text-center text-[11px] text-slate-400 pb-6">Synthetic demo · {p.dealer.name} · Reply STOP to any text to opt out</p>
      </main>
    </div>
  );
}
