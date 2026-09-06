'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { PersistentDciecmsService } = require('../../services/api/src/persistent-dciecms-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const actor = resolveActorFromClaims({ sub: 'reg-a', roles: ['REG'], court_ids: [COURT_A] });

function repository() {
  return {
    async createParty(input) {
      return Object.freeze({ ...input, createdAt: '2026-09-06T00:00:00.000Z' });
    }
  };
}

test('persistent service does not resolve a successful operation before its audit write resolves', async () => {
  let resolveAudit;
  const auditStore = {
    append() {
      return new Promise(resolve => { resolveAudit = resolve; });
    }
  };
  const service = new PersistentDciecmsService({ repository: repository(), auditStore });
  let settled = false;

  const operation = service.createParty(actor, { courtId: COURT_A, partyType: 'PERSON', displayName: 'Jane Doe' });
  operation.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, false, 'service must await audit persistence before returning success');
  resolveAudit({ auditEventId: 'audit-1' });
  const party = await operation;
  assert.equal(party.displayName, 'Jane Doe');
});

test('persistent service propagates a durable audit persistence failure', async () => {
  const failedWrite = Promise.reject(new Error('audit database unavailable'));
  failedWrite.catch(() => {});
  const auditStore = { append() { return failedWrite; } };
  const service = new PersistentDciecmsService({ repository: repository(), auditStore });

  await assert.rejects(
    () => service.createParty(actor, { courtId: COURT_A, partyType: 'PERSON', displayName: 'Jane Doe' }),
    /audit database unavailable/
  );
});
