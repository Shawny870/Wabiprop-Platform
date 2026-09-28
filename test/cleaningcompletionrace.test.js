// test/cleaningcompletionrace.test.js
// D3 (gap-and-failure audit, this session) — cleaning-completion race
// condition. resolveRoomClean() (webhook.js) previously checked a room's
// Status against an already-fetched, possibly-stale value with no re-query
// immediately before the write. Two different phone numbers sending DONE
// close enough together could both pass the guard before either write
// landed, and the second write silently overwrote the first cleaner's
// 'Cleaned By'/'Cleaning Completed At' — no error, no log, nothing to
// notice.
//
// Fix is two layers (see resolveRoomClean's own header comment for why):
//   Layer 1 — re-query Status immediately before proceeding, not the
//   caller's stale top-level fetch.
//   Layer 2 — write-then-verify on the booking's Cleaning Completed At: the
//   only race-closing check Airtable's API actually supports (no
//   conditional/optimistic-concurrency PATCH exists on their REST API).
//
// Racing two real concurrent invocations isn't reproducible deterministically
// through Node's single-threaded event loop, so the race is constructed
// precisely instead — same technique already established in this codebase
// for the P1a booking race (test/booking-race.test.js): intercept the
// write, and in the instant between that write and this fix's own
// post-write verify-read, inject a competing write directly into the store.
// This exercises exactly the window the fix closes, deterministically.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable, metaTextPayload, makeRes } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');

const CLEANER_A_PHONE = '27821110001';
const CLEANER_B_PHONE = '27821110002';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const agoIso = ms => new Date(Date.now() - ms).toISOString();

function seed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Cleaning', 'Property': ['recP1'], 'Active': true, 'Cleaning Started At': agoIso(60 * MIN) } }
    ],
    WS_Cleaners: [
      { id: 'recCA', fields: { 'Cleaner Name': 'Rose', 'Phone Number': CLEANER_A_PHONE, 'Active': true, 'Assigned Property': ['recP1'] } },
      { id: 'recCB', fields: { 'Cleaner Name': 'Thabo', 'Phone Number': CLEANER_B_PHONE, 'Active': true, 'Assigned Property': ['recP1'] } }
    ],
    WS_Bookings: [{
      id: 'recB1',
      fields: {
        'Booking Ref': 'WS-AAA001', 'Room': ['recR1'], 'Status': 'Checked Out',
        'Booking Type': 'Overnight', 'WS_Property': ['recP1'],
        'Check In': agoIso(26 * HOUR), 'Check Out': agoIso(60 * MIN)
      }
    }],
    WS_Guests: [],
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
const bookingRow = ctx => ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'recB1').fields;
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '').join('\n---\n');
const axiomEvents = ctx => ctx.axiom.map(e => e.event);

// Injects a one-shot competing update the FIRST time `update` is called
// matching `table` + `id`. Applies the real write first, then immediately
// applies `competingFields` on top — modelling "cleaner B's DONE landed in
// the gap between A's write and A's own verify-read." Fires exactly once,
// then restores the original method.
function raceOnNextUpdate(ctx, table, id, competingFields) {
  const original = ctx.airtable.update.bind(ctx.airtable);
  ctx.airtable.update = (t, recId, fields) => {
    const result = original(t, recId, fields);
    if (t === table && recId === id) {
      ctx.airtable.update = original; // one-shot
      original(table, recId, competingFields);
    }
    return result;
  };
}

test('two near-simultaneous DONE replies for the same room: only one completion survives, the loser is told, not silently overwritten', async () => {
  const ctx = start();

  // Cleaner A's DONE is about to write Cleaning Completed At/Cleaned By.
  // Inject "cleaner B's" competing completion the instant A's own write
  // lands — before A's new Layer-2 verify-read runs.
  raceOnNextUpdate(ctx, 'WS_Bookings', 'recB1', {
    'Cleaning Completed At': new Date(Date.now() + 1000).toISOString(), // provably later than A's
    'Cleaned By': 'Thabo'
  });

  await send(CLEANER_A_PHONE, 'DONE');

  // The record reflects the competing (later) write, not A's — A's own
  // completion was NOT silently allowed to stand as if nothing happened.
  const b = bookingRow(ctx);
  assert.strictEqual(b['Cleaned By'], 'Thabo', 'the competing write is what survived, matching what Airtable actually holds');

  // A was told they lost the race — not silence, not a false success.
  assert.match(texts(ctx, CLEANER_A_PHONE), /already marked clean/i, 'the loser gets an explicit message, not the success reply');
  assert.doesNotMatch(texts(ctx, CLEANER_A_PHONE), /Thank you!.*marked as clean/i, 'the loser must NOT also get the normal success message');

  // The loser's request must not ALSO fire the normal owner notification —
  // only one real completion happened from the system's point of view.
  assert.ok(!axiomEvents(ctx).includes('cleaning_job_completed'), 'no completion metric logged for the request that lost the race');
  assert.ok(axiomEvents(ctx).includes('cleaning_complete_lost_race_layer2'), 'the race loss itself is logged, not silent');
});

test('the winner of a race (no competing write) gets the normal success flow, unaffected by the fix', async () => {
  const ctx = start();
  await send(CLEANER_A_PHONE, 'DONE');

  const b = bookingRow(ctx);
  assert.strictEqual(b['Cleaned By'], 'Rose');
  assert.match(texts(ctx, CLEANER_A_PHONE), /Thank you!.*marked as clean/i);
  assert.ok(axiomEvents(ctx).includes('cleaning_job_completed'));
});

// Makes the NEXT matching GET (by table + a substring of the decoded formula)
// return `replacementRecords` instead of delegating to the mock's real
// current state — models "the room's Status changed in the instant between
// cleanerDone's top-level fetch and resolveRoomClean's own re-query."
// Fires exactly once, then restores the original fetch.
function raceOnNextGet(ctx, table, formulaContains, replacementRecords) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if ((u.pathname.includes(encodeURIComponent(table)) || u.pathname.includes(table))) {
      const formula = decodeURIComponent(u.searchParams.get('filterByFormula') || '');
      if (formula.includes(formulaContains)) {
        global.fetch = originalFetch; // one-shot
        return {
          status: 200, ok: true,
          json: async () => ({ records: replacementRecords.map(r => ({ id: r.id, fields: r.fields })) }),
          text: async () => ''
        };
      }
    }
    return originalFetch(url, opts);
  };
}

test('Layer 1: a room that flips to Available between cleanerDone\'s fetch and resolveRoomClean\'s re-query is reported with who/when, not the generic "nothing to clean" message', async () => {
  const completedAt = agoIso(30 * 1000);
  const ctx = start({
    WS_Bookings: [{
      id: 'recB1',
      fields: {
        'Booking Ref': 'WS-AAA001', 'Room': ['recR1'], 'Status': 'Checked Out',
        'Booking Type': 'Overnight', 'WS_Property': ['recP1'],
        'Check In': agoIso(26 * HOUR), 'Check Out': agoIso(90 * MIN),
        // Already completed by "cleaner A" a moment ago — cleanerDone's own
        // top-level query (seed still shows the room as 'Cleaning') hasn't
        // caught up yet, exactly the window Layer 1 exists to close.
        'Cleaning Completed At': completedAt, 'Cleaned By': 'Rose'
      }
    }]
  });

  // resolveRoomClean's Layer-1 re-query is a RECORD_ID() lookup on WS_Rooms —
  // intercept that specific call to return the room as already Available,
  // simulating the race window deterministically rather than hoping for
  // real timing.
  raceOnNextGet(ctx, 'WS_Rooms', 'RECORD_ID', [
    { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }
  ]);

  await send(CLEANER_B_PHONE, 'DONE');

  const out = texts(ctx, CLEANER_B_PHONE);
  assert.match(out, /already marked clean/i, 'the specific, informative message fires');
  assert.match(out, /Rose/, 'attributes to who actually completed it');
  assert.doesNotMatch(out, /No rooms currently marked for cleaning/i, 'must NOT fall back to the generic message when a real explanation is available');
});
