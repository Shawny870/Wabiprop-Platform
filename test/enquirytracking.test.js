// test/enquirytracking.test.js
// Lost-enquiry tracking (WABISTAY_ENQUIRY_TRACKING). Shawn's decision: nobody
// answers the phone at night for now, so lost enquiries and the times they happen
// are recorded and reviewed after a month. Each WS_Enquiries row carries the time
// of the first message, the last step reached and an outcome; a separate marker is
// written on a booking when an unpaid gate tap sees no payment and no check-in in
// 15 minutes. A guest with 'Test Phone' ticked gets no row and no marker.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';
const NOTIFY_PHONE = '27831112222';
const NOW = new Date('2026-10-03T20:30:00.000Z');          // 22:30 SAST
const minsAgo = m => new Date(NOW.getTime() - m * 60000).toISOString();
const hoursAgo = h => new Date(NOW.getTime() - h * 3600000).toISOString();
const realHoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();   // for tests driven through the handler, which uses the real clock

afterEach(() => {
  for (const k of ['WABISTAY_ENQUIRY_TRACKING', 'WABISTAY_HOLD_RELEASE', 'WABISTAY_GATE_ALERT_UNPAID', 'WABISTAY_GATE_ARRIVAL_TEMPLATE']) delete process.env[k];
});
const on = () => { process.env.WABISTAY_ENQUIRY_TRACKING = '1'; };

const property = { id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': NOTIFY_PHONE } };
const room = (extra = {}) => ({ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true, ...extra } });
const guest = (fields = {}) => ({ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'NEW', ...fields } });
const booking = (id, fields = {}) => ({ id, fields: { Guest: ['recG1'], Room: ['recR1'], 'Booking Type': 'Overnight', 'Payment Status': 'Unpaid', ...fields } });

function setup(seed = {}) {
  const ctx = {
    airtable: new MockAirtable({
      WS_Properties: [property], WS_Rooms: [room()], WS_Guests: [], WS_Bookings: [], WS_Enquiries: [], WS_Roles: [], WS_Cleaners: [],
      WS_Rates: [{ id: 'recRate', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 600, 'Active': true, 'Property': ['recP1'] } }],
      ...seed
    }),
    sends: [], axiom: []
  };
  installFetch(ctx);
  return ctx;
}

async function say(text, from = GUEST_PHONE) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const events = (ctx, name) => ctx.axiom.filter(e => e.event === name);
const rows = ctx => ctx.airtable.tables['WS_Enquiries'];
const guestRow = ctx => ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1' || g.fields['Phone Number'] === GUEST_PHONE);
const bookingRow = (ctx, id) => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id);
const DETAILS = 'Jane Doe\n1 December 2099\n3 December 2099';

// ── Axiom: message_received carries the step ─────────────────────────────────

test('message_received carries the guest\'s session state (or null for a stranger), flag on or off', async () => {
  let ctx = setup({ WS_Guests: [guest({ 'Session State': 'AWAITING_DETAILS' })] });
  await say('hello');
  assert.strictEqual(events(ctx, 'message_received')[0].sessionState, 'AWAITING_DETAILS');

  ctx = setup();
  await say('hi');
  assert.strictEqual(events(ctx, 'message_received')[0].sessionState, null);
});

test('message_received flags a test phone but still logs it', async () => {
  const ctx = setup({ WS_Guests: [guest({ 'Test Phone': true })] });
  await say('hi');
  assert.strictEqual(events(ctx, 'message_received')[0].testPhone, true);
});

// ── the greeting starts an attempt ───────────────────────────────────────────

test('flag ON: the greeting stamps the attempt on a new guest and on a returning guest at NEW', async () => {
  on();
  let ctx = setup();
  await say('hi');
  let g = guestRow(ctx);
  assert.ok(g.fields['Attempt Started At'] && g.fields['Last Inbound At']);
  assert.deepStrictEqual(g.fields['Attempt Property'], ['recP1']);

  ctx = setup({ WS_Guests: [guest()] });
  await say('hi');
  g = guestRow(ctx);
  assert.ok(g.fields['Attempt Started At']);
  assert.deepStrictEqual(g.fields['Attempt Property'], ['recP1']);
});

test('flag ON: a restart from mid-flow ("hi") keeps the original attempt start but refreshes Last Inbound At', async () => {
  on();
  const started = realHoursAgo(1);
  const ctx = setup({ WS_Guests: [guest({ 'Session State': 'AWAITING_DETAILS', 'Attempt Started At': started, 'Last Inbound At': started })] });
  await say('hi');
  const g = guestRow(ctx);
  assert.strictEqual(g.fields['Attempt Started At'], started);
  assert.ok(Date.parse(g.fields['Last Inbound At']) > Date.parse(started));
});

test('flag OFF, or a test phone: the greeting writes no tracking fields', async () => {
  let ctx = setup();
  await say('hi');
  assert.strictEqual(guestRow(ctx).fields['Attempt Started At'], undefined);

  on();
  ctx = setup({ WS_Guests: [guest({ 'Test Phone': true })] });
  await say('hi');
  assert.strictEqual(guestRow(ctx).fields['Attempt Started At'], undefined);
  assert.strictEqual(guestRow(ctx).fields['Last Inbound At'], undefined);
});

// ── rows carry first message, last message, last step ────────────────────────

test('flag ON: a No Availability row carries First Message At, Last Message At and Last Step; the event has SAST hours', async () => {
  on();
  const first = '2026-10-03T20:30:00.000Z';                     // 22:30 SAST
  const ctx = setup({
    WS_Rooms: [], WS_Guests: [guest({ 'Session State': 'AWAITING_DETAILS', 'Attempt Started At': first })]
  });
  await say(DETAILS);

  assert.strictEqual(rows(ctx).length, 1);
  const r = rows(ctx)[0].fields;
  assert.strictEqual(r['Outcome'], 'No Availability');
  assert.strictEqual(r['First Message At'], first);
  assert.strictEqual(r['Last Step'], 'AWAITING_DETAILS');
  assert.ok(r['Last Message At']);
  const closed = events(ctx, 'enquiry_closed')[0];
  assert.strictEqual(closed.outcome, 'No Availability');
  assert.strictEqual(closed.firstMessageHourSast, 22);
  assert.strictEqual(closed.testPhone, false);
});

test('flag ON: Invalid Input (deduped to one open row) and Booked carry the same three fields', async () => {
  on();
  let ctx = setup({ WS_Guests: [guest({ 'Session State': 'AWAITING_DETAILS', 'Attempt Started At': hoursAgo(1) })] });
  await say('garbage');
  await say('more garbage');
  assert.strictEqual(rows(ctx).length, 1);
  assert.strictEqual(rows(ctx)[0].fields['Outcome'], 'Invalid Input');
  assert.strictEqual(rows(ctx)[0].fields['Last Step'], 'AWAITING_DETAILS');

  ctx = setup({ WS_Guests: [guest({ 'Session State': 'AWAITING_DETAILS', 'Attempt Started At': hoursAgo(1) })] });
  await say(DETAILS);
  const booked = rows(ctx).find(r => r.fields['Outcome'] === 'Booked');
  assert.ok(booked && booked.fields['First Message At'] && booked.fields['Last Step'] === 'AWAITING_DETAILS');
});

test('flag OFF: rows are exactly as before — none of the new fields', async () => {
  const ctx = setup({ WS_Rooms: [], WS_Guests: [guest({ 'Session State': 'AWAITING_DETAILS', 'Attempt Started At': hoursAgo(1) })] });
  await say(DETAILS);
  const r = rows(ctx)[0].fields;
  assert.strictEqual(r['Outcome'], 'No Availability');
  for (const f of ['First Message At', 'Last Message At', 'Last Step']) assert.strictEqual(r[f], undefined, f);
  assert.strictEqual(events(ctx, 'enquiry_closed').length, 0);
});

// ── test phones ──────────────────────────────────────────────────────────────

test('a test phone produces no enquiry row for any outcome (flag on or off); Axiom still sees it', async () => {
  for (const flag of [true, false]) {
    if (flag) on(); else delete process.env.WABISTAY_ENQUIRY_TRACKING;
    let ctx = setup({ WS_Rooms: [], WS_Guests: [guest({ 'Session State': 'AWAITING_DETAILS', 'Test Phone': true })] });
    await say(DETAILS);                                            // No Availability
    assert.strictEqual(rows(ctx).length, 0, 'no row, flag ' + flag);
    assert.strictEqual(events(ctx, 'enquiry_skipped_test_phone').length, 1);
    if (flag) assert.strictEqual(events(ctx, 'enquiry_closed')[0].testPhone, true);

    ctx = setup({ WS_Guests: [guest({ 'Session State': 'AWAITING_DETAILS', 'Test Phone': true })] });
    await say(DETAILS);                                            // Booked
    assert.strictEqual(rows(ctx).length, 0);
    assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 1, 'the booking itself is unaffected');
  }
});

// ── Cancelled ────────────────────────────────────────────────────────────────

test('flag ON: a guest cancel writes a Cancelled row linked to the booking, even after a Booked row for it', async () => {
  on();
  const ctx = setup({
    WS_Guests: [guest({ 'Session State': 'CONFIRMED', 'Attempt Started At': hoursAgo(2) })],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed', 'Check In': '2099-12-01T12:00:00.000Z', 'Check Out': '2099-12-03T08:00:00.000Z' })],
    WS_Enquiries: [{ id: 'recE0', fields: { 'Outcome': 'Booked', 'Phone Number': GUEST_PHONE, 'Booking': ['recB1'] } }]
  });
  await say('2');
  assert.strictEqual(bookingRow(ctx, 'recB1').fields['Status'], 'Cancelled');
  const cancelled = rows(ctx).find(r => r.fields['Outcome'] === 'Cancelled');
  assert.ok(cancelled);
  assert.deepStrictEqual(cancelled.fields['Booking'], ['recB1']);
  assert.strictEqual(cancelled.fields['Last Step'], 'CONFIRMED');
});

test('flag OFF: a guest cancel writes no enquiry row, as before', async () => {
  const ctx = setup({
    WS_Guests: [guest({ 'Session State': 'CONFIRMED' })],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed' })]
  });
  await say('2');
  assert.strictEqual(rows(ctx).length, 0);
});

// ── Hold Expired ─────────────────────────────────────────────────────────────

test('flag ON: the hold release writes a Hold Expired row (not Cancelled) with the guest\'s last message time and the step they stopped at', async () => {
  on();
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest({ 'Session State': 'CONFIRMED', 'Attempt Started At': hoursAgo(3), 'Last Inbound At': hoursAgo(2) })],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed', 'Hold Expires At': minsAgo(1) })]
  });
  const summary = await wh.runHoldRelease(NOW);
  assert.strictEqual(summary.holdsReleased, 1);
  const r = rows(ctx)[0].fields;
  assert.strictEqual(r['Outcome'], 'Hold Expired');
  assert.deepStrictEqual(r['Booking'], ['recB1']);
  assert.strictEqual(r['Last Step'], 'CONFIRMED');
  assert.strictEqual(r['First Message At'], hoursAgo(3));
  assert.strictEqual(r['Last Message At'], hoursAgo(2));
  assert.deepStrictEqual(r['Property'], ['recP1']);
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'NEW', 'the guest is still reset');
});

test('hold release on a test phone: released and reset as normal, but no enquiry row', async () => {
  on();
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest({ 'Session State': 'CONFIRMED', 'Test Phone': true })],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed', 'Hold Expires At': minsAgo(1) })]
  });
  await wh.runHoldRelease(NOW);
  assert.strictEqual(bookingRow(ctx, 'recB1').fields['Status'], 'Cancelled');
  assert.strictEqual(rows(ctx).length, 0);
});

test('hold release with tracking OFF writes no enquiry row (as #83 shipped)', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = setup({
    WS_Guests: [guest({ 'Session State': 'CONFIRMED' })],
    WS_Bookings: [booking('recB1', { Status: 'Confirmed', 'Hold Expires At': minsAgo(1) })]
  });
  await wh.runHoldRelease(NOW);
  assert.strictEqual(rows(ctx).length, 0);
});

// ── Abandoned ────────────────────────────────────────────────────────────────

test('flag ON: a guest silent at the greeting step is reset and logged Abandoned — no name, no booking, property from Attempt Property, Last Message At = when they went quiet', async () => {
  on();
  const ctx = setup({
    WS_Guests: [guest({ 'Guest Name': 'Unknown', 'Session State': 'AWAITING_STAY_TYPE', 'Attempt Started At': hoursAgo(30), 'Last Inbound At': hoursAgo(30), 'Attempt Property': ['recP1'] })]
  });
  const summary = await wh.runEnquiryAbandonment(NOW);
  assert.strictEqual(summary.abandoned, 1);
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'NEW');
  const r = rows(ctx)[0].fields;
  assert.strictEqual(r['Outcome'], 'Abandoned');
  assert.strictEqual(r['First Message At'], hoursAgo(30));
  assert.strictEqual(r['Last Message At'], hoursAgo(30), 'when they went quiet, not when the sweep noticed');
  assert.strictEqual(r['Last Step'], 'AWAITING_STAY_TYPE');
  assert.deepStrictEqual(r['Property'], ['recP1']);
  assert.ok(Date.parse(r['Created At']) >= Date.now() - 60000, 'Created At is still the write time');
});

test('flag ON: a guest with no Last Inbound At falls back to when the attempt started', async () => {
  on();
  const ctx = setup({
    WS_Guests: [guest({ 'Guest Name': 'Unknown', 'Session State': 'AWAITING_STAY_TYPE', 'Attempt Started At': hoursAgo(30), 'Attempt Property': ['recP1'] })]
  });
  assert.strictEqual((await wh.runEnquiryAbandonment(NOW)).abandoned, 1);
  assert.strictEqual(rows(ctx)[0].fields['Last Message At'], hoursAgo(30));
});

test('flag OFF: the greeting step is still not swept and a nameless guest still gets no row (unchanged)', async () => {
  const ctx = setup({
    WS_Guests: [
      guest({ id: 'x', 'Guest Name': 'Unknown', 'Session State': 'AWAITING_STAY_TYPE', 'Last Inbound At': hoursAgo(30) }),
      { id: 'recG2', fields: { 'Guest Name': 'Unknown', 'Phone Number': '27820000002', 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': hoursAgo(30) } }
    ]
  });
  const summary = await wh.runEnquiryAbandonment(NOW);
  assert.strictEqual(summary.abandoned, 1, 'only the AWAITING_DETAILS guest');
  assert.strictEqual(rows(ctx).length, 0);
});

test('flag ON: an attempt that already ended in a row after the last message is not double-counted', async () => {
  on();
  const ctx = setup({
    WS_Guests: [guest({ 'Guest Name': 'Unknown', 'Session State': 'AWAITING_DETAILS', 'Attempt Started At': hoursAgo(30), 'Last Inbound At': hoursAgo(30), 'Attempt Property': ['recP1'] })],
    WS_Enquiries: [{ id: 'recE0', fields: { 'Outcome': 'No Availability', 'Phone Number': GUEST_PHONE, 'Created At': hoursAgo(30) } }]
  });
  await wh.runEnquiryAbandonment(NOW);
  assert.strictEqual(rows(ctx).length, 1, 'no extra Abandoned row');
});

test('a stale test-phone guest is reset to NEW but gets no row', async () => {
  on();
  const ctx = setup({
    WS_Guests: [guest({ 'Guest Name': 'Unknown', 'Session State': 'AWAITING_STAY_TYPE', 'Attempt Started At': hoursAgo(30), 'Last Inbound At': hoursAgo(30), 'Attempt Property': ['recP1'], 'Test Phone': true })]
  });
  await wh.runEnquiryAbandonment(NOW);
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'NEW');
  assert.strictEqual(rows(ctx).length, 0);
  assert.strictEqual(events(ctx, 'enquiry_closed')[0].testPhone, true);
});

// ── gate tap + unattended marker ─────────────────────────────────────────────

const unpaid = (extra = {}) => booking('recB1', {
  Status: 'Confirmed', 'Booking Ref': 'WS-ABC123', 'Amount Due': 250,
  'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z', ...extra
});

test('flag ON: the first unpaid tap stamps Gate Tap At after the guest reply; a second tap does not overwrite it', async () => {
  on();
  const ctx = setup({ WS_Guests: [guest({ 'Session State': 'CONFIRMED' })], WS_Bookings: [unpaid()] });
  await say('1');
  assert.match(ctx.sends[0].body, /Almost there! Pop into the office/, 'the reply is first');
  const first = bookingRow(ctx, 'recB1').fields['Gate Tap At'];
  assert.ok(first);
  await say('1');
  assert.strictEqual(bookingRow(ctx, 'recB1').fields['Gate Tap At'], first);
});

test('the tap stamp is independent of the unpaid-alert flag, skips test phones and flag-off, and never blocks the reply when the write fails', async () => {
  // alert flag off, tracking on: still stamped
  on();
  let ctx = setup({ WS_Guests: [guest({ 'Session State': 'CONFIRMED' })], WS_Bookings: [unpaid()] });
  await say('1');
  assert.ok(bookingRow(ctx, 'recB1').fields['Gate Tap At']);

  // test phone: not stamped
  ctx = setup({ WS_Guests: [guest({ 'Session State': 'CONFIRMED', 'Test Phone': true })], WS_Bookings: [unpaid()] });
  await say('1');
  assert.strictEqual(bookingRow(ctx, 'recB1').fields['Gate Tap At'], undefined);

  // flag off: not stamped
  delete process.env.WABISTAY_ENQUIRY_TRACKING;
  ctx = setup({ WS_Guests: [guest({ 'Session State': 'CONFIRMED' })], WS_Bookings: [unpaid()] });
  await say('1');
  assert.strictEqual(bookingRow(ctx, 'recB1').fields['Gate Tap At'], undefined);

  // write fails: logged, reply and alert unaffected
  on();
  process.env.WABISTAY_GATE_ALERT_UNPAID = '1';
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = 'wabistay_gate_arrival';
  ctx = setup({ WS_Guests: [guest({ 'Session State': 'CONFIRMED' })], WS_Bookings: [unpaid()] });
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('WS_Bookings') && (init.method || '').toUpperCase() === 'PATCH' && 'Gate Tap At' in JSON.parse(init.body).fields) {
      return { status: 422, ok: false, json: async () => ({ error: { type: 'UNKNOWN_FIELD_NAME', message: 'nope' } }), text: async () => '' };
    }
    return inner(url, init);
  };
  await say('1');
  assert.match(ctx.sends[0].body, /Almost there! Pop into the office/);
  assert.ok(ctx.sends.some(s => /has not paid yet/.test(s.body || '')), 'the owner alert still went');
  assert.strictEqual(events(ctx, 'gate_tap_stamp_write_failed').length, 1);
});

test('unattended sweep: 15 minutes after the tap with no payment and no check-in, the marker is written once and logged with the SAST hour', async () => {
  on();
  const ctx = setup({
    WS_Guests: [guest({ 'Session State': 'CONFIRMED' })],
    WS_Bookings: [unpaid({ 'Gate Tap At': minsAgo(16) })]
  });
  const summary = await wh.runUnattendedGateSweep(NOW);
  assert.deepStrictEqual(summary, { unattendedGateArrivals: 1 });
  assert.strictEqual(bookingRow(ctx, 'recB1').fields['Unattended Gate Arrival At'], NOW.toISOString());
  const e = events(ctx, 'unattended_gate_arrival')[0];
  assert.strictEqual(e.bookingRef, 'WS-ABC123');
  assert.strictEqual(e.gateTapHourSast, 22);           // 20:14 UTC = 22:14 SAST
  assert.strictEqual(e.minutesWaited, 16);
  assert.strictEqual(e.testPhone, false);

  assert.deepStrictEqual(await wh.runUnattendedGateSweep(NOW), { unattendedGateArrivals: 0 }, 'marked once');
});

test('unattended sweep: not yet 15 minutes, or already marked, or flag off: nothing', async () => {
  on();
  let ctx = setup({ WS_Guests: [guest()], WS_Bookings: [unpaid({ 'Gate Tap At': minsAgo(14) }), booking('recB2', { Status: 'Confirmed', 'Gate Tap At': minsAgo(60), 'Unattended Gate Arrival At': minsAgo(40) })] });
  assert.deepStrictEqual(await wh.runUnattendedGateSweep(NOW), { unattendedGateArrivals: 0 });

  delete process.env.WABISTAY_ENQUIRY_TRACKING;
  ctx = setup({ WS_Guests: [guest()], WS_Bookings: [unpaid({ 'Gate Tap At': minsAgo(60) })] });
  assert.deepStrictEqual(await wh.runUnattendedGateSweep(NOW), { unattendedGateArrivals: 0 });
  assert.strictEqual(bookingRow(ctx, 'recB1').fields['Unattended Gate Arrival At'], undefined);
});

test('unattended sweep judges resolution at the 15-minute mark: paid or checked in within 15 min is attended, paid at minute 17 is not', async () => {
  on();
  const tap = minsAgo(30);
  const at = m => new Date(Date.parse(tap) + m * 60000).toISOString();
  const ctx = setup({
    WS_Guests: [guest()],
    WS_Bookings: [
      unpaid({ id: undefined, 'Gate Tap At': tap, 'Payment Status': 'Paid', 'Paid At': at(10) }),                            // attended
      booking('recB2', { Status: 'Confirmed', 'Gate Tap At': tap, 'Payment Status': 'Paid', 'Paid At': at(17) }),            // late
      booking('recB3', { Status: 'Checked In', 'Gate Tap At': tap, 'Checked In At': at(12) }),                               // attended
      booking('recB4', { Status: 'Checked In', 'Gate Tap At': tap, 'Checked In At': at(20) }),                               // late
      booking('recB5', { Status: 'Cancelled', 'Gate Tap At': tap })                                                            // not a candidate
    ]
  });
  ctx.airtable.tables['WS_Bookings'][0].id = 'recB1';
  const summary = await wh.runUnattendedGateSweep(NOW);
  assert.strictEqual(summary.unattendedGateArrivals, 2);
  assert.strictEqual(bookingRow(ctx, 'recB1').fields['Unattended Gate Arrival At'], undefined);
  assert.ok(bookingRow(ctx, 'recB2').fields['Unattended Gate Arrival At']);
  assert.strictEqual(bookingRow(ctx, 'recB3').fields['Unattended Gate Arrival At'], undefined);
  assert.ok(bookingRow(ctx, 'recB4').fields['Unattended Gate Arrival At']);
  assert.strictEqual(bookingRow(ctx, 'recB5').fields['Unattended Gate Arrival At'], undefined);
});

test('unattended sweep: a test phone is logged (flagged) but never marked; a marker write failure is logged and not counted; out of time stops', async () => {
  on();
  let ctx = setup({ WS_Guests: [guest({ 'Test Phone': true })], WS_Bookings: [unpaid({ 'Gate Tap At': minsAgo(20) })] });
  assert.deepStrictEqual(await wh.runUnattendedGateSweep(NOW), { unattendedGateArrivals: 0 });
  assert.strictEqual(events(ctx, 'unattended_gate_arrival')[0].testPhone, true);
  assert.strictEqual(bookingRow(ctx, 'recB1').fields['Unattended Gate Arrival At'], undefined);

  ctx = setup({ WS_Guests: [guest()], WS_Bookings: [unpaid({ 'Gate Tap At': minsAgo(20) })] });
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('WS_Bookings') && (init.method || '').toUpperCase() === 'PATCH') {
      return { status: 422, ok: false, json: async () => ({ error: { type: 'UNKNOWN_FIELD_NAME', message: 'nope' } }), text: async () => '' };
    }
    return inner(url, init);
  };
  assert.deepStrictEqual(await wh.runUnattendedGateSweep(NOW), { unattendedGateArrivals: 0 });
  assert.strictEqual(events(ctx, 'unattended_gate_marker_write_failed').length, 1);

  ctx = setup({ WS_Guests: [guest()], WS_Bookings: [unpaid({ 'Gate Tap At': minsAgo(20) })] });
  const late = await wh.runUnattendedGateSweep(NOW, { deadline: Date.now() - 1 });
  assert.strictEqual(late.truncated, true);
});

test('the cron handler runs the unattended sweep inside its time budget and reports the count', async () => {
  on();
  const ctx = setup({ WS_Guests: [guest()], WS_Bookings: [unpaid({ 'Gate Tap At': new Date(Date.now() - 20 * 60000).toISOString() })] });
  const res = { body: null, status() { return this; }, json(b) { this.body = b; return this; } };
  await wh.autoCheckoutHandler({}, res);
  assert.strictEqual(res.body.unattendedGateArrivals, 1);
  assert.ok(bookingRow(ctx, 'recB1').fields['Unattended Gate Arrival At']);
});

test('the flag shows as off when unset and on for 1/true in the cold-start flag state', () => {
  delete process.env.WABISTAY_ENQUIRY_TRACKING;
  assert.strictEqual(wh.wabistayFlagState().WABISTAY_ENQUIRY_TRACKING, 'off');
  process.env.WABISTAY_ENQUIRY_TRACKING = 'true';
  assert.strictEqual(wh.wabistayFlagState().WABISTAY_ENQUIRY_TRACKING, 'on');
});
