// test/skipunnamedproperty.test.js
// A WS_Properties row with no Property Name (the blank rec5Oo92ii3H6xmBB) is skipped
// by the weekly recap, monthly report and owner summary loops: info event, no alert.
// A named property with no owner link still alerts.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const NOW = new Date('2026-08-20T06:00:00.000Z');
const ALERT = '27811110000';

function setup(properties) {
  const ctx = {
    airtable: new MockAirtable({
      WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': ALERT } }],
      WS_Properties: properties,
      WS_Owners: [{ id: 'recOwn', fields: { 'Owner Name': 'Chris' } }],
      WS_Rooms: [],
      WS_Bookings: [],
      WS_Guests: []
    }),
    sends: [],
    axiom: []
  };
  installFetch(ctx);
  return ctx;
}

const blank = { id: 'recBlank', fields: {} };
const named = { id: 'recNamed', fields: { 'Property Name': 'Canary Street', 'Notify Phone': '27700000001', 'Owner': ['recOwn'] } };
const namedNoOwner = { id: 'recNoOwn', fields: { 'Property Name': 'No Owner Lodge', 'Notify Phone': '27700000003' } };

const alerts = ctx => ctx.sends.filter(s => s.to === ALERT);
const skips = (ctx, cron) => ctx.axiom.filter(a => a.event === 'report_skipped_unnamed_property' && a.cron === cron);

test('weekly recap skips a blank property: info event, no alert, named property still sent', async () => {
  const ctx = setup([blank, named]);
  const sent = await wh.runWeeklyRecap({ now: NOW });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].propertyId, 'recNamed');
  assert.strictEqual(sent.failed.length, 0);
  assert.strictEqual(alerts(ctx).length, 0);
  assert.strictEqual(skips(ctx, 'weekly_recap').length, 1);
  assert.strictEqual(skips(ctx, 'weekly_recap')[0].propertyId, 'recBlank');
});

test('monthly report skips a blank property: info event, no alert, named property still sent', async () => {
  const ctx = setup([blank, named]);
  const sent = await wh.runMonthlyReport({ now: NOW });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent.failed.length, 0);
  assert.strictEqual(alerts(ctx).length, 0);
  assert.strictEqual(skips(ctx, 'monthly_report').length, 1);
});

test('owner summary skips a blank property: info event, no alert, no failure', async () => {
  const ctx = setup([blank, named]);
  const summaries = await wh.runOwnerSummary({ now: NOW });
  assert.ok(!(summaries.failed || []).some(f => f.propertyId === 'recBlank'));
  assert.strictEqual(alerts(ctx).length, 0);
  assert.strictEqual(skips(ctx, 'owner_summary').length, 1);
});

test('a NAMED property with no owner link still alerts in the weekly recap (blank row beside it is skipped)', async () => {
  const ctx = setup([blank, namedNoOwner]);
  const sent = await wh.runWeeklyRecap({ now: NOW });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(sent.failed.length, 1);
  assert.strictEqual(sent.failed[0].propertyId, 'recNoOwn');
  assert.strictEqual(alerts(ctx).length, 1);
  assert.ok(alerts(ctx)[0].body.includes('No Owner Lodge'));
  assert.strictEqual(skips(ctx, 'weekly_recap').length, 1);
});
