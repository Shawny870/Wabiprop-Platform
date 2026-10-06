// test/statuspricing.test.js
// The whatsapp_status_callback event also carries Meta's billing verdict from the status webhook's
// "pricing" object: billable, pricing_model and pricing_category (Meta's "category"). Added so the paid
// template messages can be attributed from Axiom. Left off when Meta sends no pricing object.
// Covered at both places that log it: the router (api/webhook.js, the Meta-configured entry point) and the
// Wabistay handler (api/wabistay/webhook.js, which handles it when invoked directly).
// In-memory only: mocked fetch.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, makeRes, installFetch, MockAirtable } = require('./harness');

installEnv();
const router = require('../api/webhook.js');
const wabistay = require('../api/wabistay/webhook.js');

const PHONE_NUMBER_ID = '1157302750805659';
function statusPayload(status) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_TEST', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '27000000000', phone_number_id: PHONE_NUMBER_ID },
      statuses: [status]
    } }] }]
  };
}
async function logged(handler, status) {
  const ctx = { airtable: new MockAirtable({}), sends: [], axiom: [] };
  installFetch(ctx);
  const res = makeRes();
  await handler({ method: 'POST', body: statusPayload(status) }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(ctx.sends.length, 0);
  return ctx.axiom.filter(e => e.event === 'whatsapp_status_callback');
}
const base = { id: 'wamid.pricing.test', status: 'delivered', timestamp: '1750000200', recipient_id: '27821234567' };

for (const [name, handler] of [['router', router], ['wabistay handler', wabistay]]) {
  test(`${name}: a utility template that is billed logs billable true, the pricing model and the category alongside wamid, status and recipient`, async () => {
    const events = await logged(handler, { ...base, pricing: { billable: true, pricing_model: 'PMP', category: 'utility' } });
    assert.strictEqual(events.length, 1);
    const e = events[0];
    assert.strictEqual(e.wamid, 'wamid.pricing.test');
    assert.strictEqual(e.status, 'delivered');
    assert.strictEqual(e.recipient, '27821234567');
    assert.strictEqual(e.billable, true);
    assert.strictEqual(e.pricing_model, 'PMP');
    assert.strictEqual(e.pricing_category, 'utility');
  });

  test(`${name}: a free service message logs billable false and its category`, async () => {
    const [e] = await logged(handler, { ...base, pricing: { billable: false, pricing_model: 'CBP', category: 'service' } });
    assert.strictEqual(e.billable, false);
    assert.strictEqual(e.pricing_model, 'CBP');
    assert.strictEqual(e.pricing_category, 'service');
  });

  test(`${name}: a marketing category is logged as sent`, async () => {
    const [e] = await logged(handler, { ...base, pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' } });
    assert.strictEqual(e.pricing_category, 'marketing');
  });

  test(`${name}: with no pricing object the event is exactly as before (no billing fields at all)`, async () => {
    const [e] = await logged(handler, { ...base, status: 'sent' });
    assert.strictEqual(e.wamid, 'wamid.pricing.test');
    assert.strictEqual(e.status, 'sent');
    for (const k of ['billable', 'pricing_model', 'pricing_category']) assert.ok(!(k in e), `${k} absent`);
  });

  test(`${name}: a failed status keeps its errors array and adds nothing when there is no pricing`, async () => {
    const errors = [{ code: 131026, title: 'Message undeliverable' }];
    const [e] = await logged(handler, { ...base, status: 'failed', errors });
    assert.deepStrictEqual(e.errors, errors);
    assert.ok(!('billable' in e));
  });
}
