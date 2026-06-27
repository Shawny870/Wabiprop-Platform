// /api/wabiprop/webhook.js
// Wabiprop — Rental Agent / Tenant / Contractor WhatsApp Automation
// Reads: WP_Agents, WP_Tenants, WP_Contractors, WP_Issues
// Writes: WP_Issues
// No AI. Deterministic logic only. Solar Geyser Principle.
// BUILD LOG:
//   P1 — GET verification handler + POST router skeleton
//   P2 — Flow 1: tenant issue intake (lookup, create issue, notify tenant + agent)

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;

// ─── AIRTABLE HELPERS ────────────────────────────────────────────────────────

async function airtableGet(table, filterFormula) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(filterFormula)}`;
  console.log(`[Airtable GET] ${table} | ${filterFormula}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  });
  console.log(`[Airtable GET STATUS] ${table} | HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) console.error(`[Airtable ERROR] ${table}:`, JSON.stringify(data.error));
  return data.records || [];
}

async function airtableCreate(table, fields) {
  console.log(`[Airtable CREATE] ${table}`, JSON.stringify(fields));
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  console.log(`[Airtable CREATE STATUS] ${table} | HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) console.error(`[Airtable CREATE ERROR] ${table}:`, JSON.stringify(data.error));
  return data;
}

async function airtableUpdate(table, recordId, fields) {
  console.log(`[Airtable UPDATE] ${table} ${recordId}`, JSON.stringify(fields));
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  console.log(`[Airtable UPDATE STATUS] ${table} | HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) console.error(`[Airtable UPDATE ERROR] ${table}:`, JSON.stringify(data.error));
  return data;
}

// ─── WHATSAPP HELPER ─────────────────────────────────────────────────────────

async function sendWhatsApp(to, message) {
  console.log(`[WhatsApp SEND] to: ${to} | msg: ${message.slice(0, 80)}...`);
  const res = await fetch(`https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    })
  });
  console.log(`[WhatsApp SEND STATUS] HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) console.error(`[WhatsApp SEND ERROR]:`, JSON.stringify(data.error));
  return data;
}

// ─── ALERT SHAWN ON ERROR ────────────────────────────────────────────────────
// Shawn's number is the agent phone — 27780384989

async function alertShawn(flowName, errorMessage, senderPhone) {
  const msg = `WABIPROP ERROR — ${flowName} failed.\nSender: ${senderPhone}\nError: ${errorMessage}`;
  await sendWhatsApp('27780384989', msg).catch(e => console.error('[alertShawn failed]', e.message));
}

// ─── FORMAT PHONE ─────────────────────────────────────────────────────────────

function formatPhone(raw) {
  let clean = String(raw).replace(/[\s\-\+]/g, '');
  if (clean.startsWith('0')) clean = '27' + clean.slice(1);
  return clean;
}

// ─── SENDER IDENTIFICATION ───────────────────────────────────────────────────
// Router checks Agents → Contractors → Tenants in that order.
// Returns { role: 'agent'|'contractor'|'tenant'|'unknown', record: <airtable record or null> }

async function identifySender(phone) {
  // Check WP_Agents — field: "Agent WhatsApp Number" (note: lowercase 'app' per schema)
  const agentRecords = await airtableGet('WP_Agents', `{Agent WhatsApp Number} = '${phone}'`);
  if (agentRecords.length > 0) {
    console.log(`[Router] Identified as AGENT: ${phone}`);
    return { role: 'agent', record: agentRecords[0] };
  }

  // Check WP_Contractors — field: "Phone (WhatsApp)"
  const contractorRecords = await airtableGet('WP_Contractors', `{Phone (WhatsApp)} = '${phone}'`);
  if (contractorRecords.length > 0) {
    console.log(`[Router] Identified as CONTRACTOR: ${phone}`);
    return { role: 'contractor', record: contractorRecords[0] };
  }

  // Check WP_Tenants — field: "Whatsapp Phone Number" (lowercase 'app' — confirmed live)
  const tenantRecords = await airtableGet('WP_Tenants', `{Whatsapp Phone Number} = '${phone}'`);
  if (tenantRecords.length > 0) {
    console.log(`[Router] Identified as TENANT: ${phone}`);
    return { role: 'tenant', record: tenantRecords[0] };
  }

  console.log(`[Router] UNKNOWN sender: ${phone}`);
  return { role: 'unknown', record: null };
}

// ─── FLOW STUBS ──────────────────────────────────────────────────────────────
// These will be replaced with full implementations in P2–P8.
// They are stubs only — they log and send a placeholder reply.

// ─── FLOW 1 — TENANT ISSUE INTAKE ───────────────────────────────────────────
// Trigger: any text message from a registered tenant
// Reads:   WP_Tenants (already fetched by router — passed in as tenantRecord)
// Writes:  WP_Issues (creates new record, Status = Open)
// Sends:   2 WhatsApp messages — tenant acknowledgement + agent notification
// Error:   logs to console + alerts Shawn, never sends tenant ack if create failed

async function handleTenantIssue(phone, messageText, tenantRecord) {
  console.log(`[Flow 1] Tenant intake — phone: ${phone}`);

  try {
    const f = tenantRecord.fields;
    const tenantName    = (f['Full Name']             || '').trim();
    const unitAddress   = (f['Unit Address']          || '').trim();
    const propertyName  = (f['Property Name']         || '').trim();
    const ownerPhone    = (f['Owner Phone']            || '').trim();
    const agentPhone    = (f['Agent WhatsApp Number'] || '').trim();

    // ── Step 1: create WP_Issues record ─────────────────────────────────────
    const issueFields = {
      'Issue Title':            `${tenantName} — ${messageText.slice(0, 60)}`,
      'Description':            messageText,
      'Status':                 'Open',
      'Urgency':                'Routine',
      'Tenant WhatsApp Number': phone,
      'Agent WhatsApp Number':  agentPhone,
      'Property Name':          propertyName,
      'Date Reported':          new Date().toISOString(),
    };

    // Include owner phone if present — needed for V2 cron queries
    if (ownerPhone) issueFields['Owner Phone'] = ownerPhone;

    const created = await airtableCreate('WP_Issues', issueFields);

    if (!created.id) {
      throw new Error(`Airtable create returned no record ID. Error: ${JSON.stringify(created.error || created)}`);
    }

    // Issue Ref is an autonumber — Airtable returns it in the created record fields
    const issueRef = created.fields?.['Issue Ref'] || created.id.slice(-6).toUpperCase();
    console.log(`[Flow 1] Issue created — Ref: ${issueRef} | Airtable ID: ${created.id}`);

    // ── Step 2: acknowledge tenant ───────────────────────────────────────────
    const tenantMsg =
      `Hi ${tenantName}, your maintenance request has been received.\n\n` +
      `Reference: WP-${issueRef}\n` +
      `Issue: ${messageText.slice(0, 80)}${messageText.length > 80 ? '...' : ''}\n\n` +
      `Your agent has been notified and will be in touch shortly. Please do not resend this message.`;

    await sendWhatsApp(phone, tenantMsg);

    // ── Step 3: notify agent ─────────────────────────────────────────────────
    if (!agentPhone) {
      console.warn(`[Flow 1] No agent phone on tenant record — skipping agent notification`);
    } else {
      const agentMsg =
        `🔧 New maintenance issue logged.\n\n` +
        `Ref: WP-${issueRef}\n` +
        `Tenant: ${tenantName}\n` +
        `Unit: ${unitAddress || 'unknown'}\n` +
        `Property: ${propertyName || 'unknown'}\n` +
        `Issue: ${messageText}\n\n` +
        `Reply *Assign [contractor name]* to dispatch.`;

      await sendWhatsApp(agentPhone, agentMsg);
    }

    console.log(`[Flow 1] Complete — Ref: WP-${issueRef} | Tenant: ${tenantName}`);

  } catch (err) {
    console.error(`[Flow 1 ERROR]`, err.message);
    await alertShawn('Flow 1 (tenant intake)', err.message, phone);
    // Do not send tenant acknowledgement — issue was not confirmed created
  }
}

async function handleAgentAssign(phone, messageText, agentRecord) {
  console.log(`[Flow 2] Agent assign — phone: ${phone} | msg: ${messageText}`);
  // P3: full implementation here
  await sendWhatsApp(phone, `[STUB] Assign command received. Flow 2 not yet built.`);
}

async function handleAgentReport(phone, agentRecord) {
  console.log(`[Flow 6] Agent REPORT — phone: ${phone}`);
  // P7: full implementation here
  await sendWhatsApp(phone, `[STUB] REPORT command received. Flow 6 not yet built.`);
}

async function handleAgentBriefing(phone, messageText, agentRecord) {
  console.log(`[V2-4] Agent BRIEFING — phone: ${phone} | msg: ${messageText}`);
  // V2: full implementation here
  await sendWhatsApp(phone, `[STUB] BRIEFING command received. V2-4 not yet built.`);
}

async function handleContractorEnRoute(phone, contractorRecord) {
  console.log(`[Flow 3] Contractor en route — phone: ${phone}`);
  // P4: full implementation here
  await sendWhatsApp(phone, `[STUB] En route acknowledged. Flow 3 not yet built.`);
}

async function handleContractorDone(phone, contractorRecord) {
  console.log(`[Flow 4] Contractor done — phone: ${phone}`);
  // P5: full implementation here
  await sendWhatsApp(phone, `[STUB] Job done acknowledged. Flow 4 not yet built.`);
}

async function handleContractorEscalation(phone, contractorRecord) {
  console.log(`[Flow 5] Contractor escalation — phone: ${phone}`);
  // P6: full implementation here
  await sendWhatsApp(phone, `[STUB] Needs assessment received. Flow 5 not yet built.`);
}

async function handleTenantClosure(phone, messageText, tenantRecord) {
  console.log(`[Flow 4b/4c] Tenant closure response — phone: ${phone} | msg: ${messageText}`);
  // P5: full implementation here (folded into Flow 4 build)
  await sendWhatsApp(phone, `[STUB] Closure response received. Flow 4b/4c not yet built.`);
}

// ─── POST ROUTER ─────────────────────────────────────────────────────────────

async function routeMessage(phone, messageText) {
  const text = messageText.trim();
  const textLower = text.toLowerCase();

  const { role, record } = await identifySender(phone);

  // ── UNKNOWN SENDER ──────────────────────────────────────────────────────
  if (role === 'unknown') {
    await sendWhatsApp(phone,
      `Sorry, we don't recognise this number. Please contact your agent to get registered.`
    );
    return;
  }

  // ── AGENT COMMANDS ───────────────────────────────────────────────────────
  if (role === 'agent') {
    if (textLower.startsWith('assign ')) {
      await handleAgentAssign(phone, text, record);
      return;
    }
    if (textLower === 'report') {
      await handleAgentReport(phone, record);
      return;
    }
    if (textLower.startsWith('briefing ')) {
      await handleAgentBriefing(phone, text, record);
      return;
    }
    // Agent sent something unrecognised
    await sendWhatsApp(phone,
      `Hi! Commands available:\n- *Assign [contractor name]* — assign contractor to latest open issue\n- *REPORT* — list all open issues\n- *BRIEFING [owner name]* — generate owner intelligence briefing`
    );
    return;
  }

  // ── CONTRACTOR COMMANDS ──────────────────────────────────────────────────
  if (role === 'contractor') {
    const enRouteKeywords = ['on my way', 'omw', 'coming now', 'leaving now', 'heading there', 'on my way!'];
    const doneKeywords = ['done', 'done!', 'complete', 'completed', 'finished', 'job done', 'all done'];
    const escalateKeywords = ['needs assessment'];

    if (enRouteKeywords.includes(textLower)) {
      await handleContractorEnRoute(phone, record);
      return;
    }
    if (doneKeywords.includes(textLower)) {
      await handleContractorDone(phone, record);
      return;
    }
    if (escalateKeywords.includes(textLower)) {
      await handleContractorEscalation(phone, record);
      return;
    }
    // Contractor sent something unrecognised
    await sendWhatsApp(phone,
      `Hi! Send one of the following:\n- *on my way* — when you are en route\n- *done* — when the job is complete\n- *needs assessment* — if owner decision is required`
    );
    return;
  }

  // ── TENANT MESSAGES ──────────────────────────────────────────────────────
  if (role === 'tenant') {
    // Check if tenant has a pending-confirmation issue — if so, this is Flow 4b/4c
    const pendingIssues = await airtableGet(
      'WP_Issues',
      `AND({Tenant WhatsApp Number} = '${phone}', {Status} = 'Pending Confirmation')`
    );
    if (pendingIssues.length > 0 && (textLower === 'yes' || textLower === '1' || textLower === 'no' || textLower === '2')) {
      await handleTenantClosure(phone, text, record);
      return;
    }
    // Any other tenant message = new issue intake (Flow 1)
    await handleTenantIssue(phone, text, record);
    return;
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {

  // ── R1: GET — Webhook Verification ─────────────────────────────────────
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    console.log(`[GET] mode: ${mode} | token match: ${token === WA_VERIFY_TOKEN}`);
    if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
      console.log('[Webhook] Verified successfully');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // ── R2: POST — Inbound Messages ────────────────────────────────────────
  if (req.method === 'POST') {
    // Body parse guard — mirrors F1 fix from Wabistay
    let body = req.body;
    if (!body) {
      console.error('[BODY] req.body undefined — body parser did not run');
      return res.status(200).send('OK');
    }
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        console.error('[BODY] Failed to parse body string:', e.message);
        return res.status(200).send('OK');
      }
    }

    const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages;
    console.log(`[POST] messages: ${messages?.length || 0}`);

    // Not a message event (delivery receipt, read receipt, status update) — ignore
    if (!messages || messages.length === 0) {
      return res.status(200).send('OK');
    }

    const message = messages[0];
    const from = formatPhone(message.from);
    const messageText = message?.text?.body;

    console.log(`[POST] from: ${from} | text: ${messageText}`);

    // Non-text message (image, voice note, sticker) — send fallback, return 200
    if (!messageText) {
      await sendWhatsApp(from,
        `Please send your message as text. Voice notes and images are not supported yet.`
      ).catch(e => console.error('[fallback send failed]', e.message));
      return res.status(200).send('OK');
    }

    // Route the message — always return 200 to Meta regardless of outcome
    try {
      await routeMessage(from, messageText);
    } catch (err) {
      console.error('[FATAL]', err.message, err.stack);
      await alertShawn('Router', err.message, from).catch(() => {});
    }

    return res.status(200).send('OK');
  }

  return res.status(405).send('Method Not Allowed');
};
