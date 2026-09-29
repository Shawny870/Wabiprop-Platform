// test/alertshawn.test.js
// Coverage for getAlertPhone()/alertShawn() (api/wabistay/webhook.js), ported
// from api/wabiprop/_lib/cronHelpers.js:100-105 but reading the destination
// number from WS_Config instead of a hardcoded string, with an
// ALERT_PHONE_FALLBACK env var as a last resort if Airtable itself is
// unreachable. See PR body for the full writeup.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();

function setup(seed = {}) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

function freshWebhook() {
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  return require('../api/wabistay/webhook.js');
}

// Discovered against the LIVE base while verifying Item A of the batch: the
// real WS_Config table has 3 rows (2 blank, 1 populated), not the single row
// the "convention" comment assumes — Airtable's own "+" row button makes
// this trivial to end up with by accident. rows[0] happened to be the
// populated one today, but that's return order, not a guarantee.
test('getAlertPhone finds the populated row even when it is not first (blank rows before it)', async () => {
  setup({
    WS_Config: [
      { id: 'recBlank1', fields: {} },
      { id: 'recBlank2', fields: {} },
      { id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }
    ]
  });
  delete process.env.ALERT_PHONE_FALLBACK;
  const wh = freshWebhook();
  const phone = await wh.getAlertPhone();
  assert.strictEqual(phone, '27811110000');
});

test('getAlertPhone logs a warning when WS_Config has more than one row, so drift is visible', async () => {
  const ctx = setup({
    WS_Config: [
      { id: 'recBlank1', fields: {} },
      { id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }
    ]
  });
  delete process.env.ALERT_PHONE_FALLBACK;
  const wh = freshWebhook();
  await wh.getAlertPhone();
  assert.ok(ctx.axiom.some(e => e.event === 'alert_phone_multiple_rows' && e.rowCount === 2));
});

test('getAlertPhone reads the number from WS_Config when a row exists', async () => {
  setup({ WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }] });
  delete process.env.ALERT_PHONE_FALLBACK;
  const wh = freshWebhook();
  const phone = await wh.getAlertPhone();
  assert.strictEqual(phone, '27811110000');
});

test('alertShawn sends free-form text to the WS_Config number when no ops-alert template is configured', async () => {
  const ctx = setup({ WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }] });
  delete process.env.ALERT_PHONE_FALLBACK;
  delete process.env.WABISTAY_OPS_ALERT_TEMPLATE;
  const wh = freshWebhook();
  await wh.alertShawn('owner_summary', 'Airtable timeout', { propertyId: 'recPROP1' });
  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].to, '27811110000');
  assert.strictEqual(ctx.sends[0].type, 'text');
  assert.ok(ctx.sends[0].body.includes('owner_summary'), 'message names the failing cron');
  assert.ok(ctx.sends[0].body.includes('Airtable timeout'), 'message includes the error');
  assert.ok(ctx.sends[0].body.includes('recPROP1'), 'message includes context');
  assert.ok(ctx.axiom.some(e => e.event === 'alert_shawn_template_not_configured'),
    'the stub-state fallback is logged, not silent');
});

// ── Sub-PR 1: alertShawn via the approved ops-alert template ────────────────
// The whole point: a template send is not limited to Meta's 24h service
// window (CLAUDE.md line 30) the way the free-form fallback above is — a
// cron failure at 3am has no reason to have messaged the bot recently. These
// tests prove the template path is used once configured; they don't (and
// can't, against this mock) prove the 24h-window behaviour itself, since
// MockAirtable/installFetch don't model Meta's re-engagement window at all —
// that's asserted structurally, by proving sendWhatsAppTemplate (not
// sendWhatsApp) is the call that goes out.

test('alertShawn sends the approved ops-alert template once WABISTAY_OPS_ALERT_TEMPLATE is configured — reaches Shawn regardless of any 24h window', async () => {
  const ctx = setup({ WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }] });
  delete process.env.ALERT_PHONE_FALLBACK;
  process.env.WABISTAY_OPS_ALERT_TEMPLATE = 'wabistay_ops_alert';
  const wh = freshWebhook();

  await wh.alertShawn('owner_summary', 'Airtable timeout', { propertyId: 'recPROP1', propertyName: 'Canary Street' });

  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].to, '27811110000');
  assert.strictEqual(ctx.sends[0].type, 'template', 'must be a template send, never free-form, once configured');
  assert.strictEqual(ctx.sends[0].template, 'wabistay_ops_alert');
  assert.deepStrictEqual(ctx.sends[0].params, ['owner_summary', 'Canary Street', ctx.sends[0].params[2], 'Airtable timeout']);
  assert.ok(!Number.isNaN(Date.parse(ctx.sends[0].params[2])), 'the "when" param is a real timestamp');
  delete process.env.WABISTAY_OPS_ALERT_TEMPLATE;
});

test('alertShawn template path falls back to propertyId, then scope, when no propertyName is available', async () => {
  const ctx = setup({ WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }] });
  delete process.env.ALERT_PHONE_FALLBACK;
  process.env.WABISTAY_OPS_ALERT_TEMPLATE = 'wabistay_ops_alert';
  const wh = freshWebhook();

  await wh.alertShawn('daily_summary_fatal', 'boom', { scope: 'entire run, not a single property' });

  assert.strictEqual(ctx.sends[0].params[1], 'entire run, not a single property');
  delete process.env.WABISTAY_OPS_ALERT_TEMPLATE;
});

test('alertShawn logs loud when the template send itself fails, still via the template path', async () => {
  const ctx = setup({ WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }] });
  delete process.env.ALERT_PHONE_FALLBACK;
  process.env.WABISTAY_OPS_ALERT_TEMPLATE = 'wabistay_ops_alert';
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('/messages') && String(opts.body || '').includes('wabistay_ops_alert')) {
      return { status: 400, ok: false, json: async () => ({ error: { code: 132001, message: 'Template not approved' } }) };
    }
    return realFetch(url, opts);
  };
  const wh = freshWebhook();

  await wh.alertShawn('owner_summary', 'Airtable timeout', { propertyId: 'recPROP1' });

  assert.ok(ctx.axiom.some(e => e.event === 'alert_shawn_template_send_failed'));
  global.fetch = realFetch;
  delete process.env.WABISTAY_OPS_ALERT_TEMPLATE;
});

// This is the fallback path required by the task: WS_Config has no usable row
// (Airtable reachable, but table missing the field/row), so getAlertPhone must
// fall back to ALERT_PHONE_FALLBACK rather than silently alerting nobody.
test('getAlertPhone falls back to ALERT_PHONE_FALLBACK when WS_Config has no Alert Phone', async () => {
  const ctx = setup({ WS_Config: [{ id: 'recCFG1', fields: {} }] }); // row exists, field empty
  process.env.ALERT_PHONE_FALLBACK = '27899990000';
  const wh = freshWebhook();
  const phone = await wh.getAlertPhone();
  assert.strictEqual(phone, '27899990000');
  assert.ok(ctx.axiom.some(e => e.event === 'alert_phone_fallback_used'),
    'fallback usage must be logged so silent reliance on it is visible');
  delete process.env.ALERT_PHONE_FALLBACK;
});

// This is the "Airtable read itself fails" case — not just an empty table,
// but the fetch call throwing/erroring outright (e.g. Airtable outage).
test('getAlertPhone falls back to ALERT_PHONE_FALLBACK when the Airtable fetch throws', async () => {
  setup(); // no WS_Config table seeded — MockAirtable.list returns [] since no formula guard, still no throw...
  // Force an actual fetch-level failure to prove the try/catch fallback path,
  // not just the "empty result" path already covered above.
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('WS_Config')) throw new Error('network down');
    return realFetch(url);
  };
  process.env.ALERT_PHONE_FALLBACK = '27899990000';
  const wh = freshWebhook();
  const phone = await wh.getAlertPhone();
  assert.strictEqual(phone, '27899990000');
  global.fetch = realFetch;
  delete process.env.ALERT_PHONE_FALLBACK;
});

test('getAlertPhone returns null when both WS_Config and the fallback are unavailable', async () => {
  setup({ WS_Config: [] });
  delete process.env.ALERT_PHONE_FALLBACK;
  const wh = freshWebhook();
  const phone = await wh.getAlertPhone();
  assert.strictEqual(phone, null);
});

test('alertShawn sends nothing (and logs) when no destination is available at all', async () => {
  const ctx = setup({ WS_Config: [] });
  delete process.env.ALERT_PHONE_FALLBACK;
  const wh = freshWebhook();
  await wh.alertShawn('daily_summary', 'boom');
  assert.strictEqual(ctx.sends.length, 0);
  assert.ok(ctx.axiom.some(e => e.event === 'alert_shawn_no_destination'));
});

test('getAlertPhone caches the number and does not re-fetch WS_Config within the TTL', async () => {
  const ctx = setup({ WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }] });
  delete process.env.ALERT_PHONE_FALLBACK;
  const wh = freshWebhook();
  await wh.getAlertPhone();
  const fetchCountAfterFirst = ctx.airtable.log.length; // creates/updates only, but confirms no writes happened
  // Mutate the underlying seed directly to prove the second call reads the cache, not Airtable.
  ctx.airtable.tables.WS_Config[0].fields['Alert Phone'] = '27822220000';
  const second = await wh.getAlertPhone();
  assert.strictEqual(second, '27811110000', 'second call within TTL must return the cached value, not the mutated one');
  assert.strictEqual(ctx.airtable.log.length, fetchCountAfterFirst, 'no Airtable writes should occur from a read path');
});
