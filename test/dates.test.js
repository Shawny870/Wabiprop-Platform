// test/dates.test.js
// B7 — SAST date parsing, unit level.
//
// These cases need a frozen clock: "today" at 00:30 SAST is only distinguishable
// from a UTC-anchored answer if the test controls `now`. The fixture replay
// harness drives real Meta payloads and can't express that, so the parser is
// tested directly here and the fixtures cover the integration.
//
// SAST is UTC+2 year-round (no DST, ever), so every expectation below is exact
// arithmetic, not a timezone-database lookup.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv } = require('./harness');

installEnv();
const { parseBookingDate, sastToUtcIso, sastCalendarDate } = require('../api/wabistay/webhook.js');

const utc = s => new Date(s);

// ── The midnight window: the whole reason this layer exists ─────────────────

test('SAST anchoring: "today" at 00:30 SAST resolves to the SAST date, NOT the UTC date', () => {
  // 2026-07-16T22:30:00Z is 2026-07-17 00:30 SAST — the dates disagree.
  const now = utc('2026-07-16T22:30:00Z');
  assert.deepStrictEqual(sastCalendarDate(now), { y: 2026, m: 7, d: 17 }, 'SAST calendar date');
  const parsed = parseBookingDate('today', now);
  assert.deepStrictEqual(parsed, { y: 2026, m: 7, d: 17 });
  // The bug this guards: a bare UTC day-boundary would answer the 16th.
  assert.strictEqual(now.toISOString().split('T')[0], '2026-07-16', 'UTC date really is the previous day here');
  assert.notStrictEqual(parsed.d, 16, 'must not fall back to the UTC date');
});

test('SAST anchoring: "today" at 01:59 SAST (last minute of the divergence window) still resolves to the SAST date', () => {
  const now = utc('2026-07-16T23:59:00Z'); // 2026-07-17 01:59 SAST
  assert.deepStrictEqual(parseBookingDate('today', now), { y: 2026, m: 7, d: 17 });
});

test('SAST anchoring: "today" at 02:00 SAST (first minute the dates agree again)', () => {
  const now = utc('2026-07-17T00:00:00Z'); // 2026-07-17 02:00 SAST
  assert.deepStrictEqual(parseBookingDate('today', now), { y: 2026, m: 7, d: 17 });
});

test('SAST anchoring: "today" at 23:30 SAST resolves to the SAST date (spec case — passes either way, see comment)', () => {
  // The build spec named 23:30 SAST as the near-midnight case. It is a real
  // scenario but it cannot fail: at 23:30 SAST the UTC clock reads 21:30 the
  // SAME day, so a UTC-anchored implementation gets the right answer by luck.
  // Kept because the spec asked for it; the 00:30 case above is the one that
  // actually distinguishes correct from broken. Divergence is 00:00–01:59 SAST.
  const now = utc('2026-07-16T21:30:00Z');
  assert.deepStrictEqual(parseBookingDate('today', now), { y: 2026, m: 7, d: 16 });
  assert.strictEqual(now.toISOString().split('T')[0], '2026-07-16', 'UTC agrees here — hence the case is vacuous');
});

test('SAST anchoring: "tomorrow" at 00:30 SAST is the SAST day after, not the UTC day after', () => {
  const now = utc('2026-07-16T22:30:00Z'); // 2026-07-17 00:30 SAST
  assert.deepStrictEqual(parseBookingDate('tomorrow', now), { y: 2026, m: 7, d: 18 });
});

test('SAST anchoring: "tomorrow" rolls month and year boundaries from inside the window', () => {
  // 2026-12-31T22:30:00Z is 2027-01-01 00:30 SAST — SAST is already next year.
  const now = utc('2026-12-31T22:30:00Z');
  assert.deepStrictEqual(parseBookingDate('today', now), { y: 2027, m: 1, d: 1 });
  assert.deepStrictEqual(parseBookingDate('tomorrow', now), { y: 2027, m: 1, d: 2 });
});

test('SAST anchoring: "tomorrow" on the last day of a month', () => {
  const now = utc('2026-07-31T10:00:00Z'); // 2026-07-31 12:00 SAST
  assert.deepStrictEqual(parseBookingDate('tomorrow', now), { y: 2026, m: 8, d: 1 });
});

// ── Absolute dates ─────────────────────────────────────────────────────────

const NOW = utc('2026-07-16T12:00:00Z'); // 2026-07-16 14:00 SAST

test('parses the greeting\'s own example formats', () => {
  assert.deepStrictEqual(parseBookingDate('20 August', NOW), { y: 2026, m: 8, d: 20 });
  assert.deepStrictEqual(parseBookingDate('20 Aug', NOW), { y: 2026, m: 8, d: 20 });
  assert.deepStrictEqual(parseBookingDate('20aug', NOW), { y: 2026, m: 8, d: 20 });
  assert.deepStrictEqual(parseBookingDate('August 20', NOW), { y: 2026, m: 8, d: 20 });
  assert.deepStrictEqual(parseBookingDate('20th August', NOW), { y: 2026, m: 8, d: 20 });
  assert.deepStrictEqual(parseBookingDate('  20 August  ', NOW), { y: 2026, m: 8, d: 20 });
});

test('numeric dates are day-first, never month-first', () => {
  // 06/08 is 6 August, still ahead of 16 July so no year roll muddies it.
  // Read as MM/DD it would be 8 June — already past, so it would also land in a
  // different year. Both digits are <= 12, so the ambiguity is real.
  assert.deepStrictEqual(parseBookingDate('06/08', NOW), { y: 2026, m: 8, d: 6 });
  assert.deepStrictEqual(parseBookingDate('6-8', NOW), { y: 2026, m: 8, d: 6 });
  assert.deepStrictEqual(parseBookingDate('20/08/2026', NOW), { y: 2026, m: 8, d: 20 });
  assert.deepStrictEqual(parseBookingDate('20/08/26', NOW), { y: 2026, m: 8, d: 20 });
});

test('a day+month already past this year rolls forward to next year (CEO 16 July)', () => {
  // 25 June is behind 16 July 2026, so the guest means 2027.
  assert.deepStrictEqual(parseBookingDate('25 June', NOW), { y: 2027, m: 6, d: 25 });
  assert.deepStrictEqual(parseBookingDate('25/06', NOW), { y: 2027, m: 6, d: 25 });
});

test('today\'s own date does not roll forward', () => {
  assert.deepStrictEqual(parseBookingDate('16 July', NOW), { y: 2026, m: 7, d: 16 });
});

test('an explicit year is taken literally, even when it is in the past', () => {
  assert.deepStrictEqual(parseBookingDate('25 June 2026', NOW), { y: 2026, m: 6, d: 25 });
});

// ── Rejection: nothing unparseable may reach Airtable ───────────────────────

test('unparseable input returns null rather than a guessed date', () => {
  for (const bad of ['', '   ', 'asdf qwerty !!', 'John Smith', 'next week', 'soon',
                     '32 June', '0 June', '25 Junk', '25/13', '32/06', 'June', '25']) {
    assert.strictEqual(parseBookingDate(bad, NOW), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('impossible calendar dates are rejected, not rolled into the next month', () => {
  // Date.UTC(2026, 5, 31) silently becomes 1 July — the parser must not.
  assert.strictEqual(parseBookingDate('31 June', NOW), null);
  assert.strictEqual(parseBookingDate('31/06', NOW), null);
  // 2026 and 2027 are both non-leap, so this re-prompts rather than landing in 2028.
  assert.strictEqual(parseBookingDate('29 February', NOW), null);
});

test('a leap day is accepted when the year it resolves to actually has one', () => {
  const now2027 = utc('2027-07-16T12:00:00Z');
  assert.deepStrictEqual(parseBookingDate('29 February', now2027), { y: 2028, m: 2, d: 29 });
});

// ── The write boundary ─────────────────────────────────────────────────────

test('sastToUtcIso applies the overnight defaults as UTC, shifted by exactly 2 hours', () => {
  const d = { y: 2026, m: 6, d: 25 };
  assert.strictEqual(sastToUtcIso(d, 14), '2026-06-25T12:00:00.000Z', '14:00 SAST check-in');
  assert.strictEqual(sastToUtcIso(d, 10), '2026-06-25T08:00:00.000Z', '10:00 SAST check-out');
});

test('sastToUtcIso keeps the SAST calendar day when the UTC shift crosses midnight backwards', () => {
  // 01:00 SAST on 1 Jan is 23:00 UTC on 31 Dec — the stored instant is the
  // previous UTC day, and that is correct.
  assert.strictEqual(sastToUtcIso({ y: 2027, m: 1, d: 1 }, 1), '2026-12-31T23:00:00.000Z');
});

test('end to end: "today" at 00:30 SAST is stored as 14:00 SAST that SAST day', () => {
  const now = utc('2026-07-16T22:30:00Z'); // 2026-07-17 00:30 SAST
  const parsed = parseBookingDate('today', now);
  assert.strictEqual(sastToUtcIso(parsed, 14), '2026-07-17T12:00:00.000Z');
});
