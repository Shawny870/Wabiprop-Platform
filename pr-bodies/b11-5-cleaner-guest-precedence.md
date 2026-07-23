# B11.5: bare-number cleaner/guest routing precedence

**Branch:** `feature/b11-5-cleaner-guest-precedence` → base `feature/b11-cleaner-property-link` (**Chain B, independent of Chain A**)
**Label:** `needs-decision` (touches routing precedence around a `states.json` global transition)
**FIXLOG:** F25

## Problem (confirmed live during B9 testing)
A phone can be both a registered cleaner and an active guest (Eric,
`27825999279`). `senderIsCleanerNamingRoom` is a global `"*"` transition that
preempts normal state routing, so Eric replying `2` to a numbered guest menu
marked Room 02 clean instead of driving his booking. Bare numbers `1–12` (room
numbers, and — once B9/F19 merge — duration and occupancy menu choices) all
collide in the same space.

## Fix
- New `guestStateExpectsInput(guest, text)` reads `states.json`: true when the sender's `Session State` is non-`NEW` and has an explicit (non-`"*"`) transition whose inputs include the text.
- `senderIsCleanerNamingRoom` returns `false` (declines to preempt) when that holds — the guest-side state machine wins. Targeted addition; the rest of the guard is unchanged.
- Read purely from `states.json`, so it generalises to future numbered menus (occupancy, hourly duration) with no further change.

## Ambiguous-case decision (documented, not left to accident)
When there is **both** a pending guest numbered menu **and** a matching cleaning
room, **the guest side wins**. Rationale: the guest's live booking transaction is
time-sensitive and the guest cannot re-route; a cleaner can still resolve the room
unambiguously by **name** or `DONE`. Tested by fixture 62.

## System-impact sweep (required) — every global `"*"` transition
`states.json` has two global rows:
1. `["done"]` → `senderIsCleaner` → `cleanerDone` — **input-specific**, not `"*"`. The keyword `done` never overlaps any guest-state numbered input, so it cannot preempt a numbered menu. No blindness.
2. `"*"` → `senderIsCleanerNamingRoom` → `cleanerRoomReply` — the one with the preemption blindness. **Fixed.**

**Absence stated, not assumed: no other global transition has this class of preemption blindness.**

## Note on the base branch
b11 has **no hourly flow** (B9 is a separate unmerged chain), so the doc's
`AWAITING_HOURLY_DURATION` example does not exist here. The precedence bug and fix
are general; they are exercised via `CONFIRMED`'s numbered menu (`2`=cancel), the
numbered guest state that exists on b11. Because the check is read from
`states.json`, the identical logic covers the hourly-duration and occupancy menus
automatically once B9/F19 merge — no code change needed.

## Tests
`node --test` → **69 tests, 68 pass, 1 fail** (pre-existing BUG-10, unrelated).
- `62_precedence_guest_menu_wins` — Eric in `CONFIRMED` replies `2` with Room 02 in Cleaning → **booking cancelled, Room 02 untouched** (two writes, neither on WS_Rooms).
- `63_precedence_cleaner_naming_unchanged` — Eric in `NEW` (no pending expectation) replies `2` → **Room 02 marked clean**, cleaner path unchanged.

## Mutation
Inverting the precedence check (`if (!guestStateExpectsInput(...))`) fails **both** 62 and 63 (each in its correct direction), plus existing cleaner fixtures — confirming the guard is load-bearing. Reverted after confirming.

## FIXLOG numbering
This branch's FIXLOG jumps F18 → F25 because F19–F24 are Chain A, which merges
first per the sprint merge order; the numbering is continuous once Chain A is in.
