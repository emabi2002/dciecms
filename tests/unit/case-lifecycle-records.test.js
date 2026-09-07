'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { hasPermission, AccessDeniedError } = require('../../packages/rbac');
const { ConflictError, ValidationError } = require('../../services/api/src/dciecms-service');

let CaseLifecycleRecordsService;
try {
  ({ CaseLifecycleRecordsService } = require('../../services/api/src/case-lifecycle-records-service'));
} catch {
  CaseLifecycleRecordsService = undefined;
}

function actor(role, userId = `${role.toLowerCase()}-1`, courtIds = ['COURT-A']) {
  return {
    userId,
    roles: [role],
    courtIds,
    explicitGrants: []
  };
}

function baseCase(overrides = {}) {
  return {
    caseId: 'case-1',
    caseNumber: 'POM-CIVIL-2026-000001',
    filingId: 'filing-1',
    paymentId: 'pay-1',
    courtId: 'COURT-A',
    caseTypeCode: 'CIVIL',
    status: 'ASSIGNED',
    assignedToSubject: 'mag-1',
    ...overrides
  };
}

function makeHarness(repositoryOverrides = {}) {
  assert.equal(typeof CaseLifecycleRecordsService, 'function', 'case lifecycle records service must exist');
  const auditEvents = [];
  const outboxEvents = [];
  const repository = {
    async getCase() { return baseCase(); },
    async hasActiveCaseHearing() { return false; },
    async getIssuedJudgmentForCase() { return { judgmentId: 'judgment-1', caseId: 'case-1', status: 'ISSUED' }; },
    async disposeCase(input) { return { ...baseCase(), status: 'DISPOSED', dispositionCode: input.dispositionCode }; },
    async closeCase(input) { return { ...baseCase(), status: 'CLOSED', closureCode: input.closureCode }; },
    async reopenCase() { return { ...baseCase(), status: 'AWAITING_ASSIGNMENT', assignedToSubject: null }; },
    async getCaseRecordControl() {
      return {
        caseRecordControlId: 'record-1',
        caseId: 'case-1',
        courtId: 'COURT-A',
        status: 'ARCHIVED',
        legalHold: false,
        dispositionEligibleAt: '2033-09-01T00:00:00.000Z'
      };
    },
    async assignRetention(input) {
      return {
        caseRecordControlId: 'record-1', caseId: input.caseId, courtId: 'COURT-A', status: 'ACTIVE', legalHold: false,
        retentionClassCode: input.retentionClassCode,
        retentionTriggerAt: input.retentionTriggerAt,
        dispositionEligibleAt: input.dispositionEligibleAt
      };
    },
    async archiveCaseRecord() { return { caseRecordControlId: 'record-1', caseId: 'case-1', courtId: 'COURT-A', status: 'ARCHIVED', legalHold: false }; },
    async setCaseLegalHold(input) { return { caseRecordControlId: 'record-1', caseId: input.caseId, courtId: 'COURT-A', status: 'ARCHIVED', legalHold: true, legalHoldReference: input.reference }; },
    async releaseCaseLegalHold(input) { return { caseRecordControlId: 'record-1', caseId: input.caseId, courtId: 'COURT-A', status: 'ARCHIVED', legalHold: false }; },
    async hasDocumentLegalHold() { return false; },
    async createDisposalRequest(input) {
      return { disposalRequestId: input.disposalRequestId, caseRecordControlId: 'record-1', caseId: input.caseId, courtId: 'COURT-A', status: 'REQUESTED', requestedBy: input.actorSubject };
    },
    async getDisposalRequest() { return { disposalRequestId: 'dr-1', caseRecordControlId: 'record-1', caseId: 'case-1', courtId: 'COURT-A', status: 'REQUESTED', requestedBy: 'records-1' }; },
    async approveDisposalRequest(input) { return { disposalRequestId: input.disposalRequestId, caseRecordControlId: 'record-1', caseId: 'case-1', courtId: 'COURT-A', status: 'APPROVED', requestedBy: 'records-1', decidedBy: input.actorSubject }; },
    async rejectDisposalRequest(input) { return { disposalRequestId: input.disposalRequestId, caseRecordControlId: 'record-1', caseId: 'case-1', courtId: 'COURT-A', status: 'REJECTED', requestedBy: 'records-1', decidedBy: input.actorSubject }; },
    ...repositoryOverrides
  };
  const auditStore = {
    async append(event) { auditEvents.push(event); return event; }
  };
  const outboxStore = {
    async enqueue(event) { outboxEvents.push(event); return event; }
  };
  const service = new CaseLifecycleRecordsService({
    repository,
    auditStore,
    outboxStore,
    clock: () => new Date('2033-09-07T00:00:00.000Z'),
    uuid: () => 'dr-generated'
  });
  return { service, repository, auditEvents, outboxEvents };
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

test('service module exposes CaseLifecycleRecordsService', () => {
  assert.equal(typeof CaseLifecycleRecordsService, 'function');
});

test('assigned magistrate may dispose a case and generic outbox excludes free-text reason', async () => {
  const { service, auditEvents, outboxEvents } = makeHarness();
  const result = await service.disposeCase(actor('MAG', 'mag-1'), 'case-1', {
    dispositionCode: 'FINAL_JUDGMENT',
    judgmentId: 'judgment-1',
    reason: 'Sensitive judicial disposition narrative'
  });
  assert.equal(result.status, 'DISPOSED');
  assert.equal(auditEvents.at(-1).action, 'case.dispose');
  assert.equal(outboxEvents.at(-1).eventType, 'case.disposed');
  assert.equal(JSON.stringify(outboxEvents.at(-1)).includes('Sensitive judicial disposition narrative'), false);
});

test('unassigned magistrate and active hearing cannot be bypassed for disposition', async () => {
  const unassigned = makeHarness();
  await assert.rejects(
    () => unassigned.service.disposeCase(actor('MAG', 'mag-2'), 'case-1', { dispositionCode: 'FINAL_ORDER', reason: 'Final order' }),
    AccessDeniedError
  );

  const active = makeHarness({ async hasActiveCaseHearing() { return true; } });
  await assert.rejects(
    () => active.service.disposeCase(actor('MAG', 'mag-1'), 'case-1', { dispositionCode: 'FINAL_ORDER', reason: 'Final order' }),
    ConflictError
  );
});

test('a supplied judgment must be an issued judgment for the same case', async () => {
  const { service } = makeHarness({ async getIssuedJudgmentForCase() { return null; } });
  await assert.rejects(
    () => service.disposeCase(actor('MAG', 'mag-1'), 'case-1', { dispositionCode: 'FINAL_JUDGMENT', judgmentId: 'judgment-other', reason: 'Final judgment' }),
    ValidationError
  );
});

test('close and reopen enforce controlled lifecycle transitions and emit minimized events', async () => {
  const harness = makeHarness({
    async getCase() { return baseCase({ status: 'DISPOSED' }); },
    async closeCase(input) { return baseCase({ status: 'CLOSED', closureCode: input.closureCode }); }
  });
  const closed = await harness.service.closeCase(actor('CMAG', 'cmag-1'), 'case-1', { closureCode: 'FINALIZED', reason: 'Administrative closure narrative' });
  assert.equal(closed.status, 'CLOSED');
  assert.equal(harness.outboxEvents.at(-1).eventType, 'case.closed');
  assert.equal(JSON.stringify(harness.outboxEvents.at(-1)).includes('Administrative closure narrative'), false);

  harness.repository.getCase = async () => baseCase({ status: 'CLOSED' });
  const reopened = await harness.service.reopenCase(actor('REG-MGR', 'reg-mgr-1'), 'case-1', { reason: 'Appeal/review requires reopening' });
  assert.equal(reopened.status, 'AWAITING_ASSIGNMENT');
  assert.equal(harness.outboxEvents.at(-1).eventType, 'case.reopened');
  assert.equal(JSON.stringify(harness.outboxEvents.at(-1)).includes('Appeal/review requires reopening'), false);
});

test('records retention validates dates before persistence and archives only through records permission', async () => {
  const { service } = makeHarness({ async getCase() { return baseCase({ status: 'CLOSED' }); } });
  await assert.rejects(
    () => service.assignRetention(actor('RECORDS', 'records-1'), 'case-1', {
      retentionClassCode: 'CIVIL-7Y',
      retentionTriggerAt: '2033-09-01T00:00:00.000Z',
      dispositionEligibleAt: '2032-09-01T00:00:00.000Z'
    }),
    ValidationError
  );

  const retained = await service.assignRetention(actor('RECORDS', 'records-1'), 'case-1', {
    retentionClassCode: 'CIVIL-7Y',
    retentionTriggerAt: '2026-09-01T00:00:00.000Z',
    dispositionEligibleAt: '2033-09-01T00:00:00.000Z'
  });
  assert.equal(retained.retentionClassCode, 'CIVIL-7Y');
  const archived = await service.archiveCaseRecord(actor('RECORDS', 'records-1'), 'case-1');
  assert.equal(archived.status, 'ARCHIVED');
});

test('document legal hold vetoes disposal request and maker cannot approve own request', async () => {
  const held = makeHarness({
    async getCase() { return baseCase({ status: 'CLOSED' }); },
    async hasDocumentLegalHold() { return true; }
  });
  await assert.rejects(
    () => held.service.requestCaseRecordDisposal(actor('RECORDS', 'records-1'), 'case-1', { reason: 'Retention expired' }),
    ConflictError
  );

  const makerChecker = makeHarness({ async getCase() { return baseCase({ status: 'CLOSED' }); } });
  await assert.rejects(
    () => makerChecker.service.approveCaseRecordDisposal(actor('CMAG', 'records-1'), 'dr-1', { reason: 'Approve' }),
    ConflictError
  );
});

test('case legal hold requires a reference and reason and never publishes narrative to outbox', async () => {
  const { service, outboxEvents } = makeHarness({ async getCase() { return baseCase({ status: 'CLOSED' }); } });
  await assert.rejects(
    () => service.setCaseLegalHold(actor('RECORDS', 'records-1'), 'case-1', { reference: '', reason: 'Litigation hold' }),
    ValidationError
  );
  const held = await service.setCaseLegalHold(actor('RECORDS', 'records-1'), 'case-1', { reference: 'HOLD-2026-1', reason: 'Confidential legal hold narrative' });
  assert.equal(held.legalHold, true);
  assert.equal(outboxEvents.some(event => JSON.stringify(event).includes('Confidential legal hold narrative')), false);
});
