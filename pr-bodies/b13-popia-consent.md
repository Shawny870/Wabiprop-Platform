# B13: POPIA consent notice

**Branch:** `feature/b13-popia-consent` → base `feature/b12-auto-checkout`
**Label:** `needs-decision` (consent code + guest-facing legal copy)
**FIXLOG:** F22

## What this adds
`handleMessage` sends a POPIA consent notice as **message #1** for a genuinely
new guest conversation. Notice-only, implied consent (LOCKED CEO 16 July) — **no
YES/1 opt-in gate**.

## "New" — defined precisely
First-ever contact from a number = **no existing `WS_Guests` record**. A
returning guest already has a record (in whatever Session State) and does **not**
see the notice again on a new booking. Confirmed against live Session State
handling, not assumed — fixture 54 seeds a returning guest in `NEW` and asserts
exactly one send (the greeting), proving the notice is suppressed.

Never sent to a **registered cleaner** (WS_Cleaners lookup) or the **owner**
(`phone === OWNER_PHONE`) — fixtures 55 and 56.

## Copy — pending Shawn's sign-off
The `consentNotice` copy is the CEO-supplied draft from the brief, reproduced
verbatim in wording:

```
Welcome to {propertyName} 👋

Quick note before we start: we collect your name, number and stay dates to manage
your booking. We keep it safe and don't share it with anyone. Carrying on with
this chat means you're OK with that.

Reply STOP anytime to opt out of messages.
```

The mid-paragraph line breaks in the brief's fenced block are treated as document
word-wrap and rendered as three flowing blocks. **Flagging for Shawn: confirm the
exact rendering before merge** (per the brief, the copy line is pending approval).
`{propertyName}` interpolates from `ctx.property` — one Wabistay voice, per-property name.

## Ordering dependency (important)
The STOP line references **B14** (Step 6 of this sprint). B14 provides the STOP
handler. **B13 must merge together with / after B14**, or the STOP instruction in
this notice has no handler behind it. Both are in this sprint's Chain A stack.

## Tests
`node --test` → **110 tests, 109 pass, 1 fail** (pre-existing BUG-10, unrelated).

- `01_greeting_new_guest` — updated: a new number now receives the consent notice, then the greeting (two sends, consent first).
- `54_consent_not_repeated_returning_guest` — returning guest, no notice.
- `55_consent_not_for_cleaner` — registered cleaner, no notice.
- `56_consent_not_for_owner` — owner number, no notice.

(No mutation — the brief specifies none for this step; correctness is pinned by the exactly-one-send assertions on the exclusion fixtures.)

## System impact
- One new gate in `handleMessage`, before dispatch; adds a single WS_Cleaners GET only when the sender has no guest record (new numbers only).
- Does not alter any state transition or existing send — purely an additional message #1 for new guests.
- **Note for B14 (Step 6):** the consent notice is itself an optional/transactional edge case — it is a one-time onboarding message. Categorised in B14's send-site trace (it fires before any WS_Guests record exists, so a STOP-opted-out guest can never have received it while opted out).
