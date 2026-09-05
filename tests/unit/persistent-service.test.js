'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { PersistentDciecmsService } = require('../../services/api/src/persistent-dciecms-service');

const reg = resolveActorFromClaims({ sub: 'reg-a', roles: ['REG'], court_ids: ['11111111-1111-1111-1111-111111111111'] });
const mgr = resolveActorFromClaims({ sub: 'mgr-a', roles: ['REG-MGR'], court_ids: ['11111111-1111-1111-1111-111111111111'] });

class FakeRepository {
  constructor() {
    this.parties = new Map();
    this.filings = new Map();
    this.tasks = new Map();
  }
  async createParty(input) {
    const row = Object.freeze({ ...input, createdAt: new Date().toISOString() });
    this.parties.set(row.partyId, row);
    return row;
  }
  async getParty(partyId) { return this.parties.get(partyId) || null; }
  async isCaseTypeActive(code) { return ['CIVIL', 'CRIMINAL'].includes(code); }
  async createFilingDraft(input) {
    const row = { ...input, status: 'DRAFT', createdAt: new Date().toISOString(), submittedAt: null, validatedAt: null, validatedBy: null };
    this.filings.set(row.filingId, row);
    return Object.freeze({ ...row });
  }
  async getFiling(filingId) {
    const row = this.filings.get(filingId);
    return row ? Object.freeze({ ...row }) : null;
  }
  async submitFilingAndCreateTask({ filingId, taskId, actorSubject, submittedAt }) {
    const filing = this.filings.get(filingId);
    if (!filing || filing.status !== 'DRAFT') { const e = new Error('bad state'); e.code='FILING_STATE_CONFLICT'; throw e; }
    filing.status = 'SUBMITTED'; filing.submittedAt = submittedAt;
    this.tasks.set(taskId, { taskId, filingId, courtId: filing.courtId, taskType: 'REGISTRY_VALIDATE_FILING', assignedRole: 'REG', status: 'PENDING', createdAt: submittedAt, completedAt: null, completedBy: null });
    return Object.freeze({ ...filing });
  }
  async findActiveRegistryValidationTask(filingId) {
    return [...this.tasks.values()].find(t => t.filingId === filingId && t.status !== 'COMPLETED') || null;
  }
  async validateFilingAndCompleteTask({ filingId, taskId, actorSubject, validatedAt }) {
    const filing = this.filings.get(filingId); const task = this.tasks.get(taskId);
    if (!filing || filing.status !== 'SUBMITTED') { const e = new Error('bad state'); e.code='FILING_STATE_CONFLICT'; throw e; }
    if (!task || task.status === 'COMPLETED') { const e = new Error('bad task'); e.code='TASK_STATE_CONFLICT'; throw e; }
    filing.status='VALIDATED'; filing.validatedAt=validatedAt; filing.validatedBy=actorSubject;
    task.status='COMPLETED'; task.completedAt=validatedAt; task.completedBy=actorSubject;
    return Object.freeze({ ...filing });
  }
  async transitionFiling({ filingId, fromStatuses, toStatus, actorSubject, reason, at }) {
    const filing = this.filings.get(filingId);
    if (!filing || !fromStatuses.includes(filing.status)) { const e = new Error('bad state'); e.code='FILING_STATE_CONFLICT'; throw e; }
    filing.status = toStatus;
    filing.decisionReason = reason || null;
    filing.decisionBy = actorSubject;
    filing.decisionAt = at;
    return Object.freeze({ ...filing });
  }
}

test('persistent service creates party and filing through repository', async () => {
  const repo = new FakeRepository();
  const svc = new PersistentDciecmsService({ repository: repo });
  const party = await svc.createParty(reg, { courtId: reg.courtIds[0], partyType: 'PERSON', displayName: 'Jane Doe' });
  const filing = await svc.createFilingDraft(reg, { courtId: reg.courtIds[0], caseTypeCode: 'civil', filerPartyId: party.partyId });
  assert.equal(repo.parties.size, 1);
  assert.equal(repo.filings.size, 1);
  assert.equal(filing.caseTypeCode, 'CIVIL');
});

test('persistent submission creates registry task and validation completes it', async () => {
  const repo = new FakeRepository();
  const svc = new PersistentDciecmsService({ repository: repo });
  const party = await svc.createParty(reg, { courtId: reg.courtIds[0], partyType: 'PERSON', displayName: 'Jane Doe' });
  const draft = await svc.createFilingDraft(reg, { courtId: reg.courtIds[0], caseTypeCode: 'CIVIL', filerPartyId: party.partyId });
  const submitted = await svc.submitFiling(reg, draft.filingId, 'idem-1');
  assert.equal(submitted.status, 'SUBMITTED');
  assert.equal(repo.tasks.size, 1);
  const validated = await svc.validateFiling(reg, draft.filingId);
  assert.equal(validated.status, 'VALIDATED');
  assert.equal([...repo.tasks.values()][0].status, 'COMPLETED');
});

test('registry return requires a reason and moves submitted filing to RETURNED', async () => {
  const repo = new FakeRepository();
  const svc = new PersistentDciecmsService({ repository: repo });
  const party = await svc.createParty(reg, { courtId: reg.courtIds[0], partyType: 'PERSON', displayName: 'Jane Doe' });
  const draft = await svc.createFilingDraft(reg, { courtId: reg.courtIds[0], caseTypeCode: 'CIVIL', filerPartyId: party.partyId });
  await svc.submitFiling(reg, draft.filingId, 'idem-1');
  await assert.rejects(() => svc.returnFiling(reg, draft.filingId, ''), /reason/i);
  const returned = await svc.returnFiling(reg, draft.filingId, 'Missing affidavit');
  assert.equal(returned.status, 'RETURNED');
  assert.equal(returned.decisionReason, 'Missing affidavit');
});

test('only registry manager may reject or accept a validated filing', async () => {
  const repo = new FakeRepository();
  const svc = new PersistentDciecmsService({ repository: repo });
  const party = await svc.createParty(reg, { courtId: reg.courtIds[0], partyType: 'PERSON', displayName: 'Jane Doe' });
  const draft = await svc.createFilingDraft(reg, { courtId: reg.courtIds[0], caseTypeCode: 'CIVIL', filerPartyId: party.partyId });
  await svc.submitFiling(reg, draft.filingId, 'idem-1');
  await svc.validateFiling(reg, draft.filingId);
  await assert.rejects(() => svc.acceptFiling(reg, draft.filingId), /REG-MGR|manager/i);
  const accepted = await svc.acceptFiling(mgr, draft.filingId);
  assert.equal(accepted.status, 'ACCEPTED');
});
