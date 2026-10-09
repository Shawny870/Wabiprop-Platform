// test/ignorereactions.test.js
// Router: WABISTAY_IGNORE_REACTIONS. An emoji reaction on the Wabistay number is logged and
// answered with 200 and no reply. Flag off: unchanged. Other non-text types keep the reply.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaOtherPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_IGNORE_REACTIONS', 'WABISTAY_NONTEXT_REPLY', 'WABISTAY_INTERACTIVE'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const router = require('../api/webhook.js');
const WS_ID = '1157302750805659';
const GUEST = '27821234567';

const seed = () => ({
  WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': WS_ID, 'Notify Phone': '27831112222', 'Guest Redirect Phone': '0730260871' } }],
  WS_Rooms: [], WS_Rates: [], WS_Guests: [], WS_Cleaners: [], WS_Roles: [], WS_Enquiries: [], WS_Bookings: []
});
async function deliver(type, { ignore, nontext = '1', id = WS_ID } = {}) {
  if (ignore === undefined) delete process.env.WABISTAY_IGNORE_REACTIONS; else process.env.WABISTAY_IGNORE_REACTIONS = ignore;
  if (nontext === undefined) delete process.env.WABISTAY_NONTEXT_REPLY; else process.env.WABISTAY_NONTEXT_REPLY = nontext;
  const payload = metaOtherPayload(GUEST, type);
  payload.entry[0].changes[0].value.metadata.phone_number_id = id;
  const ctx = { airtable: new MockAirtable(seed()), sends: [], axiom: [] };
  installFetch(ctx);
  const res = makeRes();
  await router({ method: 'POST', body: payload }, res);
  return { ctx, res };
}
const ev = (ctx, n) => ctx.axiom.filter(e => e.event === n);

test('flag on: a reaction is ignored — 200, no reply, router_reaction_ignored logged, no nontext event', async () => {
  const { ctx, res } = await deliver('reaction', { ignore: '1' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(ctx.sends.length, 0);
  assert.strictEqual(ev(ctx, 'router_reaction_ignored').length, 1);
  assert.strictEqual(ev(ctx, 'router_nontext_message').length, 0);
});

test('flag off (unset): a reaction still gets the non-text reply, exactly as before', async () => {
  const { ctx } = await deliver('reaction', { ignore: undefined });
  assert.strictEqual(ctx.sends.length, 1);
  assert.match(ctx.sends[0].body, /I can only read typed messages/);
  assert.strictEqual(ev(ctx, 'router_reaction_ignored').length, 0);
});

for (const type of ['sticker', 'audio', 'image']) {
  test(`flag on: a ${type} still gets the non-text reply`, async () => {
    const { ctx } = await deliver(type, { ignore: '1' });
    assert.strictEqual(ctx.sends.length, 1);
    assert.match(ctx.sends[0].body, /I can only read typed messages/);
    assert.strictEqual(ev(ctx, 'router_reaction_ignored').length, 0);
  });
}

test('flag on: a reaction on a non-Wabistay number is untouched (old fallback reply)', async () => {
  const { ctx } = await deliver('reaction', { ignore: '1', nontext: undefined, id: '555000555' });
  assert.strictEqual(ev(ctx, 'router_reaction_ignored').length, 0);
  assert.strictEqual(ctx.sends.length, 1);
});
