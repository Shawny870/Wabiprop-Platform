// test/notifyrouting.test.js
// PR 8 — WABISTAY_NOTIFY_ROUTING. Off (default) = today's behaviour exactly;
// on = the four operational alerts go to the property's Notify Phone, reports go
// to Owner Report Phone -> Notify Phone, and those two numbers are kept out of the
// guest flow's STOP and consent-notice handling. No command authority is granted.
// Also: env-driven report template names (defaults unchanged) and the flags log.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const saved = {};
const ENV = ['OWNER_PHONE', 'WABISTAY_NOTIFY_ROUTING', 'REPORT_TEST_MODE_PHONE',
  'WABISTAY_WEEKLY_RECAP_TEMPLATE', 'WABISTAY_MONTHLY_REPORT_TEMPLATE',
  'WABISTAY_DAILY_SUMMARY_TEMPLATE', 'WABISTAY_OWNER_SUMMARY_TEMPLATE'];
for (const k of ENV) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function freshWebhook() {
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  return require('../api/wabistay/webhook.js');
}

const OWNER = '27999000111';
const NOTIFY = '27831112222';
const REPORT = '27833334444';
const MULTI = '27780384989';   // guest test phone + Reception seat + Notify Phone + cleaner "Jill"
const NEW_NUMBER = '27821239999';

function property(extra = {}) {
  return { id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': NOTIFY, ...extra } };
}
function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
async function send(wh, from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '');
const events = (ctx, name) => ctx.axiom.filter(e => e.event === name);

function chatSeed({ props = property(), guests = [], roles = [], cleanerPhone = '27820000111', roomStatus = 'Available' } = {}) {
  return {
    WS_Properties: [props],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': roomStatus, 'Property': ['recP1'], 'Active': true, 'Cleaning Started At': new Date(Date.now() - 3600e3).toISOString() } }],
    WS_Rates: [], WS_Roles: roles, WS_Bookings: [], WS_Enquiries: [],
    WS_Cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Jill', 'Phone Number': cleanerPhone, 'Active': true, 'Assigned Property': ['recP1'] } }],
    WS_Guests: guests
  };
}

// ── pure resolvers ───────────────────────────────────────────────────────────

test('operationalAlertPhone: flag off -> raw OWNER_PHONE even when Notify Phone exists', () => {
  process.env.OWNER_PHONE = '0999000111';
  delete process.env.WABISTAY_NOTIFY_ROUTING;
  const wh = freshWebhook();
  assert.strictEqual(wh.operationalAlertPhone(property()), '0999000111');
});

test('operationalAlertPhone: flag on -> Notify Phone (formatted); falls back to OWNER_PHONE; null with neither', () => {
  process.env.OWNER_PHONE = OWNER;
  process.env.WABISTAY_NOTIFY_ROUTING = '1';
  let wh = freshWebhook();
  assert.strictEqual(wh.operationalAlertPhone(property({ 'Notify Phone': '083 111 2222' })), '083 111 2222'.replace(/\s/g, '').replace(/^0/, '27'));
  assert.strictEqual(wh.operationalAlertPhone(property({ 'Notify Phone': undefined })), OWNER);
  delete process.env.OWNER_PHONE;
  wh = freshWebhook();
  assert.strictEqual(wh.operationalAlertPhone(property({ 'Notify Phone': undefined })), null);
});

test('reportRecipientPhone: flag off ignores Owner Report Phone; flag on prefers it, blank falls back to Notify Phone', () => {
  process.env.OWNER_PHONE = OWNER;
  delete process.env.WABISTAY_NOTIFY_ROUTING;
  let wh = freshWebhook();
  assert.strictEqual(wh.reportRecipientPhone(property({ 'Owner Report Phone': REPORT })), NOTIFY);
  process.env.WABISTAY_NOTIFY_ROUTING = 'true';
  wh = freshWebhook();
  assert.strictEqual(wh.reportRecipientPhone(property({ 'Owner Report Phone': REPORT })), REPORT);
  assert.strictEqual(wh.reportRecipientPhone(property({ 'Owner Report Phone': '' })), NOTIFY);
  assert.strictEqual(wh.reportRecipientPhone(property({ 'Owner Report Phone': undefined, 'Notify Phone': undefined })), OWNER);
});

test('isOwnerSideNumber: OWNER_PHONE always; Notify / Owner Report Phone only when routing is on; malformed field never throws', () => {
  process.env.OWNER_PHONE = OWNER;
  delete process.env.WABISTAY_NOTIFY_ROUTING;
  let wh = freshWebhook();
  const p = property({ 'Owner Report Phone': REPORT });
  assert.strictEqual(wh.isOwnerSideNumber(OWNER, p), true);
  assert.strictEqual(wh.isOwnerSideNumber(NOTIFY, p), false);
  assert.strictEqual(wh.isOwnerSideNumber(REPORT, p), false);
  process.env.WABISTAY_NOTIFY_ROUTING = '1';
  wh = freshWebhook();
  assert.strictEqual(wh.isOwnerSideNumber(NOTIFY, p), true);
  assert.strictEqual(wh.isOwnerSideNumber(REPORT, p), true);
  assert.strictEqual(wh.isOwnerSideNumber(NEW_NUMBER, p), false);
  assert.strictEqual(wh.isOwnerSideNumber(NOTIFY, property({ 'Notify Phone': 12345 })), false);
});

// ── room-cleaned alert, end to end ───────────────────────────────────────────

async function roomCleaned(flag) {
  process.env.OWNER_PHONE = OWNER;
  if (flag) process.env.WABISTAY_NOTIFY_ROUTING = '1'; else delete process.env.WABISTAY_NOTIFY_ROUTING;
  const wh = freshWebhook();
  const ctx = setup(chatSeed({ roomStatus: 'Cleaning', cleanerPhone: '27820000111' }));
  await send(wh, '27820000111', 'done');
  return ctx;
}

test('room cleaned: flag off -> OWNER_PHONE is told, Notify Phone is not (today)', async () => {
  const ctx = await roomCleaned(false);
  assert.ok(texts(ctx, OWNER).some(t => /Room 01/.test(t)), 'owner alert to OWNER_PHONE');
  assert.strictEqual(texts(ctx, NOTIFY).length, 0);
});

test('room cleaned: flag on -> Notify Phone is told, OWNER_PHONE is not', async () => {
  const ctx = await roomCleaned(true);
  assert.ok(texts(ctx, NOTIFY).some(t => /Room 01/.test(t)), 'owner alert to Notify Phone');
  assert.strictEqual(texts(ctx, OWNER).length, 0);
  assert.strictEqual(events(ctx, 'owner_send_window_check').filter(e => e.site === 'room_cleaned')[0].recipient, NOTIFY);
});

// ── multi-role: STOP and consent only, no command authority ──────────────────

test('flag off: a Notify Phone number that STOPs is opted out like any guest (unchanged)', async () => {
  process.env.OWNER_PHONE = OWNER;
  delete process.env.WABISTAY_NOTIFY_ROUTING;
  const wh = freshWebhook();
  const ctx = setup(chatSeed());
  await send(wh, NOTIFY, 'stop');
  assert.strictEqual(events(ctx, 'stop_ignored_staff_number').length, 0);
  assert.strictEqual(events(ctx, 'guest_opted_out').length, 1);
});

test('flag on: STOP from Notify Phone and from Owner Report Phone is ignored as staff; no WS_Guests row is created', async () => {
  process.env.OWNER_PHONE = OWNER;
  process.env.WABISTAY_NOTIFY_ROUTING = '1';
  const wh = freshWebhook();
  const ctx = setup(chatSeed({ props: property({ 'Owner Report Phone': REPORT }) }));
  await send(wh, NOTIFY, 'stop');
  await send(wh, REPORT, 'stop');
  assert.strictEqual(events(ctx, 'stop_ignored_staff_number').length, 2);
  assert.strictEqual(events(ctx, 'guest_opted_out').length, 0);
  assert.strictEqual(ctx.airtable.tables['WS_Guests'].length, 0);
});

test('consent notice: a brand-new number gets it; Notify Phone does not when routing is on, does when off', async () => {
  process.env.OWNER_PHONE = OWNER;
  process.env.WABISTAY_NOTIFY_ROUTING = '1';
  let wh = freshWebhook();
  let ctx = setup(chatSeed());
  await send(wh, NEW_NUMBER, 'hi');
  assert.strictEqual(events(ctx, 'popia_consent_sent').length, 1, 'ordinary new guest still gets the notice');
  ctx = setup(chatSeed());
  await send(wh, NOTIFY, 'hi');
  assert.strictEqual(events(ctx, 'popia_consent_sent').length, 0, 'owner-side number is not given a POPIA notice about itself');
  delete process.env.WABISTAY_NOTIFY_ROUTING;
  wh = freshWebhook();
  ctx = setup(chatSeed());
  await send(wh, NOTIFY, 'hi');
  assert.strictEqual(events(ctx, 'popia_consent_sent').length, 1, 'flag off: unchanged');
});

test('Notify Phone gains no command authority: PAID from it, with no Reception seat, falls through to the guest flow', async () => {
  process.env.OWNER_PHONE = OWNER;
  process.env.WABISTAY_NOTIFY_ROUTING = '1';
  const wh = freshWebhook();
  const ctx = setup(chatSeed());
  await send(wh, NOTIFY, 'PAID ROOM 1 500');
  assert.strictEqual(events(ctx, 'paid_unauthorised_sender').length, 1);
  await send(wh, NOTIFY, 'CHECKOUT ROOM 1');
  assert.strictEqual(events(ctx, 'checkout_command_unauthorised_sender').length, 1);
});

test('multi-role number (guest + Reception + Notify Phone + cleaner): behaves identically with the flag off and on', async () => {
  const roles = [{ id: 'recRole1', fields: { 'Role Type': 'Reception', 'Current Phone': MULTI, 'Active': true, 'Property': ['recP1'] } }];
  const outcome = async flag => {
    process.env.OWNER_PHONE = OWNER;
    if (flag) process.env.WABISTAY_NOTIFY_ROUTING = '1'; else delete process.env.WABISTAY_NOTIFY_ROUTING;
    const wh = freshWebhook();
    const ctx = setup(chatSeed({ props: property({ 'Notify Phone': MULTI }), roles, cleanerPhone: MULTI, guests: [] }));
    await send(wh, MULTI, 'hi');        // guest greeting
    await send(wh, MULTI, 'stop');      // ignored as staff
    await send(wh, MULTI, 'done');      // cleaner command, nothing to clean
    return {
      greeted: texts(ctx, MULTI).length,
      consent: events(ctx, 'popia_consent_sent').length,
      stopIgnored: events(ctx, 'stop_ignored_staff_number').length,
      optedOut: events(ctx, 'guest_opted_out').length
    };
  };
  const off = await outcome(false);
  const on = await outcome(true);
  assert.deepStrictEqual(on, off);
  assert.strictEqual(on.consent, 0);
  assert.strictEqual(on.stopIgnored, 1);
  assert.strictEqual(on.optedOut, 0);
});

// ── reports: recipient + template names + test-mode precedence ───────────────

const NOW = new Date('2026-08-20T06:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(NOW.getTime() - n * DAY_MS).toISOString();
function reportSeed(propExtra = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Notify Phone': NOTIFY, 'Owner': ['recOwner'], ...propExtra } }],
    WS_Owners: [{ id: 'recOwner', fields: { 'Owner Name': 'The Owner' } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': ['recP1'] } }],
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(3), 'Check Out': daysAgo(1) } }],
    WS_Guests: []
  };
}

test('weekly + monthly: flag off -> Notify Phone even if Owner Report Phone is set; default template names', async () => {
  delete process.env.WABISTAY_NOTIFY_ROUTING; delete process.env.REPORT_TEST_MODE_PHONE;
  const wh = freshWebhook();
  const ctx = setup(reportSeed({ 'Owner Report Phone': REPORT }));
  await wh.runWeeklyRecap({ now: NOW });
  await wh.runMonthlyReport({ now: NOW });
  assert.deepStrictEqual(ctx.sends.map(s => s.to), [NOTIFY, NOTIFY]);
  assert.deepStrictEqual(ctx.sends.map(s => s.template), ['wabistay_owner_weekly_recap', 'wabistay_owner_monthly_recap']);
});

test('weekly + monthly: flag on -> Owner Report Phone; blank -> Notify Phone', async () => {
  process.env.WABISTAY_NOTIFY_ROUTING = '1'; delete process.env.REPORT_TEST_MODE_PHONE;
  let wh = freshWebhook();
  let ctx = setup(reportSeed({ 'Owner Report Phone': REPORT }));
  await wh.runWeeklyRecap({ now: NOW });
  await wh.runMonthlyReport({ now: NOW });
  assert.deepStrictEqual(ctx.sends.map(s => s.to), [REPORT, REPORT]);
  wh = freshWebhook();
  ctx = setup(reportSeed({ 'Owner Report Phone': '' }));
  await wh.runWeeklyRecap({ now: NOW });
  assert.deepStrictEqual(ctx.sends.map(s => s.to), [NOTIFY]);
});

test('REPORT_TEST_MODE_PHONE keeps precedence over Owner Report Phone with the flag on', async () => {
  process.env.WABISTAY_NOTIFY_ROUTING = '1'; process.env.REPORT_TEST_MODE_PHONE = '27899999999';
  const wh = freshWebhook();
  const ctx = setup(reportSeed({ 'Owner Report Phone': REPORT }));
  await wh.runWeeklyRecap({ now: NOW });
  assert.strictEqual(ctx.sends[0].to, '27899999999');
  assert.strictEqual(events(ctx, 'report_test_mode_redirect')[0].intendedRecipient, REPORT);
});

test('WABISTAY_WEEKLY_RECAP_TEMPLATE / WABISTAY_MONTHLY_REPORT_TEMPLATE override the sent template name; params untouched', async () => {
  delete process.env.WABISTAY_NOTIFY_ROUTING; delete process.env.REPORT_TEST_MODE_PHONE;
  const base = setup(reportSeed());
  await freshWebhook().runWeeklyRecap({ now: NOW });
  const defaultParams = base.sends[0].params;

  process.env.WABISTAY_WEEKLY_RECAP_TEMPLATE = 'weekly_recap';
  process.env.WABISTAY_MONTHLY_REPORT_TEMPLATE = 'other_monthly';
  const wh = freshWebhook();
  const ctx = setup(reportSeed());
  await wh.runWeeklyRecap({ now: NOW });
  await wh.runMonthlyReport({ now: NOW });
  assert.deepStrictEqual(ctx.sends.map(s => s.template), ['weekly_recap', 'other_monthly']);
  assert.deepStrictEqual(ctx.sends[0].params, defaultParams);
  assert.strictEqual(ctx.sends[0].params.length, 7);
  assert.strictEqual(ctx.sends[1].params.length, 11);
});

test('weekly recap issues its four table reads concurrently (all four started before any resolves)', async () => {
  delete process.env.WABISTAY_NOTIFY_ROUTING;
  const wh = freshWebhook();
  const ctx = setup(reportSeed());
  // Peak number of Airtable reads in flight at once.
  let inflight = 0, maxInflight = 0;
  const realFetch = global.fetch;
  global.fetch = async (...args) => {
    const url = String(args[0]);
    if (url.includes('api.airtable.com')) {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise(r => setTimeout(r, 5));
      try { return await realFetch(...args); } finally { inflight--; }
    }
    return realFetch(...args);
  };
  try { await wh.runWeeklyRecap({ now: NOW }); } finally { global.fetch = realFetch; }
  assert.ok(maxInflight >= 4, `expected >=4 concurrent Airtable reads, saw ${maxInflight}`);
});

// ── flags log ────────────────────────────────────────────────────────────────

test('flags log: NOTIFY_ROUTING is listed (off by default, on only for 1/true); last-4 only for OWNER_PHONE', () => {
  delete process.env.WABISTAY_NOTIFY_ROUTING;
  process.env.OWNER_PHONE = OWNER;
  let wh = freshWebhook();
  assert.strictEqual(wh.wabistayFlagState().WABISTAY_NOTIFY_ROUTING, 'off');
  for (const [v, exp] of [['1', 'on'], ['true', 'on'], ['yes', 'off'], ['0', 'off']]) {
    process.env.WABISTAY_NOTIFY_ROUTING = v;
    assert.strictEqual(freshWebhook().wabistayFlagState().WABISTAY_NOTIFY_ROUTING, exp, v);
  }
  const others = wh.otherSwitchState();
  assert.strictEqual(others.ownerPhoneLast4, '0111');
  assert.ok(!JSON.stringify(others).includes(OWNER));
});

test('wabistay_notify_phones: logged once per cold start with last-4 digits only, never a full number', async () => {
  process.env.OWNER_PHONE = OWNER;
  process.env.WABISTAY_NOTIFY_ROUTING = '1';
  const wh = freshWebhook();
  const ctx = setup(chatSeed({ props: property({ 'Owner Report Phone': REPORT }) }));
  await send(wh, NEW_NUMBER, 'hi');
  await send(wh, NEW_NUMBER, 'hi');
  const ev = events(ctx, 'wabistay_notify_phones');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].notifyPhoneLast4, '2222');
  assert.strictEqual(ev[0].ownerReportPhoneLast4, '4444');
  assert.strictEqual(ev[0].ownerPhoneLast4, '0111');
  assert.strictEqual(ev[0].notifyRouting, 'on');
  const dump = JSON.stringify(ev);
  for (const full of [OWNER, NOTIFY, REPORT]) assert.ok(!dump.includes(full), 'no full number logged');
});
