// test/interactive.test.js
// WABISTAY_INTERACTIVE. (a) router forwarding is covered in test/nontextreply.test.js;
// (b) a button tap becomes canonical text ONLY in its own state; any other state sees a
// stale tap that must never act as a menu choice; (c) sendInteractiveButtons validates
// Meta's reply-button limits before sending and falls back to the numbered text menu;
// (d) only the payment-method menu is converted. Flag off: today's text menu exactly.
// Typed 1 / 2 stay valid either way. In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, metaInteractivePayload, MockAirtable } = require('./harness');

installEnv();
const saved = process.env.WABISTAY_INTERACTIVE;
afterEach(() => { if (saved === undefined) delete process.env.WABISTAY_INTERACTIVE; else process.env.WABISTAY_INTERACTIVE = saved; });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const CARD = { id: 'pay_card', title: 'Card' };
const EFT = { id: 'pay_eft', title: 'Instant EFT' };
const TEXT_MENU = /is a cashless property\. Payment happens at reception when you arrive:\n1 - Card \(tap on our SpeedPoint machine\)\n2 - Instant EFT/;
const BUTTON_BODY = 'Test Lodge is a cashless property. You will pay at reception when you arrive. How would you like to pay?';

const tomorrow12Z = () => new Date(Date.now() + 24 * 3600e3).toISOString().replace(/T.*/, 'T12:00:00.000Z');

function seed({ state, booking = null, propertyName = 'Test Lodge', bookings } = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': propertyName, 'Phone Number ID': '111000111000', 'City': 'Testville', 'Notify Phone': '27831112222', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300 } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 1', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [], WS_Cleaners: [], WS_Roles: [], WS_Enquiries: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Mama Test', 'Phone Number': GUEST, 'Session State': state } }],
    WS_Bookings: bookings || (booking ? [{ id: 'recBook1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], ...booking } }] : [])
  };
}
const confirmedHourly = { 'Status': 'Confirmed', 'Booking Type': 'Hourly', 'Booking Ref': 'WS-KEGGQF', 'Amount Due': 250, 'Payment Status': 'Unpaid', 'Check In': tomorrow12Z() };

function start(opts, flag) {
  if (flag === undefined) delete process.env.WABISTAY_INTERACTIVE; else process.env.WABISTAY_INTERACTIVE = flag;
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
const tap = (reply, kind) => wh({ method: 'POST', body: metaInteractivePayload(GUEST, reply, undefined, kind) }, makeRes());
const type = text => wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const bookingRow = ctx => ctx.airtable.tables['WS_Bookings'][0].fields;
const texts = ctx => ctx.sends.filter(s => s.type === 'text').map(s => s.body);
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);

// ── mapping ──────────────────────────────────────────────────────────────────

test('canonicalTextForTap: pay_card -> 1, pay_eft -> 2, only in AWAITING_PAYMENT_METHOD; anything else is null', () => {
  assert.strictEqual(wh.canonicalTextForTap('pay_card', 'AWAITING_PAYMENT_METHOD'), '1');
  assert.strictEqual(wh.canonicalTextForTap('pay_eft', 'AWAITING_PAYMENT_METHOD'), '2');
  for (const state of ['CONFIRMED', 'CHECKED_IN', 'AWAITING_ETA', 'AWAITING_RATING', 'NEW', undefined, null]) {
    assert.strictEqual(wh.canonicalTextForTap('pay_card', state), null, String(state));
  }
  assert.strictEqual(wh.canonicalTextForTap('nope', 'AWAITING_PAYMENT_METHOD'), null);
});

test('flag on: a pay_card tap in AWAITING_PAYMENT_METHOD does exactly what a typed 1 does', async () => {
  const tapped = start({ state: 'AWAITING_PAYMENT_METHOD', booking: confirmedHourly }, '1');
  await tap(CARD);
  const typedCtx = start({ state: 'AWAITING_PAYMENT_METHOD', booking: confirmedHourly }, '1');
  await type('1');
  assert.strictEqual(bookingRow(tapped)['Payment Method'], 'Card');
  assert.strictEqual(guestRow(tapped)['Session State'], 'CONFIRMED');
  assert.deepStrictEqual(texts(tapped), texts(typedCtx), 'same replies as the typed answer');
});

test('flag on: a pay_eft tap does exactly what a typed 2 does (EFT + a payment reference)', async () => {
  const tapped = start({ state: 'AWAITING_PAYMENT_METHOD', booking: confirmedHourly }, '1');
  await tap(EFT);
  assert.strictEqual(bookingRow(tapped)['Payment Method'], 'EFT');
  assert.match(bookingRow(tapped)['Payment Reference'], /^[A-Z0-9]{4}$/);
  assert.match(texts(tapped).join('\n'), /Please pay R250\.00 at reception using [A-Z0-9]{4} as your reference/);
});

test('flag on: the tap\'s title is logged (message_received and interactive_reply_received)', async () => {
  const ctx = start({ state: 'AWAITING_PAYMENT_METHOD', booking: confirmedHourly }, '1');
  await tap(EFT);
  const received = events(ctx, 'message_received')[0];
  assert.strictEqual(received.interactiveTitle, 'Instant EFT');
  assert.strictEqual(received.interactiveId, 'pay_eft');
  const ev = events(ctx, 'interactive_reply_received')[0];
  assert.strictEqual(ev.title, 'Instant EFT');
  assert.strictEqual(ev.mapped, true);
});

test('flag off: an interactive reply is ignored, exactly as today (no reply, no write)', async () => {
  const ctx = start({ state: 'AWAITING_PAYMENT_METHOD', booking: confirmedHourly }, undefined);
  await tap(CARD);
  assert.strictEqual(ctx.sends.length, 0);
  assert.strictEqual(bookingRow(ctx)['Payment Method'], undefined);
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_PAYMENT_METHOD');
});

test('typed answers stay valid with the flag on: 1, 2, card, eft', async () => {
  for (const [text, method] of [['1', 'Card'], ['2', 'EFT'], ['card', 'Card'], ['eft', 'EFT']]) {
    const ctx = start({ state: 'AWAITING_PAYMENT_METHOD', booking: confirmedHourly }, '1');
    await type(text);
    assert.strictEqual(bookingRow(ctx)['Payment Method'], method, text);
  }
});

// ── stale taps ───────────────────────────────────────────────────────────────

test('stale tap in CONFIRMED: pay_card must NOT act as "1 - I\'m at the gate" — the confirmed menu answers, nothing changes', async () => {
  const ctx = start({ state: 'CONFIRMED', booking: { ...confirmedHourly, 'Payment Method': 'Card' } }, '1');
  await tap(CARD);
  assert.match(texts(ctx).join('\n'), /Your booking is confirmed/);
  assert.strictEqual(bookingRow(ctx)['Status'], 'Confirmed', 'not checked in');
  assert.strictEqual(guestRow(ctx)['Session State'], 'CONFIRMED');
  assert.strictEqual(ctx.airtable.tables['WS_Rooms'][0].fields['Status'], 'Available');
});

test('stale tap in CHECKED_IN: pay_eft must NOT act as "1 - Check out"', async () => {
  const ctx = start({ state: 'CHECKED_IN', booking: { ...confirmedHourly, 'Status': 'Checked In', 'Checked In At': new Date(Date.now() - 3600e3).toISOString() } }, '1');
  await tap(EFT);
  assert.match(texts(ctx).join('\n'), /You're checked in/);
  assert.strictEqual(bookingRow(ctx)['Status'], 'Checked In');
  assert.strictEqual(guestRow(ctx)['Session State'], 'CHECKED_IN');
});

test('stale tap in AWAITING_ETA: the button title is NOT saved as the arrival time — the ETA prompt is repeated', async () => {
  const ctx = start({ state: 'AWAITING_ETA', booking: { 'Status': 'Enquiry', 'Booking Type': 'Overnight', 'Amount Due': 350, 'Payment Status': 'Unpaid' } }, '1');
  await tap(CARD);
  assert.match(texts(ctx).join('\n'), /What time do you expect to arrive/);
  assert.strictEqual(bookingRow(ctx)['ETA'], undefined, 'no ETA written');
  assert.strictEqual(bookingRow(ctx)['Status'], 'Enquiry', 'booking not confirmed by a stale tap');
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_ETA');
});

test('stale tap in AWAITING_RATING_FEEDBACK: the title is NOT saved as feedback — the feedback prompt is repeated', async () => {
  const ctx = start({ state: 'AWAITING_RATING_FEEDBACK', booking: { ...confirmedHourly, 'Status': 'Checked Out', 'Rating': 1 } }, '1');
  await tap(CARD);
  assert.match(texts(ctx).join('\n'), /Would you like to tell us what went wrong/);
  assert.strictEqual(bookingRow(ctx)['Rating Feedback'], undefined);
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_RATING_FEEDBACK');
});

test('stale tap in AWAITING_RATING and AWAITING_STAY_TYPE: each state\'s own re-prompt answers, nothing is recorded', async () => {
  const rating = start({ state: 'AWAITING_RATING', booking: { ...confirmedHourly, 'Status': 'Checked Out' } }, '1');
  await tap(CARD);
  assert.match(texts(rating).join('\n'), /rate your stay|number from 1 to 5/);
  assert.strictEqual(bookingRow(rating)['Rating'], undefined);
  const stay = start({ state: 'AWAITING_STAY_TYPE' }, '1');
  await tap(EFT);
  assert.match(texts(stay).join('\n'), /Please reply with a number:\n1 - Short stay\n2 - Multiple days/);
  assert.strictEqual(guestRow(stay)['Session State'], 'AWAITING_STAY_TYPE');
});

test('a list_reply with an unknown id is treated the same way: stale, never a choice', async () => {
  const ctx = start({ state: 'CONFIRMED', booking: confirmedHourly }, '1');
  await tap({ id: 'row_x', title: 'Whatever' }, 'list_reply');
  assert.match(texts(ctx).join('\n'), /Your booking is confirmed/);
  assert.strictEqual(bookingRow(ctx)['Status'], 'Confirmed');
});

// ── the payment menu, buttons vs text ────────────────────────────────────────

const durationSeed = { state: 'AWAITING_HOURLY_DURATION', booking: { 'Booking Type': 'Hourly', 'Status': 'Enquiry', 'Check In': tomorrow12Z(), 'Payment Status': 'Unpaid' } };

test('flag off: after the duration choice the numbered TEXT payment menu is sent, exactly as today', async () => {
  const ctx = start(durationSeed, undefined);
  await type('2');
  assert.ok(texts(ctx).some(t => TEXT_MENU.test(t)), 'numbered text menu');
  assert.strictEqual(ctx.sends.filter(s => s.type === 'interactive').length, 0);
});

test('flag on: the payment menu is two reply buttons with the agreed body — and no text menu', async () => {
  const ctx = start(durationSeed, '1');
  await type('2');
  const sent = ctx.sends.filter(s => s.type === 'interactive');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, GUEST);
  assert.strictEqual(sent[0].body, BUTTON_BODY);
  assert.deepStrictEqual(sent[0].buttons, [{ id: 'pay_card', title: 'Card' }, { id: 'pay_eft', title: 'Instant EFT' }]);
  assert.strictEqual(sent[0].interactive.type, 'button');
  assert.ok(!texts(ctx).some(t => TEXT_MENU.test(t)), 'the text menu is not also sent');
});

test('flag on, over a limit: nothing is sent to Meta as interactive; the numbered text menu goes once', async () => {
  const ctx = start({ ...durationSeed, propertyName: 'L'.repeat(1100) }, '1');
  await type('2');
  assert.strictEqual(ctx.sends.filter(s => s.type === 'interactive').length, 0);
  assert.strictEqual(texts(ctx).filter(t => TEXT_MENU.test(t)).length, 1);
  assert.strictEqual(events(ctx, 'interactive_invalid')[0].reason, 'body_too_long');
  assert.strictEqual(events(ctx, 'interactive_fallback_text').length, 1);
});

test('flag on, Meta rejects the buttons at once: logged, then the numbered text menu goes once', async () => {
  const ctx = start(durationSeed, '1');
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('graph.facebook.com') && init.body && JSON.parse(init.body).type === 'interactive') {
      return { status: 400, ok: false, json: async () => ({ error: { message: 'Param interactive invalid', code: 100 } }), text: async () => '' };
    }
    return inner(url, init);
  };
  await type('2');
  assert.strictEqual(ctx.sends.filter(s => s.type === 'interactive').length, 0);
  assert.strictEqual(texts(ctx).filter(t => TEXT_MENU.test(t)).length, 1);
  assert.strictEqual(events(ctx, 'interactive_send_error').length, 1);
  const fb = events(ctx, 'interactive_fallback_text');
  assert.strictEqual(fb.length, 1);
  assert.strictEqual(fb[0].reason, 'meta_rejected');
});

test('flag on: the overnight flow sends the same buttons after the booking quote', async () => {
  const ctx = start({ state: 'AWAITING_DETAILS' }, '1');
  ctx.airtable.tables['WS_Rates'].push({ id: 'recRATE1', fields: { 'Rate Name': 'Standard Overnight', 'Rate Type': 'Per Night', 'Amount': 350, 'Active': true, 'Property': ['recP1'] } });
  await type('Mama Test\n25 June\n27 June');
  const sent = ctx.sends.filter(s => s.type === 'interactive');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].body, BUTTON_BODY);
});

// ── Meta's limits, as constants ──────────────────────────────────────────────

test('validateReplyButtons enforces Meta\'s reply-button limits', () => {
  const ok = { body: 'b', buttons: [{ id: 'a', title: 'A' }] };
  assert.strictEqual(wh.validateReplyButtons(ok), null);
  assert.deepStrictEqual(wh.INTERACTIVE_LIMITS, { buttons: 3, buttonTitle: 20, buttonId: 256, body: 1024, footer: 60 });
  const three = [1, 2, 3].map(n => ({ id: 'i' + n, title: 'T' + n }));
  assert.strictEqual(wh.validateReplyButtons({ body: 'b', buttons: three }), null, '3 buttons is the maximum');
  assert.strictEqual(wh.validateReplyButtons({ body: 'b', buttons: [...three, { id: 'i4', title: 'T4' }] }), 'too_many_buttons');
  assert.strictEqual(wh.validateReplyButtons({ body: 'b', buttons: [{ id: 'a', title: 'x'.repeat(20) }] }), null);
  assert.strictEqual(wh.validateReplyButtons({ body: 'b', buttons: [{ id: 'a', title: 'x'.repeat(21) }] }), 'button_title_too_long');
  assert.strictEqual(wh.validateReplyButtons({ body: 'b', buttons: [{ id: 'x'.repeat(256), title: 'A' }] }), null);
  assert.strictEqual(wh.validateReplyButtons({ body: 'b', buttons: [{ id: 'x'.repeat(257), title: 'A' }] }), 'button_id_too_long');
  assert.strictEqual(wh.validateReplyButtons({ body: 'x'.repeat(1024), buttons: ok.buttons }), null);
  assert.strictEqual(wh.validateReplyButtons({ body: 'x'.repeat(1025), buttons: ok.buttons }), 'body_too_long');
  assert.strictEqual(wh.validateReplyButtons({ ...ok, footer: 'x'.repeat(60) }), null);
  assert.strictEqual(wh.validateReplyButtons({ ...ok, footer: 'x'.repeat(61) }), 'footer_too_long');
  assert.strictEqual(wh.validateReplyButtons({ body: 'b', buttons: [] }), 'no_buttons');
  assert.strictEqual(wh.validateReplyButtons({ body: '', buttons: ok.buttons }), 'body_missing');
  assert.strictEqual(wh.validateReplyButtons({ body: 'b', buttons: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }), 'duplicate_button_id');
});

test('the agreed button titles fit Meta\'s 20-character limit', () => {
  assert.ok('Card'.length <= 20 && 'Instant EFT'.length <= 20);
});

test('the flag is on the cold-start flag list: off by default, on only for 1/true', () => {
  const fresh = () => { delete require.cache[require.resolve('../api/wabistay/webhook.js')]; return require('../api/wabistay/webhook.js'); };
  delete process.env.WABISTAY_INTERACTIVE;
  assert.strictEqual(fresh().wabistayFlagState().WABISTAY_INTERACTIVE, 'off');
  for (const [v, exp] of [['1', 'on'], ['true', 'on'], ['yes', 'off']]) {
    process.env.WABISTAY_INTERACTIVE = v;
    assert.strictEqual(fresh().wabistayFlagState().WABISTAY_INTERACTIVE, exp, v);
  }
});

// ── through the router ───────────────────────────────────────────────────────

test('router, flag on: a tap on the Wabistay number reaches the handler and records the payment method', async () => {
  const router = require('../api/webhook.js');
  const ctx = start({ state: 'AWAITING_PAYMENT_METHOD', booking: confirmedHourly }, '1');
  ctx.airtable.tables['WS_Properties'][0].fields['Phone Number ID'] = '1157302750805659';
  const payload = metaInteractivePayload(GUEST, EFT);
  payload.entry[0].changes[0].value.metadata.phone_number_id = '1157302750805659';
  await router({ method: 'POST', body: payload }, makeRes());
  assert.strictEqual(bookingRow(ctx)['Payment Method'], 'EFT');
});

test('router, flag off: the same tap never reaches the handler (today)', async () => {
  const router = require('../api/webhook.js');
  const ctx = start({ state: 'AWAITING_PAYMENT_METHOD', booking: confirmedHourly }, undefined);
  ctx.airtable.tables['WS_Properties'][0].fields['Phone Number ID'] = '1157302750805659';
  const payload = metaInteractivePayload(GUEST, EFT);
  payload.entry[0].changes[0].value.metadata.phone_number_id = '1157302750805659';
  await router({ method: 'POST', body: payload }, makeRes());
  assert.strictEqual(bookingRow(ctx)['Payment Method'], undefined);
});
