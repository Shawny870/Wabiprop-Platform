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
//   P6 — Flow 2 hardened (FM-006/FM-007/FM-009 confirmed clean), Flow 2c added (contractor
//        confirms receipt), Flow 3 built (contractor en route), Flow 4 + 4b + 4c built
//        (contractor done → tenant satisfaction confirmation → close or reopen)
//        Schema confirmed live from Meta API 30 June 2026.
//
// FIELD NAME REFERENCE — pulled from Airtable Meta API 30 June 2026:
//   WP_Issues: "Issue Resolution Status", "Tenant Whatsapp Number", "Agent Whatsapp number"
//              (lowercase 'app', lowercase 'n'), "Contractor Name", "Property Name" (READ ONLY
//              — multipleLookupValues), "Contractor Arrived Timestamp", "Contractor Completed
//              Timestamp", "Date Resolved", "Satisfaction", "Issue Ref", "Date Reported"
//   WP_Tenants: "Full Name", "Whatsapp Phone Number", "Unit Address", "Property Name",
//               "Agent WhatsApp Number" (capital W, A, N), "Owner Phone"
//   WP_Agents: "Agent Whatsapp number" (lowercase 'app', lowercase 'n'), "Active"
//   WP_Contractors: "Contractor Name", "Phone (whatsApp)" (lowercase 'w'), "Active"

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

// ─── AIRTABLE ISSUE LOOKUP FOR CONTRACTOR ─────────────────────────────────────
// Used by Flows 2c, 3, 4 — finds the most recent issue in the given statuses
// for a contractor identified by name.

async function getContractorActiveIssue(contractorName, statuses) {
  const statusFilters = statuses.map(s => `{Issue Resolution Status} = '${s}'`).join(', ');
  const formula = `AND({Contractor Name} = '${contractorName}', OR(${statusFilters}))`;
  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent('WP_Issues')}` +
    `?filterByFormula=${encodeURIComponent(formula)}` +
    `&sort%5B0%5D%5Bfield%5D=Date%20Reported&sort%5B0%5D%5Bdirection%5D=desc` +
    `&maxRecords=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
  const data = await res.json();
  if (data.error) console.error('[getContractorActiveIssue ERROR]', JSON.stringify(data.error));
  return (data.records || [])[0] || null;
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
  // WP_Agents — field: "Agent Whatsapp number" (lowercase 'app', lowercase 'n' — confirmed Meta API 30 Jun 2026)
  const agentRecords = await airtableGet('WP_Agents', `{Agent Whatsapp number} = '${phone}'`);
  if (agentRecords.length > 0) {
    console.log(`[Router] Identified as AGENT: ${phone}`);
    return { role: 'agent', record: agentRecords[0] };
  }

  // WP_Contractors — field: "Phone (whatsApp)" (lowercase 'w', capital 'A' — confirmed Meta API 30 Jun 2026, FM-007)
  const contractorRecords = await airtableGet('WP_Contractors', `{Phone (whatsApp)} = '${phone}'`);
  if (contractorRecords.length > 0) {
    console.log(`[Router] Identified as CONTRACTOR: ${phone}`);
    return { role: 'contractor', record: contractorRecords[0] };
  }

  // WP_Tenants — field: "Whatsapp Phone Number" (confirmed Meta API 30 Jun 2026)
  const tenantRecords = await airtableGet('WP_Tenants', `{Whatsapp Phone Number} = '${phone}'`);
  if (tenantRecords.length > 0) {
    console.log(`[Router] Identified as TENANT: ${phone}`);
    return { role: 'tenant', record: tenantRecords[0] };
  }

  console.log(`[Router] UNKNOWN sender: ${phone}`);
  return { role: 'unknown', record: null };
}

// ─── FLOW 1 — TENANT ISSUE INTAKE ───────────────────────────────────────────
// Trigger: any text message from a registered tenant (not a closure response)
// Reads:   WP_Tenants (already fetched by router — passed in as tenantRecord)
// Writes:  WP_Issues (creates new record, Status = Open)
// Sends:   tenant acknowledgement + agent notification
// Error:   logs to console + alerts Shawn, never sends tenant ack if create failed

async function handleTenantIssue(phone, messageText, tenantRecord) {
  console.log(`[Flow 1] Tenant intake — phone: ${phone}`);
  logToAxiom('info', 'flow1_start', { phone, msg: messageText.slice(0, 100) });

  try {
    const f = tenantRecord.fields;
    // WP_Tenants field names — confirmed Meta API 30 Jun 2026
    const tenantName    = (f['Full Name']             || '').trim();
    const unitAddress   = (f['Unit Address']          || '').trim();
    const propertyName  = (f['Property Name']         || '').trim();
    const ownerPhone    = (f['Owner Phone']            || '').trim();
    const agentPhone    = (f['Agent WhatsApp Number'] || '').trim();
    // Note: WP_Tenants uses "Agent WhatsApp Number" (capital W, A, N)
    // WP_Issues uses "Agent Whatsapp number" (lowercase 'app', lowercase 'n') — different field, different casing

    logToAxiom('info', 'flow1_tenant_fields', {
      phone,
      tenantName: tenantName || '(empty)',
      unitAddress: unitAddress || '(empty)',
      propertyName: propertyName || '(empty)',
      agentPhone: agentPhone || '(empty)',
      ownerPhone: ownerPhone || '(empty)',
    });

    // ── Step 1: create WP_Issues record ─────────────────────────────────────
    // Property Name is NOT written here — it is a multipleLookupValues field (read-only, FM-009)
    const issueFields = {
      'Issue Title':             `${tenantName} — ${messageText.slice(0, 60)}`,
      'Description':             messageText,
      'Issue Resolution Status': 'Open',
      'Urgency':                 'Routine',
      'Tenant Whatsapp Number':  phone,
      'Agent Whatsapp number':   agentPhone,
      'Date Reported':           new Date().toISOString(),
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
// Trigger: agent sends "1"
// Reads:   WP_Issues (most recent Open for this agent), WP_Contractors (all Active)
// Writes:  nothing — list is stateless; selection arrives as "Assign N" command
// Sends:   numbered contractor list

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
      `Reply *Assign N* (e.g. Assign 2) to confirm.`;

    await sendWhatsApp(phone, msg);
    console.log(`[Flow 2a] Contractor list sent for WP-${issueRef}`);

  } catch (err) {
    console.error(`[Flow 2a ERROR]`, err.message);
    await alertShawn('Flow 2a (show contractors)', err.message, phone);
  }
}

// ─── FLOW 2b — AGENT SELECTS CONTRACTOR ─────────────────────────────────────
// Trigger: agent sends "Assign N" (e.g. "Assign 2")
// Reads:   WP_Issues (most recent Open for this agent), WP_Contractors (sorted alphabetically), WP_Tenants
// Writes:  WP_Issues — Issue Resolution Status, Contractor Name
// Sends:   agent confirmation + contractor dispatch (with job receipt prompt)
// Note:    Property Name is NOT written to WP_Issues (multipleLookupValues — read-only, FM-009)
//          Unit Address is read from WP_Tenants, not WP_Issues (FM-006)

async function handleAgentContractorSelect(phone, selection, agentRecord) {
  console.log(`[Flow 2b] Contractor select — agent: ${phone} | selection: ${selection}`);

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
      await sendWhatsApp(phone, `No open issues found. Nothing to assign.`);
      return;
    }

    const issue       = openIssues[0];
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
    // "Phone (whatsApp)" — lowercase 'w', confirmed Meta API 30 Jun 2026 (FM-007)
    const contractorPhone = (contractor.fields['Phone (whatsApp)'] || '').trim();

    // PATCH issue — assign contractor
    // Note: "Contractor Phone" does NOT exist on WP_Issues (confirmed Meta API 30 Jun 2026)
    //       Only Contractor Name is written here. Phone comes from WP_Contractors lookup.
    const patched = await airtableUpdate('WP_Issues', issueId, {
      'Issue Resolution Status': 'Contractor Assigned',
      'Contractor Name':         contractorName,
    });

    if (patched.error) {
      throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);
    }
    console.log(`[Flow 2b] Issue patched — ${contractorName} assigned to WP-${issueRef}`);

    // Resolve tenant name + unit address from WP_Tenants
    // Unit Address lives on WP_Tenants, NOT on WP_Issues (FM-006)
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
    await sendWhatsApp(phone, `✓ ${contractorName} assigned to WP-${issueRef}. They will be notified now.`);

    // Send contractor dispatch
    if (contractorPhone) {
      const contractorMsg =
        `New job assigned to you.\n\n` +
        `Ref: WP-${issueRef}\n` +
        `Issue: ${description}\n` +
        `Tenant: ${tenantName}\n` +
        `Unit: ${unitAddress || 'contact agent for address'}\n` +
        `Tenant contact: ${tenantPhone || 'contact agent'}\n\n` +
        `Reply with a number:\n` +
        `1 — Confirm you have received this job\n` +
        `ON MY WAY — when you are heading to the property\n` +
        `DONE — when the job is complete`;

      await sendWhatsApp(contractorPhone, contractorMsg);
    }

    console.log(`[Flow 2b] Complete — ${contractorName} assigned to WP-${issueRef}`);

  } catch (err) {
    console.error(`[Flow 2b ERROR]`, err.message);
    await alertShawn('Flow 2b (contractor select)', err.message, phone);
  }
}

// ─── FLOW 2c — CONTRACTOR CONFIRMS JOB RECEIPT ──────────────────────────────
// Trigger: contractor replies "1" or "confirmed" after receiving dispatch
// Reads:   WP_Issues (most recent Contractor Assigned for this contractor), WP_Tenants
// Writes:  nothing (status is already Contractor Assigned — no state change yet)
// Sends:   tenant notification (contractor confirmed, will contact) + agent confirmation + contractor reply

async function handleContractorConfirmReceipt(phone, contractorRecord) {
  const contractorName = (contractorRecord.fields['Contractor Name'] || '').trim();
  console.log(`[Flow 2c] Contractor confirms receipt — phone: ${phone} | ${contractorName}`);
  logToAxiom('info', 'flow2c_start', { phone, contractorName });

  try {
    const issue = await getContractorActiveIssue(contractorName, ['Contractor Assigned']);

    if (!issue) {
      await sendWhatsApp(phone,
        `No assigned job found. If you received a job dispatch, contact your agent directly.`
      );
      return;
    }

    const issueRef    = issue.fields['Issue Ref'] || issue.id.slice(-6).toUpperCase();
    const tenantPhone = (issue.fields['Tenant Whatsapp Number'] || '').trim();
    const agentPhone  = (issue.fields['Agent Whatsapp number']  || '').trim();

    // Get tenant name from WP_Tenants (FM-006 — tenant data lives there, not on WP_Issues)
    let tenantName = 'The tenant';
    if (tenantPhone) {
      const tenantRecs = await airtableGet('WP_Tenants', `{Whatsapp Phone Number} = '${tenantPhone}'`);
      if (tenantRecs.length > 0) tenantName = (tenantRecs[0].fields['Full Name'] || 'The tenant').trim();
    }

    // Notify tenant that contractor has confirmed and will be in touch
    if (tenantPhone) {
      await sendWhatsApp(tenantPhone,
        `Update on your maintenance request (Ref: WP-${issueRef}).\n\n` +
        `${contractorName} has confirmed your job and will contact you to arrange access.\n\n` +
        `Please keep your phone available.`
      );
    }

    // Confirm to agent
    if (agentPhone) {
      await sendWhatsApp(agentPhone,
        `✓ WP-${issueRef}: ${contractorName} confirmed the job. ${tenantName} has been notified. Awaiting arrival.`
      );
    }

    // Reply to contractor
    await sendWhatsApp(phone,
      `Confirmed. ${tenantName} has been notified that you will make contact.\n\n` +
      `Ref: WP-${issueRef}\n\n` +
      `Reply ON MY WAY when you are heading to the property.`
    );

    console.log(`[Flow 2c] Complete — ${contractorName} confirmed WP-${issueRef}`);
    logToAxiom('info', 'flow2c_complete', { phone, contractorName, issueRef: String(issueRef) });

  } catch (err) {
    console.error(`[Flow 2c ERROR]`, err.message);
    logToAxiom('error', 'flow2c_error', { phone, error: err.message });
    await alertShawn('Flow 2c (contractor confirm receipt)', err.message, phone);
  }
}

// ─── FLOW 3 — CONTRACTOR EN ROUTE ────────────────────────────────────────────
// Trigger: contractor sends "on my way" / "omw" / "coming now" / "leaving now"
// Reads:   WP_Issues (most recent Contractor Assigned or En Route for this contractor), WP_Tenants
// Writes:  WP_Issues — Issue Resolution Status → Contractor En Route, Contractor Arrived Timestamp
// Sends:   tenant notification + agent notification + contractor confirmation

async function handleContractorEnRoute(phone, contractorRecord) {
  const contractorName = (contractorRecord.fields['Contractor Name'] || '').trim();
  console.log(`[Flow 3] Contractor en route — phone: ${phone} | ${contractorName}`);
  logToAxiom('info', 'flow3_start', { phone, contractorName });

  try {
    const issue = await getContractorActiveIssue(contractorName, ['Contractor Assigned', 'Contractor En Route']);

    if (!issue) {
      await sendWhatsApp(phone,
        `No active job found. If you have an active job, contact your agent directly.`
      );
      return;
    }

    const issueId     = issue.id;
    const issueRef    = issue.fields['Issue Ref'] || issueId.slice(-6).toUpperCase();
    const tenantPhone = (issue.fields['Tenant Whatsapp Number'] || '').trim();
    const agentPhone  = (issue.fields['Agent Whatsapp number']  || '').trim();

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-ZA', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg'
    });

    // PATCH issue: status → Contractor En Route, timestamp
    // "Contractor Arrived Timestamp" is a dateTime field on WP_Issues (confirmed Meta API 30 Jun 2026)
    const patched = await airtableUpdate('WP_Issues', issueId, {
      'Issue Resolution Status':     'Contractor En Route',
      'Contractor Arrived Timestamp': now.toISOString(),
    });

    if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

    // Get tenant name from WP_Tenants
    let tenantName = 'The tenant';
    if (tenantPhone) {
      const tenantRecs = await airtableGet('WP_Tenants', `{Whatsapp Phone Number} = '${tenantPhone}'`);
      if (tenantRecs.length > 0) tenantName = (tenantRecs[0].fields['Full Name'] || 'The tenant').trim();
    }

    // Notify tenant
    if (tenantPhone) {
      await sendWhatsApp(tenantPhone,
        `Update on your maintenance request (Ref: WP-${issueRef}).\n\n` +
        `${contractorName} is on the way and will arrive shortly.\n\n` +
        `Please ensure access to the property.`
      );
    }

    // Notify agent
    if (agentPhone) {
      await sendWhatsApp(agentPhone,
        `WP-${issueRef}: ${contractorName} is en route (${timeStr}). ${tenantName} has been notified.`
      );
    }

    // Confirm to contractor
    await sendWhatsApp(phone,
      `Got it — tenant has been notified you are on the way.\n\n` +
      `Ref: WP-${issueRef}\n\n` +
      `Reply DONE when the job is complete.`
    );

    console.log(`[Flow 3] Complete — ${contractorName} en route for WP-${issueRef}`);
    logToAxiom('info', 'flow3_complete', { phone, contractorName, issueRef: String(issueRef) });

  } catch (err) {
    console.error(`[Flow 3 ERROR]`, err.message);
    logToAxiom('error', 'flow3_error', { phone, error: err.message });
    await alertShawn('Flow 3 (contractor en route)', err.message, phone);
  }
}

// ─── FLOW 4 — CONTRACTOR REPORTS JOB DONE ────────────────────────────────────
// Trigger: contractor sends "done" / "complete" / "finished" etc.
// Reads:   WP_Issues (most recent Contractor Assigned or En Route for this contractor)
// Writes:  WP_Issues — Issue Resolution Status → Pending Confirmation, Contractor Completed Timestamp
// Sends:   tenant satisfaction prompt (1=resolved / 2=still a problem) + agent summary + contractor receipt

async function handleContractorDone(phone, contractorRecord) {
  const contractorName = (contractorRecord.fields['Contractor Name'] || '').trim();
  console.log(`[Flow 4] Contractor done — phone: ${phone} | ${contractorName}`);
  logToAxiom('info', 'flow4_start', { phone, contractorName });

  try {
    const issue = await getContractorActiveIssue(contractorName, ['Contractor Assigned', 'Contractor En Route']);

    if (!issue) {
      await sendWhatsApp(phone,
        `No active job found. If you have completed a job, contact your agent to confirm.`
      );
      return;
    }

    const issueId     = issue.id;
    const issueRef    = issue.fields['Issue Ref'] || issueId.slice(-6).toUpperCase();
    const tenantPhone = (issue.fields['Tenant Whatsapp Number'] || '').trim();
    const agentPhone  = (issue.fields['Agent Whatsapp number']  || '').trim();

    const now = new Date();

    // PATCH issue: status → Pending Confirmation, completed timestamp
    // "Contractor Completed Timestamp" is a dateTime field (confirmed Meta API 30 Jun 2026)
    const patched = await airtableUpdate('WP_Issues', issueId, {
      'Issue Resolution Status':         'Pending Confirmation',
      'Contractor Completed Timestamp':   now.toISOString(),
    });

    if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

    // Ask tenant to confirm resolution — numbered menu per Rule 11
    if (tenantPhone) {
      await sendWhatsApp(tenantPhone,
        `Update on your maintenance request (Ref: WP-${issueRef}).\n\n` +
        `${contractorName} has reported the job is complete.\n\n` +
        `Has your issue been resolved?\n\n` +
        `Reply with a number:\n` +
        `1 — Yes, resolved. Thank you.\n` +
        `2 — No, still a problem.`
      );
    }

    // Notify agent
    if (agentPhone) {
      await sendWhatsApp(agentPhone,
        `WP-${issueRef}: ${contractorName} reports job complete. Awaiting tenant confirmation.`
      );
    }

    // Confirm to contractor
    await sendWhatsApp(phone,
      `Thanks. Tenant has been asked to confirm.\n\n` +
      `Ref: WP-${issueRef}\n\n` +
      `You will hear back if there is still a problem.`
    );

    console.log(`[Flow 4] Complete — ${contractorName} done, awaiting tenant confirmation for WP-${issueRef}`);
    logToAxiom('info', 'flow4_complete', { phone, contractorName, issueRef: String(issueRef) });

  } catch (err) {
    console.error(`[Flow 4 ERROR]`, err.message);
    logToAxiom('error', 'flow4_error', { phone, error: err.message });
    await alertShawn('Flow 4 (contractor done)', err.message, phone);
  }
}

// ─── FLOW 5 — CONTRACTOR ESCALATION ─────────────────────────────────────────
// Trigger: contractor sends "needs assessment"

async function handleContractorEscalation(phone, contractorRecord) {
  console.log(`[Flow 5] Contractor escalation — phone: ${phone}`);
  // V1 — not yet built. Stub sends help text. Build after Flow 3 + 4 pass on-device test.
  await sendWhatsApp(phone, `[STUB] Needs assessment received. Flow 5 not yet built — contact your agent directly.`);
}

// ─── FLOW 4b/4c — TENANT CLOSURE RESPONSE ───────────────────────────────────
// Trigger: tenant replies "1"/"yes" (resolved) or "2"/"no" (still a problem)
//          when their issue is in Pending Confirmation status
// pendingIssue is passed directly from the router (already fetched there)
// Reads:   pendingIssue passed from router
// Writes:  WP_Issues — Issue Resolution Status, Date Resolved (4b), Satisfaction (4b/4c)
// Sends:   tenant closure reply + agent notification

async function handleTenantClosure(phone, messageText, tenantRecord, pendingIssue) {
  const textLower  = messageText.trim().toLowerCase();
  const confirmed  = textLower === '1' || textLower === 'yes';
  const tenantName = (tenantRecord.fields['Full Name'] || 'Tenant').trim();

  const issueId  = pendingIssue.id;
  const issueRef = pendingIssue.fields['Issue Ref'] || issueId.slice(-6).toUpperCase();
  const agentPhone = (pendingIssue.fields['Agent Whatsapp number'] || '').trim();

  console.log(`[Flow 4${confirmed ? 'b' : 'c'}] Tenant closure — phone: ${phone} | ${confirmed ? 'CONFIRMED' : 'REJECTED'} | WP-${issueRef}`);
  logToAxiom('info', `flow4${confirmed ? 'b' : 'c'}_start`, { phone, confirmed, issueRef: String(issueRef) });

  try {
    if (confirmed) {
      // ── Flow 4b: tenant confirms issue resolved ──────────────────────────
      // "Date Resolved" is a date field — ISO date string (no time portion)
      // "Satisfaction" is a singleSelect — live options confirmed Meta API 30 Jun 2026: "Y", "N", "Pending"
      const patched = await airtableUpdate('WP_Issues', issueId, {
        'Issue Resolution Status': 'Resolved',
        'Date Resolved':           new Date().toISOString().split('T')[0],
        'Satisfaction':            'Y',
      });
      if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

      await sendWhatsApp(phone,
        `Thank you for confirming, ${tenantName}. Your issue (Ref: WP-${issueRef}) is now closed.\n\n` +
        `We hope everything is sorted. Don't hesitate to report any future issues.`
      );

      if (agentPhone) {
        await sendWhatsApp(agentPhone,
          `✅ WP-${issueRef} CLOSED — ${tenantName} confirmed issue resolved.`
        );
      }

      console.log(`[Flow 4b] Complete — WP-${issueRef} resolved and closed`);
      logToAxiom('info', 'flow4b_complete', { phone, issueRef: String(issueRef), result: 'resolved' });

    } else {
      // ── Flow 4c: tenant rejects, reopen issue ───────────────────────────
      // "Satisfaction" is a singleSelect — live options confirmed Meta API 30 Jun 2026: "Y", "N", "Pending"
      const patched = await airtableUpdate('WP_Issues', issueId, {
        'Issue Resolution Status': 'Open',
        'Satisfaction':            'N',
      });
      if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

      await sendWhatsApp(phone,
        `Understood, ${tenantName}. Your agent has been notified that the issue is still not resolved.\n\n` +
        `Ref: WP-${issueRef}\n\nYour agent will follow up.`
      );

      if (agentPhone) {
        await sendWhatsApp(agentPhone,
          `⚠️ WP-${issueRef} REOPENED — ${tenantName} says the issue is still not resolved. Please follow up urgently.`
        );
      }

      console.log(`[Flow 4c] Complete — WP-${issueRef} reopened`);
      logToAxiom('info', 'flow4c_complete', { phone, issueRef: String(issueRef), result: 'reopened' });
    }

  } catch (err) {
    console.error(`[Flow 4b/4c ERROR]`, err.message);
    logToAxiom('error', 'flow4bc_error', { phone, error: err.message });
    await alertShawn(`Flow 4${confirmed ? 'b' : 'c'} (tenant closure)`, err.message, phone);
  }
}

// ─── FLOW 6 — AGENT REPORT ───────────────────────────────────────────────────
// STUB — build after Flow 3 + 4 pass on-device test

async function handleAgentReport(phone, agentRecord) {
  console.log(`[Flow 6] Agent REPORT — phone: ${phone}`);
  await sendWhatsApp(phone, `[STUB] REPORT command received. Flow 6 not yet built.`);
}

// ─── V2-4 — AGENT BRIEFING ───────────────────────────────────────────────────
// STUB — V2

async function handleAgentBriefing(phone, messageText, agentRecord) {
  console.log(`[V2-4] Agent BRIEFING — phone: ${phone} | msg: ${messageText}`);
  await sendWhatsApp(phone, `[STUB] BRIEFING command received. V2-4 not yet built.`);
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
    if (text === '1') {
      await handleAgentShowContractors(phone, record);
      return;
    }
    // "Assign N" — e.g. "Assign 2" or "assign 3"
    const assignMatch = textLower.match(/^assign\s+([1-9]\d*)$/);
    if (assignMatch) {
      await handleAgentContractorSelect(phone, assignMatch[1], record);
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
    // "1" or "confirmed" = job receipt confirmation (Flow 2c)
    // Must be checked first — before en-route keywords
    if (textLower === '1' || textLower === 'confirmed' || textLower === 'confirm') {
      await handleContractorConfirmReceipt(phone, record);
      return;
    }

    const enRouteKeywords = ['on my way', 'omw', 'coming now', 'leaving now', 'heading there', 'on my way!', 'on my way.'];
    const doneKeywords    = ['done', 'done!', 'complete', 'completed', 'finished', 'job done', 'all done'];
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
      `Hi! Send one of the following:\n- *1* — confirm you received a job\n- *on my way* — when you are en route\n- *done* — when the job is complete\n- *needs assessment* — if owner decision is required`
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
    if (pendingIssues.length > 0) {
      if (textLower === 'yes' || textLower === '1' || textLower === 'no' || textLower === '2') {
        // Pass the pending issue directly — avoids a second Airtable lookup in handleTenantClosure
        await handleTenantClosure(phone, text, record, pendingIssues[0]);
      } else {
        // Tenant has a pending issue but replied something unexpected — re-prompt, do not create new issue
        await sendWhatsApp(phone,
          `Please reply with a number to confirm your maintenance request status:\n\n` +
          `1 — Yes, resolved. Thank you.\n` +
          `2 — No, still a problem.`
        );
      }
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

    const value    = body?.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages;
    const statuses = value?.statuses;

    // Log delivery/read/failure status callbacks from Meta — full payload, filterable by event type
    // These arrive asynchronously after a send and are the only way to detect silent delivery failures.
    // Logging only — no logic change, always returns 200.
    if (statuses && statuses.length > 0) {
      statuses.forEach(s => {
        console.log(`[delivery_status] id: ${s.id} | to: ${s.recipient_id} | status: ${s.status}`);
        logToAxiom('info', 'delivery_status', {
          message_id:   s.id,
          recipient:    s.recipient_id,
          status:       s.status,           // sent | delivered | read | failed
          timestamp:    s.timestamp,
          errors:       s.errors || null,   // populated on failed status
          raw:          s,                  // full Meta status object for forensics
        });
      });
    }

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
