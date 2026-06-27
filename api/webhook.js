// /api/webhook.js
// Master router — single Meta webhook URL for all inbound messages on +27730260871
// Identifies sender and forwards to the correct product handler.
// Does NOT contain any flow logic — Solar Geyser Principle.
//
// Routing order:
//   1. WP_Agents / WP_Contractors / WP_Tenants → Wabiprop handler
//   2. WP_Leads with Lead Type set              → stored product handler
//   3. WP_Leads pending (no Lead Type yet)      → re-prompt menu or apply choice
//   4. Unknown (not in any table)               → show product menu, create WP_Leads record
//
// BUILD LOG:
//   R1 — Initial build: WP identity check + WP_Leads session routing + product menu

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const WA_PHONE_NUMBER_ID = process.env.WP_PHONE_NUMBER_ID; // shared physical number
const WA_ACCESS_TOKEN    = process.env.WA_ACCESS_TOKEN;
const WA_VERIFY_TOKEN    = process.env.WA_VERIFY_TOKEN;
const AXIOM_TOKEN        = process.env.AXIOM_TOKEN;

// ─── PRODUCT HANDLERS ────────────────────────────────────────────────────────
// Required at module load. Each exports module.exports = async function handler(req, res).

const wabipropHandler = require('./wabiprop/webhook');
const wabistayHandler = require('./wabistay/webhook');

// ─── AXIOM LOGGER ────────────────────────────────────────────────────────────

function logToAxiom(level, event, detail = {}) {
  if (!AXIOM_TOKEN) return;
  const payload = [{ _time: new Date().toISOString(), level, event, source: 'router', ...detail }];
  fetch('https://api.axiom.co/v1/datasets/wabiprop/ingest', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${AXIOM_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(err => console.error('[Axiom ERROR]', err.message));
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatPhone(raw) {
  let clean = String(raw).replace(/[\s\-\+]/g, '');
  if (clean.startsWith('0')) clean = '27' + clean.slice(1);
  return clean;
}

async function airtableGet(table, filterFormula) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(filterFormula)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
  const data = await res.json();
  if (data.error) console.error(`[Router Airtable ERROR] ${table}:`, JSON.stringify(data.error));
  return data.records || [];
}

async function airtableCreate(table, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  const data = await res.json();
  if (data.error) console.error(`[Router Airtable CREATE ERROR] ${table}:`, JSON.stringify(data.error));
  return data;
}

async function airtableUpdate(table, recordId, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  const data = await res.json();
  if (data.error) console.error(`[Router Airtable UPDATE ERROR] ${table}:`, JSON.stringify(data.error));
  return data;
}

async function sendWhatsApp(to, message) {
  const res = await fetch(`https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } })
  });
  const data = await res.json();
  if (data.error) console.error(`[Router WhatsApp SEND ERROR]:`, JSON.stringify(data.error));
  return data;
}

// ─── WP IDENTITY CHECK ───────────────────────────────────────────────────────
// Returns true if phone is registered in any WP table (agent, contractor, or tenant).
// Checked in the same order as Wabiprop's identifySender() for consistency.
// FIELD NAMES — confirmed from live schema:
//   WP_Agents:      "Agent WhatsApp Number"
//   WP_Contractors: "Phone (WhatsApp)"
//   WP_Tenants:     "Whatsapp Phone Number"  ← lowercase 'app', confirmed

async function isWabipropUser(phone) {
  const agents = await airtableGet('WP_Agents', `{Agent WhatsApp Number} = '${phone}'`);
  if (agents.length > 0) return true;
  const contractors = await airtableGet('WP_Contractors', `{Phone (WhatsApp)} = '${phone}'`);
  if (contractors.length > 0) return true;
  const tenants = await airtableGet('WP_Tenants', `{Whatsapp Phone Number} = '${phone}'`);
  if (tenants.length > 0) return true;
  return false;
}

// ─── PRODUCT MENU ─────────────────────────────────────────────────────────────
// Sent once to any number not found in any registered table.

const PRODUCT_MENU =
  `Hi! Please reply with a number:\n` +
  `1 - Report a maintenance issue\n` +
  `2 - Make a guesthouse booking`;

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {

  // ── GET — Webhook Verification ──────────────────────────────────────────────
  // Both products share WA_VERIFY_TOKEN — pass to either handler.
  if (req.method === 'GET') {
    return wabipropHandler(req, res);
  }

  // ── POST — Inbound Message ──────────────────────────────────────────────────
  if (req.method === 'POST') {

    // Body parse guard
    let body = req.body;
    if (!body) {
      console.error('[Router BODY] req.body undefined');
      return res.status(200).send('OK');
    }
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {
        console.error('[Router BODY] JSON parse failed:', e.message);
        return res.status(200).send('OK');
      }
    }

    // Status updates (delivery receipts, read receipts) — ignore, return 200 immediately
    const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages || messages.length === 0) {
      return res.status(200).send('OK');
    }

    const message     = messages[0];
    const phone       = formatPhone(message.from);
    const messageText = message?.text?.body;

    console.log(`[Router] from: ${phone} | text: ${messageText}`);
    logToAxiom('info', 'router_message_received', { phone, text: (messageText || '').slice(0, 100) });

    // Non-text message — send fallback, return 200
    if (!messageText) {
      await sendWhatsApp(phone, `Please send your message as text. Voice notes and images are not supported yet.`)
        .catch(e => console.error('[Router fallback send failed]', e.message));
      return res.status(200).send('OK');
    }

    try {
      const textLower = messageText.trim().toLowerCase();

      // ── Step 1: check WP registered users ──────────────────────────────────
      const wpUser = await isWabipropUser(phone);
      if (wpUser) {
        logToAxiom('info', 'router_route', { phone, destination: 'wabiprop', reason: 'wp_registered' });
        console.log(`[Router] ${phone} → Wabiprop (registered WP user)`);
        return wabipropHandler(req, res);
      }

      // ── Step 2: check WP_Leads for existing session ─────────────────────────
      // FIELD NAME ASSUMPTION: "Phone Number" — update if Airtable uses a different name
      const leadRecords = await airtableGet('WP_Leads', `{Phone Number} = '${phone}'`);
      const lead = leadRecords[0] || null;
      const leadType = lead ? (lead.fields['Lead Type'] || '').trim() : null;

      // ── Step 2a: lead exists with a confirmed product choice ────────────────
      if (lead && leadType === 'Wabiprop') {
        logToAxiom('info', 'router_route', { phone, destination: 'wabiprop', reason: 'wp_lead' });
        console.log(`[Router] ${phone} → Wabiprop (WP_Lead type: Wabiprop)`);
        return wabipropHandler(req, res);
      }

      if (lead && leadType === 'Wabistay') {
        logToAxiom('info', 'router_route', { phone, destination: 'wabistay', reason: 'ws_lead' });
        console.log(`[Router] ${phone} → Wabistay (WP_Lead type: Wabistay)`);
        return wabistayHandler(req, res);
      }

      // ── Step 2b: lead exists but no product choice yet (menu was shown) ─────
      if (lead && !leadType) {
        if (textLower === '1') {
          await airtableUpdate('WP_Leads', lead.id, { 'Lead Type': 'Wabiprop' });
          logToAxiom('info', 'router_lead_choice', { phone, choice: 'Wabiprop' });
          console.log(`[Router] ${phone} chose Wabiprop — patching lead, forwarding`);
          return wabipropHandler(req, res);
        }
        if (textLower === '2') {
          await airtableUpdate('WP_Leads', lead.id, { 'Lead Type': 'Wabistay' });
          logToAxiom('info', 'router_lead_choice', { phone, choice: 'Wabistay' });
          console.log(`[Router] ${phone} chose Wabistay — patching lead, forwarding`);
          return wabistayHandler(req, res);
        }
        // Sent something other than 1 or 2 — re-prompt
        logToAxiom('info', 'router_menu_reprompt', { phone, received: textLower });
        await sendWhatsApp(phone, PRODUCT_MENU);
        return res.status(200).send('OK');
      }

      // ── Step 3: completely unknown number — show menu, create WP_Leads ──────
      logToAxiom('info', 'router_unknown', { phone });
      console.log(`[Router] ${phone} — unknown, creating WP_Leads record, sending menu`);

      // Create lead record first (fire-and-forget errors logged, don't block menu send)
      airtableCreate('WP_Leads', { 'Phone Number': phone }).catch(e =>
        console.error('[Router WP_Leads CREATE failed]', e.message)
      );

      await sendWhatsApp(phone, PRODUCT_MENU);
      return res.status(200).send('OK');

    } catch (err) {
      console.error('[Router FATAL]', err.message, err.stack);
      logToAxiom('error', 'router_fatal', { phone, error: err.message });
      // Always return 200 — never let Meta retry loop
      return res.status(200).send('OK');
    }
  }

  return res.status(405).send('Method Not Allowed');
};
