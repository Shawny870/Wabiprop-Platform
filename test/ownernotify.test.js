// test/ownernotify.test.js
// WS_Owner_Notify — multi-recipient owner notifications, replacing the single
// WS_Properties.'Notify Phone' field. Mirrors WS_Cleaners exactly (Active
// checkbox, Property link, Phone Number, every active row notified — see
// activeOwnerRecipientsForProperty/activeCleanersForProperty). Adds a hard
// verification gate on top (CEO decision, confirmed): an unverified recipient
// is skipped from every send, not merely warned about.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable, metaTextPayload, makeRes } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

const property = { id: 'recP1', fields: { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000' } };

// ── activeOwnerRecipientsForProperty / resolveOwnerNotifyRecipients ─────────

test('activeOwnerRecipientsForProperty: returns only Active rows scoped to the property, mirroring activeCleanersForProperty', async () => {
  setup({
    WS_Owner_Notify: [
      { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831110000', Active: true, Verified: true } },
      { id: 'recON2', fields: { Property: ['recP1'], 'Phone Number': '27831110001', Active: false, Verified: true } }, // inactive
      { id: 'recON3', fields: { Property: ['recP2'], 'Phone Number': '27839990000', Active: true, Verified: true } }  // other property
    ]
  });
  const rows = await wh.activeOwnerRecipientsForProperty('recP1');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 'recON1');
});

test('resolveOwnerNotifyRecipients: unverified rows are skipped (hard gate) and each skip is logged', async () => {
  const ctx = setup({
    WS_Owner_Notify: [
      { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831110000', Active: true, Verified: true } },
      { id: 'recON2', fields: { Property: ['recP1'], 'Phone Number': '27831110001', Active: true, Verified: false } }
    ]
  });
  const recipients = await wh.resolveOwnerNotifyRecipients('recP1', 'weekly_recap');
  assert.strictEqual(recipients.length, 1);
  assert.strictEqual(recipients[0].id, 'recON1');

  const skip = ctx.axiom.find(e => e.event === 'owner_notify_unverified_skipped');
  assert.ok(skip, 'the unverified row is logged, not silently dropped');
  assert.strictEqual(skip.recipientId, 'recON2');
  assert.strictEqual(skip.site, 'weekly_recap');
});

test('resolveOwnerNotifyRecipients: zero verified recipients (rows exist, none confirmed) alerts loudly, not silently', async () => {
  const ctx = setup({
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }],
    WS_Owner_Notify: [
      { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831110000', Active: true, Verified: false } }
    ]
  });
  const recipients = await wh.resolveOwnerNotifyRecipients('recP1', 'monthly_report');
  assert.strictEqual(recipients.length, 0);

  const zero = ctx.axiom.find(e => e.event === 'owner_notify_zero_recipients');
  assert.ok(zero);
  assert.strictEqual(zero.totalActiveRows, 1, 'distinguishes "rows exist but unverified" from "table not migrated yet"');

  const alert = ctx.sends.find(s => s.to === '27811110000');
  assert.ok(alert, 'alertShawn fires when active rows exist but none are verified');
});

test('resolveOwnerNotifyRecipients: zero rows at all (not migrated yet) logs zero-recipients but does NOT page alertShawn', async () => {
  const ctx = setup({ WS_Owner_Notify: [] });
  const recipients = await wh.resolveOwnerNotifyRecipients('recP1', 'monthly_report');
  assert.strictEqual(recipients.length, 0);
  const zero = ctx.axiom.find(e => e.event === 'owner_notify_zero_recipients');
  assert.ok(zero);
  assert.strictEqual(zero.totalActiveRows, 0);
  assert.strictEqual(ctx.sends.length, 0, 'no WS_Config seeded and no rows exist — nothing to alert about yet');
});

// ── Multi-recipient fan-out: monthly/weekly send their OWN message per recipient ──

test('sendWeeklyRecap: every verified active recipient gets their OWN template send — not one merged send', async () => {
  const NOW = new Date('2026-08-20T06:00:00.000Z');
  const rooms = [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': ['recP1'] } }];
  const ownerProperty = { id: 'recP1', fields: { 'Property Name': 'Test Lodge', 'Owner': ['recOwner1'] } };
  const ctx = setup({
    WS_Properties: [ownerProperty],
    WS_Owners: [{ id: 'recOwner1', fields: { 'Owner Name': 'Test Owner' } }],
    WS_Rooms: rooms,
    WS_Bookings: [],
    WS_Guests: [],
    WS_Owner_Notify: [
      { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831110000', Active: true, Verified: true } },
      { id: 'recON2', fields: { Property: ['recP1'], 'Phone Number': '27831110001', Active: true, Verified: true } },
      { id: 'recON3', fields: { Property: ['recP1'], 'Phone Number': '27831110002', Active: true, Verified: false } } // hard-gated out
    ]
  });

  await wh.runWeeklyRecap({ now: NOW });

  assert.strictEqual(ctx.sends.length, 2, 'two verified recipients — the unverified third is skipped');
  const tos = ctx.sends.map(s => s.to).sort();
  assert.deepStrictEqual(tos, ['27831110000', '27831110001']);
  for (const s of ctx.sends) {
    assert.strictEqual(s.type, 'template');
    assert.strictEqual(s.template, wh.WEEKLY_RECAP_TEMPLATE);
  }
});

// ── Gate-arrival owner courtesy notification: multi-recipient, free-form ────

test('gate arrival: every verified active WS_Owner_Notify recipient gets their own free-form courtesy send', async () => {
  const guest = { id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': '27821234567', 'Session State': 'CONFIRMED' } };
  const room = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'] } };
  const booking = { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Confirmed' } };
  const ctx = setup({
    WS_Properties: [property],
    WS_Rooms: [room],
    WS_Guests: [guest],
    WS_Bookings: [booking],
    WS_Cleaners: [],
    WS_Owner_Notify: [
      { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831110000', Active: true, Verified: true } },
      { id: 'recON2', fields: { Property: ['recP1'], 'Phone Number': '27831110001', Active: true, Verified: true } },
      { id: 'recON3', fields: { Property: ['recP1'], 'Phone Number': '27831110099', Active: true, Verified: false } }
    ]
  });

  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27821234567', '1') }, res);
  await new Promise(r => setImmediate(r));

  const ownerSends = ctx.sends.filter(s => s.type === 'text' && s.body.includes('is at the gate'));
  assert.strictEqual(ownerSends.length, 2, 'both verified recipients get their own courtesy send');
  assert.deepStrictEqual(ownerSends.map(s => s.to).sort(), ['27831110000', '27831110001']);
  assert.ok(!ctx.sends.some(s => s.to === '27831110099'), 'the unverified recipient is never sent to');

  const skip = ctx.axiom.find(e => e.event === 'owner_notify_unverified_skipped' && e.recipientId === 'recON3');
  assert.ok(skip, 'the skip is logged against the specific recipient');
});

// ── sendOwnerNotifyVerification: stub-until-approved, same contract as every ──
// ── other business-initiated template send in this file ─────────────────────

test('sendOwnerNotifyVerification: stubbed while WABISTAY_OWNER_NOTIFY_VERIFY_TEMPLATE is unset — no send, logged loudly', async () => {
  delete process.env.WABISTAY_OWNER_NOTIFY_VERIFY_TEMPLATE;
  const ctx = setup({});
  const recipient = { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831110000', Active: true, Verified: false } };

  const result = await wh.sendOwnerNotifyVerification(recipient, property);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'stubbed');
  assert.strictEqual(ctx.sends.length, 0, 'no free-form fallback — outside the 24h window, would 200-and-vanish');
  const stub = ctx.axiom.find(e => e.event === 'owner_notify_verification_stubbed');
  assert.ok(stub);
  assert.strictEqual(stub.recipientId, 'recON1');
});

test('sendOwnerNotifyVerification: sends the template once configured', async () => {
  const previous = process.env.WABISTAY_OWNER_NOTIFY_VERIFY_TEMPLATE;
  process.env.WABISTAY_OWNER_NOTIFY_VERIFY_TEMPLATE = 'wabistay_owner_notify_verify';
  try {
    const ctx = setup({});
    const recipient = { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831110000', Active: true, Verified: false } };
    const result = await wh.sendOwnerNotifyVerification(recipient, property);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(ctx.sends.length, 1);
    assert.strictEqual(ctx.sends[0].type, 'template');
    assert.strictEqual(ctx.sends[0].template, 'wabistay_owner_notify_verify');
    assert.strictEqual(ctx.sends[0].to, '27831110000');
  } finally {
    if (previous === undefined) delete process.env.WABISTAY_OWNER_NOTIFY_VERIFY_TEMPLATE;
    else process.env.WABISTAY_OWNER_NOTIFY_VERIFY_TEMPLATE = previous;
  }
});

// ── Inbound "confirm" reply verifies the pending row, scoped to this property ──

test('inbound "confirm" from a pending recipient\'s number marks their WS_Owner_Notify row Verified', async () => {
  const ctx = setup({
    WS_Properties: [property],
    WS_Owner_Notify: [
      { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831110000', Active: true, Verified: false } }
    ]
  });

  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27831110000', 'confirm') }, res);
  await new Promise(r => setImmediate(r));

  const write = ctx.airtable.log.find(w => w.table === 'WS_Owner_Notify' && w.id === 'recON1');
  assert.ok(write, 'the row is written');
  assert.strictEqual(write.fields['Verified'], true);

  const verified = ctx.axiom.find(e => e.event === 'owner_notify_verified' && e.recipientId === 'recON1');
  assert.ok(verified);

  const ack = ctx.sends.find(s => s.to === '27831110000');
  assert.ok(ack, 'the recipient gets an acknowledgement');
});

test('inbound "confirm" does not verify a row for a DIFFERENT property\'s number (phone_number_id scoping)', async () => {
  const propertyB = { id: 'recP2', fields: { 'Property Name': 'Other Lodge', 'Phone Number ID': '222000222000' } };
  const ctx = setup({
    WS_Properties: [property, propertyB],
    WS_Owner_Notify: [
      // Pending row belongs to recP2, but the CONFIRM arrives on recP1's number.
      { id: 'recON1', fields: { Property: ['recP2'], 'Phone Number': '27831110000', Active: true, Verified: false } }
    ]
  });

  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27831110000', 'confirm') }, res);
  await new Promise(r => setImmediate(r));

  assert.strictEqual(
    ctx.airtable.log.filter(w => w.table === 'WS_Owner_Notify').length, 0,
    'no WS_Owner_Notify write — the pending row belongs to a different property than the one this number messaged'
  );
});

test('inbound "confirm" from a number with no pending WS_Owner_Notify row falls through unchanged', async () => {
  const guest = { id: 'recG1', fields: { 'Guest Name': 'Random Guest', 'Phone Number': '27820001111', 'Session State': 'NEW' } };
  const ctx = setup({
    WS_Properties: [property],
    WS_Guests: [guest],
    WS_Owner_Notify: []
  });

  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27820001111', 'confirm') }, res);
  await new Promise(r => setImmediate(r));

  assert.strictEqual(ctx.airtable.log.filter(w => w.table === 'WS_Owner_Notify').length, 0);
  const verified = ctx.axiom.find(e => e.event === 'owner_notify_verified');
  assert.ok(!verified, 'nothing was verified for an unrelated number');
});

// ── Staff-not-guest exclusions extended to WS_Owner_Notify numbers ──────────

test('an owner-notify recipient number never gets the POPIA consent notice', async () => {
  const ctx = setup({
    WS_Properties: [property],
    WS_Owner_Notify: [
      { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831110000', Active: true, Verified: true } }
    ]
  });

  const res = makeRes();
  // A message that is NOT the confirm keyword, from a never-before-seen number.
  await wh({ method: 'POST', body: metaTextPayload('27831110000', 'hello') }, res);
  await new Promise(r => setImmediate(r));

  assert.ok(!ctx.sends.some(s => s.body && s.body.includes('POPIA')), 'no consent notice sent to a staff/owner-notify number');
});

test('STOP from an owner-notify recipient number is ignored as a staff number, not written as a guest opt-out', async () => {
  const ctx = setup({
    WS_Properties: [property],
    WS_Owner_Notify: [
      { id: 'recON1', fields: { Property: ['recP1'], 'Phone Number': '27831110000', Active: true, Verified: true } }
    ]
  });

  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27831110000', 'stop') }, res);
  await new Promise(r => setImmediate(r));

  assert.strictEqual(ctx.airtable.log.filter(w => w.table === 'WS_Guests').length, 0, 'no WS_Guests row created/opted-out for a staff number');
  const ignored = ctx.axiom.find(e => e.event === 'stop_ignored_staff_number');
  assert.ok(ignored);
});
