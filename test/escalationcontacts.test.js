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
