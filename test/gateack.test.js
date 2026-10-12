// test/gateack.test.js
// WABISTAY_GATE_ACK: gate alerts ask the office for a YES; a YES clears every waiting alert of the property; an alert
// nobody answers is escalated once by the 5-minute cron after the property's own grace period. A guest's "yes" is
// never taken. Flag off: nothing changes. In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const STATES = require('../states.json');

const ENV = ['WABISTAY_GATE_ACK', 'WABISTAY_GATE_ACK_TEMPLATE', 'WABISTAY_GATE_ESCALATION_TEMPLATE', 'WABISTAY_GATE_ALERT_UNPAID', 'WABISTAY_GATE_ARRIVAL_TEMPLATE', 'GATE_ACK_GRACE_MS', 'ESCALATION_TIMEOUT_DEFAULT_MINUTES'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const GUEST = '27821234567';
const GUEST2 = '27829990002';
const NOTIFY = '27831112222';
const RECEPTION = '27825999279';
const ONDUTY = '27826660001';
const OTHER_PROPERTY_SEAT = '27827770009';
const ASK = '\n\nReply YES once you have seen this.';
const ACK_TEMPLATE = 'wabistay_gate_arrival_ack';
const NORMAL_TEMPLATE = 'wabistay_gate_arrival';
const ESC_TEMPLATE = 'wabistay_gate_escalation';
const mins = m => new Date(Date.now() - m * 60000).toISOString();

function seed({ property = {}, extraBookings = [], roles } = {}) {
  return {
    WS_Properties: [
      { id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': NOTIFY, ...property } },
      { id: 'recP2', fields: { 'Property Name': 'Other Lodge', 'Phone Number ID': '222000222000' } }
    ],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Roles: roles || [
      { id: 'recRec', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION, 'Active': true } },
      { id: 'recDuty', fields: { 'Role Label': 'On Duty', 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': ONDUTY, 'Active': true } },
      { id: 'recOther', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP2'], 'Current Phone': OTHER_PROPERTY_SEAT, 'Active': true } }
    ],
    WS_Guests: [
      { id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST, 'Session State': 'CONFIRMED' } },
      { id: 'recG2', fields: { 'Guest Name': 'Sam Smith', 'Phone Number': GUEST2, 'Session State': 'CONFIRMED' } }
    ],
    WS_Bookings: [{
      id: 'recBook1', fields: {
        'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Confirmed', 'Booking Type': 'Hourly', 'Booking Ref': 'WS-ACK001',
        'Amount Due': 250, 'Payment Status': 'Unpaid', 'Check In': mins(5), 'Check Out': new Date(Date.now() + 3 * 3600e3).toISOString()
      }
    }, ...extraBookings],
    WS_Cleaners: [], WS_Rates: [], WS_Enquiries: []
  };
}
function start(flags = {}, opts = {}) {
  for (const k of ENV) delete process.env[k];
  process.env.WABISTAY_GATE_ALERT_UNPAID = '1';
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = NORMAL_TEMPLATE;
  Object.assign(process.env, flags);
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
const say = (from, text, id) => wh({ method: 'POST', body: metaTextPayload(from, text, id) }, makeRes());
const booking = (ctx, id = 'recBook1') => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id).fields;
const textsTo = (ctx, who) => ctx.sends.filter(s => s.to === who && s.type === 'text').map(s => s.body);
const templatesTo = (ctx, who) => ctx.sends.filter(s => s.to === who && s.type === 'template');
const ON = { WABISTAY_GATE_ACK: '1', WABISTAY_GATE_ACK_TEMPLATE: ACK_TEMPLATE };
// a booking that has an ask outstanding
const waitingBooking = (id, guestId, sentMinsAgo, extra = {}) => ({
  id, fields: { 'Guest': [guestId], 'Status': 'Confirmed', 'Booking Type': 'Hourly', 'Booking Ref': 'WS-' + id.slice(-6).toUpperCase(), 'WS_Property': ['recP1'],
    'Amount Due': 250, 'Payment Status': 'Unpaid', 'Gate Notify Sent At': mins(sentMinsAgo), ...extra }
});

// ── the ask ───────────────────────────────────────────────────────────────────

test('flag off: the unpaid gate alert is unchanged — normal template, no ask, nothing tracked', async () => {
  const ctx = start({});
  await say(GUEST, '1');
  assert.strictEqual(templatesTo(ctx, RECEPTION)[0].template, NORMAL_TEMPLATE);
  assert.ok(!textsTo(ctx, NOTIFY).join('').includes('Reply YES'));
  assert.strictEqual(booking(ctx)['Gate Notify Sent At'], undefined);
});

test('flag on: Reception gets the ask template with the SAME five variables (no fifth), the Notify Phone copy ends with the ask, and the alert is tracked', async () => {
  const off = start({}); await say(GUEST, '1');
  const normalParams = templatesTo(off, RECEPTION)[0].params;
  const ctx = start(ON); await say(GUEST, '1');
  const t = templatesTo(ctx, RECEPTION)[0];
  assert.strictEqual(t.template, ACK_TEMPLATE);
  assert.strictEqual(t.params.length, 5);
  assert.deepStrictEqual(t.params, normalParams, 'the ask is in the template\'s fixed body, not in a variable');
  assert.ok(textsTo(ctx, NOTIFY).some(b => b.endsWith(ASK) && /has not paid yet/.test(b)));
  assert.ok(booking(ctx)['Gate Notify Sent At']);
  assert.deepStrictEqual(booking(ctx)['WS_Property'], ['recP1'], 'the alert is tied to its property');
  assert.ok(!booking(ctx)['Gate Notify Acked At'] && !booking(ctx)['Gate Escalated At']);
});

test('flag on, no ask template configured: Reception gets the normal alert; only the Notify Phone copy carries (and tracks) the ask', async () => {
  const ctx = start({ WABISTAY_GATE_ACK: '1' });
  await say(GUEST, '1');
  assert.strictEqual(templatesTo(ctx, RECEPTION)[0].template, NORMAL_TEMPLATE);
  assert.ok(textsTo(ctx, NOTIFY).some(b => b.endsWith(ASK)));
  assert.ok(booking(ctx)['Gate Notify Sent At']);
});

test('flag on, nothing that asks was delivered (the Notify Phone copy fails, no ask template): the alert is not tracked, so it can never escalate', async () => {
  const ctx = start({ WABISTAY_GATE_ACK: '1' });
  const real = global.fetch;
  global.fetch = async (u, o = {}) => {
    if (String(u).includes('graph.facebook.com') && JSON.parse(o.body).to !== GUEST && JSON.parse(o.body).to !== RECEPTION) {
      return { status: 400, json: async () => ({ error: { code: 131047, message: 'outside window' } }) };
    }
    return real(u, o);
  };
  await say(GUEST, '1');
  assert.ok(templatesTo(ctx, RECEPTION).length === 1, 'Reception still got the normal alert');
  assert.strictEqual(booking(ctx)['Gate Notify Sent At'], undefined);
});

// ── the YES ──────────────────────────────────────────────────────────────────

test('YES from a Reception seat clears the waiting alert and says who; flag off, the same YES is just an ordinary message', async () => {
  const on = start(ON, { extraBookings: [] });
  Object.assign(booking(on), { 'Gate Notify Sent At': mins(3), 'WS_Property': ['recP1'] });
  await say(RECEPTION, 'YES');
  assert.ok(booking(on)['Gate Notify Acked At']);
  assert.deepStrictEqual(textsTo(on, RECEPTION), ['Thanks, noted. Cleared: Jane Doe (WS-ACK001).']);
  const off = start({});
  Object.assign(booking(off), { 'Gate Notify Sent At': mins(3), 'WS_Property': ['recP1'] });
  await say(RECEPTION, 'YES');
  assert.strictEqual(booking(off)['Gate Notify Acked At'], undefined);
});

test('YES from the Notify Phone, from an On Duty seat and as "y" all work; a lowercase yes too', async () => {
  for (const [who, word] of [[NOTIFY, 'yes'], [ONDUTY, 'Y'], [RECEPTION, ' Yes ']]) {
    const ctx = start(ON);
    Object.assign(booking(ctx), { 'Gate Notify Sent At': mins(3), 'WS_Property': ['recP1'] });
    await say(who, word);
    assert.ok(booking(ctx)['Gate Notify Acked At'], `${who} / ${word}`);
  }
});

test('WHAT A YES ACKNOWLEDGES: every waiting alert of the sender\'s property, escalated ones included, and nothing of another property', async () => {
  const ctx = start(ON, { extraBookings: [
    waitingBooking('recBook2', 'recG2', 6),
    waitingBooking('recBook3', 'recG2', 30, { 'Gate Escalated At': mins(20) }),
    { id: 'recBook4', fields: { ...waitingBooking('recBook4', 'recG2', 4).fields, 'WS_Property': ['recP2'], 'Booking Ref': 'WS-OTHER4' } },
    waitingBooking('recBook5', 'recG2', 26 * 60)   // older than 24 h: stale, left alone
  ] });
  Object.assign(booking(ctx), { 'Gate Notify Sent At': mins(2), 'WS_Property': ['recP1'] });
  await say(RECEPTION, 'yes');
  assert.ok(booking(ctx, 'recBook1')['Gate Notify Acked At']);
  assert.ok(booking(ctx, 'recBook2')['Gate Notify Acked At']);
  assert.ok(booking(ctx, 'recBook3')['Gate Notify Acked At'], 'an escalated alert is still cleared by a YES');
  assert.strictEqual(booking(ctx, 'recBook4')['Gate Notify Acked At'], undefined, 'another property\'s alert is untouched');
  assert.strictEqual(booking(ctx, 'recBook5')['Gate Notify Acked At'], undefined, 'older than 24 h: untouched');
  const reply = textsTo(ctx, RECEPTION)[0];
  assert.match(reply, /^Thanks, noted\. Cleared: /);
  assert.ok(reply.includes('Jane Doe (WS-ACK001)') && reply.includes('Sam Smith (WS-RECBOOK2'.slice(0, 9)) && !reply.includes('WS-OTHER4'));
});

test('a YES from a seat of ANOTHER property, with nothing waiting, or after it was already cleared, does nothing', async () => {
  const other = start(ON);
  Object.assign(booking(other), { 'Gate Notify Sent At': mins(3), 'WS_Property': ['recP1'] });
  await say(OTHER_PROPERTY_SEAT, 'yes');   // that number's property is Other Lodge's: it messages the Canary number here, but is not Canary staff
  assert.strictEqual(booking(other)['Gate Notify Acked At'], undefined);
  const none = start(ON);
  await say(RECEPTION, 'yes');
  assert.ok(!none.axiom.some(e => e.event === 'gate_ack_confirmed'));
  const twice = start(ON);
  Object.assign(booking(twice), { 'Gate Notify Sent At': mins(3), 'WS_Property': ['recP1'] });
  await say(RECEPTION, 'yes'); await say(RECEPTION, 'yes');
  assert.strictEqual(twice.axiom.filter(e => e.event === 'gate_ack_confirmed').length, 1);
});

// ── (c) a guest's "yes" is never intercepted ─────────────────────────────────

test('A GUEST\'S YES IS NEVER INTERCEPTED: in every guest step, with an alert waiting for a YES, the reply and the data are exactly what they are with the flag off', async () => {
  const states = Object.keys(STATES.states);
  assert.ok(states.length > 10);
  for (const state of states) {
    const run = async flags => {
      const ctx = start(flags);
      Object.assign(booking(ctx), { 'Gate Notify Sent At': mins(3), 'WS_Property': ['recP1'] });
      ctx.airtable.tables['WS_Guests'][0].fields['Session State'] = state;
      await say(GUEST, 'yes');
      return ctx;
    };
    const on = await run(ON);
    const off = await run({});
    assert.strictEqual(booking(on)['Gate Notify Acked At'], undefined, `state ${state}: not acknowledged by a guest`);
    assert.ok(!on.axiom.some(e => e.event === 'gate_ack_confirmed'), `state ${state}`);
    assert.deepStrictEqual(on.sends.map(s => s.body), off.sends.map(s => s.body), `state ${state}: same reply as flag off`);
    assert.strictEqual(on.ctx, undefined);
  }
});

test('a guest\'s "yes please", "yes" with trailing words and an interactive tap titled "Yes, check out" are not a YES either', async () => {
  for (const text of ['yes please', 'yes!', 'yes, check out', 'yess']) {
    const ctx = start(ON);
    Object.assign(booking(ctx), { 'Gate Notify Sent At': mins(3), 'WS_Property': ['recP1'] });
    await say(RECEPTION, text);   // even from staff: only the exact word counts
    assert.strictEqual(booking(ctx)['Gate Notify Acked At'], undefined, text);
  }
});

test('a staff number that is ALSO a guest in a step that accepts "yes" gets the guest flow, not the ack', async () => {
  const row = { inputs: ['yes'], action: 'showConfirmedMenu' };
  STATES.states.CONFIRMED.unshift(row);
  try {
    const ctx = start(ON);
    Object.assign(booking(ctx), { 'Gate Notify Sent At': mins(3), 'WS_Property': ['recP1'] });
    ctx.airtable.tables['WS_Guests'].push({ id: 'recGR', fields: { 'Guest Name': 'Reception Person', 'Phone Number': RECEPTION, 'Session State': 'CONFIRMED' } });
    await say(RECEPTION, 'yes');
    assert.strictEqual(booking(ctx)['Gate Notify Acked At'], undefined, 'the guest step owns the word');
  } finally {
    STATES.states.CONFIRMED.shift();
  }
});

// ── the escalation sweep ─────────────────────────────────────────────────────

const calls = ctx => ctx.airtable.log.length;

test('sweep, flag off: nothing is read or written', async () => {
  const ctx = start({}, { extraBookings: [waitingBooking('recBook2', 'recG2', 60)] });
  const before = ctx.airtable.log.length;
  assert.deepStrictEqual(await wh.runGateAckEscalation(new Date()), { gateAckEscalated: 0 });
  assert.strictEqual(ctx.airtable.log.length, before);
});

test('GRACE PERIOD: the property\'s Escalation Timeout Minutes wins; GATE_ACK_GRACE_MS only when the field is blank or invalid; then the 15-minute default', async () => {
  const wait = async (property, env, minutesAgo) => {
    const ctx = start({ ...ON, ...env }, { property, extraBookings: [waitingBooking('recBook2', 'recG2', minutesAgo)] });
    return { ctx, result: await wh.runGateAckEscalation(new Date()) };
  };
  // field = 5 minutes beats an env grace of an hour
  assert.strictEqual((await wait({ 'Escalation Timeout Minutes': 5 }, { GATE_ACK_GRACE_MS: String(3600e3) }, 6)).result.gateAckEscalated, 1);
  assert.strictEqual((await wait({ 'Escalation Timeout Minutes': 5 }, { GATE_ACK_GRACE_MS: String(60e3) }, 4)).result.gateAckEscalated, 0, 'field 5 min: 4 min is too early even though the env says 1 minute');
  // blank / invalid field falls back to the env
  assert.strictEqual((await wait({}, { GATE_ACK_GRACE_MS: String(120e3) }, 3)).result.gateAckEscalated, 1);
  assert.strictEqual((await wait({ 'Escalation Timeout Minutes': 0 }, { GATE_ACK_GRACE_MS: String(120e3) }, 3)).result.gateAckEscalated, 1);
  assert.strictEqual((await wait({ 'Escalation Timeout Minutes': 'soon' }, { GATE_ACK_GRACE_MS: String(120e3) }, 1)).result.gateAckEscalated, 0);
  // neither: the global default, 15 minutes
  assert.strictEqual((await wait({}, {}, 14)).result.gateAckEscalated, 0);
  assert.strictEqual((await wait({}, {}, 16)).result.gateAckEscalated, 1);
  assert.strictEqual((await wait({}, { GATE_ACK_GRACE_MS: 'abc' }, 16)).result.gateAckEscalated, 1, 'an invalid env value is ignored');
});

test('an overdue alert is escalated ONCE, to the first On Duty seat, by the ask template when configured; a repeat run sends nothing', async () => {
  const ctx = start({ ...ON, WABISTAY_GATE_ESCALATION_TEMPLATE: ESC_TEMPLATE }, { extraBookings: [waitingBooking('recBook2', 'recG2', 20)] });
  const r1 = await wh.runGateAckEscalation(new Date());
  assert.strictEqual(r1.gateAckEscalated, 1);
  const t = templatesTo(ctx, ONDUTY);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].template, ESC_TEMPLATE);
  assert.deepStrictEqual(t[0].params.slice(0, 2), ['Canary Street Guest Rooms', 'Sam Smith']);
  assert.strictEqual(t[0].params.length, 5);
  assert.ok(booking(ctx, 'recBook2')['Gate Escalated At']);
  const r2 = await wh.runGateAckEscalation(new Date());
  assert.strictEqual(r2.gateAckEscalated, 0);
  assert.strictEqual(templatesTo(ctx, ONDUTY).length, 1);
});

test('without an escalation template the escalation is a free-form message', async () => {
  const ctx = start(ON, { extraBookings: [waitingBooking('recBook2', 'recG2', 20)] });
  await wh.runGateAckEscalation(new Date());
  assert.match(textsTo(ctx, ONDUTY)[0], /GATE ALERT: Sam Smith \(27829990002\) has been at the gate at Canary Street Guest Rooms for 20 minutes/);
});

test('an acknowledged alert is not escalated; a YES that arrives while the sweep is deciding wins (the booking is re-read)', async () => {
  const acked = start(ON, { extraBookings: [waitingBooking('recBook2', 'recG2', 20, { 'Gate Notify Acked At': mins(10) })] });
  assert.strictEqual((await wh.runGateAckEscalation(new Date())).gateAckEscalated, 0);
  const race = start(ON, { extraBookings: [waitingBooking('recBook2', 'recG2', 20)] });
  const real = global.fetch;
  global.fetch = async (u, o = {}) => {
    const res = await real(u, o);
    // the first single-booking re-read is the sweep checking before it sends: the YES lands just before it
    if (/RECORD_ID\(\)/.test(decodeURIComponent(String(u))) && String(u).includes('WS_Bookings') && !race.fired) {
      race.fired = true;
      race.airtable.tables['WS_Bookings'].find(b => b.id === 'recBook2').fields['Gate Notify Acked At'] = new Date().toISOString();
      return real(u, o);
    }
    return res;
  };
  assert.strictEqual((await wh.runGateAckEscalation(new Date())).gateAckEscalated, 0);
  assert.strictEqual(templatesTo(race, ONDUTY).length + textsTo(race, ONDUTY).length, 0);
});

test('a failed escalation send is not stamped, so the next run tries again', async () => {
  const ctx = start({ ...ON, WABISTAY_GATE_ESCALATION_TEMPLATE: ESC_TEMPLATE }, { extraBookings: [waitingBooking('recBook2', 'recG2', 20)] });
  const real = global.fetch;
  let fail = true;
  global.fetch = async (u, o = {}) => {
    if (fail && String(u).includes('graph.facebook.com') && JSON.parse(o.body).to === ONDUTY) return { status: 400, json: async () => ({ error: { code: 132001, message: 'template missing' } }) };
    return real(u, o);
  };
  assert.strictEqual((await wh.runGateAckEscalation(new Date())).gateAckEscalated, 0);
  assert.strictEqual(booking(ctx, 'recBook2')['Gate Escalated At'], undefined);
  fail = false;
  assert.strictEqual((await wh.runGateAckEscalation(new Date())).gateAckEscalated, 1);
});

test('the chain is On Duty, then Backup, then Manager, then the owner (Notify Phone): with no seats at all the owner is told', async () => {
  const ctx = start(ON, { roles: [], extraBookings: [waitingBooking('recBook2', 'recG2', 20)] });
  assert.strictEqual((await wh.runGateAckEscalation(new Date())).gateAckEscalated, 1);
  assert.match(textsTo(ctx, NOTIFY)[0], /GATE ALERT: Sam Smith/);
  const backup = start(ON, {
    roles: [{ id: 'recBk', fields: { 'Role Label': 'Backup', 'Role Type': 'Backup', 'Property': ['recP1'], 'Current Phone': '27826660002', 'Active': true } }],
    extraBookings: [waitingBooking('recBook2', 'recG2', 20)]
  });
  await wh.runGateAckEscalation(new Date());
  assert.match(textsTo(backup, '27826660002')[0], /GATE ALERT/);
});

// ── Airtable calls per cron run ──────────────────────────────────────────────

test('AIRTABLE CALLS PER RUN: flag off adds none; flag on adds exactly one read when nothing is waiting; an escalation adds its own few', async () => {
  const off = start({}, { extraBookings: [] });
  const a0 = calls(off);
  await wh.runGateAckEscalation(new Date());
  assert.strictEqual(calls(off) - a0, 0);

  const counts = async (flags, extra) => {
    const ctx = start(flags, { extraBookings: extra });
    let reads = 0;
    const real = global.fetch;
    global.fetch = async (u, o) => { if (String(u).includes('api.airtable.com') && (!o || !o.method || o.method === 'GET')) reads++; return real(u, o); };
    const w0 = calls(ctx);
    await wh.runGateAckEscalation(new Date());
    return { reads, writes: calls(ctx) - w0 };
  };
  assert.deepStrictEqual(await counts(ON, []), { reads: 1, writes: 0 }, 'nothing waiting: one read of the open bookings');
  assert.deepStrictEqual(await counts(ON, [waitingBooking('recBook2', 'recG2', 2)]), { reads: 2, writes: 0 }, 'waiting but inside the grace period: plus the property');
  const esc = await counts(ON, [waitingBooking('recBook2', 'recG2', 20)]);
  assert.strictEqual(esc.writes, 1, 'one stamp');
  assert.ok(esc.reads <= 6, 'open bookings, property, booking re-read, guest, escalation chain: ' + esc.reads);
});

test('the auto-checkout cron runs the sweep and reports the count', async () => {
  const ctx = start(ON, { extraBookings: [waitingBooking('recBook2', 'recG2', 20)] });
  const res = { status() { return this; }, json(b) { this.body = b; return this; }, send() { return this; } };
  await wh.autoCheckoutHandler({ method: 'GET' }, res);
  assert.strictEqual(res.body && res.body.gateAckEscalated, 1);
  void ctx;
});
