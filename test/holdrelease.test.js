// test/holdrelease.test.js
// Doc 1b PR 6: stale-hold release and the overdue question.
//   - 'Hold Expires At' (WS_Bookings) = 30 min after the stated arrival, set when
//     WABISTAY_HOLD_RELEASE is on; the auto-checkout cron cancels an Enquiry /
//     Confirmed booking once it has passed, and sends the guest back to NEW.
//   - A Checked In booking 60 min past its Check Out gets one template question to
//     Reception (WABISTAY_OVERDUE_ALERT_TEMPLATE), stamped in 'Overdue Alert Sent At'.
// Both sweeps run inside the cron time budget and are off unless configured.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const NOW = new Date('2026-10-02T12:00:00.000Z');
const minsAgo = m => new Date(NOW.getTime() - m * 60000).toISOString();
const minsAhead = m => new Date(NOW.getTime() + m * 60000).toISOString();

const GUEST_PHONE = '27821234567';
const RECEPTION_PHONE = '27825999279';
const ON_DUTY_PHONE = '27676090246';
const TEMPLATE = 'wabistay_overdue_test';

afterEach(() => {
  delete process.env.WABISTAY_HOLD_RELEASE;
  delete process.env.WABISTAY_OVERDUE_ALERT_TEMPLATE;
});

const room = { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } };
const property = { id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300 } };
const roles = [
  { id: 'recRecep', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION_PHONE, 'Active': true } },
  { id: 'recOnDuty', fields: { 'Role Label': 'Jill', 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': ON_DUTY_PHONE, 'Active': true } }
];
const guest = (state = 'CONFIRMED', extra = {}) => ({ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': GUEST_PHONE, 'Session State': state, ...extra } });
const booking = (id, fields) => ({ id, fields: { Guest: ['recG1'], Room: ['recR1'], 'Booking Type': 'Overnight', 'Payment Status': 'Unpaid', ...fields } });

function setup(seed) {
  const ctx = { airtable: new MockAirtable({ WS_Properties: [property], WS_Rooms: [room], WS_Roles: roles, WS_Cleaners: [], WS_Enquiries: [], WS_Rates: [], ...seed }), sends: [], axiom: [], gets: [] };
  installFetch(ctx);
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('api.airtable.com') && (init.method || 'GET').toUpperCase() === 'GET') {
      ctx.gets.push(decodeURIComponent(new URL(url).pathname.split('/')[3]));
    }
    return inner(url, init);
  };
  return ctx;
}

const events = (ctx, name) => ctx.axiom.filter(e => e.event === name);
const row = (ctx, table, id) => ctx.airtable.tables[table].find(r => r.id === id);

// ── expiry arithmetic ────────────────────────────────────────────────────────

test('holdExpiryIso: arrival + 30 min, but never sooner than 30 min from now', () => {
  assert.strictEqual(wh.holdExpiryIso(minsAhead(120), NOW), minsAhead(150));
  assert.strictEqual(wh.holdExpiryIso(minsAgo(90), NOW), minsAhead(30), 'a past arrival time still holds for 30 minutes from now');
});

test('overnightHoldExpiryIso: ETA on the check-in day (SAST) + 30 min; ambiguous reads as pm; unreadable holds to the end of the day', () => {
  const checkIn = '2099-12-01T12:00:00.000Z';                // 14:00 SAST on 1 Dec 2099
  assert.strictEqual(wh.overnightHoldExpiryIso(checkIn, '3pm', NOW), '2099-12-01T13:30:00.000Z');       // 15:30 SAST
  assert.strictEqual(wh.overnightHoldExpiryIso(checkIn, '14:00', NOW), '2099-12-01T12:30:00.000Z');
  assert.strictEqual(wh.overnightHoldExpiryIso(checkIn, '9', NOW), '2099-12-01T19:30:00.000Z');         // bare 9 -> 21:00 SAST
  assert.strictEqual(wh.overnightHoldExpiryIso(checkIn, 'in the evening', NOW), '2099-12-01T22:29:00.000Z'); // 23:59 + 30 min SAST
  assert.strictEqual(wh.overnightHoldExpiryIso(checkIn, '', NOW), '2099-12-01T22:29:00.000Z');
});

// ── the sweep ────────────────────────────────────────────────────────────────

test('flag ON: an expired Confirmed hold is cancelled and the guest goes back to NEW', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest('CONFIRMED')],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed', 'Check In': minsAgo(60), 'Hold Expires At': minsAgo(1) })]
  });
  const summary = await wh.runHoldRelease(NOW);
  assert.deepStrictEqual(summary, { holdsReleased: 1 });
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Status'], 'Cancelled');
  assert.strictEqual(row(ctx, 'WS_Guests', 'recG1').fields['Session State'], 'NEW');
  assert.strictEqual(events(ctx, 'hold_released').length, 1);
  assert.strictEqual(ctx.sends.length, 0, 'no message to the guest — the wording is not ours to invent');
});

test('the released room is free to book again: a second guest is refused before the sweep and accepted after it', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const OTHER = '27829990000';
  const ctx = setup({
    WS_Guests: [guest('CONFIRMED'), { id: 'recG2', fields: { 'Guest Name': 'Unknown', 'Phone Number': OTHER, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Rates: [{ id: 'recRate', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 600, 'Active': true, 'Property': ['recP1'] } }],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed', 'Check In': '2099-12-01T12:00:00.000Z', 'Check Out': '2099-12-03T08:00:00.000Z', 'Hold Expires At': minsAgo(1) })]
  });
  await send(OTHER, 'Jane Doe\n1 December 2099\n3 December 2099');
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 1, 'the only room is held, so no second booking');

  await wh.runHoldRelease(NOW);
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Status'], 'Cancelled');

  await send(OTHER, 'Jane Doe\n1 December 2099\n3 December 2099');
  const second = ctx.airtable.tables['WS_Bookings'].find(b => (b.fields['Guest'] || []).includes('recG2'));
  assert.ok(second && second.fields['Room'][0] === 'recR1', 'the second guest now gets the room');
});

test('an expired Enquiry in AWAITING_ETA is released too; a guest in a state with no hold (AWAITING_DETAILS) is not touched', async () => {
  process.env.WABISTAY_HOLD_RELEASE = 'true';
  let ctx = setup({
    WS_Guests: [guest('AWAITING_ETA')],
    WS_Bookings: [booking('recB1', { Status: 'Enquiry', 'Hold Expires At': minsAgo(5) })]
  });
  await wh.runHoldRelease(NOW);
  assert.strictEqual(row(ctx, 'WS_Guests', 'recG1').fields['Session State'], 'NEW');

  ctx = setup({
    WS_Guests: [guest('AWAITING_DETAILS')],
    WS_Bookings: [booking('recB1', { Status: 'Enquiry', 'Hold Expires At': minsAgo(5) })]
  });
  await wh.runHoldRelease(NOW);
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Status'], 'Cancelled');
  assert.strictEqual(row(ctx, 'WS_Guests', 'recG1').fields['Session State'], 'AWAITING_DETAILS');
});

test('not yet expired, no expiry set (older holds), or already Checked In: left alone', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest('CONFIRMED')],
    WS_Bookings: [
      booking('recB1', { Status: 'Confirmed', 'Hold Expires At': minsAhead(10) }),
      booking('recB2', { Status: 'Confirmed' }),
      booking('recB3', { Status: 'Checked In', 'Hold Expires At': minsAgo(100) })
    ]
  });
  const summary = await wh.runHoldRelease(NOW);
  assert.deepStrictEqual(summary, { holdsReleased: 0 });
  assert.deepStrictEqual(ctx.airtable.log, []);
});

test('flag OFF (unset): nothing is read and nothing is released, even for an expired hold', async () => {
  const ctx = setup({
    WS_Guests: [guest('CONFIRMED')],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed', 'Hold Expires At': minsAgo(60) })]
  });
  const summary = await wh.runHoldRelease(NOW);
  assert.deepStrictEqual(summary, { holdsReleased: 0 });
  assert.strictEqual(ctx.gets.length, 0);
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Status'], 'Confirmed');
});

test('a booking with money recorded against it is never auto-released', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest('CONFIRMED')],
    WS_Bookings: [
      booking('recB1', { Status: 'Confirmed', 'Payment Status': 'Paid', 'Hold Expires At': minsAgo(60) }),
      booking('recB2', { Status: 'Confirmed', 'Amount Paid': 100, 'Hold Expires At': minsAgo(60) })
    ]
  });
  const summary = await wh.runHoldRelease(NOW);
  assert.deepStrictEqual(summary, { holdsReleased: 0 });
  assert.strictEqual(events(ctx, 'hold_expired_paid_skipped').length, 2);
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Status'], 'Confirmed');
});

test('a guest with another live hold is not reset to NEW', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest('CONFIRMED')],
    WS_Bookings: [
      booking('recB1', { Status: 'Confirmed', 'Hold Expires At': minsAgo(5) }),
      booking('recB2', { Status: 'Confirmed', 'Hold Expires At': minsAhead(600) })
    ]
  });
  await wh.runHoldRelease(NOW);
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Status'], 'Cancelled');
  assert.strictEqual(row(ctx, 'WS_Guests', 'recG1').fields['Session State'], 'CONFIRMED');
});

test('race guard: a hold that moved on (guest checked in) between the snapshot and the write is not cancelled', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest('CONFIRMED')],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed', 'Hold Expires At': minsAgo(1) })]
  });
  const inner = global.fetch;
  let bookingReads = 0;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('WS_Bookings') && (init.method || 'GET').toUpperCase() === 'GET' && ++bookingReads === 2) {
      row(ctx, 'WS_Bookings', 'recB1').fields['Status'] = 'Checked In';   // lands after the snapshot, before the fresh read
    }
    return inner(url, init);
  };
  const summary = await wh.runHoldRelease(NOW);
  assert.deepStrictEqual(summary, { holdsReleased: 0 });
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Status'], 'Checked In');
  assert.strictEqual(events(ctx, 'hold_release_skipped_changed').length, 1);
});

test('out of time: expired holds are left for the next tick', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest('CONFIRMED')],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed', 'Hold Expires At': minsAgo(1) })]
  });
  const summary = await wh.runHoldRelease(NOW, { deadline: Date.now() - 1 });
  assert.strictEqual(summary.truncated, true);
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Status'], 'Confirmed');
});

// ── where Hold Expires At gets set ───────────────────────────────────────────

async function send(from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

test('flag ON: an overnight enquiry gets an end-of-check-in-day hold; the ETA then tightens it', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  let ctx = setup({
    WS_Guests: [guest('AWAITING_DETAILS', { 'Guest Name': 'Unknown' })], WS_Bookings: [],
    WS_Rates: [{ id: 'recRate', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 600, 'Active': true, 'Property': ['recP1'] } }]
  });
  await send(GUEST_PHONE, 'John Smith\n1 December 2099\n3 December 2099');
  const created = ctx.airtable.tables['WS_Bookings'][0];
  assert.strictEqual(created.fields['Hold Expires At'], '2099-12-01T22:29:00.000Z', '23:59 SAST on the check-in day + 30 min');

  ctx = setup({
    WS_Guests: [guest('AWAITING_ETA')],
    WS_Bookings: [booking('recB1', { Status: 'Enquiry', 'Check In': '2099-12-01T12:00:00.000Z', 'Check Out': '2099-12-03T08:00:00.000Z' })]
  });
  await send(GUEST_PHONE, '3pm');
  const confirmed = row(ctx, 'WS_Bookings', 'recB1');
  assert.strictEqual(confirmed.fields['Status'], 'Confirmed');
  assert.strictEqual(confirmed.fields['ETA'], '3pm');
  assert.strictEqual(confirmed.fields['Hold Expires At'], '2099-12-01T13:30:00.000Z');
});

test('flag ON: a confirmed hourly booking holds until 30 min after its arrival time', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest('AWAITING_HOURLY_DURATION')],
    WS_Bookings: [booking('recB1', { Status: 'Enquiry', 'Booking Type': 'Hourly', 'Check In': '2099-01-01T12:00:00.000Z' })]
  });
  await send(GUEST_PHONE, '2');
  const confirmed = row(ctx, 'WS_Bookings', 'recB1');
  assert.strictEqual(confirmed.fields['Status'], 'Confirmed');
  assert.strictEqual(confirmed.fields['Hold Expires At'], '2099-01-01T12:30:00.000Z');
});

test('flag OFF: no booking write carries Hold Expires At at all', async () => {
  const ctx = setup({
    WS_Guests: [guest('AWAITING_ETA')],
    WS_Bookings: [booking('recB1', { Status: 'Enquiry', 'Check In': '2099-12-01T12:00:00.000Z', 'Check Out': '2099-12-03T08:00:00.000Z' })]
  });
  await send(GUEST_PHONE, '3pm');
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Hold Expires At'], undefined);
  assert.ok(!ctx.airtable.log.some(w => 'Hold Expires At' in w.fields));
});

// ── overdue question ─────────────────────────────────────────────────────────

const overdueBooking = (extra = {}) => booking('recB1', { Status: 'Checked In', 'Check Out': minsAgo(61), ...extra });

test('template unset: the overdue sweep is off — no reads, no sends', async () => {
  const ctx = setup({ WS_Guests: [guest('CHECKED_IN')], WS_Bookings: [overdueBooking()] });
  const summary = await wh.runOverdueAlerts(NOW);
  assert.deepStrictEqual(summary, { overdueAlerts: 0 });
  assert.strictEqual(ctx.gets.length, 0);
  assert.strictEqual(ctx.sends.length, 0);
});

test('60+ minutes overdue: Reception (not On Duty) gets the three-param template once, and the booking is stamped', async () => {
  process.env.WABISTAY_OVERDUE_ALERT_TEMPLATE = TEMPLATE;
  const ctx = setup({ WS_Guests: [guest('CHECKED_IN')], WS_Bookings: [overdueBooking()] });
  const summary = await wh.runOverdueAlerts(NOW);

  assert.deepStrictEqual(summary, { overdueAlerts: 1 });
  const sent = ctx.sends.filter(s => s.type === 'template');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, RECEPTION_PHONE);
  assert.strictEqual(sent[0].template, TEMPLATE);
  assert.deepStrictEqual(sent[0].params, ['Room 01', 'John Smith', wh.formatSastDateTime(minsAgo(61))]);
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Overdue Alert Sent At'], NOW.toISOString());

  const again = await wh.runOverdueAlerts(new Date(NOW.getTime() + 5 * 60000));
  assert.deepStrictEqual(again, { overdueAlerts: 0 }, 'asked once, not every tick');
  assert.strictEqual(ctx.sends.filter(s => s.type === 'template').length, 1);
});

test('under 60 minutes overdue, or not Checked In: no question', async () => {
  process.env.WABISTAY_OVERDUE_ALERT_TEMPLATE = TEMPLATE;
  const ctx = setup({
    WS_Guests: [guest('CHECKED_IN')],
    WS_Bookings: [overdueBooking({ 'Check Out': minsAgo(59) }), booking('recB2', { Status: 'Checked Out', 'Check Out': minsAgo(300) })]
  });
  assert.deepStrictEqual(await wh.runOverdueAlerts(NOW), { overdueAlerts: 0 });
  assert.strictEqual(ctx.sends.length, 0);
});

test('no Reception seat: warned, not stamped, nothing sent', async () => {
  process.env.WABISTAY_OVERDUE_ALERT_TEMPLATE = TEMPLATE;
  const ctx = setup({ WS_Guests: [guest('CHECKED_IN')], WS_Bookings: [overdueBooking()], WS_Roles: [] });
  assert.deepStrictEqual(await wh.runOverdueAlerts(NOW), { overdueAlerts: 0 });
  assert.strictEqual(events(ctx, 'overdue_alert_no_seat').length, 1);
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Overdue Alert Sent At'], undefined);
});

test('a rejected send is logged and NOT stamped, so the next tick retries', async () => {
  process.env.WABISTAY_OVERDUE_ALERT_TEMPLATE = TEMPLATE;
  const ctx = setup({ WS_Guests: [guest('CHECKED_IN')], WS_Bookings: [overdueBooking()] });
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('graph.facebook.com') && init.body && JSON.parse(init.body).type === 'template') {
      return { status: 400, ok: false, json: async () => ({ error: { message: 'Template not found', code: 132001 } }), text: async () => '' };
    }
    return inner(url, init);
  };
  assert.deepStrictEqual(await wh.runOverdueAlerts(NOW), { overdueAlerts: 0 });
  assert.strictEqual(events(ctx, 'overdue_alert_failed').length, 1);
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Overdue Alert Sent At'], undefined);
});

test('out of time: the overdue sweep leaves the booking for the next tick', async () => {
  process.env.WABISTAY_OVERDUE_ALERT_TEMPLATE = TEMPLATE;
  const ctx = setup({ WS_Guests: [guest('CHECKED_IN')], WS_Bookings: [overdueBooking()] });
  const summary = await wh.runOverdueAlerts(NOW, { deadline: Date.now() - 1 });
  assert.strictEqual(summary.truncated, true);
  assert.strictEqual(ctx.sends.length, 0);
});

// ── the cron handler wires both in ───────────────────────────────────────────

test('autoCheckoutHandler reports both new counts (0 when the switches are off) and includes them in the duration event', async () => {
  const ctx = setup({ WS_Guests: [], WS_Bookings: [] });
  const res = { body: null, status() { return this; }, json(b) { this.body = b; return this; } };
  await wh.autoCheckoutHandler({}, res);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.holdsReleased, 0);
  assert.strictEqual(res.body.overdueAlerts, 0);
  assert.strictEqual(events(ctx, 'cron_duration').length, 1);
});

test('autoCheckoutHandler: with the flag on, an expired hold is released in the same run', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest('CONFIRMED')],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed', 'Hold Expires At': new Date(Date.now() - 60000).toISOString() })]
  });
  const res = { body: null, status() { return this; }, json(b) { this.body = b; return this; } };
  await wh.autoCheckoutHandler({}, res);
  assert.strictEqual(res.body.holdsReleased, 1);
  assert.strictEqual(row(ctx, 'WS_Bookings', 'recB1').fields['Status'], 'Cancelled');
});
