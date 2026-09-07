const test = require('node:test');
const assert = require('node:assert/strict');

const { hasPermission } = require('../../packages/rbac');

function actor(role) {
  return {
    userId: `${role.toLowerCase()}-1`,
    roles: [role],
    courtIds: ['COURT-A'],
    explicitGrants: []
  };
}

test('MAG may record disposition but cannot close, reopen or administer records', () => {
  assert.equal(hasPermission(actor('MAG'), 'case.disposition'), true);
  assert.equal(hasPermission(actor('MAG'), 'case.close'), false);
  assert.equal(hasPermission(actor('MAG'), 'case.reopen'), false);
  assert.equal(hasPermission(actor('MAG'), 'records.archive'), false);
});

test('CMAG may supervise disposition, close/reopen and approve disposal', () => {
  const user = actor('CMAG');
  assert.equal(hasPermission(user, 'case.disposition'), true);
  assert.equal(hasPermission(user, 'case.close'), true);
  assert.equal(hasPermission(user, 'case.reopen'), true);
  assert.equal(hasPermission(user, 'records.view'), true);
  assert.equal(hasPermission(user, 'records.disposal.approve'), true);
});

test('REG-MGR may close/reopen and approve disposal but cannot make judicial disposition', () => {
  const user = actor('REG-MGR');
  assert.equal(hasPermission(user, 'case.close'), true);
  assert.equal(hasPermission(user, 'case.reopen'), true);
  assert.equal(hasPermission(user, 'records.view'), true);
  assert.equal(hasPermission(user, 'records.disposal.approve'), true);
  assert.equal(hasPermission(user, 'case.disposition'), false);
});

test('RECORDS role is records-governance only and cannot exercise judicial powers', () => {
  const user = actor('RECORDS');
  for (const permission of [
    'case.view',
    'records.view',
    'records.retention.assign',
    'records.archive',
    'records.legal_hold.manage',
    'records.disposal.request'
  ]) {
    assert.equal(hasPermission(user, permission), true, `expected RECORDS permission ${permission}`);
  }

  for (const permission of [
    'case.disposition',
    'case.close',
    'case.reopen',
    'records.disposal.approve',
    'judgment.create',
    'judgment.issue',
    'hearing.schedule',
    'document.view'
  ]) {
    assert.equal(hasPermission(user, permission), false, `unexpected RECORDS permission ${permission}`);
  }
});
