/**
 * Test doubles for the model vendor. Tests never touch the network: providers get a fake fetch, and the gateway gets
 * a scripted ModelProvider. The fake embedding is a hashed bag of words, so it exercises the vector-store plumbing with
 * stable, explainable similarities. It does not measure retrieval quality; a real vendor embedding does that.
 */
import type { JsonRequest, MediaPart, ModelProvider } from '../lib/server/providers.ts';

export type Scripted = unknown | Error | ((req: JsonRequest) => unknown);

export class ScriptedModel implements ModelProvider {
  readonly name: 'gemini' | 'openai';
  readonly textModel = 'fake-text';
  readonly embedModel: string;
  readonly calls: JsonRequest[] = [];
  readonly embedCalls: Array<{ texts: string[]; kind: string }> = [];
  private readonly script: Scripted[];
  private readonly dim: number;

  constructor(script: Scripted[] = [], opts: { name?: 'gemini' | 'openai'; embedModel?: string; dim?: number } = {}) {
    this.script = [...script];
    this.name = opts.name ?? 'gemini';
    this.embedModel = opts.embedModel ?? 'fake-embed';
    this.dim = opts.dim ?? 512;
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    this.calls.push(req);
    if (this.script.length === 0) throw new Error('ScriptedModel: no scripted response left');
    const next = this.script.length > 1 ? this.script.shift() : this.script[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? (next as (r: JsonRequest) => unknown)(req) : next;
  }

  async transcribe(_audio: MediaPart): Promise<string> {
    return '';
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    this.embedCalls.push({ texts, kind });
    return texts.map((t) => hashEmbed(t, this.dim));
  }
}

const STOP = new Set(['the', 'and', 'when', 'with', 'from', 'vehicle', 'customer', 'complaint', 'technician', 'diagnosis', 'repair']);

export function hashEmbed(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    const w = raw.replace(/(ing|ed|es|s)$/, '');
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
    v[h % dim] += 1;
  }
  return v;
}

export interface Captured { url: string; init: RequestInit; body: any; headers: Record<string, string> }

/** Fake fetch that records each request and replies from a queue of (status, json) pairs. */
export function fakeFetch(replies: Array<{ status?: number; json: unknown }>) {
  const seen: Captured[] = [];
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, init, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const r = replies.length > 1 ? replies.shift()! : replies[0];
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn, seen };
}
