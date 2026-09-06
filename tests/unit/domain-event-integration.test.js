'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { PersistentDciecmsService } = require('../../services/api/src/persistent-dciecms-service');
const { JudicialOperationsService } = require('../../services/api/src/judicial-operations-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const CASE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HEARING_A = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const reg = resolveActorFromClaims({ sub: 'reg-a', roles: ['REG'], court_ids: [COURT_A] });
const regMgr = resolveActorFromClaims({ sub: 'reg-mgr-a', roles: ['REG-MGR'], court_ids: [COURT_A] });
const finMgr = resolveActorFromClaims({ sub: 'fin-mgr-a', roles: ['FIN-MGR'], court_ids: [COURT_A] });
const mag = resolveActorFromClaims({ sub: 'mag-a', roles: ['MAG'], court_ids: [COURT_A] });

class RecordingOutboxStore {
  constructor() { this.events = []; }
  async enqueue(event) {
    const row = Object.freeze({ outboxEventId: `evt-${this.events.length + 1}`, ...event, status: 'PENDING' });
    this.events.push(row);
    return row;
  }
}

class FilingRepo {
  constructor() {
    this.filing = { filingId: 'f-1', filingReference: 'F-1', courtId: COURT_A, caseTypeCode: 'CIVIL', status: 'DRAFT' };
  }
  async getFiling(id) { return id === this.filing.filingId ? { ...this.filing } : null; }
  async submitFilingIdempotent({ submittedAt }) {
    this.filing = { ...this.filing, status: 'SUBMITTED', submittedAt };
    return { ...this.filing };
  }
}

test('filing submission enqueues one deterministic durable domain event', async () => {
  const outboxStore = new RecordingOutboxStore();
  const svc = new PersistentDciecmsService({ repository: new FilingRepo(), outboxStore });
  const submitted = await svc.submitFiling(reg, 'f-1', 'idem-1');
  assert.equal(submitted.status, 'SUBMITTED');
  assert.equal(outboxStore.events.length, 1);
  assert.deepEqual(outboxStore.events[0], Object.freeze({
    outboxEventId: 'evt-1',
    eventType: 'filing.submitted',
    aggregateType: 'filing',
    aggregateId: 'f-1',
    courtId: COURT_A,
    actorSubject: 'reg-a',
    correlationId: null,
    deduplicationKey: 'f-1:filing.submitted',
    payload: { filingId: 'f-1', courtId: COURT_A, status: 'SUBMITTED', filingReference: 'F-1' },
    headers: { schemaVersion: 1 },
    status: 'PENDING'
  }));
});

class PaymentRepo {
  constructor() {
    this.payment = { paymentId: 'p-1', assessmentId: 'a-1', courtId: COURT_A, status: 'PENDING', amountMinor: 12000, currency: 'PGK' };
  }
  async getPayment(id) { return id === 'p-1' ? { ...this.payment } : null; }
  async confirmPayment({ providerReference, actorSubject, at }) {
    this.payment = { ...this.payment, status: 'CONFIRMED', providerReference, confirmedBy: actorSubject, confirmedAt: at };
    return { ...this.payment };
  }
}

test('payment confirmation enqueues a durable domain event without provider secrets', async () => {
  const outboxStore = new RecordingOutboxStore();
  const svc = new PersistentDciecmsService({ repository: new PaymentRepo(), outboxStore });
  await svc.confirmPayment(finMgr, 'p-1', 'PGW-REFERENCE-1');
  assert.equal(outboxStore.events.length, 1);
  assert.equal(outboxStore.events[0].eventType, 'payment.confirmed');
  assert.equal(outboxStore.events[0].deduplicationKey, 'p-1:payment.confirmed');
  assert.deepEqual(outboxStore.events[0].payload, {
    paymentId: 'p-1', courtId: COURT_A, status: 'CONFIRMED', amountMinor: 12000, currency: 'PGK'
  });
  assert.equal(Object.hasOwn(outboxStore.events[0].payload, 'providerReference'), false);
});

class CaseRepo {
  constructor() {
    this.filing = { filingId: 'f-1', courtId: COURT_A, caseTypeCode: 'CIVIL', status: 'ACCEPTED' };
    this.payment = { paymentId: 'p-1', assessmentId: 'a-1', courtId: COURT_A, status: 'CONFIRMED' };
    this.assessment = { assessmentId: 'a-1', filingId: 'f-1', courtId: COURT_A };
  }
  async getFiling(id) { return id === 'f-1' ? { ...this.filing } : null; }
  async getCaseByFiling() { return null; }
  async getPayment(id) { return id === 'p-1' ? { ...this.payment } : null; }
  async getFeeAssessment(id) { return id === 'a-1' ? { ...this.assessment } : null; }
  async openCaseFromConfirmedPayment(input) {
    return { caseId: input.caseId, caseNumber: 'POM-CIVIL-2026-000001', filingId: input.filingId, paymentId: input.paymentId, courtId: input.courtId, caseTypeCode: input.caseTypeCode, status: 'AWAITING_ASSIGNMENT' };
  }
}

test('case opening enqueues the allocated case number as durable domain evidence', async () => {
  const outboxStore = new RecordingOutboxStore();
  const svc = new PersistentDciecmsService({ repository: new CaseRepo(), outboxStore });
  const opened = await svc.openCase(regMgr, 'f-1', 'p-1');
  assert.equal(outboxStore.events.length, 1);
  assert.equal(outboxStore.events[0].eventType, 'case.opened');
  assert.equal(outboxStore.events[0].aggregateId, opened.caseId);
  assert.equal(outboxStore.events[0].deduplicationKey, `${opened.caseId}:case.opened`);
  assert.deepEqual(outboxStore.events[0].payload, {
    caseId: opened.caseId,
    caseNumber: 'POM-CIVIL-2026-000001',
    filingId: 'f-1',
    paymentId: 'p-1',
    courtId: COURT_A,
    status: 'AWAITING_ASSIGNMENT'
  });
});

class HearingRepo {
  constructor() {
    this.case = { caseId: CASE_A, courtId: COURT_A, status: 'ASSIGNED', assignedToSubject: 'mag-a' };
    this.hearing = null;
  }
  async getCase(id) { return id === CASE_A ? { ...this.case } : null; }
  async getHearing(id) { return this.hearing && id === this.hearing.hearingId ? { ...this.hearing } : null; }
  async createHearing(input) {
    this.hearing = { hearingId: input.hearingId, caseId: input.caseId, courtId: input.courtId, hearingType: input.hearingType, status: 'SCHEDULED', scheduledStart: input.scheduledStart, scheduledEnd: input.scheduledEnd, courtroom: input.courtroom };
    return { ...this.hearing };
  }
  async adjournHearing({ reason, nextStart, nextEnd, actorSubject, at }) {
    this.hearing = { ...this.hearing, status: 'ADJOURNED', adjournmentReason: reason, nextStart, nextEnd, adjournedBy: actorSubject, adjournedAt: at };
    return { ...this.hearing };
  }
  async completeHearing({ outcomeCode, actorSubject, at }) {
    this.hearing = { ...this.hearing, status: 'COMPLETED', outcomeCode, completedBy: actorSubject, completedAt: at };
    return { ...this.hearing };
  }
}

const scheduleInput = { hearingType: 'MENTION', scheduledStart: '2026-09-07T09:00:00.000Z', scheduledEnd: '2026-09-07T09:30:00.000Z', courtroom: 'Courtroom 1' };

test('hearing schedule, adjournment and completion each enqueue their own durable transition event', async () => {
  const outboxStore = new RecordingOutboxStore();
  const repo = new HearingRepo();
  const svc = new JudicialOperationsService({ repository: repo, outboxStore });
  const scheduled = await svc.scheduleHearing(mag, CASE_A, scheduleInput);
  assert.equal(outboxStore.events[0].eventType, 'hearing.scheduled');
  assert.equal(outboxStore.events[0].deduplicationKey, `${scheduled.hearingId}:hearing.scheduled`);

  await svc.adjournHearing(mag, scheduled.hearingId, { reason: 'Witness unavailable' });
  assert.equal(outboxStore.events[1].eventType, 'hearing.adjourned');
  assert.equal(outboxStore.events[1].deduplicationKey, `${scheduled.hearingId}:hearing.adjourned`);

  repo.hearing.status = 'IN_PROGRESS';
  await svc.completeHearing(mag, scheduled.hearingId, { outcomeCode: 'DECISION_RESERVED' });
  assert.equal(outboxStore.events[2].eventType, 'hearing.completed');
  assert.equal(outboxStore.events[2].deduplicationKey, `${scheduled.hearingId}:hearing.completed`);
  assert.equal(outboxStore.events[2].payload.outcomeCode, 'DECISION_RESERVED');
});

class JudgmentRepo {
  constructor() {
    this.case = { caseId: CASE_A, courtId: COURT_A, status: 'ASSIGNED', assignedToSubject: 'mag-a' };
    this.judgment = { judgmentId: 'j-1', caseId: CASE_A, courtId: COURT_A, status: 'SIGNED' };
  }
  async getCase(id) { return id === CASE_A ? { ...this.case } : null; }
  async getJudgment(id) { return id === 'j-1' ? { ...this.judgment } : null; }
  async issueJudgment({ actorSubject, at }) {
    this.judgment = { ...this.judgment, status: 'ISSUED', issuedBy: actorSubject, issuedAt: at };
    return { ...this.judgment };
  }
}

test('judgment issuance enqueues a durable domain event', async () => {
  const outboxStore = new RecordingOutboxStore();
  const svc = new JudicialOperationsService({ repository: new JudgmentRepo(), outboxStore });
  const issued = await svc.issueJudgment(mag, 'j-1');
  assert.equal(issued.status, 'ISSUED');
  assert.equal(outboxStore.events.length, 1);
  assert.equal(outboxStore.events[0].eventType, 'judgment.issued');
  assert.equal(outboxStore.events[0].deduplicationKey, 'j-1:judgment.issued');
  assert.deepEqual(outboxStore.events[0].payload, { judgmentId: 'j-1', caseId: CASE_A, courtId: COURT_A, status: 'ISSUED' });
});
