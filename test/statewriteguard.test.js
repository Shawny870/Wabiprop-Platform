// test/statewriteguard.test.js
// State-write guard (Doc 1b, PR 1). On 30 Sep a missing Session State select
// option (AWAITING_PAYMENT_METHOD) made the advance write fail; the bot sent the
// next prompt anyway, the guest stayed in the old state, and looped for a day
// with no alert. With WABISTAY_STATE_WRITE_GUARD on, a failed advance stops
// BEFORE the next prompt, sends the guest the agreed reception message, and
// alerts Shawn. Off (unset) it behaves exactly as before.
// In-memory only: MockAirtable + mocked fetch; the failure is injected by
// rejecting WS_Guests PATCHes that carry the bad Session State.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';
const ALERT_PHONE = '27811110000';
const REDIRECT = '078 038 4989';
const NOTIFY = '27831112222';

afterEach(() => { delete process.env.WABISTAY_STATE_WRITE_GUARD; });

function seed({ guestState, propertyFields = {}, bookings = [] } = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: {
        'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000',
        'Notify Phone': NOTIFY, 'Guest Redirect Phone': REDIRECT,
        'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300,
        ...propertyFields
      }
    }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [{ id: 'recRate', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 600, 'Active': true, 'Property': ['recP1'] } }],
    WS_Roles: [], WS_Cleaners: [], WS_Enquiries: [],
    WS_Config: [{ id: 'recCfg', fields: { 'Alert Phone': ALERT_PHONE } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': guestState } }],
    WS_Bookings: bookings
  };
}

// Rejects any WS_Guests PATCH that tries to set Session State to `badState`,
// exactly as Airtable did for the missing select option.
function start(opts, badState = 'AWAITING_PAYMENT_METHOD') {
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('api.airtable.com') && String(url).includes('WS_Guests') && (init.method || '').toUpperCase() === 'PATCH') {
      const fields = JSON.parse(init.body).fields;
      if (fields['Session State'] === badState) {
        return {
          status: 422, ok: false,
          json: async () => ({ error: { type: 'INVALID_MULTIPLE_CHOICE_OPTIONS', message: `Insufficient permissions to create new select option "${badState}"` } }),
          text: async () => ''
        };
      }
    }
    return inner(url, init);
  };
  return ctx;
}

async function send(text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(GUEST_PHONE, text) }, res);
  return res;
}

const guestRow = ctx => ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '');
const events = (ctx, name) => ctx.axiom.filter(e => e.event === name);
const EXPECTED_MESSAGE = `Sorry, something went wrong on our side. Please speak to reception on ${REDIRECT} and they will help you straight away.`;

// ── Overnight details -> payment menu ────────────────────────────────────────

test('guard ON: a failed AWAITING_PAYMENT_METHOD advance stops before the quote, tells the guest, alerts Shawn, writes no booking', async () => {
  process.env.WABISTAY_STATE_WRITE_GUARD = '1';
  const ctx = start({ guestState: 'AWAITING_DETAILS' });
  await send('Jane Doe\n1 September 2099\n2 September 2099');

  assert.deepStrictEqual(texts(ctx, GUEST_PHONE).filter(t => /something went wrong/.test(t)), [EXPECTED_MESSAGE]);
  assert.ok(!texts(ctx, GUEST_PHONE).some(t => /card|eft/i.test(t) && /pay/i.test(t)), 'the payment menu must not be sent');
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 0, 'the advance runs before the booking is created, so none exists');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_DETAILS', 'guest stays where they were');
  assert.strictEqual(events(ctx, 'guest_state_write_guard_tripped').length, 1);

  const alert = texts(ctx, ALERT_PHONE).join('\n');
  assert.match(alert, /guest_state_write_failed/);
  assert.match(alert, /AWAITING_PAYMENT_METHOD/);
  assert.match(alert, /INVALID_MULTIPLE_CHOICE_OPTIONS/);
  assert.match(alert, new RegExp(GUEST_PHONE));
});

test('guard OFF (unset): today\'s behaviour — failure is only logged, the flow carries on to the payment menu', async () => {
  const ctx = start({ guestState: 'AWAITING_DETAILS' });
  await send('Jane Doe\n1 September 2099\n2 September 2099');

  assert.strictEqual(events(ctx, 'guest_state_write_failed').length, 1, 'still logged');
  assert.strictEqual(events(ctx, 'guest_state_write_guard_tripped').length, 0);
  assert.ok(!texts(ctx, GUEST_PHONE).some(t => /something went wrong/.test(t)));
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 1, 'booking still created, as before');
  assert.strictEqual(texts(ctx, ALERT_PHONE).length, 0, 'no alert while the guard is off');
});

test('a write that succeeds is untouched by the guard', async () => {
  process.env.WABISTAY_STATE_WRITE_GUARD = '1';
  const ctx = start({ guestState: 'AWAITING_DETAILS' }, 'SOME_OTHER_STATE');
  await send('Jane Doe\n1 September 2099\n2 September 2099');

  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_PAYMENT_METHOD');
  assert.strictEqual(events(ctx, 'guest_state_write_guard_tripped').length, 0);
  assert.strictEqual(texts(ctx, ALERT_PHONE).length, 0);
});

// ── Hourly duration: the booking already exists when the advance fails ───────

test('guard ON, hourly: the confirmed booking is left in place and the alert names it; no quote or payment menu is sent', async () => {
  process.env.WABISTAY_STATE_WRITE_GUARD = '1';
  const ctx = start({
    guestState: 'AWAITING_HOURLY_DURATION',
    bookings: [{
      id: 'recBpend', fields: {
        'Guest': ['recG1'], 'Booking Type': 'Hourly', 'Status': 'Enquiry', 'Payment Status': 'Unpaid',
        'Check In': '2099-01-01T12:00:00.000Z'
      }
    }]
  });
  await send('2');

  assert.deepStrictEqual(texts(ctx, GUEST_PHONE).filter(t => /something went wrong/.test(t)), [EXPECTED_MESSAGE]);
  assert.ok(!texts(ctx, GUEST_PHONE).some(t => /payment|card|eft/i.test(t)), 'no payment menu');
  const booking = ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'recBpend');
  assert.strictEqual(booking.fields['Status'], 'Confirmed', 'the booking write had already landed');
  const tripped = events(ctx, 'guest_state_write_guard_tripped')[0];
  assert.strictEqual(tripped.bookingId, 'recBpend');
  assert.match(tripped.bookingRef, /^WS-/);
});

// ── Redirect number fallbacks ────────────────────────────────────────────────

test('no Guest Redirect Phone: falls back to Notify Phone for the guest message', async () => {
  process.env.WABISTAY_STATE_WRITE_GUARD = '1';
  const ctx = start({ guestState: 'AWAITING_DETAILS', propertyFields: { 'Guest Redirect Phone': undefined } });
  await send('Jane Doe\n1 September 2099\n2 September 2099');

  assert.ok(texts(ctx, GUEST_PHONE).some(t => t.includes(NOTIFY)), 'Notify Phone used');
});

test('neither phone set: the guest is sent nothing invented, and the alert says so', async () => {
  process.env.WABISTAY_STATE_WRITE_GUARD = '1';
  const ctx = start({ guestState: 'AWAITING_DETAILS', propertyFields: { 'Guest Redirect Phone': undefined, 'Notify Phone': undefined } });
  await send('Jane Doe\n1 September 2099\n2 September 2099');

  assert.ok(!texts(ctx, GUEST_PHONE).some(t => /something went wrong/.test(t)));
  assert.match(texts(ctx, ALERT_PHONE).join('\n'), /No redirect phone is set/);
  assert.strictEqual(events(ctx, 'guest_state_write_guard_tripped')[0].guestMessageSent, false);
});

// ── Flag parsing ─────────────────────────────────────────────────────────────

test('only "1" or "true" (any case) turns the guard on', async () => {
  for (const [value, expectedTrip] of [['1', 1], ['true', 1], ['TRUE', 1], ['0', 0], ['yes', 0], ['', 0]]) {
    process.env.WABISTAY_STATE_WRITE_GUARD = value;
    const ctx = start({ guestState: 'AWAITING_DETAILS' });
    await send('Jane Doe\n1 September 2099\n2 September 2099');
    assert.strictEqual(events(ctx, 'guest_state_write_guard_tripped').length, expectedTrip, `value ${JSON.stringify(value)}`);
  }
});
