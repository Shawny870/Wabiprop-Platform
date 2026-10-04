// test/nontextreply.test.js
// Router: WABISTAY_NONTEXT_REPLY. A voice note / image / other non-text message on the
// Wabistay number is answered from the phone_number_id it ARRIVED on (never
// WP_PHONE_NUMBER_ID, which the old fallback used), quoting the lodge's own phone.
// Flag off: today's reply, exactly. In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, metaInteractivePayload, metaOtherPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_NONTEXT_REPLY', 'WABISTAY_INTERACTIVE', 'WP_PHONE_NUMBER_ID'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const router = require('../api/webhook.js');
const WS_ID = '1157302750805659';
const GUEST = '27821234567';
const OLD_REPLY = 'Please send your message as text. Voice notes and images are not supported yet.';
const NEW_REPLY = lodge => `Sorry, I can only read typed messages. Please type your message, or phone us on a normal call to ${lodge}. Please do not use WhatsApp calling, as it will not ring.`;

function seed(propertyFields = {}, withProperty = true) {
  return {
    WS_Properties: withProperty ? [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': WS_ID, 'Notify Phone': '27831112222', ...propertyFields } }] : [],
    WS_Rooms: [], WS_Rates: [], WS_Guests: [], WS_Cleaners: [], WS_Roles: [], WS_Enquiries: [], WS_Bookings: []
  };
}
async function deliver(payload, { flag, seedData = seed() } = {}) {
  if (flag === undefined) delete process.env.WABISTAY_NONTEXT_REPLY; else process.env.WABISTAY_NONTEXT_REPLY = flag;
  const ctx = { airtable: new MockAirtable(seedData), sends: [], axiom: [] };
  installFetch(ctx);
  const res = makeRes();
  await router({ method: 'POST', body: payload }, res);
  return { ctx, res };
}
const withId = (payload, id) => { payload.entry[0].changes[0].value.metadata.phone_number_id = id; return payload; };
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);

test('flag off: a voice note gets today\'s reply, sent through WP_PHONE_NUMBER_ID (unset here -> "undefined"), no event', async () => {
  delete process.env.WP_PHONE_NUMBER_ID;
  const { ctx, res } = await deliver(withId(metaOtherPayload(GUEST, 'audio'), WS_ID));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].body, OLD_REPLY);
  assert.strictEqual(ctx.sends[0].fromId, 'undefined', 'the old reply is sent from WP_PHONE_NUMBER_ID, not the arriving number');
  assert.strictEqual(events(ctx, 'router_nontext_message').length, 0);
});

for (const type of ['audio', 'image', 'sticker', 'video', 'document']) {
  test(`flag on: a ${type} message gets the new reply with the property's Guest Redirect Phone, sent from the arriving number`, async () => {
    process.env.WP_PHONE_NUMBER_ID = '999999999999';
    const { ctx, res } = await deliver(withId(metaOtherPayload(GUEST, type), WS_ID), { flag: '1', seedData: seed({ 'Guest Redirect Phone': '0730260871' }) });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(ctx.sends.length, 1);
    assert.strictEqual(ctx.sends[0].to, GUEST);
    assert.strictEqual(ctx.sends[0].body, NEW_REPLY('0730260871'));
    assert.strictEqual(ctx.sends[0].fromId, WS_ID, 'from the phone_number_id it arrived on');
    assert.notStrictEqual(ctx.sends[0].fromId, '999999999999', 'never WP_PHONE_NUMBER_ID');
    const ev = events(ctx, 'router_nontext_message');
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].messageType, type);
    assert.strictEqual(ev[0].lodgePhoneSource, 'property');
  });
}

test('flag on: another property\'s own Guest Redirect Phone is quoted (not a hard-coded number)', async () => {
  const { ctx } = await deliver(withId(metaOtherPayload(GUEST, 'image'), WS_ID), { flag: 'true', seedData: seed({ 'Guest Redirect Phone': '0821112222' }) });
  assert.strictEqual(ctx.sends[0].body, NEW_REPLY('0821112222'));
});

test('flag on: property cannot be resolved, or has no Guest Redirect Phone -> the constant lodge number', async () => {
  const none = await deliver(withId(metaOtherPayload(GUEST, 'audio'), WS_ID), { flag: '1', seedData: seed({}, false) });
  assert.strictEqual(none.ctx.sends[0].body, NEW_REPLY('0730260871'));
  assert.strictEqual(events(none.ctx, 'router_nontext_message')[0].lodgePhoneSource, 'constant');
  const blank = await deliver(withId(metaOtherPayload(GUEST, 'audio'), WS_ID), { flag: '1', seedData: seed({ 'Guest Redirect Phone': '' }) });
  assert.strictEqual(blank.ctx.sends[0].body, NEW_REPLY('0730260871'));
  assert.strictEqual(events(blank.ctx, 'router_nontext_message')[0].lodgePhoneSource, 'constant');
});

test('flag on: a non-Wabistay number is untouched — old fallback behaviour, no new reply', async () => {
  const { ctx } = await deliver(withId(metaOtherPayload(GUEST, 'audio'), '1158666973993969'), { flag: '1' });
  assert.ok(!ctx.sends.some(s => /can only read typed messages/.test(s.body || '')));
  assert.strictEqual(events(ctx, 'router_nontext_message').length, 0);
});

test('flag values: only 1/true turn it on', async () => {
  for (const [flag, on] of [['1', true], ['true', true], ['TRUE', true], ['yes', false], ['0', false], ['', false]]) {
    const { ctx } = await deliver(withId(metaOtherPayload(GUEST, 'audio'), WS_ID), { flag, seedData: seed({ 'Guest Redirect Phone': '0730260871' }) });
    assert.strictEqual(/can only read typed messages/.test(ctx.sends[0].body), on, `flag ${JSON.stringify(flag)}`);
  }
});

test('typed text on the Wabistay number is routed exactly as before, with the flag on or off', async () => {
  for (const flag of [undefined, '1']) {
    const { ctx } = await deliver(withId(metaTextPayload(GUEST, 'Hi'), WS_ID), { flag, seedData: seed({ 'Guest Redirect Phone': '0730260871' }) });
    assert.ok(ctx.sends.some(s => /Welcome to Canary Street Guest Rooms/.test(s.body || '')), `flag ${flag}`);
    assert.ok(!ctx.sends.some(s => /can only read typed messages/.test(s.body || '')));
  }
});

test('an interactive reply with WABISTAY_INTERACTIVE off is just non-text: flag-1 reply when WABISTAY_NONTEXT_REPLY is on, today\'s reply when off', async () => {
  delete process.env.WABISTAY_INTERACTIVE;
  const on = await deliver(withId(metaInteractivePayload(GUEST, { id: 'pay_card', title: 'Card' }), WS_ID), { flag: '1', seedData: seed({ 'Guest Redirect Phone': '0730260871' }) });
  assert.strictEqual(on.ctx.sends[0].body, NEW_REPLY('0730260871'));
  const off = await deliver(withId(metaInteractivePayload(GUEST, { id: 'pay_card', title: 'Card' }), WS_ID));
  assert.strictEqual(off.ctx.sends[0].body, OLD_REPLY);
});

test('with WABISTAY_INTERACTIVE on, an interactive reply on the Wabistay number is NOT answered as non-text (it is forwarded)', async () => {
  process.env.WABISTAY_INTERACTIVE = '1';
  const { ctx } = await deliver(withId(metaInteractivePayload(GUEST, { id: 'pay_card', title: 'Card' }), WS_ID), { flag: '1', seedData: seed({ 'Guest Redirect Phone': '0730260871' }) });
  assert.ok(!ctx.sends.some(s => /can only read typed messages|Please send your message as text/.test(s.body || '')));
  assert.ok(ctx.axiom.some(e => e.event === 'router_route' && e.reason === 'interactive_reply'));
});
