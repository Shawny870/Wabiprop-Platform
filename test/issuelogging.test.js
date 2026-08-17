// test/issuelogging.test.js
// Stage 4 — WS_Issues logging. Content/data only: the guest/staff entry
// points here are NOT wired into handleMessage's dispatch table yet (see
// comments in webhook.js) — this file tests the standalone functions in
// isolation, per the same "prep, unit-tested, not wired live" pattern as
// dailySummaryTemplateParams.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

const baseSeed = {
  WS_Properties: [{ id: 'recVL', fields: { 'Property Name': 'Villa Liza Guest Lodge' } }],
  WS_Rooms: [
    { id: 'recRoom1', fields: { 'Room Name': 'Room 01', 'Property': ['recVL'] } },
    { id: 'recRoom2', fields: { 'Room Name': 'Room 02', 'Property': ['recVL'] } }
  ],
  WS_Guests: [{ id: 'recGuest1', fields: { 'Guest Name': 'Jane Guest', 'Phone Number': '27821111111' } }],
  WS_Bookings: [],
  WS_Roles: [],
  WS_Cleaners: [],
  WS_Issues: []
};

// ── logIssue: the core writer ────────────────────────────────────────────────

test('logIssue: rejects an invalid reporterRole before touching Airtable', async () => {
  const ctx = setup(baseSeed);
  await assert.rejects(
    () => wh.logIssue({ propertyId: 'recVL', reporterRole: 'Agent', title: 'x', description: 'y' }),
    /invalid reporterRole 'Agent'/
  );
  assert.strictEqual(ctx.airtable.log.length, 0);
});

test('logIssue: rejects a missing/empty title before touching Airtable', async () => {
  const ctx = setup(baseSeed);
  await assert.rejects(
    () => wh.logIssue({ propertyId: 'recVL', reporterRole: 'Guest', title: '  ', description: 'y' }),
    /title is required/
  );
  assert.strictEqual(ctx.airtable.log.length, 0);
});

test('logIssue: writes Issue Resolution Status = Open and the correct field set', async () => {
  const ctx = setup(baseSeed);
  const issue = await wh.logIssue({
    propertyId: 'recVL', bookingId: 'recBk1', roomId: 'recRoom1',
    reporterRole: 'Guest', reporterPhone: '27821111111',
    title: 'Leaking tap', description: 'Bathroom tap won\'t stop dripping'
  });
  assert.ok(issue.id);
  const write = ctx.airtable.log.find(w => w.table === 'WS_Issues');
  assert.strictEqual(write.fields['Issue Title'], 'Leaking tap');
  assert.strictEqual(write.fields['Description'], "Bathroom tap won't stop dripping");
  assert.strictEqual(write.fields['Reported By Role'], 'Guest');
  assert.strictEqual(write.fields['Issue Resolution Status'], 'Open');
  assert.strictEqual(write.fields['Reporter Phone'], '27821111111');
  assert.deepStrictEqual(write.fields['Property'], ['recVL']);
  assert.deepStrictEqual(write.fields['Linked Booking'], ['recBk1']);
  assert.deepStrictEqual(write.fields['Linked Room'], ['recRoom1']);
  assert.ok(write.fields['Date Reported']);
});

test('logIssue: omits link fields entirely when not provided, rather than writing empty arrays', async () => {
  const ctx = setup(baseSeed);
  await wh.logIssue({ propertyId: null, reporterRole: 'Cleaner', title: 'x', description: 'y' });
  const write = ctx.airtable.log.find(w => w.table === 'WS_Issues');
  assert.strictEqual('Property' in write.fields, false);
  assert.strictEqual('Linked Booking' in write.fields, false);
  assert.strictEqual('Linked Room' in write.fields, false);
});

test('logIssue: logs issue_logged to Axiom on success', async () => {
  const ctx = setup(baseSeed);
  const issue = await wh.logIssue({ propertyId: 'recVL', reporterRole: 'Owner', title: 'x', description: 'y' });
  const ev = ctx.axiom.find(e => e.event === 'issue_logged');
  assert.ok(ev);
  assert.strictEqual(ev.issueId, issue.id);
  assert.strictEqual(ev.reporterRole, 'Owner');
});

// ── notifyIssueReported: routing (stub-and-log only) ─────────────────────────

test('notifyIssueReported: routes to the active Reception seat, stub-and-log only (no live send)', async () => {
  const ctx = setup({
    ...baseSeed,
    WS_Roles: [{ id: 'recRole1', fields: {
      'Role Label': 'Villa Liza Reception', 'Role Type': 'Reception',
      'Property': ['recVL'], 'Current Phone': '27825999279', 'Active': true
    } }]
  });
  const issue = await wh.logIssue({ propertyId: 'recVL', reporterRole: 'Guest', title: 'Broken AC', description: 'AC not cooling' });
  const ev = ctx.axiom.find(e => e.event === 'issue_notify_stubbed');
  assert.ok(ev, 'expected issue_notify_stubbed event');
  assert.strictEqual(ev.to, '27825999279');
  assert.strictEqual(ev.title, 'Broken AC');
  assert.strictEqual(ev.issueId, issue.id);
  // Stub-and-log, never a live send — confirms no WhatsApp send happened.
  assert.strictEqual(ctx.sends.length, 0);
});

test('notifyIssueReported: logs a loud warning (not silence) when no active Reception seat exists', async () => {
  const ctx = setup(baseSeed); // no WS_Roles seeded
  await wh.logIssue({ propertyId: 'recVL', reporterRole: 'Guest', title: 'x', description: 'y' });
  const ev = ctx.axiom.find(e => e.event === 'issue_notify_no_seat');
  assert.ok(ev);
  assert.strictEqual(ev.propertyId, 'recVL');
});

test('notifyIssueReported: an inactive Reception seat is not notified', async () => {
  const ctx = setup({
    ...baseSeed,
    WS_Roles: [{ id: 'recRole1', fields: {
      'Role Type': 'Reception', 'Property': ['recVL'], 'Current Phone': '27825999279', 'Active': false
    } }]
  });
  await wh.logIssue({ propertyId: 'recVL', reporterRole: 'Guest', title: 'x', description: 'y' });
  assert.ok(!ctx.axiom.find(e => e.event === 'issue_notify_stubbed'));
  assert.ok(ctx.axiom.find(e => e.event === 'issue_notify_no_seat'));
});

// ── parseIssueReportCommand ──────────────────────────────────────────────────

test('parseIssueReportCommand: parses "ISSUE <description>", case-insensitive', () => {
  assert.deepStrictEqual(wh.parseIssueReportCommand('ISSUE the shower is broken'), { ok: true, description: 'the shower is broken' });
  assert.deepStrictEqual(wh.parseIssueReportCommand('issue no hot water'), { ok: true, description: 'no hot water' });
});

test('parseIssueReportCommand: returns null for text that is not the ISSUE command at all', () => {
  assert.strictEqual(wh.parseIssueReportCommand('hello'), null);
  assert.strictEqual(wh.parseIssueReportCommand('issues are fun'), null); // "issue" as a whole word only
});

test('parseIssueReportCommand: flags a bare "ISSUE" with no description as a syntax error, not a silent no-op', () => {
  assert.deepStrictEqual(wh.parseIssueReportCommand('ISSUE'), { ok: false, reason: 'missing_description' });
  assert.deepStrictEqual(wh.parseIssueReportCommand('issue   '), { ok: false, reason: 'missing_description' });
});

// ── handleGuestIssueReport ───────────────────────────────────────────────────

test('handleGuestIssueReport: links the guest\'s active booking + room, reporterRole Guest', async () => {
  const ctx = setup({
    ...baseSeed,
    WS_Bookings: [{ id: 'recBk1', fields: {
      'Guest': ['recGuest1'], 'Room': ['recRoom1'], 'Status': 'Checked In', 'WS_Property': ['recVL']
    } }],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Type': 'Reception', 'Property': ['recVL'], 'Current Phone': '27825999279', 'Active': true } }]
  });
  const guestCtx = { phone: '27821111111', guest: { id: 'recGuest1', fields: {} }, property: { id: 'recVL', fields: {} } };
  await wh.handleGuestIssueReport(guestCtx, 'the shower is broken');

  const write = ctx.airtable.log.find(w => w.table === 'WS_Issues');
  assert.strictEqual(write.fields['Reported By Role'], 'Guest');
  assert.strictEqual(write.fields['Reporter Phone'], '27821111111');
  assert.deepStrictEqual(write.fields['Linked Booking'], ['recBk1']);
  assert.deepStrictEqual(write.fields['Linked Room'], ['recRoom1']);
  assert.strictEqual(ctx.sends.length, 1);
  assert.ok(ctx.sends[0].body.includes('logged'));
});

test('handleGuestIssueReport: falls back to ctx.property when the guest has no active booking', async () => {
  const ctx = setup({
    ...baseSeed,
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Type': 'Reception', 'Property': ['recVL'], 'Current Phone': '27825999279', 'Active': true } }]
  });
  const guestCtx = { phone: '27821111111', guest: { id: 'recGuest1', fields: {} }, property: { id: 'recVL', fields: {} } };
  await wh.handleGuestIssueReport(guestCtx, 'noise from next door');

  const write = ctx.airtable.log.find(w => w.table === 'WS_Issues');
  assert.deepStrictEqual(write.fields['Property'], ['recVL']);
  assert.strictEqual('Linked Booking' in write.fields, false);
});

// ── handleStaffIssueReport ───────────────────────────────────────────────────

test('handleStaffIssueReport: an active Reception (WS_Roles) seat reports as Reception', async () => {
  const ctx = setup({
    ...baseSeed,
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Type': 'Reception', 'Property': ['recVL'], 'Current Phone': '27825999279', 'Active': true } }]
  });
  const issue = await wh.handleStaffIssueReport({ phone: '27825999279', roomName: null, description: 'wifi router needs reset' });
  assert.ok(issue);
  const write = ctx.airtable.log.find(w => w.table === 'WS_Issues');
  assert.strictEqual(write.fields['Reported By Role'], 'Reception');
});

test('handleStaffIssueReport: an active WS_Cleaners record reports as Cleaner — WS_Roles has no seat for it', async () => {
  const ctx = setup({
    ...baseSeed,
    WS_Cleaners: [{ id: 'recCleaner1', fields: { 'Cleaner Name': 'Thabo', 'Phone Number': '27837654321', 'Active': true, 'Assigned Property': ['recVL'] } }]
  });
  const issue = await wh.handleStaffIssueReport({ phone: '27837654321', roomName: 'Room 01', description: 'mattress damaged' });
  assert.ok(issue, 'a cleaner must be able to report an issue — cleaners are not WS_Roles seats');
  const write = ctx.airtable.log.find(w => w.table === 'WS_Issues');
  assert.strictEqual(write.fields['Reported By Role'], 'Cleaner');
  assert.deepStrictEqual(write.fields['Linked Room'], ['recRoom1']);
});

test('handleStaffIssueReport: WALKIN authorization deliberately excludes cleaners from WS_Roles, but this function still finds them via WS_Cleaners', async () => {
  const ctx = setup({
    ...baseSeed,
    WS_Cleaners: [{ id: 'recCleaner1', fields: { 'Phone Number': '27837654321', 'Active': true, 'Assigned Property': ['recVL'] } }]
  });
  const walkinRole = await wh.activeCleanerForPhone('27837654321');
  assert.ok(walkinRole, 'sanity: the phone IS an active cleaner');
  const issue = await wh.handleStaffIssueReport({ phone: '27837654321', roomName: null, description: 'x' });
  assert.ok(issue);
});

test('handleStaffIssueReport: an unauthorized phone (neither WS_Roles nor WS_Cleaners) returns null, no write', async () => {
  const ctx = setup(baseSeed);
  const result = await wh.handleStaffIssueReport({ phone: '27899999999', roomName: null, description: 'x' });
  assert.strictEqual(result, null);
  assert.strictEqual(ctx.airtable.log.filter(w => w.table === 'WS_Issues').length, 0);
});

test('handleStaffIssueReport: a deactivated Reception seat is not authorized', async () => {
  const ctx = setup({
    ...baseSeed,
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Type': 'Reception', 'Property': ['recVL'], 'Current Phone': '27825999279', 'Active': false } }]
  });
  const result = await wh.handleStaffIssueReport({ phone: '27825999279', roomName: null, description: 'x' });
  assert.strictEqual(result, null);
});

test('handleStaffIssueReport: a deactivated cleaner is not authorized', async () => {
  const ctx = setup({
    ...baseSeed,
    WS_Cleaners: [{ id: 'recCleaner1', fields: { 'Phone Number': '27837654321', 'Active': false, 'Assigned Property': ['recVL'] } }]
  });
  const result = await wh.handleStaffIssueReport({ phone: '27837654321', roomName: null, description: 'x' });
  assert.strictEqual(result, null);
});

// ── activeCleanerForPhone ─────────────────────────────────────────────────────

test('activeCleanerForPhone: matches regardless of how the phone is formatted in Airtable', async () => {
  setup({
    ...baseSeed,
    WS_Cleaners: [{ id: 'recCleaner1', fields: { 'Phone Number': '0837654321', 'Active': true } }]
  });
  const cleaner = await wh.activeCleanerForPhone('27837654321');
  assert.ok(cleaner);
  assert.strictEqual(cleaner.id, 'recCleaner1');
});

test('activeCleanerForPhone: returns null for a phone with no active cleaner match', async () => {
  setup(baseSeed);
  const cleaner = await wh.activeCleanerForPhone('27837654321');
  assert.strictEqual(cleaner, null);
});
