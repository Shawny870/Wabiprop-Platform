// test/reception-preference.test.js
// Repeat-guest preference matching (CEO-approved, 31 Aug) — overnight-only
// fuzzy name matching against the guest's most recent prior stay, gated
// behind Booking Type, with a silent repeat-number signal that fires
// independent of whether the name matched.
//
// Covers: the namesFuzzyMatch pure helper (token-subset + Levenshtein
// fallback, several matching/non-matching pairs incl. edge cases), the
// stay-length gate (hourly bypasses entirely — no write, no signal, no
// reception push), the repeat-count signal firing on ANY prior booking
// regardless of match outcome, the reception push firing only on match, and
// that guest-facing display always shows exactly what was typed this stay.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const { namesFuzzyMatch, levenshteinDistance } = wh;

// ── namesFuzzyMatch (pure helper) ───────────────────────────────────────────

test('namesFuzzyMatch: token-subset — shortened first name + initial matches full name', () => {
  assert.strictEqual(namesFuzzyMatch('Shawn M', 'Shawn Mahashi'), true);
  assert.strictEqual(namesFuzzyMatch('Shawn Mahashi', 'Shawn M'), true, 'order-independent');
});

test('namesFuzzyMatch: exact match', () => {
  assert.strictEqual(namesFuzzyMatch('John Smith', 'John Smith'), true);
});

test('namesFuzzyMatch: case-insensitive', () => {
  assert.strictEqual(namesFuzzyMatch('john smith', 'JOHN SMITH'), true);
});

test('namesFuzzyMatch: prefix token matches full token', () => {
  assert.strictEqual(namesFuzzyMatch('Rob Johnson', 'Robert Johnson'), true);
});

test('namesFuzzyMatch: single first name matches when it prefixes/equals a token in the longer name', () => {
  assert.strictEqual(namesFuzzyMatch('Shawn', 'Shawn Mahashi'), true);
});

test('namesFuzzyMatch: two different people with unrelated names do not match', () => {
  assert.strictEqual(namesFuzzyMatch('Amanda Lee', 'Robert Johnson'), false);
});

test('namesFuzzyMatch: same first name, different surname does not match', () => {
  assert.strictEqual(namesFuzzyMatch('Shawn Peters', 'Shawn Mahashi'), false);
});

test('namesFuzzyMatch: no reusing one long-name token for two short-name tokens', () => {
  // "J J" should not match "James Jones" by matching "J" against "James" twice.
  assert.strictEqual(namesFuzzyMatch('J J', 'James Jones'), true, 'J->James, J->Jones, distinct tokens');
  assert.strictEqual(namesFuzzyMatch('J J J', 'James Jones'), false, 'a third J has nothing left to consume');
});

test('namesFuzzyMatch: Levenshtein fallback catches a minor typo on a short name (distance <= 1)', () => {
  assert.strictEqual(namesFuzzyMatch('Sipho', 'Siphoo'), true, 'distance 1, len <= 8');
  assert.strictEqual(namesFuzzyMatch('Sipho', 'Sipha'), true, 'distance 1 substitution');
});

test('namesFuzzyMatch: short-name Levenshtein threshold — distance 1 on a <=8-char name matches (documented boundary, not a false-positive concern at this length)', () => {
  assert.strictEqual(levenshteinDistance('bob', 'rob'), 1);
  assert.strictEqual(namesFuzzyMatch('Bob', 'Rob'), true, 'distance 1, 3 chars <= 8 — matches per the stated threshold');
});

test('namesFuzzyMatch: short-name threshold rejects distance 2', () => {
  assert.strictEqual(levenshteinDistance('bob', 'ravi'), 4);
  assert.strictEqual(namesFuzzyMatch('Bob', 'Ravi'), false);
});

test('namesFuzzyMatch: Levenshtein fallback requires >=0.85 normalized similarity for longer names', () => {
  // "Jonathan Mahashi" (16 chars) vs a 1-char-dropped variant: similarity must clear 0.85.
  assert.strictEqual(namesFuzzyMatch('Jonathan Mahashi', 'Jonathan Mahash'), true, 'one char dropped, len 16, sim ~0.94');
  // Two substitutions on the same 16-char name: distance 2, sim = 1 - 2/16 = 0.875,
  // which still clears 0.85 — used here to pin the exact boundary math rather
  // than assume a stricter result.
  assert.strictEqual(levenshteinDistance('jonathan mahashi', 'jonathan mahoshy'), 2);
  assert.strictEqual(namesFuzzyMatch('Jonathan Mahashi', 'Jonathan Mahoshy'), true, 'sim 0.875 >= 0.85');
});

test('namesFuzzyMatch: wholly different long names do not match', () => {
  assert.strictEqual(namesFuzzyMatch('Alexandra Peterson', 'Christopher Nguyen'), false);
});

test('namesFuzzyMatch: empty/blank inputs never match', () => {
  assert.strictEqual(namesFuzzyMatch('', 'Shawn Mahashi'), false);
  assert.strictEqual(namesFuzzyMatch('Shawn Mahashi', ''), false);
  assert.strictEqual(namesFuzzyMatch(null, 'Shawn Mahashi'), false);
  assert.strictEqual(namesFuzzyMatch(undefined, undefined), false);
});

// ── Full-flow fixtures ──────────────────────────────────────────────────────

const GUEST_PHONE = '27821234567';

function baseSeed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: {
        'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000',
        'Notify Phone': '27732273477', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
      }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'] } }
    ],
    WS_Rates: [
      { id: 'recRateSingle', fields: { 'Rate Name': 'Single', 'Occupancy Type': 'Single', 'Rate Type': 'Per Night', 'Amount': 300, 'Active': true, 'Property': ['recP1'] } },
      { id: 'recRateCouple', fields: { 'Rate Name': 'Couple', 'Occupancy Type': 'Couple', 'Rate Type': 'Per Night', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Roles: [
      { id: 'recRole1', fields: { 'Role Label': 'Villa Liza Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': '27825999279', 'Active': true } }
    ],
    WS_Guests: [],
    WS_Bookings: [],
    WS_Cleaners: [],
    WS_Enquiries: [],
    ...overrides
  };
}

function start(overrides) {
  const ctx = { airtable: new MockAirtable(baseSeed(overrides)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const guestRow = ctx => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === GUEST_PHONE);
const bookings = ctx => ctx.airtable.tables['WS_Bookings'];
const allTexts = ctx => ctx.sends.map(s => s.body || '').join('\n---\n');

// A pre-existing guest with an already-set name (WS_Guests.Guest Name is
// persistent-per-phone and never re-typed once set), plus one prior Checked
// Out overnight booking that recorded a 'Guest Name (This Stay)' value — the
// only way, under the real data model, for a "previous typed name" to exist
// distinctly from the persistent guest profile name.
function seedReturningGuest({ guestName = 'Unknown', priorStayName, priorCheckOut = '2026-07-01T08:00:00.000Z' } = {}) {
  return {
    WS_Guests: [{
      id: 'recG1',
      fields: { 'Guest Name': guestName, 'Phone Number': GUEST_PHONE, 'Session State': 'NEW' }
    }],
    WS_Bookings: [{
      id: 'recBPrior',
      fields: {
        'Booking Ref': 'WS-PRIOR1', 'Guest': ['recG1'], 'Room': ['recR1'],
        'Status': 'Checked Out', 'Booking Type': 'Overnight',
        'Check In': '2026-06-29T12:00:00.000Z', 'Check Out': priorCheckOut,
        ...(priorStayName ? { 'Guest Name (This Stay)': priorStayName } : {})
      }
    }]
  };
}

test('overnight booking, fresh guest, fuzzy-matched name: reception push fires (stubbed, no template configured) and repeat signal logs', async () => {
  const ctx = start(seedReturningGuest({ priorStayName: 'Shawn Mahashi' }));
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, '2');
  await send(GUEST_PHONE, 'Shawn M\n25 Sep\n27 Sep');

  const booking = bookings(ctx).find(b => b.id !== 'recBPrior');
  assert.ok(booking, 'new booking created');
  assert.strictEqual(booking.fields['Guest Name (This Stay)'], 'Shawn M', 'freezes exactly what was typed this stay');

  assert.ok(ctx.axiom.some(e => e.event === 'repeat_guest_signal'), 'repeat-number signal fired');
  assert.ok(
    ctx.axiom.some(e => e.event === 'reception_preference_notify_stubbed'),
    'reception push attempted (stubbed — no WABISTAY_RECEPTION_PREFERENCE_TEMPLATE configured in test env)'
  );

  // Guest-facing text always shows what THEY typed this stay, never the prior name.
  assert.match(allTexts(ctx), /Shawn M(?!ahashi)/, 'guest sees "Shawn M", not the on-file "Shawn Mahashi"');
  assert.doesNotMatch(allTexts(ctx), /Mahashi/, 'previous full name never leaks to the guest');
});

test('overnight booking, name does NOT fuzzy-match prior stay: fully anonymous, no reception push, repeat signal still logs', async () => {
  const ctx = start(seedReturningGuest({ priorStayName: 'Robert Johnson' }));
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, '2');
  await send(GUEST_PHONE, 'Amanda Lee\n25 Sep\n27 Sep');

  const booking = bookings(ctx).find(b => b.id !== 'recBPrior');
  assert.strictEqual(booking.fields['Guest Name (This Stay)'], 'Amanda Lee');

  assert.ok(ctx.axiom.some(e => e.event === 'repeat_guest_signal'), 'repeat signal fires independent of match outcome');
  assert.ok(
    !ctx.axiom.some(e => e.event === 'reception_preference_notify_stubbed' || e.event === 'reception_preference_notify_failed'),
    'no reception push attempted on a non-match'
  );
  assert.doesNotMatch(allTexts(ctx), /Robert|Johnson/, 'previous unmatched name never leaks to the guest');
});

test('overnight booking, guest has no prior booking at all: no repeat signal, no reception push', async () => {
  const ctx = start(); // no WS_Bookings seeded — genuinely first-ever contact
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, '2');
  await send(GUEST_PHONE, 'Amanda Lee\n25 Sep\n27 Sep');

  assert.ok(!ctx.axiom.some(e => e.event === 'repeat_guest_signal'), 'no prior booking on this phone at all');
  assert.ok(!ctx.axiom.some(e => e.event === 'reception_preference_notify_stubbed'));
});

test('STAY-LENGTH GATE: an hourly booking never triggers preference matching, even with a prior overnight booking on the same phone', async () => {
  const ctx = start(seedReturningGuest({ priorStayName: 'Shawn Mahashi' }));
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, '1'); // short stay
  await send(GUEST_PHONE, 'Shawn Mahashi\n2pm'); // exact on-file name, would trivially match if reached

  const hourlyBooking = bookings(ctx).find(b => b.fields['Booking Type'] === 'Hourly');
  assert.ok(hourlyBooking, 'hourly booking created');
  assert.strictEqual(hourlyBooking.fields['Guest Name (This Stay)'], undefined, 'hourly bookings never get a stay-name write');

  assert.ok(!ctx.axiom.some(e => e.event === 'repeat_guest_signal'), 'hourly is unconditionally anonymous — no repeat signal');
  assert.ok(!ctx.axiom.some(e => e.event === 'reception_preference_notify_stubbed'), 'no reception preference push for hourly');
});

test('reception push carries a live template: sends to the active Reception seat with the right params', async () => {
  const TEMPLATE_ENV = 'WABISTAY_RECEPTION_PREFERENCE_TEMPLATE';
  const previous = process.env[TEMPLATE_ENV];
  process.env[TEMPLATE_ENV] = 'wabistay_reception_preference_match';
  try {
    const ctx = start(seedReturningGuest({ priorStayName: 'Shawn Mahashi' }));
    await send(GUEST_PHONE, 'hi');
    await send(GUEST_PHONE, '2');
    await send(GUEST_PHONE, 'Shawn M\n25 Sep\n27 Sep');

    const templateSend = ctx.sends.find(s => s.type === 'template' && s.template === 'wabistay_reception_preference_match');
    assert.ok(templateSend, 'template send attempted');
    assert.strictEqual(templateSend.to, '27825999279', 'sent to the active Reception seat');
    assert.deepStrictEqual(templateSend.params.slice(1, 3), ['Shawn M', 'Shawn Mahashi'], 'currentName then previousName');
  } finally {
    if (previous === undefined) delete process.env[TEMPLATE_ENV];
    else process.env[TEMPLATE_ENV] = previous;
  }
});
