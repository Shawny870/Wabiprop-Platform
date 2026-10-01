// scripts/audit-session-states.js
// Read-only audit: every Session State value the code can write must exist as a
// select option on WS_Guests in the live Airtable base. Run by hand before a
// deploy that adds or renames a state:
//
//   node --env-file=<env file with AIRTABLE_API_KEY and AIRTABLE_BASE_ID> scripts/audit-session-states.js
//
// Offline, the same required-state computation runs in
// test/sessionstateoptions.test.js against scripts/session-state-options.json.
// This script is the live check: it reads the base schema through Airtable's
// metadata API (needs a token with the schema.bases:read scope) and writes
// nothing. Exit code 1 means a state is missing from Airtable.

const fs = require('fs');
const path = require('path');

function requiredStates(root = path.join(__dirname, '..')) {
  const states = JSON.parse(fs.readFileSync(path.join(root, 'states.json'), 'utf8'));
  const required = new Set(['NEW']);
  for (const key of Object.keys(states.states)) if (key !== '*') required.add(key);
  const rows = [...states.global, ...Object.values(states.states).flat()];
  for (const row of rows) if (row.next) required.add(row.next);
  // States the handlers write by literal, outside the state table.
  for (const file of ['api/wabistay/webhook.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of src.matchAll(/'Session State':\s*'([A-Z_]+)'/g)) required.add(m[1]);
  }
  return [...required].sort();
}

async function liveOptions() {
  const base = process.env.AIRTABLE_BASE_ID;
  const key = process.env.AIRTABLE_API_KEY;
  if (!base || !key) throw new Error('AIRTABLE_BASE_ID and AIRTABLE_API_KEY are required');
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${base}/tables`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(`Airtable metadata API: ${JSON.stringify(data.error)} (the token needs schema.bases:read)`);
  const table = data.tables.find(t => t.name === 'WS_Guests');
  const field = table && table.fields.find(f => f.name === 'Session State');
  if (!field || !field.options) throw new Error('WS_Guests.Session State not found');
  return field.options.choices.map(c => c.name);
}

module.exports = { requiredStates };

if (require.main === module) {
  (async () => {
    const required = requiredStates();
    const live = await liveOptions();
    const missing = required.filter(s => !live.includes(s));
    console.log(`Code writes ${required.length} Session State values; Airtable has ${live.length} options.`);
    if (missing.length) {
      console.error(`MISSING in Airtable: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log('OK: every state the code writes exists in Airtable.');
  })().catch(err => { console.error(err.message); process.exit(2); });
}
