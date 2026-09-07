'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { hasPermission } = require('../../packages/rbac');

function actor(role){ return resolveActorFromClaims({ sub:`${role.toLowerCase()}-a`, roles:[role], court_ids:['COURT-A'] }); }

const fin = actor('FIN');
const mgr = actor('FIN-MGR');
const sec = actor('SEC-ADMIN');
const ict = actor('ICT-ADMIN');

test('FIN receives request/view finance-completion permissions but not approval/completion authority', () => {
  for (const permission of ['finance.adjustment.request','finance.refund.request','finance.refund.view','finance.reconciliation.exception.view']) {
    assert.equal(hasPermission(fin, permission), true, permission);
  }
  for (const permission of ['finance.fee_schedule.manage','finance.adjustment.approve','finance.refund.approve','finance.refund.complete','finance.reconciliation.reject']) {
    assert.equal(hasPermission(fin, permission), false, permission);
  }
});

test('FIN-MGR receives governed finance-completion manager permissions', () => {
  for (const permission of ['finance.fee_schedule.manage','finance.adjustment.request','finance.adjustment.approve','finance.refund.request','finance.refund.approve','finance.refund.complete','finance.refund.view','finance.reconciliation.reject','finance.reconciliation.exception.view']) {
    assert.equal(hasPermission(mgr, permission), true, permission);
  }
});

test('security and ICT administrators gain no implicit finance authority', () => {
  const sensitive = ['finance.fee_schedule.manage','finance.adjustment.request','finance.adjustment.approve','finance.refund.request','finance.refund.approve','finance.refund.complete','finance.reconciliation.reject'];
  for (const permission of sensitive) {
    assert.equal(hasPermission(sec, permission), false, `SEC-ADMIN ${permission}`);
    assert.equal(hasPermission(ict, permission), false, `ICT-ADMIN ${permission}`);
  }
});
