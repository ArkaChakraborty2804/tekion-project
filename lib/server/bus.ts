/** Change bus for live staff updates (SSE). One emitter per process, shared across module copies (see shared.ts). */
import { EventEmitter } from 'node:events';
import { clock } from './clock.ts';
import { shared } from './shared.ts';

export interface ChangeEvent { tenantId: string; kind: string; at: string }

export const bus = shared('bus', () => {
  const e = new EventEmitter();
  e.setMaxListeners(100);
  return e;
});

export function change(tenantId: string, kind: string): void {
  bus.emit('change', { tenantId, kind, at: clock.iso() } satisfies ChangeEvent);
}
