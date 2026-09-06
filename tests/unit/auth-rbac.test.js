const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveActorFromClaims,
  resolveActorFromVerifiedClaims,
  AuthenticationError
} = require('../../packages/auth');
const { authorize, AccessDeniedError } = require('../../packages/rbac');

test('resolveActorFromClaims rejects claims without a subject', () => {
  assert.throws(() => resolveActorFromClaims({ roles: ['REG'] }), /subject/i);
});

test('resolveActorFromClaims normalizes roles and court scopes', () => {
  const actor = resolveActorFromClaims({ sub: 'u-1', roles: ['reg', 'REG'], court_ids: ['COURT-A', 'COURT-A'] });
  assert.deepEqual(actor.roles, ['REG']);
  assert.deepEqual(actor.courtIds, ['COURT-A']);
});

test('verified claims require a non-empty string subject', () => {
  assert.throws(() => resolveActorFromVerifiedClaims({ sub: 123, roles: [] }), AuthenticationError);
  assert.throws(() => resolveActorFromVerifiedClaims({ sub: '   ', roles: [] }), AuthenticationError);
});

test('verified authorization claims must be arrays of non-empty strings', () => {
  for (const [name, value] of [
    ['roles', 'REG'],
    ['court_ids', [123]],
    ['explicit_grants', ['']]
  ]) {
    assert.throws(
      () => resolveActorFromVerifiedClaims({ sub: 'u-1', [name]: value }),
      AuthenticationError
    );
  }
});

test('verified claims preserve canonical actor normalization', () => {
  const actor = resolveActorFromVerifiedClaims({
    sub: 'u-1',
    roles: ['reg', 'REG'],
    court_ids: ['COURT-A', 'COURT-A'],
    explicit_grants: ['case:CASE-9', 'case:CASE-9']
  });
  assert.deepEqual(actor, {
    userId: 'u-1',
    roles: ['REG'],
    courtIds: ['COURT-A'],
    explicitGrants: ['case:CASE-9']
  });
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
