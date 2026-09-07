'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CaseLifecycleRecordsService } = require('../../services/api/src/case-lifecycle-records-service');

const CASE_ID = 'case-1';
const COURT_ID = 'COURT-A';

function actor(role, userId) {
  return { userId, roles: [role], courtIds: [COURT_ID], explicitGrants: [] };
}

function courtCase(status, assignedToSubject = 'mag-1') {
  return {
    caseId: CASE_ID,
    caseNumber: 'POM-CIVIL-2026-000001',
    filingId: 'filing-1',
    paymentId: 'payment-1',
    courtId: COURT_ID,
    caseTypeCode: 'CIVIL',
    status,
    assignedToSubject
  };
}

function serviceFor({ status, at }) {
  const outbox = [];
  const repository = {
    async getCase() { return courtCase(status); },
    async hasActiveCaseHearing() { return false; },
    async disposeCase(input) { return { ...courtCase('DISPOSED'), dispositionCode: input.dispositionCode, disposedAt: input.at }; },
    async closeCase(input) { return { ...courtCase('CLOSED'), closureCode: input.closureCode, closedAt: input.at }; },
    async reopenCase(input) { return { ...courtCase('AWAITING_ASSIGNMENT', null), reopenedAt: input.at }; }
  };
  const service = new CaseLifecycleRecordsService({
    repository,
    auditStore: { async append(event) { return event; } },
    outboxStore: { async enqueue(event) { outbox.push(event); return event; } },
    clock: () => new Date(at)
  });
  return { service, outbox };
}

async function lifecycleKey(operation, at) {
  if (operation === 'disposeCase') {
    const { service, outbox } = serviceFor({ status: 'ASSIGNED', at });
    await service.disposeCase(actor('MAG', 'mag-1'), CASE_ID, {
      dispositionCode: 'FINAL_ORDER',
      reason: 'Final order'
    });
    return outbox[0].deduplicationKey;
  }

  if (operation === 'closeCase') {
    const { service, outbox } = serviceFor({ status: 'DISPOSED', at });
    await service.closeCase(actor('CMAG', 'cmag-1'), CASE_ID, {
      closureCode: 'FINALIZED',
      reason: 'Administrative closure'
    });
    return outbox[0].deduplicationKey;
  }

  const { service, outbox } = serviceFor({ status: 'CLOSED', at });
  await service.reopenCase(actor('REG-MGR', 'reg-mgr-1'), CASE_ID, {
    reason: 'Reopened for review'
  });
  return outbox[0].deduplicationKey;
}

for (const operation of ['disposeCase', 'closeCase', 'reopenCase']) {
  test(`${operation} emits a distinct deduplication key for each legitimate lifecycle cycle`, async () => {
    const first = await lifecycleKey(operation, '2033-09-07T00:00:00.000Z');
    const second = await lifecycleKey(operation, '2034-09-07T00:00:00.000Z');
    assert.notEqual(first, second, 'repeatable lifecycle transitions must not collapse into one outbox event');
    assert.match(first, /2033-09-07T00:00:00\.000Z$/);
    assert.match(second, /2034-09-07T00:00:00\.000Z$/);
  });
}
