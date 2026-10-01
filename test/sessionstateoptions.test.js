// test/sessionstateoptions.test.js
// Offline half of the Session State audit (the live half is
// scripts/audit-session-states.js). The app's Airtable token cannot create
// select options, so a Session State the code writes that is not a live option
// fails silently in production — the 30 Sep AWAITING_PAYMENT_METHOD outage.
// This fails the build when states.json or the handlers reference a state that
// scripts/session-state-options.json (the live list) does not contain.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { requiredStates } = require('../scripts/audit-session-states.js');

const live = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'session-state-options.json'), 'utf8')).options;

test('every Session State the code can write is a live Airtable option', () => {
  const missing = requiredStates().filter(s => !live.includes(s));
  assert.deepStrictEqual(
    missing, [],
    `Session State(s) used by the code but not in scripts/session-state-options.json: ${missing.join(', ')}. ` +
      'Have the option created in Airtable FIRST, then add it to that list.'
  );
});

test('the required-state computation actually sees the states that caused the 30 Sep outage', () => {
  const required = requiredStates();
  for (const state of ['NEW', 'AWAITING_PAYMENT_METHOD', 'AWAITING_RATING_FEEDBACK', 'HUMAN_HANDLING', 'CHECKED_IN']) {
    assert.ok(required.includes(state), `${state} should be detected as required`);
  }
});

test('a state added to the code but not to the live list is caught', () => {
  const required = [...requiredStates(), 'AWAITING_NEW_THING'];
  assert.deepStrictEqual(required.filter(s => !live.includes(s)), ['AWAITING_NEW_THING']);
});
