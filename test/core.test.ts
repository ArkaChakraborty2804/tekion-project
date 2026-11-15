/** Basic unit checks for the safety-critical pure functions. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, FREQUENCY_CAP, type PolicyInput } from '../lib/server/policy.ts';
import { classifyRules, checkDraft, redactPII } from '../lib/server/ai.ts';
import { sniff, stripJpegMetadata, validateUpload } from '../lib/server/media.ts';
import { signBody } from '../lib/server/tekion.ts';
import { safeEqual } from '../lib/server/auth.ts';
import { DEFAULT_RULES, validateRules } from '../lib/server/engine.ts';

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  purpose: 'service', tier: 'P2', oppType: 'D1', now: new Date('2026-06-10T18:00:00Z'),
  consent: { service: 'granted', marketing: 'granted' }, ownershipState: 'active',
  nonSafetySends30d: 0, unansweredCount: 0, declinedTypes: new Set(), ...over,
});

test('policy: allowed in the happy path', () => {
  assert.deepEqual(evaluatePolicy(base()), { allowed: true });
});

test('policy: consent is checked first and fails closed', () => {
  const r = evaluatePolicy(base({ consent: {}, ownershipState: 'possibly_sold', nonSafetySends30d: 99 }));
  assert.equal(r.allowed, false);
  assert.equal(!r.allowed && r.check, 'consent');
  const m = evaluatePolicy(base({ purpose: 'marketing:accessories', consent: { service: 'granted', marketing: 'revoked' } }));
  assert.equal(!m.allowed && m.check, 'consent');
});

test('policy: night time does not suppress (quiet hours schedule the send instead); safety ignores the cap', () => {
  const night = new Date('2026-06-10T08:00:00Z'); // 01:00 in Los Angeles
  assert.equal(evaluatePolicy(base({ now: night })).allowed, true);
  const safety = evaluatePolicy(base({ now: night, purpose: 'safety_recall', tier: 'P1', nonSafetySends30d: 50, ownershipState: 'possibly_sold' }));
  assert.equal(safety.allowed, true);
});

test('policy: frequency cap blocks non-safety', () => {
  const r = evaluatePolicy(base({ nonSafetySends30d: FREQUENCY_CAP }));
  assert.equal(!r.allowed && r.check, 'frequency_cap');
});

test('NLU: STOP, snooze and safety keywords by rules (no model)', () => {
  assert.equal(classifyRules('STOP').intent, 'stop');
  assert.equal(classifyRules('snooze 3 months').intent, 'snooze');
  for (const t of ['my brakes failed', 'car shut off on the freeway', 'smell of smoke from engine', 'los frenos no funcionan', 'brake nahi lag raha']) {
    assert.equal(classifyRules(t).safety, true, t);
  }
  assert.equal(classifyRules('thanks, see you next week').safety, false);
});

test('guardrails: banned phrases, unknown numbers, unlisted URLs, phone numbers', () => {
  assert.equal(checkDraft('Guaranteed lowest price!', '').ok, false);
  assert.equal(checkDraft('Save $200 today', 'oil change 39').ok, false);
  assert.equal(checkDraft('Book at https://evil.example/x', '').ok, false);
  assert.equal(checkDraft('Call 555-010-1234 now', '').ok, false);
  assert.equal(checkDraft('Your 30000 mile service is due.', 'service at 30000 miles').ok, true);
});

test('PII redaction removes phones and emails before any model call', () => {
  const r = redactPII('call me at +1 555 010 0199 or a@b.test');
  assert.ok(!r.includes('0199') && !r.includes('a@b.test'), r);
});

test('media: magic bytes decide the type, not the filename', () => {
  assert.equal(sniff(Buffer.from('<html>hi</html>')), null);
  assert.equal(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))?.mime, 'image/png');
  assert.ok('error' in validateUpload(Buffer.from('GIF89a....'), { imageBytes: 1e6, audioBytes: 1e6 }));
});

test('media: JPEG APP1 (EXIF/GPS) segment is stripped', () => {
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x08]), Buffer.from('Exif\0\0')]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, sos]);
  const out = stripJpegMetadata(jpg);
  assert.equal(out.length, jpg.length - exif.length);
  assert.ok(!out.includes(Buffer.from('Exif')));
});

test('webhook HMAC: signature over timestamp.body; constant-time compare', () => {
  const a = signBody('s3cret', '1700000000', '{"a":1}');
  assert.equal(a, signBody('s3cret', '1700000000', '{"a":1}'));
  assert.notEqual(a, signBody('s3cret', '1700000001', '{"a":1}'));
  assert.equal(safeEqual(a, a), true);
  assert.equal(safeEqual(a, a.slice(0, -1) + '0'), a.endsWith('0'));
  assert.equal(safeEqual(a, ''), false);
});

test('rules validation keeps bounded tuning in range', () => {
  assert.deepEqual(validateRules(DEFAULT_RULES), []);
  assert.ok(validateRules({ ...DEFAULT_RULES, service: { ...DEFAULT_RULES.service, intervalMiles: 10 } }).length > 0);
  assert.ok(validateRules({ ...DEFAULT_RULES, autoSendTypes: ['D2_RECALL'] }).length > 0, 'recall can never be auto-sent');
});
