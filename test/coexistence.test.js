// test/coexistence.test.js
// Coexistence: human handoff via smb_message_echoes, suppression while
// HUMAN_HANDLING, and explicit "bot on" handback. Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable, metaTextPayload, metaEchoPayload, makeRes } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');

function makeCtx(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
async function send(payload) {
  const res = makeRes();
  await handler({ method: 'POST', body: payload }, res);
  return res;
}
const guestState = (ctx, id) => (ctx.airtable.tables['WS_Guests'] || []).find(g => g.id === id).fields['Session State'];

const property = { id: 'recP1', fields: { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } };
const GUEST_PHONE = '27821234567';
const OTHER_PHONE = '27829998888';

test('coexistence: a staff echo to a guest not yet handled sets HUMAN_HANDLING', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN' } }]
  });
  const res = await send(metaEchoPayload(GUEST_PHONE, "I'll sort your late checkout, one sec"));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(guestState(ctx, 'recG1'), 'HUMAN_HANDLING');
  assert.strictEqual(ctx.sends.length, 0, 'echo handling must never send the guest anything');
});

test('coexistence: guest messages are fully suppressed while HUMAN_HANDLING — no send, no state change', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': GUEST_PHONE, 'Session State': 'HUMAN_HANDLING' } }]
  });
  await send(metaTextPayload(GUEST_PHONE, 'hi'));
  await send(metaTextPayload(GUEST_PHONE, 'checkout'));
  await send(metaTextPayload(GUEST_PHONE, 'cancel')); // would normally hit the global "stuck" guard
  assert.strictEqual(ctx.sends.length, 0, 'bot must not reply to any guest message while suppressed');
  assert.strictEqual(guestState(ctx, 'recG1'), 'HUMAN_HANDLING', 'state must not drift while suppressed');
});

test('coexistence: "bot on" echo while HUMAN_HANDLING hands back to NEW, and normal flow resumes', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': GUEST_PHONE, 'Session State': 'HUMAN_HANDLING' } }]
  });
  await send(metaEchoPayload(GUEST_PHONE, 'BOT ON')); // case-insensitive
  assert.strictEqual(guestState(ctx, 'recG1'), 'NEW');
  assert.strictEqual(ctx.sends.length, 0, 'handback itself must never message the guest');

  // Bot resumes normal automated behaviour on the guest's next real message.
  await send(metaTextPayload(GUEST_PHONE, 'hi'));
  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(guestState(ctx, 'recG1'), 'AWAITING_STAY_TYPE');
});

test('coexistence: "bot on" echo when NOT currently HUMAN_HANDLING is a no-op — does not reset a guest mid-flow', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_HOURLY_DETAILS' } }]
  });
  await send(metaEchoPayload(GUEST_PHONE, 'bot on'));
  assert.strictEqual(guestState(ctx, 'recG1'), 'AWAITING_HOURLY_DETAILS', 'a stray "bot on" must not disturb an active flow');
});

test('coexistence: an echo to a phone with no WS_Guests row is a harmless no-op', async () => {
  const ctx = makeCtx({ WS_Properties: [property], WS_Guests: [] });
  const res = await send(metaEchoPayload(OTHER_PHONE, 'hey are you free tonight'));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(ctx.airtable.tables['WS_Guests'].length, 0, 'no guest row is created for an echo');
});

test('coexistence: a guest never taken over is completely unaffected by another guest\'s handoff', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Guests: [
      { id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': GUEST_PHONE, 'Session State': 'HUMAN_HANDLING' } },
      { id: 'recG2', fields: { 'Guest Name': 'Other Guest', 'Phone Number': OTHER_PHONE, 'Session State': 'NEW' } }
    ]
  });
  const res = await send(metaTextPayload(OTHER_PHONE, 'hi'));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(ctx.sends.length, 1, 'the untouched guest gets the normal automated reply');
  assert.strictEqual(guestState(ctx, 'recG2'), 'AWAITING_STAY_TYPE');
  assert.strictEqual(guestState(ctx, 'recG1'), 'HUMAN_HANDLING', 'the handed-off guest is untouched by someone else\'s message');
});

test('coexistence: repeated staff echoes to an already-suppressed guest are idempotent, no duplicate writes needed', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': GUEST_PHONE, 'Session State': 'HUMAN_HANDLING' } }]
  });
  await send(metaEchoPayload(GUEST_PHONE, 'still sorting this out'));
  await send(metaEchoPayload(GUEST_PHONE, 'almost done'));
  assert.strictEqual(guestState(ctx, 'recG1'), 'HUMAN_HANDLING');
  assert.strictEqual(ctx.airtable.log.filter(w => w.table === 'WS_Guests').length, 0, 'no redundant writes once already suppressed');
});
