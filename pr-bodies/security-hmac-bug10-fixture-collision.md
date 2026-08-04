# Security + integrity: HMAC gate, BUG-10, fixture collision

**Label:** `needs-decision` (security-relevant code, per CLAUDE.md)
**Branch:** `security/hmac-bug10-fixture-collision` (off `origin/main` @ `40ee34b`)
**FIXLOG:** F31
**Suite:** 141/142 → **156/156**

> ⚠ **This PR does not close the security gate.** It builds the gate and ships it in report-only mode. Closing it is a two-step env change described below, and step 2 must not happen until step 1's telemetry is checked. Read "Rollout" before merging.

---

## 1. B1 — webhook signature verification

### What was wrong

B1 had never been built. `CLAUDE.md` rule 25 has asserted *"Verify HMAC X-Hub-Signature-256 on RAW body — raw bytes, not re-serialised JSON"* since the contract was written, and the 5 Jul spec marked it a **GATE**. A grep of both entry points on `origin/main` for `hmac|x-hub-signature|createHmac|APP_SECRET` returned **zero matches**.

Anyone who learned the webhook URL — it is not a secret; it is in `CLAUDE.md`, in Meta's dashboard, and in any leaked log line — could POST a forged payload and drive the entire state machine: create bookings, hold rooms against real inventory, trigger cleaner dispatch to real phones, cancel other guests' bookings.

**Why it stayed open for a month is a numbering artefact, not a decision.** B1 belongs to the 5 Jul scheme (`WABISTAY_SESSION_BRIEF.md`), superseded on 16 Jul by `Wabistay_Full_Build_Spec_Sequence.md` — which **starts at B7**. Five of B1–B6 were renumbered into the new scheme and shipped under different numbers. B1 alone had no successor slot and was dropped silently: the same failure mode as the "Backlog #2/#8 orphaned" pattern the build queue explicitly warns about.

### The raw-body problem, and why the code refuses to fake it

Meta signs **the exact bytes it sent**. `JSON.stringify(req.body)` re-serialises them and produces a different digest — key order, whitespace, unicode escaping all differ. A re-serialised comparison would report `verified` while proving nothing: strictly worse than no check, because it looks like security.

So `readRawBody` returns `raw: null` when it cannot get the original bytes, and `verifySignature` reports `no_raw_body` rather than reconstructing. Getting real bytes required `module.exports.config = { api: { bodyParser: false } }` on `api/webhook.js` plus a stream read; the parsed payload is re-attached as `req.body`, so **all six downstream dispatch sites are untouched** and product handlers are unaffected.

### Three modes — and why the default is not a bare 403

The brief asked for a 403 on mismatch. That is implemented, but it is **not** the default, because two preconditions cannot be verified from a laptop:

1. `META_APP_SECRET` being set in the deployed environment.
2. Vercel actually honouring `bodyParser: false` via a **CommonJS** property assignment.

If (2) is wrong, `req.body` still arrives parsed, the raw bytes are gone, and a bare 403 rejects **every** inbound webhook the instant the secret is set. Meta retries, then disables the subscription. Wabistay goes fully dark — no bookings, no gate arrival, no cleaner dispatch — and the cause looks like a Meta outage, not a config flag.

The original B1 spec already said *"log-only first, then enforce."* That sequencing is load-bearing. `HMAC_MODE`:

| Mode | Behaviour |
|---|---|
| unset / `log` | **Default.** Verify, log verdict to Axiom, **always pass through**. Gate is open. |
| `enforce` | Verify, return **403 before any handler logic**. Gate is closed. |
| `off` | No check. |

Hardening: a missing secret is **never** a pass (fails closed in `enforce`, logs `error` in `log`); an unrecognised `HMAC_MODE` value falls back to `log`, never `off`, so a typo cannot silently disable the check; `no_raw_body` — the precise signal that precondition (2) failed — is reported rather than guessed past.

### Rollout — order matters

1. Set `META_APP_SECRET` in Vercel (Meta App Dashboard → Settings → Basic → App Secret). **Leave `HMAC_MODE` unset.** Deploy. Traffic behaviour is unchanged.
2. Watch Axiom for `hmac_signature_check` on real inbound traffic:
   - `reason: 'verified'` consistently → safe to set `HMAC_MODE=enforce`. **This is the step that closes the gate.**
   - `reason: 'no_raw_body'` → the parser config did not take. **Do not enforce.** Report it; it needs a code fix, not an env change.
   - `reason: 'signature_mismatch'` on genuine traffic → wrong secret, or the wrong app's secret.

### Tests — `test/hmac.test.js`, 14 tests

Digest correctness (genuine / tampered / wrong-secret / malformed header / missing header), the re-serialisation trap asserted explicitly (`raw === null`, verdict `null`, never `true`), all three modes, and **router-level** proof that forged traffic in `enforce` yields `403` with **zero sends and zero Airtable writes**. The router-level tests exist because a lib-only suite would pass while production forwarded forgeries to a product handler.

**Mutation:** flipping the default from `log` to `enforce` fails exactly the three safe-deploy tests and nothing else — the safe-deploy guarantee is load-bearing, not incidental.

---

## 2. BUG-10 — red for 19 days

`CLAUDE.md` recorded one cause. There were **two**, which is why "trivially fixable" kept not being true:

1. No `WS_Properties` seed → 6.4's `resolveProperty()` returned null → handler took the "not configured yet" refusal path (fixture 15) instead of greeting.
2. Once seeded, `assert.strictEqual(ctx.sends.length, 1)` **still** failed — that assertion predates **B13**. A genuinely new guest now correctly receives the consent notice *then* the greeting. Fixture 01 already asserts exactly this; the router test was never synced.

Fixed both, and the assertions now check message #1 *is* the consent notice and #2 *is* the greeting — so a consent regression fails loudly instead of collapsing into a count.

---

## 3. Fixture 61 collision

`61_start_opts_back_in.json` (B14/F24, 23 Jul) and `61_manual_checkout_property_scoped.json` (F28, 27 Jul) both claimed 61 — invisible in test output, since both load and both pass.

**F24's moved to `66_start_opts_back_in.json`. F28's keeps 61.** This inverts the brief's suggested direction, on evidence gathered after the brief was written: F28's fixture is cited by number in **six** places (FIXLOG F28, `pr-bodies/b10-5-bug2-property-scoping.md`, `pr-bodies/b11-5-cleaner-guest-precedence.md`, `pr-bodies/cleaner-gate-notify.md`, `test/autocheckout.test.js`, `fixtures/65`), where F24's had exactly **one**. Renumbering the referenced one would have falsified the record of already-merged work. Confirmed with the CEO before acting. One FIXLOG line updated; both fixtures pass under their corrected numbers.

---

## Files

| File | Change |
|---|---|
| `lib/hmac.js` | **new** — verification lib, deliberately outside `api/` so Vercel never treats it as a function |
| `api/webhook.js` | require lib · verify before handler logic · re-attach `req.body` · `bodyParser: false` |
| `test/hmac.test.js` | **new** — 14 tests |
| `test/router.dispatch.test.js` | BUG-10: `WS_Properties` seed + B13-aware assertions |
| `fixtures/61_start_opts_back_in.json` | → `fixtures/66_start_opts_back_in.json` |
| `docs/env.md` | `META_APP_SECRET`, `HMAC_MODE`, two-step rollout (see note below) |
| `FIXLOG.md` | F31; F24's fixture reference 61 → 66 |
| `CLAUDE.md` | BUG-10 marked resolved; rule 25 implementation-status note |

## Not done / flagged

- **`api/wabistay/webhook.js` has its own public URL and is NOT signature-checked by this PR.** The router is the Meta-configured entry point (confirmed in the B3 commit), so it is the one that matters in production — but the direct URL remains an unauthenticated path into the same state machine. Scoping it needs a decision: verify there too, or stop exposing it. **Recommend its own session; not folded in here, per the no-refactor-while-building rule.**
- The `bodyParser: false` CJS export is **unverified from local** and can only be confirmed by deploy telemetry. This is precisely what report-only mode exists to surface — see Rollout step 2.
- `META_APP_SECRET` is **not set anywhere**; obtaining it is a CEO action. Credential handling never passes through Builder.
- **Env docs went to `docs/env.md`, not `.env.example`.** `.gitignore` matches `.env*`, so `.env.example` has never been tracked — it exists only on individual machines. Worth noting for the reconciliation: H0's FIXLOG entry claims *"staging env split documented in `.env.example`"* as a delivered item, but that documentation is not in the repo and never was. `docs/env.md` (added by F30) is the tracked replacement and already says so in its own header.
