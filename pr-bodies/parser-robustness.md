# Parser robustness: single-line details + month-substring name fix

**Branch:** `feature/parser-robustness` → base `feature/rate-fix-occupancy`
**Label:** (none — no pricing/consent/state-machine/template change; re-prompt copy unchanged)
**FIXLOG:** F20

## Problem
Confirmed live: Caillin Mendes (a real prospect's guest) sent
`Caillin Mendes 31July 2026 1 August 2026` — all on one line. `collectDetails`
required three separate lines, so it re-prompted three times and Caillin
abandoned the booking. Paired with the known month-substring trap: the old
classifier decided a line was a date with `line.includes('may'|'aug'|'jun'…)`,
so any name containing a month fragment ("May Ndlovu", "Augustine", "Julian")
was misread as a date.

## Change
- New `findDateTokens(text)` locates date-shaped **spans** anywhere in the
  message (day+month, month+day, numeric day-first, today/tomorrow).
- `collectDetails` takes the first two tokens as check-in/check-out and the text
  before the first token as the name — so name + two dates on **one line** now
  parses, and the existing newline form is unchanged.
- Month-substring trap closed: detection matches genuine date **shapes**, not
  substrings. `parseBookingDate` remains the downstream validation gate, so an
  over-eager locate still re-prompts rather than booking a non-date.
- Longest month name wins (alternation sorted by length) so "June" is never
  clipped to "Jun" — the raw token feeds `Notes` and guest copy, which stay
  byte-for-byte identical.
- Re-prompt copy unchanged.

## Tests
`node --test` → **98 tests, 97 pass, 1 fail** (pre-existing BUG-10 router.dispatch, unrelated).

New fixtures:
- `49_details_single_line_caillin` — Caillin's exact single-line input books.
- `50_details_month_substring_name` — `May Ndlovu 3 Aug 2026 5 Aug 2026` → name "May Ndlovu".
- `51_details_single_line_incomplete_reprompts` — single-line name + one date re-prompts, zero writes.

All existing B7/B8/B9 two- and three-line fixtures pass unchanged (including
`03` with its byte-for-byte `Notes: "Check-in: 25 June | Check-out: 27 June"`).

## Mutation (two directions, both confirmed)
- **Under-detection** (day requires 3–4 digits): fixture 49 flips books → re-prompt. Detection is load-bearing for the single-line parse.
- **Over-detection** (a bare month word counts as a date): fixture 50 flips — "May" is eaten and the name breaks. The month-substring fix is load-bearing.
- Fixture 51 (incomplete input) stays correct under **both** mutations. It is refused independently by three guards — date-token detection, `parseBookingDate` validation, and the missing-checkout check — so no single detection mutation can force it to book. That layering is exactly the property 51 pins; a mutation cannot make it "fail into a booking" without also disabling downstream validation, which is a separate defense.

## System impact
- Only `collectDetails`'s field-extraction changed; all downstream logic (availability, occupancy step, booking creation, owner notify) is untouched.
- The unified locate path is used for both single-line and newline input, so there is no second parser to keep in sync.
