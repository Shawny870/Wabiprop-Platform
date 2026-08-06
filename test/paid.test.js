// test/paid.test.js
// B8 (PAID) — reception-confirmed payment at checkout.
//
// Two halves, both here because the command and the push are one feature:
//   · the `PAID ROOM <n> <amount>` grammar, pure and Airtable-free;
//   · the checkout push + the write path, driven through the real webhook and
//     the real cron against a persistent MockAirtable.
//
// Seeded from live shapes: `Room 01`/`Room 02` with integer `Room Number`, and
// the Reception seat is 27825999279 — the live seat number, which is also a
// registered cleaner and an active guest (F25/B11.5). Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const handler = wh;
const { parsePaidCommand } = wh;

const RECEPTION_PHONE = '27825999279';
const OUTSIDER_PHONE = '27820000999';
const GUEST_PHONE = '27821234567';

// ── Grammar ─────────────────────────────────────────────────────────────────

test('PAID ROOM <n> <amount> parses, in the shapes reception actually types', () => {
  const expected = { ok: true, roomToken: '2', amount: 500, method: null };
  for (const form of [
    'PAID ROOM 2 500', 'paid room 2 500', 'Paid Room 2 R500',
    'paid room 2 500.00', 'paid room 2 500,00', 'paid room2 500', '  PAID  ROOM  2   R 500  '
  ]) {
    assert.deepStrictEqual(parsePaidCommand(form), expected, `form: ${form}`);
  }
});

test('an optional payment method is picked up and normalised to the live enum', () => {
  for (const [written, expected] of [['cash', 'Cash'], ['EFT', 'EFT'], ['Card', 'Card']]) {
    assert.deepStrictEqual(
      parsePaidCommand(`paid room 2 500 ${written}`),
      { ok: true, roomToken: '2', amount: 500, method: expected },
      `method: ${written}`
    );
  }
});

test('the ROOM keyword is mandatory — two bare numbers are refused, not guessed', () => {
  // Rooms are numbered 1-12 live, so `PAID 2 500` could equally mean room 2 for
  // R500 or room 500 (nonexistent) — and the wrong reading books money against
  // the wrong guest's stay.
  assert.deepStrictEqual(parsePaidCommand('PAID 2 500'), { ok: false, reason: 'bad_syntax' });
  assert.deepStrictEqual(parsePaidCommand('PAID 500'), { ok: false, reason: 'bad_syntax' });
});

test('a zero or missing amount is refused', () => {
  assert.deepStrictEqual(parsePaidCommand('paid room 2 0'), { ok: false, reason: 'bad_amount' });
  assert.deepStrictEqual(parsePaidCommand('paid room 2'), { ok: false, reason: 'bad_syntax' });
});

test('ordinary traffic is not a PAID attempt — null, so it falls through silently', () => {
  for (const text of ['hi', '2', 'room 2', 'done', 'i paid already', 'walkin room 2 2hrs Bob', '']) {
    assert.strictEqual(parsePaidCommand(text), null, `should not be PAID: ${JSON.stringify(text)}`);
  }
});

// ── Fixtures for the flow ───────────────────────────────────────────────────

function seed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: {
        'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000',
        'Notify Phone': '27732273477',
        'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
      }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Occupied', 'Property': ['recP1'] } },
      { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Room Number': 2, 'Status': 'Occupied', 'Property': ['recP1'] } }
    ],
    WS_Roles: [
      {
        id: 'recRole1',
        fields: {
          'Role Label': 'Villa Liza Reception', 'Role Type': 'Reception',
          'Property': ['recP1'], 'Current Phone': RECEPTION_PHONE, 'Active': true
        }
      },
      { id: 'recRoleBlank', fields: {} }
    ],
    WS_Guests: [{
      id: 'recG1',
      fields: { 'Guest Name': 'John Smith', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN' }
    }],
    WS_Bookings: [{
      id: 'recB1',
      fields: {
        'Booking Ref': 'WS-AAA001', 'Guest': ['recG1'], 'Room': ['recR2'],
        'Status': 'Checked Out', 'Booking Type': 'Overnight', 'Amount Due': 400,
        'Payment Status': 'Unpaid', 'WS_Property': ['recP1'],
        'Check In': '2026-08-05T12:00:00.000Z', 'Check Out': '2026-08-06T08:00:00.000Z'
      }
    }],
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

const bookingRow = (ctx, id = 'recB1') => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id).fields;
const texts = ctx => ctx.sends.map(s => s.body || '').join('\n---\n');
const axiomEvents = ctx => ctx.axiom.map(e => e.event);

// ── Recording a payment ─────────────────────────────────────────────────────

test('reception records a full payment: amount, method and status all written', async () => {
  const ctx = start();
  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');

  const b = bookingRow(ctx);
  assert.strictEqual(b['Amount Paid'], 400);
  assert.strictEqual(b['Payment Status'], 'Paid');
  assert.strictEqual(b['Payment Method'], 'Cash', 'defaults to Cash — the desk takes cash');
  assert.match(texts(ctx), /Payment recorded/);
  assert.ok(axiomEvents(ctx).includes('payment_recorded'));
});

test('the payment method can be overridden on the command', async () => {
  const ctx = start();
  await send(RECEPTION_PHONE, 'PAID ROOM 2 400 EFT');
  assert.strictEqual(bookingRow(ctx)['Payment Method'], 'EFT');
});

test('a short payment is Partial, not Paid', async () => {
  // Deviation from the locked wording, flagged in the PR: R100 against R400 owed
  // recorded as 'Paid' would put a false figure into the record B17 builds the
  // owner's revenue report from.
  const ctx = start();
  await send(RECEPTION_PHONE, 'PAID ROOM 2 100');

  const b = bookingRow(ctx);
  assert.strictEqual(b['Amount Paid'], 100);
  assert.strictEqual(b['Payment Status'], 'Partial');
  assert.match(texts(ctx), /Still owing:\* R300\.00/);
});

test('an overpayment still settles the booking', async () => {
  const ctx = start();
  await send(RECEPTION_PHONE, 'PAID ROOM 2 500');
  assert.strictEqual(bookingRow(ctx)['Payment Status'], 'Paid');
});

test('the amount owed already includes extensions (F34), with no extra work here', async () => {
  // The dependency PAID was blocked on: Amount Due is read off the booking, and
  // F34 adds each extension's charge onto it in place.
  const s = seed();
  s.WS_Bookings[0].fields['Amount Due'] = 800; // base 400 + one extension
  const ctx = start({ WS_Bookings: s.WS_Bookings });
  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');

  assert.strictEqual(bookingRow(ctx)['Payment Status'], 'Partial', 'R400 against an extended R800');
});

// ── Idempotency ─────────────────────────────────────────────────────────────

test('re-sending PAID on a settled booking reports it and writes nothing', async () => {
  const ctx = start();
  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');
  const writesAfterFirst = ctx.airtable.log.length;

  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');

  assert.strictEqual(ctx.airtable.log.length, writesAfterFirst, 'no second write of any kind');
  assert.match(texts(ctx), /Already recorded/);
  assert.ok(axiomEvents(ctx).includes('paid_already_recorded'));
});

test('a different amount re-sent after settlement still does not overwrite', async () => {
  // Two handsets, or a mistyped correction — neither may silently rewrite money
  // that is already recorded.
  const ctx = start();
  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');
  await send(RECEPTION_PHONE, 'PAID ROOM 2 999');

  assert.strictEqual(bookingRow(ctx)['Amount Paid'], 400, 'the original figure stands');
});

test('a Partial booking can still be topped up — idempotency guards Paid only', async () => {
  const ctx = start();
  await send(RECEPTION_PHONE, 'PAID ROOM 2 100');
  assert.strictEqual(bookingRow(ctx)['Payment Status'], 'Partial');

  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');
  const b = bookingRow(ctx);
  assert.strictEqual(b['Payment Status'], 'Paid');
  // FLAGGED in the PR: the second amount REPLACES rather than accumulates, so
  // reception must send the full settled figure, not the balance. The reply copy
  // says so explicitly.
  assert.strictEqual(b['Amount Paid'], 400);
});

// ── Authorisation ───────────────────────────────────────────────────────────

test('an unauthorised number falls through to the ordinary guest flow', async () => {
  const ctx = start();
  await send(OUTSIDER_PHONE, 'PAID ROOM 2 400');

  assert.strictEqual(bookingRow(ctx)['Payment Status'], 'Unpaid', 'nothing recorded');
  const out = texts(ctx);
  assert.doesNotMatch(out, /payment|paid/i, 'the reply must not mention payments');
});

test('an unauthorised PAID is answered identically to any other stranger message', async () => {
  const a = start();
  await send(OUTSIDER_PHONE, 'PAID ROOM 2 400');
  const b = start();
  await send(OUTSIDER_PHONE, 'hello there');

  assert.deepStrictEqual(
    a.sends.map(s => [s.to, s.body]),
    b.sends.map(s => [s.to, s.body]),
    'a stranger cannot tell PAID exists'
  );
});

test('an inactive seat cannot record payments', async () => {
  const s = seed();
  s.WS_Roles[0].fields['Active'] = false;
  const ctx = start({ WS_Roles: s.WS_Roles });
  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');

  assert.strictEqual(bookingRow(ctx)['Payment Status'], 'Unpaid');
  assert.doesNotMatch(texts(ctx), /payment recorded/i);
});

test('a non-Reception seat cannot record payments', async () => {
  // PAID is Reception-only per the locked refusal rule — narrower than WALKIN,
  // which also accepts Owner and Manager. Flagged in the PR.
  const s = seed();
  s.WS_Roles[0].fields['Role Type'] = 'Manager';
  const ctx = start({ WS_Roles: s.WS_Roles });
  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');

  assert.strictEqual(bookingRow(ctx)['Payment Status'], 'Unpaid');
});

// ── Room and booking resolution ─────────────────────────────────────────────

test('a room with no payable booking is refused, with nothing written', async () => {
  const ctx = start();
  await send(RECEPTION_PHONE, 'PAID ROOM 1 400');

  assert.strictEqual(bookingRow(ctx)['Payment Status'], 'Unpaid', 'room 02\'s booking untouched');
  assert.match(texts(ctx), /No booking found/);
});

test('an unknown room is refused', async () => {
  const ctx = start();
  await send(RECEPTION_PHONE, 'PAID ROOM 77 400');
  assert.match(texts(ctx), /No room matching/);
});

test('the most recent CHECKED OUT stay wins over a guest still in the room', async () => {
  // Reception is at the desk just after a checkout. A guest currently occupying
  // the room has not been billed yet, so the closed stay is the one being paid.
  const s = seed();
  s.WS_Bookings.push({
    id: 'recB2',
    fields: {
      'Booking Ref': 'WS-BBB002', 'Room': ['recR2'], 'Status': 'Checked In',
      'Booking Type': 'Hourly', 'Amount Due': 250, 'Payment Status': 'Unpaid',
      'Check In': '2026-08-06T10:00:00.000Z', 'Check Out': '2026-08-06T12:00:00.000Z'
    }
  });
  const ctx = start({ WS_Bookings: s.WS_Bookings });
  await send(RECEPTION_PHONE, 'PAID ROOM 2 400');

  assert.strictEqual(bookingRow(ctx, 'recB1')['Payment Status'], 'Paid', 'the checked-out stay');
  assert.strictEqual(bookingRow(ctx, 'recB2')['Payment Status'], 'Unpaid', 'the in-house guest untouched');
});

// ── The checkout push: both paths ───────────────────────────────────────────

test('manual checkout pushes the amount owed to the Reception seat (stubbed)', async () => {
  const s = seed();
  s.WS_Bookings[0].fields['Status'] = 'Checked In';
  s.WS_Bookings[0].fields['Checked In At'] = '2026-08-05T12:00:00.000Z';
  const ctx = start({ WS_Bookings: s.WS_Bookings });

  await send(GUEST_PHONE, '1'); // CHECKED_IN + "1" = checking out

  const stub = ctx.axiom.find(e => e.event === 'reception_payment_notify_stubbed');
  assert.ok(stub, 'the push fired');
  assert.strictEqual(stub.source, 'manual');
  assert.strictEqual(stub.to, RECEPTION_PHONE);
  assert.deepStrictEqual(stub.params, ['Room 02', 'John Smith', '400.00', 'WS-AAA001']);
  // Unset template must never degrade to free-form — Reception hasn't messaged us.
  assert.ok(!ctx.sends.some(x => x.to === RECEPTION_PHONE), 'no free-form send to reception');
});

test('the cron checkout pushes too — the path most walk-ins actually close on', async () => {
  const NOW = new Date('2026-08-06T09:00:00.000Z');
  const s = seed();
  s.WS_Bookings[0].fields['Status'] = 'Checked In';
  s.WS_Bookings[0].fields['Checkout Warning Sent At'] = '2026-08-06T08:30:00.000Z';
  const ctx = start({ WS_Bookings: s.WS_Bookings });

  const summary = await wh.runAutoCheckout(NOW);
  assert.strictEqual(summary.autoCheckouts, 1);

  const stub = ctx.axiom.find(e => e.event === 'reception_payment_notify_stubbed');
  assert.ok(stub, 'the push fired from the cron');
  assert.strictEqual(stub.source, 'auto');
  assert.deepStrictEqual(stub.params, ['Room 02', 'John Smith', '400.00', 'WS-AAA001']);
});

test('with the template configured, a real template send goes out instead of the stub', async () => {
  process.env.WABISTAY_RECEPTION_PAYMENT_TEMPLATE = 'wabistay_reception_payment';
  try {
    const s = seed();
    s.WS_Bookings[0].fields['Status'] = 'Checked In';
    s.WS_Bookings[0].fields['Checked In At'] = '2026-08-05T12:00:00.000Z';
    const ctx = start({ WS_Bookings: s.WS_Bookings });

    await send(GUEST_PHONE, '1');

    const sent = ctx.sends.find(x => x.to === RECEPTION_PHONE);
    assert.ok(sent, 'reception was messaged');
    assert.strictEqual(sent.type, 'template');
    assert.strictEqual(sent.template, 'wabistay_reception_payment');
    assert.deepStrictEqual(sent.params, ['Room 02', 'John Smith', '400.00', 'WS-AAA001']);
    assert.ok(!ctx.axiom.some(e => e.event === 'reception_payment_notify_stubbed'));
  } finally {
    delete process.env.WABISTAY_RECEPTION_PAYMENT_TEMPLATE;
  }
});

test('a property with no Reception seat fails LOUD, and checkout still completes', async () => {
  const s = seed();
  s.WS_Bookings[0].fields['Status'] = 'Checked In';
  s.WS_Bookings[0].fields['Checked In At'] = '2026-08-05T12:00:00.000Z';
  const ctx = start({ WS_Roles: [], WS_Bookings: s.WS_Bookings });

  await send(GUEST_PHONE, '1');

  assert.ok(axiomEvents(ctx).includes('reception_payment_notify_no_seat'), 'nobody told = visible');
  assert.strictEqual(bookingRow(ctx)['Status'], 'Checked Out', 'the guest still checked out');
});

test('the push does not gate cleaner dispatch — that stays at checkout', async () => {
  const s = seed();
  s.WS_Bookings[0].fields['Status'] = 'Checked In';
  s.WS_Bookings[0].fields['Checked In At'] = '2026-08-05T12:00:00.000Z';
  const ctx = start({
    WS_Bookings: s.WS_Bookings,
    WS_Cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Rose', 'Phone Number': '27830001111', 'Active': true, 'Assigned Property': ['recP1'] } }]
  });

  await send(GUEST_PHONE, '1');

  assert.ok(ctx.sends.some(x => x.to === '27830001111'), 'cleaner dispatched at checkout, unpaid');
  assert.strictEqual(ctx.airtable.tables['WS_Rooms'].find(r => r.id === 'recR2').fields['Status'], 'Cleaning');
});
