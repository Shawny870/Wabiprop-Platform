// test/newbookingtemplate.test.js
// WABISTAY_NEW_BOOKING_TEMPLATE — the new-booking alert (overnight + hourly) as
// the wabistay_new_booking template: language en, 7 params
//   [property, guest name, guest phone, booking ref, stay description,
//    arrival text, amount due]
// body "The stay is {{5}}. The guest is arriving {{6}}. The amount due is {{7}}."
// Unset = today's free-form alert, untouched. An immediate Meta rejection falls
// back to the free-form text once. operationalAlertPhone still picks the recipient.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['OWNER_PHONE', 'WABISTAY_NOTIFY_ROUTING', 'WABISTAY_NEW_BOOKING_TEMPLATE'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const TEMPLATE = 'wabistay_new_booking';
const OWNER = '27999000111';
const NOTIFY = '27831112222';
const GUEST = '27821234567';

function freshWebhook() {
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  return require('../api/wabistay/webhook.js');
}

const tomorrow12Z = () => new Date(Date.now() + 24 * 3600e3).toISOString().replace(/T.*/, 'T12:00:00.000Z');
const rooms = () => [{ id: 'recR1', fields: { 'Room Name': 'Room 1', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }];
const property = () => ({ id: 'recP1', fields: {
  'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'City': 'Testville', 'Notify Phone': NOTIFY,
  'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
} });
const nightly = amount => ({ id: 'recRATE' + amount, fields: { 'Rate Name': 'Standard Overnight', 'Rate Type': 'Per Night', 'Amount': amount, 'Active': true, 'Property': ['recP1'] } });

const SCENARIOS = {
  overnight: ({ rates = [nightly(350)], guestName = 'Unknown' } = {}) => ({
    text: 'John Smith\n25 June\n27 June',
    seed: {
      WS_Properties: [property()], WS_Rates: rates, WS_Rooms: rooms(),
      WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': guestName, 'Phone Number': GUEST, 'Session State': 'AWAITING_DETAILS' } }],
      WS_Cleaners: [], WS_Bookings: [], WS_Enquiries: []
    },
    freeForm: /New booking enquiry from John Smith/
  }),
  hourly: ({ reply = '2', guestName = 'John Smith' } = {}) => ({
    text: reply,
    seed: {
      WS_Properties: [property()], WS_Rates: [], WS_Rooms: rooms(),
      WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': guestName, 'Phone Number': GUEST, 'Session State': 'AWAITING_HOURLY_DURATION' } }],
      WS_Bookings: [{ id: 'recHourlyPend0001', fields: { 'Guest': ['recG1'], 'Booking Type': 'Hourly', 'Status': 'Enquiry', 'Check In': tomorrow12Z(), 'Payment Status': 'Unpaid' } }],
      WS_Cleaners: [], WS_Enquiries: []
    },
    freeForm: /New \*short stay\* booking from/
  })
};

// Meta rejects template sends at once (not approved / wrong name or language).
function rejectTemplates() {
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('graph.facebook.com') && init.body && JSON.parse(init.body).type === 'template') {
      return { status: 404, ok: false, json: async () => ({ error: { message: 'Template name does not exist in the translation', code: 132001 } }), text: async () => '' };
    }
    return inner(url, init);
  };
}

async function run(sc, { template = TEMPLATE, routing = false, ownerPhone = OWNER, reject = false } = {}) {
  if (template) process.env.WABISTAY_NEW_BOOKING_TEMPLATE = template; else delete process.env.WABISTAY_NEW_BOOKING_TEMPLATE;
  if (routing) process.env.WABISTAY_NOTIFY_ROUTING = '1'; else delete process.env.WABISTAY_NOTIFY_ROUTING;
  if (ownerPhone) process.env.OWNER_PHONE = ownerPhone; else delete process.env.OWNER_PHONE;
  const wh = freshWebhook();
  const ctx = { airtable: new MockAirtable(sc.seed), sends: [], axiom: [] };
  installFetch(ctx);
  if (reject) rejectTemplates();
  await wh({ method: 'POST', body: metaTextPayload(GUEST, sc.text) }, makeRes());
  const templ = ctx.sends.filter(s => s.type === 'template' && s.template === TEMPLATE);
  const freeForm = ctx.sends.filter(s => s.type === 'text' && sc.freeForm.test(s.body || ''));
  return { ctx, templ, freeForm, wh };
}
const bookingRef = ctx => ctx.airtable.tables['WS_Bookings'][0].fields['Booking Ref'];
const events = (ctx, name) => ctx.axiom.filter(e => e.event === name);

// ── unset: today's behaviour ─────────────────────────────────────────────────

for (const name of ['overnight', 'hourly']) {
  test(`${name}: variable unset -> the free-form alert only, no template send`, async () => {
    const r = await run(SCENARIOS[name](), { template: null });
    assert.strictEqual(r.templ.length, 0);
    assert.strictEqual(r.freeForm.length, 1);
    assert.strictEqual(r.freeForm[0].to, OWNER);
  });
}

// ── set: the template, 7 params in order ─────────────────────────────────────

test('overnight: template set -> 7 params in order, language en, and no free-form copy', async () => {
  const r = await run(SCENARIOS.overnight());
  assert.strictEqual(r.templ.length, 1);
  assert.strictEqual(r.freeForm.length, 0);
  assert.strictEqual(r.templ[0].to, OWNER);
  assert.strictEqual(r.templ[0].language, 'en');
  const checkIn = r.ctx.airtable.tables['WS_Bookings'][0].fields['Check In'];
  assert.strictEqual(r.templ[0].params.length, 7);
  assert.deepStrictEqual(r.templ[0].params, [
    'Test Lodge', 'John Smith', GUEST, bookingRef(r.ctx),
    'overnight until 27 June',
    r.wh.formatSastDateTime(checkIn),
    'R350'
  ]);
  assert.match(r.templ[0].params[5], /^\d{1,2} [A-Z][a-z]{2} at 2:00pm$/, 'arrival reads like "25 Jun at 2:00pm"');
  assert.match(r.templ[0].params[3], /^WS-[A-Z0-9]{6}$/);
});

for (const [reply, stay, amount] of [['1', '1 hour', 'R120'], ['2', '2 hours', 'R250'], ['3', '3 hours', 'R320']]) {
  test(`hourly ${reply}: template set -> params carry "${stay}" and "${amount}", arrival as "3 Oct at 2:00pm"-style text`, async () => {
    const r = await run(SCENARIOS.hourly({ reply }));
    assert.strictEqual(r.templ.length, 1);
    assert.strictEqual(r.freeForm.length, 0);
    const checkIn = r.ctx.airtable.tables['WS_Bookings'][0].fields['Check In'];
    assert.deepStrictEqual(r.templ[0].params, [
      'Test Lodge', 'John Smith', GUEST, bookingRef(r.ctx), stay, r.wh.formatSastDateTime(checkIn), amount
    ]);
    assert.strictEqual(r.templ[0].language, 'en');
    assert.match(r.templ[0].params[5], /^\d{1,2} [A-Z][a-z]{2} at \d{1,2}:\d{2}[ap]m$/);
  });
}

// ── unpriced overnight ───────────────────────────────────────────────────────

test('overnight with no singular nightly rate (owner will finalise): amount param is "to be confirmed", never blank', async () => {
  for (const rates of [[], [nightly(350), nightly(400)]]) {
    const r = await run(SCENARIOS.overnight({ rates }));
    assert.strictEqual(r.templ.length, 1);
    assert.strictEqual(r.templ[0].params[6], 'to be confirmed');
    assert.ok(r.templ[0].params.every(p => String(p).trim() !== ''), 'no empty param');
  }
});

test('newBookingTemplateParams: amounts — whole rands as R250, cents kept, zero/blank/NaN -> to be confirmed', () => {
  const wh = freshWebhook();
  const base = { propertyName: 'P', guestName: 'G', guestPhone: '1', bookingRef: 'WS-1', bookingType: 'Hourly', hours: 2, checkInIso: '2026-10-03T12:00:00.000Z', checkOutIso: '2026-10-03T14:00:00.000Z' };
  const amountOf = amount => wh.newBookingTemplateParams({ ...base, amount })[6];
  assert.strictEqual(amountOf(250), 'R250');
  assert.strictEqual(amountOf('250'), 'R250');
  assert.strictEqual(amountOf(250.5), 'R250.50');
  for (const bad of [0, null, undefined, '', 'abc', -5]) assert.strictEqual(amountOf(bad), 'to be confirmed', String(bad));
  assert.strictEqual(wh.newBookingTemplateParams({ ...base, amount: 250 })[5], '3 Oct at 2:00pm', '14:00 SAST is 12:00Z');
});

// ── rejection -> one free-form fallback ──────────────────────────────────────

for (const name of ['overnight', 'hourly']) {
  test(`${name}: Meta rejects the template at once -> logged, then the free-form alert goes once`, async () => {
    const r = await run(SCENARIOS[name](), { reject: true });
    assert.strictEqual(r.templ.length, 0, 'the rejected template was never recorded as sent');
    assert.strictEqual(r.freeForm.length, 1, 'exactly one free-form fallback');
    assert.strictEqual(r.freeForm[0].to, OWNER);
    const failed = events(r.ctx, 'new_booking_template_failed');
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].template, TEMPLATE);
    assert.match(failed[0].error, /132001/);
  });
}

// ── recipient: operationalAlertPhone decides ─────────────────────────────────

for (const name of ['overnight', 'hourly']) {
  test(`${name}: routing on -> the template goes to Notify Phone, not OWNER_PHONE`, async () => {
    const r = await run(SCENARIOS[name](), { routing: true });
    assert.strictEqual(r.templ.length, 1);
    assert.strictEqual(r.templ[0].to, NOTIFY);
    assert.ok(!r.ctx.sends.some(s => s.to === OWNER && s.template === TEMPLATE));
  });

  test(`${name}: routing on, no Notify Phone -> OWNER_PHONE fallback gets the template`, async () => {
    const sc = SCENARIOS[name]();
    delete sc.seed.WS_Properties[0].fields['Notify Phone'];
    const r = await run(sc, { routing: true });
    assert.strictEqual(r.templ.length, 1);
    assert.strictEqual(r.templ[0].to, OWNER);
  });

  test(`${name}: no recipient at all -> no alert of either kind, the guest flow carries on`, async () => {
    const sc = SCENARIOS[name]();
    delete sc.seed.WS_Properties[0].fields['Notify Phone'];
    const r = await run(sc, { routing: true, ownerPhone: null });
    assert.strictEqual(r.templ.length, 0);
    assert.strictEqual(r.freeForm.length, 0);
    assert.ok(r.ctx.sends.some(s => s.to === GUEST));
  });
}

// ── hygiene ──────────────────────────────────────────────────────────────────

test('a guest name with a newline is flattened before it reaches Meta (error 132018 otherwise)', async () => {
  const r = await run(SCENARIOS.hourly({ guestName: 'John\nSmith' }));
  assert.strictEqual(r.templ.length, 1);
  assert.strictEqual(r.templ[0].params[1], 'John Smith');
  assert.ok(r.templ[0].params.every(p => !/[\r\n\t]/.test(p)));
});

test('the variable is on the cold-start flag list: off when unset, on when set to a template name', () => {
  delete process.env.WABISTAY_NEW_BOOKING_TEMPLATE;
  assert.strictEqual(freshWebhook().wabistayFlagState().WABISTAY_NEW_BOOKING_TEMPLATE, 'off');
  process.env.WABISTAY_NEW_BOOKING_TEMPLATE = TEMPLATE;
  assert.strictEqual(freshWebhook().wabistayFlagState().WABISTAY_NEW_BOOKING_TEMPLATE, 'on');
});
