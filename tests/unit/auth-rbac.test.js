const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveActorFromClaims } = require('../../packages/auth');
const { authorize, AccessDeniedError } = require('../../packages/rbac');

test('resolveActorFromClaims rejects claims without a subject', () => {
  assert.throws(() => resolveActorFromClaims({ roles: ['REG'] }), /subject/i);
});

test('resolveActorFromClaims normalizes roles and court scopes', () => {
  const actor = resolveActorFromClaims({ sub: 'u-1', roles: ['reg', 'REG'], court_ids: ['COURT-A', 'COURT-A'] });
  assert.deepEqual(actor.roles, ['REG']);
  assert.deepEqual(actor.courtIds, ['COURT-A']);
});

test('authorize denies permission that role does not have', () => {
  const actor = resolveActorFromClaims({ sub: 'u-1', roles: ['ICT-ADMIN'], court_ids: ['COURT-A'] });
  assert.throws(() => authorize(actor, 'filing.view', { courtId: 'COURT-A' }), AccessDeniedError);
});

test('authorize denies an otherwise permitted role outside court scope', () => {
  const actor = resolveActorFromClaims({ sub: 'u-1', roles: ['REG'], court_ids: ['COURT-A'] });
  assert.throws(() => authorize(actor, 'filing.view', { courtId: 'COURT-B' }), /court scope/i);
});

test('explicit grant can authorize restricted resource only when base permission exists', () => {
  const actor = resolveActorFromClaims({ sub: 'u-1', roles: ['REG'], court_ids: ['COURT-A'], explicit_grants: ['case:CASE-9'] });
  assert.equal(authorize(actor, 'filing.view', { courtId: 'COURT-A', explicitGrant: 'case:CASE-9' }), true);
  assert.throws(() => authorize(actor, 'judgment.sign', { courtId: 'COURT-A', explicitGrant: 'case:CASE-9' }), AccessDeniedError);
});
