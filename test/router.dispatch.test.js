// test/router.dispatch.test.js
// Router-level dispatch tests for api/webhook.js — separate from the wabistay
// replay suite in wabistay.replay.test.js, which exercises api/wabistay/webhook.js
// directly and never goes through the router at all.
//
// Added 11 Jul 2026 (Builder_Brief_Complete_Cutover.md): confirms the cutover —
// WP_PHONE_NUMBER_ID_CONST = null, WS_PHONE_NUMBER_ID_CONST = '1157302750805659' —
// behaves as intended: the reassigned number reaches Wabistay cleanly, and no
// phone_number_id can fall through to the (now-parked) Wabiprop branch.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, makeRes, installFetch, MockAirtable } = require('./harness');

installEnv();
const router = require('../api/webhook.js');

function routerPayload(phoneNumberId, from, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_TEST',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '27000000000', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: 'Test' }, wa_id: from }],
          messages: [{ from, id: 'wamid.incoming.test', timestamp: '1750000000', type: 'text', text: { body: text } }]
        }
      }]
    }]
  };
}

test('router: message on 1157302750805659 (Wabistay cutover number) dispatches to Wabistay handler cleanly', async () => {
  const ctx = {
    airtable: new MockAirtable({
      WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 1', Status: 'Available' } }],
      WS_Rates: [{ id: 'recRATE1', fields: { 'Rate Name': 'Standard Overnight', 'Rate Type': 'Per Night', Amount: 350, Active: true } }],
      WS_Guests: [],
      WS_Cleaners: []
    }),
    sends: [],
    axiom: []
  };
  installFetch(ctx);
  const res = makeRes();

  await router({ method: 'POST', body: routerPayload('1157302750805659', '27821234567', 'Hi') }, res);

  assert.strictEqual(res.statusCode, 200, 'router returns 200');
  assert.strictEqual(ctx.sends.length, 1, 'exactly one WhatsApp send — dispatched to Wabistay, not dropped or double-handled');
  assert.strictEqual(ctx.sends[0].to, '27821234567');
  assert.ok(ctx.sends[0].body.includes('Welcome to Villa Liza Guest Lodge'), 'reply is the Wabistay greeting, confirming wabistayHandler ran');
  assert.strictEqual(
    ctx.airtable.log.filter(w => w.table === 'WS_Guests').length, 1,
    'WS_Guests record created — confirms Wabistay side effects actually ran, not just the reply text'
  );
});

test('router: WP_PHONE_NUMBER_ID_CONST is null — an unrecognized phone_number_id never falls through to the parked Wabiprop branch', async () => {
  const ctx = { airtable: new MockAirtable({}), sends: [], axiom: [] };
  installFetch(ctx);
  const res = makeRes();

  // Deliberately NOT '1157302750805659' (now Wabistay) and NOT null/undefined —
  // a real-shaped but unrecognized id, e.g. the old WS sandbox test number,
  // which is no longer either constant.
  await router({ method: 'POST', body: routerPayload('1158666973993969', '27821234567', 'Hi') }, res);

  assert.strictEqual(res.statusCode, 200, 'router still returns 200 (never lets Meta retry)');
  assert.strictEqual(ctx.sends.length, 0, 'nothing sent — dropped, not routed to Wabiprop');
  assert.strictEqual(ctx.airtable.log.length, 0, 'no Airtable writes — WP_Leads branch was never entered');
  assert.ok(
    ctx.axiom.some(e => e.event === 'router_unknown_number_id'),
    'logged as router_unknown_number_id, confirming it hit the "neither known id" branch, not a silent Wabiprop match'
  );
});
