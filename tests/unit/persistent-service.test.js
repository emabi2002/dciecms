'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActorFromClaims } = require('../../packages/auth');
const { PersistentDciecmsService } = require('../../services/api/src/persistent-dciecms-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const COURT_B = '22222222-2222-2222-2222-222222222222';
const reg = resolveActorFromClaims({ sub: 'reg-a', roles: ['REG'], court_ids: [COURT_A] });
const mgr = resolveActorFromClaims({ sub: 'mgr-a', roles: ['REG-MGR'], court_ids: [COURT_A] });
const regB = resolveActorFromClaims({ sub: 'reg-b', roles: ['REG'], court_ids: [COURT_B] });

class FakeRepository {
  constructor() {
    this.parties = new Map();
    this.filings = new Map();
    this.tasks = new Map();
    this.documents = new Map();
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
  async listRegistryQueue({ courtIds }) {
    return [...this.filings.values()].filter(f => f.status === 'SUBMITTED' && courtIds.includes(f.courtId)).map(f => Object.freeze({ ...f }));
  }
  async createDocument(input) {
    const row = Object.freeze({ ...input, status: 'QUARANTINED', createdAt: new Date().toISOString() });
    this.documents.set(row.documentId, row);
    return row;
  }
  async getDocument(documentId) { return this.documents.get(documentId) || null; }
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

test('persistent registry queue returns only submitted filings within actor court scope', async () => {
  const repo = new FakeRepository();
  const svc = new PersistentDciecmsService({ repository: repo });
  const partyA = await svc.createParty(reg, { courtId: COURT_A, partyType: 'PERSON', displayName: 'Court A Party' });
  const partyB = await svc.createParty(regB, { courtId: COURT_B, partyType: 'PERSON', displayName: 'Court B Party' });
  const filingA = await svc.createFilingDraft(reg, { courtId: COURT_A, caseTypeCode: 'CIVIL', filerPartyId: partyA.partyId });
  const filingB = await svc.createFilingDraft(regB, { courtId: COURT_B, caseTypeCode: 'CIVIL', filerPartyId: partyB.partyId });
  await svc.submitFiling(reg, filingA.filingId, 'idem-a');
  await svc.submitFiling(regB, filingB.filingId, 'idem-b');
  const rows = await svc.listRegistryQueue(reg);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].filingId, filingA.filingId);
});

test('persistent document registration validates SHA-256 and enforces court scope on retrieval', async () => {
  const repo = new FakeRepository();
  const svc = new PersistentDciecmsService({ repository: repo });
  const party = await svc.createParty(reg, { courtId: COURT_A, partyType: 'PERSON', displayName: 'Jane Doe' });
  const filing = await svc.createFilingDraft(reg, { courtId: COURT_A, caseTypeCode: 'CIVIL', filerPartyId: party.partyId });
  await assert.rejects(() => svc.registerDocument(reg, filing.filingId, { fileName: 'claim.pdf', mimeType: 'application/pdf', checksumSha256: 'bad' }), /SHA-256/i);
  const doc = await svc.registerDocument(reg, filing.filingId, { fileName: 'claim.pdf', mimeType: 'application/pdf', sizeBytes: 123, checksumSha256: 'a'.repeat(64) });
  assert.equal(doc.status, 'QUARANTINED');
  assert.equal(doc.checksumSha256, 'a'.repeat(64));
  await assert.rejects(() => svc.getDocument(regB, doc.documentId), /court scope/i);
  const retrieved = await svc.getDocument(reg, doc.documentId);
  assert.equal(retrieved.documentId, doc.documentId);
});
