// test/checkoutwarningv2.test.js
// The checkout warning under WABISTAY_RATE_CARD_V2 tells the guest to ask reception for more time (the bot no longer sells
// extensions). Flag off: today's warning ("Reply EXTEND") is unchanged. Extensions stay reception-handled; nothing is built for them.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const saved = process.env.WABISTAY_RATE_CARD_V2;
afterEach(() => { if (saved === undefined) delete process.env.WABISTAY_RATE_CARD_V2; else process.env.WABISTAY_RATE_CARD_V2 = saved; });
const wh = require('../api/wabistay/webhook.js');

const NOW = new Date('2026-07-22T12:00:00.000Z');
function run(flag) {
  if (flag === null) delete process.env.WABISTAY_RATE_CARD_V2; else process.env.WABISTAY_RATE_CARD_V2 = flag;
  const ctx = {
    airtable: new MockAirtable({
      WS_Bookings: [{ id: 'recB1', fields: { Guest: ['recG1'], Status: 'Checked In', 'Booking Type': 'Hourly', Room: ['recR1'], 'Check Out': new Date(NOW.getTime() - 60000).toISOString() } }],
      WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': '27821234567' } }],
      WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Occupied', 'Property': ['recP1'] } }],
      WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Test Lodge' } }], WS_Cleaners: []
    }), sends: [], axiom: []
  };
  installFetch(ctx);
  return wh.runAutoCheckout(NOW).then(() => ctx);
}

test('V2 on: the warning tells the guest to ask reception, keeps the check-out and 15 minute lines, and no longer offers EXTEND', async () => {
  const ctx = await run('1');
  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].body, "Hi John Smith, checkout time at Test Lodge has arrived. ⏰\n\nNeed more time? Please ask reception.\nReady to go? Reply *1* to check out.\n\nIf we don't hear from you within 15 minutes, we'll check you out automatically.");
  assert.ok(!/EXTEND/.test(ctx.sends[0].body));
});

test('V2 off: today\'s warning, word for word', async () => {
  const ctx = await run(null);
  assert.strictEqual(ctx.sends[0].body, "Hi John Smith, checkout time at Test Lodge has arrived. ⏰\n\nNeed more time? Reply *EXTEND* to stay longer.\nReady to go? Reply *1* to check out.\n\nIf we don't hear from you within 15 minutes, we'll check you out automatically.");
});
