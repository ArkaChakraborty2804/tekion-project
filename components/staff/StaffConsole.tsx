'use client';
/**
 * Staff console shell (TekOrbit design): left sidebar navigation with live counts, top bar with breadcrumb, live-sync
 * status and the safety bell, identity picker (dev identities on loopback) and theme toggle in the sidebar footer.
 */
import {
  Bell, FlaskConical, Inbox, LayoutDashboard, LifeBuoy, Menu, Moon, RefreshCw, ScrollText, SlidersHorizontal, Sun,
  TrendingDown, Users, X, type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi, Staff, type Config, type Me, type StaffCtx, type Tab } from './context';
import { btn, cx } from '../ui/kit';
import Overview from './Overview';
import Queue from './Queue';
import Cases from './Cases';
import Customers from './Customers';
import Analytics from './Analytics';
import Rules from './Rules';
import Audit from './Audit';
import Dev from './Dev';

const NAV: Array<{ id: Tab; label: string; Icon: LucideIcon; View: () => React.JSX.Element }> = [
  { id: 'overview', label: 'Executive Overview', Icon: LayoutDashboard, View: Overview },
  { id: 'queue', label: 'Approval Queue', Icon: Inbox, View: Queue },
  { id: 'cases', label: 'Cases & Safety', Icon: LifeBuoy, View: Cases },
  { id: 'customers', label: 'Customer 360', Icon: Users, View: Customers },
  { id: 'insights', label: 'Churn & Closed Loop', Icon: TrendingDown, View: Analytics },
  { id: 'rules', label: 'Journey Rules', Icon: SlidersHorizontal, View: Rules },
  { id: 'audit', label: 'Audit & Governance', Icon: ScrollText, View: Audit },
  { id: 'dev', label: 'Demo Controls', Icon: FlaskConical, View: Dev },
];
/** These views hold user input; background changes must not reload them. */
const INPUT_TABS: Tab[] = ['customers', 'rules', 'dev'];

interface Counts { pending: number; p1: number }

export default function StaffConsole() {
  const [users, setUsers] = useState<Array<{ sub: string; name: string; role: string }> | null>(null);
  const [devOff, setDevOff] = useState(false);
  const [identity, setIdentity] = useState('');
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [live, setLive] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [authError, setAuthError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [focusCustomerId, setFocusCustomerId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [counts, setCounts] = useState<Counts>({ pending: 0, p1: 0 });
  const [dark, setDark] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ msg: string; err: boolean; show: boolean }>({ msg: '', err: false, show: false });
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);

  const toast = useCallback((msg: string, isError = false) => {
    setToastMsg({ msg, err: isError, show: true });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg((t) => ({ ...t, show: false })), 4000);
  }, []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const navigate = useCallback((t: Tab, opts?: { customerId?: string }) => {
    if (opts?.customerId) setFocusCustomerId(opts.customerId);
    setTab(t);
    setNavOpen(false);
    setVersion((v) => v + 1);
    if (typeof window !== 'undefined' && window.location.hash !== `#${t}`) window.history.replaceState(null, '', `#${t}`);
  }, []);

  // Deep links: /#queue, /#customers, ... (also handy for a scripted demo).
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1) as Tab;
      if (NAV.some((n) => n.id === h)) setTab(h);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  // Theme: dark by default, remembered per browser.
  useEffect(() => {
    const saved = localStorage.getItem('theme');
    if (saved) setDark(saved === 'dark');
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  // Boot: server reachability, then the dev identity list (absent unless DEV_TOOLS=1 on loopback).
  useEffect(() => {
    (async () => {
      const ok = await fetch('/healthz').then((r) => r.ok).catch(() => false);
      if (!ok) { setLive('offline'); return; }
      const u = await fetch('/api/dev/users').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!u) { setDevOff(true); return; }
      setUsers(u.users);
      setIdentity(localStorage.getItem('identity') || u.users.find((x: { role: string }) => x.role === 'group_admin')?.sub || u.users[0]?.sub || '');
    })();
  }, []);

  // Identity change: load principal and config.
  useEffect(() => {
    if (!identity) return;
    localStorage.setItem('identity', identity);
    (async () => {
      try {
        const m = await callApi<Me>(identity, '/api/me');
        setConfig(await callApi<Config>(identity, '/api/config'));
        setMe(m);
        setAuthError(null);
      } catch (e) {
        setMe(null);
        setAuthError((e as Error).message);
      }
    })();
  }, [identity]);

  // Sidebar counts (pending approvals, open P1 cases), refreshed with every change.
  useEffect(() => {
    if (!me) return;
    callApi(identity, '/api/dashboard').then((d) => setCounts({
      pending: d.queue.find((q: { status: string }) => q.status === 'pending_approval')?.n ?? 0,
      p1: d.cases.filter((c: { priority: string }) => c.priority === 'P1').reduce((a: number, c: { n: number }) => a + c.n, 0),
    })).catch(() => undefined);
  }, [identity, me, version]);

  // Live updates: SSE over fetch (not EventSource) so the same auth header is sent as on every other call.
  useEffect(() => {
    if (!identity) return;
    const ctrl = new AbortController();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const res = await fetch('/api/stream', { headers: { 'X-Dev-User': identity }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        setLive('live');
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (frame.startsWith('event: change') && !INPUT_TABS.includes(tabRef.current)) {
              clearTimeout(debounce);
              debounce = setTimeout(refresh, 400);
            }
          }
        }
      } catch {
        if (ctrl.signal.aborted) return;
      }
      setLive('offline');
      if (!ctrl.signal.aborted) retry = setTimeout(connect, 3000);
    };
    void connect();
    return () => { ctrl.abort(); clearTimeout(debounce); clearTimeout(retry); };
  }, [identity, refresh]);

  const ctx = useMemo<StaffCtx | null>(() => (me ? {
    identity, me, config, version, refresh, toast, navigate, focusCustomerId,
    api: (path, opts) => callApi(identity, path, opts),
  } : null), [identity, me, config, version, refresh, toast, navigate, focusCustomerId]);

  const nav = NAV.filter((n) => n.id !== 'dev' || config?.devTools);
  const current = NAV.find((n) => n.id === tab) ?? NAV[0];
  const View = current.View;
  const user = users?.find((u) => u.sub === identity);

  const scan = async () => {
    try {
      const r = await callApi(identity, '/api/dev/scan', { method: 'POST', body: {} });
      toast(`Engine run: ${r.evaluated} ownerships evaluated, ${r.pumped.processed} events processed`);
      refresh();
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div className="min-h-screen flex">
      {navOpen ? <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden="true" /> : null}

      <aside className={cx('fixed inset-y-0 left-0 z-50 w-64 bg-white dark:bg-[#0B0F17] border-r border-slate-200 dark:border-white/10 flex flex-col justify-between transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
        navOpen ? 'translate-x-0' : '-translate-x-full')}>
        <div>
          <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200 dark:border-white/10">
            <button type="button" onClick={() => navigate('overview')} className="flex items-center gap-2.5 whitespace-nowrap cursor-pointer">
              <span className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-display font-bold text-sm shadow-sm">T</span>
              <span className="flex flex-col text-left">
                <span className="text-sm font-bold tracking-tight font-display text-slate-900 dark:text-white leading-tight">TekOrbit</span>
                <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Loyalty Orchestrator</span>
              </span>
            </button>
            <button type="button" onClick={() => setNavOpen(false)} className="lg:hidden w-10 h-10 flex items-center justify-center rounded-lg text-slate-500" aria-label="Close navigation">
              <X className="w-4 h-4" />
            </button>
          </div>

          <nav className="p-3 space-y-1" aria-label="Sections">
            {nav.map(({ id, label, Icon }) => {
              const active = tab === id;
              const badge = id === 'queue' ? counts.pending : id === 'cases' ? counts.p1 : 0;
              return (
                <button key={id} type="button" aria-current={active ? 'page' : undefined} onClick={() => navigate(id)}
                  className={cx('w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap',
                    active ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-l-2 border-blue-600'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-white')}>
                  <span className="flex items-center gap-3"><Icon className="w-4 h-4 shrink-0" aria-hidden="true" /><span>{label}</span></span>
                  {badge > 0 ? (
                    <span className={cx('font-mono-tabular text-xs font-semibold', id === 'cases' ? 'text-rose-600 dark:text-rose-400' : 'text-blue-600 dark:text-blue-400')}>{badge}</span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-white/10 space-y-3">
          <div>
            <label htmlFor="identity" className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1.5">Signed in as</label>
            <select id="identity" disabled={!users} value={identity} onChange={(e) => setIdentity(e.target.value)}
              className="w-full h-9 px-2.5 rounded-lg border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-[#141B29] text-xs font-medium text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer">
              {(users ?? []).map((u) => <option key={u.sub} value={u.sub}>{u.name}</option>)}
            </select>
            <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">
              {devOff ? 'Dev identities off. Staff sign-in needs OIDC (docs/SECURITY.md).'
                : me ? `${me.role.replace('_', ' ')} · ${me.rooftopIds.includes('*') ? 'all rooftops' : `${me.rooftopIds.length} rooftop(s)`}` : authError ?? 'Demo identities · synthetic data'}
            </p>
          </div>
          <button type="button" onClick={() => setDark((d) => !d)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors cursor-pointer">
            <span>{dark ? 'Dark theme' : 'Light theme'}</span>
            {dark ? <Moon className="w-3.5 h-3.5 text-blue-500" aria-hidden="true" /> : <Sun className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />}
          </button>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 px-4 sm:px-6 border-b border-slate-200 dark:border-white/10 bg-white/85 dark:bg-[#0B0F17]/90 backdrop-blur-md sticky top-0 z-30 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button type="button" onClick={() => setNavOpen(true)} className="lg:hidden w-10 h-10 flex items-center justify-center rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5" aria-label="Open navigation">
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-500 dark:text-slate-400 hidden sm:inline whitespace-nowrap">{user?.name ?? 'Staff'}</span>
              <span className="text-slate-400 hidden sm:inline" aria-hidden="true">/</span>
              <h1 className="font-semibold font-display text-slate-900 dark:text-white truncate">{current.label}</h1>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden xl:inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-white/10">
              <span className={cx('w-1.5 h-1.5 rounded-full', live === 'live' ? 'bg-emerald-500 animate-pulse' : live === 'connecting' ? 'bg-amber-500' : 'bg-rose-500')} />
              {live === 'live' ? 'Live · Tekion events streaming' : live === 'connecting' ? 'Connecting…' : 'Offline'}
              {config?.ai?.active ? <span className="text-slate-400">· AI {config.ai.active} {config.ai.textModel}</span> : <span className="text-slate-400">· AI off (rules only)</span>}
            </span>
            <button type="button" onClick={() => navigate('cases')} aria-label={`Open cases (${counts.p1} open P1)`}
              className="relative w-10 h-10 flex items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors cursor-pointer">
              <Bell className="w-4 h-4" />
              {counts.p1 > 0 ? (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white font-mono-tabular text-[10px] font-semibold flex items-center justify-center">{counts.p1}</span>
              ) : null}
            </button>
            {config?.devTools && me?.can.includes('dev') ? (
              <button type="button" onClick={scan} className={btn.primary}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /><span>Run engine</span></button>
            ) : null}
          </div>
        </header>

        <main id="main" tabIndex={-1} className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {ctx ? <Staff.Provider value={ctx}><View /></Staff.Provider>
            : <p className="text-sm text-slate-500">{authError ? `Sign-in failed: ${authError}` : 'Choose an identity to continue.'}</p>}
        </main>
      </div>

      <div role="status" aria-live="polite"
        className={cx('fixed right-4 bottom-4 z-50 max-w-sm px-4 py-3 rounded-xl text-xs font-medium shadow-lg transition-opacity',
          toastMsg.err ? 'bg-rose-600 text-white' : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900',
          toastMsg.show ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
        {toastMsg.msg}
      </div>
    </div>
  );
}
