# Wabiprop · Session Transfer Document v10
**Teroch Projects (Pty) Ltd · Build Session Handoff**
Date: 27 June 2026 · Compiled end of session

---

## CRITICAL — READ THIS FIRST

This document supersedes v9. Every decision made in this session is captured here.
Claude Code must read this file before touching any file in the repo.
Do not derive any value from memory. Use only what is written here.

---

## Section 01 — Infrastructure State (Current)

### Repo structure — CONFIRMED CLEAN
```
Wabiprop-Platform/
├── api/
│   ├── webhook.js          ← Master router — ALL inbound messages enter here
│   ├── wabiprop/
│   │   └── webhook.js      ← P1–P5 built · Flows 1 + 2 awaiting live test
│   └── wabistay/
│       └── webhook.js      ← F1–F14 · DO NOT TOUCH
├── scripts/
│   └── seed-links.js       ← ONE-TIME MIGRATION — DO NOT RUN AGAIN (55/55 done)
├── README.md
└── vercel.json
```

### Local repo path: `C:\Users\smaha\wabiprop-platform`
### Branch: main
### Vercel: Pro plan — crons active

### Phone Number — CORRECTED THIS SESSION
```
Production phone number:   +27 73 026 0871
E.164 format:              27730260871
Phone Number ID:           1157302750805659   ← SINGLE real number on Teroch WABA
WABA ID:                   1034787886159027
```

1158666973993969 was Meta's sandbox test number. It is no longer valid. Do not use it.

### Meta Webhook URL — UPDATED THIS SESSION
```
https://wabiprop-platform.vercel.app/api/webhook
```
This is the master router. Register this single URL in Meta for +27730260871.
The old per-product URLs (/api/wabiprop/webhook, /api/wabistay/webhook) remain live for direct testing only.

### Airtable — FULLY SEEDED ✅
All tables renamed from NestlyHQ schema to WP_ prefix and seeded this session.
seed-links.js ran successfully — 55/55 WP_Tenants records patched with denormalised unit/property/owner/agent data.

| Table | Records | Status |
|---|---|---|
| WP_Properties | 4 | ✅ Clean |
| WP_Owners | 4 | ✅ Clean |
| WP_Units | 60 | ✅ Clean |
| WP_Agents | 1 | ✅ Clean |
| WP_Contractors | 3 | ✅ Clean |
| WP_Tenants | 55 | ✅ Clean · denormalised fields populated |
| WP_Issues | 32 | ✅ Clean |
| WP_Leads | — | ✅ Required for master router — must exist with Phone Number + Lead Type fields |

### Meta Business Verification — STILL IN REVIEW ⏳
- Submitted: 26 June 2026
- Status: In Review — do not resubmit
- Until cleared: WhatsApp delivery limited to allowed list only

---

## Section 02 — Locked Constants (Never Derive From Memory)

```
GitHub:               github.com/Shawny870/Wabiprop-Platform
Branch:               main
Local repo:           C:\Users\smaha\wabiprop-platform
Vercel URL:           wabiprop-platform.vercel.app
Master Webhook URL:   https://wabiprop-platform.vercel.app/api/webhook
Wabiprop Webhook:     https://wabiprop-platform.vercel.app/api/wabiprop/webhook  (testing only)
Wabistay Webhook:     https://wabiprop-platform.vercel.app/api/wabistay/webhook  (testing only)
Phone Number:         27730260871
Phone Number ID:      1157302750805659   ← used by BOTH products
WABA ID:              1034787886159027
App ID:               1045666914802356
Airtable Base:        appgtVqX1dK88lpRT
Verify Token:         wabiprop2026
Airtable Token:       [stored in .env — never commit · starts with patQFjOHLLg]
Axiom Token:          [stored in Vercel Production · starts with xaat-49012c39]
Axiom Dataset:        wabiprop  (router + wabiprop flows)
Axiom Dataset:        wabistay  (wabistay flows — existing)
Shawn's number:       27780384989
Girlfriend:           27732273477
Rose Madiwa:          27784896186
Second SIM:           27730260871
```

### Vercel Environment Variables — ALL CONFIRMED LIVE
| Key | Value | Notes |
|---|---|---|
| `WA_PHONE_NUMBER_ID` | `1157302750805659` | Wabistay reads this |
| `WP_PHONE_NUMBER_ID` | `1157302750805659` | Wabiprop reads this |
| `WA_VERIFY_TOKEN` | `wabiprop2026` | Shared — both products |
| `WA_ACCESS_TOKEN` | (encrypted in Vercel) | Meta permanent token |
| `WA_APP_SECRET` | (encrypted in Vercel) | Meta App Secret |
| `AIRTABLE_API_KEY` | [in .env — never commit] | Starts with patQFjOHLLg |
| `AIRTABLE_BASE_ID` | `appgtVqX1dK88lpRT` | |
| `OWNER_PHONE` | `27732273477` | |
| `AXIOM_TOKEN` | `xaat-49012c39-d370-4e13-94bd-911ae05beac5` | |

### CRITICAL — Env Var Safety Rule
**All env vars must be set via `printf` in Bash — never PowerShell `echo`.**
PowerShell `echo` outputs UTF-16 LE with a BOM character (`﻿`) prepended to the value.
Meta API rejects the BOM with error code 100.

Correct method:
```bash
printf '%s' '1157302750805659' | vercel env add WA_PHONE_NUMBER_ID production
```

Never use:
```powershell
echo "1157302750805659" | vercel env add WA_PHONE_NUMBER_ID production  # WRONG — BOM risk
```

---

## Section 03 — Demo Role Assignments

| Number | Person | Demo Role |
|---|---|---|
| 27780384989 | Shawn | Agent Sarah Dlamini |
| 27784896186 | Rose Madiwa | Sipho Nkosi Plumbing (contractor) |
| 27732273477 | Girlfriend | Ayanda Khumalo (tenant) |

---

## Section 04 — Airtable Table Names (WP_ prefix — ALL RENAMED THIS SESSION)

### V1 Tables — webhook reads/writes these
| Table | Purpose |
|---|---|
| WP_Agents | Agent lookup by phone number |
| WP_Properties | Property records with owner phone |
| WP_Units | Individual units within properties |
| WP_Tenants | Tenant lookup by phone number |
| WP_Contractors | Contractor lookup by name |
| WP_Issues | Core issue tracking — webhook writes status here |
| WP_Leads | Master router session state — Lead Type = Wabiprop or Wabistay |

### WP_Leads — Required Fields
| Field | Type | Values |
|---|---|---|
| `Phone Number` | Single line text | E.164 format e.g. 27732273477 |
| `Lead Type` | Single select | `Wabiprop` or `Wabistay` (blank = menu shown, choice pending) |

If field name `Phone Number` is wrong, Axiom will log `[Router Airtable ERROR]` on first hit — check and correct.

### V2 Tables — cron jobs read these
| Table | Purpose |
|---|---|
| WP_Leases | Lease expiry dates for V2 cron |
| WP_Payments | Rent payment status for V2 cron |
| WP_Owners | Owner WhatsApp for batched summaries |

### V3/V4 Tables — do not build against yet
WP_CommsLog, WP_Inspections, WP_Utilities, WP_TaxDocs, WP_Commissions

### Wabistay Tables — DO NOT TOUCH
WS_Bookings, WS_Rates, WS_Properties, WS_Owners

---

## Section 05 — WP_Issues Status Values (exact strings — webhook must match)

```
Open
Contractor Assigned
Contractor En Route
Pending Confirmation
Resolved
Owner Decision
```

---

## Section 06 — Complete V1 + V2 Flow Spec (LOCKED THIS SESSION)

### V1 Flows — webhook.js

**Flow 1 — Tenant intake**
- Trigger: Tenant sends any message
- Lookup tenant by phone in WP_Tenants
- Create WP_Issues record (Status=Open)
- Send acknowledgement to tenant with ref number
- Send notification to agent with full detail
- Reply format: "Reply 'Assign [contractor name]' to dispatch"

**Flow 2 — Agent assigns contractor**
- Trigger: Agent replies "Assign [name]"
- Parse contractor name → lookup in WP_Contractors
- PATCH issue: Status=Contractor Assigned + Contractor Name + Contractor Phone
- Send job details to contractor (address, tenant name, tenant phone, issue)
- Send confirmation to tenant (contractor assigned)
- Send confirmation to agent

**Flow 3 — Contractor en route**
- Trigger: Contractor sends "on my way" / "omw" / "coming now" / "leaving now"
- PATCH issue: Status=Contractor En Route
- Notify tenant contractor is coming
- Notify agent of status update

**Flow 4 — Issue closure**
- Trigger: Contractor sends "done"
- PATCH issue: Status=Pending Confirmation
- Send tenant closure WITH yes/no confirmation request
- Send agent summary
- Send contractor confirmation

**Flow 4b — Tenant confirms closure**
- Trigger: Tenant replies "YES" or "1"
- PATCH issue: Status=Resolved + Resolved Time timestamped
- Notify agent issue confirmed resolved

**Flow 4c — Tenant rejects closure**
- Trigger: Tenant replies "NO" or "2"
- PATCH issue: Status=Open
- Notify agent issue reopened — must reassign

**Flow 5 — Contractor escalation**
- Trigger: Contractor sends "needs assessment"
- PATCH issue: Status=Owner Decision
- Notify agent with full detail + prompt to send owner briefing

**Flow 6 — REPORT command**
- Trigger: Agent sends "REPORT"
- Query all open WP_Issues for this agent sorted by Urgency (Emergency first)
- Return numbered list to agent
- Agent replies with number → return full issue detail

### V2 Flows — Vercel Pro Cron Jobs

**V2-1 — Lease expiry alerts**
- Schedule: Daily 8am
- Query WP_Leases where Lease End Date = today+30 OR today+7
- Send alert to agent with tenant name, unit, expiry date, current rent
- Flag: Renewal Notice Sent = true after sending

**V2-2 — Rent overdue alerts**
- Schedule: Daily 9am
- Query WP_Payments where Expected Payment Date < today-3 AND Actual Payment Date is null
- Send alert to agent with tenant, unit, amount, days overdue
- Send passive notification to owner simultaneously

**V2-3 — Owner decision batched summary**
- Schedule: Daily 7pm
- Query WP_Issues where Status=Owner Decision, group by Owner Phone
- Send numbered list to each owner
- Owner replies with numbers (e.g. "1, 3") = attending to those issues
- System notifies relevant tenants automatically
- Agent gets confirmation of owner selections

**V2-4 — Owner intelligence briefing**
- Trigger: Agent sends "BRIEFING [owner name]"
- Query WP_Issues last 12 months for that owner's properties
- Calculate: total issues, total cost, top issue category, most affected unit
- Recommend monthly maintenance reserve (total cost / 12 / unit count)
- Send briefing to agent before owner call

---

## Section 07 — Webhook Routing Logic

### Master Router — api/webhook.js
Single Meta webhook URL. All inbound messages enter here.

Routing decision tree (deterministic — Solar Geyser Principle):
```
Inbound message
│
├─ In WP_Agents / WP_Contractors / WP_Tenants?  → Wabiprop handler
│
├─ WP_Leads record exists with Lead Type = "Wabiprop"?  → Wabiprop handler
├─ WP_Leads record exists with Lead Type = "Wabistay"?  → Wabistay handler
│
├─ WP_Leads record exists, Lead Type blank (menu shown, pending choice)?
│   ├─ Replied "1"  → PATCH Lead Type=Wabiprop → Wabiprop handler
│   ├─ Replied "2"  → PATCH Lead Type=Wabistay → Wabistay handler
│   └─ Anything else → re-send menu, return 200
│
└─ Not in any table → CREATE WP_Leads (phone only) → send menu → return 200
```

Product menu (shown once per unknown number):
```
Hi! Please reply with a number:
1 - Report a maintenance issue
2 - Make a guesthouse booking
```

### Wabiprop Internal Router — api/wabiprop/webhook.js
Checks in order: WP_Agents → WP_Contractors → WP_Tenants

Agent commands: "Assign [name]", "REPORT", "BRIEFING [name]"
Contractor commands: "on my way", "omw", "coming now", "leaving now", "done", "needs assessment"
Tenant: any message triggers intake OR closure confirmation if issue is Pending Confirmation

---

## Section 08 — Key Airtable Field Names (exact strings for API calls)

### WP_Tenants
- `Full Name` — tenant name
- `Whatsapp Phone Number` — lookup field (lowercase 'app' — confirmed live)
- `Unit Address` — denormalised from WP_Units (seeded by seed-links.js)
- `Property Name` — denormalised from WP_Properties (seeded by seed-links.js)
- `Owner Phone` — denormalised from WP_Properties (seeded by seed-links.js)
- `Agent WhatsApp Number` — denormalised from WP_Properties (seeded by seed-links.js)
- `Tenant Status` — Active/Inactive

### WP_Issues
- `Issue Title` — primary field
- `Status` — single select (see Section 05)
- `Urgency` — Emergency / Urgent / Routine / Owner Decision
- `Tenant WhatsApp Number` — denormalised text
- `Agent WhatsApp Number` — denormalised text
- `Owner Phone` — denormalised text
- `Contractor Name` — denormalised text
- `Contractor Phone` — denormalised text
- `Property Name` — denormalised text
- `Description` — long text
- `Date Reported` — datetime auto
- `Date Resolved` — datetime
- `Cost` — currency ZAR
- `Issue Ref` — autonumber (returned by Airtable on create)

### WP_Contractors
- `Contractor Name` — lookup field
- `Phone (WhatsApp)` — phone field
- `Trade` — Plumber / Electrician / General
- `Active` — checkbox

### WP_Agents
- `Agent Name`
- `Agent WhatsApp Number` — note: lowercase 'app' confirmed live
- `Active` — checkbox
- `Test Mode` — checkbox

### WP_Properties
- `Property Name`
- `Owner Whatsapp` — note: lowercase 'app' confirmed live
- `Agent Phone`

### WP_Leads
- `Phone Number` — E.164 string (assumption — verify on first Axiom error)
- `Lead Type` — single select: `Wabiprop` or `Wabistay`

---

## Section 09 — Seed Data Summary (Demo Numbers)

### Agent
| Name | Phone |
|---|---|
| Sarah Dlamini | 27780384989 |

### Contractors
| Name | Phone | Trade |
|---|---|---|
| Sipho Nkosi Plumbing | 27784896186 | Plumber |
| Themba Electrical | 27730260871 | Electrician |
| General Mike Repairs | 27780384989 | General |

### Key Demo Tenants
| Name | Phone | Unit |
|---|---|---|
| Ayanda Khumalo | 27732273477 | 4 Acacia Close Boksburg |
| Thabo Mokoena | 27780384989 | 7 Jacaranda Ave Kempton Park |
| Patricia Sithole | 27784896186 | 3 Rietfontein Road Benoni |
| Solomon Dube | 27780384989 | 14 Mokoena Street Vosloorus |

---

## Section 10 — Build Rules (All Active)

| Rule | Summary |
|---|---|
| Rule 9 | Confirm any value/credential/ID before writing code |
| Rule 10 | All Airtable schema changes via Airtable AI prompts only |
| Rule 11 | All agent/tenant/contractor messages use numbered menus |
| Rule 12 | Never write or edit code without reading the live file first |
| Rule 13 | No mid-answer reversals |
| Rule 14 | Verify before solve |
| Rule 15 | Rabbit hole limit — 3 questions max |
| Rule 16 | New chat trigger with mandatory transfer document |
| Rule 17 | Verify platform plan compatibility before recommending integrations |
| Rule 18 | No code without a passing spec — input, output, test condition defined first |

### Solar Geyser Principle (LOCKED)
No AI inside any V1 or V2 flow. Deterministic logic only. Every message is templated. No dynamic generation.

### Env Var Rule (NEW — added this session)
All Vercel env vars must be set via `printf '%s' 'value' | vercel env add NAME production` in Bash.
Never use PowerShell echo. See Section 02 for full detail.

---

## Section 11 — Operating Model

**Shawn — CEO**
Vision, outcome, client relationships, approvals. Does not touch code. Does not touch Airtable manually.

**Claude.ai — Design Engineer / Chief of Staff**
Specs, architecture, flow logic, transfer documents, rules. Challenges weak thinking. Holds context.

**Claude Code — Builder**
Reads repo directly. Writes code. Verifies Airtable schema via API before using field names. Runs tests. Pushes commits. Makes no product decisions.

---

## Section 12 — Demo Strategy

**Format:** Live Zoom screen share — WhatsApp Web. All flows fire in real time.
**Character:** Agent Sarah Dlamini — 47 properties across Boksburg, Vosloorus, Benoni, Kempton Park.
**Opening hook:** "If you manage more than 20 properties off your personal WhatsApp — this is your Friday."
**Closing line:** "Same agent. Same properties. Different Friday."
**CTA:** Reply YES · First month free · First 10 agents only · 27780384989

### 8 Live Demo Sequences
1. Tenant issue intake (Flow 1)
2. Agent assigns contractor (Flow 2)
3. Contractor en route (Flow 3)
4. Issue closure + tenant confirmation (Flow 4 + 4b)
5. REPORT command with drill-down (Flow 6)
6. Lease expiry alert (V2-1 — trigger manually)
7. Rent overdue alert (V2-2 — trigger manually)
8. Owner intelligence briefing (V2-4 — BRIEFING command)

**Pilot offer:** R750 onboarding + R60/month base + R29/property/month. First 10 agents = first month free, locked pricing 12 months.

---

## Section 13 — What Is NOT Yet Built (Priority Order for Claude Code)

| Priority | Task | Status |
|---|---|---|
| 1 | GET verification handler + POST router skeleton | ✅ BUILT (P1) |
| 2 | Flow 1 — tenant intake | ✅ BUILT (P2) · AWAITING LIVE TEST |
| 3 | Flow 2 — agent assigns contractor | ✅ BUILT (P3) · AWAITING LIVE TEST |
| 4 | Master router — api/webhook.js | ✅ BUILT (R1) · Register in Meta before testing |
| 5 | Register master webhook URL in Meta | ⬜ NOT DONE — URL: https://wabiprop-platform.vercel.app/api/webhook |
| 6 | Live test Flows 1 + 2 on allowed numbers | ⬜ BLOCKED until Meta URL registered |
| 7 | Build Flow 3 — contractor en route | ⬜ Do not build until Flow 2 confirmed |
| 8 | Build Flow 4 + 4b + 4c — closure + tenant confirmation | ⬜ Not started |
| 9 | Build Flow 5 — contractor escalation | ⬜ Not started |
| 10 | Build Flow 6 — REPORT command | ⬜ Not started |
| 11 | Build V2-1 — lease expiry cron | ⬜ Not started |
| 12 | Build V2-2 — rent overdue cron | ⬜ Not started |
| 13 | Build V2-3 — owner decision batched summary | ⬜ Not started |
| 14 | Build V2-4 — BRIEFING command | ⬜ Not started |
| 15 | Film demo sequences | ⬜ Not started |

---

## Section 14 — Known Issues

| Issue | Priority | Action |
|---|---|---|
| Meta Business Verification in review | CRITICAL — WAITING | Do not resubmit. Submitted 26 June 2026 |
| Third-party WhatsApp delivery blocked | Blocked by above | Clears on verification |
| Master webhook URL not yet registered in Meta | NEXT ACTION | Register https://wabiprop-platform.vercel.app/api/webhook |
| WP_Leads Phone Number field name unconfirmed | Low | Will surface in Axiom on first unknown-number hit |
| Wabistay Check In/Out writing to Notes not date fields | Post-demo | Do not touch |
| Nights = NaN | Post-demo | Resolves when date fields fixed |
| Axiom email on personal Gmail | Non-urgent | Migrate to Teroch business email |

---

## Section 15 — Wabistay — DO NOT TOUCH

Wabistay is confirmed working end-to-end. F1–F14 applied. Do not touch `api/wabistay/webhook.js` during Wabiprop build.
Wabistay reads `WA_PHONE_NUMBER_ID` env var. Wabiprop reads `WP_PHONE_NUMBER_ID`. Both point to `1157302750805659`.

---

## Section 16 — Files To Attach Every Session

| File | Why |
|---|---|
| `Wabiprop_Transfer_v10.md` | This document — current build state |
| `Wabiprop_Demo_Bible.docx` | Full seed data, voiceover script, 32 issues |
| `Property_Management_Airtable_Reference.html` | All table names, field names, field types — WS_ and WP_ |
| `Wabiprop_Spec_Lock.html` | Rules 1–18, architecture decisions |
| `Wabiprop_V1_Blueprint.html` | Flow specs |

---

## Section 17 — Opening Instruction for Claude Code

Paste this exactly as the first message in Claude Code:

```
Read Wabiprop_Transfer_v10.md in full before doing anything else.

Then confirm:
1. Repo structure matches Section 01 — api/webhook.js exists, api/wabiprop/webhook.js exists, api/wabistay/webhook.js exists
2. Read vercel.json and confirm contents
3. List environment variable names only (not values) from Vercel — confirm WA_PHONE_NUMBER_ID and WP_PHONE_NUMBER_ID are both present
4. Confirm api/wabistay/webhook.js line count has not changed from 526 lines

Do not create or edit any files until you have reported all four findings and received confirmation to proceed.

Next priority: confirm master webhook URL is registered in Meta, then run live test of Flow 1 and Flow 2 on allowed numbers.
```

---

## Section 18 — This Session Summary (What Changed From v9)

### Architecture changes
- Master router created at `api/webhook.js` — single Meta webhook URL for both products
- WP_Leads session routing added — unknown numbers shown product menu (1 = Wabiprop, 2 = Wabistay), choice stored in Lead Type field
- Wabiprop webhook now reads `WP_PHONE_NUMBER_ID` (not `WA_PHONE_NUMBER_ID`) — separate env var per product

### Phone number corrections
- Discovered 1158666973993969 was Meta's sandbox test number — now invalid
- Real production number: +27730260871 / Phone Number ID: 1157302750805659
- Both `WA_PHONE_NUMBER_ID` and `WP_PHONE_NUMBER_ID` set to 1157302750805659 in Vercel Production
- BOM character bug identified: PowerShell echo prepends `﻿` — all env vars must use `printf` in Bash going forward

### Code built this session
- `api/wabiprop/webhook.js` — P1 (router), P2 (Flow 1), P3 (Flow 2), P4 (env var split), P5 (Axiom logging)
- `api/webhook.js` — R1 (master router with WP_Leads session routing)
- `scripts/seed-links.js` — ran once, 55/55 WP_Tenants patched, do not run again

### Axiom datasets
- `wabistay` — existing, Wabistay flows
- `wabiprop` — new this session, router + Wabiprop flows (source field distinguishes router vs flow events)

---

*Wabiprop Transfer v10 · 27 June 2026 · Teroch Projects (Pty) Ltd*
*Supersedes v9 · Next document: v11 after Flows 1 + 2 confirmed working on live devices*
