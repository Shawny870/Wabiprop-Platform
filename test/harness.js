// test/harness.js
// H0 — Replay harness for api/wabistay/webhook.js
//
// Fixtures in fixtures/ are real Meta webhook payloads + Airtable seed records +
// the exact expected outcome (WhatsApp sends, Airtable writes, HTTP status).
// The harness mocks global.fetch: Airtable is an in-memory store that evaluates
// the three filterByFormula patterns the code uses, Meta and Axiom calls are
// recorded. No network, no live data.

const TEST_ENV = {
  AIRTABLE_BASE_ID: 'appTESTBASE000000',
  AIRTABLE_API_KEY: 'key_test',
  WA_PHONE_NUMBER_ID: '111000111000',
  WA_ACCESS_TOKEN: 'token_test',
  WA_VERIFY_TOKEN: 'verify_test',
  OWNER_PHONE: '27830000001',
  AXIOM_TOKEN: 'axiom_test'
};

function installEnv() {
  Object.assign(process.env, TEST_ENV);
}

// ── In-memory Airtable ──────────────────────────────────────────────────────

class MockAirtable {
  constructor(seed = {}) {
    this.tables = {};
    this.log = []; // ordered create/update log — the behaviour freeze
    this.counter = 0;
    for (const [table, recs] of Object.entries(seed)) {
      this.tables[table] = recs.map(r => ({ id: r.id, fields: { ...r.fields } }));
    }
  }

  // Supports exactly the formula patterns webhook.js uses:
  //   {Field} = 'value'   ·   {Field} = TRUE()   ·   RECORD_ID() = 'recXXX'
  evalFormula(formula, rec) {
    let m;
    if ((m = formula.match(/^\{(.+?)\}\s*=\s*TRUE\(\)$/))) return !!rec.fields[m[1]];
    if ((m = formula.match(/^RECORD_ID\(\)\s*=\s*'(.*)'$/))) return rec.id === m[1];
    if ((m = formula.match(/^\{(.+?)\}\s*=\s*'(.*)'$/))) return String(rec.fields[m[1]] ?? '') === m[2];
    throw new Error('Formula pattern not supported by mock: ' + formula);
  }

  list(table, formula) {
    const recs = this.tables[table] || [];
    return formula ? recs.filter(r => this.evalFormula(formula, r)) : recs;
  }

  create(table, fields) {
    const id = 'recNEW' + String(++this.counter).padStart(3, '0');
    const rec = { id, fields: { ...fields } };
    (this.tables[table] = this.tables[table] || []).push(rec);
    this.log.push({ op: 'create', table, id, fields: { ...fields } });
    return rec;
  }

  update(table, id, fields) {
    const rec = (this.tables[table] || []).find(r => r.id === id);
    if (rec) Object.assign(rec.fields, fields);
    this.log.push({ op: 'update', table, id, fields: { ...fields } });
    return rec || { id, fields };
  }
}

// ── fetch mock ──────────────────────────────────────────────────────────────

function jsonRes(obj, status = 200) {
  return { status, ok: status < 300, json: async () => obj, text: async () => JSON.stringify(obj) };
}

function installFetch(ctx) {
  global.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const u = new URL(url);

    if (u.hostname === 'api.airtable.com') {
      const parts = u.pathname.split('/').filter(Boolean); // v0 / base / table / [recId]
      const table = decodeURIComponent(parts[2]);
      const recId = parts[3];
      if (method === 'GET') {
        return jsonRes({ records: ctx.airtable.list(table, u.searchParams.get('filterByFormula')) });
      }
      if (method === 'POST') {
        const rec = ctx.airtable.create(table, JSON.parse(opts.body).fields);
        return jsonRes({ id: rec.id, fields: rec.fields, createdTime: new Date().toISOString() });
      }
      if (method === 'PATCH') {
        const rec = ctx.airtable.update(table, recId, JSON.parse(opts.body).fields);
        return jsonRes({ id: rec.id, fields: rec.fields });
      }
    }

    if (u.hostname === 'graph.facebook.com') {
      const body = JSON.parse(opts.body);
      ctx.sends.push({ to: body.to, body: body.text.body });
      return jsonRes({ messages: [{ id: 'wamid.test' }] });
    }

    if (u.hostname === 'api.axiom.co') {
      ctx.axiom.push(...JSON.parse(opts.body));
      return jsonRes({});
    }

    throw new Error('Unexpected fetch in test: ' + method + ' ' + url);
  };
}

// ── Meta payload builder + res capture ──────────────────────────────────────

function metaTextPayload(from, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_TEST',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '27000000000', phone_number_id: TEST_ENV.WA_PHONE_NUMBER_ID },
          contacts: [{ profile: { name: 'Test' }, wa_id: from }],
          messages: [{ from, id: 'wamid.incoming.test', timestamp: '1750000000', type: 'text', text: { body: text } }]
        }
      }]
    }]
  };
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.send = body => { res.body = body; return res; };
  return res;
}

// Seed values of "$NOW" become the current time (used by the F14 cooldown fixture).
function resolveNow(value) {
  if (value === '$NOW') return new Date().toISOString();
  if (Array.isArray(value)) return value.map(resolveNow);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveNow(v)]));
  }
  return value;
}

// ── Fixture runner + assertions ─────────────────────────────────────────────

async function runFixture(handler, fixture) {
  const ctx = { airtable: new MockAirtable(resolveNow(fixture.seed || {})), sends: [], axiom: [] };
  installFetch(ctx);
  const payload = fixture.payload || metaTextPayload(fixture.message.from, fixture.message.text);
  const res = makeRes();
  await handler({ method: 'POST', body: payload }, res);
  return { ctx, res };
}

// Expected string values of the form "re:<pattern>" are matched as regex.
function matchValue(assert, actual, expected, where) {
  if (typeof expected === 'string' && expected.startsWith('re:')) {
    assert.match(String(actual), new RegExp(expected.slice(3)), where);
  } else {
    assert.deepStrictEqual(actual, expected, where);
  }
}

function assertFixture(assert, expect, ctx, res) {
  assert.strictEqual(res.statusCode, expect.status ?? 200, 'HTTP status');

  const expSends = expect.sends || [];
  assert.strictEqual(ctx.sends.length, expSends.length,
    `send count — actual sends: ${JSON.stringify(ctx.sends.map(s => s.to + ': ' + s.body.slice(0, 60)))}`);
  expSends.forEach((exp, i) => {
    const got = ctx.sends[i];
    if (exp.to) assert.strictEqual(got.to, exp.to, `send[${i}].to`);
    for (const sub of exp.includes || []) {
      assert.ok(got.body.includes(sub), `send[${i}] missing "${sub}" in: ${got.body}`);
    }
  });

  const expWrites = expect.writes || [];
  assert.strictEqual(ctx.airtable.log.length, expWrites.length,
    `write count — actual writes: ${JSON.stringify(ctx.airtable.log)}`);
  expWrites.forEach((exp, i) => {
    const got = ctx.airtable.log[i];
    assert.strictEqual(got.op, exp.op, `write[${i}].op`);
    assert.strictEqual(got.table, exp.table, `write[${i}].table`);
    if (exp.id) assert.strictEqual(got.id, exp.id, `write[${i}].id`);
    for (const [field, val] of Object.entries(exp.fields || {})) {
      matchValue(assert, got.fields[field], val, `write[${i}] ${exp.table}.${field}`);
    }
  });
}

module.exports = { installEnv, runFixture, assertFixture, metaTextPayload, makeRes, TEST_ENV };
