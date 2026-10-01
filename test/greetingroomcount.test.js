// test/greetingroomcount.test.js
// Guest-facing room count in the first-contact greeting must respect Active
// (CEO decision, 2026-09-28) — a disabled room must never be counted, and the
// count must never say "0 rooms available". See webhook.js:getGuestVisibleAvailableRooms.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

// 'Show Room Count To Guests' ticked: these tests are about WHAT the count says. Whether it shows at all
// is covered by the opt-in tests at the bottom.
const property = { id: 'recP1', fields: { 'Property Name': 'Canary Street', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222', 'Show Room Count To Guests': true } };
const FROM = '27821234567';

function start(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const lastText = ctx => (ctx.sends[ctx.sends.length - 1] || {}).body || '';
const guestRow = ctx => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === FROM);

test('greeting room count: mix of active and inactive rooms counts only the active ones', async () => {
  const rooms = [
    { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
    { id: 'recR2', fields: { 'Room Name': 'Room 2', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
    { id: 'recR3', fields: { 'Room Name': 'Room 3', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
    { id: 'recR4', fields: { 'Room Name': 'Room 4', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
    { id: 'recR5', fields: { 'Room Name': 'Room 5', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
    { id: 'recR6', fields: { 'Room Name': 'Room 6', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
    { id: 'recR7', fields: { 'Room Name': 'Room 7', 'Status': 'Available', 'Property': ['recP1'], 'Active': false } },
    { id: 'recR8', fields: { 'Room Name': 'Room 8', 'Status': 'Available', 'Property': ['recP1'], 'Active': false } },
    { id: 'recR9', fields: { 'Room Name': 'Room 9', 'Status': 'Available', 'Property': ['recP1'], 'Active': false } },
    { id: 'recR10', fields: { 'Room Name': 'Room 10', 'Status': 'Available', 'Property': ['recP1'], 'Active': false } },
    { id: 'recR11', fields: { 'Room Name': 'Room 11', 'Status': 'Available', 'Property': ['recP1'], 'Active': false } },
    { id: 'recR12', fields: { 'Room Name': 'Room 12', 'Status': 'Available', 'Property': ['recP1'], 'Active': false } }
  ];
  const ctx = start({
    WS_Properties: [property], WS_Rooms: rooms, WS_Rates: [], WS_Guests: [], WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'hi');
  assert.ok(lastText(ctx).includes('6 rooms'), `expected the 6 active rooms only, got: ${lastText(ctx)}`);
  assert.ok(!lastText(ctx).includes('12 room'), 'the 6 inactive rooms must not inflate the count');
});

test('greeting room count: all rooms inactive — zero-rooms path, no stay-type menu, guest state not advanced', async () => {
  const rooms = [
    { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'], 'Active': false } },
    { id: 'recR2', fields: { 'Room Name': 'Room 2', 'Status': 'Available', 'Property': ['recP1'], 'Active': false } }
  ];
  const ctx = start({
    WS_Properties: [property], WS_Rooms: rooms, WS_Rates: [], WS_Guests: [], WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'hi');
  assert.ok(!lastText(ctx).toLowerCase().includes('0 room'), 'must never say "0 rooms available"');
  assert.ok(!lastText(ctx).includes('short stay'), 'must not offer the stay-type menu when nothing is available');
  assert.ok(!lastText(ctx).includes('multiple days'), 'must not offer the stay-type menu when nothing is available');
  assert.strictEqual(ctx.airtable.tables['WS_Guests'].length, 0, 'no guest record created — state left untouched');
  assert.strictEqual(lastText(ctx), 'Please speak to reception on 27831112222 to check what is available.');
});

test('greeting room count: all rooms occupied (none Available) — same zero-rooms path', async () => {
  const rooms = [
    { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Occupied', 'Property': ['recP1'], 'Active': true } },
    { id: 'recR2', fields: { 'Room Name': 'Room 2', 'Status': 'Cleaning', 'Property': ['recP1'], 'Active': true } }
  ];
  const ctx = start({
    WS_Properties: [property], WS_Rooms: rooms, WS_Rates: [], WS_Guests: [], WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'hi');
  assert.ok(!lastText(ctx).toLowerCase().includes('0 room'), 'must never say "0 rooms available"');
  assert.ok(!lastText(ctx).includes('short stay'), 'must not offer the stay-type menu when nothing is available');
  assert.strictEqual(ctx.airtable.tables['WS_Guests'].length, 0, 'no guest record created — state left untouched');
});

test('greeting room count: zero-rooms path leaves an EXISTING guest\'s state untouched', async () => {
  const rooms = [
    { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'], 'Active': false } }
  ];
  const ctx = start({
    WS_Properties: [property], WS_Rooms: rooms, WS_Rates: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'NEW' } }],
    WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'hi');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'NEW', 'Session State must not be written to AWAITING_STAY_TYPE when there is nothing to offer');
  const stateWrite = ctx.airtable.log.find(w => w.table === 'WS_Guests' && w.id === 'recG1');
  assert.strictEqual(stateWrite, undefined, 'no write at all to the guest record on the zero-rooms path');
});

test('greeting room count: exactly one active available room reads "1 room", not "1 rooms"', async () => {
  const rooms = [
    { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
    { id: 'recR2', fields: { 'Room Name': 'Room 2', 'Status': 'Available', 'Property': ['recP1'], 'Active': false } }
  ];
  const ctx = start({
    WS_Properties: [property], WS_Rooms: rooms, WS_Rates: [], WS_Guests: [], WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'hi');
  assert.ok(lastText(ctx).includes('1 room*'), `expected singular "1 room", got: ${lastText(ctx)}`);
  assert.ok(!lastText(ctx).includes('1 rooms'), 'singular wording must not read "1 rooms"');
});

test('greeting room count: a disabled room at another property never counts against this one', async () => {
  const otherProperty = { id: 'recP2', fields: { 'Property Name': 'Other Lodge', 'Phone Number ID': '222000222000', 'Notify Phone': '27831119999' } };
  const rooms = [
    { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
    { id: 'recR2', fields: { 'Room Name': 'Other Room', 'Status': 'Available', 'Property': ['recP2'], 'Active': true } }
  ];
  const ctx = start({
    WS_Properties: [property, otherProperty], WS_Rooms: rooms, WS_Rates: [], WS_Guests: [], WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'hi');
  assert.ok(lastText(ctx).includes('1 room*'), `expected only this property's 1 active room, got: ${lastText(ctx)}`);
});

// ── Room count is opt-in (Doc 1b PR 3) ───────────────────────────────────────

const twoRooms = [
  { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
  { id: 'recR2', fields: { 'Room Name': 'Room 2', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }
];
const unticked = { id: 'recP1', fields: { 'Property Name': 'Canary Street', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } };

test('room count hidden when Show Room Count To Guests is unticked (field absent): only that sentence is removed', async () => {
  const ctx = start({ WS_Properties: [unticked], WS_Rooms: twoRooms, WS_Rates: [], WS_Guests: [], WS_Bookings: [], WS_Cleaners: [] });
  await send(FROM, 'hi');
  assert.strictEqual(
    lastText(ctx),
    'Hi! 👋 Welcome to Canary Street.\n\nAre you looking for a *short stay* (a few hours) or *multiple days*? Reply with a number:\n1 - Short stay\n2 - Multiple days'
  );
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_STAY_TYPE', 'the rest of the flow is unchanged');
});

test('room count shown, with the same greeting otherwise, when the box is ticked', async () => {
  const ctx = start({ WS_Properties: [property], WS_Rooms: twoRooms, WS_Rates: [], WS_Guests: [], WS_Bookings: [], WS_Cleaners: [] });
  await send(FROM, 'hi');
  assert.strictEqual(
    lastText(ctx),
    'Hi! 👋 Welcome to Canary Street.\n\nWe currently have *2 rooms* available.\n\nAre you looking for a *short stay* (a few hours) or *multiple days*? Reply with a number:\n1 - Short stay\n2 - Multiple days'
  );
});

test('an explicitly false box also hides the count', async () => {
  const falsy = { id: 'recP1', fields: { ...unticked.fields, 'Show Room Count To Guests': false } };
  const ctx = start({ WS_Properties: [falsy], WS_Rooms: twoRooms, WS_Rates: [], WS_Guests: [], WS_Bookings: [], WS_Cleaners: [] });
  await send(FROM, 'hi');
  assert.ok(!/rooms? available/.test(lastText(ctx)));
});

// ── "speak to reception", never "fully booked" ───────────────────────────────

test('no room: Guest Redirect Phone is used when set, ahead of Notify Phone', async () => {
  const withRedirect = { id: 'recP1', fields: { ...unticked.fields, 'Guest Redirect Phone': '078 038 4989' } };
  const ctx = start({ WS_Properties: [withRedirect], WS_Rooms: [], WS_Rates: [], WS_Guests: [], WS_Bookings: [], WS_Cleaners: [] });
  await send(FROM, 'hi');
  assert.strictEqual(lastText(ctx), 'Please speak to reception on 078 038 4989 to check what is available.');
});

test('no room and no phone configured at all: the same sentence without a number, and the gap is logged', async () => {
  const bare = { id: 'recP1', fields: { 'Property Name': 'Canary Street', 'Phone Number ID': '111000111000' } };
  const ctx = start({ WS_Properties: [bare], WS_Rooms: [], WS_Rates: [], WS_Guests: [], WS_Bookings: [], WS_Cleaners: [] });
  await send(FROM, 'hi');
  assert.strictEqual(lastText(ctx), 'Please speak to reception to check what is available.');
  assert.ok(ctx.axiom.some(e => e.event === 'no_room_message_missing_redirect_phone'));
});

test('the availability check failing closed gets the same message — never "fully booked"', async () => {
  const guest = { id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } };
  const rooms = [{ id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }];
  const ctx = start({ WS_Properties: [property], WS_Rooms: rooms, WS_Rates: [], WS_Guests: [guest], WS_Bookings: [], WS_Cleaners: [] });
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('api.airtable.com') && String(url).includes('WS_Bookings') && (init.method || 'GET').toUpperCase() === 'GET') {
      return { status: 500, ok: false, json: async () => ({ error: { type: 'SERVER_ERROR', message: 'boom' } }), text: async () => '' };
    }
    return inner(url, init);
  };
  await send(FROM, 'John Smith\n1 Dec 2099\n3 Dec 2099');
  assert.strictEqual(lastText(ctx), 'Please speak to reception on 27831112222 to check what is available.');
  assert.ok(!/fully booked|\bfull\b/i.test(lastText(ctx)));
});

test('no guest-facing message in states.json says the lodge is "fully booked"', () => {
  const messages = require('../states.json').messages;
  const offenders = Object.entries(messages).filter(([, text]) => /fully booked|we're full|\bis full\b|\bare full\b/i.test(text)).map(([key]) => key);
  assert.deepStrictEqual(offenders, []);
});
