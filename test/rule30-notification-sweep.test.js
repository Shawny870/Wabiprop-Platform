// test/rule30-notification-sweep.test.js
// Rule 30 step 2, slice 2 — the remaining notification/logging/cosmetic sites
// left over from F44's inventory (slice 1 covered WS_Bookings/WS_Rooms.Status/
// payment-field writes only).
//
// Re-diagnosed on its own terms, not assumed to inherit slice 1's split:
//   NON-FATAL (the large majority) — genuinely inert writes/sends: a courtesy
//   owner notification the guest's own reply doesn't depend on, a cleaner
//   dispatch text that isn't gating anything else in the same handler, a
//   WS_Enquiries reporting row nothing reads back, a cron warning-stamp that
//   self-heals on its own next tick. Checked, logged loud, flow proceeds.
//
//   FATAL — the guest opt-out writes (STOP/START). These don't fit slice 1's
//   WS_Bookings/Rooms/payment scope, but 'Opted Out' genuinely gates every
//   subsequent inbound message from that number — a silent write failure
//   would tell the guest one thing while the record says another. Scope
//   correction, not a slice-2 default: the rule was never "table X gets
//   treatment Y," it's "does failure leave the system asserting something
//   false to the guest."
//
// Also: ~23 structurally-identical WS_Guests Session State writes across
// nearly every handler are now routed through one shared checked wrapper,
// updateGuestState(), instead of 23 near-duplicate patches. NON-FATAL as a
// class — each is paired with a reply describing the NEW state, but the next
// inbound message re-fetches WS_Guests fresh at dispatch, so a failure
// self-corrects within one round-trip. Covered by regression only here (every
// existing test in the suite that drives a state transition already proves
// the success path); a dedicated failure test is added for one representative
// site to prove the wrapper itself works.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';

function baseSeed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: {
        'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000',
        'Notify Phone': '27732273477', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
      }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'] } }
    ],
    WS_Rates: [
      { id: 'recRateCouple', fields: { 'Rate Name': 'Couple', 'Occupancy Type': 'Couple', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Guests: [],
    WS_Bookings: [],
    WS_Cleaners: [],
    WS_Enquiries: [],
    ...overrides
  };
}

function start(overrides) {
  const ctx = { airtable: new MockAirtable(baseSeed(overrides)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const guestRow = (ctx, phone) => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === phone);
const bookingRow = (ctx, id) => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id).fields;
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '').join('\n---\n');
const axiomEvents = ctx => ctx.axiom.map(e => e.event);

function failNextWrite(ctx, { method, pathIncludes, bodyIncludes } = {}) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const methodMatches = (opts.method || 'GET').toUpperCase() === method;
    const pathMatches = !pathIncludes || u.pathname.includes(pathIncludes);
    const bodyMatches = !bodyIncludes || String(opts.body || '').includes(bodyIncludes);
    if (methodMatches && pathMatches && bodyMatches) {
      global.fetch = originalFetch;
      return { status: 422, ok: false, json: async () => ({ error: { type: 'INVALID_REQUEST', message: 'simulated' } }), text: async () => 'simulated' };
    }
    return originalFetch(url, opts);
  };
}

// One-shot: makes ONE matching WhatsApp send return an error body instead of
// delegating to the mock, then restores.
function failNextWhatsApp(ctx, { toIncludes, bodyIncludes } = {}) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname === 'graph.facebook.com') {
      const body = JSON.parse(opts.body);
      const toMatches = !toIncludes || String(body.to || '').includes(toIncludes);
      const bodyMatches = !bodyIncludes || String(body.text && body.text.body || '').includes(bodyIncludes);
      if (toMatches && bodyMatches) {
        global.fetch = originalFetch;
        return { status: 400, ok: false, json: async () => ({ error: { type: 'SIMULATED', message: 'simulated' } }), text: async () => 'simulated' };
      }
    }
    return originalFetch(url, opts);
  };
}

// ── FATAL: guest opt-out writes ─────────────────────────────────────────────

test('STOP: a failed opt-out write tells the guest plainly, not a false confirmation', async () => {
  const ctx = start();
  failNextWrite(ctx, { method: 'POST', pathIncludes: 'WS_Guests' });

  await send(GUEST_PHONE, 'stop');

  assert.strictEqual(guestRow(ctx, GUEST_PHONE), undefined, 'the create genuinely failed, no row landed');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong/i);
  assert.doesNotMatch(texts(ctx, GUEST_PHONE), /opted out of messages/i, 'never falsely confirmed');
  assert.ok(axiomEvents(ctx).includes('guest_opt_out_write_failed'));
});

test('STOP: a successful opt-out is unaffected by the new check', async () => {
  const ctx = start();

  await send(GUEST_PHONE, 'stop');

  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Opted Out'], true);
  assert.match(texts(ctx, GUEST_PHONE), /opted out of messages/i);
});

test('START: a failed opt-back-in write tells the guest plainly, not a false confirmation', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'NEW', 'Opted Out': true } }]
  });
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Guests/recG1', bodyIncludes: 'Opted Out' });

  await send(GUEST_PHONE, 'start');

  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Opted Out'], true, 'still opted out — the write genuinely failed');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong/i);
  assert.doesNotMatch(texts(ctx, GUEST_PHONE), /Welcome back/i, 'never falsely confirmed');
  assert.ok(axiomEvents(ctx).includes('guest_opt_in_write_failed'));
});

// ── NON-FATAL: runAutoCheckout warning stamp (deferred from F44/slice 1) ───

const NOW = new Date('2026-07-22T12:00:00.000Z');
const minsBefore = m => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

test('runAutoCheckout: a failed warning-stamp write is logged loud but the warning still sends', async () => {
  const ctx = {
    airtable: new MockAirtable({
      WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Test Lodge' } }],
      WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE } }],
      WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Occupied', 'Property': ['recP1'] } }],
      WS_Bookings: [{
        id: 'recBook1',
        fields: { 'Guest': ['recG1'], 'Status': 'Checked In', 'Booking Type': 'Overnight', 'Room': ['recR1'], 'Check Out': minsBefore(1) }
      }],
      WS_Cleaners: [], WS_Rates: [], WS_Enquiries: []
    }),
    sends: [], axiom: []
  };
  installFetch(ctx);
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recBook1', bodyIncludes: 'Checkout Warning Sent At' });

  const summary = await wh.runAutoCheckout(NOW);

  assert.deepStrictEqual(summary, { warnings: 1, autoCheckouts: 0 });
  assert.strictEqual(bookingRow(ctx, 'recBook1')['Checkout Warning Sent At'], undefined, 'the write genuinely failed');
  assert.ok(axiomEvents(ctx).includes('checkout_warning_stamp_write_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /Reply \*EXTEND\*/, 'the warning still sends regardless');
});

// ── NON-FATAL: logEnquiry (WS_Enquiries) ────────────────────────────────────

test('collectDetails: a failed WS_Enquiries log write is logged loud but the booking flow proceeds', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  failNextWrite(ctx, { method: 'POST', pathIncludes: 'WS_Enquiries' });

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  assert.strictEqual(ctx.airtable.tables['WS_Enquiries'].length, 0, 'the enquiry row genuinely failed to write');
  assert.ok(axiomEvents(ctx).includes('enquiry_log_write_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /occupancy|How many of you/i, 'the booking flow proceeds regardless');
});

// ── NON-FATAL: cleaner dispatch via free-form sendWhatsApp ──────────────────

function seedCheckedIn(overrides = {}) {
  return baseSeed({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN' } }],
    WS_Bookings: [{
      id: 'recBook1',
      fields: { 'Guest': ['recG1'], 'Status': 'Checked In', 'Room': ['recR1'], 'Amount Due': 400, 'Checked In At': '2020-01-01T00:00:00.000Z' }
    }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Occupied', 'Property': ['recP1'] } }],
    WS_Cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '27821110000', 'Active': true, 'Assigned Property': ['recP1'] } }],
    ...overrides
  });
}

test('checkout: a failed cleaner-dispatch send is logged loud but checkout still completes for the guest', async () => {
  const ctx = start(seedCheckedIn());
  failNextWhatsApp(ctx, { toIncludes: '27821110000' });

  await send(GUEST_PHONE, 'checkout');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Checked Out', 'checkout is unaffected by the missed cleaner text');
  assert.ok(axiomEvents(ctx).includes('cleaner_dispatch_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /Thank you for staying/i);
});

// ── NON-FATAL: owner courtesy notifications ─────────────────────────────────

test('collectDetails: a failed owner new-booking notify is logged loud but the guest flow proceeds', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  failNextWhatsApp(ctx, { toIncludes: '27830000001' });

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  assert.ok(axiomEvents(ctx).includes('owner_new_booking_notify_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /How many of you/i, 'the guest still gets the occupancy question');
});

test('extendStay: a failed owner extension notify is logged loud but the guest is still confirmed', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN' } }],
    WS_Bookings: [{
      id: 'recBook1',
      fields: {
        'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Checked In',
        'Booking Type': 'Overnight', 'Amount Due': 400, 'Rate Applied': ['recRateCouple'],
        'Check In': '2026-08-05T12:00:00.000Z', 'Check Out': '2026-08-06T08:00:00.000Z',
        'Checked In At': '2026-08-05T12:05:00.000Z'
      }
    }]
  });
  failNextWhatsApp(ctx, { toIncludes: '27830000001' });

  await send(GUEST_PHONE, 'extend');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Amount Due'], 800, 'the extension itself still lands');
  assert.ok(axiomEvents(ctx).includes('owner_extension_notify_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /extended your stay/i);
});

// ── NON-FATAL: first-contact WS_Guests creates (found during final sweep
// verification, not in the original diagnosis — same class as
// updateGuestState, but a create rather than an update) ───────────────────

test('greetAndAskDetails: a failed first-contact guest create is logged loud but the greeting still sends', async () => {
  const ctx = start();
  failNextWrite(ctx, { method: 'POST', pathIncludes: 'WS_Guests' });

  await send(GUEST_PHONE, 'hi');

  assert.strictEqual(guestRow(ctx, GUEST_PHONE), undefined, 'the create genuinely failed');
  assert.ok(axiomEvents(ctx).includes('guest_state_write_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /Welcome to/i, 'the greeting still sends regardless');
});

// ── NON-FATAL: shared updateGuestState wrapper (representative site) ───────

test('cancelBooking: a failed Session State write is logged loud, self-corrects on the next message', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{
      id: 'recBook1',
      fields: { 'Guest': ['recG1'], 'Status': 'Confirmed', 'Room': ['recR1'], 'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z' }
    }]
  });
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Guests/recG1', bodyIncludes: 'Session State' });

  await send(GUEST_PHONE, '2');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Cancelled', 'the actual cancellation still lands');
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'CONFIRMED', 'the state write genuinely failed');
  assert.ok(axiomEvents(ctx).includes('guest_state_write_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /has been cancelled/i, 'the guest is still told, proceeds regardless');
});
