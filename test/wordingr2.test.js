// test/wordingr2.test.js
// WABISTAY_WORDING_R2: the approved round-2 guest wording (see Guest-Message-Wording-For-Approval.md), one flag, off by default.
//  A greeting (4 items, available / not available now, fixed numbers)   B unavailable / miss replies (reception number always)
//  C booking + payment choice in ONE message                             D one message after the payment choice
//  E the gate line on the confirmed menu and the arrival-time message    F "Check-out" wording
//  G the post-PAID message on both paths                                  flag off: today's messages
// Time is mocked (node:test mock timers). In-memory only: MockAirtable + mocked fetch.

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, metaInteractivePayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_WORDING_R2', 'WABISTAY_STAY_MENU', 'WABISTAY_RATE_CARD_V2', 'WABISTAY_COMBINED_STAY', 'WABISTAY_INTERACTIVE', 'WABISTAY_CHECKOUT_BUTTON',
  'WABISTAY_GATE_PAY_FLOW', 'WABISTAY_GATE_CONFIRM_FLOW', 'WABISTAY_PAY_ASSIGNS_ROOM', 'WABISTAY_PAID_ROOM_CONFIRMED', 'WABISTAY_GUEST_ADDRESS', 'WABISTAY_LEAN_COPY'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { mock.timers.reset(); for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const RECEPTION = '27780384989';
const sast = (h, m = 0, d = 14) => Date.UTC(2026, 9, d, h - 2, m); // Wed 14 Oct 2026
function atSast(h, m = 0, d = 14) { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: sast(h, m, d) }); }
const iso = (h, m = 0, d = 14) => new Date(sast(h, m, d)).toISOString();
const GATE = "When you reach the gate, reply 1. Reception will open up, take payment, and we'll message your room. No reply in 5 minutes? Call 073 026 0871.";
const ADDR = '57 Canary St, Villa Liza, Boksburg, 1459\nhttps://maps.example/canary';

function seed({ state = 'NEW', guestName = 'Unknown', phone = '0730260871', booking = null, guest = {} } = {}) {
  const prop = { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'City': 'Boksburg', 'Notify Phone': '27831112222',
    'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 200, 'Hourly Rate 3hr': 250, 'Guest Address': '57 Canary St, Villa Liza, Boksburg, 1459', 'Guest Maps Link': 'https://maps.example/canary',
    'EFT Bank Details': 'Bank: Test Bank\nAccount: 123456' };
  if (phone) prop['Guest Redirect Phone'] = phone;
  return {
    WS_Properties: [{ id: 'recP1', fields: prop }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [
      { id: 'recDay', fields: { 'Rate Name': 'Day', 'Rate Type': 'Per Day', 'Amount': 350, 'Active': true, 'Property': ['recP1'] } },
      { id: 'recNight', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 450, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Cleaners: [], WS_Enquiries: [],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION, 'Active': true } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': guestName, 'Phone Number': GUEST, 'Session State': state, ...guest } }],
    WS_Bookings: booking ? [booking] : []
  };
}
function start(opts = {}, { wording = '1', v2 = '1', menu = '1', interactive = null, checkoutButton = null, payFlow = null, extra = {} } = {}) {
  const set = (k, v) => { if (v === null || v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('WABISTAY_WORDING_R2', wording); set('WABISTAY_RATE_CARD_V2', v2); set('WABISTAY_STAY_MENU', menu);
  set('WABISTAY_INTERACTIVE', interactive); set('WABISTAY_CHECKOUT_BUTTON', checkoutButton); set('WABISTAY_GATE_PAY_FLOW', payFlow);
  set('WABISTAY_GUEST_ADDRESS', '1'); set('WABISTAY_PAID_ROOM_CONFIRMED', '1');
  delete process.env.WABISTAY_GATE_CONFIRM_FLOW; delete process.env.WABISTAY_PAY_ASSIGNS_ROOM; delete process.env.WABISTAY_COMBINED_STAY;
  for (const [k, v] of Object.entries(extra)) set(k, v);
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
const say = (from, text) => wh({ method: 'POST', body: typeof text === 'object' ? metaInteractivePayload(from, text) : metaTextPayload(from, text) }, makeRes());
const guestSays = text => say(GUEST, text);
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const bookings = ctx => ctx.airtable.tables['WS_Bookings'];
const to = (ctx, who = GUEST) => ctx.sends.filter(s => s.to === who);
const texts = (ctx, who = GUEST) => to(ctx, who).filter(s => s.type === 'text').map(s => s.body);
const last = (ctx, who = GUEST) => to(ctx, who).slice(-1)[0];

// ── A. greeting ───────────────────────────────────────────────────────────────

const TAIL = '\n\nReply with a number for something that is available now.\n\nNeed more time? Ask reception: an extra 2 hours is R200.\n\nOperating hours are 8am to 11pm. Another day? Please phone reception on 073 026 0871.';
const HEAD = 'Hi! 👋 Welcome to Canary Street Guest Rooms, Boksburg.\n\n*What we offer*\n';
const L1 = '1 - 2 hours, R200 ✅ Available now. Book any time between 8am and 5pm.';
const L2 = '2 - 3 hours, R250 ✅ Available now. Book any time between 8am and 5pm.';
const L3 = '3 - Day stay (4 hours), R350 ✅ Available now. Book between 8am and 1pm; your stay ends 4 hours after you arrive.';
const L4 = '4 - Overnight, R450 ✅ Available now. Check in between 5pm and 11pm. Check-out: 9am.';
const closed = l => l.replace('✅ Available now.', '❌ Not available now.');

test('A: 09:00 greeting lists all four items, all available now, fixed numbers 1 to 4', async () => {
  atSast(9, 0);
  const ctx = start();
  await guestSays('hi');
  assert.strictEqual(texts(ctx)[0], HEAD + [L1, L2, L3, L4].join('\n') + TAIL);
});

test('A: 14:00 the Day stay is marked not available now but is not hidden or renumbered', async () => {
  atSast(14, 0);
  const ctx = start();
  await guestSays('hi');
  assert.strictEqual(texts(ctx)[0], HEAD + [L1, L2, closed(L3), L4].join('\n') + TAIL);
});

test('A: 18:00 the short stays and Day are not available now; Overnight is', async () => {
  atSast(18, 0);
  const ctx = start();
  await guestSays('hi');
  assert.strictEqual(texts(ctx)[0], HEAD + [closed(L1), closed(L2), closed(L3), L4].join('\n') + TAIL);
});

test('A: window boundaries: Day open until 12:59, short stays until 16:59', async () => {
  for (const [h, m, day, short] of [[12, 59, true, true], [13, 0, false, true], [16, 59, false, true], [17, 0, false, false]]) {
    atSast(h, m);
    const ctx = start();
    await guestSays('hi');
    const g = texts(ctx)[0];
    assert.strictEqual(g.includes(L3), day, `Day at ${h}:${m}`);
    assert.strictEqual(g.includes(L1), short, `2h at ${h}:${m}`);
    mock.timers.reset();
  }
});

test('A: a product that cannot be priced is left off (fail closed); Day + night is never in the greeting', async () => {
  atSast(9, 0);
  const ctx = start({}, { extra: { WABISTAY_COMBINED_STAY: '1' } });
  ctx.airtable.tables['WS_Rates'] = ctx.airtable.tables['WS_Rates'].filter(r => r.id !== 'recDay');
  ctx.airtable.tables['WS_Rates'].push({ id: 'recC', fields: { 'Rate Name': 'Day + night', 'Rate Type': 'Combined', 'Amount': 650, 'Active': true, 'Property': ['recP1'] } });
  await guestSays('hi');
  const g = texts(ctx)[0];
  assert.ok(!/Day stay/.test(g) && !/Day \+ night/.test(g));
  assert.ok(g.includes(L1) && g.includes(L4));
});

test('A: with V2 off the greeting is not the new one (the wording flag alone leaves the greeting alone)', async () => {
  atSast(9, 0);
  const ctx = start({}, { v2: null });
  await guestSays('hi');
  assert.ok(!/What we offer/.test(texts(ctx)[0]));
  assert.match(texts(ctx)[0], /What would you like to book/);
});

// ── B. unavailable / miss ─────────────────────────────────────────────────────

const HELP = ' Need help? Please phone reception on 073 026 0871.';
const AVAIL_14 = 'Available now:\n1 - 2 hours, R200\n2 - 3 hours, R250\n4 - Overnight, R450\n\nReply with one of these numbers.';

test('B: picking the Day stay at 14:00 names its window, lists what is available now and shows the reception number', async () => {
  atSast(14, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await guestSays('3');
  assert.strictEqual(texts(ctx)[0], 'Sorry, the Day stay (4 hours) is not available right now. It can be booked between 8am and 1pm.\n\n' + AVAIL_14 + HELP);
  assert.strictEqual(bookings(ctx).length, 0, 'nothing parked');
  await guestSays('day');
  assert.strictEqual(texts(ctx)[1], texts(ctx)[0], 'the typed word behaves the same');
});

test('B: a reply that is not a choice gets the miss reply, also with the reception number, every time', async () => {
  atSast(14, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  for (const t of ['hello', '9', '5']) await guestSays(t);
  const miss = "Sorry, I didn't catch that. " + AVAIL_14 + HELP;
  assert.deepStrictEqual(texts(ctx), [miss, miss, miss]);
});

test('B: a property with no reception number drops the help sentence', async () => {
  atSast(14, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE', phone: '' });
  await guestSays('hello');
  assert.ok(!/phone reception/.test(texts(ctx)[0]));
  assert.match(texts(ctx)[0], /Reply with one of these numbers\.$/);
});

test('B: an available pick still works (fixed numbers: 4 at 14:00 is Overnight)', async () => {
  atSast(14, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await guestSays('4');
  assert.strictEqual(bookings(ctx)[0].fields['Notes'], 'Stay: Overnight');
  assert.match(texts(ctx)[0], /^Please send your full name and the time you expect to arrive/);
});

test('B: with the flag off the numbers go back to the V2 positions and the old reprompt', async () => {
  atSast(14, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' }, { wording: null });
  await guestSays('3');
  assert.strictEqual(bookings(ctx)[0].fields['Notes'], 'Stay: Overnight', 'V2 position 3 is Overnight at 14:00');
});

// ── C. booking + payment choice in one message ───────────────────────────────

async function book(choice, reply, { now = [9, 0], opts = {}, cfg = {} } = {}) {
  atSast(...now);
  const ctx = start({ state: 'AWAITING_STAY_TYPE', ...opts }, cfg);
  await guestSays(choice);
  const before = ctx.sends.length;
  await guestSays(reply);
  return { ctx, sent: ctx.sends.slice(before).filter(s => s.to === GUEST) };
}
const PAYTAIL = 'Canary Street Guest Rooms is cashless: you pay at reception when you arrive. How would you like to pay?';

test('C: a 2-hour booking is ONE interactive message with Card / Instant EFT buttons, showing the fixed stay', async () => {
  const { sent } = await book('1', 'Sam Dlamini 3pm', { cfg: { interactive: '1' } });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'interactive');
  assert.strictEqual(sent[0].body, 'Thanks Sam Dlamini! 🙏\n\nYour *2 hours* is booked.\n\n*Ref:* WS-NEW001\n*Your stay:* 3:00pm to 5:00pm on 14 Oct\n*Price:* R200\n\nIf you arrive late, your stay still ends at 5:00pm.\n\n' + PAYTAIL);
  assert.deepStrictEqual(sent[0].buttons.map(b => b.title), ['Card', 'Instant EFT']);
});

test('C: without buttons the same body goes as text with the numbered choice', async () => {
  const { sent } = await book('1', 'Sam Dlamini 3pm');
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].body.endsWith(PAYTAIL + '\n\nReply with a number:\n1 - Card\n2 - Instant EFT'));
});

test('C: Day stay shows the 4-hour window from the booked arrival; a late arrival does not move it', async () => {
  const { ctx, sent } = await book('3', 'Sam Dlamini 10am', { cfg: { interactive: '1' } });
  assert.match(sent[0].body, /Your \*Day stay \(4 hours\)\* is booked\.[\s\S]*\*Your stay:\* 10:00am to 2:00pm on 14 Oct\n\*Price:\* R350\n\nIf you arrive late, your stay still ends at 2:00pm\./);
  assert.strictEqual(bookings(ctx)[0].fields['Check Out'], iso(14, 0));
});

test('C: Overnight shows Arriving and Check-out (9am, V2) and no "Until"', async () => {
  const { sent } = await book('4', 'Sam Dlamini 7pm', { now: [12, 0], cfg: { interactive: '1' } });
  assert.strictEqual(sent[0].body, 'Thanks Sam Dlamini! 🙏\n\nYour *Overnight* is booked.\n\n*Ref:* WS-NEW001\n*Arriving:* 14 Oct at 7:00pm\n*Check-out:* 9am on 15 Oct\n*Price:* R450\n\n' + PAYTAIL);
  assert.ok(!/Until/.test(sent[0].body));
});

test('C: the staff alert says Stay / Check-out instead of Until', async () => {
  const { ctx } = await book('1', 'Sam Dlamini 3pm');
  const alert = texts(ctx, '27830000001').join('\n');
  assert.match(alert, /Stay: 3:00pm to 5:00pm on 14 Oct/);
  assert.ok(!/Until/.test(alert));
  const o = await book('4', 'Sam Dlamini 7pm', { now: [12, 0] });
  assert.match(texts(o.ctx, '27830000001').join('\n'), /Arriving: 14 Oct at 7:00pm\nCheck-out: 9am on 15 Oct/);
});

test('C: flag off keeps today\'s two messages (booking, then the payment menu)', async () => {
  const { sent } = await book('1', 'Sam Dlamini 3pm', { cfg: { wording: null } });
  assert.strictEqual(sent.length, 2);
  assert.match(sent[0].body, /\*Until:\*/);
});

test('C: the legacy short-stay path (stay menu off) also sends ONE merged message', async () => {
  atSast(23, 30);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' }, { menu: null, v2: null, interactive: '1' });
  await guestSays('1');
  await guestSays('Sam Dlamini\n11:45pm');
  const before = ctx.sends.length;
  await guestSays('2');
  const sent = ctx.sends.slice(before).filter(s => s.to === GUEST);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].body, /Your \*2 hours\* is booked\.[\s\S]*\*Your stay:\* 11:45pm on 14 Oct to 1:45am on 15 Oct\n\*Price:\* R200\n\nIf you arrive late, your stay still ends at 1:45am\./);
});

// ── D. one message after the payment choice ───────────────────────────────────

test('D: Card chosen is ONE message: card line, address, the gate line and the menu', async () => {
  const { ctx } = await book('1', 'Sam Dlamini 3pm');
  const before = ctx.sends.length;
  await guestSays('1');
  const sent = ctx.sends.slice(before).filter(s => s.to === GUEST);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].body, 'Card it is. ✅ You will tap your card on our SpeedPoint machine at reception.\n\n' + ADDR + '\n\n' + GATE + "\n\n1 - I'm at the gate\n2 - Cancel my booking");
  assert.strictEqual(guestRow(ctx)['Session State'], 'CONFIRMED');
});

test('D: Instant EFT chosen is ONE message with the reference, bank details, address and the gate line', async () => {
  const { ctx } = await book('4', 'Sam Dlamini 7pm', { now: [12, 0] });
  const before = ctx.sends.length;
  await guestSays('2');
  const sent = ctx.sends.slice(before).filter(s => s.to === GUEST);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].body, /^Instant EFT it is\. ✅ Please pay R450.00 by instant EFT, using [A-Z0-9]+ as your reference\.\n\nBank: Test Bank\nAccount: 123456\n\nReception will confirm once the funds reflect, and then assign your room\.\n\n57 Canary St/);
  assert.ok(sent[0].body.endsWith(GATE + "\n\n1 - I'm at the gate\n2 - Cancel my booking"));
});

test('D: typed-dates overnight (asks the arrival time next) keeps its two messages, not merged', async () => {
  atSast(9, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' }, { menu: null, v2: null });
  await guestSays('multiple days');
  await guestSays('Sam Dlamini\n25 October\n27 October');
  const before = ctx.sends.length;
  await guestSays('1');
  const sent = ctx.sends.slice(before).filter(s => s.to === GUEST);
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1].body, /What time do you expect to arrive/);
});

test('D: flag off: today\'s two messages after the card choice', async () => {
  const { ctx } = await book('1', 'Sam Dlamini 3pm', { cfg: { wording: null } });
  const before = ctx.sends.length;
  await guestSays('1');
  assert.strictEqual(ctx.sends.slice(before).filter(s => s.to === GUEST).length, 2);
});

// ── E. the gate line on the confirmed menu and the arrival-time message ──────

test('E: "hi" while booked shows the confirmed menu with the gate line', async () => {
  atSast(15, 0);
  const ctx = start({ state: 'CONFIRMED', guestName: 'Sam Dlamini' });
  await guestSays('hi');
  assert.strictEqual(texts(ctx)[0], 'Hi Sam Dlamini! Your booking is confirmed. 🛏️\n\n' + ADDR + '\n\n' + GATE + "\n\n1 - I'm at the gate\n2 - Cancel my booking");
});

test('E: the arrival-time confirmation carries the gate line too', async () => {
  atSast(12, 0);
  const ctx = start({ state: 'AWAITING_ETA', guestName: 'Sam Dlamini', booking: { id: 'recB1', fields: { 'Guest': ['recG1'], 'Booking Type': 'Overnight', 'Status': 'Confirmed', 'Check In': iso(14, 0), 'Check Out': iso(9, 0, 15), 'Amount Due': 450, 'Payment Status': 'Unpaid' } } });
  await guestSays('7pm');
  assert.strictEqual(texts(ctx)[0], "Perfect! We'll have your room ready for you. 🛏️\n\nSee you at *7pm*.\n\n" + ADDR + '\n\n' + GATE + "\n\n1 - I'm at the gate\n2 - Cancel my booking\n\nWe look forward to hosting you at Canary Street Guest Rooms! 🌟");
});

test('E: a property with no reception number drops only the call sentence', async () => {
  atSast(15, 0);
  const ctx = start({ state: 'CONFIRMED', guestName: 'Sam Dlamini', phone: '' });
  await guestSays('hi');
  assert.ok(texts(ctx)[0].includes("and we'll message your room.\n\n1 - I'm at the gate"));
  assert.ok(!/Call /.test(texts(ctx)[0]));
});

test('E: flag off: today\'s confirmed menu', async () => {
  atSast(15, 0);
  const ctx = start({ state: 'CONFIRMED', guestName: 'Sam Dlamini' }, { wording: null });
  await guestSays('hi');
  assert.strictEqual(texts(ctx)[0], "Hi Sam Dlamini! Your booking is confirmed. 🛏️\n\n" + ADDR + "\n\nReply with a number:\n1 - I'm at the gate\n2 - Cancel my booking");
});

// ── G. after reception records PAID ──────────────────────────────────────────

function gateBooking(extra = {}) {
  return { id: 'recBook1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Status': 'Confirmed', 'Amount Due': 450, 'Payment Status': 'Unpaid', 'Payment Method': 'Card',
    'Booking Ref': 'WS-GATEP1', 'Payment Reference': 'AB12', 'Check In': iso(14, 0), 'Check Out': iso(9, 0, 15), ...extra } };
}
function startGate(bookingExtra, cfg = {}, guestExtra = {}) {
  atSast(15, 0);
  return start({ state: 'CONFIRMED', guestName: 'Sam Dlamini', booking: gateBooking(bookingExtra), guest: guestExtra }, { payFlow: '1', ...cfg });
}
const PAY = 'PAID ROOM 1 450 card';

test('G: overnight, guest pressed 1 BEFORE payment was recorded: opening-the-gate line and Check-out: 9am tomorrow', async () => {
  const ctx = startGate({ 'Gate Tap At': iso(14, 55) });
  await say(RECEPTION, PAY);
  assert.strictEqual(texts(ctx).slice(-1)[0], "Payment received. Enjoy your stay! Your room is Room 01. Reception is opening the gate. Check-out: 9am tomorrow. When you're ready to leave, reply 1 to check out.");
  assert.strictEqual(bookings(ctx)[0].fields['Status'], 'Checked In');
  assert.strictEqual(guestRow(ctx)['Session State'], 'CHECKED_IN');
});

test('G: overnight, guest pressed 1 AFTER payment was recorded: same message without the opening-the-gate line', async () => {
  atSast(15, 0);
  const ctx = start({ state: 'CONFIRMED', guestName: 'Sam Dlamini', booking: gateBooking({ 'Payment Status': 'Paid', 'Amount Paid': 450 }) }, { payFlow: '1' });
  await guestSays('1');
  assert.ok(texts(ctx).includes("Payment received. Enjoy your stay! Your room is Room 01. Check-out: 9am tomorrow. When you're ready to leave, reply 1 to check out."));
  assert.ok(!texts(ctx).some(t => /opening the gate/.test(t)));
});

test('G: short stay shows the booked stay, not a check-out line, and a late payment does not move it', async () => {
  const ctx = startGate({ 'Booking Type': 'Hourly', 'Check In': iso(16, 59), 'Check Out': iso(18, 59), 'Gate Tap At': iso(14, 55) });
  await say(RECEPTION, PAY);
  assert.strictEqual(texts(ctx).slice(-1)[0], "Payment received. Enjoy your stay! Your room is Room 01. Reception is opening the gate. Your stay: 4:59pm to 6:59pm on 14 Oct. When you're ready to leave, reply 1 to check out.");
  assert.strictEqual(bookings(ctx)[0].fields['Check Out'], iso(18, 59), 'Check Out untouched');
});

test('G: the check-out phrase says today / tomorrow / the date, and takes the booking\'s own time (10am while V2 is off)', () => {
  const now = new Date(sast(15, 0));
  assert.strictEqual(wh.checkoutPhrase(iso(9, 0, 14), now), '9am today');
  assert.strictEqual(wh.checkoutPhrase(iso(9, 0, 15), now), '9am tomorrow');
  assert.strictEqual(wh.checkoutPhrase(iso(10, 0, 17), now), '10am on 17 Oct');
  assert.strictEqual(wh.checkoutPhrase(iso(9, 30, 15), now), '9:30am tomorrow');
});

test('G: with the Check out button on, the same text carries a Check out button; the keys-button flow still wins when it is on', async () => {
  const ctx = startGate({ 'Gate Tap At': iso(14, 55) }, { interactive: '1', checkoutButton: '1' });
  await say(RECEPTION, PAY);
  const m = last(ctx);
  assert.strictEqual(m.type, 'interactive');
  assert.match(m.body, /^Payment received\. Enjoy your stay!/);
  assert.deepStrictEqual(m.buttons, [{ id: 'co_start', title: 'Check out' }]);
  const keys = startGate({ 'Gate Tap At': iso(14, 55) }, { interactive: '1', extra: { WABISTAY_GATE_CONFIRM_FLOW: '1' } });
  await say(RECEPTION, PAY);
  assert.match(last(keys).body, /I have my keys|Tap the button once you have your keys/);
});

test('G: flag off: today\'s Welcome', async () => {
  const ctx = startGate({ 'Gate Tap At': iso(14, 55) }, { wording: null });
  await say(RECEPTION, PAY);
  assert.match(texts(ctx).slice(-1)[0], /^Welcome to Canary Street Guest Rooms! Your room is \*Room 01\*/);
});

// ── F. Check-out wording elsewhere ───────────────────────────────────────────

test('F: walk-in confirmation says Check-out (staff); flag off keeps Checkout', async () => {
  for (const [wording, label] of [['1', '*Check-out:*'], [null, '*Checkout:*']]) {
    atSast(9, 0);
    const ctx = start({}, { wording });
    await say(RECEPTION, 'WALKIN ROOM 1 2HRS John Smith');
    assert.ok(texts(ctx, RECEPTION).join('\n').includes(label), String(wording));
    mock.timers.reset();
  }
});

test('F: the checkout warning reads Check-out, and under V2 tells guests to ask reception; flag off is today\'s', async () => {
  const NOW = new Date(sast(12, 0));
  const run = async cfg => {
    process.env.WABISTAY_WORDING_R2 = cfg.wording || ''; if (!cfg.wording) delete process.env.WABISTAY_WORDING_R2;
    if (cfg.v2) process.env.WABISTAY_RATE_CARD_V2 = '1'; else delete process.env.WABISTAY_RATE_CARD_V2;
    const ctx = { airtable: new MockAirtable({
      WS_Bookings: [{ id: 'recB1', fields: { Guest: ['recG1'], Status: 'Checked In', 'Booking Type': 'Hourly', Room: ['recR1'], 'Check Out': new Date(NOW.getTime() - 60000).toISOString() } }],
      WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': '27821234567' } }],
      WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Occupied', 'Property': ['recP1'] } }],
      WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Test Lodge' } }], WS_Cleaners: []
    }), sends: [], axiom: [] };
    installFetch(ctx);
    await wh.runAutoCheckout(NOW);
    return ctx.sends[0].body;
  };
  assert.match(await run({ wording: '1', v2: true }), /^Hi John Smith, check-out time at Test Lodge has arrived\. ⏰\n\nNeed more time\? Please ask reception\./);
  assert.match(await run({ wording: '1', v2: false }), /^Hi John Smith, check-out time at Test Lodge has arrived\. ⏰\n\nNeed more time\? Reply \*EXTEND\*/);
  assert.match(await run({ wording: null, v2: false }), /^Hi John Smith, checkout time at Test Lodge has arrived\./);
});

test('F: combined confirmation and staff alert say Check-out; the overnight offer reads "Check-out: 9am"', async () => {
  atSast(9, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' }, { extra: { WABISTAY_COMBINED_STAY: '1' } });
  ctx.airtable.tables['WS_Rates'].push({ id: 'recC', fields: { 'Rate Name': 'Day + night', 'Rate Type': 'Combined', 'Amount': 650, 'Active': true, 'Property': ['recP1'] } });
  await guestSays('day + night');
  await guestSays('Sam Dlamini\n16 October\n18 October\n9am');
  const t = texts(ctx).join('\n');
  assert.match(t, /\*Check-out:\* 9am on 18 October/);
  assert.ok(!/Leaving/.test(t));
  assert.match(texts(ctx, '27830000001').join('\n') + texts(ctx, '27831112222').join('\n'), /Check-out: 9am on 18 October/);
  await guestSays('hi');
  const c2 = start({ state: 'AWAITING_STAY_TYPE' }, { extra: { WABISTAY_COMBINED_STAY: '1' } });
  c2.airtable.tables['WS_Rates'].push({ id: 'recC', fields: { 'Rate Name': 'Day + night', 'Rate Type': 'Combined', 'Amount': 650, 'Active': true, 'Property': ['recP1'] } });
  await guestSays('day + night');
  await guestSays('Sam Dlamini\n16 October\n17 October\n2pm');
  assert.match(texts(c2).slice(-1)[0], /\(check in 5pm to 11pm\. Check-out: 9am\)/);
});

// ── the flag itself ──────────────────────────────────────────────────────────

test('the flag is off unless 1 or true', () => {
  for (const [v, on] of [[undefined, false], ['', false], ['0', false], ['yes', false], ['1', true], ['true', true], ['TRUE', true]]) {
    if (v === undefined) delete process.env.WABISTAY_WORDING_R2; else process.env.WABISTAY_WORDING_R2 = v;
    assert.strictEqual(wh.wordingR2Enabled(), on, String(v));
  }
});
