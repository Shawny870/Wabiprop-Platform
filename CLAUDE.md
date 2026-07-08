# CLAUDE.md — Wabiprop + Wabistay Repo Contract
Teroch Projects (Pty) Ltd · v2 · 8 July 2026
This file is read at the start of EVERY Claude Code session. If code and this contract disagree, STOP and report to Shawn before touching anything.

## Three-role model
- CEO (Shawn): approvals, device testing, go/no-go only. Never writes code.
- Design Engineer (Claude AI): specs, architecture, transfer documents, challenge function.
- Builder (Claude Code): code execution only. NEVER pushes to main. NEVER deploys. NEVER merges.

## Session ritual — do in this order, every session, no exceptions
1. Read this file fully.
2. Read `FIXLOG.md` if it exists.
3. Read the session brief provided by Shawn (transfer document for this session).
4. Confirm AIRTABLE_BASE_ID from live Vercel env — read it, report the exact string before any Airtable call.
5. Run a live Airtable ping — single test API call confirming connection returns real data, not empty. PASS = proceed. FAIL = stop and report.
6. Confirm which single task this session builds. ONE task per session. No scope additions without CEO approval.
7. Build. Run tests if test suite exists.
8. Report what was built, what was tested, what was not tested.
9. Open a PR. NEVER push to main. NEVER deploy. Shawn merges.

## Hard rules
- Field names come from live Airtable schema or schema.json ONLY. Never type an Airtable field name from memory.
- Every Airtable call uses existing helpers. Log every call with HTTP status.
- Always return HTTP 200 to Meta immediately after receiving webhook (before async work).
- Verify HMAC X-Hub-Signature-256 on RAW body — raw bytes, not re-serialised JSON.
- Never refactor while adding a feature. Refactors are their own session, own PR.
- Never push to main. Never deploy to production. Never merge PRs. CEO only.
- Builder never pushes — Rule 26. This is non-negotiable and applies to every session.
- HTTP 200 from WhatsApp Send API means Meta accepted the request only — not delivery. Log async delivery callbacks to Axiom.
- Business-initiated sends (cleaner, owner, summaries) must use approved utility templates — free-form text silently fails outside the 24h window.
- Changes touching message templates, pricing values, state machine, or POPIA/consent code: label PR `needs-decision` — Shawn reviews before merging.
- Airtable is not transactional. After any room or record assignment, re-query to verify. On conflict, roll back and re-offer.

## Diagnostic protocol (3-lens rule — mandatory for every bug fix)
When a flow is broken:
1. Collect evidence first — read logs, read the relevant code, identify the exact failure point.
2. Diagnose from three distinct lenses — what broke, why it broke, what else could break from the fix.
3. Propose the fix with explicit statement of side effects.
4. Design Engineer (Claude AI) validates the proposal before Builder implements.
5. If side effects are uncertain — loop back to lens 2. Do not implement under uncertainty.
6. After fix: device test confirms the loop closes. Not code review — real device.

## What this codebase is
Two WhatsApp-native products on one repo:
- Wabiprop: property maintenance coordination for rental agents, tenants, contractors, owners.
- Wabistay: short-stay guest lodge booking and ops automation.

Stack: Node.js serverless on Vercel, Airtable as DB, Meta WhatsApp Cloud API v25.0, Axiom logging.
NO frameworks, NO TypeScript, NO ORMs, NO npm bloat. Deterministic state machine only — no AI in runtime flows.

## Routing architecture
- Master router: `api/webhook.js` — routes inbound messages by `phone_number_id`
- Wabiprop handler: `api/wabiprop/webhook.js`
- Wabistay handler: `api/wabistay/webhook.js`
- NEVER route Wabistay traffic through Wabiprop handler or vice versa.
- No hardcoded property strings, no global OWNER_PHONE. All config from Airtable.

## Locked constants — never derive from memory
- Repo: github.com/Shawny870/Wabiprop-Platform
- Branch: main
- Local repo path: C:\Users\smaha\wabiprop-platform
- Vercel URL: wabiprop-platform.vercel.app
- Master router: https://wabiprop-platform.vercel.app/api/webhook
- Wabiprop webhook: https://wabiprop-platform.vercel.app/api/wabiprop/webhook
- Wabistay webhook: https://wabiprop-platform.vercel.app/api/wabistay/webhook
- Production WABA number: 27730260871
- Wabiprop Phone Number ID: 1157302750805659
- Airtable Base ID: confirm from live Vercel env every session — do not use memory

## Do not touch list (unless explicitly instructed by CEO)
- api/webhook.js — master router, touch only in dispatch layer sessions
- Any file not related to the current session's single stated task
- .claude/settings.json — CEO-controlled permissions config
- Any production environment variable

## Known open bugs (as of 8 July 2026)
- BUG-04: Duplicate owner summaries in one cron run
- BUG-05: Owner salutation renders "Hi Mrs," with no name
- BUG-06: All monetary values display as R0.00
- BUG-07: Agent summary dead-end — no pagination
- BUG-08: "Questions? Reply" prompt has no inbound handler
- BUG-09: WhatsApp profile displays "MyNumber" not "Wabiprop"
- Dispatch layer defect: Wabistay messages routing through Wabiprop handler (current session priority)
