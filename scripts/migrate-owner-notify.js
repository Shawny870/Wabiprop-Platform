// scripts/migrate-owner-notify.js
// One-time migration: WS_Properties.'Notify Phone' → one WS_Owner_Notify row
// per property.
//
// WHY: the incident that prompted this whole feature traced back to
// WS_Properties.'Notify Phone' being read as a single, un-auditable field —
// bad data in that one field silently misrouted an owner notification. The
// fix (see api/wabistay/webhook.js: activeOwnerRecipientsForProperty,
// resolveOwnerNotifyRecipients) moves every owner-report send onto a
// multi-row WS_Owner_Notify table, mirroring the existing WS_Cleaners shape.
// This script is the one-time backfill from the old field into the new
// table — it does NOT delete or blank 'Notify Phone' on WS_Properties (kept
// as a read audit trail; no code path reads it after this migration lands).
//
// WS_Owner_Notify fields this script writes (create WS_Owner_Notify in
// Airtable first, with these exact fields — see docs/env.md for the full
// spec the code assumes):
//   Property     — Link to WS_Properties (single)
//   Phone Number — Single line text
//   Active       — Checkbox (written TRUE)
//   Verified     — Checkbox (written FALSE — see below)
//
// DELIBERATELY UNVERIFIED: every migrated row is created with Verified=false,
// same as a brand-new recipient. CEO decision (not re-litigated here): do NOT
// grandfather migrated numbers in as pre-verified — the incident that
// prompted this specifically involved a WRONG number in 'Notify Phone', so
// migrating it in as already-trusted would reproduce the exact failure mode
// this feature exists to close. Each migrated owner must reply CONFIRM (see
// OWNER_NOTIFY_CONFIRM_KEYWORDS in webhook.js) before hard-gated report sends
// resume for their property — see resolveOwnerNotifyRecipients's own comment
// for why that pause is intentional, not a bug.
//
// SAFE TO RE-RUN: skips any property that already has a WS_Owner_Notify row
// (by Property link), so re-running never creates a duplicate.
//
// NOT RUN as part of this change — no Airtable credentials/access here. To
// run for real once WS_Owner_Notify exists in Airtable:
//   1. Create the WS_Owner_Notify table with the four fields listed above.
//   2. AIRTABLE_API_KEY / AIRTABLE_BASE_ID set in the environment (or a
//      committed-nowhere .env, same as every other script in this repo).
//   3. node scripts/migrate-owner-notify.js
//      (add --dry-run to log the planned creates without writing anything)

require('dotenv').config();

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const DRY_RUN = process.argv.includes('--dry-run');

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('FATAL: AIRTABLE_API_KEY or AIRTABLE_BASE_ID not set.');
  process.exit(1);
}

const BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;
const HEADERS = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  'Content-Type': 'application/json'
};

async function fetchAll(table, fields = []) {
  let records = [];
  let offset = null;

  do {
    const params = new URLSearchParams();
    fields.forEach(f => params.append('fields[]', f));
    if (offset) params.set('offset', offset);

    const url = `${BASE_URL}/${encodeURIComponent(table)}?${params.toString()}`;
    const res = await fetch(url, { headers: HEADERS });
    const data = await res.json();

    if (data.error) throw new Error(`Airtable fetch failed for ${table}: ${data.error.message}`);

    records = records.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);

  console.log(`[Fetch] ${table} — ${records.length} records`);
  return records;
}

async function createOwnerNotifyRow(fields) {
  const url = `${BASE_URL}/${encodeURIComponent('WS_Owner_Notify')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ fields })
  });
  const data = await res.json();
  return { status: res.status, data };
}

// Normalises the raw 'Notify Phone' value the same way webhook.js's existing
// reads of it do (formatPhone: strip spaces/dashes/plus, 0-prefix → 27).
// Kept independent of webhook.js's own formatPhone deliberately — a script
// that imports the module under migration would need the full Vercel runtime
// (fetch polyfills, env shape) it does not otherwise require.
function formatPhone(raw) {
  let clean = String(raw).replace(/[\s\-+]/g, '');
  if (clean.startsWith('0')) clean = '27' + clean.slice(1);
  return clean;
}

async function main() {
  console.log('\n========================================');
  console.log(`  migrate-owner-notify.js — starting${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('========================================\n');

  const properties = await fetchAll('WS_Properties', ['Property Name', 'Notify Phone']);
  const existingRows = await fetchAll('WS_Owner_Notify', ['Property']);

  const alreadyMigrated = new Set();
  for (const row of existingRows) {
    for (const propId of row.fields['Property'] || []) {
      alreadyMigrated.add(propId);
    }
  }

  let skippedNoPhone = 0;
  let skippedAlready = 0;
  let created = 0;
  let failed = 0;

  for (const property of properties) {
    const propertyId = property.id;
    const propertyName = property.fields['Property Name'] || propertyId;
    const rawPhone = (property.fields['Notify Phone'] || '').trim();

    if (alreadyMigrated.has(propertyId)) {
      skippedAlready++;
      console.log(`[SKIP] "${propertyName}" — already has a WS_Owner_Notify row`);
      continue;
    }

    if (!rawPhone) {
      skippedNoPhone++;
      console.log(`[SKIP] "${propertyName}" — Notify Phone is empty, nothing to migrate`);
      continue;
    }

    const phone = formatPhone(rawPhone);
    const fields = {
      'Property': [propertyId],
      'Phone Number': phone,
      'Active': true,
      // Deliberately FALSE — see file header. Migrated numbers are not
      // grandfathered in as pre-verified.
      'Verified': false
    };

    if (DRY_RUN) {
      created++;
      console.log(`[DRY RUN] would create WS_Owner_Notify row for "${propertyName}" → ${phone} (Verified: false)`);
      continue;
    }

    const { status, data } = await createOwnerNotifyRow(fields);
    if (status === 200 && !data.error) {
      created++;
      console.log(`[OK] "${propertyName}" → ${phone} (Verified: false — will need a CONFIRM reply)`);
    } else {
      failed++;
      console.error(`[FAIL] "${propertyName}" | HTTP ${status} | ${JSON.stringify(data.error || data)}`);
    }

    // Stay within Airtable rate limit (5 req/s).
    await new Promise(r => setTimeout(r, 220));
  }

  console.log('\n========================================');
  console.log('  COMPLETE');
  console.log('========================================');
  console.log(`  Total properties:     ${properties.length}`);
  console.log(`  Already migrated:     ${skippedAlready}`);
  console.log(`  Skipped (no phone):   ${skippedNoPhone}`);
  console.log(`  Created:              ${created}`);
  console.log(`  Failed:               ${failed}`);
  console.log('========================================\n');

  if (!DRY_RUN && created > 0) {
    console.log('NEXT STEP: every created row is UNVERIFIED. Trigger');
    console.log('sendOwnerNotifyVerification for each new row (once');
    console.log('WABISTAY_OWNER_NOTIFY_VERIFY_TEMPLATE is approved and set) so');
    console.log('owners can reply CONFIRM and resume receiving reports.\n');
  }
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
