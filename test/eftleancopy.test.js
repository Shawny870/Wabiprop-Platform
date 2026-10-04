// test/eftleancopy.test.js
// WABISTAY_LEAN_COPY also shortens the instant-EFT message:
//   "Please pay R{amount} by instant EFT, using {reference} as your reference.\n\n{bank details}\n\n
//    Reception will confirm once the funds reflect, and then assign your room."
// The existing fallback line stays when the property has no bank details. Flag off: today's text.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const saved = process.env.WABISTAY_LEAN_COPY;
afterEach(() => { if (saved === undefined) delete process.env.WABISTAY_LEAN_COPY; else process.env.WABISTAY_LEAN_COPY = saved; });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const FALLBACK = 'Please ask reception for the bank details when you arrive.';
const BANK = 'Capitec Business\nAccount 1234567890\nBranch 470010';

function seed(bank) {
  const prop = { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' };
  if (bank) prop['EFT Bank Details'] = bank;
  return {
    WS_Properties: [{ id: 'recP1', fields: prop }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [], WS_Cleaners: [], WS_Roles: [], WS_Enquiries: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Mama Test', 'Phone Number': GUEST, 'Session State': 'AWAITING_PAYMENT_METHOD' } }],
    WS_Bookings: [{ id: 'recBook1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Confirmed', 'Booking Type': 'Hourly', 'Booking Ref': 'WS-EFT001', 'Amount Due': 250, 'Payment Status': 'Unpaid' } }]
  };
}
async function chooseEft(flag, bank, text = '2') {
  if (flag === undefined) delete process.env.WABISTAY_LEAN_COPY; else process.env.WABISTAY_LEAN_COPY = flag;
  const ctx = { airtable: new MockAirtable(seed(bank)), sends: [], axiom: [] };
  installFetch(ctx);
  await wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
  return ctx;
}
const bodies = ctx => ctx.sends.filter(s => s.to === GUEST && s.type === 'text').map(s => s.body);
const ref = ctx => ctx.airtable.tables['WS_Bookings'][0].fields['Payment Reference'];

test('flag on: the EFT message is exactly the new wording, with the bank details between', async () => {
  const ctx = await chooseEft('1', BANK);
  assert.strictEqual(bodies(ctx)[0], `Please pay R250.00 by instant EFT, using ${ref(ctx)} as your reference.\n\n${BANK}\n\nReception will confirm once the funds reflect, and then assign your room.`);
});

test('flag on: with no bank details the existing fallback line takes their place', async () => {
  const ctx = await chooseEft('1', null);
  assert.strictEqual(bodies(ctx)[0], `Please pay R250.00 by instant EFT, using ${ref(ctx)} as your reference.\n\n${FALLBACK}\n\nReception will confirm once the funds reflect, and then assign your room.`);
});

test('flag off: today\'s EFT message, unchanged', async () => {
  const ctx = await chooseEft(undefined, BANK);
  assert.strictEqual(bodies(ctx)[0], `Please pay R250.00 at reception using ${ref(ctx)} as your reference. Once reception confirms the funds have reflected, you'll be assigned your room.\n\n${BANK}`);
  const noBank = await chooseEft(undefined, null);
  assert.match(bodies(noBank)[0], new RegExp(FALLBACK.replace('.', '\\.')));
});

test('the reference and the payment method are written the same either way', async () => {
  for (const flag of ['1', undefined]) {
    const ctx = await chooseEft(flag, BANK);
    assert.match(ref(ctx), /^[A-Z0-9]{4}$/);
    assert.strictEqual(ctx.airtable.tables['WS_Bookings'][0].fields['Payment Method'], 'EFT');
    assert.strictEqual(ctx.airtable.tables['WS_Guests'][0].fields['Session State'], 'CONFIRMED');
  }
});

test('typing "eft" and "instant eft" gets the same message as 2', async () => {
  for (const t of ['eft', 'instant eft']) {
    const ctx = await chooseEft('1', BANK, t);
    assert.match(bodies(ctx)[0], /^Please pay R250\.00 by instant EFT, using [A-Z0-9]{4} as your reference\./, t);
  }
});

test('the card choice is untouched by the flag', async () => {
  const ctx = await chooseEft('1', BANK, '1');
  assert.match(bodies(ctx)[0], /Please tap your card on the SpeedPoint machine/);
});
