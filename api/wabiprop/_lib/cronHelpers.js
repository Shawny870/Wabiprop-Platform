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

async function airtableGet(table, filterFormula, options = {}) {
  let url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(filterFormula)}`;
  if (options.sort) {
    options.sort.forEach((s, i) => {
      url += `&sort%5B${i}%5D%5Bfield%5D=${encodeURIComponent(s.field)}&sort%5B${i}%5D%5Bdirection%5D=${encodeURIComponent(s.direction)}`;
    });
  }
  if (options.maxRecords) {
    url += `&maxRecords=${options.maxRecords}`;
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
  const data = await res.json();
  if (data.error) console.error(`[Airtable ERROR] ${table}:`, JSON.stringify(data.error));
  return data.records || [];
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
