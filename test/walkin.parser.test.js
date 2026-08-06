// test/walkin.parser.test.js
// B7 (WALKIN) — command grammar, unit level.
//
// `parseWalkinCommand` is pure: message in, shape out, no Airtable. That is
// deliberate — the grammar is the part with the live-data hazards in it, and it
// can be pinned exhaustively here before a single field name is written. The
// handler that consumes it (authorisation via WS_Roles, room resolution, the
// booking write) is schema-dependent and lands separately.
//
// Room identifiers are checked against the LIVE base, not invented: Villa Liza
// has 12 rooms, `Room 01`…`Room 12`, with `Room Number` 1–12 (integers, while
// the names are zero-padded). Rooms 1–12 existing is what makes the two-bare-
// numbers case genuinely ambiguous, and it is why the grammar is strict.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv } = require('./harness');

installEnv();
const { parseWalkinCommand } = require('../api/wabistay/webhook.js');

// ── The ambiguity this parser exists to kill ────────────────────────────────
//
// `roomMatchesText` (the cleaner room-naming helper) tests `\b<number>\b`
// ANYWHERE in the message. Run it over `walkin room 12 2hrs` and Room 02 matches
// on the DURATION digit — staff say twelve, the system books two. These cases
// are the mutation target: they are the reason the ROOM keyword and the hour
// unit are both mandatory.

test('room 12 for 2 hours: the room is 12 and the duration is 2 — never the reverse', () => {
  assert.deepStrictEqual(parseWalkinCommand('WALKIN ROOM 12 2HRS'), { ok: true, roomToken: '12', hours: 2 });
});

test('room 2 for 2 hours: identical digits do not confuse the positions', () => {
  assert.deepStrictEqual(parseWalkinCommand('WALKIN ROOM 2 2HRS'), { ok: true, roomToken: '2', hours: 2 });
});

test('room 1 for 2 hours and room 2 for 1 hour are not the same command', () => {
  assert.deepStrictEqual(parseWalkinCommand('WALKIN ROOM 1 2HRS'), { ok: true, roomToken: '1', hours: 2 });
  assert.deepStrictEqual(parseWalkinCommand('WALKIN ROOM 2 1HR'), { ok: true, roomToken: '2', hours: 1 });
});

test('two bare numbers are refused, not guessed — the ROOM keyword is the only disambiguator', () => {
  // Both readings are valid against the live base (rooms 1-12), so there is no
  // safe default: booking the wrong room puts a stranger in an occupied room.
  assert.deepStrictEqual(parseWalkinCommand('WALKIN 12 2'), { ok: false, reason: 'bad_syntax' });
  assert.deepStrictEqual(parseWalkinCommand('WALKIN 2 12'), { ok: false, reason: 'bad_syntax' });
});

test('a bare duration with no unit is refused for the same reason', () => {
  assert.deepStrictEqual(parseWalkinCommand('WALKIN ROOM 12 2'), { ok: false, reason: 'bad_syntax' });
});

// ── Accepted spellings ──────────────────────────────────────────────────────

test('the command keyword tolerates the spellings staff actually type', () => {
  for (const kw of ['WALKIN', 'walkin', 'Walk-in', 'walk in', 'WALK-IN']) {
    assert.deepStrictEqual(
      parseWalkinCommand(`${kw} room 7 3hrs`),
      { ok: true, roomToken: '7', hours: 3 },
      `keyword: ${kw}`
    );
  }
});

test('hour units: h / hr / hrs / hour / hours, spaced or not', () => {
  for (const unit of ['h', 'hr', 'hrs', 'hour', 'hours']) {
    assert.deepStrictEqual(
      parseWalkinCommand(`walkin room 3 2${unit}`),
      { ok: true, roomToken: '3', hours: 2 },
      `unit: ${unit}`
    );
    assert.deepStrictEqual(
      parseWalkinCommand(`walkin room 3 2 ${unit}`),
      { ok: true, roomToken: '3', hours: 2 },
      `spaced unit: ${unit}`
    );
  }
});

test('zero-padded room token survives verbatim — every live Room Name is padded', () => {
  // `Room 01` is the live name; `Room Number` is 1. The parser hands the raw
  // token to the resolver rather than coercing it, so both matching routes stay
  // open. Coercing to Number here would also destroy `Room A`.
  assert.deepStrictEqual(parseWalkinCommand('walkin room 01 1hr'), { ok: true, roomToken: '01', hours: 1 });
  assert.deepStrictEqual(parseWalkinCommand('walkin room a 1hr'), { ok: true, roomToken: 'a', hours: 1 });
});

test('missing space after ROOM, extra spaces, and a trailing full stop all parse', () => {
  assert.deepStrictEqual(parseWalkinCommand('walkin room2 2hrs'), { ok: true, roomToken: '2', hours: 2 });
  assert.deepStrictEqual(parseWalkinCommand('  WALKIN   ROOM   9    3 HRS  '), { ok: true, roomToken: '9', hours: 3 });
  assert.deepStrictEqual(parseWalkinCommand('walkin room 9 3hrs.'), { ok: true, roomToken: '9', hours: 3 });
});

// ── Duration is locked to the rate card ─────────────────────────────────────

test('1, 2 and 3 hours are the only durations, and all three are accepted', () => {
  for (const h of [1, 2, 3]) {
    assert.deepStrictEqual(parseWalkinCommand(`walkin room 5 ${h}hrs`), { ok: true, roomToken: '5', hours: h });
  }
});

test('4+ hours is refused with the requested value, not silently repriced', () => {
  // The overnight rate is occupancy-keyed (F19) and a walk-in has no guest to
  // ask, so there is no price for a 4-hour stay. Refusing beats inventing one:
  // the F19 bug was exactly a price chosen by something other than a decision.
  assert.deepStrictEqual(parseWalkinCommand('walkin room 5 4hrs'), { ok: false, reason: 'bad_duration', hours: 4 });
  assert.deepStrictEqual(parseWalkinCommand('walkin room 5 12hrs'), { ok: false, reason: 'bad_duration', hours: 12 });
});

test('zero hours is refused as a duration, not accepted as an empty booking', () => {
  assert.deepStrictEqual(parseWalkinCommand('walkin room 5 0hrs'), { ok: false, reason: 'bad_duration', hours: 0 });
});

test('a fractional duration is refused', () => {
  assert.deepStrictEqual(parseWalkinCommand('walkin room 5 2.5hrs'), { ok: false, reason: 'bad_syntax' });
});

// ── null vs { ok: false } — the no-leak boundary ────────────────────────────
//
// null means "this is not a WALKIN attempt": the guard declines, the message
// falls through to the ordinary guest flow, and an outsider sees the same
// greeting any stranger sees. { ok: false } means "malformed WALKIN", and only
// an authorised sender ever reaches the handler that answers it. Collapsing the
// two would make the system's reply to a stranger depend on whether they typed
// a real command — which is the leak the CEO ruled out.

test('ordinary guest traffic is not a WALKIN attempt (null, not a refusal)', () => {
  for (const text of [
    'hi', 'hourly', '2', 'room 2', 'ROOM 12 2HRS', 'Caillin Mendes 31July 2026 1 August 2026',
    'done', 'stop', 'i would like to walk to the shops', ''
  ]) {
    assert.strictEqual(parseWalkinCommand(text), null, `should not be a WALKIN attempt: ${JSON.stringify(text)}`);
  }
});

test('the keyword must LEAD the message — it is not matched mid-sentence', () => {
  // Otherwise a guest sentence containing "walk in" becomes a malformed command,
  // and the reply to that guest changes. It must not.
  assert.strictEqual(parseWalkinCommand('can i walk in today?'), null);
  assert.strictEqual(parseWalkinCommand('is walkin room 2 2hrs a thing?'), null);
});

test('a leading keyword with a broken body IS a WALKIN attempt (usage help, not a greeting)', () => {
  for (const text of ['WALKIN', 'walkin room', 'walkin room 2', 'walkin 2hrs', 'walkin room 2 hrs 2']) {
    const r = parseWalkinCommand(text);
    assert.ok(r && r.ok === false, `should be a malformed WALKIN attempt: ${JSON.stringify(text)}`);
    assert.strictEqual(r.reason, 'bad_syntax');
  }
});

test('a room token the base has never heard of still PARSES — the resolver refuses it, not the grammar', () => {
  // `Room A` exists in the fixtures, so alphabetic tokens must be allowed, and a
  // word token is then indistinguishable in shape from a real room name. The
  // parser deliberately does not own the room inventory: it hands `two` on, and
  // the resolver answers "no room called two" against the live rooms. Rejecting
  // it here would mean encoding room names in a regex, which goes stale the day
  // a room is renamed.
  assert.deepStrictEqual(parseWalkinCommand('walkin room two 2hrs'), { ok: true, roomToken: 'two', hours: 2 });
});

test('trailing junk is refused rather than partially honoured', () => {
  assert.deepStrictEqual(parseWalkinCommand('walkin room 2 2hrs and put him in 3'), { ok: false, reason: 'bad_syntax' });
});

// ── Input hygiene ───────────────────────────────────────────────────────────

test('non-string and empty input never throws', () => {
  for (const v of [null, undefined, 0, {}, []]) {
    assert.strictEqual(parseWalkinCommand(v), null, `input: ${JSON.stringify(v)}`);
  }
});
