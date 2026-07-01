// /api/dashboard-data.js
// Wabiprop Agent Dashboard — read-only Airtable data endpoint
// Reads: WP_Issues, WP_Properties, WP_Tenants, WP_Leases
// Writes: nothing — dashboard never writes to Airtable directly. webhook.js remains
//         the single source of truth for all issue state transitions.
// Auth: session-gated via wp_dash_session cookie (see dashboard-auth.js)
// No AI. Deterministic logic only. Solar Geyser Principle.
//
// FIELD NAME REFERENCE — confirmed live from Airtable Meta API 1 Jul 2026:
//   WP_Issues:      "Issue Ref", "Issue Resolution Status", "Date Reported",
//                   "Tenant Whatsapp Number", "Contractor Name", "Resolution Note",
//                   "Issue Title". NOTE: "Linked Property" exists on this table but
//                   is empty on every live record sampled (confirmed via direct
//                   record fetch, not just schema) — Flow 1 never writes it. Property
//                   association is resolved via the tenant instead — see below.
//   WP_Properties:  "Property Name", "Full Address", "Owner Name" (+ built-in "id")
//   WP_Tenants:     "Full Name", "Whatsapp Phone Number", "Property Name"
//                   (denormalised — populated by scripts/seed-links.js)
//   WP_Leases:      "Lease End Date", "Days Until Expiry", "Property" (NOT "Linked
//                   Property" — this table names its link field differently),
//                   "Lease Status"
//   WP_Contractors: not queried — "Contractor Name" is denormalised onto WP_Issues.
//
// "Issue Resolution Status" live choices — schema was being actively edited
// during this build session; re-confirmed via Meta API immediately before
// this commit: Contractor Assigned, Owner Handling, Resolved, Closed, Status
// (junk/unused), Open, Contractor En Route, Pending Confirmation, Awaiting
// Reopen Detail, Confirming Reopen Detail, Call Requested. "Agent Attending"
// was not yet live as of that check — included below per Engineer's expectation
// it is forthcoming; harmless no-op until it exists (a status field can never
// match a string that isn't a real option).

const crypto = require('crypto');

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const COOKIE_NAME = 'wp_dash_session';

// ─── SESSION VERIFICATION ────────────────────────────────────────────────────
// Duplicated from dashboard-auth.js by design (Phase 1 review) — not imported,
// to keep this file fully self-contained.

function verifySession(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)wp_dash_session=([^;]+)/);
  if (!match) return false;

  const [expiryStr, sig] = decodeURIComponent(match[1]).split('.');
  if (!expiryStr || !sig) return false;

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;

  const expected = crypto.createHmac('sha256', DASHBOARD_PASSWORD).update(String(expiry)).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── AIRTABLE HELPER — paginated GET, returns every matching record ─────────

async function airtableGetAll(table, filterFormula) {
  let all = [];
  let offset;
  do {
    let url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?pageSize=100`;
    if (filterFormula) url += `&filterByFormula=${encodeURIComponent(filterFormula)}`;
    if (offset) url += `&offset=${encodeURIComponent(offset)}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    const data = await res.json();
    if (data.error) {
      console.error(`[dashboard-data Airtable ERROR] ${table}:`, JSON.stringify(data.error));
      throw new Error(`Airtable read failed for ${table}: ${JSON.stringify(data.error)}`);
    }

    all = all.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return all;
}

// ─── STATUS CLASSIFICATION ───────────────────────────────────────────────────
// "Call Requested" confirmed live. "Agent Attending" not yet confirmed live as
// of last check — included per Engineer sign-off; harmless no-op until it exists.

const TERMINAL_STATUSES = ['Resolved', 'Closed'];
const ACTIVE_STATUSES = [
  'Open', 'Contractor Assigned', 'Contractor En Route', 'Pending Confirmation',
  'Awaiting Reopen Detail', 'Confirming Reopen Detail',
  'Call Requested', 'Agent Attending', 'Owner Handling',
];
const STALE_MS = 48 * 60 * 60 * 1000; // 48 hours

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

function isActive(status) {
  return ACTIVE_STATUSES.includes(status);
}

function isStale(fields) {
  if (isTerminal(fields['Issue Resolution Status'])) return false;
  const reported = fields['Date Reported'];
  if (!reported) return true; // no timestamp at all — treat as stale, matches STALE command precedent in webhook.js
  return (Date.now() - new Date(reported).getTime()) > STALE_MS;
}

// ─── POPIA MASKING ────────────────────────────────────────────────────────────

function maskTenantName(fullName) {
  const trimmed = (fullName || '').trim();
  if (!trimmed) return 'Tenant';
  const parts = trimmed.split(/\s+/);
  const first = parts[0];
  const lastInitial = parts.length > 1 ? `${parts[parts.length - 1][0]}.` : '';
  return lastInitial ? `${first} ${lastInitial}` : first;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `**** **** ${digits.slice(-4)}`;
}

// ─── PROPERTY HEALTH SCORE — spec Section 4.1, computed fresh every load ────
// Open issues 40% | Stale issues 20% | Lease expiry 25% | Rejections 15%

function scoreOpenIssues(openCount) {
  if (openCount === 0) return 40;
  return Math.max(0, 40 - openCount * 20);
}

function scoreStaleIssues(staleCount) {
  if (staleCount === 0) return 20;
  return Math.max(0, 20 - staleCount * 10);
}

function scoreLeaseExpiry(daysUntilExpiry) {
  // No active lease on file (vacant property) — full marks. A vacant property
  // is not a lease-expiry risk. Confirmed with Engineer.
  if (daysUntilExpiry === null || daysUntilExpiry === undefined) return 25;
  if (daysUntilExpiry > 60) return 25;
  if (daysUntilExpiry < 21) return 0;
  return 12; // 21-60 days
}

function scoreRejections(rejectionCount) {
  if (rejectionCount === 0) return 15;
  return Math.max(0, 15 - rejectionCount * 5);
}

function healthBand(score) {
  if (score >= 80) return 'Healthy';
  if (score >= 50) return 'Watch';
  return 'At risk';
}

function currentQuarterStartMs() {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1).getTime();
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  if (!DASHBOARD_PASSWORD) {
    console.error('[dashboard-data] DASHBOARD_PASSWORD not set in environment');
    return res.status(500).json({ ok: false, error: 'Dashboard auth is not configured.' });
  }

  if (!verifySession(req)) {
    return res.status(401).json({ ok: false, error: 'Not authenticated.' });
  }

  try {
    const [issues, properties, tenants, activeLeases] = await Promise.all([
      airtableGetAll('WP_Issues'),
      airtableGetAll('WP_Properties'),
      airtableGetAll('WP_Tenants'),
      airtableGetAll('WP_Leases', `{Lease Status} = 'Active'`),
    ]);

    // Tenant lookup by WhatsApp phone number, for masked display on the issue list
    const tenantByPhone = new Map();
    tenants.forEach(t => {
      const phone = (t.fields['Whatsapp Phone Number'] || '').trim();
      if (phone) tenantByPhone.set(phone, t);
    });

    // Active lease per property record ID — already filtered to Lease Status = Active.
    // If a property somehow has more than one Active lease on file, keep the
    // soonest-expiring one (the one that should actually drive the health score).
    const activeLeaseByPropertyId = new Map();
    activeLeases.forEach(l => {
      const propIds = l.fields['Property'] || [];
      const days = l.fields['Days Until Expiry'];
      propIds.forEach(pid => {
        const existing = activeLeaseByPropertyId.get(pid);
        const existingDays = existing ? existing.fields['Days Until Expiry'] : undefined;
        if (!existing || (days !== undefined && days < existingDays)) {
          activeLeaseByPropertyId.set(pid, l);
        }
      });
    });

    // Resolve each issue's property via its tenant, not "Linked Property" (confirmed
    // empty on every live WP_Issues record — see field reference above). Every issue
    // reliably carries Tenant Whatsapp Number (already used for tenant-name masking
    // below), and WP_Tenants.Property Name is a denormalised field seeded by
    // scripts/seed-links.js.
    const issuePropertyName = new Map(); // issue.id -> resolved property name (or null)
    issues.forEach(iss => {
      const phone = (iss.fields['Tenant Whatsapp Number'] || '').trim();
      const tenantRec = phone ? tenantByPhone.get(phone) : null;
      const propertyName = tenantRec ? (tenantRec.fields['Property Name'] || null) : null;
      issuePropertyName.set(iss.id, propertyName);
    });

    // Group issues by resolved property name — no reliable record-ID link exists
    // from issue to property, so grouping is by name (matches WP_Properties.Property
    // Name exactly, since both are populated by the same seed-links.js pass).
    const issuesByPropertyName = new Map();
    issues.forEach(iss => {
      const propertyName = issuePropertyName.get(iss.id);
      if (!propertyName) return;
      if (!issuesByPropertyName.has(propertyName)) issuesByPropertyName.set(propertyName, []);
      issuesByPropertyName.get(propertyName).push(iss);
    });

    const now = Date.now();
    const quarterStart = currentQuarterStartMs();

    // ── Global pulse stats ────────────────────────────────────────────────
    const openIssues = issues.filter(iss => isActive(iss.fields['Issue Resolution Status']));
    const staleIssues = openIssues.filter(iss => isStale(iss.fields));

    // ── Per-property health scores ──────────────────────────────────────
    const propertyCards = properties.map(prop => {
      const propName = prop.fields['Property Name'] || 'Unknown property';
      const propIssues = issuesByPropertyName.get(propName) || [];
      const propOpenIssues = propIssues.filter(iss => isActive(iss.fields['Issue Resolution Status']));
      const propStaleIssues = propOpenIssues.filter(iss => isStale(iss.fields));

      // Rejection proxy: Resolution Note non-empty, bucketed by the issue's own
      // Date Reported falling in the current quarter. Approved proxy — only
      // handleTenantReopenDetail (Flow 4d) ever writes Resolution Note, and it
      // is never cleared, so it survives even after the issue later resolves.
      const propRejections = propIssues.filter(iss => {
        const note = (iss.fields['Resolution Note'] || '').trim();
        const reported = iss.fields['Date Reported'];
        return note && reported && new Date(reported).getTime() >= quarterStart;
      });

      const activeLease = activeLeaseByPropertyId.get(prop.id);
      const daysUntilExpiry = activeLease ? activeLease.fields['Days Until Expiry'] : null;

      const score =
        scoreOpenIssues(propOpenIssues.length) +
        scoreStaleIssues(propStaleIssues.length) +
        scoreLeaseExpiry(daysUntilExpiry) +
        scoreRejections(propRejections.length);

      return {
        id: prop.id,
        propertyName: prop.fields['Property Name'] || 'Unknown property',
        address: prop.fields['Full Address'] || '',
        ownerName: prop.fields['Owner Name'] || '',
        openIssueCount: propOpenIssues.length,
        staleIssueCount: propStaleIssues.length,
        daysUntilLeaseExpiry: daysUntilExpiry,
        healthScore: Math.round(score),
        healthBand: healthBand(score),
      };
    });

    // ── Full issue list, masked — client filters by status locally ───────
    const issueList = issues.map(iss => {
      const f = iss.fields;
      const phone = (f['Tenant Whatsapp Number'] || '').trim();
      const tenantRec = phone ? tenantByPhone.get(phone) : null;
      const tenantFullName = tenantRec ? tenantRec.fields['Full Name'] : '';
      const reported = f['Date Reported'];
      const daysOpen = reported ? Math.floor((now - new Date(reported).getTime()) / 86400000) : null;

      return {
        issueRef: f['Issue Ref'] || null,
        status: f['Issue Resolution Status'] || 'Unknown',
        tenantName: maskTenantName(tenantFullName),
        tenantPhoneMasked: phone ? maskPhone(phone) : null,
        contractorName: f['Contractor Name'] || null,
        daysOpen,
        stale: isStale(f),
        dateReported: f['Date Reported'] || null,
        active: isActive(f['Issue Resolution Status']),
        propertyName: issuePropertyName.get(iss.id) || null,
        // Strip the "TenantName — " prefix that handleTenantIssue (Flow 1) embeds
        // in Issue Title, leaving only the description after the first em-dash.
        issueTitle: f['Issue Title']
          ? f['Issue Title'].replace(/^[^—]+—\s*/, '').trim()
          : null,
      };
    });

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      pulse: {
        openIssuesCount: openIssues.length,
        staleIssuesCount: staleIssues.length,
      },
      issues: issueList,
      properties: propertyCards,
    });

  } catch (err) {
    console.error('[dashboard-data ERROR]', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load dashboard data.' });
  }
};
