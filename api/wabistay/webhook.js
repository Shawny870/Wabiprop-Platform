// /api/wabistay/webhook.js
// WS1 — Wabistay Guest Booking Enquiry Bot
// Reads: WS_Rooms, WS_Rates, WS_Guests, WS_Cleaners
// Writes: WS_Guests, WS_Bookings, WS_Rooms
// No AI. Deterministic state machine only.
//
// H0: the state machine (state → input → action → next state) and ALL outbound
// message copy live in /states.json. This file holds transport, helpers and the
// side-effect handlers the table dispatches to. Every behaviour is frozen by a
// replay fixture in /fixtures — run `node --test` before and after any change.
//
// FIX LOG: see FIXLOG.md (F1–F14 from the WS1 build, referenced inline below).

const STATES = require('../../states.json');

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const OWNER_PHONE = process.env.OWNER_PHONE;

// ─── NOTIFY ROUTING (WABISTAY_NOTIFY_ROUTING) ────────────────────────────────
// Off (default / unset): every operational alert goes to OWNER_PHONE and every
// report to Notify Phone (OWNER_PHONE fallback) — exactly as before. On: the four
// operational alerts go to the property's Notify Phone (OWNER_PHONE only as a
// fallback), reports go to Owner Report Phone → Notify Phone → OWNER_PHONE, and
// Notify Phone / Owner Report Phone are kept out of the guest flow's STOP and
// consent-notice handling the way OWNER_PHONE already is. NO command authority
// is granted to either number: PAID, WALKIN, DONE etc. still resolve only from
// WS_Roles / WS_Cleaners. REPORT_TEST_MODE_PHONE still overrides every report.
function notifyRoutingOn() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_NOTIFY_ROUTING || '').trim());
}
function propertyPhoneField(property, field) {
  const raw = property && property.fields && property.fields[field];
  // Strict on purpose (no String() coercion): a malformed field fails that one
  // property's run, as it always has, rather than being silently routed around.
  return raw ? raw.replace(/[\s\-\+]/g, '') : null;
}
// Recipient of the new-booking (overnight + hourly), extension and room-cleaned
// alerts. Flag off → the raw OWNER_PHONE, exactly what these sites used before.
function operationalAlertPhone(property) {
  if (notifyRoutingOn()) {
    const notify = propertyPhoneField(property, 'Notify Phone');
    if (notify) return formatPhone(notify);
  }
  return OWNER_PHONE || null;
}
// Recipient of the weekly recap and monthly report (before the
// REPORT_TEST_MODE_PHONE gate). Flag off → Notify Phone, else OWNER_PHONE.
function reportRecipientPhone(property) {
  if (notifyRoutingOn()) {
    const report = propertyPhoneField(property, 'Owner Report Phone');
    if (report) return report;
  }
  return propertyPhoneField(property, 'Notify Phone') || (OWNER_PHONE || null);
}
// True when phone is one of the property's owner-side numbers: OWNER_PHONE
// always, plus Notify Phone / Owner Report Phone when routing is on. Used only
// to keep those numbers out of guest-only handling (STOP, consent notice).
function isOwnerSideNumber(phone, property) {
  if (OWNER_PHONE && phone === formatPhone(OWNER_PHONE)) return true;
  if (!notifyRoutingOn()) return false;
  try {
    return ['Notify Phone', 'Owner Report Phone'].some(f => {
      const v = propertyPhoneField(property, f);
      return !!v && formatPhone(v) === phone;
    });
  } catch (_) {
    return false; // a malformed phone field must never break a guest's message
  }
}
// Report template names: env override, today's name as the default.
function reportTemplateName(envName, defaultName) {
  return String(process.env[envName] || '').trim() || defaultName;
}
// Last four digits only — never a full number — for the flags log.
function last4(v) {
  const digits = String(v || '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
}
const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
// Language code every Wabistay utility template is submitted under. Meta matches
// a template on name + language, so this must equal the locale of the approved
// template or the send is rejected as non-existent.
const TEMPLATE_LANGUAGE_CODE = process.env.WA_TEMPLATE_LANGUAGE || 'en';

// Meta utility template for the cleaner gate-arrival notification. FLAG: pending
// Meta approval (Shawn submits). Read at CALL time, not here, so the notify path
// is inert until the name is configured — see cleanerGateTemplate() below. An
// unset value is the stub state, exactly like B17's owner summary.
function cleanerGateTemplate() {
  return process.env.WABISTAY_CLEANER_GATE_TEMPLATE || null;
}

// Checkout → cleaner dispatch ("room vacated, please prepare it"). Same contract as
// the getters around it: read at CALL time, unset IS the old free-form behaviour.
// Params are positional and fixed by the approved template: {{1}} cleaner name,
// {{2}} room name. No buttons: the router only understands typed text, and the
// cleaner answers by typing DONE.
// New-booking alert to the property's operational recipient (overnight and hourly).
// Same contract as the getters around it: read at CALL time, unset = the free-form
// message exactly as before. Set only once Meta has approved wabistay_new_booking.
function newBookingTemplate() {
  return process.env.WABISTAY_NEW_BOOKING_TEMPLATE || null;
}

function cleanerDispatchTemplate() {
  return process.env.WABISTAY_CLEANER_DISPATCH_TEMPLATE || null;
}

// Gate-arrival alert to every Active Reception seat. Same contract as the
// getters around it: read at CALL time, unset IS the stub state (the existing
// free-form Notify Phone alert is unaffected either way).
function receptionGateArrivalTemplate() {
  return process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE || null;
}

// B8 (PAID): the checkout push to the Reception seat. Same contract as the
// cleaner gate template above and B17's owner summary — read at CALL time, unset
// IS the stub state, and the stub logs the full payload rather than downgrading
// to free-form text. Reception has not messaged us at checkout time, so this is
// business-initiated to a third party: outside Meta's 24h window free-form is
// rejected 131047 and vanishes at HTTP 200 (CLAUDE.md line 30).
function receptionPaymentTemplate() {
  return process.env.WABISTAY_RECEPTION_PAYMENT_TEMPLATE || null;
}

// Ops alert to Shawn (guest-struggle/monitoring build, sub-PR 1, CEO
// 2026-09-29): alertShawn's destination (WS_Config.'Alert Phone') is not
// guaranteed to be inside Meta's 24h service window — a cron failure at 3am
// has no reason to have messaged the bot recently. Same contract as every
// other template getter here: read at CALL time, unset IS the stub state
// (falls back to the pre-existing free-form send, see alertShawn below).
// Draft copy proposed to Shawn, pending Meta submission — see the sub-PR 1
// report for the exact body text and Utility/Marketing classification.
function opsAlertTemplate() {
  return process.env.WABISTAY_OPS_ALERT_TEMPLATE || null;
}

// Guest-stuck/HELP escalation alert to staff (sendEscalationAlert, sub-PR 2
// of 4). CEO correction, 2026-09-29: unlike alertShawn's destination, staff
// (On Duty/Backup) only ever RECEIVE from the bot, they don't message it in
// the normal course of their work — so assuming they're inside Meta's 24h
// window is untested and likely false on the very first alert, the same
// failure shape sub-PR 1 fixed for alertShawn. Different content shape from
// an ops alert (guest number/step/last input, not a cron name/error), so a
// second template, not a reuse — see the PR report for the exact body text
// and Utility/Marketing classification. Same stub-until-configured contract
// as every other template getter here.
function guestEscalationTemplate() {
  return process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE || null;
}

// ─── AIRTABLE HELPERS ───────────────────────────────────────────────────────

// `opts.throwOnError` (default false): every existing caller relies on the
// original contract — a failed page logs to Axiom and returns whatever was
// accumulated so far, silently. That is the RIGHT default for most callers
// (e.g. "how many active cleaners" failing open to zero still fails loud via
// the existing no-cleaner-found logging). It is the WRONG default for a
// caller whose empty result means "nothing blocks this room" — there, a
// swallowed error and a genuine zero-rows answer are indistinguishable, and
// the difference is a fail-open double-booking. `findAvailableRoom` is the
// one caller (PR1 / P1b) that opts in, specifically for that query, and
// treats the throw as fail-CLOSED. No other call site is touched.
// ─── AIRTABLE CALL-COUNT INSTRUMENTATION ────────────────────────────────────
// Airtable enforces 5 req/sec per base. The Postgres/queue migration trigger
// (~100-150 properties, ~250-300 calls/run) was an ESTIMATE — this counts
// real airtableGet/airtableCreate/airtableUpdate calls made during one
// runOwnerSummary/runDailySummary invocation, so that trigger becomes
// measured, not guessed. Logging only, no Airtable write of its own (would
// break Rule 29's read-only-cron invariant — test/dailysummary.test.js).
//
// A single module-level "active counter" rather than threading a counter
// object through every call site: Vercel serverless functions are one
// invocation per request, and even where that's not guaranteed, runOwnerSummary/
// runDailySummary already run their per-property work sequentially in a
// single `for` loop with no concurrent Airtable calls in flight, so there is
// never more than one counter active at a time in practice. Save/restore
// around each run (rather than a bare set/clear) so a call to one from
// inside a test harness that nests calls still attributes correctly, and so
// nothing throws if this is ever called without a wrapping run at all.
let _activeAirtableCallCounter = null;

function _countAirtableCall(kind) {
  if (_activeAirtableCallCounter) {
    _activeAirtableCallCounter[kind] = (_activeAirtableCallCounter[kind] || 0) + 1;
  }
}

async function withAirtableCallCount(cronName, propertyCountRef, fn) {
  const counter = { get: 0, create: 0, update: 0 };
  const previous = _activeAirtableCallCounter;
  _activeAirtableCallCounter = counter;
  try {
    return await fn();
  } finally {
    _activeAirtableCallCounter = previous;
    const totalCalls = counter.get + counter.create + counter.update;
    const propertyCount = propertyCountRef.value;
    logToAxiom('info', 'airtable_call_count', {
      cronName,
      propertyCount,
      totalCalls,
      callsPerProperty: propertyCount > 0 ? Math.round((totalCalls / propertyCount) * 100) / 100 : null,
      breakdown: counter
    });
  }
}

async function airtableGet(table, filterFormula, opts = {}) {
  _countAirtableCall('get');
  const { throwOnError = false } = opts;
  // B10.5 BUG 1: Airtable's list API returns at most 100 records per response and
  // signals "there is more" with an `offset` token in the body. A single fetch
  // therefore SILENTLY truncates past 100 rows — no error, just a short list — and
  // any caller that treats the result as the complete set (e.g. logEnquiry's
  // dedup guard) breaks once the table grows. Loop on `offset`, accumulating every
  // page, until the response has no `offset`, so callers genuinely get everything.
  const base = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(filterFormula)}`;
  console.log(`[Airtable GET] ${table} | ${filterFormula}`);
  const records = [];
  let offset;
  let page = 0;
  do {
    const url = offset ? `${base}&offset=${encodeURIComponent(offset)}` : base;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    // F6: log HTTP status so we can see 401/403/404 in logs
    console.log(`[Airtable GET STATUS] ${table} | HTTP ${res.status} | page ${++page}`);
    const data = await res.json();
    if (data.error) {
      console.error(`[Airtable ERROR] ${table}:`, JSON.stringify(data.error));
      logToAxiom('error', 'airtable_get_error', { table, filterFormula, status: res.status, error: JSON.stringify(data.error) });
      if (throwOnError) {
        throw new Error(`airtableGet failed: ${table} — ${JSON.stringify(data.error)}`);
      }
      break;
    }
    if (data.records) records.push(...data.records);
    offset = data.offset; // Airtable omits this once the last page is returned
  } while (offset);
  return records;
}

async function airtableCreate(table, fields) {
  _countAirtableCall('create');
  console.log(`[Airtable CREATE] ${table}`, JSON.stringify(fields));
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  console.log(`[Airtable CREATE STATUS] ${table} | HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    console.error(`[Airtable CREATE ERROR] ${table}:`, JSON.stringify(data.error));
    logToAxiom('error', 'airtable_create_error', { table, status: res.status, error: JSON.stringify(data.error) });
  } else {
    // Rule 30 step 1 (visibility only): mirrors sendWhatsAppTemplate's existing
    // success log exactly — this function already logged failure, never
    // success, so "did the write actually land" was only ever answerable from
    // the ABSENCE of an error event, indistinguishable from Axiom itself being
    // down (F32). This does not check-before-proceeding for any caller; it
    // only makes a fact visible that was previously only inferred.
    logToAxiom('info', 'airtable_create_success', { table, id: data.id || null });
  }
  return data;
}

async function airtableUpdate(table, recordId, fields) {
  _countAirtableCall('update');
  console.log(`[Airtable UPDATE] ${table} ${recordId}`, JSON.stringify(fields));
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  console.log(`[Airtable UPDATE STATUS] ${table} | HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    console.error(`[Airtable UPDATE ERROR] ${table}:`, JSON.stringify(data.error));
    logToAxiom('error', 'airtable_update_error', { table, recordId, status: res.status, error: JSON.stringify(data.error) });
  } else {
    // Rule 30 step 1 — see airtableCreate's identical comment above.
    logToAxiom('info', 'airtable_update_success', { table, recordId });
  }
  return data;
}

// Rule 30 step 2, slice 2: shared wrapper for the ~23 structurally-identical
// WS_Guests Session State writes across the file, rather than 23 near-duplicate
// check-and-log blocks. NON-FATAL as a class: each write is paired with a
// sendWhatsApp reply describing the NEW state, so a failure here does create a
// guest/DB mismatch for one round-trip — but handleMessage's own dispatch
// entrypoint re-fetches WS_Guests fresh on every inbound message, so a failed
// state write self-corrects on the guest's next message rather than
// compounding. airtableUpdate already logs the generic 'airtable_update_error'
// (Rule 30 step 1) on any failure; this adds a correlated, guest/handler-scoped
// event on top, matching F44's precedent of a specific event per checked site
// rather than relying on the generic log alone to satisfy Rule 30's intent.
async function updateGuestState(guestId, fields, logContext = {}) {
  const result = await airtableUpdate('WS_Guests', guestId, fields);
  if (result && result.error) {
    logToAxiom('error', 'guest_state_write_failed', {
      guestId, fields, error: JSON.stringify(result.error), ...logContext
    });
  }
  return result;
}

// State-write guard (Doc 1b, 01 Oct 2026). The comment above assumes a failed
// Session State write "self-corrects on the next message". It does not once the
// bot has moved on: on 30 Sep a missing select option made every
// AWAITING_PAYMENT_METHOD write fail, the guest stayed in the old state while
// the bot sent the next prompt, and the guest looped for a day with no alert.
// advanceGuestState is for the booking-flow transitions where the bot is about
// to send the NEXT prompt: if the advance fails it stops BEFORE that prompt,
// tells the guest to speak to reception, and alerts Shawn. Off unless
// WABISTAY_STATE_WRITE_GUARD is '1' or 'true' — unset keeps today's behaviour
// exactly (the failure is logged, the flow carries on). Returns true when the
// caller should continue, false when it must stop.
function stateWriteGuardEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_STATE_WRITE_GUARD || '').trim());
}

async function advanceGuestState(ctx, fields, extra = {}) {
  const result = await updateGuestState(ctx.guest.id, fields, { phone: ctx.phone, ...extra });
  const failed = !!(result && result.error);
  if (!failed || !stateWriteGuardEnabled()) return true;

  const property = ctx.property;
  const propertyFields = (property && property.fields) || {};
  // Same number the suspended-property redirect shows a guest. Falls back to
  // Notify Phone; with neither, no guest message is sent rather than inventing
  // one, and the alert says so.
  const redirectPhone = propertyFields['Guest Redirect Phone'] || propertyFields['Notify Phone'] || null;
  const errorType = (result.error && (result.error.type || result.error.error)) || 'unknown';
  logToAxiom('error', 'guest_state_write_guard_tripped', {
    phone: ctx.phone, guestId: ctx.guest.id, targetState: fields['Session State'] || null,
    errorType: String(errorType), guestMessageSent: !!redirectPhone, ...extra
  });
  if (redirectPhone) {
    await sendWhatsApp(ctx.phone, msg('stateWriteFailed', { redirectPhone }));
  }
  await alertShawn(
    'guest_state_write_failed',
    `Guest ${ctx.phone} could not be moved to ${fields['Session State'] || 'a new state'} (${errorType}). ` +
      (redirectPhone ? 'They were told to speak to reception.' : 'No redirect phone is set, so they were told nothing.'),
    { propertyId: property && property.id, propertyName: propertyFields['Property Name'] || null }
  );
  return false;
}

// Cold-start flag log (01 Oct 2026). Which WABISTAY_* switches a given
// deployment actually has is otherwise invisible: on 01 Oct the guard variable
// was added after a deploy and nothing showed that the running code did not yet
// have it. Logs the NAME and on/off of every WABISTAY_* variable, never a value.
// "on" means set and non-empty; for WABISTAY_STATE_WRITE_GUARD it means the
// value the code actually treats as on (1/true). Known flags are listed even
// when unset so an absent flag reads "off" rather than missing. The commit and
// deployment id are Vercel system variables, not secrets, and say which
// deployment this log line belongs to.
const WABISTAY_KNOWN_FLAGS = [
  'WABISTAY_AFTER_HOURS',
  'WABISTAY_CLEANER_DISPATCH_TEMPLATE',
  'WABISTAY_CLEANER_GATE_TEMPLATE',
  'WABISTAY_ENQUIRY_TRACKING',
  'WABISTAY_GATE_ALERT_UNPAID',
  'WABISTAY_GATE_ARRIVAL_TEMPLATE',
  'WABISTAY_GATE_REQUIRES_BOOKING',
  'WABISTAY_GATE_ROOM_CHECK',
  'WABISTAY_GUEST_ADDRESS',
  'WABISTAY_GUEST_ESCALATION_TEMPLATE',
  'WABISTAY_DAILY_SUMMARY_TEMPLATE',
  'WABISTAY_HIDE_ONE_HOUR',
  'WABISTAY_HOLD_RELEASE',
  'WABISTAY_INTERACTIVE',
  'WABISTAY_LEAN_COPY',
  'WABISTAY_MESSAGE_DEDUPE',
  'WABISTAY_MONTHLY_REPORT_TEMPLATE',
  'WABISTAY_NEW_BOOKING_TEMPLATE',
  'WABISTAY_NONTEXT_REPLY',
  'WABISTAY_NOTIFY_ROUTING',
  'WABISTAY_ONE_OPEN_BOOKING',
  'WABISTAY_OPS_ALERT_TEMPLATE',
  'WABISTAY_OVERDUE_ALERT_TEMPLATE',
  'WABISTAY_PAID_BY_BOOKING_REF',
  'WABISTAY_PAID_ROOM_CONFIRMED',
  'WABISTAY_PAY_ASSIGNS_ROOM',
  'WABISTAY_OWNER_SUMMARY_TEMPLATE',
  'WABISTAY_RECEPTION_PAYMENT_TEMPLATE',
  'WABISTAY_ROOM_ORDER',
  'WABISTAY_STATE_WRITE_GUARD',
  'WABISTAY_STAY_MENU',
  'WABISTAY_WEEKLY_RECAP_TEMPLATE'
];

// Switches the code only treats as on for 1/true; for these, 'on' means that,
// not merely 'set'.
const WABISTAY_BOOLEAN_FLAGS = ['WABISTAY_AFTER_HOURS', 'WABISTAY_ENQUIRY_TRACKING', 'WABISTAY_GATE_ALERT_UNPAID', 'WABISTAY_GATE_REQUIRES_BOOKING', 'WABISTAY_GATE_ROOM_CHECK', 'WABISTAY_GUEST_ADDRESS', 'WABISTAY_HIDE_ONE_HOUR', 'WABISTAY_HOLD_RELEASE', 'WABISTAY_INTERACTIVE', 'WABISTAY_LEAN_COPY', 'WABISTAY_MESSAGE_DEDUPE', 'WABISTAY_NONTEXT_REPLY', 'WABISTAY_NOTIFY_ROUTING', 'WABISTAY_ONE_OPEN_BOOKING', 'WABISTAY_PAID_BY_BOOKING_REF', 'WABISTAY_PAID_ROOM_CONFIRMED', 'WABISTAY_PAY_ASSIGNS_ROOM', 'WABISTAY_ROOM_ORDER', 'WABISTAY_STATE_WRITE_GUARD', 'WABISTAY_STAY_MENU'];

function wabistayFlagState() {
  const names = new Set([...WABISTAY_KNOWN_FLAGS, ...Object.keys(process.env).filter(k => k.startsWith('WABISTAY_'))]);
  const flags = {};
  for (const name of [...names].sort()) {
    const raw = process.env[name];
    const on = WABISTAY_BOOLEAN_FLAGS.includes(name)
      ? /^(1|true)$/i.test(String(raw || '').trim())
      : !!(raw && String(raw).trim());
    flags[name] = on ? 'on' : 'off';
  }
  return flags;
}

// Switches that are not WABISTAY_* but change what gets sent where. The two
// phone numbers are reported set/unset ONLY (they are real numbers); the
// template language is not sensitive, so its effective value is logged — "en"
// by default, which is what every template is sent under.
// Notify Phone lives on WS_Properties, not in the environment, so it is only known
// once a property has been resolved. Null until then (the cold-start event can fire
// from a cron before any inbound message); handleMessage logs
// wabistay_notify_phones once with the real value as soon as it has one.
let _notifyPhoneLast4 = null;
function otherSwitchState() {
  const isSet = name => !!(process.env[name] && String(process.env[name]).trim());
  return {
    REPORT_TEST_MODE_PHONE: isSet('REPORT_TEST_MODE_PHONE') ? 'set' : 'unset',
    OWNER_PHONE: isSet('OWNER_PHONE') ? 'set' : 'unset',
    ownerPhoneLast4: last4(process.env.OWNER_PHONE),
    notifyPhoneLast4: _notifyPhoneLast4,
    WA_TEMPLATE_LANGUAGE: TEMPLATE_LANGUAGE_CODE,
    WA_TEMPLATE_LANGUAGE_source: isSet('WA_TEMPLATE_LANGUAGE') ? 'env' : 'default'
  };
}

// Once per cold start, the first time a property is resolved: last four digits of
// its Notify Phone / Owner Report Phone (never the full numbers) plus the routing
// flag, so "where would alerts and reports go right now" is a query.
let _notifyPhonesLogged = false;
function noteNotifyPhones(property) {
  _notifyPhoneLast4 = last4(propertyPhoneField(property, 'Notify Phone'));
  if (_notifyPhonesLogged) return;
  _notifyPhonesLogged = true;
  logToAxiom('info', 'wabistay_notify_phones', {
    notifyRouting: notifyRoutingOn() ? 'on' : 'off',
    ownerPhoneLast4: last4(process.env.OWNER_PHONE),
    notifyPhoneLast4: _notifyPhoneLast4,
    ownerReportPhoneLast4: last4(propertyPhoneField(property, 'Owner Report Phone')),
    propertyId: property.id
  });
}

let _flagsLogged = false;
function logFlagsOnce() {
  if (_flagsLogged) return null;
  _flagsLogged = true;
  const flags = wabistayFlagState();
  const others = otherSwitchState();
  const where = {
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null
  };
  console.log(`[WABISTAY FLAGS] ${JSON.stringify({ flags, others })}`);
  logToAxiom('info', 'wabistay_flags', { flags, others, ...where });
  return flags;
}

// B9: the guest's half-built hourly booking — Check In recorded, duration not
// yet chosen, so Check Out is still blank. Blank Check Out is exactly what makes
// it inert to B8's overlap check while the guest is mid-conversation.
async function findPendingHourlyBooking(guestId) {
  const enquiries = await airtableGetBookingsByGuestId(guestId, 'Enquiry');
  return enquiries.find(b => b.fields['Booking Type'] === 'Hourly' && !b.fields['Check Out']) || null;
}

// F5: direct record ID lookup — replaces FIND/ARRAYJOIN pattern
async function airtableGetBookingsByGuestId(guestId, status) {
  // Airtable linked record filter via FIND/ARRAYJOIN is unreliable —
  // fetch all bookings with matching status, then filter by guest ID in JS
  const allBookings = await airtableGet('WS_Bookings', `{Status} = '${status}'`);
  return allBookings.filter(b => {
    const guests = b.fields['Guest'] || [];
    return guests.includes(guestId);
  });
}

// B10.5 Bug 2 — property scoping for cleaner dispatch.
//
// Scope is resolved from the booking's own `WS_Property` link (persisted at
// check-in), NOT from a Booking→Room→Property walk and not from request-scoped
// state, so the manual and auto checkout paths share one source of truth.
//
// Scoping is by property RECORD ID, never by name — names collide and change.
// Airtable's filterByFormula matches a linked-record field on its primary
// display value rather than the record id, so there is no id-safe formula here;
// the correct route is to fetch the active cleaners and filter on the link array
// in code. Same reasoning as airtableGetBookingsByGuestId above.
//
// Fails CLOSED: an unresolvable property dispatches nobody. The bug being fixed
// is dispatching to everybody, so a silent no-op is the safe direction of error.
function bookingPropertyId(booking, fallbackPropertyId) {
  const linked = booking && (booking.fields['WS_Property'] || [])[0];
  return linked || fallbackPropertyId || null;
}

// Rating flow: the guest's Session State carries no booking reference, so the
// booking a AWAITING_RATING/AWAITING_RATING_FEEDBACK reply belongs to is
// resolved the same way extendStay resolves "the active booking" — most
// recent by Check Out, but scoped to Checked Out + not yet rated, since a
// returning guest may have older, already-rated Checked Out bookings.
async function findBookingAwaitingRating(guestId) {
  const bookings = await airtableGetBookingsByGuestId(guestId, 'Checked Out');
  const unrated = bookings.filter(b => b.fields['Rating'] === undefined);
  unrated.sort((a, b) => Date.parse(b.fields['Check Out'] || 0) - Date.parse(a.fields['Check Out'] || 0));
  return unrated[0] || null;
}

// AWAITING_RATING_FEEDBACK counterpart: by this point Rating is already
// written on the booking the guest is replying about, so "unrated" no longer
// identifies it — "rated but no feedback yet" does.
async function findBookingAwaitingRatingFeedback(guestId) {
  const bookings = await airtableGetBookingsByGuestId(guestId, 'Checked Out');
  const unfed = bookings.filter(b => b.fields['Rating'] !== undefined && b.fields['Rating Feedback'] === undefined);
  unfed.sort((a, b) => Date.parse(b.fields['Check Out'] || 0) - Date.parse(a.fields['Check Out'] || 0));
  return unfed[0] || null;
}

async function activeCleanersForProperty(propertyId) {
  // F4: was {Active} = 1 — Airtable checkbox requires TRUE()
  const activeCleaners = await airtableGet('WS_Cleaners', `{Active} = TRUE()`);
  if (!propertyId) return [];
  return activeCleaners.filter(c => (c.fields['Assigned Property'] || []).includes(propertyId));
}

// One cleaner, one dispatch. The dispatch used to be free-form text at three
// separate sites, and a business-initiated free-form message to a cleaner who has
// not written to us in 24 hours is dropped by Meta with HTTP 200 and no error,
// which is how rooms stayed in Cleaning with nobody told. With the template
// configured it goes as the template; if Meta rejects the template at once
// (not approved yet, wrong name or language) that is logged and the free-form
// message is tried once, so a template problem never leaves the cleaner with
// nothing. Unset = the free-form message exactly as before. A rejection that
// only shows up later in a delivery-status callback cannot be fallen back from.
// `failEvent` is the existing per-site event name for a failed free-form send.
async function sendCleanerDispatch(cleaner, roomName, { bookingId = null, failEvent = 'cleaner_dispatch_failed' } = {}) {
  const rawPhone = cleaner.fields['Phone Number'];
  if (!rawPhone) return { ok: false, skipped: true };
  const to = formatPhone(rawPhone);
  const cleanerName = cleaner.fields['Cleaner Name'];
  const correlation = { bookingId, cleanerId: cleaner.id, roomName };

  const templateName = cleanerDispatchTemplate();
  if (templateName) {
    const result = await sendWhatsAppTemplate(to, templateName, [cleanerName || 'there', roomName], { site: 'cleaner_dispatch', ...correlation });
    if (result.ok) return { ok: true, via: 'template' };
    logToAxiom('error', 'cleaner_dispatch_template_failed', {
      ...correlation, to, template: templateName, error: JSON.stringify(result.error || null)
    });
  }

  const send = await sendWhatsApp(to, msg('cleanerDispatch', { cleanerName, roomName }));
  if (send && send.error) {
    logToAxiom('error', failEvent, { ...correlation, error: JSON.stringify(send.error) });
    return { ok: false };
  }
  return { ok: true, via: templateName ? 'free_form_fallback' : 'free_form' };
}

// Gate arrival → tell the property's cleaner someone has arrived. Before this,
// `gateArrival` told the guest "someone is on their way to open the gate" and
// notified only `Notify Phone` (the owner) — no member of staff on the ground was
// ever messaged, so the guest's promise was unbacked copy.
//
// Reuses the B10.5 Bug 2 scoping model unchanged: cleaners are filtered by the
// booking's own property, so a second property's cleaner is never notified.
// Deliberately notifies EVERY active cleaner assigned to this property, matching
// the checkout dispatch — picking one would require on-duty/shift resolution,
// which is explicitly deferred and NOT built here.
//
// Every exit path logs with `bookingId`, so "the cleaner was not notified for
// booking X" is answerable from Axiom rather than inferred from silence.
async function notifyCleanerOfArrival({ propertyId, bookingId, propertyName, guestName, roomName, guestPhone }) {
  const correlation = { site: 'gate_arrival', bookingId, propertyId, guestPhone };
  const cleaners = await activeCleanersForProperty(propertyId);

  if (cleaners.length === 0) {
    // Fails LOUD, not closed: unlike dispatch-to-everybody (Bug 2), notifying
    // nobody at the gate is itself the bug being fixed, so it must be visible.
    logToAxiom('warn', 'cleaner_gate_notify_no_cleaner', { ...correlation, reason: 'no active cleaner assigned to property' });
    await alertShawn('gate_arrival', 'no active cleaner assigned to property', {
      propertyId, propertyName, bookingId
    });
    return;
  }

  const templateName = cleanerGateTemplate();

  for (const cleaner of cleaners) {
    const rawPhone = cleaner.fields['Phone Number'];
    const cleanerName = cleaner.fields['Cleaner Name'] || 'there';
    const perCleaner = { ...correlation, cleanerId: cleaner.id, cleanerName };

    if (!rawPhone) {
      logToAxiom('warn', 'cleaner_gate_notify_no_phone', { ...perCleaner, reason: 'cleaner record has no Phone Number' });
      continue;
    }
    const to = formatPhone(rawPhone);
    // Order is fixed by the approved template's {{1}}..{{4}} — see PR body.
    const params = [cleanerName, guestName, roomName || 'an unassigned room', propertyName];

    if (!templateName) {
      // STUBBED until WABISTAY_CLEANER_GATE_TEMPLATE is approved and configured.
      // Deliberately NOT a free-form sendWhatsApp fallback: outside the 24h window
      // that 200s and vanishes, which is the invisible failure this fix exists to
      // end. Logging the exact payload keeps resolution verifiable before approval.
      logToAxiom('warn', 'cleaner_gate_notify_stubbed', {
        ...perCleaner, to, params,
        reason: 'WABISTAY_CLEANER_GATE_TEMPLATE not configured — template pending Meta approval'
      });
      continue;
    }

    const result = await sendWhatsAppTemplate(to, templateName, params, perCleaner);
    if (!result.ok) {
      logToAxiom('error', 'cleaner_gate_notify_failed', {
        ...perCleaner, to, template: templateName,
        error: JSON.stringify(result.error || null)
      });
    }
  }
}

// B8 (PAID): tell Reception what is owed, at the moment the guest checks out.
// Called from BOTH checkout paths — the manual one and the B12 cron — because
// walk-ins and hourly stays are normally closed by the cron, and a push wired
// only to the manual path would miss most of the money it exists to collect.
//
// `amountDue` is read off the booking at call time, so it already includes any
// extensions (F34 adds each extension's charge onto Amount Due in place).
async function notifyReceptionOfPayment({ propertyId, bookingId, bookingRef, roomName, guestName, amountDue, source }) {
  const correlation = { site: 'checkout_payment', source, bookingId, bookingRef, propertyId, amountDue };
  const seats = await activeReceptionRolesForProperty(propertyId);

  if (seats.length === 0) {
    // Fails LOUD, like the cleaner gate: nobody being told what to collect is
    // itself the failure this push exists to prevent, so it must be visible
    // rather than quietly skipped.
    logToAxiom('warn', 'reception_payment_notify_no_seat', {
      ...correlation, reason: 'no active Reception seat for property'
    });
    return;
  }

  const templateName = receptionPaymentTemplate();

  for (const seat of seats) {
    const to = formatPhone(String(seat.fields['Current Phone']));
    const perSeat = { ...correlation, roleId: seat.id, roleLabel: seat.fields['Role Label'] || null };
    // Positional and load-bearing once the template is approved — the order is
    // documented in docs/env.md alongside the variable.
    const params = [roomName || 'a room', guestName || 'the guest', formatAmount(amountDue), bookingRef || ''];

    if (!templateName) {
      // STUBBED until WABISTAY_RECEPTION_PAYMENT_TEMPLATE is approved and set.
      // Never downgraded to free-form: Reception has not messaged us, so a
      // free-form send outside the 24h window 200s and vanishes.
      logToAxiom('warn', 'reception_payment_notify_stubbed', {
        ...perSeat, to, params,
        reason: 'WABISTAY_RECEPTION_PAYMENT_TEMPLATE not configured — template pending Meta approval'
      });
      continue;
    }

    const result = await sendWhatsAppTemplate(to, templateName, params, perSeat);
    if (!result.ok) {
      logToAxiom('error', 'reception_payment_notify_failed', {
        ...perSeat, to, template: templateName, error: JSON.stringify(result.error || null)
      });
    }
    // Success is already logged by sendWhatsAppTemplate as `whatsapp_template_sent`
    // carrying the wamid — the join key to B3's status callbacks. Not duplicated
    // here, matching notifyCleanerOfArrival.
  }
}

// Gate arrival → tell every Active Reception seat for the property. IN ADDITION
// to the free-form Notify Phone alert, never instead of it: that send is
// unchanged. Template-only by design — Reception has not messaged us at the
// moment a guest arrives, so free-form would 200 and vanish outside the 24h
// window. Params are positional and fixed by the approved template:
// {{1}} property, {{2}} guest, {{3}} room, {{4}} room status, {{5}} guest phone.
async function notifyReceptionOfArrival({ propertyId, propertyName, guestName, roomName, roomStatus, guestPhone }) {
  const correlation = { site: 'gate_arrival_reception', propertyId, guestPhone };
  const seats = await activeReceptionRolesForProperty(propertyId);

  if (seats.length === 0) {
    logToAxiom('warn', 'reception_gate_notify_no_seat', {
      ...correlation, reason: 'no active Reception seat for property'
    });
    return { sent: 0 };
  }

  const templateName = receptionGateArrivalTemplate();
  const params = [propertyName, guestName, roomName, roomStatus, guestPhone];
  let sent = 0;

  for (const seat of seats) {
    const to = formatPhone(String(seat.fields['Current Phone']));
    const perSeat = { ...correlation, roleId: seat.id, roleLabel: seat.fields['Role Label'] || null };

    if (!templateName) {
      logToAxiom('warn', 'reception_gate_notify_stubbed', {
        ...perSeat, to, params,
        reason: 'WABISTAY_GATE_ARRIVAL_TEMPLATE not configured'
      });
      continue;
    }

    const result = await sendWhatsAppTemplate(to, templateName, params, perSeat);
    if (!result.ok) {
      logToAxiom('error', 'reception_gate_notify_failed', {
        ...perSeat, to, template: templateName, error: JSON.stringify(result.error || null)
      });
    } else {
      sent++;
    }
  }
  return { sent };
}

// Unpaid gate arrival (Doc 1b follow-up, 02 Oct 2026). Until now a guest who
// tapped "I'm at the gate" before payment was confirmed was told to go to the
// office and nobody in the office was told: the alerts all sit after the payment
// gate. With WABISTAY_GATE_ALERT_UNPAID on, reception (template) and the
// Notify Phone owner copy (free-form) are alerted, with no room assigned and
// nothing written to the guest or the room. Repeat taps are suppressed for 10
// minutes via WS_Bookings 'Gate Alert Sent At', written only after an alert has
// actually gone out; a paid tap always alerts (it takes the normal path).
const GATE_ALERT_SUPPRESS_MS = 10 * 60 * 1000;

function gateAlertUnpaidEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_GATE_ALERT_UNPAID || '').trim());
}

// WABISTAY_GATE_ROOM_CHECK (1 or true; off by default). A guest who is allowed in
// (paid, or nothing owed) taps the gate button and the room they would be given is
// not Available — still Cleaning, or Occupied. Today gateArrival assigns it anyway
// and sets it Occupied, which overwrites Cleaning and leaves the cleaner's DONE with
// nothing to flip. With the flag on, that tap assigns nothing and writes nothing:
// the guest is told to wait at the office (not outside), reception is alerted
// (template + owner copy, as the unpaid alert does) with the room's real status, and a
// later tap re-checks from scratch. No stamp is written, so there is no quiet period:
// each tap re-alerts.
function gateRoomCheckEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_GATE_ROOM_CHECK || '').trim());
}

async function alertRoomNotReadyAtGate(ctx, booking, room, notifyPhone) {
  const roomName = room.fields['Room Name'];
  const roomStatus = room.fields['Status'] || 'Unknown';
  await notifyReceptionOfArrival({
    propertyId: ctx.property.id,
    propertyName: ctx.property.fields['Property Name'],
    guestName: ctx.guest.fields['Guest Name'],
    roomName,
    roomStatus,
    guestPhone: ctx.phone
  });
  if (notifyPhone) {
    logOwnerSendWindow('gate_room_not_ready', notifyPhone, ctx.phone);
    const ownerSend = await sendWhatsApp(notifyPhone, msg('gateNotifyRoomNotReady', {
      guestName: ctx.guest.fields['Guest Name'],
      guestPhone: ctx.phone,
      ref: (booking && (booking.fields['Booking Ref'] || `WS-${booking.id.slice(-6).toUpperCase()}`)) || 'no booking',
      roomName,
      roomStatus
    }));
    if (ownerSend && ownerSend.error) {
      logToAxiom('error', 'gate_room_not_ready_owner_send_failed', {
        bookingId: booking ? booking.id : null, error: JSON.stringify(ownerSend.error)
      });
    }
  }
}

async function alertUnpaidGateArrival(ctx, booking, heldRoomId, notifyPhone) {
  const lastAlert = booking.fields['Gate Alert Sent At'];
  if (lastAlert && (Date.now() - Date.parse(lastAlert)) < GATE_ALERT_SUPPRESS_MS) {
    logToAxiom('info', 'gate_alert_unpaid_suppressed', {
      phone: ctx.phone, bookingId: booking.id, lastAlert
    });
    return;
  }

  // The room the booking holds, if any: its real name, and its real status with
  // ", payment not confirmed" appended (the approved template has no wording of its
  // own for "unpaid", so the status param carries it). Otherwise the placeholders
  // agreed for an unpaid guest with no room.
  const heldRoom = heldRoomId ? (await airtableGet('WS_Rooms', `RECORD_ID() = '${heldRoomId}'`))[0] || null : null;
  const roomName = heldRoom ? heldRoom.fields['Room Name'] : 'not assigned yet';
  const roomStatus = heldRoom
    ? `${heldRoom.fields['Status'] || 'Unknown'}, payment not confirmed`
    : 'payment not confirmed';

  let anySent = false;

  const reception = await notifyReceptionOfArrival({
    propertyId: ctx.property.id,
    propertyName: ctx.property.fields['Property Name'],
    guestName: ctx.guest.fields['Guest Name'],
    roomName,
    roomStatus,
    guestPhone: ctx.phone
  });
  if (reception && reception.sent > 0) anySent = true;

  if (notifyPhone) {
    logOwnerSendWindow('gate_arrival_unpaid', notifyPhone, ctx.phone);
    // A booking that holds a room says so: "No room has been assigned" was false
    // for it. No held room keeps the original copy.
    const ownerSend = await sendWhatsApp(notifyPhone, msg(heldRoom ? 'gateNotifyUnpaidRoomHeld' : 'gateNotifyUnpaid', {
      guestName: ctx.guest.fields['Guest Name'],
      guestPhone: ctx.phone,
      ref: booking.fields['Booking Ref'] || `WS-${booking.id.slice(-6).toUpperCase()}`,
      amountDue: booking.fields['Amount Due'],
      roomName
    }));
    if (ownerSend && ownerSend.error) {
      logToAxiom('error', 'gate_alert_unpaid_owner_send_failed', {
        bookingId: booking.id, error: JSON.stringify(ownerSend.error)
      });
    } else {
      anySent = true;
    }
  }

  // Only a delivered alert starts the 10-minute quiet period. A failed stamp
  // never undoes or blocks the alert that already went out.
  if (anySent) {
    const stamp = await airtableUpdate('WS_Bookings', booking.id, { 'Gate Alert Sent At': new Date().toISOString() });
    if (stamp && stamp.error) {
      logToAxiom('error', 'gate_alert_stamp_write_failed', {
        bookingId: booking.id, error: JSON.stringify(stamp.error)
      });
    }
    logToAxiom('info', 'gate_alert_unpaid_sent', { phone: ctx.phone, bookingId: booking.id });
  }
}

// Rands, two decimals, no currency symbol — the symbol belongs to the template
// copy, not the parameter, so it cannot end up doubled ("RR400.00").
function formatAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

// ─── NEW-BOOKING ALERT (WABISTAY_NEW_BOOKING_TEMPLATE) ──────────────────────
// Template wabistay_new_booking, language en, body:
//   "The stay is {{5}}. The guest is arriving {{6}}. The amount due is {{7}}."
// {{1}} property name · {{2}} guest name · {{3}} guest phone · {{4}} booking ref ·
// {{5}} stay description · {{6}} arrival text · {{7}} amount due.
//
// ALL SEVEN values are built here, for both booking types, so a change to what a
// stay is called (Doc 2's 2 Hours / 3 Hours / Day / Night) or how arrival is
// phrased is a change to this one function.
//   · {{5}} is lowercase, sentence-ready: "overnight until 27 June", "2 hours".
//   · {{6}} is "3 Oct at 2:00pm" (SAST), the same text the hourly guest copy uses.
//   · {{7}} is "R250", or "to be confirmed" when there is no price to quote (an
//     overnight booking the owner will finalise). Never blank: Meta rejects an
//     empty parameter.
// MONTH_FULL_NAMES is the module-level constant further down; read at call time.
function formatSastDayMonth(iso) {
  const d = new Date(Date.parse(iso) + SAST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTH_FULL_NAMES[d.getUTCMonth()]}`;
}
function newBookingAmountText(amount) {
  const n = Number(amount);
  if (amount === null || amount === undefined || amount === '' || !Number.isFinite(n) || n <= 0) return 'to be confirmed';
  return Number.isInteger(n) ? `R${n}` : `R${n.toFixed(2)}`;
}
function newBookingTemplateParams({ propertyName, guestName, guestPhone, bookingRef, bookingType, checkInIso, checkOutIso, hours, amount }) {
  const stay = bookingType === 'Hourly'
    ? durationText(hours)
    : bookingType === 'Day'
      ? `day stay until ${formatSastDateTime(checkOutIso).split(' at ')[1]}`
      : `overnight until ${formatSastDayMonth(checkOutIso)}`;
  return [
    propertyName || 'the property',
    guestName || 'the guest',
    guestPhone,
    bookingRef,
    stay,
    formatSastDateTime(checkInIso),
    newBookingAmountText(amount)
  ];
}

// Template when WABISTAY_NEW_BOOKING_TEMPLATE is set; if Meta rejects it at once
// (not approved yet, wrong name or language) that is logged and the free-form
// message is tried once, so a template problem never costs the owner the alert.
// Unset = the free-form message exactly as before. A rejection that only shows up
// later in a delivery-status callback cannot be fallen back from. Returns the same
// shape the free-form send does ({ error } on failure) so existing callers'
// failure logging is unchanged.
async function sendNewBookingAlert(to, params, freeForm, correlation = {}) {
  const templateName = newBookingTemplate();
  if (templateName) {
    const result = await sendWhatsAppTemplate(to, templateName, params, { site: 'new_booking_alert', ...correlation });
    if (result.ok) return { via: 'template' };
    logToAxiom('error', 'new_booking_template_failed', {
      ...correlation, to, template: templateName, error: JSON.stringify(result.error || null)
    });
  }
  return sendWhatsApp(to, msg(freeForm.key, freeForm.vars));
}

// ─── WHATSAPP HELPER ────────────────────────────────────────────────────────

async function sendWhatsApp(to, message) {
  console.log(`[WhatsApp SEND] to: ${to} | msg: ${message.slice(0, 80)}...`);
  // F3: was v19.0 — now v25.0 to match webhook subscription version
  const res = await fetch(`https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    })
  });
  console.log(`[WhatsApp SEND STATUS] HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    console.error(`[WhatsApp SEND ERROR]:`, JSON.stringify(data.error));
    logToAxiom('error', 'whatsapp_send_error', { to, status: res.status, error: JSON.stringify(data.error) });
  } else {
    // Rule 30 step 1: mirrors sendWhatsAppTemplate's whatsapp_template_sent
    // exactly, same wamid — the join key to B3's whatsapp_status_callback
    // events. Meta can return HTTP 200 with an error BODY (e.g. 131047), which
    // is exactly the case the `if (data.error)` branch above already catches;
    // this only makes the OTHER case — genuine acceptance — equally visible,
    // where before it was pure absence of a log line.
    const wamid = (data && data.messages && data.messages[0] && data.messages[0].id) || null;
    logToAxiom('info', 'whatsapp_sent', { to, wamid });
  }
  return data;
}

// ─── WHATSAPP TEMPLATE HELPER ───────────────────────────────────────────────
// Business-initiated sends (cleaner dispatch, gate arrival, owner summary) go to
// a third party who has not messaged us, so they are outside Meta's 24-hour
// customer-service window. Free-form text there is rejected (131047) — CLAUDE.md
// line 30 — so those sends must be approved utility templates. This is the
// shared surface for all three; it is deliberately NOT gate-specific.
//
// Returns { ok, wamid, error } rather than the raw body so callers can correlate
// a failure back to the booking it belongs to. `meta` is merged into every Axiom
// event, which is how "the cleaner was NOT notified for booking X" becomes a
// queryable fact instead of a generic send error.
//
// The success log carries the wamid, which is the join key to B3's
// `whatsapp_status_callback` events (they log `wamid` too) — so a template that
// Meta accepts but never delivers is still traceable to its booking.
function sanitizeTemplateParam(value) {
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, ' ').trim();
}

async function sendWhatsAppTemplate(to, templateName, rawParams = [], meta = {}) {
  const { languageCode = TEMPLATE_LANGUAGE_CODE, ...correlation } = meta;
  // Meta rejects a template send whose text parameter contains a newline, a
  // tab, or four or more consecutive spaces (error 132018). Params carry
  // free-form text (alertShawn's error message, a guest's name), so flatten
  // them here rather than trusting every caller to.
  const params = rawParams.map(sanitizeTemplateParam);
  console.log(`[WhatsApp TEMPLATE SEND] to: ${to} | template: ${templateName} | params: ${JSON.stringify(params)}`);

  const components = params.length > 0
    ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }]
    : [];

  const res = await fetch(`https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components
      }
    })
  });
  console.log(`[WhatsApp TEMPLATE SEND STATUS] HTTP ${res.status}`);
  const data = await res.json();

  const wamid = (data && data.messages && data.messages[0] && data.messages[0].id) || null;
  const ok = !data.error && res.status < 300;

  if (!ok) {
    console.error(`[WhatsApp TEMPLATE SEND ERROR]:`, JSON.stringify(data.error));
    logToAxiom('error', 'whatsapp_template_send_error', {
      to, template: templateName, status: res.status,
      error: JSON.stringify(data.error || null),
      // 131047 is the re-engagement rejection — the specific failure this helper
      // exists to make visible. Surfaced as its own flag so it can be alerted on.
      reEngagementRejected: !!(data.error && data.error.code === 131047),
      ...correlation
    });
  } else {
    logToAxiom('info', 'whatsapp_template_sent', { to, template: templateName, wamid, ...correlation });
  }

  return { ok, wamid, error: (data && data.error) || null };
}

// TEST-MODE GATE — the entire safety mechanism for report sends (weekly
// recap + monthly report). REPORT_TEST_MODE_PHONE is a Vercel env var the
// CEO sets/unsets manually — NEVER committed to any file in this repo. When
// set, EVERY report send (regardless of which property/owner it's actually
// for) is redirected to that one number instead of the real owner's Notify
// Phone, with the real intended recipient logged explicitly to Axiom so
// "this would have gone to [owner]" is verifiable without the owner ever
// receiving it. When unset, sends go to the real owner as normal. This one
// flag, checked at the point of send, is deliberately the entire gating
// mechanism — no second mechanism (property-level flag, allowlist, etc.) is
// built here, per instructions.
function resolveSendRecipient(realRecipientPhone, site, correlation = {}) {
  const testPhone = process.env.REPORT_TEST_MODE_PHONE;
  if (testPhone) {
    logToAxiom('info', 'report_test_mode_redirect', {
      site, redirectedTo: testPhone, intendedRecipient: realRecipientPhone, ...correlation
    });
    return testPhone;
  }
  return realRecipientPhone;
}

// ─── FORMAT PHONE ────────────────────────────────────────────────────────────

function formatPhone(raw) {
  let clean = raw.replace(/[\s\-\+]/g, '');
  if (clean.startsWith('0')) clean = '27' + clean.slice(1);
  return clean;
}

// ─── ALERT SHAWN (Airtable-backed) ──────────────────────────────────────────
// Ported from api/wabiprop/_lib/cronHelpers.js:100-105. Unlike that copy, which
// hardcodes the destination number, this one reads it from WS_Config (single
// row, "Alert Phone" field) so the number can be changed without a redeploy.
// Free-form sendWhatsApp, not a template — same choice the Wabiprop original
// makes; the ops number is expected to already be inside the 24h session
// window from prior bot interaction, so this carries no new re-engagement
// risk beyond what alertShawn already has there.

let _alertPhoneCache = { value: null, fetchedAt: 0 };
// 5 min: long enough that a burst of failures in one run doesn't hammer
// Airtable once per failure, short enough that changing the number in
// Airtable takes effect within roughly one cron cycle rather than hours.
const ALERT_PHONE_CACHE_TTL_MS = 5 * 60 * 1000;

async function getAlertPhone() {
  const now = Date.now();
  if (_alertPhoneCache.value && (now - _alertPhoneCache.fetchedAt) < ALERT_PHONE_CACHE_TTL_MS) {
    return _alertPhoneCache.value;
  }
  try {
    // WS_Config is meant to be a single-row table by convention, but the
    // live base has been observed with extra blank rows (e.g. created via
    // Airtable's own "+" row button) — rows[0] is Airtable's return order,
    // NOT a guarantee the populated row comes first. Find the first row
    // that actually HAS a value instead of blindly trusting index 0, so a
    // reordered or newly-added blank row can't silently break alerting.
    const rows = await airtableGet('WS_Config', '');
    const populated = rows.find(r => r.fields['Alert Phone']);
    if (rows.length > 1) {
      logToAxiom('warn', 'alert_phone_multiple_rows', { rowCount: rows.length, usedRowId: populated ? populated.id : null });
    }
    const phone = populated && populated.fields['Alert Phone'];
    if (!phone) throw new Error('WS_Config has no row with an Alert Phone value');
    _alertPhoneCache = { value: String(phone), fetchedAt: now };
    return _alertPhoneCache.value;
  } catch (err) {
    // Airtable outage or a missing/misconfigured WS_Config row must not leave
    // zero alerting — fall back to the env var, but log every time this
    // happens so silent reliance on the fallback stays visible in Axiom
    // rather than persisting unnoticed for weeks.
    logToAxiom('warn', 'alert_phone_fallback_used', { reason: err.message });
    const fallback = process.env.ALERT_PHONE_FALLBACK;
    if (!fallback) {
      logToAxiom('error', 'alert_phone_unavailable', { reason: 'no WS_Config row and no ALERT_PHONE_FALLBACK set' });
    }
    return fallback || null;
  }
}

async function alertShawn(cronName, errorMessage, context = {}) {
  const to = await getAlertPhone();
  if (!to) {
    logToAxiom('error', 'alert_shawn_no_destination', { cronName, errorMessage });
    return;
  }
  const extra = Object.keys(context).length ? `\n${JSON.stringify(context)}` : '';

  // Guest-struggle/monitoring build, sub-PR 1 (CEO 2026-09-29): the free-form
  // send below silently fails outside Meta's 24h window (CLAUDE.md line 30) —
  // exactly the gap that let a six-week guest_state_write_failed streak go
  // unnoticed. Prefer the approved template once configured; unset IS the
  // stub state (see opsAlertTemplate above), so this falls back to the
  // pre-existing free-form send rather than regressing every call site while
  // Meta approval is pending — the fallback only works inside the 24h
  // window, which is the whole reason this sub-PR exists.
  const templateName = opsAlertTemplate();
  if (templateName) {
    const property = context.propertyName || context.propertyId || context.scope || 'N/A';
    const result = await sendWhatsAppTemplate(
      to, templateName,
      [cronName, property, new Date().toISOString(), errorMessage],
      { site: 'alert_shawn', cronName }
    ).catch(e => {
      console.error('[alertShawn template failed]', e.message);
      return { ok: false, error: { message: e.message } };
    });
    if (!result.ok) {
      logToAxiom('error', 'alert_shawn_template_send_failed', {
        cronName, errorMessage, error: result.error ? JSON.stringify(result.error) : null
      });
    }
    return;
  }
  logToAxiom('warn', 'alert_shawn_template_not_configured', {
    cronName, reason: 'WABISTAY_OPS_ALERT_TEMPLATE not configured — falling back to free-form, 24h-window-limited send'
  });
  const msg = `WABISTAY CRON ERROR — ${cronName} failed.\nError: ${errorMessage}${extra}`;
  await sendWhatsApp(to, msg).catch(e => console.error('[alertShawn failed]', e.message));
}

// ─── SAST DATES (B7) ─────────────────────────────────────────────────────────
// South Africa Standard Time is UTC+2 all year — the country has never observed
// DST — so the offset is a constant, not a timezone lookup. Every relative date
// ("today", "tomorrow") resolves against the SAST calendar; UTC appears only at
// the Airtable write boundary (sastToUtcIso). Vercel runs UTC, so a bare
// new Date() day-boundary is wrong between 00:00 and 01:59 SAST, when the UTC
// date is still the previous day — that window is what these helpers exist for.

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

// CEO-confirmed overnight defaults (16 July). Per-property overrides are a
// later step's problem — do not derive these from the property record yet.
const OVERNIGHT_CHECKIN_HOUR = 14;
const OVERNIGHT_CHECKOUT_HOUR = 10;

// B12 (auto-checkout): once a booking is past its Check Out, the cron sends one
// warning offering an extension; if still unresolved AUTO_CHECKOUT_GRACE_MS
// after that warning, auto-checkout fires. Comparisons are on absolute instants
// (Check Out is already stored as the UTC instant of the SAST checkout time via
// sastToUtcIso), so no further SAST conversion is needed here — the arithmetic
// is pure milliseconds, which is what the mutation test targets.
const AUTO_CHECKOUT_GRACE_MS = 15 * 60 * 1000; // 15-minute warning window

// B12: an EXTEND reply pushes Check Out out (uncapped, repeatable). Increment is
// per booking type. FLAG (genuinely undefined in the brief): these exact
// durations are a CEO pricing/ops decision — built as a sensible default (one
// more hour for a short stay, one more night for an overnight) and called out in
// the PR for confirmation.
const EXTENSION_MS = {
  Hourly: 60 * 60 * 1000,        // +1 hour
  Overnight: 24 * 60 * 60 * 1000 // +1 day
};

// What one extension is WORTH. B12 shipped the time extension without the money:
// `extendStay` pushed `Check Out` out and wrote nothing financial, so every
// extension since has been free, and B17's revenue total (which sums
// `Amount Due`) has understated every extended booking. This resolves the price
// of exactly one extension — the same unit `EXTENSION_MS` moves the clock by —
// and the caller ADDS it to whatever `Amount Due` already holds.
//
// The two paths mirror how each booking type was priced at creation, so an
// extension costs what the stay costs:
//   · Overnight — the booking's own `Rate Applied` link (F19's occupancy-keyed
//     rate). Read from the booking, not re-derived from the guest's occupancy
//     answer, so a rate row edited mid-stay cannot silently reprice history.
//   · Hourly (and Walk-in, which IS Booking Type 'Hourly') — the property's
//     1-hour rate, since the extension unit is one hour.
//
// Returns null when the price cannot be established, and the caller then leaves
// `Amount Due` ALONE rather than guessing. Never invent a number: a wrong figure
// on a bill the guest pays at the desk is worse than a missing one, and the
// same fail-closed posture already governs F19 and `hourlyRates`.
async function extensionCharge(booking, property) {
  // Unknown/blank Booking Type falls to Overnight here for exactly the reason it
  // does in EXTENSION_MS above — the two must agree, or a booking would be given
  // a day of time at an hour's price.
  const type = booking.fields['Booking Type'] === 'Hourly' ? 'Hourly' : 'Overnight';

  if (type === 'Hourly') {
    // HOURLY_RATE_FIELDS[1] rather than a typed field name — same constant the
    // booking flow prices from, so the two cannot drift apart.
    const raw = property && property.fields[HOURLY_RATE_FIELDS[1]];
    const amount = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(amount) || amount <= 0) return null;
    return amount;
  }

  const rateId = (booking.fields['Rate Applied'] || [])[0];
  if (!rateId) return null; // e.g. F19's fail-closed path: booked, never priced
  const rates = await airtableGet('WS_Rates', `RECORD_ID() = '${rateId}'`);
  const amount = Number(rates[0] && rates[0].fields['Amount']);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

// B14 (STOP opt-out). Keywords are matched against the already-lowercased inbound
// text, so STOP / Stop / stop all match — case-insensitive by construction.
const STOP_KEYWORDS = ['stop'];
const START_KEYWORDS = ['start'];
// "Already-active booking" for the two-tier rule: a real commitment, not a
// browsing enquiry. Transaction-completion messages are allowed to an opted-out
// guest only while their booking is in one of these states.
const ACTIVE_BOOKING_STATES = ['CONFIRMED', 'CHECKED_IN'];

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const RELATIVE_DATE_WORDS = ['today', 'tomorrow'];

// The SAST wall-clock date at a given UTC instant.
function sastCalendarDate(nowUtc) {
  const shifted = new Date(nowUtc.getTime() + SAST_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

// The one and only UTC conversion — a SAST calendar date + SAST time → the ISO
// string Airtable stores. Nothing else in this file may build a booking datetime.
// B9 added the minute argument for hourly arrival times ("2:30pm"); overnight
// callers omit it and get :00, exactly as before.
function sastToUtcIso(date, sastHour, sastMinute = 0) {
  return new Date(Date.UTC(date.y, date.m - 1, date.d, sastHour, sastMinute) - SAST_OFFSET_MS).toISOString();
}

function addSastDays(date, days) {
  const shifted = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

function compareYmd(a, b) {
  return (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
}

// Rejects 31 June, 29 Feb in a non-leap year, etc. — Date.UTC silently rolls
// those forward, so round-trip the components and check they survived.
function isValidCalendarDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Guests book the future, so a bare day+month that has already passed this year
// means next year (CEO-confirmed 16 July). Only this year and next are
// considered: "29 February" in a two-non-leap-year window returns null and
// re-prompts rather than silently landing three years out.
function resolveYear(month, day, today) {
  for (const year of [today.y, today.y + 1]) {
    if (!isValidCalendarDate(year, month, day)) continue;
    if (compareYmd({ y: year, m: month, d: day }, today) >= 0) return year;
  }
  return null;
}

function buildFromMonthName(day, monthWord, explicitYear, today) {
  const month = MONTHS[monthWord];
  if (month === undefined) return null;
  if (explicitYear) {
    const y = Number(explicitYear);
    return isValidCalendarDate(y, month, day) ? { y, m: month, d: day } : null;
  }
  const y = resolveYear(month, day, today);
  return y === null ? null : { y, m: month, d: day };
}

function normalizeDateText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Free text → a SAST calendar date, or null if it isn't one. `nowUtc` is passed
// in rather than read from the clock so the near-midnight cases are testable.
// Returns calendar parts only: the time-of-day default is the caller's choice,
// because it differs per booking type (overnight 14:00/10:00 today; hourly later).
function parseBookingDate(text, nowUtc) {
  const t = normalizeDateText(text);
  if (!t) return null;

  const today = sastCalendarDate(nowUtc);
  if (t === 'today') return today;
  if (t === 'tomorrow') return addSastDays(today, 1);

  let m;
  // "25 june", "25jun", "25 jun 2027"
  if ((m = t.match(/^(\d{1,2}) ?([a-z]+)\.?(?: (\d{4}))?$/))) {
    return buildFromMonthName(Number(m[1]), m[2], m[3], today);
  }
  // "june 25", "jun 25 2027"
  if ((m = t.match(/^([a-z]+)\.? ?(\d{1,2})(?: (\d{4}))?$/))) {
    return buildFromMonthName(Number(m[2]), m[1], m[3], today);
  }
  // "25/06", "25-6", "25/06/2027", "25/06/27" — day-first (SA convention, and
  // what the pre-B7 detection regex already assumed). Never MM/DD.
  if ((m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2}|\d{4}))?$/))) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return isValidCalendarDate(y, month, day) ? { y, m: month, d: day } : null;
    }
    const y = resolveYear(month, day, today);
    return y === null ? null : { y, m: month, d: day };
  }
  return null;
}

// ─── DATE-TOKEN DETECTION (F20 — parser robustness) ──────────────────────────
// Locates date-shaped SPANS in free text, so collectDetails can accept a name
// plus two dates all on ONE line — a real prospect (Caillin) sent exactly
// "Caillin Mendes 31July 2026 1 August 2026" and the old three-separate-lines
// parser re-prompted three times until he abandoned the booking — as well as
// the existing newline-separated form. It also closes the month-substring trap:
// the old classifier used loose `line.includes('may'|'aug'|'jun'…)`, so a NAME
// containing a month fragment ("May Ndlovu", "Augustine", "Julian") was read as
// a date. This matches genuine date shapes (day+month, month+day, numeric
// day-first, today/tomorrow) instead of any substring.
//
// This only LOCATES candidates. parseBookingDate remains the gate that validates
// them downstream, so an over-eager match here re-prompts rather than booking a
// non-date. Longest month name wins (sorted by length) so "June" is not clipped
// to "Jun" — the raw token feeds Notes and guest copy, which must stay verbatim.
const MONTH_NAMES_BY_LEN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const DATE_TOKEN_SOURCE =
  '\\d{1,2}\\s*(?:' + MONTH_NAMES_BY_LEN + ')\\.?(?:\\s+\\d{4})?' +     // 31July 2026, 25 June, 1 August 2026
  '|(?:' + MONTH_NAMES_BY_LEN + ')\\.?\\s*\\d{1,2}(?:\\s+\\d{4})?' +    // June 25, Aug 3 2026
  '|\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{2,4})?' +                    // 25/06, 25-6-2027
  '|today|tomorrow';

function findDateTokens(text) {
  const re = new RegExp(DATE_TOKEN_SOURCE, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push({ text: m[0].trim(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// ─── AXIOM LOGGER ────────────────────────────────────────────────────────────
// F12: fire-and-forget log to Axiom HTTP API
// Never awaited in critical path — cannot block or break the state machine
// Dataset: wabistay · Token via AXIOM_TOKEN env var
// This was always the correct name — it is the only dataset that exists in the
// org, which is why Wabistay logging worked while the router's silently did not.
const AXIOM_DATASET = 'wabistay';

function logToAxiom(level, event, detail = {}) {
  if (!AXIOM_TOKEN) return;
  const payload = [{
    _time: new Date().toISOString(),
    level,
    event,
    source: 'wabistay',
    ...detail
  }];
  fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/ingest`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AXIOM_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
    // fetch resolves on 4xx/5xx — surface it or it is invisible. See api/webhook.js.
    .then(res => {
      if (!res.ok) console.error(`[Axiom ERROR] ingest rejected: HTTP ${res.status} dataset=${AXIOM_DATASET} event=${event}`);
    })
    .catch(err => console.error('[Axiom ERROR]', err.message));
}

// B17: instrument the three existing owner/notify sends. Business-initiated
// free-form text silently fails (HTTP 200, nothing logged) outside the 24-hour
// customer-service window (CLAUDE.md). We cannot see Meta's window directly, but
// the reliable proxy is: is the recipient the phone that just messaged us? If so
// it is inside the window by definition; if it is a third party (owner / notify
// phone), it is almost certainly OUTSIDE it. Logging this at each site makes the
// scale of the existing exposure measurable without changing any behaviour.
function logOwnerSendWindow(site, recipient, inboundPhone) {
  const inside = recipient === inboundPhone;
  logToAxiom('info', 'owner_send_window_check', {
    site, recipient, inboundPhone,
    recipientIsInboundSender: inside,
    likelyInside24hWindow: inside
  });
}

// ─── MESSAGE RENDERING ───────────────────────────────────────────────────────
// All copy lives in states.json → messages. {placeholder} substitution only.

function msg(key, vars = {}) {
  let out = STATES.messages[key];
  if (out === undefined) throw new Error(`states.json missing message: ${key}`);
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

// ─── PROPERTY RESOLUTION ─────────────────────────────────────────────────────
// 6.4: resolve which WS_Properties record this message belongs to, from the
// receiving phone_number_id. Called once per incoming message, before dispatch.
// filterByFormula on a plain singleLineText field ({Phone Number ID} = '...')
// — standard equality match, not a linked-record lookup, so no FIND/ARRAYJOIN needed here.

async function resolveProperty(phoneNumberId) {
  const properties = await airtableGet('WS_Properties', `{Phone Number ID} = '${phoneNumberId}'`);
  if (properties.length === 0) {
    logToAxiom('error', 'property_resolution_failed', { phone_number_id: phoneNumberId });
    return null;
  }
  return properties[0];
}

// ─── PROPERTY ACTIVITY TRACKER ──────────────────────────────────────────────
// Three WS_Properties timestamp fields, populated best-effort so a write
// failure here never blocks the guest/owner-facing flow it's attached to:
//   · Last Message Received — any inbound webhook message resolved to this
//     property (set in handleMessage, right after resolveProperty).
//   · Last Report Sent — deliberately NOT a WS_Properties write. runOwnerSummary/
//     runDailySummary are a documented, tested read-only invariant (Rule 29,
//     test/dailysummary.test.js: "both crons are read-only reporting — zero
//     writes from either"), so this is surfaced instead from the existing
//     owner_summary_payload / daily_summary_payload Axiom events, which
//     already carry propertyId and a timestamp per run — no new write, no
//     invariant break, satisfies "surface from existing cron logs" literally.
//   · Last Owner App Open — NOT a real Meta webhook event. Meta's Cloud API
//     has no "user opened WhatsApp" callback; account_offboarded/
//     account_reconnected (the events the original ask named) are
//     Coexistence WABA-connection events, not per-owner app-open signals, and
//     this codebase doesn't subscribe to them. The best available proxy is a
//     `read` delivery-status callback on a message sent to that owner's
//     Notify Phone — you cannot mark a WhatsApp message read without having
//     opened the app around that time. This only advances when Meta sends us
//     something to read a status on, so it under-reports app opens with no
//     Wabistay message in flight — flagged, not silently presented as ground
//     truth.
async function bumpPropertyActivity(propertyId, field) {
  if (!propertyId) return;
  try {
    const result = await airtableUpdate('WS_Properties', propertyId, { [field]: new Date().toISOString() });
    if (result && result.error) {
      logToAxiom('warn', 'property_activity_write_failed', { propertyId, field, error: JSON.stringify(result.error) });
    }
  } catch (err) {
    logToAxiom('warn', 'property_activity_write_failed', { propertyId, field, error: err.message });
  }
}

// ─── DORMANT-PROPERTY FLAGGING ───────────────────────────────────────────────
// Uses the two activity fields bumpPropertyActivity writes: 'Last Message
// Received' and 'Last Owner App Open'. A missing timestamp (never bumped at
// all) counts as maximally stale, same as any other value older than the
// threshold.
//
// CEO DECISION (superseding the original "either" default this shipped
// with): 'Last Message Received' (guest activity) and 'Last Owner App Open'
// (the actual WhatsApp Coexistence 14-day disconnect signal) measure two
// DIFFERENT risks, and must not be conflated into one flag. A property can
// have constant guest inquiries while the owner's own app-open has gone
// stale — that IS real disconnect risk, and a combined/either-signal flag
// would mask it (a busy guest inbox would keep the property looking
// "active" even as the owner's number drifts toward disconnection). So:
//   · dormantProperties() — THE disconnect-risk flag, keyed on
//     'Last Owner App Open' ALONE by default (mode: 'owner_open_only').
//   · inactiveByMessageActivity() — a separate, distinct "this property may
//     be quiet" view keyed on 'Last Message Received' ALONE. Not merged into
//     the dormancy flag; not deleted; just not conflated. See
//     dormant-report.js, which now surfaces both as separate response keys.
// `mode: 'either'`/`'both'` remain available on dormantProperties() for
// anyone who wants a combined view later, but neither is the default.
const DORMANT_THRESHOLD_DAYS_DEFAULT = 10;

function isStale(isoTimestamp, thresholdMs, now) {
  if (!isoTimestamp) return true; // never recorded = maximally stale
  const ms = Date.parse(isoTimestamp);
  if (!Number.isFinite(ms)) return true; // unparseable = treat as unknown/stale
  return (now.getTime() - ms) > thresholdMs;
}

function dormantProperties(properties, opts = {}) {
  const {
    thresholdDays = Number(process.env.DORMANT_THRESHOLD_DAYS) || DORMANT_THRESHOLD_DAYS_DEFAULT,
    now = new Date(),
    mode = 'owner_open_only' // 'owner_open_only' (CEO-confirmed default), 'either', or 'both'
  } = opts;
  const thresholdMs = thresholdDays * DAY_MS;

  return properties
    .map(p => {
      const msgStale = isStale(p.fields['Last Message Received'], thresholdMs, now);
      const openStale = isStale(p.fields['Last Owner App Open'], thresholdMs, now);
      const dormant = mode === 'both' ? (msgStale && openStale)
        : mode === 'either' ? (msgStale || openStale)
        : openStale; // 'owner_open_only'
      return { property: p, msgStale, openStale, dormant };
    })
    .filter(r => r.dormant)
    .map(r => ({
      propertyId: r.property.id,
      propertyName: r.property.fields['Property Name'] || null,
      lastMessageReceived: r.property.fields['Last Message Received'] || null,
      lastOwnerAppOpen: r.property.fields['Last Owner App Open'] || null,
      msgStale: r.msgStale,
      openStale: r.openStale
    }));
}

// Separate, distinct "property may be inactive" view — 'Last Message
// Received' ALONE, deliberately NOT combined with the disconnect-risk flag
// above (see the header comment for why). Same shape/threshold mechanics,
// different signal, different meaning: this is about whether the property
// itself is seeing guest traffic, not about the owner's WhatsApp connection.
function inactiveByMessageActivity(properties, opts = {}) {
  const {
    thresholdDays = Number(process.env.DORMANT_THRESHOLD_DAYS) || DORMANT_THRESHOLD_DAYS_DEFAULT,
    now = new Date()
  } = opts;
  const thresholdMs = thresholdDays * DAY_MS;

  return properties
    .filter(p => isStale(p.fields['Last Message Received'], thresholdMs, now))
    .map(p => ({
      propertyId: p.id,
      propertyName: p.fields['Property Name'] || null,
      lastMessageReceived: p.fields['Last Message Received'] || null
    }));
}

// ─── ESCALATION TIMEOUT CONFIG (per-property, global default fallback) ─────
// Shift-routing/escalation investigation, PR 1 of 11 — config value only, no
// routing/resolver logic yet (that starts at PR 2's role-tagged WS_Config
// contacts). Pattern follows the CONFIRMED-live precedent for a per-property
// value with a global fallback: runDailySummary's read of
// `WS_Properties.'Daily Summary Hour'` (a plain per-property field, Number()'d
// at the read site, no dedicated getter). This mirrors that shape rather than
// gateAckGraceMs()'s env-only pattern — that function does NOT exist on main
// (see corrected investigation report; it was unmerged WIP on a stale branch,
// never a shipped precedent) and must not be treated as one.
//
// Field name is a PROPOSAL, not yet live: 'Escalation Timeout Minutes' has
// not been created in Airtable. Per the field-names-from-live-schema-only
// hard rule, this is deliberately written as a plain, tolerant field read
// (same as 'Daily Summary Hour') so it degrades to the global default with
// zero errors until the field exists — it does not assume the field is
// there. Once CEO creates it in the Airtable UI (current workaround for the
// live API billing cap — see PR-breakdown doc), update schema.json to match
// and this function's behaviour is already correct, no code change needed.
//
// Minutes, not ms, at the Airtable field level — same unit choice as 'Daily
// Summary Hour' (hours, not ms) for the same reason: a human configuring this
// in Airtable's UI should never have to type milliseconds.
const ESCALATION_TIMEOUT_DEFAULT_MINUTES = 15;

// Global default is env-overridable (ESCALATION_TIMEOUT_DEFAULT_MINUTES),
// matching DORMANT_THRESHOLD_DAYS's env-override-with-hardcoded-fallback
// shape above. An invalid/non-positive per-property value falls back to the
// global default rather than producing a zero or negative timeout — the same
// "never silently produce a degenerate value" posture as gateAckGraceMs's own
// invalid-value handling in the (unmerged) stashed branch.
function escalationTimeoutMs(property) {
  const globalDefaultMinutes = Number(process.env.ESCALATION_TIMEOUT_DEFAULT_MINUTES) || ESCALATION_TIMEOUT_DEFAULT_MINUTES;
  const raw = property && property.fields && property.fields['Escalation Timeout Minutes'];
  const parsed = Number(raw);
  const minutes = (raw !== undefined && raw !== null && Number.isFinite(parsed) && parsed > 0)
    ? parsed
    : globalDefaultMinutes;
  return minutes * 60 * 1000;
}

// Written with every greeting: 'Last Inbound At', so the abandonment sweep sees the greeting step as
// fresh. It is written for test phones and with tracking off too: without it a guest moved to
// AWAITING_STAY_TYPE keeps an old value from an earlier session and the next 5-minute sweep resets them
// to NEW seconds later (seen live 6 Oct 2026). Only for tracked, non-test guests, and when this starts a
// fresh attempt (guest new or back at NEW), also the attempt's start and property. A restart from
// mid-flow ("hi"/"menu") keeps the original start.
function greetingTrackingFields(ctx) {
  const now = new Date().toISOString();
  if (!enquiryTrackingEnabled() || isTestGuest(ctx.guest)) return { 'Last Inbound At': now };
  const state = ctx.guest && ctx.guest.fields['Session State'];
  const fresh = !ctx.guest || !state || state === 'NEW';
  return {
    'Last Inbound At': now,
    ...(fresh ? { 'Attempt Started At': now, 'Attempt Property': [ctx.property.id] } : {})
  };
}

function propertyCityLine(property) {
  const city = property.fields['City'];
  return city ? `, ${city}` : '';
}

// Doc 1b PR 3 (01 Oct 2026). A guest is never told the lodge is "fully booked"
// or "full": a room can be unavailable to the bot for reasons the guest cannot
// act on (every room mid-clean, or the availability check itself failing
// closed on an Airtable error), and reception can usually sort it out. Every
// guest-facing "no room" path sends the same sentence, pointing at the number
// the suspended-property redirect already uses (Guest Redirect Phone, falling
// back to Notify Phone). With neither set the sentence is sent without the
// number — no new words — and the gap is logged loudly.
// Every guest-facing "speak to reception, no room" message goes through here so
// the lost enquiry is on the record: a log-only Axiom event (no Airtable row) with
// the phone and the SAST hour of day, for review of when this happens. `stage` says
// where the guest was: the greeting itself (no Available room) or a booking step
// (no availability for the dates/time asked, or the availability check failed
// closed — the two look the same here; availability_check_failed_closed is logged
// separately when it is the latter).
async function sendNoRoomMessage(ctx, stage) {
  logToAxiom('info', 'enquiry_no_room_at_greeting', {
    phone: ctx.phone,
    sastHour: new Date(Date.now() + SAST_OFFSET_MS).getUTCHours(),
    stage,
    propertyId: ctx.property && ctx.property.id,
    sessionState: (ctx.guest && ctx.guest.fields['Session State']) || null,
    ...(ctx.guest && ctx.guest.fields['Test Phone'] === true ? { testPhone: true } : {})
  });
  return sendWhatsApp(ctx.phone, noRoomMessage(ctx.property));
}

function noRoomMessage(property) {
  const fields = (property && property.fields) || {};
  const redirectPhone = fields['Guest Redirect Phone'] || fields['Notify Phone'] || null;
  if (!redirectPhone) {
    logToAxiom('error', 'no_room_message_missing_redirect_phone', { propertyId: property && property.id });
    return msg('noRoomSpeakToReceptionNoPhone');
  }
  return msg('noRoomSpeakToReception', { redirectPhone });
}

// Room count in the greeting is opt-in per property: the checkbox
// 'Show Room Count To Guests' must be ticked. Airtable omits an unticked box
// entirely, so only === true shows it (same allowlist reading as 'Active').
function roomCountLine(property, roomCount) {
  if (!property || !property.fields || property.fields['Show Room Count To Guests'] !== true) return '';
  return `We currently have *${roomCount} room${roomCount !== 1 ? 's' : ''}* available.\n\n`;
}

// F19 (Rate-fix): the occupancy step confirms the booking a turn after
// collectDetails created it, so it no longer has the guest's raw date strings in
// hand. They are recovered from the Notes line collectDetails wrote
// ("Check-in: X | Check-out: Y") so bookingReceived still shows the dates in the
// guest's own words ("25 June"), unchanged, rather than the reformatted datetime.
function checkDatesFromNotes(notes) {
  const s = String(notes || '');
  const inM = s.match(/Check-in:\s*(.+?)(?:\s*\|\s*Check-out:|$)/);
  const outM = s.match(/Check-out:\s*(.+?)\s*$/);
  return { checkIn: inM ? inM[1].trim() : '', checkOut: outM ? outM[1].trim() : '' };
}

// ─── HOURLY / SHORT STAY (B9) ────────────────────────────────────────────────
// Hourly bookings write real start/end datetimes into the same Check In/Check Out
// fields as overnight, so B8's findAvailableRoom blocks hourly-vs-hourly and
// hourly-vs-overnight with no extra logic. There is deliberately no second date
// system — the only difference from overnight is the hour granularity and the
// fact that check-out is computed from a duration rather than parsed.
//
// Rates come from three per-property currency fields (names verified against
// live Airtable metadata, per Rule 1 — never typed from memory).

const HOURLY_DURATIONS = [1, 2, 3];
const HOURLY_RATE_FIELDS = {
  1: 'Hourly Rate 1hr',
  2: 'Hourly Rate 2hr',
  3: 'Hourly Rate 3hr'
};

// Fail closed: a property with any hourly rate blank or zero has not configured
// short stays, and must never quote R0 or fall through to a free booking. The
// whole feature is switched off for that property and the guest is routed to the
// overnight flow instead — the same redirect the >3hr case uses.
function hourlyRatesFor(property, durations) {
  const rates = {};
  for (const hours of durations) {
    const raw = property.fields[HOURLY_RATE_FIELDS[hours]];
    const amount = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(amount) || amount <= 0) return null;
    rates[hours] = amount;
  }
  return rates;
}
function hourlyRates(property) {
  return hourlyRatesFor(property, HOURLY_DURATIONS);
}

// WABISTAY_LEAN_COPY (1 or true; off by default). The short-stay path stops sending a
// separate "Short stay rates" message before it asks for the guest's details (the
// prices are on the duration question anyway), the name-and-time request and its
// re-prompt get shorter copy with an example, and a one-line reply such as
// "Tim 9pm" or "9pm Tim" is accepted. The fail-closed rates check is unchanged.
function leanCopyEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_LEAN_COPY || '').trim());
}
// WABISTAY_GUEST_ADDRESS (1 or true; off by default). The booking-confirmed messages (confirmedMenu,
// the overnight etaConfirmed, and the CONFIRMED fallback that reuses confirmedMenu) carry the lodge's
// Guest Address and, on its own line, Guest Maps Link, between the "confirmed" / "See you at" line and
// "Reply with a number". Each line shows only when its WS_Properties field is filled. Off: today's text.
function guestAddressEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_GUEST_ADDRESS || '').trim());
}
function guestAddressBlock(property) {
  if (!guestAddressEnabled() || !property) return '';
  const lines = ['Guest Address', 'Guest Maps Link']
    .map(f => String(property.fields[f] || '').trim())
    .filter(Boolean);
  return lines.length ? lines.join('\n') + '\n\n' : '';
}
// ─── ONE OPEN BOOKING (WABISTAY_ONE_OPEN_BOOKING) and GATE_REQUIRES_BOOKING ──
// Seen live 6 Oct 2026: a 3-hour booking (WS-D4NUMZ, 16:00) was never paid or used; at 18:53 the guest booked an
// Overnight (WS-PSG4VQ) and the 18:54 gate tap used the OLD booking, because the gate took the first Confirmed
// booking Airtable returned (the oldest). Nothing ever replaced the older open booking.
// ONE_OPEN_BOOKING (off by default):
//   · when a booking becomes Confirmed, the guest's OTHER unpaid, unchecked-in Enquiry/Confirmed bookings at the
//     same property are cancelled, except one that falls on a LATER DAY than the new one (a real future stay);
//     Notify Phone is told once, and a failed notice never blocks the cancel;
//   · the gate chooses the open booking whose check-in is nearest to now, newest (record createdTime) on a tie;
//     the payment-method step, cancel, ETA, checkout and extend choose the newest.
// GATE_REQUIRES_BOOKING (off by default): a guest tapping "I'm at the gate" with no Confirmed booking is told so,
// set to NEW, and nothing else happens (before: the legacy branch assigned a free room and checked them in).
function oneOpenBookingEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_ONE_OPEN_BOOKING || '').trim());
}
function gateRequiresBookingEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_GATE_REQUIRES_BOOKING || '').trim());
}
// Newest first by Airtable's record createdTime; records without one fall back to list position (later = newer).
function newestFirst(list) {
  const created = b => { const t = Date.parse(b.createdTime || ''); return Number.isFinite(t) ? t : null; };
  return list.map((b, i) => ({ b, i })).sort((x, y) => {
    const cx = created(x.b);
    const cy = created(y.b);
    if (cx !== null && cy !== null && cx !== cy) return cy - cx;
    return y.i - x.i;
  }).map(o => o.b);
}
// The newest open booking when the flag is on, otherwise the list exactly as Airtable returned it.
function byNewest(list) {
  return oneOpenBookingEnabled() ? newestFirst(list) : list;
}
// Check-in nearest to now; a tie (or no dates at all) goes to the newest.
function pickNearestOpenBooking(list, nowMs = Date.now()) {
  if (list.length === 0) return null;
  const dist = b => { const t = Date.parse(b.fields['Check In'] || ''); return Number.isFinite(t) ? Math.abs(t - nowMs) : Infinity; };
  return newestFirst(list).sort((a, b) => {
    const da = dist(a);
    const db = dist(b);
    return da === db ? 0 : (da < db ? -1 : 1);
  })[0];
}
// `fresh` = { id, checkIn, ref, stay } of the booking that has just become Confirmed.
async function supersedeOlderBookings(ctx, fresh) {
  if (!oneOpenBookingEnabled()) return;
  try {
    const [enquiries, confirmed] = await Promise.all([
      airtableGetBookingsByGuestId(ctx.guest.id, 'Enquiry'),
      airtableGetBookingsByGuestId(ctx.guest.id, 'Confirmed')
    ]);
    const newMs = Date.parse(fresh.checkIn || '');
    const cancelled = [];
    for (const b of [...enquiries, ...confirmed]) {
      if (b.id === fresh.id) continue;
      const f = b.fields;
      if (f['Payment Status'] === 'Paid' || Number(f['Amount Paid']) > 0 || f['Checked In At']) continue;
      const olderMs = Date.parse(f['Check In'] || '');
      // A stay on a LATER DAY is a real future booking, left alone. Compared by SAST date, not clock time: a typed-dates
      // overnight is stamped 14:00, which is earlier than a 16:00 short stay booked for the same day.
      if (Number.isFinite(olderMs) && Number.isFinite(newMs) && compareYmd(sastCalendarDate(new Date(olderMs)), sastCalendarDate(new Date(newMs))) > 0) continue;
      const roomId = (f['Room'] || [])[0];
      const room = roomId ? (await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`))[0] || null : null;
      if (bookingPropertyId(b, room && (room.fields['Property'] || [])[0]) !== ctx.property.id) continue;
      const write = await airtableUpdate('WS_Bookings', b.id, { 'Status': 'Cancelled' });
      if (write && write.error) {
        logToAxiom('error', 'booking_superseded_write_failed', { bookingId: b.id, supersededBy: fresh.id, error: JSON.stringify(write.error) });
        continue;
      }
      const ref = f['Booking Ref'] || `WS-${b.id.slice(-6).toUpperCase()}`;
      cancelled.push(`${ref} (${f['Booking Type'] || 'booking'}${room ? ', ' + room.fields['Room Name'] : ''})`);
      logToAxiom('info', 'booking_superseded', { bookingId: b.id, bookingRef: ref, supersededBy: fresh.id, status: f['Status'] });
    }
    if (cancelled.length === 0) return;
    const notifyRaw = ctx.property.fields['Notify Phone'];
    const notifyPhone = notifyRaw ? String(notifyRaw).replace(/[\s\-\+]/g, '') : OWNER_PHONE;
    if (!notifyPhone) return;
    const send = await sendWhatsApp(notifyPhone, msg('oneOpenSuperseded', {
      guestName: ctx.guest.fields['Guest Name'], phone: ctx.phone, newRef: fresh.ref, newStay: fresh.stay, list: cancelled.join(', ')
    }));
    if (send && send.error) logToAxiom('error', 'booking_superseded_notice_failed', { supersededBy: fresh.id, error: JSON.stringify(send.error) });
  } catch (err) {
    logToAxiom('error', 'booking_supersede_failed', { phone: ctx.phone, bookingId: fresh.id, message: err.message });
  }
}

// WABISTAY_PAY_ASSIGNS_ROOM (1 or true; off by default). A guest who tapped "I'm at the gate" before
// paying is waiting for reception. When reception then records the payment, the guest is checked in
// and sent their room automatically (the same check-in and welcome as a second tap), once.
// For ten minutes after that automatic check-in a tap of 1 is answered "already checked in" instead of
// checking the guest out. An automatic check-in is recognised from the booking's own timestamps: the
// gate tap came first, payment after it, and the check-in within two minutes of the payment.
function payAssignsRoomEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_PAY_ASSIGNS_ROOM || '').trim());
}
const PAY_ASSIGNS_GUARD_MS = 10 * 60 * 1000;
const PAY_ASSIGNS_CHECKIN_AFTER_PAID_MS = 2 * 60 * 1000;
const PAY_ASSIGNS_TAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function isAutoCheckedIn(booking) {
  const tap = Date.parse(booking.fields['Gate Tap At'] || '');
  const paid = Date.parse(booking.fields['Paid At'] || '');
  const inAt = Date.parse(booking.fields['Checked In At'] || '');
  if (!(tap > 0) || !(paid > 0) || !(inAt > 0)) return false;
  return paid >= tap && inAt >= paid && inAt - paid <= PAY_ASSIGNS_CHECKIN_AFTER_PAID_MS;
}
function confirmedMenuMessage(property, guestName) {
  return msg('confirmedMenu', { guestName, addressBlock: guestAddressBlock(property) });
}
// Words that may sit directly in front of a time ("Tim at 9pm") and are not part of the name.
const TIME_FILLER_WORDS = new Set(['at', 'around', 'about', 'by', 'before', 'after', 'approx', 'approximately', 'roughly', 'from', '@']);
// One-line "name and time" reply. Accepted only when EXACTLY ONE whitespace-separated
// part parses as a time and what is left is a name of at least one word. "9 pm" is joined
// to "9pm" first. Returns { name, time } (time may be { ambiguous }), or null.
function parseOneLineNameAndTime(line) {
  const cleaned = String(line || '').trim().replace(/(\d)\s+(am|pm)\b/gi, '$1$2');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const timeIdx = [];
  tokens.forEach((tok, i) => { if (parseArrivalTime(tok)) timeIdx.push(i); });
  if (timeIdx.length !== 1) return null;
  const i = timeIdx[0];
  const time = parseArrivalTime(tokens[i]);
  const drop = new Set([i]);
  if (i > 0 && TIME_FILLER_WORDS.has(tokens[i - 1].toLowerCase())) drop.add(i - 1);
  const name = tokens.filter((_, j) => !drop.has(j)).join(' ').trim();
  if (!name) return null;
  return { name, time };
}

// WABISTAY_HIDE_ONE_HOUR (1 or true; off by default): the guest-facing short-stay
// flow stops offering the 1-hour option. Only 2 and 3 hours are listed, prompted
// for and accepted; a reply of 1 repeats the prompt and books nothing. The 1hr
// rate in Airtable is left alone and is simply not read by the guest flow — it is
// NOT blanked, because hourlyRates() fails closed on any blank rate. Staff
// walk-ins (WALKIN ... 1HRS) and the +1 hour extension charge still use the 1hr
// rate, so keep it populated.
function hideOneHourEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_HIDE_ONE_HOUR || '').trim());
}
function offeredHourlyDurations() {
  return hideOneHourEnabled() ? HOURLY_DURATIONS.filter(h => h !== 1) : HOURLY_DURATIONS;
}
// The rates the guest flow reads: every offered duration must be configured
// (fail closed), the hidden one is not looked at.
function guestHourlyRates(property) {
  return hourlyRatesFor(property, offeredHourlyDurations());
}
// "1 - 1 hour (R120)\n2 - 2 hours (R250)\n3 - 3 hours (R300)", or just the 2 and 3
// lines when 1 hour is hidden. The reply key is the hour value either way.
function hourlyDurationLines(rates) {
  return offeredHourlyDurations().map(h => `${h} - ${h === 1 ? '1 hour' : h + ' hours'} (R${rates[h]})`).join('\n');
}

// Bare hours 1–11 are genuinely ambiguous ("9" could be morning or night) and
// guessing wrong puts the booking twelve hours from where the guest meant —
// wrong window held, wrong room blocked, guest arrives to nothing. One extra
// question is cheaper than that, so ambiguity re-prompts instead of assuming.
// Returns { hour, minute } in SAST, { ambiguous: n }, or null.
function parseArrivalTime(text) {
  const t = String(text || '')
    .trim().toLowerCase()
    .replace(/^(from|at|around|about|approx\.?|approximately|after|before|roughly)\s+/g, '')
    .replace(/\s+/g, '');
  if (!t) return null;

  const m = t.match(/^(\d{1,2})(?::|h|\.)?(\d{2})?(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3];
  if (minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }
  if (hour > 23) return null;
  // 0 and 12–23 can only be 24-hour clock; 1–11 could be either.
  if (hour >= 1 && hour <= 11) return { ambiguous: hour };
  return { hour, minute };
}

// The load-bearing duration arithmetic: get this wrong and every hourly overlap
// check silently examines the wrong window. Kept as one tiny function so it can
// be mutation-tested directly.
function addHoursToIso(iso, hours) {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Renders a stored UTC instant back in SAST for guest-facing copy. Times are
// always shown with their date: an hourly booking that rolled to tomorrow must
// not read as if it were today.
function formatSastDateTime(iso) {
  const d = new Date(Date.parse(iso) + SAST_OFFSET_MS);
  const h24 = d.getUTCHours();
  const meridiem = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const time = `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')}${meridiem}`;
  return `${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]} at ${time}`;
}

function durationText(hours) {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

// ─── WALK-IN COMMAND PARSER (B7) ─────────────────────────────────────────────
// `WALKIN ROOM <n> <h>HRS` — staff-initiated, no guest thread. This function is
// PURE: it reads the message and nothing else. Room resolution, authorisation
// and every Airtable write live in the handler, so the grammar can be tested
// exhaustively without a base.
//
// Deliberately strict, for three reasons that are all live-data hazards:
//
//  1. The ROOM keyword is REQUIRED. Villa Liza's rooms are numbered 1–12, so
//     `WALKIN 12 2` is two bare numbers with no way to tell which is the room.
//     The keyword is the only thing that disambiguates them.
//  2. The hour UNIT is REQUIRED (`2hrs`, not `2`). Same reason from the other
//     side: with the unit, `WALKIN ROOM 12 2HRS` is unambiguous even though both
//     tokens are numbers and both are valid room numbers.
//  3. Matching is anchored and exact — NOT `roomMatchesText`. That helper tests
//     `\b<number>\b` anywhere in the message, so it would match Room 02 on the
//     DURATION digit of `WALKIN ROOM 12 2HRS` and send staff to the wrong room.
//     It is correct where it is used (a cleaner naming a room in free text) and
//     wrong here; this parser is the reason it stays untouched.
//
// Three return shapes, and the distinction between the first two is what makes
// the no-leak rule work:
//   · null                          — not a WALKIN attempt at all. The guard
//                                     declines and the message falls through to
//                                     the ordinary guest flow, so an outsider
//                                     who types this sees exactly what any
//                                     stranger sees. Nothing confirms the
//                                     command exists.
//   · { ok: false, reason }         — a WALKIN attempt that is malformed. Only
//                                     an AUTHORISED sender ever sees the usage
//                                     help; for anyone else the handler is never
//                                     reached, so this shape still leaks nothing.
//   · { ok: true, roomToken, hours }— parsed. `roomToken` is the raw token
//                                     ('2', '02', 'a') for the resolver to match
//                                     against Room Number / Room Name; the
//                                     parser does not know what rooms exist.
const WALKIN_KEYWORD = /^walk\s*-?\s*in\b/i;
// `room2` (no space) and `room 02` (zero-padded, as every live Room Name is)
// both parse; the token is handed on verbatim rather than coerced to a number,
// because `Room A` exists in the fixtures and a number would lose it. Everything
// after the duration is guest identity — see splitWalkinIdentity.
const WALKIN_BODY = /^room\s*([a-z0-9]{1,4})\s+(\d{1,2})\s*(?:hrs|hr|hours|hour|h)\b\.?\s*(.*)$/i;
// PR D (CEO decision, 2026-09-29): `WALKIN ROOM <n> OVERNIGHT <checkin> <checkout>
// [name] [phone]` — the overnight sibling of the hourly grammar above, same
// `ROOM <n>` anchor, `OVERNIGHT` playing the disambiguating role `HRS` plays for
// hourly. Reuses findDateTokens/parseBookingDate (the exact parser collectDetails
// already uses for guest-typed dates) rather than inventing a second date
// grammar to maintain.
const WALKIN_OVERNIGHT_BODY = /^room\s*([a-z0-9]{1,4})\s+overnight\s+(.*)$/i;
// A trailing SA phone number, in any of the shapes staff actually type. Anchored
// to the END so it can never eat a digit out of the middle of a name.
const WALKIN_PHONE = /(?:^|\s)(\+?\d[\d\s-]{7,15})\s*$/;

// The message is matched case-INSENSITIVELY but never lowercased, because the
// guest's name is carried through verbatim: "John Smith" must reach Airtable as
// the guest typed it, not as "john smith".
function splitWalkinIdentity(rest) {
  const trimmed = String(rest || '').trim();
  if (!trimmed) return { guestName: null, guestPhone: null };

  const pm = trimmed.match(WALKIN_PHONE);
  if (pm) {
    const digits = pm[1].replace(/[\s\-+]/g, '');
    // Validated as a real SA number before it is treated as one. A name ending
    // in a stray digit ("Room 5 guest 2") fails this and stays part of the name,
    // rather than becoming a phone number nobody can call.
    if (/^(?:27\d{9}|0\d{9})$/.test(digits)) {
      const name = trimmed.slice(0, pm.index).trim();
      return { guestName: name || null, guestPhone: formatPhone(pm[1]) };
    }
  }
  return { guestName: trimmed, guestPhone: null };
}

function parseWalkinCommand(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!WALKIN_KEYWORD.test(t)) return null;

  const body = t.replace(WALKIN_KEYWORD, '').trim();

  // PR D: OVERNIGHT checked first — its own keyword makes it unambiguous
  // against the hourly grammar (a bare "overnight" can never be mistaken for
  // an hour count the way two numbers could).
  const om = body.match(WALKIN_OVERNIGHT_BODY);
  if (om) {
    const roomToken = om[1];
    const rest = om[2];
    const dateTokens = findDateTokens(rest);
    if (dateTokens.length < 2) return { ok: false, reason: 'bad_dates' };

    const now = new Date();
    const checkInDate = parseBookingDate(dateTokens[0].text, now);
    const checkOutDate = parseBookingDate(dateTokens[1].text, now);
    if (!checkInDate || !checkOutDate || compareYmd(checkOutDate, checkInDate) <= 0) {
      return { ok: false, reason: 'bad_dates' };
    }

    // Same identity grammar as hourly — everything after the SECOND date
    // token is guest name/phone, same optional-trailing-phone rule.
    const identityText = rest.slice(dateTokens[1].end);
    const { guestName, guestPhone } = splitWalkinIdentity(identityText);
    return {
      ok: true, overnight: true, roomToken,
      checkInText: dateTokens[0].text, checkOutText: dateTokens[1].text,
      checkInDate, checkOutDate, guestName, guestPhone
    };
  }

  const m = body.match(WALKIN_BODY);
  if (!m) return { ok: false, reason: 'bad_syntax' };

  const hours = Number(m[2]);
  // Duration is locked to the hourly rate card (CEO, 6 Aug): 1/2/3 only. A
  // fourth duration has no price — the overnight rate is occupancy-keyed and a
  // walk-in has no guest to ask — so it is refused rather than guessed. Reusing
  // HOURLY_DURATIONS means the command and the rate card can never drift apart.
  if (!HOURLY_DURATIONS.includes(hours)) return { ok: false, reason: 'bad_duration', hours };

  // Name absent is NOT a parse error: the grammar's job is to report what the
  // message contained. The handler owns the policy that a name is required, and
  // answers a nameless command with the usage line — which is the closest a
  // stateless serverless handler can get to "prompt for the guest name" without
  // a place to park the half-finished command. See the PR.
  const { guestName, guestPhone } = splitWalkinIdentity(m[3]);
  return { ok: true, roomToken: m[1], hours, guestName, guestPhone };
}

// ─── PAID COMMAND PARSER (B8) ────────────────────────────────────────────────
// `PAID ROOM <n> <amount> [method]` — reception recording cash taken at the
// desk. Pure, like parseWalkinCommand, and strict for the same live-data reason:
// rooms are numbered 1–12, so the ROOM keyword is what separates the room from
// the amount. `PAID 2 500` has two readings and is refused rather than guessed.
//
// Return shapes match the walk-in parser exactly, and the null / {ok:false}
// split carries the same meaning: `null` is "not a PAID attempt" and falls
// through to the ordinary guest flow, so an unauthorised sender learns nothing.
//
// Stage 1 (payment reconciliation): `COLLECTED` is accepted as an alias for
// the identical keyword, not a second command. Deliberately just widening
// the keyword regex rather than adding a parallel parser/dispatch/handler —
// COLLECTED and PAID produce byte-identical `{ok, roomToken, amount, method}`
// shapes and flow through senderIsAuthorizedPaid -> paidBooking exactly the
// same way, so the mismatch-refusal rule, idempotency guard, and every write
// (Amount Paid, Payment Status) cannot diverge between the two spellings by
// construction — there is only one code path to diverge from.
const PAID_KEYWORD = /^(?:paid|collected)\b/i;
// `R500`, `500`, `500.00` and `500,00` all parse. The optional trailing method
// is NOT in the locked grammar — see the PR — but a reception that types CASH
// should not be refused for being more specific than required.
const PAID_BODY = /^room\s*([a-z0-9]{1,4})\s+r?\s*(\d+(?:[.,]\d{1,2})?)\s*(cash|eft|card)?\.?$/i;
// Payment build (CEO decision, 2026-09-29): a pre-check-in EFT/card
// confirmation is still Enquiry/Confirmed, not the Checked Out/Checked In
// PAID ROOM already targets — using ROOM here would need PAID ROOM's own
// matching rule widened to a different, overlapping status set, which risks
// two payments (a pre-check-in one and a post-stay one) colliding on the
// same room/date. PAID REF <ref> is a second, separate grammar, matched by
// the booking's own {Payment Reference} instead. PROPOSED SYNTAX, not yet
// confirmed with Shawn — flagged in the PR report, same as PR D's
// command-syntax asks, since staff need to memorise this alongside PAID ROOM.
const PAID_REF_BODY = /^ref\s*([a-z0-9]{4})\s+r?\s*(\d+(?:[.,]\d{1,2})?)\s*(cash|eft|card)?\.?$/i;
const PAID_METHODS = { cash: 'Cash', eft: 'EFT', card: 'Card' };

// WABISTAY_PAID_BY_BOOKING_REF (1 or true; off by default): PAID REF also accepts the
// booking reference the guest was given ("WS-KEGGQF"), not only the 4-character
// payment reference. This is what lets reception record a payment before check-in for
// a booking that has no payment reference at all (card: only the EFT choice generates
// one) — PAID ROOM cannot, it only matches Checked In / Checked Out bookings.
// Same amount rule as every other PAID form: it must equal Amount Due exactly.
const PAID_BOOKING_REF_BODY = /^ref\s*ws-?([a-z0-9]{6})\s+r?\s*(\d+(?:[.,]\d{1,2})?)\s*(cash|eft|card)?\.?$/i;
// WABISTAY_PAID_ROOM_CONFIRMED (1 or true; off by default): PAID ROOM n amount also matches a
// CONFIRMED booking that holds that room, so reception can settle a booking at the desk before
// it has checked in (card and EFT bookings alike) with the one command they already know.
// Which booking a room number means is a RULE, because a room can carry several bookings at once
// (an old settled stay, the guest in the room, tomorrow's arrival):
//   1. Candidates: Checked Out, Checked In and Confirmed bookings on that room.
//   2. UNPAID beats paid. A settled stay must never shadow an unsettled one (without this, last
//      night's paid booking made PAID ROOM answer "already recorded" for tonight's guest). If
//      nothing is unpaid, the same order below picks the one to report as already recorded.
//   3. Order, unchanged for what existed before: Checked Out (latest check-out first), then
//      Checked In, then Confirmed.
//   4. Among Confirmed bookings, the NEAREST ARRIVAL wins ... unless another unpaid Confirmed
//      booking on the room arrives on the same SAST day, which is ambiguous: nothing is recorded
//      and reception is asked for the booking reference. (The amount must still equal that
//      booking's Amount Due, which catches most wrong guesses on its own.)
function paidRoomConfirmedEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_PAID_ROOM_CONFIRMED || '').trim());
}
function pickBookingForPaidRoom(bookings, nowMs = Date.now()) {
  if (bookings.length === 0) return { booking: null };
  const unpaid = bookings.filter(b => b.fields['Payment Status'] !== 'Paid');
  const pool = unpaid.length > 0 ? unpaid : bookings;
  const closedOrOpen = pool
    .filter(b => b.fields['Status'] === 'Checked Out' || b.fields['Status'] === 'Checked In')
    .sort((a, b) => {
      const rank = s => (s === 'Checked Out' ? 0 : 1);
      const byStatus = rank(a.fields['Status']) - rank(b.fields['Status']);
      if (byStatus !== 0) return byStatus;
      return Date.parse(b.fields['Check Out'] || 0) - Date.parse(a.fields['Check Out'] || 0);
    });
  if (closedOrOpen.length > 0) return { booking: closedOrOpen[0] };
  const confirmed = pool
    .filter(b => b.fields['Status'] === 'Confirmed')
    .sort((a, b) => {
      const dist = x => { const t = Date.parse(x.fields['Check In']); return Number.isFinite(t) ? Math.abs(t - nowMs) : Infinity; };
      return dist(a) - dist(b);
    });
  if (confirmed.length === 0) return { booking: null };
  if (unpaid.length > 0 && confirmed.length > 1) {
    const dayOf = b => { const t = Date.parse(b.fields['Check In']); return Number.isFinite(t) ? JSON.stringify(sastCalendarDate(new Date(t))) : 'unknown'; };
    if (confirmed.slice(1).some(b => dayOf(b) === dayOf(confirmed[0]))) return { booking: null, ambiguous: true };
  }
  return { booking: confirmed[0] };
}

function paidByBookingRefEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_PAID_BY_BOOKING_REF || '').trim());
}
// Excludes O, 0, I, 1, L (payment build spec, CEO 2026-09-29) — visually
// confusable characters a guest reading the reference off a phone screen,
// or reception typing it back, could misread.
const PAYMENT_REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function parsePaidCommand(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!PAID_KEYWORD.test(t)) return null;

  const body = t.replace(PAID_KEYWORD, '').trim();

  if (paidByBookingRefEnabled()) {
    const bookingRefMatch = body.match(PAID_BOOKING_REF_BODY);
    if (bookingRefMatch) {
      const amount = Number(String(bookingRefMatch[2]).replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'bad_amount' };
      const method = bookingRefMatch[3] ? PAID_METHODS[bookingRefMatch[3].toLowerCase()] : null;
      // Normalised to the stored form, "WS-" + six uppercase characters.
      return { ok: true, refToken: 'WS-' + bookingRefMatch[1].toUpperCase(), refKind: 'booking', amount, method };
    }
  }

  const refMatch = body.match(PAID_REF_BODY);
  if (refMatch) {
    const amount = Number(String(refMatch[2]).replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'bad_amount' };
    const method = refMatch[3] ? PAID_METHODS[refMatch[3].toLowerCase()] : null;
    // Accepted case-insensitively on input, normalised to uppercase before
    // comparing (payment build spec) — the reference itself is generated
    // uppercase-only, so this is the one normalisation point.
    return { ok: true, refToken: refMatch[1].toUpperCase(), amount, method };
  }

  const m = body.match(PAID_BODY);
  if (!m) return { ok: false, reason: 'bad_syntax' };

  // Comma as decimal separator is normal SA usage ("R500,00").
  const amount = Number(String(m[2]).replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'bad_amount' };

  const method = m[3] ? PAID_METHODS[m[3].toLowerCase()] : null;
  return { ok: true, roomToken: m[1], amount, method };
}

// 4 characters from PAYMENT_REFERENCE_ALPHABET, unique among pre-check-in
// bookings' {Payment Reference} at creation (payment build spec) — Enquiry
// and Confirmed, the same two statuses PAID REF matches against. Once a
// booking leaves that scope (Checked In or later) the reference has already
// done its job and a later booking is free to reuse the code — an unbounded
// uniqueness scope would eventually exhaust a 32^4 (~1M) space for no reason
// this business needs.
async function generateUniquePaymentReference() {
  // Same pre-check-in scope PAID REF matches against — see paidBooking's
  // comment on why both statuses are live candidates.
  const existing = await airtableGet('WS_Bookings', orFormula('Status', ['Enquiry', 'Confirmed']));
  const taken = new Set(existing.map(b => b.fields['Payment Reference']).filter(Boolean).map(r => String(r).toUpperCase()));
  for (let attempt = 0; attempt < 50; attempt++) {
    let ref = '';
    for (let i = 0; i < 4; i++) {
      ref += PAYMENT_REFERENCE_ALPHABET[Math.floor(Math.random() * PAYMENT_REFERENCE_ALPHABET.length)];
    }
    if (!taken.has(ref)) return ref;
  }
  // Astronomically unlikely at this business's volume (a few guests/day
  // against a ~1M-code space) — fail loud rather than silently hand out a
  // colliding reference if it ever somehow happens.
  logToAxiom('error', 'payment_reference_generation_exhausted', { existingCount: existing.length });
  throw new Error('generateUniquePaymentReference: could not find a unique reference after 50 attempts');
}

// PR D (CEO decision, 2026-09-29): `CHECKOUT ROOM <n>` — a staff command to
// close out a walk-in (in particular one with no phone, or one reception
// needs to end immediately) rather than relying on the guest's own phone or
// the auto-checkout cron. Deliberately kept separate from PAID (CEO
// decision): checkout frees the room only, no amount required — a walk-in
// may already have been paid via PAID at check-in, or gets paid after via
// PAID/PAID REF, and forcing an amount into checkout would wrongly assume
// money always changes hands at that exact moment. Same ROOM <n> shape as
// WALKIN/PAID, deliberately, so reception has one pattern to remember, not three.
const CHECKOUT_KEYWORD = /^checkout\b/i;
const CHECKOUT_BODY = /^room\s*([a-z0-9]{1,4})\.?$/i;

function parseCheckoutCommand(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!CHECKOUT_KEYWORD.test(t)) return null;

  const body = t.replace(CHECKOUT_KEYWORD, '').trim();
  const m = body.match(CHECKOUT_BODY);
  if (!m) return { ok: false, reason: 'bad_syntax' };

  return { ok: true, roomToken: m[1] };
}

// ─── CLEANING TIME (START / DONE) ────────────────────────────────────────────
// Two metrics, both emitted at the DONE event:
//
//   · Vacant-To-Ready = completion − `WS_Rooms.Cleaning Started At`. The
//     industry turnaround number: checkout → room sellable again. The baseline
//     already existed (written at checkout by both checkout paths) and would
//     have gone dead the moment per-job fields arrived; this is what keeps it
//     load-bearing.
//   · Job Duration    = completion − `Cleaning Job Started At`. Actual working
//     speed once a cleaner engages. Secondary, and only available when the
//     cleaner sent START.
//
// The timestamps live on WS_BOOKINGS, not WS_Rooms (CEO): a room holds exactly
// one slot and the next checkout overwrites it, so per-cleaner averages over
// many jobs need a per-job home that survives.
//
// HONEST LIMIT, and it belongs next to the code rather than only in the PR:
// DONE is self-reported and unverified. Nothing confirms a room was actually
// cleaned, and dispatch is a broadcast to every active cleaner on the property,
// so whoever replies first is credited. These numbers therefore measure reply
// speed at least as much as cleaning speed.
const CLEANING_JOB_STARTED_FIELD = 'Cleaning Job Started At';
const CLEANING_COMPLETED_FIELD = 'Cleaning Completed At';
const CLEANED_BY_FIELD = 'Cleaned By';

// A baseline this old is almost certainly a room that sat dirty for days rather
// than a real turnaround. It is still emitted — the CEO is clearing the known
// stale rooms by hand before go-live — but flagged so the first averages can be
// filtered rather than quietly skewed.
const CLEANING_SUSPECT_MS = 24 * 60 * 60 * 1000;

// `START ROOM <n>` — one-shot, no session state (CEO). Same strict grammar as
// WALKIN/PAID: the ROOM keyword is mandatory because rooms are numbered 1–12.
const START_CLEANING_KEYWORD = /^start\b/i;
const START_CLEANING_BODY = /^room\s*([a-z0-9]{1,4})\.?$/i;

function parseStartCleaningCommand(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!START_CLEANING_KEYWORD.test(t)) return null;

  const body = t.replace(START_CLEANING_KEYWORD, '').trim();
  // A bare `START` is B14's opt-back-in keyword and must stay that way — only
  // `START ROOM <n>` is a cleaning command, so anything else returns null and
  // falls through to the existing handling rather than being claimed here.
  if (!body) return null;

  const m = body.match(START_CLEANING_BODY);
  if (!m) return { ok: false, reason: 'bad_syntax' };
  return { ok: true, roomToken: m[1] };
}

// The booking whose checkout dirtied this room: its most recent closed stay.
// Same resolution shape as PAID's, and for the same reason — the room's current
// clean belongs to the stay that just ended, not to whoever is in it next.
async function bookingForCleaningJob(roomId) {
  const closed = await airtableGet('WS_Bookings', `{Status} = 'Checked Out'`);
  const candidates = closed
    .filter(b => (b.fields['Room'] || []).includes(roomId))
    .sort((a, b) => Date.parse(b.fields['Check Out'] || 0) - Date.parse(a.fields['Check Out'] || 0));
  return candidates[0] || null;
}

// Both durations, computed at the completion event. Returns nulls rather than
// guesses: a missing or impossible baseline produces NO number, because a wrong
// turnaround figure is worse than an absent one (locked).
function cleaningDurations(room, booking, completedAtIso) {
  const completedMs = Date.parse(completedAtIso);
  const out = { vacantToReadyMs: null, jobDurationMs: null, baselineSuspect: false };

  const vacantFrom = room && room.fields['Cleaning Started At'];
  const vacantMs = vacantFrom ? Date.parse(vacantFrom) : NaN;
  // A baseline in the FUTURE relative to completion is a stale value from an
  // earlier cycle or a clock problem — either way it cannot describe this job.
  if (Number.isFinite(vacantMs) && vacantMs <= completedMs) {
    out.vacantToReadyMs = completedMs - vacantMs;
    out.baselineSuspect = out.vacantToReadyMs > CLEANING_SUSPECT_MS;
  }

  const jobFrom = booking && booking.fields[CLEANING_JOB_STARTED_FIELD];
  const jobMs = jobFrom ? Date.parse(jobFrom) : NaN;
  if (Number.isFinite(jobMs) && jobMs <= completedMs) {
    out.jobDurationMs = completedMs - jobMs;
  }
  return out;
}

// ─── WALK-IN AUTHORISATION (B7) ──────────────────────────────────────────────
// Authority is a SEAT, not a hardcoded number: `WS_Roles.Current Phone` where
// the seat is Active. Multiple numbers per property is the normal case (two
// reception handsets, owner plus manager), which is exactly what a global
// OWNER_PHONE-style variable cannot express. This is B18's schema, built as a
// strict subset — B18 adds WS_People and the Notify toggles on top without
// changing what this reads.
//
// Cleaners are deliberately NOT authorised: a cleaner seat exists to receive
// dispatch, not to sell rooms.
const WALKIN_ROLE_TYPES = ['Owner', 'Manager', 'Reception'];

// Matched in JS rather than filterByFormula, for two reasons confirmed against
// the live table: `Current Phone` is free text, so the same number can be stored
// as 0821234567 or 27821234567 and only formatPhone can tell they are the same;
// and the table currently contains blank rows, which a formula match would have
// to special-case anyway.
async function activeWalkinRoleForPhone(phone) {
  const roles = await airtableGet('WS_Roles', `{Active} = TRUE()`);
  return roles.find(r => {
    if (!WALKIN_ROLE_TYPES.includes(r.fields['Role Type'])) return false;
    const raw = r.fields['Current Phone'];
    if (!raw) return false;
    return formatPhone(String(raw)) === phone;
  }) || null;
}

// Unfiltered sibling, used ONLY by senderIsAuthorizedWalkin's logging — deliberately
// NOT a replacement for activeWalkinRoleForPhone, which stays untouched because it
// also gates the STOP staff-check and the POPIA staff-check (rule 26: no refactor
// while adding a feature; those two call sites are out of scope for this fix).
// Fetches by role type + phone WITHOUT the {Active}=TRUE() filter, so a
// deactivated seat is still found — the caller decides what "found but inactive"
// means, rather than the query silently discarding the distinction.
async function walkinRoleRecordForPhone(phone) {
  const roles = await airtableGet('WS_Roles', orFormula('Role Type', WALKIN_ROLE_TYPES));
  return roles.find(r => {
    const raw = r.fields['Current Phone'];
    if (!raw) return false;
    return formatPhone(String(raw)) === phone;
  }) || null;
}

// ─── PAYMENT SEAT LOOKUPS (B8) ───────────────────────────────────────────────
// PAID is Reception-only, per the locked spec's refusal rule ("non-Reception
// seat ... falls through silently") — narrower than WALKIN, which also accepts
// Owner and Manager. Flagged in the PR: if the owner should be able to record a
// payment, this constant is the single place that changes.
const PAID_ROLE_TYPES = ['Reception'];

// Payment build (CEO decision, 2026-09-29): On Duty (Jill) can also confirm a
// PAID (card/EFT) command, as a fallback to Reception, since payment now
// happens at reception per the finalised design but Jill may be the one
// physically present. Deliberately a SEPARATE constant from PAID_ROLE_TYPES,
// not an addition to it: PAID_ROLE_TYPES also gates
// activeReceptionRolesForProperty below, which drives who receives the
// "here's what's owed at checkout" push — that notify list is about who
// collects money at the desk, unrelated to Jill's on-duty/escalation role,
// and widening it silently would put Jill on a cash-reconciliation
// notification nobody asked to add him to.
const PAID_COMMAND_ROLE_TYPES = ['Reception', 'On Duty'];

// Deliberately a sibling of activeWalkinRoleForPhone rather than a
// generalisation of it: rule 26 — no refactor while adding a feature. The two
// converge when B18 lands and owns seat resolution properly.
async function activePaidRoleForPhone(phone) {
  const roles = await airtableGet('WS_Roles', `{Active} = TRUE()`);
  return roles.find(r => {
    if (!PAID_COMMAND_ROLE_TYPES.includes(r.fields['Role Type'])) return false;
    const raw = r.fields['Current Phone'];
    if (!raw) return false;
    return formatPhone(String(raw)) === phone;
  }) || null;
}

// The recipients of the checkout push. Scoped by property record id and filtered
// in JS, for the same reason activeCleanersForProperty is: filterByFormula
// matches linked-record fields on their display value, which is not id-safe.
async function activeReceptionRolesForProperty(propertyId) {
  if (!propertyId) return [];
  const roles = await airtableGet('WS_Roles', `{Active} = TRUE()`);
  return roles.filter(r =>
    PAID_ROLE_TYPES.includes(r.fields['Role Type']) &&
    (r.fields['Property'] || []).includes(propertyId) &&
    r.fields['Current Phone']
  );
}

// ─── ESCALATION CONTACTS (shift-routing/escalation PR 2 of 11) ──────────────
// Resolver only — nothing in this PR wires a notification flow to it (that's
// PR 5/6 onward). Given a property, resolves the ordered on-duty → backup →
// manager → owner escalation chain, skipping any tier with no active seat.
//
// CORRECTED PRECEDENT (see investigation report Correction #2): the original
// design cited `WS_Owner_Notify` as precedent — that table does not exist on
// main, it was unmerged WIP. The REAL, live precedent is `WS_Roles`, already
// used by the Reception/PAID feature (PAID_ROLE_TYPES, above) and the WALKIN
// feature (WALKIN_ROLE_TYPES, also above) — both confirmed real and shipped.
//
// CEO DECISION (2026-09-14), two halves, do not "helpfully" unify them later:
//   1. On Duty / Backup / Manager tiers reuse `WS_Roles` directly.
//      'On Duty' and 'Backup' are NEW Role Type values this PR introduces.
//      'Manager' is NOT new — it reuses the exact same Role Type WALKIN_ROLE_TYPES
//      already uses. Deliberate: a property's manager is one seat, one phone,
//      one physical person, whether they're authorising a walk-in sale or being
//      escalated to for a missed ack. Accepted coupling risk: changing a
//      property's walk-in-authorized manager seat also changes its escalation
//      manager. If that ever needs to diverge, it needs a NEW Role Type value
//      at that point — do not silently split it now on spec.
//   2. Owner tier is DELIBERATELY NOT a WS_Roles lookup, even though 'Owner' is
//      already a live WALKIN_ROLE_TYPES value sitting right there. Owner
//      contact has exactly one source of truth everywhere else in this
//      codebase: `WS_Properties.'Notify Phone'`, falling back to `OWNER_PHONE`.
//      Adding a second, WS_Roles-sourced owner phone — even a correct one —
//      recreates the exact "plausible second data source" failure shape this
//      investigation already hit twice (the fake WS_Owner_Notify and the
//      unmerged gate-ack branch). One property, one phone per role, single
//      mechanism per role, no exception for Owner just because WS_Roles
//      happens to have a matching value. If a future session is tempted to
//      route Owner through WS_Roles too "for consistency" — don't. This
//      comment is the record of why not.
//
// Seam this reuse creates, called out per CEO instruction: the filter below
// MUST use ESCALATION_TIER_ROLE_TYPES explicitly and must never widen to "any
// active WS_Roles row for this property" — that would silently pull in
// 'Reception' rows meant for the payment feature.
const ESCALATION_TIER_ROLE_TYPES = ['On Duty', 'Backup', 'Manager'];

// Scoped + filtered in JS, same reasoning as activeReceptionRolesForProperty
// immediately above (filterByFormula on a linked field matches display value,
// not id — not safe here either).
async function activeEscalationRolesForProperty(propertyId) {
  if (!propertyId) return [];
  const roles = await airtableGet('WS_Roles', `{Active} = TRUE()`);
  return roles.filter(r =>
    ESCALATION_TIER_ROLE_TYPES.includes(r.fields['Role Type']) &&
    (r.fields['Property'] || []).includes(propertyId) &&
    r.fields['Current Phone']
  );
}

// Walks ESCALATION_TIER_ROLE_TYPES in order, skipping any tier with no active
// seat — "the resolver must skip missing tiers gracefully rather than assume
// fixed depth" (investigation doc, Decisions Already Locked In). A property
// with no Backup configured simply has no 'Backup' entry in the returned
// chain; it is not a null placeholder or a thrown error.
//
// Owner is always appended last and is the one tier NOT sourced from
// `roles` — see the header comment above for why this must stay that way.
// Owner is effectively never "missing": `OWNER_PHONE` is the existing
// last-resort fallback used everywhere else Notify Phone might be unset, so
// this mirrors that same fallback chain rather than inventing a new one.
//
// Returns raw, unformatted phone strings (same convention as
// activeReceptionRolesForProperty/activeCleanersForProperty — formatPhone()
// is applied by the caller at the actual send site, not here) since this PR
// deliberately does not wire any send.
async function resolveEscalationChain(propertyId, property) {
  const roles = await activeEscalationRolesForProperty(propertyId);
  const chain = [];

  for (const tier of ESCALATION_TIER_ROLE_TYPES) {
    const seat = roles.find(r => r.fields['Role Type'] === tier);
    if (seat) {
      chain.push({ tier, phone: String(seat.fields['Current Phone']), roleId: seat.id });
    }
  }

  const notifyPhone = property && property.fields && property.fields['Notify Phone'];
  const ownerPhone = notifyPhone || OWNER_PHONE || null;
  if (ownerPhone) {
    chain.push({ tier: 'Owner', phone: String(ownerPhone), roleId: null });
  }

  return chain;
}

// Guest-struggle/monitoring build, sub-PR 2 of 4 (CEO 2026-09-29): the send
// capability resolveEscalationChain was always missing. Sends to the FIRST
// tier in the resolved chain only — no fallback to the next tier on a send
// failure. An inactive seat never enters the chain in the first place
// (resolveEscalationChain already filters on {Active} = TRUE()), so "falls
// to Backup when Jill is inactive" is the resolver's own behaviour, not
// retry logic here. Non-fatal on failure: checked and logged loud, never
// throws, matching every other staff/courtesy notify in this file.
//
// Prefers the approved guest-escalation template once configured (staff
// only ever receive from the bot, never message it first, so assuming
// they're inside Meta's 24h window is false far more often than true);
// unset IS the stub state (see guestEscalationTemplate above), falling back
// to free-form text so this is inert (not worse) with no template
// configured — never a regression, just not yet window-safe.
//
// `alert.message` is the free-form fallback body; `alert.guestPhone`,
// `alert.step`, `alert.lastInput` feed the template's placeholders once one
// is configured. No trigger wires to this yet (deliberately — CEO
// instruction). Called directly by tests until later PRs add the
// guest-stuck/HELP triggers.
async function sendEscalationAlert(propertyId, property, alert) {
  const chain = await resolveEscalationChain(propertyId, property);
  if (chain.length === 0) {
    logToAxiom('error', 'escalation_alert_no_recipient', { propertyId });
    return { ok: false, tier: null };
  }
  const { tier, roleId, phone } = chain[0];
  const to = formatPhone(phone);

  const templateName = guestEscalationTemplate();
  let result;
  if (templateName) {
    result = await sendWhatsAppTemplate(
      to, templateName,
      [
        alert.guestPhone || 'unknown',
        (property && property.fields && property.fields['Property Name']) || 'N/A',
        alert.step || 'unknown',
        alert.lastInput || 'N/A',
        new Date().toISOString()
      ],
      { site: 'escalation_alert', propertyId, tier }
    ).catch(e => {
      console.error('[sendEscalationAlert template failed]', e.message);
      return { error: { message: e.message } };
    });
  } else {
    logToAxiom('warn', 'escalation_alert_template_not_configured', {
      propertyId, tier, reason: 'WABISTAY_GUEST_ESCALATION_TEMPLATE not configured — falling back to free-form, 24h-window-limited send'
    });
    result = await sendWhatsApp(to, alert.message).catch(e => {
      console.error('[sendEscalationAlert failed]', e.message);
      return { error: { message: e.message } };
    });
  }

  if (result && result.error) {
    logToAxiom('error', 'escalation_alert_send_failed', {
      propertyId, tier, roleId: roleId || null, error: JSON.stringify(result.error)
    });
    return { ok: false, tier };
  }
  logToAxiom('info', 'escalation_alert_sent', { propertyId, tier, roleId: roleId || null });
  return { ok: true, tier };
}

// Exact match only — never `roomMatchesText`, whose \b<number>\b test would
// match a room on the DURATION digit of the same command. `Room 01` is the live
// name shape and `Room Number` is 1, so both routes have to be tried; a token
// that is not a number can still name a room (`Room A`).
function roomMatchesWalkinToken(room, token) {
  const t = String(token || '').trim().toLowerCase();
  if (!t) return false;
  const name = String(room.fields['Room Name'] || '').trim().toLowerCase();
  if (name && (name === t || name === `room ${t}`)) return true;
  const number = room.fields['Room Number'];
  if (number === undefined || number === null) return false;
  return /^\d+$/.test(t) && Number(t) === Number(number);
}

// ─── AVAILABILITY (B8) ───────────────────────────────────────────────────────
// Rooms are held at enquiry, not at arrival: without a Room link on the booking
// there is nothing for an overlap check to compare against, and two guests
// asking for the same dates would both be accepted. The hold is also what ties a
// booking to a property — WS_Bookings has no Property field of its own.
//
// Two different axes, deliberately not conflated:
//   · Check In/Check Out — a future range. This is what decides availability.
//   · WS_Rooms.Status    — a fact about right now. Only a serviceability gate.
// A room occupied tonight is still sellable for next month, and same-day
// turnover means offering a room that is mid-clean — so Status cannot filter on
// the booking axis. Maintenance is the one status that means "not sellable at
// all", and it is excluded via an allowlist rather than a `!= Maintenance`
// denylist so that any status added to Airtable later is unsellable until
// someone deliberately allows it (fail closed, as resolveProperty does).

const BLOCKING_BOOKING_STATUSES = ['Enquiry', 'Confirmed', 'Checked In'];
const BOOKABLE_ROOM_STATUSES = ['Available', 'Occupied', 'Cleaning'];

function orFormula(field, values) {
  return `OR(${values.map(v => `{${field}} = '${v}'`).join(', ')})`;
}

// Guest-visible "right now" availability: rooms with Status = Available for
// this property, gated by Active (CEO decision, 2026-09-28) so a disabled
// room is never counted, offered, or picked as guest-facing inventory. This
// is a narrower snapshot than findAvailableRoom's BOOKABLE_ROOM_STATUSES +
// date-range check below — it answers "what can we show/hand out right now",
// not "what's free for these dates" — so it is NOT a replacement for that
// function. Shared by the greeting's room count and the legacy no-date-range
// gate-arrival fallback so the two can't drift apart again.
async function getGuestVisibleAvailableRooms(propertyId) {
  const allAvailableRooms = await airtableGet('WS_Rooms', `{Status} = 'Available'`);
  return allAvailableRooms.filter(r => (r.fields['Property'] || []).includes(propertyId) && r.fields['Active'] === true);
}

// Exclusive bounds, strict inequalities — the locked definition. A room checked
// out of at 10:00 IS available for a 14:00 check-in the same day; inclusive
// bounds would silently cost every room a sellable night on every turnover.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(aEnd) > Date.parse(bStart);
}

// A booking only blocks if it has both dates. Pre-B7 records (and any Walk-in
// row created by hand without dates) have nothing to compare, so they take no
// part — per the locked migration decision.
function bookingBlocksRange(booking, checkInIso, checkOutIso) {
  const bookedIn = booking.fields['Check In'];
  const bookedOut = booking.fields['Check Out'];
  if (!bookedIn || !bookedOut) return false;
  return rangesOverlap(checkInIso, checkOutIso, bookedIn, bookedOut);
}

// Room selection order (Doc 1b PR 4, 01 Oct 2026). Until now the room offered was
// simply the first free row Airtable listed, which is why 04 and 05 won every
// booking. With WABISTAY_ROOM_ORDER on, free rooms are ranked by what is true
// of the room right now — Available, then Cleaning, then Occupied — and ties
// go to the lowest room number, so a guest is not handed a room still being
// cleaned while clean ones are free. Off (unset) keeps Airtable's order.
function roomOrderEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_ROOM_ORDER || '').trim());
}

const ROOM_STATUS_RANK = { Available: 0, Cleaning: 1, Occupied: 2 };

// Numeric room number: the 'Room Number' field when it holds one, otherwise the
// first run of digits in 'Room Name' ("Room 04" -> 4). A room with neither
// sorts after every numbered room and then by name, so ordering is total.
function roomNumberOf(room) {
  const raw = room.fields['Room Number'];
  if (raw !== undefined && raw !== null && raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  const m = String(room.fields['Room Name'] || '').match(/\d+/);
  return m ? Number(m[0]) : Infinity;
}

function orderFreeRooms(rooms) {
  return [...rooms].sort((a, b) => {
    const rank = r => (r.fields['Status'] in ROOM_STATUS_RANK ? ROOM_STATUS_RANK[r.fields['Status']] : 3);
    const byStatus = rank(a) - rank(b);
    if (byStatus !== 0) return byStatus;
    const byNumber = roomNumberOf(a) - roomNumberOf(b);
    if (byNumber !== 0 && !Number.isNaN(byNumber)) return byNumber;
    return String(a.fields['Room Name'] || '').localeCompare(String(b.fields['Room Name'] || ''));
  });
}

// Returns the room record to use for this range, or null if the property is full.
// `preferRoomId` re-verifies an existing hold: it returns that room when it is
// still free, and silently re-offers a different one when it is not.
// `excludeBookingId` is essential for that re-verify — a booking overlaps its
// own range by definition, so without it a booking would always report its own
// held room as taken.
async function findAvailableRoom(propertyId, checkInIso, checkOutIso, opts = {}) {
  const { excludeBookingId = null, preferRoomId = null } = opts;

  // F5-style JS-side filter — FIND/ARRAYJOIN on linked records is unreliable.
  //
  // Active gate (CEO decision, 2026-09-28): a room with Active !== true is
  // invisible here, never "shown as unavailable" — it simply never enters
  // `rooms` at all, so it can't be offered, held, or reassigned by anything
  // downstream of this function. Deliberately an ALLOWLIST (=== true, not
  // !== false): Airtable's API omits an unchecked checkbox field entirely
  // rather than sending `false` (confirmed against Airtable's own docs), so
  // "field absent" and "explicitly unchecked" are indistinguishable on the
  // wire — only `=== true` can tell a deliberately-enabled room from
  // everything else, matching the existing fail-closed posture this function
  // already uses for Maintenance (comment above BOOKABLE_ROOM_STATUSES).
  const allRooms = await airtableGet('WS_Rooms', orFormula('Status', BOOKABLE_ROOM_STATUSES));
  const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(propertyId) && r.fields['Active'] === true);
  if (rooms.length === 0) return null;

  // Only statuses that actually block: a Cancelled or Checked Out booking must
  // not hold inventory. Bookings carry no Property field, so they are scoped to
  // this property by the room link itself — a booking on another property's room
  // can never mark one of these rooms taken.
  //
  // P1b: this is THE availability check — an empty result must mean "genuinely
  // nothing blocks this room", never "the read failed and we don't know". Before
  // this fix, airtableGet swallowed a failed page and returned whatever it had
  // (possibly []), which made a transient Airtable error indistinguishable from
  // a free room — a fail-OPEN path into exactly the double-booking this function
  // exists to prevent, independent of the P1a timing race. `throwOnError` makes
  // the failure loud instead of silent, and the catch below fails the whole
  // check CLOSED (room unavailable) rather than guessing the room is free.
  let blocking;
  try {
    blocking = await airtableGet('WS_Bookings', orFormula('Status', BLOCKING_BOOKING_STATUSES), { throwOnError: true });
  } catch (err) {
    logToAxiom('error', 'availability_check_failed_closed', {
      propertyId, checkInIso, checkOutIso, error: err.message,
      reason: 'blocking-bookings read failed — refusing rather than risking a double-booking'
    });
    return null;
  }
  const takenRoomIds = new Set();
  for (const booking of blocking) {
    if (excludeBookingId && booking.id === excludeBookingId) continue;
    if (!bookingBlocksRange(booking, checkInIso, checkOutIso)) continue;
    for (const roomId of booking.fields['Room'] || []) takenRoomIds.add(roomId);
  }

  let free = rooms.filter(r => !takenRoomIds.has(r.id));
  // preferRoomId (re-verifying a held room) still wins over any ordering: a
  // guest keeps the room they were given unless it is genuinely gone.
  if (preferRoomId) {
    const held = free.find(r => r.id === preferRoomId);
    if (held) return held;
  }
  if (roomOrderEnabled()) free = orderFreeRooms(free);
  return free[0] || null;
}

// ─── GUARDS ──────────────────────────────────────────────────────────────────

// Matches a cleaner's free-text reply against a room's identifying fields.
// Deliberately loose (exact name, exact number, name-as-substring, or number
// as a whole word) since this only ever runs after senderIsCleaner-equivalent
// confirms the sender is a registered cleaner -- never evaluated against guest
// messages, so a loose match here can't misfire on unrelated guest traffic.
function roomMatchesText(room, text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  const name = String(room.fields['Room Name'] || '').trim().toLowerCase();
  const number = room.fields['Room Number'];
  if (name && (t === name || t.includes(name))) return true;
  if (number !== undefined && number !== null) {
    return new RegExp(`\\b${number}\\b`).test(t);
  }
  return false;
}

// B11.5: does the sender's current guest-side state have a PENDING numbered
// expectation matching this exact reply? True when their Session State is a real
// (non-NEW) state with an explicit, non-"*" transition whose inputs include the
// text. A bare number ("2") is both a duration/menu choice AND a room number, so
// a phone that is both a registered cleaner and an active guest (Eric,
// 27825999279) would otherwise have "2" preempted by the cleaner-naming global
// and mark a room clean instead of driving their own booking. Read purely from
// states.json, so it stays correct as new numbered menus are added (occupancy,
// hourly duration) without touching this function.
function guestStateExpectsInput(guest, text) {
  if (!guest) return false;
  const state = guest.fields['Session State'];
  if (!state || state === 'NEW') return false;
  const rows = STATES.states[state];
  if (!rows) return false;
  return rows.some(t => t.inputs !== '*' && t.inputs.includes(text));
}

const guards = {
  // B7 (WALKIN). Registered FIRST in states.json's global list, ahead of the
  // cleaner-naming-room global: that guard matches \b<number>\b anywhere in the
  // message, so `WALKIN ROOM 2 2HRS` from a phone that is also a cleaner would
  // otherwise mark Room 02 clean instead of booking it. Same class of bug as
  // B11.5, and live data now guarantees the collision rather than merely
  // allowing it — the seeded Reception number (27825999279) is Eric's, already
  // both a registered cleaner and an active guest.
  //
  // Order of checks is load-bearing:
  //   1. Parse first. It is pure and free, and it returns null for everything
  //      that is not a WALKIN attempt — so ordinary guest traffic pays for no
  //      extra Airtable call, the same principle senderIsCleanerNamingRoom uses.
  //   2. Only then authorise. An unauthorised sender returns FALSE, not a
  //      refusal message: the message falls through to the ordinary guest flow
  //      and they see exactly what any stranger sees. Nothing anywhere confirms
  //      the command exists. This is the locked no-leak rule, and it is why
  //      there is no "unauthorised" reply to build.
  async senderIsAuthorizedWalkin(ctx) {
    const parsed = parseWalkinCommand(ctx.messageText);
    if (!parsed) return false;

    // Logging-granularity split, CEO decision: the no-leak guarantee to the
    // sender is unchanged either way (both cases return false with no reply,
    // identical fallthrough to the ordinary guest flow) — this only splits
    // WHAT gets logged, so Axiom can distinguish a stranger probing for the
    // command from a known staff seat whose Active box is off (revoked or
    // accidentally unticked), which the old single event name could not tell
    // apart.
    const record = await walkinRoleRecordForPhone(ctx.phone);
    if (!record) {
      logToAxiom('warn', 'walkin_unauthorised_stranger', { phone: ctx.phone });
      return false;
    }
    if (!record.fields['Active']) {
      logToAxiom('warn', 'walkin_unauthorised_deactivated', { phone: ctx.phone, roleId: record.id });
      return false;
    }
    const role = record;

    ctx.walkin = parsed;
    ctx.walkinRole = role;
    return true;
  },

  // B8 (PAID). Registered alongside the walk-in global and ahead of the
  // cleaner-naming-room guard for the same reason: `PAID ROOM 2 500` contains a
  // bare `2`, so if Room 02 is mid-clean that guard would match it and mark the
  // room Available instead of recording the money. Cheap pure parse first,
  // Airtable only for something that is actually a PAID command; an
  // unauthorised sender returns false and falls through to the guest flow.
  async senderIsAuthorizedPaid(ctx) {
    const parsed = parsePaidCommand(ctx.messageText);
    if (!parsed) return false;

    const role = await activePaidRoleForPhone(ctx.phone);
    if (!role) {
      logToAxiom('warn', 'paid_unauthorised_sender', { phone: ctx.phone });
      return false;
    }

    ctx.paid = parsed;
    ctx.paidRole = role;
    return true;
  },

  // PR D: `CHECKOUT ROOM <n>` — same role allowlist as PAID
  // (PAID_COMMAND_ROLE_TYPES: Reception + On Duty per the payment build's
  // fallback), reusing activePaidRoleForPhone rather than a third lookup
  // function for the same seat set.
  async senderIsAuthorizedCheckout(ctx) {
    const parsed = parseCheckoutCommand(ctx.messageText);
    if (!parsed) return false;

    const role = await activePaidRoleForPhone(ctx.phone);
    if (!role) {
      logToAxiom('warn', 'checkout_command_unauthorised_sender', { phone: ctx.phone });
      return false;
    }

    ctx.staffCheckout = parsed;
    ctx.staffCheckoutRole = role;
    return true;
  },

  // `START ROOM <n>` from a registered cleaner. Registered ahead of the
  // cleaner-naming-room global for the now-familiar reason: the command
  // contains a bare room number, and that guard matches \b<number>\b anywhere —
  // reached first it would mark the room CLEAN at the moment the cleaner is
  // telling us they have only just started it. Parse first (pure, free, and
  // returns null for a bare START so B14's opt-back-in keyword is untouched),
  // Airtable only for something that really is the command.
  async senderIsCleanerStartingRoom(ctx) {
    const parsed = parseStartCleaningCommand(ctx.messageText);
    if (!parsed) return false;

    const cleaners = await airtableGet('WS_Cleaners', `{Phone Number} = '${ctx.phone}'`);
    if (cleaners.length === 0) {
      logToAxiom('warn', 'cleaning_start_unauthorised_sender', { phone: ctx.phone });
      return false;
    }

    ctx.cleaner = cleaners[0];
    ctx.cleaningStart = parsed;
    return true;
  },

  // Doc 1b PR 2 (01 Oct 2026): `done` is a cleaner command, but one number can
  // be a cleaner AND a guest (Shawn's test phone is both). If no room is in
  // Cleaning, DONE has nothing to mean, so a sender who is mid-way through a
  // guest session (any Session State other than NEW / HUMAN_HANDLING) is left to
  // the guest flow instead of being told "nothing to clean". A cleaner with no
  // live guest session is still claimed, so they keep getting
  // cleanerNothingToClean rather than a guest greeting. When a room IS in
  // Cleaning the sender is always claimed, exactly as before.
  async senderIsCleaner(ctx) {
    const cleanerRecords = await airtableGet('WS_Cleaners', `{Phone Number} = '${ctx.phone}'`);
    ctx.cleaner = cleanerRecords[0] || null;
    if (cleanerRecords.length === 0) return false;

    const state = ctx.guest && ctx.guest.fields['Session State'];
    const midGuestSession = !!state && state !== 'NEW' && state !== 'HUMAN_HANDLING';
    if (midGuestSession) {
      const cleaning = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
      if (cleaning.length === 0) {
        logToAxiom('info', 'done_left_to_guest_flow', { phone: ctx.phone, sessionState: state });
        ctx.cleaner = null;
        return false;
      }
    }
    return true;
  },

  // Room-ambiguity fix: catches a cleaner's reply naming a specific room (any
  // time, not just right after "done") so cleanerDone never has to guess which
  // of several Cleaning rooms to resolve. Cheap check first (registered cleaner)
  // before the extra WS_Rooms lookup, so non-cleaner traffic only pays for one
  // Airtable call, same as it would if this guard didn't exist.
  async senderIsCleanerNamingRoom(ctx) {
    // B11.5 precedence: if the sender has a pending guest-side numbered
    // expectation for this exact reply, the guest state machine wins — this
    // global must not preempt it. Targeted addition only; the rest of the guard
    // (which behaves correctly for genuine cleaner room-naming) is unchanged.
    if (guestStateExpectsInput(ctx.guest, ctx.text)) return false;
    const cleanerRecords = await airtableGet('WS_Cleaners', `{Phone Number} = '${ctx.phone}'`);
    if (cleanerRecords.length === 0) return false;
    const cleaningRooms = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
    const match = cleaningRooms.find(r => roomMatchesText(r, ctx.text));
    if (!match) return false;
    ctx.cleaner = cleanerRecords[0];
    ctx.matchedCleaningRoom = match;
    return true;
  },

  // Universal escape hatch for the guest-side AWAITING_* limbo states
  // (AWAITING_STAY_TYPE / AWAITING_DETAILS / AWAITING_HOURLY_DETAILS /
  // AWAITING_HOURLY_DURATION / AWAITING_ETA — AWAITING_OCCUPANCY removed from
  // states.json, CEO decision 2026-09-28, but this guard's `startsWith`
  // check still catches any straggler still literally in that state in
  // Airtable). Found
  // via live testing: a guest in one of these states whose input never
  // satisfies that state's own free-text parser (wrong format, or a reply
  // meant for a different flow entirely) gets the same reprompt forever —
  // states.json gives each of them exactly one "*" row pointing at a parser
  // that only advances state on a successful parse, so a guest who can't
  // produce parseable input has no way out short of a manual Airtable edit.
  // No keyword anywhere in any of these states' own input arrays offers an
  // exit, and the abandonment sweep (runEnquiryAbandonment, ENQUIRY LOGGING
  // section below) only ever WROTE a report row, never reset the guest —
  // see the fix alongside it.
  //
  // Registered in the GLOBAL array (states.json), so this is evaluated for
  // EVERY inbound message before any per-state routing happens at all — the
  // exact "checked before the state's own parsing logic" requirement, for
  // free, from the existing global-then-per-state dispatch order. inputs is
  // an explicit ["cancel","menu","hi"] list (not "*"), matched by
  // handleMessage's own pre-filter before this guard even runs — the guard's
  // only job is to confirm the sender is actually IN one of these limbo
  // states, so a CONFIRMED/CHECKED_IN guest's "cancel"/"hi" (which already
  // mean something real there — an active booking, not a stuck draft) is
  // untouched and keeps going through its own state's row as before.
  //
  // Exact whole-message match only (ctx.text is already trim+lowercased by
  // handleMessage) — not a substring/\b test — specifically so a guest whose
  // real name or arrival note merely CONTAINS one of these words (unlikely
  // but flagged: a guest named "Candace" does not collide since "candace"
  // does not contain "cancel" as a substring; a guest typing an arrival note
  // that IS literally the word "cancel"/"menu"/"hi" and nothing else would,
  // but that reads as them wanting out anyway, same intent this exists for).
  async senderStuckInAwaitingState(ctx) {
    const state = ctx.guest && ctx.guest.fields['Session State'];
    return !!state && state.startsWith('AWAITING_');
  }
};

// Shared by cleanerDone (unambiguous case) and cleanerRoomReply (disambiguated
// case) -- same side effects either way: room -> Available, thank the cleaner,
// notify the owner.
// D3 (gap-and-failure audit, this session): cleanerDone/cleanerRoomReply both
// select from a top-level `{Status} = 'Cleaning'` fetch and pass that ALREADY-
// FETCHED room record in — the guard below was re-checking a value that could
// already be stale by the time it ran, with no re-query immediately before
// the write. Two different phone numbers sending DONE close enough together
// could both pass the guard before either write landed, and the second write
// silently overwrote the first cleaner's `Cleaned By`/`Cleaning Completed At`
// — no error, no log, nothing to notice. Confirmed by code inspection this
// session (the audit), fixed here (implementation, not investigation).
//
// Two-layer fix, both closing a DIFFERENT part of the window:
//
//   Layer 1 (below): re-query the room's Status immediately before doing
//   anything else, rather than trusting the caller's top-level fetch. This
//   closes the window between "cleanerDone ran its query" and "this function
//   started running" — the common case (a second DONE arriving seconds
//   later, not simultaneously).
//
//   Layer 2 (further down, around the booking write): even Layer 1 has a
//   window between its own re-query and this function's write — Airtable
//   exposes no conditional/optimistic-concurrency PATCH (no ETag/If-Match on
//   their REST API; confirmed absent from their API docs, not assumed), so a
//   compare-and-swap at the API level isn't available. Instead this mirrors
//   the exact pattern already proven in this file for the P1a booking race
//   (see booking-race.test.js / the collectDetails re-verify around line
//   2616): WRITE first, then immediately RE-READ the same record and compare
//   the stored value to what was just written. A mismatch means a concurrent
//   write landed in between and is now what Airtable actually holds — this
//   request's own PATCH call can return success while still having lost the
//   race, which a "did my write error" check alone would never catch.
async function resolveRoomClean(ctx, room) {
  // Layer 1: re-query, don't trust the caller's already-fetched value.
  const freshRoom = (await airtableGet('WS_Rooms', `RECORD_ID() = '${room.id}'`))[0] || room;

  if (freshRoom.fields['Status'] !== 'Cleaning') {
    // Distinguish "someone already completed this" (a race this fix cares
    // about) from "there was never anything to complete" (unrelated, existing
    // behaviour, untouched) — look up the most recent job for this room and
    // only use the more specific message when it actually explains what
    // happened. Never guess a name/time that isn't backed by a real record.
    const recentBooking = await bookingForCleaningJob(room.id);
    const completedByOther = recentBooking && recentBooking.fields[CLEANING_COMPLETED_FIELD];
    logToAxiom('warn', 'cleaning_complete_room_not_cleaning', {
      phone: ctx.phone, roomId: room.id, roomName: freshRoom.fields['Room Name'],
      status: freshRoom.fields['Status'] || null,
      reason: completedByOther ? 'lost_race_layer1' : 'nothing_to_clean'
    });
    if (completedByOther) {
      await sendWhatsApp(ctx.phone, msg('cleaningAlreadyCompleted', {
        roomName: freshRoom.fields['Room Name'],
        cleanedBy: recentBooking.fields[CLEANED_BY_FIELD] || 'someone else',
        completedAtText: formatSastDateTime(completedByOther)
      }));
    } else {
      await sendWhatsApp(ctx.phone, msg('cleanerNothingToClean'));
    }
    return;
  }
  // Everything below must use the re-queried record, not the (possibly
  // stale) one the caller passed in — reassigning the parameter itself so
  // every existing reference to `room` below this point picks it up, rather
  // than renaming every call site.
  room = freshRoom;

  const completedAt = new Date().toISOString();
  const booking = await bookingForCleaningJob(room.id);
  const durations = cleaningDurations(room, booking, completedAt);

  // Rule 30 step 2, slice 1: checked but non-fatal, same shape as walkinBooking's
  // room->Occupied write (F40) — Status is a derived display field, not
  // findAvailableRoom's source of truth (that's the WS_Bookings overlap check),
  // so a failure here fails safe (room stays Cleaning, unsellable) rather than
  // unsafe. Logged loud so the write failure is visible instead of inferred.
  // Non-fatal: job completion and metrics below are the cleaner's declaration
  // of fact, independent of whether the derived Status field caught up.
  const roomWrite = await airtableUpdate('WS_Rooms', room.id, { 'Status': 'Available' });
  if (roomWrite && roomWrite.error) {
    logToAxiom('error', 'cleaner_done_room_status_write_failed', {
      phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'],
      error: JSON.stringify(roomWrite.error)
    });
  }

  // Per-job record, on the booking so it survives the next checkout. Written
  // before the metric is logged so a failed write can never produce a number
  // with no record behind it. Proceeds regardless of the Status write above.
  if (booking) {
    const jobUpdate = { [CLEANING_COMPLETED_FIELD]: completedAt };
    // Attribution is to whoever declared DONE — the only identity the system
    // actually observes. If a different cleaner sent START, that divergence is
    // logged below rather than silently resolved in either direction.
    //
    // `Cleaned By` is a plain text field, not a link to WS_Cleaners (confirmed
    // live 6 Aug — a link was the original intent, but the field was created as
    // singleLineText). Writing the record-id array shape here would either be
    // rejected by Airtable or coerce into something unusable, so the cleaner's
    // NAME is written instead. This trades away click-through to the cleaner's
    // record and relational integrity if a cleaner is renamed — acceptable for
    // now since B18 is already going to migrate attribution wholesale to
    // WS_People, and a link built today would just be torn out then.
    if (ctx.cleaner) jobUpdate[CLEANED_BY_FIELD] = ctx.cleaner.fields['Cleaner Name'] || null;
    await airtableUpdate('WS_Bookings', booking.id, jobUpdate);

    // Layer 2 (see this function's header comment): write-then-verify, the
    // only race-closing check Airtable's API actually supports. Re-read the
    // SAME field we just wrote — if it no longer matches what THIS request
    // wrote, a concurrent DONE landed its own write in between, and that
    // write is what Airtable now holds, regardless of what our own PATCH
    // call returned. This is the only place a truly-simultaneous race (both
    // requests passing Layer 1 before either reached this point) gets caught.
    const verifyBooking = (await airtableGet('WS_Bookings', `RECORD_ID() = '${booking.id}'`))[0];
    const survivedRace = verifyBooking && verifyBooking.fields[CLEANING_COMPLETED_FIELD] === completedAt;
    if (!survivedRace) {
      logToAxiom('warn', 'cleaning_complete_lost_race_layer2', {
        phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'],
        bookingId: booking.id, ourCompletedAt: completedAt,
        actualCompletedAt: verifyBooking ? verifyBooking.fields[CLEANING_COMPLETED_FIELD] : null,
        reason: 'a concurrent DONE won the race between this write and the read that verifies it'
      });
      // The loser gets the SAME informative message as the Layer-1 case, built
      // from whatever actually survived — never our own now-overwritten values.
      await sendWhatsApp(ctx.phone, msg('cleaningAlreadyCompleted', {
        roomName: room.fields['Room Name'],
        cleanedBy: (verifyBooking && verifyBooking.fields[CLEANED_BY_FIELD]) || 'someone else',
        completedAtText: formatSastDateTime((verifyBooking && verifyBooking.fields[CLEANING_COMPLETED_FIELD]) || completedAt)
      }));
      // No success flow for the loser: no cleanerThanks, no ownerRoomCleaned,
      // no duplicate 'cleaning_job_completed' metric — the winner's request
      // already produced all of those (or will, on its own execution).
      return;
    }
  } else {
    logToAxiom('warn', 'cleaning_complete_no_booking', {
      phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'],
      reason: 'no Checked Out booking for this room — nothing to record the job against'
    });
  }

  const toMinutes = ms => (ms === null ? null : Number((ms / 60000).toFixed(1)));
  logToAxiom('info', 'cleaning_job_completed', {
    phone: ctx.phone,
    roomId: room.id, roomName: room.fields['Room Name'],
    bookingId: booking ? booking.id : null,
    bookingRef: (booking && booking.fields['Booking Ref']) || null,
    cleanerId: ctx.cleaner ? ctx.cleaner.id : null,
    cleanerName: (ctx.cleaner && ctx.cleaner.fields['Cleaner Name']) || null,
    completedAt,
    // Primary metric: checkout → sellable again.
    vacantToReadyMs: durations.vacantToReadyMs,
    vacantToReadyMinutes: toMinutes(durations.vacantToReadyMs),
    // Secondary: only present when the cleaner sent START ROOM <n>.
    jobDurationMs: durations.jobDurationMs,
    jobDurationMinutes: toMinutes(durations.jobDurationMs),
    // A missing/stale baseline emits NO turnaround rather than a wrong one.
    vacantToReadyOmitted: durations.vacantToReadyMs === null,
    baselineSuspect: durations.baselineSuspect,
    // Carried on every record so no downstream reader can mistake this for a
    // verified measurement: DONE is self-declared, and dispatch is a broadcast,
    // so this is reply speed as much as cleaning speed.
    selfReported: true
  });

  logToAxiom('info', 'state_transition', { phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'], from: 'Cleaning', to: 'Available', reason: 'cleaner_done' });
  await sendWhatsApp(ctx.phone, msg('cleanerThanks', { roomName: room.fields['Room Name'] }));
  const roomCleanedTo = operationalAlertPhone(ctx.property);
  if (roomCleanedTo) {
    logOwnerSendWindow('room_cleaned', roomCleanedTo, ctx.phone); // B17 instrumentation
    // Rule 30 step 2, slice 2: checked but non-fatal — pure courtesy
    // notification, nothing reads a "did the owner get told" flag; the
    // cleaner already got their own confirmation above regardless.
    const ownerSend = await sendWhatsApp(roomCleanedTo, msg('ownerRoomCleaned', { roomName: room.fields['Room Name'] }));
    if (ownerSend && ownerSend.error) {
      logToAxiom('error', 'owner_room_cleaned_notify_failed', {
        roomId: room.id, error: JSON.stringify(ownerSend.error)
      });
    }
  }
}

// ─── ACTION HANDLERS ─────────────────────────────────────────────────────────
// Each handler owns its side effects and write ORDER (frozen by fixtures).
// The Session State it writes comes from the transition's `next` in states.json.

const actions = {
  // B7 (WALKIN): staff-initiated booking, no guest thread. Reached only through
  // senderIsAuthorizedWalkin, so by the time this runs the sender IS authorised
  // and every reply below is safe to send — an outsider never gets here.
  //
  // Every reply goes to the SENDING STAFF NUMBER, which just messaged us and is
  // therefore inside Meta's 24-hour service window: free-form is correct here
  // and needs no template (CLAUDE.md line 30). Nothing is sent to the walk-in
  // guest, even when their number is supplied — that WOULD be business-initiated
  // to a third party, so it needs an approved template and is deliberately not
  // built here. Same reason there is no owner notification (F23's finding).
  async walkinBooking(ctx) {
    const parsed = ctx.walkin;
    const role = ctx.walkinRole;

    if (!parsed.ok) {
      if (parsed.reason === 'bad_duration') {
        logToAxiom('info', 'walkin_rejected', { phone: ctx.phone, reason: 'bad_duration', requestedHours: parsed.hours });
        await sendWhatsApp(ctx.phone, msg('walkinBadDuration', { hours: parsed.hours }));
        return;
      }
      if (parsed.reason === 'bad_dates') {
        logToAxiom('info', 'walkin_rejected', { phone: ctx.phone, reason: 'bad_dates' });
        await sendWhatsApp(ctx.phone, msg('walkinBadDates'));
        return;
      }
      logToAxiom('info', 'walkin_rejected', { phone: ctx.phone, reason: parsed.reason });
      await sendWhatsApp(ctx.phone, msg('walkinUsage'));
      return;
    }

    // The guest's name is required, and this is where "prompt for the name"
    // lands: a serverless handler has no memory between messages, and parking a
    // half-finished command would need a session store that does not exist for
    // staff numbers (WS_Guests.Session State has no walk-in states, and adding
    // them is a schema change — out of scope by instruction). So the command is
    // re-asked in full rather than continued. See the PR for the stateful
    // alternative.
    if (!parsed.guestName) {
      logToAxiom('info', 'walkin_rejected', { phone: ctx.phone, reason: 'missing_guest_name' });
      await sendWhatsApp(ctx.phone, msg('walkinNeedName'));
      return;
    }

    // Property comes from the SEAT, not from the inbound number: the role's
    // single Property link is the booking's property (locked). The link is
    // single at schema level, so [0] is the whole answer and there is no
    // disambiguation to build.
    const rolePropertyId = (role.fields['Property'] || [])[0] || null;
    if (!rolePropertyId) {
      logToAxiom('error', 'walkin_role_without_property', { phone: ctx.phone, roleId: role.id });
      await sendWhatsApp(ctx.phone, msg('walkinNotConfigured'));
      return;
    }

    // Fail closed on a cross-property mismatch. ctx.property is the property
    // that owns the WhatsApp number this message arrived on; the seat says a
    // different one. Both readings are defensible and the wrong one books a
    // stranger into another property's room, so it is refused rather than
    // guessed — the same posture as the room-assignment rule. Flagged in the PR:
    // the alternative (seat always wins) is a CEO decision, not a Builder one.
    if (rolePropertyId !== ctx.property.id) {
      logToAxiom('warn', 'walkin_property_mismatch', {
        phone: ctx.phone, roleId: role.id, rolePropertyId, inboundPropertyId: ctx.property.id
      });
      await sendWhatsApp(ctx.phone, msg('walkinWrongProperty'));
      return;
    }
    const property = ctx.property;
    const isOvernight = !!parsed.overnight;

    // Rates: hourly reuses hourlyRates, which fails closed on any blank or
    // zero — a walk-in is never quoted R0 and the price is never hardcoded
    // here. Overnight reuses the SAME flat per-night lookup collectDetails
    // uses (exactly one active Per Night rate for the property), but does
    // NOT fail closed on ambiguity/absence the way hourly does: staff are
    // standing in front of the guest either way, so the walk-in still
    // proceeds unpriced (same "accepts whatever reception sends" posture
    // PAID already has for an unpriced booking) rather than blocking the
    // check-in entirely over a rate-config gap.
    let rates = null;
    let nightlyRate = null;
    if (isOvernight) {
      const allActiveRates = await airtableGet('WS_Rates', `AND({Active} = TRUE(), {Rate Type} = 'Per Night')`);
      const nightlyRates = allActiveRates.filter(r => (r.fields['Property'] || []).includes(property.id));
      nightlyRate = nightlyRates.length === 1 ? nightlyRates[0] : null;
      if (!nightlyRate) {
        logToAxiom('warn', 'walkin_overnight_rate_lookup_not_singular', {
          phone: ctx.phone, propertyId: property.id, matchCount: nightlyRates.length
        });
      }
    } else {
      rates = hourlyRates(property);
      if (!rates) {
        logToAxiom('warn', 'walkin_rates_unavailable', { phone: ctx.phone, propertyId: property.id });
        await sendWhatsApp(ctx.phone, msg('walkinRatesUnavailable', { propertyName: property.fields['Property Name'] }));
        return;
      }
    }

    // The guest is standing at the desk: the stay starts now either way.
    // Overnight's Check In/Check Out still carry the DATES reception typed
    // (the actual availability boundary other bookings check against) —
    // only the hourly path's checkInIso is literally "this instant", since
    // its whole stay is timed from now.
    const checkInIso = isOvernight
      ? sastToUtcIso(parsed.checkInDate, OVERNIGHT_CHECKIN_HOUR)
      : new Date().toISOString();
    const checkOutIso = isOvernight
      ? sastToUtcIso(parsed.checkOutDate, OVERNIGHT_CHECKOUT_HOUR)
      : addHoursToIso(checkInIso, parsed.hours);
    const checkedInAtIso = new Date().toISOString();

    const allRooms = await airtableGet('WS_Rooms', orFormula('Status', BOOKABLE_ROOM_STATUSES));
    const propertyRooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
    const requested = propertyRooms.find(r => roomMatchesWalkinToken(r, parsed.roomToken)) || null;
    if (!requested) {
      logToAxiom('info', 'walkin_rejected', { phone: ctx.phone, reason: 'no_such_room', roomToken: parsed.roomToken });
      await sendWhatsApp(ctx.phone, msg('walkinNoSuchRoom', { roomToken: parsed.roomToken }));
      return;
    }
    // Active gate (CEO decision, 2026-09-28): blocked here too, same as the
    // guest-facing path — a disabled room may not be seated by anyone,
    // including staff. Checked separately from the propertyRooms filter above
    // (rather than folded into it) so staff get a distinct, honest message —
    // "this room is disabled" rather than the same "no such room" a genuine
    // typo produces, which would leave staff hunting for a room number that
    // does in fact exist.
    if (requested.fields['Active'] !== true) {
      logToAxiom('info', 'walkin_rejected', { phone: ctx.phone, reason: 'room_disabled', roomToken: parsed.roomToken, roomId: requested.id });
      await sendWhatsApp(ctx.phone, msg('walkinRoomDisabled', { roomName: requested.fields['Room Name'] }));
      return;
    }

    // BOOKABLE_ROOM_STATUSES deliberately includes 'Cleaning' (comment above its
    // definition) so a FUTURE-dated overnight/hourly booking can still be offered
    // against a room that happens to be mid-clean right now — same-day turnover,
    // sellable by the guest's actual check-in time. WALKIN is the one caller of
    // findAvailableRoom where that reasoning does not hold: the stay starts NOW
    // (line ~1321), so "sellable by check-in time" and "sellable this instant"
    // are the same instant. Guarded here, not in findAvailableRoom/
    // BOOKABLE_ROOM_STATUSES itself, so collectDetails/collectHourlyDetails/
    // selectHourlyDuration's legitimate future-dated case is untouched.
    if (requested.fields['Status'] === 'Cleaning') {
      logToAxiom('info', 'walkin_room_mid_clean', {
        phone: ctx.phone, roomId: requested.id, roomName: requested.fields['Room Name']
      });
      await sendWhatsApp(ctx.phone, msg('walkinRoomCleaning', { roomName: requested.fields['Room Name'] }));
      return;
    }

    // ONE availability path, the same one both guest flows use. preferRoomId
    // re-offers a different room when the preferred one is taken — correct for a
    // guest chatting on WhatsApp, wrong for a staff member standing in front of
    // a specific door — so the substitution is rejected rather than accepted:
    // the room staff named must be the room that comes back.
    const free = await findAvailableRoom(property.id, checkInIso, checkOutIso, { preferRoomId: requested.id });
    if (!free || free.id !== requested.id) {
      logToAxiom('info', 'walkin_room_taken', {
        phone: ctx.phone, roomId: requested.id, roomName: requested.fields['Room Name'],
        checkIn: checkInIso, checkOut: checkOutIso
      });
      await logEnquiry(property, parsed.guestPhone || ctx.phone, 'No Availability', {
        checkInIso, checkOutIso, bookingType: isOvernight ? 'Overnight' : 'Hourly'
      });
      await sendWhatsApp(ctx.phone, msg('walkinRoomTaken', { roomName: requested.fields['Room Name'] }));
      return;
    }

    // Guest identity. With a phone we can recognise a returning walk-in and
    // reuse their record; without one there is nothing to match on, so a
    // name-only record is created and repeat-guest tracking simply does not
    // apply to this booking (locked). Creation is never blocked on the phone.
    let guest = null;
    if (parsed.guestPhone) {
      guest = (await airtableGet('WS_Guests', `{Phone Number} = '${parsed.guestPhone}'`))[0] || null;
    }
    if (guest) {
      // An existing name is NOT overwritten — the record may be a returning
      // guest with their own history, and staff typing a shortened name at the
      // desk must not rewrite it.
      await updateGuestState(guest.id, { 'Session State': 'CHECKED_IN' });
    } else {
      const fields = {
        'Guest Name': parsed.guestName,
        'Guest Type': 'Walk-in',
        // Truthful from the moment the booking exists: they are checked in. It
        // also means a walk-in who DID give a number can drive EXTEND / checkout
        // from their own phone through the existing CHECKED_IN menu, with no new
        // flow to build.
        'Session State': 'CHECKED_IN',
        'First Visit': new Date().toISOString().split('T')[0]
      };
      if (parsed.guestPhone) fields['Phone Number'] = parsed.guestPhone;
      guest = await airtableCreate('WS_Guests', fields);
    }
    // airtableCreate resolves to Airtable's error body on a failed write rather
    // than throwing, so an unchecked `.id` here would surface as a crash three
    // lines later with the real cause already swallowed.
    if (!guest || !guest.id) {
      logToAxiom('error', 'walkin_guest_create_failed', { phone: ctx.phone, propertyId: property.id });
      await sendWhatsApp(ctx.phone, msg('walkinFailed'));
      return;
    }

    const walkinBookingFields = {
      'Guest': [guest.id],
      'Room': [requested.id],
      // Hourly/Overnight, NOT the 'Walk-in' Booking Type option: Booking Type
      // is read by EXTENSION_MS, B17's room-night maths and
      // findPendingHourlyBooking, and a third value would fall silently
      // through all three. Walk-in provenance lives in Source, which is what
      // that field is for (locked, CEO 6 Aug).
      'Booking Type': isOvernight ? 'Overnight' : 'Hourly',
      'Source': 'Walk-in',
      'Logged By': 'Manual',
      // Checked In on creation (locked): the guest is physically in the room, so
      // the auto-checkout cron owns the rest of the stay from this instant — the
      // 15-minute warning, the auto-checkout, and the cleaner dispatch that
      // follows it all come for free from B12 rather than being rebuilt here.
      'Status': 'Checked In',
      'Check In': checkInIso,
      'Check Out': checkOutIso,
      'Checked In At': checkedInAtIso,
      'Payment Status': 'Unpaid',
      // B10.5 Bug 2: both checkout paths scope cleaner dispatch off this link.
      'WS_Property': [property.id],
      'Notes': isOvernight
        ? `Walk-in (overnight): ${parsed.checkInText} to ${parsed.checkOutText}`
        : `Walk-in: ${durationText(parsed.hours)} from ${formatSastDateTime(checkInIso)}`
    };
    if (isOvernight) {
      if (nightlyRate) {
        walkinBookingFields['Rate Applied'] = [nightlyRate.id];
        walkinBookingFields['Amount Due'] = nightlyRate.fields['Amount'];
      } // else left unpriced — reception settles the amount manually via PAID, same as an unpriced guest booking.
    } else {
      walkinBookingFields['Amount Due'] = rates[parsed.hours];
    }
    const booking = await airtableCreate('WS_Bookings', walkinBookingFields);

    if (!booking || !booking.id) {
      // Same reason as the guest guard above. Nothing has been written to the
      // room yet at this point, so there is nothing to roll back.
      logToAxiom('error', 'walkin_booking_create_failed', { phone: ctx.phone, propertyId: property.id, roomId: requested.id });
      await sendWhatsApp(ctx.phone, msg('walkinFailed'));
      return;
    }

    const bookingRef = `WS-${booking.id.slice(-6).toUpperCase()}`;
    // PR3 3c: checked, but non-fatal on failure. bookingRef is already computed
    // locally and used in every message/log below regardless of whether this
    // PATCH lands — the booking is Checked In, priced and roomed either way, so
    // a failed writeback is a "does the Airtable record match what everyone was
    // told" gap, not a broken booking. Logged loud rather than discovered later
    // by someone finding a blank Booking Ref on an otherwise-complete row.
    const refWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Booking Ref': bookingRef });
    if (refWrite && refWrite.error) {
      logToAxiom('warn', 'walkin_bookingref_writeback_failed', {
        phone: ctx.phone, bookingId: booking.id, bookingRef, error: JSON.stringify(refWrite.error)
      });
    }

    // CLAUDE.md rule 32 — Airtable is not transactional. Re-query after the
    // assignment and confirm this booking still holds the room alone. A second
    // walk-in typed on the other reception handset in the same second would
    // otherwise double-book a room with a person already standing in it.
    // On conflict: roll back and re-offer, never leave two live bookings.
    const stillFree = await findAvailableRoom(property.id, checkInIso, checkOutIso, {
      excludeBookingId: booking.id, preferRoomId: requested.id
    });
    if (!stillFree || stillFree.id !== requested.id) {
      // PR3 3c: this rollback write is now checked — mirrors PR1's identical
      // fix for the same class of write (a Cancelled rollback with nothing
      // clean left to do if IT fails too). Same event name as PR1 deliberately,
      // for one queryable signal across every rollback-failure in the file.
      const rollback = await airtableUpdate('WS_Bookings', booking.id, { 'Status': 'Cancelled' });
      if (rollback && rollback.error) {
        logToAxiom('error', 'booking_rollback_failed', {
          phone: ctx.phone, bookingId: booking.id, roomId: requested.id,
          error: JSON.stringify(rollback.error),
          reason: 'lost the availability race AND the Cancelled write failed — booking may still be holding a contested room'
        });
      }
      logToAxiom('warn', 'walkin_rolled_back', {
        phone: ctx.phone, bookingId: booking.id, roomId: requested.id, reason: 'room taken between check and create'
      });
      await sendWhatsApp(ctx.phone, msg('walkinRoomTaken', { roomName: requested.fields['Room Name'] }));
      return;
    }

    // Only now is the room really occupied — after the conflict check, so a
    // rolled-back booking never leaves a room marked Occupied behind it.
    // PR3 3c: checked, but non-fatal on failure for the same reason as the
    // Booking Ref writeback — the BOOKING (its Check In/Check Out range) is
    // what findAvailableRoom actually blocks against, not this Status field,
    // which is cosmetic/ops-visibility for staff reading the room grid. A
    // failed write here risks a stale-looking room, not a double-booking.
    const roomWrite = await airtableUpdate('WS_Rooms', requested.id, { 'Status': 'Occupied' });
    if (roomWrite && roomWrite.error) {
      logToAxiom('error', 'walkin_room_status_write_failed', {
        phone: ctx.phone, roomId: requested.id, bookingId: booking.id, error: JSON.stringify(roomWrite.error)
      });
    }

    logToAxiom('info', 'booking_create', {
      phone: ctx.phone, guestName: parsed.guestName, bookingRef, bookingType: isOvernight ? 'Overnight' : 'Hourly',
      source: 'Walk-in', hours: parsed.hours || null, roomId: requested.id, airtableId: booking.id,
      roleId: role.id, propertyId: property.id, guestPhone: parsed.guestPhone || null
    });
    // B19: a walk-in is a booking that happened — logged as Booked so the owner
    // summary's demand picture includes it. Keyed on the guest's number when
    // there is one, otherwise the staff number that logged it.
    await logEnquiry(property, parsed.guestPhone || ctx.phone, 'Booked', {
      checkInIso, checkOutIso, bookingType: isOvernight ? 'Overnight' : 'Hourly', bookingId: booking.id
    });

    if (isOvernight) {
      await sendWhatsApp(ctx.phone, msg('walkinOvernightConfirmed', {
        guestName: parsed.guestName,
        roomName: requested.fields['Room Name'],
        checkInText: parsed.checkInText,
        checkOutText: parsed.checkOutText,
        amountLine: nightlyRate ? `R${nightlyRate.fields['Amount']}` : 'to be confirmed — no active nightly rate found, set the rate or price manually via PAID',
        bookingRef
      }));
    } else {
      await sendWhatsApp(ctx.phone, msg('walkinConfirmed', {
        guestName: parsed.guestName,
        roomName: requested.fields['Room Name'],
        durationText: durationText(parsed.hours),
        checkOutText: formatSastDateTime(checkOutIso),
        amount: rates[parsed.hours],
        bookingRef
      }));
    }
  },

  // WABISTAY_PAY_ASSIGNS_ROOM: the guest tapped the gate before paying and reception has now recorded
  // the payment. Runs today's gateArrival for that guest (same room check, race guard, check-in, welcome,
  // alerts), forcing the room-must-be-Available check, then tells the seat what happened.
  async autoCheckInAfterPayment(ctx, booking) {
    const tapAge = Date.now() - Date.parse(booking.fields['Gate Tap At']);
    const guestId = (booking.fields['Guest'] || [])[0];
    const guest = guestId ? (await airtableGet('WS_Guests', `RECORD_ID() = '${guestId}'`))[0] || null : null;
    const skip = async (reason) => {
      logToAxiom('info', 'pay_assigns_room_skipped', { bookingId: booking.id, reason });
    };
    if (!(tapAge >= 0 && tapAge <= PAY_ASSIGNS_TAP_MAX_AGE_MS)) return skip('gate_tap_too_old');
    if (!guest || guest.fields['Session State'] !== 'CONFIRMED') return skip('guest_not_waiting');
    const open = await airtableGetBookingsByGuestId(guest.id, 'Confirmed');
    if (open.length !== 1 || open[0].id !== booking.id) return skip('not_the_guests_only_confirmed_booking');
    const guestPhone = formatPhone(String(guest.fields['Phone Number'] || ''));
    if (!guestPhone) return skip('no_guest_phone');

    const gateCtx = { phone: guestPhone, guest, property: ctx.property, next: 'CHECKED_IN', autoCheckIn: true, gateResult: {} };
    await actions.gateArrival(gateCtx);
    const r = gateCtx.gateResult;
    logToAxiom('info', 'pay_assigns_room', { bookingId: booking.id, outcome: r.outcome || null, guestSendError: !!r.guestSendError });
    const guestName = guest.fields['Guest Name'];
    if (r.outcome === 'checked_in' && !r.guestSendError) {
      await sendWhatsApp(ctx.phone, msg('payAssignsSent', { guestName, roomName: r.roomName || 'a room' }));
    } else if (r.outcome === 'checked_in') {
      await sendWhatsApp(ctx.phone, msg('payAssignsSendFailed', { guestName, roomName: r.roomName || 'a room' }));
    } else if (r.outcome === 'room_not_ready') {
      await sendWhatsApp(ctx.phone, msg('payAssignsRoomNotReady', { guestName, roomName: r.roomName, roomStatus: r.roomStatus }));
    } else {
      await sendWhatsApp(ctx.phone, msg('payAssignsFailed', { roomName: guestName }));
    }
  },

  // B8 (PAID): reception records cash taken at the desk. Reached only through
  // senderIsAuthorizedPaid, so every reply here is safe to send and goes to the
  // seat that just messaged us — inside the 24h window, so free-form is correct.
  async paidBooking(ctx) {
    const parsed = ctx.paid;
    const role = ctx.paidRole;

    if (!parsed.ok) {
      logToAxiom('info', 'paid_rejected', { phone: ctx.phone, reason: parsed.reason });
      await sendWhatsApp(ctx.phone, msg(paidRoomConfirmedEnabled() ? 'paidUsageRoomOnly' : (paidByBookingRefEnabled() ? 'paidUsageWithBookingRef' : 'paidUsage')));
      return;
    }

    const rolePropertyId = (role.fields['Property'] || [])[0] || null;
    if (!rolePropertyId) {
      logToAxiom('error', 'paid_role_without_property', { phone: ctx.phone, roleId: role.id });
      await sendWhatsApp(ctx.phone, msg('paidNotConfigured'));
      return;
    }
    // Fails closed on a cross-property mismatch, same posture as WALKIN: the
    // seat says one property and the inbound number says another, and recording
    // a payment against the wrong property's booking is not recoverable by a
    // guess. Same CEO decision pending as WALKIN's.
    if (rolePropertyId !== ctx.property.id) {
      logToAxiom('warn', 'paid_property_mismatch', {
        phone: ctx.phone, roleId: role.id, rolePropertyId, inboundPropertyId: ctx.property.id
      });
      await sendWhatsApp(ctx.phone, msg('paidWrongProperty'));
      return;
    }
    const property = ctx.property;

    let room, booking;

    if (parsed.refToken) {
      // Payment build (CEO decision, 2026-09-29): a pre-check-in EFT/card
      // confirmation happens before check-in, and depending on whether the
      // guest has given their ETA yet, the booking may still be 'Enquiry'
      // (overnight, pre-ETA) or already 'Confirmed' (hourly always has a
      // room by this point; overnight becomes Confirmed once ETA is given)
      // — so it is matched by the booking's own {Payment Reference} across
      // both pre-check-in statuses instead of by room or a single status.
      // A booking reference is unique to one booking, so it may also name a stay
      // that has already checked in or out; the 4-character payment reference only
      // ever identifies a pre-check-in booking.
      const byBookingRef = parsed.refKind === 'booking';
      const preCheckin = await airtableGet('WS_Bookings', orFormula('Status', byBookingRef
        ? ['Enquiry', 'Confirmed', 'Checked In', 'Checked Out']
        : ['Enquiry', 'Confirmed']));
      booking = preCheckin.find(b => String(b.fields[byBookingRef ? 'Booking Ref' : 'Payment Reference'] || '').toUpperCase() === parsed.refToken) || null;
      if (!booking) {
        logToAxiom('info', 'paid_rejected', { phone: ctx.phone, reason: 'no_booking_for_reference', refToken: parsed.refToken });
        await sendWhatsApp(ctx.phone, msg('paidNoBooking', { roomName: `reference ${parsed.refToken}` }));
        return;
      }
      const bookingPropId = bookingPropertyId(booking, null);
      if (bookingPropId && bookingPropId !== property.id) {
        logToAxiom('warn', 'paid_property_mismatch', {
          phone: ctx.phone, roleId: role.id, rolePropertyId: bookingPropId, inboundPropertyId: property.id
        });
        await sendWhatsApp(ctx.phone, msg('paidWrongProperty'));
        return;
      }
      const roomId = (booking.fields['Room'] || [])[0];
      const roomRecords = roomId ? await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`) : [];
      room = roomRecords[0] || null; // both booking types have a room by this point in practice, but never assumed — falls back to roomNameForCopy below if somehow absent
    } else {
      // Resolve the room within this property, exact match only — the same
      // matcher WALKIN uses, never roomMatchesText.
      const allRooms = await airtableGet('WS_Rooms', '');
      const propertyRooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
      room = propertyRooms.find(r => roomMatchesWalkinToken(r, parsed.roomToken)) || null;
      if (!room) {
        logToAxiom('info', 'paid_rejected', { phone: ctx.phone, reason: 'no_such_room', roomToken: parsed.roomToken });
        await sendWhatsApp(ctx.phone, msg('paidNoSuchRoom', { roomToken: parsed.roomToken }));
        return;
      }

      // Which stay is being paid for. Reception is standing at the desk just after
      // a checkout, so the target is that room's most recent CLOSED booking:
      // Checked Out ranks over Checked In (a guest still in the room has not been
      // billed at the desk yet), and within each, latest Check Out wins. Cancelled
      // and Enquiry rows can never be paid for through this path — Enquiry is the
      // REF path's job, above.
      const confirmedOn = paidRoomConfirmedEnabled();
      const PAYABLE_STATUSES = confirmedOn ? ['Checked Out', 'Checked In', 'Confirmed'] : ['Checked Out', 'Checked In'];
      const all = await airtableGet('WS_Bookings', orFormula('Status', PAYABLE_STATUSES));
      const onRoom = all.filter(b => (b.fields['Room'] || []).includes(room.id));
      if (confirmedOn) {
        const pick = pickBookingForPaidRoom(onRoom);
        if (pick.ambiguous) {
          logToAxiom('warn', 'paid_rejected', { phone: ctx.phone, reason: 'ambiguous_confirmed_bookings', roomId: room.id });
          await sendWhatsApp(ctx.phone, msg('paidRoomAmbiguous', { roomName: room.fields['Room Name'] }));
          return;
        }
        booking = pick.booking;
      } else {
        const candidates = onRoom.sort((a, b) => {
          const rank = s => (s === 'Checked Out' ? 0 : 1);
          const byStatus = rank(a.fields['Status']) - rank(b.fields['Status']);
          if (byStatus !== 0) return byStatus;
          return Date.parse(b.fields['Check Out'] || 0) - Date.parse(a.fields['Check Out'] || 0);
        });
        booking = candidates[0] || null;
      }
      if (!booking) {
        logToAxiom('info', 'paid_rejected', { phone: ctx.phone, reason: 'no_booking', roomId: room.id });
        await sendWhatsApp(ctx.phone, msg('paidNoBooking', { roomName: room.fields['Room Name'] }));
        return;
      }
    }

    const roomNameForCopy = room ? room.fields['Room Name'] : `reference ${parsed.refToken}`;

    // Idempotency (locked): an already-Paid booking is reported, never rewritten.
    // Reception re-sending after a lost reply, or two handsets recording the same
    // cash, must not double-write — and must not silently look like a second
    // payment either.
    if (booking.fields['Payment Status'] === 'Paid') {
      logToAxiom('info', 'paid_already_recorded', {
        phone: ctx.phone, bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
        amountPaid: booking.fields['Amount Paid'] || null
      });
      await sendWhatsApp(ctx.phone, msg('paidAlreadyRecorded', {
        roomName: roomNameForCopy,
        bookingRef: booking.fields['Booking Ref'] || '',
        amountPaid: formatAmount(booking.fields['Amount Paid'])
      }));
      return;
    }

    const amountDue = Number(booking.fields['Amount Due']) || 0;

    // Partial payments do not exist in this business (CEO, 6 Aug), and that is
    // what decides the mismatch rule rather than a preference: if every payment
    // settles the bill in full, then an amount that is not the amount owed is
    // not a short payment — it is a TYPO. So it is refused with zero writes and
    // reception re-sends the right figure.
    //
    // The alternative (record it, flag the mismatch, mark Paid) was rejected
    // because it is unrecoverable in one step: the write marks the booking Paid,
    // and the idempotency guard immediately above then refuses every correction,
    // so a fat-fingered R40 against R400 would be frozen into the record that
    // B17 builds the owner's revenue report from. Refusing costs one re-send;
    // accepting costs a wrong number nobody can fix from WhatsApp.
    //
    // Compared with a half-cent tolerance so decimal input ("400,00") cannot
    // fail on float representation alone.
    const AMOUNT_EPSILON = 0.005;
    // An unpriced booking has nothing to check against — F19's and F34's
    // fail-closed paths both produce exactly that (booked or extended, never
    // priced). Refusing there would leave reception unable to record real cash,
    // so whatever they send is accepted and the gap is logged instead.
    const priced = amountDue > 0;
    if (priced && Math.abs(parsed.amount - amountDue) > AMOUNT_EPSILON) {
      logToAxiom('warn', 'payment_amount_mismatch', {
        phone: ctx.phone, bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
        roomName: roomNameForCopy, amountSent: parsed.amount, amountDue,
        delta: Number((parsed.amount - amountDue).toFixed(2)), written: false
      });
      await sendWhatsApp(ctx.phone, msg('paidAmountMismatch', {
        roomName: roomNameForCopy,
        amountSent: formatAmount(parsed.amount),
        amountDue: formatAmount(amountDue)
      }));
      return;
    }
    if (!priced) {
      logToAxiom('warn', 'payment_recorded_unpriced', {
        phone: ctx.phone, bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
        amountSent: parsed.amount, reason: 'booking has no Amount Due to check against'
      });
    }

    const status = 'Paid';
    // A REF-matched confirmation already has its method on the booking (set
    // by selectPaymentMethod) — reception isn't re-specifying Card/EFT, just
    // confirming the funds landed, so that stored value wins over the room
    // path's Cash default.
    const method = parsed.method || ((parsed.refToken || paidRoomConfirmedEnabled()) && booking.fields['Payment Method']) || 'Cash';

    // One instant, written to both sinks. Generating it twice would let the
    // Airtable field and the Axiom event disagree by however long the write
    // takes, and reconciling a payment against its log entry is exactly what
    // this timestamp is for.
    const recordedAt = new Date().toISOString();

    const update = {
      'Amount Paid': parsed.amount,
      'Payment Method': method,
      'Payment Status': status,
      // `Paid At` — created live by the CEO after F35 shipped, which is why the
      // original build could only log it. It goes in the SAME patch as the
      // payment fields deliberately: a payment recorded without its timestamp,
      // or a timestamp without its payment, is a half-written record either way.
      // (Contrast `Cleaning Started At`, which is a separate call precisely
      // because it was NOT confirmed live at the time.)
      'Paid At': recordedAt
    };
    // PR3 3b: the write is now checked before anything downstream trusts it.
    // `result.error` is exactly the same test airtableUpdate itself uses
    // internally to decide between logging airtable_update_success and
    // airtable_update_error (PR2) — that IS the signal; there is no separate
    // subscription mechanism to a fire-and-forget Axiom log, so the caller
    // checks the same condition the callee already checks, on the same
    // return value. Before this, the confirmation reply and payment_recorded
    // fired regardless of whether the PATCH actually landed — reception could
    // be told "Settled in full" while Payment Status stayed Unpaid, with
    // nothing but an easily-missed airtable_update_error to say otherwise.
    const result = await airtableUpdate('WS_Bookings', booking.id, update);
    if (result && result.error) {
      logToAxiom('error', 'payment_write_failed', {
        phone: ctx.phone, roleId: role.id, propertyId: property.id,
        bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
        amountAttempted: parsed.amount, method,
        error: JSON.stringify(result.error)
      });
      await sendWhatsApp(ctx.phone, msg('paidWriteFailed', { roomName: roomNameForCopy }));
      return;
    }

    logToAxiom('info', 'payment_recorded', {
      phone: ctx.phone, roleId: role.id, propertyId: property.id,
      bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
      roomId: room ? room.id : null, roomName: roomNameForCopy,
      amountPaid: parsed.amount, amountDue, method, status,
      recordedAt
    });

    await sendWhatsApp(ctx.phone, msg('paidRecorded', {
      roomName: roomNameForCopy,
      bookingRef: booking.fields['Booking Ref'] || '',
      amountPaid: formatAmount(parsed.amount),
      method
    }));

    // WABISTAY_PAY_ASSIGNS_ROOM: a guest already waiting at the gate gets their room now. After the
    // reply to reception and fenced off: a problem here can never undo or hide the recorded payment.
    if (payAssignsRoomEnabled() && booking.fields['Status'] === 'Confirmed' && booking.fields['Gate Tap At']) {
      try {
        await actions.autoCheckInAfterPayment(ctx, booking);
      } catch (err) {
        logToAxiom('error', 'pay_assigns_room_failed', { bookingId: booking.id, message: err.message });
        await sendWhatsApp(ctx.phone, msg('payAssignsFailed', { roomName: roomNameForCopy }));
      }
    }
  },

  // PR D (CEO decision, 2026-09-29): `CHECKOUT ROOM <n>` — staff closes out a
  // walk-in (or any Checked In stay) directly, rather than relying on the
  // guest's own phone or the auto-checkout cron. Deliberately reuses the same
  // downstream effects the guest-driven `checkout` handler already has
  // (Status -> Checked Out, room -> Cleaning, cleaner dispatch, reception
  // payment-owed notify) rather than inventing a second set of side effects
  // for the same event — only the trigger and the reply differ.
  //
  // No amount here, on purpose (CEO decision): checkout and payment stay two
  // separate, composable commands. A walk-in may already be paid (via PAID
  // at check-in) or gets paid after (via PAID/PAID REF) — forcing an amount
  // into CHECKOUT would wrongly assume money always changes hands at that
  // exact moment.
  async staffCheckout(ctx) {
    const parsed = ctx.staffCheckout;
    const role = ctx.staffCheckoutRole;

    if (!parsed.ok) {
      logToAxiom('info', 'checkout_command_rejected', { phone: ctx.phone, reason: parsed.reason });
      await sendWhatsApp(ctx.phone, msg('checkoutUsage'));
      return;
    }

    const rolePropertyId = (role.fields['Property'] || [])[0] || null;
    if (!rolePropertyId) {
      logToAxiom('error', 'checkout_command_role_without_property', { phone: ctx.phone, roleId: role.id });
      await sendWhatsApp(ctx.phone, msg('paidNotConfigured'));
      return;
    }
    if (rolePropertyId !== ctx.property.id) {
      logToAxiom('warn', 'checkout_command_property_mismatch', {
        phone: ctx.phone, roleId: role.id, rolePropertyId, inboundPropertyId: ctx.property.id
      });
      await sendWhatsApp(ctx.phone, msg('paidWrongProperty'));
      return;
    }
    const property = ctx.property;

    const allRooms = await airtableGet('WS_Rooms', '');
    const propertyRooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
    const room = propertyRooms.find(r => roomMatchesWalkinToken(r, parsed.roomToken)) || null;
    if (!room) {
      logToAxiom('info', 'checkout_command_rejected', { phone: ctx.phone, reason: 'no_such_room', roomToken: parsed.roomToken });
      await sendWhatsApp(ctx.phone, msg('paidNoSuchRoom', { roomToken: parsed.roomToken }));
      return;
    }

    const checkedIn = await airtableGet('WS_Bookings', `{Status} = 'Checked In'`);
    const booking = checkedIn.find(b => (b.fields['Room'] || []).includes(room.id)) || null;
    if (!booking) {
      logToAxiom('info', 'checkout_command_rejected', { phone: ctx.phone, reason: 'no_booking', roomId: room.id });
      await sendWhatsApp(ctx.phone, msg('paidNoBooking', { roomName: room.fields['Room Name'] }));
      return;
    }

    // Same FATAL-on-failure posture as the guest-driven checkout: this write
    // is what closes out the stay and feeds notifyReceptionOfPayment below.
    const checkoutWrite = await airtableUpdate('WS_Bookings', booking.id, {
      'Status': 'Checked Out',
      'Checkout Confirmed': true
    });
    if (checkoutWrite && checkoutWrite.error) {
      logToAxiom('error', 'checkout_command_write_failed', {
        phone: ctx.phone, bookingId: booking.id, error: JSON.stringify(checkoutWrite.error)
      });
      await sendWhatsApp(ctx.phone, msg('checkoutWriteFailed'));
      return;
    }

    // Same non-fatal room-status pattern as the guest-driven checkout —
    // Status is a derived display field, cleaner dispatch below is a direct
    // message, not gated on this write succeeding.
    const cleaningWrite = await airtableUpdate('WS_Rooms', room.id, { 'Status': 'Cleaning' });
    if (cleaningWrite && cleaningWrite.error) {
      logToAxiom('error', 'checkout_command_room_status_write_failed', {
        phone: ctx.phone, roomId: room.id, error: JSON.stringify(cleaningWrite.error)
      });
    }
    await airtableUpdate('WS_Rooms', room.id, { 'Cleaning Started At': new Date().toISOString() });

    const scopePropertyId = bookingPropertyId(booking, property.id);
    const cleaners = await activeCleanersForProperty(scopePropertyId);
    for (const cleaner of cleaners) {
      const cleanerPhone = cleaner.fields['Phone Number'];
      const cleanerName = cleaner.fields['Cleaner Name'];
      if (cleanerPhone) {
        await sendCleanerDispatch(cleaner, room.fields['Room Name'], { bookingId: booking.id, failEvent: 'cleaner_dispatch_failed' });
      }
    }

    // Same "tell reception what to collect" push the guest-driven checkout
    // sends — deliberately not gated on payment, same as that path.
    await notifyReceptionOfPayment({
      propertyId: scopePropertyId,
      bookingId: booking.id,
      bookingRef: booking.fields['Booking Ref'] || null,
      roomName: room.fields['Room Name'],
      guestName: null,
      amountDue: booking.fields['Amount Due'],
      source: 'staff_checkout_command'
    });

    logToAxiom('info', 'checkout_command_recorded', {
      phone: ctx.phone, roleId: role.id, propertyId: property.id,
      bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null, roomId: room.id
    });
    await sendWhatsApp(ctx.phone, msg('checkoutCommandConfirmed', {
      roomName: room.fields['Room Name'],
      bookingRef: booking.fields['Booking Ref'] || ''
    }));
  },

  // Cleaner sends `START ROOM <n>` when they actually begin a job. Purely an
  // instrumentation step: it starts the Job Duration clock and changes nothing
  // about the room, the booking's status, or the existing DONE flow — a cleaner
  // who never sends START still completes normally, and simply has no secondary
  // metric for that job.
  async startCleaningJob(ctx) {
    const parsed = ctx.cleaningStart;
    if (!parsed.ok) {
      await sendWhatsApp(ctx.phone, msg('cleaningStartUsage'));
      return;
    }

    // Only a room already marked for cleaning can have a job started on it —
    // the same invariant the completion side enforces.
    const cleaningRooms = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
    const room = cleaningRooms.find(r => roomMatchesWalkinToken(r, parsed.roomToken)) || null;
    if (!room) {
      logToAxiom('info', 'cleaning_start_rejected', {
        phone: ctx.phone, roomToken: parsed.roomToken, reason: 'no room in Cleaning matches'
      });
      await sendWhatsApp(ctx.phone, msg('cleaningStartNotCleaning', { roomToken: parsed.roomToken }));
      return;
    }

    const booking = await bookingForCleaningJob(room.id);
    if (!booking) {
      // Nowhere to record the job. The cleaner is still told to carry on — the
      // room genuinely needs cleaning — but the gap is visible rather than
      // swallowed, because a missing job record is a missing metric later.
      logToAxiom('warn', 'cleaning_start_no_booking', {
        phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name']
      });
      await sendWhatsApp(ctx.phone, msg('cleaningStarted', { roomName: room.fields['Room Name'] }));
      return;
    }

    // FIRST start wins. A second START on the same job would reset the clock and
    // silently understate how long the work took, which is the one way this
    // metric could flatter itself.
    if (booking.fields[CLEANING_JOB_STARTED_FIELD]) {
      logToAxiom('info', 'cleaning_start_already_recorded', {
        phone: ctx.phone, roomId: room.id, bookingId: booking.id,
        startedAt: booking.fields[CLEANING_JOB_STARTED_FIELD]
      });
      await sendWhatsApp(ctx.phone, msg('cleaningStarted', { roomName: room.fields['Room Name'] }));
      return;
    }

    const startedAt = new Date().toISOString();
    await airtableUpdate('WS_Bookings', booking.id, { [CLEANING_JOB_STARTED_FIELD]: startedAt });
    logToAxiom('info', 'cleaning_job_started', {
      phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'],
      bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
      cleanerId: ctx.cleaner ? ctx.cleaner.id : null,
      cleanerName: (ctx.cleaner && ctx.cleaner.fields['Cleaner Name']) || null,
      startedAt
    });
    await sendWhatsApp(ctx.phone, msg('cleaningStarted', { roomName: room.fields['Room Name'] }));
  },

  // Cleaner replies DONE (global, any state)
  async cleanerDone(ctx) {
    // F4: was {Active} = 1 — Airtable checkbox requires TRUE()
    const cleaningRooms = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
    if (cleaningRooms.length === 0) {
      await sendWhatsApp(ctx.phone, msg('cleanerNothingToClean'));
      return;
    }
    if (cleaningRooms.length > 1) {
      // Ambiguity fix: more than one room in Cleaning -- ask, don't guess.
      // The cleaner's answer (any later message naming a room) is caught by
      // the cleanerRoomReply global transition below, whenever it arrives.
      const roomList = cleaningRooms.map(r => r.fields['Room Name']).join(', ');
      await sendWhatsApp(ctx.phone, msg('cleanerWhichRoom', { roomList }));
      return;
    }
    await resolveRoomClean(ctx, cleaningRooms[0]);
  },

  // Cleaner names a specific room (e.g. after being asked which one) --
  // resolves only that room, never touches any other room in Cleaning.
  async cleanerRoomReply(ctx) {
    await resolveRoomClean(ctx, ctx.matchedCleaningRoom);
  },

  // NEW guest (or reset): greet with availability + rates, ask for details (F10)
  // 6.4: scoped to ctx.property via {Property} linked-record filter — Airtable
  // FIND/ARRAYJOIN pattern for filtering multipleRecordLinks by record ID.
  // FLAG: this filterByFormula syntax has NOT been live-tested (no Airtable
  // credential available in this Builder session) — must be confirmed via a
  // real Airtable ping / device test before merge, per Rule 1 and the 3-lens
  // diagnostic. If it's wrong, Airtable returns HTTP 200 with an empty record
  // set (not an error) — a formula bug here would silently show 0 rooms/rates
  // rather than fail loudly, so this is the single highest-risk line in 6.4.
  // A1 (flow inversion, Stage 4): stay-type (short stay vs multiple days) is now
  // asked FIRST, before any date/name capture — this replaces the old
  // greetAndAskDetails, which asked for name+dates directly and buried the
  // short-stay option in a footnote ("reply HOURLY"). No config branching
  // (locked decision): every property gets asked both options regardless of its
  // Allow Anonymous Hourly/Overnight config — availability of each path is
  // still checked where it already was (hourlyRates() fail-closed in
  // selectStayType/startHourly), just never used to skip asking the question.
  async greetAndAskStayType(ctx) {
    // Guest-visible count: Status = Available AND Active === true (CEO decision,
    // 2026-09-28) — a disabled room must never inflate the number shown to a
    // guest, same allowlist as findAvailableRoom / the gate-arrival fallback.
    const availableRooms = await getGuestVisibleAvailableRooms(ctx.property.id);
    const roomCount = availableRooms.length;

    // Data-quality signal: rows with an empty Property field never match the
    // scoped filter above and so silently vanish from every property's greeting.
    // Schema can't force this field non-empty, so surface gaps instead of guessing.
    // Rates are checked here too (even though rateText itself now builds later,
    // in selectStayType) so this diagnostic still fires on every first contact,
    // unchanged from before the reorder.
    const unassignedRooms = await airtableGet('WS_Rooms', `AND({Status} = 'Available', {Property} = BLANK())`);
    const unassignedRates = await airtableGet('WS_Rates', `AND({Active} = TRUE(), {Property} = BLANK())`);
    if (unassignedRooms.length > 0 || unassignedRates.length > 0) {
      logToAxiom('warn', 'property_unassigned_rows', {
        phone: ctx.phone,
        propertyId: ctx.property.id,
        unassignedRoomCount: unassignedRooms.length,
        unassignedRateCount: unassignedRates.length
      });
    }

    if (roomCount === 0) {
      // Fully booked (guest-visible sense): no state write either way — a new
      // guest gets no record created, an existing guest's state is untouched —
      // and no stay-type menu is offered. Same "no writes, no state change"
      // posture as the gateTooEarly path above.
      logToAxiom('info', 'greeting_zero_rooms', { phone: ctx.phone, propertyId: ctx.property.id });
      await sendNoRoomMessage(ctx, 'greeting');
      return;
    }

    if (!ctx.guest) {
      // Rule 30 step 2, slice 2: same NON-FATAL class as updateGuestState — a
      // failed first-contact create just means the guest's next message hits
      // this same !ctx.guest branch again (WS_Guests re-queried fresh on
      // every inbound message), self-correcting rather than compounding.
      const guestCreate = await airtableCreate('WS_Guests', {
        'Guest Name': 'Unknown',
        'Phone Number': ctx.phone,
        'Guest Type': 'WhatsApp',
        'Session State': ctx.next,
        'First Visit': new Date().toISOString().split('T')[0],
        ...greetingTrackingFields(ctx)
      });
      if (guestCreate && guestCreate.error) {
        logToAxiom('error', 'guest_state_write_failed', {
          phone: ctx.phone, fields: { 'Session State': ctx.next }, error: JSON.stringify(guestCreate.error)
        });
      }
    } else {
      if (!(await advanceGuestState(ctx, { 'Session State': ctx.next, ...greetingTrackingFields(ctx) }))) return;
    }

    if (stayMenuEnabled()) {
      const menuGreeting = await stayMenuGreeting(ctx, roomCount);
      if (menuGreeting) {
        await sendWhatsApp(ctx.phone, menuGreeting);
        return;
      }
    }

    await sendWhatsApp(ctx.phone, msg('greeting', {
      propertyName: ctx.property.fields['Property Name'],
      propertyCityLine: propertyCityLine(ctx.property),
      roomCountLine: roomCountLine(ctx.property, roomCount)
    }));
  },

  // AWAITING_STAY_TYPE: the guest's answer to "short stay or multiple days?".
  // Branches to a rate menu SCOPED to that answer only (never both types in one
  // message, locked decision) then continues into the existing capture flow for
  // that type — collectHourlyDetails (unchanged) for short stay, collectDetails
  // (unchanged) for multiple days. Both rate fetches below reuse the exact same
  // functions/queries B2/F19 (rate-fix) already established: hourlyRates() for
  // short stay, the WS_Rates active+property-scoped fetch (previously inline in
  // greetAndAskDetails) for overnight — no new pricing logic written here.
  //
  // "next" in states.json for this state is a nominal default only, same
  // convention startHourly already uses for its own fail-closed branch: this
  // handler always writes an explicit, hardcoded Session State on every real
  // path below, never ctx.next.
  async selectStayType(ctx) {
    const guestName = ctx.guest.fields['Guest Name'];
    const SHORT_STAY_CHOICES = ['1', 'short stay', 'short'];
    const MULTI_DAY_CHOICES = ['2', 'multiple days', 'multi-day', 'multiday', 'overnight'];

    // WABISTAY_STAY_MENU: a reply to the menu of what is on sale now. False hands over to today's code.
    if (stayMenuEnabled() && (await handleStayMenuChoice(ctx))) return;

    if (SHORT_STAY_CHOICES.includes(ctx.text)) {
      const rates = guestHourlyRates(ctx.property);
      if (!rates) {
        // Same fail-closed posture as startHourly's own equivalent branch —
        // property has not configured short stays. Route to the overnight
        // path rather than dead-ending, zero rate quoted.
        logToAxiom('info', 'hourly_not_configured', { phone: ctx.phone, propertyId: ctx.property.id });
        await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
        await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', {
          propertyName: ctx.property.fields['Property Name']
        }));
        return;
      }

      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_HOURLY_DETAILS', 'Last Inbound At': new Date().toISOString() });
      // WABISTAY_LEAN_COPY: no separate rates message (the duration question shows each
      // price); the fail-closed rates check above has already run.
      if (leanCopyEnabled()) {
        await sendWhatsApp(ctx.phone, msg('hourlyAskDetailsLean'));
        return;
      }
      const hourlyRateText = offeredHourlyDurations()
        .map(hours => `• ${hours} hour${hours === 1 ? '' : 's'}: R${rates[hours]}`)
        .join('\n');
      await sendWhatsApp(ctx.phone, msg('hourlyRatesMenu', {
        propertyName: ctx.property.fields['Property Name'],
        hourlyRateText
      }));
      await sendWhatsApp(ctx.phone, msg('hourlyAskDetails', {
        propertyName: ctx.property.fields['Property Name']
      }));
      return;
    }

    if (MULTI_DAY_CHOICES.includes(ctx.text)) {
      // Same fetch as the old greetAndAskDetails rateText build — F4/F5-style,
      // unfiltered fetch + JS filter by Property inclusion, unchanged.
      const allActiveRates = await airtableGet('WS_Rates', `{Active} = TRUE()`);
      const activeRates = allActiveRates.filter(r => (r.fields['Property'] || []).includes(ctx.property.id));
      const rateText = activeRates.length > 0
        ? activeRates.map(r =>
            `• ${r.fields['Rate Name']}: R${r.fields['Amount']} ${rateUnitLabel(r.fields['Rate Type'])}`
          ).join('\n')
        : '• Contact us for current rates';

      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      await sendWhatsApp(ctx.phone, msg('overnightRatesMenu', {
        propertyName: ctx.property.fields['Property Name'],
        rateText
      }));
      return;
    }

    // Unreadable answer — zero writes, same re-prompt-in-place pattern used
    // throughout this file for an unparseable numbered menu answer.
    await sendWhatsApp(ctx.phone, msg('stayTypeReprompt', { guestName }));
  },

  // AWAITING_DETAILS: parse name + dates, create Enquiry booking (F7, F13)
  async collectDetails(ctx) {
    const now = new Date();
    const rawText = ctx.messageText.trim();

    // F20 (parser robustness): find date-shaped tokens anywhere in the message —
    // one line or three. The first two are check-in / check-out; whatever precedes
    // the first date token is the name. Replaces the old per-line month-SUBSTRING
    // classifier, which required each field on its own line and ate names that
    // merely contained a month fragment. parseBookingDate below still validates.
    const dateTokens = findDateTokens(rawText);
    let checkIn = dateTokens[0] ? dateTokens[0].text : null;
    let checkOut = dateTokens[1] ? dateTokens[1].text : null;

    // BUGFIX (anon-name reversion): the name is whatever the guest typed THIS
    // turn — the text before the first date token (newline- or space-
    // separated), collapsed to a single line — including an explicit "anon".
    // A stored name from a prior booking is used ONLY as a fallback when
    // nothing usable was typed this turn, never as an override of what was.
    // Previously this order was reversed ("a returning guest already has a
    // name — parse dates only, never re-derive it"), which silently discarded
    // "anon" for any guest who had ever given a real name before — a direct
    // violation of the locked anonymous-entry-stays-as-entered decision. See
    // the investigation report / PR discussion for the reproduction case.
    const beforeFirstDate = dateTokens[0] ? rawText.slice(0, dateTokens[0].start) : rawText;
    const typedName = beforeFirstDate.replace(/\s+/g, ' ').trim() || null;
    const guestName = typedName || (ctx.guest.fields['Guest Name'] !== 'Unknown' ? ctx.guest.fields['Guest Name'] : null);

    // B8: check-out is now required. B7 allowed a check-in-only booking that
    // rendered as "TBC"; once a booking holds a room, one with no check-out
    // holds it against a range the overlap check cannot see, re-introducing the
    // double-booking B8 exists to prevent — via a rarer door. The greeting has
    // always asked for all three; this is the code enforcing what the copy says.
    if (!guestName || !checkIn || !checkOut) {
      // B19: the parser rejected this input (bot re-prompted) → Invalid Input.
      // Partial row: dates blank if not given. Deduped so repeated fumbles in one
      // attempt collapse to a single Invalid Input row.
      await logEnquiry(ctx.property, ctx.phone, 'Invalid Input', { ...enquiryTrackingOpts(ctx), bookingType: 'Overnight' });
      // Stay in AWAITING_DETAILS — reprompt only
      await sendWhatsApp(ctx.phone, msg('detailsReprompt'));
      return;
    }

    // B7: a line can look like a date to the classifier above and still not be
    // one. Parse before any write so an unusable date re-prompts (no writes,
    // same as the garbage path) rather than creating a booking whose structured
    // dates are absent or wrong — B8's overlap check is only as good as these.
    // The raw text keeps feeding Notes and the guest/owner copy untouched;
    // these parsed values are additional, not a replacement.
    const checkInDate = parseBookingDate(checkIn, now);
    const checkOutDate = parseBookingDate(checkOut, now);
    const datesUnusable = !checkInDate
      || !checkOutDate
      // Overnight stays span at least one night: 14:00 → 10:00 on a reversed or
      // same-day range is a negative stay, and would poison B8 (CEO 16 July).
      || compareYmd(checkOutDate, checkInDate) <= 0;
    if (datesUnusable) {
      logToAxiom('info', 'booking_date_unparsed', {
        phone: ctx.phone,
        checkInText: checkIn,
        checkOutText: checkOut || null
      });
      await logEnquiry(ctx.property, ctx.phone, 'Invalid Input', { ...enquiryTrackingOpts(ctx), bookingType: 'Overnight' });
      await sendWhatsApp(ctx.phone, msg('detailsReprompt'));
      return;
    }

    const checkInIso = sastToUtcIso(checkInDate, OVERNIGHT_CHECKIN_HOUR);
    const checkOutIso = sastToUtcIso(checkOutDate, OVERNIGHT_CHECKOUT_HOUR);

    // B8: the real double-booking fix — decided here, at enquiry, not at the gate.
    // Before this, the first collision anyone noticed was two guests at the door.
    // Refusing costs nothing and writes nothing; the guest keeps their turn in
    // AWAITING_DETAILS and can offer different dates.
    const room = await findAvailableRoom(ctx.property.id, checkInIso, checkOutIso);
    if (!room) {
      logToAxiom('info', 'booking_no_availability', {
        phone: ctx.phone,
        propertyId: ctx.property.id,
        checkIn: checkInIso,
        checkOut: checkOutIso
      });
      // B19: the revenue-relevant one — a real request refused by B8. Captures the
      // dates so the weekly summary can say "turned away, no room free".
      await logEnquiry(ctx.property, ctx.phone, 'No Availability', { ...enquiryTrackingOpts(ctx),
        checkInIso, checkOutIso, bookingType: 'Overnight'
      });
      await sendNoRoomMessage(ctx, 'overnight_dates');
      return;
    }

    if (!(await advanceGuestState(ctx, {
      'Guest Name': guestName,
      'Session State': ctx.next,
      'Last Inbound At': now.toISOString() // B19: staleness anchor for the abandonment sweep
    }))) return;

    // Flat per-night rate (CEO decision, 2026-09-28): rooms are all the same
    // size, so occupancy is no longer asked — every guest gets the one active
    // Per Night rate for this property. The booking is created here, unpriced,
    // with the room already held; the rate is resolved and applied further
    // down in this same turn, once the create/rollback race check has passed.
    const bookingData = {
      'Guest': [ctx.guest.id],
      'Booking Type': 'Overnight',
      'Source': 'WhatsApp',
      'Status': 'Enquiry',
      'Logged By': 'WhatsApp Bot',
      'Notes': `Check-in: ${checkIn}${checkOut ? ' | Check-out: ' + checkOut : ''}`,
      'Payment Status': 'Unpaid'
    };
    // B7: structured dates in addition to the Notes string above, which keeps its
    // exact pre-B7 format — it is the human-readable record of what the guest
    // actually typed, and these fields are what B8 queries.
    bookingData['Check In'] = checkInIso;
    bookingData['Check Out'] = checkOutIso;
    // B8: hold the room from this moment. Room Status deliberately stays as it
    // is — the guest is not in the room yet, and a hold is not occupancy.
    bookingData['Room'] = [room.id];
    // Doc 1b PR 6: no ETA yet, so the hold runs to the end of the check-in day;
    // recordEta tightens it once the guest says when they are arriving.
    if (holdReleaseEnabled()) bookingData['Hold Expires At'] = overnightHoldExpiryIso(checkInIso, '');

    const booking = await airtableCreate('WS_Bookings', bookingData);
    const bookingRef = booking.id ? `WS-${booking.id.slice(-6).toUpperCase()}` : 'WS-000001';
    // F13: write Booking Ref back to Airtable after CREATE
    if (booking.id) {
      // P1a: Airtable is not transactional (CLAUDE.md rule 32) — the
      // findAvailableRoom check above and this create are two separate calls,
      // and this is a WhatsApp-facing path with real concurrency (unlike
      // walkinBooking's single reception handset). Two guests racing the same
      // dates can both pass the pre-check before either's create lands. Ported
      // from walkinBooking's rollback pattern: re-verify excluding this
      // booking's own hold, and if the room did not survive, cancel rather than
      // let two Confirmed bookings exist on the same room discovered only at
      // the gate.
      const stillFree = await findAvailableRoom(ctx.property.id, checkInIso, checkOutIso, {
        excludeBookingId: booking.id, preferRoomId: room.id
      });
      if (!stillFree || stillFree.id !== room.id) {
        // Unlike walkinBooking's line-1556 rollback, THIS write is checked —
        // Rule 30 / PR3's finding applies to new code from the moment it's
        // written, not just to the handler that surfaced the bug.
        const rollback = await airtableUpdate('WS_Bookings', booking.id, { 'Status': 'Cancelled' });
        if (rollback && rollback.error) {
          // No clean recovery left at this point — the booking exists, holds a
          // room that may now be double-held, and the write meant to fix that
          // has itself failed. Nothing to do but make it maximally visible.
          logToAxiom('error', 'booking_rollback_failed', {
            phone: ctx.phone, bookingId: booking.id, roomId: room.id,
            error: JSON.stringify(rollback.error),
            reason: 'lost the availability race AND the Cancelled write failed — booking may still be holding a contested room'
          });
        }
        // The guest's Session State was already advanced to AWAITING_ETA
        // above, before this booking existed to occupy that state. Leaving them
        // there with no valid booking is the same stuck-loop symptom PR1 exists
        // to prevent, just reached via the race instead of a create failure —
        // so it is reset here rather than left for PR4, which owns the
        // create-fails-outright case, not this one.
        await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
        logToAxiom('warn', 'booking_race_lost', {
          phone: ctx.phone, bookingId: booking.id, roomId: room.id,
          checkIn: checkInIso, checkOut: checkOutIso,
          reason: 'room taken by a concurrent booking between the pre-check and this create'
        });
        await logEnquiry(ctx.property, ctx.phone, 'No Availability', { ...enquiryTrackingOpts(ctx),
          checkInIso, checkOutIso, bookingType: 'Overnight'
        });
        await sendNoRoomMessage(ctx, 'overnight_dates_recheck');
        return;
      }

      // Rule 30 step 2, slice 1: checked but non-fatal, same shape as
      // walkinBooking's identical Booking Ref writeback (F40) — bookingRef is
      // computed locally and used in every message/log regardless of whether
      // this PATCH lands, so a failure here is cosmetic, not a booking failure.
      const refWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Booking Ref': bookingRef });
      if (refWrite && refWrite.error) {
        logToAxiom('warn', 'collectdetails_bookingref_writeback_failed', {
          phone: ctx.phone, bookingId: booking.id, bookingRef, error: JSON.stringify(refWrite.error)
        });
      }
      // CEO decision, 2026-09-28: 'Booked' used to log here, right after
      // creation and before any price existed — so a guest who abandoned
      // right after giving dates was already logged Booked with no quote
      // ever sent. Moved to fire only once the flow actually reaches its
      // quote (or fail-closed contact-owner) terminal, further down.
    }
    logToAxiom(booking.id ? 'info' : 'error', 'booking_create', {
      phone: ctx.phone,
      guestName,
      bookingRef,
      airtableId: booking.id || null,
      error: booking.error ? JSON.stringify(booking.error) : null
    });

    // F41-4 (fix-order item 4): the create itself failed outright — no room was
    // held, no booking exists. Session State was already written to ctx.next
    // above, before this create ran, so left unhandled the guest silently
    // stayed in AWAITING_ETA with nothing behind it. Reset here, tell the guest
    // plainly, and skip the owner notify and rate lookup — there is nothing for
    // anyone to action.
    if (!booking.id) {
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      await sendWhatsApp(ctx.phone, msg('bookingCreateFailed', { guestName }));
      return;
    }

    // Flat per-night rate (CEO decision, 2026-09-28, replaces F19's occupancy-
    // based selection): the one active Per Night rate for this property. Fail
    // closed on zero OR more than one match — never guess, never fall back to
    // array position. This mirrors F19's own fail-closed posture, just against
    // a different ambiguity (no {Occupancy Type} to disambiguate any more).
    const allActiveRates = await airtableGet('WS_Rates', `AND({Active} = TRUE(), {Rate Type} = 'Per Night')`);
    const nightlyRates = allActiveRates.filter(r => (r.fields['Property'] || []).includes(ctx.property.id));
    const rate = nightlyRates.length === 1 ? nightlyRates[0] : null;
    // Whether a price actually got written and can be quoted. Starts false; a
    // rate-write failure below also lands here, NOT reset to AWAITING_DETAILS —
    // that would send the guest back through collectDetails with the same
    // dates, which would immediately self-block against the Enquiry booking
    // this very call already created and is holding. The booking already
    // exists either way, so the guest stays in AWAITING_ETA and the owner
    // finalises price manually, same as the zero/ambiguous-rate case.
    let priced = false;
    let quotedAmount = null; // what the owner alert reports; null = to be confirmed

    if (!rate) {
      // Zero configured, or more than one active Per Night rate for this
      // property (ambiguous — the property needs a human to sort out its own
      // rate config, this is never guessed at runtime).
      logToAxiom('warn', 'overnight_rate_lookup_not_singular', {
        phone: ctx.phone, propertyId: ctx.property.id, bookingId: booking.id, matchCount: nightlyRates.length
      });
    } else {
      // Rule 30 step 2, slice 1: FATAL on failure — this write sets the price
      // the guest is about to be told and billed, so an unchecked failure here
      // would confirm a booking at a rate that was never actually saved.
      const rateWrite = await airtableUpdate('WS_Bookings', booking.id, {
        'Rate Applied': [rate.id],
        'Amount Due': rate.fields['Amount']
      });
      if (rateWrite && rateWrite.error) {
        logToAxiom('error', 'overnight_rate_write_failed', {
          phone: ctx.phone, bookingId: booking.id, amount: rate.fields['Amount'], error: JSON.stringify(rateWrite.error)
        });
      } else {
        priced = true;
        quotedAmount = rate.fields['Amount'];
      }
    }

    // B19: logged here, at the same point the guest is actually quoted (or, in
    // the fail-closed branch, told the owner will finalise price) — CEO
    // decision, 2026-09-28. Previously logged right after creation, before any
    // price existed, so an abandoning guest was already marked Booked with no
    // quote ever sent. recordEta re-affirms on confirmation but the booking-id
    // dedup keeps it to one row.
    await logEnquiry(ctx.property, ctx.phone, 'Booked', { ...enquiryTrackingOpts(ctx),
      checkInIso, checkOutIso, bookingType: 'Overnight', bookingId: booking.id
    });

    // F7: notify owner on new booking. Moved to fire after the price is quoted
    // (CEO decision, 2026-09-28) — previously sent right after creation, before
    // the guest had any price, which meant reception got an alert for an
    // enquiry the guest might abandon before ever seeing a number.
    const newBookingTo = operationalAlertPhone(ctx.property);
    if (newBookingTo) {
      logOwnerSendWindow('new_booking', newBookingTo, ctx.phone); // B17 instrumentation
      // Rule 30 step 2, slice 2: checked but non-fatal — courtesy notification,
      // the guest already got their own quote/contact-owner reply independent
      // of this.
      const ownerSend = await sendNewBookingAlert(newBookingTo, newBookingTemplateParams({
        propertyName: ctx.property.fields['Property Name'], guestName, guestPhone: ctx.phone, bookingRef,
        bookingType: 'Overnight', checkInIso, checkOutIso, amount: quotedAmount
      }), {
        key: 'ownerNewBooking',
        vars: { guestName, phone: ctx.phone, bookingRef, checkIn, checkOut: checkOut || 'TBC' }
      }, { bookingId: booking.id });
      if (ownerSend && ownerSend.error) {
        logToAxiom('error', 'owner_new_booking_notify_failed', {
          bookingId: booking.id, error: JSON.stringify(ownerSend.error)
        });
      }
    }

    if (!priced) {
      // Session State was already advanced to AWAITING_PAYMENT_METHOD above
      // (ctx.next, written before this rate lookup ran) — no price exists to
      // ask payment for, so this downgrades straight to AWAITING_ETA instead,
      // same target the priced path reaches after payment method is chosen.
      if (!(await advanceGuestState(ctx, { 'Session State': 'AWAITING_ETA', 'Last Inbound At': new Date().toISOString() }))) return;
      await sendWhatsApp(ctx.phone, msg('occupancyContactOwner', { guestName }));
      return;
    }

    await sendWhatsApp(ctx.phone, msg('bookingReceived', {
      guestName, bookingRef, checkIn, checkOut,
      rateLine: `*Rate:* R${rate.fields['Amount']} per night`
    }));
    await sendPaymentMethodMenu(ctx);
  },

  // NEW / AWAITING_DETAILS + "HOURLY": enter the short-stay flow (closes F10 —
  // the keyword has been a placeholder since WS1 and fell through to the
  // overnight re-prompt). Wired into AWAITING_DETAILS as well as NEW because the
  // greeting that advertises HOURLY is itself what moves the guest out of NEW,
  // so almost every real guest types it from AWAITING_DETAILS.
  async startHourly(ctx) {
    const rates = guestHourlyRates(ctx.property);
    if (!rates) {
      // Property has not configured short stays — fail closed, never quote R0.
      logToAxiom('info', 'hourly_not_configured', { phone: ctx.phone, propertyId: ctx.property.id });
      if (ctx.guest) {
        await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      } else {
        // Rule 30 step 2, slice 2: same NON-FATAL class, same reasoning as
        // greetAndAskStayType's equivalent first-contact create.
        const guestCreate = await airtableCreate('WS_Guests', {
          'Guest Name': 'Unknown',
          'Phone Number': ctx.phone,
          'Guest Type': 'WhatsApp',
          'Session State': 'AWAITING_DETAILS',
          'Last Inbound At': new Date().toISOString(),
          'First Visit': new Date().toISOString().split('T')[0]
        });
        if (guestCreate && guestCreate.error) {
          logToAxiom('error', 'guest_state_write_failed', {
            phone: ctx.phone, fields: { 'Session State': 'AWAITING_DETAILS' }, error: JSON.stringify(guestCreate.error)
          });
        }
      }
      await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', {
        propertyName: ctx.property.fields['Property Name']
      }));
      return;
    }

    if (ctx.guest) {
      if (!(await advanceGuestState(ctx, { 'Session State': ctx.next, 'Last Inbound At': new Date().toISOString() }))) return;
    } else {
      // Rule 30 step 2, slice 2: same NON-FATAL class, same reasoning as
      // greetAndAskStayType's equivalent first-contact create.
      const guestCreate = await airtableCreate('WS_Guests', {
        'Guest Name': 'Unknown',
        'Phone Number': ctx.phone,
        'Guest Type': 'WhatsApp',
        'Session State': ctx.next,
        'Last Inbound At': new Date().toISOString(),
        'First Visit': new Date().toISOString().split('T')[0]
      });
      if (guestCreate && guestCreate.error) {
        logToAxiom('error', 'guest_state_write_failed', {
          phone: ctx.phone, fields: { 'Session State': ctx.next }, error: JSON.stringify(guestCreate.error)
        });
      }
    }
    await sendWhatsApp(ctx.phone, leanCopyEnabled()
      ? msg('hourlyAskDetailsLean')
      : msg('hourlyAskDetails', { propertyName: ctx.property.fields['Property Name'] }));
  },

  // AWAITING_HOURLY_DETAILS: name + arrival time, then offer the duration menu.
  // Duration is a separate state because a numbered menu cannot share a message
  // with free text — "2" must mean two hours, never part of a name or a time.
  async collectHourlyDetails(ctx) {
    // WABISTAY_STAY_MENU: the guest chose a product from the menu, so its window and price apply.
    if (stayMenuEnabled()) {
      const stayPending = await findPendingStayMenuBooking(ctx.guest.id);
      if (stayPending && (await collectStayMenuDetails(ctx, stayPending))) return;
    }

    const lines = ctx.messageText.trim().split('\n').map(l => l.trim()).filter(Boolean);
    // BUGFIX (anon-name reversion): collect whatever non-time line the guest
    // typed THIS turn first, including an explicit "anon" — same fix as
    // collectDetails above. A stored name is used only as a fallback when
    // nothing usable was typed this turn (e.g. an arrival-time-only reply),
    // never as an override of what was actually typed.
    let typedName = null;
    let arrival = null;
    let ambiguousHour = null;

    for (const line of lines) {
      const parsed = parseArrivalTime(line);
      if (parsed && parsed.ambiguous !== undefined) {
        if (ambiguousHour === null) ambiguousHour = parsed.ambiguous;
      } else if (parsed && !arrival) {
        arrival = parsed;
      } else if (!parsed && !typedName) {
        typedName = line;
      }
    }

    // WABISTAY_LEAN_COPY: a ONE-line reply ("Tim 9pm", "9pm Tim") that the line-by-line
    // pass above could not split. Accepted only when exactly one part is a time and the
    // rest is a name of at least one word; anything else falls through to the re-prompt.
    if (leanCopyEnabled() && lines.length === 1 && !arrival && ambiguousHour === null) {
      const oneLine = parseOneLineNameAndTime(lines[0]);
      if (oneLine) {
        typedName = oneLine.name;
        if (oneLine.time.ambiguous !== undefined) ambiguousHour = oneLine.time.ambiguous;
        else arrival = oneLine.time;
      }
    }

    const guestName = typedName || (ctx.guest.fields['Guest Name'] !== 'Unknown' ? ctx.guest.fields['Guest Name'] : null);

    if (!arrival && ambiguousHour !== null) {
      // Stay in AWAITING_HOURLY_DETAILS — ask which half of the clock they meant.
      await sendWhatsApp(ctx.phone, msg('hourlyTimeAmbiguous', { value: ambiguousHour }));
      return;
    }
    if (!guestName || !arrival) {
      await sendWhatsApp(ctx.phone, msg(leanCopyEnabled() ? 'hourlyDetailsRepromptLean' : 'hourlyDetailsReprompt'));
      return;
    }

    // An arrival time already past today means the next occurrence of that time,
    // same principle as B7's year-roll: guests book the future, and a bookable
    // answer beats a re-prompt. The confirmation always states the full date, so
    // a roll to tomorrow is visible rather than silent.
    const now = new Date();
    const today = sastCalendarDate(now);
    let arrivalDate = today;
    if (Date.parse(sastToUtcIso(today, arrival.hour, arrival.minute)) <= now.getTime()) {
      arrivalDate = addSastDays(today, 1);
    }
    const checkInIso = sastToUtcIso(arrivalDate, arrival.hour, arrival.minute);

    const rates = guestHourlyRates(ctx.property);
    if (!rates) {
      // Rates removed mid-conversation — same fail-closed redirect as entry.
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', { propertyName: ctx.property.fields['Property Name'] }));
      return;
    }

    if (!(await advanceGuestState(ctx, {
      'Guest Name': guestName,
      'Session State': ctx.next,
      'Last Inbound At': new Date().toISOString() // B19: staleness anchor for the abandonment sweep
    }))) return;

    // The duration menu arrives as a separate WhatsApp message — a separate
    // serverless invocation with no shared memory — so the arrival time has to
    // be persisted. It goes on a booking record rather than scratch storage,
    // the same way WS1 parks the ETA: this row IS the guest's booking, just not
    // yet priced. With Check Out still blank it holds no room and blocks
    // nothing (B8's blank-date rule), so an abandoned one is inert rather than
    // phantom inventory. Reused rather than duplicated if the guest re-enters
    // a time after being told there is no availability.
    const pending = await findPendingHourlyBooking(ctx.guest.id);
    const bookingResult = pending
      ? await airtableUpdate('WS_Bookings', pending.id, { 'Check In': checkInIso })
      : await airtableCreate('WS_Bookings', {
          'Guest': [ctx.guest.id],
          'Booking Type': 'Hourly',
          'Source': 'WhatsApp',
          'Status': 'Enquiry',
          'Logged By': 'WhatsApp Bot',
          'Check In': checkInIso,
          'Payment Status': 'Unpaid'
        });

    // F41-4: same unchecked-write pattern as collectDetails, same fix shape.
    // Previously this return value was discarded entirely — a failed write
    // left the guest advanced to AWAITING_HOURLY_DURATION with no pending row
    // behind it. selectHourlyDuration's own missing-checkInIso guard would
    // eventually catch this on the guest's NEXT message, but silently — no
    // log, no explanation, a round-trip of confusion before self-healing.
    if (!bookingResult || !bookingResult.id) {
      logToAxiom('error', 'hourly_booking_write_failed', {
        phone: ctx.phone, guestName,
        error: bookingResult && bookingResult.error ? JSON.stringify(bookingResult.error) : null
      });
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      await sendWhatsApp(ctx.phone, msg('hourlyBookingCreateFailed', { guestName }));
      return;
    }

    await sendWhatsApp(ctx.phone, msg('hourlyDurationMenu', {
      guestName,
      arrivalText: formatSastDateTime(checkInIso),
      durationLines: hourlyDurationLines(rates)
    }));
  },

  // AWAITING_HOURLY_DURATION: 1/2/3 creates the booking; 4+ redirects to overnight.
  async selectHourlyDuration(ctx) {
    const choice = Number(ctx.text.replace(/\s*(hours?|hrs?)\s*$/, '').trim());
    const pending = await findPendingHourlyBooking(ctx.guest.id);
    const rates = guestHourlyRates(ctx.property);

    if (choice > 3 && Number.isInteger(choice)) {
      // Locked decision: >3hr is an overnight stay, not an error and not a
      // fourth hourly option. Cancel the half-built hourly booking on the way
      // out so the guest does not end up with two open Enquiry rows, which
      // would make recordEta ambiguous about which one to confirm.
      // Rule 30 step 2, slice 1: checked but non-fatal, same shape as the
      // rollback writes elsewhere in this handler — cancelling a half-built
      // hold is cleanup, not the guest's actual outcome (they're being
      // redirected to overnight regardless), so a failed cancel is logged
      // loud rather than blocking the redirect.
      if (pending) {
        const cancelWrite = await airtableUpdate('WS_Bookings', pending.id, { 'Status': 'Cancelled' });
        if (cancelWrite && cancelWrite.error) {
          logToAxiom('error', 'hourly_redirect_cancel_failed', {
            phone: ctx.phone, bookingId: pending.id, error: JSON.stringify(cancelWrite.error)
          });
        }
      }
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      logToAxiom('info', 'hourly_redirect_overnight', { phone: ctx.phone, requestedHours: choice });
      await sendWhatsApp(ctx.phone, msg('hourlyTooLong'));
      return;
    }

    const checkInIso = pending && pending.fields['Check In'];
    if (!Number.isInteger(choice) || choice < 1 || !offeredHourlyDurations().includes(choice) || !checkInIso || !rates) {
      // Unreadable choice, or the flow lost its footing (no pending booking,
      // rates pulled mid-conversation), or a duration that is not on offer
      // (1 hour while WABISTAY_HIDE_ONE_HOUR is on). Re-offer rather than dead-end;
      // nothing is booked.
      if (choice === 1 && hideOneHourEnabled()) {
        logToAxiom('info', 'hourly_one_hour_hidden_reply', { phone: ctx.phone });
      }
      if (!checkInIso || !rates) {
        await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
        await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', { propertyName: ctx.property.fields['Property Name'] }));
        return;
      }
      await sendWhatsApp(ctx.phone, msg('hourlyDurationMenu', {
        guestName: ctx.guest.fields['Guest Name'],
        arrivalText: formatSastDateTime(checkInIso),
        durationLines: hourlyDurationLines(rates)
      }));
      return;
    }

    const checkOutIso = addHoursToIso(checkInIso, choice);
    const amount = rates[choice];
    const guestName = ctx.guest.fields['Guest Name'];

    // Same availability helper as overnight, unforked — this is what makes an
    // hourly booking block an overnight one on the same room and vice versa.
    const room = await findAvailableRoom(ctx.property.id, checkInIso, checkOutIso);
    if (!room) {
      logToAxiom('info', 'hourly_no_availability', {
        phone: ctx.phone, propertyId: ctx.property.id, checkIn: checkInIso, checkOut: checkOutIso
      });
      // Booking stays pending with Check Out blank — inert, and reused when the
      // guest offers a different time.
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_HOURLY_DETAILS', 'Last Inbound At': new Date().toISOString() });
      // B19: B9's hourly availability check refused — turned away, Hourly.
      await logEnquiry(ctx.property, ctx.phone, 'No Availability', { ...enquiryTrackingOpts(ctx),
        checkInIso, checkOutIso, bookingType: 'Hourly'
      });
      await sendNoRoomMessage(ctx, 'hourly_duration');
      return;
    }

    // Completes the pending row rather than creating a second one: Check Out and
    // the room hold are what turn it from inert into a real, blocking booking.
    const bookingRef = `WS-${pending.id.slice(-6).toUpperCase()}`;
    // Rule 30 step 2, slice 1: FATAL on failure — this is the write that sells
    // the room and sets the price (Amount Due), the hourly-flow analog of
    // walkinBooking's checked create (F40). Checked BEFORE the stillFree
    // re-check below: if this write never landed, there is nothing to
    // re-verify or roll back, and running that check anyway would misreport
    // a race loss for what is actually a write failure.
    const confirmWrite = await airtableUpdate('WS_Bookings', pending.id, {
      'Check Out': checkOutIso,
      'Room': [room.id],
      'Booking Ref': bookingRef,
      // The row was created as 'Enquiry' (a half-built hold) and this is the
      // point it becomes a real booking — so it must reach 'Confirmed' here, the
      // same status recordEta gives an overnight booking when its session moves
      // to CONFIRMED. Leaving it 'Enquiry' broke the invariant that a CONFIRMED
      // session has a Confirmed booking, and both `cancelBooking` and
      // `gateArrival` query strictly on 'Confirmed': the guest was told their
      // booking was cancelled while the row survived, still holding its room via
      // BLOCKING_BOOKING_STATUSES, and an arriving guest matched no booking and
      // fell through to the legacy first-available-room branch.
      'Status': 'Confirmed',
      'Notes': `Short stay: ${durationText(choice)} from ${formatSastDateTime(checkInIso)}`,
      // Doc 1b PR 6: hold until 30 minutes after the arrival time (WABISTAY_HOLD_RELEASE).
      ...(holdReleaseEnabled() ? { 'Hold Expires At': holdExpiryIso(checkInIso) } : {}),
      // Amount Due carries the price. Rate Applied is deliberately left empty:
      // it links to WS_Rates, and hourly prices live as WS_Properties fields,
      // which cannot be linked to. Blank, not dangling — B17 aggregates on
      // Amount Due, which is populated for every booking type.
      'Amount Due': amount
    });
    if (confirmWrite && confirmWrite.error) {
      logToAxiom('error', 'hourly_confirm_write_failed', {
        phone: ctx.phone, bookingId: pending.id, roomId: room.id, amount,
        error: JSON.stringify(confirmWrite.error)
      });
      await sendWhatsApp(ctx.phone, msg('hourlyBookingCreateFailed', { guestName }));
      return;
    }

    // P1a: the write above is what puts this booking on the room (Room + Status
    // Confirmed in one call) — no intermediate Enquiry step the way overnight
    // has, so this is the SAME moment overnight's create happens, just phrased
    // as an update to the pending row. Same race, same fix: re-verify excluding
    // this booking's own hold before treating the room as genuinely secured.
    const stillFree = await findAvailableRoom(ctx.property.id, checkInIso, checkOutIso, {
      excludeBookingId: pending.id, preferRoomId: room.id
    });
    if (!stillFree || stillFree.id !== room.id) {
      const rollback = await airtableUpdate('WS_Bookings', pending.id, { 'Status': 'Cancelled' });
      if (rollback && rollback.error) {
        logToAxiom('error', 'booking_rollback_failed', {
          phone: ctx.phone, bookingId: pending.id, roomId: room.id,
          error: JSON.stringify(rollback.error),
          reason: 'lost the availability race AND the Cancelled write failed — booking may still be holding a contested room'
        });
      }
      // Same re-offer the existing no-availability branch above uses (line
      // ~2139) — the booking stays inert with Check Out cleared conceptually
      // by virtue of being Cancelled, and the guest can offer a different time.
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_HOURLY_DETAILS', 'Last Inbound At': new Date().toISOString() });
      logToAxiom('warn', 'booking_race_lost', {
        phone: ctx.phone, bookingId: pending.id, roomId: room.id,
        checkIn: checkInIso, checkOut: checkOutIso,
        reason: 'room taken by a concurrent booking between the pre-check and this update'
      });
      await logEnquiry(ctx.property, ctx.phone, 'No Availability', { ...enquiryTrackingOpts(ctx),
        checkInIso, checkOutIso, bookingType: 'Hourly'
      });
      await sendNoRoomMessage(ctx, 'hourly_duration_recheck');
      return;
    }

    logToAxiom('info', 'booking_create', {
      phone: ctx.phone, guestName, bookingRef, bookingType: 'Hourly',
      hours: choice, airtableId: pending.id
    });

    // The booking is already Confirmed and holding its room at this point, so a
    // tripped guard here leaves a hold the guest was never told about — the
    // alert carries the booking id so reception can finish or cancel it.
    if (!(await advanceGuestState(ctx, { 'Session State': ctx.next, 'Last Inbound At': new Date().toISOString() }, { bookingId: pending.id, bookingRef }))) return;
    await supersedeOlderBookings(ctx, { id: pending.id, checkIn: checkInIso, ref: bookingRef, stay: `${choice} hour short stay` });
    // B19: Booked, Hourly. Completed in one handler, so this is the single log site.
    await logEnquiry(ctx.property, ctx.phone, 'Booked', { ...enquiryTrackingOpts(ctx),
      checkInIso, checkOutIso, bookingType: 'Hourly', bookingId: pending.id
    });

    const view = {
      guestName, bookingRef, amount,
      durationText: durationText(choice),
      checkInText: formatSastDateTime(checkInIso),
      checkOutText: formatSastDateTime(checkOutIso)
    };
    const hourlyBookingTo = operationalAlertPhone(ctx.property);
    if (hourlyBookingTo) {
      logOwnerSendWindow('hourly_new_booking', hourlyBookingTo, ctx.phone); // B17 instrumentation
      // Rule 30 step 2, slice 2: checked but non-fatal, same shape as
      // collectDetails' equivalent owner notify.
      const ownerSend = await sendNewBookingAlert(hourlyBookingTo, newBookingTemplateParams({
        propertyName: ctx.property.fields['Property Name'], guestName, guestPhone: ctx.phone, bookingRef,
        bookingType: 'Hourly', checkInIso, checkOutIso, hours: choice, amount
      }), {
        key: 'hourlyOwnerNewBooking',
        vars: { ...view, phone: ctx.phone }
      }, { bookingId: pending.id });
      if (ownerSend && ownerSend.error) {
        logToAxiom('error', 'owner_hourly_booking_notify_failed', {
          bookingId: pending.id, error: JSON.stringify(ownerSend.error)
        });
      }
    }
    await sendWhatsApp(ctx.phone, msg('hourlyBookingReceived', view));
    await sendPaymentMethodMenu(ctx);
  },

  // AWAITING_PAYMENT_METHOD (payment build, CEO 2026-09-29): guest chooses
  // Card (paid on SpeedPoint at reception) or Instant EFT (paid at
  // reception, funds confirmed by reception via PAID). Reached only from a
  // PRICED quote (bookingReceived / hourlyBookingReceived) — the fail-closed
  // "owner will finalise price" path has no amount to ask payment for, so it
  // skips straight to AWAITING_ETA and never reaches this state.
  //
  // No room or key is handed over here or anywhere in this handler — that is
  // the whole point of the design. This only records which method the guest
  // intends and, for EFT, generates the reference reception will later
  // confirm via `PAID REF`. The actual confirmation is a separate, later,
  // staff-only action (paidBooking) — never triggered by anything the guest
  // says here, including the word "paid" itself.
  async selectPaymentMethod(ctx) {
    const CARD_CHOICES = ['1', 'card'];
    const EFT_CHOICES = ['2', 'eft', 'instant eft'];
    const guestName = ctx.guest.fields['Guest Name'];

    if (!CARD_CHOICES.includes(ctx.text) && !EFT_CHOICES.includes(ctx.text)) {
      await sendWhatsApp(ctx.phone, msg('paymentMethodReprompt'));
      return;
    }

    // The pending priced booking — collectDetails/selectHourlyDuration both
    // write Amount Due before advancing here, so its presence is what marks
    // "the booking this payment step is for" (the fail-closed unpriced case
    // never reaches this state at all, per the header comment above).
    // Overnight is still 'Enquiry' at this point; hourly is already
    // 'Confirmed' (selectHourlyDuration's own write, no intermediate Enquiry
    // step for hourly — see that handler's P1a comment) — both are checked.
    const [enquiries, confirmedHourly] = await Promise.all([
      airtableGetBookingsByGuestId(ctx.guest.id, 'Enquiry'),
      airtableGetBookingsByGuestId(ctx.guest.id, 'Confirmed')
    ]);
    const pricedConfirmed = b => (b.fields['Booking Type'] === 'Hourly' || isStayMenuBooking(b)) && b.fields['Amount Due'] !== undefined;
    // ONE_OPEN_BOOKING: the booking being paid for is the one this chat has just created, so the NEWEST priced one. (The
    // gate's nearest-to-now rule would pick the older 16:00 short stay over an overnight stamped 14:00 the same day.)
    const booking = oneOpenBookingEnabled()
      ? (newestFirst([...enquiries.filter(b => b.fields['Amount Due'] !== undefined), ...confirmedHourly.filter(pricedConfirmed)])[0] || null)
      : (enquiries.find(b => b.fields['Amount Due'] !== undefined)
        || confirmedHourly.find(pricedConfirmed)
        || null);
    if (!booking) {
      // Flow lost its footing (no pending priced enquiry) — re-prompt rather
      // than dead-end, zero writes. Mirrors selectOccupancy's old posture.
      await sendWhatsApp(ctx.phone, msg('paymentMethodReprompt'));
      return;
    }

    // Hourly already captured its arrival time in collectHourlyDetails, so it
    // goes straight to the gate-arrival menu; overnight still needs to ask.
    // Hourly bookings and bookings made through the stay menu are already Confirmed with an arrival time,
    // so they go straight to CONFIRMED; only today's typed-dates overnight asks for an ETA next.
    const isHourly = booking.fields['Booking Type'] === 'Hourly' || isStayMenuBooking(booking);
    const nextState = isHourly ? 'CONFIRMED' : 'AWAITING_ETA';

    if (CARD_CHOICES.includes(ctx.text)) {
      const write = await airtableUpdate('WS_Bookings', booking.id, { 'Payment Method': 'Card' });
      if (write && write.error) {
        logToAxiom('error', 'payment_method_write_failed', {
          phone: ctx.phone, bookingId: booking.id, method: 'Card', error: JSON.stringify(write.error)
        });
      }
      if (!(await advanceGuestState(ctx, { 'Session State': nextState, 'Last Inbound At': new Date().toISOString() }, { bookingId: booking.id }))) return;
      await sendWhatsApp(ctx.phone, msg('paymentCardChosen'));
      await sendWhatsApp(ctx.phone, isHourly ? confirmedMenuMessage(ctx.property, guestName) : msg('askEta'));
      return;
    }

    // EFT: generate the reference reception will later match on via
    // `PAID REF`. Rule 30 posture — FATAL-ish but not blocking: if the write
    // fails, the guest is still told a reference (so they can act on it),
    // but the failure is logged loud since an un-persisted reference can
    // never be matched by PAID REF later — reception's confirmation would
    // silently fail to find anything.
    const reference = await generateUniquePaymentReference();
    const write = await airtableUpdate('WS_Bookings', booking.id, {
      'Payment Method': 'EFT',
      'Payment Reference': reference
    });
    if (write && write.error) {
      logToAxiom('error', 'payment_reference_write_failed', {
        phone: ctx.phone, bookingId: booking.id, reference, error: JSON.stringify(write.error)
      });
    }
    if (!(await advanceGuestState(ctx, { 'Session State': nextState, 'Last Inbound At': new Date().toISOString() }, { bookingId: booking.id }))) return;

    const property = await (async () => {
      const roomId = (booking.fields['Room'] || [])[0];
      if (roomId) {
        const rooms = await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`);
        const propId = rooms[0] && (rooms[0].fields['Property'] || [])[0];
        if (propId) {
          const props = await airtableGet('WS_Properties', `RECORD_ID() = '${propId}'`);
          if (props[0]) return props[0];
        }
      }
      return ctx.property; // defensive fallback only — both booking types have a room by this point in practice
    })();
    const bankDetails = property.fields['EFT Bank Details'];
    const bankDetailsBlock = bankDetails ? bankDetails : msg('paymentEftBankDetailsFallback');

    // WABISTAY_LEAN_COPY: the shorter instant-EFT message (same placeholders, same bank-details fallback line).
    await sendWhatsApp(ctx.phone, msg(leanCopyEnabled() ? 'paymentEftConfirmedLean' : 'paymentEftConfirmed', {
      amount: formatAmount(booking.fields['Amount Due']),
      reference,
      bankDetailsBlock
    }));
    await sendWhatsApp(ctx.phone, isHourly ? confirmedMenuMessage(ctx.property, guestName) : msg('askEta'));
  },

  // AWAITING_ETA: record ETA, confirm booking
  async recordEta(ctx) {
    const eta = ctx.messageText.trim();
    // F5: was FIND/ARRAYJOIN — now JS filter on fetched records
    const bookings = byNewest(await airtableGetBookingsByGuestId(ctx.guest.id, 'Enquiry'));
    const confirmedBooking = bookings[0] || null;
    // Rule 30 step 2, slice 1: FATAL on failure — this write is what moves the
    // booking from 'Enquiry' to 'Confirmed', and both cancelBooking and
    // gateArrival query strictly on 'Confirmed' (same invariant selectHourlyDuration's
    // comment above already documents). A failed write here left silently would
    // tell the guest their stay is confirmed while the booking stays invisible
    // to both of those handlers. Session State is deliberately NOT advanced on
    // failure, so the guest's next ETA message retries the same write.
    if (confirmedBooking) {
      const etaFields = { 'ETA': eta, 'Status': 'Confirmed' };
      // Doc 1b PR 6: hold until 30 minutes after the ETA the guest just gave.
      if (holdReleaseEnabled() && confirmedBooking.fields['Check In']) {
        etaFields['Hold Expires At'] = overnightHoldExpiryIso(confirmedBooking.fields['Check In'], eta);
      }
      const etaWrite = await airtableUpdate('WS_Bookings', confirmedBooking.id, etaFields);
      if (etaWrite && etaWrite.error) {
        logToAxiom('error', 'eta_confirm_write_failed', {
          phone: ctx.phone, bookingId: confirmedBooking.id, error: JSON.stringify(etaWrite.error)
        });
        await sendWhatsApp(ctx.phone, msg('etaWriteFailed'));
        return;
      }
    }
    if (!(await advanceGuestState(ctx, {
      'Session State': ctx.next,
      ...(enquiryTrackingEnabled() && !isTestGuest(ctx.guest) ? { 'Last Inbound At': new Date().toISOString() } : {})
    }))) return;
    if (confirmedBooking) {
      await supersedeOlderBookings(ctx, {
        id: confirmedBooking.id, checkIn: confirmedBooking.fields['Check In'],
        ref: confirmedBooking.fields['Booking Ref'] || `WS-${confirmedBooking.id.slice(-6).toUpperCase()}`, stay: 'overnight'
      });
    }
    // B19: Booked, re-affirmed on confirmation — deduped by booking id, so this is
    // a no-op when collectDetails already logged it at creation, and the single
    // logging site when the booking reached AWAITING_ETA another way.
    if (confirmedBooking) {
      await logEnquiry(ctx.property, ctx.phone, 'Booked', { ...enquiryTrackingOpts(ctx),
        bookingType: confirmedBooking.fields['Booking Type'] || 'Overnight',
        bookingId: confirmedBooking.id
      });
    }
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'AWAITING_ETA', to: ctx.next, eta });
    await sendWhatsApp(ctx.phone, msg('etaConfirmed', { eta, propertyName: ctx.property.fields['Property Name'], addressBlock: guestAddressBlock(ctx.property) }));
  },

  // CONFIRMED → "1": gate arrival (F11)
  async gateArrival(ctx) {
    // Step 1: notify phone from ctx.property (resolved once at dispatch — 6.4,
    // no second WS_Properties call needed), fallback to OWNER_PHONE
    const notifyPhone = ctx.property.fields['Notify Phone']
      ? ctx.property.fields['Notify Phone'].replace(/[\s\-\+]/g, '')
      : OWNER_PHONE;

    // Step 2: settle which room this guest actually gets.
    // F5-style: see greetAndAskStayType — FIND/ARRAYJOIN confirmed unreliable, JS-filter instead
    const bookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Confirmed');
    const booking = oneOpenBookingEnabled() ? pickNearestOpenBooking(bookings) : (bookings[0] || null);
    // WABISTAY_GATE_REQUIRES_BOOKING: nothing to arrive for. No room, no check-in, no alert.
    if (!booking && gateRequiresBookingEnabled()) {
      logToAxiom('info', 'gate_arrival_no_booking', { phone: ctx.phone, guestId: ctx.guest.id });
      await sendWhatsApp(ctx.phone, msg('gateNoBooking'));
      await updateGuestState(ctx.guest.id, { 'Session State': 'NEW' });
      if (ctx.gateResult) ctx.gateResult.outcome = 'no_booking';
      return;
    }
    const heldRoomId = (booking && (booking.fields['Room'] || [])[0]) || null;
    const bookedIn = booking && booking.fields['Check In'];
    const bookedOut = booking && booking.fields['Check Out'];

    // B9: refuse a gate arrival before the booking's own check-in date. Without
    // this a guest could check in days early and take a room they had not booked
    // (observed live during B8 testing). Compared at SAST day granularity, and
    // deliberately one-sided — only a FUTURE check-in is refused. A guest who is
    // late is still a guest: turning them away at the gate would be worse than
    // the bug. Day granularity also avoids refusing someone who booked "today"
    // at 23:30 and arrives at 00:30, now technically the next day.
    if (bookedIn) {
      const bookedDate = sastCalendarDate(new Date(Date.parse(bookedIn)));
      const todayDate = sastCalendarDate(new Date());
      if (compareYmd(bookedDate, todayDate) > 0) {
        logToAxiom('info', 'gate_arrival_too_early', {
          phone: ctx.phone, bookingId: booking.id, checkIn: bookedIn
        });
        // No writes, no state change — the booking is untouched and the guest
        // can still arrive on the right day.
        await sendWhatsApp(ctx.phone, msg('gateTooEarly', {
          guestName: ctx.guest.fields['Guest Name'],
          bookingDate: formatSastDateTime(bookedIn)
        }));
        if (ctx.gateResult) ctx.gateResult.outcome = 'too_early';
        return;
      }
    }

    // Payment build (CEO decision, 2026-09-29, copy corrected 2026-09-29): the
    // guest is already on the property at this point — this withholds the KEY,
    // not entry. Nothing here or anywhere else in this codebase models a
    // physical gate/lock, so there is no separate "entry" mechanism to
    // withhold in the first place; this gate's only real effect is that no
    // room gets assigned and the booking doesn't reach Checked In until
    // reception confirms payment via PAID/PAID REF — never on anything the
    // guest says here, including "I'm at the gate" itself. Gated on the
    // booking actually being priced: the fail-closed "owner will finalise
    // price" path (occupancyContactOwner) has no Amount Due to have been
    // confirmed against, so it is deliberately let through unchanged, same
    // as it already was before this build.
    if (booking && Number(booking.fields['Amount Due']) > 0 && booking.fields['Payment Status'] !== 'Paid') {
      const tapAt = new Date().toISOString();
      logToAxiom('info', 'gate_arrival_payment_not_confirmed', {
        phone: ctx.phone, bookingId: booking.id, amountDue: booking.fields['Amount Due']
      });
      // No writes, no state change (CEO requirement): the guest can send
      // "I'm at the gate" again after paying, and this same check re-runs
      // fresh — nothing about this turn is remembered or needs undoing.
      await sendWhatsApp(ctx.phone, msg(payAssignsRoomEnabled() ? 'paymentNotYetConfirmedAuto' : 'paymentNotYetConfirmed', {
        guestName: ctx.guest.fields['Guest Name']
      }));
      // Tell the office the guest is on their way to it. After the guest's reply
      // and fenced off, so an alert problem can never cost the guest their answer.
      if (gateAlertUnpaidEnabled()) {
        try {
          await alertUnpaidGateArrival(ctx, booking, heldRoomId, notifyPhone);
        } catch (err) {
          logToAxiom('error', 'gate_alert_unpaid_failed', { phone: ctx.phone, bookingId: booking.id, message: err.message });
        }
      }
      // Lost-enquiry tracking: remember the FIRST unpaid tap on this booking, so
      // the sweep can tell when nobody has dealt with the guest 15 minutes later.
      // One non-fatal timestamp write, after the guest's reply and the alert, in its
      // own try/catch: it can never block or delay either. Not for test phones.
      // WABISTAY_PAY_ASSIGNS_ROOM also needs the tap remembered (test phones and tracking off included),
      // because that is how reception's payment finds a guest who is waiting.
      if (((enquiryTrackingEnabled() && !isTestGuest(ctx.guest)) || payAssignsRoomEnabled()) && !booking.fields['Gate Tap At']) {
        try {
          const tapWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Gate Tap At': tapAt });
          if (tapWrite && tapWrite.error) {
            logToAxiom('error', 'gate_tap_stamp_write_failed', { bookingId: booking.id, error: JSON.stringify(tapWrite.error) });
          }
        } catch (err) {
          logToAxiom('error', 'gate_tap_stamp_write_failed', { bookingId: booking.id, message: err.message });
        }
      }
      if (ctx.gateResult) ctx.gateResult.outcome = 'unpaid';
      return;
    }

    let room = null;
    if (bookedIn && bookedOut) {
      // B8: re-verify the hold rather than trust it. Airtable is not
      // transactional (CLAUDE.md), so the room held at enquiry may have been
      // taken since. preferRoomId returns the held room when it is still free
      // and re-offers a different one when it is not — never fails silently.
      room = await findAvailableRoom(ctx.property.id, bookedIn, bookedOut, {
        excludeBookingId: booking.id,
        preferRoomId: heldRoomId
      });
      if (heldRoomId && room && room.id !== heldRoomId) {
        logToAxiom('warn', 'held_room_reassigned', {
          phone: ctx.phone, bookingId: booking.id,
          heldRoomId, reassignedTo: room.id, reason: 'held room taken before arrival'
        });
      } else if (heldRoomId && !room) {
        logToAxiom('warn', 'held_room_lost_no_alternative', {
          phone: ctx.phone, bookingId: booking.id, heldRoomId
        });
      }
    } else {
      // No range to check against: a booking created before B8 (no hold, no
      // dates), or none at all. Falls through to the original F11 behaviour —
      // first physically-available room. Fixtures 06 and 07 hold this path.
      // Shared helper (getGuestVisibleAvailableRooms) — same allowlist as
      // findAvailableRoom, and now the same one the greeting's room count uses.
      const availableRooms = await getGuestVisibleAvailableRooms(ctx.property.id);
      room = availableRooms[0] || null;
    }

    // Gate-time room check (WABISTAY_GATE_ROOM_CHECK): whichever path picked the room
    // above — the held one, a reassignment, or the legacy fallback — it is only
    // assigned if it is Available right now. Otherwise nothing is written (room,
    // booking and guest state stay exactly as they were) and the guest's next tap
    // re-runs this whole check. The guest's answer goes first; the alerts are fenced
    // off so a problem there can never cost the guest their reply.
    if (room && (gateRoomCheckEnabled() || ctx.autoCheckIn) && room.fields['Status'] !== 'Available') {
      logToAxiom('info', 'gate_room_not_ready', {
        phone: ctx.phone, bookingId: booking ? booking.id : null, roomId: room.id,
        roomName: room.fields['Room Name'], roomStatus: room.fields['Status'] || null,
        heldRoomId, held: !!heldRoomId && room.id === heldRoomId
      });
      const notReadySend = await sendWhatsApp(ctx.phone, msg('gateRoomNotReady', { guestName: ctx.guest.fields['Guest Name'] }));
      if (ctx.gateResult) Object.assign(ctx.gateResult, { outcome: 'room_not_ready', roomName: room.fields['Room Name'], roomStatus: room.fields['Status'] || 'Unknown', guestSendError: !!(notReadySend && notReadySend.error) });
      try {
        await alertRoomNotReadyAtGate(ctx, booking, room, notifyPhone);
      } catch (err) {
        logToAxiom('error', 'gate_room_not_ready_alert_failed', {
          phone: ctx.phone, bookingId: booking ? booking.id : null, message: err.message
        });
      }
      return;
    }

    const assignedRoomId = room ? room.id : null;
    const assignedRoomName = room ? room.fields['Room Name'] : null;
    // Captured BEFORE Step 3 flips the room to Occupied, so reception sees the
    // state the room was actually in when the guest arrived (e.g. Cleaning),
    // not the Occupied this very check-in is about to write.
    const assignedRoomStatus = room ? (room.fields['Status'] || 'Unknown') : 'N/A';

    // Step 3: room → Occupied. Now it really is occupancy, not a hold.
    // Rule 30 step 2, slice 1: checked but non-fatal — Status is a derived
    // display field here too, not findAvailableRoom's source of truth, so a
    // failure fails safe (room reads as still-available rather than sold).
    if (assignedRoomId) {
      const roomWrite = await airtableUpdate('WS_Rooms', assignedRoomId, { 'Status': 'Occupied' });
      if (roomWrite && roomWrite.error) {
        logToAxiom('error', 'gate_arrival_room_status_write_failed', {
          phone: ctx.phone, roomId: assignedRoomId, error: JSON.stringify(roomWrite.error)
        });
      }
    }

    // Step 4: booking → Checked In + link room + timestamp
    // Rule 30 step 2, slice 1: FATAL on failure — this is the write that
    // actually checks the guest in. A silent failure here would welcome a
    // guest into a room with no Checked-In record behind it, and Step 6b's
    // cleaner dispatch / Step 7's welcome message would both be false
    // positives. Everything past this point is skipped on failure.
    if (booking) {
      // Race guard (CEO decision, 2026-09-28, same class of fix as extendStay's
      // PR3/PR3b — see that action's own comment for the full reasoning).
      // `booking` was read back at Step 2, before Steps 2-3's several
      // sequential Airtable calls (findAvailableRoom's own availability
      // re-verification, the room status write) — real wall-clock time in
      // which a genuinely concurrent duplicate delivery of this same
      // gate-arrival message (Meta's at-least-once retry, landing before this
      // invocation's first response reaches Meta) can complete its own
      // check-in. Fresh re-read, immediately before the write that actually
      // checks the guest in: if this booking is no longer 'Confirmed', a
      // concurrent invocation already checked it in — stand down rather than
      // re-running check-in, double-assigning a room, or double-notifying the
      // owner/cleaner. Silent, not a guest send: whichever invocation won
      // already delivered the welcome message, and this is Meta's own
      // duplicate of a message the guest only sent once.
      const freshBookingCheck = await airtableGet('WS_Bookings', `RECORD_ID() = '${booking.id}'`);
      const stillConfirmed = freshBookingCheck[0] && freshBookingCheck[0].fields['Status'] === 'Confirmed';
      if (!stillConfirmed) {
        logToAxiom('warn', 'gate_arrival_skipped_already_checked_in', {
          phone: ctx.phone, bookingId: booking.id,
          currentStatus: freshBookingCheck[0] ? freshBookingCheck[0].fields['Status'] : null
        });
        if (ctx.gateResult) ctx.gateResult.outcome = 'already_checked_in';
        return;
      }

      const bookingUpdate = {
        'Status': 'Checked In',
        'Checked In At': new Date().toISOString()
      };
      if (assignedRoomId) bookingUpdate['Room'] = [assignedRoomId];
      // B10.5 Bug 2: persist the property on the booking. Check-in is where the
      // property is first known for certain (ctx.property is already resolved
      // from the inbound phone_number_id), so both checkout paths can scope off
      // the record instead of re-deriving it. Single-record link → one-element array.
      bookingUpdate['WS_Property'] = [ctx.property.id];
      const checkInWrite = await airtableUpdate('WS_Bookings', booking.id, bookingUpdate);
      if (checkInWrite && checkInWrite.error) {
        logToAxiom('error', 'gate_arrival_checkin_write_failed', {
          phone: ctx.phone, bookingId: booking.id, error: JSON.stringify(checkInWrite.error)
        });
        await sendWhatsApp(ctx.phone, msg('gateArrivalWriteFailed'));
        if (ctx.gateResult) ctx.gateResult.outcome = 'write_failed';
        return;
      }
    }

    // Step 5: session → CHECKED_IN
    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'CONFIRMED', to: ctx.next, assignedRoom: assignedRoomName || null });

    // Step 6: notify party
    if (notifyPhone) {
      logOwnerSendWindow('gate_arrival', notifyPhone, ctx.phone); // B17 instrumentation
      // Rule 30 step 2, slice 2: checked but non-fatal — courtesy notification.
      // notifyCleanerOfArrival (Step 6b, right after) is the operationally
      // load-bearing dispatch and already checks its own send properly.
      const ownerSend = await sendWhatsApp(notifyPhone, msg('gateNotify', {
        guestName: ctx.guest.fields['Guest Name'],
        roomInfo: assignedRoomName
          ? msg('gateRoomAssignedInfo', { roomName: assignedRoomName })
          : msg('gateNoRoomInfo'),
        roomStatus: assignedRoomStatus,
        phone: ctx.phone
      }));
      if (ownerSend && ownerSend.error) {
        logToAxiom('error', 'gate_arrival_notify_failed', {
          bookingId: booking ? booking.id : null, error: JSON.stringify(ownerSend.error)
        });
      }
    }

    // Step 6a: Reception seats, by template. Outside the notifyPhone branch on
    // purpose — a property with no Notify Phone still has Reception to tell.
    await notifyReceptionOfArrival({
      propertyId: ctx.property.id,
      propertyName: ctx.property.fields['Property Name'],
      guestName: ctx.guest.fields['Guest Name'],
      roomName: assignedRoomName || 'an unassigned room',
      roomStatus: assignedRoomStatus,
      guestPhone: ctx.phone
    });

    // Step 6b: notify the property's cleaner. IN ADDITION to the owner send
    // above, never instead of it — the owner still gets `gateNotify` unchanged.
    // Scoped by ctx.property.id, which IS this booking's WS_Property: Step 4 above
    // writes `WS_Property: [ctx.property.id]` unconditionally, so the two agree by
    // construction. Deliberately NOT bookingPropertyId(booking, ...) here — that
    // reads the copy fetched at Step 2, BEFORE the Step 4 write, so a booking
    // carrying a stale link from a previous check-in at another property would
    // scope the cleaner to the old property while the record was updated to the
    // new one. The checkout paths have no such authority (no inbound property is
    // being written there) and correctly keep using bookingPropertyId.
    const propertyNameForCleaner = ctx.property.fields['Property Name'];
    await notifyCleanerOfArrival({
      propertyId: ctx.property.id,
      bookingId: booking ? booking.id : null,
      propertyName: propertyNameForCleaner,
      guestName: ctx.guest.fields['Guest Name'],
      roomName: assignedRoomName,
      guestPhone: ctx.phone
    });

    // Step 7: tell guest
    const propertyName = ctx.property.fields['Property Name'];
    const welcomeSend = await sendWhatsApp(ctx.phone, assignedRoomName
      ? msg('welcomeAssigned', { roomName: assignedRoomName, propertyName })
      : msg('welcomeUnassigned', { propertyName }));
    if (ctx.gateResult) Object.assign(ctx.gateResult, { outcome: 'checked_in', roomName: assignedRoomName, guestSendError: !!(welcomeSend && welcomeSend.error) });
  },

  // CONFIRMED → "2": cancel
  async cancelBooking(ctx) {
    // F5: was FIND/ARRAYJOIN
    const bookings = byNewest(await airtableGetBookingsByGuestId(ctx.guest.id, 'Confirmed'));
    // Rule 30 step 2, slice 1: FATAL on failure — telling the guest "cancelled"
    // while the booking stays Confirmed leaves it still holding its room via
    // BLOCKING_BOOKING_STATUSES with no way for the guest to know it's still
    // live. Session State is deliberately NOT advanced on failure.
    if (bookings.length > 0) {
      const cancelWrite = await airtableUpdate('WS_Bookings', bookings[0].id, { 'Status': 'Cancelled' });
      if (cancelWrite && cancelWrite.error) {
        logToAxiom('error', 'cancel_booking_write_failed', {
          phone: ctx.phone, bookingId: bookings[0].id, error: JSON.stringify(cancelWrite.error)
        });
        await sendWhatsApp(ctx.phone, msg('cancelWriteFailed'));
        return;
      }
    }
    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'CONFIRMED', to: ctx.next, reason: 'cancel' });
    // Lost-enquiry tracking: a guest who cancels their own booking is an outcome.
    if (bookings.length > 0 && enquiryTrackingEnabled()) {
      await logEnquiry(ctx.property, ctx.phone, 'Cancelled', {
        ...enquiryTrackingOpts(ctx),
        checkInIso: bookings[0].fields['Check In'], checkOutIso: bookings[0].fields['Check Out'],
        bookingType: bookings[0].fields['Booking Type'], bookingId: bookings[0].id
      });
    }
    await sendWhatsApp(ctx.phone, msg('cancelled'));
  },

  // CONFIRMED fallback menu (F9)
  async showConfirmedMenu(ctx) {
    await sendWhatsApp(ctx.phone, confirmedMenuMessage(ctx.property, ctx.guest.fields['Guest Name']));
  },

  // CHECKED_IN → "1": checkout + cleaner dispatch
  async checkout(ctx) {
    // WABISTAY_PAY_ASSIGNS_ROOM: for ten minutes after an AUTOMATIC check-in (reception recorded payment
    // for a guest already waiting at the gate), a tap of 1 is not a checkout: it is most likely the
    // impatient second tap. Nothing is written and the guest stays CHECKED_IN.
    if (payAssignsRoomEnabled()) {
      const justIn = (await airtableGetBookingsByGuestId(ctx.guest.id, 'Checked In'))[0] || null;
      const inAt = justIn ? Date.parse(justIn.fields['Checked In At'] || '') : NaN;
      if (justIn && isAutoCheckedIn(justIn) && Date.now() - inAt < PAY_ASSIGNS_GUARD_MS) {
        const roomId = (justIn.fields['Room'] || [])[0];
        const roomRows = roomId ? await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`) : [];
        logToAxiom('info', 'checkout_ignored_after_auto_checkin', { phone: ctx.phone, bookingId: justIn.id, minutesSince: Math.round((Date.now() - inAt) / 60000) });
        await sendWhatsApp(ctx.phone, msg('payAssignsAlreadyCheckedIn', { roomName: roomRows[0] ? roomRows[0].fields['Room Name'] : 'your room' }));
        return; // stay CHECKED_IN
      }
    }
    // F14: gate cooldown guard — checkout < 60s after check-in is ignored
    const recentBookings = byNewest(await airtableGetBookingsByGuestId(ctx.guest.id, 'Checked In'));
    if (recentBookings.length > 0 && recentBookings[0].fields['Checked In At']) {
      const checkedInAt = new Date(recentBookings[0].fields['Checked In At']);
      const secondsSinceCheckin = (Date.now() - checkedInAt.getTime()) / 1000;
      if (secondsSinceCheckin < 60) {
        await sendWhatsApp(ctx.phone, msg('gateCooldownMenu', { guestName: ctx.guest.fields['Guest Name'], propertyName: ctx.property.fields['Property Name'] }));
        return; // stay CHECKED_IN
      }
    }
    // F5: was FIND/ARRAYJOIN
    const bookings = byNewest(await airtableGetBookingsByGuestId(ctx.guest.id, 'Checked In'));
    let roomName = 'your room';
    // B10.5 Bug 2: ctx.property is the fallback only — the booking's own
    // WS_Property wins when present (bookings checked in before this fix have none).
    let scopePropertyId = ctx.property.id;
    if (bookings.length > 0) {
      const booking = bookings[0];
      scopePropertyId = bookingPropertyId(booking, ctx.property.id);
      // Rule 30 step 2, slice 1: FATAL on failure — this write is what closes
      // out the stay, and its Amount Due later feeds notifyReceptionOfPayment
      // below. A silent failure here would dispatch cleaners and bill
      // reception for a checkout that never actually recorded.
      const checkoutWrite = await airtableUpdate('WS_Bookings', booking.id, {
        'Status': 'Checked Out',
        'Checkout Confirmed': true
      });
      if (checkoutWrite && checkoutWrite.error) {
        logToAxiom('error', 'checkout_write_failed', {
          phone: ctx.phone, bookingId: booking.id, error: JSON.stringify(checkoutWrite.error)
        });
        await sendWhatsApp(ctx.phone, msg('checkoutWriteFailed'));
        return;
      }
      if (booking.fields['Room'] && booking.fields['Room'].length > 0) {
        const roomId = booking.fields['Room'][0];
        const roomRecords = await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`);
        if (roomRecords.length > 0) {
          roomName = roomRecords[0].fields['Room Name'];
          // Rule 30 step 2, slice 1: checked but non-fatal, same shape as the
          // other room-status writes in this sweep — Status is a derived
          // display field, and cleaner dispatch below is a direct message,
          // not gated on this write succeeding. Logged loud: a failure here
          // does have a real downstream cost (senderIsCleanerNamingRoom only
          // matches rooms with Status='Cleaning', so the cleaner's own later
          // room-naming reply would silently fail to match), worth surfacing
          // even though it isn't blocked in this slice.
          const cleaningWrite = await airtableUpdate('WS_Rooms', roomId, { 'Status': 'Cleaning' });
          if (cleaningWrite && cleaningWrite.error) {
            logToAxiom('error', 'checkout_room_status_write_failed', {
              phone: ctx.phone, roomId, error: JSON.stringify(cleaningWrite.error)
            });
          }
          // Separate call, deliberately not combined with the Status update above:
          // 'Cleaning Started At' does not exist on WS_Rooms in Airtable yet (confirmed
          // live via meta API) -- Airtable rejects an entire PATCH if any field in it is
          // unrecognized, so bundling this would risk the Status transition itself
          // failing too, once the field is added and typo'd, or before it exists at all.
          // Logs an error (non-fatal) until the field is created in Airtable.
          await airtableUpdate('WS_Rooms', roomId, { 'Cleaning Started At': new Date().toISOString() });
        }
      }
    }
    // B10.5 Bug 2: was `{Active} = TRUE()` — unscoped, so every active cleaner in
    // the base was dispatched regardless of property. Now scoped to this booking's property.
    const cleaners = await activeCleanersForProperty(scopePropertyId);
    for (const cleaner of cleaners) {
      const cleanerPhone = cleaner.fields['Phone Number'];
      const cleanerName = cleaner.fields['Cleaner Name'];
      if (cleanerPhone) {
        // Rule 30 step 2, slice 2: checked but non-fatal — a missed cleaner
        // text shouldn't block reception notify or the guest's own checkout
        // confirmation below. sendCleanerDispatch logs the failure with
        // booking/cleaner/room correlation.
        await sendCleanerDispatch(cleaner, roomName, { bookingId: bookings[0] && bookings[0].id, failEvent: 'cleaner_dispatch_failed' });
      }
    }
    // B8: tell Reception what to collect. After the booking/room writes and the
    // cleaner dispatch, so a failure here cannot cost the guest their checkout —
    // and deliberately NOT gating the cleaner dispatch on payment (the 5 Jul
    // spec proposed moving dispatch behind PAID; CEO kept it at checkout).
    if (bookings.length > 0) {
      const b = bookings[0];
      await notifyReceptionOfPayment({
        propertyId: scopePropertyId,
        bookingId: b.id,
        bookingRef: b.fields['Booking Ref'] || null,
        roomName,
        guestName: ctx.guest.fields['Guest Name'],
        amountDue: b.fields['Amount Due'],
        source: 'manual'
      });
    }

    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'CHECKED_IN', to: ctx.next, reason: 'checkout', roomName });
    await sendWhatsApp(ctx.phone, msg('checkoutThanks', { propertyName: ctx.property.fields['Property Name'] }));
    await sendWhatsApp(ctx.phone, msg('ratingPrompt', { propertyName: ctx.property.fields['Property Name'] }));
  },

  // AWAITING_RATING + unrecognized reply: reprompt, stay in state (mirrors
  // AWAITING_STAY_TYPE / AWAITING_DETAILS convention — required input, no
  // auto-advance to NEW, so a stray reply doesn't silently drop the rating).
  async ratingReprompt(ctx) {
    await sendWhatsApp(ctx.phone, msg('ratingReprompt'));
  },

  // AWAITING_RATING + "1".."5": write Rating on the most recent unrated
  // Checked Out booking, then branch:
  //  <=2  → optional free-text follow-up (AWAITING_RATING_FEEDBACK, skippable)
  //  ==3  → thanks, back to NEW
  //  >=4  → thanks + review-link prompt IF the property has one set, else
  //         same as ==3. No placeholder link is ever invented (CEO to confirm
  //         WS_Properties field); if the property record has no 'Review Link'
  //         field or it's blank, this step is skipped silently.
  async recordRating(ctx) {
    const rating = parseInt(ctx.text, 10);
    const booking = await findBookingAwaitingRating(ctx.guest.id);
    if (booking) {
      const ratingWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Rating': rating });
      if (ratingWrite && ratingWrite.error) {
        logToAxiom('error', 'rating_write_failed', {
          phone: ctx.phone, bookingId: booking.id, rating, error: JSON.stringify(ratingWrite.error)
        });
        await updateGuestState(ctx.guest.id, { 'Session State': 'NEW' });
        await sendWhatsApp(ctx.phone, msg('ratingWriteFailed'));
        return;
      }
    } else {
      logToAxiom('error', 'rating_no_booking_found', { phone: ctx.phone, guestId: ctx.guest.id, rating });
    }

    if (rating <= 2) {
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_RATING_FEEDBACK' });
      logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'AWAITING_RATING', to: 'AWAITING_RATING_FEEDBACK', rating });
      await sendWhatsApp(ctx.phone, msg('ratingLowFollowup'));
      return;
    }

    await updateGuestState(ctx.guest.id, { 'Session State': 'NEW' });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'AWAITING_RATING', to: 'NEW', rating });

    if (rating >= 4) {
      const propertyId = bookingPropertyId(booking, ctx.property.id);
      const propertyRecord = propertyId === ctx.property.id
        ? ctx.property
        : (await airtableGet('WS_Properties', `RECORD_ID() = '${propertyId}'`))[0];
      const reviewLink = propertyRecord && propertyRecord.fields['Review Link'];
      if (reviewLink) {
        if (booking) await airtableUpdate('WS_Bookings', booking.id, { 'Review Prompted': true });
        await sendWhatsApp(ctx.phone, msg('ratingHighReviewPrompt', { reviewLink }));
      } else {
        // No Review Link set on WS_Properties for this property — skip silently.
        await sendWhatsApp(ctx.phone, msg('ratingHighThanks'));
      }
      return;
    }

    await sendWhatsApp(ctx.phone, msg('ratingMidThanks'));
  },

  // AWAITING_RATING_FEEDBACK + "skip"/"no"/"none": guest declines the optional follow-up.
  async skipRatingFeedback(ctx) {
    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'AWAITING_RATING_FEEDBACK', to: ctx.next, reason: 'skipped' });
  },

  // AWAITING_RATING_FEEDBACK + free text: optional follow-up for a <=2 rating.
  async recordRatingFeedback(ctx) {
    const booking = await findBookingAwaitingRatingFeedback(ctx.guest.id);
    if (booking) {
      const feedbackWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Rating Feedback': ctx.messageText });
      if (feedbackWrite && feedbackWrite.error) {
        logToAxiom('error', 'rating_feedback_write_failed', {
          phone: ctx.phone, bookingId: booking.id, error: JSON.stringify(feedbackWrite.error)
        });
      }
    } else {
      logToAxiom('error', 'rating_feedback_no_booking_found', { phone: ctx.phone, guestId: ctx.guest.id });
    }
    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'AWAITING_RATING_FEEDBACK', to: ctx.next });
    await sendWhatsApp(ctx.phone, msg('ratingFeedbackThanks'));
  },

  // Coexistence: a human took over this conversation via the WhatsApp Business
  // app. Every guest message lands here while suppressed and does nothing — no
  // send, no state change (no `next` in this state's states.json row, so
  // Session State stays HUMAN_HANDLING). The explicit "bot on" handback is
  // deliberately NOT a row in this table — it only ever comes from
  // handleMessageEcho below, reading the STAFF's own outbound message via the
  // app, never from anything a guest could type here. A guest typing "bot on"
  // by coincidence must not be able to end their own suppression.
  async suppressedForHuman(ctx) {
    logToAxiom('info', 'guest_message_suppressed_human_handling', { phone: ctx.phone, guestId: ctx.guest.id, text: ctx.text });
  },

  // CHECKED_IN + "extend": B12. Push the checkout window out (uncapped, per the
  // 16 July lock — guests can extend repeatedly). Owner is notified on the FIRST
  // extension only (one notification per booking), tracked by the
  // `Extension Owner Notified` checkbox. Clearing `Checkout Warning Sent At`
  // re-arms the cron so a fresh warning fires when the new checkout time passes.
  async extendStay(ctx) {
    const guestName = ctx.guest.fields['Guest Name'];
    const bookings = byNewest(await airtableGetBookingsByGuestId(ctx.guest.id, 'Checked In'));
    const booking = bookings[0] || null;
    if (!booking || !booking.fields['Check Out']) {
      // Nothing to extend (no active booking, or a date-less legacy row).
      await sendWhatsApp(ctx.phone, msg('checkedInMenu', { guestName }));
      return;
    }

    // A Day stay ends at 17:00 and has no extension rule (the generic one would add 24 hours and
    // another R400). The guest is sent to reception and NOTHING is written: no price, no time,
    // no booking field. Not behind a flag on purpose: a Day booking only exists because the stay
    // menu made it, and if that flag is later switched off the booking must still be protected.
    if (booking.fields['Booking Type'] === 'Day') {
      logToAxiom('info', 'extend_refused_day_booking', { phone: ctx.phone, bookingId: booking.id });
      await sendWhatsApp(ctx.phone, msg('dayExtendSpeakToReception'));
      return;
    }

    // PR3 3a — idempotency, but NOT paidBooking's pattern, and deliberately so.
    // paidBooking can check "is Payment Status already Paid" because paying
    // twice is meaningless — there is a genuine terminal state to refuse
    // against. Extensions have no such state: they are locked (16 July) as
    // repeatable and uncapped, so "already extended" is not a valid refusal —
    // a guest who genuinely wants a second extension an hour later must get
    // one. Copying paidBooking's exact shape here would either do nothing or,
    // built carelessly, silently break that locked behaviour.
    //
    // What IS available, matching the threat actually named for this fix
    // (WhatsApp at-least-once delivery; a slow handler can cause Meta to
    // retry BEFORE the first 200 lands — i.e. a genuinely CONCURRENT second
    // invocation of the same inbound message, not one arriving minutes later):
    // a fresh re-read, immediately before the write, compared against what
    // THIS invocation started from — the same optimistic-concurrency idiom
    // PR1 used for the booking-availability race. If a concurrent duplicate
    // already committed its write in the gap, this invocation's own read is
    // now stale and it stands down rather than adding a second increment on
    // top of one it never saw.
    //
    // PR3b — closes the residual gap PR3 flagged above: a duplicate delivery
    // arriving AFTER the first EXTEND already fully completed is otherwise
    // indistinguishable from a deliberate second EXTEND. wamid (now threaded
    // through handleMessage/ctx) is the only thing that tells them apart.
    // Field-based check, matching this codebase's existing idempotency
    // convention (e.g. paidBooking's Payment Status check) rather than a new
    // generic dedup store — cheaper and avoids an in-memory cache that
    // wouldn't survive Vercel's serverless cold starts anyway.
    if (ctx.wamid && booking.fields['Last Extend Wamid'] === ctx.wamid) {
      logToAxiom('warn', 'extend_duplicate_wamid_suspected', {
        phone: ctx.phone, bookingId: booking.id, wamid: ctx.wamid
      });
      await sendWhatsApp(ctx.phone, msg('extensionConfirmed', { guestName }));
      return;
    }

    const readCheckOut = booking.fields['Check Out'];

    const extendMs = EXTENSION_MS[booking.fields['Booking Type']] || EXTENSION_MS.Overnight;
    const newCheckOut = new Date(Date.parse(booking.fields['Check Out']) + extendMs).toISOString();
    const alreadyNotified = !!booking.fields['Extension Owner Notified'];

    const bookingUpdate = {
      'Check Out': newCheckOut,
      // Re-arm the warning cycle for the extended window.
      'Checkout Warning Sent At': null,
      'Last Extend Wamid': ctx.wamid || null
    };
    // Set the flag only on the first extension — leave it untouched afterwards so
    // the write log shows no re-notify bookkeeping on later extensions.
    if (!alreadyNotified) bookingUpdate['Extension Owner Notified'] = true;

    // Price the extension onto the bill. Strictly ADDITIVE — the new total is
    // whatever the booking already carried plus one extension, never a
    // recomputation from scratch. Recomputing would silently overwrite anything
    // else that had adjusted the figure, and would make the Nth extension depend
    // on rates being unchanged since the 1st. Creation-time pricing is untouched.
    const charge = await extensionCharge(booking, ctx.property);
    const previousDue = Number(booking.fields['Amount Due']) || 0;
    if (charge === null) {
      // Unpriceable (no Rate Applied, or no hourly rate configured). The time
      // extension still happens — refusing a guest more time over a config gap
      // would be a worse failure, and is not what B12 promised them — but the
      // money is left untouched and the gap is made loud rather than papered
      // over with a guessed figure.
      logToAxiom('warn', 'extension_not_priced', {
        phone: ctx.phone, bookingId: booking.id,
        bookingType: booking.fields['Booking Type'] || null,
        propertyId: ctx.property.id, amountDue: previousDue
      });
    } else {
      bookingUpdate['Amount Due'] = previousDue + charge;
    }

    // The re-check itself: fresh read, compared against what this invocation
    // started from. A concurrent duplicate that already committed changes
    // Check Out out from under us — stand down rather than adding a second
    // increment neither the guest nor B17's revenue report should ever see.
    const freshBookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Checked In');
    const freshBooking = freshBookings.find(b => b.id === booking.id) || null;
    if (!freshBooking || freshBooking.fields['Check Out'] !== readCheckOut) {
      logToAxiom('warn', 'extend_duplicate_delivery_suspected', {
        phone: ctx.phone, bookingId: booking.id,
        readCheckOut, currentCheckOut: freshBooking ? freshBooking.fields['Check Out'] : null
      });
      // The extension the guest wanted already happened — courtesy reply, not
      // an error, and definitely not a second charge.
      await sendWhatsApp(ctx.phone, msg('extensionConfirmed', { guestName }));
      return;
    }

    // Rule 30 step 2, slice 1: FATAL on failure — this write sets Amount Due
    // and Check Out, the two facts the owner notify and guest confirmation
    // below both report as settled. F41's dedup write (Last Extend Wamid) is
    // part of this same bookingUpdate object, so this check also covers that.
    const extendWrite = await airtableUpdate('WS_Bookings', booking.id, bookingUpdate);
    if (extendWrite && extendWrite.error) {
      logToAxiom('error', 'extend_write_failed', {
        phone: ctx.phone, bookingId: booking.id, error: JSON.stringify(extendWrite.error)
      });
      await sendWhatsApp(ctx.phone, msg('extendWriteFailed', { guestName }));
      return;
    }

    const extensionTo = alreadyNotified ? null : operationalAlertPhone(ctx.property);
    if (extensionTo) {
      logOwnerSendWindow('extension', extensionTo, ctx.phone); // B17 instrumentation
      // Rule 30 step 2, slice 2: checked but non-fatal — courtesy notification,
      // the guest already got their own extensionConfirmed reply below regardless.
      const ownerSend = await sendWhatsApp(extensionTo, msg('ownerExtension', {
        guestName,
        bookingRef: booking.fields['Booking Ref'] || '',
        checkOut: formatSastDateTime(newCheckOut)
      }));
      if (ownerSend && ownerSend.error) {
        logToAxiom('error', 'owner_extension_notify_failed', {
          bookingId: booking.id, error: JSON.stringify(ownerSend.error)
        });
      }
    }
    logToAxiom('info', 'booking_extended', {
      phone: ctx.phone, bookingId: booking.id, newCheckOut, ownerNotified: !alreadyNotified,
      // Both figures, so "what did this extension cost and what is owed now" is a
      // query rather than an inference — the number PAID will eventually display.
      extensionCharge: charge, amountDue: charge === null ? previousDue : previousDue + charge
    });
    await sendWhatsApp(ctx.phone, msg('extensionConfirmed', { guestName }));
  },

  // CHECKED_IN fallback menu (F9)
  async showCheckedInMenu(ctx) {
    await sendWhatsApp(ctx.phone, msg('checkedInMenu', { guestName: ctx.guest.fields['Guest Name'] }));
  },

  // Unknown session state: reset to NEW
  async unknownStateReset(ctx) {
    if (ctx.guest) {
      await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    }
    await sendWhatsApp(ctx.phone, msg('unknownFallback'));
  }
};

// ─── AUTO-CHECKOUT CRON (B12) ────────────────────────────────────────────────
// Runs on a schedule (vercel.json → cron; Shawn enables at deploy). No guest
// message triggers it, so it is a separate entry point from handleMessage. For
// every Checked In booking past its Check Out:
//   · not yet warned  → send the 15-minute warning, stamp Checkout Warning Sent At
//   · warned ≥ AUTO_CHECKOUT_GRACE_MS ago → auto-checkout (same side effects and
//     cleaner-dispatch path as the manual `checkout` action)
//   · warned, still inside the grace → wait
// An EXTEND reply pushes Check Out into the future and clears the warning stamp,
// so an extended booking is simply "not past checkout" here and takes no action
// until the new time passes. `now` is injected for deterministic timing tests.

// Shared with the manual checkout path in spirit: mirrors the exact write/send
// ORDER of the `checkout` action (booking → Checked Out; room → Cleaning; room →
// Cleaning Started At; active cleaners dispatched; guest → NEW; guest thanked),
// so both routes leave identical state. Kept as its own function rather than
// refactoring `checkout` (frozen by fixtures 10/43) — a unifying refactor is its
// own session per CLAUDE.md.
// B10.5 Bug 2: `propertyId` is the caller's room-walk result, used only as a
// fallback for bookings checked in before WS_Property was persisted.
async function settleAutoCheckout(booking, room, guest, propertyName, propertyId) {
  // Race guard (CEO decision, 2026-09-28, same class of fix as extendStay's
  // PR3/PR3b — see that action's own comment for the full reasoning). `booking`
  // is the snapshot runAutoCheckout's tick-start query captured; real wall-clock
  // time passes between that read and this call (per-booking guest/room/property
  // lookups, then this function's own several sequential writes), which is
  // exactly the gap a manual checkout can land in for the same booking. A fresh
  // re-read of the one fact this function's precondition depends on — Status
  // still 'Checked In' — immediately before any write. If the guest already
  // checked out manually (or a genuinely concurrent cron invocation already
  // settled this booking), stand down entirely: no booking write, no room
  // write, no cleaner dispatch, no guest message, no Session State overwrite.
  // A booking that is STILL legitimately Checked In and overdue is completely
  // unaffected — this only ever short-circuits work that would otherwise
  // duplicate or clobber something that already happened.
  const freshBookings = await airtableGet('WS_Bookings', `RECORD_ID() = '${booking.id}'`);
  const freshBooking = freshBookings[0] || null;
  if (!freshBooking || freshBooking.fields['Status'] !== 'Checked In') {
    logToAxiom('warn', 'auto_checkout_skipped_already_settled', {
      bookingId: booking.id, currentStatus: freshBooking ? freshBooking.fields['Status'] : null
    });
    return false;
  }

  // Rule 30 step 2, slice 1: FATAL on failure, cron twin of the manual
  // checkout write. No guest to reply to here — on failure this just logs
  // loud and returns without dispatching cleaners/reception/guest-thanks;
  // the booking stays 'Status: Checked In' so runAutoCheckout's own query
  // (`{Status} = 'Checked In'`) naturally retries it on the next tick.
  const checkoutWrite = await airtableUpdate('WS_Bookings', booking.id, {
    'Status': 'Checked Out',
    'Checkout Confirmed': true
  });
  if (checkoutWrite && checkoutWrite.error) {
    logToAxiom('error', 'auto_checkout_write_failed', {
      bookingId: booking.id, error: JSON.stringify(checkoutWrite.error)
    });
    return;
  }
  let roomName = 'your room';
  if (room) {
    roomName = room.fields['Room Name'];
    // Rule 30 step 2, slice 1: checked but non-fatal, same shape as the
    // manual checkout path's equivalent write.
    const cleaningWrite = await airtableUpdate('WS_Rooms', room.id, { 'Status': 'Cleaning' });
    if (cleaningWrite && cleaningWrite.error) {
      logToAxiom('error', 'auto_checkout_room_status_write_failed', {
        roomId: room.id, error: JSON.stringify(cleaningWrite.error)
      });
    }
    await airtableUpdate('WS_Rooms', room.id, { 'Cleaning Started At': new Date().toISOString() });
  }
  // B10.5 Bug 2: was `{Active} = TRUE()` — identical unscoped query to the manual
  // path. Both now scope off the booking's WS_Property via the same helper.
  const cleaners = await activeCleanersForProperty(bookingPropertyId(booking, propertyId));
  for (const cleaner of cleaners) {
    const cleanerPhone = cleaner.fields['Phone Number'];
    if (cleanerPhone) {
      // Rule 30 step 2, slice 2: checked but non-fatal, same shape as the
      // manual checkout path's equivalent dispatch.
      await sendCleanerDispatch(cleaner, roomName, { bookingId: booking.id, failEvent: 'auto_checkout_cleaner_dispatch_failed' });
    }
  }
  // B8: same push as the manual path. This is the branch that matters most —
  // walk-ins and hourly stays are normally closed here, not by the guest, and a
  // walk-in guest may have no phone on record to close it with at all.
  await notifyReceptionOfPayment({
    propertyId: bookingPropertyId(booking, propertyId),
    bookingId: booking.id,
    bookingRef: booking.fields['Booking Ref'] || null,
    roomName,
    guestName: guest ? guest.fields['Guest Name'] : null,
    amountDue: booking.fields['Amount Due'],
    source: 'auto'
  });

  if (guest) {
    await updateGuestState(guest.id, { 'Session State': 'AWAITING_RATING' });
  }
  const guestPhone = guest && formatPhone(String(guest.fields['Phone Number'] || ''));
  if (guestPhone) {
    await sendWhatsApp(guestPhone, msg('autoCheckoutThanks', { propertyName }));
    await sendWhatsApp(guestPhone, msg('ratingPrompt', { propertyName }));
  }
  return true;
}

// ─── STALE-HOLD RELEASE and OVERDUE QUESTION (Doc 1b PR 6) ───────────────────
// Two sweeps that ride the auto-checkout cron, both inside its time budget.
//
// 1. Stale holds. A booking in Enquiry/Confirmed holds its room (it blocks the
//    date range) until the guest arrives or cancels; nothing ever expired one, so
//    a no-show held a room forever. 'Hold Expires At' (WS_Bookings, date+time,
//    UTC) is set to 30 minutes after the stated arrival time and the sweep
//    cancels the booking once it has passed. Never sooner than 30 minutes after
//    the booking is made, whatever arrival time the guest typed. Guarded by
//    WABISTAY_HOLD_RELEASE (1/true): off, nothing is written and nothing is
//    released, so existing holds and today's behaviour are untouched.
// 2. Overdue question. A Checked In booking still open 60 minutes after its
//    Check Out is a room reception should be asked about. Template only (a
//    business-initiated message to staff), so WABISTAY_OVERDUE_ALERT_TEMPLATE
//    unset = off. Stamped in 'Overdue Alert Sent At' so it is asked once.
const HOLD_GRACE_MS = 30 * 60 * 1000;
const OVERDUE_ALERT_AFTER_MS = 60 * 60 * 1000;
// Guest states that exist only because a live hold does. When the hold goes the
// guest goes back to NEW — otherwise "I'm at the gate" finds no Confirmed
// booking and gateArrival falls through to its legacy first-available-room path.
const HOLD_SESSION_STATES = ['CONFIRMED', 'AWAITING_ETA', 'AWAITING_PAYMENT_METHOD'];

function holdReleaseEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_HOLD_RELEASE || '').trim());
}

function overdueAlertTemplate() {
  return process.env.WABISTAY_OVERDUE_ALERT_TEMPLATE || null;
}

// arrival + 30 min, but never earlier than now + 30 min.
function holdExpiryIso(arrivalIso, now = new Date()) {
  const fromArrival = Date.parse(arrivalIso) + HOLD_GRACE_MS;
  const fromNow = now.getTime() + HOLD_GRACE_MS;
  return new Date(Math.max(fromArrival, fromNow)).toISOString();
}

// Overnight arrival: the ETA the guest typed, on the check-in day (SAST). A bare
// 1-11 is ambiguous and is read as the later (pm) time, so a hold is never
// released early on a misreading. No ETA, or one that cannot be read ("evening"),
// holds to the end of the check-in day (23:59 SAST).
function overnightArrivalIso(checkInIso, etaText) {
  const day = sastCalendarDate(new Date(Date.parse(checkInIso)));
  const t = etaText ? parseArrivalTime(etaText) : null;
  let hour = 23;
  let minute = 59;
  if (t && t.ambiguous !== undefined) { hour = t.ambiguous + 12; minute = 0; }
  else if (t) { hour = t.hour; minute = t.minute; }
  return sastToUtcIso(day, hour, minute);
}

function overnightHoldExpiryIso(checkInIso, etaText, now = new Date()) {
  return holdExpiryIso(overnightArrivalIso(checkInIso, etaText), now);
}

async function runHoldRelease(now = new Date(), opts = {}) {
  const { deadline = Infinity } = opts;
  const summary = { holdsReleased: 0 };
  if (!holdReleaseEnabled()) return summary;

  const nowMs = now.getTime();
  const holds = await airtableGet('WS_Bookings', orFormula('Status', ['Enquiry', 'Confirmed']));
  const released = new Set();

  for (const hold of holds) {
    const expires = hold.fields['Hold Expires At'];
    if (!expires || nowMs < Date.parse(expires)) continue;   // no expiry set (older holds) or not yet due

    if (Date.now() > deadline) {
      summary.truncated = true;
      logToAxiom('warn', 'cron_time_budget_hit', { cron: 'auto_checkout', stage: 'hold_release', leftFrom: hold.id });
      break;
    }

    // Money has been recorded against this booking: a person decides, not a timer.
    if (hold.fields['Payment Status'] === 'Paid' || Number(hold.fields['Amount Paid']) > 0) {
      logToAxiom('warn', 'hold_expired_paid_skipped', { bookingId: hold.id, holdExpiresAt: expires });
      continue;
    }

    // Fresh read immediately before the write: the guest may have checked in,
    // cancelled, or had the hold extended since this sweep's snapshot.
    const fresh = (await airtableGet('WS_Bookings', `RECORD_ID() = '${hold.id}'`))[0] || null;
    if (!fresh || !['Enquiry', 'Confirmed'].includes(fresh.fields['Status']) || fresh.fields['Hold Expires At'] !== expires) {
      logToAxiom('info', 'hold_release_skipped_changed', {
        bookingId: hold.id, currentStatus: fresh ? fresh.fields['Status'] : null
      });
      continue;
    }

    const write = await airtableUpdate('WS_Bookings', hold.id, { 'Status': 'Cancelled' });
    if (write && write.error) {
      logToAxiom('error', 'hold_release_write_failed', { bookingId: hold.id, error: JSON.stringify(write.error) });
      continue;
    }
    released.add(hold.id);
    summary.holdsReleased++;
    logToAxiom('info', 'hold_released', {
      bookingId: hold.id, bookingRef: hold.fields['Booking Ref'] || null, roomId: (hold.fields['Room'] || [])[0] || null,
      status: fresh.fields['Status'], holdExpiresAt: expires
    });

    // Reset the guest, but only if no other live hold of theirs remains.
    const guestId = (hold.fields['Guest'] || [])[0];
    const holdGuest = guestId ? (await airtableGet('WS_Guests', `RECORD_ID() = '${guestId}'`))[0] || null : null;

    // Lost-enquiry tracking: a hold the timer released is an outcome ('Hold
    // Expired', not 'Cancelled' — nobody cancelled it). Logged before the guest is
    // reset so 'Last Step' is where they actually stopped.
    if (enquiryTrackingEnabled()) {
      const holdRoomId = (hold.fields['Room'] || [])[0];
      const holdRoom = holdRoomId ? (await airtableGet('WS_Rooms', `RECORD_ID() = '${holdRoomId}'`))[0] || null : null;
      const holdPropertyId = (holdRoom && (holdRoom.fields['Property'] || [])[0]) || (holdGuest && (holdGuest.fields['Attempt Property'] || [])[0]) || null;
      if (holdPropertyId && holdGuest) {
        await logEnquiry({ id: holdPropertyId }, formatPhone(String(holdGuest.fields['Phone Number'] || '')), 'Hold Expired', {
          checkInIso: hold.fields['Check In'], checkOutIso: hold.fields['Check Out'],
          bookingType: hold.fields['Booking Type'], bookingId: hold.id,
          firstMessageAt: holdGuest.fields['Attempt Started At'], lastMessageAt: holdGuest.fields['Last Inbound At'],
          lastStep: holdGuest.fields['Session State'], testPhone: isTestGuest(holdGuest)
        });
      } else {
        logToAxiom('warn', 'hold_expired_enquiry_not_logged', { bookingId: hold.id, reason: 'no property or guest to scope the row' });
      }
    }

    if (guestId) {
      const otherLive = holds.some(h => h.id !== hold.id && !released.has(h.id) && (h.fields['Guest'] || []).includes(guestId));
      if (!otherLive) {
        const guest = holdGuest;
        if (guest && HOLD_SESSION_STATES.includes(guest.fields['Session State'])) {
          // No message to the guest: what to say is Shawn's wording, and a guest
          // who has been silent past their arrival time is likely outside the
          // 24h window anyway. Their next message starts a fresh booking.
          await updateGuestState(guest.id, { 'Session State': 'NEW' });
        }
      }
    }
  }
  return summary;
}

async function runOverdueAlerts(now = new Date(), opts = {}) {
  const { deadline = Infinity } = opts;
  const summary = { overdueAlerts: 0 };
  const templateName = overdueAlertTemplate();
  if (!templateName) return summary;

  const nowMs = now.getTime();
  const bookings = await airtableGet('WS_Bookings', `{Status} = 'Checked In'`);
  for (const booking of bookings) {
    const checkOut = booking.fields['Check Out'];
    if (!checkOut || nowMs < Date.parse(checkOut) + OVERDUE_ALERT_AFTER_MS) continue;
    if (booking.fields['Overdue Alert Sent At']) continue;       // asked once

    if (Date.now() > deadline) {
      summary.truncated = true;
      logToAxiom('warn', 'cron_time_budget_hit', { cron: 'auto_checkout', stage: 'overdue_alert', leftFrom: booking.id });
      break;
    }

    const roomId = (booking.fields['Room'] || [])[0];
    const guestId = (booking.fields['Guest'] || [])[0];
    const [roomRows, guestRows] = await Promise.all([
      roomId ? airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`) : [],
      guestId ? airtableGet('WS_Guests', `RECORD_ID() = '${guestId}'`) : []
    ]);
    const room = roomRows[0] || null;
    const guest = guestRows[0] || null;
    const propertyId = bookingPropertyId(booking, room && (room.fields['Property'] || [])[0]);
    const seats = await activeReceptionRolesForProperty(propertyId);
    const correlation = { site: 'overdue_alert', bookingId: booking.id, propertyId };

    if (seats.length === 0) {
      logToAxiom('warn', 'overdue_alert_no_seat', { ...correlation, reason: 'no active Reception seat for property' });
      continue;
    }

    // Positional and load-bearing once the template is approved: {{1}} room,
    // {{2}} guest, {{3}} the scheduled check-out (SAST date and time).
    const params = [
      room ? room.fields['Room Name'] : 'a room',
      guest ? (guest.fields['Guest Name'] || 'the guest') : 'the guest',
      formatSastDateTime(checkOut)
    ];
    let sentAny = false;
    for (const seat of seats) {
      const to = formatPhone(String(seat.fields['Current Phone']));
      const result = await sendWhatsAppTemplate(to, templateName, params, { ...correlation, roleId: seat.id });
      if (result.ok) sentAny = true;
      else logToAxiom('error', 'overdue_alert_failed', { ...correlation, to, template: templateName, error: JSON.stringify(result.error || null) });
    }
    // Stamp only after a send landed, so a template that is not approved yet
    // (or a failed send) is retried on the next tick rather than lost.
    if (sentAny) {
      const stamp = await airtableUpdate('WS_Bookings', booking.id, { 'Overdue Alert Sent At': now.toISOString() });
      if (stamp && stamp.error) {
        logToAxiom('error', 'overdue_alert_stamp_write_failed', { bookingId: booking.id, error: JSON.stringify(stamp.error) });
      }
      logToAxiom('info', 'overdue_alert_sent', { ...correlation, checkOut });
      summary.overdueAlerts++;
    }
  }
  return summary;
}

// Unattended gate arrivals (WABISTAY_ENQUIRY_TRACKING). A guest tapped "I'm at the
// gate" before payment (first tap stamped in 'Gate Tap At'); 15 minutes on, the
// payment is still not confirmed and they are not checked in. Nobody dealt with
// them in time, which is what Shawn wants counted while nobody covers the phone
// at night. Writes 'Unattended Gate Arrival At' once and logs
// unattended_gate_arrival. Resolution is judged at the 15-minute mark, from
// 'Paid At' / 'Checked In At', not from the moment this 5-minute sweep happens
// to run — a payment at minute 17 is still unattended.
async function runUnattendedGateSweep(now = new Date(), opts = {}) {
  const { deadline = Infinity } = opts;
  const summary = { unattendedGateArrivals: 0 };
  if (!enquiryTrackingEnabled()) return summary;

  const nowMs = now.getTime();
  const candidates = (await airtableGet('WS_Bookings', orFormula('Status', ['Confirmed', 'Checked In']))).filter(b => {
    const tap = b.fields['Gate Tap At'];
    if (!tap || b.fields['Unattended Gate Arrival At']) return false;
    const limit = Date.parse(tap) + UNATTENDED_GATE_AFTER_MS;
    if (nowMs < limit) return false;
    const paidInTime = b.fields['Payment Status'] === 'Paid' && (!b.fields['Paid At'] || Date.parse(b.fields['Paid At']) <= limit);
    const inInTime = b.fields['Checked In At'] && Date.parse(b.fields['Checked In At']) <= limit;
    return !paidInTime && !inInTime;
  });

  for (const candidate of candidates) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      logToAxiom('warn', 'cron_time_budget_hit', { cron: 'auto_checkout', stage: 'unattended_gate', leftFrom: candidate.id });
      break;
    }
    const fresh = (await airtableGet('WS_Bookings', `RECORD_ID() = '${candidate.id}'`))[0] || null;
    if (!fresh || fresh.fields['Unattended Gate Arrival At']) continue;

    const guestId = (fresh.fields['Guest'] || [])[0];
    const guest = guestId ? (await airtableGet('WS_Guests', `RECORD_ID() = '${guestId}'`))[0] || null : null;
    const tap = fresh.fields['Gate Tap At'];
    const event = {
      bookingId: fresh.id, bookingRef: fresh.fields['Booking Ref'] || null, gateTapAt: tap,
      gateTapHourSast: sastHourOf(tap), minutesWaited: Math.round((nowMs - Date.parse(tap)) / 60000),
      amountDue: fresh.fields['Amount Due'] || null, phone: guest ? guest.fields['Phone Number'] : null
    };
    if (isTestGuest(guest)) {
      logToAxiom('info', 'unattended_gate_arrival', { ...event, testPhone: true });   // logged, never marked
      continue;
    }
    const write = await airtableUpdate('WS_Bookings', fresh.id, { 'Unattended Gate Arrival At': now.toISOString() });
    if (write && write.error) {
      logToAxiom('error', 'unattended_gate_marker_write_failed', { bookingId: fresh.id, error: JSON.stringify(write.error) });
      continue;
    }
    logToAxiom('info', 'unattended_gate_arrival', { ...event, testPhone: false });
    summary.unattendedGateArrivals++;
  }
  return summary;
}

// Cron time budget (Doc 1b PR 5). Every function is cut at maxDuration and the
// 5-minute auto-checkout was being cut at 10s (504) near the top of the hour. The
// sweeps are idempotent, so the safe response to running long is to stop
// starting new work and let the next tick pick up what is left, rather than be
// killed mid-write. Default 8s keeps clear of the old 10s ceiling; raise it
// with CRON_TIME_BUDGET_MS only together with a larger maxDuration.
function cronTimeBudgetMs() {
  const v = Number(process.env.CRON_TIME_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? v : 8000;
}

async function runAutoCheckout(now = new Date(), opts = {}) {
  const { deadline = Infinity } = opts;
  const nowMs = now.getTime();
  const summary = { warnings: 0, autoCheckouts: 0 };

  const bookings = await airtableGet('WS_Bookings', `{Status} = 'Checked In'`);
  for (const booking of bookings) {
    const checkOut = booking.fields['Check Out'];
    if (!checkOut) continue;                 // date-less legacy row — cron can't manage it
    if (nowMs < Date.parse(checkOut)) continue; // not past checkout (incl. extended bookings)

    // About to do the expensive part (lookups, writes, sends) for an overdue
    // booking. Out of time: leave this one and the rest for the next tick.
    if (Date.now() > deadline) {
      summary.truncated = true;
      logToAxiom('warn', 'cron_time_budget_hit', { cron: 'auto_checkout', stage: 'checkout', leftFrom: booking.id });
      break;
    }

    // Resolve guest, room and property for copy / dispatch (RECORD_ID lookups,
    // the same idiom the manual checkout uses for the room). Guest and room are
    // independent, so they are read together.
    const guestId = (booking.fields['Guest'] || [])[0];
    const roomId = (booking.fields['Room'] || [])[0];
    const [guestRows, roomRows] = await Promise.all([
      guestId ? airtableGet('WS_Guests', `RECORD_ID() = '${guestId}'`) : [],
      roomId ? airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`) : []
    ]);
    const guest = guestRows[0] || null;
    const room = roomRows[0] || null;
    const propId = room && (room.fields['Property'] || [])[0];
    const property = propId ? (await airtableGet('WS_Properties', `RECORD_ID() = '${propId}'`))[0] : null;
    const propertyName = property ? property.fields['Property Name'] : '';
    const guestName = guest ? guest.fields['Guest Name'] : 'there';
    const guestPhone = guest && formatPhone(String(guest.fields['Phone Number'] || ''));

    const warnedAt = booking.fields['Checkout Warning Sent At'];
    if (!warnedAt) {
      // First pass past checkout → warn and stamp the time.
      // Rule 30 step 2, slice 2 (deferred from F44/slice 1): NON-FATAL —
      // nothing reads this field except this same cron function on its own
      // NEXT run (line ~3009, freshly refetched). A failed stamp just means
      // the warning re-sends every tick until the write succeeds — a
      // self-healing annoyance, not a broken state.
      const warnStampWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Checkout Warning Sent At': now.toISOString() });
      if (warnStampWrite && warnStampWrite.error) {
        logToAxiom('error', 'checkout_warning_stamp_write_failed', {
          bookingId: booking.id, error: JSON.stringify(warnStampWrite.error)
        });
      }
      if (guestPhone) await sendWhatsApp(guestPhone, msg('checkoutWarning', { guestName, propertyName }));
      logToAxiom('info', 'auto_checkout_warning', { bookingId: booking.id, phone: guestPhone || null, checkOut });
      summary.warnings++;
      continue;
    }
    if (nowMs >= Date.parse(warnedAt) + AUTO_CHECKOUT_GRACE_MS) {
      // Grace elapsed, no extension, no manual checkout → auto-checkout.
      // B10.5 Bug 2: the room walk above stays — it feeds `propertyName` into the
      // guest copy. `propId` is passed only as the legacy-booking scoping fallback.
      //
      // Race guard (2026-09-28): settleAutoCheckout returns `false` only from
      // its own fresh-read guard (booking already moved on since this
      // function's snapshot read above) — a genuine write failure inside it
      // still returns undefined, preserving the pre-existing "count it,
      // retry next tick" behaviour for that unrelated case. Only the new
      // already-settled case is excluded here, so this cron's own summary/log
      // stay honest about what it actually did, without changing what a real
      // write failure reports.
      const settled = await settleAutoCheckout(booking, room, guest, propertyName, propId);
      if (settled !== false) {
        logToAxiom('info', 'auto_checkout_fired', { bookingId: booking.id, phone: guestPhone || null });
        summary.autoCheckouts++;
      }
    }
    // else: warned, still inside the grace — wait for the next run.
  }
  return summary;
}

// ─── ENQUIRY LOGGING (B19) ───────────────────────────────────────────────────
// Every terminal point of a booking attempt writes one WS_Enquiries row, so the
// attempts that never became bookings — "3 enquiries turned away, no room free"
// — stop vanishing. Booked / No Availability / Invalid Input are logged at their
// definitive points; Abandoned is a staleness sweep (guest gave a name, then went
// silent) that reuses the auto-checkout cron rather than adding a second one.

const ENQUIRY_ABANDON_MS = 24 * 60 * 60 * 1000; // 24h since last inbound with no terminal outcome
// Originally just the 3 "produced a valid booking DRAFT" states. Extended to
// all 5 AWAITING_* limbo states (closing the last gap from the stuck-state
// investigation, recDAQmhoe4aFHvFy) — AWAITING_DETAILS/AWAITING_HOURLY_DETAILS
// added so the sweep also unsticks a guest who never even got past the
// details-capture step, not just one who has a draft in progress. See
// runEnquiryAbandonment for why these two needed more than just adding their
// names here: their data shape differs from the original 3 in ways that
// would have made the RESET silently never fire if the loop below weren't
// restructured to stop gating it on those differences.
const ENQUIRY_ABANDON_STATES = [
  'AWAITING_OCCUPANCY', 'AWAITING_ETA', 'AWAITING_HOURLY_DURATION',
  'AWAITING_DETAILS', 'AWAITING_HOURLY_DETAILS',
  // Payment build (CEO 2026-09-29): a guest quoted a price who never picks
  // Card/EFT is exactly the same limbo-guest shape this sweep already exists
  // to unstick.
  'AWAITING_PAYMENT_METHOD'
];

// ─── LOST-ENQUIRY TRACKING (WABISTAY_ENQUIRY_TRACKING) ───────────────────────
// Shawn's decision: nobody answers the phone at night for now, so we record lost
// enquiries and when they happen, and review after a month. Each enquiry row
// carries the time of the first message, the last step reached and an outcome
// (Booked / Abandoned / Cancelled / Hold Expired, plus the existing
// No Availability / Invalid Input). A separate marker, 'Unattended Gate Arrival At',
// is written on a booking when a gate tap sees no payment confirmation and no
// check-in within 15 minutes. All of it sits behind WABISTAY_ENQUIRY_TRACKING
// (1/true, off by default). A guest with 'Test Phone' ticked gets no enquiry row
// and no marker, whatever the flag — their Axiom events carry testPhone: true.
const UNATTENDED_GATE_AFTER_MS = 15 * 60 * 1000;

function enquiryTrackingEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_ENQUIRY_TRACKING || '').trim());
}

function isTestGuest(guest) {
  return !!(guest && guest.fields && guest.fields['Test Phone'] === true);
}

// SAST hour of day (0-23) of an ISO instant, for Axiom's by-hour views.
function sastHourOf(iso) {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms + SAST_OFFSET_MS).getUTCHours() : null;
}

// What a handler passes to logEnquiry about the attempt: when it began, where the
// guest was, and whether they are a test phone. 'Last Step' is the guest's Session
// State on arrival of the message being handled (the step they were answering).
function enquiryTrackingOpts(ctx) {
  const g = ctx && ctx.guest;
  return {
    firstMessageAt: ctx.attemptStartedAt || (g && g.fields['Attempt Started At']) || null,
    lastMessageAt: new Date().toISOString(),
    lastStep: ctx.stepOnArrival || (g && g.fields['Session State']) || null,
    testPhone: isTestGuest(g)
  };
}

// Writes exactly one WS_Enquiries row. Property-scoped via property.id (JS-side
// record-id link, same idiom as B11). Partial rows are allowed — an attempt that
// dies before dates are given logs with blank date fields.
//
// One-write rule, two dedup guards:
//   · Booked  — never a second row for the same booking id. The overnight flow
//     reaches "Booked" at BOTH creation (collectDetails) and confirmation
//     (recordEta); only the first lands. Two SEPARATE attempts each hit their own
//     terminal and correctly produce two rows.
//   · Invalid Input — never a second OPEN (booking-less) Invalid-Input row for the
//     same phone, so repeated fumbles in one attempt collapse to one row.
async function logEnquiry(property, phone, outcome, opts = {}) {
  const { checkInIso, checkOutIso, bookingType, bookingId, firstMessageAt, lastMessageAt, lastStep, testPhone } = opts;
  const tracking = enquiryTrackingEnabled();
  const closed = {
    phone, outcome, lastStep: lastStep || null, firstMessageAt: firstMessageAt || null, lastMessageAt: lastMessageAt || null,
    firstMessageHourSast: sastHourOf(firstMessageAt), lastMessageHourSast: sastHourOf(lastMessageAt),
    bookingType: bookingType || null, bookingId: bookingId || null, propertyId: property.id
  };

  // A test phone never produces an enquiry row. The event still goes to Axiom
  // (flagged), so a tester can watch their own flow.
  if (testPhone) {
    logToAxiom('info', 'enquiry_skipped_test_phone', { phone, outcome });
    if (tracking) logToAxiom('info', 'enquiry_closed', { ...closed, testPhone: true });
    return false;
  }

  const existing = await airtableGet('WS_Enquiries', '');
  // One row per booking per outcome. A Booked row used to be the only kind that
  // carried a booking id, so any row for the booking counted; Cancelled and Hold
  // Expired also carry it, so they must be allowed to follow a Booked row.
  if (bookingId && existing.some(e => (e.fields['Booking'] || []).includes(bookingId) &&
        (outcome === 'Booked' || e.fields['Outcome'] === outcome))) return false;
  if (outcome === 'Invalid Input' && existing.some(e =>
        e.fields['Phone Number'] === phone &&
        e.fields['Outcome'] === 'Invalid Input' &&
        (e.fields['Booking'] || []).length === 0)) return false;

  // WABISTAY_AFTER_HOURS: a guest who books in the same closed window has their After Hours row turned into the
  // Booked row, not a second row beside it.
  if (outcome === 'Booked' && bookingId && afterHoursEnabled()) {
    const w = closedWindowInfo(new Date());
    const open = w && existing
      .filter(e => e.fields['Phone Number'] === phone && e.fields['Outcome'] === 'After Hours' &&
        (e.fields['Booking'] || []).length === 0 && Date.parse(e.fields['Created At'] || '') >= Date.parse(w.startIso))
      .sort((a, b) => Date.parse(b.fields['Created At']) - Date.parse(a.fields['Created At']))[0];
    if (open) {
      const upd = { 'Outcome': 'Booked', 'Booking': [bookingId] };
      if (checkInIso) upd['Requested Check In'] = checkInIso;
      if (checkOutIso) upd['Requested Check Out'] = checkOutIso;
      if (bookingType) upd['Booking Type'] = bookingType;
      if (tracking && lastMessageAt) upd['Last Message At'] = lastMessageAt;
      const updWrite = await airtableUpdate('WS_Enquiries', open.id, upd);
      if (updWrite && updWrite.error) {
        logToAxiom('error', 'enquiry_log_write_failed', { phone, propertyId: property.id, outcome, error: JSON.stringify(updWrite.error) });
        return false;
      }
      logToAxiom('info', 'enquiry_logged', { phone, propertyId: property.id, outcome, bookingType: bookingType || null, upgradedFrom: 'After Hours' });
      if (tracking) logToAxiom('info', 'enquiry_closed', { ...closed, testPhone: false });
      return true;
    }
  }

  const fields = {
    'Phone Number': phone,
    'Property': [property.id],
    'Outcome': outcome,
    'Created At': new Date().toISOString()
  };
  if (checkInIso) fields['Requested Check In'] = checkInIso;
  if (checkOutIso) fields['Requested Check Out'] = checkOutIso;
  if (bookingType) fields['Booking Type'] = bookingType;
  if (bookingId) fields['Booking'] = [bookingId];
  if (tracking) {
    if (firstMessageAt) fields['First Message At'] = firstMessageAt;
    if (lastMessageAt) fields['Last Message At'] = lastMessageAt;
    if (lastStep) fields['Last Step'] = lastStep;
  }
  // Rule 30 step 2, slice 2: NON-FATAL — WS_Enquiries is a one-way reporting
  // sink, nothing in the live guest/booking flow reads it back. The dedup
  // guards above (lines 3069-3073) re-query fresh on each future call, so a
  // failed write here just risks a duplicate row next attempt, not a broken
  // state. Previously logged 'enquiry_logged' unconditionally even on a
  // failed create, which was itself a small Rule 30 violation — now split.
  const enquiryWrite = await airtableCreate('WS_Enquiries', fields);
  if (enquiryWrite && enquiryWrite.error) {
    logToAxiom('error', 'enquiry_log_write_failed', {
      phone, propertyId: property.id, outcome, error: JSON.stringify(enquiryWrite.error)
    });
    return false;
  }
  logToAxiom('info', 'enquiry_logged', { phone, propertyId: property.id, outcome, bookingType: bookingType || null });
  if (tracking) logToAxiom('info', 'enquiry_closed', { ...closed, testPhone: false });
  return true;
}

// Staleness sweep. Runs on the auto-checkout cron. Two DECOUPLED jobs per
// stale guest, in order:
//   1. RESET — unconditional beyond staleness. A guest sitting in any of the
//      5 AWAITING_* states this long has nothing to lose from starting over,
//      whether or not they ever gave a name or produced a bookable draft.
//      This is the actual user-facing fix (closing the stuck-state gap,
//      recDAQmhoe4aFHvFy) and always runs when a guest is stale.
//   2. LOG — best-effort 'Abandoned' WS_Enquiries report row, same
//      preconditions as before this change (gave a name, no terminal already
//      covering this attempt, a property can be recovered). These exist for
//      REPORTING QUALITY, not for deciding whether to reset, so a guest who
//      fails them still gets reset — just without a report row.
//
// Why AWAITING_DETAILS/AWAITING_HOURLY_DETAILS specifically NEEDED this split
// (found while extending coverage to them, not assumed): unlike the original
// 3 states, a guest still stuck at the details-capture step has (a) never
// successfully parsed a name — Guest Name is still 'Unknown', which would
// fail gate 1 below; (b) no pending Enquiry booking yet, so no room to walk
// to a property — always fails the property-recovery gate; and (c) almost
// always already has a deduped 'Invalid Input' WS_Enquiries row from their
// first failed parse attempt, whose Created At is >= their state-entry
// timestamp — which trips the "already covered" dedup guard on every sweep
// run, forever. Leaving the old single gated code path unchanged and just
// adding these 2 states to ENQUIRY_ABANDON_STATES would have queried them
// correctly but then silently skipped every single one at one of these three
// gates — the guest would never actually get reset. Splitting the reset out
// from these three (still-correct, still-necessary) log preconditions is
// what actually closes the gap.
// With tracking on the sweep also covers the greeting step (AWAITING_STAY_TYPE),
// which it used to be blind to: a guest who says hi and then goes quiet is the
// commonest lost enquiry there is. CONFIRMED stays out: those are bookings, and
// the hold release (Hold Expired) deals with them.
function abandonStates() {
  return enquiryTrackingEnabled() ? [...ENQUIRY_ABANDON_STATES, 'AWAITING_STAY_TYPE'] : ENQUIRY_ABANDON_STATES;
}

// When the guest was last heard from. Tracking falls back to the attempt's start
// for a guest whose 'Last Inbound At' was never written (the greeting didn't).
function lastActivityIso(guest) {
  return guest.fields['Last Inbound At'] || (enquiryTrackingEnabled() ? guest.fields['Attempt Started At'] : null) || null;
}

async function runEnquiryAbandonment(now = new Date(), opts = {}) {
  const { deadline = Infinity } = opts;
  const nowMs = now.getTime();
  const summary = { abandoned: 0 };
  const tracking = enquiryTrackingEnabled();
  const guests = await airtableGet('WS_Guests', orFormula('Session State', abandonStates()));

  // Most ticks have nobody stale. The whole WS_Enquiries table (which only ever
  // grows) used to be read on every one of them, every 5 minutes; now it is read
  // only when there is at least one stale guest to process.
  const stale = guests.filter(g => {
    const li = lastActivityIso(g);
    return li && (nowMs - Date.parse(li)) >= ENQUIRY_ABANDON_MS;
  });
  if (stale.length === 0) return summary;
  const enquiries = await airtableGet('WS_Enquiries', '');

  for (const guest of stale) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      logToAxiom('warn', 'cron_time_budget_hit', { cron: 'auto_checkout', stage: 'abandonment', leftFrom: guest.id });
      break;
    }
    const lastInbound = lastActivityIso(guest);
    if (!lastInbound || (nowMs - Date.parse(lastInbound)) < ENQUIRY_ABANDON_MS) continue;
    const stepWhenStopped = guest.fields['Session State'];   // before the reset below

    // 1. RESET — see function comment. No proactive WhatsApp send: a guest
    // silent 24h+ is outside Meta's free-form service window, so this only
    // takes effect on their own next inbound message. updateGuestState logs
    // its own guest_state_write_failed on error — non-fatal, best-effort,
    // matches this sweep's existing posture throughout.
    await updateGuestState(guest.id, { 'Session State': 'NEW' });
    logToAxiom('info', 'enquiry_abandoned', { phone: guest.fields['Phone Number'], guestId: guest.id, sessionState: guest.fields['Session State'] });
    summary.abandoned++;

    // 2. LOG — optional 'Abandoned' report row. Unchanged preconditions from
    // before this task; for AWAITING_DETAILS/AWAITING_HOURLY_DETAILS these
    // will usually (not always) skip the log — see function comment — which
    // is fine: the reset above already happened regardless.
    const name = guest.fields['Guest Name'];
    // Tracking drops the "gave a name" gate: a guest who never got as far as a
    // name is exactly the lost enquiry we want to count.
    if (!tracking && (!name || name === 'Unknown')) continue;  // "provided at least a name"

    const phone = formatPhone(String(guest.fields['Phone Number'] || ''));
    // One-write guard: skip if an enquiry row for this phone already exists for
    // this attempt (created at/after the guest's last activity — i.e. a terminal
    // was already reached on that last message).
    if (enquiries.some(e => e.fields['Phone Number'] === phone &&
        Date.parse(e.fields['Created At']) >= Date.parse(lastInbound) - 60000)) continue;

    // Recover the property from the guest's pending Enquiry booking → room.
    const pending = (await airtableGetBookingsByGuestId(guest.id, 'Enquiry'))[0] || null;
    const roomId = pending && (pending.fields['Room'] || [])[0];
    const room = roomId ? (await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`))[0] : null;
    const propId = room && (room.fields['Property'] || [])[0];
    let property = propId ? (await airtableGet('WS_Properties', `RECORD_ID() = '${propId}'`))[0] : null;
    // No booking to walk to a property from: use the property the attempt began at.
    const attemptPropId = (guest.fields['Attempt Property'] || [])[0];
    if (!property && tracking && attemptPropId) property = { id: attemptPropId };
    if (!property) continue; // cannot scope without a property — leave the log for a later run

    await logEnquiry(property, phone, 'Abandoned', {
      checkInIso: pending && pending.fields['Check In'],
      checkOutIso: pending && pending.fields['Check Out'],
      bookingType: pending && pending.fields['Booking Type'],
      // When they went quiet, not when this sweep noticed 24 hours later.
      firstMessageAt: guest.fields['Attempt Started At'], lastMessageAt: lastInbound, lastStep: stepWhenStopped,
      testPhone: isTestGuest(guest)
    });
  }
  return summary;
}

async function autoCheckoutHandler(req, res) {
  logFlagsOnce();
  try {
    // A 'cron_started' with no matching 'cron_duration' in Axiom is a run that
    // was killed (504) before it could finish.
    const startedAt = Date.now();
    logToAxiom('info', 'cron_started', { cron: 'auto_checkout' });
    const deadline = startedAt + cronTimeBudgetMs();
    // propertyCount used to be a fresh { value: 0 } that nothing ever set, so every run
    // logged propertyCount 0 and callsPerProperty null even with work done. This cron
    // sweeps across properties rather than per property, so the count is the number
    // of properties in the base, read once (one extra call, included in the total).
    const propertyCountRef = { value: 0 };
    const { summary, enquiry, holds, overdue, unattended } = await withAirtableCallCount('auto_checkout', propertyCountRef, async () => {
      propertyCountRef.value = (await airtableGet('WS_Properties', '')).length;
      const summary = await runAutoCheckout(new Date(), { deadline });
      // B19: reuse this cron for the enquiry-abandonment staleness sweep.
      const enquiry = await runEnquiryAbandonment(new Date(), { deadline });
      // Doc 1b PR 6: stale-hold release, then the overdue question. Both share
      // the same deadline, so they only get the time the sweeps above left.
      const holds = await runHoldRelease(new Date(), { deadline });
      const overdue = await runOverdueAlerts(new Date(), { deadline });
      const unattended = await runUnattendedGateSweep(new Date(), { deadline });
      return { summary, enquiry, holds, overdue, unattended };
    });
    logToAxiom('info', 'cron_duration', {
      cron: 'auto_checkout', ms: Date.now() - startedAt,
      truncated: !!(summary.truncated || enquiry.truncated || holds.truncated || overdue.truncated || unattended.truncated)
    });
    res.status(200).json({
      ok: true, ...summary, ...enquiry,
      holdsReleased: holds.holdsReleased, overdueAlerts: overdue.overdueAlerts, unattendedGateArrivals: unattended.unattendedGateArrivals,
      ...(holds.truncated || overdue.truncated || unattended.truncated ? { truncated: true } : {})
    });
  } catch (err) {
    console.error('[AUTO-CHECKOUT FATAL]', err.message, err.stack);
    logToAxiom('error', 'auto_checkout_fatal', { message: err.message, stack: err.stack });
    res.status(200).json({ ok: false, error: err.message });
  }
}

// ─── OWNER SUMMARY (B17) ─────────────────────────────────────────────────────
// "The weekly P&L IS the product." A per-property aggregation over WS_Bookings,
// run weekly (a daily variant is available behind OWNER_SUMMARY_DAILY). The SEND
// is stubbed: a weekly summary is a business-initiated message outside any 24h
// window, so it needs an approved Meta utility template (Shawn submits; Meta
// reviews on their own clock). Everything except the send is built and testable
// now — sendOwnerSummary logs the fully-assembled payload to Axiom so the
// aggregation is verifiable end-to-end before the template exists.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Meta utility template name for the owner summary. FLAG: pending Meta approval
// (Shawn submits). When approved, this is the one-line swap point in
// sendOwnerSummary below.
const OWNER_SUMMARY_TEMPLATE = 'wabistay_owner_weekly_summary';
const ownerSummaryTemplateName = () => reportTemplateName('WABISTAY_OWNER_SUMMARY_TEMPLATE', OWNER_SUMMARY_TEMPLATE);

// Room-nights sold for one booking. Convention (stated explicitly per the brief):
//   · Overnight → whole nights, rounded from the 14:00→10:00 clock span
//     (a 1-night 14:00→10:00 stay is 20h of clock but counts as 1 night).
//   · Hourly    → a PARTIAL room-night: the raw fraction of a day (2h = 2/24).
// A booking missing either date contributes 0 (cannot be measured).
function bookingRoomNights(booking) {
  const ci = booking.fields['Check In'];
  const co = booking.fields['Check Out'];
  if (!ci || !co) return 0;
  const rawDays = (Date.parse(co) - Date.parse(ci)) / DAY_MS;
  if (!Number.isFinite(rawDays) || rawDays <= 0) return 0;
  // A Day stay (about 9 hours) is a PART of a room-night, like an hourly stay; rounding it to whole nights counted it as 0.
  return (booking.fields['Booking Type'] === 'Hourly' || booking.fields['Booking Type'] === 'Day') ? rawDays : Math.round(rawDays);
}

// Stage 1 (payment reconciliation): per-booking Amount Due vs Amount Paid,
// over the same period window the rest of the summary already uses — no new
// query, no new window, just read off the same `periodBookings` the revenue
// total is already computed from. Design note, not a gap: a delta can only
// ever be known once reception has actually recorded a collection via
// PAID/COLLECTED — there is no way to auto-detect real-world cash changing
// hands. A booking reception has not yet acted on shows its full Amount Due
// as delta, which is correct: it IS outstanding, by definition, until
// reception reports otherwise.
function paymentReconciliationLines(periodBookings, roomsById, guestsById) {
  return periodBookings.map(b => {
    const amountDue = Number(b.fields['Amount Due']) || 0;
    const amountPaid = Number(b.fields['Amount Paid']) || 0;
    const roomId = (b.fields['Room'] || [])[0] || null;
    const guestId = (b.fields['Guest'] || [])[0] || null;
    return {
      bookingId: b.id,
      bookingRef: b.fields['Booking Ref'] || null,
      roomName: roomId ? (roomsById.get(roomId) || null) : null,
      guestName: guestId ? (guestsById.get(guestId) || null) : null,
      amountDue,
      amountPaid,
      delta: amountDue - amountPaid
    };
  });
}

// Aggregates one property's bookings over the reporting window. `bookings` is
// already scoped to this property (via room link) and already excludes Cancelled.
function aggregateOwnerSummary(property, rooms, bookings, w, guestsById = new Map()) {
  const checkInMs = b => (b.fields['Check In'] ? Date.parse(b.fields['Check In']) : NaN);
  const inPeriod = b => {
    const t = checkInMs(b);
    return Number.isFinite(t) && t >= w.periodStartMs && t < w.periodEndMs;
  };
  const periodBookings = bookings.filter(inPeriod);

  const totalRevenue = periodBookings.reduce((s, b) => s + (Number(b.fields['Amount Due']) || 0), 0);
  const roomNightsSold = periodBookings.reduce((s, b) => s + bookingRoomNights(b), 0);
  const roomNightsAvailable = rooms.length * w.periodDays;
  const occupancyRate = roomNightsAvailable > 0 ? roomNightsSold / roomNightsAvailable : 0;

  const upcomingBookings = bookings.filter(b => {
    const t = checkInMs(b);
    return Number.isFinite(t) && t >= w.periodEndMs && t < w.upcomingEndMs;
  }).length;

  const roomsById = new Map(rooms.map(r => [r.id, r.fields['Room Name'] || null]));
  const paymentLines = paymentReconciliationLines(periodBookings, roomsById, guestsById);
  const paymentDeltaTotal = paymentLines.reduce((s, l) => s + l.delta, 0);

  return {
    propertyId: property.id,
    propertyName: property.fields['Property Name'],
    periodDays: w.periodDays,
    totalBookings: periodBookings.length,
    totalRevenue,
    roomNightsSold,
    roomNightsAvailable,
    // Rounded to 4 dp so partial (hourly) nights are visible without float noise.
    occupancyRate: Math.round(occupancyRate * 10000) / 10000,
    upcomingBookings,
    paymentLines,
    paymentDeltaTotal
  };
}

// Renders the Stage 1 reconciliation section of the weekly message: one
// aggregate delta line at the top (the number an owner actually needs first),
// then one line per booking. A booking reception has already fully settled
// still appears, at R0.00 delta — completeness matters more than brevity
// here, since the entire point is "is anything unaccounted for," and a
// filtered list can't answer that as trustworthily as a complete one can.
function formatPaymentReconciliationMessage(summary) {
  const sign = summary.paymentDeltaTotal >= 0 ? '' : '-';
  const lines = [
    `💰 *Payment Reconciliation — ${summary.propertyName}*`,
    `*Total Delta:* ${sign}R${formatAmount(Math.abs(summary.paymentDeltaTotal))}`,
    ''
  ];
  if (summary.paymentLines.length === 0) {
    lines.push('No bookings this period.');
  } else {
    for (const l of summary.paymentLines) {
      const lSign = l.delta >= 0 ? '' : '-';
      lines.push(
        `${l.roomName || 'Unknown room'} — ${l.guestName || 'Unknown guest'}: ` +
        `Due R${formatAmount(l.amountDue)} / Paid R${formatAmount(l.amountPaid)} ` +
        `(Δ ${lSign}R${formatAmount(Math.abs(l.delta))})`
      );
    }
  }
  return lines.join('\n');
}

// The send surface. STUBBED until OWNER_SUMMARY_TEMPLATE is approved: logs the
// full payload to Axiom (so aggregation is verifiable now) and marks exactly
// where the template send goes.
async function sendOwnerSummary(property, summary) {
  const notifyPhone = property.fields['Notify Phone']
    ? property.fields['Notify Phone'].replace(/[\s\-\+]/g, '')
    : (OWNER_PHONE || null);
  const paymentReconciliationMessage = formatPaymentReconciliationMessage(summary);
  const payload = { ...summary, template: ownerSummaryTemplateName(), notifyPhone, paymentReconciliationMessage };
  // Last Report Sent is deliberately NOT written back to WS_Properties here —
  // runOwnerSummary/runDailySummary are documented and tested (Rule 29,
  // test/dailysummary.test.js) as read-only reporting with zero Airtable
  // writes from either cron; adding one would silently break that invariant.
  // "Last Report Sent" is surfaced from this same owner_summary_payload
  // Axiom event instead (it already carries propertyId + the event's own
  // _time) — see the property-activity-tracker PR body for the query.
  logToAxiom('info', 'owner_summary_payload', payload);

  // TODO(B17): `sendWhatsAppTemplate` now EXISTS (see the WhatsApp template helper
  // above) — the only thing still missing is Meta's approval of
  // OWNER_SUMMARY_TEMPLATE. Once approved, this is the one-line swap:
  //   await sendWhatsAppTemplate(notifyPhone, OWNER_SUMMARY_TEMPLATE, ownerSummaryTemplateParams(summary), { site: 'owner_summary', propertyId: property.id });
  // Left stubbed here deliberately: enabling it is a separate, CEO-gated change,
  // not a side effect of building the helper.
  // Deliberately NOT a free-form sendWhatsApp — that would 200-and-vanish.

  return payload;
}

// ─── MONTHLY BI ROLLUP ───────────────────────────────────────────────────────
// NOT a bigger daily/weekly summary at a monthly cadence — a distinct
// analytics feature: this month vs last month, presented as insight
// ("occupancy up 12%") rather than side-by-side raw numbers where possible.
// No monthly cron existed before this (manual-report.js's "monthly" option
// reuses aggregateOwnerSummary with a 30-day window purely as a preview
// stand-in — see its own header comment — this is the real thing).
//
// Per metric, computability against TODAY's schema:
//   · Occupancy trend      — COMPUTABLE, but inherits aggregateOwnerSummary's
//     existing roomNightsAvailable gap (rooms.length * periodDays assumes
//     every currently-bookable room was available the WHOLE period — no
//     accounting for a room added mid-period or one that spent part of the
//     period in Maintenance). Flagged in the payload itself
//     (occupancy.denominatorCaveat), not silently shipped as exact.
//   · Revenue trend        — COMPUTABLE. Uses 'Amount Due' (same field
//     aggregateOwnerSummary's totalRevenue uses), not 'Amount Paid' — so
//     this is billed revenue, not collected cash. Same definition as the
//     existing weekly report, deliberately, so the two reports never
//     disagree about what "revenue" means for the same booking.
//   · Average length of stay — COMPUTABLE, overnight bookings only (a
//     "length of stay" in nights is not a meaningful concept for Hourly
//     bookings, which are a different product on the same booking table).
//   · Repeat-guest rate    — COMPUTABLE, but scoped: "repeat" means the
//     guest has more than one booking within the `bookings` array this
//     function is given (already filtered to BLOCKING_BOOKING_STATUSES +
//     Checked Out, scoped to this property, unbounded by date) — not
//     lifetime history if older bookings were ever purged from Airtable.
//   · Cleaning turnaround  — NOT the true vacant-to-ready number (see
//     BACKLOG-01 in CLAUDE.md and jobDurationMs's own comment above): that
//     baseline is overwritten every checkout cycle and never persisted.
//     Reports jobDurationMs (cleaner dispatch → DONE) instead, explicitly
//     labeled as a proxy, not silently presented as the real thing.
//   · Rating trend         — COMPUTABLE. WS_Bookings.Rating, already
//     captured by the existing Stage 3 Phase 3 rating flow.
// Meta-approved name, confirmed directly from Meta Business Manager's edit
// view — the constant previously said 'wabistay_monthly_bi_report' (a
// pre-submission draft name that was never updated once the real template
// was approved under a different name).
const MONTHLY_REPORT_TEMPLATE = 'wabistay_owner_monthly_recap';
const monthlyReportTemplateName = () => reportTemplateName('WABISTAY_MONTHLY_REPORT_TEMPLATE', MONTHLY_REPORT_TEMPLATE);

function avgOrNull(values) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

function pctDeltaInsight(label, current, prior, unit = '%') {
  if (prior === null || prior === 0) {
    return current === null ? `${label}: no data` : `${label}: ${current}${unit} (no prior-month baseline to compare)`;
  }
  if (current === null) return `${label}: no data this month`;
  const deltaPct = Math.round(((current - prior) / Math.abs(prior)) * 100);
  const direction = deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : 'flat vs';
  return deltaPct === 0
    ? `${label}: flat vs last month (${current}${unit})`
    : `${label} ${direction} ${Math.abs(deltaPct)}% vs last month (${current}${unit})`;
}

// One-sentence "most common stay duration" per booking type, not a full
// distribution — a distribution doesn't scale across properties of varying
// volume (unreadable/absurd at low booking counts). Falls back to an average
// when there's no single clear mode (a tie) or too few bookings to call one
// value "most common" with a straight face.
// DURATION_MODE_MIN_BOOKINGS: suggested default, pending CEO confirmation —
// see pr-bodies/monthly-bi-duration-mode.md.
const DURATION_MODE_MIN_BOOKINGS = 3;

function durationModeInsight(rawDurations, { noun, unit, minCount = DURATION_MODE_MIN_BOOKINGS }) {
  const valid = rawDurations.filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const label = noun.charAt(0).toUpperCase() + noun.slice(1);
  const pluralize = n => `${n} ${unit}${n === 1 ? '' : 's'}`;

  if (valid.length === 0) return `No ${noun} bookings this period.`;

  // Bucket by whole units — a stay is a discrete number of nights/hours even
  // if the raw checkIn/checkOut span isn't an exact multiple (e.g. a
  // 14:00→10:00 1-night stay is 20h of clock time).
  const rounded = valid.map(v => Math.round(v));

  if (valid.length >= minCount) {
    const counts = new Map();
    for (const v of rounded) counts.set(v, (counts.get(v) || 0) + 1);
    const maxCount = Math.max(...counts.values());
    const modes = [...counts.keys()].filter(k => counts.get(k) === maxCount);
    if (modes.length === 1) {
      return `Most ${noun} guests stayed ${pluralize(modes[0])}.`;
    }
    // Tie — fall through to average rather than pick an arbitrary winner.
  }

  const avg = Math.round((valid.reduce((s, v) => s + v, 0) / valid.length) * 10) / 10;
  return `${label} guests stayed an average of ${pluralize(avg)}.`;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_FULL_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// SAST calendar-day key ('YYYY-MM-DD') for a UTC ms instant — same SAST
// wall-clock convention as sastCalendarDate, just keyed for Map lookups.
function sastDayKey(ms) {
  const shifted = new Date(ms + SAST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function formatBusyDay(dayKey, withComma) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return withComma ? `${weekday}, ${d} ${MONTH_FULL_NAMES[m - 1]}` : `${weekday} ${d} ${MONTH_FULL_NAMES[m - 1]}`;
}

function joinWithAnd(items) {
  return items.length <= 1 ? (items[0] || '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Busiest single calendar day this period, by distinct rooms occupied — same
// whole-night convention as bookingRoomNights (a stay occupies each night's
// SAST calendar date from Check In up to, not including, Check Out; an
// Hourly booking occupies just its Check In date, consistent with it being a
// same-day booking). Ties are stated explicitly rather than silently picking
// a winner — same principle as durationModeInsight. Returns the structured
// pieces alongside the sentence: low-effort now, in case a future "same
// period last year" comparison wants the raw date(s)/count without
// re-parsing the sentence — that comparison itself is NOT built here.
function busiestDayInsight(currentBookings) {
  const roomsByDay = new Map(); // dayKey -> Set(roomId)

  for (const b of currentBookings) {
    const roomIds = b.fields['Room'] || [];
    if (roomIds.length === 0) continue;
    const inMs = b.fields['Check In'] ? Date.parse(b.fields['Check In']) : NaN;
    const outMs = b.fields['Check Out'] ? Date.parse(b.fields['Check Out']) : NaN;
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) continue;

    const nights = b.fields['Booking Type'] === 'Hourly' ? 1 : Math.max(1, Math.round((outMs - inMs) / DAY_MS));
    for (let n = 0; n < nights; n++) {
      const dayKey = sastDayKey(inMs + n * DAY_MS);
      if (!roomsByDay.has(dayKey)) roomsByDay.set(dayKey, new Set());
      for (const roomId of roomIds) roomsByDay.get(dayKey).add(roomId);
    }
  }

  if (roomsByDay.size === 0) {
    return { busiestDayInsight: 'No bookings this month.', busiestDates: [], roomsOccupied: 0 };
  }

  let maxCount = 0;
  for (const set of roomsByDay.values()) maxCount = Math.max(maxCount, set.size);
  const busiestDates = [...roomsByDay.entries()]
    .filter(([, set]) => set.size === maxCount)
    .map(([dayKey]) => dayKey)
    .sort();

  const insight = busiestDates.length === 1
    ? `Your busiest day this month was ${formatBusyDay(busiestDates[0], true)}, with ${maxCount} room${maxCount === 1 ? '' : 's'} occupied.`
    : `Your busiest days this month were ${joinWithAnd(busiestDates.map(d => formatBusyDay(d, false)))}.`;

  return { busiestDayInsight: insight, busiestDates, roomsOccupied: maxCount };
}

// `bookings` is already property-scoped and status-filtered (same contract
// as aggregateOwnerSummary) but NOT period-filtered — this function does its
// own current/prior windowing internally so callers fetch Airtable data once
// and this and aggregateOwnerSummary can share it if ever called together.
function aggregateMonthlyReport(property, rooms, bookings, w, guestsById = new Map()) {
  const checkInMs = b => (b.fields['Check In'] ? Date.parse(b.fields['Check In']) : NaN);
  const inRange = (b, startMs, endMs) => {
    const t = checkInMs(b);
    return Number.isFinite(t) && t >= startMs && t < endMs;
  };

  const currentBookings = bookings.filter(b => inRange(b, w.periodStartMs, w.periodEndMs));
  const priorBookings = bookings.filter(b => inRange(b, w.priorPeriodStartMs, w.periodStartMs));

  // Occupancy
  const roomNightsSold = currentBookings.reduce((s, b) => s + bookingRoomNights(b), 0);
  const roomNightsAvailable = rooms.length * w.periodDays;
  const occupancyRate = roomNightsAvailable > 0 ? roomNightsSold / roomNightsAvailable : null;
  const priorRoomNightsSold = priorBookings.reduce((s, b) => s + bookingRoomNights(b), 0);
  const priorOccupancyRate = roomNightsAvailable > 0 ? priorRoomNightsSold / roomNightsAvailable : null;

  // Revenue (billed, 'Amount Due' — see header comment)
  const revenue = currentBookings.reduce((s, b) => s + (Number(b.fields['Amount Due']) || 0), 0);
  const priorRevenue = priorBookings.reduce((s, b) => s + (Number(b.fields['Amount Due']) || 0), 0);

  // Average length of stay — overnight only
  const nightsOf = b => {
    const inMs = checkInMs(b);
    const outMs = b.fields['Check Out'] ? Date.parse(b.fields['Check Out']) : NaN;
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) return null;
    return (outMs - inMs) / DAY_MS;
  };
  const overnightCurrent = currentBookings.filter(b => b.fields['Booking Type'] === 'Overnight');
  const avgLengthOfStay = avgOrNull(overnightCurrent.map(nightsOf));

  // Most common stay duration, one sentence per booking type — see
  // durationModeInsight's own header comment for the mode-vs-average logic.
  const hoursOf = b => {
    const inMs = checkInMs(b);
    const outMs = b.fields['Check Out'] ? Date.parse(b.fields['Check Out']) : NaN;
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) return null;
    return (outMs - inMs) / HOUR_MS;
  };
  // Day stays are counted with the short stays; before, they appeared in neither group.
  const hourlyCurrent = currentBookings.filter(b => b.fields['Booking Type'] === 'Hourly' || b.fields['Booking Type'] === 'Day');
  const overnightDurationModeInsight = durationModeInsight(overnightCurrent.map(nightsOf), { noun: 'overnight', unit: 'night' });
  const shortStayDurationModeInsight = durationModeInsight(hourlyCurrent.map(hoursOf), { noun: 'short-stay', unit: 'hour' });

  // Repeat-guest rate — rolling 12-month window, not lifetime-cumulative (a
  // lifetime count only ever climbs and stops being a useful
  // current-performance signal after a property has run a few years) and not
  // within-month (this measures returning-from-a-previous-visit behaviour,
  // not two bookings landing in the same 30-day window). "Repeat" = a guest
  // in this month's bookings who has at least one OTHER booking with a Check
  // In date in the 12 months immediately prior to this period — the window
  // boundary at periodStartMs means the current stay itself can never be its
  // own "prior" booking, so no separate exclusion check is needed.
  //
  // Identity: the booking's linked 'Guest' record ID, same field every other
  // repeat-adjacent read in this file uses — NOT a raw phone-number string
  // comparison. This is deliberate and already reliable: WS_Guests records
  // are deduped by 'Phone Number' at CREATE time (see the WALKIN guest-
  // identity block, ~line 1907) before a Guest ID ever gets linked to a
  // booking, so by the time a report reads booking.fields['Guest'], any
  // guest reachable by phone already has a single stable ID. A guest with no
  // phone (e.g. a phone-less walk-in) gets an always-unique record and is
  // correctly never falsely matched to anyone else — already the documented,
  // locked behaviour for repeat-guest tracking, not a new gap introduced here.
  const REPEAT_GUEST_WINDOW_MS = 365 * DAY_MS;
  const repeatWindowStartMs = w.periodStartMs - REPEAT_GUEST_WINDOW_MS;
  const priorYearGuestIds = new Set(
    bookings
      .filter(b => {
        const t = checkInMs(b);
        return Number.isFinite(t) && t >= repeatWindowStartMs && t < w.periodStartMs;
      })
      .flatMap(b => b.fields['Guest'] || [])
  );
  const currentGuestIds = new Set(currentBookings.flatMap(b => b.fields['Guest'] || []));
  const repeatGuestRate = currentGuestIds.size > 0
    ? [...currentGuestIds].filter(id => priorYearGuestIds.has(id)).length / currentGuestIds.size
    : null;

  // Cleaning turnaround — job duration proxy, see header comment
  const avgCleaningJobDurationMs = avgOrNull(currentBookings.map(jobDurationMs));
  const priorAvgCleaningJobDurationMs = avgOrNull(priorBookings.map(jobDurationMs));

  // Rating trend
  const ratingOf = b => (typeof b.fields['Rating'] === 'number' ? b.fields['Rating'] : null);
  const avgRating = avgOrNull(currentBookings.map(ratingOf));
  const priorAvgRating = avgOrNull(priorBookings.map(ratingOf));

  const occupancyPct = occupancyRate === null ? null : Math.round(occupancyRate * 1000) / 10;
  const priorOccupancyPct = priorOccupancyRate === null ? null : Math.round(priorOccupancyRate * 1000) / 10;

  const insights = [
    pctDeltaInsight('Occupancy', occupancyPct, priorOccupancyPct),
    pctDeltaInsight('Revenue', Math.round(revenue), Math.round(priorRevenue), ''),
    avgLengthOfStay === null ? 'Average length of stay: no overnight bookings this month' : `Average length of stay: ${avgLengthOfStay.toFixed(1)} nights`,
    repeatGuestRate === null ? 'Repeat-guest rate: no bookings this month' : `${Math.round(repeatGuestRate * 100)}% of this month's guests were repeat guests`,
    avgCleaningJobDurationMs === null
      ? 'Cleaning turnaround: no completed cleaning jobs this month'
      : `Average cleaning job duration: ${Math.round(avgCleaningJobDurationMs / 60000)} min (dispatch-to-DONE, not vacant-to-ready — see BACKLOG-01)`,
    avgRating === null ? 'Guest rating: no ratings captured this month' : pctDeltaInsight('Guest rating', Math.round(avgRating * 10) / 10, priorAvgRating === null ? null : Math.round(priorAvgRating * 10) / 10, '/5')
  ];

  const busiestDay = busiestDayInsight(currentBookings);

  return {
    propertyId: property.id,
    propertyName: property.fields['Property Name'],
    periodDays: w.periodDays,
    occupancy: { currentPct: occupancyPct, priorPct: priorOccupancyPct, denominatorCaveat: 'assumes every currently-bookable room was available the entire period — see BACKLOG-01-adjacent gap in header comment' },
    revenue: { current: revenue, prior: priorRevenue },
    avgLengthOfStayNights: avgLengthOfStay,
    repeatGuestRate,
    avgCleaningJobDurationMs,
    priorAvgCleaningJobDurationMs,
    avgRating,
    priorAvgRating,
    insights,
    overnightBookingsCount: overnightCurrent.length,
    overnightDurationModeInsight,
    shortStayBookingsCount: hourlyCurrent.length,
    shortStayDurationModeInsight,
    busiestDayInsight: busiestDay.busiestDayInsight,
    // Structured alongside the sentence — not a YoY comparison feature, just
    // raw data a future comparison wouldn't have to re-parse out of the text.
    busiestDay: { dates: busiestDay.busiestDates, roomsOccupied: busiestDay.roomsOccupied },
    totalBookings: currentBookings.length
  };
}

// Meta APPROVED wabistay_owner_monthly_recap with exactly 11 {{n}} slots —
// confirmed directly from Meta Business Manager's edit view. An earlier pass
// built 13 params (split count + duration-mode sentence per booking type);
// that does not match what was actually approved. Overnight and short-stay
// each get ONE combined slot instead — see overnightBookingsParam/
// shortStayBookingsParam below, which reuse durationModeInsight's (PR #52)
// mode-vs-average-vs-tie decision output as-is, only reformatting the
// string, not the underlying logic.
//   {{1}} ownerName · {{2}} propertyName · {{3}} occupancy this-month ·
//   {{4}} occupancy last-month · {{5}} revenue this-month · {{6}} revenue
//   last-month · {{7}} overnight bookings (count + duration-mode, one
//   sentence) · {{8}} short-stay bookings (count + duration-mode, one
//   sentence) · {{9}} repeat-guest % (12-month rolling window) · {{10}}
//   rating this-month · {{11}} rating last-month.
// busiestDayInsight (PR #53) is deliberately NOT included — placement/
// whether-at-all is still an open CEO decision, not this pass's call to make.
//
// Deliberately synchronous and pure, same reasoning as
// dailySummaryTemplateParams: expects report.ownerName to already be
// resolved and attached by the caller (via resolveOwnerName) before this
// runs, and throws rather than silently defaulting if it's missing —
// sending "undefined" into a live WhatsApp template to a real owner is
// worse than a loud failure during wiring.
//
// Revenue params are the plain formatted currency figure only (e.g.
// "R12400") — the "earned" wording lives in the template's static text, not
// baked into the param, per instructions. Matches this file's existing
// R-prefix + Math.round currency convention (same as pctDeltaInsight's
// revenue formatting) rather than inventing a new comma-grouped format that
// doesn't exist anywhere else in this codebase.

// Combines {{overnight count}} + durationModeInsight's OUTPUT STRING (PR #52,
// untouched) into the one approved sentence. The zero-bookings case is
// decided from `count` (the report's own overnightBookingsCount), not by
// parsing durationModeInsight's "No overnight bookings this period." text,
// so this doesn't depend on that string's exact wording staying stable.
function overnightBookingsParam(count, durationSentence) {
  if (count === 0) return 'No overnight bookings this month.';
  const countText = `${count} overnight booking${count === 1 ? '' : 's'} this month`;
  const modeMatch = durationSentence.match(/^Most overnight guests stayed (.+)\.$/);
  if (modeMatch) return `${countText} — most guests stayed ${modeMatch[1]}.`;
  // Average fallback (tie, or below durationModeInsight's minimum booking
  // count) — reuse its existing average phrasing verbatim, minus the
  // redundant leading "Overnight ", per instructions: don't change that
  // underlying logic, just combine its output with the count.
  return `${countText} — ${durationSentence.replace(/^Overnight /, '')}`;
}

// Same combination for short-stay, but the approved copy uses a different
// verb/noun order for the clear-mode case ("booked N-hour stays" vs
// overnight's "stayed N night(s)") — durationModeInsight's decision logic
// (mode vs. average vs. tie) is still reused untouched; only the mode-case
// sentence is reworded to match the approved template text.
function shortStayBookingsParam(count, durationSentence) {
  if (count === 0) return 'No short-stay bookings this month.';
  const countText = `${count} short-stay booking${count === 1 ? '' : 's'} this month`;
  const modeMatch = durationSentence.match(/^Most short-stay guests stayed (\d+(?:\.\d+)?) hours?\.$/);
  if (modeMatch) return `${countText} — most guests booked ${modeMatch[1]}-hour stays.`;
  return `${countText} — ${durationSentence.replace(/^Short-stay /, '')}`;
}

function monthlyReportTemplateParams(report) {
  if (report.ownerName === undefined || report.ownerName === null) {
    throw new Error(
      'monthlyReportTemplateParams: report.ownerName is missing — resolve it with ' +
      'resolveOwnerName(property) and attach it to the report before calling this function.'
    );
  }

  const pctOrNA = v => (v === null ? 'N/A' : `${v}%`);
  const ratingOrNA = v => (v === null ? 'N/A' : `${Math.round(v * 10) / 10}`);

  return [
    report.ownerName,
    report.propertyName,
    pctOrNA(report.occupancy.currentPct),
    pctOrNA(report.occupancy.priorPct),
    `R${Math.round(report.revenue.current)}`,
    `R${Math.round(report.revenue.prior)}`,
    overnightBookingsParam(report.overnightBookingsCount, report.overnightDurationModeInsight),
    shortStayBookingsParam(report.shortStayBookingsCount, report.shortStayDurationModeInsight),
    report.repeatGuestRate === null ? 'N/A' : `${Math.round(report.repeatGuestRate * 100)}%`,
    ratingOrNA(report.avgRating),
    ratingOrNA(report.priorAvgRating)
  ];
}

// STUBBED until MONTHLY_REPORT_TEMPLATE is approved — same pattern as every
// other business-initiated send in this file. Cleaning turnaround
// (insights[4]) is deliberately left OUT of the WhatsApp template body: it's
// an internal ops/quality metric the owner has no action to take on, and
// every template param costs message length — Axiom still gets the full
// `insights` array including it, for anyone who wants it.
async function sendMonthlyReport(property, report) {
  const notifyPhone = reportRecipientPhone(property);
  const ownerName = await resolveOwnerName(property);
  const reportWithOwner = { ...report, ownerName };
  const templateParams = monthlyReportTemplateParams(reportWithOwner);
  const payload = { ...reportWithOwner, template: monthlyReportTemplateName(), notifyPhone, templateParams };
  logToAxiom('info', 'monthly_report_payload', payload);

  // LIVE as of MONTHLY_REPORT_TEMPLATE's Meta approval — routed through the
  // REPORT_TEST_MODE_PHONE gate (see resolveSendRecipient's own header
  // comment) so a real send can be tested against the CEO's own number
  // before going out to real owners.
  const recipient = resolveSendRecipient(notifyPhone, 'monthly_report', { propertyId: property.id });
  if (!recipient) {
    throw new Error('sendMonthlyReport: no recipient phone available — property has no Notify Phone and OWNER_PHONE fallback is unset');
  }
  await sendWhatsAppTemplate(recipient, monthlyReportTemplateName(), templateParams, { site: 'monthly_report', propertyId: property.id });
  return payload;
}

async function runMonthlyReport(opts = {}) {
  const { now = new Date() } = opts;
  const periodDays = 30;
  const periodEndMs = now.getTime();
  const w = {
    periodDays,
    periodStartMs: periodEndMs - periodDays * DAY_MS,
    priorPeriodStartMs: periodEndMs - 2 * periodDays * DAY_MS,
    periodEndMs
  };

  // Unbounded by date (unlike aggregateOwnerSummary's periodBookings) so
  // repeat-guest counting and the prior-month window both see bookings
  // outside the current 30 days — same status filter as every other report,
  // just not date-filtered at the query level.
  // Four independent table reads, run together (they used to run one after the
  // other, and each walks Airtable's 100-record pages in turn).
  const [properties, allRooms, allBookings, allGuests] = await Promise.all([
    airtableGet('WS_Properties', ''),
    airtableGet('WS_Rooms', orFormula('Status', BOOKABLE_ROOM_STATUSES)),
    airtableGet('WS_Bookings', orFormula('Status', BLOCKING_BOOKING_STATUSES.concat(['Checked Out']))),
    airtableGet('WS_Guests', '')
  ]);
  const guestsById = new Map(allGuests.map(g => [g.id, g.fields['Guest Name'] || null]));

  const sent = [];
  const failed = [];
  for (const property of properties) {
    // Per-property isolation + alertShawn on failure — same established
    // pattern as runOwnerSummary/runDailySummary/runWeeklyRecap.
    try {
      const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
      const roomIds = new Set(rooms.map(r => r.id));
      const bookings = allBookings.filter(b => (b.fields['Room'] || []).some(id => roomIds.has(id)));
      const report = aggregateMonthlyReport(property, rooms, bookings, w, guestsById);
      await sendMonthlyReport(property, report);
      sent.push(report);
    } catch (err) {
      logToAxiom('error', 'monthly_report_property_failed', {
        propertyId: property.id, propertyName: property.fields?.['Property Name'] || null,
        message: err.message, stack: err.stack
      });
      await alertShawn('monthly_report', err.message, {
        propertyId: property.id, propertyName: property.fields?.['Property Name'] || null
      });
      failed.push({ propertyId: property.id, propertyName: property.fields?.['Property Name'] || null, error: err.message });
    }
  }
  sent.failed = failed;
  return sent;
}

async function monthlyReportHandler(req, res) {
  logFlagsOnce();
  try {
    const startedAt = Date.now();
    logToAxiom('info', 'cron_started', { cron: 'monthly_report' });
    const propertyCountRef = { value: 0 };
    const sent = await withAirtableCallCount('monthly_report', propertyCountRef, async () => {
      const result = await runMonthlyReport();
      propertyCountRef.value = result.length + (result.failed ? result.failed.length : 0);
      return result;
    });
    logToAxiom('info', 'cron_duration', { cron: 'monthly_report', ms: Date.now() - startedAt });
    res.status(200).json({ ok: true, count: sent.length, sent, failed: sent.failed || [] });
  } catch (err) {
    console.error('[MONTHLY-REPORT FATAL]', err.message, err.stack);
    logToAxiom('error', 'monthly_report_fatal', { message: err.message, stack: err.stack });
    await alertShawn('monthly_report_fatal', err.message, { scope: 'entire run, not a single property' });
    res.status(200).json({ ok: false, error: err.message });
  }
}

async function runOwnerSummary(opts = {}) {
  const {
    now = new Date(),
    daily = process.env.OWNER_SUMMARY_DAILY === 'true'
  } = opts;

  const propertyCountRef = { value: 0 };
  return withAirtableCallCount('owner_summary', propertyCountRef, async () => {
    const periodDays = daily ? 1 : 7;
    const periodEndMs = now.getTime();
    const w = {
      periodDays,
      periodStartMs: periodEndMs - periodDays * DAY_MS,
      periodEndMs,
      upcomingEndMs: periodEndMs + 7 * DAY_MS
    };

    const properties = await airtableGet('WS_Properties', '');
    propertyCountRef.value = properties.length;
    const allRooms = await airtableGet('WS_Rooms', orFormula('Status', BOOKABLE_ROOM_STATUSES));
    // Non-cancelled bookings only — a cancelled booking is neither revenue nor
    // occupancy. Scoped to each property below via its room link (WS_Bookings has
    // no Property field of its own).
    const allBookings = await airtableGet('WS_Bookings', orFormula('Status', BLOCKING_BOOKING_STATUSES.concat(['Checked Out'])));
    // Stage 1: guest names for the reconciliation line items. One extra table
    // read, same shape as allRooms/allBookings above — not a new query per
    // property, and not a new per-booking lookup either.
    const allGuests = await airtableGet('WS_Guests', '');
    const guestsById = new Map(allGuests.map(g => [g.id, g.fields['Guest Name'] || null]));

    const summaries = [];
    const failed = [];
    for (const property of properties) {
      // Per-property isolation, same reasoning as runDailySummary's own fix: one
      // property throwing here must not abort the rest of this run — before this
      // fix, an uncaught throw propagated straight out of the loop and silently
      // dropped every remaining property's weekly summary for that run, with no
      // automatic retry until next Monday (unlike daily, which self-heals within
      // the hour).
      try {
        const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
        const roomIds = new Set(rooms.map(r => r.id));
        const bookings = allBookings.filter(b => (b.fields['Room'] || []).some(id => roomIds.has(id)));
        const summary = aggregateOwnerSummary(property, rooms, bookings, w, guestsById);
        await sendOwnerSummary(property, summary);
        summaries.push(summary);
      } catch (err) {
        logToAxiom('error', 'owner_summary_property_failed', {
          propertyId: property.id, propertyName: property.fields?.['Property Name'] || null,
          message: err.message, stack: err.stack
        });
        // Fires per property, not once for the whole run, so the alert itself
        // says which property failed rather than just "owner summary failed".
        await alertShawn('owner_summary', err.message, {
          propertyId: property.id, propertyName: property.fields?.['Property Name'] || null
        });
        failed.push({ propertyId: property.id, propertyName: property.fields?.['Property Name'] || null, error: err.message });
      }
    }
    // Return shape is unchanged (still a plain array of successful summaries —
    // existing callers index/map/find on it directly) — `failed` is attached as
    // a non-indexed property so callers who need failure visibility can read
    // `result.failed` without breaking anyone who only ever treated this as an
    // array. JSON.stringify silently drops non-indexed array properties, which
    // is why ownerSummaryHandler below also spreads it into the JSON response
    // explicitly rather than relying on this alone.
    summaries.failed = failed;
    return summaries;
  });
}

async function ownerSummaryHandler(req, res) {
  logFlagsOnce();
  try {
    const summaries = await runOwnerSummary();
    res.status(200).json({ ok: true, count: summaries.length, summaries, failed: summaries.failed || [] });
  } catch (err) {
    console.error('[OWNER-SUMMARY FATAL]', err.message, err.stack);
    logToAxiom('error', 'owner_summary_fatal', { message: err.message, stack: err.stack });
    await alertShawn('owner_summary_fatal', err.message, { scope: 'entire run, not a single property' });
    res.status(200).json({ ok: false, error: err.message });
  }
}

// ─── DAILY MINI-RECONCILIATION SUMMARY (Stage 3 part 1) ─────────────────────
// Runs in ADDITION to the Monday weekly cron above, not instead of it — both
// fire on Mondays. Vercel's native cron (Hobby tier: once/day, UTC-only, hour-
// imprecise) cannot deliver "fire at property X's chosen SAST hour," so this is
// invoked hourly by a GitHub Actions workflow instead (.github/workflows/
// daily-summary.yml — UTC-triggered every hour, deliberately timezone-naive:
// GitHub Actions' schedule trigger has no IANA-timezone field, so correctness
// lives entirely here, not in the workflow). Each invocation checks every
// property's `Daily Summary Hour` against the current SAST hour and only acts
// on a match — an unconfigured property (field blank) is silently skipped, not
// defaulted, since a wrong guess would fire at the wrong hour for real.
//
// Rule 29 — interaction surface with runOwnerSummary (the Monday weekly cron):
// both read WS_Properties and WS_Bookings; neither writes to either. Read-only
// reporting on both sides, so there is no write contention and no ordering
// dependence — the two can and do fire in the same hour on a Monday (weekly at
// 06:00 SAST, daily at whatever hour each property is configured for) without
// interfering, because neither's output depends on the other having run.
//
// Stage 3 part 2: content is now built. Send stays stubbed (same reasoning as
// sendOwnerSummary — no approved Meta template exists for this use case yet,
// confirmed live against Meta's template list before this part started).
//
// Meta utility template name for the daily summary. FLAG: pending Meta
// approval/submission — unlike OWNER_SUMMARY_TEMPLATE this hasn't been
// submitted yet either; naming it here only marks the swap point.
const DAILY_SUMMARY_TEMPLATE = 'wabistay_daily_summary';
const dailySummaryTemplateName = () => reportTemplateName('WABISTAY_DAILY_SUMMARY_TEMPLATE', DAILY_SUMMARY_TEMPLATE);

// ── Room state grid ──────────────────────────────────────────────────────────
// WS_Rooms.Status alone cannot distinguish overnight vs hourly occupancy (both
// read 'Occupied') — the split requires resolving which booking currently holds
// the room. 'Maintenance' is excluded from the 4-state grid the spec asks for
// (same convention as BOOKABLE_ROOM_STATUSES elsewhere in this file, which also
// excludes it) but counted separately so a room in Maintenance is never silently
// dropped from the report.
function roomState(room, bookingsForRoom) {
  const status = room.fields['Status'];
  if (status === 'Cleaning') return 'cleaning';
  if (status === 'Available') return 'ready';
  if (status === 'Occupied') {
    const active = bookingsForRoom.find(b => b.fields['Status'] === 'Checked In');
    return (active && active.fields['Booking Type'] === 'Hourly') ? 'occupied-hourly' : 'occupied-overnight';
  }
  return null; // Maintenance (or any future status) — not part of the 4-state grid
}

function roomStateGrid(rooms, bookingsByRoomId) {
  const grid = { 'occupied-overnight': 0, 'occupied-hourly': 0, ready: 0, cleaning: 0 };
  let maintenance = 0;
  for (const room of rooms) {
    const state = roomState(room, bookingsByRoomId.get(room.id) || []);
    if (state) grid[state]++;
    else maintenance++;
  }
  return { ...grid, maintenance };
}

// ── No-shows (CEO-approved inferred definition, Stage 3 part 2) ─────────────
// WS_Bookings.Status has no 'No Show' choice (confirmed live via Meta API —
// only Enquiry/Confirmed/Checked In/Checked Out/Cancelled exist), so this is
// INFERRED, not a read of an existing fact: Confirmed, Check In date has
// already arrived (today or earlier), never transitioned to Checked In.
function isNoShow(booking, todayYmd) {
  if (booking.fields['Status'] !== 'Confirmed') return false;
  const ci = booking.fields['Check In'];
  if (!ci) return false;
  return compareYmd(sastCalendarDate(new Date(Date.parse(ci))), todayYmd) <= 0;
}

// ── Overnight: check-ins / check-outs / no-shows today ───────────────────────
// Check-ins use 'Checked In At' (a real event timestamp). Check-outs have no
// symmetric real event timestamp on WS_Bookings — only the scheduled 'Check Out'
// date exists (the same field aggregateOwnerSummary already keys period math
// off of), so "checked out today" here means Status = Checked Out with a
// scheduled Check Out date of today, not a captured actual-checkout moment.
// Flagging rather than silently treating it as precise.
function overnightStatsToday(bookings, todayYmd) {
  const dateIs = (iso, ymd) => !!iso && compareYmd(sastCalendarDate(new Date(Date.parse(iso))), ymd) === 0;

  const checkInsToday = bookings.filter(b =>
    b.fields['Booking Type'] === 'Overnight' && dateIs(b.fields['Checked In At'], todayYmd)
  ).length;

  const checkOutsToday = bookings.filter(b =>
    b.fields['Booking Type'] === 'Overnight' && b.fields['Status'] === 'Checked Out' && dateIs(b.fields['Check Out'], todayYmd)
  ).length;

  const noShowsToday = bookings.filter(b =>
    b.fields['Booking Type'] === 'Overnight' && isNoShow(b, todayYmd)
  ).length;

  return { checkInsToday, checkOutsToday, noShowsToday };
}

// ── Hourly: bookings today + overstay interventions ──────────────────────────
// 'Checkout Warning Sent At' is written by runAutoCheckout for ANY Checked-In
// booking it sweeps, regardless of Booking Type — it is not hourly-specific,
// even though the content spec groups it under "Hourly". Reported unscoped by
// type here (matching what the field actually measures) rather than silently
// filtered to Hourly bookings only, which would undercount and misrepresent it.
function hourlyStatsToday(bookings, todayYmd) {
  const dateIs = (iso, ymd) => !!iso && compareYmd(sastCalendarDate(new Date(Date.parse(iso))), ymd) === 0;

  const totalHourlyBookingsToday = bookings.filter(b =>
    b.fields['Booking Type'] === 'Hourly' && dateIs(b.fields['Check In'], todayYmd)
  ).length;

  const overstayInterventionsToday = bookings.filter(b =>
    dateIs(b.fields['Checkout Warning Sent At'], todayYmd)
  ).length;

  return { totalHourlyBookingsToday, overstayInterventionsToday };
}

// ── Cleaning turnaround — JOB DURATION, explicitly NOT vacant-to-ready ──────
// See CLAUDE.md BACKLOG-01. The true "checkout → sellable again" number
// (vacantToReadyMs in resolveRoomClean/cleaningDurations) is never persisted:
// its baseline, WS_Rooms.'Cleaning Started At', is overwritten every checkout
// cycle and never copied onto the booking, so after the fact it only ever
// existed in the 'cleaning_job_completed' Axiom log entry at the moment it
// happened — unrecoverable here. What DOES survive on WS_Bookings is
// 'Cleaning Job Started At' -> 'Cleaning Completed At' ("job duration": how
// long the cleaner spent once dispatched, only present when they sent START).
// Reported here, labeled explicitly, as the best available proxy.
function jobDurationMs(booking) {
  const started = booking.fields['Cleaning Job Started At'];
  const completed = booking.fields['Cleaning Completed At'];
  if (!started || !completed) return null;
  const startMs = Date.parse(started);
  const completedMs = Date.parse(completed);
  if (!Number.isFinite(startMs) || !Number.isFinite(completedMs) || completedMs < startMs) return null;
  return completedMs - startMs;
}

function cleaningTurnaroundToday(bookings, todayYmd) {
  const completedToday = bookings.filter(b =>
    b.fields['Cleaning Completed At'] &&
    compareYmd(sastCalendarDate(new Date(Date.parse(b.fields['Cleaning Completed At']))), todayYmd) === 0
  );
  const durations = completedToday.map(jobDurationMs).filter(ms => ms !== null);
  const averageJobDurationMs = durations.length > 0
    ? Math.round(durations.reduce((s, ms) => s + ms, 0) / durations.length)
    : null;
  return {
    metric: 'job_duration', // NOT vacant-to-ready/time-to-ready — see BACKLOG-01 in CLAUDE.md
    jobsCompletedToday: completedToday.length,
    jobsWithDuration: durations.length,
    averageJobDurationMs
  };
}

// ── Revenue today (overnight / hourly / combined) ────────────────────────────
// Scoped to bookings whose Check In date is today, same period-bucketing
// convention aggregateOwnerSummary already uses for its own totalRevenue.
function revenueToday(todaysBookings) {
  const sumDue = list => list.reduce((s, b) => s + (Number(b.fields['Amount Due']) || 0), 0);
  const overnightRevenue = sumDue(todaysBookings.filter(b => b.fields['Booking Type'] === 'Overnight'));
  const hourlyRevenue = sumDue(todaysBookings.filter(b => b.fields['Booking Type'] === 'Hourly'));
  return { overnightRevenue, hourlyRevenue, combinedRevenue: overnightRevenue + hourlyRevenue };
}

// ── Tomorrow's overnight arrivals ────────────────────────────────────────────
function tomorrowsOvernightArrivals(bookings, tomorrowYmd, roomsById, guestsById) {
  return bookings
    .filter(b => b.fields['Booking Type'] === 'Overnight' &&
      b.fields['Check In'] &&
      compareYmd(sastCalendarDate(new Date(Date.parse(b.fields['Check In']))), tomorrowYmd) === 0)
    .map(b => ({
      bookingId: b.id,
      bookingRef: b.fields['Booking Ref'] || null,
      guestName: guestsById.get((b.fields['Guest'] || [])[0]) || null,
      roomName: roomsById.get((b.fields['Room'] || [])[0]) || null,
      checkIn: b.fields['Check In']
    }));
}

// ── Full per-property aggregation ────────────────────────────────────────────
// Reuses paymentReconciliationLines (Stage 1) directly for section 6
// (outstanding/pending payments), scoped to today's bookings — same helper,
// same shape, no parallel version written.
function aggregateDailySummary(property, rooms, bookings, dates, guestsById) {
  const { todayYmd, tomorrowYmd } = dates;

  const bookingsByRoomId = new Map();
  for (const b of bookings) {
    for (const roomId of (b.fields['Room'] || [])) {
      if (!bookingsByRoomId.has(roomId)) bookingsByRoomId.set(roomId, []);
      bookingsByRoomId.get(roomId).push(b);
    }
  }
  const roomsById = new Map(rooms.map(r => [r.id, r.fields['Room Name'] || null]));

  const todaysBookings = bookings.filter(b =>
    b.fields['Check In'] && compareYmd(sastCalendarDate(new Date(Date.parse(b.fields['Check In']))), todayYmd) === 0
  );
  const paymentLines = paymentReconciliationLines(todaysBookings, roomsById, guestsById);
  const paymentDeltaTotal = paymentLines.reduce((s, l) => s + l.delta, 0);

  return {
    propertyId: property.id,
    propertyName: property.fields['Property Name'],
    date: `${todayYmd.y}-${String(todayYmd.m).padStart(2, '0')}-${String(todayYmd.d).padStart(2, '0')}`,
    roomStateGrid: roomStateGrid(rooms, bookingsByRoomId),
    overnight: overnightStatsToday(bookings, todayYmd),
    hourly: hourlyStatsToday(bookings, todayYmd),
    cleaningTurnaround: cleaningTurnaroundToday(bookings, todayYmd),
    revenue: revenueToday(todaysBookings),
    outstandingPayments: { paymentLines, paymentDeltaTotal },
    tomorrowsArrivals: tomorrowsOvernightArrivals(bookings, tomorrowYmd, roomsById, guestsById)
  };
}

// Stage 3 part 3 prep — NOT wired to any live send yet. Resolves the property's
// owner name for the wabistay_owner_daily_summary template's {{1}}. This link
// (WS_Properties.Owner -> WS_Owners) has never been read anywhere in the
// daily-summary path before now. Follows the exact same single-hop
// RECORD_ID() lookup idiom already used elsewhere for linked-record
// resolution (e.g. guest/room/property resolution around the auto-checkout
// warning path) — not a new pattern. Returns null, not a guessed default, if
// the property has no linked owner or the owner record has no name set: a
// caller sending this straight into a template param must decide what to do
// with null explicitly, not have this function silently paper over it.
async function resolveOwnerName(property) {
  const ownerId = (property.fields['Owner'] || [])[0];
  if (!ownerId) return null;
  const owners = await airtableGet('WS_Owners', `RECORD_ID() = '${ownerId}'`);
  return (owners[0] && owners[0].fields['Owner Name']) || null;
}

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// CEO-confirmed: the daily-summary template needs a human-readable date
// (e.g. "20 August 2026"), not the raw ISO YYYY-MM-DD aggregateDailySummary
// produces (~webhook.js:3979). Reformats ONLY for this template's output —
// deliberately does NOT touch `summary.date` itself, since other consumers
// of aggregateDailySummary's output (the daily_summary_payload Axiom log,
// the manual report-trigger endpoint) may depend on the ISO string staying
// intact. Parses the Y-M-D components directly rather than routing through
// formatSastDateTime, which formats a UTC *instant* with a SAST time-of-day
// — not what a bare calendar date needs — but reuses this file's existing
// month-name-array convention (MONTH_ABBR, above) rather than inventing an
// unrelated approach.
function formatHumanDate(isoYmd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoYmd);
  if (!m) throw new Error(`formatHumanDate: expected YYYY-MM-DD, got '${isoYmd}'`);
  const [, y, mo, d] = m;
  return `${Number(d)} ${MONTH_FULL[Number(mo) - 1]} ${y}`;
}

// paymentDeltaTotal, unlike Reception's amountDue (always >= 0, so
// notifyReceptionOfPayment's params never need a sign), CAN be negative — an
// overpayment. formatAmount() alone (two decimals, no symbol, no sign) would
// silently drop that minus sign, showing an overpayment as if it were owed.
// Reuses the sign+abs pattern formatPaymentReconciliationMessage already
// uses for the same field, minus the 'R' prefix — the currency symbol
// decision stays with the template copy, same reasoning as formatAmount's
// own comment.
function formatSignedAmount(value) {
  const n = Number(value) || 0;
  const sign = n >= 0 ? '' : '-';
  return `${sign}${formatAmount(Math.abs(n))}`;
}

// Stage 3 part 3 prep, per the TODO below — builds the wabistay_owner_daily_summary
// template params in the Meta-locked positional order:
//   {{1}} ownerName · {{2}} propertyName · {{3}} date · {{4}} paymentDeltaTotalFormatted
//   {{5}} tomorrowsArrivalsCount
// NOT wired to sendWhatsAppTemplate yet — that only happens once the template
// is Meta-approved (see sendDailySummary's TODO). Deliberately synchronous and
// pure so it can be unit-tested in isolation without Airtable/network: it
// expects `summary.ownerName` to already be resolved and attached by the
// caller (via resolveOwnerName, above) before this runs — aggregateDailySummary
// itself is left untouched (sync, already tested, already reused by the
// manual report-trigger endpoint) rather than made async to fetch it inline.
//
// {{3}} date: CEO-confirmed the template needs human-readable output (e.g.
// "20 August 2026"), not the raw ISO YYYY-MM-DD aggregateDailySummary
// produces — reformatted here via formatHumanDate, above. summary.date
// itself is left untouched.
//
// Throws rather than silently defaulting if ownerName is missing: sending
// "undefined" or a guessed placeholder into a live WhatsApp template to a
// real owner is worse than a loud failure during wiring.
function dailySummaryTemplateParams(summary) {
  if (summary.ownerName === undefined || summary.ownerName === null) {
    throw new Error(
      'dailySummaryTemplateParams: summary.ownerName is missing — resolve it with ' +
      'resolveOwnerName(property) and attach it to the summary before calling this function.'
    );
  }
  return [
    summary.ownerName,
    summary.propertyName,
    formatHumanDate(summary.date),
    formatSignedAmount(summary.outstandingPayments.paymentDeltaTotal),
    summary.tomorrowsArrivals.length
  ];
}

// The send surface. STUBBED until DAILY_SUMMARY_TEMPLATE is approved: logs the
// full payload to Axiom (so content is verifiable now) and marks exactly where
// the template send goes — same stub pattern as sendOwnerSummary above.
//
// resolveOwnerName + dailySummaryTemplateParams are wired in HERE, not left as
// orphaned, unit-tested-only functions the way they were before this fix —
// this is the actual "one-line swap point" the TODO below refers to; before
// this change that comment was aspirational, since ownerName was never
// resolved or attached anywhere on the live path. Deliberately NOT
// try/caught in this function: dailySummaryTemplateParams throwing on a
// missing ownerName (a property with no linked WS_Owners record, or a
// linked one with no name set) is a real, loud signal that property is
// misconfigured — swallowing it here would silently produce a payload
// that would later crash the actual WhatsApp send once the template is
// approved, or worse, quietly send "undefined" to a real owner. Isolating
// ONE property's failure from the rest of a run is the caller's job
// (runDailySummary's per-property try/catch) — not this function's.
async function sendDailySummary(property, summary) {
  const notifyPhone = property.fields['Notify Phone']
    ? property.fields['Notify Phone'].replace(/[\s\-\+]/g, '')
    : (OWNER_PHONE || null);

  const ownerName = await resolveOwnerName(property);
  const summaryWithOwner = { ...summary, ownerName };
  const templateParams = dailySummaryTemplateParams(summaryWithOwner);

  const payload = { ...summaryWithOwner, template: dailySummaryTemplateName(), notifyPhone, templateParams };
  // See the matching comment in sendOwnerSummary — deliberately no Airtable
  // write here either, for the same read-only-cron reason.
  logToAxiom('info', 'daily_summary_payload', payload);

  // TODO(Stage 3 part 3): once DAILY_SUMMARY_TEMPLATE is approved by Meta,
  // this is now genuinely the one-line swap point — templateParams above is
  // already the exact array sendWhatsAppTemplate needs:
  //   await sendWhatsAppTemplate(notifyPhone, DAILY_SUMMARY_TEMPLATE, templateParams, { site: 'daily_summary', propertyId: property.id });
  // Left stubbed here deliberately — enabling it is a separate, CEO-gated change
  // once the template exists, same reasoning as sendOwnerSummary's stub above.
  return payload;
}

// ─── WEEKLY RECAP (wabistay_owner_weekly_recap) ─────────────────────────────
// Replaces two prior dead ends: runOwnerSummary (kept — separate P&L
// reconciliation feature, its own pending template, untouched) is NOT this;
// and runWeeklyValueNudge (retired — 5 wrong-shape params, never matched any
// approved template) IS what this replaces. This is the actual
// implementation of the Meta-approved 7-param wabistay_owner_weekly_recap.
//
// Reuses aggregateOwnerSummary wholesale for occupancy and upcoming-arrivals
// (same CEO-confirmed exact-7-day-ahead window, same room-night occupancy
// formula — no second, parallel calculation of either; inherits the same
// known denominator gap aggregateOwnerSummary already has, documented on
// aggregateOwnerSummary itself, not repeated here). Adds only what
// aggregateOwnerSummary doesn't already produce: the overnight/short-stay
// booking-type split (mirrors aggregateMonthlyReport's split — not
// previously built for the weekly window) and a payment-reconciliation
// figure scoped to stays that COMPLETED this week (Check Out within the
// window) rather than stays that started this week (aggregateOwnerSummary's
// own paymentDeltaTotal is Check-In-scoped) — "owed from stays completed
// this week" is a deliberately different scope, per the approved template's
// copy, reusing paymentReconciliationLines (the existing pure per-booking
// reconciliation function) rather than a new calculation.
const WEEKLY_RECAP_TEMPLATE = 'wabistay_owner_weekly_recap';
// WABISTAY_WEEKLY_RECAP_TEMPLATE=weekly_recap points the send at the already-approved
// template with no new approval; unset = today's name.
const weeklyRecapTemplateName = () => reportTemplateName('WABISTAY_WEEKLY_RECAP_TEMPLATE', WEEKLY_RECAP_TEMPLATE);

function aggregateWeeklyRecap(property, rooms, bookings, w, guestsById = new Map()) {
  const summary = aggregateOwnerSummary(property, rooms, bookings, w, guestsById);

  const checkInMs = b => (b.fields['Check In'] ? Date.parse(b.fields['Check In']) : NaN);
  const periodBookings = bookings.filter(b => {
    const t = checkInMs(b);
    return Number.isFinite(t) && t >= w.periodStartMs && t < w.periodEndMs;
  });
  const overnightBookingsCount = periodBookings.filter(b => b.fields['Booking Type'] === 'Overnight').length;
  const shortStayBookingsCount = periodBookings.filter(b => b.fields['Booking Type'] === 'Hourly' || b.fields['Booking Type'] === 'Day').length;

  const checkOutMs = b => (b.fields['Check Out'] ? Date.parse(b.fields['Check Out']) : NaN);
  const completedThisWeek = bookings.filter(b => {
    const t = checkOutMs(b);
    return Number.isFinite(t) && t >= w.periodStartMs && t < w.periodEndMs;
  });
  const roomsById = new Map(rooms.map(r => [r.id, r.fields['Room Name'] || null]));
  const completedPaymentLines = paymentReconciliationLines(completedThisWeek, roomsById, guestsById);
  const outstandingFromCompletedStays = completedPaymentLines.reduce((s, l) => s + l.delta, 0);

  return {
    ...summary,
    overnightBookingsCount,
    shortStayBookingsCount,
    outstandingFromCompletedStays
  };
}

// Meta-approved 7-param order, confirmed from Meta Business Manager's edit
// view. Deliberately synchronous and pure, same reasoning as
// dailySummaryTemplateParams/monthlyReportTemplateParams: expects
// report.ownerName pre-resolved and attached by the caller, throws rather
// than silently defaulting if it's missing.
//   {{1}} ownerName · {{2}} propertyName · {{3}} overnight booking count ·
//   {{4}} short-stay booking count · {{5}} occupancy % (this week) ·
//   {{6}} upcoming arrivals (next 7 days) · {{7}} outstanding payment amount
//   (owed from stays completed this week; "R0" not blank when nothing owed —
//   never a negative "owed" figure even if completed stays net-overpaid).
function weeklyRecapTemplateParams(report) {
  if (report.ownerName === undefined || report.ownerName === null) {
    throw new Error(
      'weeklyRecapTemplateParams: report.ownerName is missing — resolve it with ' +
      'resolveOwnerName(property) and attach it to the report before calling this function.'
    );
  }
  return [
    report.ownerName,
    report.propertyName,
    String(report.overnightBookingsCount),
    String(report.shortStayBookingsCount),
    `${Math.round(report.occupancyRate * 100)}%`,
    String(report.upcomingBookings),
    `R${Math.max(0, Math.round(report.outstandingFromCompletedStays))}`
  ];
}

// LIVE as of wabistay_owner_weekly_recap's Meta approval — routed through
// the REPORT_TEST_MODE_PHONE gate, same as sendMonthlyReport.
async function sendWeeklyRecap(property, report) {
  const notifyPhone = reportRecipientPhone(property);
  const ownerName = await resolveOwnerName(property);
  const reportWithOwner = { ...report, ownerName };
  const templateParams = weeklyRecapTemplateParams(reportWithOwner);
  const payload = { ...reportWithOwner, template: weeklyRecapTemplateName(), notifyPhone, templateParams };
  logToAxiom('info', 'weekly_recap_payload', payload);

  const recipient = resolveSendRecipient(notifyPhone, 'weekly_recap', { propertyId: property.id });
  if (!recipient) {
    throw new Error('sendWeeklyRecap: no recipient phone available — property has no Notify Phone and OWNER_PHONE fallback is unset');
  }
  await sendWhatsAppTemplate(recipient, weeklyRecapTemplateName(), templateParams, { site: 'weekly_recap', propertyId: property.id });
  return payload;
}

async function runWeeklyRecap(opts = {}) {
  const { now = new Date() } = opts;
  const periodDays = 7;
  const periodEndMs = now.getTime();
  const w = {
    periodDays,
    periodStartMs: periodEndMs - periodDays * DAY_MS,
    periodEndMs,
    upcomingEndMs: periodEndMs + 7 * DAY_MS
  };

  // Four independent table reads, run together — same as runMonthlyReport.
  const [properties, allRooms, allBookings, allGuests] = await Promise.all([
    airtableGet('WS_Properties', ''),
    airtableGet('WS_Rooms', orFormula('Status', BOOKABLE_ROOM_STATUSES)),
    airtableGet('WS_Bookings', orFormula('Status', BLOCKING_BOOKING_STATUSES.concat(['Checked Out']))),
    airtableGet('WS_Guests', '')
  ]);
  const guestsById = new Map(allGuests.map(g => [g.id, g.fields['Guest Name'] || null]));

  const sent = [];
  const failed = [];
  for (const property of properties) {
    // Per-property isolation, matching runOwnerSummary/runDailySummary/
    // runMonthlyReport's own established pattern: one property throwing
    // (including a missing ownerName) must not abort the rest of this run.
    try {
      const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
      const roomIds = new Set(rooms.map(r => r.id));
      const bookings = allBookings.filter(b => (b.fields['Room'] || []).some(id => roomIds.has(id)));
      const report = aggregateWeeklyRecap(property, rooms, bookings, w, guestsById);
      await sendWeeklyRecap(property, report);
      sent.push(report);
    } catch (err) {
      logToAxiom('error', 'weekly_recap_property_failed', {
        propertyId: property.id, propertyName: property.fields?.['Property Name'] || null,
        message: err.message, stack: err.stack
      });
      await alertShawn('weekly_recap', err.message, {
        propertyId: property.id, propertyName: property.fields?.['Property Name'] || null
      });
      failed.push({ propertyId: property.id, propertyName: property.fields?.['Property Name'] || null, error: err.message });
    }
  }
  sent.failed = failed;
  return sent;
}

async function weeklyRecapHandler(req, res) {
  logFlagsOnce();
  try {
    const sent = await runWeeklyRecap();
    res.status(200).json({ ok: true, count: sent.length, sent, failed: sent.failed || [] });
  } catch (err) {
    console.error('[WEEKLY-RECAP FATAL]', err.message, err.stack);
    logToAxiom('error', 'weekly_recap_fatal', { message: err.message, stack: err.stack });
    await alertShawn('weekly_recap_fatal', err.message, { scope: 'entire run, not a single property' });
    res.status(200).json({ ok: false, error: err.message });
  }
}

async function runDailySummary(opts = {}) {
  const { now = new Date() } = opts;
  const shifted = new Date(now.getTime() + SAST_OFFSET_MS);
  const currentSastHour = shifted.getUTCHours();
  const todayYmd = sastCalendarDate(now);
  const tomorrowYmd = addSastDays(todayYmd, 1);

  // propertyCount here is `fired.length`, not the total property count — most
  // hourly invocations fire for zero or one property (only whichever one's
  // configured hour matches this SAST hour), so "calls per property scanned"
  // would be dominated by the single unconditional WS_Properties read and
  // say little about the actual per-report cost this instrumentation exists
  // to measure. See runOwnerSummary's own comment for why calls-per-property
  // matters at all (Airtable's 5 req/sec ceiling, migration trigger).
  const propertyCountRef = { value: 0 };
  return withAirtableCallCount('daily_summary', propertyCountRef, async () => {
    const properties = await airtableGet('WS_Properties', '');
    const fired = [];
    const skipped = [];
    const failed = [];

    // Rooms/bookings/guests are fetched at most once per run, only if at least
    // one property's hour actually matches — most hourly invocations match
    // nothing, so this avoids three Airtable calls on 23/24 runs a day.
    let allRooms = null, allBookings = null, guestsById = null;

    for (const property of properties) {
      const configuredHour = property.fields['Daily Summary Hour'];
      if (configuredHour === undefined || configuredHour === null) {
        skipped.push({ propertyId: property.id, reason: 'not_configured' });
        continue;
      }
      if (Number(configuredHour) !== currentSastHour) {
        skipped.push({ propertyId: property.id, reason: 'hour_not_matched', configuredHour: Number(configuredHour) });
        continue;
      }

      // Per-property isolation: one property throwing here (e.g. sendDailySummary's
      // new ownerName resolution above, on a property with no linked/misconfigured
      // WS_Owners record) must not abort every OTHER property still waiting in this
      // same run — before this fix, an uncaught throw here propagated straight out
      // of the for-loop, silently skipping every remaining property until the outer
      // handler's catch-all, with no way to tell "genuinely zero activity" apart
      // from "crashed partway through" without checking Axiom by hand.
      try {
        if (allRooms === null) {
          // Unfiltered — includes Maintenance, unlike BOOKABLE_ROOM_STATUSES
          // elsewhere, since the room-state grid counts Maintenance separately
          // rather than silently dropping those rooms from the report.
          allRooms = await airtableGet('WS_Rooms', '');
          allBookings = await airtableGet('WS_Bookings', orFormula('Status', BLOCKING_BOOKING_STATUSES.concat(['Checked Out'])));
          const allGuests = await airtableGet('WS_Guests', '');
          guestsById = new Map(allGuests.map(g => [g.id, g.fields['Guest Name'] || null]));
        }

        const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
        const roomIds = new Set(rooms.map(r => r.id));
        const bookings = allBookings.filter(b => (b.fields['Room'] || []).some(id => roomIds.has(id)));

        const summary = aggregateDailySummary(property, rooms, bookings, { todayYmd, tomorrowYmd }, guestsById);
        await sendDailySummary(property, summary);

        fired.push({ propertyId: property.id, propertyName: property.fields['Property Name'], summary });
      } catch (err) {
        logToAxiom('error', 'daily_summary_property_failed', {
          propertyId: property.id, propertyName: property.fields?.['Property Name'] || null,
          message: err.message, stack: err.stack
        });
        // Fires per property, not once for the whole run, so the alert itself
        // says which property failed rather than just "daily summary failed".
        await alertShawn('daily_summary', err.message, {
          propertyId: property.id, propertyName: property.fields?.['Property Name'] || null
        });
        failed.push({ propertyId: property.id, propertyName: property.fields?.['Property Name'] || null, error: err.message });
      }
    }
    propertyCountRef.value = fired.length;
    return { currentSastHour, fired, skipped, failed };
  });
}

async function dailySummaryHandler(req, res) {
  logFlagsOnce();
  try {
    const result = await runDailySummary();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[DAILY-SUMMARY FATAL]', err.message, err.stack);
    logToAxiom('error', 'daily_summary_fatal', { message: err.message, stack: err.stack });
    await alertShawn('daily_summary_fatal', err.message, { scope: 'entire run, not a single property' });
    res.status(200).json({ ok: false, error: err.message });
  }
}

// ─── COEXISTENCE: MESSAGE ECHO HANDLING ─────────────────────────────────────
// Meta ships a human's own outbound message (sent via the native WhatsApp
// Business app while Cloud API coexistence is enabled) as a `message_echoes`
// webhook — a different payload shape from `messages`, not a variant of it,
// handled here rather than through the state-machine dispatcher below.
//
// Two jobs, and deliberately nothing else:
//   1. First echo for a guest not already HUMAN_HANDLING → hand off: suppress
//      the bot for that guest until an explicit handback.
//   2. Echo text is exactly "bot on" (case-insensitive) AND the guest is
//      currently HUMAN_HANDLING → hand back to NEW.
//
// Never sends the guest anything, either direction. Per the pre-check: a
// human's reply does not reopen the Cloud API's 24h free-form window, so a
// bot-sent message here could silently need a template that doesn't exist.
// Staff's own message via the app is already the guest-visible confirmation
// of a handoff; a handback is a control action with nothing new to tell the
// guest. `to` on an echo is always the guest's own number — `from` is this
// WABA's own number — so `to` alone identifies the conversation.
const BOT_HANDBACK_COMMAND = 'bot on';

async function handleMessageEcho(echo) {
  const guestPhone = formatPhone(String(echo.to || ''));
  if (!guestPhone) return;
  const guestRecords = await airtableGet('WS_Guests', `{Phone Number} = '${guestPhone}'`);
  const guest = guestRecords[0] || null;
  if (!guest) {
    // Staff messaged a number with no WS_Guests row yet — nothing to suppress;
    // the bot was never going to auto-reply to a guest it doesn't know.
    logToAxiom('info', 'message_echo_no_guest', { guestPhone });
    return;
  }

  const echoText = (echo.text && echo.text.body ? String(echo.text.body) : '').trim().toLowerCase();
  const currentState = guest.fields['Session State'];

  if (echoText === BOT_HANDBACK_COMMAND) {
    if (currentState !== 'HUMAN_HANDLING') {
      // Not currently suppressed — a stray "bot on" must not reset a guest
      // mid-flow (e.g. AWAITING_HOURLY_DETAILS). No-op, logged for visibility.
      logToAxiom('info', 'bot_on_no_op', { guestPhone, guestId: guest.id, currentState });
      return;
    }
    await updateGuestState(guest.id, { 'Session State': 'NEW' });
    logToAxiom('info', 'human_handback', { guestPhone, guestId: guest.id });
    return;
  }

  if (currentState === 'HUMAN_HANDLING') return; // already suppressed, nothing to do

  await updateGuestState(guest.id, { 'Session State': 'HUMAN_HANDLING' });
  logToAxiom('info', 'human_handoff', { guestPhone, guestId: guest.id, fromState: currentState || null });
}

// ─── DISPATCHER ──────────────────────────────────────────────────────────────
// Reads states.json: global rows first (guarded), then the current state's rows.
// A row matches when `inputs` is "*" or contains the lowercased message.

function matchTransition(rows, text) {
  return rows.find(t => t.inputs === '*' || t.inputs.includes(text)) || null;
}

// ─── CLOSED HOURS (WABISTAY_AFTER_HOURS) ─────────────────────────────────────
// Open 08:00 to 23:00 SAST; closed 23:00 to 07:59. Off by default. On, for a guest who is not a test phone:
//   · a conversation that STARTS in the closed window gets one welcome per window (stamped in
//     WS_Guests 'After Hours Reply At'), then the normal greeting. 23:00-23:59 says tomorrow, 00:00-07:59
//     says later today. Guests mid-booking, with a booking, or rating are not interrupted.
//   · the stay menu (needs WABISTAY_STAY_MENU) is the 08:00 menu, and arrivals are judged against 08:00 of
//     the day the stay will start (tomorrow from 23:00, today after midnight), worked out when the
//     name-and-time reply arrives, not when the chat began. A reply to a menu shown before 23:00 still means
//     what the guest saw.
//   · the first message of a conversation that starts closed is recorded as an 'After Hours' enquiry
//     (when enquiry tracking is on). An 'after_hours_message' event goes to Axiom for every closed message.
function afterHoursEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_AFTER_HOURS || '').trim());
}
// null while open; else when this closed window started and when the lodge next opens.
function closedWindowInfo(now = new Date()) {
  const hour = sastHourOfDate(now);
  if (hour >= 8 && hour < 23) return null;
  const today = sastCalendarDate(now);
  if (hour >= 23) {
    return { tomorrow: true, startIso: sastToUtcIso(today, 23, 0), openIso: sastToUtcIso(addSastDays(today, 1), 8, 0) };
  }
  return { tomorrow: false, startIso: sastToUtcIso(addSastDays(today, -1), 23, 0), openIso: sastToUtcIso(today, 8, 0) };
}
// The clock the stay menu uses: the real one while open (or flag off, or a test phone); in the closed
// window, 08:00 on opening day for the menu band and one second before it for window and "already
// passed" checks, so an 08:00 arrival is allowed.
function stayClock(ctx) {
  const real = new Date();
  if (afterHoursEnabled() && !isTestGuest(ctx.guest)) {
    const w = closedWindowInfo(real);
    if (w) {
      const open = new Date(Date.parse(w.openIso));
      return { menuNow: open, now: new Date(open.getTime() - 1000) };
    }
  }
  return { menuNow: real, now: real };
}
const AFTER_HOURS_RESTART_STATES = ['AWAITING_STAY_TYPE', 'AWAITING_DETAILS', 'AWAITING_HOURLY_DETAILS', 'AWAITING_HOURLY_DURATION'];
// Before dispatch, after staff and cleaner commands have had their turn. Sends the welcome when due and
// returns { startIso } so the caller stamps it once the normal reply has gone; null when nothing was sent.
async function afterHoursPrelude(ctx, { restart = false } = {}) {
  const real = new Date();
  const w = closedWindowInfo(real);
  if (!w) return null;
  const guest = ctx.guest;
  const state = guest ? guest.fields['Session State'] : null;
  logToAxiom('info', 'after_hours_message', { phone: ctx.phone, sastHour: sastHourOfDate(real), sessionState: state || null });
  // A guest who restarts ("hi" / "menu") from a step of the booking chat is welcomed like a new conversation;
  // anyone with a booking, or at payment, ETA or rating, never is.
  const restarting = restart && AFTER_HOURS_RESTART_STATES.includes(state) && ['hi', 'menu'].includes(ctx.text);
  if (guest && state && state !== 'NEW' && !restarting) return null;
  const lastWelcome = guest && guest.fields['After Hours Reply At'];
  if (lastWelcome && Date.parse(lastWelcome) >= Date.parse(w.startIso)) return null;
  // A staff number is not a guest (same identity checks as the consent notice).
  const isCleaner = (await airtableGet('WS_Cleaners', `{Phone Number} = '${ctx.phone}'`)).length > 0;
  if (isCleaner || isOwnerSideNumber(ctx.phone, ctx.property) || (await activeWalkinRoleForPhone(ctx.phone)) !== null) return null;
  await sendWhatsApp(ctx.phone, msg(w.tomorrow ? 'afterHoursWelcomeTomorrow' : 'afterHoursWelcomeToday'));
  logToAxiom('info', 'after_hours_welcome_sent', { phone: ctx.phone, tomorrow: w.tomorrow });
  if (enquiryTrackingEnabled()) {
    await logEnquiry(ctx.property, ctx.phone, 'After Hours', { ...enquiryTrackingOpts(ctx), lastStep: state || 'NEW' });
  }
  return { startIso: w.startIso };
}
async function stampAfterHoursReply(ctx) {
  try {
    const rows = ctx.guest ? [ctx.guest] : await airtableGet('WS_Guests', `{Phone Number} = '${ctx.phone}'`);
    if (!rows[0]) return;
    const write = await airtableUpdate('WS_Guests', rows[0].id, { 'After Hours Reply At': new Date().toISOString() });
    if (write && write.error) logToAxiom('error', 'after_hours_stamp_failed', { phone: ctx.phone, error: JSON.stringify(write.error) });
  } catch (err) {
    logToAxiom('error', 'after_hours_stamp_failed', { phone: ctx.phone, message: err.message });
  }
}

// ─── STAY MENU (WABISTAY_STAY_MENU) — slice 1 ────────────────────────────────
// Numbered TEXT menu of what is on sale right now, by SAST time of day. Off by default.
// Slice 1 only: no buttons or lists, no closed-hours flow, no hold-release work, and the
// guest still types the time they expect to arrive.
//
//   2 hours   R250   arrive today, before 17:00
//   3 hours   R300   arrive today, before 17:00
//   Day       R400   arrive 08:00 to 15:00, leave by 17:00 (offered until 12:00)
//   Overnight R500   check in 17:00 to 23:00, check out 10:00 the next morning
//
// Menu by SAST time: 08:00-11:59 all four; 12:00-16:59 2h, 3h, Overnight; 17:00-22:59
// Overnight only. Outside 08:00-22:59 (closed hours are not built yet) and whenever nothing
// on the menu can be priced, the guest gets today's flow unchanged.
// The reply keys are FIXED per product (1, 2, 3, 4) whichever options are showing, so a
// reply to a menu shown a minute before the hour changed still means what the guest saw.
// A booking made through this menu is marked by "Stay: " at the start of its Notes; that is
// how the details step knows which product was chosen without any new Airtable field.
function stayMenuEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_STAY_MENU || '').trim());
}
const STAY_PRODUCTS = {
  '1': { key: 'h2', label: '2 hours', type: 'Hourly', hours: 2 },
  '2': { key: 'h3', label: '3 hours', type: 'Hourly', hours: 3 },
  '3': { key: 'day', label: 'Day', type: 'Day', hours: null },
  '4': { key: 'overnight', label: 'Overnight', type: 'Overnight', hours: null }
};
const STAY_NOTE_PREFIX = 'Stay: ';
function sastHourOfDate(date) {
  return new Date(date.getTime() + SAST_OFFSET_MS).getUTCHours();
}
function stayMenuKeysForHour(hour) {
  if (hour >= 8 && hour <= 11) return ['1', '2', '3', '4'];
  if (hour >= 12 && hour <= 16) return ['1', '2', '4'];
  if (hour >= 17 && hour <= 22) return ['4'];
  return null;
}
// The single active rate row of one Rate Type for a property, or null. Same rule the
// nightly lookup has always used: exactly one, else not priced (fail closed).
async function singleActiveRate(property, rateType) {
  const rows = await airtableGet('WS_Rates', "AND({Active} = TRUE(), {Rate Type} = '" + rateType + "')");
  const mine = rows.filter(r => (r.fields['Property'] || []).includes(property.id));
  return mine.length === 1 ? mine[0] : null;
}
function rateUnitLabel(rateType) {
  if (rateType === 'Per Night') return 'per night';
  if (rateType === 'Per Day') return 'per day';
  return 'per hour';
}
// What is on sale now: { keys, prices, lines } or null (use today's flow). Anything that
// cannot be priced is left off; if nothing is left there is no menu.
async function stayMenuForNow(property, now = new Date()) {
  const baseKeys = stayMenuKeysForHour(sastHourOfDate(now));
  if (!baseKeys) return null;
  const prices = {};
  const wantsHourly = baseKeys.includes('1') || baseKeys.includes('2');
  if (wantsHourly) {
    const hourly = hourlyRatesFor(property, [2, 3]);
    if (hourly) { prices['1'] = hourly[2]; prices['2'] = hourly[3]; }
  }
  let dayRate = null;
  let nightRate = null;
  if (baseKeys.includes('3')) {
    dayRate = await singleActiveRate(property, 'Per Day');
    const amount = dayRate && Number(dayRate.fields['Amount']);
    if (amount > 0) prices['3'] = amount; else dayRate = null;
  }
  if (baseKeys.includes('4')) {
    nightRate = await singleActiveRate(property, 'Per Night');
    const amount = nightRate && Number(nightRate.fields['Amount']);
    if (amount > 0) prices['4'] = amount; else nightRate = null;
  }
  const keys = baseKeys.filter(k => prices[k] !== undefined);
  if (keys.length === 0) return null;
  // The wording the guest reads; STAY_PRODUCTS labels stay as they are (booking note marker, confirmation text).
  const menuText = {
    '1': '2 hour stay, R' + prices['1'],
    '2': '3 hour stay, R' + prices['2'],
    '3': 'Full day stay, R' + prices['3'] + '. Arrive between 8am and 3pm, leave by 5pm.',
    '4': 'Overnight stay, R' + prices['4'] + '. Check in between 5pm and 11pm, check out by 10am.'
  };
  const lines = keys.map(k => k + ' - ' + menuText[k]).join('\n');
  const phone = property.fields['Guest Redirect Phone'];
  const anotherDayLine = 'Operating hours are 8am to 11pm. Another day? Please phone reception' + (phone ? ' on ' + phone : '') + '.';
  // From 17:00 the short stays are over for the day; the one-line menu says so first.
  const menuIntro = sastHourOfDate(now) >= 17 ? 'Short stays have finished for today.\n\n' : '';
  return { keys, prices, lines, anotherDayLine, menuIntro, dayRate, nightRate };
}
// Reply -> product key ('1'..'4'), 'multi' (the typed multiple-days words, which keep
// reaching today's typed-dates flow), or null. "2" means the SECOND menu line (3 hours);
// "2 hours" means two hours.
function parseStayMenuChoice(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^(2|two) ?(hours?|hrs?|h)$/.test(t)) return '1';
  if (/^(3|three) ?(hours?|hrs?|h)$/.test(t)) return '2';
  if (/^day( stay)?$/.test(t)) return '3';
  if (/^(overnight|night)$/.test(t)) return '4';
  if (/^[1-4]$/.test(t)) return t;
  if (['multiple days', 'multi-day', 'multiday'].includes(t)) return 'multi';
  return null;
}
// Arrival window per product, for a time typed today. Returns { ok, ciIso, coIso } or
// { ok: false, reason }. A time already past is refused: the stay is always today.
function stayWindowForArrival(product, arrival, now = new Date()) {
  const today = sastCalendarDate(now);
  const minutes = arrival.hour * 60 + arrival.minute;
  let inside;
  if (product.type === 'Hourly') inside = minutes < 17 * 60;
  else if (product.type === 'Day') inside = minutes >= 8 * 60 && minutes <= 15 * 60;
  else inside = minutes >= 17 * 60 && minutes <= 23 * 60;
  if (!inside) return { ok: false, reason: 'outside_window' };
  const ciIso = sastToUtcIso(today, arrival.hour, arrival.minute);
  if (Date.parse(ciIso) <= now.getTime()) return { ok: false, reason: 'in_the_past' };
  let coIso;
  if (product.type === 'Hourly') coIso = addHoursToIso(ciIso, product.hours);
  else if (product.type === 'Day') coIso = sastToUtcIso(today, 17, 0);
  else coIso = sastToUtcIso(addSastDays(today, 1), 10, 0);
  return { ok: true, ciIso, coIso };
}
// The example time shown under "Sam Dlamini": an evening time for Overnight, an afternoon one otherwise.
function stayExampleTime(product) {
  return product.type === 'Overnight' ? '7pm' : '2pm';
}
function stayArrivalWindowText(product) {
  if (product.type === 'Hourly') return 'a short stay must start later today and before 17:00';
  if (product.type === 'Day') return 'Day arrival must be between 08:00 and 15:00 today';
  return 'Overnight check-in must be between 17:00 and 23:00 tonight';
}
// A bare hour ("9") is read as the one reading that falls inside the product's window and
// is not already past; if both or neither do, the guest is asked (both) or re-asked (neither).
function resolveBareHour(product, n, now) {
  const readings = [{ hour: n % 12, minute: 0 }, { hour: (n % 12) + 12, minute: 0 }];
  const valid = readings.filter(r => stayWindowForArrival(product, r, now).ok);
  if (valid.length === 1) return { arrival: valid[0] };
  return { arrival: null, ambiguous: valid.length === 2 };
}

async function findPendingStayMenuBooking(guestId) {
  const enquiries = await airtableGetBookingsByGuestId(guestId, 'Enquiry');
  return enquiries.find(b => String(b.fields['Notes'] || '').startsWith(STAY_NOTE_PREFIX) && !b.fields['Check In'] && !b.fields['Check Out']) || null;
}
function isStayMenuBooking(booking) {
  return !!booking && String(booking.fields['Notes'] || '').startsWith(STAY_NOTE_PREFIX);
}
function stayProductFromBooking(booking) {
  const note = String(booking.fields['Notes'] || '').slice(STAY_NOTE_PREFIX.length).trim().toLowerCase();
  return Object.values(STAY_PRODUCTS).find(p => p.label.toLowerCase() === note) || null;
}

// The greeting with the menu in it (one message). Null when the menu does not apply.
async function stayMenuGreeting(ctx, roomCount) {
  const menu = await stayMenuForNow(ctx.property, stayClock(ctx).menuNow);
  if (!menu) return null;
  return msg('greetingStayMenu', {
    propertyName: ctx.property.fields['Property Name'],
    propertyCityLine: propertyCityLine(ctx.property),
    roomCountLine: roomCountLine(ctx.property, roomCount),
    menuIntro: menu.menuIntro,
    menuLines: menu.lines,
    anotherDayLine: menu.anotherDayLine
  });
}

// AWAITING_STAY_TYPE with the flag on. Returns true when the reply was dealt with here;
// false hands it to today's handler (closed hours, nothing priceable, typed multiple-days words).
async function handleStayMenuChoice(ctx) {
  const menu = await stayMenuForNow(ctx.property, stayClock(ctx).menuNow);
  if (!menu) return false;
  const choice = parseStayMenuChoice(ctx.text);
  if (choice === 'multi') return false;
  if (!choice || !menu.keys.includes(choice)) {
    logToAxiom('info', 'stay_menu_reprompt', {
      phone: ctx.phone, reply: String(ctx.text).slice(0, 40), choice: choice || null, offered: menu.keys
    });
    await sendWhatsApp(ctx.phone, msg('stayMenuReprompt', { menuLines: menu.lines, anotherDayLine: menu.anotherDayLine }));
    return true;
  }
  const product = STAY_PRODUCTS[choice];
  // The chosen product is parked on an inert booking row (no dates, so it blocks nothing),
  // reused if the guest picks again.
  const fields = { 'Booking Type': product.type, 'Notes': STAY_NOTE_PREFIX + product.label };
  const existing = await findPendingStayMenuBooking(ctx.guest.id);
  const write = existing
    ? await airtableUpdate('WS_Bookings', existing.id, fields)
    : await airtableCreate('WS_Bookings', {
        'Guest': [ctx.guest.id], 'Source': 'WhatsApp', 'Status': 'Enquiry', 'Logged By': 'WhatsApp Bot',
        'Payment Status': 'Unpaid', ...fields
      });
  if (!write || write.error || (!existing && !write.id)) {
    logToAxiom('error', 'stay_menu_choice_write_failed', {
      phone: ctx.phone, product: product.key, error: write && write.error ? JSON.stringify(write.error) : null
    });
    await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_STAY_TYPE', 'Last Inbound At': new Date().toISOString() });
    await sendWhatsApp(ctx.phone, msg('hourlyBookingCreateFailed', { guestName: ctx.guest.fields['Guest Name'] }));
    return true;
  }
  logToAxiom('info', 'stay_menu_choice', { phone: ctx.phone, product: product.key, offered: menu.keys });
  if (!(await advanceGuestState(ctx, { 'Session State': 'AWAITING_HOURLY_DETAILS', 'Last Inbound At': new Date().toISOString() }))) return true;
  await sendWhatsApp(ctx.phone, msg('stayMenuAskDetails', { example: stayExampleTime(product) }));
  return true;
}

// AWAITING_HOURLY_DETAILS when the guest chose from the menu: the name and the arrival time
// they typed, checked against the product's window, then the booking is made in one go.
async function collectStayMenuDetails(ctx, pending) {
  const product = stayProductFromBooking(pending);
  if (!product) {
    // Marker we cannot read: leave it to today's handler rather than guess a product.
    return false;
  }
  const now = stayClock(ctx).now;
  const lines = ctx.messageText.trim().split('\n').map(l => l.trim()).filter(Boolean);
  let typedName = null;
  let arrival = null;
  let ambiguousHour = null;
  for (const line of lines) {
    const parsed = parseArrivalTime(line);
    if (parsed && parsed.ambiguous !== undefined) {
      if (ambiguousHour === null) ambiguousHour = parsed.ambiguous;
    } else if (parsed && !arrival) {
      arrival = parsed;
    } else if (!parsed && !typedName) {
      typedName = line;
    }
  }
  if (lines.length === 1 && !arrival && ambiguousHour === null) {
    const oneLine = parseOneLineNameAndTime(lines[0]);
    if (oneLine) {
      typedName = oneLine.name;
      if (oneLine.time.ambiguous !== undefined) ambiguousHour = oneLine.time.ambiguous;
      else arrival = oneLine.time;
    }
  }
  const knownName = ctx.guest.fields['Guest Name'] !== 'Unknown' ? ctx.guest.fields['Guest Name'] : null;
  const guestName = typedName || knownName;

  const reask = async (reason) => {
    // Keep the name they gave, so the next reply can be just a time.
    if (typedName && typedName !== knownName) await updateGuestState(ctx.guest.id, { 'Guest Name': typedName });
    const example = stayExampleTime(product);
    // A time that has already passed gets its own message, not the window one.
    if (reason === 'in_the_past') {
      const w = afterHoursEnabled() && !isTestGuest(ctx.guest) ? closedWindowInfo(new Date()) : null;
      await sendWhatsApp(ctx.phone, msg('stayMenuTimePassed', { example, when: w && w.tomorrow ? 'tomorrow' : 'later today' }));
    }
    else await sendWhatsApp(ctx.phone, msg('stayMenuTimeReask', { windowText: stayArrivalWindowText(product), example }));
  };

  if (!arrival && ambiguousHour !== null) {
    const resolved = resolveBareHour(product, ambiguousHour, now);
    if (resolved.arrival) arrival = resolved.arrival;
    else if (resolved.ambiguous) {
      await sendWhatsApp(ctx.phone, msg('hourlyTimeAmbiguous', { value: ambiguousHour }));
      return true;
    } else {
      await reask();
      return true;
    }
  }
  if (!guestName || !arrival) {
    await sendWhatsApp(ctx.phone, msg('stayMenuDetailsReprompt', { example: stayExampleTime(product) }));
    return true;
  }
  const window = stayWindowForArrival(product, arrival, now);
  if (!window.ok) {
    logToAxiom('info', 'stay_menu_arrival_refused', { phone: ctx.phone, product: product.key, reason: window.reason });
    await reask(window.reason);
    return true;
  }
  const { ciIso, coIso } = window;

  // Price. Hourly from the property's own rates, Day and Overnight from the single active
  // Per Day / Per Night row; no price means no booking (fail closed).
  let amount = null;
  let rateRow = null;
  if (product.type === 'Hourly') {
    const hourly = hourlyRatesFor(ctx.property, [product.hours]);
    amount = hourly ? hourly[product.hours] : null;
  } else {
    rateRow = await singleActiveRate(ctx.property, product.type === 'Day' ? 'Per Day' : 'Per Night');
    amount = rateRow ? Number(rateRow.fields['Amount']) : null;
  }
  if (!(amount > 0)) {
    logToAxiom('warn', 'stay_menu_unpriced', { phone: ctx.phone, product: product.key, propertyId: ctx.property.id });
    await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_STAY_TYPE', 'Last Inbound At': new Date().toISOString() });
    await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', { propertyName: ctx.property.fields['Property Name'] }));
    return true;
  }

  const room = await findAvailableRoom(ctx.property.id, ciIso, coIso);
  if (!room) {
    logToAxiom('info', 'stay_menu_no_availability', { phone: ctx.phone, product: product.key, checkIn: ciIso, checkOut: coIso });
    if (typedName && typedName !== knownName) await updateGuestState(ctx.guest.id, { 'Guest Name': typedName });
    await logEnquiry(ctx.property, ctx.phone, 'No Availability', { ...enquiryTrackingOpts(ctx), checkInIso: ciIso, checkOutIso: coIso, bookingType: product.type });
    await sendNoRoomMessage(ctx, 'stay_menu');
    return true;
  }

  const bookingRef = 'WS-' + pending.id.slice(-6).toUpperCase();
  const confirmFields = {
    'Check In': ciIso, 'Check Out': coIso, 'Room': [room.id], 'Booking Ref': bookingRef,
    'Status': 'Confirmed', 'Amount Due': amount,
    ...(rateRow ? { 'Rate Applied': [rateRow.id] } : {}),
    ...(holdReleaseEnabled() ? { 'Hold Expires At': holdExpiryIso(ciIso) } : {})
  };
  const confirmWrite = await airtableUpdate('WS_Bookings', pending.id, confirmFields);
  if (confirmWrite && confirmWrite.error) {
    logToAxiom('error', 'stay_menu_confirm_write_failed', {
      phone: ctx.phone, bookingId: pending.id, roomId: room.id, amount, error: JSON.stringify(confirmWrite.error)
    });
    await sendWhatsApp(ctx.phone, msg('hourlyBookingCreateFailed', { guestName }));
    return true;
  }
  const stillFree = await findAvailableRoom(ctx.property.id, ciIso, coIso, { excludeBookingId: pending.id, preferRoomId: room.id });
  if (!stillFree || stillFree.id !== room.id) {
    const rollback = await airtableUpdate('WS_Bookings', pending.id, { 'Status': 'Cancelled' });
    if (rollback && rollback.error) {
      logToAxiom('error', 'booking_rollback_failed', {
        phone: ctx.phone, bookingId: pending.id, roomId: room.id, error: JSON.stringify(rollback.error),
        reason: 'lost the availability race AND the Cancelled write failed — booking may still be holding a contested room'
      });
    }
    await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_STAY_TYPE', 'Last Inbound At': new Date().toISOString() });
    logToAxiom('warn', 'booking_race_lost', { phone: ctx.phone, bookingId: pending.id, roomId: room.id, checkIn: ciIso, checkOut: coIso });
    await logEnquiry(ctx.property, ctx.phone, 'No Availability', { ...enquiryTrackingOpts(ctx), checkInIso: ciIso, checkOutIso: coIso, bookingType: product.type });
    await sendNoRoomMessage(ctx, 'stay_menu_recheck');
    return true;
  }

  logToAxiom('info', 'booking_create', { phone: ctx.phone, guestName, bookingRef, bookingType: product.type, stay: product.key, airtableId: pending.id });
  if (!(await advanceGuestState(ctx, { 'Guest Name': guestName, 'Session State': 'AWAITING_PAYMENT_METHOD', 'Last Inbound At': new Date().toISOString() }, { bookingId: pending.id, bookingRef }))) return true;
  await supersedeOlderBookings(ctx, { id: pending.id, checkIn: ciIso, ref: bookingRef, stay: product.label });
  await logEnquiry(ctx.property, ctx.phone, 'Booked', { ...enquiryTrackingOpts(ctx), checkInIso: ciIso, checkOutIso: coIso, bookingType: product.type, bookingId: pending.id });

  const stayLabel = product.type === 'Hourly' ? product.label : product.label + ' stay';
  const view = {
    guestName, bookingRef, amount, stayLabel,
    checkInText: formatSastDateTime(ciIso),
    checkOutText: formatSastDateTime(coIso)
  };
  const alertTo = operationalAlertPhone(ctx.property);
  if (alertTo) {
    logOwnerSendWindow('stay_menu_new_booking', alertTo, ctx.phone);
    const ownerSend = await sendNewBookingAlert(alertTo, newBookingTemplateParams({
      propertyName: ctx.property.fields['Property Name'], guestName, guestPhone: ctx.phone, bookingRef,
      bookingType: product.type, checkInIso: ciIso, checkOutIso: coIso, hours: product.hours, amount
    }), {
      key: 'stayMenuOwnerNewBooking',
      vars: { ...view, phone: ctx.phone }
    }, { bookingId: pending.id });
    if (ownerSend && ownerSend.error) {
      logToAxiom('error', 'owner_stay_menu_booking_notify_failed', { bookingId: pending.id, error: JSON.stringify(ownerSend.error) });
    }
  }
  await sendWhatsApp(ctx.phone, msg('stayMenuBookingReceived', view));
  await sendPaymentMethodMenu(ctx);
  return true;
}

// ─── MESSAGE DEDUPE (WABISTAY_MESSAGE_DEDUPE) ────────────────────────────────
// Meta can deliver the same inbound message twice ("these retries can result in
// duplicate webhook notifications"). With the flag on, a message is skipped only when
// its id already equals the guest's stored 'Last Message Id'. The id is written ONLY
// AFTER the message has been handled — by the single wrapper around handleMessageInner
// below, and only when handling returned without throwing. It must not be written
// early: a crash or timeout after an early write makes Meta's retry look like a
// duplicate, so the message is silently lost; written late, the retry is processed.
// The cost of that choice: two deliveries that overlap while the first is still being
// handled can both read the old id and both be processed (the window is the handling
// time, bounded by the 10 s function limit), and a handler that dies half-way may have
// already done some of its side effects before the retry runs it again.
// A sender with no WS_Guests row cannot be checked (accepted). Fails OPEN: if the read
// or the write fails the message is processed and the failure logged.
function messageDedupeEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_MESSAGE_DEDUPE || '').trim());
}
async function recordHandledMessageId(phone, wamid, guestId) {
  try {
    const idWrite = await airtableUpdate('WS_Guests', guestId, { 'Last Message Id': wamid });
    if (idWrite && idWrite.error) {
      logToAxiom('error', 'message_dedupe_write_failed', { phone, wamid, guestId, error: JSON.stringify(idWrite.error) });
    }
  } catch (err) {
    logToAxiom('error', 'message_dedupe_write_failed', { phone, wamid, guestId, message: err.message });
  }
}
// The one wrapper. handleMessageInner does the work and, after reading the guest,
// tells us who to stamp (dedupe.guestId) or that this is a duplicate (dedupe.skipped).
// If the inner function throws, the throw propagates and nothing is written.
async function handleMessage(from, messageText, phoneNumberId, wamid, interactive = null) {
  const dedupe = { guestId: null, skipped: false };
  await handleMessageInner(from, messageText, phoneNumberId, wamid, interactive, dedupe);
  if (messageDedupeEnabled() && wamid && dedupe.guestId && !dedupe.skipped) {
    await recordHandledMessageId(formatPhone(from), wamid, dedupe.guestId);
  }
}

// ─── INTERACTIVE REPLIES (WABISTAY_INTERACTIVE) ──────────────────────────────
// A button/list tap arrives as type "interactive" with reply id + title. The id is
// turned into the canonical text the state table already understands, and ONLY in
// the state the button belongs to; in any other state it is a stale tap and must not
// be read as a menu choice (e.g. a second tap on an old "Card" button once the guest
// has moved on). Typed replies are unaffected and stay valid either way.
function interactiveEnabled() {
  return /^(1|true)$/i.test(String(process.env.WABISTAY_INTERACTIVE || '').trim());
}
const INTERACTIVE_REPLY_IDS = {
  pay_card: { state: 'AWAITING_PAYMENT_METHOD', text: '1' },
  pay_eft: { state: 'AWAITING_PAYMENT_METHOD', text: '2' }
};
// States whose "*" row would swallow ANY text as data (an arrival time, rating
// feedback): a stale tap there is answered with that state's own prompt and goes no
// further, so a button title is never saved as the guest's answer.
const STALE_TAP_REPROMPT = { AWAITING_ETA: 'askEta', AWAITING_RATING_FEEDBACK: 'ratingLowFollowup' };
const STALE_TAP_PREFIX = 'interactive:';
function canonicalTextForTap(replyId, sessionState) {
  const mapping = INTERACTIVE_REPLY_IDS[replyId];
  return mapping && mapping.state === sessionState ? mapping.text : null;
}

// Meta's limits for reply buttons, as code constants.
const INTERACTIVE_LIMITS = { buttons: 3, buttonTitle: 20, buttonId: 256, body: 1024, footer: 60 };
function validateReplyButtons({ body, buttons, footer }) {
  if (typeof body !== 'string' || body.length === 0) return 'body_missing';
  if (body.length > INTERACTIVE_LIMITS.body) return 'body_too_long';
  if (footer !== undefined && footer !== null && String(footer).length > INTERACTIVE_LIMITS.footer) return 'footer_too_long';
  if (!Array.isArray(buttons) || buttons.length === 0) return 'no_buttons';
  if (buttons.length > INTERACTIVE_LIMITS.buttons) return 'too_many_buttons';
  for (const b of buttons) {
    if (!b || typeof b.id !== 'string' || !b.id) return 'button_id_missing';
    if (b.id.length > INTERACTIVE_LIMITS.buttonId) return 'button_id_too_long';
    if (typeof b.title !== 'string' || !b.title) return 'button_title_missing';
    if (b.title.length > INTERACTIVE_LIMITS.buttonTitle) return 'button_title_too_long';
  }
  if (new Set(buttons.map(b => b.id)).size !== buttons.length) return 'duplicate_button_id';
  return null;
}

// Reply buttons only. Validated BEFORE sending: an over-limit message is never sent.
// Returns { ok, invalid?, error?, wamid? }; callers fall back to the text menu.
async function sendInteractiveButtons(to, { body, buttons, footer }) {
  const invalid = validateReplyButtons({ body, buttons, footer });
  if (invalid) {
    logToAxiom('error', 'interactive_invalid', { to, reason: invalid });
    return { ok: false, invalid };
  }
  const interactive = {
    type: 'button',
    body: { text: body },
    action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) }
  };
  if (footer) interactive.footer = { text: footer };
  console.log(`[WhatsApp INTERACTIVE SEND] to: ${to} | buttons: ${buttons.map(b => b.id).join(',')}`);
  const res = await fetch(`https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'interactive', interactive })
  });
  const data = await res.json();
  const wamid = (data && data.messages && data.messages[0] && data.messages[0].id) || null;
  const ok = !data.error && res.status < 300;
  if (!ok) {
    logToAxiom('error', 'interactive_send_error', { to, status: res.status, error: JSON.stringify(data.error || null) });
  } else {
    logToAxiom('info', 'interactive_sent', { to, wamid, buttons: buttons.map(b => b.id) });
  }
  return { ok, error: (data && data.error) || null, wamid };
}

const PAYMENT_BUTTONS = [{ id: 'pay_card', title: 'Card' }, { id: 'pay_eft', title: 'Instant EFT' }];

// The payment-method menu. WABISTAY_INTERACTIVE off: the numbered text menu exactly
// as before. On: two reply buttons; if they cannot be sent (over a limit, or Meta
// rejects them at once) that is logged and the numbered text menu is sent once.
// Typed 1 / 2 / card / eft are valid either way.
async function sendPaymentMethodMenu(ctx) {
  const propertyName = ctx.property.fields['Property Name'];
  const sendTextMenu = () => sendWhatsApp(ctx.phone, msg('paymentMethodMenu', { propertyName }));
  if (!interactiveEnabled()) return sendTextMenu();
  const result = await sendInteractiveButtons(ctx.phone, {
    body: msg('paymentMethodButtonsBody', { propertyName }),
    buttons: PAYMENT_BUTTONS
  });
  if (result.ok) return result;
  logToAxiom('warn', 'interactive_fallback_text', {
    phone: ctx.phone, menu: 'payment_method', reason: result.invalid || 'meta_rejected',
    error: result.error ? JSON.stringify(result.error) : null
  });
  return sendTextMenu();
}

async function handleMessageInner(from, messageText, phoneNumberId, wamid, interactive = null, dedupe = {}) {
  const phone = formatPhone(from);
  let text = messageText.trim().toLowerCase();
  console.log(`[handleMessage] from: ${phone} | text: ${text}`);

  // 6.4: resolve property before anything else — no action may run for an
  // unconfigured number, and no property's data may leak to another's guest.
  const property = await resolveProperty(phoneNumberId);
  if (!property) {
    console.error(`[Dispatch] no WS_Properties match for phone_number_id: ${phoneNumberId} — refusing dispatch`);
    logToAxiom('info', 'message_received', { phone, text: messageText.slice(0, 100), sessionState: null });
    await sendWhatsApp(phone, msg('numberNotConfigured'));
    return;
  }
  noteNotifyPhones(property);
  // Best-effort, non-blocking — see bumpPropertyActivity's own comment.
  await bumpPropertyActivity(property.id, 'Last Message Received');

  const guestRecords = await airtableGet('WS_Guests', `{Phone Number} = '${phone}'`);
  const guest = guestRecords[0] || null;
  const sessionState = guest ? guest.fields['Session State'] : null;
  console.log(`[State] guest: ${guest ? guest.id : 'none'} | state: ${sessionState}`);
  // Logged here rather than first thing so it can carry the step the guest was on
  // (the last step reached, for lost-enquiry reporting). A test phone is flagged,
  // not hidden: Axiom logging stays on for them.
  // WABISTAY_MESSAGE_DEDUPE: skip only when this exact id is already stored. Nothing is
  // written here: the wrapper stamps the id after this function returns successfully.
  if (messageDedupeEnabled() && wamid && guest) {
    if (guest.fields['Last Message Id'] === wamid) {
      dedupe.skipped = true;
      logToAxiom('info', 'duplicate_message_skipped', { phone, wamid, guestId: guest.id, sessionState: sessionState || null });
      return;
    }
    dedupe.guestId = guest.id;
  }

  logToAxiom('info', 'message_received', {
    phone, text: messageText.slice(0, 100), sessionState: sessionState || null, ...(isTestGuest(guest) ? { testPhone: true } : {}),
    ...(interactive ? { interactiveId: interactive.id, interactiveTitle: String(interactive.title || '').slice(0, 100) } : {})
  });

  // WABISTAY_INTERACTIVE: a tap becomes canonical text only in its own state.
  if (interactive) {
    const canonical = canonicalTextForTap(interactive.id, sessionState);
    logToAxiom('info', 'interactive_reply_received', {
      phone, replyId: interactive.id, title: String(interactive.title || '').slice(0, 100),
      sessionState: sessionState || null, mapped: canonical !== null
    });
    if (canonical !== null) {
      messageText = canonical;
      text = canonical;
    } else {
      // Stale tap: never a menu choice. States that would swallow any text as data
      // get their own prompt and stop; every other state sees text that matches
      // nothing, so its own re-prompt answers.
      const reprompt = STALE_TAP_REPROMPT[sessionState];
      if (reprompt) {
        await sendWhatsApp(phone, msg(reprompt));
        return;
      }
      messageText = STALE_TAP_PREFIX + interactive.id;
      text = messageText.toLowerCase();
    }
  }

  // ── B14: STOP opt-out (two-tier) ───────────────────────────────────────────
  // Evaluated before consent and before dispatch, so an opting-out or already
  // opted-out guest never receives an optional message. Case-insensitive by
  // construction (text is already lowercased). Two-tier rule (CEO):
  //   · STOP instantly kills all OPTIONAL messaging.
  //   · TRANSACTION-COMPLETION messages for an already-active booking (Confirmed
  //     / Checked In) still deliver, until that booking closes.
  const activeBooking = ACTIVE_BOOKING_STATES.includes(sessionState);
  if (STOP_KEYWORDS.includes(text)) {
    // F43 (fix-order item 5a): STOP previously ran before any staff-identity
    // check and wrote 'Opted Out': true to WS_Guests for ANY number, staff or
    // guest — including creating a brand-new WS_Guests row for a cleaner/
    // reception/owner number never seen before. Confirmed by diagnosis this
    // never actually blocked an operational send (cleaner dispatch, owner
    // notify, reception notify all look up their target via WS_Cleaners/
    // WS_Roles/OWNER_PHONE directly, never WS_Guests) and never broke a staff
    // member's own commands (senderIsAuthorizedWalkin etc. resolve purely from
    // WS_Roles/WS_Cleaners too) — so this was data-hygiene pollution, not an
    // operational lockout. Fixed anyway: a stray Opted-Out guest row for a
    // staff seat is still wrong, and opt-out is a guest-facing concept a
    // staff number never meant to invoke by typing a word that happens to
    // collide. Same identity check the POPIA-consent block below already
    // uses, run here first instead — cost is one extra pair of reads, paid
    // only on the rare message that is literally "stop", not on every inbound
    // message.
    const isCleanerNumber = (await airtableGet('WS_Cleaners', `{Phone Number} = '${phone}'`)).length > 0;
    const isOwnerNumber = isOwnerSideNumber(phone, property);
    const isStaffNumber = isCleanerNumber || isOwnerNumber || (await activeWalkinRoleForPhone(phone)) !== null;
    if (isStaffNumber) {
      logToAxiom('info', 'stop_ignored_staff_number', { phone });
      return;
    }
    const at = new Date().toISOString();
    // Rule 30 step 2, slice 2 — scope correction, not a slice default: this is
    // FATAL-style not because it's a WS_Guests write (most of this slice's
    // WS_Guests writes, like Session State, are NON-FATAL) but because of what
    // 'Opted Out' actually gates — every subsequent inbound message from this
    // number branches on it (the check just below this block). If this write
    // silently fails, telling the guest "you're opted out" while the record
    // still reads opted-IN means their very next message runs straight through
    // the booking flow instead of staying suppressed — a real compliance
    // mismatch, not a cosmetic miss. The rule was never "table X gets
    // treatment Y" — it's "does failure leave the system asserting something
    // false to the guest."
    const optOutWrite = guest
      ? await airtableUpdate('WS_Guests', guest.id, { 'Opted Out': true, 'Opted Out At': at })
      // STOP from a number we have never seen — record the opt-out so future
      // messages stay silent.
      : await airtableCreate('WS_Guests', {
          'Phone Number': phone, 'Guest Type': 'WhatsApp', 'Session State': 'NEW',
          'Opted Out': true, 'Opted Out At': at
        });
    if (optOutWrite && optOutWrite.error) {
      logToAxiom('error', 'guest_opt_out_write_failed', {
        phone, error: JSON.stringify(optOutWrite.error)
      });
      await sendWhatsApp(phone, msg('optOutWriteFailed'));
      return;
    }
    logToAxiom('info', 'guest_opted_out', { phone, activeBooking });
    // The single acknowledgement explaining status + how to opt back in.
    await sendWhatsApp(phone, msg('optedOut'));
    return;
  }
  if (guest && guest.fields['Opted Out']) {
    if (START_KEYWORDS.includes(text)) {
      // Rule 30 step 2, slice 2: same FATAL-style reasoning as the STOP write
      // above, mirrored — a silent failure here would tell the guest they're
      // opted back in while the record still reads opted-out, silencing the
      // booking flow on their very next message.
      const optInWrite = await airtableUpdate('WS_Guests', guest.id, { 'Opted Out': false, 'Opted Out At': null });
      if (optInWrite && optInWrite.error) {
        logToAxiom('error', 'guest_opt_in_write_failed', {
          phone, error: JSON.stringify(optInWrite.error)
        });
        await sendWhatsApp(phone, msg('optOutWriteFailed'));
        return;
      }
      logToAxiom('info', 'guest_opted_back_in', { phone });
      await sendWhatsApp(phone, msg('optedBackIn'));
      return;
    }
    if (!activeBooking) {
      // No active booking → optional messaging is silenced: the booking flow
      // never runs. Respond once with the opt-out status + how to opt back in.
      // (Strictly-once-then-total-silence would need a third tracking field — see
      // PR; only the two CEO-specified fields exist, so each optional inbound
      // gets the terse pointer, which is a compliant reply to a user message.)
      logToAxiom('info', 'opted_out_optional_suppressed', { phone, sessionState });
      await sendWhatsApp(phone, msg('optedOut'));
      return;
    }
    // Active booking: fall through to dispatch so transaction-completion
    // messages (gate arrival, checkout, extension) still deliver.
    logToAxiom('info', 'opted_out_transaction_allowed', { phone, sessionState });
  }

  // ── Payment gating: suspended-property booking block ───────────────────────
  // Wabistay Automated Payment Gating investigation, Phase 4. Placed AFTER the
  // STOP/opt-out block above (opt-out/opt-back-in must work regardless of
  // subscription status — that's a compliance concern, not a booking one) but
  // BEFORE the POPIA consent notice below (CEO decision, 2026-09-17): a
  // suspended property must show a first-ever contact ONLY the redirect, never
  // the consent notice first — sending both leaks "the bot is active/booking-
  // capable" before telling them to go elsewhere, which is confusing and
  // pointless. Reuses `activeBooking` (ACTIVE_BOOKING_STATES, computed above
  // for the STOP two-tier rule) as the exemption boundary — a guest with an
  // existing/confirmed booking must continue receiving normal service
  // uninterrupted; only NEW enquiries are blocked.
  //
  // FIELD NAMES ARE PROPOSED, NOT YET LIVE (blocked on the Airtable API
  // billing cap, same as PR 1-3 this session): 'Subscription Status' and
  // 'Guest Redirect Phone' on WS_Properties. Do not treat these as confirmed
  // until CEO creates them and a live schema pull verifies them — same
  // two-phase workaround as the rest of this session's work.
  //
  // OPEN QUESTION, not resolved here (flagged, not guessed): this check does
  // NOT distinguish staff numbers (cleaner/owner/WALKIN-authorized) from
  // genuine guests the way the consent-notice block just below does. A staff
  // member's very first-ever message to this property, if it happened to be
  // read as a NEW enquiry with no active booking, would currently receive the
  // suspended-redirect instead of proceeding — duplicating the consent
  // block's isCleaner/isOwner/isStaff check here felt like guessing at scope
  // rather than following an existing pattern, so it's left as-is and named
  // explicitly rather than silently handled either way.
  if (property.fields['Subscription Status'] === 'Suspended' && !activeBooking) {
    // CEO decision, 2026-09-28: every property is expected to carry a Guest
    // Redirect Phone before it is ever suspended (true today for the one live
    // property, Canary Street). This branch is the exception path for a
    // property suspended before that number was set — the guest still needs
    // a graceful reply (can't leave them on a broken/numberless redirect
    // while the CEO gets alerted), and the CEO must be told directly rather
    // than discover it from a confused guest. alertShawn is the existing
    // CEO-facing alert channel (used for cron failures and gate_arrival's
    // missing-cleaner case above) — reused as-is, no new notify mechanism.
    // No per-property/per-day dedupe exists anywhere else in this codebase to
    // reuse (checked); this fires on every message from an affected guest
    // until the number is set, same fail-loud posture as the rest of this
    // gate.
    if (!property.fields['Guest Redirect Phone']) {
      logToAxiom('error', 'suspended_property_missing_redirect_phone', {
        phone, propertyId: property.id, sessionState
      });
      await alertShawn(
        'suspended_property_missing_redirect_phone',
        'A Suspended property has no Guest Redirect Phone set — a guest just hit the booking block and got the generic fallback message.',
        { propertyId: property.id, propertyName: property.fields['Property Name'] || null }
      );
      await sendWhatsApp(phone, msg('propertySuspendedNoNumberFallback', {
        propertyName: property.fields['Property Name']
      }));
      return;
    }
    // msg() does plain string substitution (String(v)) with no null-handling
    // of its own — an unset 'Guest Redirect Phone' must not leak the literal
    // text "null" into a guest-facing message, so the fallback is resolved
    // here, not left to the template. In practice unreachable now that the
    // check above handles the missing-number case explicitly first — kept as
    // a defensive second line, not the primary path.
    const redirectPhoneText = property.fields['Guest Redirect Phone'] || 'our team directly';
    logToAxiom('info', 'booking_blocked_property_suspended', {
      phone, propertyId: property.id, sessionState
    });
    await sendWhatsApp(phone, msg('propertySuspendedRedirect', {
      propertyName: property.fields['Property Name'],
      redirectPhoneText
    }));
    return;
  }

  // B13: POPIA consent notice. Notice-only, implied consent (CEO 16 July) — no
  // YES/1 opt-in gate. Sent as message #1 for a genuinely NEW guest conversation:
  // "new" = first-ever contact from this number, i.e. NO existing WS_Guests
  // record. A returning guest starting another booking already has a record and
  // does not see it again. Never sent to a registered cleaner or the owner. The
  // STOP line references B14 (Step 6 of this sprint) — valid by merge time, since
  // both branches merge together (ordering dependency noted in the PR).
  if (!guest) {
    const isCleaner = (await airtableGet('WS_Cleaners', `{Phone Number} = '${phone}'`)).length > 0;
    const isOwner = isOwnerSideNumber(phone, property);
    // B7: a staff seat is not a guest. Without this, the first WALKIN ever sent
    // from a reception handset answers with a POPIA notice about that person's
    // own data — same category error the cleaner and owner exclusions above
    // already fix. Costs one extra read, and only for a number we have never
    // seen before.
    const isStaff = (await activeWalkinRoleForPhone(phone)) !== null;
    if (!isCleaner && !isOwner && !isStaff) {
      await sendWhatsApp(phone, msg('consentNotice', { propertyName: property.fields['Property Name'] }));
      logToAxiom('info', 'popia_consent_sent', { phone });
    }
  }

  // stepOnArrival / attemptStartedAt are snapshots taken before any handler writes: the
  // lost-enquiry rows report the step the guest was answering and when the attempt began,
  // however far the handler has moved the guest on by the time it logs.
  const ctx = {
    phone, text, messageText, wamid, guest, next: null, cleaner: null, property,
    stepOnArrival: sessionState || null,
    attemptStartedAt: (guest && guest.fields['Attempt Started At']) || null
  };

  // Global transitions (cleaner DONE) — guard decides, any state
  for (const t of STATES.global) {
    if (t.inputs !== '*' && !t.inputs.includes(text)) continue;
    if (t.guard && !(await guards[t.guard](ctx))) continue;
    ctx.next = t.next || null;
    console.log(`[Dispatch] global → ${t.action}`);
    // WABISTAY_AFTER_HOURS: "hi" / "menu" from a booking step restarts the chat, so it can carry the welcome.
    if (t.action === 'greetAndAskStayType' && afterHoursEnabled() && !isTestGuest(guest)) {
      const restartWelcome = await afterHoursPrelude(ctx, { restart: true });
      await actions[t.action](ctx);
      if (restartWelcome) await stampAfterHoursReply(ctx);
      return;
    }
    return actions[t.action](ctx);
  }

  // State routing: no guest / no state / NEW all route to NEW; unknown states to "*"
  const stateKey = (!guest || !sessionState || sessionState === 'NEW')
    ? 'NEW'
    : (STATES.states[sessionState] ? sessionState : '*');

  const transition = matchTransition(STATES.states[stateKey], text);
  if (!transition) return; // unreachable while every state has a "*" row
  ctx.next = transition.next || null;
  // WABISTAY_AFTER_HOURS: the closed-hours welcome (once per window) goes before the normal reply.
  const afterHours = afterHoursEnabled() && !isTestGuest(guest) ? await afterHoursPrelude(ctx) : null;
  console.log(`[Dispatch] ${stateKey} → ${transition.action}${ctx.next ? ' → ' + ctx.next : ''}`);
  if (!afterHours) return actions[transition.action](ctx);
  await actions[transition.action](ctx);
  await stampAfterHoursReply(ctx);
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  logFlagsOnce();
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
      console.log('Webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    // F1: explicit body parse guard — req.body can be undefined or a raw string
    // depending on how Meta sends the webhook and Vercel's body parser state
    let body = req.body;
    if (!body) {
      console.error('[BODY] req.body is undefined — body parser did not run');
      res.status(200).send('OK');
      return;
    }
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
        console.log('[BODY] Parsed raw string body successfully');
      } catch (e) {
        console.error('[BODY] Failed to parse body string:', e.message);
        res.status(200).send('OK');
        return;
      }
    }

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    const phoneNumberId = value?.metadata?.phone_number_id;

    console.log(`[POST] entry: ${!!entry} | messages: ${messages?.length || 0}`);

    // B3: delivery-status callbacks (sent/delivered/read/failed) — log each to Axiom,
    // then return. Mutually exclusive with `messages` in Meta's payload shape. In
    // production this branch is normally pre-empted by the master router's own copy
    // of this same check (api/webhook.js), which is the actual Meta-configured
    // entry point — kept here too so this handler is still correct if it's ever
    // invoked directly (its own dedicated webhook URL, or in tests).
    const statuses = value?.statuses;
    if (statuses && statuses.length > 0) {
      for (const s of statuses) {
        const detail = { wamid: s.id, status: s.status, timestamp: s.timestamp, recipient: s.recipient_id };
        if (s.status === 'failed' && s.errors) detail.errors = s.errors;
        logToAxiom('info', 'whatsapp_status_callback', detail);

        // Proxy for "owner opened WhatsApp" — see bumpPropertyActivity's
        // comment for why this is a proxy, not a real Meta app-open event.
        if (s.status === 'read' && s.recipient_id) {
          const recipient = formatPhone(String(s.recipient_id));
          airtableGet('WS_Properties', `{Notify Phone} = '${recipient}'`)
            .then(matches => {
              if (matches[0]) return bumpPropertyActivity(matches[0].id, 'Last Owner App Open');
            })
            .catch(err => logToAxiom('warn', 'owner_app_open_lookup_failed', { recipient, error: err.message }));
        }
      }
      res.status(200).send('OK');
      return;
    }

    // Coexistence: message_echoes — see handleMessageEcho above for why this
    // is its own branch rather than falling through to the "not a message"
    // check below (which would silently drop it, exactly the gap the
    // coexistence pre-check identified). Kept here too, same reasoning as the
    // statuses branch above, in case this handler is ever invoked directly.
    const messageEchoes = value?.message_echoes;
    if (messageEchoes && messageEchoes.length > 0) {
      for (const echo of messageEchoes) {
        await handleMessageEcho(echo).catch(err =>
          logToAxiom('error', 'message_echo_handling_failed', { echoId: echo.id, error: err.message })
        );
      }
      res.status(200).send('OK');
      return;
    }

    if (!messages || messages.length === 0) {
      // F2: respond 200 before returning on no-message events (status updates etc)
      res.status(200).send('OK');
      return;
    }

    const message = messages[0];
    const from = message.from;
    let messageText = message?.text?.body;
    const wamid = message.id || null;
    // WABISTAY_INTERACTIVE: a button/list reply carries no text; its title stands in
    // as the display text and its id is mapped (by state) inside handleMessage.
    let interactiveReply = null;
    if (!messageText && interactiveEnabled() && message.type === 'interactive') {
      const reply = message.interactive && (message.interactive.button_reply || message.interactive.list_reply);
      if (reply && reply.id) {
        interactiveReply = { id: String(reply.id), title: reply.title || '' };
        messageText = String(reply.title || reply.id);
      }
    }

    console.log(`[POST] from: ${from} | text: ${messageText}`);

    if (!messageText) {
      res.status(200).send('OK');
      return;
    }

    // F2: handleMessage runs FULLY before we respond 200
    try {
      await handleMessage(from, messageText, phoneNumberId, wamid, interactiveReply);
    } catch (err) {
      console.error('[FATAL]', err.message, err.stack);
      logToAxiom('error', 'fatal', { message: err.message, stack: err.stack });
    }

    res.status(200).send('OK');
    return;
  }

  res.status(405).send('Method Not Allowed');
};

// B7: exported for test/dates.test.js only. The SAST parser's interesting cases
// are near-midnight ones that need a frozen clock, which the fixture replay
// harness has no way to express — so they're unit-tested against these directly.
module.exports.parseBookingDate = parseBookingDate;
module.exports.sastToUtcIso = sastToUtcIso;
module.exports.sastCalendarDate = sastCalendarDate;
module.exports.addSastDays = addSastDays;
module.exports.compareYmd = compareYmd;
// B8: exported for test/availability.test.js. The exclusive-bounds behaviour is
// only observable when a check-in instant exactly equals a check-out instant,
// which the overnight flow can never produce (14:00 never equals 10:00) — so it
// is unreachable through a fixture and has to be tested here. See that file.
module.exports.rangesOverlap = rangesOverlap;
// B9: duration arithmetic and arrival-time parsing. addHoursToIso is the piece
// the mutation test targets — wrong by an hour and every hourly availability
// check silently examines the wrong window.
module.exports.parseArrivalTime = parseArrivalTime;
module.exports.addHoursToIso = addHoursToIso;
module.exports.hourlyRates = hourlyRates;
module.exports.formatSastDateTime = formatSastDateTime;
// F20: exported for parser unit coverage — findDateTokens locates the spans,
// parseBookingDate (already exported) validates them.
module.exports.findDateTokens = findDateTokens;
// B7 (WALKIN): the command grammar is pure and has no Airtable dependency, so it
// is tested exhaustively here — see test/walkin.parser.test.js. The handler that
// consumes it (authorisation, room resolution, booking write) is a separate,
// schema-dependent commit.
module.exports.parseWalkinCommand = parseWalkinCommand;
// B8 (PAID): the command grammar is pure and Airtable-free, so it is unit-tested
// directly — see test/paid.test.js.
module.exports.parsePaidCommand = parsePaidCommand;
module.exports.parseCheckoutCommand = parseCheckoutCommand;
// Cleaning time: the START grammar is pure, and the bare-`START` case is the one
// that must never regress (it is B14's opt-back-in keyword). Unit-tested in
// test/cleaningtime.test.js alongside the derived metrics.
module.exports.parseStartCleaningCommand = parseStartCleaningCommand;
module.exports.cleaningDurations = cleaningDurations;
// B12: the auto-checkout cron entry point (autoCheckoutHandler wraps it for the
// Vercel HTTP cron; runAutoCheckout takes an injected `now` for timing tests).
module.exports.runAutoCheckout = runAutoCheckout;
module.exports.autoCheckoutHandler = autoCheckoutHandler;
// B17: owner summary aggregation. runOwnerSummary(opts) takes injected now/daily
// for tests; ownerSummaryHandler is the Vercel HTTP cron entry.
module.exports.runOwnerSummary = runOwnerSummary;
module.exports.ownerSummaryHandler = ownerSummaryHandler;
module.exports.runWeeklyRecap = runWeeklyRecap;
module.exports.weeklyRecapHandler = weeklyRecapHandler;
module.exports.sendWeeklyRecap = sendWeeklyRecap;
module.exports.aggregateWeeklyRecap = aggregateWeeklyRecap;
module.exports.weeklyRecapTemplateParams = weeklyRecapTemplateParams;
module.exports.WEEKLY_RECAP_TEMPLATE = WEEKLY_RECAP_TEMPLATE;
module.exports.resolveSendRecipient = resolveSendRecipient;
module.exports.runDailySummary = runDailySummary;
module.exports.dailySummaryHandler = dailySummaryHandler;
// Stage 3 part 2: daily summary content sections, exported individually so
// each can be unit-tested apart from the full hour-matching loop.
module.exports.aggregateDailySummary = aggregateDailySummary;
module.exports.roomStateGrid = roomStateGrid;
module.exports.isNoShow = isNoShow;
module.exports.overnightStatsToday = overnightStatsToday;
module.exports.hourlyStatsToday = hourlyStatsToday;
module.exports.cleaningTurnaroundToday = cleaningTurnaroundToday;
module.exports.revenueToday = revenueToday;
module.exports.tomorrowsOvernightArrivals = tomorrowsOvernightArrivals;
module.exports.aggregateOwnerSummary = aggregateOwnerSummary;
module.exports.aggregateMonthlyReport = aggregateMonthlyReport;
module.exports.runMonthlyReport = runMonthlyReport;
module.exports.monthlyReportHandler = monthlyReportHandler;
module.exports.sendMonthlyReport = sendMonthlyReport;
module.exports.monthlyReportTemplateParams = monthlyReportTemplateParams;
module.exports.MONTHLY_REPORT_TEMPLATE = MONTHLY_REPORT_TEMPLATE;
module.exports.jobDurationMs = jobDurationMs;
module.exports.paymentReconciliationLines = paymentReconciliationLines;
module.exports.formatPaymentReconciliationMessage = formatPaymentReconciliationMessage;
// B19: enquiry-abandonment staleness sweep (injected `now` for timing tests).
module.exports.runEnquiryAbandonment = runEnquiryAbandonment;
// Rule 30 step 1: exported so the new success-vs-failure logging on these three
// shared write/send functions is testable directly — see
// test/success-logging.test.js — rather than only indirectly through whichever
// handler happens to call them.
module.exports.airtableCreate = airtableCreate;
module.exports.airtableUpdate = airtableUpdate;
module.exports.sendWhatsApp = sendWhatsApp;
module.exports.alertShawn = alertShawn;
module.exports.getAlertPhone = getAlertPhone;
module.exports.cronTimeBudgetMs = cronTimeBudgetMs;
module.exports.runHoldRelease = runHoldRelease;
module.exports.runUnattendedGateSweep = runUnattendedGateSweep;
module.exports.runOverdueAlerts = runOverdueAlerts;
module.exports.overnightHoldExpiryIso = overnightHoldExpiryIso;
module.exports.holdExpiryIso = holdExpiryIso;
module.exports.orderFreeRooms = orderFreeRooms;
module.exports.wabistayFlagState = wabistayFlagState;
module.exports.otherSwitchState = otherSwitchState;
module.exports.newBookingTemplateParams = newBookingTemplateParams;
module.exports.operationalAlertPhone = operationalAlertPhone;
module.exports.reportRecipientPhone = reportRecipientPhone;
module.exports.isOwnerSideNumber = isOwnerSideNumber;
module.exports.canonicalTextForTap = canonicalTextForTap;
module.exports.validateReplyButtons = validateReplyButtons;
module.exports.INTERACTIVE_LIMITS = INTERACTIVE_LIMITS;
module.exports.parseOneLineNameAndTime = parseOneLineNameAndTime;
module.exports.pickBookingForPaidRoom = pickBookingForPaidRoom;
module.exports.parseStayMenuChoice = parseStayMenuChoice;
module.exports.stayMenuKeysForHour = stayMenuKeysForHour;
module.exports.stayWindowForArrival = stayWindowForArrival;
module.exports.resolveBareHour = resolveBareHour;
module.exports.rateUnitLabel = rateUnitLabel;
module.exports.STAY_PRODUCTS = STAY_PRODUCTS;
module.exports.sanitizeTemplateParam = sanitizeTemplateParam;
module.exports.bumpPropertyActivity = bumpPropertyActivity;
module.exports.dormantProperties = dormantProperties;
module.exports.inactiveByMessageActivity = inactiveByMessageActivity;
// Shift-routing/escalation PR 1: per-property escalation timeout, global
// default fallback. See header comment above escalationTimeoutMs for why
// gateAckGraceMs() is NOT the precedent this follows.
module.exports.escalationTimeoutMs = escalationTimeoutMs;
module.exports.ESCALATION_TIMEOUT_DEFAULT_MINUTES = ESCALATION_TIMEOUT_DEFAULT_MINUTES;
// Shift-routing/escalation PR 2: role-tagged escalation contacts, extending
// WS_Roles (see header comment above resolveEscalationChain for why
// WS_Owner_Notify is NOT the precedent, and why Owner deliberately stays a
// Notify Phone/OWNER_PHONE lookup, never a WS_Roles one).
module.exports.ESCALATION_TIER_ROLE_TYPES = ESCALATION_TIER_ROLE_TYPES;
module.exports.activeEscalationRolesForProperty = activeEscalationRolesForProperty;
module.exports.resolveEscalationChain = resolveEscalationChain;
module.exports.sendEscalationAlert = sendEscalationAlert;
module.exports.DORMANT_THRESHOLD_DAYS_DEFAULT = DORMANT_THRESHOLD_DAYS_DEFAULT;
// CEO manual report-trigger (api/wabistay/cron/manual-report.js) needs these
// to build the SAME live-data fetch + stubbed-send pipeline the real crons
// use, without duplicating the Airtable query/pagination logic here.
module.exports.airtableGet = airtableGet;
module.exports.orFormula = orFormula;
module.exports.BLOCKING_BOOKING_STATUSES = BLOCKING_BOOKING_STATUSES;
module.exports.BOOKABLE_ROOM_STATUSES = BOOKABLE_ROOM_STATUSES;
module.exports.sendDailySummary = sendDailySummary;
module.exports.sendOwnerSummary = sendOwnerSummary;
// Coexistence: exported for direct unit testing (test/coexistence.test.js),
// same rationale as the Rule 30 step 1 exports above.
module.exports.handleMessageEcho = handleMessageEcho;
module.exports.BOT_HANDBACK_COMMAND = BOT_HANDBACK_COMMAND;
// Stage 3 part 3 prep (dailySummaryTemplateParams) — exported for isolated
// unit testing per the TODO at sendDailySummary; NOT wired to a live send.
module.exports.resolveOwnerName = resolveOwnerName;
module.exports.formatSignedAmount = formatSignedAmount;
module.exports.formatHumanDate = formatHumanDate;
module.exports.dailySummaryTemplateParams = dailySummaryTemplateParams;
