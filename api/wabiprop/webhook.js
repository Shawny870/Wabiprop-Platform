// /api/wabiprop/webhook.js
// Wabiprop — Rental Agent / Tenant / Contractor WhatsApp Automation
// Reads: WP_Agents, WP_Tenants, WP_Contractors, WP_Issues
// Writes: WP_Issues
// No AI. Deterministic logic only. Solar Geyser Principle.
// BUILD LOG:
//   P1 — GET verification handler + POST router skeleton
//   P2 — Flow 1: tenant issue intake (lookup, create issue, notify tenant + agent)
//   P3 — Flow 2: agent assigns contractor (lookup contractor, patch issue, notify 3 parties)
//   P4 — Separate WP_PHONE_NUMBER_ID env var (Wabiprop) from WA_PHONE_NUMBER_ID (Wabistay)
//   P5 — Axiom HTTP logging added (fire-and-forget, dataset: wabiprop)

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const WA_PHONE_NUMBER_ID = process.env.WP_PHONE_NUMBER_ID;   // Wabiprop-specific Phone ID
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const AXIOM_TOKEN = process.env.AXIOM_TOKEN;

// ─── AXIOM LOGGER ────────────────────────────────────────────────────────────
// Fire-and-forget — never awaited, never blocks the flow
// Dataset: wabiprop · Token via AXIOM_TOKEN env var

function logToAxiom(level, event, detail = {}) {
  if (!AXIOM_TOKEN) return;
  const payload = [{ _time: new Date().toISOString(), level, event, ...detail }];
  fetch('https://api.axiom.co/v1/datasets/wabiprop/ingest', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${AXIOM_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(err => console.error('[Axiom ERROR]', err.message));
}

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
  // Check WP_Agents — field: "Agent Whatsapp number" (note: lowercase 'app' per schema)
  const agentRecords = await airtableGet('WP_Agents', `{Agent Whatsapp number} = '${phone}'`);
  if (agentRecords.length > 0) {
    console.log(`[Router] Identified as AGENT: ${phone}`);
    return { role: 'agent', record: agentRecords[0] };
  }

  // Check WP_Contractors — field: "Phone (whatsApp)"
  const contractorRecords = await airtableGet('WP_Contractors', `{Phone (whatsApp)} = '${phone}'`);
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
  logToAxiom('info', 'flow1_start', { phone, msg: messageText.slice(0, 100) });

  try {
    const f = tenantRecord.fields;
    const tenantName    = (f['Full Name']             || '').trim();
    const unitAddress   = (f['Unit Address']          || '').trim();
    const propertyName  = (f['Property Name']         || '').trim();
    const ownerPhone    = (f['Owner Phone']            || '').trim();
    const agentPhone    = (f['Agent WhatsApp Number'] || '').trim();

    logToAxiom('info', 'flow1_tenant_fields', {
      phone,
      tenantName: tenantName || '(empty)',
      unitAddress: unitAddress || '(empty)',
      propertyName: propertyName || '(empty)',
      agentPhone: agentPhone || '(empty)',
      ownerPhone: ownerPhone || '(empty)',
    });

    // ── Step 1: create WP_Issues record ─────────────────────────────────────
    const issueFields = {
      'Issue Title':            `${tenantName} — ${messageText.slice(0, 60)}`,
      'Description':            messageText,
      'Issue Resolution Status': 'Open',
      'Urgency':                'Routine',
      'Tenant Whatsapp Number': phone,
      'Agent Whatsapp number':  agentPhone,
      'Date Reported':          new Date().toISOString(),
    };

    logToAxiom('info', 'flow1_issue_create_attempt', { phone, issueTitle: issueFields['Issue Title'] });
    const created = await airtableCreate('WP_Issues', issueFields);

    if (!created.id) {
      logToAxiom('error', 'flow1_issue_create_failed', { phone, error: JSON.stringify(created.error || created) });
      throw new Error(`Airtable create returned no record ID. Error: ${JSON.stringify(created.error || created)}`);
    }

    // Issue Ref is an autonumber — Airtable returns it in the created record fields
    const issueRef = created.fields?.['Issue Ref'] || created.id.slice(-6).toUpperCase();
    console.log(`[Flow 1] Issue created — Ref: ${issueRef} | Airtable ID: ${created.id}`);
    logToAxiom('info', 'flow1_issue_created', { phone, issueRef, airtableId: created.id });

    // ── Step 2: acknowledge tenant ───────────────────────────────────────────
    const tenantMsg =
      `Hi ${tenantName}, your maintenance request has been received.\n\n` +
      `Reference: WP-${issueRef}\n` +
      `Issue: ${messageText.slice(0, 80)}${messageText.length > 80 ? '...' : ''}\n\n` +
      `Your agent has been notified and will be in touch shortly. Please do not resend this message.`;

    logToAxiom('info', 'flow1_tenant_ack_attempt', { phone, issueRef });
    const tenantSend = await sendWhatsApp(phone, tenantMsg);
    logToAxiom(tenantSend.error ? 'error' : 'info', 'flow1_tenant_ack_result', {
      phone, issueRef,
      metaError: tenantSend.error ? JSON.stringify(tenantSend.error) : null,
      messageId: tenantSend.messages?.[0]?.id || null,
    });

    // ── Step 3: notify agent ─────────────────────────────────────────────────
    if (!agentPhone) {
      console.warn(`[Flow 1] No agent phone on tenant record — skipping agent notification`);
      logToAxiom('warn', 'flow1_no_agent_phone', { phone, tenantName });
    } else {
      const agentMsg =
        `🔧 New maintenance issue logged.\n\n` +
        `Ref: WP-${issueRef}\n` +
        `Tenant: ${tenantName}\n` +
        `Unit: ${unitAddress || 'unknown'}\n` +
        `Property: ${propertyName || 'unknown'}\n` +
        `Issue: ${messageText}\n\n` +
        `Reply *1* to assign a contractor.`;

      logToAxiom('info', 'flow1_agent_notify_attempt', { phone, agentPhone, issueRef });
      const agentSend = await sendWhatsApp(agentPhone, agentMsg);
      logToAxiom(agentSend.error ? 'error' : 'info', 'flow1_agent_notify_result', {
        phone, agentPhone, issueRef,
        metaError: agentSend.error ? JSON.stringify(agentSend.error) : null,
        messageId: agentSend.messages?.[0]?.id || null,
      });
    }

    console.log(`[Flow 1] Complete — Ref: WP-${issueRef} | Tenant: ${tenantName}`);
    logToAxiom('info', 'flow1_complete', { phone, issueRef, tenantName });

  } catch (err) {
    console.error(`[Flow 1 ERROR]`, err.message);
    logToAxiom('error', 'flow1_error', { phone, error: err.message });
    await alertShawn('Flow 1 (tenant intake)', err.message, phone);
    // Do not send tenant acknowledgement — issue was not confirmed created
  }
}

// ─── FLOW 2a — AGENT REQUESTS CONTRACTOR LIST ───────────────────────────────
// Trigger: agent sends "1" with no pending assignment on their open issue
// Reads:   WP_Issues (most recent Open for this agent), WP_Contractors (all Active)
// Writes:  WP_Issues — Attending Agent + Attending Timestamp (marks pending selection)
// Sends:   1 WhatsApp message — numbered contractor list

async function handleAgentShowContractors(phone, agentRecord) {
  console.log(`[Flow 2a] Show contractors — agent: ${phone}`);

  try {
    // Find most recent Open issue for this agent
    const issueUrl =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent('WP_Issues')}` +
      `?filterByFormula=${encodeURIComponent(`AND({Agent Whatsapp number} = '${phone}', {Issue Resolution Status} = 'Open')`)}` +
      `&sort%5B0%5D%5Bfield%5D=Date%20Reported&sort%5B0%5D%5Bdirection%5D=desc` +
      `&maxRecords=1`;

    const issueRes  = await fetch(issueUrl, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    const issueData = await issueRes.json();
    const openIssues = issueData.records || [];

    if (openIssues.length === 0) {
      await sendWhatsApp(phone, `No open issues found to assign.`);
      return;
    }

    const issue    = openIssues[0];
    const issueId  = issue.id;
    const issueRef = issue.fields['Issue Ref'] || issueId.slice(-6).toUpperCase();

    // Fetch all active contractors, sorted alphabetically — deterministic order
    const contractorRecords = await airtableGet('WP_Contractors', `{Active} = TRUE()`);
    contractorRecords.sort((a, b) =>
      (a.fields['Contractor Name'] || '').localeCompare(b.fields['Contractor Name'] || '')
    );

    if (contractorRecords.length === 0) {
      await sendWhatsApp(phone, `No active contractors available. Please check WP_Contractors.`);
      return;
    }

    const listLines = contractorRecords
      .map((c, i) => `${i + 1} - ${(c.fields['Contractor Name'] || 'Unknown').trim()}`)
      .join('\n');

    const msg =
      `Select a contractor for WP-${issueRef}:\n\n` +
      `${listLines}\n\n` +
      `Reply with a number to assign.`;

    // Mark issue pending — Attending Agent = agent phone
    await airtableUpdate('WP_Issues', issueId, {
      'Attending Agent':     phone,
      'Attending Timestamp': new Date().toISOString(),
    });

    await sendWhatsApp(phone, msg);
    console.log(`[Flow 2a] Contractor list sent for WP-${issueRef}`);

  } catch (err) {
    console.error(`[Flow 2a ERROR]`, err.message);
    await alertShawn('Flow 2a (show contractors)', err.message, phone);
  }
}

// ─── FLOW 2b — AGENT SELECTS CONTRACTOR ─────────────────────────────────────
// Trigger: agent sends a number (1–9) while an Open issue has Attending Agent = their phone
// Reads:   WP_Issues (pending issue), WP_Contractors (sorted alphabetically), WP_Tenants
// Writes:  WP_Issues — Issue Resolution Status, Contractor Name, clears Attending Agent
// Sends:   2 WhatsApp messages — agent confirmation + contractor dispatch

async function handleAgentContractorSelect(phone, selection, agentRecord) {
  console.log(`[Flow 2b] Contractor select — agent: ${phone} | selection: ${selection}`);

  try {
    // Find the Open issue pending assignment for this agent
    const pendingIssues = await airtableGet(
      'WP_Issues',
      `AND({Attending Agent} = '${phone}', {Issue Resolution Status} = 'Open')`
    );

    if (pendingIssues.length === 0) {
      await sendWhatsApp(phone, `No pending assignment found. Reply *1* to see the contractor list.`);
      return;
    }

    const issue       = pendingIssues[0];
    const issueId     = issue.id;
    const issueRef    = issue.fields['Issue Ref'] || issueId.slice(-6).toUpperCase();
    const description = (issue.fields['Description']            || '').trim();
    const tenantPhone = (issue.fields['Tenant Whatsapp Number'] || '').trim();

    // Re-fetch contractors in the same alphabetical order — consistent with Flow 2a
    const contractorRecords = await airtableGet('WP_Contractors', `{Active} = TRUE()`);
    contractorRecords.sort((a, b) =>
      (a.fields['Contractor Name'] || '').localeCompare(b.fields['Contractor Name'] || '')
    );

    const index = parseInt(selection, 10) - 1;  // 1-based → 0-based
    if (isNaN(index) || index < 0 || index >= contractorRecords.length) {
      await sendWhatsApp(phone, `Invalid selection. Reply *1* to see the contractor list again.`);
      return;
    }

    const contractor      = contractorRecords[index];
    const contractorName  = (contractor.fields['Contractor Name']  || '').trim();
    const contractorPhone = (contractor.fields['Phone (whatsApp)'] || '').trim();

    // PATCH issue — assign contractor, clear pending state
    const patched = await airtableUpdate('WP_Issues', issueId, {
      'Issue Resolution Status': 'Contractor Assigned',
      'Contractor Name':         contractorName,
      'Attending Agent':         '',
    });

    if (patched.error) {
      throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);
    }
    console.log(`[Flow 2b] Issue patched — ${contractorName} assigned to WP-${issueRef}`);

    // Resolve tenant name + unit address from WP_Tenants
    let tenantName  = 'Tenant';
    let unitAddress = '';
    if (tenantPhone) {
      const tenantRecords = await airtableGet('WP_Tenants', `{Whatsapp Phone Number} = '${tenantPhone}'`);
      if (tenantRecords.length > 0) {
        tenantName  = (tenantRecords[0].fields['Full Name']    || 'Tenant').trim();
        unitAddress = (tenantRecords[0].fields['Unit Address'] || '').trim();
      }
    }

    // Send agent confirmation
    await sendWhatsApp(phone, `✓ ${contractorName} assigned to WP-${issueRef}. They will be notified.`);

    // Send contractor dispatch
    if (contractorPhone) {
      const contractorMsg =
        `New job assigned.\n\n` +
        `Ref: WP-${issueRef}\n` +
        `Issue: ${description}\n` +
        `Tenant: ${tenantName}\n` +
        `Unit: ${unitAddress || 'see agent for address'}\n` +
        `Tenant contact: ${tenantPhone}\n\n` +
        `Reply ON MY WAY when en route.`;

      await sendWhatsApp(contractorPhone, contractorMsg);
    }

    console.log(`[Flow 2b] Complete — ${contractorName} assigned to WP-${issueRef}`);

  } catch (err) {
    console.error(`[Flow 2b ERROR]`, err.message);
    await alertShawn('Flow 2b (contractor select)', err.message, phone);
  }
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

  logToAxiom('info', 'message_received', { phone, text: text.slice(0, 100) });

  const { role, record } = await identifySender(phone);
  logToAxiom('info', 'sender_identified', { phone, role });

  // ── UNKNOWN SENDER ──────────────────────────────────────────────────────
  if (role === 'unknown') {
    await sendWhatsApp(phone,
      `Sorry, we don't recognise this number. Please contact your agent to get registered.`
    );
    return;
  }

  // ── AGENT COMMANDS ───────────────────────────────────────────────────────
  if (role === 'agent') {
    // Single digit 1–9: contractor selection (if pending) or show list (if "1" with none)
    if (/^[1-9]$/.test(text)) {
      const pendingIssues = await airtableGet(
        'WP_Issues',
        `AND({Attending Agent} = '${phone}', {Issue Resolution Status} = 'Open')`
      );
      if (pendingIssues.length > 0) {
        await handleAgentContractorSelect(phone, text, record);
        return;
      }
      if (text === '1') {
        await handleAgentShowContractors(phone, record);
        return;
      }
      await sendWhatsApp(phone, `No pending selection. Reply *1* to see the contractor list.`);
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
      `Hi! Commands available:\n- Reply *1* — assign contractor to latest open issue\n- *REPORT* — list all open issues\n- *BRIEFING [owner name]* — generate owner intelligence briefing`
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
      `AND({Tenant Whatsapp Number} = '${phone}', {Issue Resolution Status} = 'Pending Confirmation')`
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
