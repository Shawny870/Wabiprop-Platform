// test/money-path-checks.test.js
// PR 3 — money-path idempotency and unchecked writes.
//
// 3a: extendStay had zero idempotency guard. paidBooking's exact pattern
// (refuse a repeat write once a terminal state is reached) does NOT transfer:
// extensions are locked (16 July) as repeatable and uncapped, so there is no
// "already extended" state to refuse against — a guard shaped like PAID's
// would either do nothing or, built carelessly, break the locked behaviour.
// What IS built instead: an optimistic-concurrency re-check (same idiom PR1
// used for the booking-availability race) that catches a CONCURRENT duplicate
// delivery — the threat actually named for this fix ("a slow handler can
// cause Meta to retry before the first 200 lands") — while leaving genuine,
// well-separated repeat extensions untouched. The residual gap (a duplicate
// arriving well after the first has already completed, indistinguishable from
// a deliberate second EXTEND without the inbound message's own id) is real
// and stated in the code and the PR, not silently claimed as closed.
//
// 3b: paidBooking's write was unconditional — Reception could be told
// "Settled in full" while the PATCH had actually failed.
//
// 3c: walkinBooking's own three unchecked writes (Booking Ref writeback,
// rollback-to-Cancelled, room->Occupied) are fixed here, in the same
// neighbourhood as 3a/3b. Its "reference implementation" claim (made when
// WALKIN first shipped) was only half true — the two airtableCreate guards
// were real, the three airtableUpdate calls were not.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';
const RECEPTION_PHONE = '27825999279';

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
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Occupied', 'Property': ['recP1'] } },
      { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Room Number': 2, 'Status': 'Available', 'Property': ['recP1'] } }
    ],
    WS_Rates: [
      { id: 'recRateCouple', fields: { 'Rate Name': 'Couple', 'Occupancy Type': 'Couple', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Roles: [{
      id: 'recRole1',
      fields: { 'Role Label': 'Villa Liza Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION_PHONE, 'Active': true }
    }],
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

async function send(from, text, wamid) {
  const res = makeRes();
  await handler({ method: 'POST', body: metaTextPayload(from, text, wamid) }, res);
  return res;
}

const bookingRow = (ctx, id) => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id).fields;
const roomRow = (ctx, id) => ctx.airtable.tables['WS_Rooms'].find(r => r.id === id).fields;
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '').join('\n---\n');
const axiomEvents = ctx => ctx.axiom.map(e => e.event);

// One-shot: makes ONE matching write (create or update) return an Airtable
// error body instead of delegating to the mock, then restores.
function failNextWrite(ctx, { method, pathIncludes }) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if ((opts.method || 'GET').toUpperCase() === method && u.pathname.includes(pathIncludes)) {
      global.fetch = originalFetch; // one-shot
      return { status: 422, ok: false, json: async () => ({ error: { type: 'INVALID_REQUEST', message: 'simulated' } }), text: async () => 'simulated' };
    }
    return originalFetch(url, opts);
  };
}

// ── 3a: extendStay idempotency ──────────────────────────────────────────────

function seedCheckedInBooking(fields = {}) {
  return baseSeed({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN' } }],
    WS_Bookings: [{
      id: 'recBook1',
      fields: {
        'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Checked In',
        'Booking Type': 'Overnight', 'Amount Due': 400, 'Rate Applied': ['recRateCouple'],
        'Check In': '2026-08-05T12:00:00.000Z', 'Check Out': '2026-08-06T08:00:00.000Z',
        'WS_Property': ['recP1'], 'Checked In At': '2026-08-05T12:05:00.000Z',
        ...fields
      }
    }]
  });
}

// Simulates a concurrent duplicate delivery: by extendStay's SECOND read of
// this guest's Checked-In bookings (the new re-check, not the initial read),
// a competing write has already landed on the exact record being extended —
// exactly what happens when Meta retries a slow-to-200 webhook and both
// invocations end up racing the same booking.
function injectConcurrentDuplicateOnSecondRead(ctx, table, bookingId, duplicateFields) {
  const original = ctx.airtable.list.bind(ctx.airtable);
  let count = 0;
  ctx.airtable.list = (t, formula) => {
    if (t === table) {
      count++;
      if (count === 2) {
        ctx.airtable.update(table, bookingId, duplicateFields);
        ctx.airtable.list = original; // one-shot, restore after triggering
      }
    }
    return original(t, formula);
  };
}

test('a concurrent duplicate delivery is caught: no double-charge, no double-extend', async () => {
  const ctx = { airtable: new MockAirtable(seedCheckedInBooking()), sends: [], axiom: [] };
  installFetch(ctx);

  // The "duplicate" has already pushed Check Out to +24h and charged R400.
  injectConcurrentDuplicateOnSecondRead(ctx, 'WS_Bookings', 'recBook1', {
    'Check Out': '2026-08-07T08:00:00.000Z', 'Amount Due': 800, 'Extension Owner Notified': true
  });

  await send(GUEST_PHONE, 'extend');

  const b = bookingRow(ctx, 'recBook1');
  // Exactly what the "duplicate" left behind — NOT extended a second time.
  assert.strictEqual(b['Check Out'], '2026-08-07T08:00:00.000Z');
  assert.strictEqual(b['Amount Due'], 800, 'not 1200 — the second increment never happened');
  assert.match(texts(ctx, GUEST_PHONE), /See you at|extended|confirmed/i, 'a courteous reply, not silence or an error');
  assert.ok(axiomEvents(ctx).includes('extend_duplicate_delivery_suspected'));
});

test('the owner is not double-notified when a duplicate delivery is caught', async () => {
  const ctx = { airtable: new MockAirtable(seedCheckedInBooking()), sends: [], axiom: [] };
  installFetch(ctx);
  injectConcurrentDuplicateOnSecondRead(ctx, 'WS_Bookings', 'recBook1', {
    'Check Out': '2026-08-07T08:00:00.000Z', 'Amount Due': 800, 'Extension Owner Notified': true
  });

  await send(GUEST_PHONE, 'extend');

  assert.strictEqual(ctx.sends.filter(s => s.to === '27830000001').length, 0, 'the caught duplicate never reaches the owner-notify step');
});

test('a genuine, well-separated second extension still works — the locked repeatable behaviour is not broken', async () => {
  // No race injected: two ordinary, fully-sequential EXTEND messages, exactly
  // what a guest asking for more time twice looks like. This is the test that
  // proves the guard didn't accidentally undo the 16 July lock.
  const ctx = { airtable: new MockAirtable(seedCheckedInBooking()), sends: [], axiom: [] };
  installFetch(ctx);

  await send(GUEST_PHONE, 'extend');
  const afterFirst = bookingRow(ctx, 'recBook1');
  assert.strictEqual(afterFirst['Amount Due'], 800, 'first extension charged normally');

  await send(GUEST_PHONE, 'extend');
  const afterSecond = bookingRow(ctx, 'recBook1');
  assert.strictEqual(afterSecond['Amount Due'], 1200, 'second, genuinely separate extension ALSO charged — not blocked');
  assert.strictEqual(axiomEvents(ctx).filter(e => e === 'extend_duplicate_delivery_suspected').length, 0, 'neither was mistaken for a duplicate');
});

// ── 3b (this PR): post-completion duplicate EXTEND, closed via wamid ───────

test('a duplicate EXTEND arriving after the first one already fully completed is caught, no second charge', async () => {
  const ctx = { airtable: new MockAirtable(seedCheckedInBooking()), sends: [], axiom: [] };
  installFetch(ctx);

  await send(GUEST_PHONE, 'extend', 'wamid.dup.1'); // completes fully
  const afterFirst = bookingRow(ctx, 'recBook1');
  assert.strictEqual(afterFirst['Amount Due'], 800);

  await send(GUEST_PHONE, 'extend', 'wamid.dup.1'); // same wamid, redelivered well after completion

  const afterDup = bookingRow(ctx, 'recBook1');
  assert.strictEqual(afterDup['Amount Due'], 800, 'not 1200 — the redelivered duplicate did not charge again');
  assert.strictEqual(afterDup['Check Out'], afterFirst['Check Out'], 'not extended a second time');
  assert.ok(axiomEvents(ctx).includes('extend_duplicate_wamid_suspected'));
  assert.match(texts(ctx, GUEST_PHONE), /See you at|extended|confirmed/i, 'a courteous reply, not silence or an error');
});

test('a genuine second extension with a different wamid is not mistaken for the post-completion duplicate', async () => {
  const ctx = { airtable: new MockAirtable(seedCheckedInBooking()), sends: [], axiom: [] };
  installFetch(ctx);

  await send(GUEST_PHONE, 'extend', 'wamid.a');
  await send(GUEST_PHONE, 'extend', 'wamid.b');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Amount Due'], 1200, 'both extensions charged — different wamids, both real');
  assert.strictEqual(axiomEvents(ctx).filter(e => e === 'extend_duplicate_wamid_suspected').length, 0);
});

test('nothing to extend still short-circuits before the guard runs, unchanged', async () => {
  const ctx = { airtable: new MockAirtable(baseSeed({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN' } }]
  })), sends: [], axiom: [] };
  installFetch(ctx);

  await send(GUEST_PHONE, 'extend');
  assert.match(texts(ctx, GUEST_PHONE), /check.?in|check.?out|reply/i);
  assert.strictEqual(axiomEvents(ctx).includes('extend_duplicate_delivery_suspected'), false);
});

// ── 3b: paidBooking's write is now checked ──────────────────────────────────

function seedPayableBooking(fields = {}) {
  return baseSeed({
    WS_Bookings: [{
      id: 'recBook1',
      fields: {
        'Booking Ref': 'WS-AAA001', 'Room': ['recR2'], 'Status': 'Checked Out',
        'Booking Type': 'Overnight', 'Amount Due': 400, 'Payment Status': 'Unpaid',
        'WS_Property': ['recP1'], 'Check In': '2026-08-05T12:00:00.000Z', 'Check Out': '2026-08-06T08:00:00.000Z',
        ...fields
      }
    }]
  });
}

test('a failed payment write does not log payment_recorded or confirm settlement', async () => {
  const ctx = start(seedPayableBooking());
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recBook1' });

  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Payment Status'], 'Unpaid', 'the failed write never landed');
  assert.strictEqual(axiomEvents(ctx).includes('payment_recorded'), false, 'success is not logged for a failed write');
  assert.ok(axiomEvents(ctx).includes('payment_write_failed'));
  assert.doesNotMatch(texts(ctx, RECEPTION_PHONE), /Settled in full/, 'Reception is never told it settled when it did not');
  assert.match(texts(ctx, RECEPTION_PHONE), /went wrong|try.*again/i);
});

test('after a failed write, a re-send is not blocked by the idempotency guard — the booking never actually became Paid', async () => {
  const ctx = start(seedPayableBooking());
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recBook1' });
  await send(RECEPTION_PHONE, 'PAID ROOM 2 400'); // fails

  await send(RECEPTION_PHONE, 'PAID ROOM 2 400'); // retry, no injected failure this time

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Payment Status'], 'Paid', 'the retry succeeds normally');
  assert.match(texts(ctx, RECEPTION_PHONE), /Settled in full/);
});

test('a successful payment write is completely unaffected by the new check', async () => {
  const ctx = start(seedPayableBooking());
  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Payment Status'], 'Paid');
  assert.ok(axiomEvents(ctx).includes('payment_recorded'));
  assert.match(texts(ctx, RECEPTION_PHONE), /Settled in full/);
});

// ── 3c: walkinBooking's three writes ────────────────────────────────────────

test('Booking Ref writeback failing does not break the walk-in — booking still completes and confirms', async () => {
  const ctx = start({});
  // Booking Ref writes are a PATCH to WS_Bookings/<id> whose body contains
  // "Booking Ref" — the only PATCH in walkinBooking's success path that does.
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if ((opts.method || '').toUpperCase() === 'PATCH' && u.pathname.includes('WS_Bookings') && String(opts.body).includes('Booking Ref')) {
      global.fetch = originalFetch;
      return { status: 500, ok: false, json: async () => ({ error: { type: 'SERVER_ERROR', message: 'simulated' } }), text: async () => 'simulated' };
    }
    return originalFetch(url, opts);
  };

  await send(RECEPTION_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  const bookings = ctx.airtable.tables['WS_Bookings'];
  assert.strictEqual(bookings.length, 1, 'the booking exists');
  assert.strictEqual(bookings[0].fields['Status'], 'Checked In', 'and is fully correct otherwise');
  assert.ok(axiomEvents(ctx).includes('walkin_bookingref_writeback_failed'));
  assert.match(texts(ctx, RECEPTION_PHONE), /Walk-in recorded/, 'the guest-visible confirmation still fires — bookingRef is computed locally, not read back from the failed write');
});

test('room->Occupied write failing does not break the walk-in — booking still confirms, failure is logged', async () => {
  const ctx = start({});
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if ((opts.method || '').toUpperCase() === 'PATCH' && u.pathname.includes('WS_Rooms') && String(opts.body).includes('Occupied')) {
      global.fetch = originalFetch;
      return { status: 500, ok: false, json: async () => ({ error: { type: 'SERVER_ERROR', message: 'simulated' } }), text: async () => 'simulated' };
    }
    return originalFetch(url, opts);
  };

  await send(RECEPTION_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 1, 'the booking still exists and completed');
  assert.ok(axiomEvents(ctx).includes('walkin_room_status_write_failed'));
  assert.match(texts(ctx, RECEPTION_PHONE), /Walk-in recorded/, 'the guest is checked in regardless — the booking, not the room label, is the source of truth');
});

test('a rollback write that itself fails (room lost the race AND Cancelled fails to write) is logged loud', async () => {
  const ctx = start({});
  // The room must be genuinely FREE at walkinBooking's first availability
  // check (or it never reaches create at all) — the competitor has to land in
  // the gap AFTER create, exactly where the still-free re-check looks, same
  // race-injection technique as test/booking-race.test.js. Intercepting
  // create (rather than seeding a pre-existing conflict) is what reproduces
  // that gap precisely.
  const originalCreate = ctx.airtable.create.bind(ctx.airtable);
  ctx.airtable.create = (t, fields) => {
    const rec = originalCreate(t, fields);
    if (t === 'WS_Bookings') {
      ctx.airtable.create = originalCreate; // one-shot
      originalCreate('WS_Bookings', {
        'Room': ['recR2'], 'Status': 'Confirmed', 'Booking Type': 'Hourly',
        'Check In': new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        'Check Out': new Date(Date.now() + 90 * 60 * 1000).toISOString()
      });
    }
    return rec;
  };
  // Room 02 is taken by the time walkinBooking's own still-free re-check runs,
  // triggering the rollback path. Fail THAT specific PATCH (Status: Cancelled).
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if ((opts.method || '').toUpperCase() === 'PATCH' && u.pathname.includes('WS_Bookings') && String(opts.body).includes('Cancelled')) {
      global.fetch = originalFetch;
      return { status: 500, ok: false, json: async () => ({ error: { type: 'SERVER_ERROR', message: 'simulated' } }), text: async () => 'simulated' };
    }
    return originalFetch(url, opts);
  };

  await send(RECEPTION_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.ok(axiomEvents(ctx).includes('booking_rollback_failed'), 'the failed rollback is visible, not swallowed');
  assert.match(texts(ctx, RECEPTION_PHONE), /isn't free/, 'the sender is still told the truth — the room was taken — regardless of the rollback write outcome');
});

test('walkinBooking end-to-end success is completely unaffected by the three new checks', async () => {
  const ctx = start({});
  await send(RECEPTION_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  const b = ctx.airtable.tables['WS_Bookings'][0].fields;
  assert.strictEqual(b['Status'], 'Checked In');
  assert.ok(b['Booking Ref']);
  assert.strictEqual(roomRow(ctx, 'recR2')['Status'], 'Occupied');
  assert.strictEqual(
    ['walkin_bookingref_writeback_failed', 'walkin_room_status_write_failed', 'booking_rollback_failed']
      .filter(e => axiomEvents(ctx).includes(e)).length,
    0,
    'none of the new failure events fire on a clean run'
  );
});
