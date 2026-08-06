# F32 — Axiom logs went to a dataset that does not exist, and nothing could tell us

**Label:** `needs-decision` (changes observability routing for both products)
**Branch:** `fix/axiom-dataset-silent-drop` → `main`
**Suite:** 156/156 → **162/162**

## What was broken

Three of the four `logToAxiom` copies POSTed to:

```
https://api.axiom.co/v1/datasets/wabiprop/ingest
```

**There is no `wabiprop` dataset.** The Axiom org (`Wabistay` — the only org on the account) contains exactly four datasets:

```
otel-demo-metrics
otel-demo-traces
sample-http-logs
wabistay
```

Every ingest to the nonexistent one was rejected 404 and discarded. What was lost:

| Source | Status |
|---|---|
| `api/webhook.js` — the entire router | **all logs dropped** |
| `api/wabiprop/webhook.js` | **all logs dropped** |
| `api/wabiprop/_lib/cronHelpers.js` | **all logs dropped** |
| `api/wabistay/webhook.js` | worked — correct name all along |

That includes `router_fatal`, so **router crashes have been unobservable for the life of the file**, and `hmac_signature_check`, which is what made the B1 rollout gate unverifiable.

Only Wabistay ever reached Axiom, and that is exactly why nobody noticed: Wabistay is the live product, its logging worked, and the silent half belongs to a product that is currently parked.

## The root cause is not the typo — it is that the typo could not be seen

`fetch()` **does not reject on 4xx/5xx. It resolves.** Every logger handled only `.catch()`, which fires on network failure alone. A 404 was therefore indistinguishable from a 200: nothing thrown, nothing logged, nothing printed. The failure was structurally invisible for weeks.

The test harness was equally complicit. `test/harness.js` matched Axiom calls on `hostname` alone and ignored the dataset path entirely, returning a cheerful 200 for any name. **That is how a dataset name that could never work passed 156 tests.**

## How it was found

While diagnosing why `hmac_signature_check` (F31) showed zero rows on live traffic. The check was running correctly the whole time — Meta's own webhook test appeared in Vercel runtime logs:

```
10:40:32.00  wabiprop-platform.vercel.app  error  λ POST /api/webhook
[Router] from: 16315551181 | text: this is a text message | phone_number_id: 123456123
[Router] Unknown phone_number_id: 123456123
```

That console output is `api/webhook.js:269`, downstream of the HMAC block at 130–133. Execution reached it, so the check ran and the log call fired — while Axiom stayed empty.

## Why `wabistay` and not a new `wabiprop` dataset

Both options were on the table. Creating the missing dataset was rejected for three reasons:

1. **It would leave the repo depending on an Axiom provisioning step no test can verify and nothing fails without** — the same orphan-gate failure mode that left B1 unbuilt for six weeks. If the dataset is never created, the code still drops everything and still looks fixed.
2. **Wabiprop is parked** (`WP_PHONE_NUMBER_ID_CONST = null`). A dataset nobody watches is operationally identical to dropping.
3. **The router is shared infrastructure, not a Wabiprop component.** 100% of its live traffic is Wabistay. Filing `hmac_signature_check` under a Wabiprop dataset is precisely the category error that cost three rounds of diagnosis this session.

All four loggers now target `wabistay` through a named `AXIOM_DATASET` constant, and **every record carries `source`** — `router` / `wabiprop` / `wabiprop-cron` / `wabistay` — so product separation survives as a filterable field rather than a dataset boundary that fails silently. Splitting them again when Wabiprop unparks is then a deliberate decision with a real watcher, not an implicit dependency.

## Root-cause fix

Every logger now inspects the response:

```js
.then(res => {
  if (!res.ok) console.error(`[Axiom ERROR] ingest rejected: HTTP ${res.status} dataset=${AXIOM_DATASET} event=${event}`);
})
.catch(err => console.error('[Axiom ERROR]', err.message));
```

`console.error` is the correct sink **precisely because it does not depend on Axiom working** — Vercel's own runtime logs captured console output throughout this session's diagnosis. Fire-and-forget is preserved deliberately: awaiting the ingest would delay Meta's 200 and violate rule 24.

## Tests

`test/axiom.logging.test.js` — 6 tests:

- the router's live ingest target is a dataset that actually exists
- it is specifically not `wabiprop`
- `source` survives the collapse into one dataset
- a static sweep of all four logger files — the Wabiprop handler and cron helpers are unreachable at runtime (parked, and scheduled) so source assertions are the only way to pin them
- every logger checks `res.ok`
- a simulated 404 actually reaches `console.error`

`test/harness.js` now records the dataset from the ingest URL so it can be asserted.

**Mutation:** restoring `wabiprop` in the router fails exactly 3 of the 6 and nothing else.

## Files

| File | Change |
|---|---|
| `api/webhook.js` | `AXIOM_DATASET` const · `wabiprop` → `wabistay` · response-status check |
| `api/wabiprop/webhook.js` | same · adds `source: 'wabiprop'` |
| `api/wabiprop/_lib/cronHelpers.js` | same · adds `source: 'wabiprop-cron'` |
| `api/wabistay/webhook.js` | dataset already correct · response-status check · adds `source: 'wabistay'` |
| `test/harness.js` | records ingest dataset instead of ignoring it |
| `test/axiom.logging.test.js` | **new** — 6 tests |
| `FIXLOG.md` | F32 |

## Not done / flagged

- **Backfill is impossible.** Every router and Wabiprop log written before this merge is gone — Axiom rejected them at ingest, they were never stored. Any past incident analysis that relied on router logs was working from an empty set.
- **Fire-and-forget still drops logs non-deterministically.** Vercel can freeze the instance at response, killing an in-flight ingest. This is unchanged and deliberate (rule 24), but it means Axiom is lossy by design and should not be treated as a complete record. Fixing it properly needs `waitUntil` or an await placed after the response — its own session.
- **`hmac_signature_check` should now appear in the `wabistay` dataset on the next real inbound message.** That is the F31 rollout gate: confirm `reason: 'verified'` there before setting `HMAC_MODE=enforce`.
- **A cron run returned 504** at `10:45:45` (`GET /api/wabistay/cron/auto-checkout`) where every other run returned 200. Unrelated to this fix, not investigated, flagged for a look.
- **`WA_APP_SECRET` exists in Vercel Production+Preview** (created 43d ago) alongside `META_APP_SECRET` (1d). No code reads the former. Worth reconciling whether it is a duplicate of the Meta app secret.
