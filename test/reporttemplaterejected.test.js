// test/reporttemplaterejected.test.js
// Weekly recap and monthly report: a template Meta rejects (sendWhatsAppTemplate returns
// ok:false instead of throwing) is a FAILURE — ops alert with the Meta error code and the
// template name, listed in `failed`, excluded from `sent`, and the run carries on with the
// other properties. Seen live 1 and 8 Oct 2026 (error 132001).

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const NOW = new Date('2026-08-20T06:00:00.000Z');
const ALERT = '27811110000';

const props = [
  { id: 'recA', fields: { 'Property Name': 'Alpha Lodge', 'Notify Phone': '27700000001', 'Owner': ['recOwn'] } },
  { id: 'recB', fields: { 'Property Name': 'Beta Lodge', 'Notify Phone': '27700000002', 'Owner': ['recOwn'] } }
];

// Meta answers 404 / 132001 for `rejectTemplate` sent to `rejectTo`; everything else passes through.
function setup(rejectTemplate, rejectTo) {
  const ctx = {
    airtable: new MockAirtable({
      WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': ALERT } }],
      WS_Properties: props,
      WS_Owners: [{ id: 'recOwn', fields: { 'Owner Name': 'Chris' } }],
      WS_Rooms: [], WS_Bookings: [], WS_Guests: []
    }),
    sends: [], axiom: []
  };
  installFetch(ctx);
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    let body = null;
    try { body = JSON.parse(opts && opts.body); } catch (_) { /* not JSON */ }
    if (body && body.type === 'template' && body.template.name === rejectTemplate && body.to === rejectTo) {
      return { status: 404, json: async () => ({ error: { message: '(#132001) Template name does not exist in the translation', code: 132001 } }) };
    }
    return real(url, opts);
  };
  return ctx;
}
const alerts = ctx => ctx.sends.filter(s => s.to === ALERT);

test('weekly: a rejected template is a failure — alert carries code 132001 and the template name; the other property is still sent', async () => {
  const ctx = setup(wh.WEEKLY_RECAP_TEMPLATE, '27700000001');
  const sent = await wh.runWeeklyRecap({ now: NOW });
  assert.deepStrictEqual(sent.map(r => r.propertyId), ['recB'], 'only the accepted property counts as sent');
  assert.strictEqual(sent.failed.length, 1);
  assert.strictEqual(sent.failed[0].propertyId, 'recA');
  assert.match(sent.failed[0].error, /(code 132001)/);
  assert.ok(sent.failed[0].error.includes(wh.WEEKLY_RECAP_TEMPLATE));
  assert.strictEqual(alerts(ctx).length, 1);
  const body = alerts(ctx)[0].body;
  assert.ok(body.includes('weekly_recap') && body.includes('132001') && body.includes(wh.WEEKLY_RECAP_TEMPLATE) && body.includes('Alpha Lodge'));
  assert.ok(ctx.sends.some(s => s.to === '27700000002' && s.template === wh.WEEKLY_RECAP_TEMPLATE), 'Beta Lodge still got its recap');
});

test('monthly: a rejected template is a failure — alert carries code 132001 and the template name; the other property is still sent', async () => {
  const name = wh.MONTHLY_REPORT_TEMPLATE || 'wabistay_owner_monthly_recap';
  const ctx = setup(name, '27700000001');
  const sent = await wh.runMonthlyReport({ now: NOW });
  assert.deepStrictEqual(sent.map(r => r.propertyId), ['recB']);
  assert.strictEqual(sent.failed.length, 1);
  assert.strictEqual(sent.failed[0].propertyId, 'recA');
  assert.match(sent.failed[0].error, /(code 132001)/);
  assert.ok(sent.failed[0].error.includes(name));
  assert.strictEqual(alerts(ctx).length, 1);
  assert.ok(alerts(ctx)[0].body.includes('monthly_report') && alerts(ctx)[0].body.includes('132001') && alerts(ctx)[0].body.includes(name));
  assert.ok(ctx.sends.some(s => s.to === '27700000002' && s.template === name));
});

test('weekly: when Meta accepts every send there is no failure and no alert', async () => {
  const ctx = setup('no-such-template', 'nobody');
  const sent = await wh.runWeeklyRecap({ now: NOW });
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent.failed.length, 0);
  assert.strictEqual(alerts(ctx).length, 0);
});

test('monthly: when Meta accepts every send there is no failure and no alert', async () => {
  const ctx = setup('no-such-template', 'nobody');
  const sent = await wh.runMonthlyReport({ now: NOW });
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent.failed.length, 0);
  assert.strictEqual(alerts(ctx).length, 0);
});
