// scripts/seed-links.js
// Populates denormalised fields on every WP_Tenants record.
//
// Source of truth: Unit Address (singleLineText, already populated on each tenant).
// Unit Address values are like "4 Acacia Close Boksburg" — the property name is
// matched by suffix against the hardcoded PROPERTY_LOOKUP table.
//
// Fields written to WP_Tenants (all singleLineText — confirmed via Airtable Meta API):
//   Unit Address          — written back idempotently from the read value
//   Property Name         — resolved by suffix match on Unit Address
//   Agent WhatsApp Number — from PROPERTY_LOOKUP
//   Owner Phone           — from PROPERTY_LOOKUP
//
// Safe to re-run. PATCH is idempotent.

require('dotenv').config();

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('FATAL: AIRTABLE_API_KEY or AIRTABLE_BASE_ID not set.');
  process.exit(1);
}

const BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;
const HEADERS  = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  'Content-Type': 'application/json'
};

// ─── HARDCODED PROPERTY LOOKUP ────────────────────────────────────────────────
// Key: property name suffix as it appears in Unit Address values
// Confirmed from CSVs provided by Shawn

const PROPERTY_LOOKUP = {
  'Jacaranda Ave Kempton Park': { agent_phone: '27780384989', owner_phone: '27780384989' },
  'Acacia Close Boksburg':      { agent_phone: '27780384989', owner_phone: '27784896186' },
  'Mokoena Street Vosloorus':   { agent_phone: '27780384989', owner_phone: '27732273477' },
  'Rietfontein Road Benoni':    { agent_phone: '27780384989', owner_phone: '27780384989' },
};

// ─── RESOLVE PROPERTY FROM UNIT ADDRESS ──────────────────────────────────────
// Returns { propertyName, agentPhone, ownerPhone } or null if no match.

function resolveProperty(unitAddress) {
  for (const [propName, phones] of Object.entries(PROPERTY_LOOKUP)) {
    if (unitAddress.endsWith(propName)) {
      return { propertyName: propName, ...phones };
    }
  }
  return null;
}

// ─── FETCH ALL RECORDS (handles Airtable pagination) ─────────────────────────

async function fetchAll(table, fields = []) {
  let records = [];
  let offset  = null;

  do {
    const params = new URLSearchParams();
    fields.forEach(f => params.append('fields[]', f));
    if (offset) params.set('offset', offset);

    const url = `${BASE_URL}/${encodeURIComponent(table)}?${params.toString()}`;
    const res  = await fetch(url, { headers: HEADERS });
    const data = await res.json();

    if (data.error) throw new Error(`Airtable fetch failed for ${table}: ${data.error.message}`);

    records = records.concat(data.records || []);
    offset  = data.offset || null;
  } while (offset);

  console.log(`[Fetch] ${table} — ${records.length} records`);
  return records;
}

// ─── PATCH ONE TENANT RECORD ──────────────────────────────────────────────────

async function patchTenant(recordId, fields) {
  const url = `${BASE_URL}/${encodeURIComponent('WP_Tenants')}/${recordId}`;
  const res  = await fetch(url, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ fields })
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n========================================');
  console.log('  seed-links.js — starting');
  console.log('========================================\n');

  const tenantRecords = await fetchAll('WP_Tenants', [
    'Full Name',
    'Whatsapp Phone Number',
    'Unit Address',
  ]);

  console.log(`\nProcessing ${tenantRecords.length} tenant records...\n`);

  let skipped     = 0;
  let noMatch     = 0;
  let patchSuccess = 0;
  let patchFail   = 0;

  for (const tenant of tenantRecords) {
    const tenantId   = tenant.id;
    const fullName   = (tenant.fields['Full Name']          || '').trim();
    const phone      = (tenant.fields['Whatsapp Phone Number'] || '').trim();
    const unitAddress = (tenant.fields['Unit Address']       || '').trim();

    if (!unitAddress) {
      skipped++;
      console.log(`[SKIP] "${fullName}" (${phone}) — Unit Address is empty`);
      continue;
    }

    const resolved = resolveProperty(unitAddress);

    if (!resolved) {
      noMatch++;
      console.log(`[NO MATCH] "${fullName}" | Unit Address: "${unitAddress}" — no property suffix match`);
      continue;
    }

    const { propertyName, agent_phone, owner_phone } = resolved;

    const patchFields = {
      'Unit Address':          unitAddress,
      'Property Name':         propertyName,
      'Agent WhatsApp Number': agent_phone,
      'Owner Phone':           owner_phone,
    };

    const { status, data } = await patchTenant(tenantId, patchFields);

    if (status === 200 && !data.error) {
      patchSuccess++;
      console.log(`[OK] "${fullName}" → ${propertyName} | agent: ${agent_phone} | owner: ${owner_phone}`);
    } else {
      patchFail++;
      console.error(`[FAIL] "${fullName}" | HTTP ${status} | ${JSON.stringify(data.error || data)}`);
    }

    // Stay within Airtable rate limit (5 req/s)
    await new Promise(r => setTimeout(r, 220));
  }

  console.log('\n========================================');
  console.log('  COMPLETE');
  console.log('========================================');
  console.log(`  Total fetched:    ${tenantRecords.length}`);
  console.log(`  Skipped (empty):  ${skipped}`);
  console.log(`  No match:         ${noMatch}`);
  console.log(`  Patched OK:       ${patchSuccess}`);
  console.log(`  Patch failed:     ${patchFail}`);
  console.log('========================================\n');
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
