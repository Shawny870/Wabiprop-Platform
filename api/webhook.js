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

// ─── PHONE NUMBER ID DISPATCH CONSTANTS ─────────────────────────────────────
// Two separate WABAs. Routing is decided by the receiving phone_number_id,
// not by sender identity lookup. Confirmed by Design Engineer — Option A.
//
// 11 Jul 2026 cutover (Builder_Brief_Complete_Cutover.md): Wabiprop's number
// was reassigned to Wabistay as its permanent production number. Wabiprop's
// WhatsApp integration is PARKED (not migrated) until a replacement number is
// sourced — WP_PHONE_NUMBER_ID_CONST is null until then. Do not remove the
// WP_Leads dispatch branch below; it is needed again once a number lands.
const WP_PHONE_NUMBER_ID_CONST = null; // Wabiprop parked — no number assigned. Update when sourced.
const WS_PHONE_NUMBER_ID_CONST = '1157302750805659';

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

    // Receiving phone_number_id — determines which WABA/product this message belongs to
    const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

    // B3: delivery-status callbacks (sent/delivered/read/failed) — Meta sends these
    // on the same `messages` webhook field, shaped as `value.statuses` instead of
    // `value.messages`. This router is the single Meta-configured entry point, and
    // it short-circuits below before ever forwarding to a product handler — so this
    // is the only place a status callback can be observed for traffic routed here.
    const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;
    if (statuses && statuses.length > 0) {
      for (const s of statuses) {
        const detail = { wamid: s.id, status: s.status, timestamp: s.timestamp, recipient: s.recipient_id, phone_number_id: phoneNumberId };
        if (s.status === 'failed' && s.errors) detail.errors = s.errors;
        logToAxiom('info', 'whatsapp_status_callback', detail);
      }
      return res.status(200).send('OK');
    }

    // Neither a status callback nor a message — genuinely empty/unsupported payload
    const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages || messages.length === 0) {
      return res.status(200).send('OK');
    }

    const message     = messages[0];
    const phone       = formatPhone(message.from);
    const messageText = message?.text?.body;

    console.log(`[Router] from: ${phone} | text: ${messageText} | phone_number_id: ${phoneNumberId}`);
    logToAxiom('info', 'router_message_received', { phone, phone_number_id: phoneNumberId, text: (messageText || '').slice(0, 100) });

    // Non-text message — send fallback, return 200
    if (!messageText) {
      await sendWhatsApp(phone, `Please send your message as text. Voice notes and images are not supported yet.`)
        .catch(e => console.error('[Router fallback send failed]', e.message));
      return res.status(200).send('OK');
    }

    try {
      const textLower = messageText.trim().toLowerCase();

      // ── Wabistay path — dispatch by phone_number_id, no further routing needed ──
      if (phoneNumberId === WS_PHONE_NUMBER_ID_CONST) {
        logToAxiom('info', 'router_route', { phone, phone_number_id: phoneNumberId, destination: 'wabistay', reason: 'phone_number_id_match' });
        console.log(`[Router] ${phone} → Wabistay (phone_number_id: ${phoneNumberId})`);
        return wabistayHandler(req, res);
      }

      // ── Wabiprop path — dispatch by phone_number_id, WP_Leads menu stays as fallback ──
      if (phoneNumberId === WP_PHONE_NUMBER_ID_CONST) {

        // FIELD NAME ASSUMPTION: "Phone Number" — update if Airtable uses a different name
        const leadRecords = await airtableGet('WP_Leads', `{Phone Number} = '${phone}'`);
        const lead = leadRecords[0] || null;
        const leadType = lead ? (lead.fields['Lead Type'] || '').trim() : null;

        // ── lead exists with a confirmed product choice ────────────────
        if (lead && leadType === 'Wabiprop') {
          logToAxiom('info', 'router_route', { phone, phone_number_id: phoneNumberId, destination: 'wabiprop', reason: 'wp_lead' });
          console.log(`[Router] ${phone} → Wabiprop (WP_Lead type: Wabiprop)`);
          return wabipropHandler(req, res);
        }

        if (lead && leadType === 'Wabistay') {
          logToAxiom('info', 'router_route', { phone, phone_number_id: phoneNumberId, destination: 'wabistay', reason: 'ws_lead' });
          console.log(`[Router] ${phone} → Wabistay (WP_Lead type: Wabistay)`);
          return wabistayHandler(req, res);
        }

        // ── lead exists but no product choice yet (menu was shown) ─────
        if (lead && !leadType) {
          if (textLower === '1') {
            await airtableUpdate('WP_Leads', lead.id, { 'Lead Type': 'Wabiprop' });
            logToAxiom('info', 'router_lead_choice', { phone, phone_number_id: phoneNumberId, choice: 'Wabiprop' });
            console.log(`[Router] ${phone} chose Wabiprop — patching lead, forwarding`);
            return wabipropHandler(req, res);
          }
          if (textLower === '2') {
            await airtableUpdate('WP_Leads', lead.id, { 'Lead Type': 'Wabistay' });
            logToAxiom('info', 'router_lead_choice', { phone, phone_number_id: phoneNumberId, choice: 'Wabistay' });
            console.log(`[Router] ${phone} chose Wabistay — patching lead, forwarding`);
            return wabistayHandler(req, res);
          }
          // Sent something other than 1 or 2 — re-prompt
          logToAxiom('info', 'router_menu_reprompt', { phone, phone_number_id: phoneNumberId, received: textLower });
          await sendWhatsApp(phone, PRODUCT_MENU);
          return res.status(200).send('OK');
        }

        // ── completely unknown number — show menu, create WP_Leads ──────
        logToAxiom('info', 'router_unknown', { phone, phone_number_id: phoneNumberId });
        console.log(`[Router] ${phone} — unknown, creating WP_Leads record, sending menu`);

        // Create lead record first (fire-and-forget errors logged, don't block menu send)
        airtableCreate('WP_Leads', { 'Phone Number': phone }).catch(e =>
          console.error('[Router WP_Leads CREATE failed]', e.message)
        );

        await sendWhatsApp(phone, PRODUCT_MENU);
        return res.status(200).send('OK');
      }

      // ── Neither known phone_number_id — log and drop ──────────────────────
      console.error(`[Router] Unknown phone_number_id: ${phoneNumberId}`);
      logToAxiom('error', 'router_unknown_number_id', { phone, phone_number_id: phoneNumberId });
      return res.status(200).send('OK');

    } catch (err) {
      console.error('[Router FATAL]', err.message, err.stack);
      logToAxiom('error', 'router_fatal', { phone, phone_number_id: phoneNumberId, error: err.message });
      // Always return 200 — never let Meta retry loop
      return res.status(200).send('OK');
    }
  }

  return res.status(405).send('Method Not Allowed');
};
