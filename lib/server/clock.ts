/**
 * Single time source for the whole app. The dev clock offset lets demos
 * "time travel" (e.g., jump 60 days to see a warranty window). Production leaves it at 0.
 */
import { shared } from './shared.ts';

/** Shared across module copies in one process (see shared.ts), so the dev clock moves the scheduler too. */
const state = shared('clock', () => ({ offsetMs: 0 }));

export const clock = {
  now(): Date {
    return new Date(Date.now() + state.offsetMs);
  },
  iso(): string {
    return this.now().toISOString();
  },
  offsetMs(): number {
    return state.offsetMs;
  },
  setOffsetMs(ms: number): void {
    if (!Number.isFinite(ms)) throw new Error('offset must be a finite number');
    state.offsetMs = ms;
  },
  addDays(days: number): Date {
    return new Date(this.now().getTime() + days * 86_400_000);
  },
};

export const DAY_MS = 86_400_000;
export const daysBetween = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / DAY_MS;
