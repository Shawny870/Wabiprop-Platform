// test/escalationcontacts.test.js
// Shift-routing/escalation PR 2 of 11 — role-tagged escalation contacts.
// Resolver only, no notification wiring (that's PR 5/6 onward). See the
// header comment above resolveEscalationChain in webhook.js for the CEO
// decisions this encodes: Manager reuses the existing live WS_Roles
// 'Manager' Role Type (shared with WALKIN); Owner is deliberately NOT a
// WS_Roles lookup, it stays sourced from Notify Phone / OWNER_PHONE, the
// single existing owner-contact mechanism everywhere else in the codebase.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function ctxWithRoles(roles) {
  const ctx = { airtable: new MockAirtable({ WS_Roles: roles }), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

function property(overrides) {
  return { id: 'recP1', fields: { 'Property Name': 'Test Lodge', ...overrides } };
}

test('all three WS_Roles tiers configured: chain is On Duty, Backup, Manager, then Owner from Notify Phone', async () => {
  ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27811110001', 'Active': true } },
    { id: 'recBackup', fields: { 'Role Type': 'Backup', 'Property': ['recP1'], 'Current Phone': '27811110002', 'Active': true } },
    { id: 'recManager', fields: { 'Role Type': 'Manager', 'Property': ['recP1'], 'Current Phone': '27811110003', 'Active': true } }
  ]);
  const chain = await wh.resolveEscalationChain('recP1', property({ 'Notify Phone': '27811110099' }));
  assert.deepStrictEqual(chain.map(c => c.tier), ['On Duty', 'Backup', 'Manager', 'Owner']);
  assert.strictEqual(chain.find(c => c.tier === 'On Duty').phone, '27811110001');
  assert.strictEqual(chain.find(c => c.tier === 'Backup').phone, '27811110002');
  assert.strictEqual(chain.find(c => c.tier === 'Manager').phone, '27811110003');
  assert.strictEqual(chain.find(c => c.tier === 'Owner').phone, '27811110099');
});

test('property has no Backup configured: chain skips it gracefully, no null placeholder, no throw', async () => {
  ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27811110001', 'Active': true } },
    { id: 'recManager', fields: { 'Role Type': 'Manager', 'Property': ['recP1'], 'Current Phone': '27811110003', 'Active': true } }
  ]);
  const chain = await wh.resolveEscalationChain('recP1', property({ 'Notify Phone': '27811110099' }));
  assert.deepStrictEqual(chain.map(c => c.tier), ['On Duty', 'Manager', 'Owner']);
});

test('property has no manager tier at all (small property, per investigation doc): chain still resolves, just shorter', async () => {
  ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27811110001', 'Active': true } }
  ]);
  const chain = await wh.resolveEscalationChain('recP1', property({ 'Notify Phone': '27811110099' }));
  assert.deepStrictEqual(chain.map(c => c.tier), ['On Duty', 'Owner']);
});

test('no WS_Roles tiers configured at all: chain is Owner only, sourced from Notify Phone', async () => {
  ctxWithRoles([]);
  const chain = await wh.resolveEscalationChain('recP1', property({ 'Notify Phone': '27811110099' }));
  assert.deepStrictEqual(chain, [{ tier: 'Owner', phone: '27811110099', roleId: null }]);
});

test('Notify Phone unset: Owner tier falls back to OWNER_PHONE env var, matching every other Notify Phone read site', async () => {
  ctxWithRoles([]);
  const chain = await wh.resolveEscalationChain('recP1', property({}));
  assert.deepStrictEqual(chain, [{ tier: 'Owner', phone: process.env.OWNER_PHONE, roleId: null }]);
});

test('an inactive WS_Roles seat is never included, even if it matches tier and property', async () => {
  ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27811110001', 'Active': false } }
  ]);
  const chain = await wh.resolveEscalationChain('recP1', property({ 'Notify Phone': '27811110099' }));
  assert.deepStrictEqual(chain.map(c => c.tier), ['Owner']);
});

test('a Reception seat is NEVER pulled into the escalation chain — the one real seam this WS_Roles reuse creates', async () => {
  ctxWithRoles([
    { id: 'recReception', fields: { 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': '27811119999', 'Active': true } }
  ]);
  const chain = await wh.resolveEscalationChain('recP1', property({ 'Notify Phone': '27811110099' }));
  assert.deepStrictEqual(chain.map(c => c.tier), ['Owner']);
  assert.ok(!chain.some(c => c.phone === '27811119999'), 'Reception seat phone must never appear in the escalation chain');
});

test('a Manager seat scoped to a DIFFERENT property is not pulled in — property scoping is real, not just tier scoping', async () => {
  ctxWithRoles([
    { id: 'recOtherManager', fields: { 'Role Type': 'Manager', 'Property': ['recOtherProp'], 'Current Phone': '27811118888', 'Active': true } }
  ]);
  const chain = await wh.resolveEscalationChain('recP1', property({ 'Notify Phone': '27811110099' }));
  assert.deepStrictEqual(chain.map(c => c.tier), ['Owner']);
});

test('Owner tier phone is never sourced from a WS_Roles "Owner" row, even when one exists for this property (CEO decision — single source of truth)', async () => {
  ctxWithRoles([
    // A live 'Owner' Role Type row DOES exist in WS_Roles (used by WALKIN) —
    // this must be ignored entirely by the escalation resolver.
    { id: 'recRolesOwner', fields: { 'Role Type': 'Owner', 'Property': ['recP1'], 'Current Phone': '27811117777', 'Active': true } }
  ]);
  const chain = await wh.resolveEscalationChain('recP1', property({ 'Notify Phone': '27811110099' }));
  const owner = chain.find(c => c.tier === 'Owner');
  assert.strictEqual(owner.phone, '27811110099', 'must come from Notify Phone, never the WS_Roles Owner row');
  assert.strictEqual(owner.roleId, null, 'Owner tier has no WS_Roles seat id — it is not a WS_Roles-sourced tier');
});

test('ESCALATION_TIER_ROLE_TYPES does not include Owner or Reception — the allowlist itself enforces the seam', () => {
  assert.deepStrictEqual(wh.ESCALATION_TIER_ROLE_TYPES, ['On Duty', 'Backup', 'Manager']);
});

test('activeEscalationRolesForProperty with no propertyId returns empty, does not throw', async () => {
  ctxWithRoles([]);
  const roles = await wh.activeEscalationRolesForProperty(null);
  assert.deepStrictEqual(roles, []);
});

// ── sendEscalationAlert (guest-struggle/monitoring build, sub-PR 2 of 4) ────
// The send capability resolveEscalationChain was always missing. No trigger
// wires to this yet — these tests call it directly, same as sub-PRs 3/4 will.
// Free-form fallback only, no WABISTAY_GUEST_ESCALATION_TEMPLATE configured
// in these — the template path is covered separately below.

test('sendEscalationAlert sends to Jill (On Duty) when he is active', async () => {
  delete process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE;
  const ctx = ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27825999001', 'Active': true } },
    { id: 'recBackup', fields: { 'Role Type': 'Backup', 'Property': ['recP1'], 'Current Phone': '27825999279', 'Active': true } }
  ]);
  const result = await wh.sendEscalationAlert('recP1', property({ 'Notify Phone': '27811110099' }), { message: 'A guest needs help.' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.tier, 'On Duty');
  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].to, '27825999001');
  assert.strictEqual(ctx.sends[0].type, 'text');
  assert.strictEqual(ctx.sends[0].body, 'A guest needs help.');
  assert.ok(ctx.axiom.some(e => e.event === 'escalation_alert_template_not_configured'),
    'the stub-state fallback is logged, not silent');
});

test('sendEscalationAlert falls to Backup (Reception) when Jill (On Duty) is inactive', async () => {
  delete process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE;
  const ctx = ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27825999001', 'Active': false } },
    { id: 'recBackup', fields: { 'Role Type': 'Backup', 'Property': ['recP1'], 'Current Phone': '27825999279', 'Active': true } }
  ]);
  const result = await wh.sendEscalationAlert('recP1', property({ 'Notify Phone': '27811110099' }), { message: 'A guest needs help.' });
  assert.strictEqual(result.tier, 'Backup');
  assert.strictEqual(ctx.sends[0].to, '27825999279');
});

test('sendEscalationAlert falls to Owner when On Duty and Backup are both inactive', async () => {
  delete process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE;
  const ctx = ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27825999001', 'Active': false } },
    { id: 'recBackup', fields: { 'Role Type': 'Backup', 'Property': ['recP1'], 'Current Phone': '27825999279', 'Active': false } }
  ]);
  const result = await wh.sendEscalationAlert('recP1', property({ 'Notify Phone': '27811110099' }), { message: 'A guest needs help.' });
  assert.strictEqual(result.tier, 'Owner');
  assert.strictEqual(ctx.sends[0].to, '27811110099');
});

test('sendEscalationAlert logs loud and returns ok:false when nobody at all is resolvable (no roles, no Notify Phone, no OWNER_PHONE)', async () => {
  // OWNER_PHONE is captured once as a module-level const at require time, so
  // unsetting process.env alone has no effect — a fresh require is needed.
  delete process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE;
  const savedOwnerPhone = process.env.OWNER_PHONE;
  delete process.env.OWNER_PHONE;
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  const freshWh = require('../api/wabistay/webhook.js');
  const ctx = ctxWithRoles([]);
  const result = await freshWh.sendEscalationAlert('recP1', property({}), { message: 'A guest needs help.' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.tier, null);
  assert.strictEqual(ctx.sends.length, 0);
  assert.ok(ctx.axiom.some(e => e.event === 'escalation_alert_no_recipient'));
  process.env.OWNER_PHONE = savedOwnerPhone;
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
});

test('sendEscalationAlert logs loud (non-fatal) when the free-form send itself fails', async () => {
  delete process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE;
  const ctx = ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27825999001', 'Active': true } }
  ]);
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('/messages') && String(opts.body || '').includes('A guest needs help.')) {
      return { status: 500, ok: false, json: async () => ({ error: { type: 'SERVER_ERROR', message: 'simulated' } }) };
    }
    return realFetch(url, opts);
  };
  const result = await wh.sendEscalationAlert('recP1', property({ 'Notify Phone': '27811110099' }), { message: 'A guest needs help.' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.tier, 'On Duty');
  assert.ok(ctx.axiom.some(e => e.event === 'escalation_alert_send_failed'));
  global.fetch = realFetch;
});

// ── sendEscalationAlert via the approved guest-escalation template ─────────
// Same reasoning as sub-PR 1's alertShawn fix, but more pressing here: staff
// only ever receive from the bot, they don't message it first in the normal
// course of their work, so assuming they're in-window is false far more
// often than true. These prove the template path is used once configured —
// not, and can't against this mock, that Meta's real 24h window behaves a
// particular way.

test('sendEscalationAlert sends the approved guest-escalation template once configured, with guest/step/last-input/time params', async () => {
  process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE = 'wabistay_guest_escalation';
  const ctx = ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27825999001', 'Active': true } }
  ]);
  const result = await wh.sendEscalationAlert(
    'recP1',
    property({ 'Property Name': 'Canary Street Guest Rooms', 'Notify Phone': '27811110099' }),
    { guestPhone: '27821234567', step: 'AWAITING_STAY_TYPE', lastInput: '5' }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].type, 'template');
  assert.strictEqual(ctx.sends[0].template, 'wabistay_guest_escalation');
  assert.deepStrictEqual(ctx.sends[0].params.slice(0, 4), ['27821234567', 'Canary Street Guest Rooms', 'AWAITING_STAY_TYPE', '5']);
  assert.ok(!Number.isNaN(Date.parse(ctx.sends[0].params[4])), 'the "time" param is a real timestamp');
  delete process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE;
});

test('sendEscalationAlert template params fall back to placeholders when guest info is missing', async () => {
  process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE = 'wabistay_guest_escalation';
  const ctx = ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27825999001', 'Active': true } }
  ]);
  await wh.sendEscalationAlert('recP1', property({ 'Notify Phone': '27811110099' }), {});
  assert.deepStrictEqual(ctx.sends[0].params.slice(0, 4), ['unknown', 'Test Lodge', 'unknown', 'N/A']);
  delete process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE;
});

test('sendEscalationAlert logs loud when the template send itself fails, still via the template path', async () => {
  process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE = 'wabistay_guest_escalation';
  const ctx = ctxWithRoles([
    { id: 'recOnDuty', fields: { 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': '27825999001', 'Active': true } }
  ]);
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('/messages') && String(opts.body || '').includes('wabistay_guest_escalation')) {
      return { status: 400, ok: false, json: async () => ({ error: { code: 132001, message: 'Template not approved' } }) };
    }
    return realFetch(url, opts);
  };
  const result = await wh.sendEscalationAlert('recP1', property({ 'Notify Phone': '27811110099' }), { guestPhone: '27821234567', step: 'AWAITING_DETAILS', lastInput: 'blah' });
  assert.strictEqual(result.ok, false);
  assert.ok(ctx.axiom.some(e => e.event === 'escalation_alert_send_failed'));
  global.fetch = realFetch;
  delete process.env.WABISTAY_GUEST_ESCALATION_TEMPLATE;
});
