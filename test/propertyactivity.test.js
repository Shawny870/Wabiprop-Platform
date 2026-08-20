// test/propertyactivity.test.js
// Property activity tracker (WS_Properties.'Last Message Received' /
// 'Last Owner App Open'). 'Last Report Sent' is deliberately NOT a field
// here — see the comment in api/wabistay/webhook.js above bumpPropertyActivity
// for why (Rule 29's read-only-cron invariant).

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, metaTextPayload, makeRes, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function seed() {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } }],
    WS_Guests: [],
    WS_Bookings: [],
    WS_Rooms: [],
    WS_Cleaners: []
  };
}

function setup(s) {
  const ctx = { airtable: new MockAirtable(s), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

test('an inbound guest message bumps Last Message Received on the resolved property', async () => {
  const ctx = setup(seed());
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload('27821234567', 'hi') }, res);

  const prop = ctx.airtable.tables.WS_Properties[0];
  assert.ok(prop.fields['Last Message Received'], 'field was written');
  assert.ok(!Number.isNaN(Date.parse(prop.fields['Last Message Received'])), 'value is a real timestamp');
});

test('a read receipt for the owner Notify Phone bumps Last Owner App Open on that property', async () => {
  const ctx = setup(seed());
  const res = makeRes();
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_TEST',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '111000111000' },
          statuses: [{ id: 'wamid.1', status: 'read', timestamp: '1750000000', recipient_id: '27831112222' }]
        }
      }]
    }]
  };
  await wh({ method: 'POST', body: payload }, res);
  // The lookup is fire-and-forget (see the comment in webhook.js) so give the
  // in-flight promise a tick to land before asserting.
  await new Promise(r => setTimeout(r, 20));

  const prop = ctx.airtable.tables.WS_Properties[0];
  assert.ok(prop.fields['Last Owner App Open'], 'field was written from the read receipt');
});

test('a read receipt for an unrelated number does not touch any property', async () => {
  const ctx = setup(seed());
  const res = makeRes();
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_TEST',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '111000111000' },
          statuses: [{ id: 'wamid.1', status: 'read', timestamp: '1750000000', recipient_id: '27899999999' }]
        }
      }]
    }]
  };
  await wh({ method: 'POST', body: payload }, res);
  await new Promise(r => setTimeout(r, 20));

  const prop = ctx.airtable.tables.WS_Properties[0];
  assert.strictEqual(prop.fields['Last Owner App Open'], undefined);
});

test('bumpPropertyActivity failing (bad table/field) does not throw — best-effort only', async () => {
  setup(seed());
  await assert.doesNotReject(wh.bumpPropertyActivity('recDOESNOTEXIST', 'Last Message Received'));
});
