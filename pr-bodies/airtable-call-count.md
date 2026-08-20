# Airtable call-count instrumentation

**Branch:** `feat/wabistay-airtable-call-count` → base `main` (independent — no dependency on the other batch items).

## What this adds
One `airtable_call_count` Axiom event per `runOwnerSummary`/`runDailySummary` invocation: `{ cronName, propertyCount, totalCalls, callsPerProperty, breakdown: { get, create, update } }`. Purpose: the Postgres/queue migration trigger (~100-150 properties, ~250-300 calls/run) was an **estimate** — this replaces it with real measured numbers from actual runs, ahead of Airtable's 5 req/sec per-base ceiling becoming a real problem.

## Mechanism
A single module-level "active counter" (`_activeAirtableCallCounter` in `api/wabistay/webhook.js`), incremented inside `airtableGet`/`airtableCreate`/`airtableUpdate`, set/restored around one run by a new `withAirtableCallCount(cronName, propertyCountRef, fn)` wrapper. Not threaded as an explicit parameter through every call site — that would touch dozens of call sites for no benefit, since `runOwnerSummary`/`runDailySummary` already run their per-property work sequentially in a single `for` loop with no concurrent Airtable calls in flight, so at most one counter is ever active. Save/restore (not a bare set/null) so nested or re-entrant calls attribute correctly.

**`propertyCount` means different things for the two crons, deliberately:**
- `owner_summary` — total properties scanned (all of them get a summary attempt every run).
- `daily_summary` — only properties that actually **fired** this run (matched the current SAST hour), not the total scanned. Most hourly invocations match zero or one property; using the total would make `callsPerProperty` meaningless (dominated by the one unconditional `WS_Properties` read on every one of the 23/24 runs a day that fire nothing).

## Why this couldn't just write to Airtable
Considered logging the count as an Airtable row for a trend view. Didn't: `runOwnerSummary`/`runDailySummary` have an existing, tested invariant that both crons are **read-only reporting with zero Airtable writes** (Rule 29, `test/dailysummary.test.js`). Axiom-only logging respects that; a dashboard over these events (if wanted later) is a separate, explicitly out-of-scope piece per the original ask ("no dashboard needed yet").

## Test coverage
New `test/airtablecallcount.test.js`, 4 tests: one event per run, correct `cronName`/`propertyCount`/`breakdown` shape for both crons, the zero-properties-fired edge case (no division by zero — `callsPerProperty: null`), and that back-to-back runs of both crons don't cross-contaminate each other's counts.

Full suite: 473 passing, 0 failing (this branch is independent of the other batch items' fixture changes, so the pre-existing 469 are untouched).
