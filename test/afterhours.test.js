// test/afterhours.test.js
// WABISTAY_AFTER_HOURS: closed 23:00-07:59 SAST. A conversation that starts closed gets one welcome per
// window (After Hours Reply At), 23:00-23:59 "tomorrow", 00:00-07:59 "later today"; test phones bypass; guests
// with a booking or mid-payment are not interrupted. With WABISTAY_STAY_MENU on, closed-hours guests see the
// 08:00 menu (Day included) and are dated by the closed rule when the name-and-time reply arrives:
// 23:00-23:59 tomorrow, 00:00-07:59 today, earliest arrival 08:00. First message recorded as an 'After Hours'
// enquiry (tracking on). Flag off: nothing changes.
// Time is mocked with node:test mock timers. In-memory only: MockAirtable + mocked fetch.

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_AFTER_HOURS', 'WABISTAY_STAY_MENU', 'WABISTAY_ENQUIRY_TRACKING', 'WABISTAY_HOLD_RELEASE', 'WABISTAY_LEAN_COPY', 'WABISTAY_INTERACTIVE'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => {
  mock.timers.reset();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const RECEPTION = '27780384989';

// Tuesday 6 Oct 2026. SAST = UTC+2.
const sast = (h, m = 0, d = 6) => Date.UTC(2026, 9, d, h - 2, m);
function atSast(h, m = 0, d = 6) { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: sast(h, m, d) }); }
const iso = (h, m = 0, d = 6) => new Date(sast(h, m, d)).toISOString();

const TOMORROW = 'We are closed at the moment. You can book for tomorrow from 8am onwards. Operating hours are between 8am and 11pm.';
const TODAY = 'We are closed at the moment. You can book for later today from 8am onwards. Operating hours are between 8am and 11pm.';

function seed({ state, guest = true, testPhone = false, afterHoursReplyAt, bookings = [] } = {}) {
  const prop = { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'City': 'Pretoria', 'Notify Phone': '27831112222', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300, 'Guest Redirect Phone': '0730260871' };
  const g = { 'Guest Name': 'Unknown', 'Phone Number': GUEST, 'Session State': state || 'NEW' };
  if (testPhone) g['Test Phone'] = true;
  if (afterHoursReplyAt) g['After Hours Reply At'] = afterHoursReplyAt;
  return {
    WS_Properties: [{ id: 'recP1', fields: prop }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [
      { id: 'recRateDay', fields: { 'Rate Name': 'Day', 'Rate Type': 'Per Day', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } },
      { id: 'recRateNight', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 500, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Cleaners: [], WS_Enquiries: [],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION, 'Active': true } }],
    WS_Guests: guest ? [{ id: 'recG1', fields: g }] : [],
    WS_Bookings: bookings
  };
}
function start(opts = {}, { after = '1', menu = '1', tracking = null } = {}) {
  const set = (k, v) => { if (v === null) delete process.env[k]; else process.env[k] = v; };
  set('WABISTAY_AFTER_HOURS', after); set('WABISTAY_STAY_MENU', menu); set('WABISTAY_ENQUIRY_TRACKING', tracking);
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
const say = (text, from = GUEST) => wh({ method: 'POST', body: metaTextPayload(from, text) }, makeRes());
const guestRow = ctx => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === GUEST).fields;
const bookings = ctx => ctx.airtable.tables['WS_Bookings'];
const mine = ctx => bookings(ctx).find(b => String(b.fields['Notes'] || '').startsWith('Stay: ')) || bookings(ctx)[0];
const texts = (ctx, to = GUEST) => ctx.sends.filter(s => s.type === 'text' && s.to === to).map(s => s.body);
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);
const welcomes = ctx => texts(ctx).filter(t => /We are closed at the moment/.test(t));
const menuOf = ctx => texts(ctx).find(t => /What would you like to book/.test(t));

// ── the boundaries ───────────────────────────────────────────────────────────

test('boundaries: 22:59 and 08:00 are open (no welcome); 23:00, 23:59, 00:00 and 07:59 are closed with the right text', async () => {
  const cases = [
    [22, 59, 6, null], [23, 0, 6, TOMORROW], [23, 59, 6, TOMORROW],
    [0, 0, 7, TODAY], [7, 59, 7, TODAY], [8, 0, 7, null]
  ];
  for (const [h, m, d, expected] of cases) {
    atSast(h, m, d);
    const ctx = start({ guest: false });
    await say('hi');
    if (expected) assert.deepStrictEqual(welcomes(ctx), [expected], `${h}:${m}`);
    else assert.deepStrictEqual(welcomes(ctx), [], `${h}:${m}`);
    assert.ok(menuOf(ctx), `${h}:${m} the normal greeting still follows`);
    mock.timers.reset();
  }
});

test('the welcome comes first, then the 08:00 menu with Day; the reply is stamped in After Hours Reply At', async () => {
  atSast(23, 30);
  const ctx = start({ guest: false });
  await say('hi');
  const t = texts(ctx);
  const welcomeAt = t.findIndex(x => /We are closed/.test(x));
  const menuAt = t.findIndex(x => /What would you like to book/.test(x));
  assert.ok(welcomeAt >= 0 && menuAt > welcomeAt, 'welcome before the menu');
  const menu = menuOf(ctx);
  assert.match(menu, /1 - 2 hour stay, R250\n2 - 3 hour stay, R300\n3 - Full day stay, R400\. Arrive between 8am and 3pm, leave by 5pm\.\n4 - Overnight stay, R500\./);
  assert.ok(!/Short stays have finished/.test(menu), 'the 08:00 menu, not the evening one');
  assert.strictEqual(guestRow(ctx)['After Hours Reply At'], iso(23, 30));
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_STAY_TYPE');
});

test('00:30 and 07:59 also show the 08:00 menu with Day', async () => {
  for (const [h, m] of [[0, 30], [7, 59]]) {
    atSast(h, m, 7);
    const ctx = start({});
    await say('hi');
    assert.match(menuOf(ctx), /3 - Full day stay, R400/, `${h}:${m}`);
    mock.timers.reset();
  }
});

// ── once per window ──────────────────────────────────────────────────────────

test('one welcome per closed window, including across midnight; a new window gets a new welcome', async () => {
  atSast(23, 10);
  const ctx = start({});
  await say('hi');
  assert.strictEqual(welcomes(ctx).length, 1);
  guestRow(ctx)['Session State'] = 'NEW';
  atSast(23, 40);
  await say('hi');
  assert.strictEqual(welcomes(ctx).length, 1, 'same window, 30 minutes later');
  guestRow(ctx)['Session State'] = 'NEW';
  atSast(0, 30, 7);
  await say('hi');
  assert.strictEqual(welcomes(ctx).length, 1, 'still the same window after midnight');
  guestRow(ctx)['Session State'] = 'NEW';
  atSast(23, 10, 7);
  await say('hi');
  assert.strictEqual(welcomes(ctx).length, 2, 'the next night is a new window');
  assert.strictEqual(welcomes(ctx)[1], TOMORROW);
});

test('an After Hours Reply At from before this window does not count as welcomed', async () => {
  atSast(23, 10);
  const ctx = start({ afterHoursReplyAt: iso(23, 30, 5) });
  await say('hi');
  assert.strictEqual(welcomes(ctx).length, 1);
});

// ── who is not welcomed ──────────────────────────────────────────────────────

test('a test phone bypasses everything: no welcome, no stamp, no closed-hours menu, no event', async () => {
  atSast(23, 30);
  const ctx = start({ testPhone: true });
  await say('hi');
  assert.deepStrictEqual(welcomes(ctx), []);
  assert.strictEqual(guestRow(ctx)['After Hours Reply At'], undefined);
  assert.ok(!menuOf(ctx), 'the stay menu is closed for a test phone at 23:30: today\'s greeting');
  assert.match(texts(ctx)[0], /short stay/);
  assert.strictEqual(events(ctx, 'after_hours_message').length, 0);
});

test('a guest with a booking or mid-payment is not interrupted: CONFIRMED, CHECKED_IN, AWAITING_PAYMENT_METHOD, AWAITING_ETA, the rating states', async () => {
  for (const state of ['CONFIRMED', 'CHECKED_IN', 'AWAITING_PAYMENT_METHOD', 'AWAITING_ETA', 'AWAITING_RATING', 'AWAITING_RATING_FEEDBACK']) {
    atSast(23, 30);
    const ctx = start({ state });
    await say('hello').catch(() => {});
    assert.deepStrictEqual(welcomes(ctx), [], state);
    assert.strictEqual(guestRow(ctx)['After Hours Reply At'], undefined, state);
    mock.timers.reset();
  }
});

test('a guest chatting through 23:00 is not interrupted by a welcome', async () => {
  atSast(22, 40);
  const ctx = start({});
  await say('hi');
  atSast(23, 5);
  await say('4');
  assert.deepStrictEqual(welcomes(ctx), []);
});

test('a staff number (reception) is not welcomed', async () => {
  atSast(23, 30);
  const ctx = start({ guest: false });
  await say('hi', RECEPTION);
  assert.deepStrictEqual(texts(ctx, RECEPTION).filter(t => /We are closed/.test(t)), []);
});

// ── the gap: a reply after 23:00 to a menu shown before it ───────────────────

test('menu shown at 22:55 (Overnight only), reply "4" at 23:01: handled by the menu, not by the old handler; dated tomorrow at confirmation', async () => {
  atSast(22, 55);
  const ctx = start({});
  await say('hi');
  assert.match(menuOf(ctx), /^[\s\S]*What would you like to book\? Reply with a number:\n4 - Overnight stay, R500/);
  atSast(23, 1);
  await say('4');
  assert.strictEqual(mine(ctx).fields['Notes'], 'Stay: Overnight', 'Overnight chosen through the menu');
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_HOURLY_DETAILS');
  assert.ok(!texts(ctx).slice(-1)[0].includes('Sorry, I didn\'t'), 'no re-prompt');
  atSast(23, 5);
  await say('Sam Dlamini\n7pm');
  const b = mine(ctx).fields;
  assert.strictEqual(b['Status'], 'Confirmed');
  assert.strictEqual(b['Check In'], iso(19, 0, 7), 'tomorrow 19:00');
  assert.strictEqual(b['Check Out'], iso(10, 0, 8));
  assert.deepStrictEqual(welcomes(ctx), []);
});

test('a "1" after 23:00 is the closed menu\'s 2 hours, never the old "Short stay"', async () => {
  atSast(22, 55);
  const ctx = start({});
  await say('hi');
  atSast(23, 1);
  await say('1');
  assert.strictEqual(mine(ctx).fields['Notes'], 'Stay: 2 hours');
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_HOURLY_DETAILS');
});

// ── dating at confirmation ───────────────────────────────────────────────────

async function bookClosed(now, day, choice, reply) {
  atSast(now[0], now[1], day);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await say(choice);
  await say(reply);
  return ctx;
}

test('23:30: a Day stay is dated tomorrow (arrive 09:00, leave 17:00)', async () => {
  const ctx = await bookClosed([23, 30], 6, '3', 'Sam Dlamini\n9am');
  const b = mine(ctx).fields;
  assert.strictEqual(b['Booking Type'], 'Day');
  assert.strictEqual(b['Check In'], iso(9, 0, 7));
  assert.strictEqual(b['Check Out'], iso(17, 0, 7));
  assert.strictEqual(b['Amount Due'], 400);
});

test('00:30: a Day stay is dated today, and 08:00 itself is allowed as the earliest arrival', async () => {
  const ctx = await bookClosed([0, 30], 7, '3', 'Sam Dlamini\n8am');
  const b = mine(ctx).fields;
  assert.strictEqual(b['Check In'], iso(8, 0, 7));
  assert.strictEqual(b['Check Out'], iso(17, 0, 7));
});

test('07:59: an Overnight is dated today (check in 19:00 tonight, out 10:00 tomorrow)', async () => {
  const ctx = await bookClosed([7, 59], 7, '4', 'Sam Dlamini\n7pm');
  const b = mine(ctx).fields;
  assert.strictEqual(b['Check In'], iso(19, 0, 7));
  assert.strictEqual(b['Check Out'], iso(10, 0, 8));
});

test('a past time at 00:30 gets the "already passed" message with its own example; nothing is booked', async () => {
  const ctx = await bookClosed([0, 30], 7, '1', 'Sam Dlamini\n7am');
  assert.strictEqual(texts(ctx).slice(-1)[0], 'That time has already passed. Please send your full name and the time you expect to arrive, later today.\n\nExample:\nSam Dlamini\n2pm');
  assert.strictEqual(mine(ctx).fields['Status'], 'Enquiry');
  assert.strictEqual(mine(ctx).fields['Check In'], undefined);
});

// ── records ──────────────────────────────────────────────────────────────────

test('tracking on: the first closed message is an After Hours enquiry (once); an after_hours_message event goes out for every closed message', async () => {
  atSast(23, 30);
  const ctx = start({ guest: false }, { tracking: '1' });
  await say('hi');
  await say('4');
  const rows = ctx.airtable.tables['WS_Enquiries'].filter(e => e.fields['Outcome'] === 'After Hours');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].fields['Phone Number'], GUEST);
  assert.strictEqual(events(ctx, 'after_hours_message').length, 2);
  assert.strictEqual(events(ctx, 'after_hours_welcome_sent').length, 1);
});

test('tracking off: no After Hours row, but the welcome still goes', async () => {
  atSast(23, 30);
  const ctx = start({ guest: false });
  await say('hi');
  assert.strictEqual(ctx.airtable.tables['WS_Enquiries'].length, 0);
  assert.strictEqual(welcomes(ctx).length, 1);
});

// ── menu off: only the welcome and the outcome, then the old flow ────────────

test('menu off, flag on: the welcome, the After Hours outcome, then today\'s greeting', async () => {
  atSast(23, 30);
  const ctx = start({ guest: false }, { menu: null, tracking: '1' });
  await say('hi');
  assert.deepStrictEqual(welcomes(ctx), [TOMORROW]);
  assert.ok(texts(ctx).some(t => /short stay/.test(t)), 'old greeting');
  assert.ok(!menuOf(ctx));
  assert.strictEqual(ctx.airtable.tables['WS_Enquiries'].filter(e => e.fields['Outcome'] === 'After Hours').length, 1);
});

// ── flag off / open hours: nothing changes ───────────────────────────────────

test('flag off at 23:30: no welcome, no stamp, no event, and today\'s flow (no closed-hours menu)', async () => {
  atSast(23, 30);
  const ctx = start({ guest: false }, { after: null, tracking: '1' });
  await say('hi');
  assert.deepStrictEqual(welcomes(ctx), []);
  assert.ok(!menuOf(ctx));
  assert.strictEqual(guestRow(ctx)['After Hours Reply At'], undefined);
  assert.strictEqual(events(ctx, 'after_hours_message').length, 0);
  assert.strictEqual(ctx.airtable.tables['WS_Enquiries'].filter(e => e.fields['Outcome'] === 'After Hours').length, 0);
});

test('flag off: a reply after 23:00 to a menu shown before it behaves exactly as today (the old handler)', async () => {
  atSast(22, 55);
  const ctx = start({}, { after: null });
  await say('hi');
  atSast(23, 1);
  await say('4');
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_STAY_TYPE');
  assert.strictEqual(bookings(ctx).length, 0);
});

test('flag on, open hours (10:00): no welcome and the normal menu band', async () => {
  atSast(10, 0);
  const ctx = start({ guest: false });
  await say('hi');
  assert.deepStrictEqual(welcomes(ctx), []);
  assert.match(menuOf(ctx), /1 - 2 hour stay, R250/);
  assert.strictEqual(events(ctx, 'after_hours_message').length, 0);
});

test('the flag is on the cold-start list and reads off by default', () => {
  delete process.env.WABISTAY_AFTER_HOURS;
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_AFTER_HOURS'], 'off');
  process.env.WABISTAY_AFTER_HOURS = '1';
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_AFTER_HOURS'], 'on');
});

// ── review changes: Booked replaces the After Hours row ──────────────────────

const enquiries = ctx => ctx.airtable.tables['WS_Enquiries'];

test('booking in the same closed window turns the After Hours row into the Booked row: one row, with the booking and dates', async () => {
  atSast(23, 30);
  const ctx = start({ guest: false }, { tracking: '1' });
  await say('hi');
  assert.strictEqual(enquiries(ctx).length, 1);
  assert.strictEqual(enquiries(ctx)[0].fields['Outcome'], 'After Hours');
  await say('4');
  atSast(23, 40);
  await say('Sam Dlamini\n7pm');
  const rows = enquiries(ctx);
  assert.strictEqual(rows.length, 1, 'no second row');
  assert.strictEqual(rows[0].fields['Outcome'], 'Booked');
  assert.deepStrictEqual(rows[0].fields['Booking'], [mine(ctx).id]);
  assert.strictEqual(rows[0].fields['Requested Check In'], iso(19, 0, 7));
  assert.strictEqual(rows[0].fields['Booking Type'], 'Overnight');
});

test('an After Hours row from an earlier window is left alone; a booking in open hours gets its own Booked row', async () => {
  atSast(10, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' }, { tracking: '1' });
  ctx.airtable.tables['WS_Enquiries'].push({ id: 'recEnqOld', fields: { 'Phone Number': GUEST, 'Property': ['recP1'], 'Outcome': 'After Hours', 'Created At': iso(23, 30, 5) } });
  await say('4');
  await say('Sam Dlamini\n7pm');
  const rows = enquiries(ctx);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.find(r => r.id === 'recEnqOld').fields['Outcome'], 'After Hours');
  assert.ok(rows.some(r => r.fields['Outcome'] === 'Booked'));
});

test('a guest who does not book keeps the After Hours row', async () => {
  atSast(23, 30);
  const ctx = start({ guest: false }, { tracking: '1' });
  await say('hi');
  await say('banana');
  assert.deepStrictEqual(enquiries(ctx).map(r => r.fields['Outcome']), ['After Hours']);
});

test('flag off: a booking logs its own Booked row exactly as today', async () => {
  atSast(10, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' }, { after: null, tracking: '1' });
  await say('4');
  await say('Sam Dlamini\n7pm');
  assert.deepStrictEqual(enquiries(ctx).map(r => r.fields['Outcome']), ['Booked']);
});

// ── review changes: "hi" / "menu" from a booking step gets the welcome ───────

test('"hi" or "menu" from a booking step after 23:00 gets the welcome once, then the menu', async () => {
  for (const [state, word] of [['AWAITING_STAY_TYPE', 'menu'], ['AWAITING_STAY_TYPE', 'hi'], ['AWAITING_DETAILS', 'hi'], ['AWAITING_HOURLY_DETAILS', 'menu'], ['AWAITING_HOURLY_DURATION', 'hi']]) {
    atSast(23, 30);
    const ctx = start({ state });
    await say(word);
    assert.deepStrictEqual(welcomes(ctx), [TOMORROW], `${state} ${word}`);
    assert.ok(menuOf(ctx), `${state} ${word}: the menu follows`);
    assert.strictEqual(guestRow(ctx)['After Hours Reply At'], iso(23, 30));
    await say('hi');
    assert.strictEqual(welcomes(ctx).length, 1, 'not twice in the same window');
    mock.timers.reset();
  }
});

test('00:30: the same restart gets the "later today" welcome', async () => {
  atSast(0, 30, 7);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await say('menu');
  assert.deepStrictEqual(welcomes(ctx), [TODAY]);
});

test('a restart word from payment, ETA, confirmed, checked in or rating still gets no welcome', async () => {
  for (const state of ['CONFIRMED', 'CHECKED_IN', 'AWAITING_PAYMENT_METHOD', 'AWAITING_ETA', 'AWAITING_RATING', 'AWAITING_RATING_FEEDBACK']) {
    for (const word of ['hi', 'menu']) {
      atSast(23, 30);
      const ctx = start({ state });
      await say(word).catch(() => {});
      assert.deepStrictEqual(welcomes(ctx), [], `${state} ${word}`);
      assert.strictEqual(guestRow(ctx)['After Hours Reply At'], undefined, `${state} ${word}`);
      mock.timers.reset();
    }
  }
});

test('other words from a booking step get no welcome (the chat finishes normally)', async () => {
  atSast(23, 30);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await say('banana');
  assert.deepStrictEqual(welcomes(ctx), []);
});

test('flag off: "menu" from a booking step after 23:00 gets no welcome', async () => {
  atSast(23, 30);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' }, { after: null });
  await say('menu');
  assert.deepStrictEqual(welcomes(ctx), []);
  assert.strictEqual(guestRow(ctx)['After Hours Reply At'], undefined);
});

test('a test phone restarting after 23:00 gets no welcome', async () => {
  atSast(23, 30);
  const ctx = start({ state: 'AWAITING_STAY_TYPE', testPhone: true });
  await say('menu');
  assert.deepStrictEqual(welcomes(ctx), []);
});

// ── review changes: the passed-time message ──────────────────────────────────

test('passed-time message says "tomorrow" 23:00-23:59, "later today" from 00:00, and "later today" in open hours and with the flag off', async () => {
  const cases = [
    [[23, 30], 6, '1', 'Sam Dlamini\n7am', 'tomorrow', {}],
    [[23, 0], 6, '1', 'Sam Dlamini\n7am', 'tomorrow', {}],
    [[0, 30], 7, '1', 'Sam Dlamini\n7am', 'later today', {}],
    [[10, 0], 6, '1', 'Sam Dlamini\n9am', 'later today', {}],
    [[0, 30], 7, '1', 'Sam Dlamini\n7am', null, { after: null }]
  ];
  for (const [now, day, choice, reply, when, flags] of cases) {
    atSast(now[0], now[1], day);
    const ctx = start({ state: 'AWAITING_STAY_TYPE' }, flags);
    await say(choice);
    await say(reply);
    if (when) {
      assert.strictEqual(texts(ctx).slice(-1)[0], `That time has already passed. Please send your full name and the time you expect to arrive, ${when}.\n\nExample:\nSam Dlamini\n2pm`, JSON.stringify(now));
    } else {
      assert.ok(!/already passed/.test(texts(ctx).slice(-1)[0]), 'flag off at 00:30 7am: the old flow, not this message');
    }
    mock.timers.reset();
  }
});

test('a closed-hours booking does not take over an After Hours row from an earlier night', async () => {
  atSast(23, 30);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' }, { tracking: '1' });
  ctx.airtable.tables['WS_Enquiries'].push({ id: 'recEnqOld', fields: { 'Phone Number': GUEST, 'Property': ['recP1'], 'Outcome': 'After Hours', 'Created At': iso(23, 30, 5) } });
  await say('4');
  await say('Sam Dlamini\n7pm');
  const rows = enquiries(ctx);
  assert.strictEqual(rows.find(r => r.id === 'recEnqOld').fields['Outcome'], 'After Hours', 'last night\'s row untouched');
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.some(r => r.id !== 'recEnqOld' && r.fields['Outcome'] === 'Booked'));
});
