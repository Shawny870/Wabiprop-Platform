// test/availability.test.js
// B8 — the overlap definition, unit level.
//
// Why this file exists, and why the same-day-turnover fixture is NOT a substitute:
//
// The locked rule is exclusive bounds — `newIn < existingOut && newOut > existingIn`,
// strict inequalities. Exclusive and inclusive bounds only disagree on ONE input:
// when an instant is shared, i.e. a check-in exactly equal to a check-out.
//
// The overnight flow cannot produce that input. Its defaults are 14:00 in and
// 10:00 out, so a turnover compares 14:00 against 10:00 — four hours apart, and
// "no overlap" under both definitions. Fixture 26 therefore proves that same-day
// turnover is allowed (worth proving on its own — it is the revenue case) but it
// does NOT prove the bounds are exclusive: it passes either way. Verified by
// mutation — flipping rangesOverlap to <=/>= leaves every fixture green.
//
// The shared instant becomes reachable in B9, where an hourly booking ending at
// 17:00 sits against one starting at 17:00. These tests pin the rule now, so
// that B9 inherits a definition that is proven rather than assumed.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv } = require('./harness');

installEnv();
const { rangesOverlap } = require('../api/wabistay/webhook.js');

const T = h => `2026-08-20T${String(h).padStart(2, '0')}:00:00.000Z`;

// ── The boundary: the only input where exclusive and inclusive differ ───────

test('exclusive bounds: a range starting exactly when another ends does NOT overlap', () => {
  // Existing 08:00-10:00, new 10:00-12:00. Touching, not overlapping.
  // Under inclusive bounds this returns true and the room is refused.
  assert.strictEqual(rangesOverlap(T(10), T(12), T(8), T(10)), false);
});

test('exclusive bounds: a range ending exactly when another starts does NOT overlap', () => {
  // The mirror image — new range sits entirely before the existing one.
  assert.strictEqual(rangesOverlap(T(8), T(10), T(10), T(12)), false);
});

test('one minute inside the boundary DOES overlap — the rule is exact, not approximate', () => {
  assert.strictEqual(rangesOverlap('2026-08-20T09:59:00.000Z', T(12), T(8), T(10)), true);
});

// ── Ordinary overlap cases ─────────────────────────────────────────────────

test('partial overlap in either direction is an overlap', () => {
  assert.strictEqual(rangesOverlap(T(9), T(11), T(8), T(10)), true, 'new starts inside existing');
  assert.strictEqual(rangesOverlap(T(7), T(9), T(8), T(10)), true, 'new ends inside existing');
});

test('containment in either direction is an overlap', () => {
  assert.strictEqual(rangesOverlap(T(9), T(11), T(8), T(12)), true, 'new inside existing');
  assert.strictEqual(rangesOverlap(T(8), T(12), T(9), T(11)), true, 'existing inside new');
});

test('identical ranges overlap', () => {
  assert.strictEqual(rangesOverlap(T(8), T(10), T(8), T(10)), true);
});

test('fully disjoint ranges do not overlap', () => {
  assert.strictEqual(rangesOverlap(T(8), T(10), T(14), T(16)), false);
  assert.strictEqual(rangesOverlap(T(14), T(16), T(8), T(10)), false);
});

// ── The real-world shape, for the record ───────────────────────────────────

test('same-day turnover: 10:00 check-out then 14:00 check-in is free (passes under both bound styles — see file header)', () => {
  const existingIn = '2026-08-18T12:00:00.000Z';  // 14:00 SAST, two days before
  const existingOut = '2026-08-20T08:00:00.000Z'; // 10:00 SAST today
  const newIn = '2026-08-20T12:00:00.000Z';       // 14:00 SAST today
  const newOut = '2026-08-21T08:00:00.000Z';      // 10:00 SAST tomorrow
  assert.strictEqual(rangesOverlap(newIn, newOut, existingIn, existingOut), false);
});

test('B9 preview: back-to-back hourly bookings sharing an instant do not overlap', () => {
  // 14:00-17:00 SAST then 17:00-18:00 SAST on the same room. This is the input
  // the overnight flow can never generate, and the reason the rule is strict.
  const first = ['2026-08-20T12:00:00.000Z', '2026-08-20T15:00:00.000Z'];
  const second = ['2026-08-20T15:00:00.000Z', '2026-08-20T16:00:00.000Z'];
  assert.strictEqual(rangesOverlap(second[0], second[1], first[0], first[1]), false);
});
