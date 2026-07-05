// scripts/schema-diff.js
// H0 — Schema drift check: live Airtable metadata vs schema.json
//
// Usage:
//   node scripts/schema-diff.js           compare live base to schema.json (exit 1 on drift)
//   node scripts/schema-diff.js --write   (re)generate schema.json from the live base
//
// ⚠ --write is a SHAWN-ONLY command, run after a deliberate schema change.
//   Claude sessions must NEVER run --write to clear a failing diff: a failing
//   diff means STOP, report the drift, and wait (CLAUDE.md session ritual step 2).
//
// Scope: Wabistay tables only (WS_ prefix). Field names in code must come from
// schema.json — never typed from memory (CLAUDE.md hard rule).

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const AIRTABLE_BASE_ID = process.env.WS_AIRTABLE_BASE_ID || process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const SCHEMA_PATH = path.join(__dirname, '..', 'schema.json');

async function fetchLiveSchema() {
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  });
  if (!res.ok) {
    throw new Error(`Airtable metadata API HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const tables = {};
  for (const t of data.tables.filter(t => t.name.startsWith('WS_'))) {
    tables[t.name] = {
      id: t.id,
      fields: Object.fromEntries(
        t.fields.map(f => [f.name, { id: f.id, type: f.type }])
      )
    };
  }
  return { baseId: AIRTABLE_BASE_ID, scope: 'WS_', tables };
}

function diffSchemas(saved, live) {
  const problems = [];
  const savedTables = Object.keys(saved.tables);
  const liveTables = Object.keys(live.tables);
  for (const t of savedTables.filter(t => !liveTables.includes(t))) {
    problems.push(`TABLE MISSING in live base: ${t}`);
  }
  for (const t of liveTables.filter(t => !savedTables.includes(t))) {
    problems.push(`TABLE NEW in live base (not in schema.json): ${t}`);
  }
  for (const t of savedTables.filter(t => liveTables.includes(t))) {
    const sf = saved.tables[t].fields;
    const lf = live.tables[t].fields;
    for (const f of Object.keys(sf).filter(f => !lf[f])) {
      problems.push(`${t}: field MISSING in live base: "${f}"`);
    }
    for (const f of Object.keys(lf).filter(f => !sf[f])) {
      problems.push(`${t}: field NEW in live base: "${f}" (${lf[f].type})`);
    }
    for (const f of Object.keys(sf).filter(f => lf[f])) {
      if (sf[f].type !== lf[f].type) {
        problems.push(`${t}: field "${f}" type changed: ${sf[f].type} → ${lf[f].type}`);
      }
    }
  }
  return problems;
}

async function main() {
  if (!AIRTABLE_BASE_ID || !AIRTABLE_API_KEY) {
    console.error('Missing AIRTABLE_BASE_ID / AIRTABLE_API_KEY env vars.');
    process.exit(2);
  }
  const live = await fetchLiveSchema();

  if (process.argv.includes('--write')) {
    live.pulledAt = new Date().toISOString();
    fs.writeFileSync(SCHEMA_PATH, JSON.stringify(live, null, 2) + '\n');
    console.log(`schema.json written: ${Object.keys(live.tables).length} WS_ tables from ${live.baseId}`);
    return;
  }

  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error('schema.json not found. Run: node scripts/schema-diff.js --write');
    process.exit(2);
  }
  const saved = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  if (saved.baseId !== live.baseId) {
    console.warn(`NOTE: comparing against base ${live.baseId} but schema.json was pulled from ${saved.baseId}`);
  }
  const problems = diffSchemas(saved, live);
  if (problems.length === 0) {
    console.log(`Schema OK — ${Object.keys(saved.tables).length} WS_ tables match live base ${live.baseId}.`);
    return;
  }
  console.error('SCHEMA DRIFT DETECTED — STOP, report, wait (CLAUDE.md session ritual step 2):');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

main().catch(err => { console.error(err.message); process.exit(2); });
