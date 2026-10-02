// test/cleanerdispatch.test.js
// Doc 1b PR 7: cleaner dispatch by template, and the enquiry_no_room_at_greeting event.
//   - WABISTAY_CLEANER_DISPATCH_TEMPLATE set: all three dispatch sites (guest
//     checkout, staff CHECKOUT ROOM, auto-checkout) send the template with
//     [cleaner name, room name]; an immediate rejection is logged and the free-form
//     message is tried once. Unset: the free-form message exactly as before.
//   - Every guest-facing "speak to reception, no room" message logs
//     enquiry_no_room_at_greeting (phone, SAST hour, stage). Log only; no row.
//   - The overdue-question third param reads like the booking messages: "3 Oct at 4:00pm".
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';
const STAFF_PHONE = '27825999279';
const CLEANER_PHONE = '27821110000';
const TEMPLATE = 'wabistay_cleaner_dispatch';
const FREE_FORM = /has just been vacated/;

// Runs right after installFetch, so a test can wrap the mocked fetch before the flow starts.
let afterSetup = null;
afterEach(() => {
  afterSetup = null;
  delete process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE;
  delete process.env.WABISTAY_OVERDUE_ALERT_TEMPLATE;
});

const NOW = new Date('2026-07-22T12:00:00.000Z');
const minsBefore = m => new Date(NOW.getTime() - m * 60000).toISOString();

const property = { id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } };
const room = (extra = {}) => ({ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Occupied', 'Property': ['recP1'], 'Active': true, ...extra } });
const guest = (extra = {}) => ({ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN', ...extra } });
const checkedIn = (extra = {}) => ({
  id: 'recB1', fields: { Guest: ['recG1'], Room: ['recR1'], Status: 'Checked In', 'Booking Type': 'Overnight', 'Amount Due': 400, 'Checked In At': '2020-01-01T00:00:00.000Z', WS_Property: ['recP1'], ...extra }
});
const cleaner = (id, extra = {}) => ({ id, fields: { 'Cleaner Name': 'Thandi', 'Phone Number': CLEANER_PHONE, 'Active': true, 'Assigned Property': ['recP1'], ...extra } });
const reception = { id: 'recRecep', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': STAFF_PHONE, 'Active': true } };

function setup(seed = {}) {
  const ctx = {
    airtable: new MockAirtable({
      WS_Properties: [property], WS_Rooms: [room()], WS_Guests: [guest()], WS_Bookings: [checkedIn()], WS_Cleaners: [cleaner('recC1')],
      WS_Roles: [reception], WS_Enquiries: [], WS_Rates: [], ...seed
    }),
    sends: [], axiom: []
  };
  installFetch(ctx);
  if (afterSetup) afterSetup();
  return ctx;
}

async function say(text, from = GUEST_PHONE) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

// The three sites, each driven the way production drives it.
const SITES = {
  'guest checkout': async () => { const ctx = setup(); await say('1'); return ctx; },
  'staff CHECKOUT ROOM': async () => { const ctx = setup(); await say('CHECKOUT ROOM 1', STAFF_PHONE); return ctx; },
  'auto-checkout': async () => {
    const ctx = setup({ WS_Bookings: [checkedIn({ 'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(16) })] });
    await wh.runAutoCheckout(NOW);
    return ctx;
  }
};
const toCleaner = ctx => ctx.sends.filter(s => s.to === CLEANER_PHONE);
const events = (ctx, name) => ctx.axiom.filter(e => e.event === name);

// Make Meta reject template sends at once (not approved / wrong name or language).
function rejectTemplates() {
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('graph.facebook.com') && init.body && JSON.parse(init.body).type === 'template') {
      return { status: 404, ok: false, json: async () => ({ error: { message: 'Template name does not exist in the translation', code: 132001 } }), text: async () => '' };
    }
    return inner(url, init);
  };
}

// ── template configured ──────────────────────────────────────────────────────

for (const [name, run] of Object.entries(SITES)) {
  test(`${name}: template set → the cleaner gets the template with [cleaner name, room name] and no free-form message`, async () => {
    process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE = TEMPLATE;
    const ctx = await run();
    const sent = toCleaner(ctx);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'template');
    assert.strictEqual(sent[0].template, TEMPLATE);
    assert.strictEqual(sent[0].language, 'en');
    assert.deepStrictEqual(sent[0].params, ['Thandi', 'Room 01']);
  });

  test(`${name}: template unset → the free-form message exactly as before`, async () => {
    const ctx = await run();
    const sent = toCleaner(ctx);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'text');
    assert.match(sent[0].body, FREE_FORM);
    assert.match(sent[0].body, /Reply \*DONE\* when complete/);
  });

  test(`${name}: template rejected at once → logged, then the free-form message is tried exactly once`, async () => {
    process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE = TEMPLATE;
    afterSetup = rejectTemplates;
    const ctx = await run();
    const sent = toCleaner(ctx);
    assert.strictEqual(sent.length, 1, 'only the fallback was delivered');
    assert.strictEqual(sent[0].type, 'text');
    assert.match(sent[0].body, FREE_FORM);
    assert.strictEqual(events(ctx, 'cleaner_dispatch_template_failed').length, 1);
  });
}

// ── details ──────────────────────────────────────────────────────────────────

test('a cleaner with no name gets "there" as the template name param (an empty param is rejected by Meta)', async () => {
  process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE = TEMPLATE;
  const ctx = setup({ WS_Cleaners: [cleaner('recC1', { 'Cleaner Name': undefined })] });
  await say('CHECKOUT ROOM 1', STAFF_PHONE);
  assert.deepStrictEqual(toCleaner(ctx)[0].params, ['there', 'Room 01']);
});

test('every active cleaner for the property is dispatched; another property\'s cleaner and a cleaner with no phone are not', async () => {
  process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE = TEMPLATE;
  const ctx = setup({
    WS_Cleaners: [
      cleaner('recC1'),
      cleaner('recC2', { 'Cleaner Name': 'Sipho', 'Phone Number': '27822220000' }),
      cleaner('recC3', { 'Cleaner Name': 'Other', 'Phone Number': '27823330000', 'Assigned Property': ['recP2'] }),
      cleaner('recC4', { 'Cleaner Name': 'NoPhone', 'Phone Number': undefined })
    ]
  });
  await say('CHECKOUT ROOM 1', STAFF_PHONE);
  const templates = ctx.sends.filter(s => s.type === 'template' && s.template === TEMPLATE);
  assert.deepStrictEqual(templates.map(s => s.to).sort(), ['27821110000', '27822220000']);
});

test('free-form fallback that also fails is logged under the site\'s own event name and never blocks the checkout', async () => {
  process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE = TEMPLATE;
  const ctx = setup();
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('graph.facebook.com') && init.body && JSON.parse(init.body).to === CLEANER_PHONE) {
      return { status: 400, ok: false, json: async () => ({ error: { message: 'bad', code: 131047 } }), text: async () => '' };
    }
    return inner(url, init);
  };
  await say('CHECKOUT ROOM 1', STAFF_PHONE);
  assert.strictEqual(events(ctx, 'cleaner_dispatch_template_failed').length, 1);
  assert.strictEqual(events(ctx, 'cleaner_dispatch_failed').length, 1);
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'][0].fields['Status'], 'Checked Out');
});

test('the auto-checkout site keeps its own failure event name', async () => {
  const ctx = setup({ WS_Bookings: [checkedIn({ 'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(16) })] });
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('graph.facebook.com') && init.body && JSON.parse(init.body).to === CLEANER_PHONE) {
      return { status: 400, ok: false, json: async () => ({ error: { message: 'bad' } }), text: async () => '' };
    }
    return inner(url, init);
  };
  await wh.runAutoCheckout(NOW);
  assert.strictEqual(events(ctx, 'auto_checkout_cleaner_dispatch_failed').length, 1);
});

test('a template param with a newline in the cleaner\'s name is flattened before it reaches Meta', async () => {
  process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE = TEMPLATE;
  const ctx = setup({ WS_Cleaners: [cleaner('recC1', { 'Cleaner Name': 'Thandi\nM' })] });
  await say('CHECKOUT ROOM 1', STAFF_PHONE);
  assert.deepStrictEqual(toCleaner(ctx)[0].params, ['Thandi M', 'Room 01']);
});

test('the cleaner\'s typed DONE still works after a templated dispatch', async () => {
  process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE = TEMPLATE;
  const ctx = setup();
  await say('CHECKOUT ROOM 1', STAFF_PHONE);
  assert.strictEqual(ctx.airtable.tables['WS_Rooms'][0].fields['Status'], 'Cleaning');
  await say('done', CLEANER_PHONE);
  assert.strictEqual(ctx.airtable.tables['WS_Rooms'][0].fields['Status'], 'Available');
});

test('the template variable shows in the cold-start flag state: off unset, on when set', () => {
  delete process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE;
  assert.strictEqual(wh.wabistayFlagState().WABISTAY_CLEANER_DISPATCH_TEMPLATE, 'off');
  process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE = TEMPLATE;
  assert.strictEqual(wh.wabistayFlagState().WABISTAY_CLEANER_DISPATCH_TEMPLATE, 'on');
});

// ── enquiry_no_room_at_greeting ──────────────────────────────────────────────

const sastHourNow = () => new Date(Date.now() + 2 * 3600000).getUTCHours();
const SPEAK = /Please speak to reception/;

test('greeting with no Available room: logs enquiry_no_room_at_greeting with phone and SAST hour, writes no row, still sends the message', async () => {
  const ctx = setup({ WS_Rooms: [], WS_Guests: [], WS_Bookings: [] });
  await say('hi');
  const e = events(ctx, 'enquiry_no_room_at_greeting');
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].phone, GUEST_PHONE);
  assert.strictEqual(e[0].stage, 'greeting');
  assert.ok([sastHourNow(), (sastHourNow() + 23) % 24].includes(e[0].sastHour), 'the SAST hour of day');
  assert.strictEqual(ctx.airtable.tables['WS_Enquiries'].length, 0, 'log only');
  assert.match(ctx.sends.map(s => s.body).join('\n'), SPEAK);
});

test('overnight dates with no availability: same event, stage overnight_dates (the existing No Availability row is unchanged)', async () => {
  const ctx = setup({ WS_Rooms: [], WS_Bookings: [], WS_Guests: [guest({ 'Session State': 'AWAITING_DETAILS' })] });
  await say('Jane Doe\n1 December 2099\n3 December 2099');
  assert.strictEqual(events(ctx, 'enquiry_no_room_at_greeting')[0].stage, 'overnight_dates');
  assert.strictEqual(ctx.airtable.tables['WS_Enquiries'].filter(r => r.fields['Outcome'] === 'No Availability').length, 1);
});

test('hourly with no availability: stage hourly_duration', async () => {
  const hourly = { id: 'recP1', fields: { ...property.fields, 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300 } };
  const ctx = setup({
    WS_Properties: [hourly], WS_Rooms: [], WS_Cleaners: [],
    WS_Guests: [guest({ 'Session State': 'AWAITING_HOURLY_DURATION' })],
    WS_Bookings: [{ id: 'recBp', fields: { Guest: ['recG1'], 'Booking Type': 'Hourly', Status: 'Enquiry', 'Payment Status': 'Unpaid', 'Check In': '2099-01-01T12:00:00.000Z' } }]
  });
  await say('2');
  assert.strictEqual(events(ctx, 'enquiry_no_room_at_greeting')[0].stage, 'hourly_duration');
});

test('a test phone is flagged on the event, not hidden', async () => {
  const ctx = setup({ WS_Rooms: [], WS_Bookings: [], WS_Guests: [guest({ 'Session State': 'NEW', 'Test Phone': true })] });
  await say('hi');
  assert.strictEqual(events(ctx, 'enquiry_no_room_at_greeting')[0].testPhone, true);
});

test('a guest who is offered a room does not produce the event', async () => {
  const ctx = setup({ WS_Rooms: [room({ Status: 'Available' })], WS_Guests: [], WS_Bookings: [] });
  await say('hi');
  assert.strictEqual(events(ctx, 'enquiry_no_room_at_greeting').length, 0);
});

// ── overdue question: third param reads "3 Oct at 4:00pm" ────────────────────

test('overdue question: the scheduled check-out param is a SAST date and time in the booking-message style', async () => {
  process.env.WABISTAY_OVERDUE_ALERT_TEMPLATE = 'wabistay_overdue_checkout';
  const ctx = setup({
    WS_Bookings: [checkedIn({ 'Check Out': '2026-10-03T14:00:00.000Z' })]       // 16:00 SAST
  });
  const summary = await wh.runOverdueAlerts(new Date('2026-10-03T15:30:00.000Z'));
  assert.strictEqual(summary.overdueAlerts, 1);
  const t = ctx.sends.find(s => s.type === 'template');
  assert.strictEqual(t.template, 'wabistay_overdue_checkout');
  assert.strictEqual(t.language, 'en');
  assert.deepStrictEqual(t.params, ['Room 01', 'John Smith', '3 Oct at 4:00pm']);
});
