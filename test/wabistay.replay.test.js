// test/wabistay.replay.test.js
// Replays every fixture in fixtures/ against the wabistay webhook.
// Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { installEnv, runFixture, assertFixture, makeRes, TEST_ENV } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');

const fixturesDir = path.join(__dirname, '..', 'fixtures');
for (const file of fs.readdirSync(fixturesDir).filter(f => f.endsWith('.json')).sort()) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8'));
  test(`${file} — ${fixture.name}`, async () => {
    const { ctx, res } = await runFixture(handler, fixture);
    assertFixture(assert, fixture.expect, ctx, res);
  });
}

// ── Transport-level behaviour (F1/F2 + Meta verification handshake) ─────────

test('GET verification: correct token echoes challenge', async () => {
  const res = makeRes();
  await handler({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': TEST_ENV.WA_VERIFY_TOKEN, 'hub.challenge': 'CH123' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body, 'CH123');
});

test('GET verification: wrong token is 403', async () => {
  const res = makeRes();
  await handler({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'CH123' } }, res);
  assert.strictEqual(res.statusCode, 403);
});

test('F1: undefined body still returns 200', async () => {
  const res = makeRes();
  await handler({ method: 'POST', body: undefined }, res);
  assert.strictEqual(res.statusCode, 200);
});

test('F1: unparseable string body still returns 200', async () => {
  const res = makeRes();
  await handler({ method: 'POST', body: 'not json {{' }, res);
  assert.strictEqual(res.statusCode, 200);
});

test('unsupported method is 405', async () => {
  const res = makeRes();
  await handler({ method: 'DELETE' }, res);
  assert.strictEqual(res.statusCode, 405);
});
