// api/wabiprop/_lib/cronHelpers.js
// Shared helpers for Wabiprop scheduled cron functions (api/wabiprop/cron/*.js).
//
// Deliberately NOT imported into api/wabiprop/webhook.js -- that file's own copies
// of these same functions are live and device-tested. Duplicating them here avoids
// any risk of a refactor regressing the working webhook, while still giving every
// cron this session adds (Groups 7, 8, 10, ...) one shared place instead of each
// re-duplicating the same ~60 lines a third and fourth time.

const AIRTABLE_BASE_ID   = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY   = process.env.AIRTABLE_API_KEY;
const WA_PHONE_NUMBER_ID = process.env.WP_PHONE_NUMBER_ID; // Wabiprop-specific Phone ID
const WA_ACCESS_TOKEN    = process.env.WA_ACCESS_TOKEN;
const AXIOM_TOKEN        = process.env.AXIOM_TOKEN;

function logToAxiom(level, event, detail = {}) {
  if (!AXIOM_TOKEN) return;
  const payload = [{ _time: new Date().toISOString(), level, event, ...detail }];
  fetch('https://api.axiom.co/v1/datasets/wabiprop/ingest', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${AXIOM_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(err => console.error('[Axiom ERROR]', err.message));
}

// Follows Airtable's offset-based pagination past the 100-record-per-request
// default -- same fix, same reasoning as the twin copy in webhook.js. See that
// file's comment for the full explanation; kept identical here deliberately.
async function airtableGet(table, filterFormula, options = {}) {
  let baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(filterFormula)}`;
  if (options.sort) {
    options.sort.forEach((s, i) => {
      baseUrl += `&sort%5B${i}%5D%5Bfield%5D=${encodeURIComponent(s.field)}&sort%5B${i}%5D%5Bdirection%5D=${encodeURIComponent(s.direction)}`;
    });
  }
  if (options.maxRecords) {
    baseUrl += `&maxRecords=${options.maxRecords}`;
  }

  let allRecords = [];
  let offset = null;
  let page = 0;
  const MAX_PAGES = 50; // safety cap -- 50 x 100 = 5,000 records; stops a malformed offset from looping forever

  do {
    const url = offset ? `${baseUrl}&offset=${encodeURIComponent(offset)}` : baseUrl;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    const data = await res.json();
    if (data.error) {
      console.error(`[Airtable ERROR] ${table}:`, JSON.stringify(data.error));
      break; // stop paging on error -- return whatever was accumulated, matching prior error-tolerant behaviour
    }
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset || null;
    page++;
  } while (offset && page < MAX_PAGES);

  if (offset && page >= MAX_PAGES) {
    console.warn(`[Airtable GET] ${table} — hit MAX_PAGES safety cap (${MAX_PAGES}) with more data still available.`);
  }

  return allRecords;
}

async function airtableUpdate(table, recordId, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  const data = await res.json();
  if (data.error) console.error(`[Airtable UPDATE ERROR] ${table}:`, JSON.stringify(data.error));
  return data;
}

async function sendWhatsApp(to, message) {
  const res = await fetch(`https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    })
  });
  const data = await res.json();
  if (data.error) console.error(`[WhatsApp SEND ERROR]:`, JSON.stringify(data.error));
  return data;
}

async function alertShawn(cronName, errorMessage) {
  const msg = `WABIPROP CRON ERROR — ${cronName} failed.\nError: ${errorMessage}`;
  await sendWhatsApp('27780384989', msg).catch(e => console.error('[alertShawn failed]', e.message));
}

module.exports = { airtableGet, airtableUpdate, sendWhatsApp, logToAxiom, alertShawn };
