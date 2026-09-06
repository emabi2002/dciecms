'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { PersistentDciecmsService } = require('../../services/api/src/persistent-dciecms-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const actor = resolveActorFromClaims({ sub: 'reg-a', roles: ['REG'], court_ids: [COURT_A] });

test('persistent service delegates replayable filing submission to durable repository before rejecting current SUBMITTED state', async () => {
  let durableCall = null;
  let legacyCalled = false;
  const stored = Object.freeze({
    filingId: 'f-1',
    filingReference: 'F-1',
    courtId: COURT_A,
    caseTypeCode: 'CIVIL',
    filerPartyId: 'p-1',
    status: 'SUBMITTED',
    createdBy: 'reg-a',
    createdAt: '2026-09-06T00:00:00.000Z',
    submittedAt: '2026-09-06T00:10:00.000Z'
  });
  const repository = {
    async getFiling() { return stored; },
    async submitFilingIdempotent(input) { durableCall = input; return stored; },
    async submitFilingAndCreateTask() { legacyCalled = true; throw new Error('legacy submission path must not run'); }
  };
  const service = new PersistentDciecmsService({ repository });

  const result = await service.submitFiling(actor, 'f-1', 'req-123');

  assert.equal(result, stored);
  assert.equal(legacyCalled, false);
  assert.ok(durableCall);
  assert.equal(durableCall.filingId, 'f-1');
  assert.equal(durableCall.actorSubject, 'reg-a');
  assert.equal(durableCall.idempotencyKey, 'req-123');
  assert.equal(typeof durableCall.taskId, 'string');
  assert.equal(typeof durableCall.submittedAt, 'string');
});
