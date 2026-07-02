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

// Follows Airtable's offset-based pagination past the 100-record-per-request
// default so tables larger than 100 records (e.g. Tenants/Issues/Properties once
// Jojo + Rochelle are both onboarded, ~120+ properties combined) return everything
// that matches, not just the first page. Behaviour for options.maxRecords is
// unchanged -- Airtable never returns an offset once that cap is reached, so the
// loop below naturally runs once for any existing maxRecords:1 caller.
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
    console.log(`[Airtable GET] ${table} | page ${page + 1} | ${filterFormula}`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    console.log(`[Airtable GET STATUS] ${table} | HTTP ${res.status}`);
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
// mid-flow state. Option 1 is wired to Flow T1 as of Group 1 (Menu Phase 3) —
// see startTenantIssueIntake in routeMessage. Options 2/3 (Flow T2/T3, Groups
// 2/3) are not built yet and still loop back to this same menu.

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
//
// SUPERSEDED for the tenant-menu path by startTenantIssueIntake /
// completeTenantIssueIntake below (Group 1, Menu Phase 3) — the menu requires a
// two-step "ask for a description, then receive it" exchange that this one-shot
// function (message = description, in a single call) can't provide. Left in
// place rather than removed (Rule 21 — no unauthorised removal without sign-off);
// it had zero call sites before Group 1 and has zero now. Flagging for Engineer:
// worth a deliberate decision on whether to delete it in a future pass.

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

// ─── FLOW T1 — TENANT ISSUE INTAKE FROM MENU OPTION 1 (Group 1, Menu Phase 3) ─
// Trigger (start):    tenant replies "1" to the main menu, with no placeholder
//                      issue already pending
// Trigger (complete):  tenant's next message, once a placeholder issue exists
//
// ARCHITECTURE NOTE — the thing Group 4-6's flat-command pattern didn't need,
// flagged explicitly per instruction:
// Menu Spec Flow T1 requires a genuine two-turn exchange — "1" -> "please
// describe your issue" -> [tenant's next message] -> issue created. Every flat
// command built in Groups 4-6 (ASSIGN WP-N, ATTEND WP-N, OWNER WP-N, CODE,
// APPROVE, REJECT) carries its own identifying context (a WP-N or a code) in
// every message, so no memory of the prior turn was ever needed. This flow's
// second turn is bare free text with NO identifying token in it at all — the
// same structural problem the *existing* Checks 1-3 already solve for
// continuing an existing issue (state lives on the WP_Issues record itself, via
// Issue Resolution Status, not in any session store). But those three states
// only cover ALREADY-CREATED issues; there was no durable marker for "a new
// issue was started but not yet described" because no such issue exists yet
// to carry a status.
//
// SOLUTION — no new schema, reuses the existing pattern instead of requesting
// a new Issue Resolution Status option: create the WP_Issues record immediately
// on "1", with status Open (an existing, valid value) and a recognisable
// placeholder in Description ("(awaiting description)"). The router's new
// Check 5 (below, in routeMessage) looks for exactly that placeholder on an
// Open issue for this tenant — durable, Airtable-backed, same shape as every
// other mid-flow check in this file. The agent is NOT notified when the
// placeholder is created — only once a real description lands — so a tenant
// who presses 1 and never follows up doesn't generate a false alert.
//
// If this isn't the right tradeoff (e.g. a real Issue Resolution Status option
// like "Awaiting Description" is preferred instead), that's a schema change
// requiring the usual Airtable-UI sign-off (Rule 10) — flagging the option,
// not assuming it.

const TENANT_ISSUE_INTAKE_PLACEHOLDER = '(awaiting description)';
// Distinct placeholder for Flow T3 (Group 3) — same technique, different marker
// string, so Check 5 in routeMessage can tell a pending issue-report apart from
// a pending general enquiry without needing a new Issue Resolution Status value.
const TENANT_ENQUIRY_PLACEHOLDER = '(awaiting enquiry details)';

async function startTenantIssueIntake(phone, tenantRecord) {
  console.log(`[Flow T1] Start issue intake — phone: ${phone}`);

  try {
    const f = tenantRecord.fields;
    const tenantName = (f['Full Name'] || '').trim();
    const agentPhone = (f['Agent WhatsApp Number'] || '').trim();

    const created = await airtableCreate('WP_Issues', {
      'Issue Title':             `${tenantName} — ${TENANT_ISSUE_INTAKE_PLACEHOLDER}`,
      'Description':             TENANT_ISSUE_INTAKE_PLACEHOLDER,
      'Issue Resolution Status': 'Open',
      'Urgency':                 'Routine',
      'Tenant Whatsapp Number':  phone,
      'Agent Whatsapp number':   agentPhone,
      'Date Reported':           new Date().toISOString(),
    });
    if (!created.id) throw new Error(`Placeholder issue create failed: ${JSON.stringify(created.error || created)}`);

    await sendWhatsApp(phone, `Please describe the issue in one or two sentences.`);

    logToAxiom('info', 'flow_t1_intake_started', { phone, issueId: created.id });
    console.log(`[Flow T1] Placeholder issue ${created.id} created — awaiting description`);

  } catch (err) {
    console.error(`[Flow T1 ERROR — start]`, err.message);
    logToAxiom('error', 'flow_t1_start_error', { phone, error: err.message });
    await alertShawn('Flow T1 (start issue intake)', err.message, phone);
  }
}

async function completeTenantIssueIntake(phone, messageText, tenantRecord, placeholderIssue) {
  const issueId = placeholderIssue.id;
  console.log(`[Flow T1] Complete issue intake — phone: ${phone}`);

  try {
    const f = tenantRecord.fields;
    const tenantName   = (f['Full Name']    || '').trim();
    const unitAddress  = (f['Unit Address'] || '').trim();
    const propertyName = (f['Property Name'] || '').trim();
    const agentPhone   = (placeholderIssue.fields['Agent Whatsapp number'] || '').trim();

    const patched = await airtableUpdate('WP_Issues', issueId, {
      'Issue Title':   `${tenantName} — ${messageText.slice(0, 60)}`,
      'Description':   messageText,
    });
    if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

    const issueRef = placeholderIssue.fields['Issue Ref'] || issueId.slice(-6).toUpperCase();

    await sendWhatsApp(phone,
      `Hi ${tenantName}, your maintenance request has been received.\n\n` +
      `Reference: WP-${issueRef}\n` +
      `Issue: ${messageText.slice(0, 80)}${messageText.length > 80 ? '...' : ''}\n\n` +
      `Your agent has been notified and will be in touch shortly. Please do not resend this message.`
    );

    if (agentPhone) {
      await sendWhatsApp(agentPhone,
        `🔧 New maintenance issue logged.\n\n` +
        `Ref: WP-${issueRef}\n` +
        `Tenant: ${tenantName}\n` +
        `Unit: ${unitAddress || 'unknown'}\n` +
        `Property: ${propertyName || 'unknown'}\n` +
        `Issue: ${messageText}\n\n` +
        `Reply *ASSIGN WP-${issueRef}* to assign a contractor, or *1* to see all your open issues.`
      );
    } else {
      console.warn(`[Flow T1] No agent phone on tenant record — skipping agent notification`);
      logToAxiom('warn', 'flow_t1_no_agent_phone', { phone, tenantName });
    }

    console.log(`[Flow T1] Complete — Ref: WP-${issueRef} | Tenant: ${tenantName}`);
    logToAxiom('info', 'flow_t1_complete', { phone, issueRef: String(issueRef), tenantName });

  } catch (err) {
    console.error(`[Flow T1 ERROR — complete]`, err.message);
    logToAxiom('error', 'flow_t1_complete_error', { phone, error: err.message });
    await alertShawn('Flow T1 (complete issue intake)', err.message, phone);
  }
}

// ─── FLOW T2 — TENANT REQUESTS A CALL (Group 2, Menu Phase 4) ──────────────
// Trigger: tenant replies "2" to the main menu, with no active mid-flow state
// Reads:   WP_Tenants (already fetched by router — passed in as tenantRecord)
// Writes:  WP_Issues (creates new record, Status = Call Requested)
// Sends:   tenant confirmation + agent notification
//
// One-shot, unlike Flow T1 — per Brief and explicit instruction: "No
// callback-time capture. No new conversational state beyond this single
// exchange." No reason is asked for or collected, so this needs none of Flow
// T1's placeholder-record technique — "2" is the complete trigger in a single
// message, same flat-command shape as Groups 4-6's commands.
//
// Router-side note: "Call Requested" was already in the mid-flow check set
// (Check 4) before this flow existed (commit 8ebd505) — confirmed still true
// this session. That check's re-prompt path is untouched; this only adds the
// trigger that creates the Call Requested record in the first place.
//
// Composes correctly with Group 1's placeholder guard without any extra work:
// if a tenant has a pending Flow T1 placeholder issue and sends "2" instead of
// their description, Check 5 (Group 1) already intercepts bare "1"/"2"/"3" in
// that state and re-prompts for the description rather than falling through
// here — a mid-report tenant can't accidentally abandon it by hitting 2.

async function handleTenantCallRequest(phone, tenantRecord) {
  console.log(`[Flow T2] Call request — phone: ${phone}`);

  try {
    const f = tenantRecord.fields;
    const tenantName      = (f['Full Name']             || '').trim();
    const tenantFirstName = tenantName.split(/\s+/)[0] || 'A tenant';
    const agentPhone      = (f['Agent WhatsApp Number']  || '').trim();

    const created = await airtableCreate('WP_Issues', {
      'Issue Title':             `${tenantName} — call requested`,
      'Description':             'Tenant requested a call back.',
      'Issue Resolution Status': 'Call Requested',
      'Urgency':                 'Routine',
      'Tenant Whatsapp Number':  phone,
      'Agent Whatsapp number':   agentPhone,
      'Date Reported':           new Date().toISOString(),
    });
    if (!created.id) throw new Error(`Call request issue create failed: ${JSON.stringify(created.error || created)}`);

    const issueRef = created.fields?.['Issue Ref'] || created.id.slice(-6).toUpperCase();

    await sendWhatsApp(phone, `Thanks — your agent will call you shortly.`);

    if (agentPhone) {
      // Core wording matches what was specified exactly; Ref: WP-{N} appended
      // for consistency with every other agent notification in this file (so
      // STATUS WP-N works on it later) -- a small addition, flagging it as
      // such rather than folding it in silently.
      await sendWhatsApp(agentPhone,
        `📞 ${tenantFirstName} (${phone}) has requested a call. Ref: WP-${issueRef}`
      );
    } else {
      console.warn(`[Flow T2] No agent phone on tenant record — skipping agent notification`);
      logToAxiom('warn', 'flow_t2_no_agent_phone', { phone, tenantName });
    }

    console.log(`[Flow T2] Complete — Ref: WP-${issueRef} | Tenant: ${tenantName}`);
    logToAxiom('info', 'flow_t2_complete', { phone, issueRef: String(issueRef), tenantName });

  } catch (err) {
    console.error(`[Flow T2 ERROR]`, err.message);
    logToAxiom('error', 'flow_t2_error', { phone, error: err.message });
    await alertShawn('Flow T2 (call request)', err.message, phone);
  }
}

// ─── FLOW T3 — TENANT OTHER ENQUIRY (Group 3, Menu Phase 5) ─────────────────
// Trigger (start):    tenant replies "3" to the main menu, with no active
//                      mid-flow state
// Trigger (complete):  tenant's next message, once a pending enquiry exists
// Reads:   WP_Tenants (already fetched by router — passed in as tenantRecord)
// Writes:  WP_Issues (creates, then updates the same record)
// Sends:   agent forward + tenant confirmation
//
// TWO-TURN OR ONE-SHOT? — reasoning, not a silent pick, per instruction:
// This DOES need the same two-turn technique Flow T1 (Group 1) built, not
// Flow T2's (Group 2) one-shot shape. The reason is the trigger content, not
// the destination: "3" carries no enquiry text with it — the tenant's actual
// question only exists in their SECOND message, which (like Flow T1's
// description) is bare free text with no identifying token. Flow T2 avoided
// this because "2" alone is a complete, self-contained request with nothing
// further to say. So this reuses Flow T1's placeholder-issue pattern exactly,
// with its own distinct marker (TENANT_ENQUIRY_PLACEHOLDER) so Check 5 in
// routeMessage can tell "pending issue report" and "pending enquiry" apart
// without a new Issue Resolution Status value.
//
// STATUS CHOICE — flagged judgment call: once the enquiry text is forwarded,
// this sets Issue Resolution Status = Closed immediately, NOT Open. Reasoning:
// "no categorization, no sub-menu" (per Brief) means there's no ASSIGN/ATTEND/
// OWNER command that fits a general question — those are maintenance-shaped
// actions. Leaving it Open would put non-maintenance enquiries into Flow A1's
// open-issues list and STALE's stuck-issue scan with no way to close them
// (same "no HANDLED command yet" gap flagged for Group 9's Call Requested).
// Closed is an imperfect label (nothing was "resolved" by the system, just
// relayed) but keeps the issue list clean of things it can't actually act on.
// If visibility/trackability matters more than list cleanliness, this is a
// one-line change back to Open.

async function startTenantEnquiry(phone, tenantRecord) {
  console.log(`[Flow T3] Start enquiry — phone: ${phone}`);

  try {
    const f = tenantRecord.fields;
    const tenantName = (f['Full Name'] || '').trim();
    const agentPhone = (f['Agent WhatsApp Number'] || '').trim();

    const created = await airtableCreate('WP_Issues', {
      'Issue Title':             `${tenantName} — ${TENANT_ENQUIRY_PLACEHOLDER}`,
      'Description':             TENANT_ENQUIRY_PLACEHOLDER,
      'Issue Resolution Status': 'Open',
      'Category':                'General',
      'Urgency':                 'Routine',
      'Tenant Whatsapp Number':  phone,
      'Agent Whatsapp number':   agentPhone,
      'Date Reported':           new Date().toISOString(),
    });
    if (!created.id) throw new Error(`Placeholder enquiry create failed: ${JSON.stringify(created.error || created)}`);

    await sendWhatsApp(phone, `Please describe your enquiry and your agent will get back to you.`);

    logToAxiom('info', 'flow_t3_enquiry_started', { phone, issueId: created.id });
    console.log(`[Flow T3] Placeholder enquiry ${created.id} created — awaiting details`);

  } catch (err) {
    console.error(`[Flow T3 ERROR — start]`, err.message);
    logToAxiom('error', 'flow_t3_start_error', { phone, error: err.message });
    await alertShawn('Flow T3 (start enquiry)', err.message, phone);
  }
}

async function completeTenantEnquiry(phone, messageText, tenantRecord, placeholderIssue) {
  const issueId = placeholderIssue.id;
  console.log(`[Flow T3] Complete enquiry — phone: ${phone}`);

  try {
    const f = tenantRecord.fields;
    const tenantName = (f['Full Name'] || '').trim();
    const agentPhone = (placeholderIssue.fields['Agent Whatsapp number'] || '').trim();

    const patched = await airtableUpdate('WP_Issues', issueId, {
      'Issue Title':             `${tenantName} — ${messageText.slice(0, 60)}`,
      'Description':             messageText,
      'Issue Resolution Status': 'Closed', // see file header — flagged, not obviously correct
    });
    if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

    const issueRef = placeholderIssue.fields['Issue Ref'] || issueId.slice(-6).toUpperCase();

    await sendWhatsApp(phone, `Thanks, your agent has been notified and will be in touch.`);

    if (agentPhone) {
      await sendWhatsApp(agentPhone,
        `💬 ${tenantName} sent an enquiry:\n\n"${messageText}"\n\n` +
        `Ref: WP-${issueRef} · Reply directly to ${phone} to respond.`
      );
    } else {
      console.warn(`[Flow T3] No agent phone on tenant record — skipping agent notification`);
      logToAxiom('warn', 'flow_t3_no_agent_phone', { phone, tenantName });
    }

    console.log(`[Flow T3] Complete — Ref: WP-${issueRef} | Tenant: ${tenantName}`);
    logToAxiom('info', 'flow_t3_complete', { phone, issueRef: String(issueRef), tenantName });

  } catch (err) {
    console.error(`[Flow T3 ERROR — complete]`, err.message);
    logToAxiom('error', 'flow_t3_complete_error', { phone, error: err.message });
    await alertShawn('Flow T3 (complete enquiry)', err.message, phone);
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
      `Reply *ASSIGN WP-[issue number]* to assign a contractor, *ATTEND WP-[issue number]* to handle it yourself, or *OWNER WP-[issue number]* to send it to the owner — e.g. ASSIGN WP-${firstRef}, ATTEND WP-${firstRef}, or OWNER WP-${firstRef}.`
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

// ─── FLOW A1-3b / A2 (part 1) — AGENT MARKS THEMSELVES ATTENDING ───────────
// Trigger: agent sends "ATTEND WP-N" (e.g. "ATTEND WP-70")
// Reads:   WP_Issues (this agent's Open issue matching Issue Ref = N), WP_Tenants
// Writes:  WP_Issues — Issue Resolution Status -> Agent Attending, Handling Method -> Agent
// Sends:   tenant notification (agent handling personally) + agent confirmation
// Note:    Same flat WP-N-in-command pattern as ASSIGN WP-N (Group 4) — no session
//          store exists to remember a prior list selection between messages.

async function handleAgentAttend(phone, issueRefNum, agentRecord) {
  console.log(`[Flow A1-3b] Agent attending — agent: ${phone} | WP-${issueRefNum}`);

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
    const tenantPhone = (issue.fields['Tenant Whatsapp Number'] || '').trim();

    // "Agent" confirmed live option on Handling Method (Meta API)
    const patched = await airtableUpdate('WP_Issues', issueId, {
      'Issue Resolution Status': 'Agent Attending',
      'Handling Method':         'Agent',
    });
    if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

    let tenantName = 'Tenant';
    if (tenantPhone) {
      const tenantRecords = await airtableGet('WP_Tenants', `{Whatsapp Phone Number} = '${tenantPhone}'`);
      if (tenantRecords.length > 0) {
        tenantName = (tenantRecords[0].fields['Full Name'] || 'Tenant').trim();
      }
      await sendWhatsApp(tenantPhone,
        `Hi ${tenantName}, your agent is personally handling your maintenance request (Ref: WP-${issueRef}). We'll be in touch shortly.`
      );
    }

    await sendWhatsApp(phone, `WP-${issueRef} marked as Agent Attending. ${tenantName} has been notified.\n\nWhen done, reply *ATTENDED WP-${issueRef}* to ask the tenant to confirm.`);

    console.log(`[Flow A1-3b] Complete — WP-${issueRef} marked Agent Attending`);
    logToAxiom('info', 'agent_attend', { phone, issueRef: String(issueRef) });

  } catch (err) {
    console.error(`[Flow A1-3b ERROR]`, err.message);
    await alertShawn('Flow A1-3b (agent attend)', err.message, phone);
  }
}

// ─── FLOW A2 (part 2) — ATTENDED WP-N CLOSURE COMMAND ───────────────────────
// Trigger: agent sends "ATTENDED WP-N [optional note]" (e.g. "ATTENDED WP-70 fixed the lock")
// Reads:   WP_Issues (this agent's issue matching Issue Ref = N, status Agent Attending), WP_Tenants
// Writes:  WP_Issues — Issue Resolution Status -> Pending Confirmation, Resolution Note, Closed By -> Agent
// Sends:   tenant 1/2 confirmation prompt (reuses the same Pending Confirmation state
//          and handleTenantClosure the contractor-done flow already uses) + agent confirmation
// Note:    Requires the issue to already be in Agent Attending (i.e. ATTEND WP-N was sent
//          first) — ATTENDED is the closure of an announced-attending state, not a
//          standalone one-shot. Goes straight to the final Pending Confirmation state in
//          one PATCH, matching the existing handleContractorDone pattern — the Menu Spec's
//          literal "write Resolved, then overwrite with Pending Confirmation" two-step read
//          as documentation shorthand, not an intentional interim write.

async function handleAgentAttended(phone, issueRefNum, note, agentRecord) {
  console.log(`[Flow A2] Agent attended closure — agent: ${phone} | WP-${issueRefNum}`);

  try {
    const attendingIssues = await airtableGet(
      'WP_Issues',
      `AND({Agent Whatsapp number} = '${phone}', {Issue Ref} = ${issueRefNum}, {Issue Resolution Status} = 'Agent Attending')`,
      { maxRecords: 1 }
    );

    if (attendingIssues.length === 0) {
      await sendWhatsApp(phone, `WP-${issueRefNum} not found, not yours, or not currently marked as Agent Attending. Reply *ATTEND WP-${issueRefNum}* first, or *1* to see your open issues.`);
      return;
    }

    const issue       = attendingIssues[0];
    const issueId     = issue.id;
    const issueRef    = issue.fields['Issue Ref'] || issueId.slice(-6).toUpperCase();
    const tenantPhone = (issue.fields['Tenant Whatsapp Number'] || '').trim();

    const resolutionNote = note ? `Agent attended. ${note}` : `Agent attended.`;

    // "Agent" confirmed live option on Closed By (Meta API)
    const patched = await airtableUpdate('WP_Issues', issueId, {
      'Issue Resolution Status': 'Pending Confirmation',
      'Resolution Note':         resolutionNote,
      'Closed By':               'Agent',
    });
    if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

    let tenantName = 'Tenant';
    if (tenantPhone) {
      const tenantRecords = await airtableGet('WP_Tenants', `{Whatsapp Phone Number} = '${tenantPhone}'`);
      if (tenantRecords.length > 0) {
        tenantName = (tenantRecords[0].fields['Full Name'] || 'Tenant').trim();
      }
      await sendWhatsApp(tenantPhone,
        `Update on your maintenance request (Ref: WP-${issueRef}).\n\n` +
        `Your agent has attended to this personally.${note ? ` Note: ${note}` : ''}\n\n` +
        `Has your issue been resolved?\n\n` +
        `Reply with a number:\n` +
        `1 — Yes, resolved. Thank you.\n` +
        `2 — No, still a problem.`
      );
    }

    await sendWhatsApp(phone, `WP-${issueRef} marked as attended. ${tenantName} has been asked to confirm resolution.`);

    console.log(`[Flow A2] Complete — WP-${issueRef} awaiting tenant confirmation`);
    logToAxiom('info', 'agent_attended', { phone, issueRef: String(issueRef) });

  } catch (err) {
    console.error(`[Flow A2 ERROR]`, err.message);
    await alertShawn('Flow A2 (agent attended)', err.message, phone);
  }
}

// ─── FLOW A1-3c / A3 — AGENT ESCALATES ISSUE TO OWNER ───────────────────────
// Trigger: agent sends "OWNER WP-N" (e.g. "OWNER WP-70")
// Reads:   WP_Issues (this agent's Open issue matching Issue Ref = N), WP_Tenants (for
//          Owner Phone, Property Name, Unit Address), WP_Owner (Landlord Whatsapp lookup
//          for the owner's name — plain notification only, no reply handling this session)
// Writes:  WP_Issues — Issue Resolution Status -> Owner Handling, Handling Method -> Owner
// Sends:   plain owner notification (no interactive 1/2/3 menu — explicitly deferred by
//          CEO for this session) + agent confirmation
// Note:    Same flat WP-N-in-command pattern as ASSIGN WP-N / ATTEND WP-N. Owner phone is
//          not a field on WP_Issues (confirmed live Meta API) — resolved the same way
//          Flow 1 already does, via the denormalised Owner Phone field on WP_Tenants.
//          Approval Status is intentionally NOT written here — that field only has
//          meaning once an owner reply is processed, which is out of scope this session.

async function handleAgentEscalateToOwner(phone, issueRefNum, agentRecord) {
  console.log(`[Flow A1-3c] Agent escalates to owner — agent: ${phone} | WP-${issueRefNum}`);

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

    // "Owner" confirmed live option on Handling Method (Meta API).
    // "Owner Handling" replaces the old deprecated "Owner Decision" status value.
    const patched = await airtableUpdate('WP_Issues', issueId, {
      'Issue Resolution Status': 'Owner Handling',
      'Handling Method':         'Owner',
    });
    if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

    // Resolve owner phone + property context via WP_Tenants (Owner Phone is not on
    // WP_Issues — same denormalised-field pattern Flow 1 already uses, FM-006 style)
    let ownerPhone  = '';
    let ownerName   = 'the owner';
    let unitAddress = '';
    let propertyName = '';
    let agentName   = (agentRecord.fields['Agent Name'] || 'Your agent').trim();

    if (tenantPhone) {
      const tenantRecords = await airtableGet('WP_Tenants', `{Whatsapp Phone Number} = '${tenantPhone}'`);
      if (tenantRecords.length > 0) {
        const tf = tenantRecords[0].fields;
        ownerPhone   = (tf['Owner Phone']    || '').trim();
        unitAddress  = (tf['Unit Address']   || '').trim();
        propertyName = (tf['Property Name']  || '').trim();
      }
    }

    if (ownerPhone) {
      const ownerRecords = await airtableGet('WP_Owner', `{Landlord Whatsapp} = '${ownerPhone}'`);
      if (ownerRecords.length > 0) {
        const fullName = (ownerRecords[0].fields['Full Name of Landlord'] || '').trim();
        if (fullName) ownerName = fullName.split(/\s+/)[0];
      }

      await sendWhatsApp(ownerPhone,
        `Your agent has flagged an issue at ${propertyName || unitAddress || 'your property'} for your attention.\n\n` +
        `Ref: WP-${issueRef}\n` +
        `Unit: ${unitAddress || 'unknown'}\n` +
        `Issue: ${description}\n\n` +
        `${agentName} will follow up with you directly.`
      );
      console.log(`[Flow A1-3c] Owner notified — WP-${issueRef}`);
    } else {
      console.warn(`[Flow A1-3c] No owner phone found for WP-${issueRef} — status set, owner NOT notified`);
      logToAxiom('warn', 'agent_escalate_no_owner_phone', { phone, issueRef: String(issueRef) });
    }

    await sendWhatsApp(phone,
      ownerPhone
        ? `WP-${issueRef} assigned to owner. ${ownerName} has been notified.`
        : `WP-${issueRef} marked as Owner Handling, but no owner phone number was found on file — please follow up with the owner directly.`
    );

    logToAxiom('info', 'agent_escalate_to_owner', { phone, issueRef: String(issueRef), ownerNotified: Boolean(ownerPhone) });

  } catch (err) {
    console.error(`[Flow A1-3c ERROR]`, err.message);
    await alertShawn('Flow A1-3c (agent escalate to owner)', err.message, phone);
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
          `• *ASSIGN WP-${issueRef}* — reassign to a contractor\n` +
          `• *ATTEND WP-${issueRef}* — handle it yourself\n` +
          `• *OWNER WP-${issueRef}* — send it to the owner\n` +
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

// ─── GROUP 12 — TENANT SELF-REGISTRATION (agent-confirm, not immediate-link) ─
// Trigger (unregistered number): "CODE {code}" (e.g. "CODE WP-1234")
// Trigger (agent):               "APPROVE {code} [Full Name]" / "REJECT {code}"
// Reads:   WP_Units (Registration Code match), WP_Properties (Property Name,
//          Agent Phone, Owner Whatsapp -- for the agent/tenant notifications and
//          for denormalising onto the new WP_Tenants record)
// Writes:  WP_Units.Registered Tenant Phone (claim marker) -> cleared on reject;
//          WP_Tenants (new record) -> created only on agent APPROVE
//
// DESIGN NOTE -- why the tenant's name is NOT collected at CODE time:
// The only two fields approved for this flow are WP_Units."Registration Code"
// and WP_Units."Registered Tenant Phone" -- there is no field to hold a tenant's
// name during the pending window, and adding one would need CEO sign-off (Rule
// 10) that wasn't sought. Rather than stop the whole group over it, the flow is
// shaped so nothing extra needs to persist: "Registered Tenant Phone" is both
// the claim marker AND the only thing carried across the pending window. The
// agent -- who already has this tenant's name from their own lease paperwork --
// supplies it fresh in the APPROVE command itself. This also means the
// registering number is NEVER auto-recognised as a tenant (identifySender has
// no "pending" concept, only match/no-match) -- a WP_Tenants record, and
// therefore live tenant access, only exists after explicit agent approval.
// This is the "Pending state, ping the agent to approve, not immediate-link"
// design that was signed off.
//
// Registration Code matching is case-insensitive (LOWER() on both sides) --
// friendlier for a code copied off a printed notice. The code itself must be a
// single whitespace-free token (the command parser splits on the first space),
// so codes containing spaces will not match correctly -- worth knowing before
// codes are generated/printed for units.
//
// Invalid-code attempts do NOT create a WP_Leads record (unlike the generic
// unknown-sender fallback) -- a mistyped registration code is a distinct,
// deliberate self-registration attempt, not the same signal as a random
// unrecognised message, and logging every typo into the sales-CRM-ish WP_Leads
// table would be noise. Flagging this as a judgment call, not obviously correct.

async function resolvePropertyContext(unitRecord) {
  const propertyIds = unitRecord.fields['Property'] || [];
  if (propertyIds.length === 0) return {};
  const propertyRecords = await airtableGet('WP_Properties', `RECORD_ID() = '${propertyIds[0]}'`, { maxRecords: 1 });
  if (propertyRecords.length === 0) return {};
  const pf = propertyRecords[0].fields;
  return {
    propertyName: (pf['Property Name']   || '').trim(),
    agentPhone:   (pf['Agent Phone']     || '').trim(),
    ownerPhone:   (pf['Owner Whatsapp']  || '').trim(),
  };
}

async function handleTenantSelfRegister(phone, code) {
  console.log(`[Group 12] Self-registration attempt — phone: ${phone} | code: ${code}`);

  try {
    const escapedCode = code.replace(/'/g, "\\'");
    const units = await airtableGet('WP_Units', `LOWER({Registration Code}) = LOWER('${escapedCode}')`, { maxRecords: 1 });

    if (units.length === 0) {
      await sendWhatsApp(phone, `That registration code wasn't recognized. Please check the code (e.g. WP-1234) and try again, or contact your agent.`);
      logToAxiom('info', 'tenant_register_code_not_found', { phone, code });
      return;
    }

    const unit = units[0];
    const existingPhone = (unit.fields['Registered Tenant Phone'] || '').trim();

    if (existingPhone === phone) {
      await sendWhatsApp(phone, `Your registration for this unit is still pending your agent's approval.`);
      return;
    }
    if (existingPhone) {
      await sendWhatsApp(phone, `This registration code has already been used. If you believe this is a mistake, please contact your agent.`);
      logToAxiom('warn', 'tenant_register_code_already_claimed', { phone, code, unitId: unit.id });
      return;
    }

    const { propertyName, agentPhone, ownerPhone } = await resolvePropertyContext(unit);
    const unitName = (unit.fields['Unit Name'] || 'your unit').trim();

    const patched = await airtableUpdate('WP_Units', unit.id, { 'Registered Tenant Phone': phone });
    if (patched.error) throw new Error(`Unit PATCH failed: ${JSON.stringify(patched.error)}`);

    await sendWhatsApp(phone,
      `Thanks! Your registration for ${unitName}${propertyName ? `, ${propertyName}` : ''} has been sent to your agent for approval. You'll get a message once it's confirmed.`
    );

    if (agentPhone) {
      await sendWhatsApp(agentPhone,
        `📋 New tenant registration pending approval.\n\n` +
        `Phone: ${phone}\n` +
        `Unit: ${unitName}${propertyName ? `, ${propertyName}` : ''}\n` +
        `Code: ${code}\n\n` +
        `Reply *APPROVE ${code} [Tenant Full Name]* to confirm — e.g. APPROVE ${code} Ayanda Khumalo.\n` +
        `Reply *REJECT ${code}* to decline.`
      );
    } else {
      console.warn(`[Group 12] No agent phone resolved for unit ${unit.id} — registration claimed but agent not notified`);
      logToAxiom('warn', 'tenant_register_no_agent_phone', { phone, code, unitId: unit.id });
    }

    logToAxiom('info', 'tenant_register_pending', { phone, code, unitId: unit.id, agentNotified: Boolean(agentPhone) });

  } catch (err) {
    console.error(`[Group 12 ERROR — self-register]`, err.message);
    await alertShawn('Group 12 (tenant self-register)', err.message, phone);
  }
}

async function handleAgentApproveRegistration(phone, code, fullName, agentRecord) {
  console.log(`[Group 12] Agent approve — agent: ${phone} | code: ${code} | name: ${fullName}`);

  try {
    const escapedCode = code.replace(/'/g, "\\'");
    const units = await airtableGet(
      'WP_Units',
      `AND(LOWER({Registration Code}) = LOWER('${escapedCode}'), {Registered Tenant Phone} != '')`,
      { maxRecords: 1 }
    );

    if (units.length === 0) {
      await sendWhatsApp(phone, `No pending registration found for code ${code}. It may already be approved, rejected, or the code is wrong.`);
      return;
    }

    const unit = units[0];
    const { propertyName, agentPhone: unitAgentPhone, ownerPhone } = await resolvePropertyContext(unit);

    // Ownership check -- only the agent assigned to this unit's property may approve
    if (unitAgentPhone && unitAgentPhone !== phone) {
      await sendWhatsApp(phone, `Code ${code} belongs to a property assigned to a different agent. Cannot approve.`);
      logToAxiom('warn', 'tenant_register_approve_wrong_agent', { phone, code, unitId: unit.id });
      return;
    }

    const pendingPhone = (unit.fields['Registered Tenant Phone'] || '').trim();
    const unitName = (unit.fields['Unit Name'] || 'unit').trim();

    const created = await airtableCreate('WP_Tenants', {
      'Full Name':                fullName,
      'Whatsapp Phone Number':    pendingPhone,
      'Units':                    [unit.id],
      'Tenant Status':            'Active',
      'Property Name':            propertyName || '',
      'Agent WhatsApp Number':    unitAgentPhone || phone,
      'Owner Phone':              ownerPhone || '',
    });
    if (!created.id) throw new Error(`WP_Tenants create failed: ${JSON.stringify(created.error || created)}`);

    await sendWhatsApp(phone, `✅ ${fullName} registered as tenant for ${unitName}. They can now report issues via WhatsApp.`);

    const tenantFirstName = fullName.trim().split(/\s+/)[0] || fullName;
    await sendWhatsApp(pendingPhone,
      `Hi ${tenantFirstName}, you're all set! You can now report maintenance issues, request a call, or ask a question any time — just message this number.`
    );

    logToAxiom('info', 'tenant_register_approved', { phone, code, unitId: unit.id, tenantId: created.id, pendingPhone });
    console.log(`[Group 12] Approved — WP_Tenants ${created.id} created for ${pendingPhone}`);

  } catch (err) {
    console.error(`[Group 12 ERROR — approve]`, err.message);
    await alertShawn('Group 12 (agent approve registration)', err.message, phone);
  }
}

async function handleAgentRejectRegistration(phone, code, agentRecord) {
  console.log(`[Group 12] Agent reject — agent: ${phone} | code: ${code}`);

  try {
    const escapedCode = code.replace(/'/g, "\\'");
    const units = await airtableGet(
      'WP_Units',
      `AND(LOWER({Registration Code}) = LOWER('${escapedCode}'), {Registered Tenant Phone} != '')`,
      { maxRecords: 1 }
    );

    if (units.length === 0) {
      await sendWhatsApp(phone, `No pending registration found for code ${code}.`);
      return;
    }

    const unit = units[0];
    const { agentPhone: unitAgentPhone } = await resolvePropertyContext(unit);

    if (unitAgentPhone && unitAgentPhone !== phone) {
      await sendWhatsApp(phone, `Code ${code} belongs to a property assigned to a different agent. Cannot reject.`);
      return;
    }

    const pendingPhone = (unit.fields['Registered Tenant Phone'] || '').trim();

    const patched = await airtableUpdate('WP_Units', unit.id, { 'Registered Tenant Phone': '' });
    if (patched.error) throw new Error(`Unit PATCH failed: ${JSON.stringify(patched.error)}`);

    await sendWhatsApp(phone, `Registration for code ${code} declined. The code is now available again.`);

    if (pendingPhone) {
      await sendWhatsApp(pendingPhone, `Your registration request could not be confirmed. Please contact your agent directly if you believe this is a mistake.`);
    }

    logToAxiom('info', 'tenant_register_rejected', { phone, code, unitId: unit.id, pendingPhone });

  } catch (err) {
    console.error(`[Group 12 ERROR — reject]`, err.message);
    await alertShawn('Group 12 (agent reject registration)', err.message, phone);
  }
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
    // Group 12 — "CODE {code}" self-registration, checked before the generic
    // access-denied fallback below. See handleTenantSelfRegister for full design.
    const codeMatch = text.match(/^code\s+(\S+)$/i);
    if (codeMatch) {
      await handleTenantSelfRegister(phone, codeMatch[1]);
      return;
    }

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
    // "ATTEND WP-N" — e.g. "ATTEND WP-70" — agent takes this issue on personally
    const attendMatch = textLower.match(/^attend\s+wp-?(\d+)$/);
    if (attendMatch) {
      await handleAgentAttend(phone, attendMatch[1], record);
      return;
    }
    // "ATTENDED WP-N [note]" — e.g. "ATTENDED WP-70 fixed the lock" — closure command.
    // Checked before ATTEND above only matters for exact-string collisions, which the
    // \s+wp- boundary already prevents ("attend" will never match "attended ...").
    const attendedMatch = text.match(/^attended\s+wp-?(\d+)(?:\s+([\s\S]+))?$/i);
    if (attendedMatch) {
      await handleAgentAttended(phone, attendedMatch[1], (attendedMatch[2] || '').trim(), record);
      return;
    }
    // "OWNER WP-N" — e.g. "OWNER WP-70" — escalate this issue to the property owner
    const ownerMatch = textLower.match(/^owner\s+wp-?(\d+)$/);
    if (ownerMatch) {
      await handleAgentEscalateToOwner(phone, ownerMatch[1], record);
      return;
    }
    // "APPROVE {code} {Full Name}" — e.g. "APPROVE WP-1234 Ayanda Khumalo" — Group 12
    // Case preserved on the name (text, not textLower); code matched case-insensitively.
    const approveMatch = text.match(/^approve\s+(\S+)\s+([\s\S]+)$/i);
    if (approveMatch) {
      await handleAgentApproveRegistration(phone, approveMatch[1], approveMatch[2].trim(), record);
      return;
    }
    // "REJECT {code}" — e.g. "REJECT WP-1234" — Group 12
    const rejectMatch = text.match(/^reject\s+(\S+)$/i);
    if (rejectMatch) {
      await handleAgentRejectRegistration(phone, rejectMatch[1], record);
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
      `Hi! Commands available:\n- *1* — see your open issues\n- *ASSIGN WP-[issue number]* — e.g. ASSIGN WP-62\n- *ATTEND WP-[issue number]* — handle it yourself, e.g. ATTEND WP-62\n- *ATTENDED WP-[issue number]* — close it out once you're done, e.g. ATTENDED WP-62\n- *OWNER WP-[issue number]* — send it to the owner, e.g. OWNER WP-62\n- *APPROVE [code] [Tenant Name]* — confirm a pending tenant registration\n- *REJECT [code]* — decline a pending tenant registration\n- *STATUS WP-[issue number]* — e.g. STATUS WP-62\n- *STALE* — find issues stuck > 4 hours\n- *REPORT* — list all open issues`
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

    // Check 5: tenant has a pending placeholder issue awaiting its real text --
    // either Flow T1 (issue report, Group 1) or Flow T3 (enquiry, Group 3).
    // Single query against both markers rather than two near-identical checks;
    // see TENANT_ISSUE_INTAKE_PLACEHOLDER / TENANT_ENQUIRY_PLACEHOLDER and the
    // startTenantIssueIntake / startTenantEnquiry header comments for why this
    // exists instead of a session-state marker.
    const placeholderIssues = await airtableGet(
      'WP_Issues',
      `AND({Tenant Whatsapp Number} = '${phone}', {Issue Resolution Status} = 'Open', OR({Description} = '${TENANT_ISSUE_INTAKE_PLACEHOLDER}', {Description} = '${TENANT_ENQUIRY_PLACEHOLDER}'))`,
      { sort: [{ field: 'Date Reported', direction: 'desc' }], maxRecords: 1 }
    );
    if (placeholderIssues.length > 0) {
      const isEnquiry = placeholderIssues[0].fields['Description'] === TENANT_ENQUIRY_PLACEHOLDER;
      // Guard: a bare menu digit here is almost certainly a mis-tap, not real
      // content — re-prompt instead of logging "1"/"2"/"3" as the answer.
      if (text === '1' || text === '2' || text === '3') {
        await sendWhatsApp(phone, isEnquiry
          ? `Please describe your enquiry and your agent will get back to you.`
          : `Please describe the issue in one or two sentences.`
        );
        return;
      }
      if (isEnquiry) {
        await completeTenantEnquiry(phone, text, record, placeholderIssues[0]);
      } else {
        await completeTenantIssueIntake(phone, text, record, placeholderIssues[0]);
      }
      return;
    }

    // Check 6: tenant replied to the main menu with no active mid-flow state
    // above. 1 -> Flow T1 (issue intake, Group 1). 2 -> Flow T2 (call request,
    // Group 2). 3 -> Flow T3 (other enquiry, Group 3). Any other message =
    // tenant main menu (Menu Spec v1.1 — replaces straight-to-Flow-1 intake
    // from V1).
    if (text === '1') {
      await startTenantIssueIntake(phone, record);
      return;
    }
    if (text === '2') {
      await handleTenantCallRequest(phone, record);
      return;
    }
    if (text === '3') {
      await startTenantEnquiry(phone, record);
      return;
    }
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
