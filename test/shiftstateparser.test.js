// test/shiftstateparser.test.js
// Shift-routing/escalation PR 3 prep — schema-independent half only.
// parseShiftStateCommand() is pure text-in/structured-out, same shape as
// parseWalkinCommand/parsePaidCommand/parseStartCleaningCommand. NOT wired
// to any router branch or Airtable write — that's PR 3 proper, held
// pending live schema re-verification of Escalation Timeout Minutes and
// the WS_Roles 'On Duty'/'Backup' values (see investigation doc / memory).

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const { parseShiftStateCommand } = wh;

test('"off" and "off shift" both parse to state off, no end time', () => {
  assert.deepStrictEqual(parseShiftStateCommand('off'), { ok: true, state: 'off', endTime: null });
  assert.deepStrictEqual(parseShiftStateCommand('off shift'), { ok: true, state: 'off', endTime: null });
  assert.deepStrictEqual(parseShiftStateCommand('OFF SHIFT'), { ok: true, state: 'off', endTime: null });
});

test('"on break" parses to state on-break, no end time', () => {
  assert.deepStrictEqual(parseShiftStateCommand('on break'), { ok: true, state: 'on-break', endTime: null });
  assert.deepStrictEqual(parseShiftStateCommand('ON BREAK'), { ok: true, state: 'on-break', endTime: null });
});

test('bare "on shift" (no stated end time) parses, endTime null', () => {
  assert.deepStrictEqual(parseShiftStateCommand('on shift'), { ok: true, state: 'on-shift', endTime: null });
});

test('"on shift until 22:00" — 24-hour clock, unambiguous, parses with endTime', () => {
  assert.deepStrictEqual(
    parseShiftStateCommand('on shift until 22:00'),
    { ok: true, state: 'on-shift', endTime: { hour: 22, minute: 0 } }
  );
});

test('"on shift until 10pm" — 12-hour clock with meridiem, unambiguous, parses with endTime', () => {
  assert.deepStrictEqual(
    parseShiftStateCommand('on shift until 10pm'),
    { ok: true, state: 'on-shift', endTime: { hour: 22, minute: 0 } }
  );
});

test('"on shift until 6" — ambiguous hour (no am/pm, 1-11), refused rather than guessed', () => {
  const result = parseShiftStateCommand('on shift until 6');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'ambiguous_end_time');
  assert.strictEqual(result.ambiguousHour, 6);
});

test('"on shift until whenever" — unparseable end time is bad_end_time, not silently dropped', () => {
  assert.deepStrictEqual(parseShiftStateCommand('on shift until whenever'), { ok: false, reason: 'bad_end_time' });
});

test('"scheduled" is not part of this grammar — falls through as null, not a bad_syntax refusal', () => {
  assert.strictEqual(parseShiftStateCommand('scheduled'), null);
});

test('an unrelated message falls through as null, same convention as the other command parsers', () => {
  assert.strictEqual(parseShiftStateCommand('hello'), null);
  assert.strictEqual(parseShiftStateCommand('PAID ROOM 2 400'), null);
  assert.strictEqual(parseShiftStateCommand(''), null);
  assert.strictEqual(parseShiftStateCommand(undefined), null);
});

test('extra whitespace is tolerated, same normalization as the other command parsers', () => {
  assert.deepStrictEqual(parseShiftStateCommand('  on   shift   until   22:00  '), { ok: true, state: 'on-shift', endTime: { hour: 22, minute: 0 } });
});
