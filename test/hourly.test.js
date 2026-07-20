// test/hourly.test.js
// B9 — arrival-time parsing, duration arithmetic, and the fail-closed rate read.
//
// addHoursToIso is the load-bearing piece: it decides the window every hourly
// availability check is measured against. An off-by-one-hour here would not
// throw, would not fail a happy-path fixture, and would silently hold the wrong
// slot — so it is pinned directly, and mutation-tested (see the PR).

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv } = require('./harness');

installEnv();
const { parseArrivalTime, addHoursToIso, hourlyRates, formatSastDateTime } = require('../api/wabistay/webhook.js');

// ── Duration → check-out ───────────────────────────────────────────────────

test('addHoursToIso advances by exactly the requested hours', () => {
  const start = '2026-08-20T12:00:00.000Z'; // 14:00 SAST
  assert.strictEqual(addHoursToIso(start, 1), '2026-08-20T13:00:00.000Z');
  assert.strictEqual(addHoursToIso(start, 2), '2026-08-20T14:00:00.000Z');
  assert.strictEqual(addHoursToIso(start, 3), '2026-08-20T15:00:00.000Z');
});

test('addHoursToIso carries across midnight UTC without losing the date', () => {
  // 23:30 SAST + 3h = 02:30 SAST the next day.
  assert.strictEqual(addHoursToIso('2026-08-20T21:30:00.000Z', 3), '2026-08-21T00:30:00.000Z');
});

test('addHoursToIso preserves minutes — a 2:30pm arrival ends at 4:30pm, not 4:00', () => {
  assert.strictEqual(addHoursToIso('2026-08-20T12:30:00.000Z', 2), '2026-08-20T14:30:00.000Z');
});

// ── Arrival time parsing ───────────────────────────────────────────────────

test('12-hour times with a meridiem parse unambiguously', () => {
  assert.deepStrictEqual(parseArrivalTime('2pm'), { hour: 14, minute: 0 });
  assert.deepStrictEqual(parseArrivalTime('2 PM'), { hour: 14, minute: 0 });
  assert.deepStrictEqual(parseArrivalTime('2:30pm'), { hour: 14, minute: 30 });
  assert.deepStrictEqual(parseArrivalTime('11am'), { hour: 11, minute: 0 });
  assert.deepStrictEqual(parseArrivalTime('12pm'), { hour: 12, minute: 0 }, 'noon');
  assert.deepStrictEqual(parseArrivalTime('12am'), { hour: 0, minute: 0 }, 'midnight');
});

test('24-hour times parse', () => {
  assert.deepStrictEqual(parseArrivalTime('14:00'), { hour: 14, minute: 0 });
  assert.deepStrictEqual(parseArrivalTime('14h30'), { hour: 14, minute: 30 });
  assert.deepStrictEqual(parseArrivalTime('19'), { hour: 19, minute: 0 });
  assert.deepStrictEqual(parseArrivalTime('00:15'), { hour: 0, minute: 15 });
});

test('conversational prefixes are tolerated', () => {
  assert.deepStrictEqual(parseArrivalTime('around 2pm'), { hour: 14, minute: 0 });
  assert.deepStrictEqual(parseArrivalTime('after 5pm'), { hour: 17, minute: 0 });
  assert.deepStrictEqual(parseArrivalTime('at 14:00'), { hour: 14, minute: 0 });
});

test('a bare hour of 1-11 is reported ambiguous instead of guessed', () => {
  // Guessing "9" wrong puts the booking twelve hours out: wrong window held,
  // wrong room blocked, guest arrives to nothing. One extra question is cheaper.
  for (const h of [1, 5, 9, 11]) {
    assert.deepStrictEqual(parseArrivalTime(String(h)), { ambiguous: h }, `bare "${h}"`);
  }
  // 0 and 12-23 can only be 24-hour, so they are not ambiguous.
  assert.deepStrictEqual(parseArrivalTime('0'), { hour: 0, minute: 0 });
  assert.deepStrictEqual(parseArrivalTime('12'), { hour: 12, minute: 0 });
});

test('non-times return null so the flow re-prompts rather than inventing a time', () => {
  for (const bad of ['', '   ', 'John Smith', 'tomorrow', 'asdf', '25:00', '9:99pm', '13pm', '2pmish']) {
    assert.strictEqual(parseArrivalTime(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ── Rates: fail closed ─────────────────────────────────────────────────────

const propWith = fields => ({ id: 'recP1', fields });

test('all three rates configured returns the full table', () => {
  const p = propWith({ 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320 });
  assert.deepStrictEqual(hourlyRates(p), { 1: 120, 2: 250, 3: 320 });
});

test('any missing, blank or zero rate disables hourly for the whole property', () => {
  // A property onboarded without hourly configured must never quote R0 or book
  // free — the feature switches off and the guest is routed to overnight.
  const cases = [
    { 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250 },
    { 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 0 },
    { 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': null, 'Hourly Rate 3hr': 320 },
    { 'Hourly Rate 1hr': '', 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320 },
    { 'Hourly Rate 1hr': -50, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320 },
    {}
  ];
  for (const fields of cases) {
    assert.strictEqual(hourlyRates(propWith(fields)), null, JSON.stringify(fields));
  }
});

// ── Guest-facing rendering ─────────────────────────────────────────────────

test('stored UTC instants render back in SAST with their date attached', () => {
  // 12:00Z is 14:00 SAST. The date is always shown so a booking that rolled to
  // tomorrow cannot read as if it were today.
  assert.strictEqual(formatSastDateTime('2026-08-20T12:00:00.000Z'), '20 Aug at 2:00pm');
  assert.strictEqual(formatSastDateTime('2026-08-20T15:30:00.000Z'), '20 Aug at 5:30pm');
  assert.strictEqual(formatSastDateTime('2026-08-20T10:00:00.000Z'), '20 Aug at 12:00pm', 'noon');
  // 22:30Z is 00:30 SAST the NEXT day — the date must roll with it.
  assert.strictEqual(formatSastDateTime('2026-08-20T22:30:00.000Z'), '21 Aug at 12:30am');
});
