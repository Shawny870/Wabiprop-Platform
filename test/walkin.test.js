// test/walkin.test.js
// B7 (WALKIN) — the staff-initiated walk-in booking, end to end.
//
// The fixture replay harness drives one message against a fresh store and
// asserts a frozen outcome; that works for a guest turn, but a walk-in's
// interesting properties are all about WHO sent it and what the store looked
// like at the moment it landed — an unauthorised sender, an inactive seat, a
// room already held, a second walk-in racing the first. So these drive the real
// webhook against a persistent MockAirtable, the same approach hourly.status
// and autocheckout take.
//
// Seeded from live shapes, not invented ones: `Room 01`/`Room 02` with integer
// `Room Number` (live names are zero-padded, numbers are not), and the reception
// seat is 27825999279 — Eric's real number, which is ALREADY a registered
// cleaner and an active guest (F25/B11.5). That collision is now guaranteed
// rather than hypothetical, and two tests below exist only to pin it.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');

const STAFF_PHONE = '27825999279';   // holds the Reception seat (and is a cleaner, and a guest)
const OUTSIDER_PHONE = '27820000999';
const GUEST_PHONE = '27821234567';

function seed(overrides = {}) {
  return {
    WS_Properties: [
      {
        id: 'recP1',
        fields: {
          'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000',
          'City': 'Krugersdorp', 'Notify Phone': '27732273477',
          'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
        }
      },
      {
        id: 'recP2',
        fields: {
          'Property Name': 'Other Lodge', 'Phone Number ID': '222000222000',
          'Hourly Rate 1hr': 100, 'Hourly Rate 2hr': 200, 'Hourly Rate 3hr': 300
        }
      }
    ],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'] } },
      { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Room Number': 2, 'Status': 'Available', 'Property': ['recP1'] } },
      { id: 'recR9', fields: { 'Room Name': 'Room 09', 'Room Number': 9, 'Status': 'Available', 'Property': ['recP2'] } }
    ],
    WS_Roles: [
      {
        id: 'recRole1',
        fields: {
          'Role Label': 'Villa Liza Reception', 'Role Type': 'Reception',
          'Property': ['recP1'], 'Current Phone': STAFF_PHONE, 'Active': true
        }
      },
      // Blank rows exist in the live table — the lookup must not trip over them.
      { id: 'recRoleBlank', fields: {} }
    ],
    WS_Guests: [],
    WS_Bookings: [],
    WS_Cleaners: [],
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
const guests = ctx => ctx.airtable.tables['WS_Guests'] || [];
const room = (ctx, id) => ctx.airtable.tables['WS_Rooms'].find(r => r.id === id);
const texts = ctx => ctx.sends.map(s => s.body || '').join('\n---\n');

// ── The happy path ──────────────────────────────────────────────────────────

test('authorised staff walk-in creates a Checked In booking on the named room', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 1, 'exactly one booking');
  const b = bookings(ctx)[0].fields;

  assert.strictEqual(b['Status'], 'Checked In', 'created Checked In, not Confirmed');
  assert.strictEqual(b['Source'], 'Walk-in');
  assert.strictEqual(b['Logged By'], 'Manual');
  // Hourly, NOT the 'Walk-in' Booking Type option: EXTENSION_MS, B17's
  // room-night maths and findPendingHourlyBooking all read this field.
  assert.strictEqual(b['Booking Type'], 'Hourly');
  assert.deepStrictEqual(b['Room'], ['recR2'], 'the room staff named');
  assert.deepStrictEqual(b['WS_Property'], ['recP1'], 'property scoped from the seat');
  assert.strictEqual(b['Payment Status'], 'Unpaid');
  assert.ok(b['Booking Ref'], 'booking ref written back');
  assert.ok(b['Checked In At'], 'checked-in timestamp stamped');

  // Duration drives the window and the price — never hardcoded.
  const span = Date.parse(b['Check Out']) - Date.parse(b['Check In']);
  assert.strictEqual(span, 2 * 60 * 60 * 1000, 'check-out is exactly 2 hours after check-in');
  assert.strictEqual(b['Amount Due'], 250, 'the property\'s own 2hr rate');

  assert.strictEqual(room(ctx, 'recR2').fields['Status'], 'Occupied', 'room marked occupied');
  assert.strictEqual(room(ctx, 'recR1').fields['Status'], 'Available', 'the other room is untouched');

  assert.strictEqual(ctx.sends.length, 1, 'one reply, to the staff member only');
  assert.strictEqual(ctx.sends[0].to, STAFF_PHONE);
  assert.match(texts(ctx), /Walk-in recorded/);
  assert.match(texts(ctx), /Room 02/);
});

test('the space-separated `walk in` form books identically, end to end', async () => {
  // Parser coverage proves the grammar; this proves DISPATCH — that the global
  // guard is actually entered for this spelling and the booking is created,
  // which is the thing the device test was checking.
  const ctx = start();
  await send(STAFF_PHONE, 'Walk In Room 2 2hrs John Smith');

  assert.strictEqual(bookings(ctx).length, 1, 'the walk-in was created');
  const b = bookings(ctx)[0].fields;
  assert.strictEqual(b['Status'], 'Checked In');
  assert.strictEqual(b['Source'], 'Walk-in');
  assert.deepStrictEqual(b['Room'], ['recR2']);
  assert.strictEqual(b['Amount Due'], 250);
  assert.match(texts(ctx), /Walk-in recorded/);
});

test('the price comes from the property rate card, per duration', async () => {
  for (const [hours, expected] of [[1, 120], [2, 250], [3, 320]]) {
    const ctx = start();
    await send(STAFF_PHONE, `WALKIN ROOM 1 ${hours}HRS Test Guest`);
    assert.strictEqual(bookings(ctx)[0].fields['Amount Due'], expected, `${hours}hr rate`);
  }
});

test('rooms resolve by number, zero-padded name, or full name', async () => {
  for (const token of ['2', '02']) {
    const ctx = start();
    await send(STAFF_PHONE, `WALKIN ROOM ${token} 1HR Test Guest`);
    assert.strictEqual(bookings(ctx).length, 1, `token: ${token}`);
    assert.deepStrictEqual(bookings(ctx)[0].fields['Room'], ['recR2'], `token: ${token}`);
  }
});

// ── The ambiguity, at handler level ─────────────────────────────────────────

test('ROOM 12 2HRS books room 12 — the duration digit never selects the room', async () => {
  // The live-data hazard, end to end rather than at the parser: roomMatchesText
  // would match Room 02 on the trailing "2" of "2HRS".
  const ctx = start({
    WS_Rooms: [
      { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Room Number': 2, 'Status': 'Available', 'Property': ['recP1'] } },
      { id: 'recR12', fields: { 'Room Name': 'Room 12', 'Room Number': 12, 'Status': 'Available', 'Property': ['recP1'] } }
    ]
  });
  await send(STAFF_PHONE, 'WALKIN ROOM 12 2HRS John Smith');

  assert.deepStrictEqual(bookings(ctx)[0].fields['Room'], ['recR12'], 'room 12, not room 02');
  assert.strictEqual(room(ctx, 'recR2').fields['Status'], 'Available', 'room 02 untouched');
});

// ── Authorisation ───────────────────────────────────────────────────────────

test('an unauthorised number gets the ordinary guest flow and creates no booking', async () => {
  const ctx = start();
  await send(OUTSIDER_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 0, 'no booking created');
  assert.strictEqual(room(ctx, 'recR2').fields['Status'], 'Available');
  // The no-leak rule: nothing in the reply may hint that WALKIN is a command.
  const out = texts(ctx);
  assert.doesNotMatch(out, /walk-?in/i, 'reply must not mention walk-ins');
  assert.doesNotMatch(out, /not authorised|unauthorised|permission|staff/i, 'no refusal language');
});

test('an unauthorised number sending WALKIN is answered IDENTICALLY to one sending anything else', async () => {
  // The strongest form of the no-leak rule: the two conversations must be
  // byte-identical, so the reply itself carries no signal.
  const a = start();
  await send(OUTSIDER_PHONE, 'WALKIN ROOM 2 2HRS John Smith');
  const b = start();
  await send(OUTSIDER_PHONE, 'hello there');

  assert.deepStrictEqual(
    a.sends.map(s => [s.to, s.body]),
    b.sends.map(s => [s.to, s.body]),
    'a stranger cannot tell WALKIN exists'
  );
});

test('an inactive seat is not authorisation', async () => {
  const s = seed();
  s.WS_Roles[0].fields['Active'] = false;
  const ctx = start({ WS_Roles: s.WS_Roles });
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 0, 'no booking from a deactivated seat');
  assert.doesNotMatch(texts(ctx), /walk-?in/i);
});

test('a Cleaner seat cannot create bookings', async () => {
  // A cleaner seat exists to RECEIVE dispatch. Selling a room is not its job.
  const s = seed();
  s.WS_Roles[0].fields['Role Type'] = 'Cleaner';
  const ctx = start({ WS_Roles: s.WS_Roles });
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 0);
  assert.doesNotMatch(texts(ctx), /walk-?in/i);
});

test('the seat is matched however the number is written in Airtable', async () => {
  const s = seed();
  s.WS_Roles[0].fields['Current Phone'] = '0825999279'; // local format, same human
  const ctx = start({ WS_Roles: s.WS_Roles });
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 1, 'local-format seat number still authorises');
});

// ── Property scoping ────────────────────────────────────────────────────────

test('a room belonging to another property is not bookable', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'WALKIN ROOM 9 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 0, 'Room 09 belongs to recP2');
  assert.match(texts(ctx), /No room matching/);
});

test('a seat for one property cannot book through another property\'s number', async () => {
  // The seat says recP2; the message arrived on recP1's WhatsApp number. Both
  // readings are defensible, so it fails closed rather than guessing.
  const s = seed();
  s.WS_Roles[0].fields['Property'] = ['recP2'];
  const ctx = start({ WS_Roles: s.WS_Roles });
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 0);
  assert.match(texts(ctx), /different property/i);
});

// ── Availability: one path, no substitution ─────────────────────────────────

test('a room already held for an overlapping window is refused, not substituted', async () => {
  const now = Date.now();
  const ctx = start({
    WS_Bookings: [{
      id: 'recExisting1',
      fields: {
        'Room': ['recR2'], 'Status': 'Confirmed', 'Booking Type': 'Hourly',
        'Check In': new Date(now - 30 * 60 * 1000).toISOString(),
        'Check Out': new Date(now + 90 * 60 * 1000).toISOString()
      }
    }]
  });
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 1, 'no second booking — the existing one only');
  // The staff member is standing at a specific door: silently moving them to
  // Room 01 would be worse than refusing.
  assert.strictEqual(room(ctx, 'recR1').fields['Status'], 'Available', 'no substitution to another room');
  assert.match(texts(ctx), /isn't free/);
});

test('a non-overlapping earlier booking on the same room does not block', async () => {
  const now = Date.now();
  const ctx = start({
    WS_Bookings: [{
      id: 'recExisting2',
      fields: {
        'Room': ['recR2'], 'Status': 'Checked Out', 'Booking Type': 'Hourly',
        'Check In': new Date(now - 5 * 60 * 60 * 1000).toISOString(),
        'Check Out': new Date(now - 3 * 60 * 60 * 1000).toISOString()
      }
    }]
  });
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 2, 'the walk-in is created');
  assert.strictEqual(bookings(ctx)[1].fields['Status'], 'Checked In');
});

test('two walk-ins on the same room: the second is refused and books nothing', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');
  await send(STAFF_PHONE, 'WALKIN ROOM 2 1HR Jane Doe');

  const live = bookings(ctx).filter(b => b.fields['Status'] !== 'Cancelled');
  assert.strictEqual(live.length, 1, 'only the first walk-in survives');
  assert.strictEqual(live[0].fields['Guest'].length, 1);
  assert.match(texts(ctx), /isn't free/);
});

// ── Guest identity ──────────────────────────────────────────────────────────

test('a name-only walk-in books, with no phone and no repeat-guest tracking', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 1, 'creation is never blocked on a missing phone');
  const g = guests(ctx).find(g => g.fields['Guest Name'] === 'John Smith');
  assert.ok(g, 'guest record created from the name alone');
  assert.strictEqual(g.fields['Phone Number'], undefined, 'no phone invented');
  assert.strictEqual(g.fields['Guest Type'], 'Walk-in');
  // The staff number must never end up on the guest record: the auto-checkout
  // cron messages the guest, and reception would receive it.
  assert.notStrictEqual(g.fields['Phone Number'], STAFF_PHONE);
});

test('a supplied phone is stored normalised and reuses an existing guest', async () => {
  const ctx = start({
    WS_Guests: [{
      id: 'recG1',
      fields: { 'Guest Name': 'Thabo Mokoena', 'Phone Number': GUEST_PHONE, 'Session State': 'NEW' }
    }]
  });
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS T Mokoena 0821234567');

  assert.strictEqual(guests(ctx).length, 1, 'existing guest reused, not duplicated');
  const g = guests(ctx)[0];
  assert.strictEqual(g.fields['Guest Name'], 'Thabo Mokoena', 'existing name not overwritten by a desk abbreviation');
  assert.strictEqual(g.fields['Session State'], 'CHECKED_IN');
  assert.deepStrictEqual(bookings(ctx)[0].fields['Guest'], ['recG1']);
});

test('a nameless command is refused and books nothing', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS');

  assert.strictEqual(bookings(ctx).length, 0);
  assert.strictEqual(room(ctx, 'recR2').fields['Status'], 'Available');
  assert.match(texts(ctx), /needs the guest's name/);
});

// ── Refusals that must not write ────────────────────────────────────────────

test('4 hours is refused with no booking and no room change', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'WALKIN ROOM 2 4HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 0);
  assert.strictEqual(guests(ctx).length, 0, 'no guest record for a refused walk-in');
  assert.strictEqual(room(ctx, 'recR2').fields['Status'], 'Available');
  assert.match(texts(ctx), /1, 2 or 3 hours only/);
});

test('an unknown room is refused with usage help, no writes', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'WALKIN ROOM 77 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 0);
  assert.strictEqual(guests(ctx).length, 0);
  assert.match(texts(ctx), /No room matching/);
});

test('a property with no hourly rates fails closed — no R0 walk-in', async () => {
  const s = seed();
  delete s.WS_Properties[0].fields['Hourly Rate 2hr'];
  const ctx = start({ WS_Properties: s.WS_Properties });
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 0, 'never priced at zero');
  assert.match(texts(ctx), /rates aren't set up/);
});

test('a malformed walk-in from authorised staff gets usage help, not the guest greeting', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'WALKIN ROOM 2');

  assert.strictEqual(bookings(ctx).length, 0);
  assert.match(texts(ctx), /Walk-in format/);
});

// ── Precedence: the phone that is staff AND cleaner AND guest ───────────────

test('WALKIN from a phone that is also a cleaner books the room instead of marking it clean', async () => {
  // The B11.5 collision, now guaranteed by live data: 27825999279 holds the
  // Reception seat AND is a registered cleaner. Room 02 is mid-clean and is the
  // room being sold — a real turnaround, which BOOKABLE_ROOM_STATUSES allows.
  // `senderIsCleanerNamingRoom` matches \b2\b anywhere in the message, so it
  // matches the "2" in this very command; if it is reached first it marks Room
  // 02 Available and the walk-in never happens. Registering WALKIN ahead of it
  // is the whole fix, and this test is the only thing holding that order.
  const ctx = start({
    WS_Cleaners: [{
      id: 'recC1',
      fields: { 'Cleaner Name': 'Eric', 'Phone Number': STAFF_PHONE, 'Active': true, 'Assigned Property': ['recP1'] }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'] } },
      { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Room Number': 2, 'Status': 'Cleaning', 'Property': ['recP1'] } }
    ]
  });
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(bookings(ctx).length, 1, 'the walk-in won');
  assert.deepStrictEqual(bookings(ctx)[0].fields['Room'], ['recR2']);
  // Occupied, NOT Available: 'Available' is what cleanerRoomReply would have
  // written, so this assertion distinguishes the two outcomes precisely.
  assert.strictEqual(room(ctx, 'recR2').fields['Status'], 'Occupied', 'sold, not marked clean');
});

test('the same phone can still do ordinary cleaner work — WALKIN did not swallow it', async () => {
  // The guard declines everything that is not a walk-in command, so registering
  // it first must not cost the cleaner globals their traffic.
  const ctx = start({
    WS_Cleaners: [{
      id: 'recC1',
      fields: { 'Cleaner Name': 'Eric', 'Phone Number': STAFF_PHONE, 'Active': true, 'Assigned Property': ['recP1'] }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Cleaning', 'Property': ['recP1'] } },
      { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Room Number': 2, 'Status': 'Available', 'Property': ['recP1'] } }
    ]
  });
  await send(STAFF_PHONE, 'done');

  assert.strictEqual(room(ctx, 'recR1').fields['Status'], 'Available', 'cleaner DONE still resolves the room');
  assert.strictEqual(bookings(ctx).length, 0);
});

test('staff are not treated as new guests — no POPIA consent notice on a walk-in', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'WALKIN ROOM 2 2HRS John Smith');

  assert.strictEqual(ctx.sends.length, 1, 'exactly one message back');
  assert.doesNotMatch(texts(ctx), /consent|POPIA|personal information/i);
});
