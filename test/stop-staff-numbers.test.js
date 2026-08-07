// test/stop-staff-numbers.test.js
// Fix-order item 5a — STOP lockout on staff numbers.
//
// Diagnosed shape (not assumed from the symptom): the STOP handler ran before
// any staff-identity resolution and wrote 'Opted Out': true to WS_Guests for
// ANY number, staff or guest — including creating a brand-new WS_Guests row
// for a cleaner/reception/owner number never seen before. Traced every
// operational send site (cleaner dispatch, owner notify, reception notify)
// and confirmed none of them consult WS_Guests.Opted Out — they resolve their
// target purely via WS_Cleaners/WS_Roles/OWNER_PHONE — and confirmed a staff
// number's own WALKIN/PAID/cleaner-reply commands are also unaffected, since
// those guards resolve purely from WS_Roles/WS_Cleaners too. So this was
// data-hygiene pollution (a stray Opted-Out guest row for a staff seat), not
// an operational lockout — fixed anyway, since a staff number never meant to
// invoke a guest-facing opt-out concept by typing a word that happens to
// collide with their own identity check.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');

const CLEANER_PHONE = '27825999001';
const RECEPTION_PHONE = '27825999279';
const GUEST_PHONE = '27821234567';

function seed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000' }
    }],
    WS_Rooms: [],
    WS_Rates: [],
    WS_Roles: [{
      id: 'recRole1',
      fields: { 'Role Label': 'Villa Liza Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION_PHONE, 'Active': true }
    }],
    WS_Guests: [],
    WS_Bookings: [],
    WS_Cleaners: [{
      id: 'recC1',
      fields: { 'Cleaner Name': 'Eric', 'Phone Number': CLEANER_PHONE, 'Active': true, 'Assigned Property': ['recP1'] }
    }],
    WS_Enquiries: [],
    ...overrides
  };
}

function start(overrides) {
  const ctx = { airtable: new MockAirtable(seed(overrides)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(from, text) {
  const res = makeRes();
  await handler({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const guestRow = (ctx, phone) => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === phone);
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '').join('\n---\n');
const axiomEvents = ctx => ctx.axiom.map(e => e.event);

test('a cleaner texting STOP does not create an Opted-Out WS_Guests row', async () => {
  const ctx = start();

  await send(CLEANER_PHONE, 'stop');

  assert.strictEqual(guestRow(ctx, CLEANER_PHONE), undefined, 'no WS_Guests row was created for the cleaner\'s number');
  assert.ok(axiomEvents(ctx).includes('stop_ignored_staff_number'));
  assert.strictEqual(axiomEvents(ctx).includes('guest_opted_out'), false);
});

test('a reception seat texting STOP is not opted out either', async () => {
  const ctx = start();

  await send(RECEPTION_PHONE, 'stop');

  assert.strictEqual(guestRow(ctx, RECEPTION_PHONE), undefined);
  assert.ok(axiomEvents(ctx).includes('stop_ignored_staff_number'));
});

test('an existing WS_Guests row for a staff number is not retroactively opted out by STOP', async () => {
  // The B11.5-style collision: the same number is both a registered cleaner
  // and has a guest history (e.g. once stayed as a guest before joining
  // staff, or is the shared test handset). STOP from that number must not
  // silence their guest record either.
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Eric', 'Phone Number': CLEANER_PHONE, 'Session State': 'NEW' } }]
  });

  await send(CLEANER_PHONE, 'stop');

  assert.strictEqual(guestRow(ctx, CLEANER_PHONE).fields['Opted Out'], undefined, 'unchanged, not flipped to true');
  assert.ok(axiomEvents(ctx).includes('stop_ignored_staff_number'));
});

test('the cleaner still receives operational messages after texting STOP — no lockout', async () => {
  const ctx = start({
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Cleaning', 'Property': ['recP1'] } }]
  });
  await send(CLEANER_PHONE, 'stop');

  await send(CLEANER_PHONE, 'done'); // ordinary cleaner DONE command, straight after STOP

  assert.match(texts(ctx, CLEANER_PHONE), /clean|available/i, 'the cleaner\'s own command still works normally, no residual opt-out effect');
});

test('an ordinary guest texting STOP is completely unaffected by the staff check', async () => {
  const ctx = start();

  await send(GUEST_PHONE, 'stop');

  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Opted Out'], true);
  assert.ok(axiomEvents(ctx).includes('guest_opted_out'));
  assert.strictEqual(axiomEvents(ctx).includes('stop_ignored_staff_number'), false);
  assert.match(texts(ctx, GUEST_PHONE), /opt|stop/i);
});
