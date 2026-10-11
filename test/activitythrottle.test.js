// test/activitythrottle.test.js
// WABISTAY_ACTIVITY_THROTTLE: skip the per-message 'Last Message Received' property write when the
// stamp on the row is under 10 minutes old. Off: every message writes. The 'Last Message Id'
// duplicate-message guard is untouched.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, metaTextPayload, makeRes, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const ENV = ['WABISTAY_ACTIVITY_THROTTLE', 'WABISTAY_MESSAGE_DEDUPE'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const minsAgo = n => new Date(Date.now() - n * 60000).toISOString();
function setup(stamp, flag) {
  if (flag === undefined) delete process.env.WABISTAY_ACTIVITY_THROTTLE; else process.env.WABISTAY_ACTIVITY_THROTTLE = flag;
  const fields = { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' };
  if (stamp !== undefined) fields['Last Message Received'] = stamp;
  const ctx = {
    airtable: new MockAirtable({ WS_Properties: [{ id: 'recP1', fields }], WS_Guests: [], WS_Bookings: [], WS_Rooms: [], WS_Cleaners: [] }),
    sends: [], axiom: []
  };
  installFetch(ctx);
  return ctx;
}
const say = (text, id) => wh({ method: 'POST', body: metaTextPayload('27821234567', text, id) }, makeRes());
const stampWrites = ctx => ctx.airtable.log.filter(l => l.op === 'update' && l.table === 'WS_Properties' && 'Last Message Received' in l.fields);

test('flag off (unset): every inbound message writes the stamp, even when it is seconds old', async () => {
  const ctx = setup(minsAgo(0.1), undefined);
  await say('hi'); await say('hi');
  assert.strictEqual(stampWrites(ctx).length, 2);
});

test('flag on: a stamp under 10 minutes old is not rewritten', async () => {
  const fresh = minsAgo(2);
  const ctx = setup(fresh, '1');
  await say('hi'); await say('hi');
  assert.strictEqual(stampWrites(ctx).length, 0);
  assert.strictEqual(ctx.airtable.tables.WS_Properties[0].fields['Last Message Received'], fresh);
});

test('flag on: a stamp over 10 minutes old is rewritten once, then the next message skips', async () => {
  const ctx = setup(minsAgo(11), 'true');
  await say('hi'); await say('hi');
  assert.strictEqual(stampWrites(ctx).length, 1, 'refreshed by the first message, fresh for the second');
});

test('flag on: a missing, garbage or future stamp is written', async () => {
  for (const stamp of [undefined, 'not a date', new Date(Date.now() + 3600000).toISOString()]) {
    const ctx = setup(stamp, '1');
    await say('hi');
    assert.strictEqual(stampWrites(ctx).length, 1, `stamp ${stamp}`);
  }
});

test('flag on: the duplicate-message guard still stamps Last Message Id before the handler returns', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = setup(minsAgo(1), '1');
  ctx.airtable.tables.WS_Guests.push({ id: 'recG1', fields: { 'Phone Number': '27821234567', 'Session State': 'NEW', 'Guest Type': 'WhatsApp' } });
  await say('hi', 'wamid.AAA');
  const guest = ctx.airtable.tables.WS_Guests[0];
  assert.strictEqual(guest.fields['Last Message Id'], 'wamid.AAA');
  await say('hi', 'wamid.AAA');
  assert.strictEqual(ctx.sends.length, 1, 'the duplicate got no second reply');
  assert.ok(ctx.axiom.some(e => e.event === 'duplicate_message_skipped'));
});

test('messageReceivedStampIsFresh: boundaries', () => {
  const now = Date.parse('2026-10-12T10:00:00.000Z');
  const p = ms => ({ fields: { 'Last Message Received': new Date(now - ms).toISOString() } });
  assert.strictEqual(wh.messageReceivedStampIsFresh(p(0), now), true);
  assert.strictEqual(wh.messageReceivedStampIsFresh(p(599999), now), true);
  assert.strictEqual(wh.messageReceivedStampIsFresh(p(600000), now), false);
  assert.strictEqual(wh.messageReceivedStampIsFresh({ fields: {} }, now), false);
  assert.strictEqual(wh.messageReceivedStampIsFresh(null, now), false);
});
