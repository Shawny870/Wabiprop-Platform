// test/axiom.logging.test.js
// F32 — Axiom ingest went to a dataset that does not exist, and the failure was
// structurally invisible.
//
// Two independent defects, and the second is what let the first live for weeks:
//
//   1. Three of the four loggers POSTed to /v1/datasets/wabiprop/ingest. There is
//      no 'wabiprop' dataset in the Axiom org — the only datasets are
//      otel-demo-metrics, otel-demo-traces, sample-http-logs and wabistay. Every
//      router log, every Wabiprop handler log and every Wabiprop cron log was
//      rejected 404 and thrown away. That includes router_fatal, so router
//      crashes were unobservable, and hmac_signature_check, which is what made
//      the B1 rollout gate unverifiable.
//
//   2. fetch() does not reject on 4xx/5xx — it RESOLVES. Every logger handled
//      only .catch(), which fires on network failure alone, so a 404 was
//      indistinguishable from success. Nothing was logged, nothing was thrown,
//      nothing was printed.
//
// The tests below pin both, plus the harness gap that let 156 tests pass over a
// dataset name that could never work.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, makeRes, installFetch, MockAirtable } = require('./harness');

installEnv();
const router = require('../api/webhook.js');

// The datasets that actually exist in the Axiom org. A logger targeting anything
// outside this set is dropping data on the floor in production.
const EXISTING_DATASETS = ['otel-demo-metrics', 'otel-demo-traces', 'sample-http-logs', 'wabistay'];

function routerPayload(phoneNumberId, from, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_TEST',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '27000000000', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: 'Test' }, wa_id: from }],
          messages: [{ from, id: 'wamid.axiom.test', timestamp: '1750000000', type: 'text', text: { body: text } }]
        }
      }]
    }]
  };
}

// ── 1. The dataset the router actually targets ──────────────────────────────

test('axiom: router ingest targets a dataset that exists in the org', async () => {
  const ctx = { airtable: new MockAirtable({}), sends: [], axiom: [], axiomDatasets: [] };
  installFetch(ctx);
  // An unknown phone_number_id is the shortest path that still logs: it reaches
  // router_unknown_number_id without needing any Airtable seed.
  await router({ method: 'POST', headers: {}, body: routerPayload('999999', '27831234567', 'hi') }, makeRes());

  assert.ok(ctx.axiomDatasets.length > 0, 'router logged nothing at all');
  for (const dataset of ctx.axiomDatasets) {
    assert.ok(
      EXISTING_DATASETS.includes(dataset),
      `router ingested to '${dataset}', which does not exist in the Axiom org — it would 404 and be dropped`
    );
  }
});

test('axiom: router no longer targets the nonexistent wabiprop dataset', async () => {
  const ctx = { airtable: new MockAirtable({}), sends: [], axiom: [], axiomDatasets: [] };
  installFetch(ctx);
  await router({ method: 'POST', headers: {}, body: routerPayload('999999', '27831234567', 'hi') }, makeRes());

  assert.ok(
    !ctx.axiomDatasets.includes('wabiprop'),
    'router is still ingesting to wabiprop — that dataset does not exist and the logs are discarded'
  );
});

test('axiom: router events carry source so one dataset stays filterable', async () => {
  const ctx = { airtable: new MockAirtable({}), sends: [], axiom: [], axiomDatasets: [] };
  installFetch(ctx);
  await router({ method: 'POST', headers: {}, body: routerPayload('999999', '27831234567', 'hi') }, makeRes());

  assert.ok(ctx.axiom.length > 0, 'no events captured');
  // Collapsing two datasets into one is only safe if the product is still
  // recoverable from the record itself.
  for (const record of ctx.axiom) {
    assert.strictEqual(record.source, 'router', `event ${record.event} lost its source field`);
  }
});

// ── 2. Every logger in the codebase, checked statically ─────────────────────
// A runtime test can only reach the loggers it exercises. The Wabiprop handler
// is parked (no phone number assigned) and the cron helpers run on a schedule,
// so neither is reachable from a router test — but both were silently dropping
// logs, and both must stay fixed. Read the source and assert on it directly.

const fs = require('fs');
const path = require('path');

const LOGGER_FILES = [
  'api/webhook.js',
  'api/wabiprop/webhook.js',
  'api/wabiprop/_lib/cronHelpers.js',
  'api/wabistay/webhook.js'
];

test('axiom: no logger anywhere targets a nonexistent dataset', () => {
  for (const file of LOGGER_FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const literals = [...src.matchAll(/datasets\/([a-zA-Z0-9_-]+)\/ingest/g)].map(m => m[1]);
    for (const dataset of literals) {
      assert.ok(
        EXISTING_DATASETS.includes(dataset),
        `${file} ingests to '${dataset}', which does not exist in the Axiom org`
      );
    }
    const constMatch = src.match(/const AXIOM_DATASET = '([^']+)'/);
    assert.ok(constMatch, `${file} has no AXIOM_DATASET constant`);
    assert.ok(
      EXISTING_DATASETS.includes(constMatch[1]),
      `${file} sets AXIOM_DATASET to '${constMatch[1]}', which does not exist in the Axiom org`
    );
  }
});

test('axiom: every logger inspects the ingest response status', () => {
  // The root cause, not the instance. Without this branch a rejected ingest is
  // indistinguishable from a successful one and the next wrong dataset name,
  // revoked token or quota rejection is just as invisible as this one was.
  for (const file of LOGGER_FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(
      /res\.ok/.test(src) && /ingest rejected/.test(src),
      `${file} does not check the Axiom ingest response status — a non-2xx would fail silently`
    );
  }
});

// ── 3. A non-2xx ingest is actually reported ────────────────────────────────

test('axiom: a rejected ingest writes to console.error', async () => {
  const ctx = { airtable: new MockAirtable({}), sends: [], axiom: [], axiomDatasets: [] };
  installFetch(ctx);
  const harnessFetch = global.fetch;

  // Wrap the harness fetch so Axiom specifically answers 404 — the exact
  // response a nonexistent dataset returns.
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.axiom.co')) {
      return { ok: false, status: 404, json: async () => ({ error: 'dataset not found' }) };
    }
    return harnessFetch(url, opts);
  };

  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));

  try {
    await router({ method: 'POST', headers: {}, body: routerPayload('999999', '27831234567', 'hi') }, makeRes());
    // The logger is fire-and-forget by design (rule 24 — Meta gets its 200
    // immediately, the log must never block it), so the .then runs on a later
    // microtask than the handler's return.
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.error = realError;
    global.fetch = harnessFetch;
  }

  const reported = errors.filter(e => e.includes('[Axiom ERROR]') && e.includes('404'));
  assert.ok(
    reported.length > 0,
    `a 404 ingest was swallowed silently — console.error saw: ${JSON.stringify(errors)}`
  );
});
