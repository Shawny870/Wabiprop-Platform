// test/escalationtimeout.test.js
// Shift-routing/escalation PR 1 of 11 — escalationTimeoutMs(): a pure,
// Airtable-free config resolver. No routing/resolver logic yet (that's PR 2
// onward); this only makes the timeout value configurable per property with
// a global default fallback, same shape as WS_Properties.'Daily Summary
// Hour'. See the header comment above escalationTimeoutMs in webhook.js for
// why gateAckGraceMs() is NOT the precedent this follows — it does not exist
// on main.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function property(overrides) {
  return { id: 'recProp1', fields: { 'Property Name': 'Test Lodge', ...overrides } };
}

test('no per-property field set: falls back to the hardcoded 15-minute default', () => {
  delete process.env.ESCALATION_TIMEOUT_DEFAULT_MINUTES;
  const ms = wh.escalationTimeoutMs(property());
  assert.strictEqual(ms, 15 * 60 * 1000);
});

test('per-property "Escalation Timeout Minutes" set: uses that value, not the default', () => {
  delete process.env.ESCALATION_TIMEOUT_DEFAULT_MINUTES;
  const ms = wh.escalationTimeoutMs(property({ 'Escalation Timeout Minutes': 8 }));
  assert.strictEqual(ms, 8 * 60 * 1000);
});

test('ESCALATION_TIMEOUT_DEFAULT_MINUTES env var overrides the hardcoded default when no per-property value is set', () => {
  process.env.ESCALATION_TIMEOUT_DEFAULT_MINUTES = '25';
  const ms = wh.escalationTimeoutMs(property());
  assert.strictEqual(ms, 25 * 60 * 1000);
  delete process.env.ESCALATION_TIMEOUT_DEFAULT_MINUTES;
});

test('per-property value of 0 is invalid (not a real timeout) and falls back to the global default', () => {
  delete process.env.ESCALATION_TIMEOUT_DEFAULT_MINUTES;
  const ms = wh.escalationTimeoutMs(property({ 'Escalation Timeout Minutes': 0 }));
  assert.strictEqual(ms, 15 * 60 * 1000);
});

test('per-property value negative or non-numeric falls back to the global default, never produces a negative/NaN timeout', () => {
  delete process.env.ESCALATION_TIMEOUT_DEFAULT_MINUTES;
  assert.strictEqual(wh.escalationTimeoutMs(property({ 'Escalation Timeout Minutes': -5 })), 15 * 60 * 1000);
  assert.strictEqual(wh.escalationTimeoutMs(property({ 'Escalation Timeout Minutes': 'not a number' })), 15 * 60 * 1000);
});

test('a property with no fields object at all does not throw', () => {
  const ms = wh.escalationTimeoutMs({ id: 'recBare' });
  assert.strictEqual(ms, 15 * 60 * 1000);
});

test('ESCALATION_TIMEOUT_DEFAULT_MINUTES exported constant matches the hardcoded default', () => {
  assert.strictEqual(wh.ESCALATION_TIMEOUT_DEFAULT_MINUTES, 15);
});
