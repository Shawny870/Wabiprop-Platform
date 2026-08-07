// test/booking-race.test.js
// PR 1 (P1a + P1b) — room availability integrity.
//
// Two independent bugs, same symptom (a room sold twice), different cause:
//
//   P1a — collectDetails (overnight) and selectHourlyDuration (hourly) both
//   check availability once, then write the hold, with no re-verification.
//   Airtable is not transactional (CLAUDE.md rule 32), and unlike walkinBooking
//   (a single reception handset), these two paths see real WhatsApp concurrency.
//   Two guests racing the same room/dates can both pass the pre-check before
//   either write lands.
//
//   P1b — findAvailableRoom's blocking-bookings read silently fails open: a
//   transient Airtable error returns whatever airtableGet had accumulated
//   (possibly []), which reads as "nothing blocks this room" — an outage can
//   CAUSE a double-booking independent of any timing race.
//
// Racing two real concurrent invocations isn't reproducible deterministically
// through Node's single-threaded event loop without controlling the
// interleaving directly. So the race is constructed precisely instead: the
// guest's own create/update call is intercepted, and — in the instant between
// that write and the NEW post-write re-check this PR adds — a competing
// booking is inserted directly into the store. This exercises exactly the
// window the fix closes, deterministically, rather than hoping Promise.all
// timing reproduces it.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');

const GUEST_A_PHONE = '27821111111';
const GUEST_B_PHONE = '27822222222';

function seed(overrides = {}) {
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
      { id: 'recRateSingle', fields: { 'Rate Name': 'Single', 'Occupancy Type': 'Single', 'Amount': 250, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Guests: [],
    WS_Bookings: [],
    WS_Cleaners: [],
    WS_Roles: [],
    WS_Enquiries: [],
    ...overrides
  };
}

function start(overrides) {
  const ctx = { airtable: new MockAirtable(seed(overrides)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(from, text) {
  const res = makeRes();
  await handler({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const bookings = ctx => ctx.airtable.tables['WS_Bookings'] || [];
const guestRow = (ctx, phone) => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === phone);
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '').join('\n---\n');
const axiomEvents = ctx => ctx.axiom.map(e => e.event);

// Injects a one-shot competing write the FIRST time `create`/`update` is called
// matching `table`. Fires exactly once, then restores the original method — so
// it models "the other guest's write landed in the gap" without touching any
// other call in the test.
function raceOnNextCreate(ctx, table, competingFields) {
  const original = ctx.airtable.create.bind(ctx.airtable);
  ctx.airtable.create = (t, fields) => {
    const rec = original(t, fields);
    if (t === table) {
      ctx.airtable.create = original; // one-shot
      original(table, competingFields);
    }
    return rec;
  };
}

// Makes ONE matching GET (by table + a substring of the decoded formula) return
// an Airtable error body instead of delegating to the mock — used to force
// findAvailableRoom's blocking-bookings read to fail. Restores after one match.
function failNextGet(ctx, table, formulaContains) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname.includes(encodeURIComponent(table)) || u.pathname.includes(table)) {
      const formula = decodeURIComponent(u.searchParams.get('filterByFormula') || '');
      if (formula.includes(formulaContains)) {
        global.fetch = originalFetch; // one-shot
        return {
          status: 500, ok: false,
          json: async () => ({ error: { type: 'SERVER_ERROR', message: 'simulated transient failure' } }),
          text: async () => 'simulated transient failure'
        };
      }
    }
    return originalFetch(url, opts);
  };
}

// ── P1a: overnight race ──────────────────────────────────────────────────────

test('overnight: a competing booking that lands between the pre-check and create is caught and rolled back', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_A_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });

  // Guest A's collectDetails is about to create a booking for these exact
  // dates. Inject "guest B's" competing Confirmed booking on the same room,
  // overlapping range, the instant A's own create lands — before A's NEW
  // re-check runs.
  raceOnNextCreate(ctx, 'WS_Bookings', {
    'Guest': [], 'Room': ['recR1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
    'Check In': '2026-09-01T12:00:00.000Z', 'Check Out': '2026-09-03T08:00:00.000Z'
  });

  await send(GUEST_A_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  const live = bookings(ctx).filter(b => b.fields['Status'] !== 'Cancelled');
  assert.strictEqual(live.length, 1, 'only the competing booking survives active');
  assert.strictEqual(live[0].fields['Status'], 'Confirmed', 'the competitor, not A');

  const asRecord = bookings(ctx).find(b => b.fields['Guest'] && b.fields['Guest'].includes('recGA'));
  assert.ok(asRecord, 'A\'s own booking still exists as a record');
  assert.strictEqual(asRecord.fields['Status'], 'Cancelled', 'but rolled back, not left Confirmed');

  assert.strictEqual(guestRow(ctx, GUEST_A_PHONE).fields['Session State'], 'AWAITING_DETAILS', 'guest reset, not stuck in AWAITING_OCCUPANCY with no valid booking');
  assert.match(texts(ctx, GUEST_A_PHONE), /fully booked/i, 'told no availability, not "booking received"');
  assert.ok(axiomEvents(ctx).includes('booking_race_lost'));
});

test('overnight: no competitor — the ordinary single-guest booking is unaffected by the new re-check', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_A_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });

  await send(GUEST_A_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  const live = bookings(ctx).filter(b => b.fields['Status'] !== 'Cancelled');
  assert.strictEqual(live.length, 1, 'the booking survives — the re-check does not manufacture a false conflict');
  assert.strictEqual(live[0].fields['Status'], 'Enquiry');
  assert.match(texts(ctx, GUEST_A_PHONE), /occupancy|How many of you/i, 'flow proceeds normally to the occupancy question');
});

test('overnight: a rollback write that itself fails is logged loudly, not silently', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_A_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  raceOnNextCreate(ctx, 'WS_Bookings', {
    'Guest': [], 'Room': ['recR1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
    'Check In': '2026-09-01T12:00:00.000Z', 'Check Out': '2026-09-03T08:00:00.000Z'
  });

  // The rollback PATCH (Status -> Cancelled) is the next update to WS_Bookings
  // after the race is injected. Fail it specifically via a fetch intercept.
  const originalFetch = global.fetch;
  let failed = false;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (!failed && (opts.method || '').toUpperCase() === 'PATCH' && u.pathname.includes('WS_Bookings') && String(opts.body).includes('Cancelled')) {
      failed = true;
      return { status: 500, ok: false, json: async () => ({ error: { type: 'SERVER_ERROR', message: 'simulated' } }), text: async () => 'simulated' };
    }
    return originalFetch(url, opts);
  };

  await send(GUEST_A_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  assert.ok(axiomEvents(ctx).includes('booking_rollback_failed'), 'the failed rollback itself is visible, not swallowed');
  // Per Rule 30's spirit: even though the rollback write failed, the guest is
  // still told the truth (no availability) rather than a false confirmation —
  // this is the one thing that must not silently become "booking received".
  assert.match(texts(ctx, GUEST_A_PHONE), /fully booked/i);
});

// ── P1a: hourly race ─────────────────────────────────────────────────────────

function seedPendingHourly(overrides = {}) {
  return seed({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_A_PHONE, 'Session State': 'AWAITING_HOURLY_DURATION' } }],
    WS_Bookings: [{
      id: 'recPending', fields: {
        'Guest': ['recGA'], 'Booking Type': 'Hourly', 'Status': 'Enquiry',
        'Check In': '2026-09-01T12:00:00.000Z', 'Payment Status': 'Unpaid'
      }
    }],
    ...overrides
  });
}

test('hourly: a competing booking landing between the pre-check and the room-assign update is caught and rolled back', async () => {
  const ctx = { airtable: new MockAirtable(seedPendingHourly()), sends: [], axiom: [] };
  installFetch(ctx);

  // The guest's own write is an UPDATE (Room + Status:Confirmed on the pending
  // row), not a create — intercept that specific update instead.
  const original = ctx.airtable.update.bind(ctx.airtable);
  ctx.airtable.update = (t, id, fields) => {
    const rec = original(t, id, fields);
    if (t === 'WS_Bookings' && id === 'recPending' && fields['Status'] === 'Confirmed') {
      ctx.airtable.update = original; // one-shot
      ctx.airtable.create('WS_Bookings', {
        'Guest': [], 'Room': ['recR1'], 'Status': 'Confirmed', 'Booking Type': 'Hourly',
        'Check In': '2026-09-01T12:30:00.000Z', 'Check Out': '2026-09-01T13:30:00.000Z'
      });
    }
    return rec;
  };

  await send(GUEST_A_PHONE, '1');

  const pending = bookings(ctx).find(b => b.id === 'recPending');
  assert.strictEqual(pending.fields['Status'], 'Cancelled', 'the guest\'s own hold is rolled back');
  const competitor = bookings(ctx).find(b => b.id !== 'recPending');
  assert.strictEqual(competitor.fields['Status'], 'Confirmed', 'the competing booking stands');
  assert.strictEqual(guestRow(ctx, GUEST_A_PHONE).fields['Session State'], 'AWAITING_HOURLY_DETAILS');
  assert.match(texts(ctx, GUEST_A_PHONE), /fully booked/i);
  assert.ok(axiomEvents(ctx).includes('booking_race_lost'));
});

test('hourly: no competitor — the ordinary single-guest booking is unaffected', async () => {
  const ctx = { airtable: new MockAirtable(seedPendingHourly()), sends: [], axiom: [] };
  installFetch(ctx);

  await send(GUEST_A_PHONE, '1');

  const pending = bookings(ctx).find(b => b.id === 'recPending');
  assert.strictEqual(pending.fields['Status'], 'Confirmed');
  assert.deepStrictEqual(pending.fields['Room'], ['recR1']);
  assert.match(texts(ctx, GUEST_A_PHONE), /booked/i);
});

// ── P1b: fail-open on the blocking-bookings read ────────────────────────────

test('a failed blocking-bookings read refuses the room instead of treating it as free', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_A_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  // Match the exact OR-formula findAvailableRoom builds for BLOCKING_BOOKING_STATUSES.
  failNextGet(ctx, 'WS_Bookings', "OR({Status} = 'Enquiry', {Status} = 'Confirmed', {Status} = 'Checked In')");

  await send(GUEST_A_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  assert.strictEqual(bookings(ctx).length, 0, 'no booking created on a failed availability read — fails closed, not open');
  assert.match(texts(ctx, GUEST_A_PHONE), /fully booked/i, 'the guest is told no availability, not offered a room the check could not verify');
  assert.ok(axiomEvents(ctx).includes('availability_check_failed_closed'));
});

test('a genuinely free room still books normally once the read succeeds — the fail-closed path is not permanently sticky', async () => {
  // Sanity check that failNextGet's one-shot restore actually restores; if it
  // didn't, every subsequent call would also fail and this test would too.
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_A_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  await send(GUEST_A_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');
  assert.strictEqual(bookings(ctx).length, 1);
  assert.notStrictEqual(bookings(ctx)[0].fields['Status'], 'Cancelled');
});
