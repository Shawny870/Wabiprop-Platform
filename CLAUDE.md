# CLAUDE.md — Wabistay Repo Contract
Teroch Projects (Pty) Ltd · v1 · 5 July 2026
This file is read at the start of EVERY Claude Code session. It is the code-level twin of the Wabistay Build Bible (kept in Claude chat / project docs). If code and this contract disagree, STOP and ask Shawn.

## What this codebase is
WhatsApp-native booking + ops platform for SA guest lodges. Node serverless on Vercel, Airtable as DB, Meta WhatsApp Cloud API (v25.0), Axiom logging. NO frameworks, NO TypeScript, NO ORMs, NO npm bloat. Deterministic state machine only — no AI in runtime flows.

## Session ritual (do in this order, every session)
1. Read this file fully. Read `FIXLOG.md`. Read `WABISTAY_SESSION_BRIEF.md` for current decisions/build state.
2. Run schema drift check: `node scripts/schema-diff.js` (live Airtable metadata vs `schema.json`). Mismatch → STOP, report, wait.
3. Confirm which single B-step (from the brief) this session builds. ONE B-step per session. No scope additions.
4. Build. Then run tests: `node --test`. All fixtures must pass.
5. Append to `FIXLOG.md` (keep F-numbering) and update `states.json` if transitions changed.
6. Open a PR titled with the B-number (e.g. "B6: WS2 hourly core"). NEVER push to main. NEVER deploy. Shawn merges (Rule 26: CEO pushes only).

## Hard rules
- Field names come from `schema.json` ONLY. Never type an Airtable field name from memory.
- `node scripts/schema-diff.js --write` is a SHAWN-ONLY command, used after a deliberate schema change. Never run `--write` to clear a failing diff — a failing diff means STOP, report, wait.
- State machine lives in `states.json` (state → input → next state → sends). Handlers read the table. No new nested if-state logic.
- Every bug fixed gets a fixture in `fixtures/` (real Meta payload + expected outcome) so it can never regress silently.
- Never refactor while adding a feature. Refactors are their own session with their own PR.
- All Airtable/Meta calls go through the existing helpers (`airtableGet/Create/Update`, `sendWhatsApp`). Log every call with HTTP status (F6 pattern).
- Always return HTTP 200 to Meta after processing (F2). Verify HMAC X-Hub-Signature-256 on the RAW body (B1) — raw bytes, not re-serialised JSON.
- Business-initiated sends (cleaner, owner, OTP, summaries) must use approved utility templates — free-form text silently fails outside the 24h window.
- Guest-facing copy: warm, short, SA-natural, numbered menus with one-line descriptors (Rule 11). One Wabistay voice for all properties.
- Times are SAST; Vercel runs UTC — convert explicitly, test checkout times.
- Changes touching message templates, pricing values, `states.json`, or POPIA/consent code: label the PR `needs-decision` — Shawn reviews these against the Bible before merging.
- Airtable is not transactional: after any room assignment, re-query to verify sole ownership; on conflict roll back and re-offer.
- Staging first: preview deploys use the staging Airtable base + test number. Production config only via `main`.

## Key architecture decisions (from the Bible — do not re-litigate)
- Multi-tenancy: one webhook, many numbers, routed on receiving `phone_number_id` → WS_Properties (D5). No hardcoded property strings, no global OWNER_PHONE.
- Cleaner dispatch fires on checkout; PAID only records payment (D4). Cleaner no-response: re-ping +20min, alert manager +40min (D20).
- Auto-checkout at expiry +15min; manager never actions checkout. T-15 extension offer.
- STOP: two-tier — kills all optional messaging instantly; transaction-completion messages continue until active booking closes, then silence. Timestamp everything (D-round5).
- POPIA consent = message #1, always, demos included (D11).
- BLOCK ROOM X <dates> / UNBLOCK: manual availability stopgap until NightsBridge sync (D21).
- Number changes: OTP to the NEW number before swap; 7-day audit log; notify both (D8).
