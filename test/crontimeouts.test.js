// test/crontimeouts.test.js
// Doc 1b PR 5: cron timeouts. auto-checkout (every 5 min) and monthly-report were
// being cut at the 10s function limit (504). Changes under test:
//   - a time budget: the auto-checkout sweeps stop starting new work when they
//     run out of time and leave the rest for the next tick;
//   - the enquiry-abandonment sweep no longer reads the whole (ever-growing)
//     WS_Enquiries table on ticks where no guest is stale;
//   - cron_started / cron_duration events (a start with no duration = a killed run);
//   - vercel.json: longer maxDuration on the two routes (inside every plan's cap)
//     and schedules moved off minute :00, where the hourly jobs collide.
// In-memory only: MockAirtable + mocked fetch.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const NOW = new Date('2026-07-22T12:00:00.000Z');
const minsBefore = m => new Date(NOW.getTime() - m * 60 * 1000).toISOString();
const hoursBefore = h => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

const property = { id: 'recP1', fields: { 'Property Name': 'Test Lodge' } };
const room = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Occupied', 'Property': ['recP1'] } };
const guest = { id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': '27821234567' } };
const overdue = (id, extra = {}) => ({
  id, fields: { Guest: ['recG1'], Status: 'Checked In', 'Booking Type': 'Overnight', Room: ['recR1'], 'Check Out': minsBefore(1), ...extra }
});

function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [], gets: [] };
  installFetch(ctx);
  // Record every Airtable GET so a test can see which tables a run read.
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('api.airtable.com') && (init.method || 'GET').toUpperCase() === 'GET') {
      ctx.gets.push(decodeURIComponent(new URL(url).pathname.split('/')[3]));
    }
    return inner(url, init);
  };
  return ctx;
}

function jsonRes() {
  const res = { statusCode: null, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.send = body => { res.body = body; return res; };
  return res;
}

const events = (ctx, name) => ctx.axiom.filter(e => e.event === name);

// ── auto-checkout time budget ────────────────────────────────────────────────

test('out of time: an overdue booking is left untouched for the next tick, and the run says it was truncated', async () => {
  const ctx = setup({ WS_Bookings: [overdue('recB1')], WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property], WS_Cleaners: [] });
  const summary = await wh.runAutoCheckout(NOW, { deadline: Date.now() - 1 });

  assert.strictEqual(summary.truncated, true);
  assert.strictEqual(summary.warnings, 0);
  assert.strictEqual(ctx.airtable.log.length, 0, 'no stamp or write');
  assert.strictEqual(ctx.sends.length, 0, 'no warning sent');
  assert.strictEqual(events(ctx, 'cron_time_budget_hit').length, 1);
  assert.ok(!ctx.gets.includes('WS_Guests'), 'it stopped before the per-booking lookups');
});

test('time to spare (or no deadline): behaves exactly as before and is not marked truncated', async () => {
  for (const opts of [undefined, { deadline: Date.now() + 60000 }]) {
    const ctx = setup({ WS_Bookings: [overdue('recB1')], WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property], WS_Cleaners: [] });
    const summary = await wh.runAutoCheckout(NOW, opts);
    assert.deepStrictEqual(summary, { warnings: 1, autoCheckouts: 0 });
    assert.strictEqual(ctx.sends.length, 1);
    assert.match(ctx.sends[0].body, /Test Lodge/, 'property name still resolved through guest + room lookups');
  }
});

test('the next tick picks up what the truncated one left', async () => {
  const ctx = setup({ WS_Bookings: [overdue('recB1')], WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property], WS_Cleaners: [] });
  await wh.runAutoCheckout(NOW, { deadline: Date.now() - 1 });
  const second = await wh.runAutoCheckout(NOW, { deadline: Date.now() + 60000 });
  assert.deepStrictEqual(second, { warnings: 1, autoCheckouts: 0 });
});

// ── enquiry-abandonment sweep ────────────────────────────────────────────────

test('no stale guest: WS_Enquiries is not read at all', async () => {
  const fresh = { id: 'recG2', fields: { 'Guest Name': 'Unknown', 'Phone Number': '27820000001', 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': hoursBefore(1) } };
  const ctx = setup({ WS_Guests: [fresh], WS_Enquiries: [], WS_Bookings: [], WS_Rooms: [], WS_Properties: [] });
  const summary = await wh.runEnquiryAbandonment(NOW);
  assert.deepStrictEqual(summary, { abandoned: 0 });
  assert.ok(!ctx.gets.includes('WS_Enquiries'));
});

test('a stale guest is still reset to NEW (and WS_Enquiries is read)', async () => {
  const stale = { id: 'recG2', fields: { 'Guest Name': 'Unknown', 'Phone Number': '27820000001', 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': hoursBefore(30) } };
  const ctx = setup({ WS_Guests: [stale], WS_Enquiries: [], WS_Bookings: [], WS_Rooms: [], WS_Properties: [] });
  const summary = await wh.runEnquiryAbandonment(NOW);
  assert.deepStrictEqual(summary, { abandoned: 1 });
  assert.strictEqual(ctx.airtable.tables['WS_Guests'][0].fields['Session State'], 'NEW');
  assert.ok(ctx.gets.includes('WS_Enquiries'));
});

test('abandonment sweep out of time: stale guests are left for the next tick', async () => {
  const stale = { id: 'recG2', fields: { 'Guest Name': 'Unknown', 'Phone Number': '27820000001', 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': hoursBefore(30) } };
  const ctx = setup({ WS_Guests: [stale], WS_Enquiries: [], WS_Bookings: [], WS_Rooms: [], WS_Properties: [] });
  const summary = await wh.runEnquiryAbandonment(NOW, { deadline: Date.now() - 1 });
  assert.strictEqual(summary.truncated, true);
  assert.strictEqual(summary.abandoned, 0);
  assert.strictEqual(ctx.airtable.tables['WS_Guests'][0].fields['Session State'], 'AWAITING_DETAILS');
});

// ── handlers: start and duration events ──────────────────────────────────────

test('autoCheckoutHandler logs cron_started then cron_duration, with the Airtable call count', async () => {
  const ctx = setup({ WS_Bookings: [], WS_Guests: [], WS_Enquiries: [], WS_Rooms: [], WS_Properties: [], WS_Cleaners: [] });
  const res = jsonRes();
  await wh.autoCheckoutHandler({}, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(events(ctx, 'cron_started')[0].cron, 'auto_checkout');
  const done = events(ctx, 'cron_duration')[0];
  assert.strictEqual(done.cron, 'auto_checkout');
  assert.strictEqual(typeof done.ms, 'number');
  assert.strictEqual(done.truncated, false);
  assert.ok(events(ctx, 'airtable_call_count').some(e => e.cronName === 'auto_checkout'));
});

test('CRON_TIME_BUDGET_MS: default 8000, honoured when valid, junk or non-positive ignored', () => {
  try {
    delete process.env.CRON_TIME_BUDGET_MS;
    assert.strictEqual(wh.cronTimeBudgetMs(), 8000);
    process.env.CRON_TIME_BUDGET_MS = '20000';
    assert.strictEqual(wh.cronTimeBudgetMs(), 20000);
    for (const junk of ['banana', '0', '-5', '']) {
      process.env.CRON_TIME_BUDGET_MS = junk;
      assert.strictEqual(wh.cronTimeBudgetMs(), 8000, 'junk value ' + JSON.stringify(junk));
    }
  } finally {
    delete process.env.CRON_TIME_BUDGET_MS;
  }
});

// ── vercel.json ──────────────────────────────────────────────────────────────

const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

test('vercel.json: the two slow routes get a longer maxDuration, inside the 60s cap every plan allows; everything else stays at 10s', () => {
  const fn = vercel.functions;
  assert.ok(fn['api/wabistay/cron/auto-checkout.js'].maxDuration > 10 && fn['api/wabistay/cron/auto-checkout.js'].maxDuration <= 60);
  assert.ok(fn['api/wabistay/cron/monthly-report.js'].maxDuration > 10 && fn['api/wabistay/cron/monthly-report.js'].maxDuration <= 60);
  for (const [pattern, cfg] of Object.entries(fn)) {
    if (pattern.endsWith('auto-checkout.js') || pattern.endsWith('monthly-report.js')) continue;
    assert.strictEqual(cfg.maxDuration, 10, pattern);
  }
});

// Vercel refuses to deploy when one function file matches TWO patterns in the
// "functions" block (found the hard way on this PR: a specific entry next to the
// api/**/*.js catch-all failed the deployment even at an identical duration).
// So the patterns must partition api/: every function file matched exactly once.
test('vercel.json: every api/ function file is matched by exactly one functions pattern (Vercel rejects overlaps)', { skip: typeof path.matchesGlob !== 'function' }, () => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : (e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  const root = path.join(__dirname, '..');
  const files = walk(path.join(root, 'api')).map(f => path.relative(root, f).split(path.sep).join('/'));
  assert.ok(files.length > 10, 'found the api files');
  for (const file of files) {
    const matches = Object.keys(vercel.functions).filter(p => path.posix.matchesGlob(file, p));
    assert.strictEqual(matches.length, 1, file + ' matched by: ' + JSON.stringify(matches));
  }
});

test('vercel.json: every cron path has a route file', () => {
  for (const c of vercel.crons) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', c.path.replace(/^\//, '') + '.js')), c.path);
  }
});

test('vercel.json: auto-checkout and monthly-report are off minute :00, where the hourly GitHub-Actions job and other crons land', () => {
  const sched = name => vercel.crons.find(c => c.path.endsWith(name)).schedule;
  assert.strictEqual(sched('auto-checkout'), '2-57/5 * * * *', 'minutes 2,7,12,...,57');
  const minutes = [];
  for (let m = 2; m <= 57; m += 5) minutes.push(m);
  assert.ok(!minutes.includes(0));
  assert.strictEqual(sched('monthly-report').split(' ')[0], '15');
});

// ── monthly report ───────────────────────────────────────────────────────────

test('monthlyReportHandler: logs start and duration, reads the four tables together, and still reports', async () => {
  const ctx = setup({
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Test Lodge', 'Notify Phone': '27831112222' } }],
    WS_Rooms: [room], WS_Bookings: [], WS_Guests: [guest]
  });
  const res = jsonRes();
  await wh.monthlyReportHandler({}, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(events(ctx, 'cron_started')[0].cron, 'monthly_report');
  assert.strictEqual(typeof events(ctx, 'cron_duration')[0].ms, 'number');
  const calls = events(ctx, 'airtable_call_count').find(e => e.cronName === 'monthly_report');
  assert.ok(calls && calls.breakdown.get >= 4, 'the four table reads were counted');
  for (const table of ['WS_Properties', 'WS_Rooms', 'WS_Bookings', 'WS_Guests']) assert.ok(ctx.gets.includes(table), table);
});
