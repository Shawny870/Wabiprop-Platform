// test/dailysummarytemplateparams.test.js
// Stage 3 part 3 prep — dailySummaryTemplateParams(summary) builds the
// wabistay_owner_daily_summary template params in the Meta-locked positional
// order: [ownerName, propertyName, date, paymentDeltaTotalFormatted,
// tomorrowsArrivalsCount]. NOT wired to any live send — see the TODO at
// sendDailySummary in webhook.js. This file tests the params builder and the
// new resolveOwnerName lookup in isolation.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function baseSummary(overrides = {}) {
  return {
    ownerName: 'Thandiwe Nkosi',
    propertyName: 'Villa Liza Guest Lodge',
    date: '2026-08-20',
    outstandingPayments: { paymentLines: [], paymentDeltaTotal: 0 },
    tomorrowsArrivals: [],
    ...overrides
  };
}

// ── dailySummaryTemplateParams: order and shape ──────────────────────────────

test('dailySummaryTemplateParams: returns exactly the 5 fields, in the locked order', () => {
  const summary = baseSummary({
    outstandingPayments: { paymentLines: [{ delta: 100 }, { delta: 250.5 }], paymentDeltaTotal: 350.5 },
    tomorrowsArrivals: [{ bookingId: 'a' }, { bookingId: 'b' }]
  });
  const params = wh.dailySummaryTemplateParams(summary);
  assert.deepStrictEqual(params, ['Thandiwe Nkosi', 'Villa Liza Guest Lodge', '20 August 2026', '350.50', 2]);
});

test('dailySummaryTemplateParams: {{3}} date is reformatted to human-readable, per CEO confirmation', () => {
  const params = wh.dailySummaryTemplateParams(baseSummary({ date: '2026-01-05' }));
  assert.strictEqual(params[2], '5 January 2026');
});

test('dailySummaryTemplateParams: does NOT mutate summary.date — other consumers depend on the ISO string', () => {
  const summary = baseSummary({ date: '2026-03-09' });
  wh.dailySummaryTemplateParams(summary);
  assert.strictEqual(summary.date, '2026-03-09');
});

test('formatHumanDate: renders D Month YYYY from an ISO YYYY-MM-DD date', () => {
  assert.strictEqual(wh.formatHumanDate('2026-08-20'), '20 August 2026');
  assert.strictEqual(wh.formatHumanDate('2026-01-05'), '5 January 2026');
  assert.strictEqual(wh.formatHumanDate('2026-12-31'), '31 December 2026');
});

test('formatHumanDate: throws on a non-YYYY-MM-DD input rather than producing garbage', () => {
  assert.throws(() => wh.formatHumanDate('20 August 2026'), /expected YYYY-MM-DD/);
  assert.throws(() => wh.formatHumanDate(''), /expected YYYY-MM-DD/);
});

test('dailySummaryTemplateParams: {{5}} is tomorrowsArrivals.length, not the raw array', () => {
  const params = wh.dailySummaryTemplateParams(baseSummary({
    tomorrowsArrivals: [{ bookingId: 'a' }, { bookingId: 'b' }, { bookingId: 'c' }]
  }));
  assert.strictEqual(params[4], 3);
  assert.notStrictEqual(typeof params[4], 'object');
});

test('dailySummaryTemplateParams: zero arrivals produces count 0, not an empty array or null', () => {
  const params = wh.dailySummaryTemplateParams(baseSummary({ tomorrowsArrivals: [] }));
  assert.strictEqual(params[4], 0);
});

// ── {{4}} paymentDeltaTotalFormatted: formatting + sign handling ────────────

test('dailySummaryTemplateParams: positive paymentDeltaTotal formats with no sign, two decimals', () => {
  const params = wh.dailySummaryTemplateParams(baseSummary({
    outstandingPayments: { paymentLines: [], paymentDeltaTotal: 400 }
  }));
  assert.strictEqual(params[3], '400.00');
});

test('dailySummaryTemplateParams: negative paymentDeltaTotal (overpayment) keeps a leading minus', () => {
  const params = wh.dailySummaryTemplateParams(baseSummary({
    outstandingPayments: { paymentLines: [], paymentDeltaTotal: -75.5 }
  }));
  assert.strictEqual(params[3], '-75.50');
});

test('dailySummaryTemplateParams: zero paymentDeltaTotal has no sign', () => {
  const params = wh.dailySummaryTemplateParams(baseSummary({
    outstandingPayments: { paymentLines: [], paymentDeltaTotal: 0 }
  }));
  assert.strictEqual(params[3], '0.00');
});

test('formatSignedAmount: matches the reception-payment sign+abs pattern minus the R prefix', () => {
  assert.strictEqual(wh.formatSignedAmount(350.5), '350.50');
  assert.strictEqual(wh.formatSignedAmount(-350.5), '-350.50');
  assert.strictEqual(wh.formatSignedAmount(0), '0.00');
  assert.strictEqual(wh.formatSignedAmount(null), '0.00');
  assert.strictEqual(wh.formatSignedAmount(undefined), '0.00');
});

// ── {{1}} ownerName: missing is a loud failure, not a silent guess ──────────

test('dailySummaryTemplateParams: throws if ownerName is missing (undefined) — no silent placeholder', () => {
  const summary = baseSummary();
  delete summary.ownerName;
  assert.throws(() => wh.dailySummaryTemplateParams(summary), /ownerName is missing/);
});

test('dailySummaryTemplateParams: throws if ownerName is null (property has no linked owner)', () => {
  assert.throws(() => wh.dailySummaryTemplateParams(baseSummary({ ownerName: null })), /ownerName is missing/);
});

test('dailySummaryTemplateParams: does NOT throw for an empty-string ownerName (a real, if odd, Airtable value)', () => {
  assert.doesNotThrow(() => wh.dailySummaryTemplateParams(baseSummary({ ownerName: '' })));
});

// ── resolveOwnerName: the new WS_Properties.Owner -> WS_Owners lookup ───────

function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

test('resolveOwnerName: resolves Owner Name via the linked WS_Owners record', async () => {
  setup({
    WS_Properties: [{ id: 'recVL', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Owner': ['recOwn1'] } }],
    WS_Owners: [{ id: 'recOwn1', fields: { 'Owner Name': 'Thandiwe Nkosi' } }]
  });
  const property = { id: 'recVL', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Owner': ['recOwn1'] } };
  const ownerName = await wh.resolveOwnerName(property);
  assert.strictEqual(ownerName, 'Thandiwe Nkosi');
});

test('resolveOwnerName: returns null (not a guessed default) when the property has no linked owner', async () => {
  setup({ WS_Properties: [], WS_Owners: [] });
  const property = { id: 'recNoOwner', fields: { 'Property Name': 'No Owner Lodge' } };
  const ownerName = await wh.resolveOwnerName(property);
  assert.strictEqual(ownerName, null);
});

test('resolveOwnerName: returns null when the linked owner record has no Owner Name set', async () => {
  setup({
    WS_Properties: [],
    WS_Owners: [{ id: 'recOwn2', fields: {} }]
  });
  const property = { id: 'recX', fields: { 'Property Name': 'X Lodge', 'Owner': ['recOwn2'] } };
  const ownerName = await wh.resolveOwnerName(property);
  assert.strictEqual(ownerName, null);
});

test('resolveOwnerName: takes the first linked owner when Owner has multiple links', async () => {
  setup({
    WS_Properties: [],
    WS_Owners: [
      { id: 'recOwnA', fields: { 'Owner Name': 'First Owner' } },
      { id: 'recOwnB', fields: { 'Owner Name': 'Second Owner' } }
    ]
  });
  const property = { id: 'recMulti', fields: { 'Property Name': 'Multi Lodge', 'Owner': ['recOwnA', 'recOwnB'] } };
  const ownerName = await wh.resolveOwnerName(property);
  assert.strictEqual(ownerName, 'First Owner');
});
