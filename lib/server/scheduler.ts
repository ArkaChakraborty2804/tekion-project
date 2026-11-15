/**
 * Background loops (HLD 03 fallback for Temporal): event pump, outbox dispatch, periodic re-evaluation, story
 * embedding and media retention. Each loop is independent so one failure does not stop the others.
 */
import { all } from './db.ts';
import { audit } from './audit.ts';
import { clock } from './clock.ts';
import { dispatchQueued } from './channel.ts';
import { evaluateAll } from './engine.ts';
import { embedPendingStories } from './feedback.ts';
import { background } from './background.ts';
import { runPump, type Runtime } from './runtime.ts';

export function startScheduler(rt: Runtime): () => void {
  const safe = (name: string, fn: () => void) => () => {
    try { fn(); } catch (err) { console.error(`[scheduler:${name}]`, (err as Error).message); }
  };
  const timers = [
    setInterval(safe('pump', () => runPump(rt)), 2_000),
    setInterval(safe('dispatch', () => dispatchQueued(rt.db, rt.provider)), 2_000),
    setInterval(safe('evaluate', () => {
      for (const t of all<{ id: string }>(rt.db, 'SELECT id FROM tenants')) evaluateAll(rt.ctx, t.id);
    }), 60_000),
    // Embedding worker: vectorises new technician stories off the request path (no network inside handleEvent).
    setInterval(() => background('embed_stories', () => embedPendingStories(rt.db, rt.ai)), 5_000),
    setInterval(safe('retention', () => {
      const n = rt.media.purgeExpired(clock.now());
      if (n) audit(rt.db, 'system', 'system:retention', 'media.purged', 'media', { count: n });
    }), 3_600_000),
  ];
  for (const t of timers) t.unref();
  return () => { for (const t of timers) clearInterval(t); };
}
