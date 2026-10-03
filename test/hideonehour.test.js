// test/hideonehour.test.js
// WABISTAY_HIDE_ONE_HOUR (1 or true; off by default). On: the guest-facing
// short-stay flow offers only 2 and 3 hours — rates message, duration prompt and
// accepted replies — and a reply of 1 repeats the prompt and books nothing. The 1hr
// rate in Airtable is not read by the guest flow (so it may be blank) and is never
// blanked by this change. Off: today's text and behaviour exactly.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const saved = process.env.WABISTAY_HIDE_ONE_HOUR;
afterEach(() => { if (saved === undefined) delete process.env.WABISTAY_HIDE_ONE_HOUR; else process.env.WABISTAY_HIDE_ONE_HOUR = saved; });

const GUEST = '27821234567';

function freshWebhook() {
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  return require('../api/wabistay/webhook.js');
}

const tomorrow12Z = () => new Date(Date.now() + 24 * 3600e3).toISOString().replace(/T.*/, 'T12:00:00.000Z');

function seed({ state, pending = false, rate1 = 120 } = {}) {
  const prop = { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'City': 'Testville', 'Notify Phone': '27831112222', 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300 };
  if (rate1 !== null) prop['Hourly Rate 1hr'] = rate1;
  return {
    WS_Properties: [{ id: 'recP1', fields: prop }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 1', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [], WS_Cleaners: [], WS_Roles: [], WS_Enquiries: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': GUEST, 'Session State': state } }],
    WS_Bookings: pending ? [{ id: 'recHourlyPend0001', fields: {
      'Guest': ['recG1'], 'Booking Type': 'Hourly', 'Status': 'Enquiry', 'Check In': tomorrow12Z(), 'Payment Status': 'Unpaid'
    } }] : []
  };
}

async function say(opts, text, flag) {
  if (flag === undefined) delete process.env.WABISTAY_HIDE_ONE_HOUR; else process.env.WABISTAY_HIDE_ONE_HOUR = flag;
  const wh = freshWebhook();
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  await wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
  return ctx;
}
const bodies = ctx => ctx.sends.filter(s => s.to === GUEST && s.type === 'text').map(s => s.body);
const booking = ctx => ctx.airtable.tables['WS_Bookings'][0];
const guestState = ctx => ctx.airtable.tables['WS_Guests'][0].fields['Session State'];

// ── the rates message ────────────────────────────────────────────────────────

test('rates message, flag off: all three durations (today)', async () => {
  const ctx = await say({ state: 'AWAITING_STAY_TYPE' }, '1');
  const rates = bodies(ctx).find(b => /Short stay rates/.test(b));
  assert.match(rates, /• 1 hour: R120\n• 2 hours: R250\n• 3 hours: R300/);
});

for (const flag of ['1', 'true', 'TRUE']) {
  test(`rates message, flag=${flag}: only 2 hours (R250) and 3 hours (R300)`, async () => {
    const ctx = await say({ state: 'AWAITING_STAY_TYPE' }, '1', flag);
    const rates = bodies(ctx).find(b => /Short stay rates/.test(b));
    assert.strictEqual(rates, '*Short stay rates at Test Lodge:*\n• 2 hours: R250\n• 3 hours: R300');
    assert.ok(!/1 hour/.test(rates));
  });
}

test('flag set to something else ("yes", "0") does not hide anything', async () => {
  for (const flag of ['yes', '0', '']) {
    const ctx = await say({ state: 'AWAITING_STAY_TYPE' }, '1', flag);
    assert.match(bodies(ctx).find(b => /Short stay rates/.test(b)), /• 1 hour: R120/, `flag ${JSON.stringify(flag)}`);
  }
});

// ── the duration prompt ──────────────────────────────────────────────────────

test('duration prompt, flag off: offers 1, 2 and 3 (today)', async () => {
  const ctx = await say({ state: 'AWAITING_HOURLY_DETAILS' }, 'John Smith\n2pm');
  const menu = bodies(ctx).find(b => /How long do you need/.test(b));
  assert.match(menu, /Reply with a number:\n1 - 1 hour \(R120\)\n2 - 2 hours \(R250\)\n3 - 3 hours \(R300\)\n\n_Staying longer than 3 hours\? Reply 4/);
});

test('duration prompt, flag on: only 2 and 3, keys are the hour values, the longer-stay note is kept', async () => {
  const ctx = await say({ state: 'AWAITING_HOURLY_DETAILS' }, 'John Smith\n2pm', '1');
  const menu = bodies(ctx).find(b => /How long do you need/.test(b));
  assert.match(menu, /Reply with a number:\n2 - 2 hours \(R250\)\n3 - 3 hours \(R300\)\n\n_Staying longer than 3 hours\? Reply 4/);
  assert.ok(!/1 - 1 hour/.test(menu));
});

test('flag on: the 1hr rate may be blank in Airtable — the guest flow still works (it is not read)', async () => {
  const ctx = await say({ state: 'AWAITING_STAY_TYPE', rate1: null }, '1', '1');
  assert.match(bodies(ctx).find(b => /Short stay rates/.test(b)), /• 2 hours: R250/);
  const off = await say({ state: 'AWAITING_STAY_TYPE', rate1: null }, '1');
  assert.ok(bodies(off).some(b => /short stays aren't available/.test(b)), 'flag off still fails closed on a blank rate');
});

test('flag on: a blank 2hr or 3hr rate still fails closed', async () => {
  const s = seed({ state: 'AWAITING_STAY_TYPE' });
  delete s.WS_Properties[0].fields['Hourly Rate 3hr'];
  process.env.WABISTAY_HIDE_ONE_HOUR = '1';
  const wh = freshWebhook();
  const ctx = { airtable: new MockAirtable(s), sends: [], axiom: [] };
  installFetch(ctx);
  await wh({ method: 'POST', body: metaTextPayload(GUEST, '1') }, makeRes());
  assert.ok(bodies(ctx).some(b => /short stays aren't available/.test(b)));
});

// ── a reply of 1 ─────────────────────────────────────────────────────────────

test('flag on: a reply of 1 repeats the prompt and creates no booking', async () => {
  const ctx = await say({ state: 'AWAITING_HOURLY_DURATION', pending: true }, '1', '1');
  const menu = bodies(ctx).filter(b => /How long do you need/.test(b));
  assert.strictEqual(menu.length, 1, 'the prompt is repeated');
  assert.ok(!/1 - 1 hour/.test(menu[0]));
  assert.strictEqual(booking(ctx).fields['Status'], 'Enquiry', 'still the pending enquiry');
  assert.strictEqual(booking(ctx).fields['Check Out'], undefined);
  assert.strictEqual(booking(ctx).fields['Room'], undefined);
  assert.strictEqual(booking(ctx).fields['Amount Due'], undefined);
  assert.strictEqual(guestState(ctx), 'AWAITING_HOURLY_DURATION');
  assert.ok(!ctx.sends.some(s => /New \*short stay\* booking|Your \*short stay\* is booked/.test(s.body || '')));
  assert.ok(ctx.axiom.some(e => e.event === 'hourly_one_hour_hidden_reply'));
});

test('flag on: "1 hour" (typed out) is treated the same as 1', async () => {
  const ctx = await say({ state: 'AWAITING_HOURLY_DURATION', pending: true }, '1 hour', '1');
  assert.strictEqual(booking(ctx).fields['Status'], 'Enquiry');
  assert.ok(bodies(ctx).some(b => /How long do you need/.test(b)));
});

test('flag on: 2 and 3 still book at their own rates; 4 still redirects to overnight', async () => {
  for (const [reply, amount] of [['2', 250], ['3', 300]]) {
    const ctx = await say({ state: 'AWAITING_HOURLY_DURATION', pending: true }, reply, '1');
    assert.strictEqual(booking(ctx).fields['Status'], 'Confirmed', `reply ${reply}`);
    assert.strictEqual(booking(ctx).fields['Amount Due'], amount, `reply ${reply}`);
  }
  const four = await say({ state: 'AWAITING_HOURLY_DURATION', pending: true }, '4', '1');
  assert.ok(bodies(four).some(b => /stays longer than 3 hours/.test(b)));
  assert.strictEqual(booking(four).fields['Status'], 'Cancelled');
});

test('flag off: a reply of 1 books the 1-hour stay at R120 (today)', async () => {
  const ctx = await say({ state: 'AWAITING_HOURLY_DURATION', pending: true }, '1');
  assert.strictEqual(booking(ctx).fields['Status'], 'Confirmed');
  assert.strictEqual(booking(ctx).fields['Amount Due'], 120);
});

// ── scope ────────────────────────────────────────────────────────────────────

test('flag state is listed in the cold-start flag log: off by default, on only for 1/true', () => {
  delete process.env.WABISTAY_HIDE_ONE_HOUR;
  assert.strictEqual(freshWebhook().wabistayFlagState().WABISTAY_HIDE_ONE_HOUR, 'off');
  for (const [v, exp] of [['1', 'on'], ['true', 'on'], ['yes', 'off']]) {
    process.env.WABISTAY_HIDE_ONE_HOUR = v;
    assert.strictEqual(freshWebhook().wabistayFlagState().WABISTAY_HIDE_ONE_HOUR, exp, v);
  }
});

test('staff are not affected: hourlyRates() still requires and returns all three rates, flag on', () => {
  process.env.WABISTAY_HIDE_ONE_HOUR = '1';
  const wh = freshWebhook();
  assert.deepStrictEqual(wh.hourlyRates(seed({ state: 'NEW' }).WS_Properties[0]), { 1: 120, 2: 250, 3: 300 });
  assert.strictEqual(wh.hourlyRates(seed({ state: 'NEW', rate1: null }).WS_Properties[0]), null);
});
