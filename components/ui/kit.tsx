'use client';
/**
 * TekOrbit UI kit: cards, KPI tiles, pills, buttons, segmented controls and tables in one place, so every screen
 * shares the same dark executive look (slate surfaces, blue accent, display font for numbers and headings).
 */
import { AlertTriangle, Car, CheckCircle2, OctagonAlert, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

export const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

/* ---------- surfaces ---------- */

export function Card({ children = null, className = '', as: As = 'div' }: { children?: ReactNode; className?: string; as?: 'div' | 'section' | 'article' }) {
  return (
    <As className={cx('rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#0E1422] shadow-sm dark:shadow-[0_4px_20px_-2px_rgba(0,0,0,0.4)]', className)}>
      {children}
    </As>
  );
}

export function CardHeader({ title, subtitle, right, className = '' }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900 dark:text-white">{title}</h3>
        {subtitle ? <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

export function PageTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold font-display text-slate-900 dark:text-white">{title}</h2>
        {subtitle ? <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-3xl">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

/* ---------- KPI tile (OVRUN style) ---------- */

export type Tone = 'emerald' | 'blue' | 'rose' | 'amber' | 'slate' | 'violet' | 'sky';

const ICON_TONE: Record<Tone, string> = {
  emerald: 'text-emerald-500', blue: 'text-blue-500', rose: 'text-rose-500', amber: 'text-amber-500',
  slate: 'text-slate-400', violet: 'text-violet-500', sky: 'text-sky-500',
};

export function Kpi({ label, value, icon: Icon, badge, badgeTone = 'emerald', note, onClick }: {
  label: string; value: ReactNode; icon?: LucideIcon; badge?: ReactNode; badgeTone?: Tone; note?: ReactNode; onClick?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
        <span>{label}</span>
        {Icon ? <Icon className={cx('w-4 h-4', ICON_TONE[badgeTone])} aria-hidden="true" /> : null}
      </div>
      <div className="mt-2.5 flex items-baseline justify-between gap-2">
        <span className="text-2xl font-bold font-display tabular-nums text-slate-900 dark:text-white">{value}</span>
        {badge != null ? <Pill tone={badgeTone}>{badge}</Pill> : null}
      </div>
      {note ? <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2">{note}</p> : null}
    </>
  );
  const cls = 'text-left rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#0E1422] p-5 shadow-sm';
  return onClick
    ? <button type="button" onClick={onClick} className={cx(cls, 'hover:border-blue-400/50 transition-colors cursor-pointer')}>{body}</button>
    : <div className={cls}>{body}</div>;
}

/* ---------- pills and status ---------- */

const PILL_TONE: Record<Tone, string> = {
  emerald: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
  blue: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-800',
  rose: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800',
  amber: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800',
  slate: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700',
  violet: 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-300 dark:border-violet-800',
  sky: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-800',
};

export function Pill({ tone = 'slate', children, title, mono = false }: { tone?: Tone; children: ReactNode; title?: string; mono?: boolean }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap', mono && 'font-mono-tabular', PILL_TONE[tone])}>
      {children}
    </span>
  );
}

export type Severity = 'nominal' | 'warning' | 'critical';
const SEVERITY: Record<Severity, { cls: string; Icon: LucideIcon }> = {
  nominal: { cls: 'text-emerald-600 dark:text-emerald-400', Icon: CheckCircle2 },
  warning: { cls: 'text-amber-600 dark:text-amber-400', Icon: AlertTriangle },
  critical: { cls: 'text-rose-600 dark:text-rose-400', Icon: OctagonAlert },
};

export function StatusText({ severity, label, className = '' }: { severity: Severity; label: ReactNode; className?: string }) {
  const { cls, Icon } = SEVERITY[severity];
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs font-medium', cls, className)}>
      <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export const TIER_TONE: Record<string, Tone> = { P1: 'rose', P2: 'amber', P3: 'blue', P4: 'violet', P5: 'slate' };

/* ---------- buttons and inputs ---------- */

export const btn = {
  primary: 'inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors cursor-pointer whitespace-nowrap shadow-sm disabled:opacity-50 disabled:cursor-not-allowed',
  success: 'inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors cursor-pointer whitespace-nowrap shadow-sm disabled:opacity-50 disabled:cursor-not-allowed',
  secondary: 'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-white/15 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed',
  danger: 'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg border border-rose-300 dark:border-rose-800 text-xs font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50',
  ghost: 'inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer disabled:opacity-50',
};

export const input = 'h-9 px-3 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-[#141B29] text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500';
export const textarea = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-[#141B29] text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500';

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: Array<{ id: T; label: ReactNode }>; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-[#161D2B] border border-slate-200 dark:border-white/10" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={o.id === value} onClick={() => onChange(o.id)}
          className={cx('px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer',
            o.id === value ? 'bg-white dark:bg-[#0E1422] text-slate-900 dark:text-white shadow-xs' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- table ---------- */

export function DataTable({ head, rows, empty = 'Nothing to show.', align = [], onRowClick }: {
  head: string[]; rows: Array<Array<ReactNode>>; empty?: string; align?: Array<'left' | 'right'>; onRowClick?: (i: number) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b border-slate-100 dark:border-white/5 text-[11px] font-bold uppercase tracking-wider text-slate-400 bg-slate-50/60 dark:bg-white/[0.01]">
            {head.map((h, i) => <th key={h + i} scope="col" className={cx('py-3 px-4 first:pl-5 last:pr-5 whitespace-nowrap', align[i] === 'right' && 'text-right')}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-white/5 text-xs">
          {rows.length === 0 ? (
            <tr><td colSpan={head.length} className="py-8 text-center text-slate-400">{empty}</td></tr>
          ) : rows.map((r, i) => (
            <tr key={i} onClick={onRowClick ? () => onRowClick(i) : undefined}
              className={cx('hover:bg-slate-50/70 dark:hover:bg-white/[0.02] transition-colors', onRowClick && 'cursor-pointer')}>
              {r.map((v, j) => <td key={j} className={cx('py-3 px-4 first:pl-5 last:pr-5 align-top text-slate-700 dark:text-slate-300', align[j] === 'right' && 'text-right')}>{v ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- vehicle imagery ---------- */

/** Representative studio photo per body style (the seed's makes/models map onto five shots). */
export function vehicleImageFor(make: string, model: string): string {
  const m = `${make} ${model}`.toLowerCase();
  if (/tesla|model [3ysx]|mach-e|ioniq|ev\b/.test(m)) return '/cars/ev-crossover.jpg';
  if (/f-150|tacoma|tundra|ridgeline|silverado|truck|r1t/.test(m)) return '/cars/truck.jpg';
  if (/highlander|pilot|explorer|xc90|telluride|4runner/.test(m)) return '/cars/suv-large.jpg';
  if (/cr-v|rav4|escape|cx-5|tucson|rogue|crv/.test(m)) return '/cars/suv-crv.jpg';
  return '/cars/sedan-topdown.jpg';
}

export function VehicleImage({ make, model, alt, className = '' }: { make: string; model: string; alt?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const label = alt ?? `${make} ${model}`;
  if (failed) {
    return (
      <div role="img" aria-label={label} className={cx('flex flex-col items-center justify-center bg-gradient-to-br from-slate-200 to-slate-300 dark:from-[#161D2B] dark:to-[#0B0F17] text-slate-500', className)}>
        <Car className="w-8 h-8 opacity-75" aria-hidden="true" />
      </div>
    );
  }
  const src = vehicleImageFor(make, model);
  // The top-down sedan shot is letterboxed on the studio-dark background rather than cropped.
  const fit = src.includes('topdown') ? className.replace('object-cover', 'object-contain bg-[#0B0F17] p-2') : className;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={label} onError={() => setFailed(true)} className={fit} />;
}

/* ---------- misc ---------- */

export function Loading({ error }: { error: string | null }) {
  return error
    ? <Card className="p-5"><StatusText severity="critical" label={`Error: ${error}`} /></Card>
    : <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" aria-busy="true">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#0E1422] animate-pulse" />)}
      </div>;
}

export function Empty({ icon: Icon = CheckCircle2, title, note }: { icon?: LucideIcon; title: string; note?: string }) {
  return (
    <Card className="p-10 flex flex-col items-center text-center gap-2">
      <Icon className="w-8 h-8 text-emerald-500" aria-hidden="true" />
      <p className="text-sm font-semibold text-slate-900 dark:text-white">{title}</p>
      {note ? <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md">{note}</p> : null}
    </Card>
  );
}

export function KeyValues({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[11px] text-slate-500 dark:text-slate-400">{k}</dt>
          <dd className="mt-0.5 text-xs font-semibold text-slate-900 dark:text-white break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
export const pct = (x: number | null | undefined) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
export const fmtDate = (s: string | null | undefined) => (s ? s.slice(0, 10) : '—');
export const fmtDateTime = (s: string | null | undefined) => (s ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : '—');

/** Customer-facing names for opportunity types (D1-D7). */
export const OPP_LABEL: Record<string, string> = {
  D1: 'Service due', D1_WINBACK: 'Win-back offer', D2_RECALL: 'Safety recall', D2_FOLLOWUP: 'Declined-work follow-up',
  D3: 'Accessory', D4: 'Warranty ending', D5: 'Insurance renewal', D6: 'Loan maturity · trade-in', D7: 'Review request',
};
