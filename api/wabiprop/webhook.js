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
//               "Agent WhatsApp Number" (capital W, A, N), "Owner Phone",
//               "Last Message Timestamp" (dateTime — confirmed live Meta API 1 Jul 2026)
//   WP_Agents: "Agent Whatsapp number" (lowercase 'app', lowercase 'n'), "Active"
//   WP_Contractors: "Contractor Name", "Phone (whatsApp)" (lowercase 'w'), "Active"
//   WP_Owner (singular, NOT "WP_Owners"): "Full Name of Landlord", "Landlord Whatsapp"
//              (lowercase 'w') — confirmed live Meta API 1 Jul 2026

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
// Router checks Agents → Contractors → Tenants → Owner in that order.
// Returns { role: 'agent'|'contractor'|'tenant'|'owner'|'unknown', record: <airtable record or null> }

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

  // WP_Owner — table is singular "WP_Owner", NOT "WP_Owners" (confirmed Meta API 1 Jul 2026)
  // field: "Landlord Whatsapp" (lowercase 'w' — confirmed Meta API 1 Jul 2026)
  const ownerRecords = await airtableGet('WP_Owner', `{Landlord Whatsapp} = '${phone}'`);
  if (ownerRecords.length > 0) {
    console.log(`[Router] Identified as OWNER: ${phone}`);
    return { role: 'owner', record: ownerRecords[0] };
  }

  console.log(`[Router] UNKNOWN sender: ${phone}`);
  return { role: 'unknown', record: null };
}

// ─── TENANT MAIN MENU ─────────────────────────────────────────────────────────
// Menu Spec v1.1 Section 4.1 — shown on any fresh tenant inbound with no active
// mid-flow state. Phase 2 scope: display only. Replying 1/2/3 loops back to this
// same menu until Phase 3 wires up Flow T1 (and later Phases 4/5 for T2/T3).

async function showTenantMainMenu(phone, tenantRecord) {
  const fullName = (tenantRecord.fields['Full Name'] || '').trim();
  const firstName = fullName.split(/\s+/)[0] || 'there';
  await sendWhatsApp(phone,
    `Hi ${firstName}! How can we help you today?\n\n` +
    `Reply with a number:\n` +
    `1 — Report a maintenance issue\n` +
    `2 — Request a call from your agent\n` +
    `3 — Other enquiry`
  );
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
        `Reply *ASSIGN WP-${issueRef}* to assign a contractor, or *1* to see all your open issues.`;

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

// ─── FLOW A1 — AGENT OPEN ISSUES LIST ───────────────────────────────────────
// Trigger: agent sends "1"
// Reads:   WP_Issues (all Open for this agent, oldest first)
// Writes:  nothing — stateless list; next action arrives as an "ASSIGN WP-N" command
// Note:    Replaces the old blind "1 -> contractor list for most-recent-Open-issue"
//          behaviour (UX-02, Menu Spec v1.1 Section 5.2). An agent managing a real
//          portfolio can have several Open issues at once — picking "most recent"
//          silently ignored the rest. There is no session store in this codebase
//          (Vercel serverless — no durable in-memory state between invocations), so
//          the fix keeps every step self-contained: the WP-N always travels with the
//          command instead of being remembered between messages.

async function handleAgentOpenIssuesList(phone, agentRecord) {
  console.log(`[Flow A1] Open issues list — agent: ${phone}`);

  try {
    const records = await airtableGet(
      'WP_Issues',
      `AND({Agent Whatsapp number} = '${phone}', {Issue Resolution Status} = 'Open')`,
      { sort: [{ field: 'Date Reported', direction: 'asc' }] }
    );

    if (records.length === 0) {
      await sendWhatsApp(phone, `No open issues right now — nothing needs assigning.`);
      return;
    }

    const now = Date.now();
    const MAX_SHOWN = 10;
    const shown = records.slice(0, MAX_SHOWN);

    const lines = shown.map((rec, i) => {
      const f = rec.fields;
      const ref = f['Issue Ref'] || rec.id.slice(-6).toUpperCase();
      const reportedTs = f['Date Reported'] ? new Date(f['Date Reported']).getTime() : null;
      const ageHrs = reportedTs ? (now - reportedTs) / 3600000 : null;
      const ageStr = ageHrs === null ? 'age unknown' : ageHrs < 24 ? `${ageHrs.toFixed(0)}h old` : `${(ageHrs / 24).toFixed(0)}d old`;
      const title = (f['Issue Title'] || f['Description'] || 'No description').slice(0, 70);
      return `${i + 1} — WP-${ref} · ${ageStr} · ${title}`;
    });

    const overflowNote = records.length > MAX_SHOWN
      ? `\n\n(${records.length - MAX_SHOWN} more open — use STATUS WP-N to check a specific one.)`
      : '';

    const firstRef = shown[0].fields['Issue Ref'] || shown[0].id.slice(-6).toUpperCase();
    await sendWhatsApp(phone,
      `Open issues:\n\n${lines.join('\n')}${overflowNote}\n\n` +
      `Reply *ASSIGN WP-[issue number]* to assign a contractor — e.g. ASSIGN WP-${firstRef}.`
    );

    logToAxiom('info', 'agent_open_issues_list', { phone, count: records.length });
  } catch (err) {
    console.error(`[Flow A1 ERROR]`, err.message);
    await alertShawn('Flow A1 (open issues list)', err.message, phone);
  }
}

// ─── FLOW 2a — AGENT REQUESTS CONTRACTOR LIST FOR A SPECIFIC ISSUE ──────────
// Trigger: agent sends "ASSIGN WP-N" (e.g. "ASSIGN WP-62")
// Reads:   WP_Issues (this agent's Open issue matching Issue Ref = N), WP_Contractors (all Active)
// Writes:  nothing — list is stateless; selection arrives as "ASSIGN WP-N M" command
// Note:    UX-02 fix — issue is explicit (the WP-N in the command), never blindly the
//          "most recent Open issue for this agent".

async function handleAgentShowContractors(phone, agentRecord, issueRefNum) {
  console.log(`[Flow 2a] Show contractors — agent: ${phone} | WP-${issueRefNum}`);

  try {
    const openIssues = await airtableGet(
      'WP_Issues',
      `AND({Agent Whatsapp number} = '${phone}', {Issue Ref} = ${issueRefNum}, {Issue Resolution Status} = 'Open')`,
      { maxRecords: 1 }
    );

    if (openIssues.length === 0) {
      await sendWhatsApp(phone, `WP-${issueRefNum} not found, not yours, or no longer open. Reply *1* to see your open issues.`);
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
      `Reply *ASSIGN WP-${issueRef} N* (e.g. ASSIGN WP-${issueRef} 2) to confirm.`;

    await sendWhatsApp(phone, msg);
    console.log(`[Flow 2a] Contractor list sent for WP-${issueRef}`);

  } catch (err) {
    console.error(`[Flow 2a ERROR]`, err.message);
    await alertShawn('Flow 2a (show contractors)', err.message, phone);
  }
}

// ─── FLOW 2b — AGENT SELECTS CONTRACTOR ─────────────────────────────────────
// Trigger: agent sends "ASSIGN WP-N M" (e.g. "ASSIGN WP-62 2")
// Reads:   WP_Issues (this agent's Open issue matching Issue Ref = N), WP_Contractors (sorted alphabetically), WP_Tenants
// Writes:  WP_Issues — Issue Resolution Status, Contractor Name
// Sends:   agent confirmation + contractor dispatch (with job receipt prompt)
// Note:    Property Name is NOT written to WP_Issues (multipleLookupValues — read-only, FM-009)
//          Unit Address is read from WP_Tenants, not WP_Issues (FM-006)
//          UX-02 fix — issue is explicit (the WP-N in the command), never blindly the
//          "most recent Open issue for this agent".

async function handleAgentContractorSelect(phone, issueRefNum, selection, agentRecord) {
  console.log(`[Flow 2b] Contractor select — agent: ${phone} | WP-${issueRefNum} | selection: ${selection}`);

  try {
    const openIssues = await airtableGet(
      'WP_Issues',
      `AND({Agent Whatsapp number} = '${phone}', {Issue Ref} = ${issueRefNum}, {Issue Resolution Status} = 'Open')`,
      { maxRecords: 1 }
    );

    if (openIssues.length === 0) {
      await sendWhatsApp(phone, `WP-${issueRefNum} not found, not yours, or no longer open. Reply *1* to see your open issues.`);
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
      await sendWhatsApp(phone, `Invalid selection. Reply *ASSIGN WP-${issueRef}* to see the contractor list again.`);
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
      // ── Flow 4c: tenant rejects — hold in Awaiting Reopen Detail ────────
      // Do NOT reopen yet. Ask for a description first, then handleTenantReopenDetail
      // completes the reopen once the tenant replies with their description.
      // "Awaiting Reopen Detail" confirmed live in Meta API 30 Jun 2026 (id: selOaqvIcuYhvEHx0)
      const patched = await airtableUpdate('WP_Issues', issueId, {
        'Issue Resolution Status': 'Awaiting Reopen Detail',
      });
      if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

      await sendWhatsApp(phone,
        `Sorry to hear that. Please briefly describe what's still wrong (one line is fine).`
      );

      console.log(`[Flow 4c] Awaiting reopen detail — WP-${issueRef}`);
      logToAxiom('info', 'flow4c_awaiting_detail', { phone, issueRef: String(issueRef) });
    }

  } catch (err) {
    console.error(`[Flow 4b/4c ERROR]`, err.message);
    logToAxiom('error', 'flow4bc_error', { phone, error: err.message });
    await alertShawn(`Flow 4${confirmed ? 'b' : 'c'} (tenant closure)`, err.message, phone);
  }
}

// ─── FLOW 4d — TENANT REOPEN DETAIL ─────────────────────────────────────────
// Trigger: tenant sends any text when their issue is in "Awaiting Reopen Detail"
// Reads:   awaitingIssue passed from router (already fetched — Resolution Note
//          read from that record to support multi-turn accumulation on YES loops)
// Writes:  WP_Issues — Issue Resolution Status → Confirming Reopen Detail,
//          Resolution Note → accumulated description (append if existing)
// Sends:   YES/NO prompt to tenant

async function handleTenantReopenDetail(phone, messageText, tenantRecord, awaitingIssue) {
  const issueId  = awaitingIssue.id;
  const issueRef = awaitingIssue.fields['Issue Ref'] || issueId.slice(-6).toUpperCase();
  const newText  = messageText.trim();

  // Accumulate: existing Resolution Note + new text (supports YES loop iterations)
  // No separate Airtable read needed — awaitingIssue record is fresh from router fetch
  const existing    = (awaitingIssue.fields['Resolution Note'] || '').trim();
  const accumulated = existing ? `${existing}\n${newText}` : newText;

  console.log(`[Flow 4d] Reopen detail received — phone: ${phone} | WP-${issueRef}`);
  logToAxiom('info', 'flow4d_detail_received', { phone, issueRef: String(issueRef) });

  try {
    // "Confirming Reopen Detail" confirmed live in Meta API 1 Jul 2026 (id: selffi9Ef4YLESe0s)
    const patched = await airtableUpdate('WP_Issues', issueId, {
      'Issue Resolution Status': 'Confirming Reopen Detail',
      'Resolution Note':         accumulated,
    });
    if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

    await sendWhatsApp(phone,
      `Got it. Would you like to add anything else? Reply YES to add more, or NO to send this to your agent.`
    );

    logToAxiom('info', 'flow4d_awaiting_confirm', { phone, issueRef: String(issueRef) });

  } catch (err) {
    console.error(`[Flow 4d ERROR]`, err.message);
    logToAxiom('error', 'flow4d_error', { phone, error: err.message });
    await alertShawn('Flow 4d (tenant reopen detail)', err.message, phone);
  }
}

// ─── FLOW 4e — TENANT CONFIRM REOPEN ─────────────────────────────────────────
// Trigger: tenant replies YES/NO when issue is in "Confirming Reopen Detail"
// YES → loop back to Awaiting Reopen Detail, prompt for more detail
// NO  → finalise: PATCH Open + Satisfaction N, notify agent, close out tenant
// Reads:   confirmingIssue passed from router (Resolution Note already accumulated)
// Writes:  WP_Issues — Issue Resolution Status, and on NO: Satisfaction + Resolution Note
// Sends:   agent alert (NO only) + tenant acknowledgement or re-prompt

async function handleTenantConfirmReopen(phone, messageText, tenantRecord, confirmingIssue) {
  const tenantName  = (tenantRecord.fields['Full Name'] || 'Tenant').trim();
  const tenantFirstName = tenantName.split(/\s+/)[0] || tenantName;
  const textLower   = messageText.trim().toLowerCase();
  const issueId     = confirmingIssue.id;
  const issueRef    = confirmingIssue.fields['Issue Ref'] || issueId.slice(-6).toUpperCase();
  const agentPhone  = (confirmingIssue.fields['Agent Whatsapp number'] || '').trim();
  const accumulated = (confirmingIssue.fields['Resolution Note'] || '').trim();

  const wantsMore = textLower === 'yes' || textLower === 'more';
  const wantsDone = textLower === 'no' || textLower === 'done' || textLower === 'send';

  console.log(`[Flow 4e] Confirm reopen — phone: ${phone} | WP-${issueRef} | reply: ${textLower}`);
  logToAxiom('info', 'flow4e_start', { phone, issueRef: String(issueRef), reply: textLower });

  try {
    if (wantsMore) {
      // Loop: go back to Awaiting Reopen Detail — next message will append via handleTenantReopenDetail
      const patched = await airtableUpdate('WP_Issues', issueId, {
        'Issue Resolution Status': 'Awaiting Reopen Detail',
      });
      if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

      await sendWhatsApp(phone, `Please add the extra detail.`);
      logToAxiom('info', 'flow4e_loop_more', { phone, issueRef: String(issueRef) });

    } else if (wantsDone) {
      // Finalise: reopen issue, write accumulated description, notify agent
      // "Satisfaction" live options confirmed 30 Jun 2026: "Y", "N", "Pending"
      const patched = await airtableUpdate('WP_Issues', issueId, {
        'Issue Resolution Status': 'Open',
        'Satisfaction':            'N',
        'Resolution Note':         accumulated,
      });
      if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

      if (agentPhone) {
        await sendWhatsApp(agentPhone,
          `⚠️ WP-${issueRef} REOPENED\n\n` +
          `${tenantFirstName} says:\n${accumulated}\n\n` +
          `Reply with:\n` +
          `• *1* — reply to get contractor list, then pick a number to reassign\n` +
          `• *STATUS WP-${issueRef}* — view full issue detail\n` +
          `• *STALE* — find all stuck issues\n` +
          `• *REPORT* — list all open issues`
        );
      }

      await sendWhatsApp(phone,
        `Thanks, your agent has been notified with the details. If you have anything further to add, please contact your agent directly.`
      );

      console.log(`[Flow 4e] Complete — WP-${issueRef} reopened with accumulated description`);
      logToAxiom('info', 'flow4e_complete', { phone, issueRef: String(issueRef), result: 'reopened_with_detail' });

    } else {
      // Unrecognised reply — re-prompt, do not change issue state
      await sendWhatsApp(phone,
        `Please reply YES to add more detail, or NO to send your description to your agent.`
      );
      logToAxiom('info', 'flow4e_reprompt', { phone, issueRef: String(issueRef) });
    }

  } catch (err) {
    console.error(`[Flow 4e ERROR]`, err.message);
    logToAxiom('error', 'flow4e_error', { phone, error: err.message });
    await alertShawn('Flow 4e (tenant confirm reopen)', err.message, phone);
  }
}

// ─── FLOW 6 — AGENT REPORT ───────────────────────────────────────────────────
// STUB — build after Flow 3 + 4 pass on-device test

async function handleAgentReport(phone, agentRecord) {
  console.log(`[Flow 6] Agent REPORT — phone: ${phone}`);
  await sendWhatsApp(phone, `[STUB] REPORT command received. Flow 6 not yet built.`);
}

// ─── AGENT TOOL: STATUS WP-N ─────────────────────────────────────────────────
// Trigger: agent sends "STATUS WP-N" (e.g. "STATUS WP-56")
// Reads:   WP_Issues filtered by Issue Ref
// Sends:   live issue state back to agent

async function handleAgentStatusCheck(phone, issueRefNum) {
  console.log(`[STATUS] Agent status check — WP-${issueRefNum}`);
  try {
    const records = await airtableGet('WP_Issues', `{Issue Ref} = ${issueRefNum}`);
    if (records.length === 0) {
      await sendWhatsApp(phone, `WP-${issueRefNum} not found.`);
      return;
    }
    const f = records[0].fields;
    const fmt = v => v || '—';
    const ts  = iso => iso ? new Date(iso).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false }) : '—';

    const msg =
      `WP-${issueRefNum} Status\n\n` +
      `Status:      ${fmt(f['Issue Resolution Status'])}\n` +
      `Contractor:  ${fmt(f['Contractor Name'])}\n` +
      `Tenant:      ${fmt(f['Tenant Whatsapp Number'])}\n` +
      `Reported:    ${ts(f['Date Reported'])}\n` +
      `En Route:    ${ts(f['Contractor Arrived Timestamp'])}\n` +
      `Completed:   ${ts(f['Contractor Completed Timestamp'])}\n` +
      `Resolved:    ${fmt(f['Date Resolved'])}\n` +
      `Satisfaction:${fmt(f['Satisfaction'])}\n` +
      `Description: ${(f['Description'] || '').slice(0, 80)}`;

    await sendWhatsApp(phone, msg);
    logToAxiom('info', 'agent_status_check', { phone, issueRef: issueRefNum });
  } catch (err) {
    console.error(`[STATUS ERROR]`, err.message);
    await alertShawn('Agent STATUS check', err.message, phone);
  }
}

// ─── AGENT TOOL: STALE ───────────────────────────────────────────────────────
// Trigger: agent sends "STALE"
// Reads:   WP_Issues — all records in non-terminal statuses
// Sends:   list of issues stuck for more than 4 hours with no progression
// Logic:   Contractor Assigned → stale if Date Reported > 4h ago
//          Contractor En Route → stale if Contractor Arrived Timestamp > 4h ago
//          Pending Confirmation → stale if Contractor Completed Timestamp > 4h ago

async function handleAgentStaleCheck(phone) {
  console.log(`[STALE] Agent stale issue check`);
  try {
    const STALE_MS = 4 * 60 * 60 * 1000; // 4 hours
    const now = Date.now();

    const formula =
      `OR({Issue Resolution Status} = 'Contractor Assigned', ` +
      `{Issue Resolution Status} = 'Contractor En Route', ` +
      `{Issue Resolution Status} = 'Pending Confirmation', ` +
      `{Issue Resolution Status} = 'Awaiting Reopen Detail', ` +
      `{Issue Resolution Status} = 'Confirming Reopen Detail')`;

    const records = await airtableGet('WP_Issues', formula);

    // Resolve best available anchor timestamp for each status, with fallback chain.
    // Contractor Assigned/En Route: Contractor Arrived Timestamp → Date Reported
    // Pending Confirmation:         Contractor Completed Timestamp → Contractor Arrived Timestamp → Date Reported
    const resolveAnchor = (f, status) => {
      if (status === 'Pending Confirmation') {
        return f['Contractor Completed Timestamp'] || f['Contractor Arrived Timestamp'] || f['Date Reported'] || null;
      }
      // Awaiting Reopen Detail / Confirming Reopen Detail: no dedicated timestamp — fall back to Date Reported
      if (status === 'Awaiting Reopen Detail' || status === 'Confirming Reopen Detail') {
        return f['Date Reported'] || null;
      }
      // Contractor Assigned + Contractor En Route
      return f['Contractor Arrived Timestamp'] || f['Date Reported'] || null;
    };

    const stale = records.filter(rec => {
      const anchor = resolveAnchor(rec.fields, rec.fields['Issue Resolution Status']);
      if (!anchor) return true; // no timestamp at all — definitely stale
      return (now - new Date(anchor).getTime()) > STALE_MS;
    });

    if (stale.length === 0) {
      await sendWhatsApp(phone, `No stale issues. All active issues have progressed within the last 4 hours.`);
      return;
    }

    const lines = stale.map(rec => {
      const f = rec.fields;
      const anchor = resolveAnchor(f, f['Issue Resolution Status']);
      const hoursAgo = anchor ? ((now - new Date(anchor).getTime()) / 3600000).toFixed(1) : '?';
      return `WP-${f['Issue Ref']} — ${f['Issue Resolution Status']} — ${hoursAgo}h ago (${f['Contractor Name'] || 'no contractor'})`;
    });

    await sendWhatsApp(phone,
      `⚠️ Stale issues (stuck > 4h):\n\n${lines.join('\n')}`
    );

    logToAxiom('info', 'agent_stale_check', { phone, staleCount: stale.length, refs: stale.map(r => r.fields['Issue Ref']) });
  } catch (err) {
    console.error(`[STALE ERROR]`, err.message);
    await alertShawn('Agent STALE check', err.message, phone);
  }
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
  // Menu Spec v1.1 Section 3 — access-denied message + WP_Leads capture.
  // Field names confirmed live Meta API 1 Jul 2026: "Phone Number", "Lead Type" (both singleLineText)
  if (role === 'unknown') {
    await sendWhatsApp(phone,
      `Hi, this service is for registered tenants and property owners only. Please contact your rental agent to be added to the system.`
    );
    await airtableCreate('WP_Leads', {
      'Phone Number': phone,
      'Lead Type':    'Wabiprop',
    });
    return;
  }

  // ── AGENT COMMANDS ───────────────────────────────────────────────────────
  if (role === 'agent') {
    if (text === '1') {
      await handleAgentOpenIssuesList(phone, record);
      return;
    }
    // "ASSIGN WP-N M" — e.g. "ASSIGN WP-62 2" — confirm contractor M for issue N.
    // Checked before the single-argument form below so "ASSIGN WP-62 2" is not
    // swallowed by the shorter pattern.
    const assignConfirmMatch = textLower.match(/^assign\s+wp-?(\d+)\s+([1-9]\d*)$/);
    if (assignConfirmMatch) {
      await handleAgentContractorSelect(phone, assignConfirmMatch[1], assignConfirmMatch[2], record);
      return;
    }
    // "ASSIGN WP-N" — e.g. "ASSIGN WP-62" — show contractor list for that issue.
    // Replaces the old bare "Assign N" (contractor-index-only) command — UX-02 fix
    // means there is no longer a single implicit "most recent Open issue" to assign
    // a bare contractor index against.
    const assignListMatch = textLower.match(/^assign\s+wp-?(\d+)$/);
    if (assignListMatch) {
      await handleAgentShowContractors(phone, record, assignListMatch[1]);
      return;
    }
    if (textLower === 'report') {
      await handleAgentReport(phone, record);
      return;
    }
    // "STATUS WP-N" — live issue state lookup
    const statusMatch = textLower.match(/^status\s+wp-?(\d+)$/);
    if (statusMatch) {
      await handleAgentStatusCheck(phone, parseInt(statusMatch[1], 10));
      return;
    }
    // "STALE" — scan for issues stuck > 4 hours
    if (textLower === 'stale') {
      await handleAgentStaleCheck(phone);
      return;
    }
    if (textLower.startsWith('briefing ')) {
      await handleAgentBriefing(phone, text, record);
      return;
    }
    // Agent sent something unrecognised
    await sendWhatsApp(phone,
      `Hi! Commands available:\n- *1* — see your open issues\n- *ASSIGN WP-[issue number]* — e.g. ASSIGN WP-62\n- *STATUS WP-[issue number]* — e.g. STATUS WP-62\n- *STALE* — find issues stuck > 4 hours\n- *REPORT* — list all open issues`
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
    // Session timeout check — Menu Spec v1.1 Section 3, NEW.
    // "Last Message Timestamp" confirmed live Meta API 1 Jul 2026 (dateTime, WP_Tenants).
    // Soft skip only — timeout never mutates any WP_Issues status (confirmed with Engineer).
    // Last Message Timestamp is updated unconditionally on every inbound tenant message,
    // before any routing decision, regardless of what follows.
    const lastMsg = record.fields['Last Message Timestamp'];
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    const sessionExpired = Boolean(lastMsg) && new Date(lastMsg).getTime() < twoHoursAgo;

    await airtableUpdate('WP_Tenants', record.id, {
      'Last Message Timestamp': new Date().toISOString(),
    });

    if (sessionExpired) {
      console.log(`[Session] Tenant session expired (>2hrs) — showing main menu fresh: ${phone}`);
      logToAxiom('info', 'tenant_session_expired', { phone });
      await showTenantMainMenu(phone, record);
      return;
    }

    // Check 1: tenant is in the YES/NO confirmation loop after sending reopen description (Flow 4e)
    const confirmingIssues = await airtableGet(
      'WP_Issues',
      `AND({Tenant Whatsapp Number} = '${phone}', {Issue Resolution Status} = 'Confirming Reopen Detail')`,
      { sort: [{ field: 'Date Reported', direction: 'desc' }], maxRecords: 1 }
    );
    if (confirmingIssues.length > 0) {
      await handleTenantConfirmReopen(phone, text, record, confirmingIssues[0]);
      return;
    }

    // Check 2: tenant has an issue awaiting their reopen description (Flow 4d)
    // Any text is the description — never new-issue intake
    const awaitingIssues = await airtableGet(
      'WP_Issues',
      `AND({Tenant Whatsapp Number} = '${phone}', {Issue Resolution Status} = 'Awaiting Reopen Detail')`,
      { sort: [{ field: 'Date Reported', direction: 'desc' }], maxRecords: 1 }
    );
    if (awaitingIssues.length > 0) {
      await handleTenantReopenDetail(phone, text, record, awaitingIssues[0]);
      return;
    }

    // Check 3: tenant has a pending-confirmation issue (Flow 4b/4c)
    const pendingIssues = await airtableGet(
      'WP_Issues',
      `AND({Tenant Whatsapp Number} = '${phone}', {Issue Resolution Status} = 'Pending Confirmation')`,
      { sort: [{ field: 'Date Reported', direction: 'desc' }], maxRecords: 1 }
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

    // Check 4: tenant has a call request being handled (Flow T2 — NEW, built Phase 4).
    // No status transition on any reply here in Phase 2 — same re-prompt every time,
    // matching the Phase 2 scope confirmed for the main menu (option replies loop back
    // until the later phase wires up the actual handler).
    const callRequestedIssues = await airtableGet(
      'WP_Issues',
      `AND({Tenant Whatsapp Number} = '${phone}', {Issue Resolution Status} = 'Call Requested')`,
      { sort: [{ field: 'Date Reported', direction: 'desc' }], maxRecords: 1 }
    );
    if (callRequestedIssues.length > 0) {
      await sendWhatsApp(phone,
        `Your call request is being handled — your agent will be in touch shortly. Is there anything else urgent? Reply 1 to report a new issue.`
      );
      return;
    }

    // Check 5: any other tenant message = tenant main menu (Menu Spec v1.1 — replaces
    // straight-to-Flow-1 intake from V1). Flow T1 wiring for option 1 is Phase 3 —
    // handleTenantIssue (Flow 1) is intentionally unreachable from here until then.
    await showTenantMainMenu(phone, record);
    return;
  }

  // ── OWNER COMMANDS ───────────────────────────────────────────────────────
  // Phase 1 scope — main menu only (stub). Option handling (1-4) is a later phase.
  if (role === 'owner') {
    const ownerName = (record.fields['Full Name of Landlord'] || '').trim();
    const ownerFirstName = ownerName.split(/\s+/)[0] || 'there';
    await sendWhatsApp(phone,
      `Hi ${ownerFirstName}! Property owner menu:\n\n` +
      `1 — My properties\n` +
      `2 — Active issues\n` +
      `3 — Financials\n` +
      `4 — Weekly summary\n\n` +
      `Reply with number.`
    );
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
