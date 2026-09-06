'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { JudicialOperationsService } = require('../../services/api/src/judicial-operations-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const COURT_B = '22222222-2222-2222-2222-222222222222';
const CASE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const cmag = resolveActorFromClaims({ sub: 'cmag-a', roles: ['CMAG'], court_ids: [COURT_A] });
const mag = resolveActorFromClaims({ sub: 'mag-a', roles: ['MAG'], court_ids: [COURT_A] });
const magB = resolveActorFromClaims({ sub: 'mag-b', roles: ['MAG'], court_ids: [COURT_B] });

class JudicialRepository {
  constructor() {
    this.case = {
      caseId: CASE_A,
      caseNumber: 'POM-CIVIL-2026-000001',
      courtId: COURT_A,
      caseTypeCode: 'CIVIL',
      status: 'OPEN',
      assignedToSubject: null,
      assignedBySubject: null,
      assignedAt: null
    };
    this.magistrates = new Set([`${COURT_A}:mag-a`, `${COURT_B}:mag-b`]);
  }
  async getCase(caseId) { return caseId === CASE_A ? Object.freeze({ ...this.case }) : null; }
  async isActiveMagistrateInCourt(subject, courtId) { return this.magistrates.has(`${courtId}:${subject}`); }
  async assignCase({ caseId, assigneeSubject, actorSubject, assignedAt }) {
    if (caseId !== CASE_A || this.case.assignedToSubject) {
      const error = new Error('Case assignment state conflict');
      error.code = 'CASE_ASSIGNMENT_CONFLICT';
      throw error;
    }
    this.case.assignedToSubject = assigneeSubject;
    this.case.assignedBySubject = actorSubject;
    this.case.assignedAt = assignedAt;
    this.case.status = 'ASSIGNED';
    return Object.freeze({ ...this.case });
  }
  async listAssignedCases({ courtIds, assigneeSubject }) {
    if (courtIds.includes(this.case.courtId) && this.case.assignedToSubject === assigneeSubject) {
      return [Object.freeze({ ...this.case })];
    }
    return [];
  }
}

test('CMAG assigns an open case to an active magistrate in the same court', async () => {
  const svc = new JudicialOperationsService({ repository: new JudicialRepository() });
  const assigned = await svc.assignCase(cmag, CASE_A, { assigneeSubject: 'mag-a' });
  assert.equal(assigned.status, 'ASSIGNED');
  assert.equal(assigned.assignedToSubject, 'mag-a');
  assert.equal(assigned.assignedBySubject, 'cmag-a');
});

test('MAG cannot assign a case', async () => {
  const svc = new JudicialOperationsService({ repository: new JudicialRepository() });
  await assert.rejects(() => svc.assignCase(mag, CASE_A, { assigneeSubject: 'mag-a' }), /Permission denied|case.assign/i);
});

test('CMAG cannot assign a case to a magistrate outside the case court', async () => {
  const svc = new JudicialOperationsService({ repository: new JudicialRepository() });
  await assert.rejects(() => svc.assignCase(cmag, CASE_A, { assigneeSubject: magB.userId }), /magistrate|court/i);
});

test('stale or duplicate case assignment returns a conflict instead of overwriting responsibility', async () => {
  const svc = new JudicialOperationsService({ repository: new JudicialRepository() });
  await svc.assignCase(cmag, CASE_A, { assigneeSubject: 'mag-a' });
  await assert.rejects(() => svc.assignCase(cmag, CASE_A, { assigneeSubject: 'mag-a' }), /conflict|assigned/i);
});

test('MAG judicial work queue contains only cases assigned to that magistrate', async () => {
  const repo = new JudicialRepository();
  const svc = new JudicialOperationsService({ repository: repo });
  await svc.assignCase(cmag, CASE_A, { assigneeSubject: 'mag-a' });
  const mine = await svc.listMyCases(mag);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].caseId, CASE_A);
  assert.equal(mine[0].assignedToSubject, 'mag-a');
  const otherCourt = await svc.listMyCases(magB);
  assert.equal(otherCourt.length, 0);
});