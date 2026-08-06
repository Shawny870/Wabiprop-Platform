// test/cleaningtime.test.js
// Cleaning time per cleaner — START ROOM <n>, DONE, and the two derived metrics.
//
//   · Vacant-To-Ready = completion − WS_Rooms.Cleaning Started At (checkout).
//     The primary turnaround number, and the reason the pre-existing field does
//     not go dead now that per-job fields exist.
//   · Job Duration    = completion − WS_Bookings.Cleaning Job Started At.
//     Secondary; only exists when the cleaner actually sent START.
//
// Both are emitted on ONE event at completion. The timestamps live on the
// BOOKING, not the room: a room holds one slot and the next checkout overwrites
// it, so per-cleaner averages over many jobs need a per-job home.
//
// What these tests cannot assert, and the code says so too: DONE is
// self-reported. Nothing verifies the room was cleaned, and dispatch is a
// broadcast, so the numbers measure reply speed as much as cleaning speed.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const handler = wh;
const { parseStartCleaningCommand } = wh;

const CLEANER_PHONE = '27825999279';   // the live cleaner number
const OUTSIDER_PHONE = '27820000999';
const GUEST_PHONE = '27821234567';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// ── Grammar ─────────────────────────────────────────────────────────────────

test('START ROOM <n> parses in the shapes a cleaner types', () => {
  for (const form of ['START ROOM 2', 'start room 2', 'Start Room 2', 'start room2', '  START   ROOM  2  ', 'start room 02']) {
    const r = parseStartCleaningCommand(form);
    assert.ok(r && r.ok, `form: ${form}`);
    assert.strictEqual(r.roomToken, form.includes('02') ? '02' : '2', `form: ${form}`);
  }
});

test('a BARE start is not a cleaning command — B14 opt-back-in is untouched', () => {
  // The collision that would have broken a shipped feature: `START` on its own
  // is B14's opt-back-in keyword. Claiming it here would silence guests who
  // tried to opt back in.
  assert.strictEqual(parseStartCleaningCommand('start'), null);
  assert.strictEqual(parseStartCleaningCommand('START'), null);
  assert.strictEqual(parseStartCleaningCommand('  Start '), null);
});

test('START with a broken body is a malformed command, not a fall-through', () => {
  assert.deepStrictEqual(parseStartCleaningCommand('start room'), { ok: false, reason: 'bad_syntax' });
  assert.deepStrictEqual(parseStartCleaningCommand('start the room please'), { ok: false, reason: 'bad_syntax' });
});

test('ordinary traffic is not a START attempt', () => {
  for (const t of ['hi', '2', 'done', 'room 2', 'restart', '']) {
    assert.strictEqual(parseStartCleaningCommand(t), null, `text: ${JSON.stringify(t)}`);
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = () => Date.now();
const agoIso = ms => new Date(Date.now() - ms).toISOString();

function seed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27732273477' }
    }],
    WS_Rooms: [
      // Dirtied 90 minutes ago by the checkout below.
      { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Room Number': 2, 'Status': 'Cleaning', 'Property': ['recP1'], 'Cleaning Started At': agoIso(90 * MIN) } },
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'] } }
    ],
    WS_Cleaners: [
      { id: 'recC1', fields: { 'Cleaner Name': 'Rose', 'Phone Number': CLEANER_PHONE, 'Active': true, 'Assigned Property': ['recP1'] } }
    ],
    WS_Bookings: [{
      id: 'recB1',
      fields: {
        'Booking Ref': 'WS-AAA001', 'Room': ['recR2'], 'Status': 'Checked Out',
        'Booking Type': 'Overnight', 'WS_Property': ['recP1'],
        'Check In': agoIso(26 * HOUR), 'Check Out': agoIso(90 * MIN)
      }
    }],
    WS_Guests: [],
    WS_Roles: [],
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

const bookingRow = (ctx, id = 'recB1') => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id).fields;
const roomRow = (ctx, id = 'recR2') => ctx.airtable.tables['WS_Rooms'].find(r => r.id === id).fields;
const event = (ctx, name) => ctx.axiom.find(e => e.event === name);

// ── START ──────────────────────────────────────────────────────────────────

test('START ROOM stamps the job clock on the booking, not the room', async () => {
  const ctx = start();
  const baselineBefore = roomRow(ctx)['Cleaning Started At'];

  await send(CLEANER_PHONE, 'START ROOM 2');

  const startedAt = bookingRow(ctx)['Cleaning Job Started At'];
  assert.ok(startedAt, 'stamped on the booking — survives the next checkout');
  assert.ok(Math.abs(Date.parse(startedAt) - NOW()) < 5000, 'stamped now');
  // The room's checkout baseline is the OTHER metric and must not be disturbed:
  // overwriting it here would silently redefine Vacant-To-Ready as Job Duration.
  assert.strictEqual(roomRow(ctx)['Cleaning Started At'], baselineBefore, 'checkout baseline untouched');
  assert.notStrictEqual(startedAt, baselineBefore, 'and the two clocks are genuinely different');
  assert.strictEqual(roomRow(ctx)['Status'], 'Cleaning', 'START does not change room status');
  assert.ok(event(ctx, 'cleaning_job_started'));
});

test('a second START does not reset the clock', async () => {
  // Resetting would silently understate how long the work took — the one way
  // this metric could flatter itself.
  const ctx = start();
  await send(CLEANER_PHONE, 'START ROOM 2');
  const first = bookingRow(ctx)['Cleaning Job Started At'];

  await send(CLEANER_PHONE, 'START ROOM 2');

  assert.strictEqual(bookingRow(ctx)['Cleaning Job Started At'], first, 'first start wins');
  assert.ok(event(ctx, 'cleaning_start_already_recorded'));
});

test('START on a room that is not in Cleaning is refused, with no write', async () => {
  const ctx = start();
  await send(CLEANER_PHONE, 'START ROOM 1'); // Available, not Cleaning

  assert.strictEqual(bookingRow(ctx)['Cleaning Job Started At'], undefined);
  assert.match(ctx.sends.map(s => s.body).join('\n'), /isn't marked for cleaning/);
});

test('START from a number that is not a registered cleaner falls through silently', async () => {
  const ctx = start();
  await send(OUTSIDER_PHONE, 'START ROOM 2');

  assert.strictEqual(bookingRow(ctx)['Cleaning Job Started At'], undefined);
  assert.doesNotMatch(ctx.sends.map(s => s.body).join('\n'), /started/i);
});

test('START ROOM does NOT mark the room clean — the naming-room global must not preempt it', async () => {
  // `start room 2` contains a bare 2, which senderIsCleanerNamingRoom matches
  // anywhere in the message. Reached first it would resolve Room 02 to Available
  // at the exact moment the cleaner is saying they have only just begun.
  const ctx = start();
  await send(CLEANER_PHONE, 'START ROOM 2');

  assert.strictEqual(roomRow(ctx)['Status'], 'Cleaning', 'still being cleaned');
  assert.strictEqual(bookingRow(ctx)['Cleaning Completed At'], undefined, 'not completed');
});

// ── DONE: the record ───────────────────────────────────────────────────────

test('DONE writes completion and attribution onto the booking, and frees the room', async () => {
  const ctx = start();
  await send(CLEANER_PHONE, 'DONE');

  const b = bookingRow(ctx);
  assert.ok(b['Cleaning Completed At'], 'completion stamped');
  // Text, not a linked record id: `Cleaned By` was created as singleLineText,
  // not a link to WS_Cleaners (confirmed live 6 Aug) — writing the record-id
  // array shape would be rejected or coerced into garbage.
  assert.strictEqual(b['Cleaned By'], 'Rose', 'attributed by name, to whoever declared DONE');
  assert.strictEqual(roomRow(ctx)['Status'], 'Available');
});

// ── DONE: the two metrics ──────────────────────────────────────────────────

test('both metrics are emitted on one event, with Job Duration only when START was sent', async () => {
  const ctx = start();
  await send(CLEANER_PHONE, 'START ROOM 2');
  await send(CLEANER_PHONE, 'DONE');

  const e = event(ctx, 'cleaning_job_completed');
  assert.ok(e, 'one completion event');
  // Vacant-To-Ready runs from the CHECKOUT baseline (90 min ago), not from START.
  assert.ok(e.vacantToReadyMinutes >= 89 && e.vacantToReadyMinutes <= 92, `V2R was ${e.vacantToReadyMinutes}`);
  // Job Duration runs from START, which was moments ago.
  assert.ok(e.jobDurationMinutes !== null && e.jobDurationMinutes < 1, `job was ${e.jobDurationMinutes}`);
  assert.ok(e.vacantToReadyMs > e.jobDurationMs, 'the two measure different spans');
  assert.strictEqual(e.selfReported, true, 'the honesty flag rides on every record');
  assert.strictEqual(e.cleanerId, 'recC1');
});

test('a cleaner who never sends START still gets Vacant-To-Ready, and no Job Duration', async () => {
  // The primary metric must not depend on the secondary one being collected —
  // START is opt-in behaviour by a human with a mop.
  const ctx = start();
  await send(CLEANER_PHONE, 'DONE');

  const e = event(ctx, 'cleaning_job_completed');
  assert.ok(e.vacantToReadyMinutes >= 89 && e.vacantToReadyMinutes <= 92);
  assert.strictEqual(e.jobDurationMs, null, 'no start, no job duration');
  assert.strictEqual(e.vacantToReadyOmitted, false);
});

test('a MISSING baseline emits no Vacant-To-Ready — the completion is still recorded', async () => {
  // Locked: missing/stale baseline → log the completion, emit no number. A wrong
  // turnaround figure is worse than an absent one.
  const s = seed();
  delete s.WS_Rooms[0].fields['Cleaning Started At'];
  const ctx = start({ WS_Rooms: s.WS_Rooms });
  await send(CLEANER_PHONE, 'DONE');

  const e = event(ctx, 'cleaning_job_completed');
  assert.strictEqual(e.vacantToReadyMs, null);
  assert.strictEqual(e.vacantToReadyOmitted, true);
  assert.ok(bookingRow(ctx)['Cleaning Completed At'], 'the job itself is still recorded');
  assert.strictEqual(roomRow(ctx)['Status'], 'Available', 'and the room is still freed');
});

test('a baseline in the future relative to completion emits no number either', async () => {
  // A stale value from an earlier cycle, or a clock problem — either way it
  // cannot describe this job, so it produces nothing rather than a negative.
  const s = seed();
  s.WS_Rooms[0].fields['Cleaning Started At'] = new Date(Date.now() + HOUR).toISOString();
  const ctx = start({ WS_Rooms: s.WS_Rooms });
  await send(CLEANER_PHONE, 'DONE');

  const e = event(ctx, 'cleaning_job_completed');
  assert.strictEqual(e.vacantToReadyMs, null);
  assert.strictEqual(e.vacantToReadyOmitted, true);
});

test('a days-old baseline is emitted but flagged suspect, so first averages can be filtered', async () => {
  // Room 05 has sat in Cleaning since 31 July on live data. The CEO is clearing
  // those by hand before go-live; this flag is what stops the ones that slip
  // through from quietly skewing the first numbers.
  const s = seed();
  s.WS_Rooms[0].fields['Cleaning Started At'] = agoIso(6 * 24 * HOUR);
  const ctx = start({ WS_Rooms: s.WS_Rooms });
  await send(CLEANER_PHONE, 'DONE');

  const e = event(ctx, 'cleaning_job_completed');
  assert.ok(e.vacantToReadyMs > 5 * 24 * HOUR, 'the number is still reported');
  assert.strictEqual(e.baselineSuspect, true, 'and marked as not a real turnaround');
});

test('a normal turnaround is NOT flagged suspect', async () => {
  const ctx = start();
  await send(CLEANER_PHONE, 'DONE');
  assert.strictEqual(event(ctx, 'cleaning_job_completed').baselineSuspect, false);
});

test('a room with no closed booking still completes, and says so', async () => {
  const ctx = start({ WS_Bookings: [] });
  await send(CLEANER_PHONE, 'DONE');

  assert.strictEqual(roomRow(ctx)['Status'], 'Available', 'the room is still freed');
  assert.ok(event(ctx, 'cleaning_complete_no_booking'), 'the gap is visible');
  assert.ok(event(ctx, 'cleaning_job_completed'), 'still measured where possible');
});

// ── The metrics survive the next checkout ──────────────────────────────────

test('per-job timestamps live on the booking, so a later checkout cannot erase them', async () => {
  // The whole reason these fields are not on WS_Rooms: the room has one slot.
  const ctx = start();
  await send(CLEANER_PHONE, 'START ROOM 2');
  await send(CLEANER_PHONE, 'DONE');
  const completed = bookingRow(ctx)['Cleaning Completed At'];
  const started = bookingRow(ctx)['Cleaning Job Started At'];

  // The room is dirtied again by a subsequent checkout — this is the write that
  // would have destroyed the previous job's numbers had they lived on the room.
  ctx.airtable.update('WS_Rooms', 'recR2', { 'Status': 'Cleaning', 'Cleaning Started At': new Date().toISOString() });

  assert.strictEqual(bookingRow(ctx)['Cleaning Completed At'], completed, 'previous job intact');
  assert.strictEqual(bookingRow(ctx)['Cleaning Job Started At'], started);
});

// ── B14 regression ─────────────────────────────────────────────────────────

test('a bare START still opts an opted-out guest back in', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John', 'Phone Number': GUEST_PHONE, 'Session State': 'NEW', 'Opted Out': true } }]
  });
  await send(GUEST_PHONE, 'START');

  assert.strictEqual(ctx.airtable.tables['WS_Guests'][0].fields['Opted Out'], false, 'B14 still works');
  assert.match(ctx.sends.map(s => s.body).join('\n'), /Welcome back/);
});
