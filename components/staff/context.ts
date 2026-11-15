'use client';
import { createContext, useContext, useEffect, useState } from 'react';

export interface Me { id: string; name: string; role: string; rooftopIds: string[]; can: string[] }
export interface Config {
  rejectCodes: string[]; devTools: boolean; replyEnabled: boolean;
  ai: { configured: string; active: string | null; textModel: string | null; embedModel: string | null };
  [k: string]: unknown;
}

export interface ApiOpts { method?: string; body?: unknown }

export function rawApi(identity: string, path: string, { method = 'GET', body }: ApiOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (identity) headers['X-Dev-User'] = identity;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetch(path, { method, headers, body: payload });
}

/** Staff API call with the dev identity header. Throws the server's error message on non-2xx. */
export async function callApi<T = any>(identity: string, path: string, opts: ApiOpts = {}): Promise<T> {
  const res = await rawApi(identity, path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? data.errors?.join('; ') ?? `HTTP ${res.status}`);
  return data as T;
}

export interface StaffCtx {
  identity: string;
  me: Me;
  config: Config | null;
  /** Bumped on live changes and after actions; views reload when it changes. */
  version: number;
  refresh: () => void;
  toast: (msg: string, isError?: boolean) => void;
  api: <T = any>(path: string, opts?: ApiOpts) => Promise<T>;
  /** Switch section; optionally open a customer in Customer 360. */
  navigate: (tab: Tab, opts?: { customerId?: string }) => void;
  /** Customer currently opened in Customer 360 (set by navigate). */
  focusCustomerId: string | null;
}

export type Tab = 'overview' | 'queue' | 'cases' | 'customers' | 'insights' | 'rules' | 'audit' | 'dev';

export const Staff = createContext<StaffCtx | null>(null);

export function useStaff(): StaffCtx {
  const c = useContext(Staff);
  if (!c) throw new Error('useStaff outside StaffConsole');
  return c;
}

/** Loads data for a view and reloads whenever the console version or identity changes. */
export function useLoad<T>(fn: () => Promise<T>, extraDeps: unknown[] = []): { data: T | null; error: string | null } {
  const { version, identity } = useStaff();
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    fn().then(
      (data) => { if (live) setState({ data, error: null }); },
      (e: Error) => { if (live) setState((s) => ({ data: s.data, error: e.message })); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, identity, ...extraDeps]);
  return state;
}
