// scripts/seed-links.js
// One-time migration: links WP_Tenants to WP_Units and WP_Properties.
//
// Context: The Email field on WP_Tenants currently stores a unit address string
// (data was loaded into the wrong field). This script:
//   1. Reads all WP_Tenants, WP_Units, WP_Properties
//   2. Matches each tenant's Email value to a WP_Units.Unit Name (exact string)
//   3. PATCHes matched tenant records with Unit Address, Property Name,
//      Owner Phone, Agent WhatsApp Number — then clears Email
//   4. Logs every match, miss, and PATCH result
//
// Run once. Safe to re-run (PATCH is idempotent — clears Email regardless).

require('dotenv').config();

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('FATAL: AIRTABLE_API_KEY or AIRTABLE_BASE_ID not set. Check .env file.');
  process.exit(1);
}

const BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;
const HEADERS = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  'Content-Type': 'application/json'
};

// ─── FETCH ALL RECORDS (handles Airtable pagination) ─────────────────────────

async function fetchAll(table, fields = []) {
  let records = [];
  let offset = null;

  do {
    const params = new URLSearchParams();
    fields.forEach(f => params.append('fields[]', f));
    if (offset) params.set('offset', offset);

    const url = `${BASE_URL}/${encodeURIComponent(table)}?${params.toString()}`;
    console.log(`[Fetch] ${table} — offset: ${offset || 'start'}`);

    const res = await fetch(url, { headers: HEADERS });
    const data = await res.json();

    if (data.error) {
      console.error(`[Airtable ERROR] ${table}:`, JSON.stringify(data.error));
      throw new Error(`Airtable fetch failed for ${table}: ${data.error.message}`);
    }

    records = records.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);

  console.log(`[Fetch] ${table} — total records: ${records.length}`);
  return records;
}

// ─── PATCH ONE TENANT RECORD ──────────────────────────────────────────────────

async function patchTenant(recordId, fields) {
  const url = `${BASE_URL}/${encodeURIComponent('WP_Tenants')}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ fields })
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n========================================');
  console.log('  Wabiprop seed-links.js — starting');
  console.log('========================================\n');

  // ── STEP 1: Fetch WP_Tenants ─────────────────────────────────────────────
  console.log('STEP 1 — Fetching WP_Tenants...');
  const tenantRecords = await fetchAll('WP_Tenants', [
    'Full Name',
    'Whatsapp Phone Number',
    'Email'
  ]);

  // ── STEP 2: Fetch WP_Units ────────────────────────────────────────────────
  console.log('\nSTEP 2 — Fetching WP_Units...');
  const unitRecords = await fetchAll('WP_Units', [
    'Unit Name',
    'Property Name'
  ]);

  // ── STEP 3: Fetch WP_Properties ──────────────────────────────────────────
  console.log('\nSTEP 3 — Fetching WP_Properties...');
  const propertyRecords = await fetchAll('WP_Properties', [
    'Property Name',
    'Owner Whatsapp',
    'Agent Phone'
  ]);

  // ── BUILD LOOKUP MAPS ─────────────────────────────────────────────────────
  // unitsByName: "Unit Name" → unit record
  const unitsByName = {};
  for (const u of unitRecords) {
    const name = (u.fields['Unit Name'] || '').trim();
    if (name) unitsByName[name] = u;
  }

  // propertiesByName: "Property Name" → property record
  const propertiesByName = {};
  for (const p of propertyRecords) {
    const name = (p.fields['Property Name'] || '').trim();
    if (name) propertiesByName[name] = p;
  }

  // unitToProperty: unit name → property record
  // Pattern: every unit name is "{number} {Property Name}" — match by suffix
  // e.g. "4 Acacia Close Boksburg" ends with "Acacia Close Boksburg"
  const unitToProperty = {};
  for (const unitName of Object.keys(unitsByName)) {
    const matchedProperty = Object.keys(propertiesByName).find(propName =>
      unitName.endsWith(propName)
    );
    if (matchedProperty) {
      unitToProperty[unitName] = propertiesByName[matchedProperty];
    } else {
      console.warn(`[MAP WARN] Unit "${unitName}" — no property name suffix match`);
    }
  }
  console.log(`Unit→Property links resolved: ${Object.keys(unitToProperty).length} of ${Object.keys(unitsByName).length}`);

  console.log(`\nUnits indexed: ${Object.keys(unitsByName).length}`);
  console.log(`Properties indexed: ${Object.keys(propertiesByName).length}`);

  // ── STEP 4 + 5 + 6: Match, PATCH, Log ────────────────────────────────────
  console.log('\nSTEP 4/5/6 — Matching and patching tenants...\n');

  let matched = 0;
  let unmatched = 0;
  let patchSuccess = 0;
  let patchFail = 0;

  for (const tenant of tenantRecords) {
    const tenantId   = tenant.id;
    const fullName   = (tenant.fields['Full Name'] || '').trim();
    const phone      = (tenant.fields['Whatsapp Phone Number'] || '').trim();
    const emailField = (tenant.fields['Email'] || '').trim(); // stores unit address

    if (!emailField) {
      console.log(`[SKIP] "${fullName}" (${phone}) — Email field is empty, nothing to migrate`);
      continue;
    }

    // Exact match against Unit Name
    const unitRecord = unitsByName[emailField] || null;

    if (!unitRecord) {
      unmatched++;
      console.log(`[NO MATCH] "${fullName}" (${phone}) — Email value: "${emailField}" — no WP_Units.Unit Name matches`);
      continue;
    }

    matched++;

    // Resolve property via unitToProperty suffix map
    const propertyRecord = unitToProperty[emailField] || null;
    const propertyName   = propertyRecord ? (propertyRecord.fields['Property Name'] || '') : '';
    const ownerPhone     = propertyRecord ? (propertyRecord.fields['Owner Whatsapp'] || '') : '';
    const agentPhone     = propertyRecord ? (propertyRecord.fields['Agent Phone'] || '') : '';

    console.log(`[MATCH] "${fullName}" → Unit: "${emailField}" → Property: "${propertyName || 'NOT FOUND'}"`);
    if (!propertyRecord) {
      console.warn(`  ⚠ Property "${propertyName}" not found in WP_Properties — Owner Phone and Agent Phone will be blank`);
    }

    // Build PATCH payload
    const patchFields = {
      'Unit Address': emailField,       // rename: Email → Unit Address
      'Email': '',                       // clear Email field
    };

    if (propertyName)  patchFields['Property Name']        = propertyName;
    if (ownerPhone)    patchFields['Owner Phone']           = ownerPhone;
    if (agentPhone)    patchFields['Agent WhatsApp Number'] = agentPhone;

    // Execute PATCH
    const { status, data } = await patchTenant(tenantId, patchFields);

    if (status === 200 && !data.error) {
      patchSuccess++;
      console.log(`  ✅ PATCH OK — ${fullName} | Unit Address: "${emailField}" | Property: "${propertyName}" | Owner: "${ownerPhone}" | Agent: "${agentPhone}"`);
    } else {
      patchFail++;
      console.error(`  ❌ PATCH FAILED — ${fullName} | HTTP ${status} | ${JSON.stringify(data.error || data)}`);
    }

    // Small delay to stay within Airtable rate limit (5 req/s)
    await new Promise(r => setTimeout(r, 220));
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('  MIGRATION COMPLETE');
  console.log('========================================');
  console.log(`  Tenants fetched:   ${tenantRecords.length}`);
  console.log(`  Matched to unit:   ${matched}`);
  console.log(`  No match (logged): ${unmatched}`);
  console.log(`  PATCH success:     ${patchSuccess}`);
  console.log(`  PATCH failed:      ${patchFail}`);
  console.log('========================================\n');
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
