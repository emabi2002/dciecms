'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasPermission } = require('../../packages/rbac');

function actor(role) {
  return { roles:[role], courtIds:['COURT-A'], explicitGrants:[] };
}

test('REG can create/view notifications and create/view/complete follow-ups but cannot manage templates or escalate', () => {
  const reg = actor('REG');
  for (const permission of ['notification.view','notification.create','followup.view','followup.create','followup.complete']) {
    assert.equal(hasPermission(reg, permission), true, permission);
  }
  for (const permission of ['notification.template.manage','followup.cancel','followup.escalate']) {
    assert.equal(hasPermission(reg, permission), false, permission);
  }
});

test('REG-MGR receives governed template, cancel and escalation authorities', () => {
  const manager = actor('REG-MGR');
  for (const permission of [
    'notification.view','notification.create','notification.template.manage',
    'followup.view','followup.create','followup.complete','followup.cancel','followup.escalate'
  ]) assert.equal(hasPermission(manager, permission), true, permission);
});

test('CMAG can govern notifications and follow-up work', () => {
  const cmag = actor('CMAG');
  for (const permission of [
    'notification.view','notification.create',
    'followup.view','followup.create','followup.complete','followup.cancel','followup.escalate'
  ]) assert.equal(hasPermission(cmag, permission), true, permission);
  assert.equal(hasPermission(cmag, 'notification.template.manage'), false);
});

test('MAG receives view and completion authority only; assignment is enforced by service', () => {
  const mag = actor('MAG');
  assert.equal(hasPermission(mag,'notification.view'), true);
  assert.equal(hasPermission(mag,'followup.view'), true);
  assert.equal(hasPermission(mag,'followup.complete'), true);
  for (const permission of ['notification.create','notification.template.manage','followup.create','followup.cancel','followup.escalate']) {
    assert.equal(hasPermission(mag, permission), false, permission);
  }
});

test('administrative, records and standalone finance roles gain no implicit content/follow-up authority', () => {
  for (const role of ['ICT-ADMIN','SEC-ADMIN','RECORDS','FIN','FIN-MGR']) {
    for (const permission of [
      'notification.view','notification.create','notification.template.manage',
      'followup.view','followup.create','followup.complete','followup.cancel','followup.escalate'
    ]) assert.equal(hasPermission(actor(role), permission), false, `${role}:${permission}`);
  }
});
