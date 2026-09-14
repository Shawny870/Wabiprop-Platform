// test/gateack.test.js
// Gate-ack escalation feature: 'Gate Notify Sent At' stamping at gate arrival,
// the "YES" ack reply (senderConfirmingGateAck / gateAckConfirm), and the
// runGateAckEscalation cron sweep + alertGateAckTimeout escalation message.
// Modeled on test/autocheckout.test.js (cron sweep) and test/cleanergate.test.js
// (gate-arrival dispatch through the real handler). Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable, metaTextPayload, makeRes, TEST_ENV } = require('./harness');

installEnv();

function freshWebhook() {
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  return require('../api/wabistay/webhook.js');
}

function setup(seed = {}) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

const propertyA = { id: 'recP1', fields: { 'Property Name': 'Test Lodge', 'Phone Number ID': TEST_ENV.WA_PHONE_NUMBER_ID, 'Notify Phone': '27831112222' } };
const room = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'] } };
const guest = { id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': '27821234567', 'Session State': 'CONFIRMED' } };
const booking = { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Confirmed' } };
const ownerNotifyRows = [
  { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831112222', Active: true, Verified: true } }
];
const cleanerA = { id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '27821110000', Active: true, 'Assigned Property': ['recP1'] } };

// ── gateArrival: 'Gate Notify Sent At' stamping ─────────────────────────────

test('gateArrival stamps Gate Notify Sent At once, and asks for an ack in the owner message', async () => {
  const ctx = setup({
    WS_Properties: [propertyA], WS_Rooms: [room], WS_Guests: [guest],
    WS_Bookings: [booking], WS_Cleaners: [], WS_Owner_Notify: ownerNotifyRows
  });
  const wh = freshWebhook();
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27821234567', '1') }, res);
  await new Promise(r => setImmediate(r));

  const stampWrite = ctx.airtable.log.find(l => l.table === 'WS_Bookings' && l.fields['Gate Notify Sent At']);
  assert.ok(stampWrite, `expected a Gate Notify Sent At stamp, writes: ${JSON.stringify(ctx.airtable.log)}`);
  assert.strictEqual(stampWrite.id, 'recB1');

  const ownerSend = ctx.sends.find(s => s.to === '27831112222');
  assert.ok(ownerSend, 'owner-notify recipient should be messaged');
  assert.match(ownerSend.body, /Reply YES to confirm you've got this\./);
});

test('gateArrival does not re-stamp Gate Notify Sent At if the booking already carries one', async () => {
  const alreadyStamped = { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Confirmed', 'Gate Notify Sent At': '2026-01-01T00:00:00.000Z' } };
  const ctx = setup({
    WS_Properties: [propertyA], WS_Rooms: [room], WS_Guests: [guest],
    WS_Bookings: [alreadyStamped], WS_Cleaners: [], WS_Owner_Notify: ownerNotifyRows
  });
  const wh = freshWebhook();
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27821234567', '1') }, res);
  await new Promise(r => setImmediate(r));

  const stampWrites = ctx.airtable.log.filter(l => l.table === 'WS_Bookings' && l.fields['Gate Notify Sent At']);
  assert.strictEqual(stampWrites.length, 0, 'must not re-stamp an already-stamped booking');
});

// ── senderConfirmingGateAck / gateAckConfirm: the "YES" reply ──────────────

test('a cleaner replying YES acks the pending booking for their assigned property', async () => {
  const sentBooking = { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Checked In', 'WS_Property': ['recP1'], 'Gate Notify Sent At': '2026-01-01T00:00:00.000Z' } };
  const ctx = setup({
    WS_Properties: [propertyA], WS_Rooms: [room], WS_Guests: [guest],
    WS_Bookings: [sentBooking], WS_Cleaners: [cleanerA], WS_Owner_Notify: ownerNotifyRows
  });
  const wh = freshWebhook();
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27821110000', 'YES') }, res);
  await new Promise(r => setImmediate(r));

  const ackWrite = ctx.airtable.log.find(l => l.table === 'WS_Bookings' && l.fields['Gate Notify Acked At']);
  assert.ok(ackWrite, `expected a Gate Notify Acked At write, writes: ${JSON.stringify(ctx.airtable.log)}`);
  assert.strictEqual(ackWrite.id, 'recB1');
});

test('an owner-notify recipient replying yes (case-insensitive) also acks the booking', async () => {
  const sentBooking = { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Checked In', 'WS_Property': ['recP1'], 'Gate Notify Sent At': '2026-01-01T00:00:00.000Z' } };
  const ctx = setup({
    WS_Properties: [propertyA], WS_Rooms: [room], WS_Guests: [guest],
    WS_Bookings: [sentBooking], WS_Cleaners: [], WS_Owner_Notify: ownerNotifyRows
  });
  const wh = freshWebhook();
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27831112222', 'yes') }, res);
  await new Promise(r => setImmediate(r));

  const ackWrite = ctx.airtable.log.find(l => l.table === 'WS_Bookings' && l.fields['Gate Notify Acked At']);
  assert.ok(ackWrite, `expected a Gate Notify Acked At write, writes: ${JSON.stringify(ctx.airtable.log)}`);
  assert.strictEqual(ackWrite.id, 'recB1');
});

test('YES from an unrecognized number (neither cleaner nor owner-notify) is not treated as a gate ack', async () => {
  const sentBooking = { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Checked In', 'WS_Property': ['recP1'], 'Gate Notify Sent At': '2026-01-01T00:00:00.000Z' } };
  const ctx = setup({
    WS_Properties: [propertyA], WS_Rooms: [room], WS_Guests: [],
    WS_Bookings: [sentBooking], WS_Cleaners: [], WS_Owner_Notify: ownerNotifyRows
  });
  const wh = freshWebhook();
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27899990000', 'yes') }, res);
  await new Promise(r => setImmediate(r));

  const ackWrite = ctx.airtable.log.find(l => l.fields && l.fields['Gate Notify Acked At']);
  assert.ok(!ackWrite, 'an unrecognized sender must not be able to ack a booking');
});

test('a cleaner replying YES with no pending gate notification for their property does nothing destructive', async () => {
  const ctx = setup({
    WS_Properties: [propertyA], WS_Rooms: [room], WS_Guests: [],
    WS_Bookings: [], WS_Cleaners: [cleanerA], WS_Owner_Notify: []
  });
  const wh = freshWebhook();
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27821110000', 'YES') }, res);
  await new Promise(r => setImmediate(r));

  assert.ok(ctx.axiom.some(e => e.event === 'gate_ack_no_pending_booking'));
  const ackWrite = ctx.airtable.log.find(l => l.fields && l.fields['Gate Notify Acked At']);
  assert.ok(!ackWrite, 'no booking to ack, so no ack write should occur');
});

// ── runGateAckEscalation: the cron sweep ────────────────────────────────────

const NOW = new Date('2026-07-22T12:00:00.000Z');
const minsBefore = m => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

test('runGateAckEscalation: unacked past the default 10-minute grace escalates via alertShawn with a distinct message', async () => {
  const pendingBooking = {
    id: 'recB1',
    fields: {
      Guest: ['recG1'], Status: 'Checked In', 'WS_Property': ['recP1'],
      'Gate Notify Sent At': minsBefore(11), 'Booking Ref': 'WS-0001'
    }
  };
  const ctx = setup({
    WS_Properties: [propertyA], WS_Guests: [guest], WS_Bookings: [pendingBooking],
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }]
  });
  delete process.env.GATE_ACK_GRACE_MS;
  const wh = freshWebhook();
  const summary = await wh.runGateAckEscalation(NOW);
  assert.deepStrictEqual(summary, { escalated: 1 });

  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].to, '27811110000');
  assert.ok(!ctx.sends[0].body.includes('WABISTAY CRON ERROR'), 'must NOT reuse the cron-failure message verbatim');
  assert.match(ctx.sends[0].body, /unacknowledged/);
  assert.ok(ctx.sends[0].body.includes('WS-0001'), 'names the booking');
  assert.ok(ctx.sends[0].body.includes('Test Lodge'), 'names the property');
  assert.ok(ctx.sends[0].body.includes('John Smith'), 'names the guest');
});

test('runGateAckEscalation: still inside grace → no escalation', async () => {
  const pendingBooking = {
    id: 'recB1',
    fields: { Guest: ['recG1'], Status: 'Checked In', 'WS_Property': ['recP1'], 'Gate Notify Sent At': minsBefore(5) }
  };
  const ctx = setup({
    WS_Properties: [propertyA], WS_Guests: [guest], WS_Bookings: [pendingBooking],
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }]
  });
  delete process.env.GATE_ACK_GRACE_MS;
  const wh = freshWebhook();
  const summary = await wh.runGateAckEscalation(NOW);
  assert.deepStrictEqual(summary, { escalated: 0 });
  assert.strictEqual(ctx.sends.length, 0);
});

test('runGateAckEscalation: already acked → no escalation regardless of elapsed time', async () => {
  const ackedBooking = {
    id: 'recB1',
    fields: {
      Guest: ['recG1'], Status: 'Checked In', 'WS_Property': ['recP1'],
      'Gate Notify Sent At': minsBefore(60), 'Gate Notify Acked At': minsBefore(55)
    }
  };
  const ctx = setup({
    WS_Properties: [propertyA], WS_Guests: [guest], WS_Bookings: [ackedBooking],
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }]
  });
  delete process.env.GATE_ACK_GRACE_MS;
  const wh = freshWebhook();
  const summary = await wh.runGateAckEscalation(NOW);
  assert.deepStrictEqual(summary, { escalated: 0 });
  assert.strictEqual(ctx.sends.length, 0);
});

test('runGateAckEscalation: no Gate Notify Sent At at all → ignored (never sent)', async () => {
  const untouched = { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Confirmed', 'WS_Property': ['recP1'] } };
  const ctx = setup({
    WS_Properties: [propertyA], WS_Guests: [guest], WS_Bookings: [untouched],
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }]
  });
  delete process.env.GATE_ACK_GRACE_MS;
  const wh = freshWebhook();
  const summary = await wh.runGateAckEscalation(NOW);
  assert.deepStrictEqual(summary, { escalated: 0 });
  assert.strictEqual(ctx.sends.length, 0);
});

test('runGateAckEscalation: GATE_ACK_GRACE_MS env var overrides the 10-minute default', async () => {
  const pendingBooking = {
    id: 'recB1',
    fields: { Guest: ['recG1'], Status: 'Checked In', 'WS_Property': ['recP1'], 'Gate Notify Sent At': minsBefore(3) }
  };
  const ctx = setup({
    WS_Properties: [propertyA], WS_Guests: [guest], WS_Bookings: [pendingBooking],
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }]
  });
  process.env.GATE_ACK_GRACE_MS = String(2 * 60 * 1000); // 2 minutes — 3 elapsed should now fire
  const wh = freshWebhook();
  const summary = await wh.runGateAckEscalation(NOW);
  assert.deepStrictEqual(summary, { escalated: 1 });
  assert.strictEqual(ctx.sends.length, 1);
  delete process.env.GATE_ACK_GRACE_MS;
});

test('gateAckGraceMs() falls back to the 10-minute default on an invalid env value', async () => {
  process.env.GATE_ACK_GRACE_MS = 'not-a-number';
  const wh = freshWebhook();
  assert.strictEqual(wh.gateAckGraceMs(), wh.DEFAULT_GATE_ACK_GRACE_MS);
  delete process.env.GATE_ACK_GRACE_MS;
});

// ── autoCheckoutHandler: per-sweep isolation ────────────────────────────────

test('autoCheckoutHandler runs the gate-ack sweep alongside auto-checkout/enquiry-abandonment and reports its count', async () => {
  const pendingBooking = {
    id: 'recB1',
    fields: { Guest: ['recG1'], Status: 'Checked In', 'WS_Property': ['recP1'], 'Gate Notify Sent At': new Date(Date.now() - 20 * 60 * 1000).toISOString() }
  };
  setup({
    WS_Properties: [propertyA], WS_Guests: [], WS_Bookings: [pendingBooking], WS_Rooms: [],
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }]
  });
  delete process.env.GATE_ACK_GRACE_MS;
  const wh = freshWebhook();
  const res = makeRes();
  res.json = body => { res._json = body; return res; };
  await wh.autoCheckoutHandler({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res._json.ok, true);
  assert.strictEqual(res._json.escalated, 1);
});

