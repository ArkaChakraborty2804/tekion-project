/**
 * Tracked background work for model calls that must not block a request (diagnosis, triage follow-ups, embeddings).
 * Errors are logged, never thrown into the request. drainBackground() lets tests, eval and shutdown wait for completion.
 */
import { shared } from './shared.ts';

const pending = shared('background', () => new Set<Promise<unknown>>());

export function background(name: string, fn: () => Promise<unknown>): void {
  const p = Promise.resolve()
    .then(fn)
    .catch((err) => console.error(`[background:${name}]`, (err as Error).message))
    .finally(() => pending.delete(p));
  pending.add(p);
}

export async function drainBackground(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
