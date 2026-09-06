'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresAuditStore } = require('../../services/api/src/postgres-audit-store');

class FakeQueryable {
  constructor(responses = []) { this.responses = [...responses]; this.calls = []; }
  async query(text, params = []) {
    this.calls.push({ text, params });
    return this.responses.shift() || { rows: [] };
  }
}

test('PostgresAuditStore validates and appends actor-subject audit evidence with parameterized SQL', async () => {
  const db = new FakeQueryable();
  const audit = new PostgresAuditStore(db);

  await assert.rejects(() => audit.append({ action: 'case.open', resourceType: 'case' }), /actorUserId/i);
  await assert.rejects(() => audit.append({ actorUserId: 'reg-a', resourceType: 'case' }), /action/i);
  await assert.rejects(() => audit.append({ actorUserId: 'reg-a', action: 'case.open' }), /resourceType/i);

  const record = await audit.append({
    actorUserId: 'reg-a',
    effectiveRoles: ['REG'],
    action: 'case.open',
    resourceType: 'case',
    resourceId: 'case-1',
    courtId: '11111111-1111-1111-1111-111111111111',
    correlationId: 'corr-1',
    reason: 'accepted filing',
    approvalReference: 'APR-1',
    details: { filingId: 'f-1' }
  });

  assert.equal(Object.isFrozen(record), true);
  assert.equal(record.actorUserId, 'reg-a');
  assert.equal(record.action, 'case.open');
  assert.equal(record.details.filingId, 'f-1');
  assert.match(db.calls[0].text, /INSERT INTO audit\.audit_events/i);
  assert.match(db.calls[0].text, /actor_subject/i);
  assert.equal(db.calls[0].text.includes('reg-a'), false);
  assert.equal(db.calls[0].params.includes('reg-a'), true);
});

test('PostgresAuditStore lists exact-match audit evidence through parameterized predicates', async () => {
  const db = new FakeQueryable([{ rows: [{
    audit_event_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    event_time: '2026-09-06T00:00:00.000Z',
    actor_subject: 'reg-a',
    effective_roles: ['REG'],
    action: 'case.open',
    resource_type: 'case',
    resource_id: 'case-1',
    court_id: '11111111-1111-1111-1111-111111111111',
    correlation_id: 'corr-1',
    reason: null,
    approval_reference: null,
    details: { filingId: 'f-1' }
  }] }]);
  const audit = new PostgresAuditStore(db);

  const rows = await audit.list({
    actorUserId: 'reg-a',
    action: 'case.open',
    resourceType: 'case',
    resourceId: 'case-1',
    courtId: '11111111-1111-1111-1111-111111111111'
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorUserId, 'reg-a');
  assert.equal(rows[0].resourceId, 'case-1');
  assert.deepEqual(rows[0].effectiveRoles, ['REG']);
  assert.match(db.calls[0].text, /FROM audit\.audit_events/i);
  assert.match(db.calls[0].text, /actor_subject=\$1/i);
  assert.match(db.calls[0].text, /action=\$2/i);
  assert.match(db.calls[0].text, /resource_type=\$3/i);
  assert.match(db.calls[0].text, /resource_id=\$4/i);
  assert.match(db.calls[0].text, /court_id=\$5/i);
  assert.deepEqual(db.calls[0].params, ['reg-a', 'case.open', 'case', 'case-1', '11111111-1111-1111-1111-111111111111']);
});
