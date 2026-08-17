// test/cronauth.test.js
// Auth-only PR: adds a CRON_SECRET gate (Authorization: Bearer, fail-closed)
// to the 7 cron handlers that had none, mirroring the existing check in
// api/wabistay/cron/daily-summary.js (see test/dailysummary.test.js for that
// route's own coverage — not duplicated here). One 401-on-bad-auth test per
// handler; does not re-test each handler's business logic.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();

function fakeReq(authHeader) {
  return { method: 'GET', headers: authHeader ? { authorization: authHeader } : {} };
}

function fakeRes() {
  const res = { _status: null, _json: null };
  res.status = code => { res._status = code; return res; };
  res.json = body => { res._json = body; return res; };
  return res;
}

function setup(seed = {}) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

const ROUTES = [
  '../api/wabistay/cron/auto-checkout.js',
  '../api/wabistay/cron/owner-summary.js',
  '../api/wabiprop/cron/agent-morning-summary.js',
  '../api/wabiprop/cron/call-reminder.js',
  '../api/wabiprop/cron/lease-reminders.js',
  '../api/wabiprop/cron/owner-weekly.js',
  '../api/wabiprop/cron/rent-reminders.js',
];

for (const routePath of ROUTES) {
  test(`${routePath}: refuses with no CRON_SECRET configured in env`, async () => {
    delete process.env.CRON_SECRET;
    setup();
    delete require.cache[require.resolve(routePath)];
    const route = require(routePath);
    const res = fakeRes();
    await route(fakeReq('Bearer whatever'), res);
    assert.strictEqual(res._status, 401);
  });

  test(`${routePath}: refuses a wrong token`, async () => {
    process.env.CRON_SECRET = 'test-secret';
    setup();
    delete require.cache[require.resolve(routePath)];
    const route = require(routePath);
    const res = fakeRes();
    await route(fakeReq('Bearer wrong'), res);
    assert.strictEqual(res._status, 401);
  });

  test(`${routePath}: refuses a missing Authorization header`, async () => {
    process.env.CRON_SECRET = 'test-secret';
    setup();
    delete require.cache[require.resolve(routePath)];
    const route = require(routePath);
    const res = fakeRes();
    await route(fakeReq(null), res);
    assert.strictEqual(res._status, 401);
  });
}
