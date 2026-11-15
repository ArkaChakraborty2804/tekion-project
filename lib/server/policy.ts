/**
 * Contact-policy gate (HLD 01 §4). Pure function: no I/O, so it is directly testable.
 * Checks run in a fixed order; the first failure suppresses the message and returns its reason.
 * Order: consent -> ownership state -> frequency cap -> declined memory -> non-responder decay.
 * P1 (safety) skips the cap, decline and decay checks.
 *
 * Quiet hours are not a reason to suppress: they decide *when* an approved message goes out. Service and marketing
 * messages approved outside 08:00-21:00 recipient-local time are scheduled for the next allowed window
 * (nextSendWindow), so staff can work the queue at any hour and the customer is still never texted at night.
 * Safety messages are not held (their legal basis outside quiet hours is [O] in the HLD).
 */

export type Purpose = 'service' | 'safety_recall' | `marketing:${string}`;
export type Tier = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

export interface PolicyInput {
  purpose: Purpose;
  tier: Tier;
  oppType: string;
  now: Date;
  /** latest consent_type per purpose for this customer, e.g. { service: 'granted', marketing: 'revoked' } */
  consent: Partial<Record<'service' | 'safety_recall' | 'marketing', 'granted' | 'revoked'>>;
  ownershipState: 'active' | 'snoozed' | 'possibly_sold' | 'sold' | 'dormant' | 'closed';
  snoozeUntil?: Date | null;
  /** non-safety messages to this customer across the tenant in the last 30 days */
  nonSafetySends30d: number;
  /** most recent non-safety send to this customer, any dealer in the group */
  lastNonSafetySendAt?: Date | null;
  unansweredCount: number;
  /** opportunity types declined within the memory window */
  declinedTypes: Set<string>;
}

export type PolicyResult = { allowed: true } | { allowed: false; check: string; reason: string };

export const FREQUENCY_CAP = 2;
export const MIN_GAP_DAYS = 14;
export const MIN_GAP_DAYS_NON_RESPONDER = 28;

const deny = (check: string, reason: string): PolicyResult => ({ allowed: false, check, reason });

/** Local hour (0-23) in an IANA time zone. */
export function localHour(date: Date, tz: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(date);
  return Number(h) % 24;
}

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const isSafety = input.purpose === 'safety_recall' || input.tier === 'P1';
  const isMarketing = input.purpose.startsWith('marketing:');

  // 1. Consent (fail closed). Safety needs any granted consent on record.
  if (input.purpose === 'safety_recall') {
    const granted = input.consent.safety_recall === 'granted' || input.consent.service === 'granted';
    if (!granted) return deny('consent', 'no granted consent for safety/recall messaging');
  } else if (input.purpose === 'service') {
    if (input.consent.service !== 'granted') return deny('consent', 'no granted service consent');
  } else if (isMarketing) {
    if (input.consent.marketing !== 'granted') return deny('consent', 'marketing consent not granted (or revoked)');
  }

  // 2. Ownership state. Possibly-sold blocks service and offers until resolved.
  if (input.ownershipState === 'possibly_sold' && !isSafety) return deny('ownership', 'ownership possibly sold; resolve first');
  if ((input.ownershipState === 'sold' || input.ownershipState === 'closed') && !isSafety) return deny('ownership', 'ownership ended');
  if (input.ownershipState === 'snoozed' && input.snoozeUntil && input.now < input.snoozeUntil && !isSafety) {
    return deny('ownership', `snoozed until ${input.snoozeUntil.toISOString().slice(0, 10)}`);
  }


  if (!isSafety) {
    // 4. Frequency cap, group-wide.
    if (input.nonSafetySends30d >= FREQUENCY_CAP) return deny('frequency_cap', `cap of ${FREQUENCY_CAP} non-safety messages per 30 days reached`);

    // 5. Declined-offer memory.
    if (input.declinedTypes.has(input.oppType)) return deny('declined_memory', `${input.oppType} declined within 12 months`);

    // 6. Non-responder decay.
    if (input.unansweredCount >= 6) return deny('non_responder', 'six unanswered messages; only P1 and due items until customer replies');
    if (input.lastNonSafetySendAt) {
      const gapDays = (input.now.getTime() - input.lastNonSafetySendAt.getTime()) / 86_400_000;
      const minGap = input.unansweredCount >= 3 ? MIN_GAP_DAYS_NON_RESPONDER : MIN_GAP_DAYS;
      if (gapDays < minGap) return deny('non_responder', `cadence: ${Math.ceil(minGap - gapDays)} more days before next non-safety message`);
    }
    if (input.unansweredCount >= 6 && input.tier !== 'P3') return deny('non_responder', 'only due items allowed after six unanswered messages');
  }

  return { allowed: true };
}

/* ---------- quiet hours: send-time scheduling ---------- */

export interface QuietHours { startHour: number; endHour: number }

/** Quiet hours hold service and marketing messages. Safety (P1 or safety_recall) is never held. */
export function quietHoursApply(purpose: string, tier: string): boolean {
  if (purpose === 'safety_recall' || tier === 'P1') return false;
  return purpose === 'service' || purpose.startsWith('marketing:');
}

export function inSendWindow(now: Date, tz: string, qh: QuietHours): boolean {
  const h = localHour(now, tz);
  return h >= qh.startHour && h < qh.endHour;
}

const QUARTER_MS = 15 * 60_000;

/**
 * Earliest instant at or after `now` inside the recipient-local send window. Steps on UTC quarter-hours, which are
 * also quarter-hours in every IANA zone (offsets are multiples of 15 minutes), so the result is the window start,
 * e.g. 08:00 local. Handles DST because each candidate is converted with Intl.
 */
export function nextSendWindow(now: Date, tz: string, qh: QuietHours): Date {
  if (inSendWindow(now, tz, qh)) return now;
  const start = Math.ceil(now.getTime() / QUARTER_MS) * QUARTER_MS;
  for (let t = start; t <= now.getTime() + 2 * 86_400_000; t += QUARTER_MS) {
    const d = new Date(t);
    if (inSendWindow(d, tz, qh)) return d;
  }
  throw new Error(`no send window within 48 h for ${tz}`);
}

/** Recipient-local wall time, e.g. "Sat 08:00 CST". */
export function localLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(d);
}

/** What happens if this message is approved now: sent immediately, or held until the recipient's morning. */
export function sendPlan(now: Date, tz: string, qh: QuietHours, purpose: string, tier: string):
  { held: boolean; sendAt: Date; localNow: string; localSendAt: string } {
  const sendAt = quietHoursApply(purpose, tier) ? nextSendWindow(now, tz, qh) : now;
  return { held: sendAt.getTime() > now.getTime(), sendAt, localNow: localLabel(now, tz), localSendAt: localLabel(sendAt, tz) };
}
