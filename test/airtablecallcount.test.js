// test/airtablecallcount.test.js
// Airtable call-count instrumentation: one 'airtable_call_count' Axiom event
// per runOwnerSummary/runDailySummary invocation, so the Postgres/queue
// migration trigger (~100-150 properties, ~250-300 calls/run) is measured
// rather than estimated. Logging only — no Airtable write, so this cannot
// break Rule 29 (dailysummary.test.js's read-only-cron invariant).

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

const seed = {
  WS_Properties: [
    { id: 'recVL', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Notify Phone': '27732273477' } },
    { id: 'recOther', fields: { 'Property Name': 'Other Lodge', 'Notify Phone': '27732273478' } }
  ],
  WS_Rooms: [],
  WS_Bookings: [],
  WS_Guests: []
};

test('runOwnerSummary logs exactly one airtable_call_count event with sane totals', async () => {
  const ctx = setup(seed);
  await wh.runOwnerSummary({ now: new Date('2026-08-10T04:00:00.000Z') });

  const events = ctx.axiom.filter(e => e.event === 'airtable_call_count');
  assert.strictEqual(events.length, 1, 'exactly one call-count event per run');
  const e = events[0];
  assert.strictEqual(e.cronName, 'owner_summary');
  assert.strictEqual(e.propertyCount, 2);
  assert.ok(e.totalCalls >= 4, 'at least the 4 unconditional top-level reads (Properties/Rooms/Bookings/Guests)');
  assert.strictEqual(e.callsPerProperty, Math.round((e.totalCalls / 2) * 100) / 100);
  assert.ok(e.breakdown && typeof e.breakdown.get === 'number', 'breakdown by call kind is present');
});

test('runDailySummary logs one airtable_call_count event keyed to properties that actually fired', async () => {
  const ctx = setup({
    WS_Properties: [
      { id: 'recVL', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Notify Phone': '27732273477', 'Daily Summary Hour': 20, 'Owner': ['recOwnerVL'] } },
      { id: 'recOther', fields: { 'Property Name': 'Other Lodge', 'Daily Summary Hour': 9 } }
    ],
    WS_Rooms: [],
    WS_Bookings: [],
    WS_Guests: [],
    WS_Owners: [{ id: 'recOwnerVL', fields: { 'Owner Name': 'Villa Liza Owner' } }]
  });

  // 20:00 SAST — only recVL's configured hour matches.
  await wh.runDailySummary({ now: new Date('2026-08-10T18:00:00.000Z') });

  const events = ctx.axiom.filter(e => e.event === 'airtable_call_count');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].cronName, 'daily_summary');
  assert.strictEqual(events[0].propertyCount, 1, 'counts properties that fired, not the total scanned');
});

test('runDailySummary with zero properties firing still logs one event, with propertyCount 0 and callsPerProperty null', async () => {
  const ctx = setup({
    WS_Properties: [{ id: 'recVL', fields: { 'Property Name': 'Villa Liza Guest Lodge' } }], // no Daily Summary Hour
    WS_Rooms: [], WS_Bookings: [], WS_Guests: []
  });
  await wh.runDailySummary({ now: new Date('2026-08-10T18:00:00.000Z') });

  const events = ctx.axiom.filter(e => e.event === 'airtable_call_count');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].propertyCount, 0);
  assert.strictEqual(events[0].callsPerProperty, null, 'no division by zero');
  assert.strictEqual(events[0].totalCalls, 1, 'only the one unconditional WS_Properties read — nothing fired, so no rooms/bookings/guests reads');
});

test('runOwnerSummary and runDailySummary each get their own independent counter — no cross-contamination', async () => {
  const ctx = setup(seed);
  await wh.runOwnerSummary({ now: new Date('2026-08-10T04:00:00.000Z') });
  await wh.runDailySummary({ now: new Date('2026-08-10T18:00:00.000Z') });

  const events = ctx.axiom.filter(e => e.event === 'airtable_call_count');
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].cronName, 'owner_summary');
  assert.strictEqual(events[1].cronName, 'daily_summary');
});
